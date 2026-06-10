'use strict';

const {
    fmt,
    parseConversationCountRows,
    meetingsSpyneSourceClause,
    conversationInboundWhereClause,
} = require('../utils/common');

/**
 * SALES ClickHouse metrics. Every method takes (enterpriseId, teamId, start, end)
 * and returns a number or small object. `start`/`end` are the dealer-local
 * "yesterday" or "month-to-date" window (see utils/common getTimeWindows).
 * Full KPI ↔ query reference: docs/daily-digest-kpi-queries.md.
 *
 *   countInboundUniqueLeads      - distinct leads who called IN (sales agent)
 *   countAllSalesAppointments    - all sales appointments booked
 *   countInboundSalesAppointments- appointments tied to an inbound call
 *   getOutboundCallStats         - {totalCalls, uniqueReached, connectedCalls}
 *   countOutboundSalesAppointments- appointments tied to an outbound call
 *   getActionItems               - open action items grouped by intent
 *   getConversationCounts        - all convos by channel {call,sms,chat,total}
 *   getInboundConversationCounts - inbound-only convos by channel
 *   getSalesTransferStats        - {totalCalls, transferCount}
 *   countWarmTransfers           - warm transfer events
 *   countAfterHoursLeads/Appointments - activity outside working hours
 *   getTopVehicles               - most-asked-about vehicles (not currently wired)
 */
