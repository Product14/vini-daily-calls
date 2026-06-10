---
phase: 1
name: Populate live rooftops + 5-day tracker backfill
wave_count: 4
autonomous: false   # waves 2–3 need ClickHouse/Supabase MCP + user validation of numbers
depends_on: []
emails: HARD-OFF (dryRun=true) for the entire phase — nothing sends
generated: 2026-06-07
note: >
  GSD project is not initialized (no .planning/ROADMAP.md), so this PLAN.md was
  authored directly in GSD format rather than via the plan-phase orchestrator.
---

# Phase 1 — Populate live rooftops + 5-day tracker backfill

## Goal
Turn the 73 live rooftops (`roi_live_departments.is_live=true`) into a fully
populated tracker: per-rooftop config (send hour + cadence), recipients, and
**5 days of dry-run digest payloads** in `roi_digest_runs` so clicking any cell
in the emailer tracker shows the real data that would have been sent — with
guardrail reasons when it wouldn't.

## Current state (input — already done)
- `roi_live_departments`: 73 rooftops live (`is_live=true`), with `enterprise_id`, `team_name`, `dealer_name`.
- Supabase tables + RLS + anon-read live; tracker reads them.
- Dry-run guard active in `trigger-email-service.js`.
- ClickHouse (`dealer_leads.*`, `eventila.*`) + Supabase reachable via MCP.

## ⚠ Open data-source questions (resolved in Wave 0 research)
| Need | Notification-service source | Reachable via MCP? | Plan resolution |
|------|----------------------------|--------------------|-----------------|
| Dealer **timezone** | user-management API `get-working-days` | ❌ no | Wave 0 research: find a TZ column in ClickHouse (`eventila.*`); else default `America/New_York` + flag for later API backfill |
| Recipient **emails** | Mongo opt-in ∩ user-mgmt `get-team-users` | ❌ no | Wave 0 research: `eventila.enterprise_account.reporting_emails` / `employee_directory.email` as CH sources; else load from the Google Sheet / provided list |
| Metric payloads | ClickHouse `dealer_leads.*` | ✅ yes | direct queries (Wave 2) |

---

## Wave 0 — Locate timezone + email sources (research)

### T0.1 — Find a timezone source in ClickHouse
- **read_first:** `notification-service/utils/guards.js` (`fetchWorkingDays`, `getDealerConfig`)
- **action:** Probe `eventila.enterprise_team_details`, `eventila.enterprise_team_department`, `eventila.team_partner_dealer_details`, `aggregated_data.rooftop_attributes` for a timezone/working-hours column. Run `SELECT name FROM system.columns WHERE database='eventila' AND name ILIKE '%zone%'`.
- **acceptance_criteria:** Either a `{database.table.column}` holding IANA/offset timezone per team is identified, OR documented "no CH timezone source — default America/New_York, backfill via user-mgmt API later".

### T0.2 — Find a recipient-email source in ClickHouse
- **read_first:** `notification-service/utils/guards.js` (`getDigestEmailRecipients`)
- **action:** Inspect `eventila.enterprise_account` (`reporting_emails`, `bcc_email`, `email_id`) and `eventila.employee_directory` (`email`) — determine whether emails can be mapped to `team_id`/`enterprise_id` + department.
- **acceptance_criteria:** A documented mapping (team/enterprise → email[] → department) OR a decision to source recipients from the Google Sheet / a provided CSV.

---

## Wave 1 — Fill config + recipients (depends on Wave 0)

### T1.1 — Fill `roi_rooftop_config` for the 73 live rooftops  (step 2)
- **read_first:** `db/SCHEMA.md`, Wave 0 timezone finding
- **action:** For each `team_id` where `is_live=true`, upsert one config row: `enterprise_id`, `rooftop_name` (= `team_name`), `timezone` (from T0.1 or `America/New_York`), `digest_send_hour=7`, `digest_send_minute=0`, `daily_enabled=true`, `weekly_enabled=false`, `monthly_enabled=false`. Drive the list from `roi_live_departments` so only live rooftops get a row.
- **acceptance_criteria:** `select count(*) from roi_rooftop_config` = distinct live `team_id` count (~73); all rows have `digest_send_hour=7`, `daily_enabled=true`, `weekly_enabled=false`, `monthly_enabled=false`; every row has a non-null `timezone`.

