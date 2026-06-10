'use strict';

const {
    pct,
    msToSec,
    mtdDelta,
    toDateLabel,
    toPeriodLabel,
    formatActionItemIntent,
} = require('../utils/common');

/**
 * Assembles the full templateData payload from raw query results.
 *
 * @param {object} params
 * @param {object}   params.dealerDetails             - Mongoose dealerDetails document
 * @param {Date}     params.yesterdayDate              - Start of yesterday (for labels + URL filters)
 * @param {Date}     params.yesterdayDateEnd           - End of yesterday (digest createdAt window)
 * @param {number}   params.allApptsYesterday
 * @param {number}   params.allAptsMtd
 * @param {number}   params.inboundApptsYesterday
 * @param {number}   params.inboundAptsMtd
 * @param {number}   params.outboundApptsYesterday
 * @param {number}   params.outboundAptsMtd
 * @param {number}   params.inboundUniqueLeadsYesterday
 * @param {number}   params.inboundUniqueLeadsMtd
 * @param {{ totalCalls: number, uniqueReached: number }} params.outboundStatsYesterday
 * @param {{ totalCalls: number, uniqueReached: number }} params.outboundStatsMtd
 * @param {Array<{ intent: string, cnt: number }>}  params.actionItems
 * @param {Array<{ name: string, dials: number, appts: number }>} params.campaigns
 * @param {{ call: number, sms: number, chat: number, total: number }} params.conversationsYesterday
 * @param {{ call: number, sms: number, chat: number, total: number }} params.inboundConversationsYesterday
 * @param {number}   params.transferCountYesterday
 * @param {number}   params.transferCountMtd
 * @param {number}   params.avgFirstContactMsYesterday
 * @param {number}   params.avgFirstContactMsMtd
 * @returns {object} templateData
 */
