/* Shared subscription + routing logic for the ROI notification system (digests + transactional,
 * email + SMS). Single source of truth used by runner.cjs, eventRunner.cjs, and mirrored (thin) in
 * the tracker UI (src/email/dataSource.ts).
 *
 * Model: roi_recipients.subscriptions is a JSONB matrix { "<type>": { "email": bool, "sms": bool } }.
 * A MISSING key means "use the default" (defaultSub), so an empty '{}' preserves today's behavior.
 * The matrix layers UNDER the per-channel master switches (email_enabled/sms_enabled), the dept
 * routing (receives_sales/service), and the rooftop-level gates (config.<type>_enabled + sms_enabled).
 */

// The 7 notification types (bare keys — NOT the roi_rooftop_config "<type>_enabled" column names).
// 'chat' (website-chat emails) is a SUBSCRIPTION-ONLY key on top of these: those emails store as
// email_type=post_conversation (tracker/dedupe grain) but recipient-match on their own 'chat' cell,
// so a recipient's call-summary opt-out doesn't silence chat. It is deliberately NOT in these lists
// (nothing that iterates email types should treat it as a distinct type).
const DIGEST_TYPES = ["daily", "weekly", "monthly"];
const TRANSACTIONAL_TYPES = ["post_appointment", "post_conversation", "action_item", "action_item_overdue"];
const ALL_TYPES = [...DIGEST_TYPES, ...TRANSACTIONAL_TYPES];
const CHANNELS = ["email", "sms"];
// Recognised recipient roles. LABELS ONLY — they describe who a recipient is (shown in the
// tracker), they do NOT route or filter a send. See pickTieredRecipients.
const ROLE_TIERS = ["salesperson", "bdc", "gm"];

const isDigest = (type) => DIGEST_TYPES.includes(type);

/** Default subscription when a recipient has no explicit cell for (type, channel).
 * email: every type ON (preserves "email_enabled person receives every rooftop-enabled type").
 * sms:   transactional ON (preserves current transactional SMS); digests OFF (opt-in only);
 *        'chat' OFF — chat is email-only today (no smsBody is ever built), and if that changes
 *        it must be an explicit opt-in, never a new key silently defaulting SMS on. */
function defaultSub(type, channel) {
  if (channel === "email") return true;
  if (channel === "sms") return !isDigest(type) && type !== "chat"; // digests + chat default off
  return false;
}

/** Parse the subscriptions blob (Supabase returns jsonb as an object, but tolerate a string). */
function subsOf(recip) {
  const s = recip && recip.subscriptions;
  if (!s) return null;
  if (typeof s === "string") { try { return JSON.parse(s); } catch { return null; } }
  return typeof s === "object" ? s : null;
}

/** Is this recipient subscribed to (type, channel)? Explicit cell wins; else the default. */
function isSubscribed(recip, type, channel) {
  const subs = subsOf(recip);
  const cell = subs && subs[type];
  const v = cell ? cell[channel] : undefined;
  return typeof v === "boolean" ? v : defaultSub(type, channel);
}

/** CHURN SEND-GATE — a churned rooftop must never be emailed or texted, on any cadence or path.
 *
 * This is the ONE place the send path consults the lifecycle stage, and that asymmetry is
 * deliberate: onboarding/contracting rooftops SHOULD send (their AI is often already working
 * for the dealer, and the stage labels lag reality badly — 35 'PWS' rooftops are stamped Live
 * by the platform, 6 'OB-Live' ones are mid-onboarding). Gating on those would silence real
 * customers. Churn is the only stage where sending costs more than not sending, so it's the
 * only carve-out.
 *
 * Honours a past churn_date directly as well as the derived status: the ARR ledger's bucket
 * lags the date (the same reason syncLifecycle applies its own past-churn_date override), so a
 * rooftop can sit at lifecycle_status='live' with a churn_date two weeks gone.
 *
 * @param cfg    roi_rooftop_config row (needs lifecycle_status + churn_date selected)
 * @param onDate dealer-local YYYY-MM-DD being reported/sent
 * Fail-open: a missing config row or unparseable date is NOT churned, matching how the rest of
 * the send path treats missing config. */
function isChurned(cfg, onDate) {
  if (!cfg) return false;
  if (String(cfg.lifecycle_status || "").toLowerCase() === "churn") return true;
  const churn = cfg.churn_date ? String(cfg.churn_date).slice(0, 10) : "";
  const on = String(onDate || "").slice(0, 10);
  return Boolean(churn) && Boolean(on) && churn <= on;
}

/** TRANSACTIONAL routing — every eligible recipient is kept. Identity function by design.
 *
 * This used to be a role-tiered fallback: of an eligible list, only the first non-empty tier
 * (salesperson → bdc → gm) was emailed. That silently EXCLUDED people who had been added to a
 * rooftop, verified by a human, and left email_enabled — a GM behind a BDC got nothing, and a
 * recipient with no role at all got nothing the moment ANY colleague had a role set. It was
 * invisible from the tracker (which shows them as active recipients) and invisible in the send
 * path (no suppressed/not_sent row is written for someone who was filtered out before the send),
 * so "the automatic emails stopped" was the only symptom. It also disagreed with the manual
 * "Send to customer" button, which never tiered — the same rooftop got two different audiences.
 * On 2026-08-12 it was dropping 57 verified recipients across 26 rooftops.
 *
 * The product rule is now: exclusion is an EXPLICIT act, never a derived one. To stop emailing
 * someone, turn off their email_enabled / subscriptions cell, or remove them. `role` is a label.
 *
 * Kept as a named pass-through (rather than deleting the call sites) so the routing decision has
 * one documented home — if per-role routing ever comes back it must be opt-in per rooftop, and it
 * belongs here. */
function pickTieredRecipients(recips) {
  return Array.isArray(recips) ? recips : [];
}

module.exports = {
  DIGEST_TYPES, TRANSACTIONAL_TYPES, ALL_TYPES, CHANNELS, ROLE_TIERS,
  isDigest, defaultSub, isSubscribed, pickTieredRecipients, isChurned,
};
