// Lead-capture field enrichment, read straight from production ClickHouse.
//
// WHY THIS EXISTS: the reporting-vini /api/conversations feed carries the CANONICAL funnel view of
// a call (direction, intent, appointment/action-item flags, summary) — it does NOT carry the sales
// sub-report. The lead-capture email (see renderLeadCapture in transactionalTemplates.cjs) needs
// exactly those omitted fields: the requested vehicle, the financing/trade-in flags, the preferred
// visit time + chosen store, the ZIP the caller gave, and the raw transcript.
//
// So the SEND path stays feed-driven (eventRunner decides WHICH calls email — all the spam / rollup /
// coverage / dedupe gates keep working untouched) and this module only ENRICHES the chosen calls,
// one batched query per pass keyed on callId. Nothing here decides whether an email goes out.
//
// Field provenance (verified against Superior Auto `27ec3720db`, Aug-2026 calls):
//   Vehicle of Interest        report_sales.vehicleRequested[].vehicleName (+ .vehicleType)
//   Financing Option Required  report_sales.financingRequest ("Yes"/"No")
//   Trade-in                   report_sales.tradeInMention.value
//   Appointment time           report_overview.appointmentDetails[] free text → parsed
//   Preferred location         report_overview.appointmentDetails[] "Chosen location: …"
//   Name / Phone / Email       leads → customer (name / mobile_number / emails)
//   Zipcode                    the TRANSCRIPT only — no structured field exists anywhere (see below)
const CH_HOST = process.env.CLICKHOUSE_HOST;
const CH_PORT = process.env.CLICKHOUSE_PORT || "8443";
const CH_USER = process.env.CLICKHOUSE_USER;
const CH_PASS = process.env.CLICKHOUSE_PASSWORD;

function hasCreds() { return !!(CH_HOST && CH_PASS); }

// JSONEachRow, NOT TabSeparated: transcripts contain tabs and newlines, which silently corrupt
// TSV row/column splitting (the transcript is the whole point of this email).
async function chQuery(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?default_format=JSONEachRow`, {
    method: "POST",
    headers: { "X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS },
    body: sql,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 200)}`);
  return text.trimEnd().split("\n").filter(Boolean).map((ln) => JSON.parse(ln));
}
const lit = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

function parseJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => x && String(x).trim()) : []; }
  catch { return []; }
}
function parseObj(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

// ── ZIP extraction ────────────────────────────────────────────────────────────────────────────
// There is NO zip column: not on endcallreports, not on leads, not on customer (checked). The
// caller speaks it and it survives only in callDetails_transcript, in any of these shapes:
// "46802" · "4 6 8 0 2" · "4-6-8-0-2" · "four six eight zero two" · mixed — the transcriber is
// inconsistent (the agent's own lines render ZIPs spaced out), so all four must parse.
//
// Three guards, because a WRONG zip is worse than a missing one — it routes the callback and the
// vehicle transfer to a store the customer never picked:
//   1. Customer lines only. The agent reads the STORE's address back mid-call, so matching agent
//      lines would file the dealership's own zip as the caller's.
//   2. Money/mileage context rejected. A five-digit number is just as likely to be a price, a
//      budget, a down payment or an odometer reading ("I paid 15000", "46000 miles") — those are
//      checked in a window around each candidate, so a real zip in the same sentence still parses.
//   3. Proximity to the ask. Only the first few customer lines after the agent asks (counter resets
//      if it asks again) — an unrelated number later in the call is not the answer to the question.
// Falls back to any customer line that itself says "zip", so a volunteered zip is still caught.
const DIGIT_WORDS = {
  zero: "0", oh: "0", o: "0", nought: "0",
  one: "1", two: "2", three: "3", four: "4", for: "4", five: "5",
  six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};
const isZip = (z) => /^\d{5}$/.test(z) && z !== "00000";
// Terms that mean "this number is money or mileage, not a location".
const NOT_ZIP_CONTEXT = /\$|\b(paid|pay|price|priced|cost|costs|budget|down|deposit|payment|payments|monthly|finance|financed|worth|asking|msrp|sticker|offer|offered|trade|mile|miles|mileage|odometer|thousand|dollars?|bucks)\b/i;
const ZIP_ASK_RE = /zip|postal/i;
const ZIP_ASK_WINDOW = 4; // customer lines after the ask that can still be the answer

function zipFromLine(line) {
  const s = String(line);
  // literal 5-digit run, rejected when its surroundings read as money/mileage
  const re = /\b(\d{5})\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!isZip(m[1])) continue;
    const ctx = s.slice(Math.max(0, m.index - 28), m.index + m[1].length + 18);
    if (NOT_ZIP_CONTEXT.test(ctx)) continue;
    return m[1];
  }
  // five consecutive spoken digits — words ("four six eight zero two"), bare digits ("4 6 8 0 2"),
  // hyphenated, or any mix. Multi-digit tokens break the run (they aren't digit-by-digit dictation).
  const tokens = s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  let run = [];
  for (const tok of tokens) {
    const d = DIGIT_WORDS[tok] || (/^\d$/.test(tok) ? tok : null);
    if (d) {
      run.push(d);
      if (run.length === 5) { const z = run.join(""); if (isZip(z)) return z; run.shift(); }
    } else run = [];
  }
  return "";
}

