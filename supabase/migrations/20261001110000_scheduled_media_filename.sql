-- Scheduled WhatsApp media_filename: the original name the customer sees.
--
-- WHY
-- The Schedule Message dialog can now attach a Library file or an upload, and
-- the stored cloudinary object name (postora_2026_ab12.pdf) is what WhatsApp
-- would otherwise show the customer. media_filename carries the original name
-- end to end: the dialog writes it, claim_whatsapp_scheduled_messages returns
-- it, and whatsapp-scheduled-sender sends it (sanitised) as the document
-- filename, falling back to the URL's last segment.
--
-- The claim function must be dropped and recreated because adding a column to
-- RETURNS TABLE is not possible in place. Every other column, the logic,
-- SECURITY DEFINER, the search_path and the service_role-only grants are
-- identical to 20260930100000 (returns scalar columns only, never a composite
-- row type).
--
-- Idempotent: the column uses IF NOT EXISTS, the CHECK is dropped before
-- re-adding, and the function is dropped before creating. Applying twice is
-- safe. No BEGIN/COMMIT of its own (the harness wraps the file).

ALTER TABLE public.whatsapp_scheduled_messages
  ADD COLUMN IF NOT EXISTS media_filename text;

ALTER TABLE public.whatsapp_scheduled_messages
  DROP CONSTRAINT IF EXISTS whatsapp_scheduled_messages_media_filename_check;

ALTER TABLE public.whatsapp_scheduled_messages
  ADD CONSTRAINT whatsapp_scheduled_messages_media_filename_check
  CHECK (char_length(media_filename) <= 240);

DROP FUNCTION IF EXISTS public.claim_whatsapp_scheduled_messages(int, interval);

CREATE FUNCTION public.claim_whatsapp_scheduled_messages(p_limit int, p_lease interval)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  social_account_id uuid,
  recipient_phone text,
  recipient_name text,
  message_text text,
  media_url text,
  media_type text,
  media_filename text,
  scheduled_at timestamptz,
  status text,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz,
  updated_at timestamptz,
  claimed_at timestamptz,
  claim_token uuid,
  attempts int,
  account_connection_mode text,
  account_platform_user_id text,
  account_access_token text,
  account_metadata jsonb,
  account_is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'claim_whatsapp_scheduled_messages: p_limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;
  IF p_lease IS NULL OR p_lease <= interval '0' THEN
    RAISE EXCEPTION 'claim_whatsapp_scheduled_messages: p_lease must be positive'
      USING ERRCODE = '22023';
  END IF;

  -- (a) Due pending rows whose account is missing, not platform 'whatsapp',
  -- or owned by a different user than the row fail closed, with one
  -- sanitized log row each (message id and reason only -- never phone or
  -- message text), so the sender never transmits from an account the row
  -- owner does not own.
  WITH refused AS (
    UPDATE public.whatsapp_scheduled_messages AS m
    SET status = 'failed',
        error_message = 'account_not_owned',
        updated_at = now()
    WHERE m.status = 'pending'
      AND m.scheduled_at <= now()
      AND NOT EXISTS (
        SELECT 1
        FROM public.social_accounts AS s
        WHERE s.id = m.social_account_id
          AND s.platform = 'whatsapp'
          AND s.user_id = m.user_id
      )
    RETURNING m.id, m.user_id
  )
  INSERT INTO public.system_logs
    (source, category, level, message, user_id, metadata)
  SELECT 'whatsapp-scheduled-sender',
         'system',
         'warn',
         'Scheduled message refused: account not owned',
         r.user_id,
         jsonb_build_object(
           'scheduled_message_id', r.id,
           'reason', 'account_not_owned'
         )
  FROM refused AS r;

  -- (b) Expired 'sending' rows are indeterminate: the provider may already
  -- have accepted the send, so fail them under a cleared token and never
  -- resend. (The target alias matters: the RETURNS TABLE out-params share
  -- these column names, and an unqualified reference would be ambiguous.)
  WITH indeterminate AS (
    UPDATE public.whatsapp_scheduled_messages AS m
    SET status = 'failed',
        error_message = 'indeterminate',
        claim_token = NULL,
        updated_at = now()
    WHERE m.status = 'sending'
      AND m.claimed_at < now() - p_lease
    RETURNING m.id, m.user_id
  )
  INSERT INTO public.system_logs
    (source, category, level, message, user_id, metadata)
  SELECT 'whatsapp-scheduled-sender', 'system', 'warn',
         'Scheduled send outcome unknown after lease expiry',
         i.user_id,
         jsonb_build_object('scheduled_message_id', i.id, 'reason', 'indeterminate')
  FROM indeterminate AS i;

  -- (c) Expired pre-send leases: attempts >= 3 exhaust, the rest go back to
  -- pending under a cleared lease for the next claim.
  WITH exhausted AS (
    UPDATE public.whatsapp_scheduled_messages AS m
    SET status = 'failed',
        error_message = 'attempts_exhausted',
        claim_token = NULL,
        updated_at = now()
    WHERE m.status = 'claimed'
      AND m.claimed_at < now() - p_lease
      AND m.attempts >= 3
    RETURNING m.id, m.user_id
  )
  INSERT INTO public.system_logs
    (source, category, level, message, user_id, metadata)
  SELECT 'whatsapp-scheduled-sender', 'system', 'warn',
         'Scheduled message failed after repeated expired claims',
         x.user_id,
         jsonb_build_object('scheduled_message_id', x.id, 'reason', 'attempts_exhausted')
  FROM exhausted AS x;

  UPDATE public.whatsapp_scheduled_messages AS m
  SET status = 'pending',
      claim_token = NULL,
      claimed_at = NULL,
      updated_at = now()
  WHERE m.status = 'claimed'
    AND m.claimed_at < now() - p_lease
    AND m.attempts < 3;

  -- (d) Claim due pending rows on owned whatsapp accounts, oldest first, at
  -- most p_limit. FOR UPDATE OF the message row only, SKIP LOCKED, lets
  -- overlapping workers split the queue instead of blocking on each other.
  RETURN QUERY
  UPDATE public.whatsapp_scheduled_messages AS m
  SET status = 'claimed',
      claimed_at = now(),
      claim_token = gen_random_uuid(),
      attempts = m.attempts + 1,
      updated_at = now()
  FROM public.social_accounts AS s
  WHERE s.id = m.social_account_id
    AND s.platform = 'whatsapp'
    AND s.user_id = m.user_id
    AND m.id IN (
      SELECT inner_m.id
      FROM public.whatsapp_scheduled_messages AS inner_m
      JOIN public.social_accounts AS inner_s
        ON inner_s.id = inner_m.social_account_id
      WHERE inner_m.status = 'pending'
        AND inner_m.scheduled_at <= now()
        AND inner_s.platform = 'whatsapp'
        AND inner_s.user_id = inner_m.user_id
      ORDER BY inner_m.scheduled_at, inner_m.id
      LIMIT p_limit
      FOR UPDATE OF inner_m SKIP LOCKED
    )
  RETURNING m.id,
            m.user_id,
            m.social_account_id,
            m.recipient_phone,
            m.recipient_name,
            m.message_text,
            m.media_url,
            m.media_type,
            m.media_filename,
            m.scheduled_at,
            m.status,
            m.sent_at,
            m.error_message,
            m.created_at,
            m.updated_at,
            m.claimed_at,
            m.claim_token,
            m.attempts,
            s.connection_mode::text,
            s.platform_user_id,
            s.access_token,
            s.account_metadata,
            s.is_active;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_whatsapp_scheduled_messages(int, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_scheduled_messages(int, interval)
  TO service_role;
