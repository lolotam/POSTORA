-- supabase/tests/meta_pending_selection_secret_boundary.sql
-- Pending-selection secret boundary (migration 20261027100000).
--
-- One transaction, synthetic fixtures, ROLLBACK. No provider calls and no
-- real tokens. Proves that no browser role can read the Meta pending OAuth
-- selection rows -- including the row's own owner, holding a matching JWT --
-- and that the service-role path the legacy picker endpoints use still
-- works, unchanged.
--
-- The denials are asserted as SQLSTATE 42501 (insufficient_privilege), never
-- as "zero rows returned". An RLS filter and a revoked grant are different
-- protections, and only the revoked grant is what this migration establishes:
-- a query that returned no rows would still have been a query the browser was
-- allowed to make.
--
-- No assertion here is skipped, broadened or conditional. Every one of them
-- fails the suite.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures: two owners, one pending row each, in both pending tables, plus
-- one social account so the suite can prove it deleted no account data.
--
-- The candidate JSON carries a Page access token, because that is what
-- ig_candidates_json carries in production (IgCandidate.page_access_token).
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_owner uuid := 'e2b00001-0000-4000-8000-000000000001';
  u_other uuid := 'e2b00002-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_owner, 'mpsb-owner-' || u_owner::text || '@example.invalid'),
    (u_other, 'mpsb-other-' || u_other::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token)
  VALUES
    ('e2b30001-0000-4000-8000-000000000031', u_owner, 'facebook',
     'mpsb-page', 'mpsb_page', 'synthetic-not-a-live-secret');

  INSERT INTO public.oauth_pending_facebook_selections
    (id, user_id, social_profile_id, target_platform, provider_token,
     pages_json, ig_standalone_json, created_at, expires_at)
  VALUES
    ('e2b10001-0000-4000-8000-000000000011', u_owner, NULL, 'facebook',
     'synthetic-not-a-live-secret',
     '[{"id":"mpsb-page-1","name":"MPSB Page One","has_instagram":false,"picture_url":null}]'::jsonb,
     '[]'::jsonb,
     '2026-10-27 09:00:00+00'::timestamptz,
     '2026-10-27 09:15:00+00'::timestamptz),
    ('e2b10001-0000-4000-8000-000000000012', u_other, NULL, 'instagram',
     'synthetic-not-a-live-secret',
     '[]'::jsonb,
     '[]'::jsonb,
     '2026-10-27 09:00:00+00'::timestamptz,
     '2026-10-27 09:15:00+00'::timestamptz);

  INSERT INTO public.oauth_pending_instagram_selections
    (id, user_id, social_profile_id, ig_candidates_json, long_lived_token,
     expires_in, created_at, expires_at)
  VALUES
    ('e2b20001-0000-4000-8000-000000000021', u_owner, NULL,
     '[{"ig_user_id":"mpsb-ig-1","ig_username":"mpsb_ig_one","ig_profile_picture_url":null,"facebook_page_id":"mpsb-page-1","facebook_page_name":"MPSB Page One","page_access_token":"synthetic-not-a-live-secret"}]'::jsonb,
     'synthetic-not-a-live-secret', 5184000,
     '2026-10-27 09:00:00+00'::timestamptz,
     '2026-10-27 09:15:00+00'::timestamptz),
    ('e2b20001-0000-4000-8000-000000000022', u_other, NULL,
     '[]'::jsonb,
     'synthetic-not-a-live-secret', 5184000,
     '2026-10-27 09:00:00+00'::timestamptz,
     '2026-10-27 09:15:00+00'::timestamptz);
END
$fixtures$;

-- The statement catalogue is read by the denial blocks below under a
-- restricted role, so it lives in a temp table the browser roles may read
-- and the pending tables may not.
CREATE TEMP TABLE mpsb_denied_statements (ord integer PRIMARY KEY, stmt text NOT NULL);
INSERT INTO mpsb_denied_statements (ord, stmt) VALUES
  -- whole-row reads
  (1,  'SELECT 1 FROM public.oauth_pending_facebook_selections LIMIT 1'),
  (2,  'SELECT 1 FROM public.oauth_pending_instagram_selections LIMIT 1'),
  -- the Meta User token columns
  (3,  'SELECT provider_token FROM public.oauth_pending_facebook_selections LIMIT 1'),
  (4,  'SELECT long_lived_token FROM public.oauth_pending_instagram_selections LIMIT 1'),
  -- the candidate JSON, including the one that carries a Page access token
  (5,  'SELECT pages_json FROM public.oauth_pending_facebook_selections LIMIT 1'),
  (6,  'SELECT ig_standalone_json FROM public.oauth_pending_facebook_selections LIMIT 1'),
  (7,  'SELECT ig_candidates_json FROM public.oauth_pending_instagram_selections LIMIT 1'),
  -- writes
  (8,  'INSERT INTO public.oauth_pending_facebook_selections (user_id, target_platform, provider_token) VALUES (''e2b00001-0000-4000-8000-000000000001'', ''facebook'', ''synthetic-not-a-live-secret'')'),
  (9,  'UPDATE public.oauth_pending_facebook_selections SET provider_token = ''synthetic-not-a-live-secret'' WHERE id = ''e2b10001-0000-4000-8000-000000000011'''),
  (10, 'DELETE FROM public.oauth_pending_facebook_selections WHERE id = ''e2b10001-0000-4000-8000-000000000011'''),
  (11, 'INSERT INTO public.oauth_pending_instagram_selections (user_id, long_lived_token) VALUES (''e2b00001-0000-4000-8000-000000000001'', ''synthetic-not-a-live-secret'')'),
  (12, 'UPDATE public.oauth_pending_instagram_selections SET long_lived_token = ''synthetic-not-a-live-secret'' WHERE id = ''e2b20001-0000-4000-8000-000000000021'''),
  (13, 'DELETE FROM public.oauth_pending_instagram_selections WHERE id = ''e2b20001-0000-4000-8000-000000000021'''),
  -- bulk and structural operations
  (14, 'TRUNCATE public.oauth_pending_facebook_selections'),
  (15, 'TRUNCATE public.oauth_pending_instagram_selections');
