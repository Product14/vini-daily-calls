-- Add an `opened` count to the roi_event_email_counts rollup so the tracker can show a
-- per-transactional-type open rate (opened ÷ sent) in the KPI strip. `opened` counts SENT
-- emails whose tracking pixel fired at least once (opened_at IS NOT NULL) — a strict subset
-- of `sent`, so open rate is always ≤ 100%.
--
-- The view was originally created ad-hoc in the live DB (never in a migration); this file
-- makes it canonical. `create or replace view` only permits APPENDING columns, so `opened`
-- goes last, after `last_at` — do not reorder the existing columns.
create or replace view roi_event_email_counts as
 SELECT team_id,
    department,
    email_type,
    count(*)::integer AS total,
    count(*) FILTER (WHERE status = 'sent'::text)::integer AS sent,
    count(*) FILTER (WHERE status = ANY (ARRAY['suppressed'::text, 'not_sent'::text, 'error'::text]))::integer AS not_sent,
    max(created_at) AS last_at,
    count(*) FILTER (WHERE status = 'sent'::text AND opened_at IS NOT NULL)::integer AS opened
   FROM roi_event_emails
  GROUP BY team_id, department, email_type;
