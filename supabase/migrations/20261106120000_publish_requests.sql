-- Background publishing, Phase A: "Publish now" and "Retry" become a durable
-- request plus a best-effort kick.
--
-- Before this, the browser invoked process-post and waited for it. A lost or
-- slow request left the post pending forever (nothing selected it), and a
-- double click on Retry ran two publishes.
--
-- Now the request is written to the post first: publish_requested_at is the
-- moment the owner asked for a publish. enqueue-post-publish stamps it, then
-- kicks process-post with that exact value as expected_publish_requested_at.
-- process-scheduled-posts also selects posts whose request is older than a
-- short grace period and passes the same expectation. Both go through one
-- compare-and-set (_shared/postProcessingClaim.ts), so exactly one of them
-- moves the post to processing and the other matches zero rows.
--
-- scheduled_at keeps meaning "when the owner scheduled it": Calendar,
-- Analytics, the Scheduled board and the partner post.scheduled webhook read
-- it, and an immediate publish must not appear there as a schedule.
--
-- 1. posts.publish_requested_at, its due-row index, and an insert trigger that
--    pins it to the database clock.
-- 2. request_immediate_publish: the "Publish now" stamp.
-- 3. request_post_retry: the "Retry" stamp, with server-side targets.

-- ---------------------------------------------------------------------------
-- 1. The request column
-- ---------------------------------------------------------------------------
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS publish_requested_at timestamptz;

COMMENT ON COLUMN public.posts.publish_requested_at IS
  'When the owner last asked for this post to be published now or retried. The processing claim compares it, so a request is claimed once. NULL for posts that only ever ran on their schedule.';

CREATE INDEX IF NOT EXISTS posts_publish_requested_due_idx
  ON public.posts (publish_requested_at)
  WHERE status IN ('pending', 'scheduled') AND publish_requested_at IS NOT NULL;

-- The composer inserts an immediate post with publish_requested_at set, so the
-- scheduler can publish it even if the browser never reaches
-- enqueue-post-publish. A browser clock running ahead would delay that net by
-- the skew; the database clock does not.
CREATE OR REPLACE FUNCTION public.posts_pin_publish_requested_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.publish_requested_at IS NOT NULL THEN
    NEW.publish_requested_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.posts_pin_publish_requested_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_posts_pin_publish_requested_at ON public.posts;
CREATE TRIGGER trg_posts_pin_publish_requested_at
  BEFORE INSERT ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.posts_pin_publish_requested_at();

-- ---------------------------------------------------------------------------
-- 2. request_immediate_publish
-- ---------------------------------------------------------------------------
-- Returns the publish_requested_at it wrote, or NULL when nothing matched: the
-- post does not exist, belongs to another user, is a TikTok review post (those
-- have their own dispatcher), or is no longer pending or scheduled. Ownership
-- is part of the WHERE clause, so no pair of ids stamps another user's post.
--
-- A scheduled post published early gets scheduled_at = now() as well, which is
-- what "Publish now" on the Scheduled page always wrote: the post then shows at
-- the time it actually went out. An unscheduled post keeps scheduled_at NULL.
--
-- A post already queued by request_post_retry keeps its request untouched and
-- the existing stamp is returned: re-stamping would orphan the retry marker,
-- and the run would then publish to every platform, including accounts that
-- already succeeded.
CREATE OR REPLACE FUNCTION public.request_immediate_publish(p_post_id uuid, p_user_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested_at timestamptz;
BEGIN
  UPDATE public.posts
     SET publish_requested_at = CASE WHEN queued_retry THEN publish_requested_at ELSE now() END,
         scheduled_at = CASE
           WHEN queued_retry OR scheduled_at IS NULL THEN scheduled_at
           ELSE now()
         END
    FROM (
      SELECT p.id AS queued_id,
             p.publish_requested_at IS NOT NULL
               AND (p.metadata -> 'retry_request' ->> 'requested_at')::timestamptz
                   = p.publish_requested_at AS queued_retry
        FROM public.posts p
       WHERE p.id = p_post_id
    ) q
   WHERE id = q.queued_id
     AND id = p_post_id
     AND user_id = p_user_id
     AND status IN ('pending', 'scheduled')
     AND source IS DISTINCT FROM 'tiktok_review'
  RETURNING publish_requested_at INTO v_requested_at;

  RETURN v_requested_at;
END;
$$;

REVOKE ALL ON FUNCTION public.request_immediate_publish(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_immediate_publish(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. request_post_retry
-- ---------------------------------------------------------------------------
-- One transaction decides what is retried, clears those failed results and
-- queues the request, so two clicks cannot both start a run and a retry never
-- republishes an account that already succeeded.
--
-- Targets:
--   * p_account_ids given: those accounts, which must belong to the owner;
--   * otherwise: every account with a failed result on this post.
-- Either way an account that already has a successful or pending result on
-- this post is dropped: it was published, or is being published.
--
-- The post moves to pending with a fresh publish_requested_at, and
-- metadata.retry_request records the targets under the same timestamp.
-- process-post treats a run as a retry, and uses these targets, only when the
-- recorded requested_at equals the row's publish_requested_at, so a stale
-- marker from an earlier retry never applies to a later run.
--
-- Returns {"status":"accepted","requested_at":...,"account_ids":[...],
-- "platforms":[...]} or {"status":"refused","reason":"not_found" |
-- "not_retryable" | "no_targets"}. not_found also covers another user's post,
-- so the answer does not reveal which posts exist.
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

  IF v_post.status NOT IN ('failed', 'completed')
     OR v_post.source IS NOT DISTINCT FROM 'tiktok_review' THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_retryable');
  END IF;

  IF p_account_ids IS NOT NULL AND cardinality(p_account_ids) > 0 THEN
    SELECT array_agg(DISTINCT sa.id) INTO v_targets
      FROM public.social_accounts sa
     WHERE sa.id = ANY (p_account_ids)
       AND sa.user_id = p_user_id;
  ELSE
    SELECT array_agg(DISTINCT pp.social_account_id) INTO v_targets
      FROM public.platform_posts pp
     WHERE pp.post_id = p_post_id
       AND pp.status = 'failed'
       AND pp.social_account_id IS NOT NULL;
  END IF;

  SELECT array_agg(t) INTO v_targets
    FROM unnest(coalesce(v_targets, ARRAY[]::uuid[])) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM public.platform_posts pp
      WHERE pp.post_id = p_post_id
        AND pp.social_account_id = t
        AND pp.status IN ('success', 'pending')
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
     AND social_account_id = ANY (v_targets);

  UPDATE public.posts
     SET status = 'pending',
         publish_requested_at = v_requested_at,
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
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

NOTIFY pgrst, 'reload schema';
