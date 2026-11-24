-- supabase/tests/youtube_stage4_key_integrity.sql
-- YouTube Stage 4 key integrity (migration 20261124120000).
--
-- Proves the four items of the second Stage 4 migration:
--   K1  a receipt's intent key version is a foreign key, so a key version
--       that a committed receipt references cannot be deleted even by a
--       transaction whose snapshot predates that receipt;
--   K2  a key version number, once issued, is never issued again;
--   K3  the status read locks the account row first, so a rebind (or an
--       account delete) cannot slip in between the binding check and the
--       read-back of a winning settlement;
--   K4  the claim requires the digest map, and a retry whose map lacks the
--       receipt's key version is temporary (upstream), never a conflict.
--
-- Every case that asserts NEW behaviour is marked (new); it must fail when
-- this suite runs against 20261122130000 alone. Cases marked (control) pass on
-- both and prove the migration moved nothing it should not.
--
-- The cases commit synthetic fixtures so that real second and third sessions
-- (dblink) can interleave on the same rows in a fixed order; they delete those
-- fixtures before exiting. Every case starts from fresh sessions and its own
-- operation ids, and takes its key versions from the watermark: the suite that
-- runs before this one leaves deleted versions behind, which are never reused.
--
-- Run it as the migration owner (supabase_admin).

\set ON_ERROR_STOP on
SET plpgsql.check_asserts = on;

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Idempotency (migration 20261124120000 applied a SECOND time). The harness has
-- already applied it once; applying it again must change nothing and succeed.
-- On a database that does not have it yet this is its first application, which
-- is what the red run against 20261122130000 alone relies on NOT happening, so
-- the file is only re-applied when the harness already applied it.
-- ---------------------------------------------------------------------------
SELECT to_regclass('public.youtube_comment_digest_key_watermark') IS NOT NULL AS s4k_migrated \gset
\if :s4k_migrated
SELECT set_config('s4k.mark_before', last_version::text, false) FROM public.youtube_comment_digest_key_watermark;
\ir ../migrations/20261124120000_youtube_stage4_key_integrity.sql
DO $s4k_idem$
BEGIN
  ASSERT (SELECT last_version FROM public.youtube_comment_digest_key_watermark) = current_setting('s4k.mark_before')::int,
    format('the watermark must be unchanged (not lowered) by a second application: %s -> %s',
           current_setting('s4k.mark_before'), (SELECT last_version FROM public.youtube_comment_digest_key_watermark));
END
$s4k_idem$;
\endif

-- ---------------------------------------------------------------------------
-- Helpers (session temp functions: nothing here outlives the psql session).
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.s4k_owner() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e7a0001-0000-4000-8000-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.s4k_acct1() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e7b0001-0000-4000-8000-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.s4k_acct2() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e7b0002-0000-4000-8000-000000000002'::uuid $$;
CREATE FUNCTION pg_temp.s4k_op(p_n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT ('6e7c0000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;

-- The next key version number nobody ever used: above every existing version
-- and, once the watermark exists, above everything the watermark remembers.
CREATE FUNCTION pg_temp.s4k_next_version() RETURNS int LANGUAGE plpgsql AS $f$
DECLARE
  v_next int;
  v_mark int;
BEGIN
  SELECT GREATEST(
           COALESCE((SELECT max(version) FROM public.youtube_comment_digest_keys), 0),
           COALESCE((SELECT max(intent_key_version) FROM public.youtube_comment_operations), 0),
           COALESCE((SELECT max(digest_key_version) FROM public.youtube_comment_operations), 0)
         ) + 1
    INTO v_next;
  IF to_regclass('public.youtube_comment_digest_key_watermark') IS NOT NULL THEN
    EXECUTE 'SELECT last_version FROM public.youtube_comment_digest_key_watermark' INTO v_mark;
    v_next := GREATEST(v_next, v_mark + 1);
  END IF;
  RETURN v_next;
END
$f$;

CREATE FUNCTION pg_temp.s4k_add_key(p_version int) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO public.youtube_comment_digest_keys (version, key)
     VALUES (p_version, sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'utf8'))) $$;

-- The same digest under every retained key version.
CREATE FUNCTION pg_temp.s4k_map(p_digest text) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT jsonb_object_agg(k.version::text, p_digest) FROM public.youtube_comment_digest_keys AS k $$;

-- The SQL text of one edit claim, to run locally (EXECUTE) or over dblink.
CREATE FUNCTION pg_temp.s4k_claim_text(p_acct uuid, p_op uuid, p_comment text, p_digest text, p_map jsonb)
RETURNS text LANGUAGE sql AS
  $$ SELECT format(
       'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, (SELECT binding_generation FROM public.social_accounts WHERE id = %L::uuid), %L::uuid, ''edit'', %L::jsonb, %L, ''{}''::jsonb, ''write'', %L, %L::jsonb)::text',
       pg_temp.s4k_owner(), p_acct,
       (SELECT platform_user_id FROM public.social_accounts WHERE id = p_acct), p_acct,
       p_op, jsonb_build_object('video_id', 'vid-s4k', 'comment_id', p_comment), p_digest,
       'k-' || p_comment, p_map::text) $$;

