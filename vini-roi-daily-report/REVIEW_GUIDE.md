# Tech architecture review guide
Step-by-step reading order with exact file + function pointers.
Open each file as you read its section.

---

## STEP 0 · Who gets a report? (Filtering + access + user fetch)

### 0-A · The alarm clock + first filter
```
FILE:  cron/dailyDigest.cron.js          ~58 lines
READ:  the run() function (entire file)
```
**What it does in plain English:**
Runs every hour. Calls `DigestEligibilityQuery.getDigestTargets()` to get the
eligible team list, then fires `triggerDailyDigestEmail` (sales) and
`triggerServiceDailyDigestEmail` (service) for each team that has the right agent type.

**Key things to check:**
- `targets.filter(t => t.sendSales)` — sales-only list
- `targets.filter(t => t.sendService)` — service-only list
- If either throws, error is caught per-team (no full stop)

---

### 0-B · The three-gate bouncer (eligibility)
```
FILE:  queries/digest-eligibility.query.js     ~134 lines
READ:  getDigestTargets() — lines 48–123
```
**Three gates that must ALL say YES:**

| Gate | Source | What it checks |
|------|--------|---------------|
| 1 | MongoDB `conversationNotifications` | `dailyDigest === true` AND `config.dealerEmail === false` |
| 2 | ClickHouse `teamAgentMappings` | `isOnboarded=1` AND `isActive=1` (Sales or Service agent) |
| 3 | **Supabase** `roi_live_departments` | `is_live=true` for that team+department |

**GOTCHA:** Gate 1 requires `config.dealerEmail` to be *explicitly* `false`.
A missing field ≠ false, so those teams are silently skipped.

**Output:** array of `{ enterpriseId, teamId, sendSales, sendService }`

---

### 0-C · Supabase live-team check (Gate 3 detail)
```
FILE:  queries/live-team.query.js         ~75 lines
READ:  getLiveDepartmentsByTeam() + parseLiveRows()
```
**DB table to check in Supabase:**
```sql
-- See which teams+depts are marked live:
select team_id, department, is_live from roi_live_departments order by team_id;

-- Check separately for sales:
select team_id from roi_live_departments where department='sales' and is_live=true;

-- Check separately for service:
select team_id from roi_live_departments where department='service' and is_live=true;
```
Supabase Connector: use the **anon key** for read-only checks in Metabase;
use the **service_role key** in the backend only.

---

### 0-D · Supabase client (the phone line)
```
FILE:  utils/supabase.js         ~51 lines
READ:  getSupabaseClient() + TABLES map
```
`TABLES` maps logical names → real table names (overridable via config).
All five Supabase tables are accessed through this one shared client.

---

### 0-E · User fetch logic (recipient resolution)
```
FILE:  utils/guards.js           ~302 lines
READ:  getDigestEmailRecipients() — lines 152–179
       getEmailOptedInUserIds()   — lines 100–123
       fetchTeamUsersWithEmail()  — lines 133–141
```
**Two-step join:**
1. `getEmailOptedInUserIds()` — reads Mongo `conversationNotificationsUsers`
   for users where `emailNotifications: true` → returns a Set of user IDs.
2. `fetchTeamUsersWithEmail()` — calls user-management API
   `GET /user-management/v1/team/get-team-users` → full user roster with emails.
3. Intersect: keep only users whose `user_id` is in the opted-in set.

**Also read in guards.js:**
- `getDealerConfig()` — fetches timezone + working hours (determines "yesterday")
- `resolveAfterHoursConfig()` — maps working-hours API data → start/end minutes

---

## STEP 1 · Queries + data filtering (what gets measured)

### 1-A · All ClickHouse queries for SALES
```
FILE:  queries/sales-inbound-outbound.query.js     ~382 lines
```

| Function | What it counts | Metabase table |
|----------|---------------|----------------|
| `countInboundUniqueLeads` | Distinct leads who called in (sales agent) | `endcallreports` |
| `countAllSalesAppointments` | All sales appts (source='spyne') | `meetings` |
| `countInboundSalesAppointments` | Appts from inbound calls | `meetings` ⋈ `endcallreports` |
| `getOutboundCallStats` | Total calls + unique reached + connected | `endcallreports` |
| `countOutboundSalesAppointments` | Appts from outbound calls | `meetings` ⋈ `endcallreports` |
| `getActionItems` | Open items grouped by intent | `actionItems` |
| `getConversationCounts` | All convos by channel | `conversations` ⋈ agent tables |
| `getInboundConversationCounts` | Inbound-only convos | same + inbound WHERE clause |
| `getSalesTransferStats` | Inbound calls + how many transferred | `endcallreports` ⋈ `callTransferEvents` |
| `countWarmTransfers` | Warm transfer events | `callTransferEvents` |
| `countAfterHoursLeads/Appointments` | Activity outside working hours | time-of-day filter in dealer TZ |

