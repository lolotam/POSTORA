-- WhatsApp disconnect alerts (spec 2026-11-13-whatsapp-disconnect-alerts-design.md).
--
-- One disconnection episode per Evolution QR account. The episode lives in
-- social_accounts.account_metadata, so there is no new table, no new RLS surface and no
-- regenerated database types: account_metadata is already Json in types.ts.
--
-- Keys on social_accounts.account_metadata:
--   whatsapp_disconnect                = {since, first_seen, state, observed_at}
--   whatsapp_disconnect_user_email_at  = the owner email for this episode has been sent
--   whatsapp_disconnect_admin_email_at = the admin email for this episode has been sent
--   whatsapp_disconnect_claimed_at      = the in-flight claims, one per recipient
--                                          ({user: <timestamp>, admin: <timestamp>}), each with a
--                                          30 minute stale window
--   whatsapp_user_disconnected_at       = the owner disconnected this account on purpose

-- 1. Poll freshness for the watch function's round robin.
--    whatsapp_evolution_instances is absent from src/integrations/supabase/types.ts (its RLS
--    revokes anon and authenticated), so this column needs no type regeneration.
ALTER TABLE public.whatsapp_evolution_instances
  ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;

CREATE INDEX IF NOT EXISTS whatsapp_evolution_instances_last_polled_at_idx
  ON public.whatsapp_evolution_instances (last_polled_at)
  WHERE last_polled_at IS NOT NULL;

