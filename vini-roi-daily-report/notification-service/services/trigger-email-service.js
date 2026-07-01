'use strict';

const Q      = require('../queries/sales-inbound-outbound.query');
const SQ     = require('../queries/service-inbound-outbound.query');
const S2L    = require('../queries/speed-to-lead-query');
const CQ     = require('../queries/campaign-query');
const { buildTemplateData, buildServiceTemplateData } = require('./template-service');
const { getTimeWindows } = require('../utils/common');
const {
    getDealerConfig,
    getDigestEmailRecipients,
    getLocalMinutesSinceMidnight,
    getLocalDateKey,
    resolveAfterHoursConfig,
    isDailyDigestEnabled,
} = require('../utils/guards');
const RooftopConfigQuery = require('../queries/rooftop-config.query');
const { validateDigestPayload } = require('../utils/guardrails');
const { renderDigestHtml } = require('./html-render.service');
const MailSend = require('./mail-send.service');
const DigestStore = require('./digest-store.service');
const { REASONS } = DigestStore;

const DEFAULT_SEND_MINUTES = 7 * 60; // fallback when no per-rooftop config (req 2)

const EMAIL_TEMPLATE_SALES   = 'Vini-Email/Inbound/Daily-Digest/email-sales-daily';
const EMAIL_TEMPLATE_SERVICE = 'Vini-Email/Inbound/Daily-Digest/email-service-daily';

/** Only true when cron should suppress duplicate sends before the next local day */
function bypassScheduleFlag(options = {}) {
    return options.bypassDigestSchedule === true;
}

function normalizeEmailList(value) {
    if (!value) return [];
    const arr = Array.isArray(value) ? value : [value];
    return [...new Set(arr.map(v => String(v || '').trim()).filter(Boolean))];
}

function serializeToHeader(toEmails) {
    // mail-service expects `to` as a string, not an array
    return normalizeEmailList(toEmails).join(',');
}

/* ============================================================
   Per-department adapter — the only difference between the
   sales and service digests. Query objects are stateless, so
   passing bare method references is safe.
   ============================================================ */
const SALES_ADAPTER = {
    department: 'sales',
    template: EMAIL_TEMPLATE_SALES,
    build: buildTemplateData,
    subject: name => `Sales Daily Digest - ${name}`,
    inboundUniqueLeads:        Q.countInboundUniqueLeads,
    allAppts:                  Q.countAllSalesAppointments,
    inboundAppts:              Q.countInboundSalesAppointments,
    outboundStats:             Q.getOutboundCallStats,
    outboundAppts:             Q.countOutboundSalesAppointments,
    assistedAppts:             Q.countAssistedSalesAppointments, // canonical: AI-assisted (CRM), secondary
    actionItems:               Q.getActionItems,
    conversationCounts:        Q.getConversationCounts,
    inboundConversationCounts: Q.getInboundConversationCounts,
    transferStats:             Q.getSalesTransferStats,
    warmTransfers:             Q.countWarmTransfers,
    afterHoursLeads:           Q.countAfterHoursLeads,
    afterHoursAppts:           Q.countAfterHoursAppointments,
    activeCampaigns:           CQ.getSalesActiveCampaigns,
    campaignStats:             CQ.getSalesCampaignStats,
};

const SERVICE_ADAPTER = {
    department: 'service',
    template: EMAIL_TEMPLATE_SERVICE,
    build: buildServiceTemplateData,
    subject: name => `Service Daily Digest - ${name}`,
    inboundUniqueLeads:        SQ.countInboundUniqueLeads,
    allAppts:                  SQ.countAllServiceAppointments,
    inboundAppts:              SQ.countInboundServiceAppointments,
    outboundStats:             SQ.getServiceOutboundCallStats,
    outboundAppts:             SQ.countOutboundServiceAppointments,
    actionItems:               Q.getActionItems, // shared actionItems table
    conversationCounts:        SQ.getConversationCounts,
    inboundConversationCounts: SQ.getInboundConversationCounts,
    transferStats:             SQ.getServiceTransferStats,
    warmTransfers:             SQ.countWarmTransfers,
    afterHoursLeads:           SQ.countAfterHoursLeads,
    afterHoursAppts:           SQ.countAfterHoursAppointments,
    activeCampaigns:           CQ.getServiceActiveCampaigns,
    campaignStats:             CQ.getServiceCampaignStats,
};

/** dials shape differs: sales `dials`, service `leadsReachedDuringCampaign`. */
function campaignDials(stat) {
    return stat?.dials ?? stat?.leadsReachedDuringCampaign ?? 0;
}

/* ============================================================
   Shared digest core
   ============================================================ */
