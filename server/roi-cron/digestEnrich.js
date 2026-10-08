// Daily-digest enrichment — upcoming appointments (car + schedule) and top vehicles
// of interest. These used to come from a direct ClickHouse query against
// dealer_leads.meetings, a SECOND source of truth that could silently drift from the
// numbers the reports show. They now come from the Reporting service (reporting-vini)
// — the SAME meetings basis behind every appointment count in the report — so the two
// always agree. ClickHouse is no longer touched here.
//
//   appointments → the /api/reports response the KPI numbers came from (j.namedAppointments)
//   GET {apiBase}/api/meetings?scope=top-vehicles&team_id&enterprise_id&serviceType&days
//
// Best-effort: any failure (network, auth, empty) degrades to empty arrays and the
// template simply omits those sections — identical to the old CH-creds-absent behavior.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// REASON FOR SERVICE. One exception to the "ClickHouse is no longer touched here" note above, and
// it does not reopen the drift it warns about: nothing below is a COUNT. The captured service work
// is a field the Reporting API does not carry at all — the same gap leadCaptureCH exists for — so
// the appointments table can only get it from the call report. Every number in the digest still
// comes from Reporting alone.
const { fetchServiceReasonsByLead } = require("./leadCaptureCH.cjs");
const { fmtServiceReason } = require("../../src/email/transactionalTemplates.cjs");

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

