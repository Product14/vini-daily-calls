-- 0015 · Per-rooftop WEEKLY/MONTHLY digest send-day (today hardcoded to Monday / the 1st for
-- every rooftop — server/roi-cron/runner.cjs cadenceWindow()). Not all customers want their
-- weekly/monthly summary landing on the same day, so this becomes a per-rooftop choice.
--
-- weekly_send_dow: 0=Sun..6=Sat (JS Date.getUTCDay() convention — matches the numeric
-- day-of-week runner.cjs now computes from the dealer-local calendar date). Default 1 (Monday)
-- preserves today's behavior for every existing rooftop.
--
-- monthly_send_day: 1..28 — capped at 28 (not 31) so every month actually has that day,
-- sidestepping short-month edge cases. Default 1 preserves today's behavior.
alter table roi_rooftop_config
  add column if not exists weekly_send_dow smallint not null default 1 check (weekly_send_dow between 0 and 6),
  add column if not exists monthly_send_day smallint not null default 1 check (monthly_send_day between 1 and 28);
