'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// DAILY DIGEST CRON  —  cron/dailyDigest.cron.js
//
// WHAT THIS FILE DOES (plain English):
//   This is the "alarm clock" of the whole system. The Sails.js scheduler calls
//   run() once an hour. Each time it fires it:
//     1. Asks the database "which dealerships should get a report today?"
//     2. For each eligible dealership, tries to send:
//        • A Sales Daily Digest email (if they have a sales agent live)
//        • A Service Daily Digest email (if they have a service agent live)
//   Whether or not to send within this hour is decided INSIDE the trigger
//   function (it checks the dealer's local time vs their configured send hour).
//
// WHEN IT RUNS:  every hour (set in config/cron.js — look for 'dailyDigest')
// WHO CALLS IT:  Sails.js scheduler automatically on server startup
// ──────────────────────────────────────────────────────────────────────────────

// Pull in the two functions that do the actual email sending:
//   triggerDailyDigestEmail        → builds + sends the SALES report email
//   triggerServiceDailyDigestEmail → builds + sends the SERVICE report email
const {
    triggerDailyDigestEmail,
    triggerServiceDailyDigestEmail,
} = require('../services/trigger-email-service');

// Pull in the eligibility checker — this is the "bouncer" that decides which
// dealerships qualify to receive an email this run (3 gates: Mongo + ClickHouse
// + Supabase live-filter).
const DigestEligibilityQuery = require('../queries/digest-eligibility.query');

// ─── Main cron function ──────────────────────────────────────────────────────
async function run() {
    // Mark in the logs exactly when this hourly run started.
    sails.log.info('[DailyDigest] Run started');

    // ── Step 1: Get the list of dealerships to email ─────────────────────────
    // `targets` will be an array like:
    //   [{ enterpriseId: 'abc', teamId: 'xyz', sendSales: true, sendService: false }, ...]
    // One entry per dealership that cleared all three eligibility gates.
    let targets;
    try {
        targets = await DigestEligibilityQuery.getDigestTargets();
        // Default options → checks `dailyDigest` field in MongoDB
    } catch (err) {
        // If the eligibility query crashes (e.g. DB unreachable), log and abort.
        // We MUST NOT continue without knowing who to send to — we'd either
        // spam everyone or miss everyone.
        sails.log.error('[DailyDigest] Failed to load onboarded digest targets:', err.message);
        return; // ← early exit, nothing else runs this hour
    }

    // ── Step 2: Log a summary before we start sending ───────────────────────
    // Useful for monitoring — at a glance you can see how many emails are
    // about to go out and catch anomalies (e.g. suddenly 0 targets = bug).
    const salesCount   = targets.filter(t => t.sendSales).length;
    const serviceCount = targets.filter(t => t.sendService).length;
    sails.log.info(
        `[DailyDigest] ${targets.length} team(s) with onboarded agents `
        + `(sales: ${salesCount}, service: ${serviceCount})`,
    );

    // ── Step 3: Process each dealership ─────────────────────────────────────
    // We loop SEQUENTIALLY (not in parallel) so a single slow or failing
    // dealership doesn't block others — each one is wrapped in its own try/catch.
    for (const { enterpriseId, teamId, sendSales, sendService } of targets) {

        // ── Sales email ────────────────────────────────────────────────────
        // Only attempt if the eligibility query said this team has a live Sales agent.
        if (sendSales) {
            try {
                // triggerDailyDigestEmail does everything:
                //   • checks the dealer's local time vs their configured send hour
                //   • fetches yesterday's ClickHouse metrics
                //   • runs guardrails (blocks junk emails)
                //   • renders the HTML
                //   • sends to opted-in recipients
                //   • writes the outcome to Supabase roi_digest_runs
                //
                // bypassDigestSchedule: false → RESPECT the send-hour gate.
                // The function will return { sent: false } and log the reason
                // if it's too early — it does NOT throw in that case.
                await triggerDailyDigestEmail(enterpriseId, teamId, {
                    bypassDigestSchedule: false,
                });
            } catch (err) {
                // A throw here means the mail service or a query hard-crashed.
                // Log the specific team that failed, then continue to the next
                // team — a failure for one dealer must not stop all others.
                sails.log.error(
                    `[DailyDigest] Sales digest failed for ${enterpriseId}/${teamId}:`,
                    err.message,
                );
            }
        }

        // ── Service email ──────────────────────────────────────────────────
        // Same pattern — only sends if team has a live Service agent.
        if (sendService) {
            try {
                await triggerServiceDailyDigestEmail(enterpriseId, teamId, {
                    bypassDigestSchedule: false,
                });
            } catch (err) {
                sails.log.error(
                    `[DailyDigest] Service digest failed for ${enterpriseId}/${teamId}:`,
                    err.message,
                );
            }
        }
    } // ← end of per-dealer loop

    // ── Step 4: Mark run complete ────────────────────────────────────────────
    // This line in the logs confirms the cron finished without a fatal crash.
    // Absence of this line = the process died mid-loop.
    sails.log.info('[DailyDigest] Run complete');
}

// Export `run` so the Sails cron scheduler (config/cron.js) can call it.
module.exports = { run };
