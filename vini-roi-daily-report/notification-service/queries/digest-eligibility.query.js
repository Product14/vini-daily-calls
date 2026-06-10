'use strict';

const LiveTeamQuery = require('./live-team.query');

/**
 * ClickHouse: which agent types are onboarded AND active per (enterpriseId, teamId).
 *
 * This is the *candidate* set only — onboarded + active does not mean the team
 * is actually taking traffic. The candidate set is later intersected with the
 * Supabase confirmed-live allowlist (see getDigestTargets).
 *
 * @returns {Map<string, { sendSales: boolean, sendService: boolean }>}
 */
async function getOnboardedAgentFlagsByTeam() {
    const rows = await clickhouse.query(
        `SELECT DISTINCT
                tam.enterpriseId AS enterpriseId,
                tam.teamId       AS teamId,
                at.agentType     AS agentType
         FROM teamAgentMappings tam
         INNER JOIN agentTypes at ON at.agentTypeId = tam.agentTypeId
         WHERE tam.isOnboarded = 1
           AND ifNull(tam.isActive, 1) = 1
           AND ifNull(tam.__deleted, 0) = 0
           AND ifNull(at.__deleted, 0) = 0
           AND at.agentType IN ('Sales', 'Service')`,
    );

    const byTeam = new Map();
    for (const row of rows) {
        const enterpriseId = row.enterpriseId;
        const teamId = row.teamId;
        if (!enterpriseId || !teamId) continue;

        const key = `${enterpriseId}\0${teamId}`;
        if (!byTeam.has(key)) {
            byTeam.set(key, { sendSales: false, sendService: false });
        }
        const entry = byTeam.get(key);
        if (row.agentType === 'Sales') entry.sendSales = true;
        if (row.agentType === 'Service') entry.sendService = true;
    }
    return byTeam;
}

const DigestEligibilityQuery = {
    /**
     * Digest targets = three gates ANDed together, per department:
     *   1. Mongo  `conversationNotifications` — digest enabled for the team
     *   2. ClickHouse `teamAgentMappings`     — onboarded + active Sales/Service agent
     *   3. Supabase `roi_live_departments`    — dept confirmed *actually* live
     *
     * A team sends a Sales digest only when Sales passes all three; same for Service.
     *
     * @param {{ digestField?: 'dailyDigest' | 'weeklyDigest', liveFilterFailOpen?: boolean }} [options]
     *   - liveFilterFailOpen: when Supabase is unreachable, fall back to the
     *     ClickHouse candidate set (gates 1+2 only) instead of sending nothing.
     *     Defaults to false (fail closed) so a Supabase outage never blasts
     *     teams that may not be live.
     */
    async getDigestTargets(options = {}) {
        const digestField = options.digestField || 'dailyDigest';
        let docs;
        try {
            docs = await conversationNotification
                .find({
                    [digestField]: true,
                    'config.dealerEmail': false,
                })
                .select('enterpriseId teamId')
                .lean();
        } catch (err) {
            sails.log.error(
                '[DailyDigest] Failed to load conversationNotifications digest targets:',
                err.message,
            );
            return [];
        }

        const agentFlags = await getOnboardedAgentFlagsByTeam();

        // Supabase confirmed-live allowlist. Fail closed by default.
        let liveFlags;
        try {
            liveFlags = await LiveTeamQuery.getLiveDepartmentsByTeam();
        } catch (err) {
            if (options.liveFilterFailOpen) {
                sails.log.warn(
                    `[DailyDigest] Supabase live filter unavailable (${err.message}) — failing OPEN to ClickHouse candidates.`,
                );
                liveFlags = null; // sentinel: skip the live gate
            } else {
                sails.log.error(
                    `[DailyDigest] Supabase live filter unavailable (${err.message}) — failing CLOSED, no digests this run.`,
                );
                return [];
            }
        }

        const targets = [];

        for (const doc of docs) {
            const { enterpriseId, teamId } = doc;
            if (!enterpriseId || !teamId) continue;

            const flags = agentFlags.get(`${enterpriseId}\0${teamId}`);
            if (!flags || (!flags.sendSales && !flags.sendService)) continue;

            // Gate 3 — Supabase. Absent team → not live (unless failing open).
            const live = liveFlags === null
                ? { sales: true, service: true }
                : (liveFlags.get(teamId) || { sales: false, service: false });

            const sendSales = flags.sendSales && live.sales;
            const sendService = flags.sendService && live.service;
            if (!sendSales && !sendService) continue;

            targets.push({ enterpriseId, teamId, sendSales, sendService });
        }

        return targets;
    },

    /** @deprecated Use getDigestTargets — kept for tests referencing CH agent flags only */
    async getOnboardedDigestTargets() {
        const agentFlags = await getOnboardedAgentFlagsByTeam();
        return [...agentFlags.entries()].map(([key, flags]) => {
            const [enterpriseId, teamId] = key.split('\0');
            return { enterpriseId, teamId, ...flags };
        });
    },
};

module.exports = DigestEligibilityQuery;
