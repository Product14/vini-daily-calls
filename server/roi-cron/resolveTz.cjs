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
//
// ★ THE API NOW 401s WITHOUT A TOKEN (found 2026-10-08). So the self-heal never healed: nothing was
// persisted, and every events pass re-asked for every unresolved rooftop, up to four times each
// (tz + hours, sales + service). With 141 targets lacking a timezone that alone cost ~280 calls a
// pass, inside a cron that was already timing out at 300s. The same team settings are mirrored in
// ClickHouse (eventila.enterprise_team_details, synced from the same database the API reads), so
// that is now the first source, fetched for the whole pass in ONE query (primeTeamDetails), with
// the API kept as a fallback. Every answer, found or not, is remembered for the life of the
// instance, so a rooftop that resolves nowhere costs one lookup, not one per pass.
const SPYNE_API_BASE = process.env.SPYNE_API_BASE || "https://api.spyne.ai";
const CH = require("./leadCaptureCH.cjs");

const lit = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const MISS_TTL_MS = 60 * 60 * 1000; // re-ask about a rooftop that resolved nowhere at most hourly
const _details = new Map(); // teamId → { value: {timezone, workingDays} | null, at }
const _persisted = new Set(); // `${teamId}:tz|hours` written back this instance — one write each
const remembered = (teamId) => {
  const hit = _details.get(teamId);
  if (!hit) return undefined;
  if (hit.value === null && Date.now() - hit.at > MISS_TTL_MS) { _details.delete(teamId); return undefined; }
  return hit.value;
};
// The fleet is North American. A team setting outside that is a data-entry error, not a dealer's
// zone (2026-10-08: "Evansville" set to Africa/Abidjan, "Davidson Autos Watertown" to Asia/Calcutta),
// and persisting it would leave the rooftop further off than the America/New_York default. Such a
// value is logged and treated as unresolved; the setting itself needs fixing in Spyne.
//
// EXPLICIT ALLOWLIST (2026-10-09). The previous test was "anything under America/", which let Mexican
// and Central/South American zones through (America/Cancun, America/Costa_Rica, America/Bahia_Banderas
// all seen in prod runs, A1 F12) and silently shifted those rooftops' windows. Only US (lower 48,
// Alaska, Hawaii, Puerto Rico) and Canadian zones, plus their legacy US/* and Canada/* links, are accepted.
const NORTH_AMERICAN_TZ = new Set([
  // United States — Eastern / Central / Mountain / Pacific / Alaska / Hawaii / Puerto Rico
  "America/New_York", "America/Detroit", "America/Kentucky/Louisville", "America/Kentucky/Monticello", "America/Louisville",
  "America/Indiana/Indianapolis", "America/Indiana/Vincennes", "America/Indiana/Winamac", "America/Indiana/Marengo",
  "America/Indiana/Petersburg", "America/Indiana/Vevay", "America/Indiana/Tell_City", "America/Indiana/Knox", "America/Indianapolis",
  "America/Fort_Wayne", "America/Knox_IN",
  "America/Chicago", "America/Menominee", "America/North_Dakota/Center", "America/North_Dakota/New_Salem", "America/North_Dakota/Beulah",
  "America/Denver", "America/Boise", "America/Phoenix", "America/Shiprock",
  "America/Los_Angeles",
  "America/Anchorage", "America/Juneau", "America/Sitka", "America/Metlakatla", "America/Yakutat", "America/Nome", "America/Adak", "America/Atka",
  "Pacific/Honolulu", "America/Puerto_Rico",
  "US/Eastern", "US/East-Indiana", "US/Indiana-Starke", "US/Michigan", "US/Central", "US/Mountain", "US/Arizona", "US/Pacific",
  "US/Alaska", "US/Aleutian", "US/Hawaii",
  // Canada
  "America/Toronto", "America/Montreal", "America/Nipigon", "America/Thunder_Bay", "America/Iqaluit", "America/Pangnirtung",
  "America/Atikokan", "America/Winnipeg", "America/Rainy_River", "America/Resolute", "America/Rankin_Inlet",
  "America/Regina", "America/Swift_Current", "America/Edmonton", "America/Cambridge_Bay", "America/Yellowknife", "America/Inuvik",
  "America/Dawson_Creek", "America/Fort_Nelson", "America/Creston", "America/Whitehorse", "America/Dawson", "America/Vancouver",
  "America/Halifax", "America/Glace_Bay", "America/Moncton", "America/Goose_Bay", "America/St_Johns", "America/Blanc-Sablon",
  "Canada/Atlantic", "Canada/Central", "Canada/Eastern", "Canada/Mountain", "Canada/Newfoundland", "Canada/Pacific",
  "Canada/Saskatchewan", "Canada/Yukon",
]);
const isNorthAmericanTz = (tz) => NORTH_AMERICAN_TZ.has(String(tz || "").trim());
const plausibleTz = (tz, teamId) => {
  if (!tz) return null;
  const z = String(tz).trim();
  if (isNorthAmericanTz(z)) return z;
  console.warn(`[tz] ${teamId} team settings say "${z}" — not a US/Canada zone, ignored (fix the team's timezone in Spyne)`);
  return null;
};
const parseWorkingDays = (s) => {
  if (!s) return null;
  if (typeof s === "object") return s;
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : null; } catch { return null; }
};

