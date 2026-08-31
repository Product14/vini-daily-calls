// ─── Vini funnel from the ARR ledger (credit_v2) — replaces the Google Sheet ─
// Pulls the lifecycle funnel + per-agent ARR + per-rooftop live/churn rows from
// aggregated_data.aggregated_product_details, scoped to the SAME population as
// the canonical bifurcation query (teams with a Vini product-line CARR event).
// The aggregated table carries team/enterprise names, contracted_arr, live_arr
// and lifecycle dates on each row, so one scan yields everything the sheet did.
//
// Exposes drop-in replacements for the three viniMasterSheet summaries:
//   fetchCreditSources() → { contracted, contractedRows, obSummary, liveChurn }
// matching the exact shapes previewAgentsEmail.js / slackPayload.js consume.
//
// Definitions (user 31-Aug): EXCLUSIVE lifecycle stages (Contracted / Onboarding
// / Live / Churned); CARR (contracted_arr) for signed & onboarding, LARR
// (live_arr) for Live; receptionWebChat excluded. Blocker-reasons + Ageing are
// dropped (no ledger equivalent).

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
)
SELECT
  apd.team_id                              AS teamId,
  apd.team_name                            AS rooftop,
  apd.enterprise_id                        AS enterpriseId,
  apd.enterprise_name                      AS account,
  apd.product_name                         AS product_name,
  ifNull(apd.stage,'')                     AS stage,
  toFloat64(ifNull(apd.contracted_arr,0))  AS carr,
  toFloat64(ifNull(apd.live_arr,0))        AS larr,
  toString(ifNull(apd.live_date, apd.ob_live_date)) AS go_live_date
FROM aggregated_data.aggregated_product_details apd
INNER JOIN vini_teams vt ON apd.team_id = vt.teamId
WHERE apd.product_line_registry_id='${REGISTRY}' AND apd._peerdb_is_deleted=0
  AND apd.product_name IN ('inboundSales','outboundSales','inboundService','outboundService')`;

const distinct = (list, key) => new Set(list.map(r => r[key]).filter(Boolean)).size;
const sum = (list, key) => list.reduce((s, r) => s + (Number(r[key]) || 0), 0);

export async function fetchCreditSources() {
  const raw = await runClickhouse(ROWS_SQL);
  const rows = raw.map(r => ({
    teamId: r.teamId, rooftop: r.rooftop, enterpriseId: r.enterpriseId, account: r.account,
    agentShort: AGENT_LABELS[r.product_name] || r.product_name,
    stage: r.stage, carr: Number(r.carr) || 0, larr: Number(r.larr) || 0,
    goLiveDate: (r.go_live_date && !r.go_live_date.startsWith("1970") && !r.go_live_date.startsWith("0000")) ? r.go_live_date.slice(0, 10) : "",
  }));
  const byStage = (s) => rows.filter(r => r.stage === s);

  // ── Contracted (exclusive stage) ──────────────────────────────────────────
  const cRows = byStage("Contracted");
  const contractedRows = cRows.map(r => ({ agentShort: r.agentShort, arr: r.carr, teamId: r.teamId, rooftop: r.rooftop, account: r.account }));
  const contracted = { count: cRows.length, arr: sum(cRows, "carr"), rooftops: distinct(cRows, "teamId"), accounts: distinct(cRows, "enterpriseId") };

  // ── Onboarding (→ the report's "In OB") ───────────────────────────────────
  const oRows = byStage("Onboarding");
  const obSummary = {
    totalCount: oRows.length, totalArr: sum(oRows, "carr"),
    rooftops: distinct(oRows, "teamId"), accounts: distinct(oRows, "enterpriseId"),
    byAgentType: AGENT_ORDER.map(label => ({ label, arr: sum(oRows.filter(r => r.agentShort === label), "carr") }))
                            .filter(b => b.arr > 0 || oRows.some(r => r.agentShort === b.label)),
    confirmedCount: oRows.length, confirmedArr: sum(oRows, "carr"), upsideCount: 0, upsideArr: 0,
    exitCount: 0, exitArr: 0, exitsByStatus: {}, exitRows: [],   // churn comes from liveChurn, not here
  };

  // ── Live + Churned (per-rooftop rows feed ROI/RAG + the lists) ────────────
  const mkLiveRow = (r, arr) => ({
    teamId: r.teamId, account: r.account, rooftop: r.rooftop, enterpriseId: r.enterpriseId,
    agentRaw: r.agentShort, agentShort: r.agentShort, goLiveDate: r.goLiveDate,
    arr, mrr: arr / 12, stage: r.stage,
  });
  const lRows = byStage("Live").map(r => mkLiveRow(r, r.larr));       // LARR for realized live ARR
  const chRows = byStage("Churned").map(r => mkLiveRow(r, r.carr));   // churned: original contracted value
  const liveChurn = {
    live:  { count: lRows.length,  arr: sum(lRows, "arr"),  rooftops: distinct(lRows, "teamId"),  accounts: distinct(lRows, "enterpriseId"),  rows: lRows },
    churn: { count: chRows.length, arr: sum(chRows, "arr"), rooftops: distinct(chRows, "teamId"), accounts: distinct(chRows, "enterpriseId"), rows: chRows },
  };

  return { contracted, contractedRows, obSummary, liveChurn };
}
