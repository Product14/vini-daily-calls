'use strict';

const axios = require('axios');

/** IANA tz weekday name for `date`, e.g. "friday". */
function getLocalWeekdayName(date, tz) {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' })
        .format(date)
        .toLowerCase();
}

async function fetchWorkingDays(teamId) {
    const url = `${sails.config.custom.internalAPIDomain}/user-management/v1/team/get-working-days?teamId=${teamId}`;
    const resp = await axios.get(url);
    return resp.data.data;
}

/**
 * Whether daily digest emails are enabled for this enterprise/team
 * (`conversationNotifications` Mongo collection, root `dailyDigest` field).
 *
 * @param {string} enterpriseId
 * @param {string} teamId
 * @returns {Promise<boolean>}
 */
async function isDailyDigestEnabled(enterpriseId, teamId) {
    try {
        const doc = await conversationNotification
            .findOne({ enterpriseId, teamId })
            .select('dailyDigest config.dealerEmail')
            .lean();
        // GOTCHA: digest sends ONLY when dailyDigest is true AND dealerEmail is
        // EXPLICITLY false. A missing config.dealerEmail field === false fails,
        // so such teams are silently skipped. (Flagged in CHANGES.md as a risk.)
        return doc?.dailyDigest === true && doc?.config?.dealerEmail === false;
    } catch (err) {
        sails.log.warn(
            `[DailyDigest] Failed to load conversationNotifications for ${enterpriseId}/${teamId} — skipping digest:`,
            err.message,
        );
        return false;
    }
}

/**
 * Build after-hours config for a calendar day in the dealer timezone.
 *
 * @param {{ workingDays: object, timezone?: string }} workingDaysData
 * @param {Date} date - reference instant (digest yesterday start)
 * @param {string} [tz] - IANA timezone; defaults to API timezone
 */
function resolveAfterHoursConfig(workingDaysData, date, tz) {
    const { workingDays, timezone } = workingDaysData || {};
    const dealerTz = tz || timezone || 'UTC';
    const dayName = getLocalWeekdayName(date, dealerTz);
    const dayConf = workingDays?.[dayName];
    const isWorkingDay = !!dayConf?.is_working;

    if (!isWorkingDay) {
        return { isWorkingDay: false, startMinutes: 0, endMinutes: 0, timezone: dealerTz, dayName };
    }

    const [startH, startM] = (dayConf.start_time || '09:00').split(':').map(Number);
    const [endH, endM] = (dayConf.end_time || '17:00').split(':').map(Number);
    return {
        isWorkingDay: true,
        startMinutes: startH * 60 + startM,
        endMinutes: endH * 60 + endM,
        timezone: dealerTz,
        dayName,
        startTime: dayConf.start_time || '09:00',
        endTime: dayConf.end_time || '17:00',
    };
}

/**
 * Fetches working hours for a team and returns the after-hours config for a given date.
 *
 * @param {string} teamId
 * @param {Date}   date
 * @returns {{ isWorkingDay, startMinutes, endMinutes, timezone }}
 */
async function getAfterHoursConfig(teamId, date) {
    try {
        const data = await fetchWorkingDays(teamId);
        return resolveAfterHoursConfig(data, date, data.timezone);
    } catch (err) {
        sails.log.warn(
            `[DailyDigest] Failed to fetch working hours for ${teamId} — digest windows will use UTC:`,
            err.message,
        );
        return { isWorkingDay: true, startMinutes: 0, endMinutes: 0, timezone: 'UTC', dayName: 'unknown' };
    }
}

/**
 * User IDs opted in for digest email on this team (Mongo `conversationNotificationsUsers`).
 *
 * @param {string} enterpriseId
 * @param {string} teamId
 * @returns {Promise<Set<string>>}
 */
async function getEmailOptedInUserIds(enterpriseId, teamId) {
    try {
        const mongoose = require('mongoose');
        const docs = await mongoose.connection.db
            .collection('conversationNotificationsUsers')
            .find({
                enterpriseId,
                teamId,
                emailNotifications: true,
            })
            .project({ userId: 1 })
            .toArray();

        return new Set(
            docs.map(d => (d.userId || '').trim()).filter(Boolean),
        );
    } catch (err) {
        sails.log.warn(
            `[DailyDigest] Failed to load conversationNotificationsUsers for ${enterpriseId}/${teamId}:`,
            err.message,
        );
        return new Set();
    }
}

/**
 * Team roster with emails from user-management (reliable; query-builder
 * `conversationNotificationsUsers` returns 500 in prod).
 *
 * @param {string} enterpriseId
 * @param {string} teamId
 * @returns {Promise<object[]>}
 */
async function fetchTeamUsersWithEmail(enterpriseId, teamId) {
    const url = `${sails.config.custom.internalAPIDomain}/user-management/v1/team/get-team-users`;
    const resp = await axios.get(url, {
        params: {
            enterprise_id: enterpriseId,
            team_id:       teamId,
        },
    });
    return Array.isArray(resp.data?.data) ? resp.data.data : [];
}

