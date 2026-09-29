/* Recipient routing contract: a verified, enabled, subscribed recipient is NEVER excluded by
 * anything derived (role, tier, seniority). Exclusion is an explicit act — email_enabled off,
 * a subscriptions cell off, or removal.
 *
 * Regression guard for the role-tier bug (2026-08-12): pickTieredRecipients kept only the first
 * non-empty tier (salesperson → bdc → gm), silently dropping 57 verified recipients across 26
 * rooftops. Symptom: "automatic emails aren't going" while the manual send (which never tiered)
 * reached everyone.
 *
 * Run: node --test server/roi-cron/__tests__/subscriptions.routing.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickTieredRecipients, isSubscribed, defaultSub } = require("../subscriptions.cjs");

const emails = (list) => pickTieredRecipients(list).map((r) => r.email);

test("a GM is not shadowed by a BDC — both are kept", () => {
  const recips = [
    { email: "chad@dealer.com", role: "bdc" },
    { email: "alex@dealer.com", role: "gm" },
  ];
  assert.deepEqual(emails(recips), ["chad@dealer.com", "alex@dealer.com"]);
});

test("a role-less recipient is kept even when a colleague has a role", () => {
  const recips = [
    { email: "chad@dealer.com", role: "bdc" },
    { email: "leads@dealer.com", role: null },
    { email: "newhire@dealer.com" }, // role absent entirely
  ];
  assert.deepEqual(emails(recips), ["chad@dealer.com", "leads@dealer.com", "newhire@dealer.com"]);
});

test("every tier present → everyone is kept (no tier wins)", () => {
  const recips = [
    { email: "sp@dealer.com", role: "salesperson" },
    { email: "bdc@dealer.com", role: "bdc" },
    { email: "gm@dealer.com", role: "gm" },
    { email: "none@dealer.com", role: "" },
  ];
  assert.equal(pickTieredRecipients(recips).length, 4);
});

test("unknown / odd role values are kept, not filtered", () => {
  const recips = [
    { email: "a@dealer.com", role: "Service Manager" },
    { email: "b@dealer.com", role: "  GM  " },
    { email: "c@dealer.com", role: undefined },
  ];
  assert.equal(pickTieredRecipients(recips).length, 3);
});

test("empty and non-array inputs stay safe", () => {
  assert.deepEqual(pickTieredRecipients([]), []);
  assert.deepEqual(pickTieredRecipients(null), []);
  assert.deepEqual(pickTieredRecipients(undefined), []);
});

test("the caller's own filters still exclude — only role-based exclusion is gone", () => {
  // isSubscribed is the explicit opt-out lever, and it must keep working.
  const optedOut = { email: "quiet@dealer.com", subscriptions: { action_item: { email: false } } };
  const optedIn = { email: "loud@dealer.com", subscriptions: {} };
  assert.equal(isSubscribed(optedOut, "action_item", "email"), false);
  assert.equal(isSubscribed(optedIn, "action_item", "email"), true);
  assert.equal(defaultSub("action_item", "email"), true);
});
