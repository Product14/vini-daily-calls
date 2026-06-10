# ROI Daily Report — architecture & schema

## 1 · Schema (entity-relationship)

Logical relationships are keyed by `team_id` (globally unique, confirmed) and
`message_id` / `run_id`. Supabase tables are not hard-FK'd to ClickHouse/Mongo.

```mermaid
erDiagram
    roi_live_departments {
        text team_id PK
        text department PK
        boolean is_live
    }
    roi_rooftop_config {
        text team_id PK
        text enterprise_id
        smallint digest_send_hour
        smallint digest_send_minute
        text timezone
        boolean daily_enabled
    }
    roi_recipients {
        uuid id PK
        text team_id
        text email
        boolean receives_sales
        boolean receives_service
        boolean email_enabled
    }
    roi_digest_runs {
        uuid id PK
        text team_id
        text enterprise_id
        text department
        text cadence
        date local_date
        text status
        text reason
        jsonb metrics
        text rendered_html
        text message_id
        timestamptz sent_at
    }
    roi_engagement_events {
        uuid id PK
        uuid run_id FK
        text message_id
        text recipient_email
        text event_type
        timestamptz occurred_at
    }
    roi_rooftop_config    ||--o{ roi_digest_runs : "team_id"
    roi_live_departments  ||--o{ roi_digest_runs : "team_id + department"
    roi_recipients        ||--o{ roi_digest_runs : "team_id"
    roi_digest_runs       ||--o{ roi_engagement_events : "run_id / message_id"
```

## 2 · System architecture & data flow

```mermaid
flowchart TD
    CRON["dailyDigest cron"] --> ELIG{"Eligibility gate<br/>Mongo AND ClickHouse AND LIVE"}
    MG[("MongoDB<br/>conversationNotifications")] --> ELIG
    CH[("ClickHouse<br/>teamAgentMappings + metrics")] --> ELIG
    LIVE["roi_live_departments"] --> ELIG

    ELIG --> CFG["roi_rooftop_config<br/>req 2 send-hour"]
    CFG --> GATE{"Send-hour gate<br/>dealer-local"}
    GATE -->|before hour| RUNS
    GATE -->|ok| RECRES["Resolve recipients<br/>Mongo opt-in AND roi_recipients dept routing"]
    MG --> RECRES
    REC["roi_recipients<br/>req 3"] --> RECRES

    RECRES -->|none| RUNS
    RECRES --> METRICS["ClickHouse metrics<br/>step 1 + 2"]
    CH --> METRICS
    METRICS --> GUARD{"Guardrails<br/>req 4"}
    GUARD -->|fail| RUNS
    GUARD -->|pass| RENDER["Render HTML<br/>req 6"]
    RENDER --> SEND["mail-send<br/>template OR raw_html"]
    SEND --> MAIL[("mail.spyne.ai")]
    SEND --> RUNS["roi_digest_runs<br/>req 1 + 5<br/>status + reason + metrics + html"]

    MAIL --> WH["engagement webhook"]
    WH --> ENG["roi_engagement_events<br/>req 7"]
    ENG --> RUNS

    RUNS --> TRACKER["ROI Tracker UI"]
    ENG --> TRACKER
    TRACKER -->|classify live| LIVE
    TRACKER -->|edit send-hour| CFG
    TRACKER -->|edit recipients| REC
    TRACKER -->|retry / send now| CRON
```

## 3 · Component split

```mermaid
flowchart LR
    subgraph backend["notification-service (Sails.js)"]
        direction TB
        crons["crons + trigger-email-service"]
        queries["queries: live / eligibility / config / metrics"]
        services["services: digest-store / html-render / mail-send / engagement"]
        api["api: trigger + engagement-webhook + tracker reads"]
    end
    subgraph store["Supabase (Postgres)"]
        tables["5 roi_* tables"]
    end
    subgraph frontend["ROI Tracker (React/Vite)"]
        grid["rooftop x date grid + drawer"]
    end
    backend <--> store
    frontend <--> store
    frontend -->|actions| api
```
