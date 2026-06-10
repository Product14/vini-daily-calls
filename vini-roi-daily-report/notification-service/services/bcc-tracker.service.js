'use strict';

/**
 * BCC TRACKING SERVICE (Step 3 — manual send validation)
 * =========================================================
 * Problem: how do we INDEPENDENTLY confirm an email actually left the building?
 * The mail provider says "accepted" — but did it truly route? Did the dealer
 * receive it? A BCC to a controlled mailbox gives us a second source of truth.
 *
 * How it works:
 *  1. Every outbound digest gets a BCC to: track+{teamId}+{dept}+{localDate}@<trackDomain>
 *     e.g.  track+49a06313cf+sales+2026-06-07@track.spyne.ai
 *  2. The mail provider ALSO fires a "delivered" event to the engagement webhook
 *     for the BCC address — same webhook, no new infrastructure.
 *  3. When the engagement service sees a delivered event to a "track+*" address it
 *     calls `confirmBccDelivery()` here, which flips the run row:
 *       status → "sent", bcc_confirmed = true, bcc_confirmed_at = now
 *  4. The tracker shows a ✓ BCC column so CSMs can see "sent + independently confirmed".
 *
 * Config (sails.config.custom.*):
 *   bccTrackDomain   string  e.g. "track.spyne.ai"   — required to enable BCC
 *   bccEnabled       boolean default false             — master switch
 *
 * The BCC address encodes three fields separated by '+'. Never use '+' in teamId,
 * department, or date — all are controlled strings so this is safe.
 */

const { getSupabaseClient, TABLES } = require('../utils/supabase');

/** Whether BCC tracking is active. Off by default — set bccEnabled:true to turn on. */
function isBccEnabled() {
    return sails.config.custom?.bccEnabled === true;
}

/** The controlled inbox domain. e.g. "track.spyne.ai" */
function trackDomain() {
    return sails.config.custom?.bccTrackDomain || null;
}

/**
 * Build the BCC tracking address for one send.
 * Format: track+{teamId}+{department}+{localDate}@{bccTrackDomain}
 * e.g.    track+49a06313cf+sales+2026-06-07@track.spyne.ai
 *
 * Returns null when BCC is disabled or not configured.
 */
function buildBccAddress(teamId, department, localDate) {
    if (!isBccEnabled()) return null;
    const domain = trackDomain();
    if (!domain) return null;
    return `track+${teamId}+${department}+${localDate}@${domain}`;
}

/**
 * Parse a BCC tracking address back to its parts.
 * Returns null if the address doesn't match the track+* pattern.
 *
 * @param {string} email   e.g. "track+49a06313cf+sales+2026-06-07@track.spyne.ai"
 * @returns {{ teamId, department, localDate } | null}
 */
function parseBccAddress(email) {
    if (!email) return null;
    const local = email.split('@')[0]; // "track+49a06313cf+sales+2026-06-07"
    const parts = local.split('+');    // ["track", "49a06313cf", "sales", "2026-06-07"]
    if (parts.length !== 4 || parts[0] !== 'track') return null;
    const [, teamId, department, localDate] = parts;
    if (!teamId || !department || !localDate) return null;
    return { teamId, department, localDate };
}

/**
 * Called by the engagement service when a "delivered" event arrives for a
 * BCC tracking address. Marks the run as BCC-confirmed in Supabase.
 *
 * Idempotent — safe to call multiple times for the same delivery.
 *
 * @param {string} bccEmail  the full BCC address that received the delivery event
 * @param {string} [messageId]
 */
async function confirmBccDelivery(bccEmail, messageId) {
    const parsed = parseBccAddress(bccEmail);
    if (!parsed) {
        sails.log.warn(`[BccTracker] Unrecognised BCC address: ${bccEmail}`);
        return false;
    }

    const { teamId, department, localDate } = parsed;
    sails.log.info(`[BccTracker] BCC confirmed — ${teamId}/${department}/${localDate}`);

    try {
        const client = getSupabaseClient();
        const { error } = await client
            .from(TABLES.runs())
            .update({
                bcc_confirmed: true,
                bcc_confirmed_at: new Date().toISOString(),
            })
            .match({ team_id: teamId, department, local_date: localDate });

        if (error) throw new Error(error.message);
        return true;
    } catch (err) {
        sails.log.error(`[BccTracker] Failed to confirm BCC for ${teamId}/${department}/${localDate}:`, err.message);
        return false;
    }
}

module.exports = { buildBccAddress, parseBccAddress, confirmBccDelivery, isBccEnabled };