const SalesInboundQuery = {
    async countInboundUniqueLeads(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count(DISTINCT leadId) AS cnt
             FROM endcallreports
             WHERE enterpriseId = {eid:String}
               AND teamId       = {tid:String}
               AND isActive     = 1
               AND isTestCall   = 0
               AND lower(callDetails_agentInfo_agentType) = 'sales'
               AND callDetails_callType = 'inboundPhoneCall'
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted    = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },
    async countAllSalesAppointments(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS cnt
             FROM meetings
             WHERE enterprise_id    = {eid:String}
               AND team_id          = {tid:String}
               AND service_type     = 'sales'
               AND ${meetingsSpyneSourceClause()}
               AND created_at BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted        = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },
    async countInboundSalesAppointments(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS cnt
             FROM meetings m
             WHERE m.enterprise_id = {eid:String}
               AND m.team_id       = {tid:String}
               AND m.service_type  = 'sales'
               AND ${meetingsSpyneSourceClause('m')}
               AND m.created_at BETWEEN {start:DateTime} AND {end:DateTime}
               AND m.__deleted     = 0
               AND m.lead_id != ''
               AND m.call_id != ''
               AND EXISTS (
                   SELECT 1
                   FROM endcallreports e
                   WHERE e.callId = m.call_id
                     AND e.enterpriseId = {eid:String}
                     AND e.teamId       = {tid:String}
                     AND e.isActive     = 1
                     AND e.isTestCall   = 0
                     AND lower(e.callDetails_agentInfo_agentType) = 'sales'
                     AND e.callDetails_callType = 'inboundPhoneCall'
                     AND e.createdAt BETWEEN {start:DateTime} AND {end:DateTime}
                     AND e.__deleted    = 0
               )`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },

    async getOutboundCallStats(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS totalCalls,
                    count(DISTINCT leadId) AS uniqueReached,
                    countIf(callDetails_endedReason IN (
                        'customer-ended-call',
                        'voicemail',
                        'assistant-forwarded-call',
                        'assistant-ended-call-after-message-spoken',
                        'silence-timed-out',
                        'customer-ended-call-before-warm-transfer',
                        'assistant-ended-call',
                        'customer_hangup',
                        'call.in-progress.twilio-completed-call',
                        'customer-ended-call-after-warm-transfer-attempt',
                        'assistant_ended',
                        'exceeded-max-duration',
                        'transferred',
                        'silence_timeout'
                    )) AS connectedCalls
             FROM endcallreports
             WHERE enterpriseId = {eid:String}
               AND teamId       = {tid:String}
               AND isActive     = 1
               AND isTestCall   = 0
               AND callDetails_callType = 'outboundPhoneCall'
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted    = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        const row = rows[0] ?? {};
        return {
            totalCalls:    parseInt(row.totalCalls    ?? 0, 10),
            uniqueReached: parseInt(row.uniqueReached ?? 0, 10),
            connectedCalls: parseInt(row.connectedCalls ?? 0, 10),
        };
    },

    async countOutboundSalesAppointments(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS cnt
             FROM meetings m
             WHERE m.enterprise_id = {eid:String}
               AND m.team_id       = {tid:String}
               AND m.service_type  = 'sales'
               AND ${meetingsSpyneSourceClause('m')}
               AND m.created_at BETWEEN {start:DateTime} AND {end:DateTime}
               AND m.__deleted     = 0
               AND m.lead_id != ''
               AND m.call_id != ''
               AND EXISTS (
                   SELECT 1
                   FROM endcallreports e
                   WHERE e.callId = m.call_id
                     AND e.enterpriseId = {eid:String}
                     AND e.teamId       = {tid:String}
                     AND e.isTestCall   = 0
                     AND lower(e.callDetails_agentInfo_agentType) = 'sales'
                     AND e.callDetails_callType = 'outboundPhoneCall'
                     AND e.createdAt BETWEEN {start:DateTime} AND {end:DateTime}
                     AND e.__deleted    = 0
               )`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },
    async getActionItems(enterpriseId, teamId, start, end, serviceType) {
        return clickhouse.query(
            `SELECT intent, count() AS cnt
             FROM actionItems
             WHERE enterprise_id = {eid:String}
               AND team_id       = {tid:String}
               AND service_type  = {serviceType:String}
               AND is_active     = 1
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted     = 0
             GROUP BY intent
             ORDER BY cnt DESC`,
            {
                eid: enterpriseId,
                tid: teamId,
                start: fmt(start),
                end: fmt(end),
                serviceType,
            },
        );
    },

    async getConversationCounts(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT c.type, uniqExact(c.conversationId) AS cnt
             FROM conversations c
             INNER JOIN teamAgentMappings tam ON tam.teamAgentMappingId = c.teamAgentMappingId
             INNER JOIN agentTypes at ON at.agentTypeId = tam.agentTypeId
             WHERE c.enterpriseId = {eid:String}
               AND c.teamId       = {tid:String}
               AND at.agentType   = 'Sales'
               AND ifNull(c.isTest, 0) = 0
               AND c.createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND c.__deleted    = 0
             GROUP BY c.type`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );

        return parseConversationCountRows(rows);
    },

    async getInboundConversationCounts(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT c.type, uniqExact(c.conversationId) AS cnt
             FROM conversations c
             INNER JOIN teamAgentMappings tam ON tam.teamAgentMappingId = c.teamAgentMappingId
             INNER JOIN agentTypes at ON at.agentTypeId = tam.agentTypeId
             WHERE c.enterpriseId = {eid:String}
               AND c.teamId       = {tid:String}
               AND at.agentType   = 'Sales'
               AND ifNull(c.isTest, 0) = 0
               AND c.createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND c.__deleted    = 0
               AND ${conversationInboundWhereClause()}
             GROUP BY c.type`,
            {
                eid: enterpriseId,
                tid: teamId,
                start: fmt(start),
                end: fmt(end),
                dept: 'sales',
            },
        );
        return parseConversationCountRows(rows);
    },

    /**
     *
     * @returns {Array<{ make, model, year, trim, count }>}
     */
    async getTopVehicles(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT
                 dvm.make        AS make,
                 dvm.model       AS model,
                 dvm.year        AS year,
                 dvm.trim        AS trim,
                 count()         AS interestCount
             FROM entity e
             INNER JOIN inventory.dealerVinMapping dvm ON dvm.dealerVinId = e.external_id
             WHERE e.enterprise_id = {eid:String}
               AND e.team_id       = {tid:String}
               AND e.external_id  != ''
               AND e.createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND e.__deleted     = 0
               AND dvm.__deleted   = 0
             GROUP BY dvm.make, dvm.model, dvm.year, dvm.trim
             ORDER BY interestCount DESC
             LIMIT 5`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );

        return rows.map(r => ({
            make:  r.make  || '',
            model: r.model || '',
            year:  r.year  || '',
            trim:  r.trim  || '',
            count: parseInt(r.interestCount, 10),
        }));
    },
    /**
     *
     * @param {string}  enterpriseId
     * @param {string}  teamId
     * @param {Date}    start
     * @param {Date}    end
     * @param {object}  workingHours
     * @param {boolean} workingHours.isWorkingDay   – if false, every call is after-hours
     * @param {number}  workingHours.startMinutes   – e.g. 540 for 09:00
     * @param {number}  workingHours.endMinutes     – e.g. 1020 for 17:00
     * @param {string}  workingHours.timezone       – IANA tz, e.g. "America/New_York"
     */
    async countAfterHoursLeads(enterpriseId, teamId, start, end, { isWorkingDay, startMinutes, endMinutes, timezone }) {
        const baseFilters = `
            enterpriseId = {eid:String}
            AND teamId   = {tid:String}
            AND lower(callDetails_agentInfo_agentType) = 'sales'
            AND isTestCall = 0
            AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
            AND __deleted = 0`;

        let query;
        const params = { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) };

        if (!isWorkingDay) {
            // Entire day is after-hours — count all calls
            query = `SELECT count() AS cnt FROM endcallreports WHERE ${baseFilters}`;
        } else {
            // Only calls before start_time or at/after end_time
            query = `
                SELECT count() AS cnt
                FROM endcallreports
                WHERE ${baseFilters}
                  AND (
                      toHour(toTimeZone(createdAt, {tz:String})) * 60 + toMinute(toTimeZone(createdAt, {tz:String})) < {startMin:Int32}
                      OR
                      toHour(toTimeZone(createdAt, {tz:String})) * 60 + toMinute(toTimeZone(createdAt, {tz:String})) >= {endMin:Int32}
                  )`;
            params.tz       = timezone;
            params.startMin = startMinutes;
            params.endMin   = endMinutes;
        }

        const rows = await clickhouse.query(query, params);
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },


    async countAfterHoursAppointments(enterpriseId, teamId, start, end, { isWorkingDay, startMinutes, endMinutes, timezone }) {
        const baseFilters = `
            enterprise_id = {eid:String}
            AND team_id   = {tid:String}
            AND service_type = 'sales'
            AND ${meetingsSpyneSourceClause()}
            AND created_at BETWEEN {start:DateTime} AND {end:DateTime}
            AND __deleted  = 0`;

        let query;
        const params = { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) };

        if (!isWorkingDay) {
            query = `SELECT count() AS cnt FROM meetings WHERE ${baseFilters}`;
        } else {
            query = `
                SELECT count() AS cnt
                FROM meetings
                WHERE ${baseFilters}
                  AND (
                      toHour(toTimeZone(created_at, {tz:String})) * 60 + toMinute(toTimeZone(created_at, {tz:String})) < {startMin:Int32}
                      OR
                      toHour(toTimeZone(created_at, {tz:String})) * 60 + toMinute(toTimeZone(created_at, {tz:String})) >= {endMin:Int32}
                  )`;
            params.tz       = timezone;
            params.startMin = startMinutes;
            params.endMin   = endMinutes;
        }

        const rows = await clickhouse.query(query, params);
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },

    async countWarmTransfers(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS cnt
             FROM callTransferEvents
             WHERE enterpriseId = {eid:String}
               AND teamId       = {tid:String}
               AND department   = 'sales'
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted    = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },


    async getSalesTransferStats(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT
                count() AS totalCalls,
                countIf(callId IN (
                    SELECT DISTINCT callId
                    FROM callTransferEvents
                    WHERE enterpriseId = {eid:String}
                      AND teamId       = {tid:String}
                      AND __deleted    = 0
                )) AS transferCount
             FROM endcallreports
             WHERE enterpriseId = {eid:String}
               AND teamId       = {tid:String}
               AND lower(callDetails_agentInfo_agentType) = 'sales'
               AND callDetails_callType = 'inboundPhoneCall'
               AND isActive     = 1
               AND isTestCall   = 0
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted    = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        const row = rows[0] ?? {};
        return {
            transferCount: parseInt(row.transferCount ?? 0, 10),
            totalCalls:    parseInt(row.totalCalls    ?? 0, 10),
        };
    },
};

module.exports = SalesInboundQuery;
