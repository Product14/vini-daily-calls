// ─── Vini funnel straight from the ARR ledger (credit_v2) ───────────────────
// Replacement candidate for the hand-maintained Google Sheet. Pulls the
// lifecycle funnel (Contracted / Onboarding / Live / Churned) + per-agent-type
// ARR from credit_v2.arrChangeEvents, keyed on the Vini product-line registry.
//
// Two ARR types on the ledger: CARR (contracted) and LARR (live/realized). We
// use CARR for the signed/onboarding stages and LARR for Live (matches the
// realized ARR the report shows today). One ClickHouse scan via GROUPING SETS:
// stage totals + per-(agent, stage) rows.
//
// Verified 2026-08-31: no duplicate product rows (rows == distinct rooftops),
// and the ledger shows MORE live rooftops than the sheet (which undercounts).

import { runClickhouse } from "../../server/agentMetrics.js";

const REGISTRY = "68ff7a65befb847b44b6d1b8";
const AGENT_LABELS = {
  inboundSales:    "Sales IB",
  outboundSales:   "Sales OB",
  inboundService:  "Service IB",
  outboundService: "Service OB",
  // receptionWebChat is a 5th product (tiny, no Live yet) — excluded from the
  // 4-agent tower; still counted in stage totals below.
};
export const AGENT_ORDER = ["Sales IB", "Service IB", "Sales OB", "Service OB"];

const SQL = `
WITH vini_teams AS (
  SELECT DISTINCT ace.teamId FROM credit_v2.arrChangeEvents ace
  INNER JOIN (
    SELECT DISTINCT product_line_details_id FROM aggregated_data.aggregated_product_line_details
    WHERE product_line_registry_id='${REGISTRY}' AND _peerdb_is_deleted=0
  ) ids ON ace.entityId = ids.product_line_details_id
  WHERE ace.entityType='product-line' AND ace.arrType='CARR' AND ace.__deleted=0
),
carr AS (
  SELECT ace.teamId, ace.entityId AS product_id, argMax(toFloat64OrNull(ace.newArr), ace.eventAt) AS v
  FROM credit_v2.arrChangeEvents ace INNER JOIN vini_teams vt ON ace.teamId=vt.teamId
  WHERE ace.entityType='product' AND ace.arrType='CARR' AND ace.__deleted=0
  GROUP BY ace.teamId, ace.entityId
),
larr AS (
  SELECT ace.teamId, ace.entityId AS product_id, argMax(toFloat64OrNull(ace.newArr), ace.eventAt) AS v
  FROM credit_v2.arrChangeEvents ace INNER JOIN vini_teams vt ON ace.teamId=vt.teamId
  WHERE ace.entityType='product' AND ace.arrType='LARR' AND ace.__deleted=0
  GROUP BY ace.teamId, ace.entityId
),
base AS (
  SELECT apd.product_name, apd.stage AS product_stage, apd.team_id AS rooftop_id, apd.enterprise_id,
    coalesce(c.v,0) AS carr, coalesce(l.v,0) AS larr
  FROM aggregated_data.aggregated_product_details apd
  INNER JOIN vini_teams vt ON apd.team_id=vt.teamId
  LEFT JOIN carr c ON apd.product_detail_id=c.product_id
  LEFT JOIN larr l ON apd.product_detail_id=l.product_id
  WHERE apd.product_line_registry_id='${REGISTRY}' AND apd._peerdb_is_deleted=0
)
SELECT
  ifNull(product_name,'')                 AS product_name,
  product_stage,
  GROUPING(product_name)                  AS is_stage_total,
  count(*)                                AS agents,
  uniqExact(rooftop_id)                   AS rooftops,
  uniqExact(enterprise_id)                AS enterprises,
  round(sum(carr))                        AS carr,
  round(sum(larr))                        AS larr
FROM base
GROUP BY GROUPING SETS ( (product_stage), (product_name, product_stage) )`;

// Returns { byStage: {Stage: {agents,rooftops,enterprises,carr,larr}},
//           byAgentStage: {agent: {Stage: {agents,carr,larr}}} }
export async function fetchCreditFunnel() {
  const rows = await runClickhouse(SQL);
  const byStage = {};
  const byAgentStage = {};
  for (const r of rows) {
    const stage = r.product_stage;
    if (!stage || stage === "New") continue;
    if (Number(r.is_stage_total) === 1) {
      byStage[stage] = {
        agents: Number(r.agents), rooftops: Number(r.rooftops), enterprises: Number(r.enterprises),
        carr: Number(r.carr), larr: Number(r.larr),
      };
    } else {
      const agent = AGENT_LABELS[r.product_name];
      if (!agent) continue;
      (byAgentStage[agent] ||= {})[stage] = {
        agents: Number(r.agents), carr: Number(r.carr), larr: Number(r.larr),
      };
    }
  }
  return { byStage, byAgentStage };
}
