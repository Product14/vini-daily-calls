-- ClickHouse Query API Endpoint: live candidate rooftops for cron1's sync.
-- Onboarded + active Sales/Service (team, dept) pairs. No parameters.
-- Set Supabase secret CLICKHOUSE_CANDIDATES_ENDPOINT = this endpoint's run URL.
-- Columns aliased e/t/d to match cron1's mapping.
SELECT DISTINCT
  tam.enterpriseId        AS e,
  tam.teamId              AS t,
  lower(at.agentType)     AS d
FROM dealer_leads.teamAgentMappings tam
INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId = tam.agentTypeId
WHERE tam.isOnboarded = 1
  AND ifNull(tam.isActive,1) = 1
  AND ifNull(tam.__deleted,0) = 0
  AND ifNull(at.__deleted,0) = 0
  AND at.agentType IN ('Sales','Service')
