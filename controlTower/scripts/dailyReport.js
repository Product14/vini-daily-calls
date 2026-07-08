// Run: node controlTower/scripts/dailyReport.js   (DRY_RUN=1 to build without sending)
//
// The automated daily control-tower send (GitHub Actions, 11:00 IST).
// Pipeline, in order, all wrapped so a failure NEVER sends a half/blank report:
//   1. Assemble the data + guardrail block.
//   2. GUARDRAIL — if the sheet, live cohort, or spine came back empty/zero, or
//      anything threw, we DO NOT SEND. We post an alert to the Slack alerting
//      channel and exit non-zero so the human can resolve (per user 8-Jul).
//   3. Email — regenerate + send the control-tower email (existing scripts).
//   4. Slack — build "Option B", render to PNG, post to the channel.
// Any exception anywhere → Slack alert + exit 1.

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));      // controlTower/scripts
const CT      = join(SCRIPTS, "..");                          // controlTower
const REPO    = join(CT, "..");                               // repo root

// ─── env (dotenv-free; CI injects real env, local reads repo-root .env) ──────
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

const DRY = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const SLACK_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

function log(...a) { console.log(...a); }

async function slackAlert(text) {
  // Best-effort — never throws (an alert failing must not mask the real error).
  const msg = `:rotating_light: *Vini daily control tower — NOT sent*\n${text}`;
  if (DRY) { log(`[dry] would alert #${SLACK_CHANNEL}: ${text}`); return; }
  if (!SLACK_TOKEN || !SLACK_CHANNEL) { log("⚠ no Slack creds — cannot alert"); return; }
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text: msg }),
    }).then(r => r.json());
    log(r.ok ? "✓ alert posted" : `⚠ alert failed: ${r.error}`);
  } catch (e) { log(`⚠ alert threw: ${e.message}`); }
}

async function postSlackPng(pngPath, title, comment) {
  if (DRY) { log(`[dry] would post ${pngPath} to #${SLACK_CHANNEL}`); return; }
  if (!SLACK_TOKEN || !SLACK_CHANNEL) throw new Error("SLACK_BOT_TOKEN / SLACK_CHANNEL not set");
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
    body: JSON.stringify({ files: [{ id: r1.file_id, title }], channel_id: SLACK_CHANNEL, initial_comment: comment }),
  }).then(r => r.json());
  if (!r3.ok) throw new Error(`completeUploadExternal: ${r3.error}`);
  log(`✓ Slack posted · file ${r3.files?.[0]?.id || "—"}`);
}

async function main() {
  log(`→ Vini daily control tower${DRY ? " (DRY RUN)" : ""} — ${new Date().toISOString()}`);

  // 1. Assemble + guardrail
  const { assembleSlackPayload } = await import("../server/slackPayload.js");
  const { payload, guardrail } = await assembleSlackPayload();
  log(`  guardrail: contracted=${guardrail.contractedCount} live=${guardrail.liveCount} d1Leads=${guardrail.d1Leads} d1Appts=${guardrail.d1Appts} (dataDay ${guardrail.dataDay})`);

  // 2. GUARDRAIL — refuse to send on a broken/zero feed.
  const zeros = [];
  if (!(guardrail.contractedCount > 0)) zeros.push("contracted cohort empty (Master Sheet)");
  if (!(guardrail.liveCount > 0))       zeros.push("live agents = 0 (Master Sheet)");
  if (!(guardrail.d1Leads > 0))         zeros.push(`yesterday leads = 0 (ClickHouse spine, ${guardrail.dataDay})`);
  if (zeros.length) throw new Error(`data check failed — ${zeros.join("; ")}`);

  // 3. Email (existing, proven scripts; they re-fetch and self-load env)
  const node = process.execPath;
  log("→ email: regenerate + send");
  execFileSync(node, [join(SCRIPTS, "previewAgentsEmail.js")], { cwd: CT, stdio: "inherit" });
  if (DRY) log("[dry] would run sendVinniReport.js");
  else execFileSync(node, [join(SCRIPTS, "sendVinniReport.js"), guardrail.dataDay], { cwd: CT, stdio: "inherit" });

  // 4. Slack Option B — build + render + post
  log("→ slack: build Option B + render + post");
  const { buildTableHtml } = await import("../server/slackOptionTable.js");
  const puppeteer = (await import("puppeteer")).default;
  const html = buildTableHtml(payload);
  const htmlPath = join(CT, "slack-daily.html");
  const pngPath  = join(CT, "slack-daily.png");
  writeFileSync(htmlPath, html);
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 });
    await page.goto("file://" + htmlPath, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts ? document.fonts.ready : null);
    await page.screenshot({ path: pngPath, fullPage: true, type: "png" });
  } finally { await browser.close(); }
  await postSlackPng(pngPath, `Vini Control Tower · ${payload.asOfDate}`, `Vini Daily Snapshot — ${payload.asOfDate}`);

  log(`✓ Done${DRY ? " (dry)" : ""}.`);
}

main().catch(async (err) => {
  console.error("✗", err.message);
  await slackAlert(`${err.message}\n_No email or Slack report was sent. Please resolve and re-run._`);
  process.exit(1);
});
