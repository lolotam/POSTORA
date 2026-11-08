-- Independent Story copies. Canonical state never comes from a generic job payload.
-- No transaction wrapper: the disposable harness applies migrations inside its transaction.
CREATE TABLE public.instagram_story_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  media_file_id uuid NOT NULL REFERENCES public.media_files(id),
  media_object_version integer NOT NULL,
  consent_version text NOT NULL,
  credential_generation bigint,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  phase text NOT NULL DEFAULT 'awaiting_reel' CHECK (phase IN
    ('awaiting_reel','queued','creating','processing','publishing','published','failed','uncertain')),
  primary_result_id uuid REFERENCES public.platform_posts(id),
  result_id uuid REFERENCES public.platform_posts(id),
  background_job_id uuid UNIQUE REFERENCES public.background_jobs(id),
  container_id text,
  media_id text,
  error text,
  give_up_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '1 hour',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (post_id, social_account_id),
  CHECK (phase NOT IN ('processing','publishing','published') OR container_id IS NOT NULL)
);
ALTER TABLE public.instagram_story_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY instagram_story_jobs_owned_read ON public.instagram_story_jobs
  FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.instagram_story_jobs FROM anon, authenticated;
GRANT SELECT ON public.instagram_story_jobs TO authenticated;

-- Fingerprint only stored consent and selected media. Never accept a caller's opt-in boolean.
CREATE FUNCTION public.instagram_story_consent(p public.posts, a uuid)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN
    (p.metadata->'instagram_post_type' = '"reel"'::jsonb OR
     (jsonb_typeof(p.metadata->'instagram_post_type') = 'array' AND p.metadata->'instagram_post_type' ? 'reel'))
    AND (p.metadata->'instagram_share_to_story' = 'true'::jsonb OR
         (jsonb_typeof(p.metadata->'instagram_post_type') = 'array' AND p.metadata->'instagram_post_type' ? 'story'))
    AND (NOT p.metadata ? 'selected_account_ids' OR
         (jsonb_typeof(p.metadata->'selected_account_ids') = 'array' AND p.metadata->'selected_account_ids' ? a::text))
    AND cardinality(p.media_file_ids) > 0
  THEN md5(jsonb_build_array(p.metadata->'instagram_post_type', p.metadata->'instagram_share_to_story',
        p.metadata->'selected_account_ids', p.media_file_ids)::text) END
$$;

CREATE FUNCTION public.prepare_instagram_story(p_post_id uuid, p_account_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.posts; v text;
BEGIN
  SELECT * INTO p FROM public.posts WHERE id = p_post_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.social_accounts
    WHERE id = p_account_id AND user_id = p_user_id AND platform = 'instagram' AND is_active) THEN
    RAISE EXCEPTION 'story_owner_refused' USING ERRCODE = '42501';
  END IF;
  v := public.instagram_story_consent(p, p_account_id);
  IF v IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.media_files WHERE id = p.media_file_ids[1] AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'story_media_owner_refused' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.instagram_story_jobs(user_id, post_id, social_account_id, media_file_id, media_object_version, consent_version, credential_generation)
    VALUES(p_user_id, p.id, p_account_id, p.media_file_ids[1],
      (SELECT current_object_version FROM public.media_files WHERE id=p.media_file_ids[1]), v,
      (SELECT credential_generation FROM public.instagram_account_capabilities WHERE social_account_id=p_account_id AND user_id=p_user_id))
    ON CONFLICT (post_id, social_account_id) DO NOTHING;
  -- An existing generation is never reset by another primary dispatch.
  RETURN true;
END $$;

