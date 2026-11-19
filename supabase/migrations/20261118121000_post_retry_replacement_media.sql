-- Keep replacement media and retry admission in the same transaction.
CREATE OR REPLACE FUNCTION public.request_post_retry_with_media(
  p_post_id uuid,
  p_user_id uuid,
  p_media_ids uuid[],
  p_account_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owned_count integer;
  v_retry jsonb;
BEGIN
  -- Use the retry admission lock order and hold the post until both writes commit.
  PERFORM 1 FROM public.posts
   WHERE id = p_post_id AND user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_found');
  END IF;

  IF p_media_ids IS NULL OR cardinality(p_media_ids) NOT BETWEEN 1 AND 50 THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'invalid_media');
  END IF;

  SELECT count(*) INTO v_owned_count
    FROM (
      SELECT id FROM public.media_files
       WHERE user_id = p_user_id AND id = ANY(p_media_ids)
       ORDER BY id
       FOR SHARE
    ) AS owned_media;
  IF v_owned_count <> cardinality(p_media_ids) THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'invalid_media');
  END IF;

  v_retry := public.request_post_retry(p_post_id, p_user_id, p_account_ids);
  IF v_retry ->> 'status' = 'accepted' THEN
    UPDATE public.posts SET media_file_ids = p_media_ids
     WHERE id = p_post_id AND user_id = p_user_id;
  END IF;
  RETURN v_retry;
END;
$$;

REVOKE ALL ON FUNCTION public.request_post_retry_with_media(uuid, uuid, uuid[], uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_post_retry_with_media(uuid, uuid, uuid[], uuid[])
  TO service_role;
