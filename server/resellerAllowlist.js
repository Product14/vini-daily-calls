// Reseller-owned enterprises that ARE real paying rooftops — the reseller exemption.
//
// Business rule: every metric query screens enterprises with
// `(ed.reseller_id IS NULL OR ed.reseller_id = '')`. That clause was written to keep partner
// sandboxes out of fleet numbers, but `reseller_id` only records that a channel partner owns the
// commercial relationship — it does NOT separate a sandbox from a paying dealership. So genuine
// rooftops sold through a partner were filtered out of every metric entirely.
//
// Caught 2026-09-02 on Michael Hohl Chevrolet GMC (b858509a68) and Toyota of Poway (064f07c700),
// both under enterprise 62f962c8e (CallSource Auto, reseller_id 66396058e). Their console reports
// read "<name>'s report is on its way" forever while ClickHouse held hundreds of real calls. 7 of
// CallSource's 11 rooftops have activity; the other 4 have never had a lead.
//
// An ALLOWLIST, not a removal of the clause: ~40 reseller enterprises are hidden and they are
// genuinely mixed — real dealer groups sit beside c360-demo, Vincue-Demo, Netlook Ext QA and
// kartik dealer 1. Dropping the clause outright would pour those into the daily digest, the ROI
// tracker and the agent dashboards. Add an enterprise here only once someone has confirmed it is a
// paying customer whose numbers should count.
//
// Rather than fork the Metabase-synced SQL (server/agentBaseFact.sql and the 6 spine queries in
// agentMetricsQueries.json are regenerated from card 12227), this injects the exemption at load
// time, the same way callbackAttribution.js / warmTransferExclusion.js / qualifiedRules.js do. On
// re-sync the fix re-applies automatically, and drift in the upstream SQL fails loudly instead of
// silently reverting to the old universe.
//
// KEPT IN LOCKSTEP with reporting-vini's src/lib/reports/enterpriseScope.ts (RESELLER_ALLOWLIST).
// The two repos read the same ClickHouse tables and are compared against each other constantly, so
// an id added there must be added here or the console and the digest disagree about who exists.
//
// DELIBERATELY NOT APPLIED to controlTower/server/creditFunnel.js — that is the CARR/ARR ledger
// funnel, not an operating metric. See the note at its enterprise filter.

/** Reseller-owned enterprises that are real paying rooftops and must not be screened out. */
export const RESELLER_ALLOWLIST = [
  "62f962c8e", // CallSource Auto — 11 rooftops (Toyota of Poway, Michael Hohl Chevrolet GMC, …)
];

// The exact screen every spine query opens its enterprise filter with. Appears once per
// enterprise_details join; the metric/intent queries join it twice, the voucher queries not at all.
const ANCHOR = "(ed.reseller_id IS NULL OR ed.reseller_id = '')";

const quoted = (ids) => ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(", ");

/** SQL fragment: not reseller-owned, OR an allowlisted reseller. Exported so the non-injected
 *  call sites (standalone analysis SQL) can interpolate the same text. */
export function resellerScopeSql(alias = "ed") {
  const base = `${alias}.reseller_id IS NULL OR ${alias}.reseller_id = ''`;
  return RESELLER_ALLOWLIST.length
    ? `(${base} OR ${alias}.enterprise_id IN (${quoted(RESELLER_ALLOWLIST)}))`
    : `(${base})`;
}

/**
 * Widens every reseller screen in `sql` to exempt the allowlisted enterprises.
 * SQL with no reseller screen (the voucher queries) is returned untouched.
 * Throws when the SQL joins enterprise_details but carries no recognisable screen — i.e. the
 * upstream shape changed, so the fix needs review rather than silently leaving the old universe.
 */
export function applyResellerAllowlist(sql, label = "sql") {
  if (!RESELLER_ALLOWLIST.length) return sql;
  if (sql.includes("enterprise_id IN (")) return sql; // already applied
  const hits = sql.split(ANCHOR).length - 1;
  if (hits === 0) {
    // No screen at all is only legitimate when the query never joins enterprise_details.
    if (sql.includes("eventila.enterprise_details")) {
      throw new Error(
        `[resellerAllowlist] ${label}: joins enterprise_details but has no recognisable reseller ` +
        `screen — upstream SQL changed, fix needs review`
      );
    }
    return sql;
  }
  return sql.replaceAll(ANCHOR, resellerScopeSql("ed"));
}
