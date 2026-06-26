-- Widen roi_digest_runs.status to match what the digest runner actually writes.
-- The runner records two states the original 0001 check omitted:
--   'queued' — data fetched / row claimed, email not sent yet (runner.cjs pipeline)
--   'error'  — a write/record failure was captured for the run
-- Prod's constraint had been widened to accept these, but reporting-vini (built from
-- the canonical migrations) had not, so every daily roi-email write 400'd with a check
-- violation after the single-project cutover. Idempotent: drop + re-add the named check.
alter table roi_digest_runs drop constraint if exists roi_digest_runs_status_check;
alter table roi_digest_runs add constraint roi_digest_runs_status_check
  check (status in ('sent','not_sent','suppressed','scheduled','not_subscribed','queued','error'));
