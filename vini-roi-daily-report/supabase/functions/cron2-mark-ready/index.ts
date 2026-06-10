// CRON 2 (Step 1): read live ∩ config ∩ recipients → log READY rooftops in the
// daily run. Determines: live dept, send-time passed & not already sent, who receives.
// Manual/dry: ?team=<id> scopes to one rooftop; ?bypass=true ignores the send-hour gate.
import { supa, dealerWindows, json } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const team = u.searchParams.get("team");
  const bypass = u.searchParams.get("bypass") === "true";
  const sb = supa();

  let q = sb.from("roi_live_departments").select("team_id,enterprise_id,department,dry_run").eq("is_live", true);
  if (team) q = q.eq("team_id", team);
  const { data: live } = await q;
  const { data: cfgRows } = await sb.from("roi_rooftop_config").select("team_id,rooftop_name,timezone,digest_send_hour,daily_enabled");
  const { data: recRows } = await sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled");
  const cfg = new Map((cfgRows ?? []).map((c) => [c.team_id, c]));
  const recByTeam = new Map<string, any[]>();
  for (const r of recRows ?? []) { const a = recByTeam.get(r.team_id) ?? []; a.push(r); recByTeam.set(r.team_id, a); }

  const out = { ready: 0, before_hour: 0, recipients_missing: 0, already_sent: 0, disabled: 0 };

  for (const L of live ?? []) {
    const c = cfg.get(L.team_id);
    const tz = c?.timezone ?? "America/New_York";
    if (c && c.daily_enabled === false) { out.disabled++; continue; }
    const w = dealerWindows(tz);
    const base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence: "daily", local_date: w.localDate, dealer_timezone: tz, trigger: team ? "manual" : "cron" };

    const { data: sent } = await sb.from("roi_digest_runs").select("id")
      .eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", w.localDate).eq("status", "sent").maybeSingle();
    if (sent) { out.already_sent++; continue; }

    if (!bypass && w.localHour < (c?.digest_send_hour ?? 7)) {
      await sb.from("roi_digest_runs").upsert({ ...base, status: "scheduled", reason: "before_send_hour" }, { onConflict: "team_id,department,cadence,local_date" });
      out.before_hour++; continue;
    }

    const recips = (recByTeam.get(L.team_id) ?? [])
      .filter((r) => (L.department === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled)
      .map((r) => r.email);
    if (!recips.length) {
      await sb.from("roi_digest_runs").upsert({ ...base, status: "not_sent", reason: "recipients_missing" }, { onConflict: "team_id,department,cadence,local_date" });
      out.recipients_missing++; continue;
    }

    // READY → 'scheduled/ready' with recipient snapshot; cron3 picks these up
    await sb.from("roi_digest_runs").upsert(
      { ...base, status: "scheduled", reason: "ready", recipients: recips.map((e) => ({ email: e, received: false })) },
      { onConflict: "team_id,department,cadence,local_date" });
    out.ready++;
  }
  return json(out);
});
