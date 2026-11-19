-- supabase/tests/youtube_refresh_lease.sql
-- YouTube token refresh DB lease (migration 20261120110000).
--
-- Synthetic fixtures, no provider calls, no real tokens. Denials are asserted
-- as SQLSTATE 42501 (insufficient_privilege), never as "zero rows returned".
--
-- Blocks L1-L8 run in a single transaction that rolls back.
-- Block L9 commits synthetic fixtures so two dblink sessions can race on the
-- same account row, and deletes those fixtures explicitly before exiting.

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

BEGIN;

CREATE TEMP TABLE yrl_state (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON yrl_state TO PUBLIC;

DO $fixtures$
DECLARE
  u_owner uuid := '0ed00001-0000-4000-8000-000000000001';
  w_owner uuid := '0ed10001-0000-4000-8000-000000000001';
  c_comp  uuid := '0ed15001-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (u_owner, 'yrl-owner-' || u_owner::text || '@example.invalid');

  INSERT INTO public.workspaces (id, owner_id, name, is_personal)
  VALUES (w_owner, u_owner, 'YRL Personal', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.connector_connections (
    id, workspace_id, connector_type, toolkit, composio_auth_config_id, external_account_id, status
  )
  VALUES (c_comp, w_owner, 'youtube', 'youtube', 'ac-yrl', 'ext-yrl', 'active');

  INSERT INTO public.social_accounts (
    id, user_id, workspace_id, platform, platform_user_id, platform_username,
    access_token, refresh_token, token_expires_at, is_active, auth_provider,
    connection_id, needs_reauth, failure_count, account_metadata
  )
  VALUES
    (
      '0ed20001-0000-4000-8000-000000000011',
      u_owner, w_owner, 'youtube', 'UC-yrl-native', 'yrl-native',
      'access-initial', 'refresh-initial',
      clock_timestamp() - interval '10 minutes', true, 'native',
      NULL, false, 0, '{"channel_title":"My Channel"}'::jsonb
    ),
    (
      '0ed20002-0000-4000-8000-000000000012',
      u_owner, w_owner, 'youtube', 'UC-yrl-composio', 'yrl-composio',
      NULL, NULL, NULL, true, 'composio',
      c_comp, false, 0, '{}'::jsonb
    ),
    (
      '0ed20003-0000-4000-8000-000000000013',
      u_owner, w_owner, 'facebook', 'fb-yrl-1', 'yrl-fb',
      'fb-access', NULL, clock_timestamp() + interval '1 hour', true, 'native',
      NULL, false, 0, '{}'::jsonb
    );
END
$fixtures$;

-- ---------------------------------------------------------------------------
-- L1. Acquire happy path, live contention refusal, and argument validation.
-- ---------------------------------------------------------------------------
DO $l1$
DECLARE
  a_yt       uuid := '0ed20001-0000-4000-8000-000000000011';
  a_composio uuid := '0ed20002-0000-4000-8000-000000000012';
  a_fb       uuid := '0ed20003-0000-4000-8000-000000000013';
  a_missing  uuid := '0ed2ffff-0000-4000-8000-00000000ffff';
  r1 jsonb;
  r2 jsonb;
  r_bad jsonb;
  v_row public.youtube_token_refresh_leases%ROWTYPE;
BEGIN
  -- Validation refusals leave no row behind.
  r_bad := public.acquire_youtube_refresh_lease(NULL, 60);
  ASSERT r_bad = '{"ok": false, "reason": "invalid_request"}'::jsonb,
    format('L1 NULL account refused: got %s', r_bad);

  r_bad := public.acquire_youtube_refresh_lease(a_yt, 4);
  ASSERT r_bad = '{"ok": false, "reason": "invalid_request"}'::jsonb,
    format('L1 ttl below min refused: got %s', r_bad);

  r_bad := public.acquire_youtube_refresh_lease(a_yt, 601);
  ASSERT r_bad = '{"ok": false, "reason": "invalid_request"}'::jsonb,
    format('L1 ttl above max refused: got %s', r_bad);

  r_bad := public.acquire_youtube_refresh_lease(a_missing, 60);
  ASSERT r_bad = '{"ok": false, "reason": "account_not_found"}'::jsonb,
    format('L1 missing account refused: got %s', r_bad);

  r_bad := public.acquire_youtube_refresh_lease(a_fb, 60);
  ASSERT r_bad = '{"ok": false, "reason": "invalid_account"}'::jsonb,
    format('L1 non-youtube account refused: got %s', r_bad);

  r_bad := public.acquire_youtube_refresh_lease(a_composio, 60);
  ASSERT r_bad = '{"ok": false, "reason": "invalid_account"}'::jsonb,
    format('L1 composio youtube account refused: got %s', r_bad);

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.youtube_token_refresh_leases
     WHERE social_account_id IN (a_yt, a_composio, a_fb, a_missing)
  ), 'L1 refused acquires left no lease rows';

  -- First acquire wins.
  r1 := public.acquire_youtube_refresh_lease(a_yt, 60);
  ASSERT (r1 ->> 'ok')::boolean IS TRUE, format('L1 acquire succeeded: got %s', r1);
  ASSERT (r1 ->> 'lease_token')::uuid IS NOT NULL, 'L1 returns a UUID lease_token';
  ASSERT (r1 ->> 'expires_at')::timestamptz > clock_timestamp() + interval '50 seconds',
    'L1 expires_at honors ttl';

  SELECT * INTO v_row FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt;
  ASSERT FOUND AND v_row.lease_token = (r1 ->> 'lease_token')::uuid,
    'L1 lease row matches returned token';

  -- Second acquire while live is refused and does not mutate the live lease.
  r2 := public.acquire_youtube_refresh_lease(a_yt, 60);
  ASSERT (r2 ->> 'ok')::boolean IS FALSE AND r2 ->> 'reason' = 'lease_held',
    format('L1 live lease blocks contender: got %s', r2);
  ASSERT NOT (r2 ? 'lease_token'), 'L1 refusal never leaks holder token';
  ASSERT (SELECT lease_token FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt)
         = (r1 ->> 'lease_token')::uuid,
    'L1 refused contender did not alter the live lease';

  INSERT INTO yrl_state VALUES ('l1', r1);
END
$l1$;

-- ---------------------------------------------------------------------------
-- L2. Release by wrong token does nothing; release by matching token clears.
-- ---------------------------------------------------------------------------
DO $l2$
DECLARE
  a_yt uuid := '0ed20001-0000-4000-8000-000000000011';
  v_tok uuid := (SELECT (v ->> 'lease_token')::uuid FROM yrl_state WHERE k = 'l1');
  v_wrong uuid := gen_random_uuid();
BEGIN
  ASSERT NOT public.release_youtube_refresh_lease(a_yt, v_wrong),
    'L2 wrong token release returns false';
  ASSERT NOT public.release_youtube_refresh_lease(a_yt, NULL),
    'L2 NULL token release returns false';
  ASSERT NOT public.release_youtube_refresh_lease(NULL, v_tok),
    'L2 NULL account release returns false';

  ASSERT (SELECT lease_token FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt)
         = v_tok,
    'L2 live lease survives wrong-token release';

  ASSERT public.release_youtube_refresh_lease(a_yt, v_tok),
    'L2 matching token release returns true';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt),
    'L2 matching release deleted the row';
  ASSERT NOT public.release_youtube_refresh_lease(a_yt, v_tok),
    'L2 second release is a no-op returning false';