CREATE FUNCTION public.enqueue_instagram_story_after_reel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.instagram_story_jobs; r uuid; j uuid;
BEGIN
  IF NEW.platform <> 'instagram' OR NEW.status <> 'success'
    OR NEW.response_data->>'ig_post_subtype' IS DISTINCT FROM 'reel'
    OR nullif(NEW.platform_post_id, '') IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.instagram_story_jobs WHERE post_id = NEW.post_id
    AND social_account_id = NEW.social_account_id AND phase = 'awaiting_reel' FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.posts p JOIN public.social_accounts a ON a.id = s.social_account_id
    WHERE p.id = s.post_id AND p.user_id = s.user_id AND a.user_id = s.user_id AND a.is_active
      AND public.instagram_story_consent(p, a.id) = s.consent_version) THEN RETURN NEW; END IF;
  INSERT INTO public.platform_posts(post_id, social_account_id, platform, status, response_data)
    VALUES(s.post_id, s.social_account_id, 'instagram', 'pending',
      jsonb_build_object('ig_post_subtype','story','story_job_id',s.id,'story_generation',s.generation,'story_state','queued'))
    RETURNING id INTO r;
  INSERT INTO public.background_jobs(user_id, kind, payload)
    VALUES(s.user_id, 'instagram_story', jsonb_build_object('storyJobId',s.id)) RETURNING id INTO j;
  UPDATE public.instagram_story_jobs SET phase = 'queued', primary_result_id = NEW.id,
    result_id = r, background_job_id = j, give_up_at = clock_timestamp() + interval '1 hour' WHERE id = s.id;
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_instagram_story_after_reel AFTER INSERT OR UPDATE OF status ON public.platform_posts
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_instagram_story_after_reel();

