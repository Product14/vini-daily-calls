'use strict';

/**
 * Renders the "previous daily emailer" template (EmailShell v1 / dealer-reporting
 * design) as a self-contained HTML email from templateData (the object
 * buildTemplateData / buildServiceTemplateData produce).
 *
 * This HTML is BOTH:
 *   • what we send (when useDirectHtml=true → sendRawHtmlEmail), and
 *   • what we store on the run (roi_digest_runs.rendered_html) so the tracker
 *     shows the exact email that went out — tracked from THIS codebase, no Mongo.
 *
 * Layout mirrors the dealer-facing template:
 *   header → 2 hero cards (Appointments + Conversations w/ channel bar) → CTAs →
 *   Action Required → Inbound Activity (appts / leads / avg response) →
 *   Channel breakdown → After-hours + Warm transfers → Outbound Activity →
 *   Active campaigns → footer.
 */

const PURPLE = '#4600F2';

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function n(v) { const x = typeof v === 'number' ? v : parseInt(v, 10); return Number.isFinite(x) ? x : 0; }

/** A stacked call/sms/chat bar (email-safe table). */
function channelBar(call, sms, chat) {
  const total = call + sms + chat || 1;
  const seg = (w, color) => w > 0
    ? `<td style="width:${(w / total) * 100}%;background:${color};font-size:0;line-height:0;">&nbsp;</td>` : '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="height:8px;border-radius:4px;overflow:hidden;margin-top:8px;">
    <tr>${seg(call, '#2563EB')}${seg(sms, '#7C3AED')}${seg(chat, '#16A34A')}</tr></table>`;
}
function legend(call, sms, chat) {
  const dot = (c, label, val) =>
    `<span style="display:inline-block;margin-right:14px;font-size:11px;color:#374151;">
       <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:5px;"></span>${label} ${val}</span>`;
  return `<div style="margin-top:8px;">${dot('#2563EB', 'Call', call)}${dot('#7C3AED', 'Sms', sms)}${dot('#16A34A', 'Chat', chat)}</div>`;
}

function heroCard(label, value, sub, extra) {
  return `<td width="50%" valign="top" style="padding:6px;">
    <div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;">
      <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(label)}</div>
      <div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${esc(value)}
        ${sub ? `<span style="font-size:12px;font-weight:500;color:#6B7280;"> ${esc(sub)}</span>` : ''}</div>
      ${extra || ''}
    </div></td>`;
}

function miniCard(label, value, sub) {
  return `<td width="33%" valign="top" style="padding:6px;">
    <div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px;">
      <div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(label)}</div>
      <div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px;">${esc(value)}</div>
      ${sub ? `<div style="font-size:11px;color:#6B7280;margin-top:2px;">${esc(sub)}</div>` : ''}
    </div></td>`;
}

function sectionTitle(t) {
  return `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700;margin:22px 0 10px;">${esc(t)}</div>`;
}
function divider() { return `<div style="border-top:1px solid #E5E7EB;margin:22px 0;"></div>`; }

function actionItems(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map(i => `
    <tr><td style="padding:7px 0;">
      <span style="display:inline-block;min-width:22px;height:22px;line-height:22px;text-align:center;background:#111827;color:#fff;border-radius:6px;font-size:12px;font-weight:700;">${esc(i.count)}</span>
      <span style="font-size:13px;color:#111827;margin-left:10px;">${esc(i.label)}</span>
      ${i.tag ? `<span style="font-size:11px;color:#9CA3AF;"> · ${esc(i.tag)}</span>` : ''}
    </td></tr>`).join('');
}

function campaigns(camps, extra) {
  if (!Array.isArray(camps) || !camps.length) return '';
  const rows = camps.map(c => `
    <div style="border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;margin-top:8px;">
      <div><span style="font-size:13px;font-weight:600;color:#111827;">${esc(c.name)}</span>
        <span style="font-size:9px;font-weight:700;letter-spacing:.06em;color:#16A34A;background:#DCFCE7;border-radius:4px;padding:2px 6px;margin-left:8px;">${esc(String(c.status || 'active').toUpperCase())}</span></div>
      <div style="font-size:12px;color:#6B7280;margin-top:4px;">${esc(c.dials)} dials · ${esc(c.appts)} appts · ${esc(c.conversion)} conversion</div>
    </div>`).join('');
  const more = extra > 0 ? `<div style="font-size:11px;color:#9CA3AF;margin-top:8px;">+${extra} more campaign${extra === 1 ? '' : 's'}</div>` : '';
  return rows + more;
}

function btn(label, href, primary) {
  return primary
    ? `<a href="${esc(href || '#')}" style="display:inline-block;background:${PURPLE};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 18px;border-radius:8px;">${esc(label)}</a>`
    : `<a href="${esc(href || '#')}" style="display:inline-block;color:${PURPLE};text-decoration:underline;font-size:13px;font-weight:600;padding:11px 8px;">${esc(label)}</a>`;
}

/**
 * @param {object} t  templateData
 * @param {{ serviceType?: 'sales'|'service' }} [opts]
 */