GRANT SELECT ON mpsb_denied_statements TO authenticated, anon;

-- A permanent probe table OWNED by authenticated. A temp table cannot carry
-- a foreign key to a permanent table ("constraints on temporary tables may
-- reference only temporary tables"), so the REFERENCES privilege can only be
-- exercised against a table the browser role actually owns. It is created
-- inside this transaction and disappears with the ROLLBACK.
CREATE TABLE public.mpsb_references_probe (id uuid PRIMARY KEY);
ALTER TABLE public.mpsb_references_probe OWNER TO authenticated;

-- ---------------------------------------------------------------------------
-- S1. The boundary itself: RLS kept, policies gone, browser privileges
--     revoked at table AND column level, service role narrowed.
-- ---------------------------------------------------------------------------
DO $s1$
DECLARE
  t_name text;
  p_name text;
  c_name text;
  shape text;
  owner_role text;
BEGIN
  FOREACH t_name IN ARRAY ARRAY[
    'oauth_pending_facebook_selections',
    'oauth_pending_instagram_selections'
  ] LOOP
    -- RLS stays enabled. It is the second layer, not the only one: the
    -- grant removal is the first, and neither is load-bearing alone.
    ASSERT (
      SELECT c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t_name
    ), format('S1 RLS is enabled on public.%s', t_name);

    -- The owner-SELECT policies are gone, and so is every other policy.
    ASSERT NOT EXISTS (
      SELECT 1
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t_name
    ), format('S1 no policy remains on public.%s', t_name);

    ASSERT NOT EXISTS (
      SELECT 1
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = t_name
         AND p.polname IN ('own pending fb selection read', 'own pending ig selection read')
    ), format('S1 the old owner-SELECT policy is gone from public.%s', t_name);

    -- No browser role holds any table privilege. One privilege per check,
    -- because a comma-separated privilege list is an "any of these" test.
    FOREACH p_name IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
      'TRIGGER', 'MAINTAIN'
    ] LOOP
      ASSERT NOT has_table_privilege('anon', format('public.%s', t_name), p_name),
        format('S1 anon holds no %s privilege on public.%s', p_name, t_name);
      ASSERT NOT has_table_privilege('authenticated', format('public.%s', t_name), p_name),
        format('S1 authenticated holds no %s privilege on public.%s', p_name, t_name);
      -- dashboard_user holds no explicit grant on these tables, so it stands
      -- in for "any role that only has what PUBLIC gives it". If PUBLIC had a
      -- grant, dashboard_user would have it too.
      ASSERT NOT has_table_privilege('dashboard_user', format('public.%s', t_name), p_name),
        format('S1 PUBLIC grants no %s privilege on public.%s', p_name, t_name);
    END LOOP;

    -- No PUBLIC entry survives in the table ACL either.
    ASSERT NOT EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
       WHERE n.nspname = 'public'
         AND c.relname = t_name
         AND acl.grantee = 0
    ), format('S1 the ACL of public.%s carries no PUBLIC entry', t_name);

    -- No column-level grant path survives. pg_attribute.attacl is where a
    -- column grant lives; information_schema cannot be used for this because
    -- it expands table-level grants onto every column.
    FOR c_name IN
      SELECT a.attname
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = t_name
         AND a.attnum > 0
         AND NOT a.attisdropped
    LOOP
      ASSERT NOT has_column_privilege(
               'anon', format('public.%s', t_name), c_name, 'SELECT'),
        format('S1 anon holds no SELECT on public.%s.%s', t_name, c_name);
      ASSERT NOT has_column_privilege(
               'authenticated', format('public.%s', t_name), c_name, 'SELECT'),
        format('S1 authenticated holds no SELECT on public.%s.%s', t_name, c_name);
      ASSERT NOT has_column_privilege(
               'anon', format('public.%s', t_name), c_name, 'UPDATE'),
        format('S1 anon holds no UPDATE on public.%s.%s', t_name, c_name);
      ASSERT NOT has_column_privilege(
               'authenticated', format('public.%s', t_name), c_name, 'UPDATE'),
        format('S1 authenticated holds no UPDATE on public.%s.%s', t_name, c_name);
    END LOOP;

    ASSERT NOT EXISTS (
      SELECT 1
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = t_name
         AND a.attacl IS NOT NULL
    ), format('S1 no column ACL survives on public.%s', t_name);

    -- The service role keeps exactly the four backend operations.
    FOREACH p_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      ASSERT has_table_privilege('service_role', format('public.%s', t_name), p_name),
        format('S1 service_role keeps %s on public.%s', p_name, t_name);
    END LOOP;
    FOREACH p_name IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      ASSERT NOT has_table_privilege('service_role', format('public.%s', t_name), p_name),
        format('S1 service_role holds no %s privilege on public.%s', p_name, t_name);
    END LOOP;

    -- The service path depends on the service role bypassing RLS, because the
    -- tables carry no policy at all now.
    ASSERT (
      SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'service_role'
    ), 'S1 service_role bypasses RLS';
  END LOOP;

  -- The table shape is unchanged: same columns, same order, same types, same
  -- nullability, same "has a default" answer -- with ONE addition. Migration
  -- 20261027110000_meta_oauth_attempt_lifecycle.sql appends a nullable
  -- `meta_oauth_attempt_id uuid` to each pending table, with no default and no
  -- change to any pre-existing column, so legacy rows keep their exact shape
  -- and legacy queries keep their exact result shape.
  --
  -- The appended column is matched exactly like every other column: type,
  -- nullability and the "has a default" answer are all part of the expected
  -- string. It is not filtered out of the comparison and the comparison is not
  -- weakened to tolerate its absence.
  SELECT string_agg(
           column_name || ':' || data_type || ':' || is_nullable || ':' ||
           (column_default IS NOT NULL)::text,
           ',' ORDER BY ordinal_position)
    INTO shape
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'oauth_pending_facebook_selections';
  ASSERT shape = 'id:uuid:NO:true,user_id:uuid:NO:false,social_profile_id:uuid:YES:false,target_platform:text:NO:false,provider_token:text:NO:false,pages_json:jsonb:NO:true,ig_standalone_json:jsonb:NO:true,created_at:timestamp with time zone:NO:true,expires_at:timestamp with time zone:NO:true,meta_oauth_attempt_id:uuid:YES:false',
    format('S1 the Facebook pending table shape is unchanged apart from the appended nullable attempt reference (got %s)', shape);

  SELECT string_agg(
           column_name || ':' || data_type || ':' || is_nullable || ':' ||
           (column_default IS NOT NULL)::text,
           ',' ORDER BY ordinal_position)
    INTO shape
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'oauth_pending_instagram_selections';
  ASSERT shape = 'id:uuid:NO:true,user_id:uuid:NO:false,social_profile_id:uuid:YES:false,ig_candidates_json:jsonb:NO:true,long_lived_token:text:NO:false,expires_in:integer:NO:true,created_at:timestamp with time zone:NO:true,expires_at:timestamp with time zone:NO:true,meta_oauth_attempt_id:uuid:YES:false',
    format('S1 the Instagram pending table shape is unchanged apart from the appended nullable attempt reference (got %s)', shape);

  -- The indexes and constraints are still there.
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'oauth_pending_facebook_selections'
       AND indexname = 'idx_oauth_pending_fb_expires'
  ), 'S1 the Facebook pending expiry index survives';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'oauth_pending_instagram_selections'
       AND indexname = 'idx_oauth_pending_ig_expires'
  ), 'S1 the Instagram pending expiry index survives';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname = 'oauth_pending_facebook_selections'
       AND c.contype = 'p'
  ), 'S1 the Facebook pending primary key survives';
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname = 'oauth_pending_facebook_selections'
       AND c.contype = 'f'
       AND c.confdeltype = 'c'
  ), 'S1 the Facebook pending owner foreign key survives';
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname = 'oauth_pending_facebook_selections'
       AND c.contype = 'c'
  ), 'S1 the Facebook pending target_platform check survives';

  -- The creator/owner path is untouched: the owner still holds every
  -- privilege on its own table, exactly as before the migration.
  SELECT pg_get_userbyid(c.relowner) INTO owner_role
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'oauth_pending_facebook_selections';
  FOREACH p_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    ASSERT has_table_privilege(owner_role, 'public.oauth_pending_facebook_selections', p_name),
      format('S1 the table owner keeps %s on the Facebook pending table', p_name);
  END LOOP;