END
$l2$;

-- ---------------------------------------------------------------------------
-- L3. Expiry takeover: an expired lease is replaced by a new holder.
-- ---------------------------------------------------------------------------
DO $l3$
DECLARE
  a_yt uuid := '0ed20001-0000-4000-8000-000000000011';
  r1 jsonb;
  r2 jsonb;
  t1 uuid;
  t2 uuid;
BEGIN
  r1 := public.acquire_youtube_refresh_lease(a_yt, 30);
  ASSERT (r1 ->> 'ok')::boolean IS TRUE, 'L3 initial acquire succeeds';
  t1 := (r1 ->> 'lease_token')::uuid;

  UPDATE public.youtube_token_refresh_leases
     SET acquired_at = clock_timestamp() - interval '2 minutes',
         expires_at  = clock_timestamp() - interval '1 minute'
   WHERE social_account_id = a_yt;

  r2 := public.acquire_youtube_refresh_lease(a_yt, 60);
  ASSERT (r2 ->> 'ok')::boolean IS TRUE, format('L3 expired lease taken over: got %s', r2);
  t2 := (r2 ->> 'lease_token')::uuid;
  ASSERT t2 <> t1, 'L3 takeover mints a new lease_token';
  ASSERT (SELECT lease_token FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt)
         = t2,
    'L3 table holds the new holder token';

  INSERT INTO yrl_state VALUES ('l3_stale', jsonb_build_object('lease_token', t1));
  INSERT INTO yrl_state VALUES ('l3_live', r2);
END
$l3$;

-- ---------------------------------------------------------------------------
-- L4. Lease-fenced token store: stale/expired/missing rejected; valid writes
--     atomically, preserves refresh_token when omitted, preserves unrelated
--     account_metadata keys, and releases the lease.
-- ---------------------------------------------------------------------------
DO $l4$
DECLARE
  a_yt      uuid := '0ed20001-0000-4000-8000-000000000011';
  t_stale   uuid := (SELECT (v ->> 'lease_token')::uuid FROM yrl_state WHERE k = 'l3_stale');
  t_live    uuid := (SELECT (v ->> 'lease_token')::uuid FROM yrl_state WHERE k = 'l3_live');
  v_future  timestamptz := clock_timestamp() + interval '1 hour';
  v_future2 timestamptz := clock_timestamp() + interval '2 hours';
  r jsonb;
  v_acc public.social_accounts%ROWTYPE;
BEGIN
  -- Stale holder (t1 after t2 took over) writes NOTHING.
  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t_stale, 'access-from-stale', v_future, 'refresh-from-stale', ARRAY['scope.stale']
  );
  ASSERT r = '{"ok": false, "reason": "stale_lease"}'::jsonb,
    format('L4 stale holder rejected: got %s', r);
  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.access_token = 'access-initial' AND v_acc.refresh_token = 'refresh-initial',
    'L4 stale holder wrote nothing to social_accounts';

  -- Expired lease (even with the matching token) writes NOTHING.
  UPDATE public.youtube_token_refresh_leases
     SET acquired_at = clock_timestamp() - interval '2 minutes',
         expires_at  = clock_timestamp() - interval '1 second'
   WHERE social_account_id = a_yt;

  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t_live, 'access-from-expired', v_future, NULL, NULL
  );
  ASSERT r = '{"ok": false, "reason": "lease_expired"}'::jsonb,
    format('L4 expired lease rejected: got %s', r);
  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.access_token = 'access-initial', 'L4 expired holder wrote nothing';

  -- Release and verify missing-lease rejection.
  ASSERT public.release_youtube_refresh_lease(a_yt, t_live), 'L4 cleanup expired lease';
  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t_live, 'access-no-lease', v_future, NULL, NULL
  );
  ASSERT r = '{"ok": false, "reason": "lease_not_held"}'::jsonb,
    format('L4 missing lease rejected: got %s', r);

  -- Acquire fresh lease and commit WITHOUT a new refresh_token: stored refresh_token is kept.
  UPDATE public.social_accounts
     SET needs_reauth = true, failure_count = 2, last_refresh_error = 'old error'
   WHERE id = a_yt;

  t_live := (public.acquire_youtube_refresh_lease(a_yt, 60) ->> 'lease_token')::uuid;
  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t_live, 'access-fresh-1', v_future, NULL,
    ARRAY['https://www.googleapis.com/auth/youtube.upload']
  );
  ASSERT (r ->> 'ok')::boolean IS TRUE, format('L4 valid write succeeded: got %s', r);

  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.access_token = 'access-fresh-1', 'L4 access_token updated';
  ASSERT v_acc.refresh_token = 'refresh-initial', 'L4 omitted refresh_token preserved stored value';
  ASSERT v_acc.token_expires_at = v_future, 'L4 token_expires_at updated';
  ASSERT v_acc.needs_reauth IS FALSE AND v_acc.failure_count = 0 AND v_acc.last_refresh_error IS NULL,
    'L4 health columns reset on success';
  ASSERT v_acc.account_metadata ->> 'channel_title' = 'My Channel',
    'L4 unrelated account_metadata preserved';
  ASSERT v_acc.account_metadata -> 'granted_scopes' = '["https://www.googleapis.com/auth/youtube.upload"]'::jsonb,
    'L4 granted_scopes merged';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt),
    'L4 commit atomically released the lease';

  -- Replaying the consumed lease token is rejected.
  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t_live, 'access-replay', v_future2, NULL, NULL
  );
  ASSERT r = '{"ok": false, "reason": "lease_not_held"}'::jsonb,
    'L4 consumed lease cannot be reused for a second write';

  -- Fresh lease WITH a rotated refresh_token updates it.
  t_live := (public.acquire_youtube_refresh_lease(a_yt, 60) ->> 'lease_token')::uuid;
  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t_live, 'access-fresh-2', v_future2, 'refresh-rotated', NULL
  );
  ASSERT (r ->> 'ok')::boolean IS TRUE, 'L4 rotated refresh_token write succeeded';
  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.refresh_token = 'refresh-rotated', 'L4 rotated refresh_token stored';
