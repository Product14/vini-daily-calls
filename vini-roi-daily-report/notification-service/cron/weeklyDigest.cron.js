'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// WEEKLY DIGEST CRON  —  cron/weeklyDigest.cron.js
//
// WHAT THIS FILE DOES (plain English):
//   Same idea as the daily cron, but for the WEEKLY summary report.
//   Unlike the daily (which has separate sales vs service functions), the weekly
//   uses ONE combined function and passes sendSales/sendService flags into it.
//
// ⚠️  KNOWN BUG:  `triggerWeeklyDigestEmail` does not yet exist in
//     trigger-email-service.js. This cron will throw "not a function" when it
//     runs. Fix is tracked in PROJECT_PLAN.md Phase 3.
//
// WHEN IT RUNS:  set in config/cron.js — e.g. every Monday at 8 AM
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ This import will fail at runtime until triggerWeeklyDigestEmail is
// exported from trigger-email-service.js (Phase 3 of the project plan).
const { triggerWeeklyDigestEmail } = require('../services/trigger-email-service');

// Same eligibility bouncer as the daily cron.
// Passing { digestField: 'weeklyDigest' } makes it check the WEEKLY opt-in
// flag in MongoDB rather than the daily one.
const DigestEligibilityQuery = require('../queries/digest-eligibility.query');

// ─── Main cron function ──────────────────────────────────────────────────────
async function run() {
    sails.log.info('[WeeklyDigest] Run started');

    // ── Step 1: Get eligible dealerships for the WEEKLY cadence ─────────────
    let targets;
    try {
        // digestField: 'weeklyDigest' → reads MongoDB field `weeklyDigest: true`
        // instead of the default `dailyDigest: true`. A dealership can be on one
        // or both cadences independently.
        targets = await DigestEligibilityQuery.getDigestTargets({ digestField: 'weeklyDigest' });
    } catch (err) {
        sails.log.error('[WeeklyDigest] Failed to load onboarded digest targets:', err.message);
        return; // abort — nothing to do without the target list
    }

    // ── Step 2: Log summary ──────────────────────────────────────────────────
    const salesCount   = targets.filter(t => t.sendSales).length;
    const serviceCount = targets.filter(t => t.sendService).length;
    sails.log.info(
        `[WeeklyDigest] ${targets.length} team(s) with onboarded agents `
        + `(sales: ${salesCount}, service: ${serviceCount})`,
    );

    // ── Step 3: Process each dealership ─────────────────────────────────────
    for (const { enterpriseId, teamId, sendSales, sendService } of targets) {

        // If somehow neither flag is set (shouldn't happen given the query above,
        // but defensive coding), skip this entry entirely.
        if (!sendSales && !sendService) continue;

        try {
            // ONE call handles both sales and service sections for weekly.
            // The trigger function reads `sendSales` / `sendService` to decide
            // which content sections to include.
            await triggerWeeklyDigestEmail(enterpriseId, teamId, {
                bypassDigestSchedule: false, // respect the configured send day/time
                sendSales,                   // include the sales summary section?
                sendService,                 // include the service summary section?
            });
        } catch (err) {
            // Log per-dealer failure, keep looping — don't let one dealer
            // failure stop everyone else from getting their weekly report.
            sails.log.error(
                `[WeeklyDigest] Digest failed for ${enterpriseId}/${teamId}:`,
                err.message,
            );
        }
    } // ← end of per-dealer loop

    sails.log.info('[WeeklyDigest] Run complete');
}

module.exports = { run };
