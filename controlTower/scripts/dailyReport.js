// Run: node controlTower/scripts/dailyReport.js
//   DRY_RUN=1       build + validate, send nothing, touch no DB
//   FORCE_RESEND=1  wipe today's send-ledger rows first, then send again
//
// The automated daily control-tower send (GitHub Actions, 11:00 IST).
//
// SAFETY MODEL — nothing is EVER sent twice (user 8-Jul: multiple stakeholders):
//   • at-most-once per (report_date, channel) via an atomic claim in Supabase
//     (control_tower_sends, unique(report_date,channel)). The claim INSERT wins
//     for exactly one runner; a second cron fire / manual re-run / retry sees
//     the row and SKIPS. Email and Slack are claimed independently so a partial
//     failure never re-sends the half that already went out.
//   • a failed/pending channel is NOT auto-resent (it may have gone out and we
//     lost the response) — we alert and wait for a human + FORCE_RESEND.
//   • guardrail FIRST: broken/zero feed or any throw ⇒ send nothing.
//   • no Supabase creds ⇒ we CANNOT guarantee at-most-once ⇒ we refuse to send.
//
// Reports post to SLACK_CHANNEL (#central-analytics-programs).
// ALL alerts post to SLACK_ALERT_CHANNEL (#vini-alerts-and-monitoring) — never
// the reports channel.

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createClient } from "@supabase/supabase-js";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CT      = join(SCRIPTS, "..");
const REPO    = join(CT, "..");

(function loadDotenv() {
  const p = join(REPO, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim(); if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("="); if (eq < 0) continue;
    const k = s.slice(0, eq).trim(); let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const DRY          = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const FORCE_RESEND = process.env.FORCE_RESEND === "1" || process.argv.includes("--force");
const SLACK_TOKEN     = process.env.SLACK_BOT_TOKEN;
const REPORT_CHANNEL  = process.env.SLACK_CHANNEL;
const ALERT_CHANNEL   = process.env.SLACK_ALERT_CHANNEL;
const SB_URL = process.env.ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
const sb = (SB_URL && SB_KEY) ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;
const TABLE = "control_tower_sends";

const log = (...a) => console.log(...a);

async function slackPost(channel, text) {
  if (!SLACK_TOKEN || !channel) { log(`⚠ no Slack creds/channel — cannot post to ${channel}`); return; }
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text }),
  }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) log(`⚠ slack post to ${channel} failed: ${r.error}`);
  return r;
}

// Alerts ALWAYS go to the alerting channel, never the reports channel.
async function alert(text) {
  const msg = `:rotating_light: *Vini daily control tower*\n${text}`;
  if (DRY) { log(`[dry] would ALERT #${ALERT_CHANNEL}: ${text}`); return; }
  await slackPost(ALERT_CHANNEL, msg);
}

async function postSlackReportPng(pngPath, title, comment) {
  const bytes = readFileSync(pngPath);
  const r1 = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ filename: title + ".png", length: String(bytes.length) }),
  }).then(r => r.json());
  if (!r1.ok) throw new Error(`getUploadURLExternal: ${r1.error}`);
  const put = await fetch(r1.upload_url, { method: "POST", body: bytes });
  if (!put.ok) throw new Error(`upload PUT HTTP ${put.status}`);
  const r3 = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ id: r1.file_id, title }], channel_id: REPORT_CHANNEL, initial_comment: comment }),
  }).then(r => r.json());
  if (!r3.ok) throw new Error(`completeUploadExternal: ${r3.error}`);
}

// ─── at-most-once claim ─────────────────────────────────────────────────────
async function claim(date, channel) {
  const { data, error } = await sb.from(TABLE)
    .insert({ report_date: date, channel, status: "pending" })
    .select("id");
  if (error) {
    if ((error.code || "") === "23505" || /duplicate|unique/i.test(error.message || "")) return { claimed: false };
    throw new Error(`claim(${channel}) DB error: ${error.message}`);
  }
  return { claimed: true, id: data?.[0]?.id };
}
const statusOf = async (date, channel) =>
  (await sb.from(TABLE).select("status").eq("report_date", date).eq("channel", channel).maybeSingle()).data?.status ?? null;
const mark = (id, patch) => sb.from(TABLE).update(patch).eq("id", id);