END
$l4$;

-- ---------------------------------------------------------------------------
-- L5. Lease-fenced failure recording: stale/expired rejected; invalid_grant
--     sets needs_reauth once (transitioned=true then false).
-- ---------------------------------------------------------------------------
DO $l5$
DECLARE
  a_yt   uuid := '0ed20001-0000-4000-8000-000000000011';
  t1     uuid;
  t2     uuid;
  r      jsonb;
  v_acc  public.social_accounts%ROWTYPE;
BEGIN
  -- Missing lease refused.
  r := public.record_youtube_refresh_failure_with_lease(
    a_yt, gen_random_uuid(), 'YouTube refresh failed: invalid_grant', true
  );
  ASSERT r = '{"ok": false, "reason": "lease_not_held"}'::jsonb,
    format('L5 missing lease refused: got %s', r);

  t1 := (public.acquire_youtube_refresh_lease(a_yt, 60) ->> 'lease_token')::uuid;

  -- Wrong token refused and does not touch needs_reauth or failure_count.
  r := public.record_youtube_refresh_failure_with_lease(
    a_yt, gen_random_uuid(), 'YouTube refresh failed: invalid_grant', true
  );
  ASSERT r = '{"ok": false, "reason": "stale_lease"}'::jsonb,
    format('L5 stale failure refused: got %s', r);
  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.needs_reauth IS FALSE AND v_acc.failure_count = 0,
    'L5 stale failure wrote nothing';

  -- Valid holder records invalid_grant -> needs_reauth transitions false -> true once.
  r := public.record_youtube_refresh_failure_with_lease(
    a_yt, t1, 'YouTube refresh failed: invalid_grant', true
  );
  ASSERT (r ->> 'ok')::boolean IS TRUE
     AND (r ->> 'needs_reauth')::boolean IS TRUE
     AND (r ->> 'transitioned')::boolean IS TRUE,
    format('L5 first invalid_grant transitioned needs_reauth: got %s', r);
  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.needs_reauth IS TRUE AND v_acc.failure_count = 1,
    'L5 account marked needs_reauth';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt),
    'L5 failure commit released the lease';

  -- Second invalid_grant does NOT report a second transition.
  t2 := (public.acquire_youtube_refresh_lease(a_yt, 60) ->> 'lease_token')::uuid;
  r := public.record_youtube_refresh_failure_with_lease(
    a_yt, t2, 'YouTube refresh failed: invalid_grant', true
  );
  ASSERT (r ->> 'ok')::boolean IS TRUE
     AND (r ->> 'needs_reauth')::boolean IS TRUE
     AND (r ->> 'transitioned')::boolean IS FALSE,
    format('L5 repeat invalid_grant does not double-transition: got %s', r);
END
$l5$;

-- ---------------------------------------------------------------------------
-- L5b. Reconnect fence (migration 20261120130000): a credential-changing
--      UPDATE of a youtube row deletes its lease, so a refresh started under
--      the OLD credentials is fenced out of the new connection. Health-only
--      updates keep the lease, and a normal refresh still works.
-- ---------------------------------------------------------------------------
DO $l5b$
DECLARE
  a_yt   uuid := '0ed20001-0000-4000-8000-000000000011';
  a_fb   uuid := '0ed20003-0000-4000-8000-000000000013';
  t      uuid;
  r      jsonb;
  v_acc  public.social_accounts%ROWTYPE;
