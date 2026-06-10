# Every JS file explained for a Product Manager

One paragraph per file. What problem it solves, what it touches, what breaks if it's wrong.

---

## THE CRONS (the alarm clocks)

### `cron/dailyDigest.cron.js`
**Runs every hour.** Asks "who should get a report today?" and fires emails.
Think of it as the morning newspaper delivery driver — it picks up the eligible
addresses, then hands each one to the email-building team. If a dealer fails,
only that dealer misses out; everyone else still gets their paper.
**Breaks if:** the eligibility database is unreachable (aborts whole run) or
the scheduler isn't wired up in `config/cron.js`.

### `cron/weeklyDigest.cron.js`
Same idea but for weekly summaries. ⚠️ **Currently broken** — it calls a function
(`triggerWeeklyDigestEmail`) that hasn't been built yet. Fix is Phase 3 of the project plan.

---

## THE GATEKEEPER (who gets a report?)

### `queries/digest-eligibility.query.js`
The **bouncer with three ID checks**. A dealership only gets through if ALL THREE say yes:
1. MongoDB says "digest is turned on for this team"
2. ClickHouse says "they have a real, active Sales or Service AI agent"
3. **Supabase** says "this department is actually live and taking calls"
If Supabase is unreachable, it fails closed (no emails go out) unless you set the
`liveFilterFailOpen` override. Returns a clean list: `{ teamId, sendSales, sendService }`.
**Breaks if:** any one database is down. The fail-closed design is intentional —
better to miss a send than email a dealership that isn't live.

### `queries/live-team.query.js`
Reads the **CSM-curated "actually live" table in Supabase** (`roi_live_departments`).
The CSM team maintains this — marking which departments are genuinely taking traffic,
separate from what ClickHouse thinks is "onboarded." This is the human override layer.

---

## TIMING & RECIPIENTS (when + who)

### `queries/rooftop-config.query.js`
Reads **per-dealership settings from Supabase** (`roi_rooftop_config`). Most
importantly: what time should the email go out in the dealer's local timezone?
Default is 7 AM. A CSM can change it to 8 AM or 9 AM for a specific dealer
through the tracker UI. Also controls which cadences (daily/weekly/monthly)
are enabled per dealer.

Also handles **department routing for recipients** — which email addresses get
the Sales report vs the Service report (from `roi_recipients`).

### `utils/guards.js`
The **timezone wizard + address book**. Figures out:
- What is "yesterday" in this dealer's local time? (NY dealers get 12AM–11:59PM ET,
  CA dealers get 12AM–11:59PM PT — different UTC windows)
- What hours does this dealer operate? (Needed for after-hours stats)
- Who are the actual email addresses of people opted in to receive this digest?
  (Cross-references Mongo opt-in list with the user-management API)

---

## THE METRICS COLLECTORS (the data gathering)

### `queries/sales-inbound-outbound.query.js`
**The Sales data puller.** Contains 11 different ClickHouse queries, each counting
one specific KPI for the sales department. Runs in parallel (all 22 windows —
yesterday + month-to-date — simultaneously). Think of it as 22 gauge readings
taken at the same time.

| What it measures | Why the dealer cares |
|-----------------|---------------------|
| Inbound unique leads | How many new people called in |
| All appointments | Total bookings (Vini + human) |
| Inbound appointments | Bookings that came from inbound calls |
| Outbound call stats | How many leads were called out to |
| Outbound appointments | Bookings from proactive outreach |
| Action items | Open follow-ups the human team needs to act on |
| Conversations | Total interactions by channel (call/SMS/chat) |
| Transfers | Calls handed off to a human |
| After-hours activity | Leads + bookings outside working hours |
| Speed to lead | How fast the first SMS reply went out |

### `queries/service-inbound-outbound.query.js`
**The Service data puller.** Exact same structure as sales but filtered to service
department data. Key difference: service outbound calls don't track "connected calls"
the way sales does.

### `queries/campaign-query.js`
**The outbound campaign reporter.** For any calling campaigns running at a dealership,
reports: how many leads were dialled, how many appointments resulted. Shows top 3
campaigns in the email.

### `queries/speed-to-lead-query.js`
**The response-time calculator.** Measures average time between a new lead being
created and the first SMS reply going out. Appears in the email as "Avg response time."

---

## THE REPORT BUILDER (assembling + quality-checking)

### `services/template-service.js`
**The report card writer.** Takes all the raw numbers from the 22 queries and
arranges them into a structured object the email template understands. Also computes
derived metrics (e.g. transfer rate = transfers ÷ total inbound calls) and builds
the deep-link URLs to the Spyne console.

### `utils/guardrails.js`
**The quality inspector.** Before any email goes out, checks: is this worth sending?
Blocks the email (but still logs the numbers) if:
- Nothing happened yesterday (all zeros) — no point emailing "0 appointments, 0 calls"
- Only passive noise (some conversations but nothing actionable for the dealer)
- Impossible numbers (negative values, month-to-date less than yesterday — indicates a data bug)
- Required fields are missing

