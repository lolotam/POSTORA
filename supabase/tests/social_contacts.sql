-- ============================================================================
-- social_contacts.sql — Audience hub contact table, writer and read RPCs
--
-- Run only as a superuser against the disposable database created by
-- scripts/db-harness.sh. The suite commits its assertions and cleans its rows.
-- ============================================================================
\set ON_ERROR_STOP on
\echo '=== social_contacts: start ==='

CREATE TEMP TABLE sc_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO sc_ids VALUES
  ('owner_a', '88888888-8888-4888-8888-888888888801'),
  ('owner_b', '88888888-8888-4888-8888-888888888802'),
  ('acct_a',  '88888888-8888-4888-8888-888888888811'),
  ('acct_b',  '88888888-8888-4888-8888-888888888812'),
  ('acct_t',  '88888888-8888-4888-8888-888888888813');
GRANT SELECT ON sc_ids TO authenticated, service_role, anon;

CREATE OR REPLACE FUNCTION pg_temp.sc_cleanup() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_users UUID[] := ARRAY(SELECT id FROM sc_ids WHERE k IN ('owner_a','owner_b'));
BEGIN
  DELETE FROM public.social_contacts WHERE user_id = ANY(v_users);
  DELETE FROM public.social_accounts WHERE user_id = ANY(v_users);
  DELETE FROM auth.users WHERE id = ANY(v_users);
END $$;
CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_user::text, false)::void;
$$;
CREATE OR REPLACE FUNCTION pg_temp.must(p BOOLEAN, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %', label; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refused(p_sql TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN false; EXCEPTION WHEN insufficient_privilege THEN RETURN true; END $$;

SELECT pg_temp.sc_cleanup();

DO $seed$
DECLARE
  v_a UUID := (SELECT id FROM sc_ids WHERE k='owner_a');
  v_b UUID := (SELECT id FROM sc_ids WHERE k='owner_b');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_a, 'sc-owner-a@example.invalid'), (v_b, 'sc-owner-b@example.invalid')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active) VALUES
    ((SELECT id FROM sc_ids WHERE k='acct_a'), v_a, 'instagram', 'sc-ig-a', 'sc-a', 'seed', true),
    ((SELECT id FROM sc_ids WHERE k='acct_b'), v_b, 'instagram', 'sc-ig-b', 'sc-b', 'seed', true),
    ((SELECT id FROM sc_ids WHERE k='acct_t'), v_a, 'threads',   'sc-th-a', 'sc-th', 'seed', true)
  ON CONFLICT (id) DO NOTHING;
END $seed$;

-- (1) writer: insert, then increment; owner derived from the account
SET ROLE service_role;
DO $t$
DECLARE v_id1 UUID; v_id2 UUID; v_count INT; v_name TEXT; v_owner UUID;
BEGIN
  v_id1 := public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'instagram', '17841400000001', NULL, 'dana.kw', 'price?', 'post-1');
  v_id2 := public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'instagram', '17841400000001', '', NULL, 'still waiting', 'post-2');
  PERFORM pg_temp.must(v_id1 = v_id2, 'second touch returns the same row');
  SELECT total_comments_count, display_name, user_id INTO v_count, v_name, v_owner FROM public.social_contacts WHERE id = v_id1;
  PERFORM pg_temp.must(v_count = 2, 'count incremented to 2');
  PERFORM pg_temp.must(v_name = 'dana.kw', 'display_name fell back to username and an empty name did not erase it');
  PERFORM pg_temp.must(v_owner = (SELECT id FROM sc_ids WHERE k='owner_a'), 'owner derived from social_accounts');
END $t$;

-- (2) writer: no identity writes nothing; unknown account raises
DO $t$
BEGIN
  PERFORM pg_temp.must(public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'facebook', NULL, 'Someone', NULL, 'x', 'p') IS NULL, 'no identity returns null');
  PERFORM pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform='facebook') = 0, 'no identity wrote nothing');
  BEGIN
    PERFORM public.touch_social_contact('00000000-0000-4000-8000-000000000000', 'facebook', '1', 'A', NULL, 'x', 'p');
    RAISE EXCEPTION 'ASSERTION FAILED: unknown account accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%social_account_not_found%' THEN RAISE; END IF;
  END;
END $t$;

-- (3) Threads promotion: username row is re-keyed when an id arrives
DO $t$
DECLARE v_u UUID; v_i UUID; v_kind TEXT; v_count INT;
BEGIN
  v_u := public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_t'), 'threads', NULL, NULL, 'vigrox.kw', 'hi', 'th-1');
  v_i := public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_t'), 'threads', '28097456199906', NULL, 'vigrox.kw', 'again', 'th-2');
  PERFORM pg_temp.must(v_u = v_i, 'username row promoted to id row');
  SELECT identity_kind, total_comments_count INTO v_kind, v_count FROM public.social_contacts WHERE id = v_i;
  PERFORM pg_temp.must(v_kind = 'id' AND v_count = 2, 'promoted row keeps the count');
  -- A later reply carries no id again. It must find the promoted row by handle, not start a
  -- twin: that was the bug where one Threads commenter became two permanent rows.
  PERFORM public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_t'), 'threads', NULL, NULL, 'vigrox.kw', 'x', 'th-3');
  PERFORM public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_t'), 'threads', '28097456199906', NULL, 'vigrox.kw', 'y', 'th-4');
  PERFORM pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform='threads' AND username='vigrox.kw') = 1, 'reply and mention stay one row');
  PERFORM pg_temp.must((SELECT total_comments_count FROM public.social_contacts WHERE platform='threads' AND username='vigrox.kw') = 4, 'all four Threads touches counted on that row');
