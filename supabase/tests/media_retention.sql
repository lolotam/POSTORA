-- supabase/tests/media_retention.sql
-- Media retention (migration 20261001100000): per-user age, warn-only until
-- delete_enabled, set-based reference protection, claim/release, column
-- guard, media_set_keep, preview, grants, cron.
-- Style: one transaction, fixtures inside, labelled assertions, expected
-- errors in nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last.
-- Fixtures are synthetic ('...@example.invalid'). No secrets or real data.
BEGIN;
-- Fixture posts must not hit the per-plan daily post quota; the ROLLBACK restores the trigger.
ALTER TABLE public.posts DISABLE TRIGGER trg_enforce_post_quota_on_insert;

CREATE FUNCTION pg_temp.mfile(
  p_id uuid,
  p_user uuid,
  p_bucket text DEFAULT 'openinary',
  p_cloud text DEFAULT 'yes',
  p_created timestamptz DEFAULT NULL
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO public.media_files (
    id, user_id, file_path, file_type, storage_bucket, cloudinary_public_id, created_at
  ) VALUES (
    p_id,
    p_user,
    'https://cdn.example.invalid/r/' || p_id::text,
    'image',
    p_bucket,
    CASE WHEN p_cloud IS NULL THEN NULL ELSE 'cid-' || p_id::text END,
    coalesce(p_created, now() - interval '400 days')
  );
$$;

DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
  u_b uuid := 'b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7';
  v_rollout timestamptz;
  v_days int;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'retention-a-' || u_a::text || '@example.invalid'),
    (u_b, 'retention-b-' || u_b::text || '@example.invalid');

  -- S1: only 7, 30, 90 or NULL.
  BEGIN
    UPDATE public.profiles SET media_retention_days = 14 WHERE id = u_a;
    RAISE EXCEPTION 'S1 failed: retention 14 accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.profiles SET media_retention_days = 7 WHERE id = u_a;
  UPDATE public.profiles SET media_retention_days = 90 WHERE id = u_a;
  UPDATE public.profiles SET media_retention_days = NULL WHERE id = u_a;
  ASSERT (SELECT media_retention_days FROM public.profiles WHERE id = u_a) IS NULL,
    'S1 NULL (never) is accepted';
  UPDATE public.profiles SET media_retention_days = 30 WHERE id = u_a;
  UPDATE public.profiles SET media_retention_days = 30 WHERE id = u_b;

  -- S2: re-applying the column add does not rewrite NULL, and the settings
  -- insert does not move rollout_at.
  UPDATE public.profiles SET media_retention_days = NULL WHERE id = u_b;
  ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS media_retention_days integer DEFAULT 30;
  ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS media_retention_days integer DEFAULT 30;
  ASSERT (SELECT media_retention_days FROM public.profiles WHERE id = u_b) IS NULL,
    'S2 re-apply leaves NULL (never) in place';
  UPDATE public.profiles SET media_retention_days = 30 WHERE id = u_b;

  SELECT rollout_at INTO v_rollout FROM public.media_retention_settings WHERE id = 1;
  INSERT INTO public.media_retention_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  ASSERT (SELECT rollout_at FROM public.media_retention_settings WHERE id = 1) = v_rollout,
    'S2 re-insert does not move rollout_at';
  ASSERT (SELECT delete_enabled FROM public.media_retention_settings WHERE id = 1) = false,
    'S2 delete_enabled defaults false';

  -- S3: a file older than the retention window is not warned while rollout_at
  -- is still "now" (age is counted from the rollout).
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111123', u_a);
  UPDATE public.media_retention_settings SET rollout_at = now() WHERE id = 1;
  PERFORM * FROM public.media_retention_sweep(now(), 50);
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111123') IS NULL,
    'S3 rollout_at blocks a warning for a pre-existing file';
  UPDATE public.media_retention_settings
  SET rollout_at = now() - interval '400 days'
  WHERE id = 1;
END $$;

-- Reference map, buckets, keep, and the first real warn. Superuser writes the
-- fixtures; sweep is SECURITY DEFINER and is also called as service_role below.
DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
  u_b uuid := 'b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7';
  ws uuid := 'c7c7c7c7-c7c7-47c7-87c7-c7c7c7c7c7c7';
  acct_fb uuid := 'e7e7e7e7-e7e7-47e7-87e7-e7e7e7e7e7e7';
  acct_wa uuid := 'e8e8e8e8-e8e8-47e8-87e8-e8e8e8e8e8e8';
  wf uuid := 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0';
  v_now timestamptz := now();
  v_logs int;
  v_warned int;
  protected uuid[] := ARRAY[
    '11111111-1111-4111-8111-111111111102',
    '11111111-1111-4111-8111-111111111103',
    '11111111-1111-4111-8111-111111111104',
    '11111111-1111-4111-8111-111111111105',
    '11111111-1111-4111-8111-111111111106',
    '11111111-1111-4111-8111-111111111107',
    '11111111-1111-4111-8111-111111111108',
    '11111111-1111-4111-8111-111111111109',
    '11111111-1111-4111-8111-11111111110a',
    '11111111-1111-4111-8111-11111111110b',
    '11111111-1111-4111-8111-11111111110c',
    '11111111-1111-4111-8111-11111111110d',
    '11111111-1111-4111-8111-11111111110e',
    '11111111-1111-4111-8111-11111111110f',
    '11111111-1111-4111-8111-111111111110',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111112',
    '11111111-1111-4111-8111-111111111113',
    '11111111-1111-4111-8111-111111111114',
    '11111111-1111-4111-8111-111111111115',
    '11111111-1111-4111-8111-111111111116',
    '11111111-1111-4111-8111-111111111117',
    '11111111-1111-4111-8111-111111111118',
    '11111111-1111-4111-8111-111111111119',
    '11111111-1111-4111-8111-11111111111a'
  ];
  fid uuid;
