# Configurations to be done — YOUR action items only

Everything else is built + wired. These are the values only you can provide.
Emails are currently HARD-OFF (dry-run). Nothing sends until you flip `dryRun`.

## ✅ Already done (no action needed)
- Supabase project `pbhrglcpwhevrttipctk` — 5 tables created, RLS, realtime, seed team
- Frontend `.env` written (URL + anon key) — tracker reads live data
- Dry-run guard active — pipeline runs but sends nothing

---

## 1 · Backend env / `config/custom.js`  (REQUIRED)
You must supply the **service_role** key (I deliberately never fetched it).
Get it from: Supabase → Settings → API → `service_role` (secret).

```js
module.exports.custom = {
  // Supabase (service key = secret, backend only)
  supabaseUrl:        'https://pbhrglcpwhevrttipctk.supabase.co',
  supabaseServiceKey: '<PASTE service_role KEY>',          // ← you

  // Mail — leave dryRun TRUE until you explicitly want to send
  dryRun:             true,                                 // ← flip to false to go live
  mailApi:            'https://mail.spyne.ai',
  useDirectHtml:      false,                                // true = send our raw HTML
  mailRawApi:         'https://mail.spyne.ai/api/v1/send-email', // ← CONFIRM real endpoint
  mailTimeoutMs:      15000,
  mailRetries:        2,

  // Existing internal API (already in your Sails app)
  internalAPIDomain:  '<your existing internal API base>',

  // Eligibility safety
  liveFilterFailOpen: false,                                // false = no Supabase => no send

  // BCC delivery confirmation (optional; off until domain ready)
  bccEnabled:         false,                                // ← true when track domain set
  bccTrackDomain:     'track.spyne.ai',                     // ← a mailbox you control
};
```

## 2 · Install the Supabase client in the real backend repo
```
npm i @supabase/supabase-js
```

## 3 · Add the two routes to `config/routes.js`
```js
'POST /v2/notification/trigger-daily-digest': 'v2/notification/trigger-daily-digest',
'POST /v2/notification/engagement-webhook':   'v2/notification/engagement-webhook',
```

## 4 · Decisions only you can make
| Decision | Why it matters | Default in place |
|----------|----------------|------------------|
| **PII / tracker auth** | tracker currently reads via anon key (dealer PII exposed). Add Supabase Auth or proxy reads before prod. | anon-read ON (prototype) |
| **Raw-HTML mail endpoint** | confirm mail.spyne.ai's real raw-send path + payload | assumed `/api/v1/send-email` |
| **ESP for engagement** | SES / SendGrid / Mailgun — fixes webhook field mapping + signing | generic mapping |
| **When to send for real** | flip `dryRun:false` | dryRun TRUE (safe) |

## 5 · Per-rooftop data to load into Supabase (when ready)
Populate from your real rooftop list (SQL templates in `SQL_VALIDATION.md`):
- `roi_live_departments` — which teams are actually live (sales/service)
- `roi_rooftop_config` — send hour per rooftop
- `roi_recipients` — who gets sales vs service emails
