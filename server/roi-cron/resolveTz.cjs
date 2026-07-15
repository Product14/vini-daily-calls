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

// Single live call to the working-days API — returns BOTH the timezone and the full per-weekday
// schedule (e.g. {"monday":{"is_working":true,"start_time":"08:00","end_time":"18:00"}, ...}).
// resolveTz() and resolveWorkingHours() each cache/persist their own half of this response
// independently (see below) — a rooftop that already has a cached timezone but no cached
// working_hours yet (or vice versa) still only needs ONE of these, not both.
async function fetchTeamWorkingDaysLive(teamId) {
  if (!teamId) return null;
  try {
    const res = await fetch(
      `${SPYNE_API_BASE}/user-management/v1/team/get-working-days?teamId=${encodeURIComponent(teamId)}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const d = j && j.data;
    if (!d) return null;
    return { timezone: d.timezone ? String(d.timezone) : null, workingDays: d.workingDays || null };
  } catch {
    return null;
  }
}
async function fetchTeamTzLive(teamId) {
  const d = await fetchTeamWorkingDaysLive(teamId);
  return d ? d.timezone : null;
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

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// Today's dealer-local weekday name, from the SAME tz already resolved for this rooftop — so a
// rooftop that crosses midnight mid-pass still reads the correct day for its own local calendar,
// not the server's.
function todayWeekday(tz) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/New_York", weekday: "long" }).format(new Date()).toLowerCase(); }
  catch { return WEEKDAY_NAMES[new Date().getUTCDay()]; }
}

// cachedWorkingDays → live Spyne lookup (persisted back to roi_rooftop_config.working_hours) →
// null (caller falls back to a fixed hour — see EVENT_OVERDUE_*_FALLBACK_HOUR in eventRunner.cjs).
// Returns today's { startTime, endTime } ("HH:MM" strings) for the dealer's OWN weekday schedule
// (e.g. Jones CDJR: Mon-Sat 08:00-18:00, Sun 09:00-17:30 — a single global hour would be wrong on
// their Sunday), or null if today isn't a working day / nothing resolved.
async function resolveWorkingHours(sb, teamId, cachedWorkingDays, rooftopLabel, tz) {
  let workingDays = cachedWorkingDays || null;
  if (!workingDays) {
    const live = await fetchTeamWorkingDaysLive(teamId);
    if (live && live.workingDays) {
      workingDays = live.workingDays;
      console.warn(`[hours] ${rooftopLabel || teamId} had no roi_rooftop_config.working_hours — resolved live`);
      try { await sb.from("roi_rooftop_config").update({ working_hours: workingDays }).eq("team_id", teamId); } catch {}
    }
  }
  if (!workingDays) return null;
  const today = workingDays[todayWeekday(tz)];
  if (!today || today.is_working === false || !today.start_time || !today.end_time) return null;
  return { startTime: String(today.start_time), endTime: String(today.end_time) };
}

module.exports = { resolveTz, resolveWorkingHours, fetchTeamTzLive, fetchTeamWorkingDaysLive };
