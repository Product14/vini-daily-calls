# QA testing — how YOU test it

Emails are OFF (dry-run). Every test below is safe — nothing will be sent.

## Test 1 · Logic smoke test (no DB needed) — 5 seconds
```
cd pods/vini-roi-daily-report/notification-service
node test/qa-smoke.js
```
Expect: `QA SMOKE: 14 passed, 0 failed`. Covers guardrails, BCC address round-trip,
time-window math, formatters, HTML render, engagement normalization.

## Test 2 · Tracker reads live Supabase data
```
cd pods/vini-roi-emailerv2/prototype-roi-email/frontend
npm run dev
```
Open the URL → click **Rooftop tracker**. Confirm:
- Header reads "**Supabase · roi_digest_runs**" (not mock)
- Covina Kia row shows Sent / Sent / Suppr. / Sent / Sent across Jun 2–6
- The unconfigured team shows a **+ Classify** action chip
- Click a cell → drawer shows the email snippet + recipients

## Test 3 · Email preview (what would be sent — never sent)
Already generated at `frontend/public/digest-preview.html`.
With the dev server running, open `/digest-preview.html` to review the actual
rendered digest email. Regenerate from any data with `html-render.service.js`.

## Test 4 · Dry-run pipeline (safe end-to-end) — once backend env is set
After you set `supabaseServiceKey` + `dryRun:true` in `config/custom.js` and start Sails:
```
curl -X POST http://localhost:1337/v2/notification/trigger-daily-digest \
  -H "Content-Type: application/json" \
  -d '{"enterpriseId":"7d06f7427","teamId":"49a06313cf","serviceType":"both","bypassDigestSchedule":true}'
```
Expect response: `{"results":[{"department":"service","sent":false,"reason":"dry_run","wouldSendTo":[...]}]}`
Then verify in Supabase (no email left the building):
```sql
select team_id, department, status, reason, reason_detail
from roi_digest_runs where reason='dry_run' order by created_at desc;
```
Status will be `suppressed` / reason `dry_run`, with metrics + rendered_html stored.

## Test 5 · Verify the data in Supabase
Use the query sheet `notification-service/db/SQL_VALIDATION.md` (or `SQL_VALIDATION.md`)
— sections S1–S10 cover runs, blocked reasons, engagement, send-rate, BCC gaps.

## What is NOT tested locally (needs your live infra)
- Real ClickHouse metric values (needs read access) — validate via `SQL_VALIDATION.md` Step 1
- Real recipient resolution (needs user-management API)
- Actual mail delivery (intentionally OFF — flip `dryRun:false` only when ready)

## Going live (when QA passes)
1. Confirm raw-HTML endpoint + ESP
2. Decide tracker auth (PII)
3. Set `dryRun:false`
4. Trigger ONE rooftop with a `to` override to your own inbox first
5. Watch the tracker + `roi_engagement_events` for delivery/open