-- 2. Observe one Evolution connection state.
--    terminal = true  : the session is gone. Opens the episode, or keeps since/first_seen.
--    terminal = false : the session is reconnecting. Restarts the streak (since), keeps the
--                       episode and first_seen, and never opens an episode.
--    Returns the resulting episode, or NULL when there is nothing to record.
CREATE OR REPLACE FUNCTION public.observe_whatsapp_disconnect_state(
  p_account_id uuid,
  p_state text,
  p_terminal boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_meta jsonb;
  v_episode jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT COALESCE(account_metadata, '{}'::jsonb) INTO v_meta
    FROM public.social_accounts
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT p_terminal THEN
    -- A transient observation only restarts an episode that is already open. It never opens
    -- one: an account that is merely reconnecting is not an outage.
    IF NOT (v_meta ? 'whatsapp_disconnect') THEN
      RETURN NULL;
    END IF;
    v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb)
      || jsonb_build_object('since', v_now, 'state', p_state, 'observed_at', v_now);
  ELSIF NOT (v_meta ? 'whatsapp_disconnect') THEN
    v_episode := jsonb_build_object(
      'since', v_now, 'first_seen', v_now, 'state', p_state, 'observed_at', v_now);
  ELSE
    -- A terminal observation keeps since and first_seen: the streak anchor and the episode
    -- anchor must not move once they are set.
    v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb)
      || jsonb_build_object('state', p_state, 'observed_at', v_now);
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb), '{whatsapp_disconnect}', v_episode)
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN v_episode;
END;
$fn$;
REVOKE ALL ON FUNCTION public.observe_whatsapp_disconnect_state(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_whatsapp_disconnect_state(uuid, text, boolean) TO service_role;

-- 3. Reserve the alert for one recipient before sending it, so two overlapping runs cannot
--    both send. A claim older than 30 minutes is treated as a failed send and may be retaken.
--    The owner and the admins hold SEPARATE claims: the owner email and the admin email are
--    independent, so a failing owner send never costs the admin its alert and the admin
--    claim never blocks the owner's. The claim marker is therefore a map keyed by recipient.
CREATE OR REPLACE FUNCTION public.claim_whatsapp_disconnect_email(
  p_account_id uuid,
  p_kind text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_meta jsonb;
  v_claimed jsonb;
  v_marker text;
BEGIN
  v_marker := CASE p_kind
    WHEN 'user'  THEN 'whatsapp_disconnect_user_email_at'
    WHEN 'admin' THEN 'whatsapp_disconnect_admin_email_at'
    ELSE NULL
  END;
  IF v_marker IS NULL THEN
    RAISE EXCEPTION 'unknown whatsapp disconnect alert kind: %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The row lock makes the claim atomic: the check below and the write that follows see
  -- one state of the row, so two overlapping runs cannot both win the same recipient.
  SELECT COALESCE(account_metadata, '{}'::jsonb) INTO v_meta
    FROM public.social_accounts
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- A claim needs an open episode, and a recipient that has already been emailed for this
  -- episode is never emailed twice.
  IF NOT (v_meta ? 'whatsapp_disconnect') THEN
    RETURN FALSE;
  END IF;
  IF (v_meta ? v_marker) THEN
    RETURN FALSE;
  END IF;

  v_claimed := COALESCE(v_meta->'whatsapp_disconnect_claimed_at', '{}'::jsonb);

  -- This recipient's own live claim blocks it. A stale one (30 minutes) is a failed send
  -- and may be retaken. An unreadable timestamp is treated as stale.
  IF (v_claimed ? p_kind)
     AND (v_claimed->>p_kind) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} '
     AND (v_claimed->>p_kind)::timestamptz >= clock_timestamp() - interval '30 minutes' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect_claimed_at}',
           jsonb_set(v_claimed, ARRAY[p_kind], to_jsonb(clock_timestamp()::text)))
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.claim_whatsapp_disconnect_email(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_disconnect_email(uuid, text) TO service_role;

-- 4. Record that a recipient's email went out for this episode.
CREATE OR REPLACE FUNCTION public.mark_whatsapp_disconnect_emailed(
  p_account_id uuid,
  p_kind text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_marker text;
BEGIN
  v_marker := CASE p_kind
    WHEN 'user'  THEN 'whatsapp_disconnect_user_email_at'
    WHEN 'admin' THEN 'whatsapp_disconnect_admin_email_at'
    ELSE NULL
  END;
  IF v_marker IS NULL THEN
    RAISE EXCEPTION 'unknown whatsapp disconnect alert kind: %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           ARRAY['whatsapp_disconnect_' || p_kind || '_email_at'],
           to_jsonb(clock_timestamp()::text))
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_whatsapp_disconnect_emailed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_disconnect_emailed(uuid, text) TO service_role;

-- 5. Close the episode: the account is healthy again, or it has been reconnected. The red
--    flag goes with it. Only evolution_qr rows are touched: on every other platform
--    needs_reauth and last_refresh_error belong to the token-refresh path.
CREATE OR REPLACE FUNCTION public.clear_whatsapp_disconnect_episode(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = COALESCE(account_metadata, '{}'::jsonb)
                             - 'whatsapp_disconnect'
                             - 'whatsapp_disconnect_claimed_at'
                             - 'whatsapp_disconnect_user_email_at'
                             - 'whatsapp_disconnect_admin_email_at'
                             - 'whatsapp_user_disconnected_at',
         needs_reauth = false,
         last_refresh_error = NULL
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect_user_email_at'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect_admin_email_at'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_user_disconnected_at'
          OR needs_reauth = true
          OR last_refresh_error IS NOT NULL);

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.clear_whatsapp_disconnect_episode(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_whatsapp_disconnect_episode(uuid) TO service_role;

-- 6. The owner disconnected this account on purpose. The watch function skips any account
--    carrying this marker: a deliberate disconnect is not an outage.
CREATE OR REPLACE FUNCTION public.mark_whatsapp_user_disconnected(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_user_disconnected_at}',
           to_jsonb(clock_timestamp()::text))
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_whatsapp_user_disconnected(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_user_disconnected(uuid) TO service_role;

-- 7. Every five minutes: poll Evolution for the state of every paired WhatsApp QR account and
--    alert the ones that have been gone long enough. The minutes are offset from the top of the
--    hour so this run does not land on */5 with the other jobs. The cron secret is resolved at
--    run time through public.get_cron_secret(); no credential is stored in this file.
DO $do_cron_whatsapp_disconnect_watch$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'whatsapp-disconnect-watch cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch') THEN
    PERFORM cron.schedule(
      'whatsapp-disconnect-watch',
      '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/whatsapp-disconnect-watch', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      $$
    );
  END IF;
END $do_cron_whatsapp_disconnect_watch$;