// Runs `doSend` at most once for (date, channel). Returns a result token.
async function sendChannel(date, channel, doSend) {
  if (DRY) { log(`[dry] would send ${channel} for ${date}`); return "dry"; }
  if (!sb) throw new Error("Supabase creds missing — cannot guarantee at-most-once; refusing to send");

  const { claimed, id } = await claim(date, channel);
  if (!claimed) {
    const st = await statusOf(date, channel);
    if (st === "sent") { log(`✓ ${channel} already sent for ${date} — skipping (idempotent)`); return "already-sent"; }
    await alert(`*${channel}* for ${date} is '${st}' from a prior run — NOT resending (avoids a double blast). Confirm it did not go out, then re-run with FORCE_RESEND=1.`);
    log(`⚠ ${channel} prior status '${st}' — held, not resending`);
    return "held";
  }
  try {
    await doSend();
    await mark(id, { status: "sent", sent_at: new Date().toISOString() });
    log(`✓ ${channel} sent for ${date}`);
    return "sent";
  } catch (e) {
    await mark(id, { status: "failed", error: String(e.message).slice(0, 500) });
    await alert(`*${channel}* send FAILED for ${date}: ${e.message}\nNot retried automatically (may have partially gone out). Fix, then re-run with FORCE_RESEND=1.`);
    log(`✗ ${channel} failed: ${e.message}`);
    return "failed";
  }
}

async function renderSlackPng(payload) {
  const { buildTableHtml } = await import("../server/slackOptionTable.js");
  const puppeteer = (await import("puppeteer")).default;
  const htmlPath = join(CT, "slack-daily.html");
  const pngPath  = join(CT, "slack-daily.png");
  writeFileSync(htmlPath, buildTableHtml(payload));
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 });
    await page.goto("file://" + htmlPath, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts ? document.fonts.ready : null);
    await page.screenshot({ path: pngPath, fullPage: true, type: "png" });
  } finally { await browser.close(); }
  return pngPath;
}

async function main() {
  log(`→ Vini daily control tower${DRY ? " (DRY RUN)" : ""}${FORCE_RESEND ? " [FORCE_RESEND]" : ""} — ${new Date().toISOString()}`);

  // 1. Assemble + guardrail (any throw ⇒ top-level catch ⇒ alert, no claim).
  const { assembleSlackPayload } = await import("../server/slackPayload.js");
  const { payload, guardrail } = await assembleSlackPayload();
  const date = guardrail.dataDay;
  log(`  guardrail: contracted=${guardrail.contractedCount} live=${guardrail.liveCount} d1Leads=${guardrail.d1Leads} d1Appts=${guardrail.d1Appts} (report_date ${date})`);

  const zeros = [];
  if (!(guardrail.contractedCount > 0)) zeros.push("contracted cohort empty (Master Sheet)");
  if (!(guardrail.liveCount > 0))       zeros.push("live agents = 0 (Master Sheet)");
  if (!(guardrail.d1Leads > 0))         zeros.push(`yesterday leads = 0 (ClickHouse spine, ${date})`);
  if (zeros.length) throw new Error(`GUARDRAIL — data looks broken/zero, nothing sent: ${zeros.join("; ")}`);

  // 2. Generate artifacts (NO sends here — a build failure hits the top-level
  //    catch, alerts, and claims nothing, so it's safe to retry).
  log("→ generate email HTML + Slack PNG");
  execFileSync(process.execPath, [join(SCRIPTS, "previewAgentsEmail.js")], { cwd: CT, stdio: "inherit" });
  const pngPath = await renderSlackPng(payload);

  // 3. FORCE_RESEND — clear today's ledger so the claims below win fresh.
  if (FORCE_RESEND && sb && !DRY) {
    await sb.from(TABLE).delete().eq("report_date", date);
    log(`  FORCE_RESEND: cleared ledger rows for ${date}`);
  }

  // 4. Send, each claimed independently and at-most-once.
  const emailRes = await sendChannel(date, "email", () => {
    execFileSync(process.execPath, [join(SCRIPTS, "sendVinniReport.js"), date], { cwd: CT, stdio: "inherit" });
  });
  const slackRes = await sendChannel(date, "slack", () =>
    postSlackReportPng(pngPath, `Vini Control Tower · ${payload.asOfDate}`, `Vini Daily Snapshot — ${payload.asOfDate}`));

  log(`✓ Done — email:${emailRes} slack:${slackRes}${DRY ? " (dry)" : ""}`);
  if ([emailRes, slackRes].some(r => r === "failed" || r === "held")) process.exit(1);
}

main().catch(async (err) => {
  console.error("✗", err.message);
  await alert(`${err.message}\n_No email or Slack report was sent. Please resolve and re-run._`);
  process.exit(1);
});
