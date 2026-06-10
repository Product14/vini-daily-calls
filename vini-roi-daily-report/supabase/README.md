# ROI Daily Emailer — Supabase-only runtime

This `supabase/` directory **is** the complete email system. No Sails
notification-service, no MongoDB. Three runtimes only: Supabase, ClickHouse
(read-only metrics), and the Spyne mail API (`mail.spyne.ai`, delivery).

## The pipeline — 4 chained crons

`pg_cron` fires **only `cron1` hourly**; `cron1` orchestrates the rest in order.
`roi_digest_runs` is the per-day hand-off table — each cron advances a row's
`status` and the next cron picks it up.

| # | Function | Step | What it does | Status transition |
|---|----------|------|--------------|-------------------|
| 1 | `cron1-sync-live` | 0 | Re-pull onboarded+active Sales/Service rooftops from ClickHouse into `roi_live_departments` (new → `is_live=false,dry_run=true`; dropped-out → `is_live=false`; existing human flags untouched). Then calls 2→3→4. | — |
| 2 | `cron2-mark-ready` | 1 | For each **live** dept: skip if already `sent`; if before send hour → `scheduled/before_send_hour`; if no subscribed recipients → `not_sent/recipients_missing`; else snapshot recipients → **`scheduled/ready`**. | → `scheduled` (ready) |
| 3 | `cron3-render` | 2 | For each `ready` row: pull yesterday's ClickHouse metrics, run guardrails, store **metrics + ISO reportDate** (`rendered_html` stays null — the prebuild job fills it). | → `queued`, or `not_sent` (no_data / not_actionable) |
| ⟳ | **`email-render/prebuild.cjs`** (Node, separate) | 2.5 | Renders the **ACTUAL `LegacyDailyDigest` component** to inline-styled HTML for each `queued` row and writes `rendered_html`. See `prototype-roi-email/frontend/email-render/`. | (fills `rendered_html`) |
| 4 | `cron4-send` | 3 | For each `queued` row **with `rendered_html`**: honour `dry_run`; if dry → **`suppressed/dry_run`** (nothing sent); else POST stored HTML to `mail.spyne.ai` (`Authorization: Bearer`) → `sent`. Queued rows still missing HTML are left `queued` (`pending_render`). | → `sent` / `suppressed` / `not_sent` (mail_error) |

`functions/mail-webhook` (separate) ingests delivery/open/click/bounce events → `roi_engagement_events`.

> **Why the Node prebuild step?** The real email is a React component styled with Tailwind.
> Producing its HTML faithfully needs React SSR + Tailwind compile + CSS inlining, which
> can't run inside a Deno Edge Function per request. So a Node job (`email-render/`) renders
> it into `rendered_html`, and `cron4` just sends what's stored. `cron3` no longer renders.

> `functions/run-digests` is the **legacy monolith** (eligibility+metrics+render+send in one).
> Superseded by the 4-cron split above; kept for reference only.

## Status lifecycle

```
cron2:  (new)         → scheduled  (reason: ready | before_send_hour)
                      → not_sent   (reason: recipients_missing)
cron3:  scheduled/ready → queued
                        → not_sent (reason: no_data | not_actionable)   [+metrics +html stored for preview]
cron4:  queued        → sent       (dry_run = false, mail API 2xx)
                      → suppressed (reason: dry_run)
                      → not_sent   (reason: mail_error, detail stored)
```

Idempotency: one row per `(team_id, department, cadence='daily', local_date)`.
"Already sent" = a row with `status='sent'`; cron2 skips those.

## The send (cron4 → mail.spyne.ai)

The HTML rendered in cron3 is dropped **verbatim** into `templateData.HTMLdata`
of the `email-control-tower-report` template — the curl just carries our body:

```bash
curl --location 'https://mail.spyne.ai/api/v1/send-template-email' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer <MAIL_TOKEN>' \
  --data-raw '{"to":"a@x.com,b@x.com","subject":"Sales Daily Digest — <Rooftop>",
               "template":"email-control-tower-report",
               "templateData":{"HTMLdata":"<rendered html>"}}'
```
> ✅ Verified 2026-06-08: `Authorization: Bearer <token>` → `200 OK`. The auth is a
> **Bearer token**, not a Cookie.

