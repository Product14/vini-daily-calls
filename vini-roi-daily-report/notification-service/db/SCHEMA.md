# ROI Daily Report — complete data schema (old + new)

End-to-end data picture for the generator + sender + tracker. Review the
**Validation checklist** at the bottom and confirm each check.

---

## A · Old data sources (read-only — unchanged)

These already exist; the service reads from them. Listed so the join keys are explicit.

### ClickHouse (metrics + eligibility candidates)

| Table | Used for | Key columns |
|-------|----------|-------------|
| `teamAgentMappings` ⋈ `agentTypes` | eligibility candidate set (onboarded+active Sales/Service) | `enterpriseId, teamId, agentTypeId, isOnboarded, isActive` |
| `endcallreports` | leads, outbound stats, transfers, after-hours | `enterpriseId, teamId, callId, leadId, createdAt` |
| `meetings` | appointments (all / inbound / outbound / after-hours) | `enterprise_id, team_id, call_id, lead_id, created_at, service_type` |
| `conversations` | conversation counts, speed-to-lead | `enterpriseId, teamId, conversationId, leadId, type, createdAt` |
| `leads` | speed-to-lead | `enterprise_id, team_id, lead_id, service_type, created_at` |
| `campaigns`, `outboundTasks` | campaign dials/appts | `enterpriseId, teamId, campaignId, callId, leadId` |
| `actionItems` | action-required items | `enterprise_id, team_id, intent, service_type, createdAt` |
| `callTransferEvents` | warm transfers | `enterpriseId, teamId, callId, department` |

### MongoDB (config + dedup)

| Collection | Used for | Key fields |
|------------|----------|-----------|
| `conversationNotifications` | digest on/off per team | `enterpriseId, teamId, dailyDigest, config.dealerEmail` |
| `conversationNotificationsUsers` | per-user email opt-in | `enterpriseId, teamId, userId, emailNotifications` |
| `dealerDetails` | dealership display name | `enterprise_id, team_id, dealership_name` |
| `dailyDigestEmailLogs` | success/dedup log (legacy; kept) | `enterprise_id, team_id, digest_type, local_date, sent_at` |

**Universal join keys:** `enterprise_id` + `team_id`, plus `local_date` (dealer-local
calendar day), `call_id`/`lead_id` within a team, and `message_id` for engagement.

---

## B · New Supabase tables (full DDL: `db/supabase-schema.sql`)

### B1 · `roi_live_departments` — eligibility gate 3 *(old req)*
CSM-curated "actually live" allowlist. ClickHouse proposes candidates; this confirms.

```
team_id     text       -- join key to ClickHouse teamId
department  text        -- 'sales' | 'service'
is_live     boolean
PK (team_id, department)
```
Eligibility = Mongo(enabled) ∩ ClickHouse(onboarded+active) ∩ **this(is_live)**, per dept.

### B2 · `roi_rooftop_config` — per-rooftop runtime config *(req 2)*
```
team_id            text  PK
enterprise_id      text
rooftop_name       text
digest_send_hour   smallint  default 7   (0–23)   -- UI-configurable send time
digest_send_minute smallint  default 0   (0–59)
timezone           text                            -- optional override
daily/weekly/monthly_enabled  boolean
```

### B3 · `roi_recipients` — recipient + department routing *(req 3)*
```
id                uuid PK
team_id           text
enterprise_id     text
email             text
name              text
receives_sales    boolean   -- which dept's comms this person gets
receives_service  boolean
email_enabled     boolean   -- master opt-in
UNIQUE (team_id, email)
```

### B4 · `roi_digest_runs` — every run, sent or not *(req 1 & 5)* — **the tracker's read model**
```
id              uuid PK
enterprise_id   text
team_id         text
department      text         -- 'sales' | 'service'
cadence         text         -- 'daily' | 'weekly' | 'monthly'
local_date      date
dealer_timezone text
status          text         -- sent | not_sent | suppressed | scheduled | not_subscribed   (= tracker SendStatus)
reason          text         -- normalized reason (= tracker NotSentReason + backend codes)
reason_detail   text
metrics         jsonb        -- FULL computed templateData (req 5: what was calculated)
rendered_html   text         -- the exact HTML sent / would-be-sent (req 5)
subject         text
mail_template   text
recipients      jsonb        -- [{email,name,received,bounced}]
send_path       text         -- 'template' | 'raw_html'
trigger         text         -- 'cron' | 'manual' | 'backfill'
message_id      text         -- joins to engagement events
sent_at         timestamptz
created_at      timestamptz
UNIQUE (team_id, department, cadence, local_date)   -- idempotency / dedup
```

### B5 · `roi_engagement_events` — communication engagement *(req 7)*
```
id              uuid PK
run_id          uuid -> roi_digest_runs(id)
message_id      text
team_id         text
recipient_email text
event_type      text   -- delivered | open | click | bounce | complaint | dropped | deferred | unsubscribe
url             text   -- for clicks
provider        text
raw             jsonb
occurred_at     timestamptz
```

---

## C · Status + reason canonical enums (must match tracker `mockData.ts`)

**status** (SendStatus): `sent · not_sent · suppressed · scheduled · not_subscribed`

**reason** (NotSentReason + backend):
`recipients_missing · recipient_placeholder · tag_missing · smtp_timeout ·
scheduler_skipped · silent_day · bounced` **+** `not_eligible · before_send_hour ·
already_sent · no_data · not_actionable · guardrail_failed · not_subscribed · mail_error`

---

## D · How a run flows through the tables

```
cron → eligibility (Mongo ∩ ClickHouse ∩ roi_live_departments)
     → roi_rooftop_config (send hour)         ── req 2
     → recipients (Mongo opt-in) ∩ roi_recipients (dept routing)  ── req 3
     → ClickHouse metrics → guardrails         ── req 4
     → render HTML → send (template|raw_html)  ── req 6
     → roi_digest_runs (status+reason+metrics+html)  ── req 1 & 5
     → mail webhook → roi_engagement_events → updates run.recipients  ── req 7
tracker UI ← roi_digest_runs + roi_engagement_events (read)
           → roi_rooftop_config / roi_recipients / roi_live_departments (write)
```

---

## E · Validation checklist

**Confirmed by product (DDL-critical):**

1. ✅ **Join key:** `team_id` globally unique → Supabase tables keyed by `team_id` alone.
2. ✅ **`roi_live_departments` shape:** one row per `(team_id, department)` with `is_live`.
3. ✅ **Recipient ownership:** Mongo/user-mgmt resolves *who*; `roi_recipients` is a dept-routing overlay.
4. ✅ **Run payload:** full `rendered_html` + full `metrics` jsonb stored inline.

**Defaults — accepted (flip any on request):**

5. ☑ **Idempotency key:** one run per `(team_id, department, cadence, local_date)`.
6. ☑ **Status enum** = the 5 tracker values exactly.
7. ☑ **Reason enum** = the tracker set + backend codes (section C).
8. ☑ **Cadence:** `daily | weekly | monthly` in one table.
9. ☑ **Engagement event types** = the 8 in B5.
10. ☑ **Config defaults:** send time defaults to 07:00 dealer-local when no row.
11. ☑ **`enterprise_id` retained** on every table for partitioning/filtering.
12. ☑ **Suppressed vs scheduled:** `before_send_hour` → status `scheduled`; guardrail/no-data → `not_sent`.
```
