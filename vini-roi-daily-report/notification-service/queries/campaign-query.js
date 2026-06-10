'use strict';

/**
 * Outbound CALLING-CAMPAIGN metrics. For each running campaign we report:
 *   dials  - distinct leads dialed (sales) / reached (service)
 *   appts  - appointments booked off the campaign's outbound calls
 * getSalesActiveCampaigns / getServiceActiveCampaigns list running campaigns;
 * getSalesCampaignStats / getServiceCampaignStats compute dials+appts per id.
 */
const { fmt, meetingsSpyneSourceClause } = require('../utils/common');

/** Shared SQL: appointments booked from a campaign's outbound call ids, in window. */
function campaignApptsBookedSql(serviceType) {
    return `
        WITH campaign_task_calls AS (
            SELECT campaignId, callId
            FROM outboundTasks
            WHERE enterpriseId = {eid:String}
              AND teamId       = {tid:String}
              AND campaignId   IN {ids:Array(String)}
              AND callId       != ''
              AND __deleted    = 0
        )
        SELECT ctc.campaignId, count(DISTINCT m.meeting_id) AS appts
        FROM campaign_task_calls ctc
        INNER JOIN meetings m ON m.call_id = ctc.callId
            AND m.enterprise_id = {eid:String}
            AND m.team_id       = {tid:String}
            AND m.service_type  = {serviceType:String}
            AND ${meetingsSpyneSourceClause('m')}
            AND m.created_at BETWEEN {start:DateTime} AND {end:DateTime}
            AND m.__deleted     = 0
        GROUP BY ctc.campaignId`;
}

const CampaignQuery = {
    async getSalesActiveCampaigns(enterpriseId, teamId) {
        return clickhouse.query(
            `SELECT campaignId, name
             FROM campaigns
             WHERE enterpriseId    = {eid:String}
               AND teamId          = {tid:String}
               AND campaignStatus  = 'running'
               AND campaignType    = 'Sales'
               AND __deleted       = 0
             ORDER BY createdAt DESC`,
            { eid: enterpriseId, tid: teamId },
        );
    },

    async getSalesCampaignStats(enterpriseId, teamId, campaignIds, start, end) {
        if (!campaignIds.length) return [];

        const queryParams = {
            eid: enterpriseId,
            tid: teamId,
            ids: campaignIds,
            start: fmt(start),
            end: fmt(end),
        };

        const [dialsRows, apptsRows] = await Promise.all([
            clickhouse.query(
                `SELECT campaignId, count(DISTINCT leadId) AS dials
                 FROM outboundTasks
                 WHERE enterpriseId = {eid:String}
                   AND teamId       = {tid:String}
                   AND campaignId   IN {ids:Array(String)}
                   AND leadId       != ''
                   AND __deleted    = 0
                 GROUP BY campaignId`,
                queryParams,
            ),

            clickhouse.query(
                campaignApptsBookedSql('sales'),
                { ...queryParams, serviceType: 'sales' },
            ),
        ]);

        const dialsMap = {};
        for (const r of dialsRows) dialsMap[r.campaignId] = parseInt(r.dials, 10);
        const apptsMap = {};
        for (const r of apptsRows) apptsMap[r.campaignId] = parseInt(r.appts, 10);

        return campaignIds.map(id => ({
            campaignId: id,
            dials:      dialsMap[id] ?? 0,
            appts:      apptsMap[id] ?? 0,
        }));
    },

    async getServiceActiveCampaigns(enterpriseId, teamId) {
        return clickhouse.query(
            `SELECT campaignId, name
             FROM campaigns
             WHERE enterpriseId    = {eid:String}
               AND teamId          = {tid:String}
               AND campaignStatus  = 'running'
               AND campaignType    = 'Service'
               AND __deleted       = 0
             ORDER BY createdAt DESC`,
            { eid: enterpriseId, tid: teamId },
        );
    },

    async getServiceCampaignStats(enterpriseId, teamId, campaignIds, start, end) {
        if (!campaignIds.length) return [];

        const queryParams = {
            eid: enterpriseId,
            tid: teamId,
            ids: campaignIds,
            start: fmt(start),
            end: fmt(end),
        };

        const [leadsReachedRows, apptsRows] = await Promise.all([
            clickhouse.query(
                `SELECT campaignId, count(DISTINCT leadId) AS leadsReachedDuringCampaign
                 FROM outboundTasks
                 WHERE enterpriseId = {eid:String}
                   AND teamId       = {tid:String}
                   AND campaignId   IN {ids:Array(String)}
                   AND leadId       != ''
                   AND __deleted    = 0
                 GROUP BY campaignId`,
                queryParams,
            ),

            clickhouse.query(
                campaignApptsBookedSql('service'),
                { ...queryParams, serviceType: 'service' },
            ),
        ]);

        const leadsReachedMap = {};
        for (const r of leadsReachedRows) {
            leadsReachedMap[r.campaignId] = parseInt(r.leadsReachedDuringCampaign, 10);
        }
        const apptsMap = {};
        for (const r of apptsRows) apptsMap[r.campaignId] = parseInt(r.appts, 10);

        return campaignIds.map(id => ({
            campaignId:                 id,
            leadsReachedDuringCampaign: leadsReachedMap[id] ?? 0,
            appts:                      apptsMap[id] ?? 0,
        }));
    },
};

module.exports = CampaignQuery;
