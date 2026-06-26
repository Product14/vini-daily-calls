// Run: node scripts/sendVinniReport.js
//
// POSTs agents-preview-2.html (the generated stakeholder report) to
// mail.spyne.ai/api/v1/send-template-email using the
// "email-control-tower-report-vini" template. Recipient + cookie are
// read from .env (see .env.example).
//
// Pipeline:
//   1. Read .env (no dotenv dep — minimal parser inline)
//   2. Read agents-preview-2.html
//   3. POST with HTMLdata templateData
//   4. Print the response
//
// Exits 0 on success, non-zero on any failure so cron can alert on it.

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");

// ─── tiny .env loader (no dependency) ──────────────────────────────────────
function loadDotenv() {
  const path = join(ROOT, "..", ".env");   // repo-root .env (shared with parent project)
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    let val   = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotenv();

function reqEnv(k) {
  const v = process.env[k];
  if (!v || !v.trim() || v.includes("__paste_here__")) {
    console.error(`✗ Missing/placeholder env var: ${k}. See .env.example`);
    process.exit(1);
  }
  return v.trim();
}
function listEnv(k) {
  return (process.env[k] || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

// ─── read HTML report ─────────────────────────────────────────────────────
const HTML_PATH = join(ROOT, "agents-preview-2.html");
if (!existsSync(HTML_PATH)) {
  console.error(`✗ ${HTML_PATH} not found — run scripts/previewAgentsEmail.js first`);
  process.exit(1);
}
const html = readFileSync(HTML_PATH, "utf8");

// ─── build payload ────────────────────────────────────────────────────────
const cookie    = reqEnv("SPYNE_MAIL_COOKIE");
const template  = reqEnv("SPYNE_MAIL_TEMPLATE");
const to        = listEnv("MAIL_TO");
const cc        = listEnv("MAIL_CC");
const bcc       = listEnv("MAIL_BCC");

if (!to.length) {
  console.error("✗ MAIL_TO is empty — set at least one recipient in .env");
  process.exit(1);
}

// Date stamp in the subject so a missed/duplicate send is visible. Accepts
// an optional CLI override (e.g. `node sendVinniReport.js 2026-06-16`) for
// backfilling missed daily sends.
const dateArg = process.argv[2];   // optional YYYY-MM-DD
const dateForSubject = dateArg
  ? new Date(dateArg + "T12:00:00+05:30")
  : new Date();
const today = dateForSubject.toLocaleDateString("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
});
const subject = `Vini Control Tower Report · ${today}`;

const body = {
  to:  to[0],                    // API takes a single "to"; rest in cc
  cc:  cc.concat(to.slice(1)),
  bcc,
  subject,
  template,
  templateData: { HTMLdata: html },
};

// ─── POST ─────────────────────────────────────────────────────────────────
console.log(`→ Sending "${subject}" to ${to[0]}${cc.length ? ` (cc: ${cc.length})` : ""}${bcc.length ? ` (bcc: ${bcc.length})` : ""}…`);

const res = await fetch("https://mail.spyne.ai/api/v1/send-template-email", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Cookie":       cookie,
  },
  body: JSON.stringify(body),
});

const text = await res.text();
if (!res.ok) {
  console.error(`✗ HTTP ${res.status} ${res.statusText}`);
  console.error(text);
  process.exit(1);
}

console.log(`✓ HTTP ${res.status} · ${text.slice(0, 200)}`);
