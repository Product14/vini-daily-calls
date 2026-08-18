'use strict';

/**
 * common.js — shared formatters, date math, and reusable SQL fragments used by
 * every digest query and the template builder. No DB access here; pure helpers.
 */

/** ClickHouse wants 'YYYY-MM-DD HH:MM:SS'. Convert a JS Date → that string. */
function fmt(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Safe percentage as a display string, e.g. pct(3, 12) -> "25%". 0 denominator -> "0%". */
function pct(numerator, denominator) {
    if (!denominator) return '0%';
    return `${Math.round((numerator / denominator) * 100)}%`;
}

// canonical: rate display — never headline a rounded "0%". When the rounded percent
// would read 0% (or 100% off a tiny base) we surface the raw fraction instead, e.g.
// "1/32". Use this for turn/close rates so a real-but-small rate isn't shown as "0%".
function pctOrFraction(numerator, denominator) {
    if (!denominator) return '—';
    const rounded = Math.round((numerator / denominator) * 100);
    if (numerator > 0 && rounded === 0) return `${numerator}/${denominator}`;
    return `${rounded}% (${numerator}/${denominator})`;
}

// canonical (locked denominators — identical across all Vini systems):
//   Turn rate  = qualified leads ÷ real conversations (connected)   — NOT ÷ leads-touched.
//   Close rate = appointments    ÷ qualified leads                  — NOT ÷ leads-touched.
function turnRate(qualified, conversationsConnected) {
    return pctOrFraction(qualified || 0, conversationsConnected || 0);
}
function closeRate(appointments, qualified) {
    return pctOrFraction(appointments || 0, qualified || 0);
}
/** Milliseconds → human duration, e.g. 95000 -> "1 min 35 sec". Used for response-time KPIs. */
function msToSec(ms) {
    if (!ms) return '0 sec';
    const totalSec = Math.round(ms / 1000);
    const hrs  = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0)  return `${hrs} hr ${mins} min ${secs} sec`;
    if (mins > 0) return `${mins} min ${secs} sec`;
    return `${secs} sec`;
}
function mtdDelta(yesterday, mtdTotal) {
    const diff = (mtdTotal || 0) - (yesterday || 0);
    return diff >= 0 ? `+${diff}` : `${diff}`;
}

function formatActionItemIntent(intent) {
    if (!intent || typeof intent !== 'string') return 'Action Required';
    const trimmed = intent.trim();
    if (!trimmed) return 'Action Required';

    const lowerWords = trimmed
        .replace(/[-\s]+/g, '_')
        .split('_')
        .filter(Boolean)
        .map(w => w.toLowerCase());

    if (!lowerWords.length) return 'Action Required';

    lowerWords[0] = lowerWords[0].charAt(0).toUpperCase() + lowerWords[0].slice(1);
    return lowerWords.join(' ');
}

// ─── Digest time windows (dealer-local calendar) ─────────────────────────────
// Why this is fiddly: ClickHouse stores timestamps in UTC, but "yesterday" must
// mean the DEALER'S calendar day (a NY dealer's "yesterday" differs from a CA
// dealer's). So we compute the day in the dealer's timezone, then convert the
// local midnight boundaries back to the UTC instants we query with.

/** What calendar day is it (year/month/day) in timezone `tz` for instant `date`. */
function getLocalDate(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(date);
    const get = type => parseInt(parts.find(p => p.type === type).value);
    return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Convert a local wall-clock time in `tz` to the matching UTC instant.
 * Trick: build the time as if it were UTC ("approx"), see what wall-clock that
 * lands on in `tz`, measure the offset error, and shift `approx` by that error.
 * Handles DST automatically because the offset is measured at that exact date.
 */
function localToUTC(year, month, day, hour, min, sec, tz) {
    const approx = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
    const localParts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false,
    }).formatToParts(approx);
    const get = type => parseInt(localParts.find(p => p.type === type)?.value ?? '0');
    const localAsUTC = new Date(Date.UTC(
        get('year'), get('month') - 1, get('day'),
        get('hour') === 24 ? 0 : get('hour'), get('minute'), get('second'),
    ));
    return new Date(approx.getTime() + (approx.getTime() - localAsUTC.getTime()));
}

/**
 * Returns the two time windows needed for the digest, computed in the
 * dealer's local timezone so "yesterday" matches their calendar day.
 *
 * @param {string} [tz='UTC'] IANA timezone, e.g. 'America/New_York'
 */
