// Appointment-email gates. These replay the two real incidents behind the fix, so a regression here
// means a dealer gets a burst of "New appointment" emails for appointments nobody booked.
//   · Honda of Downtown Los Angeles, 2026-08-14 — one call wrote the customer's DMS appointment
//     HISTORY back as 7 fresh source='spyne' meetings (Jul-2024 → Jan-2026) → 7 emails in 6 seconds,
//     one of them rendering a 2024 date as "Sat, Dec 21 · 11:00 AM" (read as a FUTURE date).
//   · Toronto Honda, 2026-08-13 — a reschedule emitted a 'cancelled' row + a new 'scheduled' row for
//     the SAME slot 2 seconds apart → 2 emails, one announcing a cancelled appointment as new.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const E = require("../eventRunner.cjs");

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const LA = "America/Los_Angeles";
const NOW = Date.parse("2026-08-14T17:50:00Z"); // the moment the 7 emails went out
const gate = (m, seen = new Set(), now = NOW) => E.apptSkipReason(m, E.schedInfo(m.when, m.tz || LA), seen, now);

// ── the flagged email: 2024-12-21 19:00Z = Sat Dec 21, 2024, 11:00 AM in LA ──
const flagged = E.schedInfo("2024-12-21 19:00:00", LA); // zone-less = the ClickHouse shape
t("off-year date carries the year", flagged.when, "Sat, Dec 21, 2024 · 11:00 AM");
t("off-year flagged", flagged.offYear, true);
t("past flagged", flagged.past, true);
t("zone-less string is read as UTC", new Date(flagged.ts).toISOString(), "2024-12-21T19:00:00.000Z");
t("relDay suppressed when it would hide the year", E.safeRelDay(flagged, "Sat, Dec 21"), "");

// a same-year upcoming appointment is untouched — no year, relDay preserved
const soon = E.schedInfo("2026-08-18T14:30:00.000Z", LA);
t("this-year date has no year", soon.when, "Tue, Aug 18 · 7:30 AM");
t("this-year not off-year", soon.offYear, false);
t("relDay preserved when safe", E.safeRelDay(soon, "Tomorrow"), "Tomorrow");
t("bad input is inert", JSON.stringify(E.schedInfo("not-a-date", LA)), JSON.stringify({ ts: null, past: false, offYear: false, when: "" }));

// ── incident 1: all 7 James Smartt rows (one call, one lead, historical slots) ──
const smartt = [
  "2024-07-26 14:30:00", "2024-08-27 14:30:00", "2024-12-21 19:00:00", "2025-03-15 15:30:00",
  "2025-10-25 14:00:00", "2025-11-29 15:00:00", "2026-01-24 15:00:00",
].map((when, i) => ({ id: `meeting_${i}`, leadId: "lead_367682ef", when, status: "scheduled", source: "spyne" }));
const seen = new Set();
const smarttReasons = smartt.map((m) => gate(m, seen));
t("all 7 DMS-history rows are skipped", smarttReasons.every((r) => r === "past"), true);
t("…so zero emails would go out", smarttReasons.filter((r) => r === null).length, 0);

// ── incident 2: cancel + rebook of the SAME slot (Toronto Honda / ALONDRA MORA AGUIRRE) ──
const slot = "2026-08-17T16:45:00.000Z", lead = "lead_a1dbac12";
const seen2 = new Set();
t("the cancelled row is skipped", gate({ id: "meeting_2ac5e2b7", leadId: lead, when: slot, status: "cancelled" }, seen2), "cancelled");
t("the surviving scheduled row sends", gate({ id: "meeting_cdb77810", leadId: lead, when: slot, status: "scheduled" }, seen2), null);

// …and if BOTH arrive as 'scheduled', the slot dedupe still collapses them to one email
const seen3 = new Set();
t("first of a duplicate pair sends", gate({ id: "meeting_a", leadId: lead, when: slot, status: "scheduled" }, seen3), null);
t("second of a duplicate pair is skipped", gate({ id: "meeting_b", leadId: lead, when: slot, status: "scheduled" }, seen3), "slot_dupe");
// a genuinely DIFFERENT slot for the same lead is NOT a duplicate
t("same lead, different slot still sends", gate({ id: "meeting_c", leadId: lead, when: "2026-08-19T16:45:00.000Z", status: "scheduled" }, seen3), null);
// two leads that happen to share a slot are independent
t("different lead, same slot still sends", gate({ id: "meeting_d", leadId: "lead_other", when: slot, status: "scheduled" }, seen3), null);

// ── the past gate keeps genuine same-day bookings (6h grace) ──
t("slot 2h ago still sends", gate({ id: "m", leadId: "l", when: "2026-08-14T15:50:00.000Z", status: "scheduled" }), null);
t("slot 7h ago is skipped", gate({ id: "m", leadId: "l", when: "2026-08-14T10:50:00.000Z", status: "scheduled" }), "past");
t("yesterday is skipped", gate({ id: "m", leadId: "l", when: "2026-08-13T17:00:00.000Z", status: "scheduled" }), "past");
t("no-show is skipped", gate({ id: "m", leadId: "l", when: "2026-08-20T17:00:00.000Z", status: "NO_SHOW" }), "cancelled");
t("a row with no status sends", gate({ id: "m", leadId: "l", when: "2026-08-20T17:00:00.000Z" }), null);
// a row with no parseable start time keeps today's behaviour (send) — the gate must not silence
// appointments just because the feed omitted a time
t("unparseable start time still sends", gate({ id: "m", leadId: "l", when: "", status: "scheduled" }), null);

console.log(`\n${fail ? "FAILED" : "PASSED"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
