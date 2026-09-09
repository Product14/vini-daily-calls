/* emailHealth — the ONE place that decides whether an address may be mailed.
 *
 * Why this exists: every send to a dead, malformed or mistyped address is a bounce, and
 * bounces are what the receiving ISPs score spyne.ai on. A handful of addresses that can
 * never accept mail, hit twice a day by the digest cron and again by every transactional
 * event, is enough to push the whole sending domain from inbox to spam — for every rooftop,
 * including the ones whose addresses are perfectly good. So a bad address is not a per-rooftop
 * annoyance to leave in place; it is a shared asset being spent.
 *
 * Two layers, both of which stop a send:
 *   1. STRUCTURAL — the address cannot be a real mailbox (malformed, a phone placeholder, a
 *      reserved TLD, a known typo of a big mailbox provider). Decided from the string alone,
 *      so it works before the address has ever been mailed.
 *   2. SUPPRESSED — the address HAS been mailed and it failed: the mail proxy rejected the
 *      recipient, or a bounce/complaint arrived for it. Recorded on roi_recipients
 *      (suppressed_at / suppression_reason / bounce_count / last_bounce_at, migration 0023).
 *
 * Suppression is a hold, never a delete. The row stays visible in the tracker with the reason
 * on it so a CSM can fix the address (which clears the hold) — a deleted row just gets re-seeded
 * by the recipient sync and starts bouncing again, and nobody ever learns why that rooftop
 * stopped getting its digest.
 *
 * Consumed by: runner.cjs (digests), eventRunner.cjs (transactional), app.js (manual sends,
 * recipient add/edit, the tracker reads) and scripts/audit-bad-recipients.mjs (the sweep).
 */

// ── Layer 1: structural ────────────────────────────────────────────────────────────────────

// RFC 2606 / 6761 reserved + the internal-only TLDs. Nothing under these can receive mail
// from the public internet, ever. `.invalid` is also our own phone-only placeholder domain.
const UNROUTABLE_TLDS = new Set([
  "invalid", "localhost", "local", "test", "example", "internal", "lan", "home", "corp", "localdomain",
]);
// Reserved second-level domains (RFC 2606) — documentation only, never a real mailbox.
const UNROUTABLE_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

// Misspellings of the big consumer mailbox providers. Every one of these is a guaranteed hard
// bounce, and they are by far the most common bad address a dealer types into an onboarding form.
// Deliberately conservative: only entries where the intended domain is unambiguous, so a real
// (if unusual) domain is never blocked by a guess.
const DOMAIN_TYPOS = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmaill.com": "gmail.com", "gmali.com": "gmail.com",
  "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmail.co": "gmail.com", "gmail.cm": "gmail.com",
  "gmail.con": "gmail.com", "gmail.om": "gmail.com", "gmail.vom": "gmail.com", "gmail.comm": "gmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yhaoo.com": "yahoo.com", "yahoo.con": "yahoo.com",
  "yahoo.co": "yahoo.com", "yahoo.cm": "yahoo.com",
  "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmal.com": "hotmail.com",
  "hotmail.con": "hotmail.com", "hotmail.co": "hotmail.com", "hotmail.cm": "hotmail.com",
  "outlok.com": "outlook.com", "outllok.com": "outlook.com", "outook.com": "outlook.com",
  "outlook.con": "outlook.com", "outlook.co": "outlook.com",
  "aol.con": "aol.com", "aol.co": "aol.com", "aol.cm": "aol.com",
  "icloud.con": "icloud.com", "iclould.com": "icloud.com", "icloud.co": "icloud.com",
  "comcast.ent": "comcast.net", "comcast.nt": "comcast.net",
  "sbcgloba.net": "sbcglobal.net", "sbcglobal.com": "sbcglobal.net",
};

function normalizeEmail(email) {
  return String(email == null ? "" : email).trim().toLowerCase();
}

/* Why this address can never be delivered to, or null when it is structurally fine.
 * Returns { code, label, detail? } — `label` is what the tracker shows a CSM. */
