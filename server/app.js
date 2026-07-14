import express from "express";
import cors from "cors";
import dns from "node:dns";
import https from "node:https";
import { createRequire } from "node:module";
import { createClient as createSbClient } from "@supabase/supabase-js";

// CJS interop: the ROI cron engine (server/roi-cron/runner.cjs) is CommonJS.
const require = createRequire(import.meta.url);
import { query, getClient } from "./db.js";
import { buildEmailHtml } from "./emailTemplate.js";
import { sendReport }     from "./emailClient.js";
import { getAllDeploymentStatuses, upsertDeploymentStatus } from "./viniStatuses.js";
import { mapMetabaseRows } from "./viniRooftopMap.js";
import { sendProgramsReportEmail } from "./programsEmail.js";
import { runAgentMetrics, runAgentMetricsIncremental, runAgentMetricsWeekMonth, hasClickhouseCreds } from "./agentMetrics.js";
import { runAgentRooftops, runAgentRooftopsIncremental, runAgentRooftopsTotalsOnly } from "./agentRooftop.js";
import { readAgentCache, writeAgentCache, hasCacheDb } from "./agentCache.js";

// Best-effort run log, mirrors what server/roi-cron/runner.cjs writes for
// sync-live/sync-lifecycle — gives every refresh tier a "last synced" trail
// without inventing new storage. These 3 tiers are the first callers to log a
// `source` other than "sync-live"/"sync-lifecycle" — if `source` ever turns
// out to be constrained (couldn't confirm from here: the local dev Supabase
// key can't see this table at all, PGRST205, so schema introspection isn't
// possible outside prod), retry once under the plain, pre-existing-shaped
// "agents-refresh" name so the run is still logged (tier stays readable via
// summary.mode) instead of silently vanishing.
async function logCronRun(source, ok, summary) {
  const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
  const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return;
  const sb = createSbClient(sbUrl, sbKey);
  try {
    const { error } = await sb.from("roi_cron_runs").insert({ source, ok, summary });
    if (!error) return;
    console.warn(`[cron] roi_cron_runs insert failed for source="${source}": ${error.message} — retrying with fallback source`);
    const { error: fallbackError } = await sb.from("roi_cron_runs").insert({ source: "agents-refresh", ok, summary: { ...summary, sourceAttempted: source } });
    if (fallbackError) console.error(`[cron] roi_cron_runs fallback insert also failed for source="${source}": ${fallbackError.message}`);
  } catch (err) {
    console.error(`[cron] roi_cron_runs insert threw for source="${source}": ${err?.message ?? err}`);
  }
}

// Cache keys for the precomputed agent-dashboard bundles (see agentCache.js).
const AGENT_CACHE_KEY_ROOFTOP = "rooftop";
const AGENT_CACHE_KEY_OVERALL = "overall";