function renderDigestHtml(t = {}, opts = {}) {
  const isService = opts.serviceType === 'service';
  const convCall = n(t.conversationsCall), convSms = n(t.conversationsSms), convChat = n(t.conversationsChat);
  const chCall = n(t.channelCall), chSms = n(t.channelSms), chChat = n(t.channelChat);

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F3F4F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0;"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;border:1px solid #E5E7EB;overflow:hidden;">

  <!-- Header -->
  <tr><td style="padding:24px 28px 8px;">
    <table width="100%"><tr>
      <td valign="top">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${PURPLE};font-weight:700;">Vini · Dealer Reporting</div>
        <div style="font-size:24px;font-weight:800;margin-top:4px;">Daily Digest</div>
      </td>
      <td valign="top" align="right">
        <div style="font-size:13px;font-weight:700;">${esc(t.dealershipName)}</div>
        <div style="font-size:12px;color:#6B7280;">${esc(t.reportDate)}</div>
      </td>
    </tr></table>
  </td></tr>

  <!-- Hero KPIs -->
  <tr><td style="padding:8px 22px 0;">
    <table width="100%"><tr>
      ${heroCard('Appointments yesterday', n(t.appointmentsYesterday), '', `<div style="font-size:12px;color:#6B7280;margin-top:6px;">${n(t.appointmentsYesterdayMTD)} month to date</div>`)}
      ${heroCard('Conversations handled', n(t.conversationsHandled), '', channelBar(convCall, convSms, convChat) + legend(convCall, convSms, convChat))}
    </tr></table>
  </td></tr>

  <!-- CTAs -->
  <tr><td style="padding:14px 28px 4px;">
    ${btn('View today’s appointments', t.viewAppointmentsUrl, true)} ${btn('Open conversation inbox', t.openInboxUrl, false)}
  </td></tr>

  ${Array.isArray(t.actionRequiredItems) && t.actionRequiredItems.length ? `
  <tr><td style="padding:4px 28px;">${divider()}
    ${sectionTitle('Action required')}
    <table width="100%">${actionItems(t.actionRequiredItems)}</table>
    <div style="margin-top:12px;">${btn('Review action items', t.reviewActionItemsUrl, true)}</div>
  </td></tr>` : ''}

  <!-- Inbound activity -->
  <tr><td style="padding:4px 22px;">
    <div style="padding:0 6px;">${divider()}${sectionTitle('Inbound activity')}</div>
    <table width="100%"><tr>
      ${miniCard('Appointments', n(t.appointmentsYesterday), `Yesterday · ${n(t.appointmentsYesterdayMTD)} MTD`)}
      ${miniCard('Unique leads', n(t.inboundUniqueLeads), `Yesterday · ${n(t.inboundUniqueLeadsMTD)} MTD`)}
      ${isService ? miniCard('Transfer rate', esc(t.transferRate || '0%'), `${esc(t.transferRateMTD || '0%')} MTD`)
                  : miniCard('Avg response time', esc(t.avgResponseTime || '—'), `${esc(t.avgResponseTimeMTD || '—')} MTD`)}
    </tr></table>

    <div style="padding:0 6px;">
      ${sectionTitle('Channel breakdown')}
      ${channelBar(chCall, chSms, chChat)}${legend(chCall, chSms, chChat)}
      <table width="100%" style="margin-top:14px;"><tr>
        <td valign="top" width="50%">
          <div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">After-hours</div>
          <div style="font-size:13px;margin-top:3px;"><b>${n(t.afterHoursLeadsEngaged)}</b> leads engaged · <b>${n(t.afterHoursApptsBooked)}</b> appts booked</div>
        </td>
        <td valign="top" width="50%">
          <div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">Warm transfers</div>
          <div style="font-size:13px;margin-top:3px;"><b>${n(t.warmTransfers)}</b> · ${n(t.warmTransfersMTD)} MTD</div>
        </td>
      </tr></table>
    </div>
  </td></tr>

  <!-- Outbound activity -->
  <tr><td style="padding:4px 22px;">
    <div style="padding:0 6px;">${divider()}${sectionTitle('Outbound activity')}</div>
    <table width="100%"><tr>
      ${miniCard('Unique reached', n(t.outboundUniqueReached), `${n(t.outboundUniqueReachedMTD)} MTD`)}
      ${miniCard('Connect rate', esc(t.outboundConnectRate || '0%'), `${esc(t.outboundConnectRateMTD || '0%')} MTD`)}
      ${miniCard('Appointments set', n(t.outboundAppointmentsSet), `${n(t.outboundAppointmentsSetMTD)} MTD`)}
    </tr></table>
    ${Array.isArray(t.campaigns) && t.campaigns.length ? `<div style="padding:0 6px;">${sectionTitle('Active campaigns')}${campaigns(t.campaigns, n(t.campaignsExtra))}</div>` : ''}
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:18px 28px 26px;border-top:1px solid #E5E7EB;">
    <table width="100%"><tr>
      <td valign="top" style="font-size:11px;color:#9CA3AF;line-height:1.6;">
        Reporting period: ${esc(t.reportingPeriod)}<br/>Next report: ${esc(t.nextReport)}
      </td>
      <td valign="top" align="right" style="font-size:11px;color:#9CA3AF;">
        <a href="#" style="color:#9CA3AF;">Manage subscription</a><br/>© Vini
      </td>
    </tr></table>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

module.exports = { renderDigestHtml };
