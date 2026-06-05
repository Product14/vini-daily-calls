// One-shot importer for the Vini Success Standup CSV → Supabase programs_tasks.
//
// Usage:
//   node scripts/import-standup.js [csv-path]
//   (defaults to scripts/standup-june-w1.csv)
//
// Behavior:
//   - Skips rows that aren't actionable: empty/blank "Tasks to turn green",
//     "Not live", "Not service", "Churned"-marker rows.
//   - For each (rooftop × agent_type) it touches, **deletes the existing tasks
//     and replaces them with the CSV row's task**. So re-running the script
//     after a fresh standup updates the dashboard cleanly.
//   - Owner resolution:
//       Next Step Owner = "" + team = CSM → use the account's CSM (from funnel sheet)
//       Next Step Owner = "Shubham Mittal" / "Yash" / "Subhav" → mapped to email
//       Function maps: "Tech" → "Engineering"; everything else passes through.
//
// Requires: VITE_PROGRAMS_SUPABASE_URL and VITE_PROGRAMS_SUPABASE_KEY in .env
// (already populated from previous setup).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

// Load .env from repo root.
import "../server/loadEnv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2] || path.join(__dirname, "standup-june-w1.csv");

// ─── Owner mapping ─────────────────────────────────────────────────────────
// Add / correct these as the standup-sheet roster evolves.
const OWNER_EMAILS = {
  "shubham mittal": "shubham.mittal@spyne.ai",
  "yash":           "yash.sharma@spyne.ai",
  "subhav":         "subhav.malhotra@spyne.ai",
};
const FUNCTION_MAP = {
  "csm":         "CSM",
  "engineering": "Engineering",
  "product":     "Product",
  "tech":        "Engineering",  // collapse to Engineering
  "operations":  "Operations",
  "pm":          "PM",
  "dealer":      "Dealer",
};

const FUNNEL_SHEET_ID = "15BScfybsSmmvQefXQxN-TYA_-cCNkD8qLDui7EML3ss";
const FUNNEL_MASTER_URL = `https://docs.google.com/spreadsheets/d/${FUNNEL_SHEET_ID}/export?format=csv&gid=0`;

// ─── Minimal CSV parser (handles quoted fields with commas + escaped quotes) ──
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (field !== "" || row.length) { row.push(field); rows.push(row); }
        row = []; field = "";
        if (c === "\r" && text[i+1] === "\n") i++;
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function buildHeaderIndex(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cells = rows[r].map(s => (s ?? "").toLowerCase().replace(/_/g, " ").trim());
    if (cells.includes("rooftop name")) {
      const idx = {};
      cells.forEach((c, i) => { if (c && !(c in idx)) idx[c] = i; });
      return { headerRow: r, idx };
    }
  }
  return null;
}

function normalizeAgentType(s) {
  const t = (s ?? "").trim().toLowerCase();
  if (t === "sales inbound") return "Sales Inbound";
  if (t === "service inbound") return "Service Inbound";
  if (t === "sales outbound") return "Sales Outbound";
  if (t === "service outbound") return "Service Outbound";
  return null;
}

function accountKey(rooftopId, rooftopName, agentType) {
  if (rooftopId && rooftopId.trim()) return `tid:${rooftopId.trim()}::${agentType}`;
  return `name:${(rooftopName ?? "").toLowerCase().trim()}::${agentType}`;
}