END
$s1$;

-- ---------------------------------------------------------------------------
-- S2. The OWNER of a pending row, holding a matching JWT, is refused.
--
-- This is the exact read that was proven open: the owner could read its own
-- row whole, token column included. Refusal must be a privilege error, not an
-- empty result.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e2b00001-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $s2$
DECLARE
  stmt text;
  ord integer;
  v_msg text;
BEGIN
  FOR ord, stmt IN SELECT d.ord, d.stmt FROM mpsb_denied_statements d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION
        'S2 failed: the owning browser role was allowed to run statement %: %',
        ord, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        NULL;
    END;
  END LOOP;

  -- A structural path needs its own attempt: a browser role must not be
  -- able to attach a foreign key to a pending table either. The message is
  -- checked too, so a refusal for some unrelated reason cannot pass here.
  BEGIN
    EXECUTE 'ALTER TABLE public.mpsb_references_probe ADD CONSTRAINT mpsb_references_probe_fk FOREIGN KEY (id) REFERENCES public.oauth_pending_facebook_selections (id)';
    RAISE EXCEPTION 'S2 failed: a browser role attached a foreign key to the pending table'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      ASSERT v_msg LIKE '%oauth_pending_facebook_selections%',
        format('S2 the REFERENCES refusal names the pending table (got %s)', v_msg);
  END;

  BEGIN
    EXECUTE 'CREATE TRIGGER mpsb_trigger_probe BEFORE INSERT ON public.oauth_pending_facebook_selections FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
    RAISE EXCEPTION 'S2 failed: a browser role attached a trigger to the pending table'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      ASSERT v_msg LIKE '%oauth_pending_facebook_selections%',
        format('S2 the TRIGGER refusal names the pending table (got %s)', v_msg);
  END;
END
$s2$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S3. A FOREIGN owner, holding their own matching JWT, is refused too.
--
-- Before the migration the RLS policy made the row invisible to them. The
-- point of asserting the privilege error here is that it no longer depends
-- on whose row it is.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e2b00002-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $s3$
DECLARE
  stmt text;
  ord integer;
