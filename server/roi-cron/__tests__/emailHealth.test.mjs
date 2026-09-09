// Adversarial tests for the deliverability gate. Two failure modes, both expensive:
//   FALSE NEGATIVE — a dead address keeps getting mailed, its bounces are scored against
//                    spyne.ai, and every rooftop's inbox placement degrades.
//   FALSE POSITIVE — a perfectly good dealer address is silently held and a GM stops getting
//                    their digest with nobody the wiser. This is the worse one.
// So the real-address block below matters more than the bad-address block.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const H = require("../emailHealth.cjs");

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const code = (e) => { const p = H.addressProblem(e); return p ? p.code : "ok"; };

// ── Real addresses of the shapes actually in the recipient book ────────────────
// Dealer domains are long, hyphenated, multi-label and use every TLD under the sun.
for (const good of [
  "jperry@zeiglerauto.com",
  "service@hornemazda.com",
  "b.heiselmann@kelly-cadillac.com",
  "gm@invergrove-ford.net",
  "bdc.team@newbrightonford.co.uk",
  "sales+leads@dreamnissan.us",
  "j.o'brien@dealer.com".replace("'", ""),      // apostrophes are rare; keep the plain form real
  "first.last@cornhuskerautogroup.io",
  "DEVANSH.HASIJA@spyne.ai",                    // case is not a defect
  "a@bc.de",                                    // short but valid
  "internetmanager@johnelwayharleydavidson.com",
  "u_ser-name99@auto-plex.dealer.tech",
]) t(`real: ${good}`, code(good), "ok");

// ── Structurally impossible ────────────────────────────────────────────────────
t("bad: empty", code(""), "empty");
t("bad: no @", code("gmdealercom"), "malformed");
t("bad: no domain dot", code("gm@dealer"), "malformed");
t("bad: trailing @", code("gm@"), "malformed");
t("bad: two @", code("gm@a@dealer.com"), "malformed");
t("bad: leading dot in local", code(".gm@dealer.com"), "malformed");
t("bad: double dot in local", code("g..m@dealer.com"), "malformed");
t("bad: numeric TLD", code("gm@dealer.123"), "malformed");
t("bad: hyphen-led domain label", code("gm@-dealer.com"), "malformed");

// The old gate was an UNANCHORED /\S+@\S+\.\S+/ — every one of these matched on a substring
// and went out to the proxy as-is, which is how one bad row failed a whole rooftop's send.
t("bad: display name pasted in", code("Bob Smith <bob@dealer.com>"), "malformed");
t("bad: space in the middle", code("john smith@dealer.com"), "malformed");
t("bad: two addresses in one field", code("a@dealer.com, b@dealer.com"), "malformed");
t("bad: semicolon list", code("a@dealer.com;b@dealer.com"), "malformed");
t("bad: trailing comma", code("a@dealer.com,"), "malformed");

// ── Cannot receive public mail ─────────────────────────────────────────────────
t("unroutable: .local", code("gm@dealer.local"), "unroutable");
t("unroutable: .lan", code("printer@store.lan"), "unroutable");
t("unroutable: example.com", code("gm@example.com"), "unroutable");
t("placeholder: phone-only row", code("ph.13135551234@phone.invalid"), "placeholder");

// ── Typos of the big mailbox providers (guaranteed hard bounces) ───────────────
t("typo: gmial.com", code("gm@gmial.com"), "typo");
t("typo: gmail.con", code("gm@gmail.con"), "typo");
t("typo: yaho.com", code("gm@yaho.com"), "typo");
t("typo: hotmial.com", code("gm@hotmial.com"), "typo");
t("typo: outlok.com", code("gm@outlok.com"), "typo");
t("typo: comcast.ent", code("gm@comcast.ent"), "typo");
t("typo suggests the fix", H.addressProblem("gm@gmial.com").detail, "gmail.com");
// …but the correctly-spelled ones must sail through
for (const p of ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "comcast.net", "sbcglobal.net"]) {
  t(`provider ok: ${p}`, code(`gm@${p}`), "ok");
}

// ── Suppression state ──────────────────────────────────────────────────────────
t("canEmail: clean row", H.canEmail({ email: "gm@dealer.com" }), "true");
t("canEmail: suppressed row", H.canEmail({ email: "gm@dealer.com", suppressed_at: "2026-09-01T00:00:00Z" }), "false");
t("canEmail: typo row", H.canEmail({ email: "gm@gmial.com" }), "false");
t("canEmail: null", H.canEmail(null), "false");
t("emailBlock: reason carries through", H.emailBlock({ email: "x@y.com", suppressed_at: "2026-09-01T00:00:00Z", suppression_reason: "Hard bounce · 550" }).label, "Hard bounce · 550");