BEGIN
  -- Deterministic baseline: the earlier blocks left refreshed credentials and
  -- needs_reauth behind; normalize to a clean connected account.
  UPDATE public.social_accounts
     SET access_token = 'access-initial', refresh_token = 'refresh-initial',
         needs_reauth = false, failure_count = 0, last_refresh_error = NULL
   WHERE id = a_yt;
  DELETE FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt;

  -- 1) Success path: reconnect between acquire and store fences the holder.
  t := (public.acquire_youtube_refresh_lease(a_yt, 60) ->> 'lease_token')::uuid;
  ASSERT t IS NOT NULL, 'L5b lease acquired for the success-path fence';

  UPDATE public.social_accounts
     SET access_token = 'access-reconnected', refresh_token = 'refresh-reconnected'
   WHERE id = a_yt;

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt
  ), 'L5b reconnect update deleted the lease row';

  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t, 'access-from-stale', clock_timestamp() + interval '1 hour',
    'refresh-from-stale', NULL
  );
  ASSERT r = '{"ok": false, "reason": "lease_not_held"}'::jsonb,
    format('L5b stale holder on the success path refused: got %s', r);

  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.access_token = 'access-reconnected'
     AND v_acc.refresh_token = 'refresh-reconnected',
    'L5b stale holder wrote nothing onto the reconnected credentials';

  -- 2) invalid_grant path: a stale holder must not escalate onto the new
  --    connection either.
  UPDATE public.social_accounts
     SET needs_reauth = false, failure_count = 0
   WHERE id = a_yt;
  t := (public.acquire_youtube_refresh_lease(a_yt, 60) ->> 'lease_token')::uuid;

  UPDATE public.social_accounts
     SET access_token = 'access-reconnected-2'
   WHERE id = a_yt;

  r := public.record_youtube_refresh_failure_with_lease(
    a_yt, t, 'YouTube refresh failed: invalid_grant', true
  );
  ASSERT r = '{"ok": false, "reason": "lease_not_held"}'::jsonb,
    format('L5b stale holder on the invalid_grant path refused: got %s', r);

  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.needs_reauth IS FALSE AND v_acc.failure_count = 0,
    'L5b stale holder escalated nothing onto the new connection';

  -- 3) A refresh_token-only change fences too (a re-consent that returns no
  --    new access text still rotates the grant).
  t := (public.acquire_youtube_refresh_lease(a_yt, 60) ->> 'lease_token')::uuid;
  UPDATE public.social_accounts
     SET refresh_token = 'refresh-rotated-by-reconnect'
   WHERE id = a_yt;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt
  ), 'L5b refresh_token-only change deleted the lease row';
  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t, 'access-from-stale', clock_timestamp() + interval '1 hour', NULL, NULL
  );
  ASSERT r = '{"ok": false, "reason": "lease_not_held"}'::jsonb,
    format('L5b stale holder after refresh_token rotation refused: got %s', r);

  -- 4) A health-only update keeps the lease, and a normal refresh still works
  --    under the trigger (the store UPDATE fires it; the sequence stays safe).
  t := (public.acquire_youtube_refresh_lease(a_yt, 60) ->> 'lease_token')::uuid;
  UPDATE public.social_accounts SET needs_reauth = true WHERE id = a_yt;
  ASSERT EXISTS (
    SELECT 1 FROM public.youtube_token_refresh_leases
     WHERE social_account_id = a_yt AND lease_token = t
  ), 'L5b health-only update must not delete the lease';

  r := public.store_youtube_refreshed_token_with_lease(
    a_yt, t, 'access-normal-refresh', clock_timestamp() + interval '1 hour',
    NULL, NULL
  );
  ASSERT (r ->> 'ok')::boolean IS TRUE,
    format('L5b normal refresh works with the fence installed: got %s', r);
  SELECT * INTO v_acc FROM public.social_accounts WHERE id = a_yt;
  ASSERT v_acc.access_token = 'access-normal-refresh' AND v_acc.needs_reauth IS FALSE,
    'L5b normal refresh stored its token and cleared health';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt
  ), 'L5b the store sequence still releases the lease';

  -- 5) A non-youtube credential change is untouched by the fence: the UPDATE
  --    must simply succeed (the WHEN guard scopes the trigger to youtube).
  UPDATE public.social_accounts SET access_token = 'fb-rotated' WHERE id = a_fb;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = a_fb
  ), 'L5b facebook row holds no lease by construction';

  -- Cleanup the baseline lease state for the remaining blocks.
  DELETE FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt;
END
$l5b$;

