-- ============================================================================
-- comment_workflow.sql — Comment Workflow rules, events, usage claims, stats
--
-- Run only as a superuser against the disposable database created by
-- scripts/db-harness.sh. The suite commits its assertions and cleans its rows.
--
-- What it is here to prove, in order of what would hurt most if it broke:
--   1. a rule cannot be attached to another user's account, or another user's
--      file, or a platform its account is not (composite FKs)
--   2. one user cannot see or change another's rules, events or stats (RLS)
--   3. a client cannot write the audit trail at all
--   4. the CHECKs reject every configuration that would claim a comment and
--      then do nothing with it
--   5. one event per comment, one usage claim per (rule, person, post)
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== comment_workflow: start ==='

CREATE TEMP TABLE cw_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO cw_ids VALUES
  ('owner_a',  '88888888-8888-4888-8888-888888888801'),
  ('owner_b',  '88888888-8888-4888-8888-888888888802'),
  ('acct_a',   '88888888-8888-4888-8888-888888888811'),
  ('acct_b',   '88888888-8888-4888-8888-888888888812'),
  ('acct_th',  '88888888-8888-4888-8888-888888888813'),
  ('rule_a',   '88888888-8888-4888-8888-888888888821'),
  ('media_a',  '88888888-8888-4888-8888-888888888831'),
  ('media_b',  '88888888-8888-4888-8888-888888888832');

CREATE OR REPLACE FUNCTION pg_temp.cw_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_users UUID[] := ARRAY(SELECT id FROM cw_ids WHERE k IN ('owner_a', 'owner_b'));
BEGIN
  DELETE FROM public.comment_workflow_rules WHERE user_id = ANY(v_users);
  DELETE FROM public.media_files WHERE user_id = ANY(v_users);
  DELETE FROM public.social_accounts WHERE user_id = ANY(v_users);
  DELETE FROM auth.users WHERE id = ANY(v_users);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.cw_act_as(p_user UUID) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_user::text, false)::void;
$$;

CREATE OR REPLACE FUNCTION pg_temp.cw_must(p_condition BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

SELECT pg_temp.cw_cleanup();

INSERT INTO auth.users (id, email) VALUES
  ('88888888-8888-4888-8888-888888888801', 'cw-owner-a@example.invalid'),
  ('88888888-8888-4888-8888-888888888802', 'cw-owner-b@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
VALUES
  ('88888888-8888-4888-8888-888888888811', '88888888-8888-4888-8888-888888888801', 'facebook',  'cw-page-a', 'CW Page A', 'seed-a', true),
  ('88888888-8888-4888-8888-888888888812', '88888888-8888-4888-8888-888888888802', 'instagram', 'cw-ig-b',   'cw_ig_b',   'seed-b', true),
  ('88888888-8888-4888-8888-888888888813', '88888888-8888-4888-8888-888888888801', 'threads',   'cw-th-a',   'cw_th_a',   'seed-t', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.media_files (id, user_id, file_path, file_type, storage_bucket) VALUES
  ('88888888-8888-4888-8888-888888888831', '88888888-8888-4888-8888-888888888801',
   '88888888-8888-4888-8888-888888888801/cw-guide.pdf', 'document', 'media'),
  ('88888888-8888-4888-8888-888888888832', '88888888-8888-4888-8888-888888888802',
   '88888888-8888-4888-8888-888888888802/cw-other.pdf', 'document', 'media')
ON CONFLICT (id) DO NOTHING;


-- (1) Structural tenancy. Edge Functions run under the service role, so RLS is enforcing
--     nothing for the code that writes these rows — only these keys are.
DO $structural_tenancy$
BEGIN
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
    VALUES ('88888888-8888-4888-8888-888888888802', '88888888-8888-4888-8888-888888888811',
            'facebook', 'steal account', 'any', '{}', '{hi}');
    RAISE EXCEPTION 'unexpected success: a rule was attached to another user''s account';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- The denormalized platform cannot disagree with the account's. This is what makes the
  -- "Threads rules carry no DM" constraint unbypassable rather than advisory.
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888813',
            'facebook', 'mislabelled threads account', 'any', '{}', '{hi}', 'sneaky dm');
    RAISE EXCEPTION 'unexpected success: a rule claimed a platform its account is not';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- A rule can only attach a file its own owner owns. Without the composite key a user could
  -- name someone else's media row and have the service role sign that object for them.
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message, media_file_id)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'steal media', 'any', '{}', '{hi}', 'here', '88888888-8888-4888-8888-888888888832');
    RAISE EXCEPTION 'unexpected success: a rule attached another user''s file';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $structural_tenancy$;
