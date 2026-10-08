/* The zones the schedule editor offers: US and Canadian IANA zones. Mirrors NA_TIMEZONES in
 * server/roi-cron/sendGates.cjs, which /api/rooftop-config validates against (a test keeps the two
 * lists identical). A free-text zone used to be saved as typed, and one invalid value stops the
 * hourly digest pass for every rooftop (A1 F6, A4 F4). */
export const NA_TIMEZONES = [
  "America/New_York", "America/Detroit", "America/Kentucky/Louisville", "America/Kentucky/Monticello",
  "America/Indiana/Indianapolis", "America/Indiana/Vincennes", "America/Indiana/Winamac", "America/Indiana/Marengo",
  "America/Indiana/Petersburg", "America/Indiana/Vevay", "America/Indiana/Tell_City", "America/Indiana/Knox",
  "America/Chicago", "America/Menominee", "America/North_Dakota/Center", "America/North_Dakota/New_Salem",
  "America/North_Dakota/Beulah", "America/Denver", "America/Boise", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "America/Juneau", "America/Sitka", "America/Metlakatla", "America/Yakutat", "America/Nome",
  "America/Adak", "Pacific/Honolulu", "America/Puerto_Rico",
  "America/Toronto", "America/Halifax", "America/Glace_Bay", "America/Moncton", "America/Goose_Bay",
  "America/St_Johns", "America/Winnipeg", "America/Regina", "America/Swift_Current", "America/Edmonton",
  "America/Vancouver", "America/Whitehorse", "America/Dawson_Creek", "America/Fort_Nelson", "America/Creston",
  "America/Indianapolis", "America/Louisville",
];

/** The zones this browser can format, with a readable label ("America/Chicago · CDT"). */
export function timezoneOptions(now = new Date()): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const tz of NA_TIMEZONES) {
    try {
      const abbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
      out.push({ value: tz, label: abbr ? `${tz.replace(/_/g, " ")} · ${abbr}` : tz.replace(/_/g, " ") });
    } catch { /* not known to this browser */ }
  }
  return out;
}
