-- Partner API v1, Phase 7: the publishing seam's database half (deliverable 7.4).
--
-- Design record: docs/decisions/2026-09-02-d9-publishing-seam.md.
-- Additive only: one function. No table, column or constraint is changed.
--
-- WHAT 7.0 FOUND, because it determines this function's shape:
--
--   Terminal platform_posts status is committed from FIVE places, all inside
--   process-post/index.ts -- and in TWO shapes. A row can be UPDATED to
--   terminal (the TikTok poll settling, lines 965 and 1001) or INSERTED
--   already terminal (lines 1568, 1630, 4365). v1.1 assumed one writer and
--   one shape; an operation that only handled the update would silently miss
--   three of the five, and D5(R1) would be false for them while looking true.
--
-- So this function serves both: given a row id it settles that row, and given
-- the (post, account, platform) triple with no row id it creates the row
-- already terminal. One operation, one enqueue, either way.

CREATE OR REPLACE FUNCTION public.partner_settle_platform_post(
  p_platform_post_id   UUID,
  p_post_id            UUID,
  p_social_account_id  UUID,
  p_platform           TEXT,
  p_status             TEXT,
  p_provider_post_id   TEXT DEFAULT NULL,
  p_provider_post_url  TEXT DEFAULT NULL,
  p_error_message      TEXT DEFAULT NULL,
  p_response_data      JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row        public.platform_posts;
  v_post       public.posts;
  v_owner      UUID;
  v_acct_owner UUID;
  v_workspace  UUID;
  v_event      TEXT;
  v_enqueued   INTEGER := 0;
  v_total      INTEGER;
  v_settled    INTEGER;
  v_succeeded  INTEGER;
  v_post_state TEXT;
BEGIN
  -- platform_posts.status admits only pending / success / failed, so
  -- "terminal" is exactly success|failed. Rejecting anything else here keeps
  -- a caller from using this function to park a row in `pending` and expecting
  -- an event, which would enqueue a publication that has not happened.
  IF p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'partner_settle_platform_post: % is not a terminal status', p_status;
  END IF;

  -- ---- the pairing check, BEFORE anything is written --------------------
  --
  -- platform_posts carries two INDEPENDENT foreign keys, so a post belonging
  -- to user A and an account belonging to user B is a perfectly valid row --
  -- and this function would then roll up A's post while deriving the event's
  -- workspace from B's account, delivering A's post details to B's webhook.
  --
  -- No caller does that today; all five pair the ids from the same job. But
  -- "every caller pairs them correctly" is the assumption D4 exists to
  -- refuse: the tenancy boundary belongs in the constraint, not in the
  -- discipline of callers. `platform_posts` predates this programme and
  -- cannot gain a composite FK additively (it has no workspace_id and posts
  -- has no workspace_id either), so the check lives here instead -- and it
  -- runs before the write, so a mismatched pair cannot even create a row.
  IF p_platform_post_id IS NOT NULL THEN
    SELECT p.user_id INTO v_owner FROM public.posts p
      JOIN public.platform_posts pp ON pp.post_id = p.id
     WHERE pp.id = p_platform_post_id;
  ELSE
    SELECT p.user_id INTO v_owner FROM public.posts p WHERE p.id = p_post_id;
  END IF;

  IF p_social_account_id IS NOT NULL OR p_platform_post_id IS NOT NULL THEN
    SELECT a.user_id INTO v_acct_owner
      FROM public.social_accounts a
     WHERE a.id = coalesce(
             p_social_account_id,
             (SELECT pp.social_account_id FROM public.platform_posts pp WHERE pp.id = p_platform_post_id)
           );
    -- NULL account owner means there is no account to disagree with (the
    -- fallback insert permits a row without one), so only a PRESENT and
    -- DIFFERENT owner is a refusal.
    IF v_acct_owner IS NOT NULL AND v_owner IS NOT NULL AND v_acct_owner <> v_owner THEN
      RAISE EXCEPTION
        'partner_settle_platform_post: post % belongs to % but account % belongs to % (cross-tenant pairing refused)',
        coalesce(p_post_id, p_platform_post_id), v_owner, p_social_account_id, v_acct_owner
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF p_platform_post_id IS NOT NULL THEN
    -- Shape 1: settle an existing row. FOR UPDATE serialises two settles of
    -- the same target -- the TikTok poller and the request path can both reach
    -- one row.
    SELECT * INTO v_row FROM public.platform_posts
     WHERE id = p_platform_post_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'partner_settle_platform_post: no platform_post %', p_platform_post_id;
    END IF;

    -- Already terminal: do NOT re-write and do NOT re-enqueue. The occurrence
    -- id would be identical and the outbox would absorb it anyway, but
    -- returning early keeps `enqueued` truthful about what this call did.
    IF v_row.status IN ('success', 'failed') THEN
      RETURN jsonb_build_object(
        'platform_post_id', v_row.id, 'settled', false, 'enqueued', 0,
        'reason', 'already terminal'
      );
    END IF;

    UPDATE public.platform_posts
       SET status            = p_status,
           platform_post_id  = coalesce(p_provider_post_id, platform_post_id),
           platform_post_url = coalesce(p_provider_post_url, platform_post_url),
           error_message     = coalesce(p_error_message, error_message),
           response_data     = coalesce(p_response_data, response_data),
           posted_at         = CASE WHEN p_status = 'success'
                                    THEN coalesce(posted_at, now()) ELSE posted_at END
     WHERE id = p_platform_post_id
    RETURNING * INTO v_row;
  ELSE
    -- Shape 2: the row is born terminal. Three of the five writers do this.
    IF p_post_id IS NULL OR p_platform IS NULL THEN
      RAISE EXCEPTION
        'partner_settle_platform_post: p_post_id and p_platform are required when no row id is given';
    END IF;

    INSERT INTO public.platform_posts (
      post_id, social_account_id, platform, platform_post_id, platform_post_url,
      status, error_message, response_data, posted_at
    )
    VALUES (
      p_post_id, p_social_account_id, p_platform, p_provider_post_id, p_provider_post_url,
      p_status, p_error_message, p_response_data,
      CASE WHEN p_status = 'success' THEN now() ELSE NULL END
    )
    RETURNING * INTO v_row;
  END IF;

  -- ---- the parent roll-up, in the same statement -------------------------
  --
  -- Recomputed from the rows rather than incremented, because a publish can
  -- reach this function once per target and out of order.
  SELECT count(*),
         count(*) FILTER (WHERE status IN ('success', 'failed')),
         count(*) FILTER (WHERE status = 'success')
    INTO v_total, v_settled, v_succeeded
    FROM public.platform_posts WHERE post_id = v_row.post_id;

  IF v_settled = v_total THEN
    -- `completed` when anything succeeded: a two-target post where one
    -- platform worked is not a failed post, and per-target truth lives in
    -- platform_posts where D11 says it belongs.
    v_post_state := CASE WHEN v_succeeded > 0 THEN 'completed' ELSE 'failed' END;
    UPDATE public.posts
       SET status = v_post_state,
           posted_at = CASE WHEN v_post_state = 'completed'
                            THEN coalesce(posted_at, now()) ELSE posted_at END
     WHERE id = v_row.post_id;
  END IF;

  -- ---- the enqueue, in the same statement --------------------------------
  --
  -- D5(R1): a callback that fired "after the status is written" would recreate
  -- exactly the crash gap the outbox exists to close.
  SELECT * INTO v_post FROM public.posts WHERE id = v_row.post_id;

  -- platform_posts carries no workspace_id, and neither does posts. The
  -- account is the only tenancy anchor available, so a row with no account
  -- (the fallback insert at process-post:1630 permits it) cannot be attributed
  -- and is deliberately not emitted rather than being emitted to a guessed
  -- workspace -- a wrong guess is a cross-tenant delivery nothing downstream
  -- could detect.
  IF v_row.social_account_id IS NOT NULL THEN
    v_workspace := public.partner_workspace_of_account(v_row.social_account_id);
  END IF;

  IF v_workspace IS NOT NULL THEN
    v_event := CASE WHEN p_status = 'success' THEN 'post.published' ELSE 'post.failed' END;
    v_enqueued := public.partner_emit_webhook_event(
      v_workspace,
      v_event,
      -- The PLATFORM_POST row id, not the post id: one post fans out to many
      -- targets, and keying on the post would make the second target's
      -- transition collide with the first and be silently dropped -- the same
      -- collision the Phase 5 record documents for message.delivered/.read.
      v_event || ':' || v_row.id::text,
      jsonb_build_object(
        'post_id', v_row.post_id,
        'platform_post_id', v_row.id,
        'platform', v_row.platform,
        'account_id', v_row.social_account_id,
        'status', v_row.status,
        'provider_post_id', v_row.platform_post_id,
        'provider_post_url', v_row.platform_post_url,
        'error_message', v_row.error_message,
        'posted_at', v_row.posted_at,
        'post_status', coalesce(v_post_state, v_post.status)
      ),
      v_row.platform,
      v_row.social_account_id,
      coalesce(v_row.posted_at, now())
    );
  END IF;

  RETURN jsonb_build_object(
    'platform_post_id', v_row.id,
    'settled', true,
    'post_status', coalesce(v_post_state, v_post.status),
    'enqueued', v_enqueued
  );
END;
$$;

-- Same grant convention as every other partner producer: service-role only.
-- The publish path runs in an edge function; nothing user-facing calls this.
REVOKE ALL ON FUNCTION public.partner_settle_platform_post(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_settle_platform_post(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;
