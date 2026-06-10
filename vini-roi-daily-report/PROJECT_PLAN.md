# ROI Daily Report — project plan

Status legend: ✅ done · 🟡 in progress · ⬜ not started · 🔒 blocked (needs input)

---

## Phase 0 — Foundations (DONE)
| # | Task | Status |
|---|------|--------|
| 0.1 | Review both codebases, document pitfalls | ✅ |
| 0.2 | Supabase eligibility gate (Mongo ∩ ClickHouse ∩ Supabase live) | ✅ |
| 0.3 | Persist every run (sent/not) + metrics + HTML | ✅ |
| 0.4 | Configurable per-rooftop send hour | ✅ |
| 0.5 | Per-recipient department routing | ✅ |
| 0.6 | Payload guardrails | ✅ |
| 0.7 | Direct-HTML render + send path | ✅ |
| 0.8 | Engagement webhook + events | ✅ |
| 0.9 | Schema locked + validated; arch diagrams | ✅ |
| 0.10 | Manual trigger endpoint + curl | ✅ |
| 0.11 | Tracker reads live data (mock fallback) | ✅ |
| 0.12 | Code comments + plain-English guide | ✅ |

## Phase 1 — Provision & connect (NEXT)
| # | Task | Status | Depends on |
|---|------|--------|-----------|
| 1.1 | Create Supabase project; capture URL + anon + service keys | ⬜ | — |
| 1.2 | Run `supabase-schema.sql` then `supabase-config.sql` | ⬜ | 1.1 |
| 1.3 | Fill backend config (§ Config below) | ⬜ | 1.1 |
| 1.4 | Fill frontend `.env` (anon key) | ⬜ | 1.1 |
| 1.5 | Seed test rows (live dept, config, recipient) | ⬜ | 1.2 |
| 1.6 | Decide PII path: Supabase Auth+RLS **or** backend-proxy reads | 🔒 | product |

## Phase 2 — Wire backend into the real repo
| # | Task | Status | Depends on |
|---|------|--------|-----------|
| 2.1 | Clone real notification-service repo | 🔒 | repo URL |
| 2.2 | Port the 12 changed/new files to real paths | ⬜ | 2.1 |
| 2.3 | Add routes: `trigger-daily-digest`, `engagement-webhook` | ⬜ | 2.2 |
| 2.4 | Confirm Mongo models (`dailyDigestEmailLogs`, `dealerDetails`…) resolve | ⬜ | 2.2 |
| 2.5 | Confirm raw-HTML mail endpoint contract (req 6) | 🔒 | mail-service team |
| 2.6 | Pick + wire ESP for engagement webhook (req 7) | 🔒 | ESP choice |

## Phase 3 — Cadence completeness
| # | Task | Status |
|---|------|--------|
| 3.1 | Fix dead weekly digest (`triggerWeeklyDigestEmail` missing) | ⬜ |
| 3.2 | Add weekly + monthly windows to `getTimeWindows()` | ⬜ |
| 3.3 | Weekly/monthly run rows + tracker cadences | ⬜ |

## Phase 4 — Tracker write-actions
| # | Task | Status |
|---|------|--------|
| 4.1 | Drawer "Send now / Retry" → `POST trigger-daily-digest` | ⬜ |
| 4.2 | "Classify" → write `roi_live_departments` | ⬜ |
| 4.3 | "Add recipient / fix email" → write `roi_recipients` | ⬜ |
| 4.4 | Send-hour editor → write `roi_rooftop_config` | ⬜ |
| 4.5 | Store CSM on a rooftop (currently "Unassigned") | ⬜ |
| 4.6 | Realtime subscription so the grid live-updates | ⬜ |

## Phase 5 — Internal testing (see § Testing)
| # | Task | Status |
|---|------|--------|
| 5.1 | Unit tests: guardrails, reason-mapping, time windows, recipient filter | ⬜ |
| 5.2 | Integration: eligibility 3-gate, run-store upsert idempotency | ⬜ |
| 5.3 | Dry-run mode (compute + store, do NOT send) across all live teams | ⬜ |
| 5.4 | QA send to internal inboxes (`to` override) per template | ⬜ |
| 5.5 | Webhook replay test (delivered/open/bounce → run updates) | ⬜ |
| 5.6 | Tracker E2E: trigger → row → grid cell → drawer | ⬜ |

