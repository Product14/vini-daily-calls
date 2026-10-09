/* Tracker reads must see every row, and a lookup by address must find only that address.
 *
 * Regression guard for the 2026-10-08 audit:
 *   · A1 F14 / A4 F15 — roi_recipients (737 rows), roi_rooftop_config (647) and roi_live_departments
 *     were read unpaged, and PostgREST returns at most 1,000 rows. At 1,001 recipients, rooftops past
 *     the cap would drop to recipients_missing on every send path with no error.
 *   · A5-20 / A4 F25 — recipients were matched with an unescaped ILIKE, so "a_b@x.com" also matched
 *     "axb@x.com" (a bounce, a toggle or a verify could land on someone else).
 *
 * Fully offline: a fake Supabase client that honours range() / order() / ilike escapes.
 * Run: node --test server/roi-cron/__tests__/trackerReads.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const H = require("../emailHealth.cjs");

/** LIKE pattern → RegExp (Postgres semantics, backslash escape), case-insensitive like ILIKE. */
function likeToRegex(p) {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) { out += p[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%") out += ".*"; else if (c === "_") out += "."; else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

function fakeSb(tables, log = []) {
  return {
    from(table) {
      const q = { f: [], order: [], range: null, cols: "*", op: "select" };
      const b = {
        select(cols) { q.cols = cols; return b; },
        eq(k, v) { q.f.push((r) => r[k] === v); return b; },
        in(k, vs) { q.f.push((r) => vs.includes(r[k])); return b; },
        ilike(k, p) { const re = likeToRegex(p); q.f.push((r) => re.test(String(r[k] ?? ""))); return b; },
        order(k) { q.order.push(k); return b; },
        range(a, z) { q.range = [a, z]; return b; },
        update(patch) { q.op = "update"; q.patch = patch; return b; },
        then(res, rej) {
          log.push({ table, op: q.op, range: q.range, order: [...q.order] });
          let rows = (tables[table] || []).filter((r) => q.f.every((fn) => fn(r)));
          if (q.order.length) rows = [...rows].sort((a, c) => { for (const k of q.order) { const x = String(a[k]), y = String(c[k]); if (x !== y) return x < y ? -1 : 1; } return 0; });
          if (q.op === "update") { for (const r of rows) Object.assign(r, q.patch); return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(res, rej); }
          // PostgREST: a response never carries more than db-max-rows (1000), range or not.
          const [a, z] = q.range ?? [0, Infinity];
          rows = rows.slice(a, Math.min(z + 1, a + 1000));
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

test("selectRecipients pages past the 1,000-row cap in id order", async () => {
  const rows = Array.from({ length: 2345 }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, team_id: `t${i % 300}`, email: `p${i}@dealer.com` }));
  const log = [];
  const { data, error } = await H.selectRecipients(fakeSb({ roi_recipients: rows }, log), "id,team_id,email");
  assert.equal(error, null);
  assert.equal(data.length, 2345);
  assert.equal(new Set(data.map((r) => r.id)).size, 2345);
  assert.ok(log.every((l) => l.order.includes("id") && l.range), "every page is ordered and ranged");
  assert.equal(log.length, 3);
});

test("selectRecipients keeps the caller's filter on every page", async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, team_id: i < 1200 ? "big" : "other", email: `p${i}@dealer.com` }));
  const { data } = await H.selectRecipients(fakeSb({ roi_recipients: rows }), "id,team_id,email", (q) => q.eq("team_id", "big"));
  assert.equal(data.length, 1200);
  assert.ok(data.every((r) => r.team_id === "big"));
});

test("selectTablePaged reads roi_live_departments past 1,000 rows in primary-key order", async () => {
  const rows = [];
  for (let i = 0; i < 700; i++) for (const d of ["sales", "service"]) rows.push({ team_id: `t${String(i).padStart(4, "0")}`, department: d, is_live: true });
  const { data } = await H.selectTablePaged(fakeSb({ roi_live_departments: rows }), "roi_live_departments", "team_id,department,is_live", { order: ["team_id", "department"] });
  assert.equal(data.length, 1400);
});

test("escapeLike: _ % and \\ are literal", () => {
  assert.equal(H.escapeLike("a_b%c\\d@x.com"), "a\\_b\\%c\\\\d@x.com");
  assert.ok(likeToRegex(H.escapeLike("a_b@x.com")).test("A_B@X.COM"));
  assert.equal(likeToRegex(H.escapeLike("a_b@x.com")).test("axb@x.com"), false);
});

test("findRecipientsByEmail matches the exact address only, case-insensitively", async () => {
  const tables = { roi_recipients: [
    { id: "1", team_id: "t", email: "a_b@x.com" },
    { id: "2", team_id: "t", email: "axb@x.com" },
    { id: "3", team_id: "t", email: "A_B@X.com" },
    { id: "4", team_id: "other", email: "a_b@x.com" },
    { id: "5", team_id: "t", email: "a%@x.com" },
    { id: "6", team_id: "t", email: "ab@x.com" },
  ] };
  const sb = fakeSb(tables);
  const { data } = await H.findRecipientsByEmail(sb, { teamId: "t", email: " a_b@x.com " });
  assert.deepEqual(data.map((r) => r.id).sort(), ["1", "3"]);
  assert.deepEqual((await H.findRecipientsByEmail(sb, { teamId: "t", email: "a%@x.com" })).data.map((r) => r.id), ["5"]);
  assert.deepEqual((await H.findRecipientsByEmail(sb, { teamId: "t", email: "" })).data, []);
});

test("suppressAddress no longer suppresses look-alike addresses", async () => {
  const tables = { roi_recipients: [
    { id: "1", team_id: "t", email: "a_b@x.com" },
    { id: "2", team_id: "t", email: "axb@x.com" },
  ] };
  const r = await H.suppressAddress(fakeSb(tables), { teamId: "t", email: "a_b@x.com", reason: "Hard bounce" });
  assert.equal(r.count, 1);
  assert.ok(tables.roi_recipients[0].suppressed_at);
  assert.equal(tables.roi_recipients[1].suppressed_at, undefined);
});
