-- Open-rate tracking for the daily digest.
-- Adds roi_digest_runs.opened_at, stamped on first load of the email's tracking
-- pixel (GET /api/email/track-open). Per-recipient open state lives in the
-- recipients jsonb as {opened, opened_at} (no DDL needed for that).
-- Safe to run multiple times.
alter table roi_digest_runs
  add column if not exists opened_at timestamptz;

comment on column roi_digest_runs.opened_at is
  'First time the digest email was opened (tracking pixel). NULL = not opened / not tracked.';
