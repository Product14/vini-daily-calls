# ABR Trends (`/abr-trends`)

> **Now covers calls as well as SMS.** `vini_funnel_base.sql` is the channel-aware spine;
> the three `vini_funnel_extract_*.sql` files are what the dashboard is built from. The
> `vini_sms_*.sql` files are the SMS-only predecessors, kept for reference.

Diagnostics for changes in SMS appointment-booking and reply rates, for sales inbound,
sales outbound and service outbound agents. The question this answers: *appointments are
down, which step broke and when.*

Scan **down** the conversion columns to find the step, **across** the weeks to find the
week, then drop into the drill-down to find the specific item.

## The queries

**Rooftop breakdown moved out** of the dashboard on 2026-08-14 — it is getting its own
tab. `vini_funnel_extract_rooftops.sql` is kept ready for it.

| File | Grain | Status |
|---|---|---|
| `vini_sms_funnel_weekly.sql` | week × rooftop × agent_bucket × capability | **Ready** |
| `vini_sms_drilldown.sql` | grain × period × agent_bucket × family × item | **Ready** |
| `vini_sms_pitch_funnel.sql` | week × rooftop × agent_bucket × capability | **Parked**, see below |

All three are single ClickHouse statements with no trailing semicolon (what the MCP
`run_query` tool and the existing report routines expect). Edit `date_from` /
`date_to_excl` at the top of the `WITH` block. The drill-down also takes a
`team_filter` for single-rooftop drill-in.

**The funnel**: leads attempted → texted (delivered) → replied → action item →
qualified → tool call → booked.

**The drill-down** is long-format and covers three families with identical treatment,
so "same breakdown for tool calls" is the same query with a different `family` filter:

- `family = 'action_item'` → `dealerActionItems[].intent`, e.g. `SALES_LOST_LEAD`
- `family = 'tool_call'` → tool function name, e.g. `sales_create_meeting`
- `family = 'outcome'` → `conversationAnalytics.outcome`, e.g. `Purchase Intent`

`grain` is `day` / `week` / `month`, giving DoD / WoW / MoM from one query. Each row
carries `delta_events`, `delta_leads`, `delta_*_pct`, `pct_of_family_events`,
`booked_leads` and `item_to_booked_pct`.

## Read this before building anything on top

Every count is **distinct leads** (`uniqExact(lead_id)`), not conversations.

1. **Do not sum across rollup dimensions.** Both queries emit pre-computed rollup rows.
   In the funnel use `capability = 'All Capabilities'`; in the drill-down use
   `agent_bucket = 'All Agents'` and pick one `grain`. Summing the per-value rows
   double-counts leads that span several buckets. Never average the `_pct` columns,
   re-derive them from the counts.
2. **Do not sum `booked_leads` across `item`** in the drill-down. One lead carries
   several tools and action items, so this gives roughly 4x the true count. The
   `outcome` family is the exception and reconciles exactly to the funnel (1,195
   bookings, Jun 1 – Aug 13 2026). Use that as the cross-check between the two files.
3. **Weeks are Monday-start UTC, not rooftop-local.** Immaterial at weekly grain. If
   anyone adds local-day bucketing, read the timezone note in the funnel header first:
   ClickHouse `multiIf` returns the timezone of its first `DateTime` branch and renders
   every row in it. `vini_reporting.rmv_conversation_fact.after_hours` still has the
   broken version and buckets every rooftop in `America/New_York`. Do not copy it.
4. **`sales_outbound` booked is a floor, not the rate.** Strict conversation attribution
   misses outbound-warmed leads that close on a call, since those meetings carry a
   `call_id` instead. The trend within the bucket is still valid; the level is not
   comparable to `sales_inbound`.
5. **`leads_action_item` is not "agent activity".** `SALES_LOST_LEAD` (the agent giving
   up) is ~76% of structured action items and did not exist before the week of
   2026-06-29. Use `leads_action_item_productive` and
   `reply_to_productive_action_item_pct`. The raw column rose 42% → 66% over the same
   period that productive activity fell 42% → 30%.
