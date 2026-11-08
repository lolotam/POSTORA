\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  u uuid := 'e3910000-0000-4000-8000-000000000001';
  other_user uuid := 'e3910000-0000-4000-8000-000000000002';
  a uuid := 'e3910000-0000-4000-8000-000000000003';
  p uuid := 'e3910000-0000-4000-8000-000000000004';
  m uuid := 'e3910000-0000-4000-8000-000000000005';
  j uuid; r uuid; token uuid := gen_random_uuid(); v jsonb; count_before bigint;
BEGIN
  ASSERT NOT has_function_privilege('authenticated','public.prepare_instagram_story(uuid,uuid,uuid)','EXECUTE'), 'clients cannot forge service identity';
  INSERT INTO auth.users(id,email) VALUES (u,'story-owner@example.invalid'),(other_user,'story-other@example.invalid');
  -- Three independent scenarios need three posts; keep the owner non-admin and quota enforcement active.
  INSERT INTO public.user_quotas(user_id,max_posts_per_day) VALUES(u,3)
    ON CONFLICT (user_id) DO UPDATE SET max_posts_per_day=EXCLUDED.max_posts_per_day;
  ASSERT (SELECT max_posts_per_day FROM public.effective_user_quotas(u))=3, 'bounded fixture quota';
  INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,is_active)
    VALUES(a,u,'instagram','3910001','story_fixture','synthetic-unused',true);
  INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,login_kind,permission_read_state,granted_scopes,scopes_read_at)
    VALUES(a,u,'direct','ok',ARRAY['instagram_business_content_publish'],now());
  INSERT INTO public.media_files(id,user_id,file_path,file_type,file_size,mime_type,storage_bucket)
    VALUES(m,u,'synthetic.jpg','image',100,'image/jpeg','media');
  INSERT INTO public.posts(id,user_id,caption,platforms,media_file_ids,status,metadata)
    VALUES(p,u,'Story fixture',ARRAY['instagram'],ARRAY[m],'processing',
      jsonb_build_object('instagram_post_type',jsonb_build_array('reel','story'),'selected_account_ids',jsonb_build_array(a)));
  BEGIN
    PERFORM public.prepare_instagram_story(p,a,other_user);
    RAISE EXCEPTION 'cross owner unexpectedly accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT public.prepare_instagram_story(p,a,u) IS TRUE, 'prepare owns exact post/account';
  ASSERT public.prepare_instagram_story(p,a,u) IS TRUE, 'prepare is idempotent';
  ASSERT (SELECT count(*) FROM public.instagram_story_jobs WHERE post_id=p) = 1, 'one logical intent';
  ASSERT (SELECT phase FROM public.instagram_story_jobs WHERE post_id=p) IS NOT DISTINCT FROM 'awaiting_reel', 'no pre-primary dispatch';
  INSERT INTO public.platform_posts(post_id,social_account_id,platform,status,platform_post_id,response_data)
    VALUES(p,a,'instagram','success','391001',jsonb_build_object('ig_post_subtype','reel'));
  SELECT background_job_id,result_id INTO j,r FROM public.instagram_story_jobs WHERE post_id=p;
  ASSERT j IS NOT NULL AND r IS NOT NULL, 'primary commit atomically creates result and job';
  INSERT INTO public.platform_posts(post_id,social_account_id,platform,status,platform_post_id,response_data)
    VALUES(p,a,'instagram','success','391001',jsonb_build_object('ig_post_subtype','reel'));
  ASSERT (SELECT count(*) FROM public.background_jobs WHERE id=j)=1, 'duplicate primary cannot enqueue again';
  ASSERT public.retry_instagram_story(p,r,u) IS FALSE, 'queued cannot retry';
  UPDATE public.background_jobs SET status='running',claim_token=token,claimed_at=clock_timestamp(),attempts=1 WHERE id=j;
  ASSERT public.read_instagram_story_job(j,gen_random_uuid()) IS NULL, 'wrong token refuses canonical state';
  UPDATE public.background_jobs SET claimed_at=clock_timestamp()-interval '4 minutes' WHERE id=j;
  ASSERT public.read_instagram_story_job(j,token) IS NULL, 'expired lease refuses';
  UPDATE public.background_jobs SET claimed_at=clock_timestamp() WHERE id=j;
  ASSERT public.checkpoint_instagram_story(j,token,2,'creating') IS FALSE, 'wrong generation refuses';
  ASSERT public.checkpoint_instagram_story(j,token,NULL,'creating') IS FALSE, 'unknown generation refuses';
  ASSERT public.checkpoint_instagram_story(j,token,1,NULL) IS FALSE, 'unknown phase refuses';
  UPDATE public.instagram_account_capabilities SET permission_read_state='unknown' WHERE social_account_id=a;
  ASSERT public.checkpoint_instagram_story(j,token,1,'creating') IS FALSE, 'unknown capability refuses';
  UPDATE public.instagram_account_capabilities SET permission_read_state='ok' WHERE social_account_id=a;
  ASSERT public.checkpoint_instagram_story(j,token,1,'creating') IS TRUE, 'current owned consent permits creation';
  ASSERT public.checkpoint_instagram_story(j,token,1,'processing','391010') IS TRUE, 'save container';
  ASSERT public.checkpoint_instagram_story(j,token,1,'publishing',NULL) IS FALSE, 'unknown container refuses';
  ASSERT public.checkpoint_instagram_story(j,token,1,'publishing','different') IS FALSE, 'container substitution refuses';
  ASSERT public.checkpoint_instagram_story(j,token,1,'publishing','391010') IS TRUE, 'one dispatch intent';
  ASSERT public.checkpoint_instagram_story(j,token,1,'publishing','391010') IS FALSE, 'duplicate dispatch refuses';
  ASSERT public.settle_instagram_story(j,token,1,false,'lost_reply',true) IS TRUE, 'uncertainty saved';
  UPDATE public.background_jobs SET status='failed' WHERE id=j;
  ASSERT public.retry_instagram_story(p,r,u) IS FALSE, 'unknown outcome never retries';
  ASSERT (SELECT response_data->>'story_state' FROM public.platform_posts WHERE id=r) IS NOT DISTINCT FROM 'uncertain', 'UI keeps uncertainty';

  -- General/bulk retry must preserve the managed result while retrying another failed account.
  INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active)
    VALUES('e3910000-0000-4000-8000-000000000008',u,'facebook','391008','synthetic-unused',true);
  INSERT INTO public.platform_posts(post_id,social_account_id,platform,status)
    VALUES(p,'e3910000-0000-4000-8000-000000000008','facebook','failed');
  v := public.request_post_retry(p,u,ARRAY[a,'e3910000-0000-4000-8000-000000000008'::uuid]);
  ASSERT v->>'status' IS NOT DISTINCT FROM 'accepted', 'general retry can still accept other platforms';
  ASSERT v->'account_ids' IS NOT DISTINCT FROM '["e3910000-0000-4000-8000-000000000008"]'::jsonb, 'managed account excluded';
  ASSERT EXISTS(SELECT 1 FROM public.platform_posts WHERE id=r), 'managed Story result preserved';
  UPDATE public.posts SET status='completed', publish_requested_at=NULL WHERE id=p;
  v := public.request_post_retry(p,u);
  ASSERT v->>'reason' IS NOT DISTINCT FROM 'no_targets', 'general retry excludes a sole managed failure';

  -- A distinct definitely-unpublished attempt may retry, without creating another Reel.
  p := 'e3910000-0000-4000-8000-000000000006';
  INSERT INTO public.posts(id,user_id,caption,platforms,media_file_ids,status,metadata)
    VALUES(p,u,'Second Story fixture',ARRAY['instagram'],ARRAY[m],'processing',
      jsonb_build_object('instagram_post_type',jsonb_build_array('reel','story'),'selected_account_ids',jsonb_build_array(a)));
  PERFORM public.prepare_instagram_story(p,a,u);
  INSERT INTO public.platform_posts(post_id,social_account_id,platform,status)
    VALUES(p,a,'instagram','failed');
  UPDATE public.posts SET status='failed' WHERE id=p;
  v := public.request_post_retry(p,u,ARRAY[a]);
  ASSERT v->>'status' IS NOT DISTINCT FROM 'accepted', 'an intent awaiting its first Reel does not block primary retry';
  UPDATE public.posts SET status='processing' WHERE id=p;
  INSERT INTO public.platform_posts(post_id,social_account_id,platform,status,platform_post_id,response_data)
    VALUES(p,a,'instagram','success','391002',jsonb_build_object('ig_post_subtype','reel'));
  SELECT background_job_id,result_id INTO j,r FROM public.instagram_story_jobs WHERE post_id=p;
  UPDATE public.background_jobs SET status='running',claim_token=token,claimed_at=clock_timestamp() WHERE id=j;
  ASSERT public.settle_instagram_story(j,token,1,false,'unsupported_media',false) IS TRUE, 'definite pre-dispatch failure';
  UPDATE public.background_jobs SET status='failed' WHERE id=j;
  SELECT count(*) INTO count_before FROM public.platform_posts WHERE post_id=p AND response_data->>'ig_post_subtype'='reel';
  ASSERT public.retry_instagram_story(p,r,other_user) IS FALSE, 'retry cannot cross owner';
  ASSERT public.retry_instagram_story(gen_random_uuid(),r,u) IS FALSE, 'retry binds post as well as result';
  UPDATE public.instagram_account_capabilities SET credential_generation=1,permission_read_state='unknown' WHERE social_account_id=a;
  ASSERT public.retry_instagram_story(p,r,u) IS FALSE, 'unverified new credentials cannot start another generation';
  UPDATE public.instagram_account_capabilities SET permission_read_state='ok' WHERE social_account_id=a;
  ASSERT public.retry_instagram_story(p,r,u) IS TRUE, 'definite failure retry accepted';
  ASSERT (SELECT credential_generation FROM public.instagram_story_jobs WHERE post_id=p)=1, 'explicit retry captures refreshed credentials';
  ASSERT public.retry_instagram_story(p,r,u) IS FALSE, 'second retry refuses while queued';
  ASSERT (SELECT generation FROM public.instagram_story_jobs WHERE post_id=p)=2, 'one generation increment';
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id=p AND response_data->>'ig_post_subtype'='reel')=count_before, 'retry never adds a Reel';
  SELECT background_job_id INTO j FROM public.instagram_story_jobs WHERE post_id=p;
  UPDATE public.background_jobs SET status='running',claim_token=token,claimed_at=clock_timestamp() WHERE id=j;
  ASSERT public.checkpoint_instagram_story(j,token,2,'creating') IS TRUE, 'retry current generation';
  ASSERT public.checkpoint_instagram_story(j,token,2,'processing','391011') IS TRUE, 'retry keeps own container';
  ASSERT public.checkpoint_instagram_story(j,token,2,'publishing','391011') IS TRUE, 'retry dispatch';
  ASSERT public.checkpoint_instagram_story(j,token,2,'published','391011','391012') IS TRUE, 'save confirmed publication';
  UPDATE public.background_jobs SET status='failed' WHERE id=j;
  ASSERT (SELECT status FROM public.platform_posts WHERE id=r) IS NOT DISTINCT FROM 'success', 'sweep recovers confirmed success after DB settlement crash';
  ASSERT public.retry_instagram_story(p,r,u) IS FALSE, 'published is terminal';
  ASSERT (SELECT platform_post_id FROM public.platform_posts WHERE id=r) IS NOT DISTINCT FROM '391012', 'provider identity retained';

  p := 'e3910000-0000-4000-8000-000000000007';
  INSERT INTO public.posts(id,user_id,caption,platforms,media_file_ids,status,metadata)
    VALUES(p,u,'Revocation fixture',ARRAY['instagram'],ARRAY[m],'processing',
      jsonb_build_object('instagram_post_type',jsonb_build_array('reel','story'),'selected_account_ids',jsonb_build_array(a)));
  PERFORM public.prepare_instagram_story(p,a,u);
  INSERT INTO public.platform_posts(post_id,social_account_id,platform,status,platform_post_id,response_data)
    VALUES(p,a,'instagram','success','391003',jsonb_build_object('ig_post_subtype','reel'));
  SELECT background_job_id INTO j FROM public.instagram_story_jobs WHERE post_id=p;
  UPDATE public.background_jobs SET status='running',claim_token=token,claimed_at=clock_timestamp() WHERE id=j;
  UPDATE public.posts SET metadata=jsonb_set(metadata,'{instagram_post_type}','["reel"]') WHERE id=p;
  ASSERT public.checkpoint_instagram_story(j,token,1,'creating') IS FALSE, 'withdrawn consent refuses';
  UPDATE public.posts SET metadata=jsonb_set(metadata,'{instagram_post_type}','["reel","story"]') WHERE id=p;
  ASSERT public.checkpoint_instagram_story(j,token,1,'creating') IS FALSE, 'restoring checkbox never revives old claim';
END $$;
ROLLBACK;
