/* sendGates — the rules every MANUAL send path in server/app.js applies before it emails anyone.
 *
 * Why this exists: the crons (runner.cjs, eventRunner.cjs) refuse to email a churned rooftop, a
 * department held in dry run, a type the rooftop switched off, or a recipient who opted out. The
 * tracker's manual buttons (roi-send-now, roi-event-send-now, roi-event-generate-send,
 * roi-generate-send) checked none of that: one click on a dry-run department's "Send now" emailed
 * nine dealer addresses (A4/A5 audit, 2026-10-08). Every manual path now asks the same questions,
 * in one place, with the cron's own predicates.
 *
 * Pure: no I/O. The callers read cfg / live / recipients and hand them in.
 *
 * An override is the typed DANGER confirmation the no-value gate already uses (emailValue.overrideOk).
 * It may bypass churn, department dry run, a type toggle and the lead-capture restriction, never the
 * server's own DRY_RUN or a department removed from the emailer (is_live=false). The caller records
 * an overridden send on its row (trigger='manual', reason_detail naming the override).
 */
const { isChurned, isSubscribed } = require("./subscriptions.cjs");
const { emailBlock, normalizeEmail, addressProblem } = require("./emailHealth.cjs");
const { overrideOk } = require("./emailValue.cjs");

const CADENCES = ["daily", "weekly", "monthly"];
const EVENT_TYPES = ["post_appointment", "post_conversation", "action_item", "action_item_overdue"];
// eventRunner.cjs: a 'lead_capture' rooftop gets only the lead sheet, whatever these toggles say.
const LEAD_CAPTURE_SUPPRESSED = new Set(["post_appointment", "action_item", "action_item_overdue"]);

const TYPE_LABEL = {
  daily: "Daily digest", weekly: "Weekly digest", monthly: "Monthly digest",
  post_appointment: "Post-appointment", post_conversation: "Post-conversation",
  action_item: "Action item", action_item_overdue: "Action item overdue", chat: "Website chat",
};

/** Same parse as runner.cjs / eventRunner.cjs: anything but "false" / "0" keeps the server dry. */
function serverDryRun(env = process.env) {
  return !["false", "0"].includes(String(env.DRY_RUN ?? "").trim().toLowerCase());
}

const REFUSALS = {
  server_dry_run: { overridable: false, label: () => "Sending is turned off on this server (DRY_RUN). Nothing can be emailed from here." },
  not_live: { overridable: false, label: () => "This department is not live in the emailer, so nothing is sent for it." },
  churned: { overridable: true, label: () => "This rooftop has churned. The scheduled emails skip it." },
  dry_run: { overridable: true, label: () => "This department is held in dry run. The scheduled emails are not sent to the dealer." },
  disabled: { overridable: true, label: (t) => `${TYPE_LABEL[t] || t} is turned off for this rooftop.` },
  lead_capture: { overridable: true, label: () => "This rooftop is on the lead capture template, which turns off appointment, action-item and overdue emails." },
  bad_type: { overridable: false, label: (t) => `Unknown email type: ${t}` },
};
const refuse = (reason, type) => ({ ok: false, reason, label: REFUSALS[reason].label(type), overridable: REFUSALS[reason].overridable });

/** The checks both kinds of send share, in the cron's order of precedence. */
function commonGate({ cfg, live, localDate, env }) {
  if (serverDryRun(env)) return refuse("server_dry_run");
  if (!live || live.is_live === false) return refuse("not_live");
  if (isChurned(cfg, localDate)) return refuse("churned");
  // Only an explicit true holds, exactly as the crons read it (`L.dry_run === true`). A null
  // dry_run SENDS on the cron, so a manual path must not treat it as held either.
  if (live.dry_run === true) return refuse("dry_run");
  return null;
}

/** May a manual DIGEST send go out for this (rooftop, department, cadence, period)?
 * cfg  = roi_rooftop_config row (or null: daily still sends on defaults, weekly/monthly do not)
 * live = roi_live_departments row for the department
 * Mirrors runner.cjs: daily is off only when daily_enabled === false; weekly/monthly need
 * `${cadence}_enabled === true` (runCadence skips a rooftop with no config row). */
