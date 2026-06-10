'use strict';

/**
 * External Supabase source of truth for "which teams are ACTUALLY live"
 * per department.
 *
 * Why this exists
 * ----------------
 * ClickHouse `teamAgentMappings` tells us a team has an onboarded + active
 * agent (`isOnboarded = 1`, `isActive = 1`). But onboarded/active ≠ actually
 * live — a team can be configured yet not taking real traffic. The CSM team
 * curates an external Supabase table of team_ids that are genuinely live on
 * the Sales and/or Service department. Digest eligibility = ClickHouse
 * candidate ∩ Supabase confirmed-live.
 *
 * Assumed Supabase schema (table name override: sails.config.custom.supabaseLiveTable)
 * ------------------------------------------------------------------
 *   table:  roi_live_departments
 *     team_id     text     -- matches ClickHouse teamId
 *     department  text     -- 'sales' | 'service'
 *     is_live     boolean
 *
 * One row per (team_id, department). If your table is one-row-per-team with
 * sales_live/service_live booleans, adjust `parseLiveRows` only.
 *
 * Returns: Map<teamId, { sales: boolean, service: boolean }>
 */

const { getSupabaseClient, TABLES } = require('../utils/supabase');

/** Maps raw Supabase rows → Map<teamId, { sales, service }>. */
function parseLiveRows(rows) {
    const byTeam = new Map();
    for (const row of rows || []) {
        const teamId = String(row.team_id || '').trim();
        if (!teamId) continue;

        if (!byTeam.has(teamId)) {
            byTeam.set(teamId, { sales: false, service: false });
        }
        const entry = byTeam.get(teamId);

        const dept = String(row.department || '').toLowerCase();
        const live = row.is_live === true || row.is_live === 1 || row.is_live === 'true';

        if (live && dept === 'sales') entry.sales = true;
        if (live && dept === 'service') entry.service = true;
    }
    return byTeam;
}

const LiveTeamQuery = {
    /**
     * @returns {Promise<Map<string, { sales: boolean, service: boolean }>>}
     *   keyed by teamId. Teams absent from Supabase are treated as not-live.
     */
    async getLiveDepartmentsByTeam() {
        const client = getSupabaseClient();
        const { data, error } = await client
            .from(TABLES.live())
            .select('team_id, department, is_live');

        if (error) {
            throw new Error(
                `[DigestEligibility] Supabase live-departments query failed: ${error.message}`,
            );
        }
        return parseLiveRows(data);
    },

    // exported for unit tests / alternate schemas
    parseLiveRows,
};

module.exports = LiveTeamQuery;
