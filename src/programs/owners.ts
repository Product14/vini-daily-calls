// ─── Canonical task-owner registry ──────────────────────────────────────────
// Single source of truth for the Task Owner dropdown in the account drawer and
// for normalising historical `programs_tasks.task_dri` values.
//
// Each owner has:
//   • name    — canonical full name. This is what we STORE in task_dri and show
//               everywhere (no more mix of first-name / full-name / email).
//   • email   — Spyne corp address; "" when the surname/email isn't known yet.
//   • team    — default team. Selecting an owner in the drawer auto-fills the
//               task's `function` to this, but it stays editable per task.
//   • aliases — raw task_dri forms (matched case-insensitively) that fold into
//               this canonical owner. Used by the one-time migration and to keep
//               older spellings resolving correctly. The canonical `name` and a
//               bare-email/first-name are matched automatically, so aliases only
//               need the *extra* spellings seen in the data.
//
// Adding a new owner: append a row here. To give Prakash / Sanu / Bhaskar /
// Ritika a proper full name + email later, just edit their `name`/`email` and
// add their old first-name to `aliases` so historical rows still resolve.

export type OwnerTeam = "CSM" | "Product" | "Engineering" | "Operations" | "Dealer" | "PM";

export type Owner = {
  name: string;
  email: string;
  team: OwnerTeam;
  aliases: string[];
};

export const OWNERS: Owner[] = [
  { name: "Ankur Batra",        email: "ankur.batra@spyne.ai",      team: "CSM",         aliases: ["ankur.batra@spyne.ai", "ankur"] },
  { name: "Shubham Mittal",     email: "shubham.mittal@spyne.ai",   team: "Engineering", aliases: ["shubham.mittal@spyne.ai", "shubham"] },
  { name: "Subhav Malhotra",    email: "subhav.malhotra@spyne.ai",  team: "Product",     aliases: ["subhav.malhotra@spyne.ai"] },
  { name: "Abhijeet Mitra",     email: "abhijeet.mitra@spyne.ai",   team: "CSM",         aliases: ["abhijeet.mitra@spyne.ai"] },
  { name: "Prabha Kumari",      email: "prabha.kumari@spyne.ai",    team: "CSM",         aliases: ["prabha.kumari@spyne.ai"] },
  { name: "Jaspreet Kaur",      email: "jaspreet.kaur@spyne.ai",    team: "CSM",         aliases: [] },
  { name: "Ankit Singh",        email: "ankit.singh@spyne.ai",      team: "Engineering", aliases: [] },
  { name: "Puneet Sharma",      email: "puneet.sharma@spyne.ai",    team: "CSM",         aliases: [] },
  { name: "Vishal Singh",       email: "vishal.singh1@spyne.ai",    team: "CSM",         aliases: ["vishal.singh1@spyne.ai"] },
  { name: "Sanyam Tyagi",       email: "sanyam.tyagi@spyne.ai",     team: "CSM",         aliases: ["sanyam.tyagi@spyne.ai"] },
  { name: "Lakshay Narang",     email: "lakshay.narang@spyne.ai",   team: "Product",     aliases: [] },
  { name: "Aditya Kaul",        email: "aditya.kaul@spyne.ai",      team: "CSM",         aliases: [] },
  { name: "Zeeshana Aijaz",     email: "zeeshana.aijaz@spyne.ai",   team: "CSM",         aliases: ["zeeshana.aijaz@spyne.ai"] },
  { name: "Yash Sharma",        email: "yash.sharma@spyne.ai",      team: "Product",     aliases: ["yash.sharma@spyne.ai", "yash"] },
  { name: "Ishan Gill",         email: "ishan.gill@spyne.ai",       team: "Engineering", aliases: ["ishan.gill@spyne.ai"] },
  { name: "Tushar Shrivastava", email: "tushar.shrivastava@spyne.ai", team: "CSM",       aliases: ["tushar.shrivastava@spyne.ai"] },
  { name: "Manpreet Kaur",      email: "manpreet.kaur@spyne.ai",    team: "CSM",         aliases: ["manpreet.kaur@spyne.ai", "manpreet"] },
  { name: "Devansh Hasija",     email: "devansh.hasija@spyne.ai",   team: "Product",     aliases: ["devansh.hasija@spyne.ai", "devansh"] },
  // TODO: surname/email unknown — bare first name kept as-is for now.
  { name: "Prakash",            email: "",                          team: "CSM",         aliases: [] },
  { name: "Sanu",               email: "",                          team: "Operations",  aliases: [] },
  { name: "Bhaskar",            email: "",                          team: "Engineering", aliases: [] },
  { name: "Ritika",             email: "",                          team: "CSM",         aliases: [] },
];

// alias (lowercased) → canonical name. Includes the canonical name itself and
// the local-part of each email so a bare first name / email both resolve.
const ALIAS_TO_NAME = new Map<string, string>();
for (const o of OWNERS) {
  ALIAS_TO_NAME.set(o.name.trim().toLowerCase(), o.name);
  if (o.email) ALIAS_TO_NAME.set(o.email.trim().toLowerCase(), o.name);
  for (const a of o.aliases) ALIAS_TO_NAME.set(a.trim().toLowerCase(), o.name);
}

/**
 * Resolve a raw task_dri value to its canonical owner name.
 * Returns null when the value is empty or unrecognised (junk like "CHURN" or a
 * task title pasted into the owner field) — callers leave those untouched.
 */
export function canonicalOwnerName(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  return ALIAS_TO_NAME.get(s.toLowerCase()) ?? null;
}

/** Default team for a canonical owner name; null if not a known owner. */
export function teamForOwner(name: string | null | undefined): OwnerTeam | null {
  const s = (name ?? "").trim().toLowerCase();
  if (!s) return null;
  return OWNERS.find(o => o.name.toLowerCase() === s)?.team ?? null;
}

/** Owner full names for the dropdown, alphabetical. */
export const OWNER_NAMES: string[] = OWNERS.map(o => o.name).sort((a, b) => a.localeCompare(b));
