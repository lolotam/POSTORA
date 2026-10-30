-- Deferred publishing for slow Meta containers, and a sweeper for stranded posts.
--
-- Design: docs/superpowers/specs/2026-10-29-hardening-followups-design.md, Part B2.
--
-- WHY
-- An Instagram reel or a Threads video can take Meta longer to process than an
-- edge worker lives (60 s). process-post used to wait for it inline; when the
-- worker was killed mid-wait, no platform_posts row was written and the post
-- stayed `processing` forever (handasa10, 2026-10-29). process-post now stops
-- waiting while it still has time, records a `pending` row carrying
-- response_data.deferred, and the reconcile-deferred-publishes cron finishes it.
--
-- This migration adds:
--   * posts.processing_started_at, set by the claim, so a stranded post can be
--     told apart from one edited a minute ago;
--   * claim_deferred_publishes(), which leases due deferred rows to one
--     reconciler run (SKIP LOCKED, so two runs never take the same row);
--   * sweep_stale_processing_posts(), which settles posts stuck in
--     `processing` with no pending row;
--   * the cron job.
--
-- Additive and idempotent. No BEGIN/COMMIT of its own.

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

COMMENT ON COLUMN public.posts.processing_started_at IS
  'When process-post last claimed the post. Read by sweep_stale_processing_posts().';

CREATE INDEX IF NOT EXISTS platform_posts_pending_created_at_idx
  ON public.platform_posts (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS posts_processing_started_at_idx
  ON public.posts (processing_started_at)
  WHERE status = 'processing';

-- Leases up to p_limit due deferred rows for p_lease. A run that dies keeps the
-- row only until the lease ends; the next run takes it again.
CREATE OR REPLACE FUNCTION public.claim_deferred_publishes(
  p_limit integer DEFAULT 10,
  p_lease interval DEFAULT interval '3 minutes'
)
RETURNS TABLE (platform_post_id uuid, post_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH due AS (
    SELECT pp.id
      FROM public.platform_posts pp
     WHERE pp.status = 'pending'
       AND pp.response_data ? 'deferred'
       AND coalesce((pp.response_data #>> '{deferred,next_check_at}')::timestamptz, '-infinity') <= now()
       AND coalesce((pp.response_data #>> '{deferred,claimed_until}')::timestamptz, '-infinity') <= now()
     ORDER BY pp.created_at
     LIMIT greatest(p_limit, 0)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.platform_posts pp
     SET response_data = jsonb_set(pp.response_data, '{deferred,claimed_until}', to_jsonb(now() + p_lease))
    FROM due
   WHERE pp.id = due.id
  RETURNING pp.id, pp.post_id;
$$;

-- Settles posts left in `processing` for longer than p_older_than with no
-- pending row: every selected account without a row gets a failed row through
-- the settle RPC (which emits post.failed), then the post is rolled up the
-- way the RPC rolls it up. A post with a pending row is still being finished
-- by someone (TikTok's poller, the reconciler) and is left alone.
CREATE OR REPLACE FUNCTION public.sweep_stale_processing_posts(
  p_older_than interval DEFAULT interval '20 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post      record;
  v_account   record;
  v_posts     integer := 0;
  v_rows      integer := 0;
  v_succeeded integer;
  v_message   constant text := 'Publishing was interrupted before it finished. Safe to retry.';
BEGIN
  FOR v_post IN
    SELECT p.id, p.user_id, p.metadata
      FROM public.posts p
     WHERE p.status = 'processing'
       AND p.processing_started_at < now() - p_older_than
       AND NOT EXISTS (
         SELECT 1 FROM public.platform_posts pp
          WHERE pp.post_id = p.id AND pp.status = 'pending'
       )
     ORDER BY p.processing_started_at
     LIMIT 50
     FOR UPDATE SKIP LOCKED
  LOOP
    v_posts := v_posts + 1;

    FOR v_account IN
      SELECT a.id, a.platform
        FROM public.social_accounts a
       WHERE jsonb_typeof(v_post.metadata -> 'selected_account_ids') = 'array'
         AND a.id::text IN (SELECT jsonb_array_elements_text(v_post.metadata -> 'selected_account_ids'))
         AND a.user_id = v_post.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.platform_posts pp
            WHERE pp.post_id = v_post.id AND pp.social_account_id = a.id
         )
    LOOP
      PERFORM public.partner_settle_platform_post(
        NULL, v_post.id, v_account.id, v_account.platform, 'failed',
        NULL, NULL, v_message, jsonb_build_object('swept_at', now())
      );
      v_rows := v_rows + 1;
    END LOOP;

    SELECT count(*) FILTER (WHERE status = 'success')
      INTO v_succeeded
      FROM public.platform_posts WHERE post_id = v_post.id;

    UPDATE public.posts
       SET status    = CASE WHEN v_succeeded > 0 THEN 'completed' ELSE 'failed' END,
           posted_at = CASE WHEN v_succeeded > 0 THEN coalesce(posted_at, now()) ELSE posted_at END
     WHERE id = v_post.id AND status = 'processing';
  END LOOP;

  RETURN jsonb_build_object('posts', v_posts, 'rows_failed', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_deferred_publishes(integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_deferred_publishes(integer, interval) TO service_role;
REVOKE ALL ON FUNCTION public.sweep_stale_processing_posts(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stale_processing_posts(interval) TO service_role;

-- Every minute: Meta suggests checking a container about once a minute.
DO $do_reconcile_deferred$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'reconcile-deferred-publishes cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-deferred-publishes') THEN
    PERFORM cron.schedule(
      'reconcile-deferred-publishes',
      '* * * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/reconcile-deferred-publishes', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      $$
    );
  END IF;
END $do_reconcile_deferred$;
