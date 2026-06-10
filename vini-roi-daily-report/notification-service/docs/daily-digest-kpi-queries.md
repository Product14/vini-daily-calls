# Daily digest — KPIs and queries

Reference for **sales** and **service** daily digest emails only.

| Item | Location |
|------|----------|
| Orchestration | `services/Notification-Service/services/trigger-email-service.js` |
| Template mapping | `services/Notification-Service/services/template-service.js` |
| Sales ClickHouse | `services/Notification-Service/queries/sales-inbound-outbound.query.js` |
| Service ClickHouse | `services/Notification-Service/queries/service-inbound-outbound.query.js` |
| Campaigns | `services/Notification-Service/queries/campaign-query.js` |
| Speed to lead | `services/Notification-Service/queries/speed-to-lead-query.js` |
| Time windows | `services/Notification-Service/utils/common.js` → `getTimeWindows()` |

**Templates**

- Sales: `Vini-Email/Inbound/Daily-Digest/email-sales-daily`
- Service: `Vini-Email/Inbound/Daily-Digest/email-service-daily`

---

## Time windows

All ClickHouse metrics use `{start:DateTime}` and `{end:DateTime}` from `getTimeWindows(dealerTz)`:

| Window | Range (dealer local calendar) | Used for |
|--------|-------------------------------|----------|
| **Yesterday** | Previous day `00:00:00` → `23:59:59` | Primary KPI values in the email |
| **MTD** | 1st of current month `00:00:00` → end of yesterday | `*MTD` template fields |

Params on every query: `enterpriseId`, `teamId`, `start`, `end`.

---

## Non–ClickHouse data (both emails)

| Purpose | Source | Method / API |
|---------|--------|----------------|
| Enable digest | Mongo `conversationNotifications` | `dailyDigest === true` (`guards.isDailyDigestEnabled`) |
| Dealership display name | Mongo `dealerDetails` | `dealerDetails.findOne({ enterprise_id, team_id })` — email uses **team name** from API instead |
| Team name, timezone, working hours | User-management | `GET .../team/get-working-days?teamId=` + query-builder `enterprise_team_details` (`guards.getDealerConfig`) |
| After-hours window | Derived | `guards.resolveAfterHoursConfig(workingDaysData, yesterdayStart, dealerTz)` |
| Recipients | Mongo `conversationNotificationsUsers` + query-builder | Opt-in: `emailNotifications: true`; emails from query-builder `conversationNotificationsUsers` table (`guards.getDigestEmailRecipients`) |
| Cron dedup | Mongo `dailyDigestEmailLogs` | `digest_type`: `sales` or `service`, `local_date` |
| Report labels | Computed | `toDateLabel`, `toPeriodLabel` — no query |
| Console URLs | Computed | Built from `enterpriseId`, `teamId`, `serviceType` |

---

## Send guard (no query)

Email is **not sent** when both are zero for yesterday:

- `countAll*Appointments` (yesterday)
- `getConversationCounts` → `total` (yesterday)

(`guards.hasDigestData`)

---

# Sales daily digest

**Function:** `triggerDailyDigestEmail` → `buildTemplateData({ serviceType: 'sales' })`

## Step 1 — parallel ClickHouse (yesterday + MTD)

| # | Query function | Module | Window(s) |
|---|----------------|--------|-----------|
| 1 | `countInboundUniqueLeads` | `Q` (sales) | yesterday, MTD |
| 2 | `countAllSalesAppointments` | `Q` | yesterday, MTD |
| 3 | `countInboundSalesAppointments` | `Q` | yesterday, MTD |
| 4 | `getOutboundCallStats` | `Q` | yesterday, MTD |
| 5 | `countOutboundSalesAppointments` | `Q` | yesterday, MTD |
| 6 | `getActionItems` (`serviceType: 'sales'`) | `Q` | yesterday only |
| 7 | `getSalesActiveCampaigns` | `CQ` | no date filter |
| 8 | `getConversationCounts` | `Q` | yesterday only |
| 9 | `getInboundConversationCounts` | `Q` | yesterday only |
| 10 | `getSalesTransferStats` | `Q` | yesterday, MTD |
| 11 | `countWarmTransfers` | `Q` | yesterday, MTD |
| 12 | `computeAvgFirstContactMs` (`'sales'`) | `S2L` | yesterday, MTD |
| 13 | `countAfterHoursLeads` | `Q` | yesterday only |
| 14 | `countAfterHoursAppointments` | `Q` | yesterday only |