6. **Guard columns.** `booked_leads_unreplied` and `unmapped_outcome_leads` should both
   be 0. Non-zero means a data-quality change, not a metric movement:
   - `booked_leads_unreplied` → a new variant of the pre-existing-appointment pattern
     that the 30s rule does not catch.
   - `unmapped_outcome_leads` → the outcome vocabulary moved and the qualified arrays
     at the top of both files need updating.
   - `leads_with_analytics` should track `replied_leads`. A gap means analytics
     generation is lagging, so qualified and action-item counts are understated.

## Definitions that were deliberate, not incidental

- **Booked** = `meetings.conversation_id` matches the SMS conversation, `is_active = 1`,
  `source` is `'spyne'` or `NULL`, **and** the meeting was created more than 30s after
  the conversation started. That last clause excludes an equity-mining campaign that
  texts customers who *already* have a service appointment and writes the meeting row
  in the same second, with `source = 'spyne'`. 306 of 1,513 "bookings" were this.
  Surfaced separately as `preexisting_appt_leads`.
- **`status = 'failed'` conversations are NOT excluded**, unlike
  `apps/reporting-vini/vini_capability_split.sql` and the Metabase funnel. That status
  *is* the failed-delivery population. Excluding it makes `delivery_rate` read ~99% and
  hides ~12% of attempted volume. `leads_texted` still reconciles with those queries
  because it is gated on `delivered_out`, which is narrower. **Do not "align" this
  back.**
- **Qualified** uses two disjoint allowlists (sales and service) because the two
  departments share no outcome vocabulary. A single list scores every service
  conversation 0% qualified. Both arrays sit at the top of each file and are the only
  place to edit them. They are currently byte-identical across the two files; keep them
  that way.
- **Tool names** live on the assistant message under **two** key spellings,
  `toolCalls` and `tool_calls`. Both must be read; one gives ~5% coverage. No single
  substring covers both (`'oolCall'` matches `toolCalls` but not `tool_calls`).

## Channel differences that are not obvious

- **Calls have a real Engaged step**, and it is the TV Wall's `connected`: reached AND a
  `role='user'` turn in the transcript. Both conditions are required because neither
  implies the other — 187,870 calls have a user turn but only 113,643 are non-voicemail
  (voicemail transcripts contain user turns too). Reached 48.6%, Engaged 30.1% across all
  calls, so the two steps are genuinely distinct.
- **SMS booked requires a booking tool call; calls require only the `call_id` join.**
  An equity-mining campaign stamps `conversation_id` onto CRM-imported **service**
  appointments it merely references, so the SMS join alone credited 810 meetings / 306
  leads to conversations that booked nothing. That is **mis-attribution, not double
  counting** — 810 meetings, 810 distinct `meeting_id`s, 810 distinct lead+slot pairs, 0
  with a `call_id`. Each appointment is counted once. The upstream defect is
  `source='spyne'` being set on CRM-imported appointments no AI booked.
  The booking-tool test separates them cleanly: **98.8%** of genuine SMS bookings invoked
  `sales_create_meeting` / `service_create_appointment_v2` vs **0%** of the reference
  cohort. It replaced an earlier >30s timing proxy that produced an identical lead count.
- **Do not use `external_crm_appointment_id` as the discriminator.** It looks perfect
  (100% of the reference cohort has one) but **45.2% of genuine bookings have one too**,
  because Vini syncs its own bookings back to the dealer CRM. It would silently drop 569
  real bookings.
- Calls need no such test — `call_id` is only written by the booking flow. Requiring the
  tool there would drop 78 of 3,969 bookings where the AI warm-transferred and a human
  booked. Also note `conversations.createdAt` for a call is the call *end*, so an in-call
  booking timestamps *before* it (median −68s); any "after-only" rule kills 98% of them.
- **Call tool calls come from `endcallreports.callDetails_messages`**, keyed on `callId`,
  and use the **camelCase `toolCalls` spelling only** — no `tool_calls`, no `role:"tool"`,
  no `tool_call_id`. SMS needs both spellings; calls need one. `tool_key` in the spine
  carries the differing join key.
