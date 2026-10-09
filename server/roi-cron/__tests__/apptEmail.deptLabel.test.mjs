/* An appointment email labels itself with the APPOINTMENT's department, never the caller's.
 *
 * Regression guard for Stillwell Ford, 2026-10-07: a service booking was rendered for the Sales
 * tracker row, so the header and footer read "Vini · Sales" while the card underneath was a service
 * appointment (oil change, "Service" chip). The header came from `opts.dept` (whoever called), the
 * card from `appointment.type` (the booking itself). They must never disagree.
 *
 * Run: node --test server/roi-cron/__tests__/apptEmail.deptLabel.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../../../src/email/transactionalTemplates.cjs");

const appt = (type) => ({
  customer: "Karen Chamberlain", phone: "+15175550100", relDay: "Tue, Oct 13", time: "3:30 PM", when: "Tue, Oct 13 · 3:30 PM",
  type, intent: "schedule_appointment", byVini: true, services: ["Replace Engine Oil and Filter"],
});
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ");

test("service appointment rendered for the Sales row → every label says Service", () => {
  const t = text(T.renderPostAppointment({ rooftopName: "Stillwell Ford", dept: "sales", appointment: appt("Service") }));
  assert.match(t, /Vini · Service/);
  assert.match(t, /Sent by Vini · Service for Stillwell Ford/);
  assert.doesNotMatch(t, /Vini · Sales/);
});

test("sales appointment rendered for the Service row → every label says Sales", () => {
  const t = text(T.renderPostAppointment({ rooftopName: "Stillwell Ford", dept: "service", appointment: appt("Sales") }));
  assert.match(t, /Sent by Vini · Sales for Stillwell Ford/);
  assert.doesNotMatch(t, /Vini · Service/);
});

test("no type on the appointment → the caller's department is used, as before", () => {
  const t = text(T.renderPostAppointment({ rooftopName: "Stillwell Ford", dept: "service", appointment: appt(undefined) }));
  assert.match(t, /Sent by Vini · Service for Stillwell Ford/);
});

test("the SMS version agrees with the appointment too", () => {
  const sms = T.renderPostAppointmentSms({ rooftopName: "Stillwell Ford", dept: "sales", appointment: appt("Service") });
  assert.match(sms, /Service/);
  assert.doesNotMatch(sms, /\bSales\b/);
});