// reporting-vini's read API requires a credential (it returns PII): the trusted service secret as Bearer,
// so every call authorizes whether or not a per-rooftop Spyne token is passed.
// canonical: reporting-vini authorizes on ITS service secret — prefer a dedicated REPORTING_CRON_SECRET
// (= reporting-vini's secret), NOT necessarily this app's CRON_SECRET. Falls back to the old chain.
const REPORTING_AUTH = process.env.REPORTING_CRON_SECRET || process.env.CRON_SECRET || process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || "";
// A per-rooftop Spyne token rides in the X-Spyne-Token header (reporting-vini stab/reporting-parity),
// never in the URL (?auth_key= ends up in request logs). The Bearer service secret above still
// authorizes the call on any deploy; the rooftop's enterprise travels as enterprise_id.
async function fetchJson(url, spyneToken) {
  const headers = REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {};
  if (spyneToken) headers["X-Spyne-Token"] = String(spyneToken);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`reporting-api ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/**
 * @param {string} teamId  dealer_leads team id
 * @param {{dollarRate?:number, dept?:string, enterpriseId?:string, apiBase?:string, token?:string, start?:string, end?:string, report?:object, topVehiclesDays?:number}} opts
 *   dollarRate  — $/appointment for the per-row Est. value (config, not data)
 *   dept        — "sales" | "service" → serviceType filter (omit/both => rooftop-wide)
 *   enterpriseId— scopes every call to the rooftop's own enterprise (REQUIRED for cross-enterprise runs)
 *   apiBase     — Reporting service base URL (defaults to REPORTING_API_BASE)
 *   token       — Spyne API token, sent as the X-Spyne-Token header (never in the URL)
 *   start,end   — the REPORT window (yyyy-mm-dd, end exclusive).
 *   report      — the /api/reports response for exactly that window, already fetched by the runner for
 *                 the KPI numbers. When given, the appointment lists and warm leads are read from IT, so
 *                 the list under "Appointments — AI-booked" is the same rows the number counts.
 *   topVehiclesDays — trailing window for "Top vehicles" (the meetings route has no period window).
 * @returns {Promise<{appointments:Array, assistedAppointments:Array, topVehicles:Array, topVehiclesDays:number, warmLeads:Array}>}
 */
export async function enrichRooftop(teamId, opts = {}) {
  if (!teamId) return { appointments: [], assistedAppointments: [], topVehicles: [], topVehiclesDays: null, warmLeads: [] };
  const rate = N(opts.dollarRate);
  const base = (opts.apiBase || REPORTING_API_BASE).replace(/\/$/, "");
  const dept = opts.dept === "sales" || opts.dept === "service" ? opts.dept : null;
  const params = new URLSearchParams({ team_id: String(teamId) });
  if (opts.enterpriseId) params.set("enterprise_id", String(opts.enterpriseId));
  if (dept) params.set("serviceType", dept);
  const qs = params.toString();
  const tok = opts.token ? String(opts.token) : undefined;
  const windowed = !!(opts.start && opts.end);
  // "Top vehicles" is a trailing N-day ranking from now (the meetings route takes `days`, not a period),
  // so the email labels it with N rather than presenting it as the report's own period.
  const tvDays = Math.max(1, Math.min(180, Number(opts.topVehiclesDays) || 30));

  // The /api/reports response for the report window: the runner hands over the one it already fetched
  // for the numbers; only a caller without one fetches it here.
  const reportUrl = `${base}/api/reports?team_id=${encodeURIComponent(String(teamId))}`
    + (opts.enterpriseId ? `&enterprise_id=${encodeURIComponent(String(opts.enterpriseId))}` : "")
    + (windowed ? `&start=${encodeURIComponent(opts.start)}&end=${encodeURIComponent(opts.end)}` : "")
    + "&omit=leadSources"; // never shown in the digest; hotLeads is kept (it IS the Sales warm-lead list)

  // Fetch in parallel; a failure in one must not drop the others.
  const [reportRes, vehRes, upcomingRes] = await Promise.allSettled([
    opts.report && typeof opts.report === "object" ? Promise.resolve(opts.report) : fetchJson(reportUrl, tok),
    fetchJson(`${base}/api/meetings?scope=top-vehicles&days=${tvDays}&${qs}`, tok),
    // No report window → the old now-relative "upcoming" list (no caller does this today).
    windowed ? Promise.resolve(null) : fetchJson(`${base}/api/meetings?scope=upcoming&${qs}`, tok),
  ]);

  const toRow = (svcReasons) => (m) => {
    const svc = svcReasons.get(String((m && m.leadId) || "")) || null;
    return {
      sched: fmtSched(m.when, m.tz || opts.tz),
      customer: (m.customer || "").trim() || "Customer",
      phone: m.phone || "",
      vehicle: (m.vehicle || "").trim() || (svc && svc.vehicleName) || "—",
      intent: m.intent || "",
      // capped at 2 — this is a one-line sub-caption under the customer name, not the alert card
      reason: svc ? fmtServiceReason(svc.services, svc.intent, 2) : "",
      assisted: Boolean(m.assisted),
      estValue: rate || undefined,
    };
  };
  // The table header has always promised "Customer · vehicle · reason" while rendering the booking
  // intent ('schedule_appointment'), which is not a reason — it's the one thing the service manager
  // already knows. Service depts only: report_service is empty on sales calls.
  const reasonsFor = async (rows) => (dept === "service"
    ? await fetchServiceReasonsByLead(teamId, rows.map((m) => m && m.leadId)).catch(() => new Map())
    : new Map());

  // APPOINTMENTS, from the SAME /api/reports response as the "Appointments — AI-booked" KPI
  // (j.namedAppointments: store-local booking days, this department only). AI-booked and AI-assisted
  // (CRM) rows come back as two lists and are never listed under one heading. This used to be a second
  // source (/api/meetings?scope=window: UTC-day bounds, both kinds mixed), and the list footer contradicted
  // the KPI in 242 of 634 sends. No cap: the template shows the first rows, the KPI carries the count.
  let appointments = [], assistedAppointments = [];
  if (windowed) {
    if (reportRes.status === "fulfilled") {
      const named = (reportRes.value?.namedAppointments || [])
        .filter((a) => a && (!dept || String(a.serviceType || "").toLowerCase() === dept));
      const row = toRow(await reasonsFor(named));
      appointments = named.filter((a) => !a.assisted).map(row);
      assistedAppointments = named.filter((a) => a.assisted).map(row);
    } else {
      console.warn("[digest-enrich] appointments skipped:", String(reportRes.reason).slice(0, 160));
    }
  } else if (upcomingRes.status === "fulfilled" && upcomingRes.value) {
    const raw = upcomingRes.value.meetings || [];
    appointments = raw.map(toRow(await reasonsFor(raw)));
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
  if (reportRes.status === "fulfilled") {
    warmLeads = (reportRes.value?.warmLeads || [])
      .filter((w) => !dept || (w.serviceType || "").toLowerCase() === dept)
      .filter((w) => (w.customer || "").trim() || (w.phone || "").trim())
      .map((w) => ({ customer: (w.customer || "").trim() || "Lead", phone: w.phone || "", tier: w.tier === "hot" ? "hot" : "warm", interest: w.interest || "", lastActivity: w.lastActivity || null }))
      .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "hot" ? -1 : 1))
      .slice(0, 8);
  } else {
    console.warn("[digest-enrich] warm leads skipped:", String(reportRes.reason).slice(0, 160));
  }

  return { appointments, assistedAppointments, topVehicles, topVehiclesDays: tvDays, warmLeads };
}
