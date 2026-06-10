# Notification-Service — changes on top of the zip

Forward-deployed notes. Each change is scoped so it can be cherry-picked into the
real Sails monorepo.

## 1 · Supabase confirmed-live eligibility gate  ✅ done

**Files:** `queries/live-team.query.js` (new), `queries/digest-eligibility.query.js`

Digest targeting is now three gates ANDed **per department**:

| # | Source | Gate |
|---|--------|------|
| 1 | Mongo `conversationNotifications` | `dailyDigest === true` && `config.dealerEmail === false` |
| 2 | ClickHouse `teamAgentMappings` ⋈ `agentTypes` | onboarded **and active** Sales/Service agent |
| 3 | **Supabase `roi_live_departments`** | dept confirmed *actually* live |

Gate 2 now also filters `isActive` (was `isOnboarded` only). Gate 3 is new:
ClickHouse proposes candidates, Supabase confirms which are truly live.

### Config required

```js
// config/custom.js  (or env)
supabaseUrl:        process.env.SUPABASE_URL,
supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
supabaseLiveTable:  'roi_live_departments',   // optional, this is the default
```

Dependency: `npm i @supabase/supabase-js` (required lazily so boot doesn't break if absent).

### ⚠️ Assumed Supabase schema — please confirm

```
table:  roi_live_departments
  team_id     text      -- matches ClickHouse teamId
  department  text      -- 'sales' | 'service'
  is_live     boolean
```

One row per (team_id, department). If your table is instead one-row-per-team with
`sales_live` / `service_live` columns, only `parseLiveRows()` in
`queries/live-team.query.js` needs changing — the rest is shape-agnostic.

### Failure behaviour

Supabase unreachable → **fail closed** (no digests that run) by default, so an
outage never blasts teams that may not be live. Pass `{ liveFilterFailOpen: true }`
to fall back to ClickHouse candidates (gates 1+2).

---

## 2 · Supabase as central store + tracker seam  ✅ done

**Schema:** `db/supabase-schema.sql` — five tables:
`roi_live_departments` (gate 3), `roi_rooftop_config` (req 2),
`roi_recipients` (req 3), `roi_digest_runs` (req 1 & 5, full payload + HTML),
`roi_engagement_events` (req 7). `roi_digest_runs` has a unique key on
`(team_id, department, cadence, local_date)` → upsert idempotency (kills the
old dedup race). Shared client in `utils/supabase.js`.

## 3 · Persist every run, sent or not (req 1 & 5)  ✅ done

`services/digest-store.service.js` — `recordDigestRun()` upserts a row on every
decision path of the trigger (sent / suppressed / each not_sent reason) with the
full computed `metrics` jsonb + `rendered_html` + normalized `reason`.
`syncFromDailyDigestLogs()` backfills history from Mongo. Reason codes are
centralized and mapped to the tracker's `NotSentReason` enum.

## 4 · Configurable per-rooftop send hour (req 2)  ✅ done

`queries/rooftop-config.query.js` → `getRooftopConfig(teamId)`. The hardcoded
`7*60` is now a fallback only; the gate reads `digest_send_hour/minute` from
`roi_rooftop_config`. UI writes that row.

## 5 · Per-recipient department subscription (req 3)  ✅ done

Same module → `getRecipientDeptSubscriptions()` + `filterEmailsByDept()`.
After resolving recipients, the trigger filters to those subscribed to the
current department. Distinguishes `recipients_missing` from `not_subscribed`.
Fail-open (missing routing row keeps a recipient) — flip `strict:true` to require
an explicit subscription.

## 6 · Payload guardrails post step 1 & 2 (req 4)  ✅ done

`utils/guardrails.js` → `validateDigestPayload()`. Blocks junk before send:
`no_data`, `not_actionable`, `invalid_metrics`, `inconsistent_mtd` (MTD <
yesterday), `missing_fields`. Blocked runs are still recorded (with metrics) so a
human can review. Unit-tested against good/all-zero/bad-MTD/passive/missing cases.

## 7 · Direct-HTML send feasibility (req 6)  ✅ done (assumption flagged)

`services/html-render.service.js` renders a self-contained HTML email from
templateData (no mail-service template registration needed). `services/mail-send.service.js`
adds timeout + retry and two paths: `template` (existing) and `raw_html` (new),
toggled by `sails.config.custom.useDirectHtml`. The same renderer feeds the
`rendered_html` stored on every run.
⚠️ **Confirm the raw-HTML endpoint contract** of mail.spyne.ai — assumed
`POST {mailApi}/api/v1/send-email` with `{to, subject, html}`. Override via
`mailRawApi`.

## 8 · Communication engagement tracking (req 7)  ✅ done (provider TBD)

`services/engagement.service.js` + `api/controllers/v2/notification/engagement-webhook.js`
ingest delivered/open/click/bounce, join to runs via `message_id`, and flip
per-recipient `received`/`bounced` on the run. ⚠️ **Provider TBD** — `normalizeEvent()`
field mapping + webhook signature verification need the chosen ESP (SES/SendGrid/Mailgun).

## Trigger refactor

`services/trigger-email-service.js` collapsed the two near-identical 200-line
sales/service functions into one `runDigest(adapter, …)` core + two adapters
(stateless query refs). Single insertion point for every behaviour above.
Removed the hardcoded `mailApiBase` + dead guard.

---

## Still open / not yet done

- **Confirm Supabase schemas** — `roi_live_departments` shape (above) and the four
  new tables. Run `db/supabase-schema.sql` (or reconcile with existing tables).
- **Weekly + monthly cadence** — daily is wired; `cron/weeklyDigest.cron.js` still
  calls the non-existent `triggerWeeklyDigestEmail`, and `getTimeWindows()` has no
  weekly/monthly windows. Tracker shows all three.
- **Wire tracker frontend** — replace `mockData.ts` with reads from `roi_digest_runs`
  + write endpoints for classify / add-recipient / retry.
- **Manual trigger/retry endpoint** — the tracker's "Send now / Retry" buttons need
  a controller calling `runDigest(..., {bypassDigestSchedule:true, to})`.
- **Provider wiring** — raw-HTML endpoint contract (req 6) + ESP webhook format (req 7).
- Metric nits still open: sales vs service `outboundConnectRate` denominators differ;
  `nextReport` hardcodes "PT".
