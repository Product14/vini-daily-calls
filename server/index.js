import "./loadEnv.js";
import dns from "node:dns";
// Some macOS dev environments hang on IPv6 lookups for hosted Metabase; prefer IPv4
// so /api/dream and other Metabase passthroughs don't time out under flaky resolvers.
dns.setDefaultResultOrder?.("ipv4first");
import { initSchema } from "./db.js";
import app from "./app.js";

const PORT = process.env.PORT || 3002;

try {
  await initSchema();
} catch (err) {
  // AggregateError (e.g. pg ECONNREFUSED) has empty .message; surface .code and inner errors.
  const parts = [err?.message, err?.code, ...(err?.errors?.map((e) => e?.message) ?? [])].filter(Boolean);
  const reason = parts.length ? parts.join(" | ") : String(err);
  const hint = !process.env.VIN_TRACKER_DATABASE_URL
    ? "\n  hint: VIN_TRACKER_DATABASE_URL is not set — copy .env.example to .env (or database_url.env) and fill in the Supabase URL."
    : "";
  console.warn(
    `[startup] initSchema failed — DB endpoints will 500, but non-DB routes (e.g. /api/campaigns) still work.\n  reason: ${reason}${hint}`
  );
}

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  // Prewarm the ClickHouse-backed /agents caches in the background. Both routes
  // run live base_fact scans that take ~50-66s cold, then cache for 20 min. Without
  // this, the FIRST visitor after a restart sits on a blank /agents (Overall ~50s,
  // first Rooftop click ~66s) — looks like the page is broken. Firing the same
  // requests the first user would trigger means the data is ready by the time
  // anyone opens the page. Best-effort: failures here just fall back to lazy load.
  const base = `http://localhost:${PORT}`;
  for (const path of ["/api/metrics", "/api/agents"]) {
    fetch(`${base}${path}`)
      .then((r) => console.log(`[prewarm] ${path} -> ${r.status}`))
      .catch((e) => console.warn(`[prewarm] ${path} failed: ${e?.message ?? e}`));
  }
});