// Team settings for many rooftops in ONE ClickHouse read. Returns Map teamId → {timezone,
// workingDays}; rooftops ClickHouse doesn't know are absent. Never throws.
async function fetchTeamDetailsCH(teamIds) {
  const ids = [...new Set((teamIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length || !CH.hasCreds()) return out;
  try {
    const rows = await CH._chQuery(
      "SELECT team_id, timezone, working_days FROM eventila.enterprise_team_details FINAL" +
      " WHERE _peerdb_is_deleted=0 AND team_id IN (" + ids.map(lit).join(",") + ")");
    for (const r of rows) {
      const timezone = plausibleTz(r.timezone ? String(r.timezone) : null, r.team_id);
      const workingDays = parseWorkingDays(r.working_days);
      if (timezone || workingDays) out.set(String(r.team_id), { timezone, workingDays });
    }
  } catch (e) {
    console.warn(`[tz] team-settings lookup failed (${String(e && e.message || e).slice(0, 120)}) — falling back to the Spyne API`);
  }
  return out;
}

// Prefetch team settings for every rooftop a pass is about to visit, so the per-rooftop resolvers
// below read memory instead of making a call each. Only asks about rooftops not already remembered.
async function primeTeamDetails(teamIds) {
  const ask = [...new Set((teamIds || []).filter(Boolean).map(String))].filter((t) => remembered(t) === undefined);
  if (!ask.length) return;
  const found = await fetchTeamDetailsCH(ask);
  for (const t of ask) if (found.has(t)) _details.set(t, { value: found.get(t), at: Date.now() });
}

// BOTH the timezone and the full per-weekday schedule (e.g. {"monday":{"is_working":true,
// "start_time":"08:00","end_time":"18:00"}, ...}) for one rooftop: memory → ClickHouse → the Spyne
// API. resolveTz() and resolveWorkingHours() each persist their own half independently — a rooftop
// that already has a cached timezone but no cached working_hours yet (or vice versa) still only
// needs ONE of these.
async function fetchTeamWorkingDaysLive(teamId) {
  if (!teamId) return null;
  const known = remembered(teamId);
  if (known !== undefined) return known;
  let value = (await fetchTeamDetailsCH([teamId])).get(String(teamId)) || null;
  if (!value) {
    try {
      const res = await fetch(
        `${SPYNE_API_BASE}/user-management/v1/team/get-working-days?teamId=${encodeURIComponent(teamId)}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const d = (await res.json())?.data;
        if (d) value = { timezone: plausibleTz(d.timezone ? String(d.timezone) : null, teamId), workingDays: d.workingDays || null };
      }
    } catch { /* unresolved — remembered below */ }
  }
  _details.set(teamId, { value, at: Date.now() });
  return value;
}
async function fetchTeamTzLive(teamId) {
  const d = await fetchTeamWorkingDaysLive(teamId);
  return d ? d.timezone : null;
}

// configuredTz → live Spyne lookup (persisted back) → "America/New_York" (logged, never silent).
async function resolveTz(sb, teamId, configuredTz, rooftopLabel) {
  // The configured value goes through the same allowlist: it is free text in the tracker drawer (no
  // validation, A1 F12), and an unknown zone would also crash every Intl call made with it.
  if (configuredTz && isNorthAmericanTz(configuredTz)) return String(configuredTz).trim();
  if (configuredTz) console.warn(`[tz] ${rooftopLabel || teamId} roi_rooftop_config.timezone "${configuredTz}" is not a US/Canada zone — ignored, resolving from team settings`);
  const live = await fetchTeamTzLive(teamId);
  if (live) {
    if (!_persisted.has(`${teamId}:tz`)) {
      _persisted.add(`${teamId}:tz`);
      console.warn(`[tz] ${rooftopLabel || teamId} had no roi_rooftop_config.timezone — resolved from team settings: ${live}`);
      try { await sb.from("roi_rooftop_config").update({ timezone: live }).eq("team_id", teamId); } catch {}
    }
    return live;
  }
  console.warn(`[tz] ${rooftopLabel || teamId} — timezone unresolved (config + team settings both empty), defaulting to America/New_York`);
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
      if (!_persisted.has(`${teamId}:hours`)) {
        _persisted.add(`${teamId}:hours`);
        console.warn(`[hours] ${rooftopLabel || teamId} had no roi_rooftop_config.working_hours — resolved from team settings`);
        try { await sb.from("roi_rooftop_config").update({ working_hours: workingDays }).eq("team_id", teamId); } catch {}
      }
    }
  }
  if (!workingDays) return null;
  const today = workingDays[todayWeekday(tz)];
  if (!today || today.is_working === false || !today.start_time || !today.end_time) return null;
  return { startTime: String(today.start_time), endTime: String(today.end_time) };
}

/* Today's dealer-local working status — what resolveWorkingHours() can't say, because it returns null
 * both for "closed today" and for "we don't know the hours". The overdue digest needs the difference:
 * it must stay silent on a CLOSED day (28 digests went out on Sunday 10-05 through the fallback hours,
 * A3-17) but still fire on its fallback hours when the schedule is simply unknown.
 *   { status: 'open', startTime, endTime } | { status: 'closed' } | { status: 'unknown' } */
async function resolveWorkingDay(sb, teamId, cachedWorkingDays, rooftopLabel, tz) {
  const hours = await resolveWorkingHours(sb, teamId, cachedWorkingDays, rooftopLabel, tz);
  if (hours) return { status: "open", ...hours };
  const known = cachedWorkingDays || (remembered(teamId) || {}).workingDays || null;
  if (!known || typeof known !== "object") return { status: "unknown" };
  const today = known[todayWeekday(tz)];
  if (today && today.is_working === false) return { status: "closed" };
  return { status: "unknown" };
}

module.exports = { resolveTz, resolveWorkingHours, resolveWorkingDay, isNorthAmericanTz, NORTH_AMERICAN_TZ, fetchTeamTzLive, fetchTeamWorkingDaysLive, primeTeamDetails, fetchTeamDetailsCH };
