// Self-healing rooftop-timezone resolver for the transactional pipeline.
//
// roi_rooftop_config.timezone is a manually-set override; when it's blank (e.g. a rooftop was
// onboarded but nobody set it in RooftopCellDrawer), eventRunner used to hardcode
// "America/New_York" — silently wrong for any non-Eastern dealer (confirmed: 32 live rooftops,
// e.g. Hyundai Carson, Toyota of Poway, were showing appointment/action-item times in NY time).
//
// reporting-vini already solved this for its own reports via the Spyne working-hours API
// (src/lib/reports/tzMap.ts: GET .../user-management/v1/team/get-working-days, no token
// required) — that's the canonical source of a rooftop's configured timezone. Mirror it here:
// live lookup, persisted back to roi_rooftop_config so later passes don't re-fetch, and only
// fall back to America/New_York if even the live API has nothing.
const SPYNE_API_BASE = process.env.SPYNE_API_BASE || "https://api.spyne.ai";

async function fetchTeamTzLive(teamId) {
  if (!teamId) return null;
  try {
    const res = await fetch(
      `${SPYNE_API_BASE}/user-management/v1/team/get-working-days?teamId=${encodeURIComponent(teamId)}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return j?.data?.timezone ? String(j.data.timezone) : null;
  } catch {
    return null;
  }
}

// configuredTz → live Spyne lookup (persisted back) → "America/New_York" (logged, never silent).
async function resolveTz(sb, teamId, configuredTz, rooftopLabel) {
  if (configuredTz) return configuredTz;
  const live = await fetchTeamTzLive(teamId);
  if (live) {
    console.warn(`[tz] ${rooftopLabel || teamId} had no roi_rooftop_config.timezone — resolved live: ${live}`);
    try { await sb.from("roi_rooftop_config").update({ timezone: live }).eq("team_id", teamId); } catch {}
    return live;
  }
  console.warn(`[tz] ${rooftopLabel || teamId} — timezone unresolved (config + live API both empty), defaulting to America/New_York`);
  return "America/New_York";
}

module.exports = { resolveTz, fetchTeamTzLive };
