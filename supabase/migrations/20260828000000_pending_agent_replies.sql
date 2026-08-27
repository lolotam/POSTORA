-- Durable outbox for AI agent replies.
--
-- When an inbound message triggers the agent, the webhook runs media understanding,
-- generation and delivery inside runInBackground -- ~50s of best-effort work against a 60s
-- worker ceiling. A worker killed anywhere in that window (timeout, crash, redeploy) drops
-- the customer's message and nothing records why. ARCHITECTURE.md 27: "Long-running or
-- retry-critical workflows must persist state so they can resume/reconcile after process
-- termination."
--
-- The design is TWO-STAGE, and the reason is that re-running the agent repeats more than
-- the reply: tool calls, escalation, human assignment and admin notification all fire
-- before the send. So the webhook records the inbound work item (a pre-generation death is
-- recoverable), and ai-agent-reply persists the generated reply before sending (a
-- post-generation death is re-DELIVERED, never re-generated).
--
--   pending -> running -> ready_to_send -> sending -> sent
--
-- Every transition that precedes an external side effect is confirmed and fail-closed
-- (advance_agent_reply). Recovery is then a function of the state a lapsed lease was found
-- in, and nothing else:
--
--   pending        nothing external has happened     -> re-run the agent
--   running        a tool MAY have fired; unknowable  -> hand to a human, never re-run
--   ready_to_send  text exists, no delivery attempted -> deliver the stored text
--   sending        an attempt was in flight           -> delivery_unknown, never re-send
--
-- Design: docs/superpowers/plans/2026-08-27-durable-reply-outbox.md

CREATE TABLE IF NOT EXISTS public.pending_agent_replies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  social_account_id UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  -- Derived inside enqueue_agent_reply from social_accounts, never taken from the caller:
  -- a webhook passing the wrong user_id would attribute a reply to the wrong tenant.
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  message_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  recipient_id      TEXT NOT NULL,

  -- What the customer sent. inbound_text is the placeholder as it stood at enqueue time;
  -- the media_* columns are what recovery needs to redo the understanding the original
  -- attempt may not have finished.
  inbound_text      TEXT NOT NULL,
  media_url         TEXT,
  media_kind        TEXT,
  media_caption     TEXT,
  unread_attachments INTEGER NOT NULL DEFAULT 0,
  language_hint     TEXT,
  comment_id        TEXT,
  -- Populated ONLY when the platform states an expiry we can read; NULL means "unknown",
  -- not "never expires". Meta's messaging attachment URLs are signed and do expire, but the
  -- webhook payload carries no expiry and the signature is opaque, so for FB/IG this stays
  -- NULL. Recovery ATTEMPTS the fetch, and an expiry-shaped refusal from the CDN is what
  -- degrades the attempt to the placeholder.
  media_expires_at  TIMESTAMPTZ,

  -- Ordering within a conversation, so two queued messages are never answered backwards.
  inbound_at        TIMESTAMPTZ NOT NULL,

  -- Persisted by ai-agent-reply BEFORE it sends. Its presence is what makes a row
  -- re-deliverable without re-running the agent.
  generated_reply   TEXT,

  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','ready_to_send','sending','sent',
                                      'delivery_unknown','failed','cancelled')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  -- The lease. A claimed row is invisible to other workers until this passes, which is the
  -- guarantee SKIP LOCKED does NOT give once the claiming transaction commits.
  lease_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at        TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  error             TEXT,
  CONSTRAINT pending_agent_replies_dedup UNIQUE (social_account_id, message_id)
);

ALTER TABLE public.pending_agent_replies ENABLE ROW LEVEL SECURITY;
-- Deny-all. Written only by webhooks and the recovery job, both service-role. The
-- user-facing record of a reply stays ai_agent_logs, which has its own RLS.

-- The claim query: unfinished rows whose lease has lapsed, oldest inbound first.
CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_claimable
  ON public.pending_agent_replies (lease_expires_at NULLS FIRST, inbound_at)
  WHERE status IN ('pending','running','ready_to_send','sending');

CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_account
  ON public.pending_agent_replies (social_account_id);

CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_user
  ON public.pending_agent_replies (user_id);

-- Serves both the ordering check and the retention purge.
CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_conversation
  ON public.pending_agent_replies (conversation_id, inbound_at);

