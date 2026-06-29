#!/usr/bin/env node
/* ROI TRANSACTIONAL email poll — the event-driven companion to the daily/weekly/monthly
 * digest cron (runner.cjs). Runs frequently (every ~15 min via Vercel cron) and, per the
 * Jun-2026 review, sends one email per NEW event:
 *
 *   post_appointment       — a new appointment was booked            (reporting-vini /api/meetings)
 *   post_conversation      — a call conversation happened            (reporting-vini /api/conversations)
 *   action_item            — a new action item was created/assigned  (reporting-vini /api/action-items?scope=recent)
 *   action_item_overdue    — an action item breached its SLA         (reporting-vini /api/action-items?scope=overdue)
 *
 * Each type is gated per rooftop by roi_rooftop_config.*_enabled. Dedupe is the unique
 * (team_id, email_type, event_key) on roi_event_emails — an event is emailed at most once.
 * Outbound post-conversation only fires when the customer responded / it's actionable
 * (config: post_conversation_mode, post_conversation_outbound_requires_reply).
 *
 * SAFETY: DRY_RUN defaults TRUE — records 'suppressed/dry_run', sends nothing. dealership
 * dry_run=true is always held. Same mail proxy + env as runner.cjs.
 *
 *   node eventRunner.cjs            # one pass
 *   node eventRunner.cjs --loop     # every 15 min
 */
const { createClient } = require("@supabase/supabase-js");
const T = require("../../src/email/transactionalTemplates.cjs");
// Anti-churn value gate (shared with the digest runner) — never email a no-value
// transactional unless overridden (DANGER).
const emailValue = require("./emailValue.cjs");

const SB_URL = process.env.ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
const MAIL_URL = process.env.MAIL_PROXY_URL || "https://mail.spyne.ai/api/v1/send-template-email";
const MAIL_TEMPLATE = process.env.MAIL_TEMPLATE || "email-control-tower-report";
const MAIL_TOKEN = process.env.MAIL_TOKEN || "";
const DRY_RUN = process.env.DRY_RUN !== "false";
const REPORTING_API_BASE = (process.env.REPORTING_API_BASE || "https://reporting-vini.vercel.app").replace(/\/$/, "");
const SPYNE_TOKEN = process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || "";
const POLL_MINUTES = Number(process.env.EVENT_POLL_MINUTES || 20); // look-back window per pass
const CONSOLE_BASE = "https://console.spyne.ai/converse-ai";