-- ---------------------------------------------------------------------------
-- L6. Structural security boundary: RLS on, zero policies, zero PUBLIC grants
--     (aclexplode grantee = 0), SECURITY DEFINER and search_path pinned.
--     Extended with the reconnect fence trigger (migration 20261120130000).
-- ---------------------------------------------------------------------------
DO $l6$
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.youtube_token_refresh_leases'::regclass),
    'L6 RLS is enabled on youtube_token_refresh_leases';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'youtube_token_refresh_leases'),
    'L6 no RLS policy exists on youtube_token_refresh_leases';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
     WHERE c.oid = 'public.youtube_token_refresh_leases'::regclass
       AND x.grantee = 0),
    'L6 PUBLIC holds no table privilege';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid IN (
       'public.acquire_youtube_refresh_lease(uuid, integer)'::regprocedure,
       'public.release_youtube_refresh_lease(uuid, uuid)'::regprocedure,
       'public.store_youtube_refreshed_token_with_lease(uuid, uuid, text, timestamptz, text, text[])'::regprocedure,
       'public.record_youtube_refresh_failure_with_lease(uuid, uuid, text, boolean, integer, timestamptz)'::regprocedure)
       AND x.grantee = 0),
    'L6 PUBLIC holds no EXECUTE on any lease RPC';
  ASSERT (SELECT bool_and(COALESCE(p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig), false))
            FROM pg_proc p
           WHERE p.oid IN (
             'public.acquire_youtube_refresh_lease(uuid, integer)'::regprocedure,
             'public.release_youtube_refresh_lease(uuid, uuid)'::regprocedure,
             'public.store_youtube_refreshed_token_with_lease(uuid, uuid, text, timestamptz, text, text[])'::regprocedure,
             'public.record_youtube_refresh_failure_with_lease(uuid, uuid, text, boolean, integer, timestamptz)'::regprocedure)),
    'L6 every lease RPC is SECURITY DEFINER with search_path=public, pg_temp';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.social_accounts'::regclass
       AND tgname = 'trg_social_accounts_youtube_credential_revoke_refresh_lease'
       AND NOT tgisinternal
  ), 'L6 the reconnect fence trigger must exist on social_accounts';
  ASSERT (
    SELECT position('UPDATE OF access_token, refresh_token' in pg_get_triggerdef(t.oid)) > 0
       AND position('IS DISTINCT FROM' in pg_get_triggerdef(t.oid)) > 0
       AND position('youtube' in pg_get_triggerdef(t.oid)) > 0
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.social_accounts'::regclass
       AND t.tgname = 'trg_social_accounts_youtube_credential_revoke_refresh_lease'
  ), 'L6 the fence must fire on actual credential change of youtube rows only';
  ASSERT (
    SELECT p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig)
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.social_accounts'::regclass
       AND t.tgname = 'trg_social_accounts_youtube_credential_revoke_refresh_lease'
  ), 'L6 the fence function must be SECURITY DEFINER with pinned search_path';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid = 'public.delete_youtube_refresh_lease_on_credential_change()'::regprocedure
       AND x.grantee IN (0,
         (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
         (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'))
  ), 'L6 browser roles and PUBLIC hold no EXECUTE on the fence function';
END
$l6$;

-- ---------------------------------------------------------------------------
-- L7. Browser roles (owner authenticated + anon) are denied everywhere with
--     SQLSTATE 42501.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE yrl_denied (ord int PRIMARY KEY, stmt text NOT NULL) ON COMMIT DROP;
GRANT ALL ON yrl_denied TO PUBLIC;
INSERT INTO yrl_denied VALUES
  (1, 'SELECT count(*) FROM public.youtube_token_refresh_leases'),
  (2, 'INSERT INTO public.youtube_token_refresh_leases (social_account_id, lease_token, expires_at) '
      'VALUES (''0ed20001-0000-4000-8000-000000000011'', gen_random_uuid(), clock_timestamp() + interval ''1 minute'')'),
  (3, 'UPDATE public.youtube_token_refresh_leases SET expires_at = clock_timestamp()'),
  (4, 'DELETE FROM public.youtube_token_refresh_leases'),
  (5, 'SELECT public.acquire_youtube_refresh_lease(''0ed20001-0000-4000-8000-000000000011'', 60)'),
  (6, 'SELECT public.release_youtube_refresh_lease(''0ed20001-0000-4000-8000-000000000011'', gen_random_uuid())'),
  (7, 'SELECT public.store_youtube_refreshed_token_with_lease(''0ed20001-0000-4000-8000-000000000011'', gen_random_uuid(), ''x'', clock_timestamp() + interval ''1 hour'')'),
  (8, 'SELECT public.record_youtube_refresh_failure_with_lease(''0ed20001-0000-4000-8000-000000000011'', gen_random_uuid(), ''err'', true)');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '0ed00001-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $l7a$
DECLARE
  stmt text;
  n integer;
BEGIN
  FOR n, stmt IN SELECT d.ord, d.stmt FROM yrl_denied d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION 'L7 failed: authenticated ran statement %: %', n, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
END
$l7a$;

RESET ROLE;

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role', 'anon', true);

DO $l7b$
DECLARE
  stmt text;
  n integer;
BEGIN
  FOR n, stmt IN SELECT d.ord, d.stmt FROM yrl_denied d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION 'L7 failed: anon ran statement %: %', n, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
END
$l7b$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- L8. service_role runs the RPCs and reads the table, but cannot write the
--     table directly.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $l8$
DECLARE
  a_yt uuid := '0ed20001-0000-4000-8000-000000000011';
  r jsonb;
  v_tok uuid;
BEGIN
  r := public.acquire_youtube_refresh_lease(a_yt, 60);
  ASSERT (r ->> 'ok')::boolean IS TRUE, 'L8 service_role acquires lease';
  v_tok := (r ->> 'lease_token')::uuid;
  ASSERT (SELECT count(*) FROM public.youtube_token_refresh_leases WHERE social_account_id = a_yt) = 1,
    'L8 service_role reads the lease table';
  ASSERT public.release_youtube_refresh_lease(a_yt, v_tok), 'L8 service_role releases lease';

  BEGIN
    INSERT INTO public.youtube_token_refresh_leases (social_account_id, lease_token, expires_at)
    VALUES (a_yt, gen_random_uuid(), clock_timestamp() + interval '1 minute');
    RAISE EXCEPTION 'L8 service_role inserted directly' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    UPDATE public.youtube_token_refresh_leases SET expires_at = clock_timestamp();
    RAISE EXCEPTION 'L8 service_role updated directly' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    DELETE FROM public.youtube_token_refresh_leases;
    RAISE EXCEPTION 'L8 service_role deleted directly' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END
$l8$;

RESET ROLE;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- L9. Real two-session concurrent acquire races via dblink.
--     Committed fixtures are required for cross-session visibility and are
--     cleaned up explicitly at the end of this block.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email)
VALUES ('0ed90001-0000-4000-8000-000000000001', 'yrl-race@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts (
  id, user_id, platform, platform_user_id, platform_username,
  access_token, refresh_token, token_expires_at, is_active, auth_provider
)
VALUES (
  '0ed90002-0000-4000-8000-000000000002',
  '0ed90001-0000-4000-8000-000000000001',
  'youtube', 'UC-yrl-race', 'yrl-race',
  'race-access', 'race-refresh', clock_timestamp() - interval '5 minutes', true, 'native'
)
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.youtube_token_refresh_leases
 WHERE social_account_id = '0ed90002-0000-4000-8000-000000000002';

SELECT extensions.dblink_connect(
  'yrl_a',
  format('dbname=%s user=%s application_name=yrl_race_a', current_database(), current_user)
);
SELECT extensions.dblink_connect(
  'yrl_b',
  format('dbname=%s user=%s application_name=yrl_race_b', current_database(), current_user)
);

DO $l9_race1$
DECLARE
  a_race uuid := '0ed90002-0000-4000-8000-000000000002';
  r_a jsonb;
  r_b jsonb;
  v_a_pid integer;
  v_b_pid integer;
  v_deadline timestamptz;
BEGIN
  -- Race 1: fresh acquire (no existing lease row).
  -- Session A acquires inside an open transaction and holds the row lock.
  PERFORM extensions.dblink_exec('yrl_a', 'BEGIN');
  SELECT res INTO r_a
    FROM extensions.dblink(
      'yrl_a',
      format('SELECT public.acquire_youtube_refresh_lease(%L::uuid, 60)', a_race)
    ) AS t(res jsonb);
  ASSERT (r_a ->> 'ok')::boolean IS TRUE, format('L9 race1 A acquired: got %s', r_a);

  SELECT pid INTO v_a_pid
    FROM extensions.dblink('yrl_a', 'SELECT pg_backend_pid()') AS t(pid int);
  SELECT pid INTO v_b_pid
    FROM extensions.dblink('yrl_b', 'SELECT pg_backend_pid()') AS t(pid int);

  -- Session B starts acquiring concurrently and MUST block on A's lock. The
  -- block is required to be real and attributable: pg_blocking_pids must name
  -- A as B's blocker on a bounded deadline BEFORE A commits. A busy-only
  -- check could pass on request-formatting lag; this cannot.
  PERFORM extensions.dblink_send_query(
    'yrl_b',
    format('SELECT public.acquire_youtube_refresh_lease(%L::uuid, 60)', a_race)
  );
  v_deadline := clock_timestamp() + interval '5 seconds';
  WHILE clock_timestamp() < v_deadline LOOP
    EXIT WHEN v_a_pid = ANY (pg_blocking_pids(v_b_pid));
    PERFORM pg_sleep(0.05);
  END LOOP;
  ASSERT v_a_pid = ANY (pg_blocking_pids(v_b_pid)),
    'L9 race1 A must appear as B blocker before commit';

  -- Commit A; B unblocks and MUST see A's live lease and be refused.
  PERFORM extensions.dblink_exec('yrl_a', 'COMMIT');
  SELECT res INTO r_b FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);
  PERFORM * FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);

  ASSERT (r_b ->> 'ok')::boolean IS FALSE AND r_b ->> 'reason' = 'lease_held',
    format('L9 race1 B must lose with lease_held: got %s', r_b);
  ASSERT (SELECT lease_token FROM public.youtube_token_refresh_leases WHERE social_account_id = a_race)
         = (r_a ->> 'lease_token')::uuid,
    'L9 race1 table holds winner A token';
