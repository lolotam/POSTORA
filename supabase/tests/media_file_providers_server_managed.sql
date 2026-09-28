-- supabase/tests/media_file_providers_server_managed.sql
-- Provider rows are server-managed (migration 20261001090000): no
-- INSERT/UPDATE/DELETE policy or grant survives for anon/authenticated, so
-- end users can read their own rows but cannot write object_key,
-- delivery_url or status; edge functions keep writing via service_role.
-- Style: one transaction, fixtures inside, labelled S1..S7 ASSERTs,
-- expected errors in nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel
-- last. Fixture values are synthetic ('...@example.invalid'); no secrets
-- or real data.
BEGIN;
DO $$
DECLARE
  u_a uuid := 'a9a9a9a9-a9a9-49a9-89a9-a9a9a9a9a9a9';
  u_b uuid := 'b9b9b9b9-b9b9-49b9-89b9-b9b9b9b9b9b9';
  mf_a uuid := 'c9c9c9c9-c9c9-49c9-89c9-c9c9c9c9c9c9';
  prov_a uuid := 'd9d9d9d9-d9d9-49d9-89d9-d9d9d9d9d9d9';
BEGIN
  -- Fixtures as superuser (bypasses RLS). The media row is owned by A; its
  -- provider row is written the way the server writes it.
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'mfp-server-a-' || u_a::text || '@example.invalid'),
    (u_b, 'mfp-server-b-' || u_b::text || '@example.invalid');
  INSERT INTO public.media_files (id, user_id, file_path, file_type)
  VALUES (mf_a, u_a, 'mfp-server/probe.jpg', 'image');
  INSERT INTO public.media_file_providers
    (id, media_file_id, provider, object_key, delivery_url, status)
  VALUES (prov_a, mf_a, 'cloudinary', 'mfp-server/probe-key',
          'https://example.invalid/mfp-server/probe.jpg', 'ready');

  -- S1: no write policy survives on the table, for any role; the
  -- owner-scoped SELECT policy is untouched.
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public'
                       AND tablename = 'media_file_providers'
                       AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')),
    'S1 no INSERT/UPDATE/DELETE/ALL policy remains on media_file_providers';
  ASSERT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public'
                   AND tablename = 'media_file_providers'
                   AND policyname = 'Users can view own media file providers'
                   AND cmd = 'SELECT'),
    'S1 owner SELECT policy survives';

  -- S1b: the grant surface matches -- no client role can write, SELECT
  -- stays, service_role keeps full access.
  ASSERT NOT has_table_privilege('authenticated',
             'public.media_file_providers', 'INSERT'),
    'S1b authenticated cannot INSERT media_file_providers';
  ASSERT NOT has_table_privilege('authenticated',
             'public.media_file_providers', 'UPDATE'),
    'S1b authenticated cannot UPDATE media_file_providers';
  ASSERT NOT has_table_privilege('authenticated',
             'public.media_file_providers', 'DELETE'),
    'S1b authenticated cannot DELETE media_file_providers';
  ASSERT NOT has_table_privilege('anon',
             'public.media_file_providers', 'INSERT, UPDATE, DELETE'),
    'S1b anon cannot write media_file_providers';
  ASSERT has_table_privilege('authenticated',
             'public.media_file_providers', 'SELECT'),
    'S1b authenticated keeps SELECT on media_file_providers';
  ASSERT has_table_privilege('service_role',
             'public.media_file_providers', 'INSERT, UPDATE, DELETE'),
    'S1b service_role keeps write on media_file_providers';
END $$;

-- Writes + reads as owner A. SET ROLE is a statement-level command: it
-- cannot run inside a DO block.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a9a9a9a9-a9a9-49a9-89a9-a9a9a9a9a9a9',
                    'role', 'authenticated')::text, true);

DO $$
DECLARE
  mf_a uuid := 'c9c9c9c9-c9c9-49c9-89c9-c9c9c9c9c9c9';
  prov_a uuid := 'd9d9d9d9-d9d9-49d9-89d9-d9d9d9d9d9d9';
BEGIN
  -- S2: A cannot insert a provider row for their own file.
  BEGIN
    INSERT INTO public.media_file_providers
      (media_file_id, provider, object_key, status)
    VALUES (mf_a, 'openinary', 'mfp-server/evil-key', 'ready');
    RAISE EXCEPTION 'S2 failed: owner INSERT into media_file_providers accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- S3: A cannot retarget their own row's object_key. With no UPDATE
  -- policy the row is silently filtered, so assert the value is unchanged.
  UPDATE public.media_file_providers
  SET object_key = 'mfp-server/evil-key'
  WHERE id = prov_a;
  ASSERT (SELECT object_key FROM public.media_file_providers
          WHERE id = prov_a) = 'mfp-server/probe-key',
    'S3 owner UPDATE of object_key changes nothing';

  -- S4: A cannot delete their own provider row.
  DELETE FROM public.media_file_providers WHERE id = prov_a;
  ASSERT EXISTS (SELECT 1 FROM public.media_file_providers
                 WHERE id = prov_a),
    'S4 owner DELETE removes nothing';

  -- S5: A can still read their own provider rows.
  ASSERT (SELECT count(*) FROM public.media_file_providers
          WHERE media_file_id = mf_a) = 1,
    'S5 owner SELECT of own provider rows still works';
END $$;

RESET ROLE;

-- Reads as user B: A's rows stay invisible.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'b9b9b9b9-b9b9-49b9-89b9-b9b9b9b9b9b9',
                    'role', 'authenticated')::text, true);

DO $$
DECLARE
  mf_a uuid := 'c9c9c9c9-c9c9-49c9-89c9-c9c9c9c9c9c9';
BEGIN
  -- S6: B cannot see A's provider rows.
  ASSERT (SELECT count(*) FROM public.media_file_providers
          WHERE media_file_id = mf_a) = 0,
    'S6 cross-user SELECT of provider rows returns nothing';
END $$;

RESET ROLE;

-- S7: the server path still works -- a privileged write succeeds.
DO $$
DECLARE
  mf_a uuid := 'c9c9c9c9-c9c9-49c9-89c9-c9c9c9c9c9c9';
  prov_srv uuid := 'e9e9e9e9-e9e9-49e9-89e9-e9e9e9e9e9e9';
BEGIN
  INSERT INTO public.media_file_providers
    (id, media_file_id, provider, object_key, status)
  VALUES (prov_srv, mf_a, 'openinary', 'mfp-server/server-key', 'pending');
  ASSERT (SELECT object_key FROM public.media_file_providers
          WHERE id = prov_srv) = 'mfp-server/server-key',
    'S7 privileged (service) INSERT into media_file_providers succeeds';
END $$;

ROLLBACK;
\echo '=== media_file_providers_server_managed: ALL CHECKS PASSED ==='