BEGIN
  INSERT INTO public.workspaces (id, name, owner_id) VALUES (ws, 'retention workspace', u_a);
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES (acct_fb, u_a, 'facebook', 'mret-fb', 'token-mret-fb');
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id)
  VALUES (acct_wa, u_a, 'whatsapp', 'mret-wa', 'token-mret-wa', ws);

  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111101', u_a); -- control
  PERFORM pg_temp.mfile(protected[1], u_a);
  PERFORM pg_temp.mfile(protected[2], u_a);
  PERFORM pg_temp.mfile(protected[3], u_a);
  PERFORM pg_temp.mfile(protected[4], u_a);
  PERFORM pg_temp.mfile(protected[5], u_a);
  PERFORM pg_temp.mfile(protected[6], u_a);
  PERFORM pg_temp.mfile(protected[7], u_a);
  PERFORM pg_temp.mfile(protected[8], u_a);
  PERFORM pg_temp.mfile(protected[9], u_a);
  PERFORM pg_temp.mfile(protected[10], u_a);
  PERFORM pg_temp.mfile(protected[11], u_a);
  PERFORM pg_temp.mfile(protected[12], u_a);
  PERFORM pg_temp.mfile(protected[13], u_a);
  PERFORM pg_temp.mfile(protected[14], u_a); -- canvas a
  PERFORM pg_temp.mfile(protected[15], u_a); -- canvas b
  PERFORM pg_temp.mfile(protected[16], u_a);
  PERFORM pg_temp.mfile(protected[17], u_a);
  PERFORM pg_temp.mfile(protected[18], u_a);
  PERFORM pg_temp.mfile(protected[19], u_a);
  PERFORM pg_temp.mfile(protected[20], u_a);
  PERFORM pg_temp.mfile(protected[21], u_a);
  PERFORM pg_temp.mfile(protected[22], u_a);
  PERFORM pg_temp.mfile(protected[23], u_a);
  PERFORM pg_temp.mfile(protected[24], u_a); -- shared object
  PERFORM pg_temp.mfile(protected[25], u_a); -- alias target

  -- Canvas duplicates share a file_path. Object-identity and address-alias
  -- holders live in partner-media so they are references, not candidates.
  UPDATE public.media_files
  SET file_path = 'https://cdn.example.invalid/r/canvas-duplicate-row'
  WHERE id IN (protected[14], protected[15]);

  PERFORM pg_temp.mfile('11111111-1111-4111-8111-11111111111b', u_a, 'partner-media');
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-11111111111c', u_a, 'partner-media');
  INSERT INTO public.media_file_providers (media_file_id, provider, object_key, delivery_url, status)
  VALUES
    (protected[24], 'cloudinary', 'retention-shared-object-key',
     'https://cdn.example.invalid/r/provider/' || protected[24]::text, 'ready'),
    ('11111111-1111-4111-8111-11111111111b', 'cloudinary', 'retention-shared-object-key',
     'https://cdn.example.invalid/r/provider/other-object', 'ready'),
    ('11111111-1111-4111-8111-11111111111c', 'openinary', 'retention-alias-holder-key',
     (SELECT file_path FROM public.media_files WHERE id = protected[25]), 'ready');

  PERFORM pg_temp.mfile('11111111-1111-4111-8111-11111111111d', u_a, 'partner-media');
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-11111111111e', u_a, 'media');
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-11111111111f', u_a, 'supabase');
  INSERT INTO public.media_files (id, user_id, file_path, file_type, storage_bucket, cloudinary_public_id, created_at)
  VALUES ('11111111-1111-4111-8111-111111111120', u_a,
          'https://cdn.example.invalid/r/11111111-1111-4111-8111-111111111120',
          'image', 'openinary', NULL, now() - interval '400 days');
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111121', u_a);
  UPDATE public.media_files SET keep_forever = true
  WHERE id = '11111111-1111-4111-8111-111111111121';
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111122', u_a, 'openinary', 'yes', now() - interval '10 days');
  -- Explicitly not protected.
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111124', u_a);
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111125', u_a);
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111126', u_a);
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111127', u_a);
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-111111111128', u_a);

  INSERT INTO public.posts (user_id, platforms, media_file_ids)
  VALUES (u_a, ARRAY['facebook']::text[], ARRAY[protected[1]]);

  INSERT INTO public.comment_workflow_rules
    (user_id, social_account_id, platform, name, match_type, dm_message, media_file_id)
  VALUES (u_a, acct_fb, 'facebook', 'retention rule', 'any', 'thanks', protected[2]);

  INSERT INTO public.workflows (id, user_id, name, nodes)
  VALUES (wf, u_a, 'retention flow',
          jsonb_build_array(jsonb_build_object('media_file_id', protected[3]::text)));
  UPDATE public.workflows
  SET thumbnail_url = (SELECT file_path FROM public.media_files WHERE id = protected[19])
  WHERE id = wf;

  INSERT INTO public.workflow_versions (workflow_id, version_number, nodes, edges)
  VALUES (wf, 1,
          jsonb_build_array(jsonb_build_object('url',
            (SELECT file_path FROM public.media_files WHERE id = protected[4]))),
          '[]'::jsonb);

  INSERT INTO public.workflow_templates (name, category, nodes, preview_image_url)
  VALUES ('retention template', 'library',
          jsonb_build_array(jsonb_build_object('media_file_id', protected[5]::text)),
          (SELECT file_path FROM public.media_files WHERE id = protected[20]));

  UPDATE public.profiles
  SET avatar_url = (SELECT file_path FROM public.media_files WHERE id = protected[6])
  WHERE id = u_a;

  INSERT INTO public.app_settings (key, value)
  VALUES
    ('app_logo', to_jsonb((SELECT file_path FROM public.media_files WHERE id = protected[7]))),
    ('app_favicon', to_jsonb((SELECT file_path FROM public.media_files WHERE id = protected[8])));

  INSERT INTO public.image_reference_presets (user_id, name, reference_images)
  VALUES (u_a, 'retention preset',
          jsonb_build_array((SELECT file_path FROM public.media_files WHERE id = protected[9])));

  INSERT INTO public.posts (user_id, platforms, metadata)
  VALUES (u_a, ARRAY['youtube']::text[],
          jsonb_build_object('youtube_thumbnail',
            (SELECT file_path FROM public.media_files WHERE id = protected[10])));

  INSERT INTO public.whatsapp_scheduled_messages
    (user_id, social_account_id, recipient_phone, scheduled_at, media_url, status)
  VALUES
    (u_a, acct_wa, '96555510011', now() + interval '1 day',
     (SELECT file_path FROM public.media_files WHERE id = protected[11]), 'pending'),
    (u_a, acct_wa, '96555510012', now() + interval '1 day',
     (SELECT file_path FROM public.media_files WHERE id = '11111111-1111-4111-8111-111111111125'),
     'sent');

  INSERT INTO public.whatsapp_broadcasts (user_id, name, template_name, template_components, status)
  VALUES
    (u_a, 'retention broadcast', 'hello',
     jsonb_build_array(jsonb_build_object('url',
       (SELECT file_path FROM public.media_files WHERE id = protected[12]))),
     'pending'),
    (u_a, 'done broadcast', 'hello',
     jsonb_build_array(jsonb_build_object('url',
       (SELECT file_path FROM public.media_files WHERE id = '11111111-1111-4111-8111-111111111126'))),
     'completed');

  INSERT INTO public.blog_posts (title, content, cover_image_url)
  VALUES ('retention', 'body',
          (SELECT file_path FROM public.media_files WHERE id = protected[13]));

  INSERT INTO public.whatsapp_messages
    (user_id, social_account_id, conversation_id, media_url)
  VALUES (u_a, acct_wa, 'retention-conv',
          (SELECT file_path FROM public.media_files WHERE id = protected[16]));

  INSERT INTO public.whatsapp_contacts (user_id, phone_number, workspace_id, avatar_url)
  VALUES (u_a, '96555510013', ws,
          (SELECT file_path FROM public.media_files WHERE id = protected[17]));

  INSERT INTO public.ai_knowledge_sources (user_id, file_path, status)
  VALUES (u_a, (SELECT file_path FROM public.media_files WHERE id = protected[18]), 'ready');

  INSERT INTO public.ai_generation_jobs
    (user_id, provider, model_id, modality, credential_source, status, media_file_id)
  VALUES
    (u_a, 'higgsfield', 'm', 'image', 'platform', 'running', protected[21]),
    (u_a, 'higgsfield', 'm', 'image', 'platform', 'succeeded',
     '11111111-1111-4111-8111-111111111124');
  INSERT INTO public.ai_generation_jobs
    (user_id, provider, model_id, modality, credential_source, status, result_url)
  VALUES (u_a, 'higgsfield', 'm', 'image', 'platform', 'running',
          (SELECT file_path FROM public.media_files WHERE id = protected[22]));
  INSERT INTO public.ai_generation_jobs
    (user_id, provider, model_id, modality, credential_source, status, params)
  VALUES (u_a, 'higgsfield', 'm', 'image', 'platform', 'running',
          jsonb_build_object('image',
            (SELECT file_path FROM public.media_files WHERE id = protected[23])));

  INSERT INTO public.media_operations_history (user_id, operation_type, source_url)
  VALUES (u_a, 'edit',
          (SELECT file_path FROM public.media_files WHERE id = '11111111-1111-4111-8111-111111111127'));
  UPDATE public.media_files
  SET metadata = jsonb_build_object('original_file_id', '11111111-1111-4111-8111-111111111128')
  WHERE id = '11111111-1111-4111-8111-111111111101';

  -- The touch trigger resets last_used_at on the references we just wrote.
  -- Put the protected rows back to "old and unused" so only the reference
  -- map can save them.
  UPDATE public.media_files
  SET last_used_at = NULL,
      expires_at = NULL,
      retention_state = NULL,
      retention_claimed_at = NULL,
      retention_attempts = 0,
      retention_next_attempt_at = NULL,
      created_at = now() - interval '400 days'
  WHERE id = ANY (protected)
     OR id IN (
       '11111111-1111-4111-8111-111111111101',
       '11111111-1111-4111-8111-111111111123',
       '11111111-1111-4111-8111-111111111124',
       '11111111-1111-4111-8111-111111111125',
       '11111111-1111-4111-8111-111111111126',
       '11111111-1111-4111-8111-111111111127',
       '11111111-1111-4111-8111-111111111128'
     );

  SELECT count(*) INTO v_logs FROM public.system_logs WHERE source = 'media-retention';
  SELECT count INTO v_warned
  FROM public.media_retention_sweep(v_now, 200)
  WHERE phase = 'warn';

  ASSERT v_warned > 0, 'S4 sweep warned at least one file';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111101') = v_now + interval '7 days',
    'S4 control expires_at is p_now + 7 days';
  ASSERT (SELECT retention_state FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111101') = 'warned',
    'S4 control retention_state is warned';

  FOREACH fid IN ARRAY protected LOOP
    ASSERT (SELECT expires_at FROM public.media_files WHERE id = fid) IS NULL,
      'S4 reference protected ' || fid::text;
  END LOOP;

  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-11111111111d') IS NULL,
    'S4 partner-media is excluded';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-11111111111e') IS NULL,
    'S4 media bucket is excluded';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-11111111111f') IS NULL,
    'S4 supabase bucket is excluded';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111120') IS NULL,
    'S4 a row with no provider and no cloudinary id is excluded';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111121') IS NULL,
    'S4 keep_forever is excluded';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111122') IS NULL,
    'S4 a file newer than the retention window is not warned';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111124') IS NOT NULL,
    'S4 a succeeded generation job does not protect';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111125') IS NOT NULL,
    'S4 a sent scheduled message does not protect';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111126') IS NOT NULL,
    'S4 a completed broadcast does not protect';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111127') IS NOT NULL,
    'S4 media_operations_history does not protect';
  ASSERT (SELECT expires_at FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111128') IS NOT NULL,
    'S4 metadata.original_file_id does not protect';

  ASSERT (SELECT count(*) FROM public.system_logs
          WHERE source = 'media-retention' AND user_id = u_a) = 1,
    'S4 one sanitized log row for the warning user';
  ASSERT (SELECT metadata = jsonb_build_object('warned_count', (metadata ->> 'warned_count')::int)
          FROM public.system_logs
          WHERE source = 'media-retention' AND user_id = u_a
          ORDER BY created_at DESC LIMIT 1),
    'S4 warning log is a count only';
  ASSERT (SELECT count(*) FROM public.system_logs WHERE source = 'media-retention') > v_logs,
    'S4 warning log was written';

  -- The touch above ran for u_a's own post. A post owned by B that names A's
  -- file must not rewrite A's retention columns.
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-11111111112d', u_a);
  UPDATE public.media_files
  SET expires_at = v_now + interval '7 days', retention_state = 'warned', last_used_at = NULL
  WHERE id = '11111111-1111-4111-8111-11111111112d';
  INSERT INTO public.posts (user_id, platforms, media_file_ids)
  VALUES (u_b, ARRAY['facebook']::text[], ARRAY['11111111-1111-4111-8111-11111111112d']::uuid[]);
  ASSERT (SELECT last_used_at IS NULL AND expires_at IS NOT NULL
          FROM public.media_files WHERE id = '11111111-1111-4111-8111-11111111112d'),
    'S4b another user''s post does not touch this owner''s retention columns';
END $$;

DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
  v_now timestamptz := now();
  f_age uuid := '11111111-1111-4111-8111-111111111129';
  f_never uuid := '11111111-1111-4111-8111-11111111112a';
  f_use uuid := '11111111-1111-4111-8111-11111111112c';
  f_stale uuid := '11111111-1111-4111-8111-1111111111aa';
  f_fresh uuid := '11111111-1111-4111-8111-1111111111ab';
BEGIN
  -- S5: raising the window clears a warning the file no longer qualifies for.
  PERFORM pg_temp.mfile(f_age, u_a, 'openinary', 'yes', v_now - interval '40 days');
  PERFORM * FROM public.media_retention_sweep(v_now, 50);
  ASSERT (SELECT retention_state FROM public.media_files WHERE id = f_age) = 'warned',
    'S5 40-day file is warned at 30 days';
  UPDATE public.profiles SET media_retention_days = 90 WHERE id = u_a;
  PERFORM * FROM public.media_retention_sweep(v_now, 200);
  ASSERT (SELECT expires_at IS NULL AND retention_state IS NULL
          FROM public.media_files WHERE id = f_age),
    'S5 a longer retention clears the warning';
  UPDATE public.profiles SET media_retention_days = 30 WHERE id = u_a;

  -- S6: never (NULL) clears an existing warning.
  PERFORM pg_temp.mfile(f_never, u_a);
  PERFORM * FROM public.media_retention_sweep(v_now, 50);
  ASSERT (SELECT retention_state FROM public.media_files WHERE id = f_never) = 'warned',
    'S6 file is warned before never';
  UPDATE public.profiles SET media_retention_days = NULL WHERE id = u_a;
  PERFORM * FROM public.media_retention_sweep(v_now, 200);
  ASSERT (SELECT expires_at IS NULL AND retention_state IS NULL
          FROM public.media_files WHERE id = f_never),
    'S6 NULL retention clears warnings';
  UPDATE public.profiles SET media_retention_days = 30 WHERE id = u_a;

  -- S7: using the file clears the warning and stamps last_used_at.
  PERFORM pg_temp.mfile(f_use, u_a);
  PERFORM * FROM public.media_retention_sweep(v_now, 50);
  ASSERT (SELECT retention_state FROM public.media_files WHERE id = f_use) = 'warned',
    'S7 file is warned before use';
  INSERT INTO public.posts (user_id, platforms, media_file_ids)
  VALUES (u_a, ARRAY['instagram']::text[], ARRAY[f_use]);
  ASSERT (SELECT expires_at IS NULL AND retention_state IS NULL AND last_used_at IS NOT NULL
          FROM public.media_files WHERE id = f_use),
    'S7 inserting a post clears expires_at and sets last_used_at';

  -- S8: a deleting claim older than an hour returns to warned; a fresh one stays.
  PERFORM pg_temp.mfile(f_stale, u_a);
  PERFORM pg_temp.mfile(f_fresh, u_a);
  UPDATE public.media_files
  SET expires_at = v_now - interval '1 day',
      retention_state = 'deleting',
      retention_claimed_at = v_now - interval '2 hours'
  WHERE id = f_stale;
  UPDATE public.media_files
  SET expires_at = v_now - interval '1 day',
      retention_state = 'deleting',
      retention_claimed_at = v_now - interval '5 minutes'
  WHERE id = f_fresh;
  PERFORM * FROM public.media_retention_sweep(v_now, 50);
  ASSERT (SELECT retention_state = 'warned' AND retention_claimed_at IS NULL
          FROM public.media_files WHERE id = f_stale),
    'S8 a deleting claim older than 1 hour returns to warned';
  ASSERT (SELECT retention_state = 'deleting' AND retention_claimed_at IS NOT NULL
          FROM public.media_files WHERE id = f_fresh),
    'S8 a fresh deleting claim is left alone';
END $$;

DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
  v_now timestamptz := now();
  f_due uuid := '11111111-1111-4111-8111-111111111101';
  f_null uuid := '11111111-1111-4111-8111-11111111112f';
  f_later uuid := '11111111-1111-4111-8111-111111111130';
  v_attempts int;
  v_next timestamptz;
  v_id uuid;
  v_state text;
  v_exp timestamptz;
  v_used timestamptz;
  v_keep boolean;
  v_logs int;
  v_sig text;
  v_sig2 text;
BEGIN
  -- S9: delete_enabled false claims nothing. True claims due rows and marks deleting.
  UPDATE public.media_files
  SET expires_at = v_now - interval '1 minute',
      retention_state = 'warned',
      retention_attempts = 0,
      retention_next_attempt_at = NULL,
      retention_claimed_at = NULL
  WHERE id = f_due;
  ASSERT (SELECT count(*) FROM public.media_retention_claim(v_now, 50)) = 0,
    'S9 claim returns nothing while delete_enabled is false';
  ASSERT (SELECT retention_state FROM public.media_files WHERE id = f_due) = 'warned',
    'S9 a refused claim does not mark deleting';

  UPDATE public.media_retention_settings SET delete_enabled = true WHERE id = 1;
  SELECT media_file_id INTO v_id FROM public.media_retention_claim(v_now, 50) WHERE media_file_id = f_due;
  ASSERT v_id = f_due, 'S9 claim returns the due row when delete_enabled is true';
  ASSERT (SELECT retention_state = 'deleting' AND retention_claimed_at IS NOT NULL
          FROM public.media_files WHERE id = f_due),
    'S9 claim marks the row deleting';

  -- S10: budget release (p_failed false) does not count or back off.
  SELECT retention_attempts, retention_next_attempt_at
    INTO v_attempts, v_next
  FROM public.media_files WHERE id = f_due;
  PERFORM public.media_retention_release(f_due, false);
  ASSERT (SELECT retention_state = 'warned'
            AND retention_attempts = v_attempts
            AND retention_next_attempt_at IS NOT DISTINCT FROM v_next
            AND retention_claimed_at IS NULL
          FROM public.media_files WHERE id = f_due),
    'S10 p_failed false returns the row to warned without an attempt or backoff';

  -- S11: a failed attempt (provider read failure, or a partial delete) backs off.
  PERFORM public.media_retention_claim(v_now, 50);
  ASSERT (SELECT retention_state FROM public.media_files WHERE id = f_due) = 'deleting',
    'S11 the released row can be claimed again';
  PERFORM public.media_retention_release(f_due, true);
  ASSERT (SELECT retention_state = 'warned'
            AND retention_attempts = 1
            AND retention_next_attempt_at = v_now + interval '15 minutes'
          FROM public.media_files WHERE id = f_due),
    'S11 first failure waits 15 minutes';
  ASSERT (SELECT count(*) FROM public.media_retention_claim(v_now, 50)
          WHERE media_file_id = f_due) = 0,
    'S11 claim skips a row whose backoff has not elapsed';

  UPDATE public.media_files
  SET retention_state = 'deleting',
      retention_attempts = 4,
      retention_next_attempt_at = NULL,
      expires_at = v_now - interval '1 minute'
  WHERE id = f_due;
  SELECT count(*) INTO v_logs FROM public.system_logs
  WHERE source = 'media-retention' AND message = 'Media retention stopped retrying a file delete';
  PERFORM public.media_retention_release(f_due, true);
  ASSERT (SELECT retention_state = 'warned' AND retention_attempts = 5
          FROM public.media_files WHERE id = f_due),
    'S11 the fifth failure stays warned';
  ASSERT (SELECT count(*) FROM public.system_logs
          WHERE source = 'media-retention'
            AND message = 'Media retention stopped retrying a file delete') = v_logs + 1,
    'S11 the fifth failure writes one log row';
  UPDATE public.media_files
  SET retention_next_attempt_at = NULL, expires_at = v_now - interval '1 minute'
  WHERE id = f_due;
  ASSERT (SELECT count(*) FROM public.media_retention_claim(v_now, 50)
          WHERE media_file_id = f_due) = 0,
    'S11 five attempts are not claimed again';

  -- S12: NULLS FIRST, then expires_at.
  PERFORM pg_temp.mfile(f_null, u_a);
  PERFORM pg_temp.mfile(f_later, u_a);
  UPDATE public.media_files
  SET expires_at = v_now - interval '1 day',
      retention_state = 'warned',
      retention_attempts = 0,
      retention_next_attempt_at = NULL
  WHERE id = f_null;
  UPDATE public.media_files
  SET expires_at = v_now - interval '2 days',
      retention_state = 'warned',
      retention_attempts = 0,
      retention_next_attempt_at = v_now - interval '1 minute'
  WHERE id = f_later;
  SELECT media_file_id INTO v_id FROM public.media_retention_claim(v_now, 1);
  ASSERT v_id = f_null, 'S12 claim prefers a null next_attempt over an older expires_at';

  -- S13: preview writes nothing.
  PERFORM pg_temp.mfile('11111111-1111-4111-8111-11111111112e', u_a);
  SELECT md5(string_agg(
           id::text || coalesce(expires_at::text, '') || coalesce(retention_state, '')
           || coalesce(last_used_at::text, '') || keep_forever::text || retention_attempts::text,
           ',' ORDER BY id))
    INTO v_sig
  FROM public.media_files;
  SELECT count(*) INTO v_logs FROM public.system_logs WHERE source = 'media-retention';
  ASSERT EXISTS (
    SELECT 1 FROM public.media_retention_preview(u_a)
    WHERE media_file_id = '11111111-1111-4111-8111-11111111112e'
      AND action = 'would_warn'
  ), 'S13 preview reports would_warn';
  SELECT md5(string_agg(
           id::text || coalesce(expires_at::text, '') || coalesce(retention_state, '')
           || coalesce(last_used_at::text, '') || keep_forever::text || retention_attempts::text,
           ',' ORDER BY id))
    INTO v_sig2
  FROM public.media_files;
  ASSERT v_sig2 = v_sig, 'S13 preview does not change media_files';
  ASSERT (SELECT count(*) FROM public.system_logs WHERE source = 'media-retention') = v_logs,
    'S13 preview does not write system_logs';

  SELECT retention_state, expires_at, last_used_at, keep_forever
    INTO v_state, v_exp, v_used, v_keep
  FROM public.media_files WHERE id = f_due;
  PERFORM * FROM public.media_retention_preview(NULL);
  ASSERT (SELECT retention_state IS NOT DISTINCT FROM v_state
            AND expires_at IS NOT DISTINCT FROM v_exp
            AND last_used_at IS NOT DISTINCT FROM v_used
            AND keep_forever IS NOT DISTINCT FROM v_keep
          FROM public.media_files WHERE id = f_due),
    'S13 preview leaves an already-warned row unchanged';
END $$;

-- S14: missing settings row fails closed (no warns, no dues).
DO $$
DECLARE
  v_rollout timestamptz;
  v_enabled boolean;
  f_due uuid := '11111111-1111-4111-8111-11111111112f';
  v_state text;
BEGIN
  SELECT rollout_at, delete_enabled INTO v_rollout, v_enabled
  FROM public.media_retention_settings WHERE id = 1;
  SELECT retention_state INTO v_state FROM public.media_files WHERE id = f_due;
  DELETE FROM public.media_retention_settings WHERE id = 1;
  ASSERT (SELECT count(*) FROM public.media_retention_sweep(now(), 50)) = 0,
    'S14 sweep returns nothing when the settings row is missing';
  ASSERT (SELECT count(*) FROM public.media_retention_claim(now(), 50)) = 0,
    'S14 claim returns nothing when the settings row is missing';
  ASSERT (SELECT count(*) FROM public.media_retention_preview(NULL)) = 0,
    'S14 preview returns nothing when the settings row is missing';
  ASSERT (SELECT retention_state IS NOT DISTINCT FROM v_state
          FROM public.media_files WHERE id = f_due),
    'S14 a missing settings row does not change files';
  INSERT INTO public.media_retention_settings (id, rollout_at, delete_enabled)
  VALUES (1, v_rollout, v_enabled);
END $$;

-- S15: guard, media_set_keep, and authenticated column rights.
DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
  acct_wa uuid := 'e8e8e8e8-e8e8-47e8-87e8-e8e8e8e8e8e8';
  f_guard uuid := '11111111-1111-4111-8111-111111111133';
  f_url uuid := '11111111-1111-4111-8111-111111111134';
  f_keep uuid := '11111111-1111-4111-8111-111111111131';
  f_other uuid := '11111111-1111-4111-8111-111111111135';
  u_b uuid := 'b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7';
BEGIN
  PERFORM pg_temp.mfile(f_guard, u_a);
  PERFORM pg_temp.mfile(f_url, u_a);
  PERFORM pg_temp.mfile(f_keep, u_a);
  PERFORM pg_temp.mfile(f_other, u_b);
  UPDATE public.media_files
  SET retention_state = 'deleting', retention_claimed_at = now(),
      expires_at = now() - interval '1 day'
  WHERE id IN (f_guard, f_url);

  BEGIN
    INSERT INTO public.posts (user_id, platforms, media_file_ids)
    VALUES (u_a, ARRAY['facebook']::text[], ARRAY[f_guard]);
    RAISE EXCEPTION 'S15 failed: post referencing a deleting file was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%being deleted from your library%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO public.whatsapp_scheduled_messages
      (user_id, social_account_id, recipient_phone, scheduled_at, media_url, status)
    VALUES (u_a, acct_wa, '96555510021', now() + interval '1 day',
            (SELECT file_path FROM public.media_files WHERE id = f_url), 'pending');
    RAISE EXCEPTION 'S15 failed: scheduled url referencing a deleting file was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%being deleted from your library%' THEN
      RAISE;
    END IF;
  END;
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7',
                    'role', 'authenticated')::text, true);

DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
  u_b uuid := 'b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7';
  f_keep uuid := '11111111-1111-4111-8111-111111111131';
  f_guard uuid := '11111111-1111-4111-8111-111111111133';
  f_other uuid := '11111111-1111-4111-8111-111111111135';
  f_folder uuid := '11111111-1111-4111-8111-111111111121';
  v_enabled boolean;
BEGIN
  SELECT delete_enabled INTO v_enabled FROM public.media_retention_settings LIMIT 1;
  ASSERT v_enabled IS NOT NULL, 'S16 authenticated can read delete_enabled';
  BEGIN
    PERFORM rollout_at FROM public.media_retention_settings LIMIT 1;
    RAISE EXCEPTION 'S16 failed: rollout_at is visible to authenticated'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.media_files
  SET folder_path = '/retention-kept', metadata = jsonb_build_object('title', 'kept')
  WHERE id = f_folder;
  ASSERT (SELECT folder_path = '/retention-kept'
            AND metadata ->> 'title' = 'kept'
          FROM public.media_files WHERE id = f_folder),
    'S16 owner can still update folder_path and metadata';

  BEGIN
    UPDATE public.media_files SET expires_at = now() WHERE id = f_folder;
    RAISE EXCEPTION 'S16 failed: expires_at update accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.media_files SET retention_state = 'warned' WHERE id = f_folder;
    RAISE EXCEPTION 'S16 failed: retention_state update accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.media_files SET last_used_at = now() WHERE id = f_folder;
    RAISE EXCEPTION 'S16 failed: last_used_at update accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.media_files SET keep_forever = true WHERE id = f_folder;
    RAISE EXCEPTION 'S16 failed: keep_forever update accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.media_files SET retention_attempts = 3 WHERE id = f_folder;
    RAISE EXCEPTION 'S16 failed: retention_attempts update accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.media_files SET retention_claimed_at = now() WHERE id = f_folder;
    RAISE EXCEPTION 'S16 failed: retention_claimed_at update accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.media_files SET retention_next_attempt_at = now() WHERE id = f_folder;
    RAISE EXCEPTION 'S16 failed: retention_next_attempt_at update accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM public.media_set_keep(ARRAY[f_keep], true);
  ASSERT (SELECT keep_forever IS TRUE AND expires_at IS NULL AND retention_state IS NULL
          FROM public.media_files WHERE id = f_keep),
    'S17 media_set_keep true sets keep_forever and clears the warning';
  PERFORM public.media_set_keep(ARRAY[f_keep], false);
  ASSERT (SELECT keep_forever IS FALSE AND expires_at IS NULL
          FROM public.media_files WHERE id = f_keep),
    'S17 media_set_keep false clears keep_forever and leaves expires_at null';

  PERFORM public.media_set_keep(ARRAY[f_other], true);

  BEGIN
    PERFORM public.media_set_keep(ARRAY[f_guard], true);
    RAISE EXCEPTION 'S17 failed: keep on a deleting file was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%being deleted from your library%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM * FROM public.media_retention_sweep(now(), 1);
    RAISE EXCEPTION 'S18 failed: authenticated could call sweep'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