// Open-tracking pixel → the track-open Edge Function (keyed by the event-email row id).
// Override the host with DIGEST_TRACK_BASE if it ever moves.
const TRACK_OPEN_URL = (process.env.DIGEST_TRACK_BASE || "https://qludnojfibguobgeeujw.supabase.co/functions/v1/track-open").replace(/\/$/, "");
function withPixel(html, id) {
  if (!html || !id) return html;
  const img = `<img src="${TRACK_OPEN_URL}?id=${encodeURIComponent(id)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;
  return html.includes("</body>") ? html.replace("</body>", `${img}</body>`) : html + img;
}

const IS_CLI = require.main === module;
if (IS_CLI && (!SB_URL || !SB_KEY)) { console.error("Set ROI_SUPABASE_URL + ROI_SUPABASE_SERVICE_KEY"); process.exit(1); }
const sb = createClient(SB_URL || "http://invalid.local", SB_KEY || "noop", { auth: { persistSession: false } });

const todayISO = () => new Date().toISOString().slice(0, 10);
// Dealer-local "today" (YYYY-MM-DD) so the post-appointment window matches the dealer's day, not UTC.
function localDateISO(tz) {
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t)?.value;
    return `${g("year")}-${g("month")}-${g("day")}`;
  } catch { return todayISO(); }
}
// Appointment time in the dealer's local zone, e.g. "Mon, Jun 23 · 2:30 PM".
function fmtSched(iso, tz) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d.getTime())) return "";
  const z = tz || "America/New_York";
  try {
    const dp = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: z }).format(d);
    const tp = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: z }).format(d);
    return `${dp} · ${tp}`;
  } catch { return ""; }
}
// The reporting-vini read API now requires a credential (it returns per-customer PII). Forward the
// trusted service secret (preferred) or the Spyne token so these server-to-server calls authorize;
// without this the conversations/action-items/reports/meetings calls return 401.
const REPORTING_AUTH = process.env.CRON_SECRET || SPYNE_TOKEN || "";
// Set when any feed response comes back degraded (e.g. reporting-vini missing CLICKHOUSE_* → empty
// feed). Surfaced loudly at the end of runOnce so a misconfig can't silently disable all transactional
// email for days. Reset at the start of each pass.
let _feedDegraded = false;
async function apiJson(path) {
  const headers = REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {};
  const res = await fetch(`${REPORTING_API_BASE}${path}`, { headers, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`reporting-api ${res.status} ${path}`);
  const j = await res.json();
  if (j && (j.degraded || j.note === "clickhouse not configured")) _feedDegraded = true;
  return j;
}
function links(team, ent, dept) {
  const q = `?enterprise_id=${encodeURIComponent(ent || "")}&team_id=${encodeURIComponent(team)}&serviceType=${dept}`;
  return { appointment: `${CONSOLE_BASE}/appointments${q}`, conversations: `${CONSOLE_BASE}/conversations${q}`, actionItems: `${CONSOLE_BASE}/action-items${q}`, console: CONSOLE_BASE };
}

// MTD appointment count for the post-appointment "additional value" strip.
async function apptMTD(team, dept) {
  try {
    const start = todayISO().slice(0, 8) + "01", end = todayISO();
    const j = await apiJson(`/api/reports?team_id=${team}&start=${start}&end=${end}`);
    const D = dept === "service" ? "Service" : "Sales";
    const byName = {}; for (const a of j.agents || []) byName[a.name] = a;
    const im = (byName[`${D} Inbound`] || {}).metrics || {}, om = (byName[`${D} Outbound`] || {}).metrics || {};
    return (Number(im.appointments) || 0) + (Number(om.appointments) || 0);
  } catch { return 0; }
}

async function sendMail(to, subject, html, opts) {
  // Anti-churn gate: refuse a no-value email (marker stamped by the renderer)
  // unless { force: true } (DANGER override). Strip the marker off the wire.
  const force = opts && opts.force === true;
  if (emailValue.isNoValue(html)) {
    if (!force) { const e = new Error("This email shows no value — blocked to avoid churn. Override with the password to send."); e.code = "BLOCKED_NO_VALUE"; throw e; }
    html = emailValue.stripMarker(html);
  }
  const body = JSON.stringify({ to: to.join(","), subject, template: MAIL_TEMPLATE, templateData: { HTMLdata: html } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(MAIL_URL, { method: "POST", headers: { "Content-Type": "application/json", ...(MAIL_TOKEN ? { Authorization: `Bearer ${MAIL_TOKEN}` } : {}) }, body });
    if (res.ok) { const j = await res.json().catch(() => ({})); return j.messageId ?? j.id ?? null; }
    if (res.status < 500 && res.status !== 429) throw new Error(`mail ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  throw new Error("mail failed after retries");
}

// Insert the dedupe row FIRST (status 'queued') — the unique (team,type,event_key) guarantees
// only one worker ever claims an event. If the insert conflicts, someone already handled it → skip.
async function claim(base, eventKey) {
  const { data, error } = await sb.from("roi_event_emails")
    .insert({ ...base, event_key: eventKey, status: "queued" })
    .select("id");
  if (error) { if ((error.code || "") === "23505" || /duplicate|unique/i.test(error.message || "")) return null; throw error; }
  return data && data[0] ? data[0].id : null;
}
const finish = (id, patch) => sb.from("roi_event_emails").update(patch).eq("id", id);

