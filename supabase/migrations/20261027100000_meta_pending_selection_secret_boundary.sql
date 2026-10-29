-- ===========================================================================
-- Closes the browser read path onto the Meta pending OAuth selection stash.
--
-- Plan: docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md
--   §13/§14, and the accepted advisor decision (advisor consultation 14,
--   "Ordered implementation slices", slice 1: "Pending-access boundary:
--   independent additive migration and privilege/legacy-endpoint controls.
--   No activation.").
--
-- APPLY AS supabase_admin. It is the migration role on this stack and the
-- superuser of the self-hosted image. postgres is NOT a superuser here, and a
-- REVOKE issued by a non-owner is a WARNING that changes nothing, so the
-- role this runs as is load-bearing.
--
-- ===========================================================================
--
-- WHAT WAS EXPOSED
--
-- Two owner-run scripts created the pending-selection stash:
--
--   supabase/manual-sql/20260623_facebook_pending_selections.sql
--   supabase/manual-sql/20260624_instagram_pending_selections.sql
--
-- and both shipped the same shape: `GRANT SELECT ... TO authenticated`, plus
-- a policy named "own pending fb selection read" / "own pending ig selection
-- read" that allowed SELECT to authenticated when `user_id = auth.uid()`.
--
-- The live catalog is WIDER than those scripts suggest. Measured on the
-- accepted candidate database (baseline dump of the production schemas):
--
--   policies on both tables .... exactly the two owner-SELECT policies above,
--                                 both FOR SELECT TO authenticated
--   table ACL ................... ALL for postgres, anon, authenticated and
--                                 service_role (no PUBLIC grant, no column
--                                 grant: pg_attribute.attacl is empty)
--   views / matviews ............ none depends on either table
--   functions ................... none in public references either table
--   publications ................ neither table is in any publication
--
-- So `anon` held INSERT/UPDATE/DELETE as well. RLS stopped anon from
-- reading, because no policy mentions anon, but the privilege was there and
-- RLS is not a substitute for a grant that should not exist.
--
-- THE SECRET MATERIAL IN THESE ROWS
--
--   oauth_pending_facebook_selections.provider_token
--       The Meta User token obtained by the OAuth callback exchange.
--   oauth_pending_facebook_selections.pages_json
--       Page candidate metadata (id, name, picture). As currently written it
--       carries no Page access token.
--   oauth_pending_facebook_selections.ig_standalone_json
--       Standalone Instagram candidate metadata (id, username, picture). As
--       currently written it carries no access token.
--   oauth_pending_instagram_selections.long_lived_token
--       The Meta long-lived User token.
--   oauth_pending_instagram_selections.ig_candidates_json
--       Each candidate carries `page_access_token` -- a Page access
--       credential. This is the column that makes the JSON a secret rather
--       than a projection.
--
-- HOW THE READ WAS REPRODUCED
--
-- With a real role and a real JWT, not inferred from the script text. Under
-- `SET LOCAL ROLE authenticated` with `request.jwt.claim.sub` set to the
-- row's owner, the owner's own row was returned whole, token column
-- included:
--
--   SELECT EXISTS (SELECT 1 FROM public.oauth_pending_facebook_selections
--                   WHERE provider_token = '<synthetic>');
--
-- The probe used synthetic values only and rolled back.
--
-- WHY THE BROWSER MUST NOT READ THIS
--
-- The picker endpoints are server-owned. facebook-oauth and
-- instagram-business-oauth both build their client with the service-role key
-- and apply the ownership check in code (`row.user_id !== user_id` -> 403).
-- Nothing under src/ reads these tables: the only reference outside the edge
-- functions is the maintained TypeScript type. The browser has no consumer
-- for a Meta User token or a Page access token, and a credential a browser
-- can read is a credential an injected script can read.
--
-- WHAT THIS MIGRATION DOES
--
--   * Revokes every browser and PUBLIC table privilege on both tables, and
--     every column-level grant path on both tables.
--   * Drops the policies on both tables, so RLS admits nobody who is not
--     bypassing it. No policy is recreated: there is no browser caller left.
--   * Keeps RLS enabled on both tables. FORCE ROW LEVEL SECURITY is NOT
--     enabled, so the table owner keeps its inherent access and the shape of
--     the owner path is unchanged.
--   * Narrows service_role to exactly the four operations the backend
--     performs on these tables: SELECT, INSERT, UPDATE, DELETE. TRUNCATE,
--     REFERENCES, TRIGGER and MAINTAIN are not needed by any caller and are
--     dropped.
--   * Refuses to commit if a view or materialized view already reaches either
--     pending table, including through another view or materialized view.
--     The migration does not drop or revoke that relation.
--   * Adds no column, no table, no index, no policy and no function. Nothing
--     here can read a pending row on a browser's behalf: there is no
--     SECURITY DEFINER reader and no authenticated RPC.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
--   * It is NOT column encryption. The stored values are unchanged and stay
--     plaintext. The property established here is ACCESS DENIAL, and nothing
--     more is claimed.
--   * It does NOT fix the legacy `social_accounts.account_metadata`
--     exposure. That belongs to the separate credential-mode contract and is
--     not touched here.
--   * It does NOT add the OAuth attempt / claim / receipt contracts, the
--     direct Instagram writer, or the fenced refresh entry points. This is
--     the independent first slice only, and it must be reviewable alone.
--   * It does NOT claim that the OAuth flow is protected end to end. It
--     closes one read path; it does not establish the credential authority.
--   * It does NOT touch credential mode or the collection flag. The two are
--     server-controlled switches that this slice is independent of.
--
-- ROLLBACK
--
-- The rollback of this boundary is NOT "re-grant SELECT to authenticated".
-- Re-granting it restores exactly the exposure this migration closes, so it
-- is not offered as a rollback step. If the boundary must be undone, revert
-- the migration file and apply a corrective migration that states the new
-- risk explicitly. The legacy picker endpoints keep working either way,
-- because they hold the service-role key.
--
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Preconditions. Fail closed: a missing pending table means the boundary
--    would silently not apply, which is the one outcome this must never
--    produce. There is deliberately no IF EXISTS here.
-- ---------------------------------------------------------------------------
DO $precondition$
DECLARE
  t_name text;
  t_kind "char";
BEGIN
  FOREACH t_name IN ARRAY ARRAY[
    'oauth_pending_facebook_selections',
    'oauth_pending_instagram_selections'
  ] LOOP
    IF to_regclass(format('public.%I', t_name)) IS NULL THEN
      RAISE EXCEPTION
        'pending selection boundary: public.% does not exist. Refusing to continue:'
        ' a missing pending table means the secret boundary would not apply to it.',
        t_name
        USING ERRCODE = 'undefined_table';
    END IF;

    SELECT c.relkind INTO t_kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = t_name;

    IF t_kind IS DISTINCT FROM 'r' THEN
      RAISE EXCEPTION
        'pending selection boundary: public.% exists but is not an ordinary table'
        ' (relkind=%). Refusing to continue: the boundary is defined for a'
        ' pending-selection table and would not apply to another object type.',
        t_name, coalesce(t_kind::text, '<none>')
        USING ERRCODE = 'wrong_object_type';
    END IF;
  END LOOP;
END
$precondition$;

-- ---------------------------------------------------------------------------
-- 2. Revoke the browser and PUBLIC surface.
--
--    Two separate ACLs are involved and a table-level REVOKE does not touch
--    the second one:
--
--      * pg_class.relacl   -- table-level privileges
--      * pg_attribute.attacl -- column-level privileges
--
--    Both are revoked for PUBLIC, anon and authenticated, table-level and
--    every column, so no narrower grant survives behind a wider revoked one.
--
--    PUBLIC is written as the bare keyword on purpose. It is a pseudo-role,
--    not a role named "PUBLIC": quoting it with %I would target a role that
--    does not exist and change nothing.
-- ---------------------------------------------------------------------------
DO $revoke_browser$
DECLARE
  t_name text;
  r_name text;
  c_name text;
BEGIN
  FOREACH t_name IN ARRAY ARRAY[
    'oauth_pending_facebook_selections',
    'oauth_pending_instagram_selections'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t_name);

    FOREACH r_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t_name, r_name);

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
        EXECUTE format('REVOKE ALL (%I) ON TABLE public.%I FROM %I', c_name, t_name, r_name);
      END LOOP;
    END LOOP;
  END LOOP;
