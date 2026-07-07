-- Add 'sending' to roi_digest_runs.status — the transient state the atomic send-claim writes.
--
-- runner.cjs (runOnce + runCadence) reserves a row before mailing with an atomic
--   UPDATE ... SET status='sending', message_id=<lock> WHERE message_id IS NULL
-- so exactly one racer wins the send (idempotency: at-most-once per customer·dept·cadence·day).
-- 0007 widened the check to {queued,error,…} but never included 'sending', so every send-claim
-- 400'd with `roi_digest_runs_status_check` and the WHOLE pass failed (Sent OK: 0). The live DB had
-- been hand-patched to accept 'sending', but a re-run of 0007 reset it — the same prod-vs-migration
-- drift 0007 itself documents. This makes 'sending' canonical so it survives migration re-runs.
--
-- Idempotent: drop + re-add the named check. Must stay AFTER 0007 so it wins on a full re-apply.
alter table roi_digest_runs drop constraint if exists roi_digest_runs_status_check;
alter table roi_digest_runs add constraint roi_digest_runs_status_check
  check (status in ('sent','not_sent','suppressed','scheduled','not_subscribed','queued','error','sending'));