- **Callback re-attribution applies to calls only.** Inbound callbacks from outbound
  campaigns are credited to Outbound. Omit it and the split is wrong in both directions.
- **`end_call` and `warm_transfer` dominate the call tool drill-down** (12,051 and 8,044
  leads) the way `SALES_LOST_LEAD` dominates action items. They are mechanical, not
  intent. Not excluded — the matrix enumerates so you can see them.
- **Calls add four agent buckets** SMS never had: `service_inbound`,
  `receptionist_inbound`, `receptionist_outbound`, `sales_unknown`. `receptionist` has no
  qualified allowlist and will read 0% qualified.
- **All Conversations dedupes leads.** 4,785 booked leads in All vs 4,799 summing SMS and
  calls — 14 leads booked on both channels. Never offer a summed total.

## ⚠️ Call outcome taxonomy changed around 20 Jul 2026

`General Engagement` — which **is** in the qualified allowlist — collapses across sales
inbound calls: 1,596 → 1,533 → 1,332 → 888 → 265 → 216 → 151 for the weeks of 29 Jun
through 10 Aug. Over the same weeks `Could Not Conclude`, which is **not** qualified,
appears from 20 Jul and grows: 0 → 0 → 0 → 310 → 621 → 593 → 382.

Outcome coverage is 100% every week, so this is not report lag. Calls previously labelled
`General Engagement` are now labelled `Could Not Conclude`, and the call Qualified rate
drops 88.6% → 18.6% as a direct result. **That is a relabelling, not an agent regression.**
Same class of trap as the 29 Jun action-item taxonomy migration. Do not read the call
Qualified trend across 20 Jul without accounting for it, and consider whether
`General Engagement` — a catch-all — belongs in the qualified set for calls at all.

## Known state, as of 2026-08-14

**The current diagnosis.** `sales_inbound` replied→booked fell 10.41% (week of Jul 6) →
6.52% → 3.90%, tracking `sales_create_meeting` tool calls 1:1 (129 → 43 → 24 leads).
Delivery, reply rate and qualified% all held; qualified% is at its August high. The
agent stopped calling the booking tool. Secondary: the structured action-item taxonomy
including `SALES_LOST_LEAD` shipped the week of Jun 29, two weeks earlier. Correlated,
not proven causal.

Highest-converting tools by `item_to_booked_pct` (sales_inbound, July): `sales_create_meeting`
97.6%, then **`dealership_check_hours` 51.6%** — a customer asking opening hours is the
second-strongest booking signal, ahead of inventory search at 14%.

**Open items.**

- **Service qualified list is not calibrated.** Three members convert at 0–2%
  (`Customer Open To Return` 0%, `Customer Considering` 1.5%, `Callback Requested`
  2.2%) while the strongest *excluded* outcome, `Customer Already Self Booked`,
  converts at 33.2%. Six other members are too low-volume to calibrate. The sales list
  is data-calibrated; this one is not yet.
- **`vini_sms_pitch_funnel.sql` is blocked on two things**, only one of which a backfill
  fixes. Coverage: funnelEval SMS data starts ~2026-08-01 (~1% of texted leads in June
  rising to ~93% by Aug 3), so any trend across that boundary is backfill. Wiring:
  `step1_conversationReached`, `step6_bookingToolCalled` and
  `step7_crmAppointmentWritten` pass **0 of 60,994** SMS conversations. They are the
  three deterministic steps and they read voice-side sources — `step6` reads
  `conversation_ai.tool_invocation_events`, which has zero SMS rows. That is an
  eval-pipeline bug; a backfill will not fix it. Only `step2`–`step5` carry signal, so
  the file can show pitch suppression but not whether the booking tool fired or the CRM
  was written. Run the coverage check at the bottom of that file before trusting it.
- **`bdc`-source meetings**: 2,663 carry a `call_id`. Those are warm transfers that
  converted. Irrelevant here (only 3 have a `conversation_id`) but a call-side funnel
  filtering on `source = 'spyne'` alone would undercount transfers substantially.