/**
 * Enqueues an inbound work item and reports whether THIS caller created it.
 *
 * newly_enqueued=false means another invocation already owns the work -- a webhook
 * redelivery, or the same message racing itself. That caller must NOT start processing;
 * the owner is either still running or the recovery job will take it.
 *
 * user_id is read from social_accounts rather than accepted as an argument, so a caller
 * cannot attribute a reply to the wrong tenant.
 */
CREATE OR REPLACE FUNCTION public.enqueue_agent_reply(
  p_social_account_id UUID,
  p_platform TEXT,
  p_message_id TEXT,
  p_conversation_id TEXT,
  p_recipient_id TEXT,
  p_inbound_text TEXT,
  p_inbound_at TIMESTAMPTZ,
  p_media JSONB DEFAULT '{}'::jsonb,
  p_language_hint TEXT DEFAULT NULL,
  p_comment_id TEXT DEFAULT NULL,
  p_lease_seconds INTEGER DEFAULT 180
)
RETURNS TABLE (id UUID, newly_enqueued BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_id UUID;
BEGIN
  IF p_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'enqueue_agent_reply requires a positive lease';
  END IF;

  SELECT sa.user_id INTO v_user_id
    FROM public.social_accounts sa WHERE sa.id = p_social_account_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unknown social account %', p_social_account_id;
  END IF;

  INSERT INTO public.pending_agent_replies (
    social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, media_url, media_kind, media_caption, unread_attachments,
    media_expires_at, language_hint, comment_id, lease_expires_at
  ) VALUES (
    p_social_account_id, v_user_id, p_platform, p_message_id, p_conversation_id,
    p_recipient_id, p_inbound_text, p_inbound_at,
    p_media->>'url', p_media->>'kind', p_media->>'caption',
    COALESCE((p_media->>'unread')::int, 0),
    (p_media->>'expires_at')::timestamptz, p_language_hint, p_comment_id,
    -- The enqueuing invocation IS the first owner, so it takes the lease here.
    --
    -- Leaving this NULL would make a brand-new row immediately claimable, and the webhook
    -- never calls claim_agent_replies -- it enqueues and then processes inline. A cron tick
    -- landing inside that ~50s window would claim the row and re-run the agent CONCURRENTLY
    -- with the invocation still working on it. 180s exceeds the 60s worker ceiling, so the
    -- lease outlives any living owner; a row whose owner died early becomes claimable when
    -- it lapses.
    now() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT ON CONSTRAINT pending_agent_replies_dedup DO NOTHING
  RETURNING pending_agent_replies.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, TRUE;
  ELSE
    RETURN QUERY
      SELECT p.id, FALSE FROM public.pending_agent_replies p
       WHERE p.social_account_id = p_social_account_id AND p.message_id = p_message_id;
  END IF;
END;
$$;

/**
 * Claims work by taking a LEASE on it.
 *
 * Eligibility is "the lease has lapsed", not "the row is old". A predicate on created_at is
 * satisfied by a freshly claimed row immediately, so SKIP LOCKED would buy nothing once the
 * claiming transaction committed and two cron runs could execute the same row side by side.
 *
 * The status is deliberately NOT overwritten: a ready_to_send row must stay ready_to_send,
 * or the recovery job loses the very fact that tells it "re-deliver, do not re-run".
 *
 * Rows are ordered by inbound_at so a conversation's messages are recovered in the order
 * the customer sent them.
 */
CREATE OR REPLACE FUNCTION public.claim_agent_replies(
  p_limit INTEGER,
  p_lease_seconds INTEGER,
  p_max_attempts INTEGER
)
RETURNS SETOF public.pending_agent_replies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_limit <= 0 OR p_lease_seconds <= 0 OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'claim_agent_replies requires positive parameters';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT p.id FROM public.pending_agent_replies p
     WHERE p.status IN ('pending','running','ready_to_send','sending')
       AND p.attempts < p_max_attempts
       AND (p.lease_expires_at IS NULL OR p.lease_expires_at < now())
     ORDER BY p.inbound_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.pending_agent_replies p
     SET attempts         = p.attempts + 1,
         claimed_at       = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    FROM claimed
   WHERE p.id = claimed.id
  RETURNING p.*;
END;
$$;

/**
 * Moves exhausted work to a terminal state, and RETURNS THE ROWS so the caller can make
 * them visible.
 *
 * Without this a row at max attempts is never selected again -- alive in the table,
 * invisible to the job, invisible to the operator. And returning a bare count is not
 * enough: this table has deny-all RLS and no UI, so a "terminal, needs a human" state that
 * only exists here is not observable by any human. The caller writes an ai_agent_logs row
 * for each returned id, which is the surface the customer's owner already reads.
 *
 * Which terminal state depends on how far the row got, because that is what decides whether
 * a customer may already have received something:
 *   pending       -> failed            nothing external happened
 *   running       -> delivery_unknown  a tool or escalation may have fired
 *   ready_to_send -> failed            text exists but no delivery was attempted
 *   sending       -> delivery_unknown  an attempt was in flight
 */
CREATE OR REPLACE FUNCTION public.reap_exhausted_agent_replies(p_max_attempts INTEGER)
RETURNS SETOF public.pending_agent_replies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'reap_exhausted_agent_replies requires a positive limit';
  END IF;

  RETURN QUERY
  UPDATE public.pending_agent_replies
     SET status = CASE WHEN status IN ('running','sending') THEN 'delivery_unknown'
                       ELSE 'failed' END,
         error  = COALESCE(error, 'attempts exhausted'),
         lease_expires_at = NULL
   WHERE status IN ('pending','running','ready_to_send','sending')
     AND attempts >= p_max_attempts
     AND (lease_expires_at IS NULL OR lease_expires_at < now())
  RETURNING *;
END;
$$;

/**
 * Moves a row from one state to the next, or refuses.
 *
 * The WHERE clause names the state the caller believes the row is in, so two workers cannot
 * both believe they own it. A caller that gets FALSE must NOT proceed -- that is the whole
 * contract, and it is why this returns BOOLEAN rather than being a fire-and-forget update.
 * Every transition that precedes an external side effect goes through here.
 */
CREATE OR REPLACE FUNCTION public.advance_agent_reply(
  p_id UUID,
  p_from TEXT,
  p_to TEXT,
  p_generated_reply TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.pending_agent_replies
     SET status          = p_to,
         generated_reply = COALESCE(p_generated_reply, generated_reply),
         error           = COALESCE(p_error, error),
         sent_at         = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
         -- A terminal row holds no lease; leaving one would keep it in the claimable index
         -- for no reason.
         lease_expires_at = CASE WHEN p_to IN ('sent','delivery_unknown','failed','cancelled')
                                 THEN NULL ELSE lease_expires_at END
   WHERE id = p_id AND status = p_from;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_agent_reply(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_agent_reply(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, TEXT, TEXT, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_agent_replies(INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_agent_replies(INTEGER, INTEGER, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.reap_exhausted_agent_replies(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_exhausted_agent_replies(INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.advance_agent_reply(UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_agent_reply(UUID, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

-- ai-agent-reply stamps every log row with the outbox id it was working for, so a replay
-- can be told apart from a fresh reply in the Logs tab. Non-unique on purpose: a log
-- constraint is NOT send idempotency (the send happens before the log is written), and the
-- durable `sending` state above is what carries that guarantee.
ALTER TABLE public.ai_agent_logs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_agent_logs_idempotency_key
  ON public.ai_agent_logs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Retention. Two windows deliberately: a settled row is transient bookkeeping, but a failed
-- or delivery_unknown row is the evidence for a customer complaint and must outlive it.
-- These rows carry customer message text, which is the other reason they do not live
-- forever. Same unschedule-then-schedule shape as 20260823090000.
DO $$
BEGIN
  PERFORM cron.unschedule('purge-pending-agent-replies');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-pending-agent-replies',
  '23 4 * * *',
  $$
  DELETE FROM public.pending_agent_replies
   WHERE status IN ('sent','cancelled') AND created_at < now() - interval '14 days';
  DELETE FROM public.pending_agent_replies
   WHERE status IN ('failed','delivery_unknown') AND created_at < now() - interval '90 days';
  $$
);

-- Recovery. Every two minutes: claim lapsed work one row at a time and re-drive it through
-- ai-agent-reply. Its own schedule rather than a piggyback on process-scheduled-posts, whose
-- cadence is chosen for publishing -- coupling the two means one job's slow run silently
-- delays the other's.
DO $$
BEGIN
  PERFORM cron.unschedule('process-pending-agent-replies');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'process-pending-agent-replies',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/process-pending-replies',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_cron_secret()
    ),
    body := '{}'::jsonb
  );
  $$
);
