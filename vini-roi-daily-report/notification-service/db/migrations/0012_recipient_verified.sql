-- Recipient verification gate — a rooftop may only ever email a recipient a human has
-- explicitly confirmed belongs to THAT rooftop.
--
-- Why: every cross-rooftop leak we've hit (e.g. Laguna Niguel's BDC receiving Foothill Ranch
-- summaries) was a wrong email typed into a rooftop's recipient list. The send paths are already
-- strictly team-scoped, and ownership can't be inferred from the address (group GMs legitimately
-- cover many rooftops; a wrong address can sit on a single wrong team). So the only real guarantee
-- is a human-verified recipient↔rooftop mapping.
--
-- verified_at NULL  = unverified → HELD (never sent to) by runner.cjs + eventRunner.cjs.
-- verified_at set   = a human confirmed this recipient for this rooftop.
--
-- Backfill grandfathers everything currently in use so no active send breaks; disabled rows stay
-- unverified so re-enabling one forces a fresh verification. New recipients default NULL → held.
alter table roi_recipients add column if not exists verified_at timestamptz;

-- ONE-TIME grandfather. Guarded so a migration RE-RUN never re-verifies pending recipients (which
-- would silently defeat the gate — migrations here have re-run before, see 0011). Only backfills when
-- nothing has been verified yet, i.e. the genuine first apply.
do $$
begin
  if not exists (select 1 from roi_recipients where verified_at is not null) then
    update roi_recipients set verified_at = now() where email_enabled = true or sms_enabled = true;
  end if;
end $$;