function addressProblem(email) {
  const raw = String(email == null ? "" : email).trim();
  if (!raw) return { code: "empty", label: "No email address" };
  // A single address only. A display name ("Bob <b@x.com>"), a comma/semicolon list pasted into
  // one field, or an embedded space all reach the proxy as one malformed "to" and bounce.
  // The old gate used an UNANCHORED /\S+@\S+\.\S+/, so "john smith@dealer.com" matched on the
  // substring and went out as-is.
  if (/[\s,;<>"()[\]\\]/.test(raw)) return { code: "malformed", label: "Not a single valid address (spaces, a name, or several addresses in one field)" };
  if (raw.length > 254) return { code: "malformed", label: "Address is too long to be deliverable" };

  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return { code: "malformed", label: "Missing the local part or the domain" };
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1).toLowerCase();
  if (raw.indexOf("@") !== at) return { code: "malformed", label: "More than one @ in the address" };
  if (local.length > 64) return { code: "malformed", label: "Local part is too long to be deliverable" };
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return { code: "malformed", label: "Local part has a stray dot" };

  const labels = domain.split(".");
  if (labels.length < 2) return { code: "malformed", label: "Domain has no dot — it cannot resolve" };
  for (const l of labels) {
    if (!l || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith("-") || l.endsWith("-")) {
      return { code: "malformed", label: "Domain is not a valid hostname" };
    }
  }
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,24}$/.test(tld)) return { code: "malformed", label: "Domain ends in something that is not a real TLD" };

  // The phone-only placeholder (…@phone.invalid) is deliberate, not a mistake — a recipient who
  // only ever gets SMS. Name it separately so the tracker doesn't scold a CSM about it.
  if (/^phone\.invalid$/.test(domain)) return { code: "placeholder", label: "Phone-only recipient (SMS only, never emailed)" };
  if (UNROUTABLE_TLDS.has(tld) || UNROUTABLE_DOMAINS.has(domain)) return { code: "unroutable", label: `.${tld} can never receive mail from outside the network` };

  const meant = DOMAIN_TYPOS[domain];
  if (meant) return { code: "typo", label: `Looks like a typo of @${meant}`, detail: meant };

  return null;
}

const isDeliverableAddress = (email) => addressProblem(email) === null;

// ── Layer 2: suppression state on the recipient row ───────────────────────────────────────

const isSuppressed = (rec) => !!(rec && rec.suppressed_at);

/* The single send predicate. Returns the blocking reason, or null when this recipient may be
 * mailed. Both layers in one call so no send path can accidentally honour only one of them. */
function emailBlock(rec) {
  if (!rec) return { code: "missing", label: "No recipient" };
  if (isSuppressed(rec)) return { code: "suppressed", label: rec.suppression_reason || "Suppressed — this address failed" };
  return addressProblem(rec.email);
}
const canEmail = (rec) => emailBlock(rec) === null;

// ── Reading recipients (tolerates a database that has not run migration 0023 yet) ─────────

const DELIVERABILITY_COLS = "suppressed_at,suppression_reason,bounce_count,last_bounce_at";

function isMissingColumnError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || "");
  return code === "42703" || code === "PGRST204" || /column .* does not exist/i.test(msg);
}

/* select() on roi_recipients WITH the deliverability columns, falling back to the caller's own
 * column list if the migration hasn't been applied. Without this a deploy that lands before the
 * migration would 400 every recipient read and take the whole digest cron down — the gate is
 * supposed to stop bad addresses, not stop the mail. */
async function selectRecipients(sb, baseCols, filter) {
  const run = (cols) => {
    let q = sb.from("roi_recipients").select(cols);
    if (filter) q = filter(q);
    return q;
  };
  const withCols = await run(`${baseCols},${DELIVERABILITY_COLS}`);
  if (!withCols.error || !isMissingColumnError(withCols.error)) return withCols;
  console.warn("[emailHealth] roi_recipients is missing the deliverability columns — apply migration 0023_recipient_deliverability.sql. Falling back to the structural gate only.");
  return run(baseCols);
}

// ── Classifying a send failure ────────────────────────────────────────────────────────────

