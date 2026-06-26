// Run: node scripts/sendSlackReport.js
//
// Builds the Slack-thumbnail PNG version of the daily Vini report. Per CEO
// 18-Jun: Slack is consumed on mobile, ~50 daily reports compete in the
// channel, so the VALUE has to land in the thumbnail itself.
//
// Output files:
//   slack-report.html  — source (open in browser at 720px to QA)
//   slack-report.png   — the thumbnail to paste into Slack
//
// Posting is manual until a SLACK_BOT_TOKEN lands in .env (incoming webhooks
// can't upload files; files.upload needs a bot token).

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname }                            from "path";
import { fileURLToPath }                            from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");

// Tiny .env loader (no dependency)
(function loadDotenv() {
  const envPath = join(ROOT, "..", ".env");   // repo-root .env (shared CLICKHOUSE_* + CT vars)
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

import { fetchAgentsTotals }                       from "../server/agentsSource.js";
import {
  fetchContractedAgents,  summarizeContracted,
  fetchInOb,              summarizeInOb,
  fetchLiveAndChurned,    summarizeLiveChurned,
  fetchBlockedReasons,    topBlockerReasons,
} from "../server/viniMasterSheet.js";
import { joinAppointments, computeRoiAndRag, summarizeVini } from "../server/viniAgentTracker.js";
import { fetchAllQuality }                          from "../server/superbrynQuality.js";
import { buildHistoricalMetrics, AGENT_ORDER }      from "../server/historicalAggregates.js";
import { buildSlackHtml }                           from "../server/slackHtmlTemplate.js";
import puppeteer                                    from "puppeteer";

// ─── Fetch the same data set as the email ────────────────────────────────
console.log("→ Building Slack thumbnail report…");
const [contractedRows, obRows, liveChurnRows, blockerRows, totals, quality] = await Promise.all([
  fetchContractedAgents(),
  fetchInOb(),
  fetchLiveAndChurned(),
  fetchBlockedReasons(),
  fetchAgentsTotals(),
  fetchAllQuality({ lookbackHours: 24 }).catch(() => null),
]);
const contracted = summarizeContracted(contractedRows);
const obSummary  = summarizeInOb(obRows);
const liveChurn  = summarizeLiveChurned(liveChurnRows);
const scored     = computeRoiAndRag(joinAppointments(liveChurn.live.rows, totals));
const vini       = summarizeVini([
  ...scored,
  ...liveChurn.churn.rows.map(r => ({ ...r, rag: "Red", redKind: null, roiMultiple: null })),
]);
const topBlockers5 = topBlockerReasons(blockerRows, 5);

const todaySnap = {
  ragByAgent: vini.byAgentType.map(b => ({ label: b.label, live: b.live, green: b.green })),
};
const historical = await buildHistoricalMetrics({
  todaySnapshot: todaySnap,
  todayQuality:  quality,
  obSummary,
});

// Per-agent funnel ARRs (same calc as email).
const perAgentArr = {};
for (const agent of AGENT_ORDER) {
  const cArr  = contractedRows.filter(r => r.agentShort === agent).reduce((s, r) => s + (r.arr || 0), 0);
  const obArr = obSummary.byAgentType.find(b => b.label === agent)?.arr || 0;
  const liveB = vini.byAgentType.find(b => b.label === agent);
  const liveArr = liveB ? (liveB.greenArr || 0) + (liveB.amberArr || 0) + (liveB.redArr || 0) : 0;
  perAgentArr[agent] = { cArr, obArr, liveArr };

  // Mehul whiteboard (applied 26-Jun): ARR-weighted ROI Multiple per agent.
  let arrSum = 0, roiW = 0;
  for (const a of scored) {
    if (a.agentShort !== agent) continue;
    if (a.roiMultiple == null || a.arr == null) continue;
    roiW   += a.roiMultiple * a.arr;
    arrSum += a.arr;
  }
  const roi = arrSum > 0 ? roiW / arrSum : null;
  if (historical?.byAgent?.[agent]) {
    historical.byAgent[agent].roiMultiple = {
      mtd: roi, d1: roi, d2: null, d3: null, m1: null, m2: null, m3: null,
    };
  }
}

// Per-agent ARR deltas — diff vs the most recent prior snapshot the email
// run saved. User 23-Jun: show movement inline in the per-agent ARR strip.
import { readdirSync } from "fs";
const SNAP_DIR = join(ROOT, "data", "snapshots");
const perAgentArrDeltas = (() => {
  if (!existsSync(SNAP_DIR)) return {};
  const todayDate = historical.dates.today;
  const files = readdirSync(SNAP_DIR)
    .filter(f => /^email-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace(/^email-|\.json$/g, ""))
    .filter(d => d < todayDate)
    .sort();
  if (!files.length) return {};
  let prior;
  try { prior = JSON.parse(readFileSync(join(SNAP_DIR, `email-${files[files.length - 1]}.json`), "utf8")); } catch { return {}; }
  const out = {};
  for (const agent of AGENT_ORDER) {
    const cur = perAgentArr[agent] || {};
    const prv = prior.perAgentArr?.[agent];
    const prvOb   = prv?.obArr   ?? (prior.obByAgent || []).find(b => b.label === agent)?.arr;
    const prvLive = prv?.liveArr ?? (() => {
      const r = (prior.ragByAgent || []).find(b => b.label === agent);
      return r ? (r.greenArr || 0) + (r.amberArr || 0) + (r.redArr || 0) : null;
    })();
    out[agent] = {
      cArr:    prv?.cArr != null ? cur.cArr - prv.cArr : null,
      obArr:   prvOb     != null ? cur.obArr - prvOb   : null,
      liveArr: prvLive   != null ? cur.liveArr - prvLive : null,
    };
  }
  return out;
})();

const today = historical.dates.today;
const dateStr = new Date(today + "T12:00:00").toLocaleDateString("en-US", {
  weekday: "short", month: "short", day: "numeric", year: "numeric",
});

const html = buildSlackHtml({
  funnel: {
    contracted: { agents: contracted.count,        arr: contracted.arr        },
    ob:         { agents: obSummary.totalCount,    arr: obSummary.totalArr    },
    live:       { agents: vini.live.count,         arr: vini.live.arr         },
    churned:    { agents: liveChurn.churn.count,   arr: liveChurn.churn.arr   },
  },
  asOfDate:    dateStr,
  dates:       historical.dates,
  byAgent:     historical.byAgent,
  perAgentArr,
  perAgentArrDeltas,
  topBlocker:  topBlockers5[0] || null,
});

const htmlPath = join(ROOT, "slack-report.html");
const pngPath  = join(ROOT, "slack-report.png");
writeFileSync(htmlPath, html);
console.log(`✓ slack-report.html written`);

// ─── Render to PNG via puppeteer ─────────────────────────────────────────
// fullPage screenshots pad to the viewport height when content is shorter
// — measure body first, then clip exactly to it so the PNG isn't padded
// with empty whitespace.
console.log("→ Rendering PNG (720w @ 2x DPR, clipped to content)…");
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 720, height: 300, deviceScaleFactor: 2 });
  await page.goto("file://" + htmlPath, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts ? document.fonts.ready : null);
  const bodyH = await page.evaluate(() => document.body.offsetHeight);
  await page.setViewport({ width: 720, height: bodyH, deviceScaleFactor: 2 });
  await page.screenshot({
    path: pngPath,
    type: "png",
    clip: { x: 0, y: 0, width: 720, height: bodyH },
  });
  console.log(`✓ slack-report.png written (720 × ${bodyH}px source · 1440 × ${bodyH * 2} retina)`);
} finally {
  await browser.close();
}

