// Daily-digest enrichment — upcoming appointments (car + schedule) and top vehicles
// of interest. These used to come from a direct ClickHouse query against
// dealer_leads.meetings, a SECOND source of truth that could silently drift from the
// numbers the reports show. They now come from the Reporting service (reporting-vini)
// — the SAME meetings basis behind every appointment count in the report — so the two
// always agree. ClickHouse is no longer touched here.
//
//   GET {apiBase}/api/meetings?scope=upcoming&team_id&enterprise_id&serviceType
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

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`reporting-api ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/**
 * @param {string} teamId  dealer_leads team id
 * @param {{dollarRate?:number, dept?:string, enterpriseId?:string, apiBase?:string, token?:string}} opts
 *   dollarRate  — $/appointment for the per-row Est. value (config, not data)
 *   dept        — "sales" | "service" → serviceType filter (omit/both => rooftop-wide)
 *   enterpriseId— scopes the meetings call to the right enterprise (REQUIRED for cross-enterprise runs)
 *   apiBase     — Reporting service base URL (defaults to REPORTING_API_BASE)
 *   token       — Spyne API token forwarded as auth_key; else the service uses its own SPYNE_API_TOKEN
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

  // Fetch both in parallel; a failure in one must not drop the other.
  const [apptsRes, vehRes] = await Promise.allSettled([
    fetchJson(`${base}/api/meetings?scope=upcoming&${qs}`),
    fetchJson(`${base}/api/meetings?scope=top-vehicles&${qs}`),
  ]);

  let appointments = [];
  if (apptsRes.status === "fulfilled") {
    appointments = (apptsRes.value?.meetings || []).slice(0, 5).map((m) => ({
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

  return { appointments, topVehicles };
}