// Some local resolvers (mac dev boxes, restrictive networks) break dns.lookup() while
// dns.resolve4() still works. Node's global fetch uses dns.lookup. Wrap https.request
// with an explicit resolve4 lookup so Metabase passthroughs survive flaky resolvers.
async function fetchJsonViaResolve4(url, { signal } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { throw e; }
  if (parsed.protocol !== "https:") throw new Error(`unsupported protocol ${parsed.protocol}`);

  // Resolve up-front, then connect by IP and assert the hostname via TLS SNI + Host header.
  const addrs = await new Promise((resolve, reject) =>
    dns.resolve4(parsed.hostname, (err, a) => err ? reject(err) : resolve(a)));
  if (!addrs?.length) throw new Error(`no A record for ${parsed.hostname}`);

  return new Promise((resolve, reject) => {
    let req;
    const onAbort = () => { req?.destroy(new Error("aborted")); };
    if (signal) signal.addEventListener("abort", onAbort);
    req = https.request({
      method: "GET",
      host: addrs[0],                         // dial the IP directly
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      servername: parsed.hostname,            // TLS SNI uses the real hostname
      headers: { Host: parsed.hostname, Accept: "application/json" },
    }, res => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        if (signal) signal.removeEventListener("abort", onAbort);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.on("error", err => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    req.end();
  });
}

const app = express();
app.use(cors());
app.use(express.json());

const VIN_DETAILS_URL =
  "https://metabase.spyne.ai/api/public/card/15e908e4-fe21-4982-9d8c-4aff07f2c948/query/json";

const ROOFTOP_DETAILS_URL =
  "https://metabase.spyne.ai/api/public/card/f5c032a6-c262-40ee-8d95-c115d326d3a8/query/json";

const ENTERPRISE_DETAILS_URL =
  "https://metabase.spyne.ai/api/public/card/b8f1271c-cc5a-470f-badf-807711f74af4/query/json";

/** Metabase public card JSON URL for Vini Account Health (same columns as vini-dashboard CSV). Optional — when set, sync pulls automatically with POST /api/sync. */
const VINI_ROOFTOP_METABASE_URL = process.env.VINI_ROOFTOP_METABASE_URL?.trim() || "";

// ─── Sync helpers ────────────────────────────────────────────────────────────

const EPOCH        = "1970-01-01T00:00:00Z";
const cleanDate    = (v) => (!v || v === EPOCH) ? null : v;
const cleanAfter24 = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.toLowerCase() === "yes" ? 1 : 0;
  return v ? 1 : 0;
};

// Fetch from Metabase with optional per-attempt timeout and exponential back-off retry.
// timeoutMs = 0 means no timeout (used for fast endpoints like Rooftops/Enterprises).
async function fetchFromMetabase(url, label, retries = 3, timeoutMs = 0) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) console.log(`[sync:${label}] retry attempt ${attempt}/${retries}`);
      // Try Node's global fetch first; if the local resolver breaks (ENOTFOUND),
      // fall back to https.request with an explicit dns.resolve4 lookup.
      try {
        const opts = timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {};
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        const msg = String(err?.cause?.code || err?.code || err?.message || "");
        if (msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN") || /fetch failed/i.test(err?.message ?? "")) {
          console.warn(`[sync:${label}] dns.lookup broken, falling back to resolve4`);
          const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
          return await fetchJsonViaResolve4(url, { signal });
        }
        throw err;
      }
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = 3000 * (attempt + 1);
        console.warn(`[sync:${label}] failed, retrying in ${delay / 1000}s — ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Per-table sync functions ─────────────────────────────────────────────────
// Each syncs independently — a failure in one does not affect the others.
// Uses UNNEST bulk-insert for efficiency (single query vs N queries per row).

async function syncVins() {
  console.log("[sync:VIN_DETAILS] fetching…");
  // 1 retry (not 3) — Metabase VIN fetch can take ~60s, so 3 retries would consume
  // ~240s of the 300s Vercel budget before the other syncs even get a chance.
  // 65s timeout per attempt caps a hanging request just above Metabase's worst case.
  const rows    = await fetchFromMetabase(VIN_DETAILS_URL, "VIN_DETAILS", 1, 65000);
  const syncedAt = new Date().toISOString();
  const deduped = Object.values(
    rows.reduce((acc, row) => { acc[row.vinName ?? ""] = row; return acc; }, {})
  );
  if (deduped.length > 0) console.log("[sync:VIN_DETAILS] sample row keys:", Object.keys(deduped[0]), "| has_photos sample:", deduped[0].has_photos);

  const vins = [], dealerVinIds = [], enterpriseIds = [], rooftopIds = [];
  const statuses = [], after24hs = [], receivedAts = [], processedAts = [];
  const reasonBuckets = [], holdReasons = [], hasPhotosArr = [], syncedAts = [];

  for (const row of deduped) {
    vins.push(row.vinName ?? "");
    dealerVinIds.push(row["m.dealerVinId"] ?? null);
    enterpriseIds.push(row.enterpriseId ?? "");
    rooftopIds.push(String(row.teamId ?? ""));
    statuses.push(row.status ?? "");
    after24hs.push(cleanAfter24(row.after_24_hrs ?? row.after_24hrs ?? null));
    receivedAts.push(cleanDate(row.receivedAt));
    processedAts.push(cleanDate(row.sentAt));
    reasonBuckets.push(row.reason_bucket ?? "");
    holdReasons.push(row.hold_reason ?? "");
    hasPhotosArr.push(cleanAfter24(row.has_photos ?? null));
    syncedAts.push(syncedAt);
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM vins");
    if (deduped.length > 0) {
      await client.query(`
        INSERT INTO vins
          (vin, dealer_vin_id, enterprise_id, rooftop_id, status, after_24h, received_at, processed_at, reason_bucket, hold_reason, has_photos, synced_at)
        SELECT
          UNNEST($1::text[]), UNNEST($2::text[]), UNNEST($3::text[]), UNNEST($4::text[]),
          UNNEST($5::text[]), UNNEST($6::smallint[]), UNNEST($7::text[]), UNNEST($8::text[]),
          UNNEST($9::text[]), UNNEST($10::text[]), UNNEST($11::smallint[]), UNNEST($12::text[])
      `, [vins, dealerVinIds, enterpriseIds, rooftopIds, statuses, after24hs, receivedAts, processedAts, reasonBuckets, holdReasons, hasPhotosArr, syncedAts]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  console.log(`[sync:VIN_DETAILS] done — ${deduped.length} rows`);
}

async function syncRooftops() {
  console.log("[sync:ROOFTOP_DETAILS] fetching…");
  const rows    = await fetchFromMetabase(ROOFTOP_DETAILS_URL, "ROOFTOP_DETAILS");
  const syncedAt = new Date().toISOString();
  const deduped = Object.values(
    rows.reduce((acc, row) => { if (row.team_id) acc[String(row.team_id)] = row; return acc; }, {})
  );

  const teamIds = [], enterpriseIds = [], teamNames = [], teamTypes = [];
  const websiteScores = [], websiteListingUrls = [], imsStatuses = [], publishingStatuses = [], syncedAts = [];

  for (const row of deduped) {
    teamIds.push(String(row.team_id));
    enterpriseIds.push(String(row["t.enterprise_id"] ?? ""));
    teamNames.push(row.team_name ?? null);
    teamTypes.push(row.team_type ?? null);
    websiteScores.push(row.overallScore != null ? Number(row.overallScore) : null);
    websiteListingUrls.push(row.website_listing_url ?? null);
    imsStatuses.push(row.ims_integration_status != null ? String(row.ims_integration_status) : null);
    publishingStatuses.push(row.publishing_status != null ? String(row.publishing_status) : null);
    syncedAts.push(syncedAt);
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM rooftop_details");
    if (deduped.length > 0) {
      await client.query(`
        INSERT INTO rooftop_details
          (team_id, enterprise_id, team_name, team_type, website_score, website_listing_url, ims_integration_status, publishing_status, synced_at)
        SELECT
          UNNEST($1::text[]), UNNEST($2::text[]), UNNEST($3::text[]), UNNEST($4::text[]),
          UNNEST($5::real[]), UNNEST($6::text[]), UNNEST($7::text[]), UNNEST($8::text[]),
          UNNEST($9::text[])
      `, [teamIds, enterpriseIds, teamNames, teamTypes, websiteScores, websiteListingUrls, imsStatuses, publishingStatuses, syncedAts]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  console.log(`[sync:ROOFTOP_DETAILS] done — ${deduped.length} rows`);
}

async function syncEnterprises() {
  console.log("[sync:ENTERPRISE_DETAILS] fetching…");
  const rows    = await fetchFromMetabase(ENTERPRISE_DETAILS_URL, "ENTERPRISE_DETAILS");
  const syncedAt = new Date().toISOString();
  const deduped = Object.values(
    rows.reduce((acc, row) => { if (row["dt.enterprise_id"]) acc[String(row["dt.enterprise_id"])] = row; return acc; }, {})
  );

  const enterpriseIds = [], names = [], types = [], websiteUrls = [], pocEmails = [], syncedAts = [];

  for (const row of deduped) {
    enterpriseIds.push(String(row["dt.enterprise_id"]));
    names.push(row.name ?? null);
    types.push(row.type ?? null);
    websiteUrls.push(row.website_url ?? null);
    pocEmails.push(row.email_id ?? null);
    syncedAts.push(syncedAt);
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM enterprise_details");
    if (deduped.length > 0) {
      await client.query(`
        INSERT INTO enterprise_details
          (enterprise_id, name, type, website_url, poc_email, synced_at)
        SELECT
          UNNEST($1::text[]), UNNEST($2::text[]), UNNEST($3::text[]),
          UNNEST($4::text[]), UNNEST($5::text[]), UNNEST($6::text[])
      `, [enterpriseIds, names, types, websiteUrls, pocEmails, syncedAts]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  console.log(`[sync:ENTERPRISE_DETAILS] done — ${deduped.length} rows`);
}

async function syncViniRooftopMetrics() {
  if (!VINI_ROOFTOP_METABASE_URL) {
    console.log("[sync:VINI_METRICS] skipped — set VINI_ROOFTOP_METABASE_URL (Metabase public card …/query/json)");
    return;
  }
  console.log("[sync:VINI_METRICS] fetching…");
  const rows = await fetchFromMetabase(VINI_ROOFTOP_METABASE_URL, "VINI_METRICS", 1, 120000);
  const payload = Array.isArray(rows) ? rows : [];
  await query(
    `INSERT INTO vini_metrics_cache (id, rows_json, synced_at)
     VALUES ('global', $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET rows_json = EXCLUDED.rows_json, synced_at = NOW()`,
    [JSON.stringify(payload)]
  );
  console.log(`[sync:VINI_METRICS] done — ${payload.length} rows`);
}

// Atomically claims a sync lock in the DB, runs all three syncs sequentially,
// then releases the lock. Returns { skipped: true } if already running.
// VINs is treated as critical — its failure propagates as an HTTP 500.
// Rooftops and Enterprises run first (milliseconds) and fail silently.
// completed_at is only stamped when VINs succeeds.
async function runSync() {
  // Atomic claim: only one instance wins this UPDATE at a time.
  const { rows } = await query(`
    UPDATE sync_state
       SET running = TRUE, started_at = NOW(), completed_at = NULL
     WHERE id = 'global' AND running = FALSE
    RETURNING id
  `);

  if (rows.length === 0) {
    console.warn("[sync] already in progress — skipping duplicate request");
    return { skipped: true };
  }

  console.log("[sync] started — Rooftops, Enterprises (non-critical), then VINs (critical)");
  let succeeded = false;
  try {
    // Non-critical syncs first — fast and must not be blocked by VINs timing out.
    for (const [fn, name] of [[syncRooftops, "Rooftops"], [syncEnterprises, "Enterprises"]]) {
      try { await fn(); } catch (e) { console.error(`[sync] ${name} failed:`, e?.message); }
    }
    // VINs is critical — let failure throw so the caller returns HTTP 500.
    await syncVins();
    succeeded = true;
  } finally {
    // Only stamp completed_at when VINs actually succeeded so the UI
    // does not show a fresh "synced X min ago" after a failed sync.
    if (succeeded) {
      await query(`UPDATE sync_state SET running = FALSE, completed_at = NOW() WHERE id = 'global'`);
      // Precompute all 3 summary variants and store in summary_cache so
      // GET /api/summary becomes a trivial single-row lookup (<5ms).
      for (const df of [null, 'post', 'pre']) {
        try {
          const payload = await computeSummary(df);
          await upsertSummaryCache(df, payload);
        } catch (e) {
          console.error(`[sync] summary precompute failed for dateFilter=${df}:`, e?.message);
        }
      }
      // Update meta in sync_state so GET /api/sync/status needs no vins scan.
      await query(`
        UPDATE sync_state
           SET total_rows = (SELECT COUNT(*)::int FROM vins),
               last_sync  = (SELECT MAX(synced_at) FROM vins)
         WHERE id = 'global'
      `);
      // Refresh materialized views with new vins data, then precompute
      // filter-options cache so GET /api/filter-options is a trivial lookup.
      await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY v_by_rooftop`);
      await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY v_by_enterprise`);
      try {
        const filterPayload = await computeFilterOptions();
        await upsertFilterCache(filterPayload);
      } catch (e) {
        console.error(`[sync] filter-options precompute failed:`, e?.message);
      }
      try {
        await syncViniRooftopMetrics();
      } catch (e) {
        console.error("[sync] Vini metrics failed:", e?.message);
      }
    } else {
      await query(`UPDATE sync_state SET running = FALSE WHERE id = 'global'`);
    }
  }

  console.log("[sync] complete");
  return { skipped: false };
}

// ─── Row serialisers ──────────────────────────────────────────────────────────

function toApiRow(r) {
  return {
    vin:          r.vin,
    dealerVinId:  r.dealer_vin_id ?? null,
    enterpriseId: r.enterprise_id,
    enterprise:   r.enterprise,
    rooftopId:    r.rooftop_id,
    rooftop:      r.rooftop,
    rooftopType:  r.rooftop_type,
    csm:          r.csm,
    status:       r.status,
    reasonBucket: r.reason_bucket || null,
    holdReason:   r.hold_reason || null,
    after24h:     r.after_24h !== null ? Boolean(r.after_24h) : null,
    hasPhotos:    r.has_photos !== null ? Boolean(r.has_photos) : false,
    receivedAt:   r.received_at,
    processedAt:  r.processed_at,
    syncedAt:     r.synced_at,
  };
}

function toTotals(r) {
  return {
    total:                   r.total,
    enterpriseCount:         r.enterprise_count ?? 0,
    withPhotos:              r.with_photos ?? 0,
    deliveredWithPhotos:     r.delivered_with_photos ?? 0,
    pendingWithPhotos:       r.pending_with_photos ?? 0,
    processed:               r.processed,
    processedAfter24:        r.processed_after_24h,
    notProcessed:            r.not_processed,
    notProcessedAfter24:     r.not_processed_after_24h,
    bucketProcessingPending: r.bucket_processing_pending,
    bucketPublishingPending: r.bucket_publishing_pending,
    bucketQcPending:         r.bucket_qc_pending,
    bucketSold:              r.bucket_sold,
    bucketOthers:            r.bucket_others,
  };
}

function toRooftopRow(r) {
  return {
    rooftopId:                r.rooftop_id,
    name:                     r.name,
    type:                     r.type,
    csm:                      r.csm,
    enterpriseId:             r.enterprise_id,
    enterprise:               r.enterprise,
    total:                    r.total,
    withPhotos:               r.with_photos ?? 0,
    deliveredWithPhotos:      r.delivered_with_photos ?? 0,
    pendingWithPhotos:        r.pending_with_photos ?? 0,
    processed:                r.processed,
    processedAfter24:         r.processed_after_24h,
    notProcessed:             r.not_processed,
    notProcessedAfter24:      r.not_processed_after_24h,
    websiteScore:             r.website_score ?? null,
    websiteListingUrl:        r.website_listing_url ?? null,
    imsIntegrationStatus:     r.ims_integration_status ?? null,
    publishingStatus:         r.publishing_status ?? null,
    bucketProcessingPending:  r.bucket_processing_pending,
    bucketPublishingPending:  r.bucket_publishing_pending,
    bucketQcPending:          r.bucket_qc_pending,
    bucketQcHold:             r.bucket_qc_hold,
    bucketSold:               r.bucket_sold,
    bucketOthers:             r.bucket_others,
  };
}

function toEnterpriseRow(r) {
  return {
    id:                       r.id,
    name:                     r.name,
    csm:                      r.csm ?? null,
    total:                    r.total,
    withPhotos:               r.with_photos ?? 0,
    deliveredWithPhotos:      r.delivered_with_photos ?? 0,
    pendingWithPhotos:        r.pending_with_photos ?? 0,
    processed:                r.processed,
    processedAfter24:         r.processed_after_24h,
    notProcessed:             r.not_processed,
    notProcessedAfter24:      r.not_processed_after_24h,
    rooftopCount:             r.rooftop_count ?? 0,
    notIntegratedCount:       r.not_integrated_count ?? 0,
    publishingDisabledCount:  r.publishing_disabled_count ?? 0,
    avgWebsiteScore:          r.avg_website_score ?? null,
    websiteUrl:               r.website_url ?? null,
    accountType:              r.account_type ?? null,
    bucketProcessingPending:  r.bucket_processing_pending,
    bucketPublishingPending:  r.bucket_publishing_pending,
    bucketQcPending:          r.bucket_qc_pending,
    bucketQcHold:             r.bucket_qc_hold,
    bucketSold:               r.bucket_sold,
    bucketOthers:             r.bucket_others,
  };
}

function toCsmRow(r) {
  return {
    name:                     r.name,
    label:                    r.name,
    rooftopCount:             r.rooftop_count,
    enterpriseCount:          r.enterprise_count ?? 0,
    total:                    r.total,
    withPhotos:               r.with_photos ?? 0,
    deliveredWithPhotos:      r.delivered_with_photos ?? 0,
    pendingWithPhotos:        r.pending_with_photos ?? 0,
    processed:                r.processed,
    processedAfter24:         r.processed_after_24h,
    notProcessed:             r.not_processed,
    notProcessedAfter24:      r.not_processed_after_24h,
    avgWebsiteScore:          r.avg_website_score ?? null,
    missingWebsiteCount:      r.missing_website_count ?? 0,
    integratedCount:          r.integrated_count ?? 0,
    publishingCount:          r.publishing_count ?? 0,
    bucketProcessingPending:  r.bucket_processing_pending,
    bucketPublishingPending:  r.bucket_publishing_pending,
    bucketQcPending:          r.bucket_qc_pending,
    bucketQcHold:             r.bucket_qc_hold,
    bucketSold:               r.bucket_sold,
    bucketOthers:             r.bucket_others,
  };
}

function toTypeRow(r) {
  return {
    label:                    r.label,
    rooftopCount:             r.rooftop_count,
    enterpriseCount:          r.enterprise_count ?? 0,
    total:                    r.total,
    withPhotos:               r.with_photos ?? 0,
    deliveredWithPhotos:      r.delivered_with_photos ?? 0,
    pendingWithPhotos:        r.pending_with_photos ?? 0,
    processed:                r.processed,
    processedAfter24:         r.processed_after_24h,
    notProcessed:             r.not_processed,
    notProcessedAfter24:      r.not_processed_after_24h,
    avgWebsiteScore:          r.avg_website_score ?? null,
    missingWebsiteCount:      r.missing_website_count ?? 0,
    integratedCount:          r.integrated_count ?? 0,
    publishingCount:          r.publishing_count ?? 0,
    bucketProcessingPending:  r.bucket_processing_pending,
    bucketPublishingPending:  r.bucket_publishing_pending,
    bucketQcPending:          r.bucket_qc_pending,
    bucketQcHold:             r.bucket_qc_hold,
    bucketSold:               r.bucket_sold,
    bucketOthers:             r.bucket_others,
  };
}

// ─── Date filter helpers ──────────────────────────────────────────────────────

const DATE_CUTOFF = '2026-04-01';

// Returns a SQL condition string for the date filter, or null for "all".
// alias: table alias prefix (e.g. 'v' → 'v.received_at'), or '' for bare column.
function getDateCondition(dateFilter, alias = '') {
  const col = alias ? `${alias}.received_at` : 'received_at';
  if (dateFilter === 'post') return `${col} >= '${DATE_CUTOFF}'`;
  if (dateFilter === 'pre')  return `(${col} < '${DATE_CUTOFF}' OR ${col} IS NULL)`;
  return null;
}

// Returns { prefix, from } for the rooftop aggregation source.
// When dateFilter is active, inlines the view SQL as a CTE so the date
// condition can be applied before aggregation.
function buildRooftopSource(dateFilter) {
  const dc = getDateCondition(dateFilter, 'v');
  if (!dc) return { prefix: '', from: 'v_by_rooftop' };
  const prefix = `
    WITH rt AS (
      SELECT
        v.rooftop_id,
        v.enterprise_id,
        MAX(rd.team_name)                   AS name,
        MAX(rd.team_type)                   AS type,
        MAX(ed.poc_email)                   AS csm,
        MAX(ed.name)                        AS enterprise,
        COUNT(*)::int                       AS total,
        SUM(CASE WHEN v.status = 'Delivered' THEN 1 ELSE 0 END)::int                                       AS processed,
        SUM(CASE WHEN v.status = 'Delivered' AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int        AS processed_after_24h,
        SUM(CASE WHEN v.status != 'Delivered' THEN 1 ELSE 0 END)::int                                      AS not_processed,
        SUM(CASE WHEN v.status != 'Delivered' AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int       AS not_processed_after_24h,
        MAX(rd.website_score)               AS website_score,
        MAX(rd.website_listing_url)         AS website_listing_url,
        MAX(rd.ims_integration_status)      AS ims_integration_status,
        MAX(rd.publishing_status)           AS publishing_status,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'Processing Pending' AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_processing_pending,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'Publishing Pending' AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_publishing_pending,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'QC Pending'         AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_qc_pending,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'Sold'               AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_sold,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'Others'             AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_others
      FROM vins v
      LEFT JOIN rooftop_details rd ON v.rooftop_id = rd.team_id
      LEFT JOIN enterprise_details ed ON v.enterprise_id = ed.enterprise_id
      WHERE ${dc}
      GROUP BY v.rooftop_id, v.enterprise_id
    )
  `;
  return { prefix, from: 'rt' };
}

// Returns { prefix, from } for the enterprise aggregation source.
function buildEnterpriseSource(dateFilter) {
  const dc = getDateCondition(dateFilter, 'v');
  if (!dc) return { prefix: '', from: 'v_by_enterprise' };
  const prefix = `
    WITH et AS (
      SELECT
        v.enterprise_id                       AS id,
        MAX(ed.name)                          AS name,
        MAX(ed.poc_email)                     AS csm,
        COUNT(*)::int                         AS total,
        SUM(CASE WHEN v.status = 'Delivered' THEN 1 ELSE 0 END)::int                                       AS processed,
        SUM(CASE WHEN v.status = 'Delivered' AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int        AS processed_after_24h,
        SUM(CASE WHEN v.status != 'Delivered' THEN 1 ELSE 0 END)::int                                      AS not_processed,
        SUM(CASE WHEN v.status != 'Delivered' AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int       AS not_processed_after_24h,
        COUNT(DISTINCT v.rooftop_id)::int     AS rooftop_count,
        COUNT(DISTINCT CASE WHEN rd.ims_integration_status = 'false' THEN v.rooftop_id END)::int AS not_integrated_count,
        COUNT(DISTINCT CASE WHEN rd.publishing_status = 'false' THEN v.rooftop_id END)::int      AS publishing_disabled_count,
        ROUND(AVG(rd.website_score)::numeric, 2) AS avg_website_score,
        MAX(ed.website_url)                   AS website_url,
        MAX(ed.type)                          AS account_type,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'Processing Pending' AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_processing_pending,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'Publishing Pending' AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_publishing_pending,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'QC Pending'         AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_qc_pending,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'Sold'               AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_sold,
        SUM(CASE WHEN v.status != 'Delivered' AND v.reason_bucket = 'Others'             AND COALESCE(v.after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_others
      FROM vins v
      LEFT JOIN enterprise_details ed ON v.enterprise_id = ed.enterprise_id
      LEFT JOIN rooftop_details rd    ON v.rooftop_id = rd.team_id
      WHERE ${dc}
      GROUP BY v.enterprise_id
    )
  `;
  return { prefix, from: 'et' };
}

// ─── VIN query helpers ────────────────────────────────────────────────────────

// Whitelist map: frontend column key → DB expression (prevents SQL injection)
const SORT_MAP = {
  enterprise:   "ed.name",
  rooftop:      "rd.team_name",
  rooftopType:  "rd.team_type",
  csm:          "ed.poc_email",
  vin:          "v.vin",
  dealerVinId:  "v.dealer_vin_id",
  status:       "v.status",
  after24h:     "v.after_24h",
  receivedAt:   "v.received_at",
  processedAt:  "v.processed_at",
  reasonBucket: "v.reason_bucket",
  holdReason:   "v.hold_reason",
};

function buildVinSort({ sortBy, sortDir } = {}) {
  const col = SORT_MAP[sortBy];
  if (!col) return "v.received_at DESC NULLS LAST";
  return `${col} ${sortDir === "asc" ? "ASC" : "DESC"} NULLS LAST`;
}

const VIN_FROM = `
  FROM vins v
  LEFT JOIN rooftop_details rd ON v.rooftop_id = rd.team_id
  LEFT JOIN enterprise_details ed ON v.enterprise_id = ed.enterprise_id
`;

const VIN_SELECT = `
  SELECT v.vin, v.dealer_vin_id, v.enterprise_id, v.rooftop_id,
         v.status, v.after_24h, v.has_photos, v.received_at, v.processed_at, v.reason_bucket, v.hold_reason, v.synced_at,
         rd.team_name AS rooftop, rd.team_type AS rooftop_type,
         ed.name AS enterprise, ed.poc_email AS csm
  ${VIN_FROM}
`;

// Builds a WHERE clause with PostgreSQL positional params ($1, $2, …).
// Returns { where: string, params: any[] }.
function buildVinFilters(queryParams) {
  const { search, rooftop, rooftopId, rooftopType, csm, status, after24h, hasPhotos, enterprise, enterpriseId, reasonBucket, dateFilter } = queryParams;
  const conditions = [];
  const params = [];

  // Helper: push value to params array, return its $N placeholder
  const p = (val) => { params.push(val); return `$${params.length}`; };

  if (search) {
    const s = `%${search}%`;
    conditions.push(`(v.vin ILIKE ${p(s)} OR rd.team_name ILIKE ${p(s)} OR ed.poc_email ILIKE ${p(s)} OR ed.name ILIKE ${p(s)})`);
  }
  if (enterpriseId) conditions.push(`v.enterprise_id = ${p(enterpriseId)}`);
  if (rooftopId)    conditions.push(`v.rooftop_id = ${p(rooftopId)}`);
  if (rooftop)      conditions.push(`rd.team_name = ${p(rooftop)}`);
  if (rooftopType)  conditions.push(`rd.team_type = ${p(rooftopType)}`);
  if (csm)          conditions.push(`ed.poc_email = ${p(csm)}`);
  if (status)       conditions.push(`v.status = ${p(status)}`);
  if (enterprise)   conditions.push(`ed.name = ${p(enterprise)}`);
  if (after24h === "true"  || after24h === "1") conditions.push("COALESCE(v.after_24h, 0) = 1");
  if (after24h === "false" || after24h === "0") conditions.push("COALESCE(v.after_24h, 0) = 0");
  if (hasPhotos === "true"  || hasPhotos === "1") conditions.push("COALESCE(v.has_photos, 0) = 1");
  if (hasPhotos === "false" || hasPhotos === "0") conditions.push("COALESCE(v.has_photos, 0) = 0");
  if (reasonBucket) conditions.push(`v.reason_bucket = ${p(reasonBucket)}`);
  const dc = getDateCondition(dateFilter, 'v');
  if (dc) conditions.push(dc);

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

// ─── GET /api/sync/status ─────────────────────────────────────────────────────

app.get("/api/sync/status", async (_req, res) => {
  const { rows } = await query(
    "SELECT running, started_at, completed_at, total_rows, last_sync FROM sync_state WHERE id = 'global'"
  );
  const state = rows[0];
  res.json({
    running:     state?.running     ?? false,
    startedAt:   state?.started_at  ?? null,
    completedAt: state?.completed_at ?? null,
    lastSync:    state?.last_sync   ?? null,
    totalRows:   state?.total_rows  ?? 0,
  });
});

// ─── POST /api/sync ───────────────────────────────────────────────────────────
// Synchronous — awaits the full sync before responding.
// maxDuration: 300 is set in vercel.json to allow up to 5 minutes.

app.post("/api/sync", async (_req, res) => {
  try {
    const result = await runSync();
    if (result.skipped) {
      const { rows } = await query("SELECT started_at FROM sync_state WHERE id = 'global'");
      return res.status(202).json({ status: "already_running", startedAt: rows[0]?.started_at });
    }
    res.json({ status: "completed" });
  } catch (err) {
    console.error("[POST /api/sync] error:", err);
    res.status(500).json({ error: err.message || "Sync failed" });
  }
});

// ─── Summary computation ──────────────────────────────────────────────────────
// Runs the full aggregation query and returns the shaped JS object.
// Called at the end of each sync (to precompute all 3 variants) and as a
// fallback in GET /api/summary when the cache is empty (first deploy).

async function computeSummary(dateFilter) {
  const dc = getDateCondition(dateFilter);
  const statsWhere = dc ? `WHERE ${dc}` : '';
  const { rows } = await query(`
    WITH
      meta AS (
        SELECT MAX(synced_at) AS last_sync, COUNT(*)::int AS total_rows FROM vins
      ),
      base AS MATERIALIZED (
        SELECT
          v.status,
          v.has_photos,
          v.after_24h,
          v.reason_bucket,
          v.rooftop_id,
          v.enterprise_id,
          ed.poc_email,
          rd.team_type,
          rd.website_score,
          rd.website_listing_url,
          rd.ims_integration_status,
          rd.publishing_status
        FROM vins v
        LEFT JOIN enterprise_details ed ON v.enterprise_id = ed.enterprise_id
        LEFT JOIN rooftop_details rd    ON v.rooftop_id    = rd.team_id
        ${statsWhere}
      ),
      totals AS (
        SELECT
          COUNT(*)::int                                                                                                          AS total,
          COUNT(DISTINCT enterprise_id)::int                                                                                    AS enterprise_count,
          SUM(CASE WHEN COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                                                       AS with_photos,
          SUM(CASE WHEN status = 'Delivered' AND COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                              AS delivered_with_photos,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                             AS pending_with_photos,
          SUM(CASE WHEN status = 'Delivered' THEN 1 ELSE 0 END)::int                                                            AS processed,
          SUM(CASE WHEN status = 'Delivered' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int                               AS processed_after_24h,
          SUM(CASE WHEN status != 'Delivered' THEN 1 ELSE 0 END)::int                                                           AS not_processed,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS not_processed_after_24h,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Processing Pending' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_processing_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Publishing Pending' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_publishing_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'QC Pending'         AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_qc_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'QC Hold'            AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_qc_hold,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Sold'               AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_sold,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Others'             AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_others
        FROM base
      ),
      by_csm AS (
        SELECT
          poc_email                                                                                                                  AS name,
          COUNT(DISTINCT rooftop_id)::int                                                                                           AS rooftop_count,
          COUNT(DISTINCT enterprise_id)::int                                                                                        AS enterprise_count,
          COUNT(*)::int                                                                                                              AS total,
          SUM(CASE WHEN COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                                                           AS with_photos,
          SUM(CASE WHEN status = 'Delivered' AND COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                                  AS delivered_with_photos,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                                 AS pending_with_photos,
          SUM(CASE WHEN status = 'Delivered' THEN 1 ELSE 0 END)::int                                                                AS processed,
          SUM(CASE WHEN status = 'Delivered' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int                                   AS processed_after_24h,
          SUM(CASE WHEN status != 'Delivered' THEN 1 ELSE 0 END)::int                                                               AS not_processed,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int     AS not_processed_after_24h,
          ROUND(AVG(website_score)::numeric, 2)                                                                                     AS avg_website_score,
          COUNT(DISTINCT CASE WHEN (website_listing_url IS NULL OR website_listing_url = '') THEN rooftop_id END)::int              AS missing_website_count,
          COUNT(DISTINCT CASE WHEN ims_integration_status = 'false' THEN rooftop_id END)::int                                      AS integrated_count,
          COUNT(DISTINCT CASE WHEN publishing_status = 'false' THEN rooftop_id END)::int                                           AS publishing_count,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Processing Pending' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_processing_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Publishing Pending' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_publishing_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'QC Pending'         AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_qc_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'QC Hold'            AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_qc_hold,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Sold'               AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_sold,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Others'             AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_others
        FROM base
        GROUP BY poc_email
      ),
      by_type AS (
        SELECT
          team_type                                                                                                                  AS label,
          COUNT(DISTINCT rooftop_id)::int                                                                                           AS rooftop_count,
          COUNT(DISTINCT enterprise_id)::int                                                                                        AS enterprise_count,
          COUNT(*)::int                                                                                                              AS total,
          SUM(CASE WHEN COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                                                           AS with_photos,
          SUM(CASE WHEN status = 'Delivered' AND COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                                  AS delivered_with_photos,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 THEN 1 ELSE 0 END)::int                                 AS pending_with_photos,
          SUM(CASE WHEN status = 'Delivered' THEN 1 ELSE 0 END)::int                                                                AS processed,
          SUM(CASE WHEN status = 'Delivered' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int                                   AS processed_after_24h,
          SUM(CASE WHEN status != 'Delivered' THEN 1 ELSE 0 END)::int                                                               AS not_processed,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int     AS not_processed_after_24h,
          ROUND(AVG(website_score)::numeric, 2)                                                                                     AS avg_website_score,
          COUNT(DISTINCT CASE WHEN (website_listing_url IS NULL OR website_listing_url = '') THEN rooftop_id END)::int              AS missing_website_count,
          COUNT(DISTINCT CASE WHEN ims_integration_status = 'false' THEN rooftop_id END)::int                                      AS integrated_count,
          COUNT(DISTINCT CASE WHEN publishing_status = 'false' THEN rooftop_id END)::int                                           AS publishing_count,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Processing Pending' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_processing_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Publishing Pending' AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_publishing_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'QC Pending'         AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_qc_pending,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'QC Hold'            AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_qc_hold,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Sold'               AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_sold,
          SUM(CASE WHEN status != 'Delivered' AND COALESCE(has_photos,0)=1 AND reason_bucket = 'Others'             AND COALESCE(after_24h,0)=1 THEN 1 ELSE 0 END)::int AS bucket_others
        FROM base
        GROUP BY team_type
      ),
      by_bucket AS (
        SELECT reason_bucket AS label, COUNT(*)::int AS count
        FROM base
        WHERE status != 'Delivered' AND COALESCE(has_photos,0)=1 AND COALESCE(after_24h,0)=1
          AND reason_bucket IS NOT NULL AND reason_bucket != ''
        GROUP BY reason_bucket
      )
    SELECT
      (SELECT last_sync   FROM meta)                AS last_sync,
      (SELECT total_rows  FROM meta)                AS total_rows,
      (SELECT row_to_json(t) FROM totals t)         AS totals_json,
      (SELECT json_agg(c ORDER BY c.rooftop_count DESC)
       FROM by_csm c)                               AS by_csm_json,
      (SELECT json_agg(t ORDER BY
          CASE t.label
            WHEN 'Franchise Group'        THEN 1
            WHEN 'Franchise Individual'   THEN 2
            WHEN 'Independent Group'      THEN 3
            WHEN 'Independent Individual' THEN 4
            WHEN 'Others'                 THEN 5
            ELSE 6
          END, t.label)
       FROM by_type t)                              AS by_type_json,
      (SELECT json_agg(b ORDER BY
          CASE b.label
            WHEN 'Processing Pending' THEN 1
            WHEN 'Publishing Pending' THEN 2
            WHEN 'QC Pending'         THEN 3
            WHEN 'Sold'               THEN 4
            ELSE 5
          END, b.label)
       FROM by_bucket b)                            AS by_bucket_json
  `);
  const row = rows[0];
  return {
    lastSync:  row.last_sync  ?? null,
    totalRows: row.total_rows ?? 0,
    totals:    toTotals(row.totals_json),
    byCSM:     (row.by_csm_json    ?? []).map(toCsmRow),
    byType:    (row.by_type_json   ?? []).map(toTypeRow),
    byBucket:  (row.by_bucket_json ?? []).map(r => ({ label: r.label, count: r.count })),
  };
}

async function upsertSummaryCache(dateFilter, payload) {
  await query(
    `INSERT INTO summary_cache (date_filter, payload, computed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (date_filter) DO UPDATE SET payload = $2, computed_at = NOW()`,
    [dateFilter ?? 'all', JSON.stringify(payload)]
  );
}

// ─── GET /api/summary ─────────────────────────────────────────────────────────
// Serves from summary_cache (precomputed at end of each sync) — trivial lookup.
// Falls back to computing on-demand if cache is empty (first deploy with existing data).

app.get("/api/summary", async (req, res) => {
  const dateFilter = req.query.dateFilter ?? null;
  const cacheKey   = dateFilter ?? 'all';
  const { rows } = await query(
    'SELECT payload FROM summary_cache WHERE date_filter = $1',
    [cacheKey]
  );
  if (rows.length > 0) {
    return res.json(rows[0].payload);
  }
  // Cache not yet populated — compute and store so the next request is instant.
  const payload = await computeSummary(dateFilter);
  await upsertSummaryCache(dateFilter, payload);
  res.json(payload);
});

// ─── Filter-options computation ───────────────────────────────────────────────
// Queries the materialized views (pre-aggregated at sync time) and returns the
// shaped payload. Called at the end of each sync and as a fallback on cold start.

async function computeFilterOptions() {
  const [
    rooftopNamesRes,
    rooftopTypesRes,
    rooftopCSMsRes,
    enterprisesRes,
    enterpriseCSMsRes,
    enterpriseTypesRes,
    rooftopBucketFlagsRes,
    enterpriseColFlagsRes,
  ] = await Promise.all([
    query("SELECT DISTINCT name FROM v_by_rooftop WHERE name IS NOT NULL ORDER BY name"),
    query("SELECT DISTINCT type FROM v_by_rooftop WHERE type IS NOT NULL ORDER BY type"),
    query("SELECT DISTINCT csm  FROM v_by_rooftop WHERE csm  IS NOT NULL ORDER BY csm"),
    query("SELECT DISTINCT enterprise_id AS id, enterprise AS name FROM v_by_rooftop WHERE enterprise IS NOT NULL ORDER BY enterprise"),
    query("SELECT DISTINCT csm  FROM v_by_enterprise WHERE csm  IS NOT NULL ORDER BY csm"),
    query("SELECT DISTINCT account_type FROM v_by_enterprise WHERE account_type IS NOT NULL ORDER BY account_type"),
    query(`
      SELECT
        BOOL_OR(bucket_processing_pending > 0) AS bucket_processing_pending,
        BOOL_OR(bucket_publishing_pending > 0) AS bucket_publishing_pending,
        BOOL_OR(bucket_qc_pending         > 0) AS bucket_qc_pending,
        BOOL_OR(bucket_qc_hold            > 0) AS bucket_qc_hold,
        BOOL_OR(bucket_sold               > 0) AS bucket_sold,
        BOOL_OR(bucket_others             > 0) AS bucket_others
      FROM v_by_rooftop
    `),
    query(`
      SELECT
        BOOL_OR(not_integrated_count      > 0) AS has_not_integrated,
        BOOL_OR(publishing_disabled_count > 0) AS has_publishing_disabled
      FROM v_by_enterprise
    `),
  ]);
  const bf = rooftopBucketFlagsRes.rows[0] ?? {};
  const cf = enterpriseColFlagsRes.rows[0]  ?? {};
  return {
    rooftopNames:    rooftopNamesRes.rows.map(r => r.name),
    rooftopTypes:    rooftopTypesRes.rows.map(r => r.type),
    rooftopCSMs:     rooftopCSMsRes.rows.map(r => r.csm),
    enterprises:     enterprisesRes.rows,
    enterpriseCSMs:  enterpriseCSMsRes.rows.map(r => r.csm),
    enterpriseTypes: enterpriseTypesRes.rows.map(r => r.account_type),
    bucketFlags: {
      bucketProcessingPending: bf.bucket_processing_pending ?? false,
      bucketPublishingPending: bf.bucket_publishing_pending ?? false,
      bucketQcPending:         bf.bucket_qc_pending         ?? false,
      bucketQcHold:            bf.bucket_qc_hold            ?? false,
      bucketSold:              bf.bucket_sold               ?? false,
      bucketOthers:            bf.bucket_others             ?? false,
    },
    hasNotIntegrated:      cf.has_not_integrated      ?? false,
    hasPublishingDisabled: cf.has_publishing_disabled ?? false,
  };
}

async function upsertFilterCache(payload) {
  await query(
    `INSERT INTO filter_cache (id, payload, computed_at)
     VALUES ('global', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = $1, computed_at = NOW()`,
    [JSON.stringify(payload)]
  );
}

// ─── GET /api/filter-options ──────────────────────────────────────────────────
// Serves from filter_cache (precomputed at end of each sync) — trivial lookup.
// Falls back to computing on-demand if cache is empty (first deploy).

app.get("/api/filter-options", async (_req, res) => {
  const { rows } = await query(
    "SELECT payload FROM filter_cache WHERE id = 'global'"
  );
  if (rows.length > 0) return res.json(rows[0].payload);
  // Cache not yet populated — compute and store so the next request is instant.
  const payload = await computeFilterOptions();
  await upsertFilterCache(payload);
  res.json(payload);
});

// ─── GET /api/vins ────────────────────────────────────────────────────────────

app.get("/api/vins", async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)     || 1);
  const pageSize = Math.min(500, Math.max(10, parseInt(req.query.pageSize) || 50));
  const offset   = (page - 1) * pageSize;

  const { where, params } = buildVinFilters(req.query);
  const orderBy = buildVinSort(req.query);

  const [countRes, rowsRes] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n ${VIN_FROM} ${where}`, params),
    query(`${VIN_SELECT} ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]),
  ]);

  const total = countRes.rows[0].n;
  res.json({ data: rowsRes.rows.map(toApiRow), total, page, pageSize, pageCount: Math.ceil(total / pageSize) });
});

// Keep old path as alias
app.get("/api/vins/raw", (req, res) => {
  res.redirect(307, `/api/vins?${new URLSearchParams(req.query)}`);
});

// ─── GET /api/rooftops ────────────────────────────────────────────────────────

const ROOFTOP_SORT_MAP = {
  name:                "name",
  type:                "type",
  enterprise:          "enterprise",
  csm:                 "csm",
  total:               "total",
  processed:           "processed",
  notProcessed:        "not_processed",
  notProcessedAfter24: "not_processed_after_24h",
  rate:                "not_processed_after_24h", // proxy: sort by count as approximation
  websiteScore:        "website_score",
};

function buildRooftopFilters(queryParams) {
  const conditions = [];
  const params = [];
  const p = (val) => { params.push(val); return `$${params.length}`; };

  if (queryParams.search) {
    const s = `%${queryParams.search}%`;
    conditions.push(`(name ILIKE ${p(s)} OR rooftop_id ILIKE ${p(s)})`);
  }
  if (queryParams.enterpriseId)   conditions.push(`enterprise_id = ${p(queryParams.enterpriseId)}`);
  if (queryParams.enterprise)     conditions.push(`enterprise = ${p(queryParams.enterprise)}`);
  if (queryParams.type)           conditions.push(`type = ${p(queryParams.type)}`);
  if (queryParams.csm)            conditions.push(`csm = ${p(queryParams.csm)}`);
  if (queryParams.imsIntegration === "Yes") conditions.push("ims_integration_status = 'true'");
  if (queryParams.imsIntegration === "No")  conditions.push("ims_integration_status != 'true'");
  if (queryParams.publishingStatus === "Yes") conditions.push("publishing_status = 'true'");
  if (queryParams.publishingStatus === "No")  conditions.push("publishing_status != 'true'");
  if (queryParams.websiteScore === "Poor (<6)")     conditions.push("website_score < 6");
  if (queryParams.websiteScore === "Average (6\u20138)") conditions.push("(website_score >= 6 AND website_score < 8)");
  if (queryParams.websiteScore === "Good (8+)")     conditions.push("website_score >= 8");

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

app.get("/api/rooftops", async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)     || 1);
  const pageSize = Math.min(500, Math.max(10, parseInt(req.query.pageSize) || 50));
  const offset   = (page - 1) * pageSize;

  const { prefix, from } = buildRooftopSource(req.query.dateFilter);
  const { where, params } = buildRooftopFilters(req.query);
  const sortCol = ROOFTOP_SORT_MAP[req.query.sortBy] ?? "not_processed_after_24h";
  const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
  const orderBy = `ORDER BY ${sortCol} ${sortDir} NULLS LAST`;

  const [countRes, rowsRes] = await Promise.all([
    query(`${prefix} SELECT COUNT(*)::int AS n FROM ${from} ${where}`, params),
    query(`${prefix} SELECT * FROM ${from} ${where} ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]),
  ]);

  const total = countRes.rows[0].n;
  res.json({ data: rowsRes.rows.map(toRooftopRow), total, page, pageSize, pageCount: Math.ceil(total / pageSize) });
});

app.get("/api/rooftops/export", async (req, res) => {
  const { prefix, from } = buildRooftopSource(req.query.dateFilter);
  const { where, params } = buildRooftopFilters(req.query);
  const sortCol = ROOFTOP_SORT_MAP[req.query.sortBy] ?? "not_processed_after_24h";
  const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
  const { rows } = await query(`${prefix} SELECT * FROM ${from} ${where} ORDER BY ${sortCol} ${sortDir} NULLS LAST`, params);
  res.json({ data: rows.map(toRooftopRow) });
});

// ─── GET /api/enterprises ─────────────────────────────────────────────────────

const ENTERPRISE_SORT_MAP = {
  name:                   "name",
  csm:                    "csm",
  total:                  "total",
  processed:              "processed",
  notProcessed:           "not_processed",
  notProcessedAfter24:    "not_processed_after_24h",
  processedAfter24:       "processed_after_24h",
  rate:                   "not_processed_after_24h", // proxy
  rooftopCount:           "rooftop_count",
  notIntegratedCount:     "not_integrated_count",
  publishingDisabledCount:"publishing_disabled_count",
  avgWebsiteScore:        "avg_website_score",
};

function buildEnterpriseFilters(queryParams) {
  const conditions = [];
  const params = [];
  const p = (val) => { params.push(val); return `$${params.length}`; };

  if (queryParams.search) {
    const s = `%${queryParams.search}%`;
    conditions.push(`(name ILIKE ${p(s)} OR id ILIKE ${p(s)})`);
  }
  if (queryParams.csm)         conditions.push(`csm = ${p(queryParams.csm)}`);
  if (queryParams.accountType) conditions.push(`account_type = ${p(queryParams.accountType)}`);
  if (queryParams.websiteScore === "Poor (<6)")     conditions.push("avg_website_score < 6");
  if (queryParams.websiteScore === "Average (6\u20138)") conditions.push("(avg_website_score >= 6 AND avg_website_score < 8)");
  if (queryParams.websiteScore === "Good (8+)")     conditions.push("avg_website_score >= 8");

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

app.get("/api/enterprises", async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)     || 1);
  const pageSize = Math.min(500, Math.max(10, parseInt(req.query.pageSize) || 50));
  const offset   = (page - 1) * pageSize;

  const { prefix, from } = buildEnterpriseSource(req.query.dateFilter);
  const { where, params } = buildEnterpriseFilters(req.query);
  const sortCol = ENTERPRISE_SORT_MAP[req.query.sortBy] ?? "not_processed_after_24h";
  const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
  const orderBy = `ORDER BY ${sortCol} ${sortDir} NULLS LAST`;

  const [countRes, rowsRes] = await Promise.all([
    query(`${prefix} SELECT COUNT(*)::int AS n FROM ${from} ${where}`, params),
    query(`${prefix} SELECT * FROM ${from} ${where} ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]),
  ]);

  const total = countRes.rows[0].n;
  res.json({ data: rowsRes.rows.map(toEnterpriseRow), total, page, pageSize, pageCount: Math.ceil(total / pageSize) });
});

app.get("/api/enterprises/export", async (req, res) => {
  const { prefix, from } = buildEnterpriseSource(req.query.dateFilter);
  const { where, params } = buildEnterpriseFilters(req.query);
  const sortCol = ENTERPRISE_SORT_MAP[req.query.sortBy] ?? "not_processed_after_24h";
  const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
  const { rows } = await query(`${prefix} SELECT * FROM ${from} ${where} ORDER BY ${sortCol} ${sortDir} NULLS LAST`, params);
  res.json({ data: rows.map(toEnterpriseRow) });
});

// ─── GET /api/vins/export ─────────────────────────────────────────────────────

app.get("/api/vins/export", async (req, res) => {
  const { where, params } = buildVinFilters(req.query);
  const orderBy = buildVinSort(req.query);
  const { rows } = await query(`${VIN_SELECT} ${where} ORDER BY ${orderBy}`, params);
  res.json({ data: rows.map(toApiRow) });
});

// ─── GET /api/scheduled-report ───────────────────────────────────────────────
// Called by Vercel Cron at 06:30, 12:30, 18:30 UTC (12:00 PM / 6:00 PM / 12:00 AM IST).
// Workflow: sync data from Metabase → compute summary → build HTML → send email.
// Secured via Vercel's built-in CRON_SECRET: Vercel sends it as
//   Authorization: Bearer <CRON_SECRET>
// so the endpoint rejects anything that doesn't match.

app.get("/api/scheduled-report", async (req, res) => {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Time label (what the email header will show) ───────────────────────────
  const timeLabel = new Date().toLocaleString("en-IN", {
    timeZone:  "Asia/Kolkata",
    hour:      "2-digit",
    minute:    "2-digit",
    hour12:    true,
  }).toUpperCase().replace(/\s+/g, " ");

  const dashboardUrl = process.env.DASHBOARD_URL || "";

  console.log(`[scheduled-report] starting — ${timeLabel}`);

  // ── Step 1: Sync data from Metabase ───────────────────────────────────────
  let syncSkipped = false;
  try {
    const result = await runSync();
    syncSkipped = result.skipped;
    if (syncSkipped) {
      console.warn("[scheduled-report] sync was already running — sending email with cached data");
    } else {
      console.log("[scheduled-report] sync complete");
    }
  } catch (err) {
    // Sync failed (VINs critical failure). Log and fall through to send email
    // with the last cached summary so recipients still get a report.
    console.error("[scheduled-report] sync failed — sending email with cached data:", err?.message);
  }

  // ── Step 2: Compute fresh summary directly from DB ───────────────────────
  // Always query live — never read from cache — so lastSync reflects the
  // sync that just completed, not a previously cached value.
  let summary;
  try {
    summary = await computeSummary(null);
  } catch (err) {
    console.error("[scheduled-report] failed to compute summary:", err?.message);
    return res.status(500).json({ error: "Failed to compute summary data" });
  }

  // ── Step 3: Build HTML and send ───────────────────────────────────────────
  try {
    const html = buildEmailHtml(summary, timeLabel, dashboardUrl);
    await sendReport(html, timeLabel);
    console.log("[scheduled-report] done");
    return res.json({ ok: true, timeLabel, syncSkipped });
  } catch (err) {
    console.error("[scheduled-report] email send failed:", err?.message);
    return res.status(500).json({ error: err?.message });
  }
});

// ─── Vini Account Health — deployment statuses (Supabase, optional) ─────────
// Mirrors Product14/vini-dashboard GET/POST /api/statuses.

app.get("/api/statuses", async (_req, res) => {
  try {
    const statuses = await getAllDeploymentStatuses();
    return res.json(statuses);
  } catch (err) {
    console.error("GET /api/statuses error:", err?.message);
    return res.json({});
  }
});

app.post("/api/statuses", async (req, res) => {
  try {
    const { rooftopKey, rooftopName, enterprise, statuses } = req.body ?? {};
    if (!rooftopKey || !statuses) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    await upsertDeploymentStatus(rooftopKey, rooftopName ?? "", enterprise ?? "", statuses);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/statuses error:", err?.message);
    return res.status(500).json({ error: err?.message ?? "Failed to save" });
  }
});

// ─── GET /api/agents — V3 dual-card passthrough (Metabase) ──────────────────
//
// V3 anchors on activity-day (not lead-creation-day) — fixes the ~3x OB
// appointment undercount we saw in V2. Two cards:
//   • daily  — agents_v2_daily — per-day rows. Distinct-count fields
//              (touched_leads, qualified_leads, appointments) are per-day,
//              so summing across days double-counts. Used for the chart +
//              per-day expanded rooftop rows.
//   • totals — agents_v2_totals — one row per (team × agent_type),
//              deduplicated at the lead level. Used for KPI cards + collapsed
//              rooftop summary. DO NOT compute totals from daily client-side.
//
// Volume fields (total_calls, total_sms, appointment_value) ARE sum-friendly.
// Both cards share Metabase filter params: activity_date, rooftop_stage,
// team_id, enterprise_name, agent_type — currently fetched without params,
// so totals reflect the card's default scope (all-time).

const AGENTS_DAILY_URL =
  "https://metabase.spyne.ai/api/public/card/b5f956e3-faee-4989-b5bf-6510de631deb/query/json";
const AGENTS_TOTALS_URL =
  "https://metabase.spyne.ai/api/public/card/a4bd2fd4-3d76-44c2-959a-d4abdbc57191/query/json";

// Internal / test rooftops that leak through Metabase's agent query. They have
// activity rows (the agents were prompted there during demos / setup) but they
// are not real customer deployments and would otherwise pollute every tab —
// notably the "no-sheet" mode where the master accounts sheet isn't used to
// gate the rooftop universe. Match is case-insensitive against rooftop_name.
const AGENT_ROOFTOP_EXCLUDE = new Set([
  "team 1", "team1",
  "spyne motors", "spyne", "spyne auto group",
  "khandelwal", "prompt testing", "speed to lead", "approval genie",
  "onboardtest3", "onboardtest4",
  "used inventory",
]);
function isExcludedAgentRooftop(row) {
  const name = String(row?.rooftop_name ?? "").trim().toLowerCase();
  return AGENT_ROOFTOP_EXCLUDE.has(name);
}

// Numeric agent-card fields that should be summed when collapsing duplicates.
// Includes both the old (total_sms) and new (total_sms_conversations) variants
// the Metabase cards have flipped between, so dedupe survives schema changes.
const AGENT_NUMERIC_FIELDS = [
  "touched_leads", "leads_with_calls", "leads_with_sms",
  "qualified_leads", "appointments", "appointment_value",
  "total_calls", "total_sms", "total_sms_conversations",
  "total_inbound_human_msgs",
  // Inbound-only outcome counts (added in the latest card revision). Distinct
  // lead counts per (team × agent_type), so additive across dupes like the
  // other distinct-count fields. Null/absent on Outbound rows.
  "appointment_intent_leads", "transfer_leads", "callback_leads",
];
// Fields that are NOT additive across dupes — rolling-window totals
// (new_leads_created, leads_contacted_from_new) are constant across all
// daily rows of the same (rooftop × service_type), and rates (capture_rate,
// abr) can't be summed. Take MAX so a real-row + zero-ghost pair collapses
// to the real value.
const AGENT_MAX_FIELDS = [
  "new_leads_created", "leads_contacted_from_new", "capture_rate", "abr",
];
const AGENT_KEEP_FIELDS = [
  "enterprise_id", "enterprise_name", "rooftop_name", "rooftop_stage",
  "service_type", "direction", "pld.team_id", "pld.enterprise_id",
];
// Read a field with a sibling-key fallback — the totals card emits team_id /
// enterprise_id as `pld.team_id` / `pld.enterprise_id`, the daily card emits
// them bare. Without the fallback every totals row collapses to "::<agent>"
// and you get one merged row per agent_type (heavily over-summed).
const KEY_FIELD_FALLBACKS = {
  team_id: ["pld.team_id"],
  enterprise_id: ["pld.enterprise_id"],
};
function readKeyField(row, field) {
  const direct = row?.[field];
  if (direct != null && direct !== "") return direct;
  for (const alt of KEY_FIELD_FALLBACKS[field] ?? []) {
    const v = row?.[alt];
    if (v != null && v !== "") return v;
  }
  return "";
}
// Merge agent rows by composite key (e.g. team_id+agent_type[+day]). Numeric
// fields are summed; identity/string fields take the first non-empty value;
// `conversion_rate` is recomputed (appointments / touched_leads) when both
// inputs are present so the merged row stays internally consistent. Normalises
// total_sms ↔ total_sms_conversations into total_sms so the dashboard's
// projectRow doesn't need to care which variant the card emitted.
function mergeAgentRows(rows, keyFields) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFields.map(f => String(readKeyField(r, f))).join("::");
    let acc = m.get(k);
    if (!acc) {
      acc = {};
      for (const f of keyFields) acc[f] = r[f];
      for (const f of AGENT_KEEP_FIELDS) if (r[f] != null && r[f] !== "") acc[f] = r[f];
      for (const f of AGENT_NUMERIC_FIELDS) acc[f] = 0;
      for (const f of AGENT_MAX_FIELDS) acc[f] = null;
      acc.agent_type = r.agent_type;
      m.set(k, acc);
    }
    // Sum numerics. Skip nulls; coerce to number safely.
    for (const f of AGENT_NUMERIC_FIELDS) {
      const v = r[f];
      if (v == null) continue;
      const n = Number(v);
      if (Number.isFinite(n)) acc[f] = (acc[f] ?? 0) + n;
    }
    // Max-preserve for non-additive fields (rolling totals + rates).
    for (const f of AGENT_MAX_FIELDS) {
      const v = r[f];
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (acc[f] == null || n > acc[f]) acc[f] = n;
    }
    // Backfill identity fields if the first row had blanks.
    for (const f of AGENT_KEEP_FIELDS) {
      if ((acc[f] == null || acc[f] === "") && r[f] != null && r[f] !== "") acc[f] = r[f];
    }
  }
  // Normalise SMS field + recompute conversion_rate post-merge so summed rows
  // expose a single canonical sms column and a self-consistent conversion %.
  for (const acc of m.values()) {
    if ((acc.total_sms == null || acc.total_sms === 0) && acc.total_sms_conversations) {
      acc.total_sms = acc.total_sms_conversations;
    }
    acc.conversion_rate =
      acc.touched_leads > 0 ? acc.appointments / acc.touched_leads : null;
  }
  return Array.from(m.values());
}

let agentsCache = { daily: null, totals: null, fetchedAt: 0, source: null };
let agentsInflight = null; // single-flight: concurrent callers share one query set
const AGENTS_TTL_MS = 5 * 60 * 1000; // matches the agents-refresh-incremental cron + frontend poll cadence

// Run the rooftop aggregation once and return the bundle. The expensive part
// (~66s of ClickHouse base_fact scans) lives here; callers persist the result so
// page loads never pay for it. Same source the Overall view uses → the two
// views reconcile. GROUP BY yields one row per key (no dedup needed).
async function computeRooftopBundle() {
  let dailyRows, totalsRows, source;
  if (hasClickhouseCreds()) {
    const { daily, totals } = await runAgentRooftops();
    dailyRows  = (Array.isArray(daily)  ? daily  : []).filter(r => !isExcludedAgentRooftop(r));
    totalsRows = (Array.isArray(totals) ? totals : []).filter(r => !isExcludedAgentRooftop(r));
    source = "clickhouse-q12227";
    console.log(`[api/agents] ClickHouse Q12227 — daily ${dailyRows.length}, totals ${totalsRows.length} rows`);
  } else {
    // Fallback (only when CLICKHOUSE_* is unset): legacy Metabase agents_v2
    // cards. Drop internal/test rooftops, then de-dup the multiple rows
    // Metabase emits per (team × agent [× day]).
    const [daily, totals] = await Promise.all([
      fetchFromMetabase(AGENTS_DAILY_URL, "AGENTS_DAILY", 1, 60000),
      fetchFromMetabase(AGENTS_TOTALS_URL, "AGENTS_TOTALS", 1, 60000),
    ]);
    const filteredDaily  = (Array.isArray(daily)  ? daily  : []).filter(r => !isExcludedAgentRooftop(r));
    const filteredTotals = (Array.isArray(totals) ? totals : []).filter(r => !isExcludedAgentRooftop(r));
    dailyRows  = mergeAgentRows(filteredDaily,  ["team_id", "agent_type", "day"]);
    totalsRows = mergeAgentRows(filteredTotals, ["team_id", "agent_type"]);
    source = "metabase-agents_v2";
    console.log(`[api/agents] Metabase fallback — daily ${dailyRows.length}, totals ${totalsRows.length} rows`);
  }
  return { source, daily: dailyRows, totals: totalsRows };
}

function serializeAgents(c) {
  return {
    fetchedAt: new Date(c.fetchedAt).toISOString(),
    source: c.source,
    dailyRowCount: c.daily.length,
    totalsRowCount: c.totals.length,
    daily: c.daily,
    totals: c.totals,
  };
}

// Compute + persist to the cron-backed cache; refresh the in-process copy too.
async function refreshRooftopCache() {
  const bundle = await computeRooftopBundle();
  agentsCache = { ...bundle, fetchedAt: Date.now() };
  await writeAgentCache(AGENT_CACHE_KEY_ROOFTOP, bundle);
  return bundle;
}

// ── Partial refreshes ─────────────────────────────────────────────────────
// `totals` is a uniqExact(lead_id) distinct count over the whole 120-day
// window, not a sum of `daily` rows, so it can't be derived from cached daily
// data (see agentRooftop.js). These two therefore refresh independently:
// `daily` from a narrow (today + buffer) scan merged into the existing cache,
// `totals` from the full-window scan replacing the cached totals wholesale.
// Both fall back to a full compute if nothing is cached yet to merge into.
function mergeRooftopDaily(cachedDaily, freshDaily) {
  const keyOf = (r) => `${r.team_id}|${r.agent_type}|${r.day}`;
  const merged = new Map((cachedDaily || []).map((r) => [keyOf(r), r]));
  for (const r of freshDaily) merged.set(keyOf(r), r);
  return [...merged.values()];
}

async function loadRooftopBase() {
  if (agentsCache.daily) return agentsCache;
  const cached = await readAgentCache(AGENT_CACHE_KEY_ROOFTOP);
  return cached?.payload?.daily ? cached.payload : null;
}

async function refreshRooftopCacheIncremental() {
  if (!hasClickhouseCreds()) return null;
  const base = await loadRooftopBase();
  if (!base) return refreshRooftopCache();
  const { daily } = await runAgentRooftopsIncremental();
  const fresh = daily.filter((r) => !isExcludedAgentRooftop(r));
  const bundle = { source: base.source, daily: mergeRooftopDaily(base.daily, fresh), totals: base.totals };
  agentsCache = { ...bundle, fetchedAt: Date.now() };
  await writeAgentCache(AGENT_CACHE_KEY_ROOFTOP, bundle);
  return bundle;
}

async function refreshRooftopCacheTotalsOnly() {
  if (!hasClickhouseCreds()) return null;
  const base = await loadRooftopBase();
  if (!base) return refreshRooftopCache();
  const { totals } = await runAgentRooftopsTotalsOnly();
  const bundle = { source: base.source, daily: base.daily, totals: totals.filter((r) => !isExcludedAgentRooftop(r)) };
  agentsCache = { ...bundle, fetchedAt: Date.now() };
  await writeAgentCache(AGENT_CACHE_KEY_ROOFTOP, bundle);
  return bundle;
}

// Serving order: (1) warm in-process cache, (2) the precomputed Postgres cache
// the cron keeps fresh (instant, no ClickHouse), (3) live compute on a cold
// first-ever load or ?refresh=1. The page never blocks on ClickHouse once the
// cron has run at least once.
app.get("/api/agents", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    // Edge-cache the (small, brotli'd ~200 KB) payload at Vercel's CDN. The data
    // is daily-grain and the cron refreshes every 30 min, so a stale copy is
    // harmless: `stale-while-revalidate` lets the edge serve the last good bundle
    // INSTANTLY (~10 ms) while it revalidates in the background — the first
    // visitor after a scale-to-zero never waits on a cold lambda + Postgres read,
    // let alone a live ClickHouse scan. `?refresh=1` is uncacheable by design.
    if (!force) {
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    }
    if (!force && agentsCache.daily && agentsCache.totals
        && (Date.now() - agentsCache.fetchedAt) < AGENTS_TTL_MS) {
      return res.json(serializeAgents(agentsCache));
    }
    if (!force) {
      const cached = await readAgentCache(AGENT_CACHE_KEY_ROOFTOP);
      if (cached?.payload?.daily && cached?.payload?.totals) {
        agentsCache = { ...cached.payload, fetchedAt: new Date(cached.computedAt).getTime() };
        return res.json(serializeAgents(agentsCache));
      }
    }
    // Reuse an in-flight run instead of launching another (avoids stacking
    // memory-heavy ClickHouse scans when several clients refresh at once).
    if (!agentsInflight) {
      agentsInflight = refreshRooftopCache().finally(() => { agentsInflight = null; });
    }
    await agentsInflight;
    return res.json(serializeAgents(agentsCache));
  } catch (err) {
    console.error("GET /api/agents error:", err?.message);
    // Never let the edge cache a failure — a transient ClickHouse blip would
    // otherwise be pinned for the whole s-maxage window.
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: err?.message ?? "Failed to load agents data" });
  }
});

// ─── GET /api/agent-stages — Rooftop → stage mapping (Google Sheet CSVs) ─────
//
// Config: STAGES_SHEET_URLS env var holds a JSON object mapping stage name to
// a published-as-CSV Google Sheet URL — one sheet per stage. Each sheet is a
// roster of rooftops currently at that stage; the dashboard overrides
// Metabase's rooftop_stage using these. Example:
//
//   STAGES_SHEET_URLS={"Live":"https://docs.google.com/.../export?format=csv&gid=46675906",
//                      "Onboarding":"https://docs.google.com/.../export?format=csv&gid=2053683245"}
//
// Sheets must have a header row containing a "Rooftop Name" column (case-
// insensitive). Other rows + columns are ignored. Empty/duplicate rooftop names
// are dropped. If a sheet fails to fetch, its stage is reported in `errors`
// and other stages still load.

const STAGES_TTL_MS = 10 * 60 * 1000; // 10 minutes
let stagesCache = { data: null, fetchedAt: 0 };

// Full CSV parser — handles quoted fields AND embedded newlines inside quotes.
// Returns array of rows; each row is array of trimmed cell strings.
function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;
  const flushCell = () => { row.push(cur.trim()); cur = ""; };
  const flushRow = () => { rows.push(row); row = []; };
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQ) {
      if (ch === '"' && csv[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") flushCell();
      else if (ch === "\r") { /* swallow */ }
      else if (ch === "\n") { flushCell(); flushRow(); }
      else cur += ch;
    }
  }
  // Tail
  if (cur.length > 0 || row.length > 0) { flushCell(); flushRow(); }
  return rows;
}

// Find the header row index by looking for "Rooftop Name". Some sheets have
// summary rows or grouping rows above the real header (the OB sheet has 2 rows
// of metadata before its header).
function findRooftopNameColumn(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cells = rows[r].map(s => s.toLowerCase());
    const col = cells.findIndex(c => c === "rooftop name");
    if (col >= 0) return { headerRow: r, col };
  }
  return null;
}

function extractRooftopNames(csv) {
  const rows = parseCsv(csv);
  const loc = findRooftopNameColumn(rows);
  if (!loc) return [];
  const out = [];
  const seen = new Set();
  for (let i = loc.headerRow + 1; i < rows.length; i++) {
    const v = (rows[i][loc.col] ?? "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

// ─── sheet_cache helpers (Postgres-backed fallback for Google Sheet fetches) ──

async function readSheetCache(source) {
  try {
    const { rows } = await query(
      "SELECT payload, fetched_at FROM sheet_cache WHERE source = $1",
      [source]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.warn(`[sheet_cache:${source}] read failed:`, err?.message);
    return null;
  }
}

async function writeSheetCache(source, payload) {
  try {
    await query(
      `INSERT INTO sheet_cache (source, payload, fetched_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (source) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW()`,
      [source, JSON.stringify(payload)]
    );
  } catch (err) {
    console.warn(`[sheet_cache:${source}] write failed:`, err?.message);
  }
}

function parseStageSheetUrls() {
  const raw = process.env.STAGES_SHEET_URLS;
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

app.get("/api/agent-stages", async (req, res) => {
  const sheetUrls = parseStageSheetUrls();
  if (!sheetUrls) {
    // No env config — but a previous run may have populated the persistent cache.
    // Surface it so the dashboard keeps working even with the env var unset.
    const cached = await readSheetCache("stages");
    if (cached) {
      return res.json({
        ...cached.payload,
        fetchedAt: cached.fetched_at,
        cached: true,
        note: "Served from sheet_cache (STAGES_SHEET_URLS unconfigured this deploy)",
      });
    }
    return res.json({
      stages: {}, rooftopToStage: {}, errors: {},
      note: "STAGES_SHEET_URLS not configured (set JSON: {\"Live\":\"...csv-url\",\"Onboarding\":\"...csv-url\"})",
    });
  }
  try {
    const force = req.query.refresh === "1";
    const fresh = !force && stagesCache.data && (Date.now() - stagesCache.fetchedAt) < STAGES_TTL_MS;
    if (!fresh) {
      const entries = Object.entries(sheetUrls);
      const results = await Promise.allSettled(entries.map(async ([stage, url]) => {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const csv = await resp.text();
        const names = extractRooftopNames(csv);
        return { stage, names };
      }));

      const stages = {};
      const errors = {};
      const rooftopToStage = {};
      let anySuccess = false;
      results.forEach((r, idx) => {
        const stage = entries[idx][0];
        if (r.status === "fulfilled") {
          anySuccess = true;
          stages[stage] = r.value.names;
          for (const name of r.value.names) {
            const key = name.toLowerCase().trim();
            // First sheet to claim a name wins; record any conflicts.
            if (!rooftopToStage[key]) rooftopToStage[key] = stage;
          }
        } else {
          errors[stage] = r.reason?.message ?? "fetch failed";
          stages[stage] = [];
        }
      });
      // If every sheet failed (Google unreachable / sheet unpublished), fall back to
      // the last good DB payload so consumers keep working with slightly stale data.
      if (!anySuccess) {
        const cached = await readSheetCache("stages");
        if (cached) {
          stagesCache = {
            data: { ...cached.payload, errors, stale: true },
            fetchedAt: new Date(cached.fetched_at).getTime(),
          };
          return res.json({
            ...stagesCache.data,
            fetchedAt: cached.fetched_at,
            cached: true,
            note: "All sheet fetches failed — served from sheet_cache",
          });
        }
      }
      stagesCache = {
        data: { stages, rooftopToStage, errors },
        fetchedAt: Date.now(),
      };
      // Persist on any partial success — better to keep a partial-stage snapshot than
      // to lose stages we already had cached when one of the sheets goes unavailable.
      if (anySuccess) await writeSheetCache("stages", stagesCache.data);
    }
    return res.json({
      ...stagesCache.data,
      fetchedAt: new Date(stagesCache.fetchedAt).toISOString(),
    });
  } catch (err) {
    console.error("GET /api/agent-stages error:", err?.message);
    // Last-ditch fallback — anything we can serve is better than 500.
    const cached = await readSheetCache("stages");
    if (cached) {
      return res.json({
        ...cached.payload,
        fetchedAt: cached.fetched_at,
        cached: true,
        note: `Served from sheet_cache after error: ${err?.message ?? "unknown"}`,
      });
    }
    return res.status(500).json({
      error: err?.message ?? "Failed to load stages",
      stages: {}, rooftopToStage: {}, errors: {},
    });
  }
});

// ─── GET /api/accounts-sheet — Vini funnel master sheet (Google Sheet CSV) ────
//
// Source: the "Devansh_Vini_Funnel" workbook, read across two tabs and merged
// into one row per (rooftop × agent_type). This sheet is the source of truth for
// the dashboard's three account stages — Live, Churned, In OB:
//   • Master tab (gid=0): Account / Team ID / Agent Opted / Stage (Live|Churned)
//     / MRR / ARR — supplies the Live and Churned rooftops.
//   • In-OB tab (gid=327747468): Rooftop_ID / Agent_Type / Status (OB Initiated)
//     / ARR — supplies the In OB rooftops (untracked OB/Sales drops are excluded).
//
// Config: ALL_ACCOUNTS_SHEET_URL (master tab) and INOB_SHEET_URL (in-OB tab)
// env vars, each a CSV-export URL. When unset they default to the public CSV
// exports below. Data is cached in-process for 10 minutes and persisted to
// sheet_cache so a failed Google fetch falls back to the last good snapshot
// instead of breaking the dashboard.

const FUNNEL_SHEET_ID = "15BScfybsSmmvQefXQxN-TYA_-cCNkD8qLDui7EML3ss";
const DEFAULT_ACCOUNTS_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${FUNNEL_SHEET_ID}/export?format=csv&gid=0`;
const DEFAULT_INOB_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${FUNNEL_SHEET_ID}/export?format=csv&gid=327747468`;
const ACCOUNTS_TTL_MS = 10 * 60 * 1000;
let accountsCache = { data: null, fetchedAt: 0 };

// Build a header→index map from the row containing "Rooftop Name". Header
// labels are normalised to lower-case + trimmed; multiple columns with the same
// label (the sheet has two "Enterprise Type" columns side by side) collapse to
// the first occurrence, which is what we want.
// Header labels are normalised to lower-case, with underscores treated as
// spaces, so the two tabs of the funnel sheet line up despite different
// conventions: the master tab uses "Rooftop Name" / "Team ID" / "Agent Opted"
// while the in-OB tab uses "Rooftop_Name" / "Rooftop_ID" / "Agent_Type".
function buildHeaderIndex(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cells = rows[r].map(s => s.toLowerCase().replace(/_/g, " ").trim());
    if (cells.includes("rooftop name")) {
      const idx = {};
      cells.forEach((c, i) => { if (c && !(c in idx)) idx[c] = i; });
      return { headerRow: r, idx };
    }
  }
  return null;
}

// "$1,499" / "1499" / "1,499.50" → 1499.5 (number) or null. Empty / non-numeric
// → null. We treat null as "no MRR provided" so the UI can grey it out instead
// of showing $0 — that distinction matters for accounts that genuinely cost $0
// vs accounts we just don't have data for.
function parseMoney(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "—" || s.startsWith("✏")) return null;
  // Strip currency glyphs ($, ₹, €, £) — the in-OB tab quotes ARR in ₹ while
  // the master tab uses $; the number itself is the same magnitude either way.
  const cleaned = s.replace(/[$₹€£,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Parse the master tab's "Go-Live Date" column. Sheet uses "D-MMM-YY"
// (e.g. "4-Aug-25" → "2025-08-04"). Returns an ISO date string or null.
const GO_LIVE_MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseGoLiveDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.startsWith("✏")) return null;
  const m = s.match(/^(\d{1,2})[-\s\/]([A-Za-z]{3,9})[-\s\/](\d{2,4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = GO_LIVE_MONTHS[m[2].slice(0,3).toLowerCase()];
  let yr = Number(m[3]);
  if (mon == null || !Number.isFinite(day) || !Number.isFinite(yr)) return null;
  if (yr < 100) yr += 2000;
  const d = new Date(Date.UTC(yr, mon, day));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Collapse every funnel-sheet stage label to exactly one of the three buckets
// the dashboard exposes — Live / Churned / In OB — or null for rows we don't
// track (e.g. "OB Drop", "Sales Drop": rooftops lost before go-live).
//   • master tab "Stage":  Live | Churned
//   • in-OB tab "Status":  OB Initiated (→ In OB) | OB Drop | Sales Drop | Churned
function normalizeStage(raw) {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return null;
  if (s === "live") return "Live";
  if (s === "churned") return "Churned";
  if (s === "ob initiated" || s === "in ob" || s === "onboarding" || s === "in implementation") return "In OB";
  return null;
}

// Rows like "39 rooftops" / "12 rooftops" — the sheet rolls up bulk PWS quotes
// at the top under a fake rooftop name. They aren't real accounts and would
// otherwise inflate MRR totals if a downstream consumer summed agentMrr.
const AGGREGATE_NAME_RE = /^\d+\s+rooftops?$/i;

// Extract raw account rows from one CSV tab of the funnel sheet. Column lookups
// accept aliases so the same code reads both the master tab (Account / Team ID /
// Agent Opted / Stage / MRR / ARR) and the in-OB tab (Enterprise_Name /
// Rooftop_ID / Agent_Type / Status / ARR). Stage is collapsed to Live / Churned
// / In OB via normalizeStage; rows whose stage falls outside those three buckets
// (untracked OB/Sales drops, blank, TBC agent) are dropped and counted.
function extractAccountRows(csv) {
  const rows = parseCsv(csv);
  const hdr = buildHeaderIndex(rows);
  if (!hdr) return { rows: [], droppedAggregate: 0, droppedStage: 0 };

  const pick = (...keys) => { for (const k of keys) if (hdr.idx[k] != null) return hdr.idx[k]; return undefined; };
  const COL = {
    enterpriseName: pick("enterprise name", "enterrprise name", "account"),
    rooftopName:    pick("rooftop name"),
    agentType:      pick("agent type", "agent opted"),
    currentStage:   pick("current stage", "stage", "status"),
    subStage:       pick("sub stage", "current month confirmations"),
    enterpriseId:   pick("enterprise id"),
    rooftopId:      pick("rooftop id", "team id"),
    agentMrr:       pick("agent mrr", "mrr"),
    collectedMrr:   pick("collected mrr"),
    agentCarr:      pick("agent carr", "arr", "$arr"),
    goLiveDate:     pick("go-live date", "go live date", "live date"),
    csmEmail:       pick("csm name", "csm email", "csm"),
  };
  // Rooftop Name is the only strictly required column.
  if (COL.rooftopName == null) return { rows: [], droppedAggregate: 0, droppedStage: 0 };

  const out = [];
  let droppedAggregate = 0;
  let droppedStage = 0;
  for (let i = hdr.headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = (row[COL.rooftopName] ?? "").trim();
    if (!name) continue;
    // Placeholder row (the sheet has a "✏ INPUT" row right under the header).
    if (name.startsWith("✏")) continue;
    if (AGGREGATE_NAME_RE.test(name)) { droppedAggregate++; continue; }

    // Collapse to Live / Churned / In OB. Anything else (OB Drop, Sales Drop,
    // blank) is not one of the three tracked buckets — drop it.
    const stage = normalizeStage(COL.currentStage != null ? row[COL.currentStage] : "");
    if (!stage) { droppedStage++; continue; }

    const agentCarr = COL.agentCarr != null ? parseMoney(row[COL.agentCarr]) : null;
    let agentMrr = COL.agentMrr != null ? parseMoney(row[COL.agentMrr]) : null;
    // The in-OB tab carries ARR but no monthly figure — derive MRR from it so
    // the dashboard's MRR column/filter is populated for in-onboarding rooftops.
    if (agentMrr == null && agentCarr != null) agentMrr = Math.round(agentCarr / 12);

    const entry = {
      enterpriseName: COL.enterpriseName != null ? (row[COL.enterpriseName] ?? "").trim() : "",
      rooftopName:    name,
      agentType:      COL.agentType != null ? (row[COL.agentType] ?? "").trim() : "",
      currentStage:   stage,
      subStage:       COL.subStage != null ? (row[COL.subStage] ?? "").trim() : "",
      enterpriseId:   COL.enterpriseId != null ? (row[COL.enterpriseId] ?? "").trim() : "",
      rooftopId:      COL.rooftopId != null ? (row[COL.rooftopId] ?? "").trim() : "",
      agentMrr,
      collectedMrr:   COL.collectedMrr != null ? parseMoney(row[COL.collectedMrr]) : null,
      agentCarr,
      goLiveDate:     COL.goLiveDate != null ? parseGoLiveDate(row[COL.goLiveDate]) : null,
      csmEmail:       (() => {
        if (COL.csmEmail == null) return null;
        const raw = (row[COL.csmEmail] ?? "").trim();
        if (!raw || raw.startsWith("✏")) return null;
        // Only accept values that look like an email — the column header
        // is "CSM Name" but the data is emails; some rows may be free-text.
        return /@/.test(raw) ? raw.toLowerCase() : null;
      })(),
    };
    // Skip rows that don't identify an agent — agent_type drives the dashboard's
    // per-tab join, so "TBC"-only / blank-agent rows are not addressable.
    if (!entry.agentType || entry.agentType.toUpperCase() === "TBC") {
      droppedAggregate++;
      continue;
    }
    out.push(entry);
  }
  return { rows: out, droppedAggregate, droppedStage };
}

// Collapse duplicates by (team_id, agent_type) across the merged master + in-OB
// rows. Duplicates arise within a tab (~7 pairs in the master tab) and across
// tabs (a rooftop×agent that is Live in the master tab but also appears as In OB
// in the in-OB roster). On conflict we keep the higher-priority stage —
// Churned > Live > In OB — so a gone-live rooftop never regresses to In OB, and
// within a stage we keep the higher-MRR row.
function dedupeAccounts(allRows) {
  const STAGE_PRIORITY = { "Churned": 4, "Live": 3, "In OB": 2 };
  const stagePriority = (s) => STAGE_PRIORITY[s] ?? 1;
  const dedupKey = (e) => e.rooftopId ? `tid:${e.rooftopId}::${e.agentType}` : `name:${e.rooftopName.toLowerCase()}::${e.agentType}`;
  const merged = new Map();
  let dedupedDuplicates = 0;
  for (const e of allRows) {
    const k = dedupKey(e);
    const prev = merged.get(k);
    if (!prev) { merged.set(k, e); continue; }
    dedupedDuplicates++;
    const keepNew =
      stagePriority(e.currentStage) > stagePriority(prev.currentStage) ||
      (stagePriority(e.currentStage) === stagePriority(prev.currentStage) &&
        (e.agentMrr ?? 0) > (prev.agentMrr ?? 0));
    if (keepNew) merged.set(k, e);
  }
  const namesSeen = new Set();
  for (const e of merged.values()) namesSeen.add(e.rooftopName);

  return {
    rows: Array.from(merged.values()),
    rooftopNames: Array.from(namesSeen),
    dedupedDuplicates,
  };
}

// Fetch + parse both funnel tabs and merge into a single deduped account list:
// the master tab supplies Live / Churned, the in-OB tab supplies In OB. Either
// fetch failing on its own doesn't sink the whole response — we merge whatever
// parsed successfully (a master-only result is still useful).
async function fetchAccountsSheet() {
  const masterUrl = (process.env.ALL_ACCOUNTS_SHEET_URL || DEFAULT_ACCOUNTS_SHEET_URL).trim();
  const inObUrl = (process.env.INOB_SHEET_URL || DEFAULT_INOB_SHEET_URL).trim();

  const fetchCsv = async (url) => {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  };

  const [masterRes, inObRes] = await Promise.allSettled([fetchCsv(masterUrl), fetchCsv(inObUrl)]);
  if (masterRes.status === "rejected" && inObRes.status === "rejected") {
    throw new Error(masterRes.reason?.message ?? "both account tabs failed to fetch");
  }

  const allRows = [];
  let droppedAggregate = 0, droppedStage = 0;
  const errors = {};
  for (const [tab, res] of [["master", masterRes], ["inOb", inObRes]]) {
    if (res.status === "fulfilled") {
      const ex = extractAccountRows(res.value);
      allRows.push(...ex.rows);
      droppedAggregate += ex.droppedAggregate;
      droppedStage += ex.droppedStage;
    } else {
      errors[tab] = res.reason?.message ?? "fetch failed";
    }
  }

  return { ...dedupeAccounts(allRows), droppedAggregate, droppedStage, errors };
}

app.get("/api/accounts-sheet", async (req, res) => {
  const force = req.query.refresh === "1";
  const fresh = !force && accountsCache.data && (Date.now() - accountsCache.fetchedAt) < ACCOUNTS_TTL_MS;
  if (fresh) {
    return res.json({
      ...accountsCache.data,
      fetchedAt: new Date(accountsCache.fetchedAt).toISOString(),
    });
  }

  try {
    const parsed = await fetchAccountsSheet();
    accountsCache = { data: parsed, fetchedAt: Date.now() };
    await writeSheetCache("accounts", parsed);
    return res.json({
      ...parsed,
      fetchedAt: new Date(accountsCache.fetchedAt).toISOString(),
    });
  } catch (err) {
    console.error("GET /api/accounts-sheet — fetch failed:", err?.message);
    // Fall back to the last successful payload from sheet_cache (or in-memory if DB read fails).
    const cached = await readSheetCache("accounts");
    if (cached) {
      accountsCache = {
        data: cached.payload,
        fetchedAt: new Date(cached.fetched_at).getTime(),
      };
      return res.json({
        ...cached.payload,
        fetchedAt: cached.fetched_at,
        cached: true,
        note: `Served from sheet_cache (Google fetch failed: ${err?.message ?? "unknown"})`,
      });
    }
    if (accountsCache.data) {
      return res.json({
        ...accountsCache.data,
        fetchedAt: new Date(accountsCache.fetchedAt).toISOString(),
        cached: true,
        note: `Served from in-memory cache (Google fetch failed: ${err?.message ?? "unknown"})`,
      });
    }
    return res.status(503).json({
      error: err?.message ?? "Failed to fetch accounts sheet",
      rows: [], rooftopNames: [],
    });
  }
});

// ─── GET /api/dream — Dream Automotive · Lead Activity ─────────────────────
//
// Source: Metabase card dc97f9c0-4a31-43ef-a7ac-66f339fc2620.
// Each Metabase row = one (lead × activity × meeting × action_item) tuple.
// We dedupe activities by (lead_id, activity_at, activity_type) and group
// activities under their parent lead. Browser receives one entry per lead
// with the full activity timeline embedded.

const DREAM_METABASE_URL =
  "https://metabase.spyne.ai/api/public/card/dc97f9c0-4a31-43ef-a7ac-66f339fc2620/query/json";

let dreamCache = { data: null, fetchedAt: 0, rawCount: 0 };
const DREAM_TTL_MS = 5 * 60 * 1000;

function aggregateDream(rawRows) {
  // Pass 1: dedupe activities. Key = (lead_id, activity_at, activity_type) — the
  // fanout is from LEFT JOINs against meetings/action_items so the same activity
  // appears multiple times.
  const actByKey = new Map();
  // Pass 2: collect lead metadata and per-lead meeting/action-item sets.
  const leads = new Map();

  for (const r of rawRows) {
    const leadId = r["l.lead_id"];
    if (!leadId) continue;

    let lead = leads.get(leadId);
    if (!lead) {
      lead = {
        leadId,
        teamId: r["l.team_id"] || null,
        leadCreatedAt: r.lead_created_at || null,
        leadSource: r.lead_source || null,
        leadStage: r.lead_stage || null,
        customerName: r.customer_name || null,
        customerPhone: r.customer_phone || null,
        meetingIds: new Set(),
        actionItemIds: new Set(),
        appointmentPitched: false,
        appointmentScheduled: false,
        firstActivityAt: null,
        lastActivityAt: null,
        callCount: 0,
        smsCount: 0,
        inboundCount: 0,
        outboundCount: 0,
        activities: [],
      };
      leads.set(leadId, lead);
    }

    // Roll up freshest non-null lead metadata (the LEFT JOINs sometimes null these).
    if (!lead.customerName  && r.customer_name)  lead.customerName  = r.customer_name;
    if (!lead.customerPhone && r.customer_phone) lead.customerPhone = r.customer_phone;
    if (!lead.leadSource    && r.lead_source)    lead.leadSource    = r.lead_source;
    if (!lead.leadStage     && r.lead_stage)     lead.leadStage     = r.lead_stage;
    if (r.meeting_id)     lead.meetingIds.add(r.meeting_id);
    if (r.action_item_id) lead.actionItemIds.add(r.action_item_id);
    if (r.appointment_pitched   === "Yes") lead.appointmentPitched   = true;
    if (r.appointment_scheduled === "Yes") lead.appointmentScheduled = true;

    // Dedupe activity. Some rows have null activity_type (lead-only rows from the
    // LEFT JOIN); skip them — they don't represent a real activity.
    if (!r.activity_type || !r.activity_at) continue;
    const actKey = `${leadId}::${r.activity_at}::${r.activity_type}`;
    if (actByKey.has(actKey)) continue;

    const activity = {
      type: r.activity_type,                       // call | sms
      at: r.activity_at,
      direction: r.direction || null,              // "Inbound" | "Outbound"
      status: r.activity_status || null,
      callType: r.call_type || null,
      endedReason: r.call_ended_reason || null,
      agent: r.agent_name || null,
      campaignId: r.campaign_id || null,
      summary: r.call_summary || null,
    };
    actByKey.set(actKey, activity);
    lead.activities.push(activity);

    if (activity.type === "call")  lead.callCount++;
    else if (activity.type === "sms")  lead.smsCount++;
    if (activity.direction === "Inbound")  lead.inboundCount++;
    else if (activity.direction === "Outbound") lead.outboundCount++;

    if (!lead.firstActivityAt || activity.at < lead.firstActivityAt) lead.firstActivityAt = activity.at;
    if (!lead.lastActivityAt  || activity.at > lead.lastActivityAt)  lead.lastActivityAt  = activity.at;
  }

  const out = [];
  for (const lead of leads.values()) {
    lead.activities.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    out.push({
      leadId: lead.leadId,
      teamId: lead.teamId,
      leadCreatedAt: lead.leadCreatedAt,
      leadSource: lead.leadSource,
      leadStage: lead.leadStage,
      customerName: lead.customerName,
      customerPhone: lead.customerPhone,
      firstActivityAt: lead.firstActivityAt,
      lastActivityAt: lead.lastActivityAt,
      activityCount: lead.activities.length,
      callCount: lead.callCount,
      smsCount: lead.smsCount,
      inboundCount: lead.inboundCount,
      outboundCount: lead.outboundCount,
      meetingCount: lead.meetingIds.size,
      actionItemCount: lead.actionItemIds.size,
      hasMeeting: lead.meetingIds.size > 0,
      hasActionItem: lead.actionItemIds.size > 0,
      appointmentPitched: lead.appointmentPitched,
      appointmentScheduled: lead.appointmentScheduled,
      activities: lead.activities,
    });
  }
  // Sort by last activity (newest leads first); leads with no activity fall to bottom.
  out.sort((a, b) =>
    (b.lastActivityAt ?? b.leadCreatedAt ?? "").localeCompare(a.lastActivityAt ?? a.leadCreatedAt ?? "")
  );
  return out;
}

app.get("/api/dream", async (req, res) => {
  const force = req.query.refresh === "1";
  const fresh = !force && dreamCache.data && (Date.now() - dreamCache.fetchedAt) < DREAM_TTL_MS;

  if (!fresh) {
    try {
      const raw = await fetchFromMetabase(DREAM_METABASE_URL, "DREAM", 1, 120000);
      const aggregated = aggregateDream(Array.isArray(raw) ? raw : []);
      dreamCache = { data: aggregated, fetchedAt: Date.now(), rawCount: Array.isArray(raw) ? raw.length : 0 };
    } catch (err) {
      console.error("GET /api/dream — refresh failed:", err?.message);
      // Fall through and serve whatever we have cached (even if stale).
      // Only 500 when we have absolutely nothing to show the client.
      if (!dreamCache.data) {
        return res.status(503).json({ error: `Metabase unreachable: ${err?.message ?? "unknown"}. No cached data available yet — try again in a moment.` });
      }
    }
  }

  return res.json({
    leadCount: dreamCache.data.length,
    rawRowCount: dreamCache.rawCount ?? null,
    fetchedAt: new Date(dreamCache.fetchedAt).toISOString(),
    leads: dreamCache.data,
    stale: !fresh && (Date.now() - dreamCache.fetchedAt) >= DREAM_TTL_MS,
  });
});

// ─── GET /api/vini/rooftops — Vini Account Health rows (Metabase → DB cache) ──

app.get("/api/vini/rooftops", async (_req, res) => {
  try {
    const { rows } = await query(
      "SELECT rows_json, synced_at FROM vini_metrics_cache WHERE id = 'global'"
    );
    if (!rows.length) {
      return res.json({ source: "none", syncedAt: null, rowCount: 0, rooftops: [] });
    }
    const raw = rows[0].rows_json;
    const arr = Array.isArray(raw) ? raw : [];
    const rooftops = mapMetabaseRows(arr);
    return res.json({
      source: arr.length ? "metabase" : "none",
      syncedAt: rows[0].synced_at,
      rowCount: arr.length,
      rooftops,
    });
  } catch (err) {
    console.error("GET /api/vini/rooftops error:", err?.message);
    return res.status(500).json({ error: err?.message ?? "Failed to load" });
  }
});

// ─── POST /api/programs/send-report — Email the Daily Snapshot ─────────────
// Client computes the report data (the same aggregates that drive the on-screen
// Email Report tab) and POSTs it here. Server fetches active recipients from
// Supabase, renders an inline-styled HTML email, and sends via the Spyne
// mail proxy.
app.post("/api/programs/send-report", async (req, res) => {
  try {
    const { payload, subject, dashboardUrl, recipientsOverride } = req.body ?? {};
    if (!payload || !Array.isArray(payload.perAgent) || !Array.isArray(payload.section2)) {
      return res.status(400).json({ error: "payload missing or malformed" });
    }

    // Debug: payload structure summary. If tables come up blank in the
    // email, this is the first thing to check — confirms whether the
    // client actually serialised the aggregates.
    console.log("[send-report] payload received:", {
      overallTotalCount: payload.overall?.totalCount,
      overallTotalArr:   payload.overall?.totalArr,
      overallRed:        payload.overall?.red,
      overallAmber:      payload.overall?.amber,
      overallGreen:      payload.overall?.green,
      perAgentCount:     payload.perAgent.length,
      perAgent0:         payload.perAgent[0],
      section2Count:     payload.section2.length,
      section2RowCounts: payload.section2.map(s => ({ agent: s.agent, rows: s.rows?.length ?? 0 })),
      section2FirstRow:  payload.section2.find(s => s.rows?.length)?.rows?.[0],
    });

    // Preview mode — render the HTML and return it instead of sending.
    // Done before the recipient gate so it works without any configured.
    if (req.query?.preview === "1") {
      const { renderProgramsEmailHtml } = await import("./programsEmail.js");
      const dateText = new Date().toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "short", year: "numeric"
      });
      const html = renderProgramsEmailHtml({ ...payload, dateText, dashboardUrl });
      res.set("Content-Type", "text/html");
      return res.send(html);
    }

    // Resolve recipients — either an explicit override from the client (testing
    // a single send) or all active rows in programs_email_recipients.
    let recipients = [];
    if (Array.isArray(recipientsOverride) && recipientsOverride.length > 0) {
      recipients = recipientsOverride.map(s => String(s).trim()).filter(Boolean);
    } else {
      const sbUrl = process.env.VITE_PROGRAMS_SUPABASE_URL;
      const sbKey = process.env.VITE_PROGRAMS_SUPABASE_KEY;
      if (!sbUrl || !sbKey) {
        return res.status(500).json({ error: "Supabase env not configured on server" });
      }
      const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
      const { data, error } = await sb
        .from("programs_email_recipients")
        .select("email")
        .eq("active", true);
      if (error) {
        return res.status(500).json({ error: `recipients fetch failed: ${error.message}` });
      }
      recipients = (data ?? []).map(r => r.email).filter(Boolean);
    }
    if (recipients.length === 0) {
      return res.status(400).json({ error: "No active recipients configured" });
    }

    const result = await sendProgramsReportEmail({
      payload, recipients, subject, dashboardUrl,
    });
    return res.json({
      sent: recipients.length,
      recipients,
      providerStatus: result?.status ?? null,
      providerResponse: result?.response ?? null,
    });
  } catch (err) {
    console.error("POST /api/programs/send-report error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "Send failed" });
  }
});

// ─── Open-tracking pixel helpers (manual send paths) ────────────────────────
// Mirror the cron renderers: inject the same 1×1 pixel pointing at the track-open
// Edge Function so manually-sent mail is tracked too. Digest pixel keys by
// team/dept/cadence/date; event pixel keys by the roi_event_emails row id.
const TRACK_OPEN_BASE = (process.env.DIGEST_TRACK_BASE || "https://qludnojfibguobgeeujw.supabase.co/functions/v1/track-open").replace(/\/$/, "");
const pixelTag = (qs) => `<img src="${TRACK_OPEN_BASE}?${qs}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;
const injectPixel = (html, tag) => {
  if (!html || !tag || html.includes(TRACK_OPEN_BASE)) return html; // skip if absent or already tracked
  return html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : html + tag;
};
const digestPixel = (team, dept, cadence, dt) =>
  pixelTag(`t=${encodeURIComponent(team)}&d=${encodeURIComponent(dept)}&c=${encodeURIComponent(cadence || "daily")}&dt=${encodeURIComponent(dt)}`);
const eventPixel = (id) => pixelTag(`id=${encodeURIComponent(id)}`);

// ─── ROI Email Tracker · real "send now" ────────────────────────────────────
// Forwards the rendered digest HTML to the mail proxy AND marks the run sent in
// the ROI Supabase (status=sent, recipients received, rendered_html stored) so
// the tracker shows it as sent and the exact HTML is viewable.
// Body: { teamId, department, localDate, to:[emails], subject, html }
app.post("/api/email/roi-send-now", async (req, res) => {
  try {
    const { teamId, department, localDate, to, subject, html, override } = req.body ?? {};
    const recipients = (Array.isArray(to) ? to : [to]).map((s) => String(s || "").trim()).filter(Boolean);
    if (!teamId || !department || !localDate) return res.status(400).json({ error: "teamId, department, localDate required" });
    if (!recipients.length) return res.status(400).json({ error: "no recipients" });
    if (!html) return res.status(400).json({ error: "no html" });
    // Anti-churn gate: a no-value digest is blocked unless the DANGER override is typed.
    const force = require("./roi-cron/emailValue.cjs").overrideOk(override);

    // Inject the open-tracking pixel (keyed by team/dept/daily/date) so a manual
    // send is tracked exactly like the cron. No-op if the html already carries it.
    const trackedHtml = injectPixel(html, digestPixel(teamId, department === "service" ? "service" : "sales", "daily", localDate));

    // 1) send via the EXACT SAME mail path as the daily cron. The cron (runOnce) and
    // Send Now both go through runner.sendMail — one mail URL, one token, one template
    // (MAIL_TEMPLATE || default), one retry policy. Previously this route had its own
    // divergent fetch with an extra EMAIL_PROXY_TEMPLATE fallback; a stale/bad value in
    // that env made Send Now fail with "invalid template" while the cron kept working.
    const { sendMail } = require("./roi-cron/runner.cjs"); // lazy: env present at request time
    let messageId;
    try {
      messageId = await sendMail(recipients, subject || "Daily Digest", trackedHtml, { force });
    } catch (mailErr) {
      if (mailErr && mailErr.code === "BLOCKED_NO_VALUE") {
        return res.json({ ok: false, blocked: true, reason: "no_value", error: mailErr.message });
      }
      return res.status(502).json({ error: mailErr?.message ?? "mail send failed" });
    }

    // 2) mark the run sent in ROI Supabase (service key — bypasses RLS)
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    let dbUpdated = false;
    if (sbUrl && sbKey) {
      const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
      const { error } = await sb.from("roi_digest_runs").update({
        status: "sent", reason: null, sent_at: new Date().toISOString(), send_path: "raw_html",
        rendered_html: trackedHtml, message_id: messageId,
        recipients: recipients.map((email) => ({ email, received: true })),
      }).eq("team_id", teamId).eq("department", department).eq("cadence", "daily").eq("local_date", localDate);
      dbUpdated = !error;
      if (error) console.error("[roi-send-now] supabase update failed:", error.message);
    } else {
      console.warn("[roi-send-now] ROI_SUPABASE_SERVICE_KEY not set — email sent but run not marked");
    }
    return res.json({ ok: true, messageId, dbUpdated, to: recipients });
  } catch (err) {
    console.error("POST /api/email/roi-send-now error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "send failed" });
  }
});

// ─── ROI Email Tracker · on-demand "Generate & send {cadence}" ──────────────
// Builds a digest in real time for the selected cadence (daily / weekly = last 7
// days / monthly = last 30 days), renders via the SAME pipeline as the cron, and
// sends to the rooftop's real recipients — bypassing the cron's send-day/send-hour
// gates. Scope to ONE rooftop with { teamId, department }, or omit both to run all
// live rooftops. Honours dry-run (server DRY_RUN + each rooftop's dry_run); pass
// { dryRun: true } to force a suppressed preview (renders + stores, no email).
// Body: { cadence, teamId?, department?, dryRun? }
app.post("/api/email/roi-generate-send", async (req, res) => {
  try {
    const { cadence, teamId, department, dryRun, override } = req.body ?? {};
    const cad = cadence === "weekly" || cadence === "monthly" ? cadence : "daily";
    const dept = department === "service" ? "service" : department === "sales" ? "sales" : undefined;
    if (teamId && !dept) return res.status(400).json({ error: "department (sales|service) is required when teamId is set" });
    const force = require("./roi-cron/emailValue.cjs").overrideOk(override);
    const { generateAndSendNow } = require("./roi-cron/runner.cjs"); // lazy: env present at request time
    const summary = await generateAndSendNow({ cadence: cad, teamId: teamId || undefined, department: dept, dryRun: dryRun === true, force });
    // Single-rooftop run that sent nothing because the digest had no value → tell the
    // UI it's blocked so it can offer the DANGER override (skip when already forced).
    if (teamId && !force && summary && summary.sent === 0 && (summary.no_data || 0) > 0) {
      return res.json({ ok: false, blocked: true, reason: "no_value", error: "This digest shows no value — blocked to avoid churn.", ...summary });
    }
    return res.json({ ok: true, ...summary });
  } catch (err) {
    console.error("POST /api/email/roi-generate-send error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "generate/send failed" });
  }
});

// ── POST /api/email/roi-generate-preview — render a digest, return its HTML ───
// Render-ONLY (no DB write, no email): builds the same metrics + HTML the on-demand
// send would produce for ONE rooftop, so the tracker can preview a weekly/monthly
// digest before the user manually triggers the send. Body: { cadence, teamId, department }
app.post("/api/email/roi-generate-preview", async (req, res) => {
  try {
    const { cadence, teamId, department } = req.body ?? {};
    const cad = cadence === "weekly" || cadence === "monthly" ? cadence : "daily";
    const dept = department === "service" ? "service" : "sales";
    if (!teamId) return res.status(400).json({ error: "teamId is required" });
    const { previewDigestNow } = require("./roi-cron/runner.cjs"); // lazy: env present at request time
    const out = await previewDigestNow({ cadence: cad, teamId, department: dept });
    return res.json(out);
  } catch (err) {
    console.error("POST /api/email/roi-generate-preview error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "preview failed" });
  }
});

// ── Live PREVIEW of ONE transactional email with the CURRENT template ────────
// Re-renders an event for a customer on demand (no DB write, no send) from the reporting
// feeds, so the tracker's "Latest design" toggle shows the up-to-date email per customer
// even when the stored copy is older or no event was sent yet.
// Body: { teamId, enterpriseId, department, emailType, eventKey, rooftopName, tz }
app.post("/api/email/roi-event-preview", async (req, res) => {
  try {
    const { teamId, enterpriseId, department, emailType, eventKey, rooftopName, tz } = req.body ?? {};
    if (!teamId || !emailType) return res.status(400).json({ error: "teamId and emailType required" });
    // The tracker's drill-down list is built entirely from ClickHouse (listEventsCH), so a clicked
    // row carries a ClickHouse event_key (callId / sms:<id> / lead:<id> / meeting_id). The reporting
    // API only resolves NEW events inside a narrow recent window (it's the send path), so for a
    // historical click it silently fell back to its most-recent item — rendering a DIFFERENT
    // customer's PII into the preview ("shows data for <someone else>"). So when an eventKey is
    // present we resolve that EXACT event from ClickHouse, STRICT (never substitute), matching the
    // list's source + key. The reporting-API path stays first only for the synthetic, key-less
    // "latest design" preview, where a representative recent customer is the intended behaviour.
    const wantKey = !!(eventKey && String(eventKey).trim());
    let html = "";
    const tryApi = async () => {
      try {
        const { previewEvent } = require("./roi-cron/eventRunner.cjs");
        return await previewEvent({ teamId, enterpriseId, department, emailType, eventKey, rooftopName, tz });
      } catch (e) {
        console.warn("[roi-event-preview] API path failed:", String(e?.message || e).slice(0, 140));
        return "";
      }
    };
    const tryCH = async (strict) => {
      const { hasClickhouseCreds } = await import("./agentMetrics.js");
      if (!hasClickhouseCreds()) return "";
      const { previewEventCH } = await import("./roi-cron/eventPreviewCH.js");
      return await previewEventCH({ teamId, department, emailType, eventKey, rooftopName, tz, strict });
    };
    if (wantKey) {
      try { html = await tryCH(true); } catch (e) { console.warn("[roi-event-preview] CH strict path failed:", String(e?.message || e).slice(0, 140)); }
      if (!html) html = await tryApi(); // CH unavailable → API still won't substitute (keyed)
    } else {
      html = await tryApi();
      if (!html) { try { html = await tryCH(false); } catch (e) { console.warn("[roi-event-preview] CH fallback failed:", String(e?.message || e).slice(0, 140)); } }
    }
    return res.json({ ok: true, empty: !html, html: html || "" });
  } catch (err) {
    console.error("POST /api/email/roi-event-preview error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "preview failed" });
  }
});

// ── GET /api/email/roi-event-list — all real events for a rooftop+type from CH ──
// Backfill + live: lists every event in the window (history included) so the
// transactional drill-down shows all data, not just generated rows. Read-only.
// Query: ?teamId&department&emailType&sinceDays?&limit?
app.get("/api/email/roi-event-list", async (req, res) => {
  try {
    const { teamId, department, emailType, direction, sinceDays, limit, offset } = req.query;
    if (!teamId || !emailType) return res.status(400).json({ error: "teamId and emailType required" });
    if (!hasClickhouseCreds()) return res.json({ ok: true, events: [], note: "ClickHouse not configured" });
    const { listEventsCH } = await import("./roi-cron/eventPreviewCH.js");
    const events = await listEventsCH({ teamId, department, emailType, direction, sinceDays: Number(sinceDays) || 120, limit: Number(limit) || 200, offset: Number(offset) || 0 });
    return res.json({ ok: true, events });
  } catch (err) {
    console.error("GET /api/email/roi-event-list error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "list failed" });
  }
});

// ── GET /api/email/roi-event-daycounts — per-day mini-report for ONE (team×dept×type) ──
// Created / Closed (action items only) / Eligible from ClickHouse (dealer-local days), with
// Sent overlaid from roi_event_emails. Powers the drill-down's per-day header.
// Query: ?teamId&department&emailType&tz?&sinceDays?
app.get("/api/email/roi-event-daycounts", async (req, res) => {
  try {
    const { teamId, department, emailType, tz, sinceDays } = req.query;
    if (!teamId || !emailType) return res.status(400).json({ error: "teamId and emailType required" });
    const zone = String(tz || "America/New_York");
    const days = {};
    if (hasClickhouseCreds()) {
      const { countEventsByDayCH } = await import("./roi-cron/eventPreviewCH.js");
      const ch = await countEventsByDayCH({ teamId, department, emailType, tz: zone, sinceDays: Number(sinceDays) || 120 });
      for (const [d, o] of Object.entries(ch)) days[d] = { created: o.created || 0, closed: o.closed || 0, eligible: o.eligible || 0, sent: 0 };
    }
    // Overlay Sent from roi_event_emails (bucketed to the dealer's local day of sent_at).
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (sbUrl && sbKey) {
      const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
      const sinceIso = new Date(Date.now() - (Number(sinceDays) || 120) * 86400000).toISOString();
      let q = sb.from("roi_event_emails")
        .select("sent_at")
        .eq("team_id", teamId).eq("email_type", emailType).eq("status", "sent")
        .not("sent_at", "is", null).gte("sent_at", sinceIso);
      if (department) q = q.eq("department", department);
      const { data: sentRows, error } = await q;
      if (!error) {
        const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
        for (const r of sentRows || []) {
          const d = fmt.format(new Date(r.sent_at)); // 'YYYY-MM-DD' in dealer-local zone
          if (!days[d]) days[d] = { created: 0, closed: 0, eligible: 0, sent: 0 };
          days[d].sent += 1;
        }
      }
    }
    return res.json({ ok: true, days });
  } catch (err) {
    console.error("GET /api/email/roi-event-daycounts error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "daycounts failed" });
  }
});

// ── GET /api/email/roi-event-counts — per (team×dept×type) totals from CH ────
// Powers the transactional grid totals from REAL events (history + live). Three
// heavy grouped scans → cached in-process for 5 min. ?refresh=1 bypasses.
let eventCountsCache = { rows: null, fetchedAt: 0 };
let eventCountsInflight = null;
const EVENT_COUNTS_TTL_MS = 5 * 60 * 1000;
app.get("/api/email/roi-event-counts", async (req, res) => {
  try {
    if (!hasClickhouseCreds()) return res.json({ ok: true, counts: [], note: "ClickHouse not configured" });
    const force = req.query.refresh === "1";
    const fresh = !force && eventCountsCache.rows && (Date.now() - eventCountsCache.fetchedAt) < EVENT_COUNTS_TTL_MS;
    if (!fresh) {
      if (!eventCountsInflight) {
        const sinceDays = Number(req.query.sinceDays) || 120;
        eventCountsInflight = import("./roi-cron/eventPreviewCH.js")
          .then((m) => m.countEventsCH({ sinceDays }))
          .then((rows) => { eventCountsCache = { rows, fetchedAt: Date.now() }; })
          .finally(() => { eventCountsInflight = null; });
      }
      await eventCountsInflight;
    }
    return res.json({ ok: true, counts: eventCountsCache.rows || [], fetchedAt: new Date(eventCountsCache.fetchedAt).toISOString() });
  } catch (err) {
    console.error("GET /api/email/roi-event-counts error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "counts failed" });
  }
});

// Shared mail-proxy POST with the SAME retry policy as the cron (eventRunner.sendMail):
// retry transient 5xx/429 up to 3×, fail fast on other 4xx. Manual sends previously did a single
// fetch, so a transient gateway blip failed a send the cron would have completed.
async function postMailWithRetry(mailUrl, payload) {
  const token = process.env.MAIL_TOKEN;
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  };
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await fetch(mailUrl, init);
    if (last.ok) return last;
    if (last.status < 500 && last.status !== 429) return last; // non-transient → don't retry
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  return last;
}

// ── Manual send of ONE transactional email (roi_event_emails) ────────────────
// Sends the stored rendered_html of a single per-event email to its recipients
// (override `to`, else the row's recipients, else the rooftop's configured ones),
// then marks the row sent. Used by the tracker's per-email "Send now" button.
app.post("/api/email/roi-event-send-now", async (req, res) => {
  try {
    const { id, to, override } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "id required" });
    const EV = require("./roi-cron/emailValue.cjs");
    const force = EV.overrideOk(override);
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });

    const { data: row, error: rowErr } = await sb.from("roi_event_emails")
      .select("id,team_id,department,email_type,subject,rendered_html,recipients").eq("id", id).maybeSingle();
    if (rowErr || !row) return res.status(404).json({ error: "event email not found" });
    if (!row.rendered_html) return res.status(400).json({ error: "no rendered copy to send" });

    // recipients: explicit override → the row's recipients → the rooftop's enabled recipients for this dept
    let recipients = (Array.isArray(to) ? to : to ? [to] : []).map((s) => String(s || "").trim()).filter(Boolean);
    if (!recipients.length) recipients = (row.recipients ?? []).map((r) => String(r?.email || "").trim()).filter(Boolean);
    if (!recipients.length) {
      const { data: recs } = await sb.from("roi_recipients").select("email,receives_sales,receives_service,email_enabled").eq("team_id", row.team_id);
      recipients = (recs ?? []).filter((r) => (row.department === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled).map((r) => r.email);
    }
    if (!recipients.length) return res.status(400).json({ error: "no recipients configured for this rooftop/department" });

    // Anti-churn gate: refuse a no-value email unless the DANGER override is typed.
    let wireHtml = row.rendered_html;
    if (EV.isNoValue(wireHtml)) {
      if (!force) return res.json({ ok: false, blocked: true, reason: "no_value", error: "This email shows no value — blocked to avoid churn." });
      wireHtml = EV.stripMarker(wireHtml);
    }

    const mailUrl = process.env.MAIL_PROXY_URL || process.env.EMAIL_PROXY_URL || "https://mail.spyne.ai/api/v1/send-template-email";
    const template = process.env.MAIL_TEMPLATE || "email-control-tower-report";
    const mailRes = await postMailWithRetry(mailUrl, { to: recipients.join(","), subject: row.subject || "Vini", template, templateData: { HTMLdata: wireHtml } });
    if (!mailRes.ok) {
      const t = await mailRes.text().catch(() => "");
      return res.status(502).json({ error: `mail proxy ${mailRes.status}: ${t.slice(0, 200)}` });
    }
    const mj = await mailRes.json().catch(() => ({}));
    const messageId = mj.messageId ?? mj.id ?? null;
    await sb.from("roi_event_emails").update({
      status: "sent", reason: null, sent_at: new Date().toISOString(), message_id: messageId,
      recipients: recipients.map((email) => ({ email, received: true })),
    }).eq("id", id);
    return res.json({ ok: true, messageId, to: recipients });
  } catch (err) {
    console.error("POST /api/email/roi-event-send-now error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "send failed" });
  }
});

// ── Render a transactional email LIVE and send it to the rooftop's recipients ─
// Powers the tracker's per-cell "Send to customer" for a type that has no stored event
// yet: renders the latest-design email from ClickHouse (previewEventCH), emails it to the
// dept's enabled recipients, and records a roi_event_emails row so it shows in the list.
// Body: { teamId, enterpriseId, department, emailType, eventKey, rooftopName, tz }
const EVENT_SUBJECTS = {
  post_appointment: "New appointment", post_conversation: "Conversation summary",
  action_item: "Action items", action_item_overdue: "Overdue action items",
};
app.post("/api/email/roi-event-generate-send", async (req, res) => {
  try {
    const { teamId, enterpriseId, department, emailType, eventKey, rooftopName, tz, override } = req.body ?? {};
    if (!teamId || !emailType) return res.status(400).json({ error: "teamId and emailType required" });
    const dept = department === "service" ? "service" : "sales";
    const EV = require("./roi-cron/emailValue.cjs");
    const force = EV.overrideOk(override);
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });

    // 1) render the email from live ClickHouse data (same path as the preview)
    const { hasClickhouseCreds } = await import("./agentMetrics.js");
    if (!hasClickhouseCreds()) return res.status(500).json({ error: "ClickHouse not configured on this server" });
    const { previewEventCH } = await import("./roi-cron/eventPreviewCH.js");
    // strict:true — on the SEND path, if eventKey doesn't resolve to that exact item, refuse rather than
    // substitute the rooftop's most-recent customer (which would email a dealer another customer's PII).
    const html = await previewEventCH({ teamId, department: dept, emailType, eventKey, rooftopName, tz, strict: !!eventKey });
    if (!html) return res.status(404).json({ error: "No live data found to render this email for the rooftop." });

    // 2) recipients — the dept's enabled addresses
    const { data: recs } = await sb.from("roi_recipients").select("email,receives_sales,receives_service,email_enabled").eq("team_id", teamId);
    const recipients = (recs ?? []).filter((r) => (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled).map((r) => r.email);
    if (!recipients.length) return res.status(400).json({ error: "no recipients configured for this rooftop/department" });

    // 3) idempotency: a deterministic event_key + a recent-duplicate guard so a double-click or client
    // retry doesn't email the dealer twice (the old `manual-${type}-${Date.now()}` key never deduped).
    const subject = `${EVENT_SUBJECTS[emailType] || "Vini"} — ${rooftopName || teamId}`;
    const evKey = `manual-${emailType}-${eventKey || "latest"}`;
    const dupSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: dup } = await sb.from("roi_event_emails")
      .select("id,status").eq("team_id", teamId).eq("email_type", emailType).eq("event_key", evKey)
      .gte("created_at", dupSince).in("status", ["queued", "sent"]).limit(1).maybeSingle();
    if (dup) return res.json({ ok: true, deduped: true, id: dup.id, message: "this event was just sent — not re-sending" });

    // insert the row to get its id, so the open-tracking pixel can key to it.
    const { data: inserted, error: insErr } = await sb.from("roi_event_emails").insert({
      team_id: teamId, enterprise_id: enterpriseId || null, department: dept, email_type: emailType,
      event_key: evKey, status: "queued", subject,
      recipients: recipients.map((email) => ({ email })),
    }).select("id").single();
    if (insErr || !inserted?.id) return res.status(500).json({ error: insErr?.message || "could not create event row" });
    const id = inserted.id;
    const trackedHtml = injectPixel(html, eventPixel(id));

    // Anti-churn gate: a no-value email is blocked unless the DANGER override is typed.
    // (A truly empty transactional is already refused above via the `!html` 404.)
    let wireHtml = trackedHtml;
    if (EV.isNoValue(wireHtml)) {
      if (!force) {
        await sb.from("roi_event_emails").update({ status: "not_sent", reason: "no_value", rendered_html: trackedHtml }).eq("id", id);
        return res.json({ ok: false, blocked: true, reason: "no_value", error: "This email shows no value — blocked to avoid churn." });
      }
      wireHtml = EV.stripMarker(wireHtml);
    }

    // 4) send via the mail proxy
    const mailUrl = process.env.MAIL_PROXY_URL || process.env.EMAIL_PROXY_URL || "https://mail.spyne.ai/api/v1/send-template-email";
    const template = process.env.MAIL_TEMPLATE || "email-control-tower-report";
    const mailRes = await postMailWithRetry(mailUrl, { to: recipients.join(","), subject, template, templateData: { HTMLdata: wireHtml } });
    if (!mailRes.ok) {
      const t = await mailRes.text().catch(() => "");
      await sb.from("roi_event_emails").update({ status: "error", reason: `mail proxy ${mailRes.status}`, rendered_html: trackedHtml }).eq("id", id);
      return res.status(502).json({ error: `mail proxy ${mailRes.status}: ${t.slice(0, 200)}` });
    }
    const mj = await mailRes.json().catch(() => ({}));
    const messageId = mj.messageId ?? mj.id ?? null;

    // 5) finalize the row → flips the cell from "—" to a count, email viewable + trackable
    await sb.from("roi_event_emails").update({
      status: "sent", message_id: messageId, sent_at: new Date().toISOString(),
      rendered_html: trackedHtml, recipients: recipients.map((email) => ({ email, received: true })),
    }).eq("id", id);
    return res.json({ ok: true, messageId, to: recipients });
  } catch (err) {
    console.error("POST /api/email/roi-event-generate-send error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "send failed" });
  }
});

// ── Open-rate tracking pixel ─────────────────────────────────────────────────
// The digest embeds <img src=".../api/email/track-open?t=<team>&d=<dept>&dt=<date>&r=<email>">.
// On first load we stamp roi_digest_runs.opened_at and flip recipients[].opened for
// the matching address. ALWAYS returns a 1×1 transparent GIF (never blocks the image
// or leaks errors to the inbox); the DB write is best-effort.
const TRACK_PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
app.get("/api/email/track-open", async (req, res) => {
  const sendPixel = () => {
    res.set("Content-Type", "image/gif");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Content-Length", String(TRACK_PIXEL.length));
    res.status(200).end(TRACK_PIXEL);
  };
  try {
    const teamId = String(req.query.t || "").trim();
    const department = String(req.query.d || "").trim() === "service" ? "service" : "sales";
    const localDate = String(req.query.dt || "").trim();
    const who = String(req.query.r || "").trim().toLowerCase();
    sendPixel(); // respond immediately; record asynchronously below
    if (!teamId || !localDate) return;
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return;
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const { data: row } = await sb.from("roi_digest_runs")
      .select("recipients,opened_at").eq("team_id", teamId).eq("department", department)
      .eq("cadence", "daily").eq("local_date", localDate).maybeSingle();
    if (!row) return;
    const now = new Date().toISOString();
    const recipients = (Array.isArray(row.recipients) ? row.recipients : []).map((rec) => {
      const match = !who || String(rec.email || "").toLowerCase() === who;
      return match ? { ...rec, opened: true, opened_at: rec.opened_at || now } : rec;
    });
    await sb.from("roi_digest_runs").update({ opened_at: row.opened_at || now, recipients })
      .eq("team_id", teamId).eq("department", department).eq("cadence", "daily").eq("local_date", localDate);
  } catch (err) {
    console.error("GET /api/email/track-open error:", err?.message ?? err);
    if (!res.headersSent) sendPixel();
  }
});

// ── Email-tracker sign-in (server-side password — keeps it out of the JS bundle) ──
// Light gate for the PII tracker: the password is validated HERE (server), never shipped to the
// browser. On success we return a short HMAC-signed token the UI stores + re-checks via /verify.
// NOTE: intentionally light — it does NOT yet gate the /api/email/* endpoints or enable Supabase RLS
// (the browser anon key can still read roi_* directly). That hardening is deferred. Credentials +
// signing secret are overridable via TRACKER_USER / TRACKER_PASSWORD / TRACKER_AUTH_SECRET.
const _crypto = require("crypto");
const TRACKER_USER = process.env.TRACKER_USER || "spyne-devansh";
const TRACKER_PASSWORD = process.env.TRACKER_PASSWORD || "SPYNE";
const TRACKER_SECRET = process.env.TRACKER_AUTH_SECRET || process.env.ROI_SUPABASE_SERVICE_KEY || "vini-tracker-fallback-secret";
const TRACKER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function _trackerSign(exp) { return _crypto.createHmac("sha256", TRACKER_SECRET).update(`${TRACKER_USER}.${exp}`).digest("hex"); }
function _trackerToken() { const exp = Date.now() + TRACKER_TTL_MS; return Buffer.from(`${exp}.${_trackerSign(exp)}`).toString("base64"); }
function _trackerValid(token) {
  try {
    const [exp, sig] = Buffer.from(String(token || ""), "base64").toString("utf8").split(".");
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const good = _trackerSign(Number(exp));
    return sig.length === good.length && _crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
  } catch { return false; }
}
app.post("/api/tracker/login", (req, res) => {
  const { id, password } = req.body ?? {};
  const ok = String(id || "").trim() === TRACKER_USER
    && _crypto.timingSafeEqual(
      _crypto.createHash("sha256").update(String(password ?? "")).digest(),
      _crypto.createHash("sha256").update(TRACKER_PASSWORD).digest(),
    );
  if (!ok) return res.status(401).json({ ok: false, error: "Incorrect ID or password." });
  return res.json({ ok: true, token: _trackerToken() });
});
app.post("/api/tracker/verify", (req, res) => res.json({ ok: _trackerValid((req.body ?? {}).token) }));

// A non-deliverable placeholder email for a phone-only recipient. email is roi_recipients'
// identity (NOT NULL + unique per team), so a phone-only person still needs one; the `.invalid`
// TLD (RFC 2606) guarantees it never resolves, and the sender skips non-real addresses.
function placeholderEmailForPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits ? `ph.${digits}@phone.invalid` : "";
}
function isPlaceholderEmail(email) {
  return /@phone\.invalid$/i.test(String(email || ""));
}

// ── Add a recipient to a rooftop+department (tracker "Add recipient") ────────
// Upserts roi_recipients with the department flag + email_enabled=true (service key, bypasses RLS).
app.post("/api/recipients", async (req, res) => {
  try {
    const { teamId, department, email, name, emailEnabled, phone, smsEnabled, role } = req.body ?? {};
    const dept = department === "service" ? "service" : "sales";
    const rawEmail = String(email || "").trim();
    const rawPhone = phone === undefined ? undefined : String(phone || "").trim();
    if (!teamId) return res.status(400).json({ error: "teamId required" });
    if (rawEmail && !/\S+@\S+\.\S+/.test(rawEmail)) return res.status(400).json({ error: "enter a valid email" });
    // A recipient needs at least ONE contact channel. When only a phone is given we synthesize a
    // non-deliverable placeholder email (email is the row's identity key) — the sender skips it, so
    // a phone-only recipient receives SMS only. Placeholder is derived from the phone's digits so
    // it's stable for that person within the team.
    const addr = rawEmail || (rawPhone ? placeholderEmailForPhone(rawPhone) : "");
    if (!addr) return res.status(400).json({ error: "add an email or a phone" });
    if (role !== undefined && role !== null && !["salesperson", "bdc", "gm"].includes(role)) return res.status(400).json({ error: "role must be salesperson|bdc|gm|null" });
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    // preserve the other department's existing flag if the recipient already exists
    const { data: existing, error: selErr } = await sb.from("roi_recipients")
      .select("id,receives_sales,receives_service,email_enabled").eq("team_id", teamId).ilike("email", addr).maybeSingle();
    if (selErr) return res.status(500).json({ error: selErr.message });
    const patch = {
      receives_sales: dept === "sales" ? true : (existing?.receives_sales ?? false),
      receives_service: dept === "service" ? true : (existing?.receives_service ?? false),
      // email_enabled: honor explicit flag; else new rows default ON, existing rows keep their state.
      email_enabled: typeof emailEnabled === "boolean" ? emailEnabled : (existing ? existing.email_enabled : true),
    };
    // SMS channel (optional): phone accepts common formats; "" clears it. Turning SMS on requires a phone.
    if (phone !== undefined) patch.phone = phone ? String(phone).trim() : null;
    if (typeof smsEnabled === "boolean") {
      if (smsEnabled && !patch.phone && phone === undefined) return res.status(400).json({ error: "add a phone before enabling SMS" });
      patch.sms_enabled = smsEnabled;
    }
    if (role !== undefined) patch.role = role || null; // '' / null clears the role (rooftop-wide fallback)
    const q = existing
      ? sb.from("roi_recipients").update(patch).eq("id", existing.id)
      : sb.from("roi_recipients").insert({ team_id: teamId, email: addr, name: name || null, ...patch });
    const { error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, teamId, department: dept, email: addr, created: !existing });
  } catch (err) {
    console.error("POST /api/recipients error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "add recipient failed" });
  }
});

// ── Edit an existing recipient's identity by row id (email / phone / name) ───
// Keyed on the row id (not email) so the email itself can be RENAMED — the plain
// /api/recipients upsert is keyed on email and would create a new row instead.
// Any field omitted is left unchanged. Clearing the email is allowed only when a
// phone remains (then the identity falls back to a phone placeholder).
app.post("/api/recipients/update", async (req, res) => {
  try {
    const { teamId, id, email, phone, name } = req.body ?? {};
    if (!teamId || !id) return res.status(400).json({ error: "teamId + id required" });
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const { data: row, error: selErr } = await sb.from("roi_recipients")
      .select("id,email,phone").eq("team_id", teamId).eq("id", id).maybeSingle();
    if (selErr) return res.status(500).json({ error: selErr.message });
    if (!row) return res.status(404).json({ error: "recipient not found" });

    const patch = {};
    const nextPhone = phone === undefined ? row.phone : (String(phone || "").trim() || null);
    if (phone !== undefined) patch.phone = nextPhone;
    if (name !== undefined) patch.name = name ? String(name).trim() : null;
    if (email !== undefined) {
      const addr = String(email || "").trim();
      if (addr) {
        if (!/\S+@\S+\.\S+/.test(addr)) return res.status(400).json({ error: "enter a valid email" });
        patch.email = addr;
      } else {
        // clearing the email → must keep a phone; fall back to its placeholder identity
        if (!nextPhone) return res.status(400).json({ error: "keep an email or add a phone" });
        patch.email = placeholderEmailForPhone(nextPhone);
      }
    }
    if (Object.keys(patch).length === 0) return res.json({ ok: true, id, unchanged: true });

    // Guard the unique(team_id, email) constraint with a friendly message.
    if (patch.email && patch.email.toLowerCase() !== String(row.email).toLowerCase()) {
      const { data: clash } = await sb.from("roi_recipients")
        .select("id").eq("team_id", teamId).ilike("email", patch.email).neq("id", id).maybeSingle();
      if (clash) return res.status(409).json({ error: "another recipient already uses that email" });
    }
    const { error } = await sb.from("roi_recipients").update(patch).eq("id", id).eq("team_id", teamId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, id, email: patch.email ?? row.email, phone: patch.phone });
  } catch (err) {
    console.error("POST /api/recipients/update error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "update failed" });
  }
});

// ── Toggle a recipient's email_enabled (store state, no send) ────────────────
app.post("/api/recipients/toggle", async (req, res) => {
  try {
    const { teamId, email, enabled, channel } = req.body ?? {};
    const addr = String(email || "").trim();
    if (!teamId || !addr) return res.status(400).json({ error: "teamId + email required" });
    const col = channel === "sms" ? "sms_enabled" : "email_enabled";
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    // Enabling SMS requires a phone on file — guard so we never flag a phoneless recipient as SMS-on.
    if (col === "sms_enabled" && enabled) {
      const { data: r } = await sb.from("roi_recipients").select("phone").eq("team_id", teamId).ilike("email", addr).maybeSingle();
      if (!r?.phone) return res.status(400).json({ error: "add a phone before enabling SMS" });
    }
    const { error } = await sb.from("roi_recipients").update({ [col]: !!enabled }).eq("team_id", teamId).ilike("email", addr);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, teamId, email: addr, [col]: !!enabled });
  } catch (err) {
    console.error("POST /api/recipients/toggle error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "toggle failed" });
  }
});

// ── Verify / unverify a recipient for its rooftop (the cross-rooftop send gate) ──
// A recipient is only ever emailed after a human confirms it belongs to THIS rooftop
// (roi_recipients.verified_at). This is the guarantee against a wrong-rooftop address
// receiving another rooftop's data. verified=false clears it (re-holds the recipient).
app.post("/api/recipients/verify", async (req, res) => {
  try {
    const { teamId, email, verified } = req.body ?? {};
    const addr = String(email || "").trim();
    if (!teamId || !addr) return res.status(400).json({ error: "teamId + email required" });
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const verified_at = verified === false ? null : new Date().toISOString();
    const { error } = await sb.from("roi_recipients").update({ verified_at }).eq("team_id", teamId).ilike("email", addr);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, teamId, email: addr, verified_at });
  } catch (err) {
    console.error("POST /api/recipients/verify error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "verify failed" });
  }
});

// ── Set ONE cell of a recipient's subscription matrix (type × channel) ───────
// body { teamId, email, type, channel, enabled }. Merges into roi_recipients.subscriptions
// (read-modify-write). Enabling SMS requires a phone on file (same guard as the master switch).
const SUB_TYPES = new Set([
  "daily", "weekly", "monthly",
  "post_appointment", "post_conversation", "action_item", "action_item_overdue",
]);
app.post("/api/recipients/subscription", async (req, res) => {
  try {
    const { teamId, email, type, channel, enabled } = req.body ?? {};
    const addr = String(email || "").trim();
    if (!teamId || !addr) return res.status(400).json({ error: "teamId + email required" });
    if (!SUB_TYPES.has(type)) return res.status(400).json({ error: "invalid type" });
    if (channel !== "email" && channel !== "sms") return res.status(400).json({ error: "channel must be email|sms" });
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const { data: row, error: selErr } = await sb.from("roi_recipients")
      .select("id,subscriptions,phone").eq("team_id", teamId).ilike("email", addr).maybeSingle();
    if (selErr) return res.status(500).json({ error: selErr.message });
    if (!row) return res.status(404).json({ error: "recipient not found" });
    if (channel === "sms" && enabled && !row.phone) return res.status(400).json({ error: "add a phone before enabling SMS" });
    const subs = (row.subscriptions && typeof row.subscriptions === "object") ? { ...row.subscriptions } : {};
    subs[type] = { ...(subs[type] || {}), [channel]: !!enabled };
    const { error } = await sb.from("roi_recipients").update({ subscriptions: subs }).eq("id", row.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, teamId, email: addr, type, channel, enabled: !!enabled });
  } catch (err) {
    console.error("POST /api/recipients/subscription error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "subscription update failed" });
  }
});

// ── Update a rooftop's config: send hour/minute/timezone, email-type toggles,
//    and daily-digest template. All writes go through the service key so the
//    browser (publishable/anon key) never needs write grants on roi_rooftop_config.
const ROOFTOP_BOOL_COLS = new Set([
  "daily_enabled", "weekly_enabled", "monthly_enabled",
  "post_appointment_enabled", "post_conversation_enabled",
  "action_item_enabled", "action_item_overdue_enabled",
  "sms_enabled",
]);
// Best-effort config-change audit log — never lets a logging failure fail the actual save.
async function logConfigAudit(sb, teamId, actor, patch, before) {
  try {
    const rows = Object.entries(patch)
      .filter(([field, next]) => String(before?.[field] ?? "") !== String(next ?? ""))
      .map(([field, next]) => ({
        team_id: teamId, actor: actor || null, field,
        old_value: before?.[field] == null ? null : String(before[field]),
        new_value: next == null ? null : String(next),
        source: "tracker",
      }));
    if (!rows.length) return;
    // Supabase resolves { error } rather than throwing — checking it is the whole point of this
    // function; an unchecked insert here silently drops every audit entry.
    const { error } = await sb.from("roi_config_audit_log").insert(rows);
    if (error) console.warn("[audit] roi_config_audit_log insert failed:", error.message);
  } catch (e) {
    console.warn("[audit] roi_config_audit_log insert failed:", e?.message ?? e);
  }
}

app.post("/api/rooftop-config", async (req, res) => {
  try {
    const { teamId, actor, sendHour, sendMinute, timezone, daily_template, digest_focus, weekly_send_dow, monthly_send_day } = req.body ?? {};
    if (!teamId) return res.status(400).json({ error: "teamId required" });
    const patch = {};
    if (sendHour != null) { const h = Number(sendHour); if (!Number.isInteger(h) || h < 0 || h > 23) return res.status(400).json({ error: "sendHour must be 0–23" }); patch.digest_send_hour = h; }
    if (sendMinute != null) { const m = Number(sendMinute); if (!Number.isInteger(m) || m < 0 || m > 59) return res.status(400).json({ error: "sendMinute must be 0–59" }); patch.digest_send_minute = m; }
    if (typeof timezone === "string" && timezone.trim()) patch.timezone = timezone.trim();
    if (weekly_send_dow != null) { const d = Number(weekly_send_dow); if (!Number.isInteger(d) || d < 0 || d > 6) return res.status(400).json({ error: "weekly_send_dow must be 0–6" }); patch.weekly_send_dow = d; }
    if (monthly_send_day != null) { const d = Number(monthly_send_day); if (!Number.isInteger(d) || d < 1 || d > 28) return res.status(400).json({ error: "monthly_send_day must be 1–28" }); patch.monthly_send_day = d; }
    // Email-type toggles: whitelist boolean columns only.
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (ROOFTOP_BOOL_COLS.has(k)) {
        if (typeof v !== "boolean") return res.status(400).json({ error: `${k} must be a boolean` });
        patch[k] = v;
      }
    }
    if (daily_template != null) {
      if (daily_template !== "v1" && daily_template !== "v2") return res.status(400).json({ error: "daily_template must be 'v1' or 'v2'" });
      patch.daily_template = daily_template;
    }
    if (digest_focus != null) {
      if (!["auto", "conversation", "appointment"].includes(digest_focus)) return res.status(400).json({ error: "digest_focus must be 'auto', 'conversation' or 'appointment'" });
      patch.digest_focus = digest_focus;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing to update" });
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const { data: before } = await sb.from("roi_rooftop_config").select(Object.keys(patch).join(",")).eq("team_id", teamId).maybeSingle();
    const { error } = await sb.from("roi_rooftop_config").update(patch).eq("team_id", teamId);
    if (error) return res.status(500).json({ error: error.message });
    await logConfigAudit(sb, teamId, actor, patch, before);
    return res.json({ ok: true, teamId, ...patch });
  } catch (err) {
    console.error("POST /api/rooftop-config error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "update failed" });
  }
});

// ── Config change history for the ConfigDrawer's "History" panel ────────────
app.get("/api/config-audit-log", async (req, res) => {
  try {
    const teamId = String(req.query.teamId || "").trim();
    if (!teamId) return res.status(400).json({ error: "teamId required" });
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const { data, error } = await sb.from("roi_config_audit_log")
      .select("field,old_value,new_value,actor,source,created_at")
      .eq("team_id", teamId).order("created_at", { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, entries: data ?? [] });
  } catch (err) {
    console.error("GET /api/config-audit-log error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "load failed" });
  }
});

// ── Flip is_live for EVERY department of a rooftop (the real emailer kill switch — is_live is
// what both the digest cron and the transactional cron gate on, independent of any UI-level
// "churn" tag). Routed through the server so it can log the change to roi_config_audit_log —
// unlike roi_rooftop_config, roi_live_departments is otherwise written directly from the browser
// (see DryRunToggle) with no audit trail, so this endpoint exists specifically to make the
// "Remove from Emailer" action attributable.
app.post("/api/rooftop-live-status", async (req, res) => {
  try {
    const { teamId, isLive, actor } = req.body ?? {};
    if (!teamId) return res.status(400).json({ error: "teamId required" });
    if (typeof isLive !== "boolean") return res.status(400).json({ error: "isLive must be a boolean" });
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const { data: before, error: readErr } = await sb.from("roi_live_departments").select("department,is_live").eq("team_id", teamId);
    if (readErr) return res.status(500).json({ error: readErr.message });
    const { error } = await sb.from("roi_live_departments").update({ is_live: isLive }).eq("team_id", teamId);
    if (error) return res.status(500).json({ error: error.message });
    try {
      const rows = (before ?? [])
        .filter((d) => d.is_live !== isLive)
        .map((d) => ({ team_id: teamId, actor: actor || null, field: `is_live (${d.department})`, old_value: String(d.is_live), new_value: String(isLive), source: "tracker" }));
      if (rows.length) {
        const { error: auditErr } = await sb.from("roi_config_audit_log").insert(rows);
        if (auditErr) console.warn("[audit] roi_config_audit_log insert failed:", auditErr.message);
      }
    } catch (e) {
      console.warn("[audit] roi_config_audit_log insert failed:", e?.message ?? e);
    }
    return res.json({ ok: true, teamId, isLive });
  } catch (err) {
    console.error("POST /api/rooftop-live-status error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "update failed" });
  }
});

// ── Assign a CSM (name + email both required) → set csm_name + enable BOTH depts ──
app.post("/api/csm", async (req, res) => {
  try {
    const { teamId, name, email, actor } = req.body ?? {};
    const nm = String(name || "").trim();
    const addr = String(email || "").trim();
    if (!teamId || !nm || !/\S+@\S+\.\S+/.test(addr)) return res.status(400).json({ error: "teamId, CSM name and a valid CSM email are all required" });
    const sbUrl = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
    const sbKey = process.env.ROI_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: "ROI_SUPABASE_SERVICE_KEY not set on server" });
    const sb = createSbClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const { data: beforeCfg } = await sb.from("roi_rooftop_config").select("csm_name").eq("team_id", teamId).maybeSingle();
    const { error: cfgErr } = await sb.from("roi_rooftop_config").update({ csm_name: nm }).eq("team_id", teamId);
    if (cfgErr) return res.status(500).json({ error: cfgErr.message });
    await logConfigAudit(sb, teamId, actor, { csm_name: nm }, beforeCfg);
    const { data: existing } = await sb.from("roi_recipients").select("id").eq("team_id", teamId).ilike("email", addr).maybeSingle();
    const patch = { receives_sales: true, receives_service: true, email_enabled: true };
    const q = existing
      ? sb.from("roi_recipients").update({ ...patch, name: nm }).eq("id", existing.id)
      : sb.from("roi_recipients").insert({ team_id: teamId, email: addr, name: nm, ...patch });
    const { error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, teamId, csm: nm, email: addr });
  } catch (err) {
    console.error("POST /api/csm error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "assign CSM failed" });
  }
});

// ── Report a missing rooftop → email product@spyne.ai + subhav.malhotra@spyne.ai ──
app.post("/api/missing-rooftop", async (req, res) => {
  try {
    const { teamId, teamName, departments, csm, csmEmail, note } = req.body ?? {};
    if (!teamId && !teamName) return res.status(400).json({ error: "teamId or teamName required" });
    const esc = (v) => String(v ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const rows = [
      ["Team ID", teamId], ["Team name", teamName], ["Departments live", Array.isArray(departments) ? departments.join(", ") : departments],
      ["CSM", csm], ["CSM email", csmEmail], ["Note", note],
    ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6B7280;">${esc(k)}</td><td style="padding:4px 0;font-weight:600;">${esc(v)}</td></tr>`).join("");
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#111827;"><p>A rooftop is missing from the ROI digest tracker and needs onboarding:</p><table>${rows}</table></div>`;
    const mailUrl = process.env.MAIL_PROXY_URL || process.env.EMAIL_PROXY_URL || "https://mail.spyne.ai/api/v1/send-template-email";
    const template = process.env.MAIL_TEMPLATE || "email-control-tower-report";
    const to = "product@spyne.ai,subhav.malhotra@spyne.ai";
    const mailRes = await fetch(mailUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.MAIL_TOKEN ? { Authorization: `Bearer ${process.env.MAIL_TOKEN}` } : {}) },
      body: JSON.stringify({ to, subject: `Missing ROI rooftop: ${teamName || teamId}`, template, templateData: { HTMLdata: html } }),
    });
    if (!mailRes.ok) { const t = await mailRes.text().catch(() => ""); return res.status(502).json({ error: `mail proxy ${mailRes.status}: ${t.slice(0, 200)}` }); }
    return res.json({ ok: true, to });
  } catch (err) {
    console.error("POST /api/missing-rooftop error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "report failed" });
  }
});

// ── Hourly ROI digest cron (Vercel Cron → this route) ───────────────────────
// Runs the full daily-digest pass for EVERY live rooftop (roi_live_departments.is_live=true).
// With DRY_RUN=false it really emails the rooftops where dry_run=false and suppresses the rest,
// at each rooftop's local send-hour (idempotent: one send per rooftop per day).
// Vercel sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is configured.
app.get("/api/cron/roi-email", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const { runOnce, runCadence } = require("./roi-cron/runner.cjs"); // lazy: env is present at request time
    const summary = await runOnce();
    // Weekly/monthly digests run in the same hourly pass; each is internally gated to
    // its send-day (Mon / 1st) + send-hour, so off-day passes are cheap no-ops.
    const weekly = await runCadence("weekly").catch((e) => ({ error: String(e).slice(0, 120) }));
    const monthly = await runCadence("monthly").catch((e) => ({ error: String(e).slice(0, 120) }));
    return res.status(200).json({ ok: true, ranAt: new Date().toISOString(), summary, weekly, monthly });
  } catch (err) {
    console.error("GET /api/cron/roi-email error:", err?.message ?? err);
    // A total crash of the digest cron writes no rows and would otherwise be invisible → alert loudly.
    try {
      const { postSystemicAlert } = require("./roi-cron/slackAlert.cjs");
      await postSystemicAlert({ source: "Daily digest", title: "digest cron CRASHED", detail: `runOnce threw before completing: ${String(err?.message ?? err).slice(0, 300)}`, windowLabel: "hourly digest cron" });
    } catch { /* best-effort */ }
    return res.status(500).json({ ok: false, error: err?.message ?? "cron failed" });
  }
});

// ── Preview a STORED digest day in a chosen template (render-only, NO send) ──
// Powers the tracker's daily "New / Classic" preview toggle: renders the metrics already stored for
// (teamId, department, cadence, localDate) under tpl=v1|v2 so any past day can be viewed in either
// template. Pure render — no email, no DB write. Returns 404 when that day has no stored metrics.
//   GET /api/email/roi-render-preview?teamId&department&localDate[&cadence=daily][&tpl=v1|v2]
app.get("/api/email/roi-render-preview", async (req, res) => {
  try {
    const { teamId, department, localDate, cadence, tpl } = req.query ?? {};
    if (!teamId || !department || !localDate) return res.status(400).json({ error: "teamId, department, localDate required" });
    const { renderStoredDigest } = require("./roi-cron/runner.cjs");
    const out = await renderStoredDigest({ teamId, department, cadence: cadence || "daily", localDate, tpl });
    if (!out) return res.status(404).json({ error: "no stored digest data for that day — nothing to preview" });
    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error("GET /api/email/roi-render-preview error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "render failed" });
  }
});

// ── Manual ROI digest BACKFILL (record-only, NO emails) ─────────────────────
// On-demand: re-record roi_digest_runs for a past date range (e.g. to fill a gap
// after an outage). Runs the SAME fetch+render pipeline as the cron but never sends
// mail — it only upserts rows. Requires the service_role key (set on Vercel) to
// write roi_digest_runs. Guarded by CRON_SECRET like the cron routes.
//   GET /api/cron/roi-backfill?start=2026-06-23&end=2026-06-24
app.get("/api/cron/roi-backfill", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { start, end } = req.query;
  const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(start) || !isDate(end)) {
    return res.status(400).json({ ok: false, error: "start and end are required as YYYY-MM-DD (e.g. ?start=2026-06-23&end=2026-06-24)" });
  }
  if (start > end) return res.status(400).json({ ok: false, error: "start must be <= end" });
  try {
    const { backfill } = require("./roi-cron/runner.cjs"); // lazy: env is present at request time
    const summary = await backfill(start, end);
    return res.status(200).json({ ok: true, ranAt: new Date().toISOString(), start, end, summary });
  } catch (err) {
    console.error("GET /api/cron/roi-backfill error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "backfill failed" });
  }
});

// ── Transactional email poll (Vercel Cron → this route, ~every 15 min) ──────
// Sends the per-event emails (post-appointment / post-conversation / action-item / overdue)
// for rooftops that enabled them in roi_rooftop_config. Dedup via roi_event_emails.
app.get("/api/cron/roi-events", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const { runOnce } = require("./roi-cron/eventRunner.cjs");
    const summary = await runOnce();
    return res.status(200).json({ ok: true, ranAt: new Date().toISOString(), summary });
  } catch (err) {
    console.error("GET /api/cron/roi-events error:", err?.message ?? err);
    // A total crash of the events cron writes no rows and would otherwise be invisible → alert loudly.
    try {
      const { postSystemicAlert } = require("./roi-cron/slackAlert.cjs");
      await postSystemicAlert({ source: "Transactional email", title: "events cron CRASHED", detail: `runOnce threw before completing: ${String(err?.message ?? err).slice(0, 300)}`, windowLabel: "15-min events cron" });
    } catch { /* best-effort */ }
    return res.status(500).json({ ok: false, error: err?.message ?? "events cron failed" });
  }
});

// ── GET /api/cron/csm-sync — refresh the CSM (cs_poc) mapping ────────────────
// Pulls Metabase Q12071's cs_poc_email per team_id and upserts it into
// roi_rooftop_config.cs_poc — the authoritative CSM the Email Tracker reads.
// Idempotent; safe on a schedule. Vercel sends Authorization: Bearer <secret>.
app.get("/api/cron/csm-sync", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const { syncCsPoc } = require("./roi-cron/syncCsPoc.cjs"); // lazy: env present at request time
    const summary = await syncCsPoc();
    return res.status(200).json({ ok: true, ranAt: new Date().toISOString(), ...summary });
  } catch (err) {
    console.error("GET /api/cron/csm-sync error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "csm-sync failed" });
  }
});

// Rooftop DISCOVERY cron — pull onboarded+active rooftops from ClickHouse and add
// new ones to roi_live_departments (held: is_live=true, dry_run=true → no email).
// Scheduled daily in vercel.json. Same CRON_SECRET auth as the send cron.
app.get("/api/cron/sync-live", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const { syncLive } = require("./roi-cron/runner.cjs"); // lazy: env is present at request time
    const summary = await syncLive();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error("GET /api/cron/sync-live error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "sync failed" });
  }
});

// Rooftop LIFECYCLE-stage sync — pull every Vini rooftop's ARR bucket (onboarding /
// contracting / live / churn) from ClickHouse into roi_rooftop_config, so the tracker
// can show rooftops that aren't technically live yet. Scheduled daily in vercel.json.
app.get("/api/cron/sync-lifecycle", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const { syncLifecycle } = require("./roi-cron/runner.cjs");
    const summary = await syncLifecycle();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error("GET /api/cron/sync-lifecycle error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "sync failed" });
  }
});

// ── GET /api/metrics — "Overall" agent-performance bundle (live ClickHouse) ──
// Powers the Overall view on /agents. Runs the 6 day/week/month aggregations
// against Prod-ClickHouse and returns { bundle, meta }. Returns 503 when the
// CLICKHOUSE_* env vars are not set — the frontend then falls back to the
// bundled snapshot (public/agent-overall-snapshot.json).
// 5-minute in-process cache so repeated loads are instant and the live
// ClickHouse query (~50s) only re-runs once per window. `?refresh=1` bypasses
// it (the dashboards' auto-refresh forces a fresh pull every 5 min, matching
// the agents-refresh-incremental cron cadence).
let metricsCache = { payload: null, fetchedAt: 0 };
let metricsInflight = null; // single-flight: concurrent callers share one query set
const METRICS_TTL_MS = 5 * 60 * 1000;

// Compute + persist the Overall bundle to the cron-backed cache.
async function refreshMetricsCache() {
  const payload = await runAgentMetrics();
  metricsCache = { payload, fetchedAt: Date.now() };
  await writeAgentCache(AGENT_CACHE_KEY_OVERALL, payload);
  return payload;
}

// ── Partial refreshes (mirrors the rooftop split above) ──────────────────
// day/week/month are each their own uniqExact(lead_id) distinct count over
// their own window — a week's count isn't derivable from its daily rows
// either. `day` refreshes on a tight cadence via the full, UNMODIFIED
// day_metrics/day_intent/day_vouchers queries (not narrowed — a live
// full-vs-narrowed cross-check caught a real undercount bug in `qualified`
// from doing that, see agentMetrics.js); `week`/`month` stay on their own
// full, unmodified queries too, just at a slower cadence, since none of the
// 6 embedded query floors are safe to hand-narrow (verified: textually
// identical floor literals within one query aren't necessarily semantically
// interchangeable — one gates an unrelated lead-level lookback).
function mergePeriodGrain(cachedGrain, freshGrain) {
  if (!freshGrain) return cachedGrain;
  if (!cachedGrain) return freshGrain;
  const data = { ...cachedGrain.data, ...freshGrain.data };
  const intent = { ...cachedGrain.intent, ...freshGrain.intent };
  const periods = [...new Set([...(cachedGrain.periods || []), ...(freshGrain.periods || [])])].sort().reverse();
  return { periods, data, intent };
}

async function loadMetricsBase() {
  if (metricsCache.payload?.bundle) return metricsCache.payload;
  const cached = await readAgentCache(AGENT_CACHE_KEY_OVERALL);
  return cached?.payload?.bundle ? cached.payload : null;
}

async function refreshMetricsCacheIncremental() {
  if (!hasClickhouseCreds()) return null;
  const base = await loadMetricsBase();
  if (!base) return refreshMetricsCache();
  const { day } = await runAgentMetricsIncremental();
  const bundle = { ...base.bundle, day: mergePeriodGrain(base.bundle.day, day) };
  const payload = { bundle, meta: { ...base.meta, generated: new Date().toISOString().slice(0, 10) } };
  metricsCache = { payload, fetchedAt: Date.now() };
  await writeAgentCache(AGENT_CACHE_KEY_OVERALL, payload);
  return payload;
}

async function refreshMetricsCacheWeekMonthOnly() {
  if (!hasClickhouseCreds()) return null;
  const base = await loadMetricsBase();
  if (!base) return refreshMetricsCache();
  const { week, month } = await runAgentMetricsWeekMonth();
  const payload = { bundle: { ...base.bundle, week, month }, meta: base.meta };
  metricsCache = { payload, fetchedAt: Date.now() };
  await writeAgentCache(AGENT_CACHE_KEY_OVERALL, payload);
  return payload;
}

// Same serving order as /api/agents: warm in-process → precomputed Postgres
// cache (instant) → live ClickHouse only on a cold first load or ?refresh=1.
app.get("/api/metrics", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    if (!force && metricsCache.payload && (Date.now() - metricsCache.fetchedAt) < METRICS_TTL_MS) {
      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=1200");
      return res.status(200).json(metricsCache.payload);
    }
    if (!force) {
      const cached = await readAgentCache(AGENT_CACHE_KEY_OVERALL);
      if (cached?.payload?.bundle) {
        metricsCache = { payload: cached.payload, fetchedAt: new Date(cached.computedAt).getTime() };
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=1200");
        return res.status(200).json(metricsCache.payload);
      }
    }
    // No cached bundle yet — a live compute needs ClickHouse creds. Without them
    // the frontend falls back to its bundled snapshot (public/agent-overall-snapshot.json).
    if (!hasClickhouseCreds()) {
      return res.status(503).json({ error: "ClickHouse env vars not set (need CLICKHOUSE_HOST/PORT/USER/PASSWORD) — using bundled snapshot." });
    }
    // Reuse an in-flight run instead of launching another (avoids stacking
    // memory-heavy ClickHouse scans when several clients refresh at once).
    if (!metricsInflight) {
      metricsInflight = refreshMetricsCache().finally(() => { metricsInflight = null; });
    }
    await metricsInflight;
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=1200");
    res.status(200).json(metricsCache.payload);
  } catch (err) {
    console.error("GET /api/metrics error:", err?.message ?? err);
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /api/cron/agents-refresh(-incremental|-full) — precompute both
// dashboards into the cache ──────────────────────────────────────────────
// Three tiers, all writing the SAME cache the routes below read:
//   -incremental (every few min): narrow "today" scans, merged into the cache.
//     Cheap — this is what makes a call/SMS from minutes ago show up fast.
//   (plain, hourly): full-window `totals`/`week`/`month` grains, replacing
//     those wholesale — these are window-level distinct counts that can't be
//     cheaply derived from the daily/day cache, so they still need the full
//     scan, just less often than before.
//   -full (weekly): the original full recompute of everything. Insurance
//     against a historical correction (a dev backfill, late CDC) landing
//     outside the incremental tier's narrow window — the only path that ever
//     re-verifies old, already-cached days.
// Vercel Cron hits these on a schedule (see vercel.json); each run logs to
// roi_cron_runs so "when did each tier last sync" is always answerable.
function makeAgentsRefreshRoute(mode, { rooftop: rooftopFn, overall: overallFn }) {
  return async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const ranAt = new Date().toISOString();
    if (!hasCacheDb()) {
      console.warn(`[cron/agents-refresh:${mode}] no cache DB configured (POSTGRES_URL) — precompute skipped`);
    }
    // Both refreshes share the global ClickHouse concurrency cap internally, so
    // launching them together just interleaves their queries. allSettled so one
    // failing tab still persists the other.
    const [rooftop, overall] = await Promise.allSettled([
      rooftopFn(),
      hasClickhouseCreds()
        ? overallFn()
        : Promise.reject(new Error("ClickHouse creds not set")),
    ]);
    const summary = {
      ranAt,
      mode,
      cacheDb: hasCacheDb(),
      rooftop: rooftop.status === "fulfilled"
        ? { ok: true, daily: rooftop.value?.daily?.length ?? null, totals: rooftop.value?.totals?.length ?? null, source: rooftop.value?.source ?? null }
        : { ok: false, error: String(rooftop.reason?.message ?? rooftop.reason) },
      overall: overall.status === "fulfilled"
        ? { ok: true, meta: overall.value?.meta ?? null }
        : { ok: false, error: String(overall.reason?.message ?? overall.reason) },
    };
    const ok = rooftop.status === "fulfilled" || overall.status === "fulfilled";
    if (!ok) console.error(`[cron/agents-refresh:${mode}] both refreshes failed`, summary);
    await logCronRun(`agents-refresh-${mode}`, ok, summary);
    return res.status(ok ? 200 : 500).json({ ok, ...summary });
  };
}

app.get("/api/cron/agents-refresh-incremental", makeAgentsRefreshRoute("incremental", {
  rooftop: refreshRooftopCacheIncremental,
  overall: refreshMetricsCacheIncremental,
}));

app.get("/api/cron/agents-refresh", makeAgentsRefreshRoute("hourly", {
  rooftop: refreshRooftopCacheTotalsOnly,
  overall: refreshMetricsCacheWeekMonthOnly,
}));

app.get("/api/cron/agents-refresh-full", makeAgentsRefreshRoute("full", {
  rooftop: refreshRooftopCache,
  overall: refreshMetricsCache,
}));

export default app;
