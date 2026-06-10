-- ROI Daily Digest · ACTION ITEMS card (Metabase). Params: {{team_id}} {{start}} {{end}} {{dept}}.
-- Faithful to getActionItems(). One row per intent → powers "Action required" + "Top service intents".
SELECT intent, count() AS cnt
FROM dealer_leads.actionItems
WHERE team_id={{team_id}} AND service_type={{dept}} AND is_active=1 AND __deleted=0
  AND createdAt BETWEEN {{start}} AND {{end}}
GROUP BY intent
ORDER BY cnt DESC
