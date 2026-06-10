'use strict';

/**
 * Shared Supabase client for the ROI daily-report service.
 *
 * Config (sails.config.custom.* with env fallback):
 *   supabaseUrl        / SUPABASE_URL
 *   supabaseServiceKey / SUPABASE_SERVICE_KEY   (service-role key; server-side only)
 *
 * Table-name overrides (optional):
 *   supabaseLiveTable        default 'roi_live_departments'
 *   supabaseConfigTable      default 'roi_rooftop_config'
 *   supabaseRecipientsTable  default 'roi_recipients'
 *   supabaseRunsTable        default 'roi_digest_runs'
 *   supabaseEngagementTable  default 'roi_engagement_events'
 */

let _client = null;

function getSupabaseClient() {
    if (_client) return _client;

    const { createClient } = require('@supabase/supabase-js');

    const url = sails.config.custom?.supabaseUrl || process.env.SUPABASE_URL;
    const key =
        sails.config.custom?.supabaseServiceKey || process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
        throw new Error(
            '[ROI] Supabase not configured — set sails.config.custom.supabaseUrl / supabaseServiceKey (or SUPABASE_URL / SUPABASE_SERVICE_KEY).',
        );
    }

    _client = createClient(url, key, { auth: { persistSession: false } });
    return _client;
}

function tableName(key, fallback) {
    return sails.config.custom?.[key] || fallback;
}

const TABLES = {
    live:        () => tableName('supabaseLiveTable', 'roi_live_departments'),
    config:      () => tableName('supabaseConfigTable', 'roi_rooftop_config'),
    recipients:  () => tableName('supabaseRecipientsTable', 'roi_recipients'),
    runs:        () => tableName('supabaseRunsTable', 'roi_digest_runs'),
    engagement:  () => tableName('supabaseEngagementTable', 'roi_engagement_events'),
};

module.exports = { getSupabaseClient, TABLES };