END
$revoke_browser$;

-- ---------------------------------------------------------------------------
-- 3. Drop the policies.
--
--    Every policy on these two tables is dropped, not only the two known
--    owner-SELECT policies: if a baseline carried an additional browser
--    policy, leaving it would keep a path open. Dropping is safe because the
--    only remaining caller is the service role, which has BYPASSRLS, and the
--    assertions below prove that before the migration commits.
--
--    No policy is recreated. service_role does not need one, and creating a
--    browser-reachable reader is exactly what this migration exists to
--    prevent.
-- ---------------------------------------------------------------------------
DO $drop_policies$
DECLARE
  t_name text;
  p_name text;
  dropped integer := 0;
BEGIN
  FOR t_name, p_name IN
    SELECT c.relname, p.polname
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN (
         'oauth_pending_facebook_selections',
         'oauth_pending_instagram_selections'
       )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p_name, t_name);
    dropped := dropped + 1;
  END LOOP;

  RAISE NOTICE
    'pending selection boundary: dropped % policy/policies from the pending selection tables.',
    dropped;
END
$drop_policies$;

-- ---------------------------------------------------------------------------
-- 4. RLS stays enabled on both tables.
--
--    Deliberately NOT FORCE ROW LEVEL SECURITY: the table owner keeps its
--    inherent access, exactly as before this migration, and the service role
--    reaches the rows through BYPASSRLS. Forcing RLS would change the owner
--    path for no security gain here, because the browser path is already
--    closed by the revoked privileges.
-- ---------------------------------------------------------------------------
ALTER TABLE public.oauth_pending_facebook_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_pending_instagram_selections ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Narrow the service surface to what the backend actually performs.
--
--    The legacy picker endpoints use the service-role key and perform
--    SELECT (read the pending row), INSERT (stash it in the callback) and
--    DELETE (consume it after the selection). UPDATE is retained because the
--    pending-row lifecycle in the later OAuth contracts consumes rows
--    through it. TRUNCATE, REFERENCES and TRIGGER are used by no caller of
--    these two tables and are dropped.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE public.oauth_pending_facebook_selections FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.oauth_pending_facebook_selections TO service_role;

