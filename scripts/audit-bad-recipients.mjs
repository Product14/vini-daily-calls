#!/usr/bin/env node
/* audit-bad-recipients — find every address in the recipient book that mail cannot reach, and
 * (with --apply) stop mailing it.
 *
 * WHY: bounces are scored against the SENDING DOMAIN. A dead address is not a per-rooftop
 * annoyance — the digest cron hits it every morning and every transactional event hits it again,
 * and that steady drip of bounces is what moves spyne.ai from inbox to spam for every dealer we
 * mail, including the ones whose addresses are perfectly good.
 *
 * WHAT IT LOOKS AT, worst evidence first:
 *   1. Provider bounce / complaint events        roi_engagement_events  (hard evidence)
 *   2. Per-recipient bounced flags on past sends roi_digest_runs.recipients[].bounced
 *   3. Send failures that NAMED an address       roi_digest_runs.reason_detail, roi_event_emails.reason
 *   4. Undeliverable by construction             the address string itself (malformed / typo /
 *                                                reserved TLD) — no send history needed
 *
 * It HOLDS, it never deletes: roi_recipients.suppressed_at + suppression_reason. The row stays in
 * the tracker with the reason on it so a CSM can fix the address (which lifts the hold). A deleted
 * row is re-seeded by the recipient sync and starts bouncing again with nobody the wiser.
 *
 * USAGE (dry run prints the report and changes nothing):
 *   node scripts/audit-bad-recipients.mjs
 *   node scripts/audit-bad-recipients.mjs --apply          # put the holds on
 *   node scripts/audit-bad-recipients.mjs --apply --structural-only   # skip the history scan
 *   node scripts/audit-bad-recipients.mjs --csv > bad-addresses.csv
 *
 * NEEDS THE REAL SERVICE KEY. roi_* is RLS-locked, and the key in the repo's local .env is a
 * publishable (anon) one — with it every read returns [] and the script will report "nothing to
 * do" on a book full of bad addresses. Run it with the sb_secret_ key:
 *   ROI_SUPABASE_SERVICE_KEY=sb_secret_… node scripts/audit-bad-recipients.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const H = require("../server/roi-cron/emailHealth.cjs");

const APPLY = process.argv.includes("--apply");
const CSV = process.argv.includes("--csv");
const STRUCTURAL_ONLY = process.argv.includes("--structural-only");
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 180);

const SB_URL = process.env.ROI_SUPABASE_URL || process.env.VITE_ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("Set ROI_SUPABASE_URL and ROI_SUPABASE_SERVICE_KEY (the sb_secret_ service key — the publishable one reads nothing).");
  process.exit(1);
}
if (!/^sb_secret_|^eyJ/.test(SB_KEY)) {
  console.error(`⚠  ROI_SUPABASE_SERVICE_KEY looks like a publishable key (${SB_KEY.slice(0, 14)}…). roi_* is RLS-locked, so every read will come back empty and this will wrongly report a clean book.`);
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const PAGE = 1000;  // PostgREST caps a read at db-max-rows=1000; .limit(5000) silently lies.
async function readAll(table, cols, shape = (q) => q) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await shape(sb.from(table).select(cols)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// findings: email → { email, teams:Set, reason, evidence, severity }  (worst evidence wins)
const findings = new Map();
const RANK = { bounce_event: 4, bounced_flag: 3, send_rejected: 2, structural: 1 };
function note(email, evidence, reason, teamId) {
  const addr = H.normalizeEmail(email);
  if (!addr) return;
  const prev = findings.get(addr);
  if (prev && RANK[prev.evidence] >= RANK[evidence]) { if (teamId) prev.teams.add(teamId); return; }
  const teams = prev ? prev.teams : new Set();
  if (teamId) teams.add(teamId);
  findings.set(addr, { email: addr, evidence, reason, teams });
}

async function main() {
  console.error(`Reading the recipient book…`);
  const recips = await readAll("roi_recipients", "id,team_id,email,email_enabled,verified_at,suppressed_at,suppression_reason")
    .catch(async (e) => {
      if (!H.isMissingColumnError({ message: e.message })) throw e;
      console.error("⚠  roi_recipients has no suppression columns — apply migration 0023_recipient_deliverability.sql. Reporting only.");
      return readAll("roi_recipients", "id,team_id,email,email_enabled,verified_at");
    });
  const known = new Map();                        // address → the rows that hold it
  for (const r of recips) {
    const a = H.normalizeEmail(r.email);
    known.set(a, [...(known.get(a) || []), r]);
  }
  const alreadyHeld = new Set(recips.filter((r) => r.suppressed_at).map((r) => H.normalizeEmail(r.email)));
  console.error(`  ${recips.length} recipient rows · ${known.size} distinct addresses · ${alreadyHeld.size} already held`);

  // ── 4. Undeliverable by construction ────────────────────────────────────────
  for (const r of recips) {
    const p = H.addressProblem(r.email);
    if (!p || p.code === "placeholder") continue;   // placeholder = a deliberate phone-only recipient
    note(r.email, "structural", p.label, r.team_id);
  }

  if (!STRUCTURAL_ONLY) {
    // ── 1. Provider bounce / complaint events ─────────────────────────────────
    const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
    console.error(`Scanning ${HISTORY_DAYS}d of send history…`);
    const events = await readAll("roi_engagement_events", "recipient_email,event_type,occurred_at",
      (q) => q.gte("occurred_at", since).in("event_type", ["bounce", "complaint", "dropped"])).catch((e) => {
        console.error(`  (engagement events unreadable: ${e.message})`); return [];
      });
    for (const e of events) {
      if (!e.recipient_email) continue;
      note(e.recipient_email, "bounce_event",
        `Provider reported a ${e.event_type} on ${String(e.occurred_at).slice(0, 10)}`, null);
    }
    console.error(`  ${events.length} bounce/complaint events`);

    // ── 2 & 3. Per-recipient bounced flags + failures that named an address ────
    const runs = await readAll("roi_digest_runs", "team_id,status,reason,reason_detail,recipients,local_date",
      (q) => q.gte("local_date", since.slice(0, 10)));
    let flagged = 0, named = 0;
    for (const run of runs) {
      for (const r of Array.isArray(run.recipients) ? run.recipients : []) {
        if (r && r.bounced === true && r.email) { note(r.email, "bounced_flag", `Bounced on the ${run.local_date} digest`, run.team_id); flagged++; }
      }
      const txt = `${run.reason || ""} ${run.reason_detail || ""}`.trim();
      if (!txt || H.classifySendFailure(txt) !== "hard") continue;
      for (const a of H.extractAddresses(txt)) {
        if (!known.has(a)) continue;              // only ours — the body may quote our own From:
        note(a, "send_rejected", `The mail proxy rejected it: ${txt.slice(0, 120)}`, run.team_id); named++;
      }
    }
    const evs = await readAll("roi_event_emails", "team_id,status,reason,created_at",
      (q) => q.eq("status", "error").gte("created_at", since));
    for (const e of evs) {
      const txt = String(e.reason || "");
      if (H.classifySendFailure(txt) !== "hard") continue;
      for (const a of H.extractAddresses(txt)) {
        if (!known.has(a)) continue;
        note(a, "send_rejected", `The mail proxy rejected it: ${txt.slice(0, 120)}`, e.team_id); named++;
      }
    }
    console.error(`  ${runs.length} digest runs · ${evs.length} failed transactional rows → ${flagged} bounce flags, ${named} named rejections`);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  // Only act on addresses we actually mail. An address on a disabled or unverified row is
  // already held by another gate; reporting it as a deliverability problem is noise.
  const actionable = [...findings.values()]
    .filter((f) => known.has(f.email))
    .filter((f) => (known.get(f.email) || []).some((r) => r.email_enabled && r.verified_at))
    .filter((f) => !alreadyHeld.has(f.email))
    .sort((a, b) => RANK[b.evidence] - RANK[a.evidence] || a.email.localeCompare(b.email));

  if (CSV) {
    console.log("email,evidence,reason,rooftops");
    for (const f of actionable) console.log(`${f.email},${f.evidence},"${f.reason.replace(/"/g, "'")}",${[...f.teams].join(" ")}`);
  } else {
    const byEvidence = {};
    for (const f of actionable) (byEvidence[f.evidence] ||= []).push(f);
    console.log(`\n${"═".repeat(78)}`);
    console.log(`BAD ADDRESSES STILL BEING MAILED: ${actionable.length}`);
    console.log(`${"═".repeat(78)}`);
    for (const [ev, label] of [
      ["bounce_event", "The provider told us it bounced or was marked as spam"],
      ["bounced_flag", "A past digest recorded a bounce for this address"],
      ["send_rejected", "The mail proxy refused the address outright"],
      ["structural", "Cannot be a real mailbox (malformed, mistyped, or a reserved domain)"],
    ]) {
      const rows = byEvidence[ev] || [];
      if (!rows.length) continue;
      console.log(`\n── ${label} — ${rows.length}`);
      for (const f of rows) console.log(`   ${f.email.padEnd(42)} ${f.reason}${f.teams.size ? `   [${[...f.teams].join(", ")}]` : ""}`);
    }
    if (!actionable.length) console.log("\n   Nothing to hold — every address we mail is deliverable.");
  }

  if (!APPLY) {
    console.error(`\nDRY RUN — nothing changed. Re-run with --apply to put these ${actionable.length} address(es) on hold.`);
    return;
  }
  let held = 0;
  for (const f of actionable) {
    const r = await H.suppressAddress(sb, { email: f.email, reason: f.reason });
    if (r.count) { held += r.count; console.error(`  held ${f.email} (${r.count} row${r.count === 1 ? "" : "s"})`); }
    else if (r.error) console.error(`  FAILED ${f.email}: ${r.error.message || r.error}`);
  }
  console.error(`\nHeld ${held} recipient row(s) across ${actionable.length} address(es). They stay visible in the tracker with the reason; fixing the address lifts the hold.`);
}

main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