END
$l9_race1$;

-- Backdate the committed lease outside the DO block so dblink sessions see
-- the committed expiry without blocking on our own transaction.
UPDATE public.youtube_token_refresh_leases
   SET acquired_at = clock_timestamp() - interval '2 minutes',
       expires_at  = clock_timestamp() - interval '1 minute'
 WHERE social_account_id = '0ed90002-0000-4000-8000-000000000002';

DO $l9_race2$
DECLARE
  a_race uuid := '0ed90002-0000-4000-8000-000000000002';
  v_prev_tok uuid;
  r_a2 jsonb;
  r_b2 jsonb;
  v_a_pid integer;
  v_b_pid integer;
  v_deadline timestamptz;
BEGIN
  SELECT lease_token INTO v_prev_tok
    FROM public.youtube_token_refresh_leases
   WHERE social_account_id = a_race;

  -- Race 2: expired-lease takeover under contention.
  PERFORM extensions.dblink_exec('yrl_a', 'BEGIN');
  SELECT res INTO r_a2
    FROM extensions.dblink(
      'yrl_a',
      format('SELECT public.acquire_youtube_refresh_lease(%L::uuid, 60)', a_race)
    ) AS t(res jsonb);
  ASSERT (r_a2 ->> 'ok')::boolean IS TRUE
     AND (r_a2 ->> 'lease_token')::uuid <> v_prev_tok,
    format('L9 race2 A took over expired lease: got %s', r_a2);

  SELECT pid INTO v_a_pid
    FROM extensions.dblink('yrl_a', 'SELECT pg_backend_pid()') AS t(pid int);
  SELECT pid INTO v_b_pid
    FROM extensions.dblink('yrl_b', 'SELECT pg_backend_pid()') AS t(pid int);

  PERFORM extensions.dblink_send_query(
    'yrl_b',
    format('SELECT public.acquire_youtube_refresh_lease(%L::uuid, 60)', a_race)
  );
  v_deadline := clock_timestamp() + interval '5 seconds';
  WHILE clock_timestamp() < v_deadline LOOP
    EXIT WHEN v_a_pid = ANY (pg_blocking_pids(v_b_pid));
    PERFORM pg_sleep(0.05);
  END LOOP;
  ASSERT v_a_pid = ANY (pg_blocking_pids(v_b_pid)),
    'L9 race2 A must appear as B blocker before commit';

  PERFORM extensions.dblink_exec('yrl_a', 'COMMIT');
  SELECT res INTO r_b2 FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);
  PERFORM * FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);

  ASSERT (r_b2 ->> 'ok')::boolean IS FALSE AND r_b2 ->> 'reason' = 'lease_held',
    format('L9 race2 B must lose takeover with lease_held: got %s', r_b2);
  ASSERT (SELECT lease_token FROM public.youtube_token_refresh_leases WHERE social_account_id = a_race)
         = (r_a2 ->> 'lease_token')::uuid,
    'L9 race2 table holds winner A2 token';
END
$l9_race2$;

-- ---------------------------------------------------------------------------
-- L9 race3 (migration 20261120130000, finding F): a contender that waits for
-- the row lock must stamp its takeover AFTER the wait, not at its send time.
-- B is given the minimum ttl so the pre-fix stamps (captured at send) would
-- produce a lease born already expired; the post-fix stamps keep it live.
--
-- The lease row is prepared OUTSIDE the DO block, at top level, and
-- autocommitted: a setup UPDATE inside the block would make the block's own
-- transaction hold the row lock its dblink sessions wait on.
-- ---------------------------------------------------------------------------
UPDATE public.youtube_token_refresh_leases
   SET acquired_at = clock_timestamp() - interval '2 minutes',
       expires_at  = clock_timestamp() - interval '1 second'
 WHERE social_account_id = '0ed90002-0000-4000-8000-000000000002';

DO $l9_race3$
DECLARE
  a_race uuid := '0ed90002-0000-4000-8000-000000000002';
  r_a3 jsonb;
  r_b3 jsonb;
  v_a_tok uuid;
  v_b_tok uuid;
  v_a_pid integer;
  v_b_pid integer;
  v_b_send timestamptz;
  v_deadline timestamptz;
  v_row public.youtube_token_refresh_leases%ROWTYPE;
