'use strict';

/**
 * Mail send abstraction with timeout + retry, and a message-id for engagement
 * joins (req 6 & 7). Two send paths:
 *
 *   template  — POST /api/v1/send-template-email  (existing; mail-service renders
 *               a stored template from templateData)
 *   raw_html  — POST <mailRawApi>                  (req 6; we render the HTML in
 *               this service and send the body, so new templates need not be
 *               registered in mail-service)
 *
 * Config (sails.config.custom.*):
 *   mailApi        default 'https://mail.spyne.ai'
 *   mailRawApi     default `${mailApi}/api/v1/send-email`   (raw-HTML endpoint)
 *   mailTimeoutMs  default 15000
 *   mailRetries    default 2
 *   useDirectHtml  default false   — when true, the daily digest uses raw_html
 *   bccEnabled     default false   — add BCC tracking address to every send
 *   bccTrackDomain default null    — e.g. "track.spyne.ai" (required if bccEnabled)
 *
 * BCC tracking (Step 3 — manual send validation):
 *   When bccEnabled=true every send gets a BCC to:
 *     track+{teamId}+{department}+{localDate}@{bccTrackDomain}
 *   The mail provider fires a "delivered" event to the engagement webhook for
 *   that address, which calls bcc-tracker.service.confirmBccDelivery() and
 *   stamps the run row as independently confirmed.
 *
 * ⚠️ The raw-HTML endpoint path/contract is an ASSUMPTION — confirm what
 *    mail.spyne.ai exposes for sending a raw HTML body and adjust here only.
 */

const axios = require('axios');

function cfg(key, fallback) {
    return sails.config.custom?.[key] ?? fallback;
}

function mailBase() {
    return cfg('mailApi', 'https://mail.spyne.ai');
}

async function postWithRetry(url, payload) {
    const timeout = cfg('mailTimeoutMs', 15000);
    const retries = cfg('mailRetries', 2);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const resp = await axios.post(url, payload, { timeout });
            return resp;
        } catch (err) {
            lastErr = err;
            const code = err.code || err.response?.status;
            const retryable =
                code === 'ECONNABORTED' || code === 'ETIMEDOUT' ||
                (typeof code === 'number' && code >= 500);
            sails.log.warn(
                `[MailSend] attempt ${attempt + 1}/${retries + 1} failed (${code || err.message})${retryable && attempt < retries ? ' — retrying' : ''}`,
            );
            if (!retryable || attempt === retries) break;
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
    }
    throw lastErr;
}

function extractMessageId(resp) {
    const d = resp?.data || {};
    return d.messageId || d.message_id || d.id || d.data?.messageId || null;
}

/** Existing template send. @returns {{ messageId: string|null }} */
async function sendTemplateEmail({ to, subject, template, templateData, bcc }) {
    const resp = await postWithRetry(`${mailBase()}/api/v1/send-template-email`, {
        to, subject, template, templateData,
        // bcc is passed only when BCC tracking is enabled (bcc-tracker.service)
        ...(bcc ? { bcc } : {}),
    });
    return { messageId: extractMessageId(resp) };
}

/** Raw-HTML send (req 6). @returns {{ messageId: string|null }} */
async function sendRawHtmlEmail({ to, subject, html, bcc }) {
    const url = cfg('mailRawApi', `${mailBase()}/api/v1/send-email`);
    const resp = await postWithRetry(url, {
        to, subject, html,
        ...(bcc ? { bcc } : {}),
    });
    return { messageId: extractMessageId(resp) };
}

module.exports = { sendTemplateEmail, sendRawHtmlEmail, useDirectHtml: () => cfg('useDirectHtml', false) };
