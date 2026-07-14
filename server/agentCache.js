// Persistent precompute cache for the agent dashboards (Overall + Rooftop).
//
// Why this exists: on Vercel each cold serverless invocation starts with an empty
// in-process cache, so /api/agents and /api/metrics would re-run the heavy
// ClickHouse base_fact scans (~50–66s) on the first hit after every scale-to-zero
// — the "takes forever to load" symptom. We instead PRECOMPUTE both bundles on a
// cron and persist them here; the routes then serve a sub-100ms row lookup and
// never block a page load on ClickHouse.
//
// Storage: a single tiny table keyed by 'overall' | 'rooftop'. We use a dedicated
// pool (NOT server/db.js) because that pool points at VIN_TRACKER_DATABASE_URL —
// unset in this deployment — and drags in the VIN inventory schema/materialized
// views. Here we connect to the Supabase Postgres that IS configured in prod
// (POSTGRES_URL), so caching works without touching the VIN tracker.
import pg from "pg";

const { Pool } = pg;

function connString() {
  // Deliberately does NOT fall back to VIN_TRACKER_DATABASE_URL — that's the unrelated VIN-inventory
  // Supabase project (see server/db.js), and the whole point of this dedicated pool is to never touch
  // it. It used to sit ahead of POSTGRES_URL in this chain (backwards from that stated intent); harmless
  // only because VIN_TRACKER_DATABASE_URL happens to be unset in this deployment. If it's ever set for
  // the unrelated VIN-tracker feature, this cache must not silently start reading/writing that project.
  return (
    process.env.AGENT_CACHE_DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

export function hasCacheDb() {
  return Boolean(connString());
}

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const cs = connString();
  if (!cs) return null;
  _pool = new Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  return _pool;
}

let _tableReady = null;
export async function ensureAgentCacheTable() {
  const p = pool();
  if (!p) return false;
  if (!_tableReady) {
    _tableReady = p
      .query(
        `CREATE TABLE IF NOT EXISTS agent_metrics_cache (
           cache_key   TEXT PRIMARY KEY,
           payload     JSONB NOT NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      )
      .then(() => true)
      .catch((err) => {
        _tableReady = null; // allow a retry on the next call
        throw err;
      });
  }
  return _tableReady;
}

// Returns { payload, computedAt } or null. Best-effort: any DB error -> null so
// the route falls back to live compute instead of erroring.
export async function readAgentCache(key) {
  const p = pool();
  if (!p) return null;
  try {
    await ensureAgentCacheTable();
    const { rows } = await p.query(
      `SELECT payload, computed_at FROM agent_metrics_cache WHERE cache_key = $1`,
      [key]
    );
    if (!rows.length) return null;
    return { payload: rows[0].payload, computedAt: rows[0].computed_at };
  } catch (err) {
    console.warn(`[agentCache] read ${key} failed: ${err?.message ?? err}`);
    return null;
  }
}

export async function writeAgentCache(key, payload) {
  const p = pool();
  if (!p) return false;
  try {
    await ensureAgentCacheTable();
    await p.query(
      `INSERT INTO agent_metrics_cache (cache_key, payload, computed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key)
       DO UPDATE SET payload = EXCLUDED.payload, computed_at = NOW()`,
      [key, JSON.stringify(payload)]
    );
    return true;
  } catch (err) {
    console.warn(`[agentCache] write ${key} failed: ${err?.message ?? err}`);
    return false;
  }
}
