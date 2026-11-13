-- WhatsApp disconnect alerts (spec 2026-11-13-whatsapp-disconnect-alerts-design.md).
--
-- One disconnection episode per Evolution QR account. The episode lives in
-- social_accounts.account_metadata, so there is no new table, no new RLS surface and no
-- regenerated database types: account_metadata is already Json in types.ts.
--
-- Keys on social_accounts.account_metadata:
--   whatsapp_disconnect                = {episode_id, since, first_seen, state, observed_at}
--                                          episode_id identifies THIS episode: the claim returns it
--                                          and the mark only writes when the open episode still
--                                          carries it, so a marker can never outlive its episode
--   whatsapp_disconnect_user_email_at  = the owner email for this episode has been sent
--   whatsapp_disconnect_admin_email_at = the admin email for this episode has been sent
--   whatsapp_disconnect_claimed_at      = the in-flight claims, one per recipient
--                                          ({user: <timestamp>, admin: <timestamp>}), each with a
--                                          30 minute stale window
--   whatsapp_user_disconnected_at       = the owner disconnected this account on purpose
--
-- needs_reauth on an evolution_qr row belongs to this feature: the token-refresh sweep never
-- selects those rows (no token_expires_at, auth_provider = 'native'), so the two never collide.
-- If Evolution QR accounts are ever given a refresh token, that assumption breaks and the
-- token-refresh path starts owning needs_reauth on these rows too.
--
-- Deployment note: the cron job calls the watcher through public.get_cron_functions_base_url(),
-- so this database needs one of those configured before the watcher runs: the database setting
-- "app.settings.supabase_url", an app_settings row with key functions_base_url, or the vault
-- secret functions_base_url. Without one the migration raises a warning and the scheduled job
-- skips its call (and says so in the log) until a base URL is configured.

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
--
--    A deliberate disconnect (whatsapp_user_disconnected_at) is never an outage: the marker is
--    checked under the row lock, so a disconnect that lands while this observation is in flight
--    wins and no episode is opened.
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

  IF (v_meta ? 'whatsapp_user_disconnected_at') THEN
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
      'episode_id', gen_random_uuid()::text,
      'since', v_now, 'first_seen', v_now, 'state', p_state, 'observed_at', v_now);
  ELSE
    -- A terminal observation keeps since and first_seen: the streak anchor and the episode
    -- anchor must not move once they are set. The episode_id stays too: it is the identity the
    -- claim returns and the mark checks.
    v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb)
      || jsonb_build_object('state', p_state, 'observed_at', v_now);
    IF NOT (v_episode ? 'episode_id') THEN
      v_episode := v_episode || jsonb_build_object('episode_id', gen_random_uuid()::text);
    END IF;
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
--    Returns the episode_id of the claimed episode, or NULL when the claim was refused. The
--    caller carries that id into mark_whatsapp_disconnect_emailed and into the email
--    provider's idempotency key, so a retry of the same episode resolves to the same send.
CREATE OR REPLACE FUNCTION public.claim_whatsapp_disconnect_email(
  p_account_id uuid,
  p_kind text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_meta jsonb;
  v_claimed jsonb;
  v_marker text;
  v_episode jsonb;
  v_episode_id uuid;
  v_claimed_at timestamptz;
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
    RETURN NULL;
  END IF;

  -- A deliberate disconnect is not an outage. Re-checked under the row lock because the
  -- marker can be written between the watcher listing the account and this claim: without
  -- this the owner would get a "reconnect" email for the disconnect they asked for.
  IF (v_meta ? 'whatsapp_user_disconnected_at') THEN
    RETURN NULL;
  END IF;

  -- A claim needs an open episode, and a recipient that has already been emailed for this
  -- episode is never emailed twice.
  IF NOT (v_meta ? 'whatsapp_disconnect') THEN
    RETURN NULL;
  END IF;
  IF (v_meta ? v_marker) THEN
    RETURN NULL;
  END IF;

  v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb);
  BEGIN
    v_episode_id := (v_episode->>'episode_id')::uuid;
  EXCEPTION WHEN others THEN
    -- An episode without a usable id cannot be claimed: the mark and the provider's
    -- idempotency key both need it.
    v_episode_id := NULL;
  END;
  IF v_episode_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_claimed := COALESCE(v_meta->'whatsapp_disconnect_claimed_at', '{}'::jsonb);

  -- This recipient's own live claim blocks it. A stale one (30 minutes) is a failed send
  -- and may be retaken. An unreadable timestamp is treated as stale, and never aborts the
  -- claim: a malformed value must not silence every future alert for this account.
  v_claimed_at := NULL;
  BEGIN
    v_claimed_at := (v_claimed->>p_kind)::timestamptz;
  EXCEPTION WHEN others THEN
    v_claimed_at := NULL;
  END;
  IF v_claimed_at IS NOT NULL
     AND v_claimed_at >= clock_timestamp() - interval '30 minutes' THEN
    RETURN NULL;
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect_claimed_at}',
           jsonb_set(v_claimed, ARRAY[p_kind], to_jsonb(clock_timestamp()::text)))
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN v_episode_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.claim_whatsapp_disconnect_email(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_disconnect_email(uuid, text) TO service_role;

-- 4. Record that a recipient's email went out for this episode.
--    The mark is bound to the episode the claim returned. A mark that arrives after the
--    episode was closed, or after a later episode opened, writes nothing: a marker that
--    outlives its episode would silence the next outage for that recipient.
CREATE OR REPLACE FUNCTION public.mark_whatsapp_disconnect_emailed(
  p_account_id uuid,
  p_kind text,
  p_episode_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_marker text;
  v_meta jsonb;
  v_episode jsonb;
  v_episode_id uuid;
  v_claimed jsonb;
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

  IF p_episode_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT COALESCE(account_metadata, '{}'::jsonb) INTO v_meta
    FROM public.social_accounts
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb);
  BEGIN
    v_episode_id := (v_episode->>'episode_id')::uuid;
  EXCEPTION WHEN others THEN
    v_episode_id := NULL;
  END;
  IF v_episode_id IS DISTINCT FROM p_episode_id THEN
    RETURN FALSE;
  END IF;

  -- The mark closes a claim: the recipient must actually hold one.
  v_claimed := COALESCE(v_meta->'whatsapp_disconnect_claimed_at', '{}'::jsonb);
  IF NOT (v_claimed ? p_kind) THEN
    RETURN FALSE;
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
REVOKE ALL ON FUNCTION public.mark_whatsapp_disconnect_emailed(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_disconnect_emailed(uuid, text, uuid) TO service_role;

-- 5. Close the episode: the account is healthy again, or it has been reconnected. The red
--    flag goes with it. Only evolution_qr rows are touched: on every other platform
--    needs_reauth and last_refresh_error belong to the token-refresh path.
--    A deliberately disconnected account is left completely alone: the owner asked for that
--    disconnect, so nothing here may resurrect it into an alertable state. Its marker is
--    cleared by the reactivation trigger instead, which is the one thing that means "the
--    owner came back".
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
     AND NOT (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_user_disconnected_at')
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
--    The marker also closes whatever episode was open: the owner asked for this, so no alert
--    may go out, and the next outage has to start from a clean episode instead of reusing the
--    old one (whose "already emailed" marker would silence it).
CREATE OR REPLACE FUNCTION public.mark_whatsapp_user_disconnected(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = (COALESCE(account_metadata, '{}'::jsonb)
                               - 'whatsapp_disconnect'
                               - 'whatsapp_disconnect_claimed_at'
                               - 'whatsapp_disconnect_user_email_at'
                               - 'whatsapp_disconnect_admin_email_at')
                             || jsonb_build_object(
                                  'whatsapp_user_disconnected_at', to_jsonb(clock_timestamp()::text)),
         needs_reauth = false,
         last_refresh_error = NULL
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_whatsapp_user_disconnected(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_user_disconnected(uuid) TO service_role;

-- 7. Reactivating a WhatsApp QR account closes its disconnect episode in the SAME statement.
--    The reset used to be a separate best-effort call, and when it failed the old episode and
--    its "already emailed" marker survived the reconnect: the next outage reused that episode
--    and the marker silenced the new alert. A BEFORE UPDATE trigger makes the reset atomic
--    with the activation, for every path that flips is_active back to true (the webhook's
--    "open" branch and the activation RPC alike).
CREATE OR REPLACE FUNCTION public.clear_whatsapp_disconnect_on_reactivate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.platform IS DISTINCT FROM 'whatsapp'
     OR NEW.connection_mode IS DISTINCT FROM 'evolution_qr' THEN
    RETURN NEW;
  END IF;

  NEW.account_metadata := COALESCE(NEW.account_metadata, '{}'::jsonb)
    - 'whatsapp_disconnect'
    - 'whatsapp_disconnect_claimed_at'
    - 'whatsapp_disconnect_user_email_at'
    - 'whatsapp_disconnect_admin_email_at'
    - 'whatsapp_user_disconnected_at';
  NEW.needs_reauth := false;
  NEW.last_refresh_error := NULL;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.clear_whatsapp_disconnect_on_reactivate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS social_accounts_clear_whatsapp_disconnect_on_reactivate
  ON public.social_accounts;
CREATE TRIGGER social_accounts_clear_whatsapp_disconnect_on_reactivate
  BEFORE UPDATE ON public.social_accounts
  FOR EACH ROW
  WHEN (OLD.is_active IS NOT TRUE AND NEW.is_active IS TRUE)
  EXECUTE FUNCTION public.clear_whatsapp_disconnect_on_reactivate();

-- 8. The base URL the cron job calls. It is never a literal domain in this file: the
--    deployment supplies it, the same way the cron secret is supplied through the vault.
--    Resolution order: the database-level app.settings.supabase_url setting, then the
--    app_settings row an admin can change without a migration, then the vault secret
--    functions_base_url. NULL means "not configured".
CREATE OR REPLACE FUNCTION public.get_cron_functions_base_url()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_base text;
BEGIN
  v_base := nullif(btrim(coalesce(current_setting('app.settings.supabase_url', true), '')), '');
  IF v_base IS NOT NULL THEN
    RETURN v_base;
  END IF;

  SELECT nullif(btrim(coalesce(value #>> '{}', '')), '') INTO v_base
    FROM public.app_settings
   WHERE key = 'functions_base_url'
   LIMIT 1;
  IF v_base IS NOT NULL THEN
    RETURN v_base;
  END IF;

  -- The vault is optional: a database without it still resolves the other two sources.
  BEGIN
    SELECT nullif(btrim(coalesce(decrypted_secret, '')), '') INTO v_base
      FROM vault.decrypted_secrets
     WHERE name = 'functions_base_url'
     LIMIT 1;
  EXCEPTION WHEN others THEN
    v_base := NULL;
  END;

  RETURN nullif(v_base, '');
END;
$fn$;
REVOKE ALL ON FUNCTION public.get_cron_functions_base_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cron_functions_base_url() TO service_role;

-- 9. Every five minutes: poll Evolution for the state of every paired WhatsApp QR account and
--    alert the ones that have been gone long enough. The minutes are offset from the top of the
--    hour so this run does not land on */5 with the other jobs. The cron secret is resolved at
--    run time through public.get_cron_secret(); no credential is stored in this file. The
--    endpoint is resolved at run time too, through public.get_cron_functions_base_url(), so a
--    staging or self-hosted database calls its own watcher and never production's. A database
--    without a configured base URL keeps the job but skips the call, and says so in the log.
DO $do_cron_whatsapp_disconnect_watch$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'whatsapp-disconnect-watch cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  IF public.get_cron_functions_base_url() IS NULL THEN
    RAISE WARNING 'whatsapp-disconnect-watch has no functions base URL yet: set the app.settings.supabase_url database setting, an app_settings row with key functions_base_url, or the vault secret functions_base_url. The job skips its call until one is configured.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch') THEN
    PERFORM cron.schedule(
      'whatsapp-disconnect-watch',
      '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
      $$
      DO $do_call$
      DECLARE
        v_url text;
      BEGIN
        SELECT public.get_cron_functions_base_url() || '/functions/v1/whatsapp-disconnect-watch' INTO v_url;
        IF v_url IS NULL THEN
          RAISE NOTICE 'whatsapp-disconnect-watch: no functions base URL configured, skipping this run';
          RETURN;
        END IF;
        PERFORM net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      END $do_call$;
      $$
    );
  END IF;
END $do_cron_whatsapp_disconnect_watch$;