DO $$
BEGIN
  ASSERT (SELECT keep_forever FROM public.media_files
          WHERE id = '11111111-1111-4111-8111-111111111135') = false,
    'S17 media_set_keep ignores another user''s file';
  ASSERT has_function_privilege('service_role', 'public.media_retention_sweep(timestamptz, integer)', 'EXECUTE'),
    'S18 service_role can execute sweep';
  ASSERT has_function_privilege('service_role', 'public.media_retention_claim(timestamptz, integer)', 'EXECUTE'),
    'S18 service_role can execute claim';
  ASSERT has_function_privilege('service_role', 'public.media_retention_release(uuid, boolean)', 'EXECUTE'),
    'S18 service_role can execute release';
  ASSERT has_function_privilege('service_role', 'public.media_retention_preview(uuid)', 'EXECUTE'),
    'S18 service_role can execute preview';
  ASSERT NOT has_function_privilege('authenticated', 'public.media_retention_sweep(timestamptz, integer)', 'EXECUTE'),
    'S18 authenticated cannot execute sweep';
  ASSERT NOT has_function_privilege('anon', 'public.media_retention_claim(timestamptz, integer)', 'EXECUTE'),
    'S18 anon cannot execute claim';
  ASSERT NOT has_function_privilege('authenticated', 'public.media_retention_release(uuid, boolean)', 'EXECUTE'),
    'S18 authenticated cannot execute release';
  ASSERT NOT has_function_privilege('anon', 'public.media_retention_preview(uuid)', 'EXECUTE'),
    'S18 anon cannot execute preview';
  ASSERT has_function_privilege('authenticated', 'public.media_set_keep(uuid[], boolean)', 'EXECUTE'),
    'S18 authenticated can execute media_set_keep';
  ASSERT NOT has_function_privilege('anon', 'public.media_set_keep(uuid[], boolean)', 'EXECUTE'),
    'S18 anon cannot execute media_set_keep';
  ASSERT NOT has_function_privilege('service_role', 'public.media_set_keep(uuid[], boolean)', 'EXECUTE'),
    'S18 service_role cannot execute media_set_keep';

  ASSERT NOT has_column_privilege('authenticated', 'public.media_files', 'expires_at', 'UPDATE'),
    'S18 authenticated has no UPDATE on expires_at';
  ASSERT NOT has_column_privilege('authenticated', 'public.media_files', 'retention_state', 'UPDATE'),
    'S18 authenticated has no UPDATE on retention_state';
  ASSERT NOT has_column_privilege('authenticated', 'public.media_files', 'last_used_at', 'UPDATE'),
    'S18 authenticated has no UPDATE on last_used_at';
  ASSERT NOT has_column_privilege('authenticated', 'public.media_files', 'keep_forever', 'UPDATE'),
    'S18 authenticated has no UPDATE on keep_forever';
  ASSERT has_column_privilege('authenticated', 'public.media_files', 'folder_path', 'UPDATE'),
    'S18 authenticated keeps UPDATE on folder_path';
  ASSERT has_column_privilege('authenticated', 'public.media_files', 'metadata', 'UPDATE'),
    'S18 authenticated keeps UPDATE on metadata';
  ASSERT has_column_privilege('authenticated', 'public.media_files', 'file_path', 'UPDATE'),
    'S18 authenticated keeps UPDATE on file_path';
  ASSERT has_column_privilege('authenticated', 'public.media_retention_settings', 'delete_enabled', 'SELECT'),
    'S18 authenticated can select delete_enabled';
  ASSERT NOT has_column_privilege('authenticated', 'public.media_retention_settings', 'rollout_at', 'SELECT'),
    'S18 authenticated cannot select rollout_at';
  ASSERT NOT has_column_privilege('anon', 'public.media_retention_settings', 'delete_enabled', 'SELECT'),
    'S18 anon cannot select delete_enabled';