async function runDigest(adapter, enterpriseId, teamId, options = {}) {
    const department = adapter.department;
    const cadence = 'daily';
    const LOG = `[${department === 'sales' ? 'DailyDigest' : 'ServiceDigest'}]`;
    const cronSchedule = !bypassScheduleFlag(options);
    const trigger = cronSchedule ? 'cron' : 'manual';

    // mutable context filled in as we learn dealer tz / local day
    const ctx = { dealerTz: null, localDate: null };

    // record every decision to Supabase (req 1 & 5) — never throws
    const recordRun = (status, reason, extra = {}) =>
        DigestStore.recordDigestRun({
            enterpriseId, teamId, department, cadence,
            localDate: ctx.localDate || getLocalDateKey(new Date(), ctx.dealerTz || 'UTC'),
            dealerTimezone: ctx.dealerTz,
            status, reason, trigger,
            ...extra,
        });

    // ── Gate 1: digest enabled for the team ───────────────────────────────────
    if (!(await isDailyDigestEnabled(enterpriseId, teamId))) {
        await recordRun('not_sent', REASONS.NOT_ELIGIBLE, {
            reasonDetail: 'daily digest not enabled for this team',
        });
        return { sent: false, reason: 'daily digest not enabled for this team' };
    }

    // ── 0. Dealer details (best-effort) ───────────────────────────────────────
    let dealer = null;
    try {
        dealer = await dealerDetails.findOne({ enterprise_id: enterpriseId, team_id: teamId }).lean();
    } catch (err) {
        sails.log.warn(`${LOG} dealerDetails lookup failed (${err.message}). Proceeding with stub.`);
    }

    // ── 1a. Timezone + team name ──────────────────────────────────────────────
    const { teamName, dealerTz, workingDaysData } = await getDealerConfig(enterpriseId, teamId);
    ctx.dealerTz = dealerTz;
    sails.log.info(`${LOG} timezone: ${dealerTz} | team: ${teamName}`);

    // ── 1b. Per-rooftop send hour (req 2) ─────────────────────────────────────
    let sendMinutes = DEFAULT_SEND_MINUTES;
    try {
        const cfg = await RooftopConfigQuery.getRooftopConfig(teamId);
        sendMinutes = cfg.sendMinutesSinceMidnight;
    } catch (err) {
        sails.log.warn(`${LOG} rooftop config unavailable (${err.message}) — defaulting to 7:00 local.`);
    }

    if (cronSchedule) {
        const now = new Date();
        ctx.localDate = getLocalDateKey(now, dealerTz);

        const localMinuteOfDay = getLocalMinutesSinceMidnight(now, dealerTz);
        if (localMinuteOfDay < sendMinutes) {
            await recordRun('scheduled', REASONS.BEFORE_SEND_HOUR, {
                reasonDetail: `before ${Math.floor(sendMinutes / 60)}:${String(sendMinutes % 60).padStart(2, '0')} local (${dealerTz})`,
            });
            return { sent: false, reason: 'before configured local send time' };
        }

        // Supabase-native dedup (no Mongo) — already sent this local day?
        const already = await DigestStore.alreadySentToday({
            teamId, department, cadence, localDate: ctx.localDate,
        });
        if (already) {
            return { sent: false, reason: `already sent for local day ${ctx.localDate}` };
        }
    }

    // ── Recipients + department routing (req 3) ───────────────────────────────
    const baseEmails = cronSchedule
        ? await getDigestEmailRecipients(enterpriseId, teamId)
        : normalizeEmailList(options?.to);

    let toEmails = baseEmails;
    try {
        const subs = await RooftopConfigQuery.getRecipientDeptSubscriptions(teamId);
        toEmails = RooftopConfigQuery.filterEmailsByDept(baseEmails, subs, department);
    } catch (err) {
        sails.log.warn(`${LOG} recipient dept-subscription lookup failed (${err.message}) — using unfiltered recipients.`);
    }

    if (!toEmails.length) {
        const reason = baseEmails.length ? REASONS.NOT_SUBSCRIBED : REASONS.RECIPIENTS_MISSING;
        await recordRun('not_sent', reason, {
            reasonDetail: baseEmails.length
                ? `${baseEmails.length} recipient(s) but none subscribed to ${department}`
                : 'no recipients configured',
        });
        return { sent: false, reason: reason === REASONS.NOT_SUBSCRIBED ? 'no recipients subscribed to this department' : 'no recipients' };
    }

    // ── Time windows + after-hours ────────────────────────────────────────────
    const { yesterday, mtd } = getTimeWindows(dealerTz);
    const { start: yStart, end: yEnd } = yesterday;
    const { start: mStart, end: mEnd } = mtd;
    const afterHoursCfg = resolveAfterHoursConfig(workingDaysData, yStart, dealerTz);

    // ── Step 1: parallel ClickHouse ───────────────────────────────────────────
    const [
        inboundUniqueLeadsYesterday, inboundUniqueLeadsMtd,
        allApptsYesterday, allAptsMtd,
        inboundApptsYesterday, inboundAptsMtd,
        outboundStatsYesterday, outboundStatsMtd,
        outboundApptsYesterday, outboundAptsMtd,
        assistedApptsYesterday, assistedApptsMtd,
        actionItems, activeCampaigns,
        conversationsYesterday, inboundConversationsYesterday,
        transferStatsYesterday, transferStatsMtd,
        warmTransfersYesterday, warmTransfersMtd,
        avgFirstContactMsYesterday, avgFirstContactMsMtd,
        afterHoursLeadsEngaged, afterHoursApptsBooked,
    ] = await Promise.all([
        adapter.inboundUniqueLeads(enterpriseId, teamId, yStart, yEnd),
        adapter.inboundUniqueLeads(enterpriseId, teamId, mStart, mEnd),
        adapter.allAppts(enterpriseId, teamId, yStart, yEnd),
        adapter.allAppts(enterpriseId, teamId, mStart, mEnd),
        adapter.inboundAppts(enterpriseId, teamId, yStart, yEnd),
        adapter.inboundAppts(enterpriseId, teamId, mStart, mEnd),
        adapter.outboundStats(enterpriseId, teamId, yStart, yEnd),
        adapter.outboundStats(enterpriseId, teamId, mStart, mEnd),
        adapter.outboundAppts(enterpriseId, teamId, yStart, yEnd),
        adapter.outboundAppts(enterpriseId, teamId, mStart, mEnd),
        // canonical: AI-assisted (CRM) appts — secondary metric (sales only; service adapter has no method → 0)
        adapter.assistedAppts ? adapter.assistedAppts(enterpriseId, teamId, yStart, yEnd) : Promise.resolve(0),
        adapter.assistedAppts ? adapter.assistedAppts(enterpriseId, teamId, mStart, mEnd) : Promise.resolve(0),
        adapter.actionItems(enterpriseId, teamId, yStart, yEnd, department),
        adapter.activeCampaigns(enterpriseId, teamId),
        adapter.conversationCounts(enterpriseId, teamId, yStart, yEnd),
        adapter.inboundConversationCounts(enterpriseId, teamId, yStart, yEnd),
        adapter.transferStats(enterpriseId, teamId, yStart, yEnd),
        adapter.transferStats(enterpriseId, teamId, mStart, mEnd),
        adapter.warmTransfers(enterpriseId, teamId, yStart, yEnd),
        adapter.warmTransfers(enterpriseId, teamId, mStart, mEnd),
        S2L.computeAvgFirstContactMs(enterpriseId, teamId, yStart, yEnd, department),
        S2L.computeAvgFirstContactMs(enterpriseId, teamId, mStart, mEnd, department),
        adapter.afterHoursLeads(enterpriseId, teamId, yStart, yEnd, afterHoursCfg),
        adapter.afterHoursAppts(enterpriseId, teamId, yStart, yEnd, afterHoursCfg),
    ]);

    // ── Step 2: campaign stats ────────────────────────────────────────────────
    let campaigns = [];
    let campaignsExtra = 0;
    if (activeCampaigns.length) {
        const campaignIds = activeCampaigns.map(c => c.campaignId);
        const stats = await adapter.campaignStats(enterpriseId, teamId, campaignIds, yStart, yEnd);
        const statsMap = {};
        for (const s of stats) statsMap[s.campaignId] = s;
        const allCampaigns = activeCampaigns.map(c => ({
            name:  c.name,
            dials: campaignDials(statsMap[c.campaignId]),
            appts: statsMap[c.campaignId]?.appts ?? 0,
        }));
        campaigns = allCampaigns.slice(0, 3);
        campaignsExtra = Math.max(0, allCampaigns.length - 3);
    }

    // ── Build payload ─────────────────────────────────────────────────────────
    const templateData = adapter.build({
        dealerDetails: dealer, teamName, dealerTz, enterpriseId, teamId,
        serviceType: department,
        yesterdayDate: yStart, yesterdayDateEnd: yEnd,
        allApptsYesterday, allAptsMtd,
        inboundApptsYesterday, inboundAptsMtd,
        outboundApptsYesterday, outboundAptsMtd,
        assistedApptsYesterday, assistedApptsMtd, // canonical: AI-assisted (CRM), secondary
        inboundUniqueLeadsYesterday, inboundUniqueLeadsMtd,
        outboundStatsYesterday, outboundStatsMtd,
        actionItems, campaigns, campaignsExtra,
        conversationsYesterday, inboundConversationsYesterday,
        transferStatsYesterday, transferStatsMtd,
        warmTransfersYesterday, warmTransfersMtd,
        avgFirstContactMsYesterday, avgFirstContactMsMtd,
        afterHoursLeadsEngaged, afterHoursApptsBooked,
    });

    // render once — stored on the run regardless of send path / outcome (req 5)
    const renderedHtml = renderDigestHtml(templateData, { serviceType: department });
    const subject = adapter.subject(teamName || enterpriseId);

    // ── Guardrails post step 1 & 2 (req 4) ────────────────────────────────────
    const guard = validateDigestPayload(templateData, {
        allApptsYesterday, conversationsTotal: conversationsYesterday?.total,
    });
    if (!guard.ok) {
        sails.log.info(`${LOG} guardrail blocked (${guard.reason}) for ${enterpriseId}/${teamId}.`);
        await recordRun('not_sent', guard.reason, {
            reasonDetail: JSON.stringify(guard.failures).slice(0, 1000),
            metrics: templateData, renderedHtml, subject, mailTemplate: adapter.template,
        });
        return { sent: false, reason: `guardrail: ${guard.reason}` };
    }

    // ── DRY RUN GUARD — hard stop before any mail is sent ─────────────────────
    // When sails.config.custom.dryRun === true (or options.dryRun), the full
    // pipeline runs (queries, guardrails, render, record) but NO email is sent.
    // The run is logged as 'suppressed' with reason 'dry_run' and the rendered
    // HTML is stored so it can be reviewed in the tracker. Flip dryRun to false
    // only when you are ready to actually deliver email.
    const dryRun = sails.config.custom?.dryRun === true || options.dryRun === true;
    const recipientRows = toEmails.map(email => ({ email, received: !dryRun }));
    if (dryRun) {
        sails.log.warn(`${LOG} DRY RUN — not sending. Would send to ${toEmails.join(', ')} (${enterpriseId}/${teamId}).`);
        await recordRun('suppressed', 'dry_run', {
            reasonDetail: `DRY RUN — email NOT sent. Would have gone to: ${toEmails.join(', ')}`,
            metrics: templateData, renderedHtml, subject, mailTemplate: adapter.template,
            recipients: recipientRows,
        });
        return { sent: false, reason: 'dry_run', wouldSendTo: toEmails };
    }

    // ── Send (req 6: template OR raw-html path) ───────────────────────────────
    const useRaw = MailSend.useDirectHtml();
    try {
        const { messageId } = useRaw
            ? await MailSend.sendRawHtmlEmail({ to: serializeToHeader(toEmails), subject, html: renderedHtml })
            : await MailSend.sendTemplateEmail({ to: serializeToHeader(toEmails), subject, template: adapter.template, templateData });

        sails.log.info(`${LOG} sent → ${toEmails.join(', ')} (${enterpriseId}/${teamId})`);

        await recordRun('sent', null, {
            metrics: templateData, renderedHtml, subject,
            mailTemplate: useRaw ? null : adapter.template,
            recipients: recipientRows, sendPath: useRaw ? 'raw_html' : 'template',
            messageId, sentAt: new Date(),
        });

        // Tracking is self-contained: the recordRun('sent') above (roi_digest_runs)
        // is the single source of truth + dedup key. No Mongo write.
        return { sent: true, recipients: toEmails };
    } catch (err) {
        const timeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
        const reason = timeout ? REASONS.SMTP_TIMEOUT : REASONS.MAIL_ERROR;
        const mailError = err.response?.data || err.message;
        sails.log.error(`${LOG} mail error (${enterpriseId}/${teamId}):`, mailError);
        await recordRun('not_sent', reason, {
            reasonDetail: typeof mailError === 'string' ? mailError : JSON.stringify(mailError).slice(0, 1000),
            metrics: templateData, renderedHtml, subject, recipients: recipientRows,
        });
        throw new Error(`Mail send failed: ${JSON.stringify(mailError)}`);
    }
}

/* ============================================================
   Public API — preserved signatures
   ============================================================ */
async function triggerDailyDigestEmail(enterpriseId, teamId, options = {}) {
    return runDigest(SALES_ADAPTER, enterpriseId, teamId, options);
}

async function triggerServiceDailyDigestEmail(enterpriseId, teamId, options = {}) {
    return runDigest(SERVICE_ADAPTER, enterpriseId, teamId, options);
}

module.exports = { triggerDailyDigestEmail, triggerServiceDailyDigestEmail };