/**
 * Digest recipient emails: team users from user-management, intersected with
 * Mongo users where `emailNotifications` is true.
 *
 * @param {string} enterpriseId
 * @param {string} teamId
 * @returns {Promise<string[]>}
 */
async function getDigestEmailRecipients(enterpriseId, teamId) {
    const optedInUserIds = await getEmailOptedInUserIds(enterpriseId, teamId);
    if (!optedInUserIds.size) {
        sails.log.info(
            `[DailyDigest] No users with emailNotifications enabled for ${enterpriseId}/${teamId}.`,
        );
        return [];
    }

    try {
        const users = await fetchTeamUsersWithEmail(enterpriseId, teamId);
        const emails = [
            ...new Set(
                users
                    .filter(u => optedInUserIds.has((u.user_id || '').trim()))
                    .map(u => (u.email_id || u.emailId || u.email || '').trim())
                    .filter(Boolean),
            ),
        ];
        return emails;
    } catch (err) {
        sails.log.warn(
            `[DailyDigest] Failed to fetch digest recipients (get-team-users) ${enterpriseId}/${teamId}:`,
            err.message,
        );
        return [];
    }
}

/** Local wall-clock pieces in IANA `tz` (hour 0–23). */
function getLocalWallClock(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = type => parts.find(p => p.type === type)?.value;
    const hourStr = get('hour');
    const h = hourStr === '24' ? 0 : parseInt(hourStr, 10);
    return {
        year:  get('year'),
        month: get('month'),
        day:   get('day'),
        hour:  h,
        minute: parseInt(get('minute'), 10),
    };
}

/**
 * Minute-of-day in dealer tz (for schedule checks).
 * @param {Date} date
 * @param {string} tz
 */
function getLocalMinutesSinceMidnight(date, tz) {
    const { hour, minute } = getLocalWallClock(date, tz);
    return hour * 60 + minute;
}

/**
 * Stable YYYY-MM-DD in dealer timezone (for once-per-local-day dedup).
 */
function getLocalDateKey(date, tz) {
    const { year, month, day } = getLocalWallClock(date, tz);
    return `${year}-${month}-${day}`;
}

/**
 * Fetches the team name from the query-builder API.
 * Returns the team_name string, or an empty string on failure.
 *
 * @param {string} enterpriseId
 * @param {string} teamId
 * @returns {Promise<string>}
 */
async function getTeamName(enterpriseId, teamId) {
    try {
        const url  = `${sails.config.custom.internalAPIDomain}/user-management/v1/query-builder/get`;
        const resp = await axios.post(url, {
            table:   'enterprise_team_details',
            columns: 'enterprise_id, team_id, team_name',
            filter: {
                $and: [
                    { enterprise_id: enterpriseId },
                    { team_id:       teamId },
                ],
            },
        });
        return resp.data?.data?.[0]?.team_name || '';
    } catch (err) {
        sails.log.warn(`[DailyDigest] Failed to fetch team name for ${enterpriseId}/${teamId}:`, err.message);
        return '';
    }
}

/**
 * Returns false if there is no meaningful data to report —
 * i.e. both appointments and conversations are 0.
 * Use this to skip sending an empty digest email.
 *
 * @param {{ appointments: number, conversations: number }} params
 * @returns {boolean}
 */
function hasDigestData({ appointments, conversations }) {
    return appointments > 0 || conversations > 0;
}

/**
 * Fetches working hours config and team name in parallel for a given enterprise/team.
 * When `digestReferenceDate` is set, after-hours uses that day's schedule in dealer TZ
 * (digest "yesterday"), not today's.
 *
 * @param {string} enterpriseId
 * @param {string} teamId
 * @param {Date}   [digestReferenceDate]
 * @returns {Promise<{ afterHoursCfg: object, teamName: string, dealerTz: string, workingDaysData: object }>}
 */
async function getDealerConfig(enterpriseId, teamId, digestReferenceDate) {
    const [workingDaysData, teamName] = await Promise.all([
        fetchWorkingDays(teamId).catch(err => {
            sails.log.warn(
                `[DailyDigest] Failed to fetch working hours for ${teamId}:`,
                err.message,
            );
            return { workingDays: {}, timezone: 'UTC' };
        }),
        getTeamName(enterpriseId, teamId),
    ]);
    const dealerTz = workingDaysData.timezone || 'UTC';
    const ref = digestReferenceDate || new Date();
    const afterHoursCfg = resolveAfterHoursConfig(workingDaysData, ref, dealerTz);
    return { afterHoursCfg, teamName, dealerTz, workingDaysData };
}

module.exports = {
    fetchWorkingDays,
    resolveAfterHoursConfig,
    getLocalWeekdayName,
    getAfterHoursConfig,
    getDigestEmailRecipients,
    getTeamName,
    getDealerConfig,
    isDailyDigestEnabled,
    hasDigestData,
    getLocalWallClock,
    getLocalMinutesSinceMidnight,
    getLocalDateKey,
};
