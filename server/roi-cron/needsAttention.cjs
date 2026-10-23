/* NEEDS-ATTENTION delivery — the one PUSH-driven transactional email.
 *
 * Every other transactional email is discovered by the poll (eventRunner.cjs) reading a feed.
 * This one is pushed in by the Sales Inbox backend the moment it flags a conversation as
 * "needs attention" (the customer asked something Vini could not answer and the thread is sitting
 * open). A poll would be wrong here: the whole value of the email is that it arrives while the
 * customer is still in the thread, and a 4-15 minute poll gap is most of the window.
 *
 * The caller supplies the EVENT. This module owns everything that protects the dealer's inbox, so
 * a push can never bypass a gate the poll respects:
 *
 *   1. rooftop known            — team_id must exist in roi_rooftop_config      → not_sent/unknown_rooftop
 *   2. churn gate               — subscriptions.isChurned                       → suppressed/churned
 *   3. rooftop type gate        — roi_rooftop_config.needs_attention_enabled,
 *                                 DEFAULT ON (only an explicit false opts out)  → not_sent/type_disabled
 *   4. dry run                  — global DRY_RUN or the dept's dry_run row       → suppressed/dry_run
 *   5. cooldown                 — one needs-attention email per conversation per
 *                                 NEEDS_ATTENTION_COOLDOWN_MIN (default 30)      → deduped/cooldown
 *   6. dedupe claim             — unique (team_id, email_type, event_key) on
 *                                 roi_event_emails; a retry is free              → deduped/duplicate_event
 *   7. verified recipients      — verified_at + email_enabled + dept flag +
 *                                 subscription 'needs_attention' + role tier     → not_sent/recipients_missing
 *   8. anti-churn value gate    — no question text ⇒ nothing to act on           → not_sent/no_value
 *
 * Every outcome writes a roi_event_emails row (with the rendered HTML) so the email tracker shows
 * the event whether or not it went out, exactly like the poll's types.
 *
 * The mail POST is INJECTED (`sendMail`) rather than reimplemented — the caller passes the mail
 * proxy client it already has (app.js postMailWithRetry / eventRunner.sendMail), so there is no
 * third copy of the retry policy to drift.
 */
const T = require("../../src/email/transactionalTemplates.cjs");
const emailValue = require("./emailValue.cjs");
const { isSubscribed, pickTieredRecipients, isChurned } = require("./subscriptions.cjs");
const { resolveTz } = require("./resolveTz.cjs");

const EMAIL_TYPE = "needs_attention";
// Same subscription key as the email type here (unlike 'chat', which stores as post_conversation) —
// this type has its own tracker grain AND its own recipient cell.
const SUBSCRIPTION_TYPE = "needs_attention";
const CONSOLE_BASE = (process.env.CONSOLE_BASE || "https://console.spyne.ai/converse-ai").replace(/\/$/, "");
const COOLDOWN_MIN = Number(process.env.NEEDS_ATTENTION_COOLDOWN_MIN || 30);
// "false"/"0" disable, matching eventRunner — DRY_RUN defaults TRUE so a fresh deploy records
// instead of sending.
const DRY_RUN = !["false", "0"].includes(String(process.env.DRY_RUN ?? "").trim().toLowerCase());

// Deliverability gate, shared with runner.cjs / eventRunner.cjs. Subsumes the old isRealEmail:
// it still drops the …@phone.invalid placeholder (SMS-only recipient) and additionally blocks
// malformed / mistyped addresses and any address already suppressed for bouncing — bounces are
// scored against the sending DOMAIN, so one dead address costs every rooftop its placement.
const { canEmail, selectRecipients } = require("./emailHealth.cjs");
const localDateISO = (tz) => {
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t)?.value;
    return `${g("year")}-${g("month")}-${g("day")}`;
  } catch { return new Date().toISOString().slice(0, 10); }
};

/** Console deep links for the email. `takeControl` is a FALLBACK only: the inbox route that
 * actually hands a thread to a human belongs to the console/inbox app, so the caller should send
 * its own `takeControlUrl`. Without one the button opens the conversations list — degraded, but it
 * never claims to do something it can't. */