## Phase 6 — Live tracking & rollout
| # | Task | Status |
|---|------|--------|
| 6.1 | Canary: 1–2 friendly rooftops, real send, watch tracker | ⬜ |
| 6.2 | Backfill history via `syncFromDailyDigestLogs()` | ⬜ |
| 6.3 | Monitoring: cron success, send rate, guardrail-block rate, bounce rate | ⬜ |
| 6.4 | Alerting: Supabase-down (fail-closed), mail errors, eligibility=0 | ⬜ |
| 6.5 | Gradual ramp by CSM book → all rooftops | ⬜ |
| 6.6 | Runbook: how to retry, reclassify, pause a rooftop | ⬜ |

---

## Config — everything to fill 🔧

### Supabase
| Item | Where to get it | Goes into |
|------|-----------------|-----------|
| Project URL | Supabase → Settings → API | backend + frontend |
| `anon` key | Supabase → Settings → API | frontend only |
| `service_role` key | Supabase → Settings → API (secret) | backend only |
| Schema applied | run `db/supabase-schema.sql` | — |
| RLS/grants/realtime | run `db/supabase-config.sql` | — |

### Backend (`config/custom.js` or env)
| Key | Example | Required |
|-----|---------|----------|
| `SUPABASE_URL` | `https://abcd.supabase.co` | yes |
| `SUPABASE_SERVICE_KEY` | `eyJ...` (service_role) | yes |
| `internalAPIDomain` | internal user-mgmt base URL | yes (existing) |
| `mailApi` | `https://mail.spyne.ai` | yes |
| `mailRawApi` | `${mailApi}/api/v1/send-email` | only if `useDirectHtml` |
| `useDirectHtml` | `false` (template) / `true` (raw HTML) | no (default false) |
| `mailTimeoutMs` | `15000` | no |
| `mailRetries` | `2` | no |
| `liveFilterFailOpen` | `false` (fail closed) | no |
| table-name overrides | only if you renamed tables | no |

### Frontend (`frontend/.env`)
| Key | Example |
|-----|---------|
| `VITE_SUPABASE_URL` | `https://abcd.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` (anon) |

### Mail / ESP (decisions needed 🔒)
| Item | Needed for |
|------|-----------|
| Raw-HTML send endpoint contract | req 6 direct send |
| ESP (SES/SendGrid/Mailgun) + webhook signing | req 7 engagement |

---

## Testing strategy 🧪

**Unit (pure, fast):** `validateDigestPayload` cases (done manually — formalize); reason
normalizer (`dataSource.normReason`); `getTimeWindows` across timezones + DST; `filterEmailsByDept`.

**Integration (against a staging Supabase + ClickHouse read replica):**
- 3-gate eligibility returns exactly the expected teams.
- Run-store **idempotency**: two sends same day → one row (unique key).
- Recipient routing: a sales-only recipient never receives the service digest.
- Guardrail block writes `not_sent` row WITH metrics (so a human can review).

**Dry-run (safest pre-launch):** add a `dryRun` option that runs the whole pipeline
and writes `roi_digest_runs` rows but **skips the mail POST** — verify numbers + HTML
for every live team without emailing anyone.

**QA sends:** use the curl `to` override to send each template to internal inboxes;
eyeball rendering across Gmail/Outlook/Apple Mail.

**Webhook replay:** POST sample delivered/open/bounce payloads to
`engagement-webhook`; confirm `roi_engagement_events` rows + `roi_digest_runs.recipients`
flip received/bounced.

**Tracker E2E:** fire a trigger → confirm grid cell turns "Sent" → open drawer →
recipients + snippet correct.

---

## Live tracking (observability) 📊
Surface in the tracker + a lightweight dashboard:
- **Cron health:** last run time, teams processed, duration.
- **Send funnel:** eligible → passed guardrails → sent → delivered → opened.
- **Block reasons:** counts by reason (the tracker action board already does this).
- **Bounce/complaint rate** per ESP.
- **Alerts:** eligibility count drops to 0, Supabase unreachable (fail-closed),
  mail error spike, guardrail-block spike (signals a data-pipeline issue).

---

## Critical path
`1.1 → 1.2 → 1.3/1.4 → 5.3 (dry-run) → 5.4 (QA send) → 6.1 (canary) → 6.5 (ramp)`
Blockers to clear in parallel: **repo URL** (2.1), **PII decision** (1.6),
**raw-HTML contract** (2.5), **ESP choice** (2.6).
