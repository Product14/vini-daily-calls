-- 0021 · Per-rooftop working hours cache — the real per-weekday open/close times, mirroring
-- how `timezone` is already resolved-live-then-persisted (server/roi-cron/resolveTz.cjs).
--
-- Drives the overdue action-item report's two daily send slots (server/roi-cron/eventRunner.cjs):
-- before the dealer's business day starts, and at end of day — tied to the dealer's ACTUAL hours
-- (e.g. Jones Chrysler Dodge Jeep Ram: Mon-Sat 08:00-18:00, Sun 09:00-17:30), not a guessed global
-- default. Falls back to EVENT_OVERDUE_MORNING_FALLBACK_HOUR / EVENT_OVERDUE_EOD_FALLBACK_HOUR
-- when this is null (rooftop not yet resolved, or the live working-days API has nothing).
--
-- Shape (from GET api/user-management/v1/team/get-working-days, same endpoint timezone already
-- uses): {"monday":{"is_working":true,"start_time":"08:00","end_time":"18:00"}, ...} — the full
-- week, so a rooftop with day-specific hours (like Jones' shorter Sunday) resolves correctly
-- every day, not just on the day it happened to be first resolved.
alter table roi_rooftop_config
  add column if not exists working_hours jsonb;
