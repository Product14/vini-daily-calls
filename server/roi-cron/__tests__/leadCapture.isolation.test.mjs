// CROSS-ROOFTOP ISOLATION (blocking check): a lead-capture enrichment must never return a row that
// belongs to a different dealer. Runs the enrichment with MISMATCHED (team, call) / (team, lead)
// pairs and asserts nothing comes back — the email then falls back to the standard format rather
// than rendering another dealer's customer.
import "dotenv/config";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const LC = require("../leadCaptureCH.cjs");

const A = process.env.LEAD_CAPTURE_TEST_TEAM || "27ec3720db"; // any rooftop with real calls
let pass = 0, fail = 0;
const t = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };

// a real call + lead from SOME OTHER team, picked straight from ClickHouse
const [other] = await LC._chQuery(
  "SELECT teamId, callId, leadId FROM dealer_leads.endcallreports" +
  " WHERE teamId != '" + A + "' AND isTestCall=0 AND __deleted=0 AND notEmpty(report_overview)" +
  " AND notEmpty(leadId) AND createdAt >= now() - INTERVAL 14 DAY ORDER BY createdAt DESC LIMIT 1");
const [mine] = await LC._chQuery(
  "SELECT teamId, callId, leadId FROM dealer_leads.endcallreports" +
  " WHERE teamId = '" + A + "' AND __deleted=0 AND notEmpty(report_overview) AND notEmpty(leadId)" +
  " ORDER BY createdAt DESC LIMIT 1");
console.log(`fixtures: mine team=${mine.teamId} · other team=${other.teamId}\n`);

// 1) another dealer's callId, asked for under OUR team → must be empty
const xCall = await LC.fetchLeadFields(A, [other.callId]);
t("other dealer's callId under our team → no data", xCall.size === 0, `size=${xCall.size}`);
// 2) another dealer's leadId, asked for under OUR team → must be empty
const xLead = await LC.fetchLeadFieldsByLead(A, [other.leadId]);
t("other dealer's leadId under our team → no data", xLead.size === 0, `size=${xLead.size}`);
// 3) OUR callId asked for under THEIR team → must be empty (symmetry)
const rev = await LC.fetchLeadFields(other.teamId, [mine.callId]);
t("our callId under another dealer's team → no data", rev.size === 0, `size=${rev.size}`);
// NB: the Map is deliberately keyed under BOTH the vendor callId and the Mongo id (see test 8), so
// count DISTINCT leads, not keys.
const leads = (m) => new Set([...m.values()]).size;
// 4) mixed batch: only our own call survives
const mixed = await LC.fetchLeadFields(A, [mine.callId, other.callId]);
t("mixed batch returns only our own call", leads(mixed) === 1 && mixed.has(mine.callId), `leads=${leads(mixed)}`);
// 5) the happy path still returns our own data (guards against a filter that just breaks everything)
t("our own callId still resolves", leads(await LC.fetchLeadFields(A, [mine.callId])) === 1);
// 6) SQL-injection-ish input is escaped, not executed
const evil = await LC.fetchLeadFields(A, ["' OR 1=1 --"]);
t("injection payload returns nothing (escaped)", evil.size === 0, `size=${evil.size}`);
// 7) identity resolution can't cross dealers: lead_id/customer_id are globally unique
const [{ dup_leads }] = await LC._chQuery(
  "SELECT count() dup_leads FROM (SELECT lead_id FROM dealer_leads.leads WHERE created_at >= now() - INTERVAL 180 DAY GROUP BY lead_id HAVING uniqExact(team_id) > 1)");
t("no lead_id spans two teams (identity join is safe)", Number(dup_leads) === 0, `dup=${dup_leads}`);

// 8) the feed's cv.id may be the vendor callId OR the Mongo _id — both must resolve, or the feature
//    silently degrades to the generic email in prod with no error anywhere.
const [ids] = await LC._chQuery(
  "SELECT callId, id FROM dealer_leads.endcallreports WHERE teamId = '" + A + "' AND __deleted=0" +
  " AND notEmpty(report_overview) ORDER BY createdAt DESC LIMIT 1");
const byUuid = await LC.fetchLeadFields(A, [ids.callId]);
const byMongo = await LC.fetchLeadFields(A, [ids.id]);
t("resolves by vendor callId (uuid)", byUuid.has(ids.callId), `key=${ids.callId.slice(0, 8)}…`);
t("resolves by Mongo _id (24-hex)", byMongo.has(ids.id), `key=${ids.id}`);
t("map is keyed under both ids", byUuid.has(ids.id) && byMongo.has(ids.callId));
// 9) another dealer's MONGO id under our team is still refused
const xMongo = await LC.fetchLeadFields(A, [other.callId, "6a70f57bd5687b580aecd7af".replace("6a70", "0000")]);
t("bogus/foreign mongo id returns nothing extra", xMongo.size === 0, `size=${xMongo.size}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