function links(team, ent, dept, conversationId) {
  const q = `?enterprise_id=${encodeURIComponent(ent || "")}&team_id=${encodeURIComponent(team)}&serviceType=${dept}`;
  return {
    conversations: `${CONSOLE_BASE}/conversations${q}`,
    takeControl: conversationId ? `${CONSOLE_BASE}/conversations${q}&conversation_id=${encodeURIComponent(conversationId)}` : "",
    console: CONSOLE_BASE,
  };
}

/** Validate the pushed event. Returns { ok:true, value } or { ok:false, error } — a 400 for the
 * caller, never a silent default: a needs-attention email with a guessed customer or a missing
 * question is worse than no email. */
function validate(body) {
  const b = body || {};
  const teamId = String(b.teamId || b.team_id || "").trim();
  const conversationId = String(b.conversationId || b.conversation_id || "").trim();
  const eventId = String(b.eventId || b.event_id || "").trim();
  const question = String(b.question == null ? "" : b.question).trim();
  if (!teamId) return { ok: false, error: "teamId is required" };
  if (!conversationId) return { ok: false, error: "conversationId is required" };
  if (!eventId) return { ok: false, error: "eventId is required (it is the idempotency key — reuse it on retries)" };
  if (!question) return { ok: false, error: "question is required — it is the whole email. Send the customer's words verbatim." };
  if (question.length > 2000) return { ok: false, error: "question is too long (max 2000 chars)" };
  const dept = String(b.department || b.serviceType || "sales").toLowerCase() === "service" ? "service" : "sales";
  const channelRaw = String(b.channel || "chat").toLowerCase();
  const channel = ["chat", "sms", "call"].includes(channelRaw) ? channelRaw : "chat";
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  return {
    ok: true,
    value: {
      teamId, conversationId, eventId, dept, channel, question,
      enterpriseId: String(b.enterpriseId || b.enterprise_id || "").trim(),
      takeControlUrl: String(b.takeControlUrl || b.take_control_url || "").trim(),
      customer: b.customer || b.customerName || "",
      phone: b.phone || "",
      at: b.at || b.askedAt || null,
      waitingSince: b.waitingSince || b.at || b.askedAt || null,
      reason: b.reason || "",
      attempts: Number(b.attempts) || 0,
      intent: b.intent || "",
      sentiment: b.sentiment || "",
      sentimentScore: b.sentimentScore,
      frustrated: b.frustrated === true,
      vehicle: b.vehicle || "",
      vin: b.vin || "",
      stockNumber: b.stockNumber || b.stock_number || "",
      transcript: b.transcript || "",
      // last 12 only — the email shows 8 and the row stores what was rendered, not a whole history
      messages: msgs.slice(-12).map((m) => ({
        direction: m.direction === "in" || m.direction === "inbound" ? "in" : "out",
        authorType: m.authorType || m.author_type || "",
        body: String(m.body == null ? "" : m.body).slice(0, 1000),
        status: m.status || "",
        at: m.at || m.createdAt || null,
      })),
    },
  };
}

/**
 * Render + gate + send one needs-attention email.
 *
 * @param sb        Supabase client with the SERVICE key (roi_* tables are RLS-locked)
 * @param body      the pushed event (see validate())
 * @param sendMail  async ({ to, subject, html }) => { messageId } — the caller's mail-proxy client
 * @param withPixel (html, rowId) => html — optional open-tracking pixel injector. Applied AFTER the
 *                  dedupe claim (the pixel keys to the row id), so the stored HTML and the sent
 *                  bytes are the same, exactly like the poll's types.
 * @param opts      { dryRun?:boolean } — dryRun renders and returns the HTML, writes NO row, sends nothing
 * @returns { httpStatus, payload } — payload.status is one of
 *          sent | suppressed | not_sent | deduped | error, with a machine-readable `reason`
 */