BEGIN
  FOR ord, stmt IN SELECT d.ord, d.stmt FROM mpsb_denied_statements d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION
        'S3 failed: a foreign browser role was allowed to run statement %: %',
        ord, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        NULL;
    END;
  END LOOP;
END
$s3$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S4. The anonymous browser role is refused as well. It held ALL on both
--     tables before this migration; RLS was the only thing between it and a
--     read, and an RLS filter is not a grant.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role', 'anon', true);

DO $s4$
DECLARE
  stmt text;
  ord integer;
BEGIN
  FOR ord, stmt IN SELECT d.ord, d.stmt FROM mpsb_denied_statements d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION
        'S4 failed: the anonymous role was allowed to run statement %: %',
        ord, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        NULL;
    END;
  END LOOP;
END
$s4$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S5. The table owner still reads its own table. The creator's path is not
--     what this migration changes.
-- ---------------------------------------------------------------------------
DO $s5$
DECLARE
  owner_role text;
  seen integer;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_role
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'oauth_pending_facebook_selections';

  EXECUTE format('SET LOCAL ROLE %I', owner_role);
  -- Prove the role switch actually took effect inside this block, so the
  -- reads below are genuinely the owner path and not the session user.
  ASSERT current_user = owner_role,
    format('S5 the block is running as the table owner (current_user=%s, owner=%s)',
      current_user, owner_role);

  SELECT count(*) INTO seen
    FROM public.oauth_pending_facebook_selections
   WHERE id = 'e2b10001-0000-4000-8000-000000000011';
  ASSERT seen = 1,
    format('S5 the table owner (%s) can still read the Facebook pending row', owner_role);

  SELECT count(*) INTO seen
    FROM public.oauth_pending_instagram_selections
   WHERE id = 'e2b20001-0000-4000-8000-000000000021';
  ASSERT seen = 1,
    format('S5 the table owner (%s) can still read the Instagram pending row', owner_role);
  EXECUTE 'RESET ROLE';
END
$s5$;

-- ---------------------------------------------------------------------------
-- S6. The legacy service-owned picker path still works, using the exact
--     query shapes the two edge functions issue.
--
--     facebook-oauth        loadPendingSelection  (SELECT ... WHERE id = ?)
--                          stash                 (INSERT ... RETURNING id)
--                          consume               (DELETE ... WHERE id = ?)
--     instagram-business-oauth
--                          get_pending_selection (SELECT ... WHERE id = ?)
--                          store_ig_account      (SELECT ... WHERE id = ?)
--                          clear_pending_selection (DELETE ... WHERE id = ? AND user_id = ?)
-- ---------------------------------------------------------------------------
DO $s6$
DECLARE
  fb_id uuid;
  ig_id uuid;
  row_user uuid;
  row_expires timestamptz;
  row_token text;
  deleted integer;
BEGIN
  SET LOCAL ROLE service_role;
  -- Prove the role switch took effect: the roundtrip below must be the
  -- service path, not the superuser session path.
  ASSERT current_user = 'service_role',
    format('S6 the block is running as service_role (current_user=%s)', current_user);

  -- stash: INSERT ... RETURNING id
  INSERT INTO public.oauth_pending_facebook_selections
    (user_id, social_profile_id, target_platform, provider_token, pages_json, ig_standalone_json)
  VALUES
    ('e2b00001-0000-4000-8000-000000000001', NULL, 'facebook',
     'synthetic-not-a-live-secret',
     '[]'::jsonb, '[]'::jsonb)
  RETURNING id INTO fb_id;
  ASSERT fb_id IS NOT NULL, 'S6 the service role can stash a Facebook pending row';

  INSERT INTO public.oauth_pending_instagram_selections
    (user_id, social_profile_id, ig_candidates_json, long_lived_token, expires_in)
  VALUES
    ('e2b00001-0000-4000-8000-000000000001', NULL,
     '[]'::jsonb, 'synthetic-not-a-live-secret', 5184000)
  RETURNING id INTO ig_id;
  ASSERT ig_id IS NOT NULL, 'S6 the service role can stash an Instagram pending row';

  -- loadPendingSelection
  SELECT user_id, expires_at, provider_token
    INTO row_user, row_expires, row_token
    FROM public.oauth_pending_facebook_selections
   WHERE id = fb_id;
  ASSERT row_user = 'e2b00001-0000-4000-8000-000000000001',
    'S6 the Facebook picker read returns the owner the endpoint compares against';
  ASSERT row_expires IS NOT NULL, 'S6 the Facebook picker read still carries expires_at';
  ASSERT row_token = 'synthetic-not-a-live-secret',
    'S6 the Facebook picker read still carries the provider token';

  -- get_pending_selection / store_ig_account
  SELECT user_id, expires_at, long_lived_token
    INTO row_user, row_expires, row_token
    FROM public.oauth_pending_instagram_selections
   WHERE id = ig_id;
  ASSERT row_user = 'e2b00001-0000-4000-8000-000000000001',
    'S6 the Instagram picker read returns the owner the endpoint compares against';
  ASSERT row_expires IS NOT NULL, 'S6 the Instagram picker read still carries expires_at';
  ASSERT row_token = 'synthetic-not-a-live-secret',
    'S6 the Instagram picker read still carries the long-lived token';

  -- UPDATE is retained for the pending-row lifecycle.
  UPDATE public.oauth_pending_facebook_selections
     SET expires_at = '2026-10-27 10:15:00+00'::timestamptz
   WHERE id = fb_id;
  SELECT expires_at INTO row_expires
    FROM public.oauth_pending_facebook_selections
   WHERE id = fb_id;
  ASSERT row_expires = '2026-10-27 10:15:00+00'::timestamptz,
    'S6 the service role can update a pending row expiry';

  -- clear_pending_selection is owner filtered: it must remove exactly the
  -- caller's own row and nobody else's.
  DELETE FROM public.oauth_pending_instagram_selections
   WHERE id = ig_id
     AND user_id = 'e2b00001-0000-4000-8000-000000000001';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  ASSERT deleted = 1, 'S6 the owner-filtered delete removed exactly one row';

  DELETE FROM public.oauth_pending_instagram_selections
   WHERE id = ig_id
     AND user_id = 'e2b00002-0000-4000-8000-000000000002';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  ASSERT deleted = 0,
    'S6 the owner-filtered delete removed nothing when the owner does not match';

  -- consume: DELETE ... WHERE id = ?
  DELETE FROM public.oauth_pending_facebook_selections WHERE id = fb_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  ASSERT deleted = 1, 'S6 the service role can consume a pending row';

  RESET ROLE;