\echo 'PASS 1: composite keys bind a rule to its owner, its account, its platform and its own files'


-- (2) Every CHECK. Each stands for a rule that would claim a comment — suppressing every
--     other automation on it — and then do nothing visible.
DO $checks$
BEGIN
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'no keywords', 'exact', '{}', '{hi}');
    RAISE EXCEPTION 'unexpected success: an exact rule with no keywords was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A whitespace keyword is not a keyword. Left in, it would be trimmed to '' at match time
  -- and claim every comment on the account.
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'blank keyword', 'contains', ARRAY['price', '   '], '{hi}');
    RAISE EXCEPTION 'unexpected success: a blank keyword was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- cardinality() alone would have let ARRAY[''] through.
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'blank reply', 'any', '{}', ARRAY['']);
    RAISE EXCEPTION 'unexpected success: an empty public reply was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'blank dm', 'any', '{}', '{}', '   ');
    RAISE EXCEPTION 'unexpected success: a blank private message was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'overlong dm', 'any', '{}', '{}', repeat('x', 1001));
    RAISE EXCEPTION 'unexpected success: a private message over the platform limit was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'too many replies', 'any', '{}', ARRAY['a','b','c','d','e','f']);
    RAISE EXCEPTION 'unexpected success: more public replies than the form allows were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', '   ', 'any', '{}', '{hi}');
    RAISE EXCEPTION 'unexpected success: a blank name was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'does nothing', 'any', '{}', '{}', NULL);
    RAISE EXCEPTION 'unexpected success: a rule that neither replies nor DMs was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888813',
            'threads', 'threads dm', 'any', '{}', '{hi}', 'private');
    RAISE EXCEPTION 'unexpected success: a Threads rule carried a private message';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A real media row, so the composite FK is satisfied and only cwr_media_needs_dm can be
  -- what rejects this. A random uuid would have been refused by the FK and the CHECK would
  -- have gone untested.
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, media_file_id)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'orphan media', 'any', '{}', '{hi}', '88888888-8888-4888-8888-888888888831');
    RAISE EXCEPTION 'unexpected success: a file was attached with no private message to carry it';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'tiktok', 'out of scope', 'any', '{}', '{hi}');
    RAISE EXCEPTION 'unexpected success: tiktok was accepted as a platform';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $checks$;
\echo 'PASS 2: CHECK constraints reject every rule that would claim a comment and do nothing'


-- A valid rule, used by everything below. A Threads rule too, to prove the public-only shape
-- is expressible.
INSERT INTO public.comment_workflow_rules
  (id, user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message, media_file_id)
VALUES
  ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888801',
   '88888888-8888-4888-8888-888888888811', 'facebook', 'guide funnel',
   'exact', '{GUIDE}', '{"Check your DM"}', 'Here is the guide', '88888888-8888-4888-8888-888888888831');

INSERT INTO public.comment_workflow_rules
  (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
VALUES
  ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888813',
   'threads', 'threads public funnel', 'contains', '{price}', '{"DM us"}');


-- (3) Events: one per comment, several per person.
INSERT INTO public.comment_workflow_events
  (rule_id, user_id, social_account_id, platform, external_post_id, external_comment_id,
   author_key, public_reply_status, dm_status)
