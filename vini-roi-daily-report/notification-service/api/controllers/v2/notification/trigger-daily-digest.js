'use strict';

/**
 * POST /v2/notification/trigger-daily-digest
 *
 * Manual / on-demand digest trigger. Powers the tracker's "Send now" and
 * "Retry" buttons and ad-hoc QA sends. Bypasses the cron send-hour gate by
 * default (bypassDigestSchedule:true) so it fires immediately, but still runs
 * the full pipeline: recipients → metrics → guardrails → send → record run.
 *
 * Route (add to config/routes.js):
 *   'POST /v2/notification/trigger-daily-digest': 'v2/notification/trigger-daily-digest'
 *
 * Body:
 *   {
 *     "enterpriseId": "7d06f7427",     // required
 *     "teamId": "49a06313cf",          // required
 *     "serviceType": "sales",          // "sales" | "service" | "both"  (default "both")
 *     "to": ["mgr@dealer.com"],        // optional — overrides resolved recipients
 *     "bypassDigestSchedule": true     // optional — default true for manual sends
 *   }
 *
 * Response: { ok, results: [{ department, sent, reason?, recipients? }] }
 */

const {
    triggerDailyDigestEmail,
    triggerServiceDailyDigestEmail,
} = require('../../../../services/trigger-email-service');

module.exports = async function triggerDailyDigest(req, res) {
    const body = req.body || {};
    const enterpriseId = body.enterpriseId || body.enterprise_id;
    const teamId = body.teamId || body.team_id;
    const serviceType = (body.serviceType || 'both').toLowerCase();
    const to = body.to;
    const bypassDigestSchedule = body.bypassDigestSchedule !== false; // default true

    if (!enterpriseId || !teamId) {
        return res.status(400).json({ ok: false, error: 'enterpriseId and teamId are required' });
    }
    if (!['sales', 'service', 'both'].includes(serviceType)) {
        return res.status(400).json({ ok: false, error: "serviceType must be 'sales', 'service' or 'both'" });
    }

    const options = { bypassDigestSchedule };
    if (to) options.to = to;

    const jobs = [];
    if (serviceType === 'sales' || serviceType === 'both') {
        jobs.push(['sales', () => triggerDailyDigestEmail(enterpriseId, teamId, options)]);
    }
    if (serviceType === 'service' || serviceType === 'both') {
        jobs.push(['service', () => triggerServiceDailyDigestEmail(enterpriseId, teamId, options)]);
    }

    const results = [];
    for (const [department, run] of jobs) {
        try {
            const r = await run();
            results.push({ department, ...r });
        } catch (err) {
            sails.log.error(`[TriggerDigest] ${department} failed for ${enterpriseId}/${teamId}:`, err.message);
            results.push({ department, sent: false, error: err.message });
        }
    }

    const anySent = results.some(r => r.sent);
    return res.status(anySent ? 200 : 207).json({ ok: anySent, results });
};
