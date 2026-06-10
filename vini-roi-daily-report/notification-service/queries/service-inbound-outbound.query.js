'use strict';

const {
    fmt,
    parseConversationCountRows,
    meetingsSpyneSourceClause,
    conversationInboundWhereClause,
} = require('../utils/common');

/**
 * SERVICE ClickHouse metrics — mirror of sales-inbound-outbound.query.js but
 * filtered to the Service department (agentType 'service', service_type 'service').
 * Same (enterpriseId, teamId, start, end) signature and return shapes.
 * Note: service outbound stats have NO connectedCalls (sales-only field).
 */
const ServiceInboundQuery = {

    async countInboundUniqueLeads(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count(DISTINCT leadId) AS cnt
             FROM endcallreports
             WHERE enterpriseId = {eid:String}
               AND teamId       = {tid:String}
               AND isActive     = 1
               AND isTestCall   = 0
               AND lower(callDetails_agentInfo_agentType) = 'service'
               AND callDetails_callType = 'inboundPhoneCall'
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted    = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },

    async getServiceOutboundCallStats(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS totalCalls,
                    count(DISTINCT leadId) AS uniqueReached
             FROM endcallreports
             WHERE enterpriseId = {eid:String}
               AND teamId       = {tid:String}
               AND isActive     = 1
               AND isTestCall   = 0
               AND lower(callDetails_agentInfo_agentType) = 'service'
               AND callDetails_callType = 'outboundPhoneCall'
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted    = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        const row = rows[0] ?? {};
        return {
            totalCalls:    parseInt(row.totalCalls    ?? 0, 10),
            uniqueReached: parseInt(row.uniqueReached ?? 0, 10),
        };
    },

    async countAllServiceAppointments(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS cnt
             FROM meetings
             WHERE enterprise_id    = {eid:String}
               AND team_id          = {tid:String}
               AND service_type     = 'service'
               AND ${meetingsSpyneSourceClause()}
               AND created_at BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted        = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },


    async countInboundServiceAppointments(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS cnt
             FROM meetings m
             WHERE m.enterprise_id = {eid:String}
               AND m.team_id       = {tid:String}
               AND m.service_type  = 'service'
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
                     AND lower(e.callDetails_agentInfo_agentType) = 'service'
                     AND e.callDetails_callType = 'inboundPhoneCall'
                     AND e.createdAt BETWEEN {start:DateTime} AND {end:DateTime}
                     AND e.__deleted    = 0
               )`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },


    async countOutboundServiceAppointments(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS cnt
             FROM meetings m
             WHERE m.enterprise_id = {eid:String}
               AND m.team_id       = {tid:String}
               AND m.service_type  = 'service'
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
                     AND lower(e.callDetails_agentInfo_agentType) = 'service'
                     AND e.callDetails_callType = 'outboundPhoneCall'
                     AND e.createdAt BETWEEN {start:DateTime} AND {end:DateTime}
                     AND e.__deleted    = 0
               )`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },
    async countAfterHoursLeads(enterpriseId, teamId, start, end, { isWorkingDay, startMinutes, endMinutes, timezone }) {
        const baseFilters = `
            enterpriseId = {eid:String}
            AND teamId   = {tid:String}
            AND lower(callDetails_agentInfo_agentType) = 'service'
            AND isTestCall = 0
            AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
            AND __deleted = 0`;

        let query;
        const params = { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) };

        if (!isWorkingDay) {
            query = `SELECT count() AS cnt FROM endcallreports WHERE ${baseFilters}`;
        } else {
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

    // ─── Conversations ────────────────────────────────────────────────────────

    async getConversationCounts(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT c.type, uniqExact(c.conversationId) AS cnt
             FROM conversations c
             INNER JOIN teamAgentMappings tam ON tam.teamAgentMappingId = c.teamAgentMappingId
             INNER JOIN agentTypes at ON at.agentTypeId = tam.agentTypeId
             WHERE c.enterpriseId = {eid:String}
               AND c.teamId       = {tid:String}
               AND at.agentType   = 'Service'
               AND ifNull(c.isTest, 0) = 0
               AND c.createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND c.__deleted    = 0
             GROUP BY c.type`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );

        return parseConversationCountRows(rows);
    },

    /**
     * Inbound-only conversation counts by channel (for digest channelCall/Sms/Chat).
     */
    async getInboundConversationCounts(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT c.type, uniqExact(c.conversationId) AS cnt
             FROM conversations c
             INNER JOIN teamAgentMappings tam ON tam.teamAgentMappingId = c.teamAgentMappingId
             INNER JOIN agentTypes at ON at.agentTypeId = tam.agentTypeId
             WHERE c.enterpriseId = {eid:String}
               AND c.teamId       = {tid:String}
               AND at.agentType   = 'Service'
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
                dept: 'service',
            },
        );
        return parseConversationCountRows(rows);
    },

    async countServiceConversations(enterpriseId, teamId, start, end) {
        const rows = await clickhouse.query(
            `SELECT count() AS cnt
             FROM endcallreports
             WHERE enterpriseId = {eid:String}
               AND teamId       = {tid:String}
               AND lower(callDetails_agentInfo_agentType) = 'service'
               AND isTestCall   = 0
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted    = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },

    async countAfterHoursAppointments(enterpriseId, teamId, start, end, { isWorkingDay, startMinutes, endMinutes, timezone }) {
        const baseFilters = `
            enterprise_id = {eid:String}
            AND team_id   = {tid:String}
            AND service_type = 'service'
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
               AND department   = 'service'
               AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}
               AND __deleted    = 0`,
            { eid: enterpriseId, tid: teamId, start: fmt(start), end: fmt(end) },
        );
        return parseInt(rows[0]?.cnt ?? 0, 10);
    },


    async getServiceTransferStats(enterpriseId, teamId, start, end) {
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
               AND lower(callDetails_agentInfo_agentType) = 'service'
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

module.exports = ServiceInboundQuery;