function getTimeWindows(tz = 'UTC') {
    const now = new Date();
    const { year, month, day } = getLocalDate(now, tz);

    const yStart   = localToUTC(year, month, day - 1, 0, 0, 0, tz);
    const yEnd     = new Date(localToUTC(year, month, day, 0, 0, 0, tz).getTime() - 1);
    const mtdStart = localToUTC(year, month, 1, 0, 0, 0, tz);
    // canonical: comparable window = rolling last-30-days [today-30, today) in DEALER-LOCAL tz.
    // This is the window the console (reporting-vini) headlines; expose it here for parity.
    // The daily email keeps `yesterday`/`mtd` but those views must be LABELLED as such.
    const last30Start = localToUTC(year, month, day - 30, 0, 0, 0, tz);
    const last30End   = new Date(localToUTC(year, month, day, 0, 0, 0, tz).getTime() - 1);

    return {
        yesterday: { start: yStart, end: yEnd },
        mtd:       { start: mtdStart, end: yEnd },
        last30:    { start: last30Start, end: last30End },
    };
}


function toDateLabel(date, tz = 'UTC') {
    return date.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        timeZone: tz,
    });
}
function toPeriodLabel(date, tz = 'UTC') {
    return date.toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
        timeZone: tz,
    });
}

/** Maps ClickHouse GROUP BY c.type rows to { call, sms, chat, total }. */
function parseConversationCountRows(rows) {
    const result = { call: 0, sms: 0, chat: 0, total: 0 };
    for (const row of rows) {
        const cnt = parseInt(row.cnt, 10);
        if (row.type === 'call') {
            result.call = cnt;
            result.total += cnt;
        } else if (row.type === 'sms') {
            result.sms = cnt;
            result.total += cnt;
        } else if (row.type === 'chat') {
            result.chat = cnt;
            result.total += cnt;
        }
    }
    return result;
}

/**
 * Inbound-only predicate for digest channel breakdown (requires {dept:String} = sales|service).
 * Call: linked endcallreports inboundPhoneCall. SMS/chat: non-campaign threads.
 */
/**
 * ★ CANONICAL (2026-08-18): meta.source='warm_transfer' rows are NOT appointments we created.
 *
 * `meetings.source` says who OWNS a booking ('spyne' = us, 'bdc'/'eleads' = the dealer's CRM);
 * `meta.source` says HOW the row came to exist. 'warm_transfer' rows are the customer's EXISTING
 * appointments, pulled in around a transfer — records nobody just booked (their start times are often
 * the customer's own PAST visits). So source='spyne' alone is NOT proof the AI booked it, and such a
 * row must never be counted as an appointment on EITHER side (AI-booked or AI-assisted/CRM).
 *
 * Caught on Honda of Downtown Los Angeles 2026-08-14: a manager got 7 "New appointment" emails for ONE
 * customer in 6 seconds, all 7 warm_transfer (start times Jul-2024 → Jan-2026). Prod all-time has only
 * three meta.source values — '' , 'warm_transfer' (4,975 / 48 teams), 'callback' (1,050) — so one
 * equality test covers the rule. 'callback' rows are deliberately left alone.
 *
 * Applied identically in reporting-vini (agentBaseFact.sql appt_attribution, detailQueries.ts
 * notWarmTransfer, push_metrics.py) and vini-daily-calls (server/warmTransferExclusion.js).
 */
function meetingsNotWarmTransferClause(tableAlias) {
    const p = tableAlias ? `${tableAlias}.meta` : 'meta';
    return `lower(JSONExtractString(ifNull(${p}, ''), 'source')) != 'warm_transfer'`;
}

/**
 * Digest meetings: only rows created through Spyne (excludes DMS / integration imports), and never a
 * warm_transfer row (see meetingsNotWarmTransferClause — 'spyne' ownership is not proof we booked it).
 */
function meetingsSpyneSourceClause(tableAlias) {
    const own = tableAlias ? `${tableAlias}.source = 'spyne'` : `source = 'spyne'`;
    return `${own} AND ${meetingsNotWarmTransferClause(tableAlias)}`;
}

function conversationInboundWhereClause() {
    return `(
        (c.type = 'call' AND ifNull(c.callId, '') != ''
          AND EXISTS (
              SELECT 1
              FROM endcallreports e
              WHERE e.callId = c.callId
                AND e.enterpriseId = c.enterpriseId
                AND e.teamId = c.teamId
                AND e.isActive = 1
                AND e.isTestCall = 0
                AND lower(e.callDetails_agentInfo_agentType) = {dept:String}
                AND e.callDetails_callType = 'inboundPhoneCall'
                AND e.__deleted = 0
          ))
        OR (c.type IN ('sms', 'chat') AND ifNull(c.campaignId, '') = '')
    )`;
}

module.exports = {
    fmt,
    pct,
    pctOrFraction,   // canonical: fraction-aware rate display (never headline a rounded 0%)
    turnRate,        // canonical: qualified ÷ connected
    closeRate,       // canonical: appointments ÷ qualified
    msToSec,
    mtdDelta,
    formatActionItemIntent,
    getLocalDate,
    localToUTC,
    getTimeWindows,
    toDateLabel,
    toPeriodLabel,
    parseConversationCountRows,
    meetingsSpyneSourceClause,
    meetingsNotWarmTransferClause,   // canonical: exclude appointments we did not create
    conversationInboundWhereClause,
};
