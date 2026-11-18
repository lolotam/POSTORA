-- The outcome of a YouTube destination that goes with the account.
--
-- WHY
-- ---
-- The public result row of a destination belongs to the account it published
-- on: public.platform_posts.social_account_id is ON DELETE CASCADE, so the row
-- is deleted with the account the customer disconnects.
--
-- That row is where the outcome of a YouTube upload lives. The video id of a
-- published video, and the uncertainty marker of an upload that may already
-- have published one, are written there and nowhere else. The session keeps
-- the evidence too, but the session is not the row the owner reads: after the
-- disconnect the owner is left with a post that says nothing about the video
-- that is on their channel, and with nothing that says the outcome was
-- uncertain at all.
--
-- WHAT
-- ---
-- The evidence is therefore copied onto the post before the result row goes.
-- The post is the row the owner keeps, it outlives every account the customer
-- may disconnect, and it is the row the post's own history reads.
--
-- The evidence is per destination. A post may publish to several channels, so
-- the outcome is a map keyed by the id of the result row it came from, and one
-- destination's outcome never overwrites another's.
--
-- The trigger runs before the row is deleted, so the values it copies are the
-- ones the row was settled with. A result with neither a video nor an
-- uncertainty marker says nothing, so nothing is written for it.
--
-- This is a NEW migration. The migrations of this feature are applied in
-- production, and a change to their behaviour is never an edit of an applied
-- file (ARCHITECTURE.md section 23).

-- ---------------------------------------------------------------------------
-- The evidence of a deleted result row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preserve_youtube_upload_outcome_of_deleted_result()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_channel text;
  v_outcome jsonb;
BEGIN
  IF OLD.platform <> 'youtube' THEN
    RETURN OLD;
  END IF;

  -- A result with neither a video nor an uncertainty marker says nothing, so
  -- there is no evidence to keep.
  IF OLD.platform_post_id IS NULL
     AND coalesce(OLD.response_data ->> 'publish_outcome', '') <> 'uncertain' THEN
    RETURN OLD;
  END IF;

  -- The channel of the destination is kept by the session, which outlives the
  -- account the result row belonged to. The session still points at this row
  -- here: the foreign key clears the link only after the row is gone.
  SELECT s.disconnected_channel_id INTO v_channel
    FROM public.youtube_upload_sessions s
   WHERE s.platform_post_id = OLD.id
   LIMIT 1;

  v_outcome := jsonb_strip_nulls(jsonb_build_object(
    'outcome', CASE WHEN OLD.platform_post_id IS NOT NULL THEN 'published' ELSE 'uncertain' END,
    'video_id', OLD.platform_post_id,
    'video_url', OLD.platform_post_url,
    'channel_id', v_channel,
    'reason', OLD.response_data ->> 'youtube_upload_reason',
    'publish_outcome_reason', OLD.response_data ->> 'publish_outcome_reason'
  ));

  UPDATE public.posts p
     SET metadata = jsonb_set(
           coalesce(p.metadata, '{}'::jsonb),
           '{youtube_upload_outcomes}',
           coalesce(p.metadata -> 'youtube_upload_outcomes', '{}'::jsonb)
             || jsonb_build_object(OLD.id::text, v_outcome),
           true)
   WHERE p.id = OLD.post_id;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.preserve_youtube_upload_outcome_of_deleted_result() IS
  'Copies the outcome of a deleted YouTube result row onto the post, so that the '
  'video id of a published video and the marker of an uncertain upload survive the '
  'account the row belonged to.';

DROP TRIGGER IF EXISTS trg_youtube_upload_preserve_deleted_outcome ON public.platform_posts;
CREATE TRIGGER trg_youtube_upload_preserve_deleted_outcome
  BEFORE DELETE ON public.platform_posts
  FOR EACH ROW
  WHEN (OLD.platform = 'youtube')
  EXECUTE FUNCTION public.preserve_youtube_upload_outcome_of_deleted_result();

REVOKE ALL ON FUNCTION public.preserve_youtube_upload_outcome_of_deleted_result()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preserve_youtube_upload_outcome_of_deleted_result() TO service_role;
