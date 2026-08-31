// ─── Vini funnel from the ARR ledger (credit_v2) — replaces the Google Sheet ─
// Reproduces the canonical Vini bifurcation query EXACTLY (same population +
// same ARR): teams with a Vini product-line CARR event → per-product current
// CARR via argMax on arrChangeEvents → grouped by stage. Enriched with team /
// enterprise NAMES and the live/ob go-live date from aggregated_product_details
// (joined on product_detail_id), which the query's own base already LEFT JOINs.
//
// IMPORTANT: ARR = product_curr.curr_arr (the argMax CARR from arrChangeEvents),
// NOT aggregated_product_details.contracted_arr. The two diverge at churn — the
// event stream writes CARR down at churn ($303K) while the aggregated column
// keeps the original contracted value ($2.21M). We use the event value to match
// the canonical query.
//
// Exposes drop-in replacements for the three viniMasterSheet summaries:
//   fetchCreditSources() → { contracted, contractedRows, obSummary, liveChurn }
//
// Definitions (user 31-Aug): EXCLUSIVE lifecycle stages (Contracted / Onboarding
// / Live / Churned, 'New' dropped); CARR throughout (matches the query);
// receptionWebChat excluded. Blocker-reasons + Ageing retired (no ledger data).

import { runClickhouse } from "../../server/agentMetrics.js";

const REGISTRY = "68ff7a65befb847b44b6d1b8";
const AGENT_LABELS = {
  inboundSales: "Sales IB", outboundSales: "Sales OB",
  inboundService: "Service IB", outboundService: "Service OB",
};
export const AGENT_ORDER = ["Sales IB", "Service IB", "Sales OB", "Service OB"];

const ROWS_SQL = `
WITH vini_teams AS (
  SELECT DISTINCT ace.teamId FROM credit_v2.arrChangeEvents ace
  INNER JOIN (
    SELECT DISTINCT product_line_details_id FROM aggregated_data.aggregated_product_line_details
    WHERE product_line_registry_id='${REGISTRY}' AND _peerdb_is_deleted=0
  ) ids ON ace.entityId = ids.product_line_details_id
  WHERE ace.entityType='product-line' AND ace.arrType='CARR' AND ace.__deleted=0
),
product_curr AS (
  SELECT ace.teamId, ace.enterpriseId, ace.entityId AS product_id,
    argMax(toFloat64OrNull(ace.newArr), ace.eventAt) AS curr_arr
  FROM credit_v2.arrChangeEvents ace INNER JOIN vini_teams vt ON ace.teamId=vt.teamId
  WHERE ace.entityType='product' AND ace.arrType='CARR' AND ace.__deleted=0
  GROUP BY ace.teamId, ace.enterpriseId, ace.entityId
),
tpa AS ( SELECT teamId, any(enterpriseId) AS enterpriseId FROM product_curr GROUP BY teamId )
SELECT
  tpa.teamId                               AS teamId,
  tpa.enterpriseId                         AS enterpriseId,
  apd.team_name                            AS rooftop,
  apd.enterprise_name                      AS account,
  apd.product_name                         AS product_name,
  ifNull(apd.stage,'')                     AS stage,
  ifNull(pc.curr_arr, 0)                   AS arr,
  toString(ifNull(apd.live_date, apd.ob_live_date)) AS go_live_date
FROM tpa
LEFT JOIN aggregated_data.aggregated_product_details apd
  ON tpa.teamId = apd.team_id AND apd.product_line_registry_id='${REGISTRY}' AND apd._peerdb_is_deleted=0
LEFT JOIN product_curr pc ON apd.product_detail_id = pc.product_id
-- Drop test/demo accounts (the ledger includes them; the sheet was hand-curated
-- so it didn't). Mirrors the spine's enterprise filter (agentBaseFact.sql) so the
-- funnel and the operating metrics share one universe. Without this, ~95 test
-- products inflate OB by ~$7M (gibberish teams carrying fake $1.2M CARR).
INNER JOIN eventila.enterprise_details ed FINAL ON apd.enterprise_id = ed.enterprise_id
WHERE apd.product_name IN ('inboundSales','outboundSales','inboundService','outboundService')
  AND ed.is_test_account = 0
  AND (ed.reseller_id IS NULL OR ed.reseller_id = '')
  AND lower(ifNull(ed.name,'')) NOT LIKE '%testing%'
  AND lower(ifNull(ed.name,'')) NOT LIKE '%test %'
  AND lower(ifNull(ed.name,'')) NOT LIKE '% test%'
  AND lower(ifNull(ed.name,'')) NOT LIKE '%demo%'
  AND lower(ifNull(ed.name,'')) NOT LIKE '%sandbox%'
  AND lower(ifNull(ed.name,'')) NOT LIKE '%spyne motors%'`;

