/* Recipient reads must page exactly once.
 *
 * Integration regression (2026-10-09): stab/tracker made emailHealth.selectRecipients page internally,
 * while stab/digest and stab/events each wrapped it in their own paging loop that put a `.range()` in the
 * filter. The inner range overrides the outer one, so every outer page returned the whole table: harmless
 * at 737 recipients, but past 1,000 the outer loop never ends and every recipient is read repeatedly —
 * exactly the threshold the paging was added for.
 *
 * Run: node --test server/roi-cron/__tests__/recipientPaging.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const H = require("../emailHealth.cjs");

// Fake PostgREST: honours the LAST .range() call like supabase-js, caps at 1000 rows per request.
function fakeSb(rows, log) {
  return {
    from() {
      let lo = 0, hi = 999;
      const b = {
        select() { return b; }, eq() { return b; }, order() { return b; },
        range(a, z) { lo = a; hi = z; return b; },
        then(res, rej) {
          log.requests++;
          if (log.requests > 50) return Promise.resolve({ data: null, error: { message: "runaway paging" } }).then(res, rej);
          const end = Math.min(hi, lo + 999);
          return Promise.resolve({ data: rows.slice(lo, end + 1), error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}
const ROWS = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, team_id: `t${i % 7}`, email: `r${i}@dealer.example` }));

test("selectRecipients pages a 2,500-row table into exactly 2,500 rows and stops", async () => {
  const log = { requests: 0 };
  const { data, error } = await H.selectRecipients(fakeSb(ROWS, log), "id,team_id,email");
  assert.equal(error, null);
  assert.equal(data.length, 2500);
  assert.equal(new Set(data.map((r) => r.id)).size, 2500);
  assert.ok(log.requests <= 6, `requests=${log.requests}`);
});

test("no caller re-pages selectRecipients by putting .range() in its filter", () => {
  for (const f of ["../runner.cjs", "../eventRunner.cjs", "../../app.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    // Each call's statement runs from `selectRecipients(` to the next `;`.
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/selectRecipients\(/.test(line) || /function selectRecipients/.test(line)) return;
      const stmt = lines.slice(i, i + 6).join("\n").split(";")[0];
      assert.ok(!/\.range\(/.test(stmt), `${f}:${i + 1} selectRecipients filter must not call .range() (it pages internally)`);
    });
  }
});
