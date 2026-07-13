-- 0017 · roi_config_audit_log ended up with RLS enabled despite 0016 never running
-- `enable row level security` on it — evidently this Supabase project defaults new tables to
-- RLS-on (confirmed via pg_class.relrowsecurity). With zero policies defined, that silently
-- blocked every insert from any role except one with BYPASSRLS (service_role) — and any
-- deployment where ROI_SUPABASE_SERVICE_KEY is accidentally a publishable/anon key (as the local
-- dev .env currently is) would silently drop every audit-log entry with no thrown error.
-- Disable RLS explicitly so the audit log doesn't depend on that role attribute at all.
alter table roi_config_audit_log disable row level security;