function resolveOwner(rawOwner, fn, csmEmail) {
  const owner = (rawOwner ?? "").trim();
  if (owner) {
    const mapped = OWNER_EMAILS[owner.toLowerCase()];
    return mapped || owner;  // fallback: pass through as-is (will display via unfurl)
  }
  // Empty owner → CSM if function is CSM-ish, else null
  if (fn === "CSM") return csmEmail || "";
  return "";
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const URL = process.env.VITE_PROGRAMS_SUPABASE_URL;
  const KEY = process.env.VITE_PROGRAMS_SUPABASE_KEY;
  if (!URL || !KEY) {
    console.error("Missing VITE_PROGRAMS_SUPABASE_URL or VITE_PROGRAMS_SUPABASE_KEY in .env");
    process.exit(1);
  }
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });

  // 1. Build CSM map from the funnel sheet.
  console.log(`[1/4] Fetching funnel sheet for CSM mapping…`);
  const funnelText = await (await fetch(FUNNEL_MASTER_URL)).text();
  const funnelRows = parseCsv(funnelText);
  const funnelHdr = buildHeaderIndex(funnelRows);
  if (!funnelHdr) throw new Error("Could not locate header row in funnel sheet");
  const pick = (h, ...keys) => { for (const k of keys) if (h.idx[k] != null) return h.idx[k]; return undefined; };
  const F = {
    rooftopName: pick(funnelHdr, "rooftop name"),
    teamId:      pick(funnelHdr, "team id", "rooftop id"),
    agentType:   pick(funnelHdr, "agent opted", "agent type"),
    csmEmail:    pick(funnelHdr, "csm name", "csm email", "csm"),
    stage:       pick(funnelHdr, "stage", "current stage", "status"),
  };
  const csmByKey = new Map();        // account_key → csmEmail
  const liveKeys = new Set();        // only insert tasks for Live accounts
  for (let i = funnelHdr.headerRow + 1; i < funnelRows.length; i++) {
    const r = funnelRows[i];
    const name = (r[F.rooftopName] ?? "").trim();
    if (!name || name.startsWith("✏")) continue;
    const at = normalizeAgentType(r[F.agentType]);
    if (!at) continue;
    const stage = (r[F.stage] ?? "").toLowerCase().trim();
    const k = accountKey(r[F.teamId], name, at);
    if (stage === "live") liveKeys.add(k);
    const em = (r[F.csmEmail] ?? "").trim().toLowerCase();
    if (em && em.includes("@")) csmByKey.set(k, em);
  }
  console.log(`   ${liveKeys.size} Live accounts · ${csmByKey.size} with CSM email`);

  // 2. Parse standup CSV.
  console.log(`[2/4] Parsing standup CSV from ${csvPath}…`);
  const csvText = fs.readFileSync(csvPath, "utf8");
  const sRows = parseCsv(csvText);
  const sHdr = buildHeaderIndex(sRows);
  if (!sHdr) throw new Error("Could not locate header row in standup CSV");
  const S = {
    rooftopName: pick(sHdr, "rooftop name"),
    teamId:      pick(sHdr, "team id"),
    agentType:   pick(sHdr, "agent opted"),
    nextOwner:   pick(sHdr, "next step owner"),
    nextTeam:    pick(sHdr, "next step owner team"),
    task:        pick(sHdr, "tasks to turn green"),
  };
  if (S.task == null) throw new Error("Couldn't find 'Tasks to turn green' column");

  // 3. Build task list (one task per CSV row), filtered to Live accounts and
  //    non-empty actionable text.
  const tasks = [];
  const skipped = { notLive: 0, blankTask: 0, churn: 0, badAgent: 0 };
  for (let i = sHdr.headerRow + 1; i < sRows.length; i++) {
    const r = sRows[i];
    const name = (r[S.rooftopName] ?? "").trim();
    if (!name) continue;
    const at = normalizeAgentType(r[S.agentType]);
    if (!at) { skipped.badAgent++; continue; }
    const k = accountKey(r[S.teamId], name, at);
    if (!liveKeys.has(k)) { skipped.notLive++; continue; }

    let raw = (r[S.task] ?? "").trim();
    if (!raw) { skipped.blankTask++; continue; }
    // Strip leading "- " bullet syntax sometimes used in the sheet.
    raw = raw.replace(/^\s*-\s*/, "");
    if (/churn/i.test(raw)) { skipped.churn++; continue; }

    const rawTeam = (r[S.nextTeam] ?? "").trim().toLowerCase();
    const fn = FUNCTION_MAP[rawTeam] || "CSM";
    const ownerEmail = resolveOwner(r[S.nextOwner], fn, csmByKey.get(k));

    tasks.push({
      account_key: k,
      title: raw,
      task_dri: ownerEmail,
      function: fn,
      due_date: null,
      status: "Open",
      blocker_note: "",
    });
  }
  console.log(`   parsed ${tasks.length} tasks · skipped {notLive:${skipped.notLive}, blankTask:${skipped.blankTask}, churn:${skipped.churn}, badAgent:${skipped.badAgent}}`);

  // Show owner distribution.
  const ownerCounts = {};
  for (const t of tasks) ownerCounts[t.task_dri || "(no owner)"] = (ownerCounts[t.task_dri || "(no owner)"] ?? 0) + 1;
  console.log(`   owner distribution:`);
  for (const [e, c] of Object.entries(ownerCounts).sort((a,b)=>b[1]-a[1])) {
    console.log(`     ${String(c).padStart(3)} · ${e}`);
  }

  // 4. Replace tasks per account_key in Supabase.
  console.log(`[3/4] Replacing tasks in Supabase for ${new Set(tasks.map(t=>t.account_key)).size} accounts…`);

  // (a) Delete existing tasks for any account_key in the new task set.
  const touchedKeys = Array.from(new Set(tasks.map(t => t.account_key)));
  const CHUNK = 50;
  for (let i = 0; i < touchedKeys.length; i += CHUNK) {
    const chunk = touchedKeys.slice(i, i + CHUNK);
    const { error } = await sb.from("programs_tasks").delete().in("account_key", chunk);
    if (error) throw error;
  }

  // (b) Upsert account_state rows so the foreign key relationship is satisfied
  //     and account_state stays in sync.
  const stateRows = touchedKeys.map(k => {
    const m = /^tid:([^:]+)::(.+)$/.exec(k);
    const n = /^name:[^:]+::(.+)$/.exec(k);
    return {
      account_key: k,
      rooftop_id: m ? m[1] : null,
      agent_type: m ? m[2] : (n ? n[1] : null),
      account_dri: csmByKey.get(k) || "",
      root_causes: [],
      notes: "",
      updated_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < stateRows.length; i += CHUNK) {
    const chunk = stateRows.slice(i, i + CHUNK);
    const { error } = await sb.from("programs_account_state").upsert(chunk, { onConflict: "account_key" });
    if (error) throw error;
  }

  // (c) Insert new tasks.
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const chunk = tasks.slice(i, i + CHUNK);
    const { error } = await sb.from("programs_tasks").insert(chunk);
    if (error) throw error;
  }

  console.log(`[4/4] Done. Imported ${tasks.length} tasks across ${touchedKeys.length} accounts.`);
}

main().catch(e => { console.error("Import failed:", e); process.exit(1); });
