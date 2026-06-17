// One-shot seed for the "Actually Live" flag on programs_account_state.
//
// Usage:
//   node scripts/import-actual-status.js [csv-path]
//   (defaults to scripts/actual-live-seed.csv)
//
// What it does:
//   1. Parses the CSV — each row is a (team_id × agent_opted) that should be
//      treated as Actually Live.
//   2. Dedupes (CSV has a few accidental duplicates, e.g. Feldmann Service OB).
//   3. Builds the matching account_key — "tid:<team_id>::<agent_type>" — for
//      every CSV row.
//   4. Upserts a row into programs_account_state with actual_live = true.
//      If a row already exists (account_dri, tasks, notes, etc.), only
//      actual_live is touched.
//
// Re-runnable — safe to invoke any time. Won't reset rows you've toggled off
// in the UI back to true (the CSV defines what's "live initially"; user
// edits via UI are the source of truth thereafter).
//
// Requires env: VITE_PROGRAMS_SUPABASE_URL + VITE_PROGRAMS_SUPABASE_KEY.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import "../server/loadEnv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2] || path.join(__dirname, "actual-live-seed.csv");

// Minimal CSV parser (handles quoted fields).
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

function normAgent(s) {
  const t = (s ?? "").trim().toLowerCase();
  if (t === "sales inbound")    return "Sales Inbound";
  if (t === "sales outbound")   return "Sales Outbound";
  if (t === "service inbound")  return "Service Inbound";
  if (t === "service outbound") return "Service Outbound";
  return null;
}

async function main() {
  const URL = process.env.VITE_PROGRAMS_SUPABASE_URL;
  const KEY = process.env.VITE_PROGRAMS_SUPABASE_KEY;
  if (!URL || !KEY) {
    console.error("Missing VITE_PROGRAMS_SUPABASE_URL or VITE_PROGRAMS_SUPABASE_KEY in .env");
    process.exit(1);
  }
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });

  console.log(`[1/3] Parsing ${csvPath}…`);
  const text = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  if (!rows.length) { console.error("Empty CSV"); process.exit(1); }

  // First row is the header
  const hdr = rows[0].map(s => (s ?? "").toLowerCase().trim());
  const idxTeam  = hdr.indexOf("team id");
  const idxAgent = hdr.indexOf("agent opted");
  const idxEnt   = hdr.indexOf("enterprise id");
  if (idxTeam < 0 || idxAgent < 0) {
    console.error("Expected columns: 'Team ID' and 'Agent Opted' — found:", hdr);
    process.exit(1);
  }

  const keys = new Set();
  const skipped = { badAgent: 0, missingTeam: 0 };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const team = (r[idxTeam] ?? "").trim();
    const agent = normAgent(r[idxAgent]);
    if (!team)  { skipped.missingTeam++; continue; }
    if (!agent) { skipped.badAgent++;    continue; }
    keys.add(`tid:${team}::${agent}`);
  }
  console.log(`   ${keys.size} unique (rooftop × agent) live rows · skipped: ${JSON.stringify(skipped)}`);

  console.log(`[2/3] Upserting into programs_account_state…`);
  const stripAgent = (k) => { const i = k.indexOf("::"); return i > 0 ? k.slice(0, i) : k; };
  const rooftopIdOf = (k) => {
    const m = /^tid:([^:]+)::/.exec(k);
    return m ? m[1] : null;
  };
  const agentTypeOf = (k) => {
    const m = /^tid:[^:]+::(.+)$/.exec(k);
    return m ? m[1] : null;
  };

  const CHUNK = 50;
  const arr = Array.from(keys).map(k => ({
    account_key: k,
    rooftop_id:  rooftopIdOf(k),
    agent_type:  agentTypeOf(k),
    actual_live: true,
    updated_at:  new Date().toISOString(),
  }));
  for (let i = 0; i < arr.length; i += CHUNK) {
    const chunk = arr.slice(i, i + CHUNK);
    const { error } = await sb
      .from("programs_account_state")
      .upsert(chunk, { onConflict: "account_key" });
    if (error) {
      console.error(`Chunk ${i / CHUNK} failed:`, error.message);
      process.exit(1);
    }
  }
  console.log(`   ${arr.length} rows upserted`);

  console.log(`[3/3] Done.`);
  console.log(`Tip: the dashboard's Account List has an 'Actual Status' checkbox per row;`);
  console.log(`     toggling it from the UI is the source of truth from here on.`);
}

main().catch(e => { console.error("Import failed:", e); process.exit(1); });