-- Serialize with the generic lease before reading canonical state. No token leaves this RPC.
CREATE FUNCTION public.read_instagram_story_job(p_job_id uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.instagram_story_jobs; j public.background_jobs; v_authorized boolean;
BEGIN
  SELECT * INTO j FROM public.background_jobs WHERE id = p_job_id AND kind = 'instagram_story'
    AND status = 'running' AND claim_token = p_token AND claimed_at > clock_timestamp() - interval '3 minutes' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.instagram_story_jobs WHERE background_job_id = j.id AND user_id = j.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF j.claimed_at <= clock_timestamp() - interval '3 minutes' THEN RETURN NULL; END IF;
  SELECT EXISTS (SELECT 1 FROM public.posts p JOIN public.social_accounts a ON a.id = s.social_account_id
    JOIN public.media_files m ON m.id=s.media_file_id AND m.user_id=s.user_id AND m.current_object_version=s.media_object_version
    WHERE p.id = s.post_id AND p.user_id = s.user_id AND p.status IN ('processing','completed','failed')
      AND a.user_id = s.user_id AND a.is_active AND a.platform = 'instagram'
      AND public.instagram_story_consent(p,a.id) = s.consent_version) INTO v_authorized;
  RETURN jsonb_build_object('id',s.id,'postId',s.post_id,'accountId',s.social_account_id,
    'resultId',s.result_id,'generation',s.generation,'consentVersion',s.consent_version,
    'giveUpAt',extract(epoch FROM s.give_up_at)*1000,'phase',s.phase,'containerId',s.container_id,
    'mediaId',s.media_id,'mediaFileId',s.media_file_id,'mediaVersion',s.media_object_version,'authorized',v_authorized,
    'primarySucceeded',EXISTS (SELECT 1 FROM public.platform_posts pp WHERE pp.id=s.primary_result_id
      AND pp.post_id=s.post_id AND pp.social_account_id=s.social_account_id AND pp.status='success'));
END $$;

CREATE FUNCTION public.checkpoint_instagram_story(p_job_id uuid, p_token uuid, p_generation integer,
  p_phase text, p_container_id text DEFAULT NULL, p_media_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb; s public.instagram_story_jobs;
BEGIN
  v := public.read_instagram_story_job(p_job_id,p_token);
  IF v IS NULL OR (v->>'authorized')::boolean IS NOT TRUE OR (v->>'primarySucceeded')::boolean IS NOT TRUE THEN RETURN false; END IF;
  SELECT * INTO s FROM public.instagram_story_jobs WHERE background_job_id=p_job_id FOR UPDATE;
  IF s.generation IS DISTINCT FROM p_generation OR clock_timestamp() >= s.give_up_at THEN RETURN false; END IF;
  IF p_phase IN ('creating','publishing') AND NOT EXISTS (
    SELECT 1 FROM public.instagram_account_capabilities c WHERE c.social_account_id=s.social_account_id
      AND c.user_id=s.user_id AND c.credential_generation=s.credential_generation
      AND c.permission_read_state='ok' AND c.scopes_read_at IS NOT NULL
      AND CASE c.login_kind WHEN 'direct' THEN 'instagram_business_content_publish'
        WHEN 'page_linked' THEN 'instagram_content_publish' END = ANY(c.granted_scopes)
  ) THEN RETURN false; END IF;
  IF ((s.phase='queued' AND p_phase='creating') OR
          (s.phase='creating' AND p_phase='processing' AND nullif(p_container_id,'') IS NOT NULL) OR
          (s.phase='processing' AND p_phase='publishing' AND p_container_id=s.container_id) OR
          (s.phase IN ('processing','publishing') AND p_phase='published' AND p_container_id=s.container_id)) IS NOT TRUE THEN RETURN false; END IF;
  UPDATE public.instagram_story_jobs SET phase=p_phase, container_id=coalesce(s.container_id,p_container_id),
    media_id=coalesce(s.media_id,p_media_id) WHERE id=s.id;
  UPDATE public.platform_posts SET response_data=response_data || jsonb_build_object('story_state',p_phase)
    WHERE id=s.result_id;
  RETURN true;
END $$;

CREATE FUNCTION public.settle_instagram_story(p_job_id uuid, p_token uuid, p_generation integer,
  p_published boolean, p_error text DEFAULT NULL, p_uncertain boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb; s public.instagram_story_jobs; state text;
BEGIN
  v := public.read_instagram_story_job(p_job_id,p_token);
  IF v IS NULL THEN RETURN false; END IF;
  SELECT * INTO s FROM public.instagram_story_jobs WHERE background_job_id=p_job_id FOR UPDATE;
  IF s.generation IS DISTINCT FROM p_generation OR p_published IS NULL OR p_uncertain IS NULL OR s.phase IN ('failed','uncertain') THEN RETURN false; END IF;
  IF p_published IS TRUE AND s.phase <> 'published' THEN RETURN false; END IF;
  -- A dispatched or confirmed publication can never be turned into a retryable failure.
  IF p_published IS NOT TRUE AND s.phase='published' THEN RETURN false; END IF;
  state := CASE WHEN p_published THEN 'published' WHEN p_uncertain OR s.phase='publishing' THEN 'uncertain' ELSE 'failed' END;
  UPDATE public.instagram_story_jobs SET phase=state, error=left(p_error,64) WHERE id=s.id;
  PERFORM public.partner_settle_platform_post(s.result_id,s.post_id,s.social_account_id,'instagram',
    CASE WHEN p_published THEN 'success' ELSE 'failed' END,
    CASE WHEN p_published THEN s.media_id END,NULL,CASE WHEN p_published THEN NULL ELSE left(p_error,64) END,
    (SELECT response_data FROM public.platform_posts WHERE id=s.result_id) ||
      jsonb_build_object('story_state',state,'story_retryable',state='failed'));
  RETURN true;
END $$;

CREATE FUNCTION public.retry_instagram_story(p_post_id uuid, p_result_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.instagram_story_jobs; j uuid; v text; v_credential_generation bigint;
BEGIN
  SELECT * INTO s FROM public.instagram_story_jobs WHERE post_id=p_post_id AND result_id=p_result_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR s.phase <> 'failed' THEN RETURN false; END IF;
  SELECT public.instagram_story_consent(p,s.social_account_id) INTO v FROM public.posts p
    JOIN public.social_accounts a ON a.id=s.social_account_id
    WHERE p.id=s.post_id AND p.user_id=s.user_id AND a.user_id=s.user_id AND a.is_active;
  IF v IS DISTINCT FROM s.consent_version THEN RETURN false; END IF;
  -- An explicit new attempt may adopt the current connection; existing attempts keep their fence.
  SELECT c.credential_generation INTO v_credential_generation FROM public.instagram_account_capabilities c
    WHERE c.social_account_id=s.social_account_id AND c.user_id=s.user_id
      AND c.permission_read_state='ok' AND c.scopes_read_at IS NOT NULL
      AND CASE c.login_kind WHEN 'direct' THEN 'instagram_business_content_publish'
        WHEN 'page_linked' THEN 'instagram_content_publish' END = ANY(c.granted_scopes)
    FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.background_jobs WHERE id=s.background_job_id AND status IN ('running','queued')) THEN RETURN false; END IF;
  INSERT INTO public.background_jobs(user_id,kind,payload)
    VALUES(s.user_id,'instagram_story',jsonb_build_object('storyJobId',s.id)) RETURNING id INTO j;
  UPDATE public.instagram_story_jobs SET generation=generation+1, phase='queued', background_job_id=j,
    credential_generation=v_credential_generation,
    container_id=NULL, media_id=NULL, error=NULL, give_up_at=clock_timestamp()+interval '1 hour' WHERE id=s.id;
  UPDATE public.platform_posts SET status='pending', error_message=NULL,
    response_data=response_data || jsonb_build_object('story_generation',s.generation+1,'story_state','queued','story_retryable',false)
    WHERE id=s.result_id;
  RETURN true;
END $$;

CREATE FUNCTION public.reconcile_failed_story_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.instagram_story_jobs; v_state text;
BEGIN
  IF NEW.kind <> 'instagram_story' OR NEW.status <> 'failed' THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.instagram_story_jobs WHERE background_job_id=NEW.id FOR UPDATE;
  IF NOT FOUND OR s.phase IN ('failed','uncertain') THEN RETURN NEW; END IF;
  v_state := CASE WHEN s.phase='published' THEN 'published' WHEN s.phase IN ('creating','publishing') THEN 'uncertain' ELSE 'failed' END;
  UPDATE public.instagram_story_jobs SET phase=v_state,error='story_worker_exhausted' WHERE id=s.id;
  PERFORM public.partner_settle_platform_post(s.result_id,s.post_id,s.social_account_id,'instagram',
    CASE WHEN v_state='published' THEN 'success' ELSE 'failed' END,
    CASE WHEN v_state='published' THEN s.media_id END,NULL,CASE WHEN v_state='published' THEN NULL ELSE 'story_worker_exhausted' END,
    (SELECT response_data FROM public.platform_posts WHERE id=s.result_id) ||
      jsonb_build_object('story_state',v_state,'story_retryable',v_state='failed'));
  RETURN NEW;
END $$;
CREATE TRIGGER reconcile_failed_story_job AFTER UPDATE OF status ON public.background_jobs
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_failed_story_job();

-- Revoking and restoring the same checkbox does not revive an already revoked generation.
CREATE FUNCTION public.revoke_changed_story_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.instagram_story_jobs; v_state text;
BEGIN
  FOR s IN SELECT * FROM public.instagram_story_jobs WHERE post_id=NEW.id
    AND phase NOT IN ('published','failed','uncertain') FOR UPDATE LOOP
    IF public.instagram_story_consent(NEW,s.social_account_id) IS NOT DISTINCT FROM s.consent_version THEN CONTINUE; END IF;
    v_state := CASE WHEN s.phase='publishing' THEN 'uncertain' ELSE 'failed' END;
    UPDATE public.instagram_story_jobs SET phase=v_state,error='story_consent_changed' WHERE id=s.id;
    IF s.result_id IS NOT NULL THEN
      PERFORM public.partner_settle_platform_post(s.result_id,s.post_id,s.social_account_id,'instagram','failed',
        NULL,NULL,'story_consent_changed', (SELECT response_data FROM public.platform_posts WHERE id=s.result_id) ||
        jsonb_build_object('story_state',v_state,'story_retryable',false));
    END IF;
    UPDATE public.background_jobs SET status='failed',error='story_consent_changed',finished_at=clock_timestamp(),claim_token=NULL
      WHERE id=s.background_job_id AND status IN ('running','queued');
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_changed_story_consent AFTER UPDATE OF metadata, media_file_ids ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.revoke_changed_story_consent();

REVOKE ALL ON FUNCTION public.instagram_story_consent(public.posts,uuid),
  public.prepare_instagram_story(uuid,uuid,uuid), public.enqueue_instagram_story_after_reel(),
  public.read_instagram_story_job(uuid,uuid), public.checkpoint_instagram_story(uuid,uuid,integer,text,text,text),
  public.settle_instagram_story(uuid,uuid,integer,boolean,text,boolean), public.retry_instagram_story(uuid,uuid,uuid),
  public.reconcile_failed_story_job(), public.revoke_changed_story_consent() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_instagram_story(uuid,uuid,uuid), public.read_instagram_story_job(uuid,uuid),
  public.checkpoint_instagram_story(uuid,uuid,integer,text,text,text),
  public.settle_instagram_story(uuid,uuid,integer,boolean,text,boolean), public.retry_instagram_story(uuid,uuid,uuid) TO service_role;

-- Preserve the existing generic retry contract, excluding independently managed Story accounts.
CREATE OR REPLACE FUNCTION public.request_post_retry(
  p_post_id uuid,
  p_user_id uuid,
  p_account_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_targets uuid[];
  v_platforms text[];
  v_requested_at timestamptz := now();
BEGIN
  SELECT * INTO v_post
    FROM public.posts
   WHERE id = p_post_id AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_found');
  END IF;

  -- The lease length is mcp_claim_post_action's default, the only one its callers use.
  IF v_post.status NOT IN ('failed', 'completed')
     OR v_post.source IS NOT DISTINCT FROM 'tiktok_review'
     OR (v_post.action_claim_id IS NOT NULL AND v_post.action_claimed_at > now() - interval '15 minutes') THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_retryable');
  END IF;

  IF p_account_ids IS NOT NULL AND cardinality(p_account_ids) > 0 THEN
    SELECT array_agg(DISTINCT sa.id) INTO v_targets
      FROM public.social_accounts sa
     WHERE sa.id = ANY (p_account_ids)
       AND sa.user_id = p_user_id;
  ELSE
    -- Joined to social_accounts so a result row that names another user's
    -- account never becomes a target, the same rule as the explicit list.
    SELECT array_agg(DISTINCT pp.social_account_id) INTO v_targets
      FROM public.platform_posts pp
      JOIN public.social_accounts sa ON sa.id = pp.social_account_id
     WHERE pp.post_id = p_post_id
       AND pp.status = 'failed'
       AND sa.user_id = p_user_id;
  END IF;

  SELECT array_agg(t) INTO v_targets
    FROM unnest(coalesce(v_targets, ARRAY[]::uuid[])) AS t
   -- A managed Story has a confirmed primary and its own retry/generation protocol.
   -- Exclude its account even from an explicit generic selection; other accounts remain eligible.
   WHERE NOT EXISTS (SELECT 1 FROM public.instagram_story_jobs sj
                      WHERE sj.post_id=p_post_id AND sj.social_account_id=t AND sj.result_id IS NOT NULL)
     AND NOT EXISTS (
     SELECT 1 FROM public.platform_posts pp
      WHERE pp.post_id = p_post_id
        AND pp.social_account_id = t
        AND (pp.status = 'pending'
             OR (pp.status = 'success'
                 AND NOT (pp.platform = 'instagram'
                          AND EXISTS (SELECT 1 FROM public.platform_posts failed
                                       WHERE failed.post_id = p_post_id
                                         AND failed.social_account_id = t
                                         AND failed.status = 'failed'))))
   );

  IF v_targets IS NULL OR cardinality(v_targets) = 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_targets');
  END IF;

  SELECT array_agg(DISTINCT sa.platform) INTO v_platforms
    FROM public.social_accounts sa
   WHERE sa.id = ANY (v_targets);

  DELETE FROM public.platform_posts
   WHERE post_id = p_post_id
     AND status = 'failed'
     AND social_account_id = ANY (v_targets)
     AND NOT EXISTS (SELECT 1 FROM public.instagram_story_jobs sj WHERE sj.result_id=platform_posts.id);

  UPDATE public.posts
     SET status = 'pending',
         publish_requested_at = v_requested_at,
         -- metadata is owner-writable and may hold a non-object; || on a
         -- scalar or array would build an array instead of adding a key.
         metadata = (CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END)
                    || jsonb_build_object(
           'retry_request', jsonb_build_object(
             'requested_at', v_requested_at,
             'account_ids', to_jsonb(v_targets),
             'platforms', to_jsonb(v_platforms),
             'prior_status', v_post.status
           )
         )
   WHERE id = p_post_id;

  RETURN jsonb_build_object(
    'status', 'accepted',
    'requested_at', v_requested_at,
    'account_ids', to_jsonb(v_targets),
    'platforms', to_jsonb(v_platforms)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) TO service_role;