## Secrets (Edge Function env)
```
# SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-injected — do NOT set them.
CLICKHOUSE_METRICS_ENDPOINT     # ClickHouse Query API Endpoint run-URL (db/clickhouse-endpoints/metrics.sql)
CLICKHOUSE_CANDIDATES_ENDPOINT  # …run-URL for db/clickhouse-endpoints/candidates.sql
CLICKHOUSE_KEY_ID               # API key id  (Basic auth)
CLICKHOUSE_KEY_SECRET           # API key secret
MAIL_TOKEN                      # Bearer token for mail.spyne.ai  ⚠ expires — see below
```
> ClickHouse access is via **Query API Endpoints** (HTTPS + key) — no DB password, no
> proxy. Create the two endpoints from `db/clickhouse-endpoints/*.sql`, make one API key,
> and paste the run-URLs + key here. `_shared/lib.ts` calls them with Basic auth.
⚠ **The token expires.** If cron4 logs `mail_auth` (401/403), refresh `MAIL_TOKEN`
(or paste a fresh token in the tracker's "Send now" field).

## Deploy
```bash
supabase functions deploy cron1-sync-live
supabase functions deploy cron2-mark-ready
supabase functions deploy cron3-render
supabase functions deploy cron4-send
supabase functions deploy mail-webhook --no-verify-jwt
# then schedule (fill PROJECT_REF + key):
#   notification-service/db/migrations/0003_pg_cron_pipeline.sql
```

## Manual dry-run testing (sends nothing)

Run the whole pipeline for **one rooftop**, forced dry, without touching the live set:
```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/cron1-sync-live?team=<TEAM_ID>&dry=true&skipSync=true&bypass=true" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```
- `team=<id>`  → only that rooftop  · `dry=true` → cron4 suppresses (no send)
- `skipSync=true` → don't re-pull ClickHouse  · `bypass=true` → ignore send-hour gate

Or drive each step yourself:
```bash
# Step 1 — mark ready (bypass send-hour for testing)
curl -X POST ".../functions/v1/cron2-mark-ready?team=<TEAM_ID>&bypass=true" -H "Authorization: Bearer <KEY>"
# Step 2 — render metrics + HTML
curl -X POST ".../functions/v1/cron3-render?team=<TEAM_ID>" -H "Authorization: Bearer <KEY>"
# Step 3 — dry send (suppress; preview via tracker)
curl -X POST ".../functions/v1/cron4-send?team=<TEAM_ID>&dry=true" -H "Authorization: Bearer <KEY>"
```
Each returns a JSON summary. The tracker reads `roi_digest_runs` to show the
rendered HTML + recipients for every row, sent or suppressed.

## Manual LIVE send (real email)

The tracker's per-rooftop **"Send now (real email)"** (and the curl below) really
dispatches. It passes `force=true`, which tells cron4 to send **for that one rooftop**
even if its `dry_run` flag is on. Send-decision precedence in cron4:
1. `?dry=true` → always suppress (the tracker's dry-run buttons use this).
2. `?force=true` → real send, ignoring the rooftop's dry_run flag.
3. `dry_run = false` → real send (normal scheduled path).
4. else → suppress.

```bash
# Real send for ONE rooftop (regenerates, then POSTs to mail.spyne.ai):
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/cron1-sync-live?team=<TEAM_ID>&force=true&skipSync=true&bypass=true" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "x-mail-token: <MAIL_TOKEN>"   # optional — overrides the server MAIL_TOKEN
```
(cron4 then calls mail.spyne.ai with `Authorization: Bearer <MAIL_TOKEN>`.)

**Mail token resolution** (for real sends), in order: request header `x-mail-token`,
then env `MAIL_TOKEN` (legacy `MAIL_COOKIE`). It's sent to mail.spyne.ai as
`Authorization: Bearer <token>`, and is read from a **header, never the URL** (it's a
secret). On a `401/403` cron4 marks the row `not_sent / mail_auth` and returns
`auth_failed: true`; the tracker then shows a field to paste a fresh token and retry
(kept in `sessionStorage` for that browser session only).

### Tracker global CTAs
| Button | Pipeline call | Effect |
|--------|---------------|--------|
| **Dry-run all (preview)** | `dry=true` | Regenerates HTML for every rooftop, **suppresses all** — no email. |
| **▶ Send live (N)** | neither `dry` nor `force` | Honours each `dry_run` flag: **real send to the N live rooftops** (`dry_run=false`), dry rooftops suppressed. `N` shown live; disabled-state + guard message when `N=0`; requires a confirm. |
| (per-rooftop) **Send now (real email)** | `force=true&team=<id>` | Force-sends that one rooftop, overriding its flag. |

So the global "Send live" CTA only ever emails rooftops you've explicitly flipped to
live — it can never email a dry-run rooftop.

## Go-live
1. Set secrets → deploy all functions → apply `0003_pg_cron_pipeline.sql`.
2. Dry-run a few rooftops (above) → confirm `queued`/`suppressed` rows + previews in the tracker.
3. Pilot: `update roi_live_departments set is_live=true, dry_run=false where team_id in (...) ;`
4. The hourly `cron1` then sends each live, non-dry rooftop at its dealer-local send hour; everyone else stays held (`dry_run=true` is the default for new rows).

## Safety
Every `(team, department)` defaults to `dry_run = true`. cron4 sends only when a row is
NOT dry — i.e. `dry_run = false` (scheduled path) **or** an explicit `force=true` manual
send. The tracker's dry-run buttons hard-code `dry=true`, which overrides everything and
guarantees suppression. The only ways a real email leaves: (a) you flip a rooftop
`dry_run=false` and the scheduled cron runs, or (b) someone clicks **"Send now (real
email)"** / runs the `force=true` curl and confirms.