VALUES
  ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888801',
   '88888888-8888-4888-8888-888888888811', 'facebook', 'post-1', 'comment-1', 'author-1', 'sent', 'sent'),
  ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888801',
   '88888888-8888-4888-8888-888888888811', 'facebook', 'post-1', 'comment-2', 'author-1', 'skipped', 'skipped');

DO $events$
BEGIN
  BEGIN
    INSERT INTO public.comment_workflow_events
      (rule_id, user_id, social_account_id, platform, external_comment_id, author_key,
       public_reply_status, dm_status)
    VALUES ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888801',
            '88888888-8888-4888-8888-888888888811', 'facebook', 'comment-1', 'author-1', 'pending', 'pending');
    RAISE EXCEPTION 'unexpected success: the same comment was claimed twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- An event cannot name a user who does not own its rule.
  BEGIN
    INSERT INTO public.comment_workflow_events
      (rule_id, user_id, social_account_id, platform, external_comment_id, author_key,
       public_reply_status, dm_status)
    VALUES ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888802',
            '88888888-8888-4888-8888-888888888812', 'instagram', 'forged-1', 'x', 'sent', 'sent');
    RAISE EXCEPTION 'unexpected success: an event was attributed to a user who does not own the rule';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- An indeterminate send is representable: a timeout is not proof of non-delivery.
  INSERT INTO public.comment_workflow_events
    (rule_id, user_id, social_account_id, platform, external_post_id, external_comment_id,
     author_key, public_reply_status, dm_status)
  VALUES ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888801',
          '88888888-8888-4888-8888-888888888811', 'facebook', 'post-1', 'comment-3', 'author-1', 'sent', 'indeterminate');

  PERFORM pg_temp.cw_must(
    (SELECT count(*) FROM public.comment_workflow_events WHERE author_key = 'author-1') = 3,
    'one person can produce several event rows');
END $events$;
\echo 'PASS 3: one event per comment, several per person, bound to the rule''s owner'


-- (4) Usage claims.
DO $usage$
BEGIN
  INSERT INTO public.comment_workflow_usage (rule_id, author_key, external_post_id)
  VALUES ('88888888-8888-4888-8888-888888888821', 'author-1', 'post-1');

  BEGIN
    INSERT INTO public.comment_workflow_usage (rule_id, author_key, external_post_id)
    VALUES ('88888888-8888-4888-8888-888888888821', 'author-1', 'post-1');
    RAISE EXCEPTION 'unexpected success: the same person claimed the same post twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  INSERT INTO public.comment_workflow_usage (rule_id, author_key, external_post_id)
  VALUES ('88888888-8888-4888-8888-888888888821', 'author-1', 'post-2');

  INSERT INTO public.comment_workflow_usage (rule_id, author_key)
  VALUES ('88888888-8888-4888-8888-888888888821', 'author-2');
  PERFORM pg_temp.cw_must(
    EXISTS (SELECT 1 FROM public.comment_workflow_usage
            WHERE author_key = 'author-2' AND external_post_id = ''),
    'a claim with no post id lands under the empty-string key');
END $usage$;
\echo 'PASS 4: usage claims are unique per (rule, person, post) and survive a missing post id'


-- (5) The stats view.
DO $stats$
DECLARE
  v_stats RECORD;
