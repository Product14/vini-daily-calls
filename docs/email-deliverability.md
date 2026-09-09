# Email deliverability — not sending to addresses that fail

## The problem

Bounces are scored against the **sending domain**, not the rooftop. A handful of addresses that
can never accept mail — a typo'd `@gmial.com`, an advisor who left the store, a mailbox that was
closed — get hit by the digest cron every morning and by every transactional event on top. That
steady drip of bounces is what moves `spyne.ai` from inbox to spam **for every dealer we mail**,
including the ones whose addresses are perfectly good.

Before this change there was nothing stopping it:

- The address filter was an **unanchored** `/\S+@\S+\.\S+/`, so `Bob Smith <bob@x.com>`,
  `a@x.com, b@y.com` and `john smith@dealer.com` all passed the check and went out as-is.
- The senders write `recipients[].received = true` the instant the mail proxy accepts the
  message, and **nothing ever contradicted it**. A bounce an hour later was invisible.
- `roi_engagement_events` and `roi_digest_runs.recipients[].bounced` exist, but the only thing
  that ever wrote them was `supabase/functions/mail-webhook` — a **Resend** webhook, while sends
  actually go through `mail.spyne.ai`. It was never receiving anything.
- A mail-proxy rejection was recorded as `status='error'` with the reason text on the run, and
  nobody read it. On the transactional path even the body was thrown away (`mail ${res.status}`).

So a dead address was mailed forever.

## The gate

`server/roi-cron/emailHealth.cjs` is the single place that decides whether an address may be
mailed. Two layers, either of which stops a send:

| Layer | What it catches | Decided from |
|---|---|---|
| **Structural** | malformed, a display name or a list pasted into one field, a reserved TLD (`.local`, `.lan`, `example.com`), a known typo of a big mailbox provider (`@gmial.com` → `@gmail.com`) | the string alone — works before the address has ever been mailed |
| **Suppressed** | the address *has* been mailed and it failed: a hard bounce, a spam complaint, or a mail-proxy rejection | `roi_recipients.suppressed_at` (migration `0023`) |

Every send path calls it, so no route can honour only one gate:

| Path | File |
|---|---|
| Daily / weekly / monthly digests | `server/roi-cron/runner.cjs` → `subscribedEmails()` |
| Transactional events | `server/roi-cron/eventRunner.cjs` → `emailsForType()` |
| Needs-attention push | `server/roi-cron/needsAttention.cjs` |
| Tracker "Send now" (digest) | `POST /api/email/roi-send-now` |
| Tracker "Send now" (stored event) | `POST /api/email/roi-event-send-now` |
| Tracker "Send to customer" | `POST /api/email/roi-event-generate-send` |
| Adding / editing a recipient | `POST /api/recipients`, `POST /api/recipients/update` |

`sendMailRaw()` in both runners also drops undeliverable addresses immediately before the POST, so
a manual or backfill caller passing raw addresses cannot get round the gate.

### A hold, never a delete

A failed address is held, not removed. The row stays in the tracker with the reason on it, so a
CSM can see why that person stopped receiving and fix the address. A deleted row is re-seeded by
the recipient sync and starts bouncing again with nobody the wiser.

**Fixing the address lifts the hold automatically** (`/api/recipients/update` clears
`suppressed_at` when the email actually changes). "Release the hold anyway" exists in the tracker
but is the wrong tool: if the address is still dead it bounces again and is re-held.

## How an address gets held

1. **The mail proxy rejects it.** `sendMailRaw` classifies the error body
   (`classifySendFailure`). On a *hard* rejection it suppresses the named address and re-sends to
   the rest of the batch — one dead address no longer silences a whole rooftop's send. If the
   proxy didn't name the offender, it walks the batch one address at a time. Soft failures
   (mailbox full, greylisting, rate limit) are counted, not suppressed; three in a row suppresses.
   **`unknown` never suppresses** — an auth failure or a bad template is our problem, not the
   recipient's, and must not silence a live rooftop.
2. **A bounce/complaint webhook arrives** at `POST /api/email/bounce` → suppressed.
3. **The daily sweep** (`deliverabilityAudit` in `runner.cjs`, one UTC hour, default 15:00) holds
   anything undeliverable by construction and folds in the last 36h of bounce events. It posts
   what it held to the Slack breakage channel.

## What still needs wiring — the one dependency

**Automatic *bounce* suppression is inert until the mail provider is pointed at
`POST /api/email/bounce`.** Everything else works today; asynchronous bounces do not, because
nothing currently reports them to us. The endpoint reads Resend, SendGrid, SES (raw and inside
its SNS envelope) and a plain `{email, type}`, so whichever ESP `mail.spyne.ai` fronts, it needs
no code change — only:

- the webhook URL configured on the provider (or on the proxy, if the proxy owns the ESP account),
- `MAIL_WEBHOOK_SECRET` set on this server and sent as `Authorization: Bearer <secret>`.

The route **fails closed**: with no secret configured it returns 500 rather than accepting
unauthenticated writes, because an open route would let anyone silence a rooftop by POSTing a fake
bounce for its GM.

The Resend edge function at `vini-roi-daily-report/supabase/functions/mail-webhook/` is the older,
never-connected version of this. Leave it or delete it — do not wire both.

## Cleaning up what is already in the book

```bash
# report only — changes nothing
ROI_SUPABASE_SERVICE_KEY=sb_secret_… node scripts/audit-bad-recipients.mjs

# put the holds on
ROI_SUPABASE_SERVICE_KEY=sb_secret_… node scripts/audit-bad-recipients.mjs --apply

# just the address strings, no history scan
… node scripts/audit-bad-recipients.mjs --apply --structural-only
… node scripts/audit-bad-recipients.mjs --csv > bad-addresses.csv
```

It ranks evidence worst-first (provider bounce → recorded bounce flag → proxy rejection →
structurally undeliverable) and only reports addresses that are **still being mailed** — an
address on a disabled or unverified row is already held by another gate.

It **requires the real `sb_secret_` service key**. `roi_*` is RLS-locked and the key in the repo's
local `.env` is a publishable one: with that key every read returns `[]` and the script would
report a clean book. It checks the key prefix and refuses rather than lying to you.

## Tuning

| Env | Default | Meaning |
|---|---|---|
| `SOFT_BOUNCE_LIMIT` | `3` | consecutive soft bounces before an address is held |
| `DELIVERABILITY_AUDIT_UTC_HOUR` | `15` | the hour the daily sweep runs |
| `MAIL_WEBHOOK_SECRET` | — | bearer secret for `POST /api/email/bounce` (falls back to `CRON_SECRET`) |

## Tests

`node server/roi-cron/__tests__/emailHealth.test.mjs` — 82 assertions. The **false-positive**
block matters more than the false-negative one: wrongly holding a real dealer address silently
stops a GM's digest, which is worse than one extra bounce. Add any address shape you are unsure
about to that block before changing the validator.