BEGIN
  SELECT pid INTO v_a_pid
    FROM extensions.dblink('yrl_a', 'SELECT pg_backend_pid()') AS t(pid int);
  SELECT pid INTO v_b_pid
    FROM extensions.dblink('yrl_b', 'SELECT pg_backend_pid()') AS t(pid int);

  -- A takes over inside a transaction with the MINIMUM ttl (5s) and sits on
  -- the row lock.
  PERFORM extensions.dblink_exec('yrl_a', 'BEGIN');
  SELECT res INTO r_a3
    FROM extensions.dblink(
      'yrl_a',
      format('SELECT public.acquire_youtube_refresh_lease(%L::uuid, 5)', a_race)
    ) AS t(res jsonb);
  ASSERT (r_a3 ->> 'ok')::boolean IS TRUE, format('L9 race3 A took over: got %s', r_a3);
  v_a_tok := (r_a3 ->> 'lease_token')::uuid;

  -- B acquires while A sits on the lock. v_b_send is B's pre-wait moment on
  -- purpose: the fix under test must not let this moment become B's
  -- acquired_at.
  v_b_send := clock_timestamp();
  PERFORM extensions.dblink_send_query(
    'yrl_b',
    format('SELECT public.acquire_youtube_refresh_lease(%L::uuid, 60)', a_race)
  );

  v_deadline := clock_timestamp() + interval '5 seconds';
  WHILE clock_timestamp() < v_deadline LOOP
    EXIT WHEN v_a_pid = ANY (pg_blocking_pids(v_b_pid));
    PERFORM pg_sleep(0.05);
  END LOOP;
  ASSERT v_a_pid = ANY (pg_blocking_pids(v_b_pid)),
    'L9 race3 A must appear as B blocker before commit';

  -- Hold the wait past A's whole 5-second window, so B unblocks onto an
  -- EXPIRED lease and takes over.
  PERFORM pg_sleep(6);

  PERFORM extensions.dblink_exec('yrl_a', 'COMMIT');
  SELECT res INTO r_b3 FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);
  PERFORM * FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);

  ASSERT (r_b3 ->> 'ok')::boolean IS TRUE,
    format('L9 race3 B took over the expired lease after the wait: got %s', r_b3);
  v_b_tok := (r_b3 ->> 'lease_token')::uuid;
  ASSERT v_b_tok <> v_a_tok, 'L9 race3 takeover mints a new lease_token';

  SELECT * INTO v_row
    FROM public.youtube_token_refresh_leases
   WHERE social_account_id = a_race;
  ASSERT v_row.lease_token = v_b_tok, 'L9 race3 table holds winner B token';

  -- THE FIX: B's stamps are captured after its lock wait, not at send time.
  ASSERT v_row.acquired_at >= v_b_send + interval '4 seconds',
    format('L9 race3 acquired_at must postdate the lock wait (acquired_at %s, sent %s)',
      v_row.acquired_at, v_b_send);
  ASSERT v_row.expires_at > clock_timestamp(),
    'L9 race3 the takeover lease is born live, never pre-expired';
  ASSERT v_row.expires_at - v_row.acquired_at >= interval '55 seconds'
     AND v_row.expires_at - v_row.acquired_at <= interval '60 seconds',
    'L9 race3 the requested ttl is honored from the post-lock clock';
END
$l9_race3$;

-- ---------------------------------------------------------------------------
-- L9 race4 (L5): a first-time acquire that ROLLS BACK after the wait must
-- leave B a LIVE lease with post-wait stamps. B serialises on the ACCOUNT
-- row before it touches the lease or samples a clock, so a contender that
-- waited for a rolled-back insert can never carry stamps taken before its
-- wait (which would hand it a lease born already expired).
--
-- The lease row is cleared OUTSIDE the DO block, at top level, and
-- autocommitted, so the block's own transaction holds no lease-row lock its
-- dblink sessions could wait on.
-- ---------------------------------------------------------------------------
DELETE FROM public.youtube_token_refresh_leases
 WHERE social_account_id = '0ed90002-0000-4000-8000-000000000002';

DO $l9_race4$
DECLARE
  a_race uuid := '0ed90002-0000-4000-8000-000000000002';
  r_a4 jsonb;
  r_b4 jsonb;
  v_a_tok uuid;
  v_b_tok uuid;
  v_a_pid integer;
  v_b_pid integer;
  v_b_send timestamptz;
  v_deadline timestamptz;
  v_row public.youtube_token_refresh_leases%ROWTYPE;
BEGIN
  SELECT pid INTO v_a_pid
    FROM extensions.dblink('yrl_a', 'SELECT pg_backend_pid()') AS t(pid int);
  SELECT pid INTO v_b_pid
    FROM extensions.dblink('yrl_b', 'SELECT pg_backend_pid()') AS t(pid int);

  -- A: first-time acquire (no row exists) with the MINIMUM ttl, inside an
  -- open transaction.
  PERFORM extensions.dblink_exec('yrl_a', 'BEGIN');
  SELECT res INTO r_a4
    FROM extensions.dblink(
      'yrl_a',
      format('SELECT public.acquire_youtube_refresh_lease(%L::uuid, 5)', a_race)
    ) AS t(res jsonb);
  ASSERT (r_a4 ->> 'ok')::boolean IS TRUE, format('L9 race4 A acquired first lease: got %s', r_a4);
  v_a_tok := (r_a4 ->> 'lease_token')::uuid;

  -- B acquires concurrently. v_b_send is B's pre-wait moment on purpose: the
  -- stamps B eventually carries must not come from this moment.
  v_b_send := clock_timestamp();
  PERFORM extensions.dblink_send_query(
    'yrl_b',
    format('SELECT public.acquire_youtube_refresh_lease(%L::uuid, 60)', a_race)
  );

  v_deadline := clock_timestamp() + interval '5 seconds';
  WHILE clock_timestamp() < v_deadline LOOP
    EXIT WHEN v_a_pid = ANY (pg_blocking_pids(v_b_pid));
    PERFORM pg_sleep(0.05);
  END LOOP;
  ASSERT v_a_pid = ANY (pg_blocking_pids(v_b_pid)),
    'L9 race4 A must appear as B blocker before rollback';

  -- Hold the wait past A's whole 5-second window, then ROLL A BACK: no lease
  -- row survives, and B must win the first-time race with FRESH stamps.
  PERFORM pg_sleep(6);

  PERFORM extensions.dblink_exec('yrl_a', 'ROLLBACK');
  SELECT res INTO r_b4 FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);
  PERFORM * FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);

  ASSERT (r_b4 ->> 'ok')::boolean IS TRUE,
    format('L9 race4 B won the first-time race after A rolled back: got %s', r_b4);
  v_b_tok := (r_b4 ->> 'lease_token')::uuid;
  ASSERT v_b_tok <> v_a_tok, 'L9 race4 B mints its own lease_token';

  SELECT * INTO v_row
    FROM public.youtube_token_refresh_leases
   WHERE social_account_id = a_race;
  ASSERT v_row.lease_token = v_b_tok, 'L9 race4 table holds winner B token';

  -- THE FIX: B's stamps are captured after its wait, not at send time.
  ASSERT v_row.acquired_at >= v_b_send + interval '4 seconds',
    format('L9 race4 acquired_at must postdate the wait (acquired_at %s, sent %s)',
      v_row.acquired_at, v_b_send);
  ASSERT v_row.expires_at > clock_timestamp(),
    'L9 race4 the lease is born LIVE, never pre-expired by a rolled-back rival';
  ASSERT v_row.expires_at - v_row.acquired_at >= interval '55 seconds'
     AND v_row.expires_at - v_row.acquired_at <= interval '60 seconds',
    'L9 race4 the requested ttl is honored from the post-lock clock';
