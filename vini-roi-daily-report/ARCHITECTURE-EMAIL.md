# ROI Daily Email — System Architecture

Three runtimes, one source of truth (`roi_digest_runs`). ClickHouse is reached **only**
through Metabase **public cards** (4 params each: `team_id`, `start`, `end`, `dept`) — no
DB creds, no MCP. The hourly cron orchestrates; the tracker reads/acts on the same table.

## Components

```mermaid
flowchart TB
  subgraph SRC["ClickHouse · dealer_leads (read-only)"]
    CH[(meetings · endcallreports · conversations ·\nactionItems · campaigns · outboundTasks)]
  end

  subgraph MB["Metabase · public cards (4 params: team_id, start, end, dept)"]
    M1[["metabase-metrics.sql\n(appts · leads · conv · outbound · transfers)"]]
    M2[["metabase-action-items.sql\n(intent → count)"]]
    M3[["metabase-campaigns.sql\n(name · dials · appts)"]]
  end
  CH --> M1 & M2 & M3

  subgraph SB["Supabase · roi_* (Postgres + RLS)"]
    LD[("roi_live_departments\nis_live · dry_run  ← step 0/1")]
    CFG[("roi_rooftop_config\ntz · send_hour")]
    RCP[("roi_recipients\nemail · dept flags  ← step 1")]
    RUN[("roi_digest_runs\nSOURCE OF TRUTH:\nstatus · metrics · html · recipients")]
  end

  subgraph CRON["Hourly cron (runner.cjs / Vercel /api/cron/roi-email)"]
    O{{"orchestrator\n(every hour)"}}
  end
  LD & CFG & RCP --> O
  M1 & M2 & M3 -->|"fetch daily + MTD windows"| O
  O -->|"upsert per (team,dept,date)"| RUN

  O -->|"if live & guardrails pass & send-hour reached"| MAIL[["mail.spyne.ai\nsend-template-email\n(HTMLdata)"]]
  MAIL --> INBOX([Dealer inbox])

  subgraph UI["vini-daily-calls · /email-tracker (React)"]
    T["Rooftop Tracker tab"]
    API["/api/email/roi-send-now (Express)"]
  end
  RUN -->|"read (anon + RLS)"| T
  T -->|"Send now"| API
  API --> MAIL
  API -->|"mark sent"| RUN
```

## Hourly run — sequence

```mermaid
sequenceDiagram
  autonumber
  participant Cron as Hourly cron
  participant SB as Supabase (roi_*)
  participant MB as Metabase cards
  participant Mail as mail.spyne.ai
  Cron->>SB: load finalized set (is_live ⨝ config ⨝ recipients)
  loop each live (team, dept)
    Cron->>SB: already sent today? (status='sent')
    alt sent / no recipients
      Cron->>SB: skip / upsert not_sent(recipients_missing)
    else proceed
      Cron->>MB: metrics(team,dept, yStart,yEnd)  + metrics(month window = MTD)
      Cron->>MB: action-items(...) + campaigns(...)
      Cron->>SB: upsert status='queued' (+ metrics)
      Note over Cron: guardrails (no_data / not_actionable)
      alt fail guardrail
        Cron->>SB: status='not_sent'(reason)
      else before send-hour
        Cron->>SB: status='scheduled'
      else dry-run (DRY_RUN or dry_run flag)
        Cron->>SB: status='suppressed' (+ rendered_html)
      else SEND
        Cron->>Mail: POST template + HTMLdata
        Mail-->>Cron: 200 + messageId
        Cron->>SB: status='sent' (recipients received, html, sent_at)
      end
    end
  end
```

## Status lifecycle (one row per team·dept·daily·local_date)
`queued` (data fetched) → `not_sent` (guardrail/recipients) | `scheduled` (pre send-hour) |
`suppressed` (dry-run) | `sent` (mailed). Idempotent: existing `sent` row blocks re-send.

## Key design choices (SDE-2 notes)
- **Metabase public cards as the data port** — decouples the cron from ClickHouse creds; the
  only ClickHouse coupling is 3 saved SQL cards. 4 params keep them generic & cacheable.
- **MTD via the same card** — call metrics with a month-start window; no second query to maintain.
- **`roi_digest_runs` is the single source of truth** — cron writes it, tracker reads it; UI and
  pipeline never disagree. Idempotency key = `(team_id, department, cadence, local_date)`.
- **Dealer-local windows** — `start`/`end` computed per rooftop timezone in the cron, passed as UTC.
- **Dry-run safe by default** — real mail only when `DRY_RUN=false` AND the rooftop isn't `dry_run`.
- **Same mail contract everywhere** — cron and tracker both POST `template + templateData.HTMLdata`.
```