function buildTemplateData({
    dealerDetails,
    teamName,
    dealerTz,
    enterpriseId,
    teamId,
    serviceType,
    yesterdayDate,
    yesterdayDateEnd,
    allApptsYesterday,
    allAptsMtd,
    inboundApptsYesterday,
    inboundAptsMtd,
    outboundApptsYesterday,
    outboundAptsMtd,
    inboundUniqueLeadsYesterday,
    inboundUniqueLeadsMtd,
    outboundStatsYesterday,
    outboundStatsMtd,
    actionItems,
    campaigns,
    campaignsExtra,
    conversationsYesterday,
    inboundConversationsYesterday,
    transferStatsYesterday,
    transferStatsMtd,
    warmTransfersYesterday,
    warmTransfersMtd,
    avgFirstContactMsYesterday,
    avgFirstContactMsMtd,
    afterHoursLeadsEngaged,
    afterHoursApptsBooked,
    // topVehicles,
}) {
    // Mail API validates required keys on JSON; axios drops keys whose values are undefined.
    const conv                  = conversationsYesterday ?? { call: 0, sms: 0, chat: 0, total: 0 };
    const inboundConv           = inboundConversationsYesterday ?? { call: 0, sms: 0, chat: 0, total: 0 };
    const obY                   = outboundStatsYesterday    ?? { totalCalls: 0, uniqueReached: 0 };
    const obM                   = outboundStatsMtd         ?? { totalCalls: 0, uniqueReached: 0 };
    const txY                   = transferStatsYesterday   ?? { transferCount: 0, totalCalls: 0 };
    const txM                   = transferStatsMtd        ?? { transferCount: 0, totalCalls: 0 };
    const items                 = Array.isArray(actionItems) ? actionItems : [];
    const camps                 = Array.isArray(campaigns) ? campaigns : [];

    const totalApptsYesterday   = allApptsYesterday       ?? 0;
    const totalAptsMtd          = allAptsMtd              ?? 0;
    const inboundIn             = inboundApptsYesterday    ?? 0;
    const inboundInMtd          = inboundAptsMtd          ?? 0;
    const outboundApptsY        = outboundApptsYesterday   ?? 0;
    const outboundApptsM        = outboundAptsMtd         ?? 0;
    const inboundLeadsY         = inboundUniqueLeadsYesterday ?? 0;
    const inboundLeadsM         = inboundUniqueLeadsMtd       ?? 0;
    const warmY                 = warmTransfersYesterday ?? 0;
    const warmM                 = warmTransfersMtd       ?? 0;
    const afterHoursLeads       = afterHoursLeadsEngaged ?? 0;
    const afterHoursAppts       = afterHoursApptsBooked ?? 0;
    const totalConvs            = conv.total ?? 0;

    const nextReportDate = new Date(yesterdayDate);
    nextReportDate.setUTCDate(nextReportDate.getUTCDate() + 1);

    const createdAtStart = encodeURIComponent(yesterdayDate.toISOString());
    const createdAtEnd   = encodeURIComponent(
        (yesterdayDateEnd || yesterdayDate).toISOString(),
    );
    const digestDateRange = `&createdAtStart=${createdAtStart}&createdAtEnd=${createdAtEnd}`;
    const appointmentsDateRange =
        `&all_createdAtStart=${createdAtStart}`
        + `&all_createdAtEnd=${createdAtEnd}`
        + '&all_createdAtDateValue=yesterday';

    return {
        // ── Dealership & report meta 
        dealershipName:   teamName || '',
        reportDate:       toDateLabel(yesterdayDate, dealerTz),
        reportingPeriod:  toPeriodLabel(yesterdayDate, dealerTz),
        nextReport:       `${toPeriodLabel(nextReportDate, dealerTz)} · 7:00 AM PT`,
        // ── Action items
        actionRequiredItems: items.map(item => ({
            count: Number.parseInt(item.cnt, 10) || 0,
            label: formatActionItemIntent(item.intent),
        })),
        // ── Appointments 
        appointmentsYesterday:    totalApptsYesterday,
        appointmentsYesterdayMTD: totalAptsMtd,
        inboundAppointments:      inboundIn,
        inboundAppointmentsMTD:   inboundInMtd,
        // ── Inbound unique leads
        inboundUniqueLeads:    inboundLeadsY,
        inboundUniqueLeadsMTD: inboundLeadsM,
        // ── Conversations
        conversationsHandled: totalConvs,
        conversationsCall:    conv.call ?? 0,
        conversationsSms:     conv.sms  ?? 0,
        conversationsChat:    conv.chat ?? 0,
        channelCall:          inboundConv.call ?? 0,
        channelSms:           inboundConv.sms  ?? 0,
        channelChat:          inboundConv.chat ?? 0,
        // ── Transfers
        transferCount:    txY.transferCount ?? 0,
        warmTransfers:    warmY,
        warmTransfersMTD: warmM,
        transferRate:     pct(txY.transferCount ?? 0, txY.totalCalls ?? 0),
        transferRateMTD:  pct(txM.transferCount ?? 0, txM.totalCalls ?? 0),
        // ── Outbound
        outboundUniqueReached:    obY.uniqueReached ?? 0,
        outboundUniqueReachedMTD: obM.uniqueReached ?? 0,
        outboundConnectRate:      pct(
            serviceType === 'sales' ? (obY.connectedCalls ?? obY.uniqueReached ?? 0) : (obY.uniqueReached ?? 0),
            obY.totalCalls ?? 0,
        ),
        outboundConnectRateMTD:   pct(
            serviceType === 'sales' ? (obM.connectedCalls ?? obM.uniqueReached ?? 0) : (obM.uniqueReached ?? 0),
            obM.totalCalls ?? 0,
        ),
        outboundAppointmentsSet:    outboundApptsY,
        outboundAppointmentsSetMTD: outboundApptsM,
        // ── Campaigns
        campaigns: camps.map(c => {
            const dials = c.dials ?? c.leadsReachedDuringCampaign ?? 0;
            const appts = c.appts ?? 0;
            return {
                name:       c.name ?? '',
                status:     'active',
                dials,
                appts,
                conversion: pct(appts, dials),
            };
        }),
        campaignsExtra: campaignsExtra || 0,
        // ── Hardcoded / deferred values 
        avgResponseTime:       msToSec(avgFirstContactMsYesterday),
        avgResponseTimeMTD:    msToSec(avgFirstContactMsMtd),
        afterHoursApptsBooked: afterHoursAppts,
        afterHoursLeadsEngaged: afterHoursLeads,
        // ── URLs
        openInboxUrl:         `https://console.spyne.ai/converse-ai/conversations?enterprise_id=${enterpriseId}&team_id=${teamId}&serviceType=${serviceType}`,
        reviewActionItemsUrl: `https://console.spyne.ai/converse-ai/action-items?enterprise_id=${enterpriseId}&team_id=${teamId}&serviceType=${serviceType}${digestDateRange}`,
        viewAppointmentsUrl:  `https://console.spyne.ai/converse-ai/appointments?enterprise_id=${enterpriseId}&team_id=${teamId}${appointmentsDateRange}&page=1&serviceType=${serviceType}&tab=all`,
    };
}

