// ─── Email value gate (anti-churn) ──────────────────────────────────────────
// One shared rule for EVERY customer-facing send path: never email a digest that
// shows no value. An empty/all-zero digest is a churn threat ("we mailed you and
// said nothing"), so the renderer stamps a hidden marker on a no-value email and
// the send chokepoints REFUSE to send a marked email — unless an override password
// (DANGER) is supplied for a deliberate manual send. The marker is an HTML comment
// stripped off the wire so a real customer never sees it.
//
// Keep the marker string and the digestSignal fields in sync with the inline copy
// in src/email/digestTemplate.cjs (that module is also bundled into the SPA, so it
// can't require this file — it stamps the same marker independently).

const NO_VALUE_MARK = "<!--vini:no-value-->";
const OVERRIDE_PASSWORD = "DANGER";

// ─── v2 (redesign) recipient lock ────────────────────────────────────────────
// SAFETY: while the redesigned digest is in testing, a v2 email may ONLY reach @spyne.ai.
// The v2 renderer stamps V2_MARK; every send chokepoint filters recipients to @spyne.ai when the
// HTML is v2-marked, unless V2_TO_CUSTOMERS=true is explicitly set (the deliberate "ship it" switch).
const V2_MARK = "<!--vini:v2-->";
const V2_TO_CUSTOMERS = String(process.env.V2_TO_CUSTOMERS || "").trim() === "true";
function isV2(html) { return typeof html === "string" && html.includes(V2_MARK); }
function isSpyne(email) { return /@spyne\.ai$/i.test(String(email == null ? "" : email).trim().toLowerCase()); }
// Returns { locked, allowed }. locked=true means a v2-in-testing email; allowed = the @spyne.ai subset.
function lockV2Recipients(html, recipients) {
  const list = Array.isArray(recipients) ? recipients : [];
  if (isV2(html) && !V2_TO_CUSTOMERS) return { locked: true, allowed: list.filter(isSpyne) };
  return { locked: false, allowed: list };
}

// The digest "signal": any real activity worth emailing. Mirrors runner.cjs
// guardrail() — zero means a truly empty day (no appointments, conversations,
// calls, leads, outbound dials, or action items) → no value → churn risk.
function digestSignal(m) {
  m = m || {};
  const n = (v) => Number(v) || 0;
  return (
    n(m.appointmentsYesterday) +
    n(m.conversationsHandled) +
    n(m.callsHandled != null ? m.callsHandled : m.conversationsCall) +
    n(m.totalLeads != null ? m.totalLeads : m.inboundUniqueLeads) +
    n(m.outboundTotalCalls) +
    n(m.actionItemsTotal)
  );
}
function digestHasValue(m) { return digestSignal(m) > 0; }

function markNoValue(html) {
  if (typeof html !== "string") return html;
  return html.includes(NO_VALUE_MARK) ? html : html + NO_VALUE_MARK;
}
function isNoValue(html) { return typeof html === "string" && html.includes(NO_VALUE_MARK); }
// Strip ALL hidden vini markers (no-value + v2) off the wire so a recipient never sees them.
function stripMarker(html) { return typeof html === "string" ? html.split(NO_VALUE_MARK).join("").split(V2_MARK).join("") : html; }
function overrideOk(v) { return String(v == null ? "" : v).trim() === OVERRIDE_PASSWORD; }

module.exports = {
  NO_VALUE_MARK, OVERRIDE_PASSWORD, V2_MARK, V2_TO_CUSTOMERS,
  digestSignal, digestHasValue,
  markNoValue, isNoValue, stripMarker, overrideOk,
  isV2, isSpyne, lockV2Recipients,
};
