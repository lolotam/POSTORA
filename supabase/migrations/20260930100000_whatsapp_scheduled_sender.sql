-- Whatsapp scheduled sender: claim fence, client state guard, and cron.
--
-- WHY
-- whatsapp-scheduled-sender runs every minute from cron and must survive
-- overlapping runs and crashes without double-sending a WhatsApp message.
-- The fence: claim_whatsapp_scheduled_messages stamps a fresh claim_token on
-- every claim and bumps attempts, so overlapping workers split the queue via
-- SKIP LOCKED instead of blocking on each other. An expired 'sending' row is
-- indeterminate (the provider may already have accepted it), so the claim
-- fails it as 'indeterminate' and never resends it. An expired 'claimed'
-- lease below 3 attempts is released back to 'pending'; at 3 or more it
-- fails as 'attempts_exhausted'. A due 'pending' row that points at a
-- missing, non-whatsapp, or cross-user account fails closed as
-- 'account_not_owned' with one sanitized log row (ids and reason only --
-- never phone or message text).
--
-- Tenancy is structural (ARCHITECTURE.md sections 23-24): the Edge Function
-- runs under the service role, which bypasses RLS, so the claim function
-- stays SECURITY DEFINER with a controlled search_path and EXECUTE granted
-- to service_role only. End-user writes stay narrow: the RLS INSERT/UPDATE
-- policies additionally require an owned whatsapp account, and the client
-- guard trigger lets end users insert pending rows and cancel them -- every
-- other client-side state transition raises insufficient_privilege.
--
-- Idempotent: columns/indexes use IF NOT EXISTS, the FK and the status CHECK
-- are dropped before re-adding, policies/functions/triggers are dropped (or
-- created-or-replaced) before creating, and the cron job is scheduled only
-- when absent and never re-activated. Applying twice is safe. No BEGIN/COMMIT
-- of its own (the harness wraps the file).

-- ---------------------------------------------------------------------------
-- 0. Claim columns, ownership FK, and lookup indexes.
-- ---------------------------------------------------------------------------
ALTER TABLE public.whatsapp_scheduled_messages
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;

ALTER TABLE public.whatsapp_scheduled_messages
  DROP CONSTRAINT IF EXISTS whatsapp_scheduled_messages_social_account_id_fkey;

-- Rows whose account was deleted before this FK existed would abort ADD
-- CONSTRAINT. ON DELETE CASCADE is the rule from here on, so apply it to them.
DELETE FROM public.whatsapp_scheduled_messages AS m
WHERE NOT EXISTS (
  SELECT 1 FROM public.social_accounts AS s WHERE s.id = m.social_account_id
);

