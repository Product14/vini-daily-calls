'use strict';
/**
 * QA SMOKE TEST — pure-logic checks, no live DB required.
 * Run:  node test/qa-smoke.js
 * Exits non-zero if any assertion fails (CI-friendly).
 *
 * Covers: guardrails, BCC address round-trip, reason handling, time windows,
 * formatters, engagement normalization. The full pipeline (ClickHouse/Mongo/
 * Supabase) is validated separately via the dry-run trigger — see QA_TESTING.md.
 */

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', name); } };

// sails stub so modules that read sails.config at call-time don't crash
global.sails = { config: { custom: { bccEnabled: true, bccTrackDomain: 'track.spyne.ai', dryRun: true } },
                 log: { info() {}, warn() {}, error() {} } };

// ── Guardrails ───────────────────────────────────────────────────────────────
const { validateDigestPayload } = require('../utils/guardrails');
const good = { dealershipName: 'X', reportDate: 'd', reportingPeriod: 'p',
  appointmentsYesterday: 4, appointmentsYesterdayMTD: 42, conversationsHandled: 31,
  inboundUniqueLeads: 9, outboundUniqueReached: 12, actionRequiredItems: [{ label: 'a', count: 3 }] };
ok('guardrail passes a good payload', validateDigestPayload(good).ok === true);
ok('guardrail blocks all-zero as no_data',
  validateDigestPayload({ ...good, appointmentsYesterday: 0, appointmentsYesterdayMTD: 0, conversationsHandled: 0, inboundUniqueLeads: 0, outboundUniqueReached: 0, actionRequiredItems: [] }).reason === 'no_data');
ok('guardrail blocks MTD<yesterday as inconsistent_mtd',
  validateDigestPayload({ ...good, appointmentsYesterdayMTD: 1 }).reason === 'inconsistent_mtd');
ok('guardrail blocks passive-only as not_actionable',
  validateDigestPayload({ ...good, appointmentsYesterday: 0, appointmentsYesterdayMTD: 0, inboundUniqueLeads: 0, outboundUniqueReached: 0, actionRequiredItems: [], conversationsHandled: 5 }).reason === 'not_actionable');
ok('guardrail flags missing required fields',
  validateDigestPayload({ appointmentsYesterday: 1, conversationsHandled: 1 }).ok === false);

// ── BCC tracking ─────────────────────────────────────────────────────────────
const bcc = require('../services/bcc-tracker.service');
ok('bcc builds the track address',
  bcc.buildBccAddress('t1', 'sales', '2026-06-07') === 'track+t1+sales+2026-06-07@track.spyne.ai');
const parsed = bcc.parseBccAddress('track+t1+sales+2026-06-07@track.spyne.ai');
ok('bcc parses its own address', parsed && parsed.teamId === 't1' && parsed.department === 'sales' && parsed.localDate === '2026-06-07');
ok('bcc rejects a normal email', bcc.parseBccAddress('manager@dealer.com') === null);

// ── Common helpers ───────────────────────────────────────────────────────────
const c = require('../utils/common');
ok('pct computes + guards /0', c.pct(3, 12) === '25%' && c.pct(0, 0) === '0%');
ok('msToSec formats duration', c.msToSec(95000) === '1 min 35 sec');
const w = c.getTimeWindows('America/New_York');
ok('time windows: yesterday before its end', w.yesterday.start < w.yesterday.end);
ok('time windows: mtd start <= yesterday end', w.mtd.start <= w.yesterday.end);

// ── HTML render ──────────────────────────────────────────────────────────────
const { renderDigestHtml } = require('../services/html-render.service');
const html = renderDigestHtml(good, { serviceType: 'sales' });
ok('renders a full HTML doc', html.startsWith('<!doctype html>') && html.includes('X'));

// ── Engagement normalization ─────────────────────────────────────────────────
const eng = require('../services/engagement.service');
const ev = eng.normalizeEvent({ event: 'DELIVERED', email: 'A@B.com', messageId: 'm1', timestamp: 1717000000 });
ok('engagement normalizes type + lowercases email', ev.event_type === 'delivered' && ev.recipient_email === 'a@b.com' && ev.message_id === 'm1');

console.log(`\nQA SMOKE: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