CREATE FUNCTION pg_temp.s4k_claim(p_acct uuid, p_op uuid, p_comment text, p_digest text, p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_text text;
BEGIN
  EXECUTE pg_temp.s4k_claim_text(p_acct, p_op, p_comment, p_digest, p_map) INTO v_text;
  RETURN v_text::jsonb;
END
$f$;

-- Fresh sessions a, b, c: a pending result or an aborted statement of a
-- previous case never leaks into the next one.
CREATE FUNCTION pg_temp.s4k_sessions() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['s4k_a', 's4k_b', 's4k_c'] LOOP
    BEGIN PERFORM extensions.dblink_disconnect(v_name); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM extensions.dblink_connect(
      v_name, format('dbname=%s user=%s application_name=%s', current_database(), current_user, v_name));
  END LOOP;
END
$f$;

CREATE FUNCTION pg_temp.s4k_pid(p_session text) RETURNS int LANGUAGE sql AS
  $$ SELECT pid FROM extensions.dblink(p_session, 'SELECT pg_backend_pid()') AS t(pid int) $$;

-- Waits (bounded) until the backend is parked on a lock; fails loudly if it never is.
CREATE FUNCTION pg_temp.s4k_wait_blocked(p_pid int, p_label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_i int := 0;
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = p_pid AND wait_event_type = 'Lock');
    v_i := v_i + 1;
    IF v_i > 100 THEN
      RAISE EXCEPTION '% was never parked on a lock', p_label;
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$f$;

-- Waits (bounded) until the backend is parked on a lock that the named blocker
-- holds or waits for. Naming the blocker is what tells "waits for the status
-- read" from "waits for something else" (an uncommitted settlement, say).
CREATE FUNCTION pg_temp.s4k_wait_blocked_by(p_pid int, p_blocker int, p_label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_i int := 0;
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN p_blocker = ANY (pg_blocking_pids(p_pid));
    v_i := v_i + 1;
    IF v_i > 60 THEN
      RAISE EXCEPTION '% was never blocked by the status read (blocked by %)', p_label, pg_blocking_pids(p_pid);
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$f$;

-- Receipts and the keys beyond version 1 of every previous run of this suite.
CREATE FUNCTION pg_temp.s4k_reset() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM public.youtube_comment_operations WHERE owner_id = pg_temp.s4k_owner();
  UPDATE public.youtube_comment_digest_keys SET retired_at = NULL WHERE version = 1;
  DELETE FROM public.youtube_comment_digest_keys WHERE version > 1;
END
$f$;

-- A direct receipt insert of the given shape. Returns NULL when the row was
-- accepted, otherwise the SQLSTATE and message that refused it. The row is
-- removed again either way, so a case that expected a refusal and got none
-- leaves nothing behind.
CREATE FUNCTION pg_temp.s4k_try_insert(p_n int, p_action text, p_ikv int, p_dkv int)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_result text := NULL;
BEGIN
  BEGIN
    IF p_action = 'edit' THEN
      INSERT INTO public.youtube_comment_operations (
        owner_id, operation_id, social_account_id, account_ref, channel_id, binding_generation,
        action, video_id, comment_id, intent_digest, intent_key_version, digest_key_version, state, attempt_token)
      VALUES (pg_temp.s4k_owner(), pg_temp.s4k_op(p_n), pg_temp.s4k_acct1(), pg_temp.s4k_acct1(), 'UC-s4-key', 1,
              'edit', 'vid', 'cmt', repeat('e', 64), p_ikv, p_dkv, 'claimed', gen_random_uuid());
    ELSIF p_action = 'moderate' THEN
      INSERT INTO public.youtube_comment_operations (
        owner_id, operation_id, social_account_id, account_ref, channel_id, binding_generation,
        action, video_id, comment_id, moderation_status, intent_digest, intent_key_version, digest_key_version, state, attempt_token)
      VALUES (pg_temp.s4k_owner(), pg_temp.s4k_op(p_n), pg_temp.s4k_acct1(), pg_temp.s4k_acct1(), 'UC-s4-key', 1,
              'moderate', 'vid', 'cmt', 'published', repeat('e', 64), p_ikv, p_dkv, 'claimed', gen_random_uuid());
    ELSE
      INSERT INTO public.youtube_comment_operations (
        owner_id, operation_id, social_account_id, account_ref, channel_id, binding_generation,
        action, video_id, parent_comment_id, logical_digest, intent_digest, intent_key_version, digest_key_version, state, attempt_token)
      VALUES (pg_temp.s4k_owner(), pg_temp.s4k_op(p_n), pg_temp.s4k_acct1(), pg_temp.s4k_acct1(), 'UC-s4-key', 1,
              p_action, 'vid', CASE WHEN p_action = 'reply' THEN 'par' END,
              'k1-logical-' || p_n, repeat('f', 64), p_ikv, p_dkv, 'claimed', gen_random_uuid());
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_result := SQLSTATE || ': ' || SQLERRM;
  END;
  DELETE FROM public.youtube_comment_operations WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(p_n);
  RETURN v_result;
END
$f$;

-- ---------------------------------------------------------------------------
-- Fixtures (committed, deleted at the end). A killed run is healed first.
-- ---------------------------------------------------------------------------
DELETE FROM public.youtube_comment_operations WHERE owner_id = '6e7a0001-0000-4000-8000-000000000001';
UPDATE public.youtube_comment_digest_keys SET retired_at = NULL WHERE version = 1;
DELETE FROM public.youtube_comment_digest_keys WHERE version > 1;
DELETE FROM public.social_accounts WHERE id IN ('6e7b0001-0000-4000-8000-000000000001', '6e7b0002-0000-4000-8000-000000000002');
DELETE FROM public.app_settings
 WHERE key IN ('feature_youtube_comments', 'youtube_comments_stage4_rollout')
   AND description LIKE 'Stage 4 suite%';
DELETE FROM auth.users WHERE id = '6e7a0001-0000-4000-8000-000000000001';

INSERT INTO auth.users (id, email) VALUES
  ('6e7a0001-0000-4000-8000-000000000001', 's4-key-owner@example.invalid');

INSERT INTO public.social_accounts (
  id, user_id, platform, platform_user_id, platform_username,
  access_token, refresh_token, token_expires_at, is_active, auth_provider
) VALUES
  ('6e7b0001-0000-4000-8000-000000000001', '6e7a0001-0000-4000-8000-000000000001',
   'youtube', 'UC-s4-key', 's4-key', 'key-access-1', 'key-refresh-1',
   clock_timestamp() + interval '1 hour', true, 'native'),
  ('6e7b0002-0000-4000-8000-000000000002', '6e7a0001-0000-4000-8000-000000000001',
   'youtube', 'UC-s4-key-two', 's4-key-two', 'key2-access-1', 'key2-refresh-1',
   clock_timestamp() + interval '1 hour', true, 'native');

INSERT INTO public.app_settings (key, value, description) VALUES
  ('feature_youtube_comments', 'true'::jsonb, 'Stage 4 suite key integrity tile flag'),
  ('youtube_comments_stage4_rollout',
   jsonb_build_object('version', 1, 'accounts', jsonb_build_object(
     '6e7b0001-0000-4000-8000-000000000001'::text,
     jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', false),
     '6e7b0002-0000-4000-8000-000000000002'::text,
     jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', false)
   )),
   'Stage 4 suite key integrity rollout policy')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

SELECT pg_temp.s4k_sessions();

-- ===========================================================================
-- K1. The foreign key.
-- ===========================================================================

-- K1.1 (new) A rotation session whose snapshot predates a committed claim
-- cannot delete the key version that claim's receipt references. Since this
-- migration's guard refuses key maintenance outside READ COMMITTED, a stale
-- REPEATABLE READ snapshot can no longer reach the delete at all; the foreign
-- key remains the backstop for any path that bypasses the guard.
SELECT set_config('s4k.n', pg_temp.s4k_next_version()::text, false);
SELECT pg_temp.s4k_add_key(current_setting('s4k.n')::int);

DO $k1_1$
DECLARE
  v_n       int := current_setting('s4k.n')::int;
  v_op      uuid := pg_temp.s4k_op(101);
  v_r       jsonb;
  v_text    text;
  v_refused boolean := false;
  v_state   text;
  v_msg     text;
BEGIN
  -- Session B opens REPEATABLE READ and takes its snapshot BEFORE the claim commits.
  PERFORM extensions.dblink_exec('s4k_b', 'BEGIN ISOLATION LEVEL REPEATABLE READ');
  PERFORM * FROM extensions.dblink('s4k_b', 'SELECT count(*) FROM public.youtube_comment_operations') AS t(c bigint);

  -- Session A claims under the highest active version (n) and commits.
  SELECT res INTO v_text FROM extensions.dblink(
    's4k_a', pg_temp.s4k_claim_text(pg_temp.s4k_acct1(), v_op, 'cmt-k1-1', repeat('a', 64), pg_temp.s4k_map(repeat('a', 64)))
  ) AS t(res text);
  v_r := v_text::jsonb;
  ASSERT (v_r ->> 'ok')::boolean, format('K1.1 the claim succeeded: %s', v_text);
  ASSERT (SELECT intent_key_version FROM public.youtube_comment_operations
           WHERE owner_id = pg_temp.s4k_owner() AND operation_id = v_op) = v_n,
    'K1.1 the receipt was written under the highest active key version';

  -- Session B, still on the old snapshot, deletes that version. Another active
  -- key (version 1) exists, so the "last active key" rule is not what refuses it.
  BEGIN
    PERFORM extensions.dblink_exec('s4k_b', format('DELETE FROM public.youtube_comment_digest_keys WHERE version = %s', v_n));
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
    v_state := SQLSTATE;
    v_msg := SQLERRM;
  END;
  BEGIN PERFORM extensions.dblink_exec('s4k_b', 'ROLLBACK'); EXCEPTION WHEN OTHERS THEN NULL; END;

  RAISE NOTICE 'K1.1 stale-snapshot delete: refused=% sqlstate=% message=%', v_refused, v_state, v_msg;
  ASSERT v_refused, 'K1.1 (new) the stale-snapshot delete of a referenced key version was refused';
  ASSERT v_state = 'P0001', format('K1.1 (new) it was refused by the READ COMMITTED guard (P0001), got %s: %s', v_state, v_msg);
  ASSERT v_msg = 'youtube_stage4_guard_digest_keys: digest key maintenance must run under READ COMMITTED (the last-active-key check reads the current state)',
    format('K1.1 (new) the refusal is the exact READ COMMITTED message: %s', v_msg);
  ASSERT EXISTS (SELECT 1 FROM public.youtube_comment_digest_keys WHERE version = v_n), 'K1.1 the key row remains';
  v_r := public.youtube_comment_op_status(pg_temp.s4k_owner(), pg_temp.s4k_acct1(), v_op);
  ASSERT (v_r ->> 'ok')::boolean AND v_r ->> 'state' = 'claimed', format('K1.1 the receipt still resolves: %s', v_r);
END
$k1_1$;

-- K1.2 (control) The same delete in READ COMMITTED is refused by the guard, before and after.
SELECT pg_temp.s4k_sessions();
DO $k1_2$
DECLARE
  v_n       int := current_setting('s4k.n')::int;
  v_refused boolean := false;
  v_state   text;
  v_msg     text;
BEGIN
  BEGIN
    PERFORM extensions.dblink_exec('s4k_b', format('DELETE FROM public.youtube_comment_digest_keys WHERE version = %s', v_n));
  EXCEPTION WHEN OTHERS THEN
    v_refused := true; v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  ASSERT v_refused, 'K1.2 (control) a read-committed delete of a referenced version is refused';
  ASSERT v_msg LIKE '%still referenced by a receipt%', format('K1.2 (control) the readable guard message is kept: %s', v_msg);
  ASSERT EXISTS (SELECT 1 FROM public.youtube_comment_digest_keys WHERE version = v_n), 'K1.2 the key row remains';
END
$k1_2$;

-- K1.3 (new) A direct insert of a receipt with an unknown intent key version is refused.
DO $k1_3$
DECLARE r text := pg_temp.s4k_try_insert(133, 'edit', current_setting('s4k.n')::int + 1000, 0);
BEGIN
  ASSERT r LIKE '23503:%', format('K1.3 (new) an unknown intent key version is refused by the foreign key: %s', r);
END
$k1_3$;

-- K1.4 (new) A direct insert that breaks the version CHECK is refused, one case per action family.
DO $k1_4a$
DECLARE r text := pg_temp.s4k_try_insert(134, 'create_thread', 1, current_setting('s4k.n')::int);
BEGIN
  ASSERT r LIKE '23514:%youtube_comment_operations_key_versions_check%',
    format('K1.4a (new) a create_thread receipt with different key versions breaks the CHECK: %s', r);
END
$k1_4a$;

DO $k1_4b$
DECLARE r text := pg_temp.s4k_try_insert(135, 'edit', 1, 1);
BEGIN
  ASSERT r LIKE '23514:%youtube_comment_operations_key_versions_check%',
    format('K1.4b (new) an edit receipt with a non-zero digest key version breaks the CHECK: %s', r);
END
$k1_4b$;

DO $k1_4c$
DECLARE r text := pg_temp.s4k_try_insert(136, 'moderate', 1, 1);
BEGIN
  ASSERT r LIKE '23514:%youtube_comment_operations_key_versions_check%',
    format('K1.4c (new) a moderate receipt with a non-zero digest key version breaks the CHECK: %s', r);
END
$k1_4c$;

-- K1.5 (control) The values the claim itself writes are accepted.
DO $k1_5$
DECLARE
  v_n int := current_setting('s4k.n')::int;
BEGIN
  ASSERT pg_temp.s4k_try_insert(137, 'edit', 1, 0) IS NULL, 'K1.5 (control) an edit receipt with digest key version 0';
  ASSERT pg_temp.s4k_try_insert(138, 'moderate', v_n, 0) IS NULL, 'K1.5 (control) a moderate receipt with digest key version 0';
  ASSERT pg_temp.s4k_try_insert(139, 'reply', v_n, v_n) IS NULL, 'K1.5 (control) a reply receipt with equal key versions';
  ASSERT pg_temp.s4k_try_insert(140, 'create_thread', 1, 1) IS NULL, 'K1.5 (control) a create_thread receipt with equal key versions';
END
$k1_5$;

SELECT pg_temp.s4k_reset();

-- ===========================================================================
-- K2. A key version number is never issued twice.
-- ===========================================================================

-- K2.1 (new) Delete an unreferenced version n, insert n again: refused, with the next allowed number named.
SELECT set_config('s4k.n', pg_temp.s4k_next_version()::text, false);
SELECT pg_temp.s4k_add_key(current_setting('s4k.n')::int);
DELETE FROM public.youtube_comment_digest_keys WHERE version = current_setting('s4k.n')::int;

DO $k2_1$
DECLARE
  v_n       int := current_setting('s4k.n')::int;
  v_refused boolean := false;
  v_msg     text;
BEGIN
  BEGIN
    PERFORM pg_temp.s4k_add_key(v_n);
  EXCEPTION WHEN OTHERS THEN
    v_refused := true; v_msg := SQLERRM;
  END;
  -- Leave the table as it was whatever happened.
  DELETE FROM public.youtube_comment_digest_keys WHERE version = v_n;
  ASSERT v_refused, 'K2.1 (new) a deleted version number cannot be issued again';
  ASSERT v_msg LIKE '%next allowed version is ' || (v_n + 1) || '%',
    format('K2.1 (new) the refusal names the next allowed version: %s', v_msg);
END
$k2_1$;

-- K2.2 (new) The next number after a deleted one is allowed, and a jump too. A
-- never-used number below the watermark is refused. A rolled-back insert moves nothing.
DO $k2_2a$
DECLARE
  v_n int := current_setting('s4k.n')::int;
BEGIN
  PERFORM pg_temp.s4k_add_key(v_n + 2);
  ASSERT EXISTS (SELECT 1 FROM public.youtube_comment_digest_keys WHERE version = v_n + 2), 'K2.2a a jump above the watermark is allowed';
  ASSERT (SELECT last_version FROM public.youtube_comment_digest_key_watermark) = v_n + 2,
    'K2.2a (new) the watermark is the highest version ever issued';
END
$k2_2a$;

DO $k2_2b$
DECLARE
  v_n       int := current_setting('s4k.n')::int;
  v_refused boolean := false;
BEGIN
  BEGIN
    PERFORM pg_temp.s4k_add_key(v_n + 1);
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;
  DELETE FROM public.youtube_comment_digest_keys WHERE version = v_n + 1;
  ASSERT v_refused, 'K2.2b (new) an unused number below the watermark is refused';
END
$k2_2b$;

DO $k2_2c$
DECLARE
  v_n int := current_setting('s4k.n')::int;
  v_mark_before int;
  v_mark_after  int;
BEGIN
  EXECUTE 'SELECT last_version FROM public.youtube_comment_digest_key_watermark' INTO v_mark_before;
  BEGIN
    PERFORM pg_temp.s4k_add_key(v_n + 10);
    RAISE EXCEPTION 'k2-rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'k2-rollback' THEN RAISE; END IF;
  END;
  EXECUTE 'SELECT last_version FROM public.youtube_comment_digest_key_watermark' INTO v_mark_after;
  ASSERT v_mark_after = v_mark_before, format('K2.2c (new) a rolled-back insert left the watermark alone: %s -> %s', v_mark_before, v_mark_after);
END
$k2_2c$;

SELECT pg_temp.s4k_reset();

-- K2.3 (control) Two sessions insert the same new version: exactly one succeeds.
SELECT pg_temp.s4k_sessions();
SELECT set_config('s4k.n', pg_temp.s4k_next_version()::text, false);
DO $k2_3$
DECLARE
  v_n      int := current_setting('s4k.n')::int;
  v_pid_b  int;
  v_failed boolean := false;
BEGIN
  PERFORM extensions.dblink_exec('s4k_a', 'BEGIN');
  PERFORM extensions.dblink_exec('s4k_a', format(
    'INSERT INTO public.youtube_comment_digest_keys (version, key) VALUES (%s, sha256(convert_to(gen_random_uuid()::text, ''utf8'')))', v_n));
  v_pid_b := pg_temp.s4k_pid('s4k_b');
  PERFORM extensions.dblink_send_query('s4k_b', format(
    'INSERT INTO public.youtube_comment_digest_keys (version, key) VALUES (%s, sha256(convert_to(gen_random_uuid()::text, ''utf8'')))', v_n));
  PERFORM pg_temp.s4k_wait_blocked(v_pid_b, 'K2.3 session B');
  PERFORM extensions.dblink_exec('s4k_a', 'COMMIT');
  BEGIN
    PERFORM * FROM extensions.dblink_get_result('s4k_b') AS t(res text);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  ASSERT v_failed, 'K2.3 (control) the second inserter failed';
  ASSERT (SELECT count(*) FROM public.youtube_comment_digest_keys WHERE version = v_n) = 1, 'K2.3 exactly one row won';
END
$k2_3$;

-- K2.4 (new) key maintenance under REPEATABLE READ is refused: the last-active-key
-- check reads the current state, which a snapshot cannot provide.
SELECT pg_temp.s4k_sessions();
SELECT set_config('s4k.n', pg_temp.s4k_next_version()::text, false);
SELECT pg_temp.s4k_add_key(current_setting('s4k.n')::int);
DO $k2_4$
DECLARE
  v_n       int := current_setting('s4k.n')::int;
  v_refused boolean := false;
  v_msg     text;
BEGIN
  PERFORM extensions.dblink_exec('s4k_a', 'BEGIN ISOLATION LEVEL REPEATABLE READ');
  BEGIN
    PERFORM extensions.dblink_exec('s4k_a', format(
      'UPDATE public.youtube_comment_digest_keys SET retired_at = clock_timestamp() WHERE version = %s', v_n));
  EXCEPTION WHEN OTHERS THEN
    v_refused := true; v_msg := SQLERRM;
  END;
  BEGIN PERFORM extensions.dblink_exec('s4k_a', 'ROLLBACK'); EXCEPTION WHEN OTHERS THEN NULL; END;
  DELETE FROM public.youtube_comment_digest_keys WHERE version = v_n;
  ASSERT v_refused, format('K2.4 (new) retiring a key under REPEATABLE READ was refused: %s', v_msg);
  ASSERT v_msg LIKE '%digest key maintenance must run under READ COMMITTED%',
    format('K2.4 (new) the refusal names the isolation rule: %s', v_msg);
END
$k2_4$;

SELECT pg_temp.s4k_reset();

-- ===========================================================================
-- K3. The status read locks the account row first.
-- ===========================================================================
-- The receipt of a dispatched edit, older than the 90 s conversion threshold.
SELECT pg_temp.s4k_sessions();

DO $k3_setup$
DECLARE
  v_r     jsonb;
  v_token text;
  v_acct  uuid;
BEGIN
  -- operation 301 on account 1 (the rebind case) and 302 on account 2 (the delete
  -- case): each claimed, marked and aged past the 90 s conversion threshold.
  FOR i IN 301..302 LOOP
    v_acct := CASE WHEN i = 302 THEN pg_temp.s4k_acct2() ELSE pg_temp.s4k_acct1() END;
    v_r := pg_temp.s4k_claim(v_acct, pg_temp.s4k_op(i), 'cmt-k3-' || i, repeat('k', 64), pg_temp.s4k_map(repeat('k', 64)));
    ASSERT (v_r ->> 'ok')::boolean, format('K3 setup claim %s: %s', i, v_r);
    v_token := v_r ->> 'attempt_token';
    v_r := public.youtube_comment_op_mark_dispatched(
      pg_temp.s4k_owner(), pg_temp.s4k_op(i), v_token::uuid,
      (SELECT platform_user_id FROM public.social_accounts WHERE id = v_acct),
      (SELECT binding_generation FROM public.social_accounts WHERE id = v_acct));
    ASSERT (v_r ->> 'ok')::boolean, format('K3 setup mark %s: %s', i, v_r);
    UPDATE public.youtube_comment_operations
       SET dispatched_at = clock_timestamp() - interval '100 seconds'
     WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(i);
    PERFORM set_config('s4k.token' || i, v_token, false);
  END LOOP;
END
$k3_setup$;

-- K3.1 (new) A settlement is in flight, a status read waits for it, and a
-- rebind that starts meanwhile is blocked until the read has answered.
DO $k3_1$
DECLARE
  v_op      uuid := pg_temp.s4k_op(301);
  v_acct    uuid := pg_temp.s4k_acct1();
  v_token   text := current_setting('s4k.token301');
  v_pid_b   int;
  v_pid_c   int;
  r_a       text;
  r_b       text;
  v_gen     bigint;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct;

  PERFORM extensions.dblink_exec('s4k_a', 'BEGIN');
  SELECT res INTO r_a FROM extensions.dblink('s4k_a', format(
    'SELECT public.youtube_comment_op_settle(%L::uuid, %L::uuid, %L::uuid, ''confirmed'', NULL, ''none'', NULL, ''cmt-k3-1'')::text',
    pg_temp.s4k_owner(), v_op, v_token)) AS t(res text);
  ASSERT (r_a::jsonb ->> 'ok')::boolean, format('K3.1 session A settled (uncommitted): %s', r_a);

  -- B reads the status and parks on A's settlement.
  v_pid_b := pg_temp.s4k_pid('s4k_b');
  PERFORM extensions.dblink_send_query('s4k_b', format(
    'SELECT public.youtube_comment_op_status(%L::uuid, %L::uuid, %L::uuid)::text', pg_temp.s4k_owner(), v_acct, v_op));
  PERFORM pg_temp.s4k_wait_blocked(v_pid_b, 'K3.1 the status read');

  -- C rebinds (a credential change advances the generation). It must wait for B.
  v_pid_c := pg_temp.s4k_pid('s4k_c');
  PERFORM extensions.dblink_send_query('s4k_c', format(
    'UPDATE public.social_accounts SET access_token = ''key-access-rebound'' WHERE id = %L::uuid', v_acct));
  BEGIN
    PERFORM pg_temp.s4k_wait_blocked_by(v_pid_c, v_pid_b, 'K3.1 (new) the rebind while the status read is in flight');
  EXCEPTION WHEN OTHERS THEN
    -- Leave no half-open session behind before failing loudly.
    BEGIN PERFORM extensions.dblink_exec('s4k_a', 'ROLLBACK'); EXCEPTION WHEN OTHERS THEN NULL; END;
    RAISE;
  END;

  PERFORM extensions.dblink_exec('s4k_a', 'COMMIT');
  SELECT res INTO r_b FROM extensions.dblink_get_result('s4k_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4k_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4k_c') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4k_c') AS t(res text);

  ASSERT r_b::jsonb ->> 'state' = 'confirmed' AND r_b::jsonb ->> 'result_comment_id' = 'cmt-k3-1',
    format('K3.1 the read answers with the winning settlement: %s', r_b);
  ASSERT (SELECT binding_generation FROM public.social_accounts WHERE id = v_acct) = v_gen + 1, 'K3.1 the rebind completed after the read';
  -- After the rebind the receipt is no longer readable, and carries no result ids.
  r_b := public.youtube_comment_op_status(pg_temp.s4k_owner(), v_acct, v_op)::text;
  ASSERT r_b::jsonb ->> 'reason' = 'not_found' AND (r_b::jsonb ->> 'result_comment_id') IS NULL,
    format('K3.1 a read after the rebind is not_found with no result ids: %s', r_b);
END
$k3_1$;

-- K3.2 (control) An account delete in place of the rebind: the read still answers with the
-- winning settlement and the delete completes after it. (The delete is held by the open
-- settlement on the same receipt whether or not the status read locks the account, so the
-- account lock itself is proven by K3.1 and K3.3b.)
SELECT pg_temp.s4k_sessions();
DO $k3_2$
DECLARE
  v_op      uuid := pg_temp.s4k_op(302);
  v_acct    uuid := pg_temp.s4k_acct2();
  v_token   text := current_setting('s4k.token302');
  v_pid_b   int;
  v_pid_c   int;
  r_a       text;
  r_b       text;
BEGIN
  PERFORM extensions.dblink_exec('s4k_a', 'BEGIN');
  SELECT res INTO r_a FROM extensions.dblink('s4k_a', format(
    'SELECT public.youtube_comment_op_settle(%L::uuid, %L::uuid, %L::uuid, ''confirmed'', NULL, ''none'', NULL, ''cmt-k3-2'')::text',
    pg_temp.s4k_owner(), v_op, v_token)) AS t(res text);
  ASSERT (r_a::jsonb ->> 'ok')::boolean, format('K3.2 session A settled (uncommitted): %s', r_a);

  v_pid_b := pg_temp.s4k_pid('s4k_b');
  PERFORM extensions.dblink_send_query('s4k_b', format(
    'SELECT public.youtube_comment_op_status(%L::uuid, %L::uuid, %L::uuid)::text', pg_temp.s4k_owner(), v_acct, v_op));
  PERFORM pg_temp.s4k_wait_blocked(v_pid_b, 'K3.2 the status read');

  v_pid_c := pg_temp.s4k_pid('s4k_c');
  PERFORM extensions.dblink_send_query('s4k_c', format('DELETE FROM public.social_accounts WHERE id = %L::uuid', v_acct));
  BEGIN
    PERFORM pg_temp.s4k_wait_blocked(v_pid_c, 'K3.2 the account delete while the settlement is in flight');
  EXCEPTION WHEN OTHERS THEN
    BEGIN PERFORM extensions.dblink_exec('s4k_a', 'ROLLBACK'); EXCEPTION WHEN OTHERS THEN NULL; END;
    RAISE;
  END;

  PERFORM extensions.dblink_exec('s4k_a', 'COMMIT');
  SELECT res INTO r_b FROM extensions.dblink_get_result('s4k_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4k_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4k_c') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4k_c') AS t(res text);
  ASSERT r_b::jsonb ->> 'state' = 'confirmed', format('K3.2 the read answers with the winning settlement: %s', r_b);
  ASSERT NOT EXISTS (SELECT 1 FROM public.social_accounts WHERE id = v_acct), 'K3.2 the delete completed after the read';
END
$k3_2$;

-- Receipts for the lock-shape and lock-order cases, created AFTER the rebind of K3.1
-- (a receipt of an older generation would not be readable any more):
--   303 dispatched and aged: the receipt a settlement will hold in K3.4;
--   304 freshly claimed: read by K3.3b (a read converts nothing) and marked by K3.4.
SELECT pg_temp.s4k_sessions();
DO $k3_setup_b$
DECLARE
  v_r     jsonb;
  v_acct  uuid := pg_temp.s4k_acct1();
BEGIN
  v_r := pg_temp.s4k_claim(v_acct, pg_temp.s4k_op(303), 'cmt-k3-303', repeat('k', 64), pg_temp.s4k_map(repeat('k', 64)));
  ASSERT (v_r ->> 'ok')::boolean, format('K3 setup claim 303: %s', v_r);
  PERFORM set_config('s4k.token303', v_r ->> 'attempt_token', false);
  v_r := public.youtube_comment_op_mark_dispatched(
    pg_temp.s4k_owner(), pg_temp.s4k_op(303), (current_setting('s4k.token303'))::uuid,
    (SELECT platform_user_id FROM public.social_accounts WHERE id = v_acct),
    (SELECT binding_generation FROM public.social_accounts WHERE id = v_acct));
  ASSERT (v_r ->> 'ok')::boolean, format('K3 setup mark 303: %s', v_r);
  UPDATE public.youtube_comment_operations
     SET dispatched_at = clock_timestamp() - interval '100 seconds'
   WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(303);

  v_r := pg_temp.s4k_claim(v_acct, pg_temp.s4k_op(304), 'cmt-k3-304', repeat('m', 64), pg_temp.s4k_map(repeat('m', 64)));
  ASSERT (v_r ->> 'ok')::boolean, format('K3 setup claim 304: %s', v_r);
  PERFORM set_config('s4k.token304', v_r ->> 'attempt_token', false);
END
$k3_setup_b$;

-- K3.3 (new when the receipt exists, control when it does not) What the read locks.
DO $k3_3$
DECLARE
  v_acct   uuid := pg_temp.s4k_acct1();
  r        text;
  v_locked boolean;
BEGIN
  -- a status read for an operation id that has no receipt locks nothing (control)
  PERFORM extensions.dblink_exec('s4k_a', 'BEGIN');
  SELECT res INTO r FROM extensions.dblink('s4k_a', format(
    'SELECT public.youtube_comment_op_status(%L::uuid, %L::uuid, %L::uuid)::text',
    pg_temp.s4k_owner(), v_acct, pg_temp.s4k_op(399))) AS t(res text);
  ASSERT r::jsonb ->> 'reason' = 'not_found', format('K3.3 an unknown operation is not_found: %s', r);
  v_locked := false;
  BEGIN
    PERFORM * FROM extensions.dblink('s4k_c', format(
      'SELECT 1 FROM public.social_accounts WHERE id = %L::uuid FOR UPDATE NOWAIT', v_acct)) AS t(x int);
  EXCEPTION WHEN lock_not_available THEN v_locked := true;
  END;
  PERFORM extensions.dblink_exec('s4k_a', 'ROLLBACK');
  ASSERT NOT v_locked, 'K3.3 (control) a status read for an unknown operation leaves no lock on the account row';
END
$k3_3$;

SELECT pg_temp.s4k_sessions();
DO $k3_3b$
DECLARE
  v_acct   uuid := pg_temp.s4k_acct1();
  r        text;
  v_locked boolean := false;
BEGIN
  -- a status read for an existing receipt holds a share lock on the account to the end of the call
  PERFORM extensions.dblink_exec('s4k_a', 'BEGIN');
  SELECT res INTO r FROM extensions.dblink('s4k_a', format(
    'SELECT public.youtube_comment_op_status(%L::uuid, %L::uuid, %L::uuid)::text',
    pg_temp.s4k_owner(), v_acct, pg_temp.s4k_op(304))) AS t(res text);
  ASSERT (r::jsonb ->> 'ok')::boolean, format('K3.3b the read answered: %s', r);
  BEGIN
    PERFORM * FROM extensions.dblink('s4k_c', format(
      'SELECT 1 FROM public.social_accounts WHERE id = %L::uuid FOR UPDATE NOWAIT', v_acct)) AS t(x int);
  EXCEPTION WHEN lock_not_available THEN v_locked := true;
  END;
  PERFORM extensions.dblink_exec('s4k_a', 'ROLLBACK');
  ASSERT v_locked, 'K3.3b (new) a status read of an existing receipt holds the account row until it answers';
END
$k3_3b$;

-- K3.4 (new) The status read, the mark and a settlement interleave without a deadlock.
-- S settles receipt 303 and holds it; B reads the status of 303 (account share lock, then waits for S);
-- A marks a second operation on the same account (account update lock): it must wait for B, and nobody deadlocks.
SELECT pg_temp.s4k_sessions();
DO $k3_4$
DECLARE
  v_acct    uuid := pg_temp.s4k_acct1();
  v_pid_a   int;
  v_pid_b   int;
  v_token   text;
  r_s       text;
  r_b       text;
  r_a       text;
BEGIN
  v_token := current_setting('s4k.token304');

  -- S (session c): settles receipt 303 and keeps the transaction open.
  PERFORM extensions.dblink_exec('s4k_c', 'BEGIN');
  SELECT res INTO r_s FROM extensions.dblink('s4k_c', format(
    'SELECT public.youtube_comment_op_settle(%L::uuid, %L::uuid, %L::uuid, ''confirmed'', NULL, ''none'', NULL, ''cmt-k3-303'')::text',
    pg_temp.s4k_owner(), pg_temp.s4k_op(303), current_setting('s4k.token303'))) AS t(res text);
  ASSERT (r_s::jsonb ->> 'ok')::boolean, format('K3.4 session S settled: %s', r_s);

  -- B: status of 303 parks on S's settlement while it holds the account share lock.
  v_pid_b := pg_temp.s4k_pid('s4k_b');
  PERFORM extensions.dblink_send_query('s4k_b', format(
    'SELECT public.youtube_comment_op_status(%L::uuid, %L::uuid, %L::uuid)::text', pg_temp.s4k_owner(), v_acct, pg_temp.s4k_op(303)));
  PERFORM pg_temp.s4k_wait_blocked(v_pid_b, 'K3.4 the status read');

  -- A: the mark of 304 needs the account row exclusively. It must wait for B (new) and not deadlock.
  v_pid_a := pg_temp.s4k_pid('s4k_a');
  PERFORM extensions.dblink_send_query('s4k_a', format(
    'SELECT public.youtube_comment_op_mark_dispatched(%L::uuid, %L::uuid, %L::uuid, ''UC-s4-key'', (SELECT binding_generation FROM public.social_accounts WHERE id = %L::uuid))::text',
    pg_temp.s4k_owner(), pg_temp.s4k_op(304), v_token, v_acct));
  BEGIN
    PERFORM pg_temp.s4k_wait_blocked_by(v_pid_a, v_pid_b, 'K3.4 (new) the mark while a status read holds the account');
  EXCEPTION WHEN OTHERS THEN
    BEGIN PERFORM extensions.dblink_exec('s4k_c', 'ROLLBACK'); EXCEPTION WHEN OTHERS THEN NULL; END;
    RAISE;
  END;

  PERFORM extensions.dblink_exec('s4k_c', 'COMMIT');
  SELECT res INTO r_b FROM extensions.dblink_get_result('s4k_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4k_b') AS t(res text);
  SELECT res INTO r_a FROM extensions.dblink_get_result('s4k_a') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4k_a') AS t(res text);
  ASSERT r_b::jsonb ->> 'state' = 'confirmed', format('K3.4 the status read answered: %s', r_b);
  ASSERT (r_a::jsonb ->> 'ok')::boolean, format('K3.4 the mark completed with no deadlock: %s', r_a);
END
$k3_4$;

SELECT pg_temp.s4k_reset();

-- ===========================================================================
-- K4. The claim requires the digest map.
-- ===========================================================================
CREATE FUNCTION pg_temp.s4k_k4_claim(p_op int, p_comment text, p_digest text, p_map jsonb) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT public.youtube_comment_op_claim(
       pg_temp.s4k_owner(), pg_temp.s4k_acct1(), 'UC-s4-key',
       (SELECT binding_generation FROM public.social_accounts WHERE id = pg_temp.s4k_acct1()),
       pg_temp.s4k_op(p_op), 'edit', jsonb_build_object('video_id', 'vid-k4', 'comment_id', p_comment),
       p_digest, '{}'::jsonb, 'write', 'k4-' || p_op, p_map) $$;
CREATE FUNCTION pg_temp.s4k_receipts(p_op int) RETURNS bigint LANGUAGE sql AS
  $$ SELECT count(*) FROM public.youtube_comment_operations WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(p_op) $$;

-- K4.1 (new) a NULL map is invalid_request and writes no receipt
DO $k4_1$
DECLARE
  v_r    jsonb := pg_temp.s4k_k4_claim(401, 'cmt-k4-1', repeat('z', 64), NULL);
  v_rows bigint := pg_temp.s4k_receipts(401);
BEGIN
  DELETE FROM public.youtube_comment_operations WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(401);
  ASSERT v_r ->> 'reason' = 'invalid_request' AND v_rows = 0,
    format('K4.1 (new) a NULL map is invalid_request with no receipt: %s rows=%s', v_r, v_rows);
END
$k4_1$;

-- K4.2 (new) a map that is not a JSON object is invalid_request, one case per non-object shape
DO $k4_2$
DECLARE
  v_shape text;
  v_r     jsonb;
  v_rows  bigint;
BEGIN
  FOR v_shape IN SELECT unnest(ARRAY['[]', '"x"', '7', 'true', 'null']) LOOP
    v_r := pg_temp.s4k_k4_claim(402, 'cmt-k4-2', repeat('z', 64), v_shape::jsonb);
    v_rows := pg_temp.s4k_receipts(402);
    DELETE FROM public.youtube_comment_operations WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(402);
    ASSERT v_r ->> 'reason' = 'invalid_request' AND v_rows = 0,
      format('K4.2 (new) the map %s is invalid_request with no receipt: %s rows=%s', v_shape, v_r, v_rows);
  END LOOP;
END
$k4_2$;

-- K4.3 (control) a map without the active version is the temporary refusal, with no receipt
DO $k4_3$
DECLARE
  v_r jsonb := pg_temp.s4k_k4_claim(403, 'cmt-k4-3', repeat('z', 64), '{"99999":"x"}'::jsonb);
BEGIN
  ASSERT v_r ->> 'reason' = 'upstream' AND pg_temp.s4k_receipts(403) = 0,
    format('K4.3 (control) a map without the active version is upstream, no receipt: %s', v_r);
END
$k4_3$;

-- K4.4 (new) a retry whose map lacks the receipt's key version is temporary (upstream) and changes nothing.
-- The receipt is written under version 1, a rotation adds a version, and the retry sends only the new one.
DO $k4_4$
DECLARE
  v_r     jsonb;
  v_n     int;
  v_state text;
BEGIN
  v_r := pg_temp.s4k_k4_claim(404, 'cmt-k4-4', repeat('1', 64), jsonb_build_object('1', repeat('1', 64)));
  ASSERT (v_r ->> 'ok')::boolean, format('K4.4 the first claim under version 1: %s', v_r);
  v_n := pg_temp.s4k_next_version();
  PERFORM pg_temp.s4k_add_key(v_n);
  PERFORM set_config('s4k.k4n', v_n::text, false);
  SELECT state INTO v_state FROM public.youtube_comment_operations
   WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(404);

  v_r := pg_temp.s4k_k4_claim(404, 'cmt-k4-4', repeat('2', 64), jsonb_build_object(v_n::text, repeat('2', 64)));
  ASSERT v_r ->> 'reason' = 'upstream' AND (v_r ->> 'attempt_token') IS NULL,
    format('K4.4 (new) a retry whose map lacks the receipt version is upstream, with no token: %s', v_r);
  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(404)) = v_state,
    'K4.4 the receipt is unchanged';
END
$k4_4$;

-- K4.5 (control) the same intent after a rotation is answered from the receipt (no token);
-- a different intent under the receipt's version is still a conflict.
DO $k4_5$
DECLARE
  v_n int := current_setting('s4k.k4n')::int;
  v_r jsonb;
BEGIN
  v_r := pg_temp.s4k_k4_claim(404, 'cmt-k4-4', repeat('2', 64),
    jsonb_build_object('1', repeat('1', 64), v_n::text, repeat('2', 64)));
  ASSERT v_r ->> 'reason' = 'already_recorded' AND (v_r ->> 'attempt_token') IS NULL,
    format('K4.5 (control) the same intent after a rotation is already_recorded: %s', v_r);
  v_r := pg_temp.s4k_k4_claim(404, 'cmt-k4-4', repeat('3', 64),
    jsonb_build_object('1', repeat('9', 64), v_n::text, repeat('3', 64)));
  ASSERT v_r ->> 'reason' = 'conflict', format('K4.5 (control) a different intent under the receipt version is a conflict: %s', v_r);
END
$k4_5$;

-- K4.6 (control) a new receipt stores the digest of the key version the claim locked: the map's entry
DO $k4_6$
DECLARE
  v_n int := current_setting('s4k.k4n')::int;
  v_r jsonb;
BEGIN
  v_r := pg_temp.s4k_k4_claim(406, 'cmt-k4-6', repeat('p', 64),
    jsonb_build_object('1', repeat('q', 64), v_n::text, repeat('r', 64)));
  ASSERT (v_r ->> 'ok')::boolean, format('K4.6 the claim under the active version: %s', v_r);
  ASSERT (SELECT intent_digest FROM public.youtube_comment_operations
           WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(406)) = repeat('r', 64),
    'K4.6 the stored digest is the map entry of the locked active version, never the single digest argument';
END
$k4_6$;

-- A claim with an explicit logical map, for the non-string-entry case below.
CREATE FUNCTION pg_temp.s4k_k4_claim_logical(p_op int, p_comment text, p_digest text, p_map jsonb, p_logical jsonb)
RETURNS jsonb LANGUAGE sql AS
  $$ SELECT public.youtube_comment_op_claim(
       pg_temp.s4k_owner(), pg_temp.s4k_acct1(), 'UC-s4-key',
       (SELECT binding_generation FROM public.social_accounts WHERE id = pg_temp.s4k_acct1()),
       pg_temp.s4k_op(p_op), 'edit', jsonb_build_object('video_id', 'vid-k4', 'comment_id', p_comment),
       p_digest, p_logical, 'write', 'k4-' || p_op, p_map) $$;

-- K4.7 (new) a non-string entry under the ACTIVE version is invalid_request:
-- the map is not coerced to text and no receipt is inserted.
DO $k4_7_new$
DECLARE
  v_active int   := (SELECT max(version) FROM public.youtube_comment_digest_keys WHERE retired_at IS NULL);
  v_map    jsonb := pg_temp.s4k_map(repeat('s', 64));
  v_r      jsonb;
  v_rows   bigint;
BEGIN
  v_map := jsonb_set(v_map, ARRAY[v_active::text], '123'::jsonb);
  v_r := pg_temp.s4k_k4_claim(407, 'cmt-k4-7-num', repeat('s', 64), v_map);
  v_rows := pg_temp.s4k_receipts(407);
  DELETE FROM public.youtube_comment_operations WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(407);
  ASSERT v_r ->> 'reason' = 'invalid_request' AND v_rows = 0,
    format('K4.7 (new) a NUMBER under the active version is invalid_request with no receipt: %s rows=%s', v_r, v_rows);
END
$k4_7_new$;

-- K4.8 (new) a logical map with a non-string entry is invalid_request too,
-- even for an edit where the logical map is otherwise not consumed.
DO $k4_8_new$
DECLARE
  v_r    jsonb := pg_temp.s4k_k4_claim_logical(408, 'cmt-k4-8-num', repeat('t', 64),
                   pg_temp.s4k_map(repeat('t', 64)), jsonb_build_object('1', 456));
  v_rows bigint := pg_temp.s4k_receipts(408);
BEGIN
  DELETE FROM public.youtube_comment_operations WHERE owner_id = pg_temp.s4k_owner() AND operation_id = pg_temp.s4k_op(408);
  ASSERT v_r ->> 'reason' = 'invalid_request' AND v_rows = 0,
    format('K4.8 (new) a non-string logical entry is invalid_request with no receipt: %s rows=%s', v_r, v_rows);
END
$k4_8_new$;

SELECT pg_temp.s4k_reset();

-- ===========================================================================
-- The migration's own durable state.
-- ===========================================================================
DO $durable$
BEGIN
  ASSERT to_regclass('public.youtube_comment_digest_key_watermark') IS NOT NULL, 'the watermark table exists';
  ASSERT (SELECT convalidated FROM pg_constraint
           WHERE conrelid = 'public.youtube_comment_operations'::regclass
             AND conname = 'youtube_comment_operations_intent_key_version_fkey'), 'the foreign key is validated';
  ASSERT (SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t
           WHERE t.tgrelid = 'public.youtube_comment_digest_keys'::regclass AND NOT t.tgisinternal)
      = ARRAY['trg_youtube_comment_digest_keys_guard'],
    'the digest keys still carry only the guard trigger';
END
$durable$;

-- Cleanup of the committed fixtures.
SELECT pg_temp.s4k_reset();
DELETE FROM public.social_accounts WHERE id IN ('6e7b0001-0000-4000-8000-000000000001', '6e7b0002-0000-4000-8000-000000000002');
DELETE FROM public.app_settings
 WHERE key IN ('feature_youtube_comments', 'youtube_comments_stage4_rollout')
   AND description LIKE 'Stage 4 suite%';
DELETE FROM auth.users WHERE id = '6e7a0001-0000-4000-8000-000000000001';
SELECT extensions.dblink_disconnect('s4k_a');
SELECT extensions.dblink_disconnect('s4k_b');
SELECT extensions.dblink_disconnect('s4k_c');

\echo '=== youtube_stage4_key_integrity: ALL CHECKS PASSED ==='
