-- RLS fix — run this in the Supabase SQL editor.
-- The schema.sql originally tried to DISABLE RLS, but Supabase enabled it
-- anyway. This snippet adds permissive policies so the publishable client
-- key can read + write. First-cut only — tighten when we move to a wider
-- audience and proxy writes through the Express server with the service-role
-- key.

-- programs_account_state
DROP POLICY IF EXISTS "programs_state_all" ON programs_account_state;
CREATE POLICY "programs_state_all" ON programs_account_state
  FOR ALL
  TO anon, authenticated
  USING (true) WITH CHECK (true);

-- programs_tasks
DROP POLICY IF EXISTS "programs_tasks_all" ON programs_tasks;
CREATE POLICY "programs_tasks_all" ON programs_tasks
  FOR ALL
  TO anon, authenticated
  USING (true) WITH CHECK (true);