async function deliverNeedsAttention({ sb, body, sendMail, withPixel, opts }) {
  const v = validate(body);
  if (!v.ok) return { httpStatus: 400, payload: { ok: false, error: v.error } };
  const ev = v.value;
  const previewOnly = !!(opts && opts.dryRun);

  // ── rooftop context ────────────────────────────────────────────────────────────────────────
  // A preview reads the rooftop only (name + timezone are what the render needs). It deliberately
  // does NOT read roi_recipients: a render-and-return call has no business moving a rooftop's
  // recipient list, and the reply goes back over the caller's connection.
  const cfgQ = sb.from("roi_rooftop_config")
    .select("team_id,enterprise_id,rooftop_name,team_name,timezone,needs_attention_enabled,lifecycle_status,churn_date")
    .eq("team_id", ev.teamId).maybeSingle();
  const [cfgRes, liveRes, recRes] = previewOnly
    ? [await cfgQ, null, null]
    : await Promise.all([
      cfgQ,
      sb.from("roi_live_departments").select("team_id,department,is_live,dry_run").eq("team_id", ev.teamId).eq("department", ev.dept).maybeSingle(),
      selectRecipients(sb, "email,receives_sales,receives_service,email_enabled,role,subscriptions,verified_at", (q) => q.eq("team_id", ev.teamId)),
    ]);
  if (cfgRes.error) throw new Error(`roi_rooftop_config: ${cfgRes.error.message}`);
  if (recRes && recRes.error) throw new Error(`roi_recipients: ${recRes.error.message}`);
  const cfg = cfgRes.data;
  const live = liveRes && liveRes.data;

  // rooftop_name || team_name || "" — NEVER the raw team_id, which leaked into subject lines once.
  const name = (cfg && (cfg.rooftop_name || cfg.team_name)) || "";
  const enterpriseId = ev.enterpriseId || (cfg && cfg.enterprise_id) || "";
  const tz = cfg ? await resolveTz(sb, ev.teamId, cfg.timezone, name).catch(() => cfg.timezone || "America/New_York") : "America/New_York";

  // ── render first: every outcome stores the HTML, so the tracker can view (and manually send)
  // an email that a gate held back ──────────────────────────────────────────────────────────────
  const L = links(ev.teamId, enterpriseId, ev.dept, ev.conversationId);
  const html = T.renderNeedsAttention({
    rooftopName: name || "your rooftop", dept: ev.dept, tz, links: L,
    takeControlUrl: ev.takeControlUrl || L.takeControl,
    event: ev,
  });
  const subject = `Needs attention — ${ev.customer || "a customer"}${name ? ` · ${name}` : ""}`;
  if (previewOnly) {
    return { httpStatus: 200, payload: { ok: true, status: "preview", subject, renderedHtml: emailValue.stripMarker(html), teamId: ev.teamId, department: ev.dept } };
  }

  const done = (httpStatus, status, reason, extra) => ({ httpStatus, payload: { ok: true, status, ...(reason ? { reason } : {}), teamId: ev.teamId, department: ev.dept, ...(extra || {}) } });

  // ── gates that need no row ─────────────────────────────────────────────────────────────────
  if (!cfg) return done(200, "not_sent", "unknown_rooftop", { detail: "no roi_rooftop_config row for this team_id — the rooftop is not onboarded to notifications" });
  if (isChurned(cfg, localDateISO(tz))) return done(200, "suppressed", "churned");
  if (cfg.needs_attention_enabled === false) return done(200, "not_sent", "type_disabled");

  const base = { team_id: ev.teamId, enterprise_id: enterpriseId || null, department: ev.dept };
  const dry = DRY_RUN || (live && live.dry_run === true);

  // ── cooldown: a thread can generate several unanswered questions in a row. Each is a real event
  // (its own row, its own eventId), but the dealer only needs to be pulled in once — the human is
  // in the thread after the first one. Held events are recorded, not dropped. ──────────────────
  if (COOLDOWN_MIN > 0) {
    const since = new Date(Date.now() - COOLDOWN_MIN * 60 * 1000).toISOString();
    const { data: recent } = await sb.from("roi_event_emails")
      .select("id,sent_at").eq("team_id", ev.teamId).eq("email_type", EMAIL_TYPE)
      .like("event_key", `na:${ev.conversationId}:%`).eq("status", "sent").gte("sent_at", since)
      .limit(1).maybeSingle();
    if (recent) {
      await sb.from("roi_event_emails").insert({
        ...base, email_type: EMAIL_TYPE, event_key: `na:${ev.conversationId}:${ev.eventId}`,
        status: "suppressed", reason: "cooldown", subject, rendered_html: html,
      }).then(() => {}, () => {}); // best-effort audit row; a dupe key here is itself a dupe event
      return done(200, "deduped", "cooldown", { cooldownMinutes: COOLDOWN_MIN, previousEmailId: recent.id });
    }
  }

  // ── dedupe claim: the unique (team_id, email_type, event_key) makes a caller retry free ─────
  const eventKey = `na:${ev.conversationId}:${ev.eventId}`;
  let id;
  {
    const { data, error } = await sb.from("roi_event_emails")
      .insert({ ...base, email_type: EMAIL_TYPE, event_key: eventKey, status: "queued", subject })
      .select("id");
    if (error) {
      if ((error.code || "") === "23505" || /duplicate|unique/i.test(error.message || "")) {
        return done(200, "deduped", "duplicate_event", { detail: "this eventId was already handled" });
      }
      throw new Error(`roi_event_emails: ${error.message}`);
    }
    id = data && data[0] ? data[0].id : null;
  }
  const finish = (patch) => sb.from("roi_event_emails").update(patch).eq("id", id);
  // pixel keys to the claimed row, so an open is attributable to THIS event
  const wireHtml = typeof withPixel === "function" ? withPixel(html, id) : html;

  try {
    // ── recipients: verified + dept + subscribed + role tier. Same chain as the poll, so a push
    // cannot reach an address the poll wouldn't. ─────────────────────────────────────────────
    const recs = (recRes && recRes.data) ?? []; // recRes is null only on the preview path, which returned above
    const deptOk = (r) => (ev.dept === "sales" ? r.receives_sales : r.receives_service);
    const emails = pickTieredRecipients(
      recs.filter((r) => r.verified_at && canEmail(r) && deptOk(r) && r.email_enabled && isSubscribed(r, SUBSCRIPTION_TYPE, "email")),
    ).map((r) => r.email);

    if (!emails.length) {
      await finish({ status: "not_sent", reason: "recipients_missing", rendered_html: wireHtml });
      return done(200, "not_sent", "recipients_missing", { id, detail: "no verified, needs-attention-subscribed recipient for this rooftop/department" });
    }
    if (dry) {
      await finish({ status: "suppressed", reason: "dry_run", rendered_html: wireHtml, recipients: emails.map((email) => ({ email })) });
      return done(200, "suppressed", "dry_run", { id, recipients: emails });
    }
    // Anti-churn gate — validate() already refuses a missing question, so this fires only if the
    // renderer's own no-value rule changes. Never force-overridden on the push path.
    if (emailValue.isNoValue(wireHtml)) {
      await finish({ status: "not_sent", reason: "no_value", rendered_html: wireHtml });
      return done(200, "not_sent", "no_value", { id });
    }

    const sentAt = new Date().toISOString();
    const { messageId } = await sendMail({ to: emails, subject, html: wireHtml });
    await finish({
      status: "sent", reason: null, rendered_html: wireHtml, sent_at: sentAt,
      message_id: messageId || `na-${sentAt}`, recipients: emails.map((email) => ({ email, received: true })),
    });
    return done(200, "sent", null, { id, messageId: messageId || null, recipients: emails });
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 300);
    try { await finish({ status: "error", reason: msg, rendered_html: html }); } catch { /* the row already says queued */ }
    return { httpStatus: 502, payload: { ok: false, status: "error", error: msg, id } };
  }
}

module.exports = { deliverNeedsAttention, validate, links, EMAIL_TYPE, SUBSCRIPTION_TYPE, COOLDOWN_MIN };
