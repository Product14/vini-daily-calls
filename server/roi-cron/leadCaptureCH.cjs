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
// caller speaks it and it survives only in callDetails_transcript — and usually as WORDS
// ("That's four six eight zero two"), so a \d{5} regex alone finds nothing.
//
// Two guards against capturing the wrong number:
//   1. Customer lines only. The AI reads the STORE's address back ("Fort Wayne, Indiana 46815") —
//      matching AI lines would return the dealership's ZIP as the customer's.
//   2. Prefer the lines after the AI asks for a ZIP. Falls back to any customer line that itself
//      mentions "zip", so a volunteered ZIP ("my zip is 46802") is still caught.
const DIGIT_WORDS = {
  zero: "0", oh: "0", o: "0", nought: "0",
  one: "1", two: "2", three: "3", four: "4", for: "4", five: "5",
  six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};
const isZip = (z) => /^\d{5}$/.test(z) && z !== "00000";

function zipFromLine(line) {
  const m = String(line).match(/\b(\d{5})\b/);
  if (m && isZip(m[1])) return m[1];
  // five consecutive spoken digits, e.g. "four six eight zero two" / "four-six-eight-zero-two"
  const words = String(line).toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  let run = [];
  for (const w of words) {
    const d = DIGIT_WORDS[w];
    if (d) { run.push(d); if (run.length === 5) { const z = run.join(""); if (isZip(z)) return z; run.shift(); } }
    else run = [];
  }
  return "";
}

function extractZip(transcript) {
  const lines = String(transcript || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const isCust = (l) => /^customer\s*:/i.test(l);
  const body = (l) => l.replace(/^[a-z]+\s*:\s*/i, "");
  // pass 1 — customer lines that follow an AI "what's your ZIP" prompt
  let asked = false;
  for (const l of lines) {
    if (!isCust(l)) { if (/zip/i.test(l)) asked = true; continue; }
    if (!asked) continue;
    const z = zipFromLine(body(l));
    if (z) return z;
  }
  // pass 2 — a customer line that names the ZIP itself
  for (const l of lines) {
    if (!isCust(l) || !/zip|postal/i.test(l)) continue;
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
  // 3 PM") or, on the SMS path, what the customer typed ("can we move it to Thursday at 5?").
  // Matched STRUCTURALLY (day + optional clock time) rather than "everything up to punctuation":
  // a text often has no trailing period, so the loose form swallowed the rest of the message.
  for (const s of summaryLines) {
    if (!DAY_TIME_RE.test(s)) continue;
    const m = String(s).match(/\b(?:on|for|at|to)\s+((?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today)(?:\s+(?:at|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)?)/i);
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
// "did Eva actually text the pre-qualification link?" — shown next to Financing so the BDC doesn't
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
  " ifNull(e.callDetails_endedReason,'') endedReason";

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
  const sql =
    "SELECT e.callId callId, toString(e.createdAt) at," + LEAD_FIELD_COLS + "," +
    " ifNull(c.name,'') customer, ifNull(c.mobile_number,'') phone, c.emails emails" +
    " FROM dealer_leads.endcallreports e" + IDENTITY_JOINS +
    " WHERE e.teamId=" + lit(teamId) + " AND e.__deleted=0 AND e.callId IN (" + ids.map(lit).join(",") + ")" +
    // endcallreports keeps CDC-duplicate rows per callId — keep the newest version of each.
    " ORDER BY e.updatedAt DESC LIMIT 1 BY e.callId";
  let rows;
  try { rows = await chQuery(sql); }
  catch (e) { console.warn("[lead-capture] ClickHouse enrichment failed:", String(e).slice(0, 160)); return new Map(); }

  const out = new Map();
  for (const r of rows) out.set(String(r.callId), leadFromRow(r));
  return out;
}

/**
 * Same fields, keyed by LEAD instead of call — the lead's most recent call.
 *
 * This is what the SMS path needs. A text thread carries no sales sub-report of its own (no
 * endcallreports row exists for it), but on this dealer's flow the text is always a follow-on to
 * the call Eva just had — she texts the pre-qualification / trade-in links at the end of it. So a
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
    location: "", financing: "", prequalSent: false, tradeIn: "", intent: "", summary: [],
    actionItems: [], transcript: "", recordingUrl: "", durationSec: 0, endedReason: "", at: null,
  };
  const moved = !!(typedWhen && base.apptWhen && typedWhen.toLowerCase() !== String(base.apptWhen).toLowerCase());
  return {
    ...base,
    channel: "sms",
    sms,
    smsFailed: sms.filter((m) => SMS_FAILED.has(String(m && m.status))).length,
    zip: typedZip || base.zip || "",
    apptWhen: typedWhen || base.apptWhen || "",
    // the follow-ups Eva logged on the CALL still quote the old slot — say so on the field itself
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