function canSendDigest({ cfg = null, live = null, cadence = "daily", localDate = "", env = process.env } = {}) {
  if (!CADENCES.includes(cadence)) return refuse("bad_type", cadence);
  const common = commonGate({ cfg, live, localDate, env });
  if (common) return common;
  if (cadence === "daily" ? (cfg && cfg.daily_enabled === false) : !(cfg && cfg[`${cadence}_enabled`] === true)) return refuse("disabled", cadence);
  return { ok: true };
}

/** May a manual TRANSACTIONAL send go out? Mirrors eventRunner.cjs: a type sends only when its
 * `${type}_enabled` flag is truthy (no config row → nothing sends), and a lead-capture rooftop
 * never gets appointment / action-item / overdue emails. */
function canSendEvent({ cfg = null, live = null, emailType = "", localDate = "", env = process.env } = {}) {
  if (!EVENT_TYPES.includes(emailType)) return refuse("bad_type", emailType);
  const common = commonGate({ cfg, live, localDate, env });
  if (common) return common;
  if (!(cfg && cfg[`${emailType}_enabled`])) return refuse("disabled", emailType);
  if (String(cfg.post_conversation_template || "") === "lead_capture" && LEAD_CAPTURE_SUPPRESSED.has(emailType)) return refuse("lead_capture", emailType);
  return { ok: true };
}

/** Apply a typed override to a gate verdict. send=false means refuse; `overridden` names the gate
 * that was bypassed (for the row's reason_detail), null when nothing was bypassed. */
function decide(gate, override) {
  if (gate.ok) return { send: true, overridden: null };
  if (gate.overridable && overrideOk(override)) return { send: true, overridden: gate.reason };
  return { send: false, overridden: null };
}

/** JSON body for a refused manual send. `gated` tells the tracker to offer the typed override
 * (only when the gate can be overridden). */
function refusalBody(gate) {
  return { ok: false, gated: true, reason: gate.reason, overridable: !!gate.overridable, error: gate.label };
}

const onDeptList = (r, dept) => (dept === "service" ? !!r.receives_service : !!r.receives_sales);

/** Why this recipient would NOT get `type` from `dept`, or null when it would. The predicate is
 * runner.cjs subscribedEmails / eventRunner.cjs emailsForType, clause for clause:
 * verified_at ∧ canEmail ∧ dept flag ∧ email_enabled ∧ isSubscribed(type, 'email'). */
function recipientHold(r, dept, type) {
  if (!r) return "No recipient";
  if (!onDeptList(r, dept)) return `Not on the ${dept === "service" ? "Service" : "Sales"} list`;
  if (!r.email_enabled) return "Paused (email off)";
  if (!r.verified_at) return "Not verified for this rooftop";
  const block = emailBlock(r);
  if (block) return block.label;
  if (!isSubscribed(r, type, "email")) return `Opted out of ${TYPE_LABEL[type] || type}`;
  return null;
}

/** The recipients the cron would email for (dept, type). Same predicate as subscribedEmails. */
function eligibleRecipients(recipients, dept, type) {
  return (recipients || []).filter((r) => recipientHold(r, dept, type) === null);
}

/** Eligible + held (with the reason) for the department's own list — what the tracker shows before
 * a go-live or a manual send. Recipients on the other department's list only are left out. */
function explainRecipients(recipients, dept, type) {
  const eligible = [];
  const held = [];
  for (const r of recipients || []) {
    if (!onDeptList(r, dept)) continue;
    const why = recipientHold(r, dept, type);
    const row = { email: r.email, name: r.name || null };
    if (why) held.push({ ...row, why }); else eligible.push(row);
  }
  return { eligible, held };
}

// ── Recipient add (C8) ─────────────────────────────────────────────────────────────────────
/** The write for "+ Add" on a department list. A NEW recipient takes the requested email_enabled
 * (the tracker adds people paused). An EXISTING one only gains this department's flag: adding a
 * Sales recipient to the Service list used to send emailEnabled:false along with it and paused
 * every email that person got (A4 F14). email_enabled is the per-person master switch and only
 * the On/Off toggle changes it. */
