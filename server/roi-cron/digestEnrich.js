// Daily-digest enrichment — upcoming appointments (car + schedule) and top vehicles
// of interest. These used to come from a direct ClickHouse query against
// dealer_leads.meetings, a SECOND source of truth that could silently drift from the
// numbers the reports show. They now come from the Reporting service (reporting-vini)
// — the SAME meetings basis behind every appointment count in the report — so the two
// always agree. ClickHouse is no longer touched here.
//
//   GET {apiBase}/api/meetings?scope=window&team_id&enterprise_id&serviceType&start&end
//   GET {apiBase}/api/meetings?scope=top-vehicles&team_id&enterprise_id&serviceType
//
// Best-effort: any failure (network, auth, empty) degrades to empty arrays and the
// template simply omits those sections — identical to the old CH-creds-absent behavior.

const REPORTING_API_BASE = process.env.REPORTING_API_BASE || "https://reporting-vini.vercel.app";
const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** "Mon, Jun 23 · 2:30 PM" in the meeting's own timezone (matches the old CH format). */
function fmtSched(iso, tz) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const zone = tz || "America/New_York";
  try {
    const datePart = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(d);
    const timePart = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: zone }).format(d);
    return `${datePart} · ${timePart}`;
  } catch {
    return "";
  }
}

// reporting-vini's read API requires a credential (it returns PII). The meetings call already forwards
// the Spyne token as ?auth_key=; this header is a fallback to the trusted service secret so the call
// still authorizes when no per-rooftop token was passed.
const REPORTING_AUTH = process.env.CRON_SECRET || process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || "";
async function fetchJson(url) {
  const headers = REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`reporting-api ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/**
 * @param {string} teamId  dealer_leads team id
 * @param {{dollarRate?:number, dept?:string, enterpriseId?:string, apiBase?:string, token?:string, start?:string, end?:string}} opts
 *   dollarRate  — $/appointment for the per-row Est. value (config, not data)
 *   dept        — "sales" | "service" → serviceType filter (omit/both => rooftop-wide)
 *   enterpriseId— scopes the meetings call to the right enterprise (REQUIRED for cross-enterprise runs)
 *   apiBase     — Reporting service base URL (defaults to REPORTING_API_BASE)
 *   token       — Spyne API token forwarded as auth_key; else the service uses its own SPYNE_API_TOKEN
 *   start,end   — the REPORT window (yyyy-mm-dd, end exclusive). When given, appointments are the ones
 *                 BOOKED in that window (scope=window) so the list tracks the report's date and reconciles
 *                 with its appointment count. Omitted → scope=upcoming (appointments upcoming as of now).
 * @returns {Promise<{appointments:Array,topVehicles:Array}>}
 */
export async function enrichRooftop(teamId, opts = {}) {
  if (!teamId) return { appointments: [], topVehicles: [] };
  const rate = N(opts.dollarRate);
  const base = (opts.apiBase || REPORTING_API_BASE).replace(/\/$/, "");
  const params = new URLSearchParams({ team_id: String(teamId) });
  if (opts.enterpriseId) params.set("enterprise_id", String(opts.enterpriseId));
  if (opts.dept === "sales" || opts.dept === "service") params.set("serviceType", opts.dept);
  if (opts.token) params.set("auth_key", String(opts.token));
  const qs = params.toString();

  // Appointments BOOKED in the report window (scope=window) so the list tracks the report's date and
  // its count reconciles with the headline; falls back to now-relative upcoming when no window is given.
  const apptUrl = opts.start && opts.end
    ? `${base}/api/meetings?scope=window&start=${encodeURIComponent(opts.start)}&end=${encodeURIComponent(opts.end)}&${qs}`
    : `${base}/api/meetings?scope=upcoming&${qs}`;

  // Warm/hot leads (buying intent, no appointment yet) for the "Leads to call now" section — the
  // workable pipeline. Sourced from the SAME reporting-vini report the counts come from (j.warmLeads),
  // dept-filtered below. Best-effort: a failure just omits the section.
  const reportUrl = `${base}/api/reports?team_id=${encodeURIComponent(String(teamId))}`
    + (opts.enterpriseId ? `&enterprise_id=${encodeURIComponent(String(opts.enterpriseId))}` : "")
    + (opts.start && opts.end ? `&start=${encodeURIComponent(opts.start)}&end=${encodeURIComponent(opts.end)}` : "");

  // Fetch in parallel; a failure in one must not drop the others.
  const [apptsRes, vehRes, warmRes] = await Promise.allSettled([
    fetchJson(apptUrl),
    fetchJson(`${base}/api/meetings?scope=top-vehicles&${qs}`),
    fetchJson(reportUrl),
  ]);

  let appointments = [];
  if (apptsRes.status === "fulfilled") {
    // No cap here — the template displays the first 6 and uses the full length for its "view all (N)"
    // total, so every booked customer is represented in the count.
    appointments = (apptsRes.value?.meetings || []).map((m) => ({
      sched: fmtSched(m.when, m.tz || opts.tz),
      customer: (m.customer || "").trim() || "Customer",
      phone: m.phone || "",
      vehicle: (m.vehicle || "").trim() || "—",
      intent: m.intent || "",
      estValue: rate || undefined,
    }));
  } else {
    console.warn("[digest-enrich] upcoming appointments skipped:", String(apptsRes.reason).slice(0, 160));
  }

  let topVehicles = [];
  if (vehRes.status === "fulfilled") {
    topVehicles = (vehRes.value?.vehicles || [])
      .filter((v) => (v.name || "").trim())
      .map((v) => ({ name: v.name.trim(), count: N(v.count) }));
  } else {
    console.warn("[digest-enrich] top vehicles skipped:", String(vehRes.reason).slice(0, 160));
  }

  // Warm leads → "Leads to call now". Filter to this department; hot first.
  let warmLeads = [];
  if (warmRes.status === "fulfilled") {
    const dept = opts.dept === "sales" || opts.dept === "service" ? opts.dept : null;
    warmLeads = (warmRes.value?.warmLeads || [])
      .filter((w) => !dept || (w.serviceType || "").toLowerCase() === dept)
      .filter((w) => (w.customer || "").trim() || (w.phone || "").trim())
      .map((w) => ({ customer: (w.customer || "").trim() || "Lead", phone: w.phone || "", tier: w.tier === "hot" ? "hot" : "warm", interest: w.interest || "", lastActivity: w.lastActivity || null }))
      .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "hot" ? -1 : 1))
      .slice(0, 8);
  } else {
    console.warn("[digest-enrich] warm leads skipped:", String(warmRes.reason).slice(0, 160));
  }

  return { appointments, topVehicles, warmLeads };
}