const distinct = (list, key) => new Set(list.map(r => r[key]).filter(Boolean)).size;
const sum = (list, key) => list.reduce((s, r) => s + (Number(r[key]) || 0), 0);

export async function fetchCreditSources() {
  const raw = await runClickhouse(ROWS_SQL);
  const rows = raw.map(r => ({
    teamId: r.teamId, rooftop: r.rooftop, enterpriseId: r.enterpriseId, account: r.account,
    agentShort: AGENT_LABELS[r.product_name] || r.product_name,
    stage: r.stage, arr: Number(r.arr) || 0,
    goLiveDate: (r.go_live_date && !r.go_live_date.startsWith("1970") && !r.go_live_date.startsWith("0000")) ? r.go_live_date.slice(0, 10) : "",
  }));
  const byStage = (s) => rows.filter(r => r.stage === s);

  // ── Contracted (exclusive stage) ──────────────────────────────────────────
  const cRows = byStage("Contracted");
  const contractedRows = cRows.map(r => ({ agentShort: r.agentShort, arr: r.arr, teamId: r.teamId, rooftop: r.rooftop, account: r.account }));
  const contracted = { count: cRows.length, arr: sum(cRows, "arr"), rooftops: distinct(cRows, "teamId"), accounts: distinct(cRows, "enterpriseId") };

  // ── Onboarding (→ the report's "In OB") ───────────────────────────────────
  const oRows = byStage("Onboarding");
  const obSummary = {
    totalCount: oRows.length, totalArr: sum(oRows, "arr"),
    rooftops: distinct(oRows, "teamId"), accounts: distinct(oRows, "enterpriseId"),
    byAgentType: AGENT_ORDER.map(label => ({ label, arr: sum(oRows.filter(r => r.agentShort === label), "arr") })),
    confirmedCount: oRows.length, confirmedArr: sum(oRows, "arr"), upsideCount: 0, upsideArr: 0,
    exitCount: 0, exitArr: 0, exitsByStatus: {}, exitRows: [],   // churn comes from liveChurn, not here
  };

  // ── Live + Churned (per-rooftop rows feed ROI/RAG + the lists) ────────────
  const mkRow = (r) => ({
    teamId: r.teamId, account: r.account, rooftop: r.rooftop, enterpriseId: r.enterpriseId,
    agentRaw: r.agentShort, agentShort: r.agentShort, goLiveDate: r.goLiveDate,
    arr: r.arr, mrr: r.arr / 12, stage: r.stage,
  });
  const lRows = byStage("Live").map(mkRow);
  const chRows = byStage("Churned").map(mkRow);
  const liveChurn = {
    live:  { count: lRows.length,  arr: sum(lRows, "arr"),  rooftops: distinct(lRows, "teamId"),  accounts: distinct(lRows, "enterpriseId"),  rows: lRows },
    churn: { count: chRows.length, arr: sum(chRows, "arr"), rooftops: distinct(chRows, "teamId"), accounts: distinct(chRows, "enterpriseId"), rows: chRows },
  };

  return { contracted, contractedRows, obSummary, liveChurn };
}