function recipientAddPatch(existing, { dept, emailEnabled, phone, smsEnabled, role } = {}) {
  const d = dept === "service" ? "service" : "sales";
  const patch = existing
    ? { [d === "sales" ? "receives_sales" : "receives_service"]: true }
    : {
      receives_sales: d === "sales",
      receives_service: d === "service",
      email_enabled: typeof emailEnabled === "boolean" ? emailEnabled : false,
    };
  if (phone !== undefined) patch.phone = phone ? String(phone).trim() : null;
  if (typeof smsEnabled === "boolean") patch.sms_enabled = smsEnabled;
  if (role !== undefined) patch.role = role || null;
  return patch;
}

// ── Timezones (C16) ────────────────────────────────────────────────────────────────────────
/* The zones a US / Canadian rooftop can be in. A free-text timezone used to be saved as typed, and
 * one invalid value ("America/NewYork", "Central") makes Intl throw inside the hourly digest pass,
 * which stops the pass for every rooftop (A1 F6). Mirrored for the editor in src/email/timezones.ts
 * (a test keeps the two lists identical). */
const NA_TIMEZONES = [
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
  // ICU's own names for two of the above (Intl.supportedValuesOf lists these, not the long forms).
  "America/Indianapolis", "America/Louisville",
];

function zoneWorks(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date()); return true; } catch { return false; }
}
const SUPPORTED = (() => {
  try { return new Set(Intl.supportedValuesOf("timeZone")); } catch { return null; }
})();
/** NA_TIMEZONES ∩ the zones this runtime's Intl knows. Intl.supportedValuesOf lists ICU's canonical
 * names (America/Indianapolis rather than America/Indiana/Indianapolis), so "knows" means listed OR
 * accepted by Intl.DateTimeFormat: an alias Intl can format is exactly as safe in the runner. */
const ALLOWED_TIMEZONES = NA_TIMEZONES.filter((tz) => ((SUPPORTED && SUPPORTED.has(tz)) || zoneWorks(tz)) && zoneWorks(tz));
const ALLOWED_TZ_SET = new Set(ALLOWED_TIMEZONES);

/** null when `tz` may be saved, else the error to return (400). */
function timezoneProblem(tz) {
  const s = typeof tz === "string" ? tz.trim() : "";
  if (!s) return "timezone is empty";
  if (!ALLOWED_TZ_SET.has(s)) return `timezone must be a US or Canadian IANA zone such as America/New_York (got "${s.slice(0, 60)}")`;
  return null;
}

// ── Programs report relay (C18) ────────────────────────────────────────────────────────────
const DASHBOARD_HOSTS = new Set(["vini-daily-calls.vercel.app", "reporting-vini.vercel.app", "spyne.ai"]);
function dashboardHostOk(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return DASHBOARD_HOSTS.has(h) || h.endsWith(".spyne.ai");
}
const isSpyneAddress = (e) => {
  const s = normalizeEmail(e);
  return !addressProblem(s) && s.endsWith("@spyne.ai");
};
/** /api/programs/send-report was an open relay: anyone could pick the recipients, the subject and
 * the CTA link of a Spyne-branded email (A5-10). An explicit recipient list may only name
 * @spyne.ai addresses, and the dashboard link may only point at our own hosts. */
function programsReportProblem({ recipientsOverride, dashboardUrl } = {}) {
  if (Array.isArray(recipientsOverride) && recipientsOverride.length) {
    const bad = recipientsOverride.map((s) => String(s || "").trim()).filter((s) => !isSpyneAddress(s));
    if (bad.length) return `recipientsOverride may only contain @spyne.ai addresses (rejected: ${bad.slice(0, 3).join(", ")})`;
  }
  if (dashboardUrl != null && dashboardUrl !== "" && !dashboardHostOk(dashboardUrl)) {
    return "dashboardUrl must be an https link to vini-daily-calls.vercel.app, reporting-vini.vercel.app or a spyne.ai domain";
  }
  return null;
}

module.exports = {
  CADENCES, EVENT_TYPES, TYPE_LABEL,
  serverDryRun, canSendDigest, canSendEvent, decide, refusalBody,
  recipientHold, eligibleRecipients, explainRecipients,
  recipientAddPatch,
  NA_TIMEZONES, ALLOWED_TIMEZONES, timezoneProblem,
  programsReportProblem, dashboardHostOk, isSpyneAddress,
};
