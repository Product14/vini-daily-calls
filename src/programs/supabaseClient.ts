import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Programs dashboard uses its own Supabase project (separate from the VIN
// tracker DB). Publishable key is client-safe; tables have RLS disabled for
// the first cut — see src/programs/schema.sql.
const URL = import.meta.env.VITE_PROGRAMS_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_PROGRAMS_SUPABASE_KEY as string | undefined;

let client: SupabaseClient | null = null;
export function getProgramsClient(): SupabaseClient | null {
  if (!URL || !KEY) return null;
  if (!client) {
    client = createClient(URL, KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}
export const PROGRAMS_DB_CONFIGURED = Boolean(URL && KEY);
