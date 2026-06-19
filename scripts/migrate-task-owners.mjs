// One-time migration: normalise programs_tasks.task_dri to canonical full names.
//
// Mirrors the alias map in src/programs/owners.ts. Dry-run by default; pass
// --execute to write. Junk values (CHURN, task titles in the owner field) and
// empty owners are left untouched.
//
//   node scripts/migrate-task-owners.mjs            # dry run — prints the plan
//   node scripts/migrate-task-owners.mjs --execute  # apply to Supabase

const URL = process.env.VITE_PROGRAMS_SUPABASE_URL || "https://zocdmtehlfeozrtitmej.supabase.co";
const KEY = process.env.VITE_PROGRAMS_SUPABASE_KEY || "sb_publishable_71TOgS-eKBNL-x4zpspV4Q_JyZn6Hx6";
const EXECUTE = process.argv.includes("--execute");

// (canonical name, [extra aliases]) — bare email local-part and the canonical
// name itself also resolve automatically.
const OWNERS = [
  ["Ankur Batra",        "ankur.batra@spyne.ai",      ["ankur"]],
  ["Shubham Mittal",     "shubham.mittal@spyne.ai",   ["shubham"]],
  ["Subhav Malhotra",    "subhav.malhotra@spyne.ai",  []],
  ["Abhijeet Mitra",     "abhijeet.mitra@spyne.ai",   []],
  ["Prabha Kumari",      "prabha.kumari@spyne.ai",    []],
  ["Jaspreet Kaur",      "jaspreet.kaur@spyne.ai",    []],
  ["Ankit Singh",        "ankit.singh@spyne.ai",      []],
  ["Puneet Sharma",      "puneet.sharma@spyne.ai",    []],
  ["Vishal Singh",       "vishal.singh1@spyne.ai",    []],
  ["Sanyam Tyagi",       "sanyam.tyagi@spyne.ai",     []],
  ["Lakshay Narang",     "lakshay.narang@spyne.ai",   []],
  ["Aditya Kaul",        "aditya.kaul@spyne.ai",      []],
  ["Zeeshana Aijaz",     "zeeshana.aijaz@spyne.ai",   []],
  ["Yash Sharma",        "yash.sharma@spyne.ai",      ["yash"]],
  ["Ishan Gill",         "ishan.gill@spyne.ai",       []],
  ["Tushar Shrivastava", "tushar.shrivastava@spyne.ai", []],
  ["Manpreet Kaur",      "manpreet.kaur@spyne.ai",    ["manpreet"]],
  ["Devansh Hasija",     "devansh.hasija@spyne.ai",   ["devansh"]],
  ["Prakash",            "",                          []],
  ["Sanu",               "",                          []],
  ["Bhaskar",            "",                          []],
  ["Ritika",             "",                          []],
];

const ALIAS_TO_NAME = new Map();
for (const [name, email, aliases] of OWNERS) {
  ALIAS_TO_NAME.set(name.toLowerCase(), name);
  if (email) ALIAS_TO_NAME.set(email.toLowerCase(), name);
  for (const a of aliases) ALIAS_TO_NAME.set(a.toLowerCase(), name);
}
const canonical = (raw) => {
  const s = (raw ?? "").trim();
  if (!s) return null;
  return ALIAS_TO_NAME.get(s.toLowerCase()) ?? null;
};

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function main() {
  const res = await fetch(`${URL}/rest/v1/programs_tasks?select=task_dri&limit=5000`, { headers });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();

  // Count tasks per distinct raw value.
  const counts = new Map();
  for (const r of rows) {
    const k = r.task_dri ?? "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const changes = [];   // { raw, to, count }
  const leave = [];      // { raw, count, reason }
  for (const [raw, count] of counts) {
    const to = canonical(raw);
    if (!raw.trim()) { leave.push({ raw, count, reason: "empty (no owner)" }); continue; }
    if (to == null)  { leave.push({ raw, count, reason: "unrecognised — left as-is" }); continue; }
    if (to === raw)  { leave.push({ raw, count, reason: "already canonical" }); continue; }
    changes.push({ raw, to, count });
  }
  changes.sort((a, b) => b.count - a.count);

  console.log(`\n${EXECUTE ? "EXECUTING" : "DRY RUN"} — ${rows.length} tasks, ${counts.size} distinct owners\n`);
  console.log("CHANGES:");
  let changed = 0;
  for (const c of changes) { console.log(`  ${String(c.count).padStart(3)}  "${c.raw}"  →  "${c.to}"`); changed += c.count; }
  console.log(`\n  ${changed} task rows will change across ${changes.length} distinct values\n`);
  console.log("LEFT AS-IS:");
  for (const l of leave.sort((a, b) => b.count - a.count)) console.log(`  ${String(l.count).padStart(3)}  "${l.raw}"  (${l.reason})`);

  if (!EXECUTE) { console.log("\nRe-run with --execute to apply.\n"); return; }

  console.log("\nApplying…");
  for (const c of changes) {
    const r = await fetch(`${URL}/rest/v1/programs_tasks?task_dri=eq.${encodeURIComponent(c.raw)}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ task_dri: c.to }),
    });
    if (!r.ok) { console.error(`  FAILED "${c.raw}" → "${c.to}": ${r.status} ${await r.text()}`); continue; }
    console.log(`  ok  "${c.raw}" → "${c.to}" (${c.count})`);
  }
  console.log("\nDone.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
