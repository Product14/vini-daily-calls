// CRON 1 (Step 0) — the hourly entrypoint. Two jobs:
//   (a) SYNC: re-pull the onboarded+active Sales/Service rooftops from ClickHouse
//       into roi_live_departments. New (team,dept) rows are inserted is_live=false,
//       dry_run=true (held until a human flips them live). Rows that were live but
//       have dropped out of onboarded+active are forced is_live=false. Existing
//       human-curated is_live / dry_run flags are NEVER overwritten (ON CONFLICT DO NOTHING).
//   (b) ORCHESTRATE: invoke cron2 → cron3 → cron4 in order, threading ?team / ?dry.
//
// Manual/dry usage (no real send, one rooftop, full flow):
//   POST /cron1-sync-live?team=<id>&dry=true&skipSync=true
//   - skipSync=true   → don't touch the live set, just run the pipeline
//   - team=<id>       → only that rooftop through 2/3/4
//   - dry=true        → forces cron4 to suppress (sends nothing) regardless of flags
import { supa, liveCandidates, json, preflight } from "../_shared/lib.ts";

const BASE = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function call(fn: string, params: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}/${fn}${qs ? `?${qs}` : ""}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, ...extraHeaders },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf; // CORS preflight for the browser-based tracker trigger

  const u = new URL(req.url);
  const team = u.searchParams.get("team");
  const dry = u.searchParams.get("dry") === "true";
  const force = u.searchParams.get("force") === "true"; // real send, override dry_run flag (manual "Send now")
  const bypass = u.searchParams.get("bypass") === "true"; // ignore send-hour gate (manual tests)
  const skipSync = u.searchParams.get("skipSync") === "true";
  const mailToken = req.headers.get("x-mail-token") ?? ""; // FE-supplied mail cookie/token, forwarded to cron4
  const sb = supa();
  const result: Record<string, unknown> = {};

  // ── (a) SYNC live candidate set from ClickHouse ───────────────────────────
  if (!skipSync) {
    const rows = await liveCandidates(); // onboarded+active Sales/Service via the CH endpoint
    const cand = rows.map((r) => ({ team_id: String(r.t), enterprise_id: String(r.e), department: String(r.d) }));
    const candSet = new Set(cand.map((c) => `${c.team_id}|${c.department}`));

    // insert NEW candidates only — ignoreDuplicates keeps existing is_live/dry_run intact
    for (let i = 0; i < cand.length; i += 500) {
      await sb.from("roi_live_departments")
        .upsert(cand.slice(i, i + 500).map((c) => ({ ...c, is_live: false, dry_run: true })),
          { onConflict: "team_id,department", ignoreDuplicates: true });
    }

    // force is_live=false for rooftops that were live but dropped out of onboarded+active
    const { data: liveNow } = await sb.from("roi_live_departments").select("team_id,department").eq("is_live", true);
    const stale = (liveNow ?? []).filter((l) => !candSet.has(`${l.team_id}|${l.department}`));
    for (const s of stale) {
      await sb.from("roi_live_departments").update({ is_live: false }).eq("team_id", s.team_id).eq("department", s.department);
    }
    result.sync = { candidates: cand.length, deactivated: stale.length };
  } else {
    result.sync = "skipped";
  }

  // ── (b) ORCHESTRATE 2 → 3 → 4 ─────────────────────────────────────────────
  const scope: Record<string, string> = {};
  if (team) scope.team = team;
  result.cron2 = await call("cron2-mark-ready", { ...scope, ...(bypass ? { bypass: "true" } : {}) });
  result.cron3 = await call("cron3-render", scope);
  result.cron4 = await call(
    "cron4-send",
    { ...scope, ...(dry ? { dry: "true" } : {}), ...(force ? { force: "true" } : {}) },
    mailToken ? { "x-mail-token": mailToken } : {}, // forward FE token to cron4 (header, not URL)
  );

  return json(result);
});
