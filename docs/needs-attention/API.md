# Needs attention → email API

**For the Sales Inbox backend team.** One endpoint. Call it when a conversation is flagged
**needs attention** (the customer asked something Vini could not answer, and the thread is sitting
open). We render the email, decide whether it may be sent, send it, and log it.

- Owner of this endpoint: Vini notification service (`vini-daily-calls`, `tracker-api`)
- Owner of the event: Sales Inbox backend
- Owner of the take-over link: console / inbox app (see [Take control](#take-control-the-one-thing-we-cannot-supply))

---

## 1. The call

```
POST /api/notify/needs-attention
Authorization: Bearer <NEEDS_ATTENTION_SECRET>
Content-Type: application/json
```

| Environment | Host |
|---|---|
| Today (Vercel) | `https://vini-daily-calls.vercel.app` |
| After the AWS move | `https://api-<pu>.spyne.ai/<base path>` — the path will be published with the migration; use an env var, not a literal |

Server to server only. The secret is a shared bearer token, issued by us, held in your secrets
manager. It is **not** the tracker session token and not a user token. If the secret is missing on
our side the route answers `500` and sends nothing — it never falls open.

### Request body

**Required**

| Field | Type | Notes |
|---|---|---|
| `teamId` | string | The rooftop. Must be the same `team_id` the console/DMS sync uses. |
| `conversationId` | string | The thread. Also the cooldown key. |
| `eventId` | string | **Your** id for this needs-attention event. This is the idempotency key — reuse it on every retry of the same event, and never reuse it for a different one. |
| `question` | string | **The customer's words, verbatim**, max 2000 chars. This is the email. No question ⇒ `400`. Do not paraphrase, do not send a summary, do not send the AI's reply. |

**Strongly recommended** (each one that is missing makes the email weaker, none of them are guessed on our side)

| Field | Type | Notes |
|---|---|---|
| `enterpriseId` | string | Falls back to the rooftop's configured enterprise. |
| `department` | `"sales"` \| `"service"` | Default `"sales"`. Decides which recipients get it. |
| `channel` | `"chat"` \| `"sms"` \| `"call"` | Default `"chat"`. Changes the button label and whether we show bubbles or a transcript. |
| `takeControlUrl` | string (URL) | The deep link that opens this thread **and** hands it to the human. See §4. |
| `customer` | string | Name. Absent ⇒ the email says "a customer" / "Website visitor". |
| `phone` | string | E.164 or 10 digits. Rendered as `+1 (602) 555-0137`. |
| `at` | ISO 8601 | When the question was asked. Drives the timestamp. |
| `waitingSince` | ISO 8601 | When the loop opened, if different from `at`. Drives "asked 7 min ago". |
| `reason` | string | Why Vini stopped. See §3 for the vocabulary; unknown values are humanised, not rejected. |
| `messages` | array | The tail of the thread. `{ direction: "in" \| "out", body, at }`. We keep the last 12 and show the last 8. |

**Optional**

`attempts` (int — shown as "Asked 2×" when > 1) · `intent` · `sentiment` + `sentimentScore` ·
`frustrated` (bool) · `vehicle` · `vin` · `stockNumber` · `transcript` (calls only) ·
`dryRun` (bool — see §5).

### Example

```bash
curl -sS -X POST "$VINI_NOTIFY_BASE/api/notify/needs-attention" \
  -H "Authorization: Bearer $NEEDS_ATTENTION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "teamId": "49a06313cf",
    "enterpriseId": "7d06f7427",
    "conversationId": "cnv_7f21ab",
    "eventId": "na_cnv_7f21ab_3",
    "department": "sales",
    "channel": "chat",
    "customer": "Marcus Delgado",
    "phone": "16025550137",
    "at": "2026-09-09T16:41:22Z",
    "waitingSince": "2026-09-09T16:41:22Z",
    "question": "I am still $4,200 upside down on my Tacoma. Will you roll that into the CX-5 lease or do I have to pay it down first?",
    "reason": "pricing_negotiation",
    "attempts": 2,
    "intent": "TRADE_IN_VALUATION",
    "frustrated": true,
    "vehicle": "2024 Mazda CX-5 Preferred",
    "stockNumber": "M24118",
    "vin": "JM3KFBCM1R0412887",
    "takeControlUrl": "https://console.spyne.ai/converse-ai/inbox?enterprise_id=7d06f7427&team_id=49a06313cf&conversation_id=cnv_7f21ab&takeover=1",
    "messages": [
      { "direction": "out", "body": "Hi Marcus, this is Vini at Horne Mazda...", "at": "2026-09-09T16:26:04Z" },
      { "direction": "in",  "body": "good. what would a lease run me with my trade", "at": "2026-09-09T16:33:10Z" },
      { "direction": "in",  "body": "I am still $4,200 upside down on my Tacoma...", "at": "2026-09-09T16:41:22Z" }
    ]
  }'
```

---

## 2. The response, and what to do with it

```json
{ "ok": true, "status": "sent", "id": "8f2c…", "messageId": "…", "recipients": ["javian.perry@…"],
  "teamId": "49a06313cf", "department": "sales" }
```

`status` is the contract. **A `200` does not mean an email went out** — it means we accepted the
event and reached a decision.

| HTTP | `status` | `reason` | What it means | Retry? |
|---|---|---|---|---|
| 200 | `sent` | — | Delivered to the mail service | No |
| 200 | `deduped` | `duplicate_event` | This `eventId` was already handled | No |
| 200 | `deduped` | `cooldown` | Another needs-attention email for this conversation went out inside the cooldown window (§6) | No |
| 200 | `not_sent` | `recipients_missing` | The rooftop has no verified, subscribed recipient for that department | No — a human has to add/verify one |
| 200 | `not_sent` | `type_disabled` | The rooftop opted out of this email | No |
| 200 | `not_sent` | `unknown_rooftop` | That `teamId` is not onboarded to notifications | No — but tell us, it usually means a wrong id |
| 200 | `not_sent` | `no_value` | Nothing actionable in the payload | No — fix the payload |
| 200 | `suppressed` | `dry_run` | Rooftop or environment is in dry run; recorded, not sent | No |
| 200 | `suppressed` | `churned` | Churned rooftop. We never email these | No |
| 200 | `preview` | — | `dryRun` request; `renderedHtml` returned, nothing sent, nothing logged | No |
| 400 | — | — | Bad payload. `error` says which field | **Never.** Fix and re-send |
| 401 | — | — | Bad or missing bearer token | No |
| 502 | `error` | — | Mail service failed. The event is logged as `error` | Yes, same `eventId` |
| 500 | — | — | Our side broke | Yes, same `eventId` |

**Retry rule:** retry only `5xx`, `502` and network/timeout failures, with the **same `eventId`**,
with backoff. The dedupe key makes that free. Never retry a `400`, and never mint a fresh `eventId`
to "force" a send — that defeats both the dedupe and the cooldown and lands two emails on a
salesperson.

**Timeout:** allow 15s. We call an external mail service inside the request.

---

## 3. `reason` vocabulary

Known values render as a sentence. Anything else is humanised (`some_new_reason` → "Some new
reason"), so a new value never breaks the email — but it also never reads as well, so tell us when
you add one.

| Value | Renders as |
|---|---|
| `unanswered_question` | Vini had no answer for what the customer asked |
| `no_knowledge` | Not in Vini's knowledge base for this rooftop |
| `out_of_scope` | Outside what Vini is allowed to answer |
| `low_confidence` | Vini wasn't confident enough to answer |
| `pricing_negotiation` | Customer is negotiating price |
| `trade_valuation` | Customer wants a number on their trade |
| `human_requested` | Customer asked for a person |
| `repeat_question` | Customer asked the same thing again |
| `escalation` | Escalation phrase in the thread |

---

## 4. Take control — the one thing we cannot supply

The email's only button is **"Take over this chat"**. The route that opens a thread and hands it to
a human belongs to the inbox app, so **send us `takeControlUrl`**.

Without it we fall back to the rooftop's conversations list. That is an honest degraded link, not a
take-over — the manager lands on a list and has to find the thread. Ship the real URL.

What the URL has to survive, because it is being clicked out of an email:

1. **An unauthenticated click.** The reader may not have a console session in that browser. It must
   bounce through SSO and come back to *this* thread, not to a dashboard.
2. **A late click.** Someone opens it 40 minutes later, after a colleague already took over. It
   should say so rather than silently reassigning.
3. **A shared inbox.** Several recipients can get the same email and click it. First click wins;
   the rest need a clear "already with <name>".
4. **A stable id.** The link carries `conversationId`, not a session-scoped token.

Confirm with the inbox app which of those four hold today. Anything that doesn't is a known gap, not
a surprise to discover in front of a dealer.

---

## 5. Integrating without emailing anyone

Send `"dryRun": true` (or `?dryRun=1`). We validate, render, and return the HTML in
`renderedHtml`. Nothing is sent, no row is written, no cooldown is consumed. Use it to eyeball the
email against real conversations before the first live send.

For an end-to-end test that exercises the gates and the ledger, ask us to point you at a test
rooftop — `Umang_Sharma_Testing` (`team_id=3769f9d53b`) exists for exactly this and has no verified
recipients, so a live call there returns `not_sent / recipients_missing` and still writes the audit
row.

---

## 6. What we do on our side (so you don't have to)

You send every needs-attention event. We decide whether it may reach a human, in this order:

1. **Rooftop known** — `teamId` exists in the notification config.
2. **Churn gate** — a churned rooftop is never emailed.
3. **Rooftop opt-out** — `needs_attention_enabled`, default ON.
4. **Dry run** — environment or rooftop.
5. **Cooldown** — **one needs-attention email per conversation per 30 minutes**
   (`NEEDS_ATTENTION_COOLDOWN_MIN`). A thread that stumps the AI three times in five minutes
   produces three events, three ledger rows, and one email. The human is already in the thread
   after the first one.
6. **Dedupe** — unique on `(rooftop, type, eventId)`.
7. **Recipients** — only addresses a human has **verified** for that rooftop and department, that
   have email enabled, and that are subscribed to this type. Then role tiering: the assigned
   salesperson if there is one, else the BDC, else the GM.
8. **Value gate** — an email with nothing to act on is refused rather than sent.

Every outcome writes a row in the event ledger with the rendered HTML, so the email tracker shows
the event whether or not it went out, and a held email can be inspected or sent by hand.

### Why not call `mail.spyne.ai` directly

You could POST the mail service yourself. Don't — every one of the eight gates above lives on this
side of it, plus the tracker row and the open tracking. A direct send can email an unverified
address, a churned dealer, or the same salesperson four times about one thread, and none of it
shows up in the tracker. That is the failure the verified-recipient gate was built after.

---

## 7. Before the first live call — our prerequisites

Not yours, but you are blocked on them, so they are worth tracking:

- [ ] Migration `src/programs/schema-needs-attention.sql` applied (new email type + rooftop column).
      **Until this runs, every live call answers 500.**
- [ ] `NEEDS_ATTENTION_SECRET` issued and set on the tracker API.
- [ ] `DRY_RUN=0` on the environment you are pointed at, or everything comes back
      `suppressed / dry_run`.
- [ ] At least one **verified** recipient on the pilot rooftop, subscribed to `needs_attention`.
- [ ] Pilot rooftop list agreed. This is a new email in a manager's inbox; it goes to one or two
      rooftops first, not the fleet.
- [ ] Email tracker column for the new type (internal only, does not block you).

---

## 8. Open questions

1. **Does the AI stay muted after a take-over?** The email says "Taking over pauses Vini on this
   thread and puts you in it." If the inbox does not actually pause the AI, that sentence is wrong
   and has to change before launch.
2. **Escalation when nobody clicks.** Today: one email, then silence for 30 minutes. No second
   email, no SMS, no "still unanswered after an hour". Decide whether an unclaimed thread should
   escalate, and to whom.
3. **Resolution signal.** We have no event for "a human took over". Sending one
   (`conversationId` + who) would let us stop a queued escalation and report how long threads sit
   unclaimed — the number that tells a GM whether this feature is working.
4. **Service department.** Same endpoint works with `department: "service"`, but the copy is written
   for a sales thread. Worth a read before pointing service traffic at it.
