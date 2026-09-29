/**
 * ROI Email-tracker "connected" gate.
 *   VITE_ROI_SUPABASE_URL
 *   VITE_ROI_SUPABASE_KEY
 * ⚠️ The roi_* tables (digest runs, live depts, config, recipients: dealer PII) are RLS-PROTECTED:
 * the anon key can NOT read them. All roi_* reads/writes go through the authenticated server
 * (/api/tracker/* + /api/recipients*, service-role key); see dataSource.ts.
 *
 * There used to be a browser Supabase client here too. Nothing imported it any more, yet building
 * it pulled all of @supabase/supabase-js into the tracker's entry bundle and started its session
 * bootstrap on every page load. Only the gate survives; create a client again only for a genuine
 * non-PII, non-RLS direct read.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

export const isSupabaseConfigured = Boolean(env.VITE_ROI_SUPABASE_URL && env.VITE_ROI_SUPABASE_KEY);
