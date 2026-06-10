'use strict';

/**
 * Payload guardrails (req 4).
 *
 * Runs AFTER step 1 (ClickHouse metrics) + step 2 (campaign stats) and BEFORE
 * the email is rendered/sent. Prevents junk / irrelevant / non-actionable
 * emails from going out (beyond the basic hasDigestData appts-or-convs check).
 *
 * Returns { ok, reason, failures } where `reason` is a normalized code stored
 * on the digest run when ok === false.
 *
 *   GUARDRAIL_REASONS:
 *     no_data            — nothing happened (all primary KPIs zero)
 *     not_actionable     — activity exists but nothing the dealer can act on
 *     invalid_metrics    — NaN / negative / impossible values
 *     inconsistent_mtd   — MTD < yesterday (window/computation bug)
 *     missing_fields     — required template fields absent
 */

const REQUIRED_FIELDS = ['dealershipName', 'reportDate', 'reportingPeriod'];

function num(v) {
    const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * @param {object} templateData  output of buildTemplateData / buildServiceTemplateData
 * @param {object} [raw]          raw computed numbers for cross-checks
 *   { allApptsYesterday, allAptsMtd, conversationsTotal, inboundLeads, outboundReached }
 */
function validateDigestPayload(templateData = {}, raw = {}) {
    const failures = [];

    // 1 · required fields present
    for (const f of REQUIRED_FIELDS) {
        if (templateData[f] === undefined || templateData[f] === null || templateData[f] === '') {
            failures.push({ code: 'missing_fields', field: f });
        }
    }

    // 2 · core counts must be valid (non-negative integers)
    const counts = {
        appointmentsYesterday: num(templateData.appointmentsYesterday),
        appointmentsYesterdayMTD: num(templateData.appointmentsYesterdayMTD),
        conversationsHandled: num(templateData.conversationsHandled),
        inboundUniqueLeads: num(templateData.inboundUniqueLeads),
        outboundUniqueReached: num(templateData.outboundUniqueReached),
    };
    for (const [k, v] of Object.entries(counts)) {
        if (Number.isNaN(v) || v < 0) failures.push({ code: 'invalid_metrics', field: k, value: v });
    }

    // 3 · MTD can never be less than the single yesterday value
    if (
        Number.isFinite(counts.appointmentsYesterday) &&
        Number.isFinite(counts.appointmentsYesterdayMTD) &&
        counts.appointmentsYesterdayMTD < counts.appointmentsYesterday
    ) {
        failures.push({
            code: 'inconsistent_mtd',
            field: 'appointmentsYesterdayMTD',
            value: `${counts.appointmentsYesterdayMTD} < ${counts.appointmentsYesterday}`,
        });
    }

    // 4 · actionability — at least one thing worth emailing about
    const actionItemCount = Array.isArray(templateData.actionRequiredItems)
        ? templateData.actionRequiredItems.reduce((s, i) => s + (num(i.count) || 0), 0)
        : 0;
    const signalSum =
        (counts.appointmentsYesterday || 0) +
        (counts.conversationsHandled || 0) +
        (counts.inboundUniqueLeads || 0) +
        (counts.outboundUniqueReached || 0) +
        actionItemCount;

    if (signalSum === 0) {
        // nothing happened at all
        failures.push({ code: 'no_data', field: 'signalSum', value: 0 });
    } else if (
        (counts.appointmentsYesterday || 0) === 0 &&
        actionItemCount === 0 &&
        (counts.inboundUniqueLeads || 0) === 0
    ) {
        // some passive conversation noise but nothing actionable for the dealer
        failures.push({ code: 'not_actionable', field: 'actionable', value: signalSum });
    }

    if (!failures.length) return { ok: true, failures: [] };

    // pick the most severe reason for the run record (order = severity)
    const order = ['invalid_metrics', 'inconsistent_mtd', 'missing_fields', 'no_data', 'not_actionable'];
    const reason = order.find((c) => failures.some((f) => f.code === c)) || failures[0].code;
    return { ok: false, reason, failures };
}

module.exports = { validateDigestPayload, REQUIRED_FIELDS };
