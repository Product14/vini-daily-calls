# ROI Email — complete local cron

One Node process that runs the whole pipeline against Supabase + a public data
embedding + the mail curl. No ClickHouse MCP, no deployed Edge Functions.

## Flow (matches the spec)
1. **Finalized set** — reads `roi_live_departments.is_live` (step 0/1) + `roi_recipients` (who receives).
2. **Fetch data** — for each live `(team, dept)` calls the **public embedding** with params
   `team_id` + `dept`; stores metrics in `roi_digest_runs` with status **`queued`**.
3. **Guardrails** — validates the data (`no_data` / `not_actionable` → `not_sent`).
4. **Send** via the mail curl **iff**: team live · recipients added · guardrails pass ·
   send-hour reached · not already sent today. Records `status='sent'` + recipients received.
5. Runs **every hour** (`--loop`).

## Setup
```bash
cd local-cron
cp .env.example .env        # fill ROI_SUPABASE_SERVICE_KEY + EMBEDDING_URL
npm install
```
**Create the embedding** (once): paste `../db/clickhouse-endpoints/email-embedding.sql` into a
Metabase question (variables `team_id`, `dept`, type Text) → **Public link** → copy the
`/api/public/card/<uuid>/query/json` URL into `EMBEDDING_URL`.

## Run
```bash
npm run once        # single pass (DRY_RUN=true by default → sends nothing, records everything)
npm run loop        # run now + every hour
```
Flip `DRY_RUN=false` in `.env` to actually email. Per-rooftop `roi_live_departments.dry_run=true`
still holds that rooftop even when `DRY_RUN=false`.

### Hourly in production
Use the `--loop` process under pm2 (`pm2 start runner.cjs -- --loop`) or a system cron
(`0 * * * * cd /path/local-cron && node runner.cjs >> cron.log 2>&1`).

## What you'll see in the tracker
Each pass writes `roi_digest_runs`: `queued` (fetched) → `not_sent` (guardrail) /
`scheduled` (before send-hour) / `suppressed` (dry-run) / `sent` (real). The tracker tab
reflects it live.
