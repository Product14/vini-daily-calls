// ─── Superbryn quality eval integration ────────────────────────────────────
// Fetches observability calls + per-call audit/eval data for each of the
// four agent types (Sales IB / Sales OB / Service IB / Service OB).
//
// API:
//   GET /public-api/v1/observability/calls?limit=&cursor=
//     → { data: [...], next_cursor, has_more }
//   GET /public-api/v1/observability/calls/:id
//     → adds { audit: {verdict,...}, analysis_issues: [...] }
//
// Quality verdict mapping (Superbryn → stakeholder UI):
//   TN  →  All Clear     (correctly identified no issue)
//   FN  →  Blind Spot    (real issue MISSED by agent)
//   FP  →  False Alarm   (flagged but no real issue)
//   TP  →  Red Alert     (real issue correctly caught)
//
// Each agent key is scoped to ONE agent in Superbryn, so we issue 4 parallel
// fetches (one per agent type). Results are cached per-day per-agent to
// data/superbryn/<date>/<agent>.json so reruns are free.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "data", "superbryn");

const BASE_URL = "https://api.superbryn.com/public-api/v1";

// Sales IB has TWO keys: the original v2-scoped key (now stale — last data
// was 20-May-2026) and a newer v1-scoped key the user generated 15-Jun. The
// v1 key is where active Sales IB data lives, so prefer it; fall back to the
// v2 key if it's missing. Other agents have one key each.
const AGENT_KEYS = {
  "Sales IB":   ["SUPERBRYN_KEY_SALES_IB_2", "SUPERBRYN_KEY_SALES_IB"],
  "Sales OB":   ["SUPERBRYN_KEY_SALES_OB"],
  "Service IB": ["SUPERBRYN_KEY_SERVICE_IB"],
  "Service OB": ["SUPERBRYN_KEY_SERVICE_OB"],
};

const VERDICT_MAP = { TN: "allClear", FN: "blindSpot", FP: "falseAlarm", TP: "redAlert" };
const LANE_LABEL  = {
  agent_performance: "Agent Performance",
  user_behaviour:    "User Behaviour",
  user_behavior:     "User Behaviour",
  tool_execution:    "Tool Execution",
  audio_technical:   "Audio & Technical",
  "audio&technical": "Audio & Technical",
  security:          "Security",
  observer:          "Observer",
};

// Configurable look-back. Default 24h. If window has zero analyzed calls,
// the caller can re-run with a wider window via opts.
const DEFAULT_LOOKBACK_HOURS = 24;
const FALLBACK_LOOKBACK_HOURS = 24 * 30;    // 30d when 24h is empty