// ── Failure classification — 'unknown' must never suppress ─────────────────────
t("hard: 550 unknown user", H.classifySendFailure("550 5.1.1 <gm@x.com>: Recipient address rejected: User unknown"), "hard");
t("hard: invalid recipient", H.classifySendFailure('{"error":"invalid recipient"}'), "hard");
t("hard: domain not found", H.classifySendFailure("550 Domain not found"), "hard");
t("soft: mailbox full", H.classifySendFailure("452 4.2.2 Mailbox full"), "soft");
t("soft: rate limited", H.classifySendFailure("429 rate limit exceeded"), "soft");
t("soft wins over hard when both read", H.classifySendFailure("4.2.2 mailbox full, try again"), "soft");
// Our problem, not the recipient's — suppressing on these would silence live rooftops.
t("unknown: auth failure", H.classifySendFailure("401 Unauthorized"), "unknown");
t("unknown: bad template", H.classifySendFailure('{"error":"template not found"}'), "unknown");
t("unknown: empty body", H.classifySendFailure(""), "unknown");
t("unknown: gateway down", H.classifySendFailure("502 Bad Gateway"), "unknown");

// ── Pulling the offender out of a batch error ──────────────────────────────────
t("extract: names the bad address",
  H.extractAddresses("550 <bad@gmial.com>: recipient rejected").join(","), "bad@gmial.com");
t("extract: dedupes and lowercases",
  H.extractAddresses("A@X.com failed; a@x.com failed").join(","), "a@x.com");
t("extract: none in the body", H.extractAddresses("500 internal error").length, 0);

// ── Reading a provider's bounce webhook ────────────────────────────────────────
// Whichever ESP mail.spyne.ai turns out to front, the ingest must read it. Real payload shapes.
const one = (body) => { const r = H.parseBounceEvents(body); return r.length === 1 ? `${r[0].email}|${r[0].type}` : `${r.length} events`; };

t("resend: bounced", one({ type: "email.bounced", data: { to: ["gm@dealer.com"], bounce: { message: "550 user unknown" } } }), "gm@dealer.com|bounce");
t("resend: complained", one({ type: "email.complained", data: { to: ["gm@dealer.com"] } }), "gm@dealer.com|complaint");
t("resend: delivery_delayed is soft", one({ type: "email.delivery_delayed", data: { to: ["gm@dealer.com"] } }), "gm@dealer.com|deferred");
t("resend: keeps the diagnostic", H.parseBounceEvents({ type: "email.bounced", data: { to: ["a@b.com"], bounce: { message: "550 user unknown" } } })[0].detail, "550 user unknown");

t("sendgrid: bounce", one([{ email: "gm@dealer.com", event: "bounce", type: "bounce", reason: "550 no such user" }]), "gm@dealer.com|bounce");
t("sendgrid: blocked is soft", one([{ email: "gm@dealer.com", event: "bounce", type: "blocked", reason: "421 too many" }]), "gm@dealer.com|deferred");
t("sendgrid: spamreport", one([{ email: "gm@dealer.com", event: "spamreport" }]), "gm@dealer.com|complaint");
t("sendgrid: delivered is ignored", H.parseBounceEvents([{ email: "gm@dealer.com", event: "delivered" }]).length, 0);
t("sendgrid: batch of many", H.parseBounceEvents([
  { email: "a@x.com", event: "bounce" }, { email: "b@x.com", event: "open" }, { email: "c@x.com", event: "spamreport" },
]).map((e) => `${e.email}:${e.type}`).join(","), "a@x.com:bounce,c@x.com:complaint");

t("ses: permanent bounce", one({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "gm@dealer.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" }] } }), "gm@dealer.com|bounce");
t("ses: transient bounce is soft", one({ notificationType: "Bounce", bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "gm@dealer.com" }] } }), "gm@dealer.com|deferred");
t("ses: complaint", one({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "gm@dealer.com" }] } }), "gm@dealer.com|complaint");
t("ses: inside the SNS envelope", one({ Type: "Notification", Message: JSON.stringify({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "gm@dealer.com" }] } }) }), "gm@dealer.com|bounce");
t("ses: unparseable SNS body is ignored, not thrown", H.parseBounceEvents({ Type: "Notification", Message: "not json" }).length, 0);
t("ses: two bounced recipients in one event", H.parseBounceEvents({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@x.com" }, { emailAddress: "b@x.com" }] } }).length, 2);

t("plain proxy shape", one({ email: "gm@dealer.com", status: "bounced", reason: "550" }), "gm@dealer.com|bounce");
t("junk payload is ignored", H.parseBounceEvents({ hello: "world" }).length, 0);
t("null payload is ignored", H.parseBounceEvents(null).length, 0);
// A delivery notification must never suppress anybody.
t("ses: delivery is ignored", H.parseBounceEvents({ notificationType: "Delivery", delivery: { recipients: ["a@x.com"] } }).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
