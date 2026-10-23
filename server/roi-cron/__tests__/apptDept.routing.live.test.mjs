// APPOINTMENT DEPARTMENT ROUTING (blocking check): an appointment belongs to its OWN service_type,
// never to the tracker row it is viewed or sent from. The Sales drill-down must list no service
// appointment (and vice versa), and the manual send path's lookup must report the meeting's own
// department so /api/email/roi-event-generate-send can refuse a cross-department send.
//
// Regression guard for Stillwell Ford, 2026-10-07: listEventsCH ignored the department for
// post_appointment, so the Sales row listed all 27 service appointments as eligible; five were sent
// from it and the service bookings reached the sales team.
//
// Run: npm run test:live   (needs CLICKHOUSE_* in env; excluded from the offline `npm test`)
import "dotenv/config";
import { listEventsCH, meetingDeptCH } from "../eventPreviewCH.js";
import { runClickhouse } from "../../agentMetrics.js";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };

// a rooftop with Vini-booked appointments in BOTH departments, plus one meeting of each
const [team] = await runClickhouse(
  "SELECT team_id FROM dealer_leads.meetings WHERE source='spyne' AND is_active=1 AND created_at >= now() - INTERVAL 30 DAY" +
  " GROUP BY team_id HAVING countIf(service_type='service') > 0 AND countIf(service_type!='service') > 0" +
  " ORDER BY count() DESC LIMIT 1");
const TEAM = process.env.APPT_DEPT_TEST_TEAM || team.team_id;
const [svc] = await runClickhouse("SELECT meeting_id FROM dealer_leads.meetings WHERE team_id='" + TEAM + "' AND source='spyne' AND service_type='service' ORDER BY created_at DESC LIMIT 1");
const [sal] = await runClickhouse("SELECT meeting_id FROM dealer_leads.meetings WHERE team_id='" + TEAM + "' AND source='spyne' AND service_type!='service' ORDER BY created_at DESC LIMIT 1");
console.log(`fixtures: team=${TEAM} · service=${svc.meeting_id} · sales=${sal.meeting_id}\n`);

for (const dept of ["sales", "service"]) {
  const rows = await listEventsCH({ teamId: TEAM, department: dept, emailType: "post_appointment", sinceDays: 30, limit: 500 });
  const other = dept === "sales" ? "Service" : "Sales";
  const leaked = rows.filter((r) => r.sub.startsWith(other));
  t(`${dept} drill-down lists no ${other} appointment`, leaked.length === 0, `rows=${rows.length} leaked=${leaked.length}`);
}

t("service meeting resolves to service", (await meetingDeptCH(TEAM, svc.meeting_id)) === "service");
t("sales meeting resolves to sales", (await meetingDeptCH(TEAM, sal.meeting_id)) === "sales");
t("another team's meeting does not resolve", (await meetingDeptCH("0000000000", svc.meeting_id)) === null);
t("unknown key does not resolve", (await meetingDeptCH(TEAM, "meeting_does_not_exist")) === null);

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
