-- The action claim becomes the processing claim: an agent retry may only move
-- its post into `processing` while it still holds the lease, and only to the
-- destinations that are still safe to publish to.
--
-- WHY THIS EXISTS. The agent route (n8n / MCP) decides what to publish from an
-- APPLICATION-SIDE SNAPSHOT: it reads the per-platform results, picks the
-- failed accounts, and dispatches the publish. Between that read and the
-- worker that publishes, a durable writer can mark a destination as no longer
-- safe to publish to -- an unknown outcome, a cancelled attempt, a deferred
-- Threads image, a YouTube upload that may have created a video. The snapshot
-- does not see it, so the retry publishes to a destination that may already
-- hold the publication, and the customer gets it twice.
--
-- `request_post_retry` is the contract that answers the question durably, in
-- one place, under the lock of the post. The agent route cannot call it: it
-- queues the retry and deletes the failed rows, while the agent route
-- publishes synchronously and keeps the rows it replaced. So the durable
-- questions are asked here instead, and the answer is the same one.
--
-- The gate is one transaction on the parent row:
--
--   1. the parent row is locked, so this decision and the durable writers
--      that mark a destination are ordered, not racing;
--   2. the lease that asks for the publish is the EXACT live claim on the
--      post -- a claim that is not the one on the row, or one whose lease has
--      run out, may not publish;
--   3. the post is the caller's own and has finished;
--   4. the targets are the caller's own accounts;
--   5. every target is still safe to publish to, read under that same lock;
--   6. and only then does the parent move to `processing`.
--
-- A refusal changes nothing: the post keeps its status, its rows and its
-- evidence. The caller is told which destinations refused and why, so the
-- answer is the same one the browser gets.
--
-- This migration is ADDITIVE: two new functions and a rewrite of the target
-- filter of `request_post_retry` that asks the same question through the
-- shared helper. The accepted retry contract is unchanged.

