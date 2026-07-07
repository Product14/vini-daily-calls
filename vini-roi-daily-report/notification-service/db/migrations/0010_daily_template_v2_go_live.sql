-- 0010 · DAILY-digest go-live: make the redesigned template (v2) the default for ALL.
--
-- Product decision (Jul 2026): the redesigned "Conversational AI 2.0" daily digest
-- replaces the classic email for every rooftop. Two moving parts, kept in lockstep
-- with the code (runner.cjs pickTemplate now defaults to 'v2'):
--   1) flip the column DEFAULT so any NEW rooftop is created on v2, and
--   2) backfill every existing rooftop from 'v1' → 'v2'.
--
-- 'v1' (Classic) is retained purely as a per-rooftop OPT-OUT — a human can flip a
-- single rooftop back to Classic in the Email Tracker; nothing else defaults to it.
-- The recipient safety lock (V2_TO_CUSTOMERS) was already lifted, so v2 now reaches
-- real dealers. Weekly/monthly were always v2 and are unaffected.
--
-- Idempotent + reversible: re-running is a no-op; revert by setting default back to
-- 'v1' and UPDATE ... SET daily_template='v1'.

-- 1) new rooftops default to the redesign
alter table roi_rooftop_config
  alter column daily_template set default 'v2';

-- 2) move every existing rooftop still on Classic onto the redesign
update roi_rooftop_config
  set daily_template = 'v2'
  where daily_template <> 'v2';
