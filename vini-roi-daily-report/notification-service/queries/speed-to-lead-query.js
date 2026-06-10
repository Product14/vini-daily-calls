'use strict';

/**
 * "Speed to lead" — how fast we first replied to a new lead. Per lead we take
 * (first SMS conversation time − lead created time), then average across leads
 * in the window. Returned in milliseconds; the template formats it via msToSec.
 */
const { fmt } = require('../utils/common');

const SpeedToLeadQuery = {

    /**
     * @param {string} serviceType - leads.service_type filter ('sales' | 'service')
     * @returns {Promise<number>} avg delta in ms; 0 when no qualifying leads
     */
    async computeAvgFirstContactMs(enterpriseId, teamId, start, end, serviceType = 'sales') {
        const rows = await clickhouse.query(
            `SELECT round(avg(delta_ms)) AS avg_ms
             FROM (
                 SELECT
                     l.lead_id,
                     (toUnixTimestamp(min(c.createdAt)) - toUnixTimestamp(l.created_at)) * 1000 AS delta_ms
                 FROM leads l
                 INNER JOIN conversations c ON c.leadId = l.lead_id
                     AND c.enterpriseId = {eid:String}
                     AND c.teamId       = {tid:String}
                     AND c.type         = 'sms'
                     AND ifNull(c.campaignId, '') = ''
                     AND ifNull(c.isTest, 0) = 0
                     AND c.createdAt    BETWEEN {start:DateTime} AND {end:DateTime}
                     AND c.__deleted    = 0
                 WHERE l.enterprise_id = {eid:String}
                   AND l.team_id       = {tid:String}
                   AND l.lead_id       != ''
                   AND l.service_type  = {serviceType:String}
                   AND l.created_at    BETWEEN {start:DateTime} AND {end:DateTime}
                   AND l.__deleted     = 0
                 GROUP BY l.lead_id, l.created_at
                 HAVING delta_ms >= 0
             )`,
            {
                eid: enterpriseId,
                tid: teamId,
                serviceType,
                start: fmt(start),
                end: fmt(end),
            },
        );

        return parseInt(rows[0]?.avg_ms ?? 0, 10);
    },
};

module.exports = SpeedToLeadQuery;