ALTER TABLE public.whatsapp_scheduled_messages
  ADD CONSTRAINT whatsapp_scheduled_messages_social_account_id_fkey
  FOREIGN KEY (social_account_id)
  REFERENCES public.social_accounts(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_whatsapp_scheduled_messages_social_account_id
  ON public.whatsapp_scheduled_messages(social_account_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_scheduled_sender_due
  ON public.whatsapp_scheduled_messages(scheduled_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- 1. Status CHECK: drop whatever status CHECK is present, then add the
--    canonical one. Re-running drops what the first run added and re-adds it
--    identically.
-- ---------------------------------------------------------------------------
DO $do_scheduled_sender_status_check$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.whatsapp_scheduled_messages') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint AS c
    WHERE c.conrelid = 'public.whatsapp_scheduled_messages'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.whatsapp_scheduled_messages DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  ALTER TABLE public.whatsapp_scheduled_messages
    ADD CONSTRAINT whatsapp_scheduled_messages_status_check
    CHECK (status IN ('pending', 'claimed', 'sending', 'sent', 'failed', 'cancelled', 'skipped'));
END $do_scheduled_sender_status_check$;

-- ---------------------------------------------------------------------------
-- 2. RLS: one policy per operation. Reads and deletes stay owner-scoped;
--    writes additionally require the row's account to be an owned whatsapp
--    account, so a client cannot point a scheduled message at another user's
--    number even when they own the row. (INSERT policies carry no USING
--    clause -- Postgres forbids it there.)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users manage own scheduled messages"
  ON public.whatsapp_scheduled_messages;

DROP POLICY IF EXISTS "whatsapp_scheduled_messages_select_own"
  ON public.whatsapp_scheduled_messages;
CREATE POLICY "whatsapp_scheduled_messages_select_own"
  ON public.whatsapp_scheduled_messages
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "whatsapp_scheduled_messages_delete_own"
  ON public.whatsapp_scheduled_messages;
CREATE POLICY "whatsapp_scheduled_messages_delete_own"
  ON public.whatsapp_scheduled_messages
  FOR DELETE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "whatsapp_scheduled_messages_insert_owned_account"
  ON public.whatsapp_scheduled_messages;
CREATE POLICY "whatsapp_scheduled_messages_insert_owned_account"
  ON public.whatsapp_scheduled_messages
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.social_accounts AS s
      WHERE s.id = whatsapp_scheduled_messages.social_account_id
        AND s.user_id = auth.uid()
        AND s.platform = 'whatsapp'
    )
  );

DROP POLICY IF EXISTS "whatsapp_scheduled_messages_update_owned_account"
  ON public.whatsapp_scheduled_messages;
CREATE POLICY "whatsapp_scheduled_messages_update_owned_account"
  ON public.whatsapp_scheduled_messages
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.social_accounts AS s
      WHERE s.id = whatsapp_scheduled_messages.social_account_id
        AND s.user_id = auth.uid()
        AND s.platform = 'whatsapp'
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Client state guard: end users may insert a fresh pending row and may
--    move a pending row to cancelled (or keep it pending); every other
--    client-side write -- sending, claiming, retrying, backdating sent_at --
--    raises insufficient_privilege. The check keys on current_user, so the
--    service role and SECURITY DEFINER callers pass straight through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_scheduled_messages_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- current_user, not auth.role(): inside a SECURITY DEFINER function (the
  -- account merge repoints social_account_id on rows in any status) the JWT
  -- role is still 'authenticated', but current_user is the function owner.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
      OR NEW.claimed_at IS NOT NULL
      OR NEW.claim_token IS NOT NULL
      OR NEW.attempts IS DISTINCT FROM 0
      OR NEW.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'whatsapp_scheduled_messages: clients may only insert fresh pending rows'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM 'pending'
    OR NEW.status NOT IN ('pending', 'cancelled')
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.attempts IS DISTINCT FROM OLD.attempts
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'whatsapp_scheduled_messages: clients may only cancel pending rows'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.whatsapp_scheduled_messages_client_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_scheduled_messages_client_guard()
  TO service_role;

DROP TRIGGER IF EXISTS whatsapp_scheduled_messages_client_guard
  ON public.whatsapp_scheduled_messages;

CREATE TRIGGER whatsapp_scheduled_messages_client_guard
  BEFORE INSERT OR UPDATE ON public.whatsapp_scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_scheduled_messages_client_guard();

-- ---------------------------------------------------------------------------
-- 4. claim_whatsapp_scheduled_messages: fence (a) refuse unowned accounts,
--    (b) fail indeterminate sends, (c) exhaust or release expired leases,
--    (d) claim due owned rows. p_lease is the claim lease (worker uses
--    2 minutes). The RETURNS TABLE lists scalar columns only -- never a
--    composite row type.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_whatsapp_scheduled_messages(p_limit int, p_lease interval)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  social_account_id uuid,
  recipient_phone text,
  recipient_name text,
  message_text text,
  media_url text,
  media_type text,
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

-- ---------------------------------------------------------------------------
-- 5. Cron: whatsapp-scheduled-sender every minute. Scheduled only when
--    pg_cron is present AND the job is absent -- a re-run never duplicates
--    or re-activates it -- and set inactive immediately: the job is
--    activated by hand after deploy verification.
-- ---------------------------------------------------------------------------
DO $do_cron_sender$
DECLARE
  v_jobid bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    AND to_regprocedure('public.get_cron_secret()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-scheduled-sender') THEN
      SELECT cron.schedule(
        'whatsapp-scheduled-sender',
        '* * * * *',
        $$
        SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/whatsapp-scheduled-sender', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
        $$
      ) INTO v_jobid;
      PERFORM cron.alter_job(job_id := v_jobid, active := false);
    END IF;
  END IF;
END $do_cron_sender$;