`Q` = `sales-inbound-outbound.query.js`, `CQ` = `campaign-query.js`, `S2L` = `speed-to-lead-query.js`.

## Step 2 — campaigns (yesterday only)

If step 1 returns active campaigns:

| Query | Module |
|-------|--------|
| `getSalesCampaignStats(enterpriseId, teamId, campaignIds, yStart, yEnd)` | `CQ` |

Top **3** campaigns in email; remainder count → `campaignsExtra`.

## Not wired (commented out in trigger)

| Query | Notes |
|-------|--------|
| `getTopVehicles` | Exists in `Q`; not called; not in template |

---

## Sales KPI → template field → query

### Meta

| Template field | KPI | Query / source |
|----------------|-----|----------------|
| `dealershipName` | Team display name | `getDealerConfig` → query-builder `team_name` |
| `reportDate` | Yesterday label | `toDateLabel(yesterdayStart, dealerTz)` |
| `reportingPeriod` | Yesterday short date | `toPeriodLabel(yesterdayStart, dealerTz)` |
| `nextReport` | Next send hint | `toPeriodLabel(yesterday + 1 day)` + `" · 7:00 AM PT"` |

### Appointments

| Template field | KPI | Query (window) |
|----------------|-----|----------------|
| `appointmentsYesterday` | All sales appointments | `countAllSalesAppointments` (yesterday) |
| `appointmentsYesterdayMTD` | All sales appointments MTD | `countAllSalesAppointments` (MTD) |
| `inboundAppointments` | Inbound-attributed sales appts | `countInboundSalesAppointments` (yesterday) |
| `inboundAppointmentsMTD` | Same MTD | `countInboundSalesAppointments` (MTD) |
| `outboundAppointmentsSet` | Outbound-attributed sales appts | `countOutboundSalesAppointments` (yesterday) |
| `outboundAppointmentsSetMTD` | Same MTD | `countOutboundSalesAppointments` (MTD) |

**`countAllSalesAppointments`**

```sql
SELECT count() AS cnt
FROM meetings
WHERE enterprise_id = {eid} AND team_id = {tid}
  AND service_type = 'sales'
  AND created_at BETWEEN {start} AND {end}
  AND __deleted = 0
```

**`countInboundSalesAppointments`** — meetings with matching inbound sales `endcallreports` on same `call_id`.

**`countOutboundSalesAppointments`** — meetings with matching outbound sales `endcallreports` on same `call_id`.

### Inbound leads

| Template field | KPI | Query (window) |
|----------------|-----|----------------|
| `inboundUniqueLeads` | Distinct inbound sales phone leads | `countInboundUniqueLeads` (yesterday) |
| `inboundUniqueLeadsMTD` | Same MTD | `countInboundUniqueLeads` (MTD) |

**`countInboundUniqueLeads`**

```sql
SELECT count(DISTINCT leadId) AS cnt
FROM endcallreports
WHERE enterpriseId = {eid} AND teamId = {tid}
  AND isActive = 1 AND isTestCall = 0
  AND lower(callDetails_agentInfo_agentType) = 'sales'
  AND callDetails_callType = 'inboundPhoneCall'
  AND createdAt BETWEEN {start} AND {end}
  AND __deleted = 0
```

### Conversations (all + inbound channel split)

