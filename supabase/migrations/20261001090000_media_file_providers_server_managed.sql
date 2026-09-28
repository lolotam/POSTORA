-- Server-managed media_file_providers writes.
--
-- WHY: provider rows are authoritative delete-side state (object_key,
-- delivery_url, status). The delete path acts on the object named by
-- object_key using credentials held server-side, so whoever can write those
-- columns controls which stored object gets destroyed. Every legitimate
-- writer is an edge function holding the service role (e.g. cloudinary-upload
-- writes provider rows through its admin client; the frontend only reads
-- them via embedded selects), and service_role bypasses RLS entirely -- so
-- owner-scoped write policies grant no legitimate capability while widening
-- the writer set beyond the server. This migration therefore makes the
-- server the sole writer: it drops every INSERT/UPDATE/DELETE policy on
-- public.media_file_providers and revokes those privileges from anon and
-- authenticated. SELECT visibility is unchanged, and service_role keeps full
-- access.

-- Named owner write policies first, so the intent reads explicitly even
-- though the DO block below would catch them as well.
DROP POLICY IF EXISTS "Users can insert own media file providers"
  ON public.media_file_providers;
DROP POLICY IF EXISTS "Users can update own media file providers"
  ON public.media_file_providers;

-- Then every other write policy on the table, found by command rather than
-- by name so renames and future additions cannot slip through. A FOR ALL
-- policy reports cmd 'ALL' in pg_policies; SELECT policies are untouched.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'media_file_providers'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.media_file_providers',
      r.policyname
    );
  END LOOP;
END
$$;

-- Grants are the second layer: with no write policy left, RLS already
-- refuses authenticated/anon writes, but least-privilege grants make the
-- table's surface explicit instead of relying on policy absence alone.
-- SELECT grants are left as they are; service_role keeps full access.
REVOKE INSERT, UPDATE, DELETE ON public.media_file_providers FROM anon, authenticated;
GRANT ALL ON public.media_file_providers TO service_role;
