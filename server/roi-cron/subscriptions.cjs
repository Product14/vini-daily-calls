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
// Role fallback order for transactional routing: prefer the salesperson, escalate to the "parent".
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

const normRole = (r) => String(r || "").trim().toLowerCase();

/** Role-tiered fallback for TRANSACTIONAL routing. Given an already channel+dept+subscription
 * eligible list, return the first non-empty tier (salesperson → bdc → gm). If NO recipient has a
 * tier role set, return the whole list (backward compatible — the rooftop is the "parent"). */
function pickTieredRecipients(recips) {
  const list = Array.isArray(recips) ? recips : [];
  if (!list.length) return [];
  const anyTierRole = list.some((r) => ROLE_TIERS.includes(normRole(r.role)));
  if (!anyTierRole) return list; // no roles configured → send to all eligible
  for (const tier of ROLE_TIERS) {
    const m = list.filter((r) => normRole(r.role) === tier);
    if (m.length) return m;
  }
  return list; // roles present but none in the tier list → fall back to all
}

module.exports = {
  DIGEST_TYPES, TRANSACTIONAL_TYPES, ALL_TYPES, CHANNELS, ROLE_TIERS,
  isDigest, defaultSub, isSubscribed, pickTieredRecipients, isChurned,
};