async function runOnce() {
  console.log(`\n── ROI EVENT pass @ ${new Date().toISOString()} · DRY_RUN=${DRY_RUN} · window=${POLL_MINUTES}m ──`);
  _feedDegraded = false;
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const [liveRes, cfgRes, recRes] = await Promise.all([
    // enterprise_id lives on roi_rooftop_config (not roi_live_departments) — read it from cfg, like runner.cjs.
    sb.from("roi_live_departments").select("team_id,department,dry_run").eq("is_live", true),
    sb.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,post_appointment_enabled,post_conversation_enabled,action_item_enabled,action_item_overdue_enabled,post_conversation_mode,post_conversation_outbound_requires_reply,action_item_sla_minutes"),
    sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled"),
  ]);
  if (liveRes.error || cfgRes.error || recRes.error) throw new Error((liveRes.error || cfgRes.error || recRes.error).message);
  const cfgOf = new Map((cfgRes.data ?? []).map((c) => [c.team_id, c]));
  const recOf = new Map();
  for (const r of recRes.data ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }
  const out = { sent: 0, suppressed: 0, skipped_dupe: 0, no_recipients: 0, errors: 0 };
  const ONLY = (process.env.ONLY_TEAMS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const targets = (liveRes.data ?? []).filter((L) => !ONLY.length || ONLY.includes(L.team_id));

  for (const L of targets) {
    const c = cfgOf.get(L.team_id) || {};
    const name = c.rooftop_name || L.team_id;
    const tz = c.timezone || "America/New_York"; // dealer-local zone for windows + displayed times
    const dept = L.department; // 'sales' | 'service'
    const emails = (recOf.get(L.team_id) ?? []).filter((r) => (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled).map((r) => r.email);
    const base = { team_id: L.team_id, enterprise_id: c.enterprise_id, department: dept };
    const dry = DRY_RUN || L.dry_run === true;
    const L_ = links(L.team_id, c.enterprise_id, dept);

    // Build the list of (type, eventKey, render, subject) jobs for the enabled types.
    const jobs = [];
    try {
      if (c.post_appointment_enabled) {
        const day = localDateISO(tz); // dealer-local "today", not UTC
        const j = await apiJson(`/api/meetings?scope=window&team_id=${L.team_id}&enterprise_id=${encodeURIComponent(c.enterprise_id || "")}&serviceType=${dept}&start=${day}&end=${day}${SPYNE_TOKEN ? `&auth_key=${encodeURIComponent(SPYNE_TOKEN)}` : ""}`);
        const mtd = await apptMTD(L.team_id, dept);
        for (const m of (j.meetings || []).slice(0, 50)) {
          if (!m.id) continue;
          // Only surface VINI-booked appointments (source='spyne'). Skip known BDC/CRM bookings —
          // a "Vini booked you an appointment" email about the dealer's own booking is noise.
          // (When the feed doesn't report source yet, keep firing with a generic label.)
          if (m.source && m.source !== "spyne") continue;
          const byVini = m.source === "spyne";
          jobs.push({ type: "post_appointment", key: m.id,
            subject: `${byVini ? "Vini booked an appointment" : "New appointment"} — ${name}`,
            html: T.renderPostAppointment({ rooftopName: name, dept, tz, mtdCount: mtd, links: L_, appointment: {
              customer: m.customer, phone: m.phone, when: fmtSched(m.when, m.tz || tz), time: m.time, relDay: m.relDay,
              type: m.type || (dept === "service" ? "Service" : "Sales"), intent: m.intent, vehicle: m.vehicle,
              transportation: m.transportation || m.transportationOption, status: m.status, byVini, recordingUrl: m.recordingUrl,
            } }) });
        }
      }
      if (c.post_conversation_enabled) {
        const actionableOnly = (c.post_conversation_mode || "actionable") === "actionable";
        const j = await apiJson(`/api/conversations?team_id=${L.team_id}&serviceType=${dept}&minutes=${POLL_MINUTES}&limit=50${actionableOnly ? "&actionableOnly=1" : ""}`);
        for (const cv of j.conversations || []) {
          // outbound: only when the customer responded (config) — proxy: actionable signal present.
          if (cv.direction === "outbound" && c.post_conversation_outbound_requires_reply !== false && !(cv.hasActionItem || cv.appointmentScheduled)) continue;
          jobs.push({ type: "post_conversation", key: cv.id,
            subject: `Conversation summary — ${name}`,
            html: T.renderPostConversation({ rooftopName: name, dept, tz, conversation: cv, links: L_ }) });
        }
      }
      if (c.action_item_enabled) {
        const [recent, open] = await Promise.all([
          apiJson(`/api/action-items?team_id=${L.team_id}&serviceType=${dept}&scope=recent&minutes=${POLL_MINUTES}&limit=50`),
          apiJson(`/api/action-items?team_id=${L.team_id}&serviceType=${dept}&scope=open&limit=50`),
        ]);
        const openItems = open.actionItems || [];
        const recentItems = recent.actionItems || [];
        // LEAD-LEVEL: group just-arrived items by their lead, then send ONE email per lead
        // carrying ALL of that lead's open action items + lead context. Falls back to grouping
        // by customer/id when the feed has no leadId yet.
        const leadKey = (it) => it.leadId || it.lead_id || it.customer || it.id;
        const byLead = new Map();
        for (const it of recentItems) { const k = leadKey(it); const g = byLead.get(k) || []; g.push(it); byLead.set(k, g); }
        for (const [k, arrived] of byLead) {
          const leadOpen = openItems.filter((p) => leadKey(p) === k);
          const items = leadOpen.length ? leadOpen : arrived; // prefer the lead's full open set
          const seed = arrived[0] || items[0] || {};
          const lead = {
            customer: seed.customer || seed.leadName, phone: seed.phone, vehicle: seed.vehicle,
            source: seed.leadSource || seed.source, stage: seed.stage,
            aiScore: seed.aiScore, grade: seed.grade, sentiment: seed.sentiment, sentimentScore: seed.sentimentScore,
            lastSummary: seed.lastSummary || seed.conversationSummary,
          };
          // dedupe per lead per newest-arrived item, so a fresh item re-triggers the lead view once
          const newestId = arrived.map((x) => x.id).filter(Boolean).sort().slice(-1)[0] || k;
          jobs.push({ type: "action_item", key: `lead:${k}:${newestId}`,
            subject: `Action items — ${lead.customer || name}`,
            html: T.renderActionItem({ rooftopName: name, dept, tz, lead, items, totalOpen: leadOpen.length || items.length, justArrived: arrived.length, mtdOpen: open.total, links: L_ }) });
        }
      }
      if (c.action_item_overdue_enabled) {
        const j = await apiJson(`/api/action-items?team_id=${L.team_id}&serviceType=${dept}&scope=overdue&limit=50`);
        const overdue = j.actionItems || [];
        // LEAD-LEVEL escalation: group a customer's overdue items into ONE red email so the
        // manager sees "who's been waiting too long". Re-escalates once per lead per day.
        const leadKey = (it) => it.leadId || it.lead_id || it.customer || it.id;
        const byLead = new Map();
        for (const it of overdue) { const k = leadKey(it); const g = byLead.get(k) || []; g.push(it); byLead.set(k, g); }
        const dayKey = localDateISO(tz);
        for (const [k, items] of byLead) {
          const seed = items[0] || {};
          const lead = {
            customer: seed.customer || seed.leadName, phone: seed.phone, vehicle: seed.vehicle,
            source: seed.leadSource || seed.source, stage: seed.stage,
            aiScore: seed.aiScore, grade: seed.grade, sentiment: seed.sentiment, sentimentScore: seed.sentimentScore,
            lastSummary: seed.lastSummary || seed.conversationSummary,
          };
          const oldest = items.map((x) => x.dueAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0];
          jobs.push({ type: "action_item_overdue", key: `lead:${k}:overdue:${dayKey}`,
            subject: `Overdue — ${lead.customer || name}`,
            html: T.renderActionItemOverdue({ rooftopName: name, dept, tz, lead, items, oldestDueAt: oldest, totalOverdue: items.length, links: L_ }) });
        }
      }
    } catch (e) { out.errors++; console.log(`  ✗ ${name} [${dept}] feed error: ${String(e).slice(0, 140)}`); continue; }

    for (const job of jobs) {
      let id;
      try {
        id = await claim({ ...base, email_type: job.type }, job.key);
        if (!id) { out.skipped_dupe++; continue; } // already handled in a prior pass
        // Inject the open-tracking pixel now that we have the row id, so the stored
        // HTML and the sent bytes both carry it (id keys the open back to this row).
        const html = withPixel(job.html, id);
        // Always store the generated HTML — even when we can't send (no recipient) — so the tracker
        // always has a copy to view and you can send it manually later.
        if (!emails.length) { await finish(id, { status: "not_sent", reason: "recipients_missing", subject: job.subject, rendered_html: html }); out.no_recipients++; continue; }
        if (dry) { await finish(id, { status: "suppressed", reason: "dry_run", subject: job.subject, rendered_html: html, recipients: emails.map((e) => ({ email: e })) }); out.suppressed++; continue; }
        const sentAt = new Date().toISOString();
        const messageId = await sendMail(emails, job.subject, html);
        await finish(id, { status: "sent", subject: job.subject, rendered_html: html, message_id: messageId || `evt-${sentAt}`, sent_at: sentAt, recipients: emails.map((e) => ({ email: e, received: true })) });
        out.sent++;
      } catch (e) { out.errors++; if (id) { try { await finish(id, { status: "error", reason: String(e).slice(0, 300), rendered_html: job.html }); } catch { /* ignore */ } } }
    }
  }
  if (_feedDegraded) {
    out.feed_degraded = true;
    console.error("  ⚠️  reporting-vini feed DEGRADED (clickhouse not configured) — transactional emails are DISABLED until CLICKHOUSE_HOST/CLICKHOUSE_PASSWORD are set on the reporting-vini deployment. No events were sent this pass.");
  }
  console.log("  events summary:", JSON.stringify(out));
  return out;
}

// ── LIVE PREVIEW (dashboard) ─────────────────────────────────────────────────
// Re-render ONE transactional email on demand with the CURRENT template, pulling the
// customer's real data from the reporting feeds. Powers the tracker's "Latest design"
// toggle so a manager can preview the up-to-date email per customer even when the
// stored copy is older (or no event has been sent yet). Mirrors the runOnce mapping.
// Returns rendered HTML, or null when the referenced item can't be found.
async function previewEvent(opts) {
  opts = opts || {};
  const dept = opts.department === "service" ? "service" : "sales";
  const tz = opts.tz || "America/New_York";
  const name = opts.rooftopName || opts.teamId;
  const teamId = opts.teamId, ent = opts.enterpriseId || "";
  const emailType = opts.emailType, eventKey = String(opts.eventKey || "");
  const L_ = links(teamId, ent, dept);
  // When a specific event was clicked (eventKey present) we must render THAT customer or nothing.
  // Falling back to the feed's most-recent item rendered a different customer's PII into the
  // preview (the "shows data for <someone else>" bug). The representative-customer fallback is only
  // allowed for the synthetic "latest design" preview, which carries no eventKey.
  const keyed = eventKey !== "";

  if (emailType === "post_appointment") {
    const day = localDateISO(tz);
    const j = await apiJson(`/api/meetings?scope=window&team_id=${teamId}&enterprise_id=${encodeURIComponent(ent)}&serviceType=${dept}&start=${day}&end=${day}${SPYNE_TOKEN ? `&auth_key=${encodeURIComponent(SPYNE_TOKEN)}` : ""}`);
    const list = j.meetings || [];
    const m = list.find((x) => String(x.id) === eventKey) || (keyed ? null : list[0]);
    if (!m) return null;
    const mtd = await apptMTD(teamId, dept).catch(() => 0);
    return T.renderPostAppointment({ rooftopName: name, dept, tz, mtdCount: mtd, links: L_, appointment: {
      customer: m.customer, phone: m.phone, when: fmtSched(m.when, m.tz || tz), time: m.time, relDay: m.relDay,
      type: m.type || (dept === "service" ? "Service" : "Sales"), intent: m.intent, vehicle: m.vehicle,
      transportation: m.transportation || m.transportationOption, status: m.status, byVini: m.source === "spyne", recordingUrl: m.recordingUrl,
    } });
  }

  if (emailType === "post_conversation") {
    const j = await apiJson(`/api/conversations?team_id=${teamId}&serviceType=${dept}&minutes=20160&limit=200`);
    const list = j.conversations || [];
    const cv = list.find((x) => String(x.id) === eventKey) || (keyed ? null : list[0]);
    if (!cv) return null;
    return T.renderPostConversation({ rooftopName: name, dept, tz, conversation: cv, links: L_ });
  }

  // action_item / action_item_overdue → eventKey is `lead:<leadKey>:…`
  const leadKey = eventKey.replace(/^lead:/, "").split(":")[0];
  const scope = emailType === "action_item_overdue" ? "overdue" : "open";
  const j = await apiJson(`/api/action-items?team_id=${teamId}&serviceType=${dept}&scope=${scope}&limit=200`);
  const all = j.actionItems || [];
  const keyOf = (it) => it.leadId || it.lead_id || it.customer || it.id;
  const items = leadKey ? all.filter((it) => String(keyOf(it)) === leadKey) : [];
  // Keyed click → only that lead's items (never another lead's, which showed the wrong customer's
  // action items). all.slice fallback is reserved for the synthetic, key-less preview.
  const use = items.length ? items : (keyed ? [] : all.slice(0, 4));
  if (!use.length) return null;
  const seed = use[0] || {};
  const lead = {
    customer: seed.customer || seed.leadName, phone: seed.phone, vehicle: seed.vehicle,
    source: seed.leadSource || seed.source, stage: seed.stage,
    aiScore: seed.aiScore, grade: seed.grade, sentiment: seed.sentiment, sentimentScore: seed.sentimentScore,
    lastSummary: seed.lastSummary || seed.conversationSummary,
  };
  if (emailType === "action_item_overdue") {
    const oldest = use.map((x) => x.dueAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0];
    return T.renderActionItemOverdue({ rooftopName: name, dept, tz, lead, items: use, oldestDueAt: oldest, totalOverdue: use.length, links: L_ });
  }
  return T.renderActionItem({ rooftopName: name, dept, tz, lead, items: use, totalOpen: use.length, justArrived: 0, mtdOpen: j.total, links: L_ });
}

module.exports = { runOnce, previewEvent };
if (IS_CLI) {
  (async () => {
    await runOnce();
    if (process.argv.includes("--loop")) setInterval(() => runOnce().catch((e) => console.error("pass failed:", e)), 15 * 60 * 1000);
  })();
}