function extractZip(transcript) {
  const lines = String(transcript || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const isCust = (l) => /^customer\s*:/i.test(l);
  const body = (l) => l.replace(/^[a-z]+\s*:\s*/i, "");
  // pass 1 — the customer lines that answer an agent "what's your ZIP" prompt
  let asked = false, since = 0;
  for (const l of lines) {
    if (!isCust(l)) { if (ZIP_ASK_RE.test(l)) { asked = true; since = 0; } continue; }
    if (!asked) continue;
    if (++since > ZIP_ASK_WINDOW) { asked = false; continue; }
    const z = zipFromLine(body(l));
    if (z) return z;
  }
  // pass 2 — a customer line that names the ZIP itself ("my zip is …"), asked or not
  for (const l of lines) {
    if (!isCust(l) || !ZIP_ASK_RE.test(l)) continue;
    const z = zipFromLine(body(l));
    if (z) return z;
  }
  return "";
}

// ── appointment time / location ────────────────────────────────────────────────────────────────
// report_overview.appointmentDetails is free text the model writes, e.g.
//   ["Preferred visit on Tuesday at 3 PM", "Chosen location: Fort Wayne West", "…link sent"]
// so both fields are parsed out of it rather than read from a column. Labels ("Proposed date and
// time:", "Preferred visit on") are stripped so the field reads as a time, not a sentence.
const DAY_TIME_RE = /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\btomorrow\b|\btoday\b/i;
const TIME_LABEL_RE = /^(proposed\s+date\s+and\s+time|preferred\s+(visit|time|appointment)?\s*(time)?|requested\s+(visit|time)|appointment\s+time|visit\s+time)\s*[:\-]?\s*/i;

function cleanTimePhrase(s) {
  let t = String(s || "").trim().replace(/^[-•·]\s*/, "");
  t = t.replace(TIME_LABEL_RE, "");
  t = t.replace(/^(preferred|proposed|requested)\s+visit\s+on\s+/i, "").replace(/^(visit|come\s+in)\s+on\s+/i, "");
  // a leading preposition survives when the phrase came out of a sentence ("on Tuesday at 3 PM")
  t = t.replace(/^(on|for|at)\s+/i, "");
  return t.trim().replace(/[.]$/, "");
}
function pickApptWhen(apptDetails, summaryLines) {
  for (const d of apptDetails) if (DAY_TIME_RE.test(d) && !/open|hours|closed/i.test(d)) return cleanTimePhrase(d);
  // Fall back to free prose — either the narrative summary ("…interest in visiting on Tuesday at
  // 3 PM") or, on the SMS path, what the customer typed ("make it Thursday at 5").
  // Matched STRUCTURALLY (day + optional clock time) rather than "everything up to punctuation":
  // a text often has no trailing period, so the loose form swallowed the rest of the message.
  // The preposition is OPTIONAL — "Thursday at 5 works for me" is how people actually reply, and
  // requiring "on/at/to" silently dropped those, which on the SMS path meant the sheet kept showing
  // the SUPERSEDED time from the call.
  const DAY = "(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today)";
  const CLOCK = "(?:\\s+(?:at|@)\\s*\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?)?";
  const PHRASE = new RegExp("\\b(?:on|for|at|to\\s)?\\s*(" + DAY + CLOCK + ")", "i");
  for (const s of summaryLines) {
    if (!DAY_TIME_RE.test(s)) continue;
    if (/\b(open|hours|closed|closes)\b/i.test(s)) continue; // store hours are not an appointment
    const m = String(s).match(PHRASE);
    if (m) return cleanTimePhrase(m[1]);
  }
  return "";
}
function pickLocation(apptDetails, summaryLines) {
  for (const d of apptDetails) {
    const m = String(d).match(/(?:chosen|preferred|selected|nearest)\s+location\s*[:\-]?\s*(.+)$/i);
    if (m) return m[1].trim().replace(/[.]$/, "");
  }
  for (const s of summaryLines) {
    const m = String(s).match(/chose\s+the\s+(.+?)\s+location/i) || String(s).match(/location\s*[:\-]\s*(.+?)[.;]/i);
    if (m) return m[1].trim();
  }
  return "";
}
// "did the agent actually text the pre-qualification link?" — shown next to Financing so the BDC doesn't
// re-send it. Phrasing check only; there is no structured flag for the link send.
const PREQUAL_SENT_RE = /(texted|sent|sending).{0,60}pre-?qual|pre-?qual.{0,60}(link\s+(sent|texted)|sent\s+via\s+sms)/i;

const IDENTITY_JOINS =
  " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads GROUP BY lead_id) l ON e.leadId=l.lead_id" +
  " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number," +
  " anyIf(emails, notEmpty(emails)) emails FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id";

const JUNK_NAMES = new Set(["unknown", "unknown caller", "n/a", "na", "none", "null", "test", "-", "."]);
function cleanName(name) {
  const n = String(name || "").trim();
  return n && !JUNK_NAMES.has(n.toLowerCase()) ? n : "";
}
// callDetails_startedAt/endedAt are Nullable(String) and already ISO-with-Z ("2026-08-03T19:52:58.913Z"),
// but ClickHouse DateTime columns come back space-separated and naive — normalize both shapes.
function asMs(v) {
  const s = String(v || "").trim();
  if (!s) return 0;
  const iso = /[TZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}
function durationSec(a, b) {
  const s = asMs(a), e = asMs(b);
  return s && e && e > s ? Math.round((e - s) / 1000) : 0;
}

// The columns leadFromRow() needs, as a SELECT list fragment — shared with eventPreviewCH so the
// preview and the real send read the SAME fields (a preview that renders different data than the
// email the dealer receives is worse than no preview).
const LEAD_FIELD_COLS =
  " ifNull(e.report_summary,'') summary, ifNull(e.report_actionItems,'') actionItems," +
  " ifNull(e.report_overview,'') overview, ifNull(e.report_sales,'') sales," +
  " ifNull(e.callDetails_transcript,'') transcript, ifNull(e.callDetails_recordingUrl,'') recordingUrl," +
  " toString(e.callDetails_startedAt) startedAt, toString(e.callDetails_endedAt) endedAt," +
  " ifNull(e.callDetails_endedReason,'') endedReason," +
  // The agent's own name, so the email never hardcodes one. It is per-rooftop (and can differ
  // between calls on the SAME rooftop), so a literal in the template would eventually address the
  // dealer about an assistant that doesn't exist.
  " ifNull(e.callDetails_agentInfo_agentName,'') agentName";

/** Map one joined endcallreports row → the `lead` object T.renderLeadCapture expects. Pure. */
function leadFromRow(r) {
  const ov = parseObj(r.overview);
  const sales = parseObj(r.sales);
  const summary = parseJsonArray(r.summary);
  const apptDetails = Array.isArray(ov.appointmentDetails) ? ov.appointmentDetails.filter(Boolean) : [];
  const vehicles = Array.isArray(sales.vehicleRequested)
    ? sales.vehicleRequested.map((v) => (v && (v.vehicleName || v.name)) || "").filter(Boolean)
    : [];
  const emails = Array.isArray(r.emails) ? r.emails.filter(Boolean) : [];
  const transcript = String(r.transcript || "");
  return {
    customer: cleanName(r.customer),
    phone: r.phone || "",
    email: emails[0] || "",
    zip: extractZip(transcript),
    vehicle: vehicles.join(", "),
    vehicleType: sales.vehicleType || "",
    apptWhen: pickApptWhen(apptDetails, summary),
    location: pickLocation(apptDetails, summary),
    financing: sales.financingRequest || "",
    prequalSent: PREQUAL_SENT_RE.test(transcript + "\n" + summary.join("\n")),
    tradeIn: (sales.tradeInMention && sales.tradeInMention.value) || "",
    intent: (ov.overall && ov.overall.customerIntent) || "",
    agentName: cleanName(r.agentName),
    summary,
    actionItems: parseJsonArray(r.actionItems),
    transcript,
    recordingUrl: r.recordingUrl || "",
    durationSec: durationSec(r.startedAt, r.endedAt),
    endedReason: r.endedReason || "",
    at: r.at,
  };
}

/**
 * Batched lead-capture fields for a set of calls. Returns Map<callId, lead> shaped for
 * T.renderLeadCapture({ lead }). Never throws into the caller's send loop — on any failure it
 * returns an empty Map so eventRunner falls back to the standard conversation email rather than
 * dropping the notification entirely.
 */
async function fetchLeadFields(teamId, callIds) {
  const ids = [...new Set((callIds || []).filter(Boolean).map(String))];
  if (!hasCreds() || !teamId || !ids.length) return new Map();
  const inList = "(" + ids.map(lit).join(",") + ")";
  const sql =
    "SELECT e.callId callId, e.id id, toString(e.createdAt) at," + LEAD_FIELD_COLS + "," +
    " ifNull(c.name,'') customer, ifNull(c.mobile_number,'') phone, c.emails emails" +
    " FROM dealer_leads.endcallreports e" + IDENTITY_JOINS +
    // TEAM-SCOPED: an id from another rooftop returns nothing rather than another dealer's lead
    // (the caller then falls back to the standard email). Cross-rooftop isolation is a hard rule.
    //
    // Matched on callId OR id because the conversations feed's `cv.id` is one or the other depending
    // on the row — endcallreports carries BOTH a vendor callId (uuid) and a Mongo _id (24-hex), and
    // eventPreviewCH already has to accept either. Filtering on callId alone would silently resolve
    // nothing for id-keyed rows: no error, just every lead quietly falling back to the generic email.
    " WHERE e.teamId=" + lit(teamId) + " AND e.__deleted=0 AND (e.callId IN " + inList + " OR e.id IN " + inList + ")" +
    // endcallreports keeps CDC-duplicate rows per callId — keep the newest version, preferring one
    // that actually carries a report (belt-and-braces: a newest-but-empty version would render a
    // blank sheet and trip the no-value gate on a real lead).
    " ORDER BY notEmpty(ifNull(e.report_overview,'')) DESC, e.updatedAt DESC LIMIT 1 BY e.callId";
  let rows;
  try { rows = await chQuery(sql); }
  catch (e) { console.warn("[lead-capture] ClickHouse enrichment failed:", String(e).slice(0, 160)); return new Map(); }

  const out = new Map();
  for (const r of rows) {
    const lead = leadFromRow(r);
    // keyed under BOTH identifiers, so the caller can look up by whichever one the feed gave it
    if (r.callId) out.set(String(r.callId), lead);
    if (r.id) out.set(String(r.id), lead);
  }
  return out;
}

/**
 * Same fields, keyed by LEAD instead of call — the lead's most recent call.
 *
 * This is what the SMS path needs. A text thread carries no sales sub-report of its own (no
 * endcallreports row exists for it), but on this dealer's flow the text is always a follow-on to
 * the call the agent just had — it texts the pre-qualification / trade-in links at the end of it. So a
 * reply's lead sheet is built from that lead's own call, with the thread attached by the caller.
 * A lead with no call at all simply isn't in the Map; the caller then renders a thread-only sheet.
 */
async function fetchLeadFieldsByLead(teamId, leadIds) {
  const ids = [...new Set((leadIds || []).filter(Boolean).map(String))];
  if (!hasCreds() || !teamId || !ids.length) return new Map();
  const sql =
    "SELECT e.leadId leadId, toString(e.createdAt) at," + LEAD_FIELD_COLS + "," +
    " ifNull(c.name,'') customer, ifNull(c.mobile_number,'') phone, c.emails emails" +
    " FROM dealer_leads.endcallreports e" + IDENTITY_JOINS +
    // TEAM-SCOPED for the same reason as above: a leadId that isn't this rooftop's returns nothing.
    " WHERE e.teamId=" + lit(teamId) + " AND e.__deleted=0 AND e.leadId IN (" + ids.map(lit).join(",") + ")" +
    " AND notEmpty(e.report_overview)" +
    " ORDER BY e.createdAt DESC LIMIT 1 BY e.leadId";
  let rows;
  try { rows = await chQuery(sql); }
  catch (e) { console.warn("[lead-capture] ClickHouse lead lookup failed:", String(e).slice(0, 160)); return new Map(); }
  const out = new Map();
  for (const r of rows) out.set(String(r.leadId), leadFromRow(r));
  return out;
}

const SMS_FAILED = new Set(["failed", "undelivered", "error"]);
const isInboundSms = (m) => m && (m.direction === "in" || m.direction === "inbound");

/**
 * The lead sheet for a TEXT conversation — the SMS counterpart of leadFromRow, used by both the
 * cron and the tracker preview so the two can't drift.
 *
 * `callLead` is that lead's call-derived sheet (leadFromRow) when it has one, else null.
 *
 * The text is NEWER than the call, so anything the customer typed WINS over the carried-over value:
 * a reply that moves the time ("make it Thursday at 5") or finally gives the ZIP must not be shown
 * with the stale figure from the call — that would send the BDC to confirm the wrong slot.
 */
function buildSmsLead(callLead, seed, msgs) {
  const sms = Array.isArray(msgs) ? msgs : [];
  const typedLines = sms.filter(isInboundSms).map((m) => String(m.body || ""));
  const typedZip = extractZip(typedLines.map((b) => "Customer: " + b).join("\n"));
  const typedWhen = pickApptWhen([], typedLines);
  const base = callLead || {
    customer: "", phone: "", email: "", zip: "", vehicle: "", vehicleType: "", apptWhen: "",
    location: "", financing: "", prequalSent: false, tradeIn: "", intent: "", agentName: "",
    summary: [], actionItems: [], transcript: "", recordingUrl: "", durationSec: 0, endedReason: "", at: null,
  };
  const moved = !!(typedWhen && base.apptWhen && typedWhen.toLowerCase() !== String(base.apptWhen).toLowerCase());
  return {
    ...base,
    channel: "sms",
    sms,
    smsFailed: sms.filter((m) => SMS_FAILED.has(String(m && m.status))).length,
    zip: typedZip || base.zip || "",
    apptWhen: typedWhen || base.apptWhen || "",
    // the follow-ups logged on the CALL still quote the old slot — say so on the field itself
    apptWhenNote: moved ? `Moved by text — the call said ${base.apptWhen}` : "",
    customer: base.customer || cleanName(seed && seed.customer),
    phone: base.phone || (seed && seed.phone) || "",
    intent: base.intent || (seed && seed.intent) || "",
    at: (seed && seed.at) || base.at,
  };
}

module.exports = {
  fetchLeadFields, fetchLeadFieldsByLead, leadFromRow, buildSmsLead, LEAD_FIELD_COLS, hasCreds,
  extractZip, pickApptWhen, pickLocation, _chQuery: chQuery,
};