/**
 * Assembles the service digest templateData payload.
 * Matches Vini-Email/Inbound/Daily-Digest/email-service-daily required keys
 * (see send-template-email contract): no sales-only fields, no manageSubscriptionUrl.
 */
function buildServiceTemplateData(params) {
    const base = buildTemplateData(params);
    const { dealerTz, yesterdayDate } = params;

    const reportDateShort = toPeriodLabel(yesterdayDate, dealerTz);
    const reportingPeriod = `${reportDateShort} (12:00 AM – 11:59 PM)`;

    const actionRequiredItems = base.actionRequiredItems.map(item => ({
        count: item.count,
        label: item.label,
        tag: item.tag || '',
    }));

    return {
        actionRequiredItems,
        afterHoursApptsBooked:      base.afterHoursApptsBooked,
        afterHoursLeadsEngaged:     base.afterHoursLeadsEngaged,
        appointmentsYesterday:      base.appointmentsYesterday,
        appointmentsYesterdayMTD:   base.appointmentsYesterdayMTD,
        campaigns: base.campaigns.map(c => ({
            name:       c.name,
            status:     String(c.status || 'active').toLowerCase(),
            dials:      c.dials,
            appts:      c.appts,
            conversion: c.conversion,
        })),
        campaignsExtra:             base.campaignsExtra,
        conversationsCall:          base.conversationsCall,
        conversationsChat:          base.conversationsChat,
        conversationsHandled:       base.conversationsHandled,
        conversationsSms:            base.conversationsSms,
        dealershipName:             base.dealershipName,
        inboundAppointments:        base.inboundAppointments,
        inboundAppointmentsMTD:      base.inboundAppointmentsMTD,
        inboundUniqueLeads:         base.inboundUniqueLeads,
        inboundUniqueLeadsMTD:      base.inboundUniqueLeadsMTD,
        nextReport:                 'Tomorrow 7:00 AM',
        openInboxUrl:               base.openInboxUrl,
        outboundAppointmentsSet:    base.outboundAppointmentsSet,
        outboundAppointmentsSetMTD: base.outboundAppointmentsSetMTD,
        outboundConnectRate:        base.outboundConnectRate,
        outboundConnectRateMTD:     base.outboundConnectRateMTD,
        outboundUniqueReached:      base.outboundUniqueReached,
        outboundUniqueReachedMTD:   base.outboundUniqueReachedMTD,
        reportDate:                 reportDateShort,
        reportingPeriod,
        reviewActionItemsUrl:       base.reviewActionItemsUrl,
        transferCount:              base.transferCount,
        transferRate:               base.transferRate,
        transferRateMTD:            base.transferRateMTD,
        viewAppointmentsUrl:        base.viewAppointmentsUrl,
        warmTransfers:              base.warmTransfers,
        warmTransfersMTD:           base.warmTransfersMTD,
    };
}

module.exports = { buildTemplateData, buildServiceTemplateData };