-- ---------------------------------------------------------------------------
-- 1. The shared reason.
--
-- The durable reasons a destination of a post may not be published to again.
-- They live in one function so that every gate that asks the question asks it
-- the same way: the agent route drifted from `request_post_retry` once, and a
-- second copy of these rules is how that happens again.
--
-- The helper answers for an ACCOUNT, not for a row: a destination is a
-- destination, whichever of its rows carries the marker.
--
-- It is STABLE because it only reads. It is SECURITY DEFINER because the
-- caller is the service role and the tables are the contract.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_retry_block_reason(
  p_post_id uuid,
  p_account_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A result whose publish outcome is UNKNOWN or CANCELLED is not published
  -- again. The provider may already hold the publication, so a retry could
  -- publish a second one, and a cancelled attempt is not republished either.
  IF EXISTS (
    SELECT 1 FROM public.platform_posts pp
     WHERE pp.post_id = p_post_id
       AND pp.social_account_id = p_account_id
       AND coalesce(pp.response_data ->> 'publish_outcome', '') IN ('uncertain', 'cancelled')
  ) THEN
    RETURN 'publish_outcome_protected';
  END IF;

  -- A deferred Threads image whose outcome is unknown may be on the profile
  -- already.
  IF EXISTS (
    SELECT 1 FROM public.platform_posts pp
     WHERE pp.post_id = p_post_id
       AND pp.social_account_id = p_account_id
       AND pp.platform = 'threads'
       AND pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
       AND pp.response_data #>> '{deferred,publish_outcome}' IS NOT DISTINCT FROM 'uncertain'
  ) THEN
    RETURN 'threads_deferred_uncertain';
  END IF;

  -- A YouTube upload that needs manual reconciliation may have created a
  -- video on the channel, so a retry could create a second one. An upload
  -- that is still open is not retried either: the continuation carries it on,
  -- and a retry would write the same bytes into a second session. A session
  -- that already holds a RECEIPT is not retried either: the video exists.
  IF EXISTS (
    SELECT 1 FROM public.youtube_upload_sessions ys
     WHERE ys.post_id = p_post_id
       AND ys.social_account_id = p_account_id
       AND ys.state IN ('reconcile', 'open', 'uploaded')
  ) THEN
    RETURN 'youtube_upload_in_flight';
  END IF;

  -- A publish that is still going out is a publish that may still go public.
  IF EXISTS (
    SELECT 1 FROM public.platform_posts pp
     WHERE pp.post_id = p_post_id
       AND pp.social_account_id = p_account_id
       AND pp.status = 'pending'
  ) THEN
    RETURN 'publish_in_flight';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.post_retry_block_reason(uuid, uuid) IS
  'The durable reasons a destination of a post may not be published to again, '
  'or NULL when it may. The answer is per account: a marker on any of its '
  'rows protects the destination.';

REVOKE ALL ON FUNCTION public.post_retry_block_reason(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_retry_block_reason(uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The retry contract asks the shared question.
--
-- The target filter asked four questions inline. It now asks the shared
-- helper, which holds the same four rules, so that the agent gate below and
-- this one cannot drift apart.
--
-- Nothing else changes: the Instagram story exclusion, the success rule and
-- the deletion of the failed rows keep the contract they had.
-- ---------------------------------------------------------------------------
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
    SELECT array_agg(DISTINCT pp.social_account_id) INTO v_targets
      FROM public.platform_posts pp
      JOIN public.social_accounts sa ON sa.id = pp.social_account_id
     WHERE pp.post_id = p_post_id
       AND pp.status = 'failed'
       AND sa.user_id = p_user_id
       AND NOT (
         pp.platform = 'threads'
         AND pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
         AND pp.response_data #>> '{deferred,publish_outcome}' IS NOT DISTINCT FROM 'uncertain'
       );
  END IF;

  -- A destination that is not safe to publish to again is not a target: an
  -- unknown or cancelled outcome, a deferred Threads image, a YouTube upload
  -- that may have created a video, and a publish that is still going out.
  -- The reason is one function, so the agent gate below answers the same
  -- question the same way.
  SELECT array_agg(t) INTO v_targets
    FROM unnest(coalesce(v_targets, ARRAY[]::uuid[])) AS t
   WHERE NOT EXISTS (SELECT 1 FROM public.instagram_story_jobs sj
                      WHERE sj.post_id=p_post_id AND sj.social_account_id=t AND sj.result_id IS NOT NULL)
     AND public.post_retry_block_reason(p_post_id, t) IS NULL
     -- A result that succeeded is not published again. Instagram is the
     -- exception: an account whose story went live still has its failed feed
     -- post to publish.
     AND NOT EXISTS (
       SELECT 1 FROM public.platform_posts pp
        WHERE pp.post_id = p_post_id
          AND pp.social_account_id = t
          AND pp.status = 'success'
          AND NOT (pp.platform = 'instagram'
                   AND EXISTS (SELECT 1 FROM public.platform_posts failed
                                WHERE failed.post_id = p_post_id
                                  AND failed.social_account_id = t
                                  AND failed.status = 'failed'))
     );

  IF v_targets IS NULL OR cardinality(v_targets) = 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_targets');
  END IF;

  SELECT array_agg(DISTINCT sa.platform) INTO v_platforms
    FROM public.social_accounts sa
   WHERE sa.id = ANY (v_targets);

  -- The failed rows the retry replaces are deleted. The rows that carry the
  -- evidence of what happened stay: an unknown or cancelled outcome keeps its
  -- row, a deferred Threads image keeps its row, and a destination with a
  -- YouTube upload keeps its row.
  DELETE FROM public.platform_posts
   WHERE post_id = p_post_id
     AND status = 'failed'
     AND social_account_id = ANY (v_targets)
     AND NOT EXISTS (SELECT 1 FROM public.instagram_story_jobs sj WHERE sj.result_id=platform_posts.id)
     AND NOT (
       platform = 'threads'
       AND response_data #>> '{deferred,media_type}' = 'IMAGE'
       AND response_data #>> '{deferred,publish_outcome}' IS NOT DISTINCT FROM 'uncertain'
     )
     -- An unknown or cancelled outcome keeps its row: it is the record of what
     -- happened, and it is the evidence that the destination is not retryable.
     -- The coalesce matters: a row without the marker must still be deleted,
     -- because `NOT (NULL IN (...))` is NULL and would keep it for ever.
     AND coalesce(response_data ->> 'publish_outcome', '') NOT IN ('uncertain', 'cancelled')
     AND NOT EXISTS (
       SELECT 1 FROM public.youtube_upload_sessions ys
        WHERE ys.post_id = platform_posts.post_id
          AND ys.social_account_id = platform_posts.social_account_id
          AND ys.state IN ('reconcile', 'open', 'uploaded')
     );

  UPDATE public.posts
     SET status = 'pending',
         publish_requested_at = v_requested_at,
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

COMMENT ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) IS
  'The accepted retry contract, plus the exclusion of a YouTube upload that '
  'needs manual reconciliation or that already holds a receipt: such an '
  'upload may have created a video on the channel, so it is neither targeted '
  'nor deleted. A result whose publish outcome is unknown or cancelled is '
  'neither targeted nor deleted either, for the same reason: the provider '
  'may already hold the publication. The durable reasons live in '
  'post_retry_block_reason, so that every gate asks them the same way.';

REVOKE ALL ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The processing claim of an agent action.
--
-- The claim the agent route takes (`mcp_claim_post_action`) says who is
-- working on the post. It never changes the post's status: it is a lease on
-- an action, not a publish.
--
-- This function is the other half. It moves the post into `processing` for
-- the worker that is about to publish, and it does that only when every
-- condition holds:
--
--   * the post is the caller's own;
--   * the lease it carries is the EXACT claim on the row, and that claim is
--     still live -- a claim that ran out, or a claim of another run, may not
--     publish;
--   * the post has finished, so nobody else is publishing it;
--   * the targets are the caller's own accounts;
--   * every target is still safe to publish to, read under the lock of the
--     parent, so a marker written after the caller's snapshot is seen here.
--
-- The parent moves to `processing` only after all of them. A refusal leaves
-- the post exactly as it was.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_post_action_processing(
  p_post_id uuid,
  p_user_id uuid,
  p_action_claim_id uuid,
  p_target_account_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_targets uuid[];
  v_blocked jsonb;
  v_processing_started_at timestamptz := clock_timestamp();
BEGIN
  IF p_post_id IS NULL OR p_user_id IS NULL OR p_action_claim_id IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'missing_argument');
  END IF;

  -- THE PARENT LOCK. Everything below is read under it, so a durable writer
  -- that marks a destination while this call waits cannot be invisible: the
  -- two are ordered, not racing.
  SELECT * INTO v_post
    FROM public.posts
   WHERE id = p_post_id AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_found');
  END IF;

  -- THE EXACT LIVE LEASE. The lease is the identity of the run that asked
  -- for this publish: a claim that is not the one on the row, or one whose
  -- lease has run out, is not allowed to publish. The lease is fifteen
  -- minutes, the length `mcp_claim_post_action` takes.
  IF v_post.action_claim_id IS DISTINCT FROM p_action_claim_id
     OR v_post.action_claimed_at IS NULL
     OR v_post.action_claimed_at <= now() - interval '15 minutes' THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'claim_not_live');
  END IF;

  -- A post that has not finished is being published by somebody else. An
  -- expired lease does not change that: the claim proves that an agent
  -- stopped, not that the publish stopped.
  IF v_post.status IS NULL OR v_post.status NOT IN ('failed', 'completed') THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_terminal', 'status', v_post.status);
  END IF;

  -- The targets are the caller's own accounts. A target of somebody else is
  -- not a target at all.
  SELECT array_agg(DISTINCT sa.id ORDER BY sa.id) INTO v_targets
    FROM public.social_accounts sa
   WHERE sa.id = ANY (p_target_account_ids)
     AND sa.user_id = p_user_id;

  IF v_targets IS NULL OR cardinality(v_targets) = 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_targets');
  END IF;

  -- THE DURABLE ADMISSIBILITY OF EVERY TARGET, read under the parent lock.
  -- The caller's snapshot was taken before this call, and a marker may have
  -- been written since: that marker is what this read finds.
  WITH reasons AS (
    SELECT t AS account_id,
           public.post_retry_block_reason(p_post_id, t) AS reason
      FROM unnest(v_targets) AS t
  )
  SELECT jsonb_agg(jsonb_build_object('account_id', s.account_id, 'reason', s.reason) ORDER BY s.account_id)
    INTO v_blocked
    FROM (
      SELECT r.account_id,
             COALESCE(
               r.reason,
               CASE WHEN EXISTS (
                 SELECT 1 FROM public.platform_posts pp
                  WHERE pp.post_id = p_post_id
                    AND pp.social_account_id = r.account_id
                    AND pp.status = 'success'
               ) THEN 'already_published' END
             ) AS reason
        FROM reasons r
    ) s
   WHERE s.reason IS NOT NULL;

  IF v_blocked IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'refused',
      'reason', 'targets_not_admissible',
      'blocked', v_blocked
    );
  END IF;

  -- The whole gate passed. Only now does the parent move to `processing`.
  UPDATE public.posts
     SET status = 'processing',
         processing_started_at = v_processing_started_at
   WHERE id = p_post_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'processing_started_at', v_processing_started_at,
    'account_ids', to_jsonb(v_targets)
  );
END;
$$;

COMMENT ON FUNCTION public.claim_post_action_processing(uuid, uuid, uuid, uuid[]) IS
  'Moves a post into processing for an agent action that holds its live lease, '
  'when every destination it names is still safe to publish to. The decision '
  'is made under the lock of the post, so a destination that became unsafe '
  'after the caller read its results refuses the publish instead of '
  'publishing it twice. A refusal changes nothing.';

REVOKE ALL ON FUNCTION public.claim_post_action_processing(uuid, uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_post_action_processing(uuid, uuid, uuid, uuid[])
  TO service_role;