END
$s6$;

-- ---------------------------------------------------------------------------
-- S7. Nothing was deleted or rewritten by the boundary. The other owner's
--     rows, their expiry, their tokens, and the social account are all still
--     exactly as the fixtures wrote them.
-- ---------------------------------------------------------------------------
DO $s7$
DECLARE
  seen integer;
  seen_expires timestamptz;
  seen_token text;
  seen_candidate jsonb;
BEGIN
  ASSERT (
    SELECT count(*) FROM public.oauth_pending_facebook_selections
     WHERE id = 'e2b10001-0000-4000-8000-000000000011'
  ) = 1, 'S7 the owner Facebook pending row survives';

  SELECT expires_at, provider_token INTO seen_expires, seen_token
    FROM public.oauth_pending_facebook_selections
   WHERE id = 'e2b10001-0000-4000-8000-000000000011';
  ASSERT seen_expires = '2026-10-27 09:15:00+00'::timestamptz,
    'S7 the owner Facebook pending expiry is unchanged';
  ASSERT seen_token = 'synthetic-not-a-live-secret',
    'S7 the owner Facebook pending token is unchanged';

  SELECT count(*) INTO seen
    FROM public.oauth_pending_facebook_selections
   WHERE id = 'e2b10001-0000-4000-8000-000000000012';
  ASSERT seen = 1, 'S7 the other owner Facebook pending row survives';

  SELECT count(*) INTO seen
    FROM public.oauth_pending_instagram_selections
   WHERE id = 'e2b20001-0000-4000-8000-000000000021';
  ASSERT seen = 1, 'S7 the owner Instagram pending row survives';

  SELECT expires_at, long_lived_token, ig_candidates_json
    INTO seen_expires, seen_token, seen_candidate
    FROM public.oauth_pending_instagram_selections
   WHERE id = 'e2b20001-0000-4000-8000-000000000021';
  ASSERT seen_expires = '2026-10-27 09:15:00+00'::timestamptz,
    'S7 the owner Instagram pending expiry is unchanged';
  ASSERT seen_token = 'synthetic-not-a-live-secret',
    'S7 the owner Instagram pending token is unchanged';
  ASSERT seen_candidate->0->>'page_access_token' = 'synthetic-not-a-live-secret',
    'S7 the Page access credential inside the candidate JSON is unchanged';

  SELECT count(*) INTO seen
    FROM public.oauth_pending_instagram_selections
   WHERE id = 'e2b20001-0000-4000-8000-000000000022';
  ASSERT seen = 1, 'S7 the other owner Instagram pending row survives';

  SELECT count(*) INTO seen
    FROM public.social_accounts
   WHERE id = 'e2b30001-0000-4000-8000-000000000031';
  ASSERT seen = 1, 'S7 the social account survives';

  SELECT access_token INTO seen_token
    FROM public.social_accounts
   WHERE id = 'e2b30001-0000-4000-8000-000000000031';
  ASSERT seen_token = 'synthetic-not-a-live-secret',
    'S7 the social account credential is unchanged';
END
$s7$;

-- ---------------------------------------------------------------------------
-- S8. Reader audit.
--
--     A view or materialized view that reaches either pending table is an
--     exposure, including one reached only through another view. The read
--     edge lives on pg_rewrite (deptype 'n'), and the walk below is the same
--     one migration 20261027100000 uses. The clean catalog has no such
--     relation. The seeded controls prove a leak is detected and that an
--     unrelated view is not.
--
--     A public function may read the pending tables. The next lifecycle
--     slice needs a service-only function for that. What it may not do is
--     be executable by anon or authenticated. Grants to PUBLIC count as
--     anon's privilege, so a default EXECUTE grant is a browser grant.
--     The function's name is not the boundary.
-- ---------------------------------------------------------------------------

