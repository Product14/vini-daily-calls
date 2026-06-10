'use strict';

/**
 * Persists every digest decision to Supabase roi_digest_runs (req 1 & 5).
 *
 * Called on EVERY exit path of the trigger — sent, suppressed, and every
 * not_sent reason — so the CSM tracker has a complete, queryable history:
 *   • sent     → metrics + rendered HTML of what the dealer received
 *   • not sent → failure reason + the numbers that were computed, so a human
 *                can still decide whether to send.
 *
 * Upsert on (team_id, department, cadence, local_date) gives idempotency —
 * fixes the read-then-write dedup race in the original code.
 */

const { getSupabaseClient, TABLES } = require('../utils/supabase');

/**
 * Canonical reason codes. The tracker frontend (NotSentReason) understands the
 * first group directly; the second group is backend-specific and rendered as
 * detail. Keep this in sync with tracker mockData.ts.
 */
const REASONS = {
    // tracker-aligned
    RECIPIENTS_MISSING: 'recipients_missing',
    RECIPIENT_PLACEHOLDER: 'recipient_placeholder',
    TAG_MISSING: 'tag_missing',
    SMTP_TIMEOUT: 'smtp_timeout',
    SCHEDULER_SKIPPED: 'scheduler_skipped',
    SILENT_DAY: 'silent_day',
    BOUNCED: 'bounced',
    // backend-specific
    NOT_ELIGIBLE: 'not_eligible',          // digest disabled / gate failed
    BEFORE_SEND_HOUR: 'before_send_hour',  // ran before configured local hour
    ALREADY_SENT: 'already_sent',
    NO_DATA: 'no_data',                    // guardrail: nothing happened
    NOT_ACTIONABLE: 'not_actionable',      // guardrail: nothing to act on
    GUARDRAIL_FAILED: 'guardrail_failed',  // guardrail: invalid/inconsistent
    NOT_SUBSCRIBED: 'not_subscribed',      // recipients exist but none for this dept
    MAIL_ERROR: 'mail_error',
};

/**
 * @param {object} run
 * @param {string} run.enterpriseId
 * @param {string} run.teamId
 * @param {'sales'|'service'} run.department
 * @param {'daily'|'weekly'|'monthly'} [run.cadence='daily']
 * @param {string} run.localDate            YYYY-MM-DD (dealer local)
 * @param {string} [run.dealerTimezone]
 * @param {'sent'|'not_sent'|'suppressed'|'scheduled'|'not_subscribed'} run.status
 * @param {string} [run.reason]
 * @param {string} [run.reasonDetail]
 * @param {object} [run.metrics]            full computed templateData
 * @param {string} [run.renderedHtml]
 * @param {string} [run.subject]
 * @param {string} [run.mailTemplate]
 * @param {Array}  [run.recipients]
 * @param {'template'|'raw_html'} [run.sendPath='template']
 * @param {'cron'|'manual'|'backfill'} [run.trigger='cron']
 * @param {string} [run.messageId]
 * @param {Date}   [run.sentAt]
 *
 * Never throws — logging the run must not break the send pipeline.
 * @returns {Promise<boolean>} true if persisted
 */
async function recordDigestRun(run) {
    const row = {
        enterprise_id: run.enterpriseId,
        team_id: run.teamId,
        department: run.department,
        cadence: run.cadence || 'daily',
        local_date: run.localDate,
        dealer_timezone: run.dealerTimezone || null,
        status: run.status,
        reason: run.reason || null,
        reason_detail: run.reasonDetail || null,
        metrics: run.metrics || null,
        rendered_html: run.renderedHtml || null,
        subject: run.subject || null,
        mail_template: run.mailTemplate || null,
        recipients: run.recipients || null,
        send_path: run.sendPath || 'template',
        trigger: run.trigger || 'cron',
        message_id: run.messageId || null,
        sent_at: run.sentAt ? new Date(run.sentAt).toISOString() : null,
    };

    try {
        const client = getSupabaseClient();
        const { error } = await client
            .from(TABLES.runs())
            .upsert(row, { onConflict: 'team_id,department,cadence,local_date' });
        if (error) throw new Error(error.message);
        return true;
    } catch (err) {
        sails.log.error(
            `[DigestStore] Failed to record run ${run.teamId}/${run.department}/${run.localDate}:`,
            err.message,
        );
        return false;
    }
}

/**
 * Has a digest already been SENT for this team/dept/cadence/local-day?
 * Supabase-native dedup (replaces the Mongo dailyDigestEmailLogs check) so the
 * whole send+track loop is self-contained in this codebase. Fails open (returns
 * false) on error so a transient Supabase blip never permanently blocks a send.
 *
 * @returns {Promise<boolean>}
 */
async function alreadySentToday({ teamId, department, cadence = 'daily', localDate }) {
    try {
        const client = getSupabaseClient();
        const { data, error } = await client
            .from(TABLES.runs())
            .select('id')
            .eq('team_id', teamId)
            .eq('department', department)
            .eq('cadence', cadence)
            .eq('local_date', localDate)
            .eq('status', 'sent')
            .maybeSingle();
        if (error) throw new Error(error.message);
        return !!data;
    } catch (err) {
        sails.log.warn(`[DigestStore] alreadySentToday check failed (${err.message}) — treating as not sent.`);
        return false;
    }
}

/**
 * Backfill: copy historical successful sends from Mongo dailyDigestEmailLogs
 * into roi_digest_runs (req 1 — "cron sync back to Supabase"). Idempotent.
 */
async function syncFromDailyDigestLogs({ since } = {}) {
    const filter = {};
    if (since) filter.sent_at = { $gte: new Date(since) };

    const logs = await dailyDigestEmailLogs.find(filter).lean();
    let synced = 0;
    for (const log of logs) {
        const ok = await recordDigestRun({
            enterpriseId: log.enterprise_id,
            teamId: log.team_id,
            department: log.digest_type,            // 'sales' | 'service'
            cadence: 'daily',
            localDate: log.local_date,
            dealerTimezone: log.dealer_timezone,
            status: 'sent',
            subject: log.subject,
            mailTemplate: log.mail_template,
            recipients: (log.recipients || []).map((email) => ({ email, received: true })),
            trigger: 'backfill',
            sentAt: log.sent_at,
        });
        if (ok) synced += 1;
    }
    sails.log.info(`[DigestStore] Backfill synced ${synced}/${logs.length} dailyDigestEmailLogs rows.`);
    return synced;
}

module.exports = { recordDigestRun, alreadySentToday, syncFromDailyDigestLogs, REASONS };