END $t$;
RESET ROLE;

-- (4) privileges: authenticated and anon cannot execute the writer; anon cannot read
SET ROLE authenticated;
SELECT pg_temp.must(pg_temp.refused($$SELECT public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'instagram', 'z', NULL, NULL, NULL, NULL)$$), 'authenticated cannot call the writer');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.must(pg_temp.refused($$SELECT public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'instagram', 'z', NULL, NULL, NULL, NULL)$$), 'anon cannot call the writer');
SELECT pg_temp.must(pg_temp.refused($$SELECT * FROM public.get_social_contacts_stats()$$), 'anon cannot call stats');
SELECT pg_temp.must(pg_temp.refused($$SELECT * FROM public.search_social_contacts(NULL, NULL, NULL, NULL, 10, 0)$$), 'anon cannot call search');
RESET ROLE;

-- (5) RLS: owner reads/updates own row; other user sees nothing and cannot update or delete
SET ROLE authenticated;
SELECT pg_temp.act_as((SELECT id FROM sc_ids WHERE k='owner_a'));
SELECT pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform_user_id='17841400000001') = 1, 'owner reads own contact');
UPDATE public.social_contacts SET tags = ARRAY['lead'] WHERE platform_user_id='17841400000001';
SELECT pg_temp.must((SELECT tags FROM public.social_contacts WHERE platform_user_id='17841400000001') = ARRAY['lead'], 'owner updates own contact');
-- composite FK: owner cannot attach another user's account
DO $t$
BEGIN
  UPDATE public.social_contacts SET social_account_id = (SELECT id FROM sc_ids WHERE k='acct_b') WHERE platform_user_id='17841400000001';
  RAISE EXCEPTION 'ASSERTION FAILED: foreign account attached';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END $t$;

SELECT pg_temp.act_as((SELECT id FROM sc_ids WHERE k='owner_b'));
SELECT pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform_user_id='17841400000001') = 0, 'other user cannot read');
UPDATE public.social_contacts SET notes = 'stolen' WHERE platform_user_id='17841400000001';
DELETE FROM public.social_contacts WHERE platform_user_id='17841400000001';
RESET ROLE;
SELECT pg_temp.must((SELECT notes IS NULL FROM public.social_contacts WHERE platform_user_id='17841400000001'), 'other user update was a no-op');
SELECT pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform_user_id='17841400000001') = 1, 'other user delete was a no-op');

-- (6) read RPCs under RLS
SET ROLE authenticated;
SELECT pg_temp.act_as((SELECT id FROM sc_ids WHERE k='owner_a'));
SELECT pg_temp.must((SELECT total FROM public.get_social_contacts_stats()) = 2, 'stats total counts owner rows only');
-- One row per platform, so the tie breaks on the name: instagram sorts first.
SELECT pg_temp.must((SELECT top_platform FROM public.get_social_contacts_stats()) = 'instagram', 'top platform breaks ties by name');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts('dana', NULL, NULL, NULL, 50, 0)) = 1, 'search by username');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts('%', NULL, NULL, NULL, 50, 0)) = 0, 'a literal % is escaped, not a wildcard');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts(NULL, 'threads', NULL, NULL, 50, 0)) = 1, 'platform filter');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts(NULL, NULL, NULL, ARRAY['lead'], 50, 0)) = 1, 'tag filter');
SELECT pg_temp.must((SELECT row_count FROM public.search_social_contacts(NULL, NULL, NULL, NULL, 1, 0)) = 2, 'row_count reports the unpaged total');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts(NULL, NULL, 'organic_comment', NULL, 50, 0)) = 2, 'source filter keeps organic rows');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts(NULL, NULL, 'workflow_lead', NULL, 50, 0)) = 0, 'source filter excludes non-leads');
SELECT pg_temp.act_as((SELECT id FROM sc_ids WHERE k='owner_b'));
SELECT pg_temp.must((SELECT total FROM public.get_social_contacts_stats()) = 0, 'stats total = 0 for other');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts(NULL, NULL, NULL, NULL, 50, 0)) = 0, 'search returns nothing for other');
RESET ROLE;

-- (7) deleting the account nulls only the reference, never the owner
DO $t$
DECLARE v_owner UUID; v_acct UUID;
BEGIN
  DELETE FROM public.social_accounts WHERE id = (SELECT id FROM sc_ids WHERE k='acct_a');
  SELECT user_id, social_account_id INTO v_owner, v_acct
    FROM public.social_contacts WHERE platform_user_id='17841400000001';
  PERFORM pg_temp.must(v_acct IS NULL, 'social_account_id nulled by the account delete');
  PERFORM pg_temp.must(v_owner = (SELECT id FROM sc_ids WHERE k='owner_a'), 'user_id survived the account delete');
END $t$;

-- (8) flag seeded
SELECT pg_temp.must((SELECT value = 'false'::jsonb FROM public.app_settings WHERE key='feature_audience_hub'), 'flag seeded false');

SELECT pg_temp.sc_cleanup();
\echo '=== social_contacts: ALL CHECKS PASSED ==='