// ─── Print headline summary so the run shows what landed in the PNG ──────
console.log(`
  Funnel:  ${contracted.count} contracted ($${(contracted.arr/1e6).toFixed(2)}M) → ${obSummary.totalCount} OB ($${(obSummary.totalArr/1e6).toFixed(2)}M) → ${vini.live.count} Live ($${(vini.live.arr/1e6).toFixed(2)}M) → ${liveChurn.churn.count} Churn
  Per-agent (Live · ABR D-1 · % Green D-1):`);
for (const a of AGENT_ORDER) {
  const m = historical.byAgent[a] || {};
  const live  = m.liveAgents?.d1 ?? "—";
  const abr   = m.abr?.d1   != null ? `${(m.abr.d1 * 100).toFixed(1)}%` : "—";
  const green = m.pctGreen?.d1 != null ? `${Math.round(m.pctGreen.d1 * 100)}%` : "—";
  console.log(`    ${a.padEnd(11)} Live ${String(live).padStart(3)}  ABR ${abr.padStart(5)}  Green ${green}`);
}

// ─── Post to Slack (manual until bot token is wired) ─────────────────────
const botToken = process.env.SLACK_BOT_TOKEN;
const channel  = process.env.SLACK_CHANNEL || "central-analytics-programs";
if (!botToken) {
  console.log(`\n⚠ SLACK_BOT_TOKEN not set — preview only.`);
  console.log(`   To post: drag slack-report.png into #${channel} OR add a bot token to .env.`);
  process.exit(0);
}

// files.uploadV2 flow: getUploadURLExternal → upload → completeUploadExternal.
async function slackUpload() {
  const fileBytes = readFileSync(pngPath);
  const filename  = `vini-daily-${today}.png`;

  // 1) request upload URL
  const r1 = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: { "Authorization": `Bearer ${botToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ filename, length: String(fileBytes.length) }),
  }).then(r => r.json());
  if (!r1.ok) throw new Error(`getUploadURLExternal: ${r1.error}`);

  // 2) upload bytes
  const r2 = await fetch(r1.upload_url, { method: "POST", body: fileBytes });
  if (!r2.ok) throw new Error(`upload PUT: HTTP ${r2.status}`);

  // 3) complete + share to channel
  const r3 = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { "Authorization": `Bearer ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [{ id: r1.file_id, title: `Vini Daily · ${dateStr}` }],
      channel_id: channel,
      initial_comment: `Vini Daily Snapshot — ${dateStr}`,
    }),
  }).then(r => r.json());
  if (!r3.ok) throw new Error(`completeUploadExternal: ${r3.error}`);
  return r3;
}

const result = await slackUpload();
console.log(`✓ Posted to #${channel} · file id ${result.files?.[0]?.id || "—"}`);
