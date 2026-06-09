import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * ROI Email-tracker Supabase client. Reads the roi_* tables (digest runs, live
 * departments, rooftop config, recipients) from the ROI Supabase project —
 * separate from the VIN tracker / programs projects.
 *   VITE_ROI_SUPABASE_URL
 *   VITE_ROI_SUPABASE_KEY   (publishable / anon — browser-safe)
 * When unset, the tracker falls back to mock data (see dataSource.ts).
 * ⚠️ roi_digest_runs holds dealer PII — gate reads behind Supabase Auth + RLS in production.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const url = env.VITE_ROI_SUPABASE_URL;
const anonKey = env.VITE_ROI_SUPABASE_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, { auth: { persistSession: true } })
  : null;