function ensureCacheDir(date) {
  const dir = join(CACHE_DIR, date);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Sleep helper (used between batches to respect rate limits).
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, apiKey, attempt = 0) {
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  if (res.status === 429 && attempt < 4) {
    // Exponential backoff: 500ms, 1s, 2s, 4s.
    await sleep(500 * Math.pow(2, attempt));
    return fetchJson(url, apiKey, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Superbryn ${res.status} for ${url} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Paginate /observability/calls until we either fall past `sinceIso` or run
// out of data. Returns the array of call summaries within the window.
async function fetchCallsSince(apiKey, sinceIso, hardCap = 2000) {
  const calls = [];
  let cursor = null;
  while (calls.length < hardCap) {
    const url = `${BASE_URL}/observability/calls?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await fetchJson(url, apiKey);
    if (!Array.isArray(page.data) || page.data.length === 0) break;
    for (const c of page.data) {
      // API returns newest-first; once we see a call older than sinceIso, stop.
      if (c.created_at < sinceIso) return calls;
      calls.push(c);
    }
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return calls;
}

async function fetchDetail(apiKey, callId, cacheDir) {
  const cachePath = join(cacheDir, `${callId}.json`);
  if (existsSync(cachePath)) {
    try { return JSON.parse(readFileSync(cachePath, "utf8")); } catch { /* fall through */ }
  }
  const detail = await fetchJson(`${BASE_URL}/observability/calls/${callId}`, apiKey);
  // Strip the transcript before caching — large + not needed for aggregation.
  const slim = { ...detail, transcript: undefined };
  writeFileSync(cachePath, JSON.stringify(slim));
  return slim;
}

// Aggregate verdict counts + top issues for one agent type.
function aggregate(label, calls, details) {
  const ingested = calls.length;
  const analyzed = calls.filter(c => c.audit_verdict).length;
  const filtered = ingested - analyzed;

  // Filter-reason breakdown (helps the email show *why* a call was excluded).
  const filterReasons = {};
  for (const c of calls.filter(c => !c.audit_verdict)) {
    let reason;
    if (c.duration_seconds < 10) reason = "Call too short";
    else if (c.end_reason === "voicemail" || c.voicemail_detection === "yes") reason = "Voicemail";
    else if (c.duration_seconds < 30) reason = "Too few customer turns";
    else reason = "Other / pending eval";
    filterReasons[reason] = (filterReasons[reason] || 0) + 1;
  }

  // Quality verdict distribution.
  const quality = { allClear: 0, blindSpot: 0, falseAlarm: 0, redAlert: 0 };
  for (const c of calls) {
    const k = VERDICT_MAP[c.audit_verdict];
    if (k) quality[k] += 1;
  }

  // Aggregate issues across analyzed calls. Group by (lane, title) — count =
  // how many distinct calls hit this issue.
  //
  // v1 agents expose issues in `analysis_issues[]` directly.
  // v2 agents (Sales IB) expose them in `audit.transcript_audit.*_status`
  // — when a `*_status` field is "false", that call failed that audit lane.
  // We extract both shapes so the report works across versions.
  const V2_LANES = [
    { field: "security_status",          lane: "security",          label: "Security guardrail breach"   },
    { field: "call_path_status",         lane: "agent_performance", label: "Agent did not follow the expected call flow" },
    { field: "tool_call_status",         lane: "tool_execution",    label: "Tool call failure"           },
    { field: "policy_guardrails_status", lane: "agent_performance", label: "Policy guardrail violation"  },
  ];
  const issueMap = new Map();
  const bump = (lane, label) => {
    const key = `${lane}|${label}`;
    if (!issueMap.has(key)) {
      issueMap.set(key, { lane: LANE_LABEL[lane] || lane, label, failedCalls: 0 });
    }
    issueMap.get(key).failedCalls += 1;
  };
  for (const d of details) {
    // v1 path
    for (const iss of (d.analysis_issues || [])) {
      bump(iss.lane, iss.title || iss.code);
    }
    // v2 path — derive from audit.transcript_audit
    const ta = d.audit?.transcript_audit;
    if (ta) {
      for (const { field, lane, label } of V2_LANES) {
        if (ta[field] === "false") bump(lane, label);
      }
    }
    // Free-form observer_analysis entries (v2)
    for (const obs of (d.audit?.observer_analysis || [])) {
      if (obs?.title || obs?.label) bump(obs.lane || "observer", obs.title || obs.label);
    }
  }
  const topIssues = [...issueMap.values()]
    .map(t => ({ ...t, failRate: analyzed > 0 ? t.failedCalls / analyzed : 0 }))
    .sort((a, b) => b.failedCalls - a.failedCalls)
    .slice(0, 5);

  return {
    label,
    ingested,
    analyzed,
    filtered,
    filterReasons,
    quality,
    topIssues,
  };
}

// Public entry: pull quality data for ALL four agent types in parallel.
// Returns { asOfDate, lookbackHours, agents: [...] }.
export async function fetchAllQuality({ lookbackHours = DEFAULT_LOOKBACK_HOURS, todayIso = null } = {}) {
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const sinceMs = Date.now() - lookbackHours * 3600 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const cacheDir = ensureCacheDir(today);

  const agents = await Promise.all(Object.entries(AGENT_KEYS).map(async ([label, envNames]) => {
    // Walk the env-name list — first non-empty wins.
    const apiKey = envNames.map(n => process.env[n]).find(v => v && v.trim());
    if (!apiKey) {
      return { label, error: `missing env (${envNames.join("|")})`, ingested: 0, analyzed: 0, filtered: 0, quality: {}, topIssues: [] };
    }
    try {
      // Step 1: list of calls in window.
      let calls = await fetchCallsSince(apiKey, sinceIso);
      let usedFallback = false;
      if (calls.filter(c => c.audit_verdict).length === 0 && lookbackHours < FALLBACK_LOOKBACK_HOURS) {
        // No analyzed calls in primary window — fall back to a wider window
        // so the email shows the most recent batch instead of an empty card.
        const wideSinceIso = new Date(Date.now() - FALLBACK_LOOKBACK_HOURS * 3600 * 1000).toISOString();
        calls = await fetchCallsSince(apiKey, wideSinceIso);
        usedFallback = true;
      }
      // Step 2: fetch detail for each analyzed call.
      // Cap to MAX_DETAIL_FETCHES so very wide fallback windows don't blow
      // through rate limits. Parallel batches of 4 with a 200ms pause
      // between batches — gentle enough to stay under Superbryn's limit.
      const MAX_DETAIL_FETCHES = 150;
      const analyzedCalls = calls.filter(c => c.audit_verdict).slice(0, MAX_DETAIL_FETCHES);
      const details = [];
      for (let i = 0; i < analyzedCalls.length; i += 4) {
        const batch = analyzedCalls.slice(i, i + 4);
        const got = await Promise.all(batch.map(c => fetchDetail(apiKey, c.id, cacheDir).catch(e => {
          console.error(`  ! detail fetch failed for ${c.id}: ${e.message}`);
          return null;
        })));
        for (const d of got) if (d) details.push(d);
        if (i + 4 < analyzedCalls.length) await sleep(200);
      }
      const agg = aggregate(label, calls, details);
      if (usedFallback) agg.windowNote = `Last ${FALLBACK_LOOKBACK_HOURS}h (no analyzed calls in last ${lookbackHours}h)`;
      else agg.windowNote = `Last ${lookbackHours}h`;
      return agg;
    } catch (e) {
      return { label, error: e.message, ingested: 0, analyzed: 0, filtered: 0, quality: {}, topIssues: [] };
    }
  }));

  return {
    asOfDate: today,
    lookbackHours,
    agents,
  };
}
