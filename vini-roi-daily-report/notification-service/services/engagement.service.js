'use strict';

/**
 * Communication engagement tracking (req 7).
 *
 * Ingests provider events (delivered / open / click / bounce / complaint …),
 * stores them in roi_engagement_events, and reflects delivered/bounced back
 * onto the originating run's per-recipient state so the tracker's "who
 * received / who bounced" view is accurate.
 *
 * Events are joined to a run via message_id (captured at send time).
 */

const { getSupabaseClient, TABLES } = require('../utils/supabase');
const { confirmBccDelivery, parseBccAddress } = require('./bcc-tracker.service');

const EVENT_TYPES = new Set([
    'delivered', 'open', 'click', 'bounce', 'complaint', 'dropped', 'deferred', 'unsubscribe',
]);

/**
 * Normalizes one provider event to our row shape. Override the field mapping
 * for your ESP (SES/SendGrid/Mailgun) — only this function is provider-specific.
 */
function normalizeEvent(raw = {}) {
    const type = String(raw.event || raw.type || raw.eventType || '').toLowerCase();
    return {
        message_id: raw.messageId || raw.message_id || raw['smtp-id'] || raw.sg_message_id || null,
        recipient_email: (raw.recipient || raw.email || raw.to || '').toString().trim().toLowerCase() || null,
        event_type: EVENT_TYPES.has(type) ? type : null,
        url: raw.url || null,
        provider: raw.provider || null,
        occurred_at: raw.timestamp
            ? new Date(typeof raw.timestamp === 'number' ? raw.timestamp * 1000 : raw.timestamp).toISOString()
            : new Date().toISOString(),
        raw,
    };
}

async function recordEngagementEvents(rawEvents = []) {
    const client = getSupabaseClient();
    const rows = [];

    for (const raw of Array.isArray(rawEvents) ? rawEvents : [rawEvents]) {
        const ev = normalizeEvent(raw);
        if (!ev.event_type || !ev.message_id) continue;

        // resolve run_id + team_id from the originating run
        const { data: run } = await client
            .from(TABLES.runs())
            .select('id, team_id, recipients')
            .eq('message_id', ev.message_id)
            .maybeSingle();

        rows.push({
            run_id: run?.id || null,
            team_id: run?.team_id || null,
            message_id: ev.message_id,
            recipient_email: ev.recipient_email,
            event_type: ev.event_type,
            url: ev.url,
            provider: ev.provider,
            occurred_at: ev.occurred_at,
            raw: ev.raw,
        });

        // BCC tracking: if this delivery is to a track+* address, confirm the run
        if (ev.event_type === 'delivered' && ev.recipient_email && parseBccAddress(ev.recipient_email)) {
            await confirmBccDelivery(ev.recipient_email, ev.message_id).catch(err =>
                sails.log.warn('[Engagement] BCC confirm failed:', err.message),
            );
        }

        // reflect delivered / bounced onto the run's per-recipient state
        if (run && Array.isArray(run.recipients) && (ev.event_type === 'delivered' || ev.event_type === 'bounce')) {
            const updated = run.recipients.map((r) => {
                if ((r.email || '').toLowerCase() !== ev.recipient_email) return r;
                return ev.event_type === 'delivered'
                    ? { ...r, received: true }
                    : { ...r, received: false, bounced: true };
            });
            await client.from(TABLES.runs()).update({ recipients: updated }).eq('id', run.id);
        }
    }

    if (rows.length) {
        const { error } = await client.from(TABLES.engagement()).insert(rows);
        if (error) throw new Error(error.message);
    }
    return rows.length;
}

module.exports = { recordEngagementEvents, normalizeEvent, EVENT_TYPES };
