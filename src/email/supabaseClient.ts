import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * ROI Email-tracker Supabase client (publishable / anon key — browser-safe).
 *   VITE_ROI_SUPABASE_URL
 *   VITE_ROI_SUPABASE_KEY
 * isSupabaseConfigured (below) is the tracker's "connected" gate.
 * ⚠️ The roi_* tables (digest runs, live depts, config, recipients — dealer PII) are RLS-PROTECTED:
 * this anon key can NO LONGER read them. All roi_* reads/writes go through the authenticated
 * server (/api/tracker/* + /api/recipients*, service-role key) — see dataSource.ts. This client
 * remains only for the few non-PII, non-RLS uses that still read directly.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const url = env.VITE_ROI_SUPABASE_URL;
const anonKey = env.VITE_ROI_SUPABASE_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, { auth: { persistSession: true } })
  : null;
