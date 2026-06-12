-- Add a free-text CRM name to programs_account_state. Editable from the
-- dashboard's account drawer — single source of truth for "which CRM is this
-- rooftop on" (VinSolutions / DealerSocket / Tekion / Reynolds / etc.).
-- Run in Supabase SQL editor.

alter table programs_account_state
  add column if not exists crm_name text not null default '';