BEGIN
  SELECT * INTO v_stats FROM public.comment_workflow_rule_stats
  WHERE rule_id = '88888888-8888-4888-8888-888888888821';
  PERFORM pg_temp.cw_must(v_stats.triggered_count = 3, 'stats count every claimed comment');
  PERFORM pg_temp.cw_must(v_stats.public_sent_count = 2, 'stats count sent public replies');
  PERFORM pg_temp.cw_must(v_stats.dm_sent_count = 1, 'stats count sent DMs');
  PERFORM pg_temp.cw_must(v_stats.failed_count = 0, 'an indeterminate send is not counted as a failure');
  PERFORM pg_temp.cw_must(v_stats.indeterminate_count = 1, 'stats surface indeterminate sends separately');
  PERFORM pg_temp.cw_must(v_stats.last_triggered_at IS NOT NULL, 'stats carry a last-triggered time');
  PERFORM pg_temp.cw_must(v_stats.last_error_message IS NULL AND v_stats.last_error_at IS NULL,
    'a rule with no failed send carries no last error');

  -- Two failures, then a success. The card must show the NEWEST failure's reason, and a later
  -- success must not erase it: the user still needs to know why the earlier one failed.
  INSERT INTO public.comment_workflow_events
    (rule_id, user_id, social_account_id, platform, external_post_id, external_comment_id,
     author_key, public_reply_status, dm_status, error_message, created_at)
  VALUES
    ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888801',
     '88888888-8888-4888-8888-888888888811', 'facebook', 'post-1', 'comment-4', 'author-2',
     'skipped', 'failed', 'older failure', now() - interval '2 hours'),
    ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888801',
     '88888888-8888-4888-8888-888888888811', 'facebook', 'post-1', 'comment-5', 'author-3',
     'failed', 'not_applicable', 'Private replies to Facebook Pages are not allowed.', now() - interval '1 hour'),
    ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888801',
     '88888888-8888-4888-8888-888888888811', 'facebook', 'post-1', 'comment-6', 'author-4',
     'sent', 'sent', NULL, now());

  SELECT * INTO v_stats FROM public.comment_workflow_rule_stats
  WHERE rule_id = '88888888-8888-4888-8888-888888888821';
  PERFORM pg_temp.cw_must(v_stats.triggered_count = 6, 'stats still count every claimed comment');
  PERFORM pg_temp.cw_must(v_stats.failed_count = 2, 'stats count a failure on either leg');
  PERFORM pg_temp.cw_must(v_stats.last_error_message = 'Private replies to Facebook Pages are not allowed.',
    'the last error is the newest failed event''s message, not the oldest and not the latest success');
  PERFORM pg_temp.cw_must(
    v_stats.last_error_at = (SELECT created_at FROM public.comment_workflow_events WHERE external_comment_id = 'comment-5'),
    'the last error carries the time of the event it came from');
  PERFORM pg_temp.cw_must(
    v_stats.last_triggered_at = (SELECT created_at FROM public.comment_workflow_events WHERE external_comment_id = 'comment-6'),
    'last triggered still tracks the newest event of any outcome');
END $stats$;
\echo 'PASS 5: the stats view aggregates events per rule, keeps indeterminate apart from failed, and carries the newest failure reason'


-- (6) RLS.
SET ROLE authenticated;
SELECT pg_temp.cw_act_as('88888888-8888-4888-8888-888888888801');
DO $rls_owner$
BEGIN
  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_rules) = 2,
    'the owner sees their own rules');
  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_events) = 6,
    'the owner sees their own events');
  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_rule_stats) = 1,
    'the owner sees their own stats row');
END $rls_owner$;