A blocked email is still written to the Supabase log with the numbers, so the CSM team
can see what was calculated and decide whether to manually trigger a send.

### `services/html-render.service.js`
**The printing press.** Turns the structured report data into actual email HTML —
the thing the dealer sees in their inbox. Does this in-service (in our code) so we
can ship new email designs without waiting for the mail-service team to register a
new template.

---

## THE SENDER (getting it out the door)

### `services/trigger-email-service.js`
**The conductor — the most important file.** Orchestrates everything in order:
eligibility → timing → recipients → 22 queries → guardrails → HTML render → send → log.
One shared engine (`runDigest`) handles both Sales and Service via adapter objects
at the top of the file (SALES_ADAPTER / SERVICE_ADAPTER). If you need to change the
send pipeline for one department, you change only its adapter.

### `services/mail-send.service.js`
**The post office abstraction.** Actually calls the mail service API. Supports two modes:
- **template mode** (default): sends templateData to mail-service, which renders a pre-registered template
- **raw HTML mode**: sends our own rendered HTML directly (no template registration needed)
Retries up to 2× on timeouts. Also passes the BCC tracking address when enabled.

### `api/controllers/v2/notification/trigger-daily-digest.js`
**The "Send Now" button.** A REST endpoint that humans (or the tracker UI) can call
to manually trigger a digest for any dealer at any time. Bypasses the hourly send-gate.
This is what the curl commands hit.

---

## THE LOGBOOK (recording everything)

### `services/digest-store.service.js`
**The permanent record.** Every digest decision — sent, blocked, skipped — gets
written to Supabase (`roi_digest_runs`) with: the reason, the full calculated numbers,
and the exact HTML that was (or would have been) sent. This is what the tracker reads.
Also has a backfill function to import history from the old Mongo log.

---

## THE CONFIRMATION LAYER (did it really arrive?)

### `services/bcc-tracker.service.js`
**The second opinion on delivery.** When BCC tracking is enabled, every email gets
a secret copy sent to `track+{teamId}+{dept}+{date}@track.spyne.ai`. When the mail
provider confirms delivery to that address, it updates the Supabase log with
`bcc_confirmed = true`. Gives the CSM team independent proof that the email left
our system — not just "the mail service accepted it."

### `services/engagement.service.js`
**The open/click tracker.** Processes events from the mail provider (delivered, opened,
clicked, bounced). Updates the `roi_digest_runs` table to show per-recipient status —
who received it, who bounced. Also triggers the BCC confirmation when a BCC delivery
event arrives.

### `api/controllers/v2/notification/engagement-webhook.js`
**The mail provider's callback endpoint.** The mail service (SendGrid / SES / etc.)
calls this URL every time an email event happens (delivered, opened, clicked, bounced).
This endpoint receives it and passes it to engagement.service.js for processing.

---

## THE DATABASE (Supabase)

### `utils/supabase.js`
**The phone line to Supabase.** Creates and reuses a single Supabase client with the
service-role key. All five Supabase tables are accessed through this one file.
Change the table names here if you ever need to rename them.

### `db/supabase-schema.sql`
**The blueprint.** Run this once in Supabase SQL Editor to create the 5 tables.

### `db/supabase-config.sql`
**The security config.** Run this after the schema. Sets up RLS (who can read/write),
grants, realtime subscriptions (for live tracker updates), and auto-update triggers.

---

## THE HELPERS (shared utilities)

### `utils/common.js`
**The calculator.** Shared helper functions: format a date for ClickHouse, compute a
percentage, convert milliseconds to "2 min 30 sec", figure out what "yesterday" means
in a given timezone. No database access — pure math and formatting.

### `utils/guardrails.js` (listed above in report builder section)

---

## THE TRACKER FRONTEND

### `src/tracker/mockData.ts`
**The fake data.** A hardcoded set of rooftops with simulated send history.
Shown when Supabase isn't connected. Safe to ignore in production.

### `src/tracker/supabaseClient.ts`
**The tracker's phone line to Supabase.** Uses the browser-safe anon key.
Returns `null` if credentials aren't set (tracker falls back to mock).

### `src/tracker/dataSource.ts`
**The translator.** Reads `roi_digest_runs` + `roi_recipients` + `roi_live_departments`
from Supabase and converts them into the grid format the tracker UI expects.
Maps backend reason codes → tracker colour codes.

### `src/tracker/EmailerTracker.tsx`
**The main dashboard screen.** A scrollable grid: rows = dealerships, columns = days.
Each cell shows whether the email was sent. Has filters, summary cards, a send funnel,
and a CSM action board for blocked dealers.

### `src/tracker/RooftopCellDrawer.tsx`
**The detail panel.** Click any grid cell → side drawer opens showing: what the dealer
received (snippet), who received it (per recipient), and for blocked cells — why it
was blocked + fix-it form.
