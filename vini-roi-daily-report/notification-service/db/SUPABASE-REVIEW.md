# Supabase configuration review

I have no live credentials, so this reviews the config the integration **requires**
and how to **verify** it. Apply `supabase-schema.sql` then `supabase-config.sql`,
then walk the checklist.

## 1 · API keys & where each is used  🔑
| Key | Used by | RLS | Notes |
|-----|---------|-----|-------|
| **service_role** | backend Sails (`utils/supabase.js` → `SUPABASE_SERVICE_KEY`) | bypasses | server-side ONLY — never ship to the browser |
| **anon** | tracker frontend (`VITE_SUPABASE_ANON_KEY`) | enforced | safe in browser only with RLS + auth |

**Finding:** `roi_digest_runs.rendered_html` and `recipients` hold dealer **PII**.
Reading those from the browser with the anon key and no auth would expose them.
Decide one: **(A)** tracker uses Supabase Auth (signed-in CSMs) + the `authenticated`
RLS policies (recommended), or **(B)** tracker reads via the backend API and the
browser never gets a Supabase key.

## 2 · RLS  🔒
- Enable on all 5 tables (`supabase-config.sql` does this).
- `service_role` bypasses → backend unaffected.
- Read policies target `authenticated` (not `anon`).
- Writes (classify / recipients / send-hour) **should go through the backend**;
  direct authenticated-write policies are provided commented-out.

Verify:
```sql
select relname, relrowsecurity from pg_class
where relname like 'roi_%' order by relname;        -- all true
select tablename, policyname, roles, cmd from pg_policies where tablename like 'roi_%';
```

## 3 · Indexes  📈
Shipped in schema: `roi_digest_runs (team_id, local_date, cadence)` and `(message_id)`,
`roi_engagement_events (message_id)`, `(run_id)`, `roi_recipients (team_id)`.
The tracker's main query (runs for the last N days across rooftops) hits the first.
Verify: `select indexname, indexdef from pg_indexes where tablename like 'roi_%';`

## 4 · Idempotency  ♻️
Confirm the unique key exists (this is what kills the dedup race):
```sql
select conname, contype from pg_constraint
where conrelid = 'roi_digest_runs'::regclass and contype = 'u';
-- expect a UNIQUE on (team_id, department, cadence, local_date)
```

## 5 · Realtime  ⚡
`supabase-config.sql` adds `roi_digest_runs` + `roi_engagement_events` to the
`supabase_realtime` publication so the tracker can live-update on new sends.
Verify: `select * from pg_publication_tables where pubname = 'supabase_realtime';`

## 6 · Connection from the backend  🔌
Sails reaches Supabase over HTTPS (supabase-js), not the Postgres socket — no
pooler config needed for the service. If anything else connects via Postgres
directly, use the **pooled** connection string (port 6543), not 5432.

## 7 · Env wiring  🧩
Backend (`config/custom.js` or env):
```
SUPABASE_URL, SUPABASE_SERVICE_KEY
supabaseLiveTable / supabaseConfigTable / supabaseRecipientsTable /
supabaseRunsTable / supabaseEngagementTable   (only if you renamed tables)
mailApi, mailRawApi, useDirectHtml, mailTimeoutMs, mailRetries
```
Frontend (`.env`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

## 8 · Seed data to test end-to-end  🌱
```sql
insert into roi_live_departments(team_id, department, is_live) values
  ('49a06313cf','service',true), ('b4df3297f5','sales',true);
insert into roi_rooftop_config(team_id, enterprise_id, rooftop_name, digest_send_hour) values
  ('49a06313cf','7d06f7427','Covina Kia',7);
insert into roi_recipients(team_id, email, receives_service, email_enabled) values
  ('49a06313cf','mamri@covinakia.com',true,true);
```

## Checklist
- [ ] `supabase-schema.sql` applied (5 tables)
- [ ] `supabase-config.sql` applied (RLS, grants, realtime, triggers)
- [ ] PII decision made: **Auth+RLS** or **backend-proxy reads**
- [ ] service_role key in backend env only; anon key in frontend env only
- [ ] unique constraint on `roi_digest_runs` present
- [ ] realtime publication includes the two tables
- [ ] seed rows inserted and a manual trigger produces a `roi_digest_runs` row
