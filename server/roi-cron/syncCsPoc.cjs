// Sync the CSM point-of-contact mapping into reporting-vini Supabase.
//
// Source of truth: Metabase question 12071, column `cs_poc_email`, keyed by
// team_id (a clean 1:1 mapping — verified no team_id has >1 distinct POC). We
// write it to roi_rooftop_config.cs_poc, which the Email Tracker reads as the
// authoritative CSM (see src/email/dataSource.ts → nameFromEmail(cs_poc)).
//
// Re-runnable: `node server/roi-cron/syncCsPoc.cjs` (loads .env), or call
// syncCsPoc() from the cron route. Only cs_poc is upserted — rooftop_name /
// csm_name on existing rows are never clobbered.
//
// Env: METABASE_SECRET_KEY, METABASE_SITE_URL (default metabase.spyne.ai),
//      ROI_SUPABASE_URL, ROI_SUPABASE_SERVICE_KEY (service_role, not anon).
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");

const MB_SITE = process.env.METABASE_SITE_URL || "https://metabase.spyne.ai";
const MB_SECRET = process.env.METABASE_SECRET_KEY;
const QUESTION = Number(process.env.CS_POC_METABASE_QUESTION) || 12071;
const SB_URL = process.env.ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Sign a short-lived Metabase embedding JWT (HS256) without pulling in
// jsonwebtoken — the payload is trivial and node:crypto is always available.
function signEmbedToken(question) {
  const data = b64url({ alg: "HS256", typ: "JWT" }) + "." +
    b64url({ resource: { question }, params: {}, exp: Math.round(Date.now() / 1000) + 600 });
  return data + "." + crypto.createHmac("sha256", MB_SECRET).update(data).digest("base64url");
}

async function fetchCsPocMap() {
  const token = signEmbedToken(QUESTION);
  const res = await fetch(`${MB_SITE}/api/embed/card/${token}/query/json`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Metabase Q${QUESTION} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  const map = new Map(); // team_id -> cs_poc_email (first non-empty wins)
  for (const r of rows) {
    const t = String(r.team_id ?? "").trim();
    const e = String(r.cs_poc_email ?? "").trim().toLowerCase();
    if (t && e && !map.has(t)) map.set(t, e);
  }
  return map;
}

async function syncCsPoc() {
  if (!MB_SECRET) throw new Error("Missing METABASE_SECRET_KEY");
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY (service_role key)");
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  const map = await fetchCsPocMap();
  // Only (team_id, cs_poc) so we never overwrite curated rooftop_name/csm_name.
  const payload = [...map.entries()].map(([team_id, cs_poc]) => ({ team_id, cs_poc, updated_at: new Date().toISOString() }));
  const { error } = await sb.from("roi_rooftop_config").upsert(payload, { onConflict: "team_id" });
  if (error) throw new Error(`roi_rooftop_config upsert failed (service_role key required): ${error.message}`);

  return { question: QUESTION, mapped: payload.length };
}

module.exports = { syncCsPoc, fetchCsPocMap };

// Allow `node server/roi-cron/syncCsPoc.cjs` for a manual run.
if (require.main === module) {
  // loadEnv.js is ESM; load .env best-effort via dotenv directly instead.
  try { require("dotenv").config({ path: ["database_url.env", ".env"] }); } catch { /* env already set */ }
  syncCsPoc()
    .then((r) => { console.log("[syncCsPoc] done:", JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error("[syncCsPoc] failed:", e?.message ?? e); process.exit(1); });
}
