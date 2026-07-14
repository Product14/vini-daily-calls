-- ClickHouse Query API Endpoint: rooftop lifecycle stage for cron1-lifecycle's sync.
-- Every Vini rooftop's ARR/lifecycle bucket — Contract-Initiated → PWS → Onboarding →
-- OB-Live → Live → Churned — from the canonical ARR change-event ledger. No parameters.
-- Set Supabase secret CLICKHOUSE_LIFECYCLE_ENDPOINT = this endpoint's run URL.
-- Columns aliased to match syncLifecycle()'s mapping (server/roi-cron/runner.cjs).
WITH vini_teams AS (
  SELECT DISTINCT ace.teamId
  FROM credit_v2.arrChangeEvents ace
  INNER JOIN (
    SELECT DISTINCT product_line_details_id
    FROM aggregated_data.aggregated_product_line_details
    WHERE product_line_registry_id = '68ff7a65befb847b44b6d1b8'
      AND _peerdb_is_deleted = 0
  ) ids ON ace.entityId = ids.product_line_details_id
  WHERE ace.entityType = 'product-line'
    AND ace.arrType    = 'CARR'
    AND ace.__deleted  = 0
),
product_curr AS (
  SELECT
    ace.teamId,
    ace.enterpriseId,
    ace.entityId                                     AS product_id,
    argMax(toFloat64OrNull(ace.newArr), ace.eventAt) AS curr_arr,
    countIf(ace.eventType = 'churn') > 0             AS is_product_churned
  FROM credit_v2.arrChangeEvents ace
  INNER JOIN vini_teams vt ON ace.teamId = vt.teamId
  WHERE ace.entityType = 'product'
    AND ace.arrType    = 'CARR'
    AND ace.__deleted  = 0
  GROUP BY ace.teamId, ace.enterpriseId, ace.entityId
),
team_product_agg AS (
  SELECT
    teamId,
    any(enterpriseId)                         AS enterpriseId,
    sumIf(curr_arr, is_product_churned = 0)   AS contracted_arr,
    (countIf(is_product_churned = 0) = 0)     AS is_churned
  FROM product_curr
  GROUP BY teamId
)
SELECT
  tpa.teamId                                                          AS t,
  tpa.enterpriseId                                                    AS e,
  COALESCE(apld.enterprise_name, ed.name, tpa.enterpriseId)          AS enterprise_name,
  COALESCE(apld.team_name, etd.team_name, tpa.teamId)                AS team_name,
  apld.ae_poc_email                                                   AS ae_poc,
  apld.ob_poc_email                                                   AS ob_poc,
  CASE
    WHEN tpa.is_churned = 1                                           THEN 'Churned'
    WHEN apld.live_date IS NOT NULL                                   THEN 'Live'
    WHEN apld.ob_live_date IS NOT NULL AND apld.live_date IS NULL     THEN 'OB-Live'
    WHEN apld.onboarding_date IS NOT NULL                             THEN 'Onboarding'
    WHEN apld.contracted_date IS NOT NULL                             THEN 'PWS'
    ELSE 'Contract-Initiated'
  END                                                                 AS arr_bucket,
  apld.contracted_date,
  apld.onboarding_date                                                AS ob_start_date,
  apld.ob_live_date,
  apld.live_date,
  apld.churn_date
FROM team_product_agg tpa
LEFT JOIN aggregated_data.aggregated_product_line_details apld
  ON tpa.teamId = apld.team_id
  AND apld.product_line_registry_id = '68ff7a65befb847b44b6d1b8'
  AND apld.is_test_account = 0
  AND apld._peerdb_is_deleted = 0
LEFT JOIN eventila.enterprise_team_details etd
  ON tpa.teamId = etd.team_id
  AND etd.is_test_account = 0
LEFT JOIN eventila.enterprise_details ed
  ON tpa.enterpriseId = ed.enterprise_id