-- Same walk as migration 20261027100000 section 6.8. pg_temp keeps this
-- helper out of the public function scan.
CREATE FUNCTION pg_temp.mpsb_pending_relation_readers()
RETURNS TABLE (view_schema name, view_name name, view_kind "char")
LANGUAGE sql
STABLE
AS $readers$
  WITH RECURSIVE pending_reader AS (
    SELECT rel.oid AS relid
      FROM pg_class rel
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname IN (
         'oauth_pending_facebook_selections',
         'oauth_pending_instagram_selections'
       )
    UNION
    SELECT DISTINCT view_rel.oid
      FROM pending_reader src
      JOIN pg_depend dep
        ON dep.refclassid = 'pg_class'::regclass
       AND dep.refobjid = src.relid
       AND dep.classid = 'pg_rewrite'::regclass
       AND dep.deptype = 'n'
      JOIN pg_rewrite rule ON rule.oid = dep.objid
      JOIN pg_class view_rel ON view_rel.oid = rule.ev_class
     WHERE view_rel.relkind IN ('v', 'm')
       AND view_rel.oid <> src.relid
  )
  SELECT n.nspname, c.relname, c.relkind
    FROM pending_reader reached
    JOIN pg_class c ON c.oid = reached.relid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('v', 'm')
$readers$;

-- The failing messages below are the diagnostics. A bare "%" in format()
-- raises "unterminated format() type specifier" instead of naming the
-- function, which is how an exposed reader used to look like a test bug.
CREATE PROCEDURE pg_temp.mpsb_assert_pending_function_boundary()
LANGUAGE plpgsql
AS $boundary$
DECLARE
  f_sig regprocedure;
BEGIN
  FOR f_sig IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (
         p.prosrc ILIKE '%oauth_pending_facebook_selections%'
         OR p.prosrc ILIKE '%oauth_pending_instagram_selections%'
       )
     ORDER BY n.nspname, p.proname, p.oid
  LOOP
    ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
      format('S8 anon cannot execute %s', f_sig);
    ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
      format('S8 authenticated cannot execute %s', f_sig);
  END LOOP;
END
$boundary$;

DO $s8$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_temp.mpsb_pending_relation_readers()
  ), 'S8 no view or materialized view exposes the pending selection tables';

  CALL pg_temp.mpsb_assert_pending_function_boundary();

  ASSERT NOT EXISTS (
    SELECT 1
      FROM pg_publication_rel pr
      JOIN pg_class c ON c.oid = pr.prrelid
     WHERE c.relname IN (
       'oauth_pending_facebook_selections',
       'oauth_pending_instagram_selections'
     )
  ), 'S8 neither pending table is in a publication';
END
$s8$;

-- ---------------------------------------------------------------------------
-- S8a. A service-only function may read the pending table. Its name contains
--      "pending_selection", which the old blanket name check rejected.
--      Default privileges grant EXECUTE to anon and authenticated, so those
--      grants are revoked before the function is treated as backend-only.
--      The body returns a count, not the token.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.mpsb_pending_selection_service_probe()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$SELECT count(*) FROM public.oauth_pending_facebook_selections$$;

REVOKE ALL ON FUNCTION public.mpsb_pending_selection_service_probe()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mpsb_pending_selection_service_probe()
  TO service_role;

DO $s8a$
DECLARE
  seen bigint;
  f_count integer := 0;
  f_sig regprocedure;
BEGIN
  ASSERT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'mpsb_pending_selection_service_probe'
       AND p.proname ILIKE '%pending%selection%'
  ), 'S8a the service-only probe is a pending-selection function';

  -- The boundary call is the same procedure the clean catalog just passed.
  -- It must still pass once this function exists.
  CALL pg_temp.mpsb_assert_pending_function_boundary();

  FOR f_sig IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (
         p.prosrc ILIKE '%oauth_pending_facebook_selections%'
         OR p.prosrc ILIKE '%oauth_pending_instagram_selections%'
       )
  LOOP
    f_count := f_count + 1;
  END LOOP;
  ASSERT f_count >= 1,
    'S8a a service-only pending reader is allowed when the browser cannot execute it';

  ASSERT NOT has_function_privilege(
           'anon', 'public.mpsb_pending_selection_service_probe()'::regprocedure, 'EXECUTE'),
    'S8a anon holds no EXECUTE on the service-only probe';
  ASSERT NOT has_function_privilege(
           'authenticated', 'public.mpsb_pending_selection_service_probe()'::regprocedure, 'EXECUTE'),
    'S8a authenticated holds no EXECUTE on the service-only probe';
  ASSERT NOT has_function_privilege(
           'public', 'public.mpsb_pending_selection_service_probe()'::regprocedure, 'EXECUTE'),
    'S8a PUBLIC holds no EXECUTE on the service-only probe';
  ASSERT has_function_privilege(
           'service_role', 'public.mpsb_pending_selection_service_probe()'::regprocedure, 'EXECUTE'),
    'S8a service_role keeps EXECUTE on the service-only probe';

  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.mpsb_pending_selection_service_probe();
    RAISE EXCEPTION 'S8a anon executed the service-only function'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      NULL;
  END;
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.mpsb_pending_selection_service_probe();
    RAISE EXCEPTION 'S8a authenticated executed the service-only function'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      NULL;
  END;
  RESET ROLE;

  SET LOCAL ROLE service_role;
  ASSERT current_user = 'service_role',
    format('S8a the service call is running as service_role (current_user=%s)', current_user);
  SELECT public.mpsb_pending_selection_service_probe() INTO seen;
  ASSERT seen = 2,
    format('S8a service_role read the pending row count (got %s)', seen);
  RESET ROLE;
END
$s8a$;

DROP FUNCTION public.mpsb_pending_selection_service_probe();

-- ---------------------------------------------------------------------------
-- S8b. An anon-executable definer that returns the token is a real read, and
--      the boundary's failing branch must name the function. The message is
--      the privilege diagnostic, not a format() error.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.mpsb_exposed_anon_probe()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT provider_token
    FROM public.oauth_pending_facebook_selections
   WHERE id = 'e2b10001-0000-4000-8000-000000000011'
