'use strict';

/**
 * Per-rooftop runtime config + recipient department-routing, from Supabase.
 *
 *   roi_rooftop_config — req 2: send hour is configurable per rooftop (from UI),
 *                        no longer hardcoded to 7 AM.
 *   roi_recipients     — req 3: which department's comms each recipient receives.
 */

const { getSupabaseClient, TABLES } = require('../utils/supabase');

const DEFAULT_SEND_HOUR = 7;
const DEFAULT_SEND_MINUTE = 0;

const RooftopConfigQuery = {
    /**
     * @returns {Promise<{ sendHour, sendMinute, sendMinutesSinceMidnight, timezone, daily, weekly, monthly }>}
     *   Falls back to 7:00 defaults when the team has no config row.
     */
    async getRooftopConfig(teamId) {
        const client = getSupabaseClient();
        const { data, error } = await client
            .from(TABLES.config())
            .select(
                'digest_send_hour, digest_send_minute, timezone, daily_enabled, weekly_enabled, monthly_enabled',
            )
            .eq('team_id', teamId)
            .maybeSingle();

        if (error) {
            throw new Error(
                `[RooftopConfig] Supabase config query failed for ${teamId}: ${error.message}`,
            );
        }

        const hour = clampInt(data?.digest_send_hour, DEFAULT_SEND_HOUR, 0, 23);
        const minute = clampInt(data?.digest_send_minute, DEFAULT_SEND_MINUTE, 0, 59);

        return {
            sendHour: hour,
            sendMinute: minute,
            sendMinutesSinceMidnight: hour * 60 + minute,
            timezone: data?.timezone || null,
            daily: data?.daily_enabled ?? true,
            weekly: data?.weekly_enabled ?? false,
            monthly: data?.monthly_enabled ?? false,
        };
    },

    /**
     * Department-subscription map for a team's recipients.
     * @returns {Promise<Map<string, { sales: boolean, service: boolean, enabled: boolean }>>}
     *   keyed by lowercased email.
     */
    async getRecipientDeptSubscriptions(teamId) {
        const client = getSupabaseClient();
        const { data, error } = await client
            .from(TABLES.recipients())
            .select('email, receives_sales, receives_service, email_enabled')
            .eq('team_id', teamId);

        if (error) {
            throw new Error(
                `[RooftopConfig] Supabase recipients query failed for ${teamId}: ${error.message}`,
            );
        }

        const map = new Map();
        for (const row of data || []) {
            const email = String(row.email || '').trim().toLowerCase();
            if (!email) continue;
            map.set(email, {
                sales: row.receives_sales === true,
                service: row.receives_service === true,
                enabled: row.email_enabled !== false,
            });
        }
        return map;
    },

    /**
     * Filters a resolved email list to those subscribed to `serviceType`.
     * Recipients absent from roi_recipients are KEPT (fail-open) so a missing
     * routing row never silently drops a previously-working recipient — flip
     * `strict` to true to require an explicit subscription.
     */
    filterEmailsByDept(emails, subs, serviceType, { strict = false } = {}) {
        const dept = serviceType === 'service' ? 'service' : 'sales';
        return (emails || []).filter((e) => {
            const sub = subs.get(String(e || '').trim().toLowerCase());
            if (!sub) return !strict;
            return sub.enabled && sub[dept];
        });
    },
};

function clampInt(v, fallback, min, max) {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

module.exports = RooftopConfigQuery;
