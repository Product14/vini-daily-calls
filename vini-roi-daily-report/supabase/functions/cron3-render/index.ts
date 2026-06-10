// CRON 3 (Step 2): for each READY run row, pull yesterday's ClickHouse metrics and
// apply guardrails. Pass → status='queued' (+ metrics, subject). Fail → 'not_sent'
// (no_data / not_actionable). It does NOT render the email HTML — the Node prebuild
// job (email-render/prebuild.cjs) renders the ACTUAL LegacyDailyDigest component into
// rendered_html for queued rows, then cron4 sends it. The tracker previews from metrics.
// reportDate is stored as ISO (local_date) because the component's formatDate() splits on "-".
// Manual/dry: ?team=<id> scopes to one rooftop.
import { supa, dealerWindows, metrics, guardrail, json, type Dept } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const team = u.searchParams.get("team");
  const sb = supa();

  let q = sb.from("roi_digest_runs").select("id,team_id,department,local_date,dealer_timezone,recipients")
    .eq("status", "scheduled").eq("reason", "ready");
  if (team) q = q.eq("team_id", team);
  const { data: rows } = await q;

  const { data: cfgRows } = await sb.from("roi_rooftop_config").select("team_id,rooftop_name");
  const nameOf = new Map((cfgRows ?? []).map((c) => [c.team_id, c.rooftop_name]));

  const out = { queued: 0, no_data: 0, not_actionable: 0 };

  for (const r of rows ?? []) {
    const tz = r.dealer_timezone ?? "America/New_York";
    const w = dealerWindows(tz);
    const name = nameOf.get(r.team_id) ?? r.team_id;
    const m = await metrics(r.team_id, r.department as Dept, w.yStart, w.yEnd, w.monthStart);
    const g = guardrail(m);
    // reportDate must be ISO (yyyy-mm-dd) — the email component's formatDate() splits on "-"
    const metricsJson = { ...m, reportDate: w.localDate };

    if (!g.ok) {
      await sb.from("roi_digest_runs").update({ status: "not_sent", reason: g.reason, metrics: metricsJson, rendered_html: null }).eq("id", r.id);
      if (g.reason === "not_actionable") out.not_actionable++; else out.no_data++;
      continue;
    }
    // QUEUED with metrics; rendered_html stays null until the prebuild job fills it.
    await sb.from("roi_digest_runs").update({
      status: "queued", reason: null, metrics: metricsJson, rendered_html: null,
      subject: `${r.department === "service" ? "Service" : "Sales"} Daily Digest — ${name}`,
    }).eq("id", r.id);
    out.queued++;
  }
  return json(out);
});