### T1.2 — Fill `roi_recipients` for live rooftops  (step 3)
- **read_first:** Wave 0 email finding, `notification-service/queries/rooftop-config.query.js`
- **action:** For each live rooftop, insert recipient rows from the chosen email source. Set `receives_sales`/`receives_service` per the department(s) live for that team in `roi_live_departments`; set `email_enabled=true` unless the source marks otherwise. Lowercase + dedupe emails per `(team_id,email)`.
- **acceptance_criteria:** Every live rooftop with a resolvable email has ≥1 `roi_recipients` row; `receives_sales`/`receives_service` align with that team's live departments; teams with no email source are listed (so the tracker shows `recipients_missing`, not silent).

---

## Wave 2 — Queries doc + payload generation (depends on Wave 1)

### T2.1 — Produce `QUERIES.md` (step 4.1)
- **read_first:** `SQL_VALIDATION.md`, all `notification-service/queries/*.js`
- **action:** Write a single doc listing every ClickHouse metric query (sales + service + campaign + speed-to-lead) as copy-paste SQL against `dealer_leads.*`, parameterized by `team_id` + yesterday/MTD window, grouped by KPI. (Seed from existing `SQL_VALIDATION.md`.)
- **acceptance_criteria:** `QUERIES.md` exists; contains ≥11 sales + service queries + campaign + speed-to-lead; each is runnable as-is after substituting team_id + dates. **User runs & validates the numbers (step 4.2) — checkpoint.**

### T2.2 — Compute one-day payload + guardrail per rooftop (step 4.3)
- **read_first:** `notification-service/services/template-service.js`, `utils/guardrails.js`, `services/digest-store.service.js`
- **action:** For each live rooftop + live department, run the Wave-2 queries for "yesterday" (dealer-local), assemble the templateData payload, run `validateDigestPayload`, and record a `roi_digest_runs` row: `status='suppressed', reason='dry_run'` when it passes, or `status='not_sent', reason=<guardrail code>` when it fails — storing `metrics` (the computed numbers) and `rendered_html` either way.
- **acceptance_criteria:** Each live (team,dept) has exactly one `roi_digest_runs` row for the target date; passing rows carry full `metrics` + `rendered_html`; failing rows carry the guardrail `reason` + the numbers that triggered it.

---

## Wave 3 — 5-day backfill (depends on Wave 2)  (step 5)

### T3.1 — Populate last 5 days for all live rooftops
- **read_first:** T2.2 output, `services/digest-store.service.js` (upsert key)
- **action:** Repeat T2.2's compute+guardrail+store for the 5 most recent dealer-local days, per live (team,dept,daily). Idempotent upsert on `(team_id,department,cadence,local_date)`. All `dry_run` — no sends.
- **acceptance_criteria:** `roi_digest_runs` holds ~5 rows × live (team,dept); `select count(distinct local_date)` ≥ 5; tracker grid shows status cells for all 73 rooftops across the last 5 columns; clicking a cell opens the drawer with that day's stored metrics + HTML.

---

## must_haves (goal-backward verification)
1. `roi_rooftop_config` has a 7AM/daily row for every live rooftop.
2. `roi_recipients` populated for every live rooftop with a resolvable email; gaps listed.
3. `QUERIES.md` exists and the user has validated the numbers.
4. `roi_digest_runs` has 5 days of dry-run payloads (metrics + HTML + guardrail reasons) for all 73 live rooftops.
5. The emailer tracker, pointed at live Supabase, renders all 73 rooftops with 5 days of clickable cells.
6. Zero emails sent (dryRun=true throughout; verify no `status='sent'` rows created this phase).

## Artifacts this phase produces
- Rows in `roi_rooftop_config`, `roi_recipients`, `roi_digest_runs` (Supabase)
- `pods/vini-roi-daily-report/QUERIES.md`
- (possibly) a `timezone` / recipient-email source mapping note in this folder

## Verification
- `select count(*) from roi_rooftop_config where daily_enabled` = live rooftop count
- `select count(distinct local_date) from roi_digest_runs` ≥ 5
- `select count(*) from roi_digest_runs where status='sent'` = 0  (proves nothing sent)
- Tracker screenshot: 73 rooftops × 5 day-columns populated
