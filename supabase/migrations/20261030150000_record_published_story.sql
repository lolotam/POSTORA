-- One platform_posts row per published Instagram story, enforced in SQL.
--
-- Follow-up to the story recording in process-post/instagramStory.ts (review F9,
-- docs/superpowers/specs/2026-10-30-hardening-review-followups-design.md).
--
-- WHY
-- process-post recorded a live story by reading platform_posts for the story's
-- media id and, when none was found, inserting the row through
-- partner_settle_platform_post: two requests, with nothing between them. Two
-- runs carrying the same story (the request path and the reconciler's resume, or
-- a retry overlapping a slow first attempt) could both read "none" and both
-- insert, leaving the post with two rows for one story.
--
-- WHAT
-- 1. A partial unique index: at most one row showing a given story per (post,
--    account, story media id). It covers the two shapes such a row takes: a
--    story row (ig_post_subtype = 'story', which every story writer sets) and a
--    reel row the abandon path settled as the account's live story
--    (story_recorded_on_reel_row). No other writer's rows are constrained. If
--    the abandon path's settle loses to a story insert it fails on the index,
--    and the reconciler's next run finds the story row and gives the reel up
--    normally.
-- 2. record_published_story: the lookup and the insert in one function. A
--    concurrent insert that wins the race raises unique_violation inside it;
--    the losing call rolls back its own insert (with its roll-up and enqueue)
--    and answers the winner's row instead.
--
-- Production had no duplicate (post, account, provider id) groups in
-- platform_posts when this was written (2026-10-30), so the index builds
-- without a clean-up step. It is additive and safe to apply before the Edge
-- Function deploys: the old code's insert path still works under the index.
-- No BEGIN/COMMIT of its own.

CREATE UNIQUE INDEX IF NOT EXISTS platform_posts_one_row_per_instagram_story
  ON public.platform_posts (post_id, social_account_id, platform_post_id)
  WHERE platform_post_id IS NOT NULL
    AND (response_data ->> 'ig_post_subtype' = 'story'
         OR response_data ->> 'story_recorded_on_reel_row' = 'true');

CREATE OR REPLACE FUNCTION public.record_published_story(
  p_post_id uuid,
  p_social_account_id uuid,
  p_story_id text,
  p_story_url text,
  p_response_data jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing uuid;
  v_settled jsonb;
BEGIN
  IF p_post_id IS NULL OR p_social_account_id IS NULL OR coalesce(p_story_id, '') = '' THEN
    RAISE EXCEPTION 'record_published_story: post, account and story id are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Any row of this post and account already showing the story counts, as the
  -- caller's old lookup did: that includes a reel row settled as the story.
  SELECT id INTO v_existing FROM public.platform_posts
   WHERE post_id = p_post_id AND social_account_id = p_social_account_id AND platform_post_id = p_story_id
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('platform_post_id', v_existing, 'recorded', false);
  END IF;

  BEGIN
    -- The tenancy check, the roll-up and the enqueue are the settle function's.
    -- The tag is set here, on an object, so the row always falls under the unique
    -- index: `||` on an array or scalar would yield an array without the tag.
    v_settled := public.partner_settle_platform_post(
      NULL, p_post_id, p_social_account_id, 'instagram', 'success',
      p_story_id, p_story_url, NULL,
      CASE WHEN jsonb_typeof(p_response_data) = 'object' THEN p_response_data ELSE '{}'::jsonb END
        || jsonb_build_object('ig_post_subtype', 'story')
    );
  EXCEPTION WHEN unique_violation THEN
    -- Another run recorded the same story between the lookup and the insert.
    SELECT id INTO v_existing FROM public.platform_posts
     WHERE post_id = p_post_id AND social_account_id = p_social_account_id AND platform_post_id = p_story_id
     LIMIT 1;
    -- A conflict that left no row showing the story was some other constraint:
    -- answering success would let the caller drop a story nothing recorded.
    IF v_existing IS NULL THEN
      RAISE;
    END IF;
    RETURN jsonb_build_object('platform_post_id', v_existing, 'recorded', false);
  END;

  RETURN jsonb_build_object('platform_post_id', v_settled ->> 'platform_post_id', 'recorded', true);
END;
$$;

-- Same grant convention as the other publish-path functions: service role only.
REVOKE ALL ON FUNCTION public.record_published_story(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_published_story(uuid, uuid, text, text, jsonb) TO service_role;
