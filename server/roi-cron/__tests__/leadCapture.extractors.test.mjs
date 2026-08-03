// Adversarial tests for the lead-capture extractors. A wrong ZIP or a stale time on a lead sheet
// sends the BDC to the wrong store or a dead slot, so these are correctness tests, not niceties.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const LC = require("../leadCaptureCH.cjs");

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const call = (...lines) => lines.join("\n");

// ── ZIP ────────────────────────────────────────────────────────────────────────
t("zip: spoken as words", LC.extractZip(call(
  "AI: What ZIP code are you coming from?", "Customer: That's four six eight zero two.")), "46802");
t("zip: spaced single digits", LC.extractZip(call(
  "AI: What is your five-digit ZIP code?", "Customer: 4 6 8 0 2")), "46802");
t("zip: hyphenated digits", LC.extractZip(call(
  "AI: ZIP code please?", "Customer: 4-6-8-0-2")), "46802");
t("zip: plain 5 digits", LC.extractZip(call(
  "AI: What ZIP are you in?", "Customer: 46802")), "46802");
t("zip: volunteered without being asked", LC.extractZip(call(
  "Customer: my zip is 46802 if that helps")), "46802");
t("zip: zip+4 keeps the 5", LC.extractZip(call(
  "AI: ZIP?", "Customer: 46802-1234")), "46802");
t("zip: mixed words and digits", LC.extractZip(call(
  "AI: ZIP code?", "Customer: four 6 eight zero two")), "46802");
// the AI reads the STORE's address back — never the caller's ZIP
t("zip: store address on an AI line is ignored", LC.extractZip(call(
  "AI: The nearest location is Fort Wayne West, Fort Wayne, Indiana 46815. Which do you prefer?",
  "Customer: The first one sounds good.")), "");
// numbers that are NOT zips
t("zip: price is not a zip", LC.extractZip(call(
  "AI: What ZIP code are you coming from?", "Customer: I paid 15000 for my trade-in")), "");
t("zip: mileage is not a zip", LC.extractZip(call(
  "AI: What ZIP code are you coming from?", "Customer: mine has 46000 miles on it")), "");
t("zip: budget is not a zip", LC.extractZip(call(
  "AI: ZIP code?", "Customer: my budget is around 25000 dollars")), "");
t("zip: down payment is not a zip", LC.extractZip(call(
  "AI: ZIP?", "Customer: I can put 10000 down")), "");
t("zip: phone number is not a zip", LC.extractZip(call(
  "AI: ZIP?", "Customer: my number is 5550000000")), "");
t("zip: 00000 rejected", LC.extractZip(call("AI: ZIP?", "Customer: 00000")), "");
t("zip: nothing given", LC.extractZip(call(
  "AI: What ZIP code are you coming from?", "Customer: Allow me just a second.")), "");
t("zip: drifting far past the ask is ignored", LC.extractZip(call(
  "AI: What ZIP code are you coming from?",
  "Customer: hold on", "Customer: sorry", "Customer: my wife is calling", "Customer: anyway",
  "Customer: the sticker said 21500")), "");
t("zip: empty transcript", LC.extractZip(""), "");

// ── appointment time ───────────────────────────────────────────────────────────
t("appt: from appointmentDetails", LC.pickApptWhen(
  ["Test drive requested for 2021 Chevrolet Equinox", "Proposed date and time: Wednesday at 3 PM"], []), "Wednesday at 3 PM");
t("appt: store-hours line is not the appointment", LC.pickApptWhen(
  ["Dealership sales department open Tuesday at 3 PM"], []), "");
t("appt: from the narrative summary", LC.pickApptWhen(
  [], ["The customer expressed interest in visiting on Tuesday at 3 PM and chose Fort Wayne West."]), "Tuesday at 3 PM");
t("appt: from a text, no trailing punctuation", LC.pickApptWhen(
  [], ["Can we move it to Thursday at 5? My zip is 46802 by the way"]), "Thursday at 5");
t("appt: bare weekday with no preposition", LC.pickApptWhen([], ["Thursday at 5 works for me"]), "Thursday at 5");
t("appt: tomorrow", LC.pickApptWhen([], ["can we do tomorrow at 10"]), "tomorrow at 10");
t("appt: nothing", LC.pickApptWhen([], ["I'll think about it and call back"]), "");

// ── location ───────────────────────────────────────────────────────────────────
t("location: chosen line", LC.pickLocation(["Chosen location: Fort Wayne West"], []), "Fort Wayne West");
t("location: from summary", LC.pickLocation([], ["The customer chose the Fort Wayne West location for the visit."]), "Fort Wayne West");
t("location: none", LC.pickLocation([], ["No location discussed."]), "");

// ── SMS merge: the text is NEWER than the call and must win ────────────────────
const callLead = { customer: "A", phone: "+15550000000", zip: "", apptWhen: "Wednesday at 3 PM", vehicle: "2021 Equinox" };
const moved = LC.buildSmsLead(callLead, {}, [{ direction: "in", body: "make it Thursday at 5, zip 46802", status: "received" }]);
t("sms: typed time supersedes the call", moved.apptWhen, "Thursday at 5");
t("sms: typed zip fills the gap", moved.zip, "46802");
t("sms: supersede is flagged for the BDC", /Moved by text/.test(moved.apptWhenNote), true);
const same = LC.buildSmsLead({ apptWhen: "Thursday at 5" }, {}, [{ direction: "in", body: "Thursday at 5 is good", status: "received" }]);
t("sms: no note when the time did not change", same.apptWhenNote, "");
const noCall = LC.buildSmsLead(null, { customer: "B", phone: "+1346" }, [{ direction: "in", body: "my zip is 46802", status: "received" }]);
t("sms: thread-only still resolves zip", noCall.zip, "46802");
t("sms: thread-only carries no invented vehicle", noCall.vehicle, "");
t("sms: outbound-only thread yields nothing typed", LC.buildSmsLead(null, {}, [{ direction: "out", body: "here is your link, zip 46815", status: "delivered" }]).zip, "");
t("sms: failed delivery counted", LC.buildSmsLead(null, {}, [{ direction: "out", body: "x", status: "failed" }]).smsFailed, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