**To validate on Metabase** — run these equivalent queries for one teamId, one day:
```sql
-- Inbound unique leads (sales)
SELECT count(DISTINCT leadId) FROM endcallreports
WHERE teamId='<id>' AND lower(callDetails_agentInfo_agentType)='sales'
AND callDetails_callType='inboundPhoneCall'
AND createdAt BETWEEN '<yStart>' AND '<yEnd>'
AND isActive=1 AND isTestCall=0 AND __deleted=0;

-- All sales appointments
SELECT count() FROM meetings
WHERE team_id='<id>' AND service_type='sales' AND source='spyne'
AND created_at BETWEEN '<yStart>' AND '<yEnd>' AND __deleted=0;
```

---

### 1-B · All ClickHouse queries for SERVICE
```
FILE:  queries/service-inbound-outbound.query.js     ~308 lines
```
Same structure as sales, but filtered to `agentType='service'` / `service_type='service'`.
**Key difference:** `getServiceOutboundCallStats` has NO `connectedCalls` field
(service outbound doesn't track connect reasons).

---

### 1-C · Campaign queries
```
FILE:  queries/campaign-query.js     ~152 lines
READ:  getSalesActiveCampaigns, getSalesCampaignStats (and Service equivalents)
```
**To validate on Metabase:**
```sql
-- Running campaigns
SELECT campaignId, name FROM campaigns
WHERE teamId='<id>' AND campaignStatus='running' AND campaignType='Sales' AND __deleted=0;

-- Campaign dials
SELECT campaignId, count(DISTINCT leadId) as dials FROM outboundTasks
WHERE teamId='<id>' AND campaignId IN (<ids>) AND __deleted=0 GROUP BY campaignId;
```

---

### 1-D · Speed to lead
```
FILE:  queries/speed-to-lead-query.js     ~54 lines
READ:  computeAvgFirstContactMs()
```
`(first SMS conversation time) − (lead created time)` per lead, averaged.
Returns milliseconds. Template displays it via `msToSec()`.

---

### 1-E · Data filtering rule — when is an email BLOCKED?
```
FILE:  utils/guardrails.js     ~99 lines
READ:  validateDigestPayload()
```
Email is **blocked** (not sent, but logged) when ANY of these are true:

| Rule | Code | Meaning |
|------|------|---------|
| Nothing happened | `no_data` | all primary KPIs are zero |
| Nothing to act on | `not_actionable` | some convos but 0 appts, 0 action items, 0 inbound leads |
| Bad numbers | `invalid_metrics` | NaN or negative in any core field |
| MTD < yesterday | `inconsistent_mtd` | month total less than single day — data bug |
| Missing fields | `missing_fields` | required template fields absent |

When blocked: run is written to `roi_digest_runs` with `status='not_sent'` +
`reason=<code>` + full `metrics` jsonb + `rendered_html` so you can still review
what the numbers were.

---

## STEP 2 · Payload generation + email trigger

### 2-A · Payload assembly (template data)
```
FILE:  services/template-service.js     ~242 lines
READ:  buildTemplateData() — for sales
       buildServiceTemplateData() — for service (a subset of sales fields)
```
Takes all the raw numbers from Step 1 and assembles them into the exact
key-value object the email template needs. Each key maps 1:1 to a variable in
the template HTML. Also computes:
- `viewAppointmentsUrl`, `openInboxUrl`, `reviewActionItemsUrl` (console deep-links)
- `reportDate`, `reportingPeriod`, `nextReport` (display labels)
- `transferRate = pct(transferCount, totalCalls)` (calculated field)

---

### 2-B · Payload storage in Supabase
```
FILE:  services/digest-store.service.js     ~136 lines
READ:  recordDigestRun()
```
Called on EVERY exit path — sent, not_sent, suppressed. Stores:
- `metrics` (full templateData as JSON)
- `rendered_html` (the actual email HTML)
- `status`, `reason`, `reason_detail`
- `recipients` (who was it sent to)

**To check in Supabase:**
```sql
-- Most recent runs
SELECT team_id, department, local_date, status, reason, created_at
FROM roi_digest_runs ORDER BY created_at DESC LIMIT 20;

-- A blocked run — see what numbers were computed
SELECT metrics, rendered_html FROM roi_digest_runs
WHERE status='not_sent' AND team_id='<id>' ORDER BY created_at DESC LIMIT 1;
```

---

### 2-C · Email triggering — the conductor
```
FILE:  services/trigger-email-service.js     ~343 lines
READ:  runDigest() — the single shared engine
       SALES_ADAPTER / SERVICE_ADAPTER — at the top, the dept-specific method refs
```
**Order of operations inside runDigest():**
1. Gate 1: `isDailyDigestEnabled()`
2. Dealer timezone + working hours (`getDealerConfig`)
3. **Per-rooftop send hour** from `roi_rooftop_config`
4. Send-hour gate (cron only)
5. Recipient resolution + dept routing (`getDigestEmailRecipients` + `filterEmailsByDept`)
6. ClickHouse queries (22 parallel via `Promise.all`)
7. Campaign stats (sequential, depends on step 6)
8. Build payload (`buildTemplateData`)
9. Render HTML (`renderDigestHtml`)
10. **Guardrails** (`validateDigestPayload`) — block if fails
11. Send (`sendTemplateEmail` or `sendRawHtmlEmail`) with optional BCC
12. Store run (`recordDigestRun`)
13. Write Mongo dedup log (backward-compat)

---

### 2-D · Mail send abstraction
```
FILE:  services/mail-send.service.js     ~90 lines
READ:  sendTemplateEmail(), sendRawHtmlEmail(), postWithRetry()
```
Two paths:
- **template** (default) → `POST /api/v1/send-template-email` with templateData
- **raw_html** (new) → `POST /api/v1/send-email` with rendered HTML body

Both support `bcc` field (Step 3 tracking). Both retry up to 2× on 5xx / timeout.

---

## STEP 3 · Daily tracking + manual send + BCC validation

### 3-A · Tracker read model
```
FILE:  services/digest-store.service.js    READ: recordDigestRun()
DB:    roi_digest_runs table
```
Every run written here becomes one cell in the tracker grid.
`status` → cell colour. `reason` → tooltip/drawer content.

**Status values:**
| status | tracker shows | meaning |
|--------|--------------|---------|
| `sent` | green ✓ | email dispatched |
| `not_sent` | red/amber + reason CTA | blocked — see reason |
| `suppressed` | amber | sent but suppressed (e.g. silent day) |
| `scheduled` | blue | before configured send hour |
| `not_subscribed` | grey — | no subscription |

---

### 3-B · Manual send flow
```
FILE:  api/controllers/v2/notification/trigger-daily-digest.js     ~70 lines
```
**curl (copy-paste ready):**
```bash
# Send to real recipients (resolved from config)
curl -X POST https://<host>/v2/notification/trigger-daily-digest \
  -H "Content-Type: application/json" \
  -d '{"enterpriseId":"7d06f7427","teamId":"49a06313cf","serviceType":"both"}'

# QA send — override recipients, skip send-hour gate
curl -X POST https://<host>/v2/notification/trigger-daily-digest \
  -H "Content-Type: application/json" \
  -d '{
    "enterpriseId": "7d06f7427",
    "teamId":       "49a06313cf",
    "serviceType":  "sales",
    "to":           ["you@spyne.ai"],
    "bypassDigestSchedule": true
  }'
```
Response: `{ ok, results: [{ department, sent, recipients }] }`
Every call writes a `roi_digest_runs` row → appears in the tracker.

---

### 3-C · BCC email check flow (Step 3 — independent send validation)
```
FILE:  services/bcc-tracker.service.js     ~120 lines
READ:  buildBccAddress(), parseBccAddress(), confirmBccDelivery()
```
**How it works end-to-end:**

```
1. SEND  trigger-email-service  →  mail-send adds BCC: track+{teamId}+{dept}+{date}@track.spyne.ai
2. ROUTE mail.spyne.ai          →  forwards to dealer inbox AND BCCs the track address
3. EVENT ESP fires "delivered"  →  hits POST /v2/notification/engagement-webhook
4. PARSE engagement.service     →  sees recipient is "track+*", calls confirmBccDelivery()
5. MARK  bcc-tracker.service    →  sets roi_digest_runs.bcc_confirmed = true
6. SHOW  tracker UI             →  ✓ BCC column turns green = independently confirmed
```

**To enable (config):**
```js
// config/custom.js
bccEnabled:     true,
bccTrackDomain: 'track.spyne.ai',   // a mailbox you control
```

**To check in Supabase:**
```sql
-- Runs confirmed by BCC
SELECT team_id, department, local_date, bcc_confirmed, bcc_confirmed_at
FROM roi_digest_runs WHERE bcc_confirmed = true ORDER BY bcc_confirmed_at DESC;

-- Runs where email was sent but BCC not yet confirmed (potential delivery gap)
SELECT team_id, department, local_date, sent_at
FROM roi_digest_runs
WHERE status = 'sent' AND bcc_confirmed = false AND sent_at < now() - interval '1 hour';
```

---

## Quick-reference: which file to open for what

| Question | File |
|----------|------|
| Who is eligible today? | `queries/digest-eligibility.query.js` → `getDigestTargets()` |
| Which teams are marked "actually live"? | Supabase `roi_live_departments` |
| Who are the email recipients for a team? | `utils/guards.js` → `getDigestEmailRecipients()` |
| What time does a rooftop send? | Supabase `roi_rooftop_config` → `digest_send_hour` |
| What queries hit ClickHouse? | `queries/sales-inbound-outbound.query.js` |
| Why was an email blocked? | Supabase `roi_digest_runs` → `reason` + `metrics` |
| What HTML did the dealer receive? | Supabase `roi_digest_runs` → `rendered_html` |
| How do I send manually? | `curl POST /v2/notification/trigger-daily-digest` |
| How does BCC tracking work? | `services/bcc-tracker.service.js` |
| How do open/click/bounce get tracked? | `services/engagement.service.js` |