END
$l9_race4$;

-- ---------------------------------------------------------------------------
-- L11 (migration 20261120130000, finding G): both write RPCs lock the ACCOUNT
-- row before they check the lease, matching the deletion order (account row,
-- then cascade to the lease). Proven discriminator: with A holding ONLY the
-- account row lock, a write presenting a WRONG token must block â€” a
-- lease-first order would answer stale_lease immediately.
--
-- The lease the writes are fenced on is acquired OUTSIDE the DO blocks, at
-- top level, and autocommitted: setup writes inside a block would make the
-- block's own transaction hold the lease row lock the blocked write needs
-- after the rollback, deadlocking the proof against itself.
-- ---------------------------------------------------------------------------
DELETE FROM public.youtube_token_refresh_leases
 WHERE social_account_id = '0ed90002-0000-4000-8000-000000000002';

SELECT public.acquire_youtube_refresh_lease('0ed90002-0000-4000-8000-000000000002', 60);

UPDATE public.youtube_token_refresh_leases
   SET expires_at = clock_timestamp() + interval '10 minutes'
 WHERE social_account_id = '0ed90002-0000-4000-8000-000000000002';

DO $l11_lock_order$
DECLARE
  a_race uuid := '0ed90002-0000-4000-8000-000000000002';
  r_b jsonb;
  v_a_pid integer;
  v_b_pid integer;
  v_deadline timestamptz;
BEGIN
  SELECT pid INTO v_a_pid
    FROM extensions.dblink('yrl_a', 'SELECT pg_backend_pid()') AS t(pid int);
  SELECT pid INTO v_b_pid
    FROM extensions.dblink('yrl_b', 'SELECT pg_backend_pid()') AS t(pid int);

  -- A locks ONLY the account row (no credential columns: the reconnect fence
  -- must not fire) and holds it uncommitted.
  PERFORM extensions.dblink_exec('yrl_a', 'BEGIN');
  PERFORM extensions.dblink_exec('yrl_a',
    format('UPDATE public.social_accounts SET platform_username = %L WHERE id = %L',
      'yrl-race-locked', a_race));

  -- B presents a WRONG lease token to the store RPC.
  PERFORM extensions.dblink_send_query('yrl_b',
    format('SELECT public.store_youtube_refreshed_token_with_lease(%L::uuid, %L::uuid, %L, clock_timestamp() + interval ''1 hour'', NULL, NULL)',
      a_race, gen_random_uuid()::text, 'access-lock-order-probe'));

  v_deadline := clock_timestamp() + interval '5 seconds';
  WHILE clock_timestamp() < v_deadline LOOP
    EXIT WHEN v_a_pid = ANY (pg_blocking_pids(v_b_pid));
    PERFORM pg_sleep(0.05);
  END LOOP;
  ASSERT v_a_pid = ANY (pg_blocking_pids(v_b_pid)),
    'L11 store must lock the account row before the lease-token check';

  PERFORM extensions.dblink_exec('yrl_a', 'ROLLBACK');
  SELECT res INTO r_b FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);
  PERFORM * FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);

  ASSERT (r_b ->> 'ok')::boolean IS FALSE AND r_b ->> 'reason' = 'stale_lease',
    format('L11 blocked store still refused the wrong token: got %s', r_b);
END
$l11_lock_order$;

DO $l11_lock_order_record$
DECLARE
  a_race uuid := '0ed90002-0000-4000-8000-000000000002';
  v_a_pid integer;
  v_b_pid integer;
  v_deadline timestamptz;
  r_b jsonb;
BEGIN
  SELECT pid INTO v_a_pid
    FROM extensions.dblink('yrl_a', 'SELECT pg_backend_pid()') AS t(pid int);
  SELECT pid INTO v_b_pid
    FROM extensions.dblink('yrl_b', 'SELECT pg_backend_pid()') AS t(pid int);

  PERFORM extensions.dblink_exec('yrl_a', 'BEGIN');
  PERFORM extensions.dblink_exec('yrl_a',
    format('UPDATE public.social_accounts SET platform_username = %L WHERE id = %L',
      'yrl-race-locked-record', a_race));

  PERFORM extensions.dblink_send_query('yrl_b',
    format('SELECT public.record_youtube_refresh_failure_with_lease(%L::uuid, %L::uuid, %L, true)',
      a_race, gen_random_uuid()::text, 'YouTube refresh failed: lock order probe'));

  v_deadline := clock_timestamp() + interval '5 seconds';
  WHILE clock_timestamp() < v_deadline LOOP
    EXIT WHEN v_a_pid = ANY (pg_blocking_pids(v_b_pid));
    PERFORM pg_sleep(0.05);
  END LOOP;
  ASSERT v_a_pid = ANY (pg_blocking_pids(v_b_pid)),
    'L11 record must lock the account row before the lease-token check';

  PERFORM extensions.dblink_exec('yrl_a', 'ROLLBACK');
  SELECT res INTO r_b FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);
  PERFORM * FROM extensions.dblink_get_result('yrl_b') AS t(res jsonb);

  ASSERT (r_b ->> 'ok')::boolean IS FALSE AND r_b ->> 'reason' = 'stale_lease',
    format('L11 blocked record still refused the wrong token: got %s', r_b);
END
$l11_lock_order_record$;

SELECT extensions.dblink_disconnect('yrl_a');
SELECT extensions.dblink_disconnect('yrl_b');

DELETE FROM public.youtube_token_refresh_leases
 WHERE social_account_id = '0ed90002-0000-4000-8000-000000000002';
DELETE FROM public.social_accounts
 WHERE id = '0ed90002-0000-4000-8000-000000000002';
DELETE FROM auth.users
 WHERE id = '0ed90001-0000-4000-8000-000000000001';

\echo '=== youtube_refresh_lease: ALL CHECKS PASSED ==='