| Template field | KPI | Query (window) |
|----------------|-----|----------------|
| `conversationsHandled` | Total conversations (call+sms+chat) | `getConversationCounts` → `total` (yesterday) |
| `conversationsCall` | By channel | `getConversationCounts` → `call` |
| `conversationsSms` | By channel | `getConversationCounts` → `sms` |
| `conversationsChat` | By channel | `getConversationCounts` → `chat` |
| `channelCall` | Inbound-only call convs | `getInboundConversationCounts` → `call` |
| `channelSms` | Inbound-only SMS | `getInboundConversationCounts` → `sms` |
| `channelChat` | Inbound-only chat | `getInboundConversationCounts` → `chat` |

**`getConversationCounts`** — `conversations` ⋈ `teamAgentMappings` ⋈ `agentTypes` where `agentType = 'Sales'`, `uniqExact(conversationId)` by `c.type`.

**`getInboundConversationCounts`** — same, plus `conversationInboundWhereClause()` (`dept = 'sales'`): inbound call linked to inbound `endcallreports`, or sms/chat with empty `campaignId`.

### Transfers

| Template field | KPI | Query (window) |
|----------------|-----|----------------|
| `transferCount` | Inbound calls that transferred | `getSalesTransferStats` → `transferCount` (yesterday) |
| `transferRate` | Transfers ÷ inbound calls | `pct(transferCount, totalCalls)` from yesterday stats |
| `transferRateMTD` | Same MTD | `getSalesTransferStats` (MTD) |
| `warmTransfers` | Warm transfer events | `countWarmTransfers` (yesterday) |
| `warmTransfersMTD` | Same MTD | `countWarmTransfers` (MTD) |

**`getSalesTransferStats`** — `endcallreports` inbound sales calls; `transferCount` = calls with row in `callTransferEvents`.

**`countWarmTransfers`**

```sql
SELECT count() AS cnt FROM callTransferEvents
WHERE enterpriseId = {eid} AND teamId = {tid}
  AND department = 'sales'
  AND createdAt BETWEEN {start} AND {end}
  AND __deleted = 0
```

### Outbound

| Template field | KPI | Query (window) |
|----------------|-----|----------------|
| `outboundUniqueReached` | Distinct leads dialed | `getOutboundCallStats` → `uniqueReached` (yesterday) |
| `outboundUniqueReachedMTD` | Same MTD | `getOutboundCallStats` (MTD) |
| `outboundConnectRate` | Connected ÷ total outbound calls | `pct(connectedCalls, totalCalls)` (yesterday) |
| `outboundConnectRateMTD` | Same MTD | `getOutboundCallStats` (MTD) |

**`getOutboundCallStats`**

```sql
SELECT count() AS totalCalls,
       count(DISTINCT leadId) AS uniqueReached,
       countIf(callDetails_endedReason IN (...)) AS connectedCalls
FROM endcallreports
WHERE enterpriseId = {eid} AND teamId = {tid}
  AND isActive = 1 AND isTestCall = 0
  AND callDetails_callType = 'outboundPhoneCall'
  AND createdAt BETWEEN {start} AND {end}
  AND __deleted = 0
```

### Action items

| Template field | KPI | Query |
|----------------|-----|--------|
| `actionRequiredItems[]` | Open action items by intent | `getActionItems(..., 'sales')` (yesterday) |

```sql
SELECT intent, count() AS cnt
FROM actionItems
WHERE enterprise_id = {eid} AND team_id = {tid}
  AND service_type = 'sales' AND is_active = 1
  AND createdAt BETWEEN {start} AND {end}
  AND __deleted = 0
GROUP BY intent ORDER BY cnt DESC
```

Template maps `intent` → human label via `formatActionItemIntent`.

### Campaigns

| Template field | KPI | Query |
|----------------|-----|--------|
| `campaigns[].name` | Campaign name | `getSalesActiveCampaigns` |
| `campaigns[].dials` | Distinct leads in campaign tasks | `getSalesCampaignStats` → dials (yesterday) |
| `campaigns[].appts` | Appts tied to campaign outbound calls | `getSalesCampaignStats` → appts (yesterday) |
| `campaigns[].conversion` | Appts ÷ dials | `pct(appts, dials)` in template |
| `campaigns[].status` | Always `"active"` | Hardcoded in template |
| `campaignsExtra` | Count beyond top 3 | Computed in trigger |