SELECT pg_temp.cw_act_as('88888888-8888-4888-8888-888888888802');
DO $rls_outsider$
BEGIN
  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_rules) = 0,
    'another user sees no rules');
  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_events) = 0,
    'another user sees no events');
  -- security_invoker is what makes this hold: without it the view reads as its owner and
  -- hands every user everyone else's counters.
  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_rule_stats) = 0,
    'the stats view does not leak across users');

  UPDATE public.comment_workflow_rules SET is_active = false
  WHERE id = '88888888-8888-4888-8888-888888888821';
  PERFORM pg_temp.cw_must(NOT FOUND, 'another user cannot deactivate a foreign rule');

  DELETE FROM public.comment_workflow_rules WHERE id = '88888888-8888-4888-8888-888888888821';
  PERFORM pg_temp.cw_must(NOT FOUND, 'another user cannot delete a foreign rule');

  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies)
    VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
            'facebook', 'forged rule', 'any', '{}', '{hi}');
    RAISE EXCEPTION 'unexpected success: a rule was written on another user''s behalf';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.comment_workflow_events
      (rule_id, user_id, social_account_id, platform, external_comment_id, author_key,
       public_reply_status, dm_status)
    VALUES ('88888888-8888-4888-8888-888888888821', '88888888-8888-4888-8888-888888888802',
            '88888888-8888-4888-8888-888888888811', 'facebook', 'forged', 'x', 'sent', 'sent');
    RAISE EXCEPTION 'unexpected success: a client wrote the audit trail';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.comment_workflow_events SET dm_status = 'sent' WHERE external_comment_id = 'comment-1';
    PERFORM pg_temp.cw_must(NOT FOUND, 'a client cannot rewrite the audit trail');
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_usage) = 0,
    'usage claims are invisible to clients');
  BEGIN
    INSERT INTO public.comment_workflow_usage (rule_id, author_key)
    VALUES ('88888888-8888-4888-8888-888888888821', 'forged');
    RAISE EXCEPTION 'unexpected success: a client wrote a usage claim';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $rls_outsider$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
\echo 'PASS 6: cross-user denial on rules, events, stats and usage claims'


-- (7) Deleting a rule takes its history with it. Stated here because it is a real trade-off:
--     the audit trail is append-only while the rule lives, and gone when the rule is deleted.
DO $cascade$
BEGIN
  DELETE FROM public.comment_workflow_rules WHERE id = '88888888-8888-4888-8888-888888888821';
  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_events
                           WHERE rule_id = '88888888-8888-4888-8888-888888888821') = 0,
    'deleting a rule removes its events');
  PERFORM pg_temp.cw_must((SELECT count(*) FROM public.comment_workflow_usage
                           WHERE rule_id = '88888888-8888-4888-8888-888888888821') = 0,
    'deleting a rule removes its usage claims');
END $cascade$;
\echo 'PASS 7: deleting a rule cascades to its events and claims'

-- (7b) Deleting an attached file detaches it and leaves the workflow standing. A bare
--      ON DELETE SET NULL on the composite key would null user_id too and fail its NOT NULL,
--      making the file undeletable while any workflow references it.
DO $media_detach$
DECLARE
  v_rule UUID;
BEGIN
  INSERT INTO public.comment_workflow_rules
    (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message, media_file_id)
  VALUES ('88888888-8888-4888-8888-888888888801', '88888888-8888-4888-8888-888888888811',
          'facebook', 'attachment funnel', 'any', '{}', '{hi}', 'here it is',
          '88888888-8888-4888-8888-888888888831')
  RETURNING id INTO v_rule;

  DELETE FROM public.media_files WHERE id = '88888888-8888-4888-8888-888888888831';

  PERFORM pg_temp.cw_must(
    EXISTS (SELECT 1 FROM public.comment_workflow_rules WHERE id = v_rule AND media_file_id IS NULL),
    'deleting a file detaches it and leaves the workflow');
  PERFORM pg_temp.cw_must(
    (SELECT user_id FROM public.comment_workflow_rules WHERE id = v_rule) = '88888888-8888-4888-8888-888888888801',
    'detaching a file does not disturb the workflow owner');
END $media_detach$;
\echo 'PASS 7b: deleting an attached file detaches it rather than failing'


-- (8) The feature ships off.
DO $flag$
BEGIN
  PERFORM pg_temp.cw_must(
    (SELECT value FROM public.app_settings WHERE key = 'feature_comment_workflow') = 'false'::jsonb,
    'the comment workflow flag is seeded off');
END $flag$;
\echo 'PASS 8: the feature flag ships off'

SELECT pg_temp.cw_cleanup();
\echo '=== comment_workflow: ALL CHECKS PASSED ==='