$$;

REVOKE ALL ON FUNCTION public.mpsb_exposed_anon_probe()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mpsb_exposed_anon_probe() TO anon;

DO $s8b$
DECLARE
  seen text;
  v_msg text;
  refused boolean := false;
BEGIN
  SET LOCAL ROLE anon;
  ASSERT current_user = 'anon',
    format('S8b the exposed read is running as anon (current_user=%s)', current_user);
  SELECT public.mpsb_exposed_anon_probe() INTO seen;
  ASSERT seen = 'synthetic-not-a-live-secret',
    format('S8b anon read the synthetic token through the exposed function (got %s)', seen);
  RESET ROLE;

  BEGIN
    CALL pg_temp.mpsb_assert_pending_function_boundary();
    RAISE EXCEPTION 'S8b the anon-exposed function produced no refusal'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  EXCEPTION
    WHEN assert_failure THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      refused := true;
      ASSERT v_msg LIKE '%S8 anon cannot execute%mpsb_exposed_anon_probe%',
        format('S8b the anon refusal names the function (got %s)', v_msg);
      ASSERT position('unterminated format' IN v_msg) = 0
         AND position('too few arguments' IN v_msg) = 0,
        format('S8b the anon refusal is the privilege diagnostic (got %s)', v_msg);
  END;
  ASSERT refused, 'S8b the anon-exposed function was refused';
END
$s8b$;

DROP FUNCTION public.mpsb_exposed_anon_probe();

-- ---------------------------------------------------------------------------
-- S8c. The authenticated failing branch is separate. anon must not hold
--      EXECUTE, or the anon assertion fires first and this message never runs.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.mpsb_exposed_authenticated_probe()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT provider_token
    FROM public.oauth_pending_facebook_selections
   WHERE id = 'e2b10001-0000-4000-8000-000000000011'
$$;

REVOKE ALL ON FUNCTION public.mpsb_exposed_authenticated_probe()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mpsb_exposed_authenticated_probe() TO authenticated;

DO $s8c$
DECLARE
  seen text;
  v_msg text;
  refused boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'e2b00001-0000-4000-8000-000000000001', true);
  ASSERT current_user = 'authenticated',
    format('S8c the exposed read is running as authenticated (current_user=%s)', current_user);
  SELECT public.mpsb_exposed_authenticated_probe() INTO seen;
  ASSERT seen = 'synthetic-not-a-live-secret',
    format('S8c authenticated read the synthetic token through the exposed function (got %s)', seen);
  RESET ROLE;

  ASSERT NOT has_function_privilege(
           'anon', 'public.mpsb_exposed_authenticated_probe()'::regprocedure, 'EXECUTE'),
    'S8c anon holds no EXECUTE, so the authenticated branch is the one that fails';

  BEGIN
    CALL pg_temp.mpsb_assert_pending_function_boundary();
    RAISE EXCEPTION 'S8c the authenticated-exposed function produced no refusal'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  EXCEPTION
    WHEN assert_failure THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      refused := true;
      ASSERT v_msg LIKE '%S8 authenticated cannot execute%mpsb_exposed_authenticated_probe%',
        format('S8c the authenticated refusal names the function (got %s)', v_msg);
      ASSERT position('unterminated format' IN v_msg) = 0
         AND position('too few arguments' IN v_msg) = 0,
        format('S8c the authenticated refusal is the privilege diagnostic (got %s)', v_msg);
  END;
  ASSERT refused, 'S8c the authenticated-exposed function was refused';
END
$s8c$;

DROP FUNCTION public.mpsb_exposed_authenticated_probe();

-- ---------------------------------------------------------------------------
-- S8d. Direct definer view. authenticated can read the token through the
--      view and still cannot read the table. The exposure walk has to see
--      the view, or a later clean-catalog check would stay green.
-- ---------------------------------------------------------------------------
CREATE VIEW public.mpsb_direct_leak AS
  SELECT user_id, provider_token AS bearer
    FROM public.oauth_pending_facebook_selections;
GRANT SELECT ON public.mpsb_direct_leak TO authenticated;

DO $s8d$
DECLARE
  seen integer;
  v_exposed text;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'e2b00001-0000-4000-8000-000000000001', true);
  ASSERT current_user = 'authenticated',
    format('S8d the view read is running as authenticated (current_user=%s)', current_user);
  SELECT count(*) INTO seen
    FROM public.mpsb_direct_leak
   WHERE user_id = 'e2b00001-0000-4000-8000-000000000001'
     AND bearer = 'synthetic-not-a-live-secret';
  ASSERT seen = 1,
    format('S8d authenticated read the synthetic token through the direct view (got %s)', seen);
  BEGIN
    PERFORM 1 FROM public.oauth_pending_facebook_selections LIMIT 1;
    RAISE EXCEPTION 'S8d the pending table became readable to authenticated'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      NULL;
  END;
  RESET ROLE;

  ASSERT EXISTS (
    SELECT 1
      FROM pg_temp.mpsb_pending_relation_readers()
     WHERE view_schema = 'public'
       AND view_name = 'mpsb_direct_leak'
       AND view_kind = 'v'
  ), 'S8d the exposure walk detects the direct view';

  SELECT string_agg(format('%I.%I', view_schema, view_name), ', ' ORDER BY view_schema, view_name)
    INTO v_exposed
    FROM pg_temp.mpsb_pending_relation_readers();
  ASSERT v_exposed LIKE '%mpsb_direct_leak%',
    format('S8d the exposure diagnostic names the direct view (got %s)', v_exposed);