**Active campaigns**

```sql
SELECT campaignId, name FROM campaigns
WHERE enterpriseId = {eid} AND teamId = {tid}
  AND campaignStatus = 'running' AND campaignType = 'Sales'
  AND __deleted = 0
ORDER BY createdAt DESC
```

**Campaign dials**

```sql
SELECT campaignId, count(DISTINCT leadId) AS dials
FROM outboundTasks
WHERE enterpriseId = {eid} AND teamId = {tid}
  AND campaignId IN {ids} AND leadId != '' AND __deleted = 0
GROUP BY campaignId
```

**Campaign appts** — `outboundTasks` (campaign `callId`) ⋈ `meetings` where `service_type = 'sales'`, `created_at` in window.

### After hours

| Template field | KPI | Query (window) |
|----------------|-----|----------------|
| `afterHoursLeadsEngaged` | Leads engaged outside dealer hours | `countAfterHoursLeads` (yesterday) + `afterHoursCfg` |
| `afterHoursApptsBooked` | Appts booked outside hours | `countAfterHoursAppointments` (yesterday) + `afterHoursCfg` |

Uses dealer working-day config: non-working day = full day after-hours; working day = before `start_time` or at/after `end_time` in dealer TZ on `endcallreports` / `meetings`.

### Response time (sales template only)

| Template field | KPI | Query (window) |
|----------------|-----|----------------|
| `avgResponseTime` | Avg time lead created → first inbound SMS | `computeAvgFirstContactMs(..., 'sales')` (yesterday) |
| `avgResponseTimeMTD` | Same MTD | `computeAvgFirstContactMs` (MTD) |

**`computeAvgFirstContactMs`** — per lead: `min(sms conversation createdAt) - lead.created_at`; average in ms; template → `msToSec()`.

### URLs (computed)

`openInboxUrl`, `reviewActionItemsUrl`, `viewAppointmentsUrl`

---

# Service daily digest

**Function:** `triggerServiceDailyDigestEmail` → `buildServiceTemplateData()`

Uses **`SQ`** (`service-inbound-outbound.query.js`) for service-specific metrics. Action items still use **`Q.getActionItems(..., 'service')`** from the sales query file (same `actionItems` table, `service_type = 'service'`).

## Step 1 — parallel ClickHouse

Same shape as sales; replacements:

| Sales (`Q`) | Service (`SQ`) |
|-------------|----------------|
| `countInboundUniqueLeads` | `SQ.countInboundUniqueLeads` (agent `service`, inbound phone) |
| `countAllSalesAppointments` | `countAllServiceAppointments` |
| `countInboundSalesAppointments` | `countInboundServiceAppointments` |
| `getOutboundCallStats` | `getServiceOutboundCallStats` (no `connectedCalls`) |
| `countOutboundSalesAppointments` | `countOutboundServiceAppointments` |
| `getConversationCounts` | `SQ.getConversationCounts` (`agentType = 'Service'`) |
| `getInboundConversationCounts` | `SQ.getInboundConversationCounts` (`dept = 'service'`) |
| `getSalesTransferStats` | `getServiceTransferStats` |
| `countWarmTransfers` | `SQ.countWarmTransfers` (`department = 'service'`) |
| `computeAvgFirstContactMs(..., 'sales')` | `computeAvgFirstContactMs(..., 'service')` |
| `countAfterHoursLeads` / `countAfterHoursAppointments` | Service variants on `endcallreports` / `meetings` |

Campaigns: `getServiceActiveCampaigns` + `getServiceCampaignStats` (`campaignType = 'Service'`; dials field = `leadsReachedDuringCampaign`).

## Step 2 — campaigns

`getServiceCampaignStats` — same pattern as sales; template still exposes `dials` from `leadsReachedDuringCampaign`.

---

## Service KPI → template field → query

Service email includes a **subset** of sales fields. Below: fields **in the service template** and their queries.