// A permanent recipient problem: the address does not exist / will not accept mail. Re-sending
// to it only produces another bounce, so the address is suppressed on the first one.
const HARD_PATTERNS = [
  /\b5\.1\.[0-9]+\b/, /\b550\b/, /\b551\b/, /\b553\b/, /\b554\b/,
  /invalid\s+(recipient|address|email|to)/i, /recipient.{0,20}(rejected|not\s*found|unknown|invalid)/i,
  /no\s+such\s+(user|mailbox|recipient)/i, /user\s+unknown/i, /mailbox\s+(not\s+found|unavailable|does\s+not\s+exist)/i,
  /address\s+(does\s+not\s+exist|not\s+found|rejected)/i, /domain\s+(not\s+found|does\s+not\s+exist)/i,
  /unrouteable|unroutable|undeliverable/i, /bad\s+destination/i, /email_address_invalid|invalid_to|invalid_email/i,
];
// A temporary problem: the mailbox exists but could not take the message right now. Counted,
// not suppressed — suppressing on a full mailbox would silence a real, reachable recipient.
const SOFT_PATTERNS = [
  /\b4\.[0-9]\.[0-9]+\b/, /\b4[0-9]{2}\b\s*(temporar|try)/i,
  /mailbox\s+full/i, /over\s*quota/i, /quota\s+exceeded/i, /greylist/i, /grey-?listed/i,
  /temporar(y|ily)/i, /try\s+again/i, /rate[\s_-]?limit/i, /throttl/i, /deferred/i,
];

/* 'hard' | 'soft' | 'unknown' for a mail-proxy error body or a bounce payload. 'unknown' never
 * suppresses — an auth failure, a bad template or a gateway wobble is our problem, not the
 * recipient's, and must not quietly silence a rooftop's mail. */
function classifySendFailure(text) {
  const s = String(text || "");
  if (!s) return "unknown";
  if (SOFT_PATTERNS.some((re) => re.test(s))) return "soft";
  if (HARD_PATTERNS.some((re) => re.test(s))) return "hard";
  return "unknown";
}

/* Pull addresses out of an error body so a batch failure can be attributed to the one bad
 * address in it rather than to every recipient on the send. */
function extractAddresses(text) {
  const found = String(text || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g) || [];
  return [...new Set(found.map((e) => e.toLowerCase()))];
}

// ── Writing suppression state ─────────────────────────────────────────────────────────────

// Soft failures are only permanent once they keep happening. Three consecutive is the usual
// provider convention (a genuinely full mailbox that is never emptied is a dead mailbox).
const SOFT_BOUNCE_LIMIT = Number(process.env.SOFT_BOUNCE_LIMIT || 3);

function matchEmail(q, email) {
  // roi_recipients has no case-normalised email column, and addresses were entered by hand over
  // two years — match case-insensitively or half the suppressions silently miss their row.
  return q.ilike("email", String(email || "").trim());
}

/* Put an address on hold. teamId omitted → every rooftop that has this address, which is the
 * right scope for a bounce: a dead mailbox is dead for everyone, not just the rooftop that
 * happened to mail it first. Returns the rows affected. */
async function suppressAddress(sb, { teamId, email, reason }) {
  const addr = normalizeEmail(email);
  if (!addr) return { count: 0 };
  let q = sb.from("roi_recipients")
    .update({ suppressed_at: new Date().toISOString(), suppression_reason: String(reason || "failed").slice(0, 300) });
  if (teamId) q = q.eq("team_id", teamId);
  const { data, error } = await matchEmail(q, addr).select("id,team_id,email");
  if (error) {
    if (isMissingColumnError(error)) { console.warn(`[emailHealth] cannot suppress ${addr} — migration 0023 not applied`); return { count: 0, error }; }
    return { count: 0, error };
  }
  return { count: (data || []).length, rows: data || [] };
}

/* Lift the hold — used when a CSM fixes the address or explicitly restores it. Clears the
 * bounce counter too, so the address gets a genuinely fresh start. */
async function unsuppressAddress(sb, { teamId, email }) {
  const addr = normalizeEmail(email);
  if (!addr) return { count: 0 };
  let q = sb.from("roi_recipients").update({ suppressed_at: null, suppression_reason: null, bounce_count: 0 });
  if (teamId) q = q.eq("team_id", teamId);
  const { data, error } = await matchEmail(q, addr).select("id");
  if (error) return { count: 0, error };
  return { count: (data || []).length };
}

