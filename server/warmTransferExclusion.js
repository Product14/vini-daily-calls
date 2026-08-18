// meetings.meta.source='warm_transfer' — appointment rows we did NOT create.
//
// Business rule: `dealer_leads.meetings.source` says who OWNS a booking ('spyne'
// = us, 'bdc'/'eleads' = the dealer's CRM). `meta.source` says HOW the row came
// to exist — and 'warm_transfer' rows are the customer's EXISTING appointments,
// pulled in around a transfer. Nobody just booked them; their start times are
// often the customer's own PAST visits. So `source='spyne'` alone is NOT proof
// the AI booked an appointment, and a warm_transfer row must never be counted as
// one or listed as one.
//
// Caught on Honda of Downtown Los Angeles, 2026-08-14: a manager received 7 "New
// appointment" emails for ONE customer in 6 seconds and asked why she had 7
// appointments. All 7 were warm_transfer rows (start times Jul-2024 → Jan-2026 —
// her own past service visits). The email send path already drops them
// (server/roi-cron/eventRunner.cjs + leadCaptureCH.fetchMeetingMetaSource); this
// module is the same rule for the dashboard's METRICS, so what we count matches
// what we send.
//
// Rather than fork the Metabase-synced SQL (server/agentBaseFact.sql and the 6
// spine queries in agentMetricsQueries.json are regenerated from card 12227),
// this injects the predicate into every meetings scan at load time, the same way
// callbackAttribution.js does. On re-sync the fix re-applies automatically, and
// drift in the upstream SQL fails loudly instead of silently skipping the fix.
//
// 'callback' meta.source rows are deliberately left alone (not asked for, not
// verified). Prod all-time (2026-08-18) has exactly three meta.source values —
// '' (97,583 rows), 'warm_transfer' (4,975 / 48 teams) and 'callback' (1,050) —
// so one equality test covers the rule.

// Every meetings scan in the spine reads the table under alias `m` …
const MEETINGS_SCAN = "dealer_leads.meetings AS m FINAL";
// … and opens its WHERE with this exact liveness pair, which appears nowhere
// else in the spine. Anchoring on it gates the AI-booked (source='spyne') and
// AI-assisted (source!='spyne') branches alike — both are meeting records, and
// a warm_transfer row is not a booking on either side.
const ANCHOR = "m.is_active = 1 AND m.__deleted = 0";
const PREDICATE = "lower(JSONExtractString(ifNull(m.meta, ''), 'source')) != 'warm_transfer'";

/**
 * Adds the warm_transfer exclusion to every `dealer_leads.meetings` scan in `sql`.
 * SQL with no meetings scan (e.g. the voucher queries) is returned untouched.
 * Throws when the anchor count doesn't match the scan count — i.e. the upstream
 * SQL grew a meetings scan shaped differently, so the fix needs review rather
 * than silently covering only some of the scans.
 */
export function applyWarmTransferExclusion(sql, label = "sql") {
  if (sql.includes("'warm_transfer'")) return sql; // already applied
  const scans = sql.split(MEETINGS_SCAN).length - 1;
  if (scans === 0) return sql; // nothing to gate
  const anchors = sql.split(ANCHOR).length - 1;
  if (anchors !== scans) {
    throw new Error(
      `[warmTransferExclusion] ${label}: ${scans} meetings scan(s) but ${anchors} anchor(s) ` +
      `— upstream SQL changed, fix needs review`
    );
  }
  return sql.replaceAll(ANCHOR, `${ANCHOR} AND ${PREDICATE}`);
}
