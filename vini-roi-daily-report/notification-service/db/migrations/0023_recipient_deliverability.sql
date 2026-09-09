-- 0023 · Recipient deliverability — stop mailing addresses that fail.
--
-- Why: bounces are scored against the SENDING DOMAIN, not the rooftop. A few addresses that can
-- never accept mail — a typo'd @gmial.com, someone who left the store, a mailbox that was closed —
-- get hit by the digest cron every day and by every transactional event on top, and that steady
-- drip of bounces is what moves spyne.ai from inbox to spam for EVERY dealer we mail. So a failed
-- address has to stop being mailed automatically, not wait for someone to notice.
--
-- A hold, not a delete. The row stays so the tracker can show WHY that person stopped receiving
-- and a CSM can fix the address; a deleted row is re-seeded by the recipient sync and starts
-- bouncing again with nobody the wiser.
--
--   suppressed_at      set  → never emailed (SMS is unaffected — this is deliverability, not consent)
--   suppression_reason why, shown verbatim in the tracker
--   bounce_count       consecutive failures; soft bounces suppress at SOFT_BOUNCE_LIMIT (default 3)
--   last_bounce_at     when the most recent failure landed
--
-- Enforced in server/roi-cron/emailHealth.cjs, which every send path calls. The code tolerates
-- this migration not having run yet (it falls back to the structural gate), so apply order is
-- not a deploy hazard — but until it runs, nothing can be suppressed.

alter table roi_recipients add column if not exists bounce_count       integer     not null default 0;
alter table roi_recipients add column if not exists last_bounce_at     timestamptz;
alter table roi_recipients add column if not exists suppressed_at      timestamptz;
alter table roi_recipients add column if not exists suppression_reason text;

-- Partial index: the sweep and the tracker's "bad addresses" view only ever read the held rows.
create index if not exists roi_recipients_suppressed_idx
  on roi_recipients (suppressed_at) where suppressed_at is not null;