| Template field | KPI | Query (window) |
|----------------|-----|----------------|
| `dealershipName` | Team name | `getDealerConfig` |
| `reportDate` | Short date | `toPeriodLabel(yesterday)` |
| `reportingPeriod` | Date + `(12:00 AM – 11:59 PM)` | Formatted in `buildServiceTemplateData` |
| `nextReport` | Static | `"Tomorrow 7:00 AM"` (hardcoded) |
| `appointmentsYesterday` / `*MTD` | All service appts | `countAllServiceAppointments` |
| `inboundAppointments` / `*MTD` | Inbound service appts | `countInboundServiceAppointments` |
| `outboundAppointmentsSet` / `*MTD` | Outbound service appts | `countOutboundServiceAppointments` |
| `inboundUniqueLeads` / `*MTD` | Inbound service phone leads | `SQ.countInboundUniqueLeads` |
| `conversationsHandled` / `Call` / `Sms` / `Chat` | Service conversations | `SQ.getConversationCounts` (yesterday) |
| `transferCount` | Service inbound transfers | `getServiceTransferStats` (yesterday) |
| `transferRate` / `transferRateMTD` | Transfer % | `pct` on transfer stats |
| `warmTransfers` / `*MTD` | Service warm transfers | `SQ.countWarmTransfers` |
| `outboundUniqueReached` / `*MTD` | Outbound leads reached | `getServiceOutboundCallStats` |
| `outboundConnectRate` / `*MTD` | Connect rate | `pct(uniqueReached, totalCalls)` — **no** `connectedCalls` on service |
| `actionRequiredItems[]` | Action items | `getActionItems(..., 'service')` |
| `campaigns[]` / `campaignsExtra` | Running service campaigns | `getServiceActiveCampaigns` + `getServiceCampaignStats` |
| `afterHoursLeadsEngaged` | After-hours leads | `SQ.countAfterHoursLeads` |
| `afterHoursApptsBooked` | After-hours appts | `SQ.countAfterHoursAppointments` |
| `openInboxUrl`, `reviewActionItemsUrl`, `viewAppointmentsUrl` | Console links | Computed (`serviceType = 'service'`) |

### Queried for service but **not** in service template

These run in `triggerServiceDailyDigestEmail` but are **dropped** by `buildServiceTemplateData`:

| Query result | Sales template field | Notes |
|--------------|----------------------|--------|
| `getInboundConversationCounts` | `channelCall`, `channelSms`, `channelChat` | Not exported in service email |
| `computeAvgFirstContactMs` | `avgResponseTime`, `avgResponseTimeMTD` | Not exported in service email |

### Sales-only template fields (not in service email)

`channelCall`, `channelSms`, `channelChat`, `avgResponseTime`, `avgResponseTimeMTD`, full `reportDate` weekday format, `nextReport` with PT timezone label.

---

## Query count summary

| Email | ClickHouse calls (typical) | Notes |
|-------|----------------------------|--------|
| Sales | 22 in step 1 + 0–2 in step 2 | +2 if campaigns have stats (dials + appts) |
| Service | 22 in step 1 + 0–2 in step 2 | Same structure |

Each “yesterday + MTD” pair = 2 queries. Campaign stats = 2 queries per send when campaigns exist.

---

## Which teams get the cron (eligibility)

**Mongo** `conversationNotifications` (not ClickHouse):

```javascript
find({
  dailyDigest: true,
  'config.dealerEmail': false,
})
```

Then intersect with ClickHouse `teamAgentMappings` / `agentTypes` to set `sendSales` / `sendService` (onboarded Sales or Service agent).

Per-send guard (`isDailyDigestEnabled`): same Mongo doc must have `dailyDigest === true` and `config.dealerEmail === false`.

---

## Related files

- Cron: `cron/dailyDigest.cron.js`
- Eligibility: `queries/digest-eligibility.query.js` → `getDigestTargets()`
- Manual API: `api/controllers/v2/notification/trigger-daily-digest.js`
- Config: `config/cron.js` → `dailyDigest` (hourly; send gate 7:00 local in trigger)