/* Record one delivery failure against an address.
 *   kind 'hard' | 'complaint' → suppress immediately.
 *   kind 'soft'               → count it; suppress once it reaches SOFT_BOUNCE_LIMIT.
 *   kind 'unknown'            → nothing (see classifySendFailure).
 * Best-effort: never throws at a caller that is in the middle of a send. */
async function recordFailure(sb, { teamId, email, kind, detail }) {
  const addr = normalizeEmail(email);
  if (!addr || !sb) return { suppressed: false };
  const why = String(detail || "").replace(/\s+/g, " ").trim().slice(0, 200);
  try {
    if (kind === "hard" || kind === "complaint") {
      const reason = kind === "complaint" ? `Marked as spam by the recipient${why ? ` · ${why}` : ""}` : `Hard bounce${why ? ` · ${why}` : ""}`;
      const r = await suppressAddress(sb, { teamId, email: addr, reason });
      await bumpBounce(sb, { teamId, email: addr });
      return { suppressed: r.count > 0, count: r.count, reason };
    }
    if (kind === "soft") {
      const n = await bumpBounce(sb, { teamId, email: addr });
      if (n >= SOFT_BOUNCE_LIMIT) {
        const reason = `${n} soft bounces in a row${why ? ` · ${why}` : ""}`;
        const r = await suppressAddress(sb, { teamId, email: addr, reason });
        return { suppressed: r.count > 0, count: r.count, reason };
      }
      return { suppressed: false, bounceCount: n };
    }
  } catch (e) {
    console.warn(`[emailHealth] recordFailure(${addr}) skipped: ${String((e && e.message) || e).slice(0, 140)}`);
  }
  return { suppressed: false };
}

/* Increment bounce_count / stamp last_bounce_at. Read-modify-write rather than an RPC: this
 * fires a handful of times a day at most, and adding a database function is a migration the
 * platform team has to approve. Returns the highest count now on file for the address. */
async function bumpBounce(sb, { teamId, email }) {
  let sel = sb.from("roi_recipients").select("id,bounce_count");
  if (teamId) sel = sel.eq("team_id", teamId);
  const { data, error } = await matchEmail(sel, email);
  if (error || !data || !data.length) return 0;
  const now = new Date().toISOString();
  let max = 0;
  for (const row of data) {
    const next = Number(row.bounce_count || 0) + 1;
    max = Math.max(max, next);
    await sb.from("roi_recipients").update({ bounce_count: next, last_bounce_at: now }).eq("id", row.id);
  }
  return max;
}

// ── Reading a provider's bounce payload ───────────────────────────────────────────────────

/* Normalise a bounce/complaint webhook into [{ email, type, detail }].
 *
 * Provider-agnostic on purpose: mail.spyne.ai fronts the actual ESP, so whichever one we are
 * eventually pointed at, the ingest route should not need rewriting. Handles Resend, SendGrid,
 * SES (raw and inside its SNS envelope) and a plain { email, type } from the proxy itself.
 *
 * type is 'bounce' | 'complaint' | 'deferred'. Only 'deferred' is soft — SES 'Transient' bounces
 * and SendGrid 'blocked' are mapped to it, because a full mailbox is not a dead one and
 * suppressing on the first of those would silence a live, reachable recipient. */
