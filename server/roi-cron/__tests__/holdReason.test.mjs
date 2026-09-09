// The hold/failure line on the transactional send paths.
//
// A DELIBERATE HOLD (the anti-churn no-value gate, the v2 @spyne.ai lock, the deliverability gate
// leaving nobody to mail) is recorded as not_sent and must NEVER reach the Slack breakage alert.
// Anything else is a real failure and must.
//
// Why this is pinned: eventRunner used to treat every throw as a failure and push one alert entry
// PER LEAD. Measured over 30d in prod, ~2,740 no-value holds produced 235 Slack warnings and 109
// CRITICAL @channel pings, against 11 genuine failures. That channel is the dead-man's switch for
// this pipeline going silent — it once went dark for 13 days unnoticed — so drowning it is how the
// next real outage gets missed.
//
// The dangerous direction is the OTHER one: misclassifying a real failure as a hold mutes an
// outage completely. Hence the "must stay a FAILURE" block is the one to extend when in doubt.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { holdReason } = require("../eventRunner.cjs");

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// ── Holds: recorded as not_sent with this reason, never alerted ────────────────
t("no-value gate → no_value",                 holdReason({ code: "BLOCKED_NO_VALUE" }), "no_value");
t("v2 spyne-only lock → v2_spyne_only",       holdReason({ code: "V2_SPYNE_ONLY" }), "v2_spyne_only");
t("nobody deliverable → recipients_missing",  holdReason({ code: "NO_DELIVERABLE_RECIPIENT" }), "recipients_missing");
// The real error object the anti-churn gate throws, not a hand-made stub.
const noValue = Object.assign(new Error("This email shows no value — blocked to avoid churn."), { code: "BLOCKED_NO_VALUE" });
t("the real thrown Error is recognised",      holdReason(noValue), "no_value");

// ── Failures: must stay failures, or a real outage goes silent ─────────────────
t("mail 4xx is a failure",        holdReason(new Error("mail 400: bad request")), "null");
t("mail 5xx is a failure",        holdReason(new Error("mail 503: gateway down")), "null");
t("network blip is a failure",    holdReason(new TypeError("fetch failed")), "null");
t("auth failure is a failure",    holdReason({ code: "EAUTH", message: "401" }), "null");
t("unknown code is a failure",    holdReason({ code: "SOMETHING_NEW" }), "null");
t("bare string is a failure",     holdReason("boom"), "null");
t("undefined is a failure",       holdReason(undefined), "null");
t("null is a failure",            holdReason(null), "null");
// A message that merely mentions the gate is NOT a hold — only the code counts. Otherwise a
// proxy echoing our own body back in an error would mute a genuine failure.
t("message text alone is not a hold", holdReason(new Error("This email shows no value")), "null");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