REVOKE ALL ON TABLE public.oauth_pending_instagram_selections FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.oauth_pending_instagram_selections TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Assert the boundary this migration claims, before it commits.
--
--    A migration that reports success while the boundary is not in place is
--    worse than one that fails. Each assertion below is a property the
--    migration is responsible for, so a failure rolls the whole migration
--    back and leaves the previous state visible rather than a half-closed
--    boundary.
-- ---------------------------------------------------------------------------
DO $assert_boundary$
DECLARE
  t_name text;
  r_name text;
  c_name text;
  p_name text;
  secret_cols text[];
  f_sig regprocedure;
  f_count integer := 0;
  v_exposed text;
BEGIN
  -- 6.1. Both tables exist, are ordinary tables, and RLS is enabled.
  FOREACH t_name IN ARRAY ARRAY[
    'oauth_pending_facebook_selections',
    'oauth_pending_instagram_selections'
  ] LOOP
    ASSERT (
      SELECT c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t_name
    ), format('RLS is enabled on public.%s', t_name);

    -- 6.2. No policy survives on either table, for any role.
    ASSERT NOT EXISTS (
      SELECT 1
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t_name
    ), format('no policy remains on public.%s', t_name);

    -- 6.3. No browser role and no PUBLIC holds any table privilege.
    --      Checked one privilege at a time: a comma-separated privilege list
    --      is not an unambiguous "holds none of these".
    FOREACH p_name IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
      'TRIGGER', 'MAINTAIN'
    ] LOOP
      ASSERT NOT has_table_privilege('anon', format('public.%s', t_name), p_name),
        format('anon holds no %s privilege on public.%s', p_name, t_name);
      ASSERT NOT has_table_privilege('authenticated', format('public.%s', t_name), p_name),
        format('authenticated holds no %s privilege on public.%s', p_name, t_name);
    END LOOP;

    -- 6.4. No column-level grant path survives for a browser role.
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
      FOREACH p_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        ASSERT NOT has_column_privilege(
                 'anon', format('public.%s', t_name), c_name, p_name),
          format('anon holds no %s privilege on public.%s.%s', p_name, t_name, c_name);
        ASSERT NOT has_column_privilege(
                 'authenticated', format('public.%s', t_name), c_name, p_name),
          format('authenticated holds no %s privilege on public.%s.%s', p_name, t_name, c_name);
      END LOOP;
    END LOOP;

    -- 6.5. The service role keeps exactly the four backend operations.
    FOREACH p_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      ASSERT has_table_privilege('service_role', format('public.%s', t_name), p_name),
        format('service_role keeps %s on public.%s', p_name, t_name);
    END LOOP;
    FOREACH p_name IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      ASSERT NOT has_table_privilege('service_role', format('public.%s', t_name), p_name),
        format('service_role holds no %s privilege on public.%s', p_name, t_name);
    END LOOP;

    -- 6.6. The secret columns this boundary protects are still present. A
    --      later slice may add columns; a slice that REMOVED one of these
    --      would have changed what the boundary is for.
    IF t_name = 'oauth_pending_facebook_selections' THEN
      secret_cols := ARRAY['provider_token', 'pages_json', 'ig_standalone_json'];
    ELSE
      secret_cols := ARRAY['long_lived_token', 'ig_candidates_json'];
    END IF;
    FOREACH c_name IN ARRAY secret_cols LOOP
      ASSERT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = t_name
           AND column_name = c_name
      ), format('public.%s still carries the secret column %s', t_name, c_name);
    END LOOP;
  END LOOP;

  -- 6.7. The service path this boundary depends on must exist. service_role
  --      reaches these rows by bypassing RLS; if it did not, the legacy
  --      picker endpoints would silently read nothing. Fail loudly instead.
  ASSERT (
    SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'service_role'
  ), 'service_role bypasses RLS, so the service picker path keeps working';

  -- 6.8. No view or materialized view can reach either pending table.
  --
  --      The read edge is stored on the view's _RETURN rewrite rule:
  --      pg_depend.classid = pg_rewrite, not pg_class. A nested view's rule
  --      references the inner view or materialized view, so the walk repeats.
  --      deptype 'n' is that read edge. deptype 'i' is the rule's own
  --      relation and is not an exposure. Any hit aborts the transaction.
  --      Existing views are left in place for the migration that owns them.
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
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
    INTO v_exposed
    FROM pending_reader reached
    JOIN pg_class c ON c.oid = reached.relid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('v', 'm');

  IF v_exposed IS NOT NULL THEN
    RAISE EXCEPTION
      'pending selection boundary: % exposes a pending selection relation through a view or materialized view. Refusing to continue; existing views are not dropped or revoked.',
      v_exposed
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- 6.9. No callable function exposes either pending table to a browser
  --      role. The measured catalog has none at all; this asserts that stays
  --      true rather than trusting the measurement to keep holding.
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
    ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
      format('anon cannot execute %s', f_sig);
    ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
      format('authenticated cannot execute %s', f_sig);
  END LOOP;

  RAISE NOTICE
    'pending selection boundary: verified. browser privileges revoked, policies removed,'
    ' service_role narrowed to SELECT/INSERT/UPDATE/DELETE. public functions touching the'
    ' pending tables: %.', f_count;
END
$assert_boundary$;

-- ---------------------------------------------------------------------------
-- 7. Record the boundary in the catalog, so the next reader of these tables
--    does not have to rediscover it.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.oauth_pending_facebook_selections IS
  'Short-lived Meta OAuth page-selection stash. Holds a Meta User token'
  ' (provider_token) and candidate JSON. Service-role access only: RLS is'
  ' enabled with no policies, browser and PUBLIC privileges are revoked, and'
  ' the service_role grant is limited to SELECT/INSERT/UPDATE/DELETE. Never'
  ' read this from a browser; the picker endpoints own it and check the'
  ' owner in code. See migration 20261027100000.';

COMMENT ON TABLE public.oauth_pending_instagram_selections IS
  'Short-lived Meta OAuth Instagram-selection stash. Holds a Meta long-lived'
  ' User token (long_lived_token) and candidate JSON that carries Page'
  ' access tokens (ig_candidates_json.page_access_token). Service-role access'
  ' only: RLS is enabled with no policies, browser and PUBLIC privileges are'
  ' revoked, and the service_role grant is limited to'
  ' SELECT/INSERT/UPDATE/DELETE. Never read this from a browser; the picker'
  ' endpoints own it and check the owner in code. See migration 20261027100000.';

COMMIT;
