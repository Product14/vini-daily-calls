'use strict';

/**
 * POST /v2/notification/engagement-webhook  (req 7)
 *
 * Mail-provider webhook sink. Accepts a single event or a batch array and
 * writes them to roi_engagement_events. Wire your ESP's webhook here.
 *
 * Route (add to config/routes.js):
 *   'POST /v2/notification/engagement-webhook': 'v2/notification/engagement-webhook'
 *
 * ⚠️ Add provider signature verification before going live (SES SNS sig,
 *    SendGrid Ed25519, Mailgun HMAC) — left as a TODO since the provider is TBD.
 */

const { recordEngagementEvents } = require('../../../../services/engagement.service');

module.exports = async function engagementWebhook(req, res) {
    try {
        const body = req.body;
        const events = Array.isArray(body) ? body : (body?.events || body?.records || body);
        const count = await recordEngagementEvents(events);
        return res.json({ ok: true, ingested: count });
    } catch (err) {
        sails.log.error('[EngagementWebhook] Failed to ingest events:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
};