END $$;

DO $s19_cron$
BEGIN
  IF to_regnamespace('cron') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'media-retention cron skipped: pg_cron absent';
    RETURN;
  END IF;
  ASSERT NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-media'),
    'S19 cleanup-media is unscheduled';
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-retention') THEN
    RAISE NOTICE 'media-retention cron skipped: job absent (pg_net or get_cron_secret unavailable at migrate time)';
    RETURN;
  END IF;
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'media-retention') = 1,
    'S19 media-retention is scheduled once';
  ASSERT (SELECT schedule FROM cron.job WHERE jobname = 'media-retention') = '*/15 * * * *',
    'S19 media-retention runs every 15 minutes';
  ASSERT (SELECT command FROM cron.job WHERE jobname = 'media-retention') ILIKE '%media-retention%',
    'S19 cron command calls media-retention';
  ASSERT (SELECT command FROM cron.job WHERE jobname = 'media-retention') ILIKE '%get_cron_secret%',
    'S19 cron command uses get_cron_secret()';
END $s19_cron$;

-- S20: explain the sweep on a few thousand synthetic rows. Timing is printed,
-- not asserted.
DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
  line text;
BEGIN
  INSERT INTO public.media_files (user_id, file_path, file_type, storage_bucket, cloudinary_public_id, created_at)
  SELECT u_a,
         'https://cdn.example.invalid/bench/' || g::text,
         'image',
         'openinary',
         'bench-cid-' || g::text,
         now() - interval '400 days'
  FROM generate_series(1, 5000) AS g;

  INSERT INTO public.posts (user_id, platforms, media_file_ids, metadata)
  SELECT u_a,
         ARRAY['facebook']::text[],
         ARRAY[m.id],
         jsonb_build_object('youtube_thumbnail', m.file_path)
  FROM public.media_files AS m
  WHERE m.file_path LIKE 'https://cdn.example.invalid/bench/%'
  ORDER BY m.file_path
  LIMIT 100;

  INSERT INTO public.media_file_providers (media_file_id, provider, object_key, delivery_url, status)
  SELECT m.id, 'openinary', 'bench-key-' || m.id::text, m.file_path, 'ready'
  FROM public.media_files AS m
  WHERE m.file_path LIKE 'https://cdn.example.invalid/bench/%'
  ORDER BY m.file_path
  LIMIT 200;

  FOR line IN
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT * FROM public.media_retention_sweep(now(), 50)
  LOOP
    RAISE NOTICE 'media_retention sweep explain: %', line;
  END LOOP;
END $$;

-- S21: adding the column backfills 30; a second add leaves a later NULL.
DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
BEGIN
  ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_media_retention_days_check;
  ALTER TABLE public.profiles DROP COLUMN media_retention_days;
  ALTER TABLE public.profiles ADD COLUMN media_retention_days integer DEFAULT 30;
  ASSERT (SELECT media_retention_days FROM public.profiles WHERE id = u_a) = 30,
    'S21 a newly added column backfills existing rows to 30';
  UPDATE public.profiles SET media_retention_days = NULL WHERE id = u_a;
  ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS media_retention_days integer DEFAULT 30;
  ASSERT (SELECT media_retention_days FROM public.profiles WHERE id = u_a) IS NULL,
    'S21 running the column add again does not fill NULL';
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_media_retention_days_check
    CHECK (media_retention_days IS NULL OR media_retention_days IN (7, 30, 90));
END $$;

ROLLBACK;
\echo '=== media_retention: ALL CHECKS PASSED ==='