function parseBounceEvents(body) {
  const out = [];
  const push = (email, type, detail) => { if (email && type) out.push({ email: String(email), type, detail: String(detail || "").slice(0, 300) }); };
  const norm = (t) => {
    const s = String(t || "").toLowerCase();
    if (s.includes("complain") || s.includes("spam")) return "complaint";
    if (s.includes("defer") || s.includes("delay")) return "deferred";
    if (s.includes("bounce") || s.includes("drop") || s.includes("reject") || s.includes("fail")) return "bounce";
    return "";
  };
  for (const ev of Array.isArray(body) ? body : [body]) {
    if (!ev || typeof ev !== "object") continue;
    // SES arrives wrapped in an SNS envelope with the real payload as a JSON string.
    if (typeof ev.Message === "string" && ev.Type) {
      try { for (const e of parseBounceEvents(JSON.parse(ev.Message))) out.push(e); } catch { /* not JSON — ignore */ }
      continue;
    }
    // SES: { notificationType:'Bounce', bounce:{ bounceType, bouncedRecipients:[{emailAddress,diagnosticCode}] } }
    if (ev.notificationType || ev.eventType) {
      const kind = norm(ev.notificationType || ev.eventType);
      const soft = String(ev.bounce?.bounceType || "").toLowerCase() === "transient";
      const list = ev.bounce?.bouncedRecipients || ev.complaint?.complainedRecipients || [];
      for (const r of list) push(r.emailAddress, soft ? "deferred" : kind, r.diagnosticCode || ev.bounce?.bounceSubType || "");
      continue;
    }
    // Resend: { type:'email.bounced', data:{ to:[…], bounce:{ message } } }
    if (ev.type && ev.data) {
      const kind = norm(ev.type);
      for (const a of Array.isArray(ev.data.to) ? ev.data.to : [ev.data.to]) push(a, kind, ev.data.bounce?.message || ev.data.reason || ev.type);
      continue;
    }
    // SendGrid: [{ email, event:'bounce', type:'blocked', reason }] · and the plain proxy shape.
    const soft = String(ev.type || "").toLowerCase() === "blocked";
    const kind = norm(ev.event || ev.type || ev.status);
    push(ev.email || ev.recipient || ev.to, soft && kind ? "deferred" : kind, ev.reason || ev.response || ev.event || "");
  }
  return out;
}

/* One recipient in a failed batch is bad. Work out which, suppress it, and re-send to the rest,
 * so one dead address can't silence a whole rooftop's email.
 *
 * `post(addresses)` re-posts the same message to a subset and returns the fetch Response. If the
 * proxy named the offending address in its error we trust that and retry once; otherwise we walk
 * the batch one address at a time. Only ever called on a HARD rejection (classifySendFailure),
 * and only once per send, so a gateway wobble can never turn into a send storm.
 * Returns { messageId } when the rest of the batch was delivered. */
async function isolateAndSuppress(sb, { to, errBody, post, teamId = null, log = console.warn }) {
  const readId = async (res) => { const j = await res.json().catch(() => ({})); return j.messageId ?? j.id ?? null; };
  const named = extractAddresses(errBody).filter((a) => to.some((t) => normalizeEmail(t) === a));
  for (const addr of named) {
    await recordFailure(sb, { teamId, email: addr, kind: "hard", detail: errBody });
    log(`  ⛔ suppressed ${addr} — the mail proxy rejected it: ${String(errBody).slice(0, 120)}`);
  }
  const rest = to.filter((e) => !named.includes(normalizeEmail(e)));
  if (!rest.length) return {};
  if (named.length) {                          // the proxy told us who — one retry with the rest
    const res = await post(rest);
    return res.ok ? { messageId: await readId(res) } : {};
  }
  if (to.length < 2) return {};                // single recipient, unnamed → nothing to isolate
  let firstId = null;                          // unnamed in a batch → find the offender address by address
  for (const addr of to) {
    const res = await post([addr]);
    if (res.ok) { const id = await readId(res); if (!firstId) firstId = id; continue; }
    const body = await res.text().catch(() => "");
    if (classifySendFailure(body) === "hard") {
      await recordFailure(sb, { teamId, email: addr, kind: "hard", detail: body });
      log(`  ⛔ suppressed ${addr} — isolated from a failing batch: ${body.slice(0, 120)}`);
    }
  }
  return { messageId: firstId };
}

module.exports = {
  addressProblem, isDeliverableAddress, normalizeEmail,
  isolateAndSuppress,
  isSuppressed, emailBlock, canEmail,
  DELIVERABILITY_COLS, selectRecipients, isMissingColumnError,
  classifySendFailure, extractAddresses, parseBounceEvents,
  suppressAddress, unsuppressAddress, recordFailure,
  SOFT_BOUNCE_LIMIT, DOMAIN_TYPOS, UNROUTABLE_TLDS,
};