END
$s8d$;

DROP VIEW public.mpsb_direct_leak;

-- ---------------------------------------------------------------------------
-- S8e. Nested view in another schema. The outer view is the only granted
--      relation. A walk that stops at a direct public pg_class dependency
--      does not see it, and authenticated still receives the token.
-- ---------------------------------------------------------------------------
CREATE VIEW public.mpsb_inner_leak AS
  SELECT user_id, provider_token AS bearer
    FROM public.oauth_pending_facebook_selections;
-- supabase_admin's default privileges grant new public relations to anon
-- and authenticated. Take that back on the inner view so only the outer
-- grant is the browser path.
REVOKE ALL ON TABLE public.mpsb_inner_leak FROM PUBLIC, anon, authenticated;
CREATE SCHEMA mpsb_other;
CREATE VIEW mpsb_other.mpsb_outer_leak AS
  SELECT bearer FROM public.mpsb_inner_leak;
GRANT USAGE ON SCHEMA mpsb_other TO authenticated;
GRANT SELECT ON mpsb_other.mpsb_outer_leak TO authenticated;

DO $s8e$
DECLARE
  seen integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'e2b00001-0000-4000-8000-000000000001', true);
  BEGIN
    PERFORM 1 FROM public.mpsb_inner_leak LIMIT 1;
    RAISE EXCEPTION 'S8e the inner view was selectable by authenticated'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      NULL;
  END;
  SELECT count(*) INTO seen
    FROM mpsb_other.mpsb_outer_leak
   WHERE bearer = 'synthetic-not-a-live-secret';
  ASSERT seen = 2,
    format('S8e authenticated read the synthetic token through the nested view (got %s)', seen);
  RESET ROLE;

  ASSERT EXISTS (
    SELECT 1 FROM pg_temp.mpsb_pending_relation_readers()
     WHERE view_schema = 'public' AND view_name = 'mpsb_inner_leak'
  ), 'S8e the exposure walk detects the inner view';
  ASSERT EXISTS (
    SELECT 1 FROM pg_temp.mpsb_pending_relation_readers()
     WHERE view_schema = 'mpsb_other' AND view_name = 'mpsb_outer_leak'
  ), 'S8e the exposure walk detects the nested view outside public';
END
$s8e$;

DROP VIEW mpsb_other.mpsb_outer_leak;
DROP VIEW public.mpsb_inner_leak;
DROP SCHEMA mpsb_other;

-- ---------------------------------------------------------------------------
-- S8f. Materialized view, then a view over it. Both relkinds are on the
--      path. The granted relation is the outer view.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW public.mpsb_mat_leak AS
  SELECT user_id, provider_token AS bearer
    FROM public.oauth_pending_facebook_selections;
-- Same default-privilege grant as a table. The browser path under test is
-- the view over this materialized view, not the materialized view itself.
REVOKE ALL ON TABLE public.mpsb_mat_leak FROM PUBLIC, anon, authenticated;
CREATE VIEW public.mpsb_over_mat_leak AS
  SELECT bearer FROM public.mpsb_mat_leak;
GRANT SELECT ON public.mpsb_over_mat_leak TO authenticated;

DO $s8f$
DECLARE
  seen integer;
BEGIN
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO seen
    FROM public.mpsb_over_mat_leak
   WHERE bearer = 'synthetic-not-a-live-secret';
  ASSERT seen = 2,
    format('S8f authenticated read the synthetic token through the view over the materialized view (got %s)', seen);
  BEGIN
    PERFORM 1 FROM public.mpsb_mat_leak LIMIT 1;
    RAISE EXCEPTION 'S8f the materialized view itself was selectable by authenticated'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      NULL;
  END;
  RESET ROLE;

  ASSERT EXISTS (
    SELECT 1 FROM pg_temp.mpsb_pending_relation_readers()
     WHERE view_schema = 'public' AND view_name = 'mpsb_mat_leak' AND view_kind = 'm'
  ), 'S8f the exposure walk detects the materialized view';
  ASSERT EXISTS (
    SELECT 1 FROM pg_temp.mpsb_pending_relation_readers()
     WHERE view_schema = 'public' AND view_name = 'mpsb_over_mat_leak' AND view_kind = 'v'
  ), 'S8f the exposure walk detects the view over the materialized view';
END
$s8f$;

DROP VIEW public.mpsb_over_mat_leak;
DROP MATERIALIZED VIEW public.mpsb_mat_leak;

-- ---------------------------------------------------------------------------
-- S8g. An unrelated view is not an exposure. After the leak fixtures are
--      gone, the clean-catalog checks pass again.
-- ---------------------------------------------------------------------------
CREATE VIEW public.mpsb_unrelated_view AS SELECT 1 AS n;

DO $s8g$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_temp.mpsb_pending_relation_readers()
     WHERE view_name = 'mpsb_unrelated_view'
  ), 'S8g an unrelated view is not an exposure';
END
$s8g$;

DROP VIEW public.mpsb_unrelated_view;

DO $s8_clear$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_temp.mpsb_pending_relation_readers()
  ), 'S8 the exposure walk is clear after the leak fixtures are removed';
  CALL pg_temp.mpsb_assert_pending_function_boundary();
END
$s8_clear$;

RESET ROLE;

ROLLBACK;

\echo '=== meta_pending_selection_secret_boundary: ALL CHECKS PASSED ==='
