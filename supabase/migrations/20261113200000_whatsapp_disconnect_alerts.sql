-- WhatsApp disconnect alerts (spec 2026-11-13-whatsapp-disconnect-alerts-design.md).
--
-- One disconnection episode per Evolution QR account. The episode lives in
-- social_accounts.account_metadata, so there is no new RLS surface on that table and no
-- regenerated database types: account_metadata is already Json in types.ts.
--
-- The rendered email of a recipient does NOT live there: account_metadata is readable by
-- the account owner and by anyone who can see a public profile, and the admin payload
-- carries every admin's email address. It lives in its own table,
-- public.whatsapp_disconnect_email_payloads, which has RLS enabled and no policy at all.
--
-- Keys on social_accounts.account_metadata:
--   whatsapp_disconnect                = {episode_id, since, first_seen, state, observed_at}
--                                          episode_id identifies THIS episode: the claim returns it
--                                          and the mark only writes when the open episode still
--                                          carries it, so a marker can never outlive its episode
--                                          since is the start of the CURRENT CONTINUOUS TERMINAL
--                                          STREAK: it is null while no terminal streak runs, so a
--                                          transient observation can never age into the ten
--                                          minute grace window
--                                          first_seen is the start of the EPISODE and is never
--                                          reset while the episode is open
--   whatsapp_disconnect.flagged_at     = the watcher flagged this episode (and deactivated the
--                                          account). Only a flagged episode may be restored by a
--                                          healthy poll, so an account that was inactive for any
--                                          other reason is never resurrected
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
-- "app.settings.supabase_url" or the vault secret functions_base_url. Without one the migration
-- raises a warning and the scheduled job skips its call (and says so in the log) until a base URL
-- is configured. An app_settings row is deliberately NOT a source: an application admin can edit
-- that table, and the value becomes the host the cron secret is sent to.

-- 1. Poll freshness for the watch function's round robin.
--    whatsapp_evolution_instances is absent from src/integrations/supabase/types.ts (its RLS
--    revokes anon and authenticated), so this column needs no type regeneration.
ALTER TABLE public.whatsapp_evolution_instances
  ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;

CREATE INDEX IF NOT EXISTS whatsapp_evolution_instances_last_polled_at_idx
  ON public.whatsapp_evolution_instances (last_polled_at)
  WHERE last_polled_at IS NOT NULL;

-- 2. Observe one Evolution connection state.
--    terminal = true  : the session is gone. Opens the episode if there is none, or keeps
--                       the anchors of an open one.
--    terminal = false : the session is reconnecting. It may OPEN the episode (an account
--                       stuck in `connecting` for an hour is broken, and the backstop needs
--                       a first_seen to count from), but it never starts a terminal streak:
--                       `since` is cleared, so the ten minute rule stays out of reach.
--    Returns the resulting episode, or NULL when there is nothing to record.
--
--    `since` is the start of the CURRENT CONTINUOUS TERMINAL STREAK. It is kept only across
--    consecutive terminal observations: a terminal observation that follows a transient (or
--    that opens the episode) starts a new streak at that moment, and a transient clears it.
--    `first_seen` is the start of the episode and is never reset while the episode is open.
--
--    A deliberate disconnect (whatsapp_user_disconnected_at) is never an outage: the marker is
--    checked under the row lock. An inactive marker always wins; an active marker
--    blocks observation for 30 minutes while teardown completes. Older active markers
--    are recovered after a failed teardown and rollback, so outages cannot stay hidden.
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
  v_is_active boolean;
  v_marker_at timestamptz;
  v_episode jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT COALESCE(account_metadata, '{}'::jsonb), is_active
    INTO v_meta, v_is_active
    FROM public.social_accounts
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF (v_meta ? 'whatsapp_user_disconnected_at') THEN
    IF NOT v_is_active THEN
      RETURN NULL;
    END IF;

    BEGIN
      v_marker_at := (v_meta->>'whatsapp_user_disconnected_at')::timestamptz;
    EXCEPTION WHEN others THEN
      -- A marker written by this feature always has a timestamp. An unreadable value
      -- on an active row cannot prove a fresh teardown, so it is recoverable.
      v_marker_at := NULL;
    END;
    IF v_marker_at IS NOT NULL
       AND v_marker_at >= v_now - interval '30 minutes' THEN
      RETURN NULL;
    END IF;
    v_meta := v_meta - 'whatsapp_user_disconnected_at';
  END IF;

  IF p_terminal THEN
    IF NOT (v_meta ? 'whatsapp_disconnect') THEN
      v_episode := jsonb_build_object(
        'episode_id', gen_random_uuid()::text,
        'since', v_now, 'first_seen', v_now, 'state', p_state, 'observed_at', v_now);
    ELSE
      -- A terminal observation keeps the episode id and first_seen: the episode id is the
      -- identity the claim returns and the mark checks, and first_seen is the episode
      -- anchor that the backstop counts from.
      v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb)
        || jsonb_build_object('state', p_state, 'observed_at', v_now);
      -- `since` is kept only across CONSECUTIVE terminal observations. A terminal
      -- observation that follows a transient -- whose `since` is null -- starts the streak
      -- now, so the ten minute grace window can never count pre-terminal time.
      IF v_episode->>'since' IS NULL THEN
        v_episode := v_episode || jsonb_build_object('since', v_now);
      END IF;
      IF NOT (v_episode ? 'episode_id') THEN
        v_episode := v_episode || jsonb_build_object('episode_id', gen_random_uuid()::text);
      END IF;
    END IF;
  ELSE
    -- A transient observation may open the episode: an account that never leaves
    -- `connecting` is broken, and without a first_seen the sixty minute backstop could
    -- never fire for it. It never starts a terminal streak, so the ten minute rule stays
    -- out of reach and only the backstop can alert on a transient-only episode.
    IF NOT (v_meta ? 'whatsapp_disconnect') THEN
      v_episode := jsonb_build_object(
        'episode_id', gen_random_uuid()::text,
        'since', NULL, 'first_seen', v_now, 'state', p_state, 'observed_at', v_now);
    ELSE
      v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb)
        || jsonb_build_object('since', NULL, 'state', p_state, 'observed_at', v_now);
    END IF;
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(v_meta, '{whatsapp_disconnect}', v_episode)
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  -- Markers belong to this episode and are cleared with it. Return only completed groups,
  -- so the watcher can retain recovery polling without redispatching completed alerts.
  RETURN v_episode || jsonb_strip_nulls(jsonb_build_object(
    'user_email_at', v_meta->>'whatsapp_disconnect_user_email_at',
    'admin_email_at', v_meta->>'whatsapp_disconnect_admin_email_at'));
END;
$fn$;
REVOKE ALL ON FUNCTION public.observe_whatsapp_disconnect_state(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_whatsapp_disconnect_state(uuid, text, boolean) TO service_role;

-- 2a. The rendered email of a recipient, stored for the episode it belongs to.
--     The payload is NOT kept in social_accounts.account_metadata: that column is readable
--     by the account owner ("Users can view own social accounts") and by anyone who can
--     see a public profile, and the admin payload carries every admin's email address and
--     the rendered admin email. This table has RLS enabled and NO policy at all, so only
--     the service role -- the edge functions -- can read it.
--     The primary key carries the episode: a later episode gets its own payload row, and
--     the claim of one episode can never overwrite the payload of another.
CREATE TABLE IF NOT EXISTS public.whatsapp_disconnect_email_payloads (
  social_account_id uuid NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('user', 'admin')),
  episode_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (social_account_id, kind, episode_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_disconnect_email_payloads_account_idx
  ON public.whatsapp_disconnect_email_payloads (social_account_id);

ALTER TABLE public.whatsapp_disconnect_email_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.whatsapp_disconnect_email_payloads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.whatsapp_disconnect_email_payloads TO service_role;

-- 3. Reserve the alert for one recipient before sending it, so two overlapping runs cannot
--    both send. A claim older than 30 minutes is treated as a failed send and may be retaken.
--    The owner and the admins hold SEPARATE claims: the owner email and the admin email are
--    independent, so a failing owner send never costs the admin its alert and the admin
--    claim never blocks the owner's. The claim marker is therefore a map keyed by recipient.
--    The claim also stores the rendered payload (to, subject, html) of the recipient, and
--    only the first time that recipient is claimed: the provider's idempotency key belongs
--    to the episode and the recipient, so it must ALWAYS carry the same body. A retake
--    after a stale claim would otherwise rebuild the body -- the account name and the
--    recipient list may have changed in the meantime -- and the provider would answer the
--    changed body with a conflict forever.
--    Returns the episode_id of the claimed episode and the stored payload, or NULL when the
--    claim was refused. The caller carries the episode id into mark_whatsapp_disconnect_emailed
--    and into the email provider's idempotency key, so a retry of the same episode resolves
--    to the same send.
DROP FUNCTION IF EXISTS public.claim_whatsapp_disconnect_email(uuid, text);
CREATE OR REPLACE FUNCTION public.claim_whatsapp_disconnect_email(
  p_account_id uuid,
  p_kind text,
  p_payload jsonb
) RETURNS jsonb
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
  v_stored jsonb;
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

  -- The payload of this recipient for THIS episode. It is stored only once: the
  -- idempotency key belongs to the episode and the recipient, so the body under that key
  -- must never change. The conflict clause keeps the payload the FIRST claim brought.
  IF p_payload IS NOT NULL THEN
    INSERT INTO public.whatsapp_disconnect_email_payloads
      (social_account_id, kind, episode_id, payload)
    VALUES (p_account_id, p_kind, v_episode_id, p_payload)
    ON CONFLICT (social_account_id, kind, episode_id) DO NOTHING;
  END IF;

  SELECT payload INTO v_stored
    FROM public.whatsapp_disconnect_email_payloads
   WHERE social_account_id = p_account_id
     AND kind = p_kind
     AND episode_id = v_episode_id;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect_claimed_at}',
           jsonb_set(v_claimed, ARRAY[p_kind], to_jsonb(clock_timestamp()::text)))
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  IF v_stored IS NULL THEN
    RETURN jsonb_build_object('episode_id', v_episode_id);
  END IF;
  RETURN jsonb_build_object('episode_id', v_episode_id, 'payload', v_stored);
END;
$fn$;
REVOKE ALL ON FUNCTION public.claim_whatsapp_disconnect_email(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_disconnect_email(uuid, text, jsonb) TO service_role;

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
--    owner came back". Active markers older than 30 minutes (or unreadable) belong
--    to a failed teardown/rollback and can be recovered by a healthy poll.
CREATE OR REPLACE FUNCTION public.clear_whatsapp_disconnect_episode(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_meta jsonb;
  v_marker_at timestamptz;
  v_cleared boolean;
BEGIN
  SELECT COALESCE(account_metadata, '{}'::jsonb)
    INTO v_meta
    FROM public.social_accounts
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND is_active
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF (v_meta ? 'whatsapp_user_disconnected_at') THEN
    BEGIN
      v_marker_at := (v_meta->>'whatsapp_user_disconnected_at')::timestamptz;
    EXCEPTION WHEN others THEN
      v_marker_at := NULL;
    END;
    IF v_marker_at IS NOT NULL
       AND v_marker_at >= clock_timestamp() - interval '30 minutes' THEN
      RETURN FALSE;
    END IF;
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = v_meta
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
     AND (v_meta ? 'whatsapp_disconnect'
          OR v_meta ? 'whatsapp_disconnect_user_email_at'
          OR v_meta ? 'whatsapp_disconnect_admin_email_at'
          OR v_meta ? 'whatsapp_disconnect_claimed_at'
          OR v_meta ? 'whatsapp_user_disconnected_at'
          OR needs_reauth = true
          OR last_refresh_error IS NOT NULL);
  v_cleared := FOUND;

  -- The episode is over, so its stored payloads go with it: a later episode must build
  -- its own payload, and a stale row must never be reused under a new idempotency key.
  -- Only when the episode really closed -- a refused clear leaves the episode open, and
  -- its payload must survive for the retake of a stale claim.
  IF v_cleared THEN
    DELETE FROM public.whatsapp_disconnect_email_payloads
     WHERE social_account_id = p_account_id;
  END IF;

  RETURN v_cleared;
END;
$fn$;
REVOKE ALL ON FUNCTION public.clear_whatsapp_disconnect_episode(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_whatsapp_disconnect_episode(uuid) TO service_role;

-- 5a. A healthy inactive unflagged episode closes without clearing the reconnect banner.
CREATE OR REPLACE FUNCTION public.clear_unflagged_whatsapp_disconnect_episode(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cleared boolean;
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = COALESCE(account_metadata, '{}'::jsonb)
                              - 'whatsapp_disconnect'
                              - 'whatsapp_disconnect_claimed_at'
                              - 'whatsapp_disconnect_user_email_at'
                              - 'whatsapp_disconnect_admin_email_at'
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND NOT is_active
     AND NOT (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_user_disconnected_at')
     AND (COALESCE(account_metadata, '{}'::jsonb)->'whatsapp_disconnect'->>'flagged_at') IS NULL
     AND (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect_claimed_at'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect_user_email_at'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect_admin_email_at');
  v_cleared := FOUND;

  -- The episode is over, so its stored payloads go with it. A refused clear leaves
  -- the episode open, and its payload must survive for the retake of a stale claim.
  IF v_cleared THEN
    DELETE FROM public.whatsapp_disconnect_email_payloads
     WHERE social_account_id = p_account_id;
  END IF;

  RETURN v_cleared;
END;
$fn$;

REVOKE ALL ON FUNCTION public.clear_unflagged_whatsapp_disconnect_episode(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_unflagged_whatsapp_disconnect_episode(uuid) TO service_role;

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
DECLARE
  v_marked boolean;
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
  v_marked := FOUND;

  -- The deliberate disconnect closes the episode, so its stored payloads go with it.
  IF v_marked THEN
    DELETE FROM public.whatsapp_disconnect_email_payloads
     WHERE social_account_id = p_account_id;
  END IF;

  RETURN v_marked;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_whatsapp_user_disconnected(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_user_disconnected(uuid) TO service_role;

-- Local intent and deactivation are one transaction. In particular, a failed lookup or
-- write cannot clear an already-inactive account's outage while leaving it connected remotely.
CREATE OR REPLACE FUNCTION public.deactivate_whatsapp_deliberately(
  p_account_id uuid,
  p_workspace_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM public.social_accounts
   WHERE id = p_account_id
     AND platform = 'whatsapp' AND connection_mode = 'evolution_qr'
     AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
   FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM public.mark_whatsapp_user_disconnected(p_account_id);
  UPDATE public.social_accounts SET is_active = false WHERE id = p_account_id;
  RETURN TRUE;
END;
$fn$;
REVOKE ALL ON FUNCTION public.deactivate_whatsapp_deliberately(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_whatsapp_deliberately(uuid, uuid) TO service_role;

-- 6a. Undoes a deliberate-disconnect marker that was written for a teardown which then
--     failed. The teardown marks FIRST (so a completed disconnect is never alerted on) and
--     deactivates second; when the deactivation fails, the account stays active with the
--     marker on it. That state is the worst of both: the watcher skips every account
--     carrying the marker, so a live account whose session is gone is never polled and the
--     owner is never told.
--     The marker is therefore cleared again -- but ONLY while the row is still active and is
--     still an evolution_qr WhatsApp row. An inactive row carries the marker legitimately
--     (the disconnect did happen), and a row that is no longer a QR account never had the
--     marker in the first place.
CREATE OR REPLACE FUNCTION public.unmark_whatsapp_user_disconnected(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = COALESCE(account_metadata, '{}'::jsonb)
                             - 'whatsapp_user_disconnected_at'
   WHERE id = p_account_id
     AND is_active = true
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_user_disconnected_at');

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.unmark_whatsapp_user_disconnected(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unmark_whatsapp_user_disconnected(uuid) TO service_role;

-- 6b. The watcher flags an account only while the episode it observed is still the open one.
--     Observing and flagging are two calls, and between them the owner may reconnect (the
--     reactivation trigger clears the episode) or disconnect on purpose (the marker). An
--     unconditional update would then re-raise the banner on an account that is healthy or
--     deliberately closed. Checking the episode_id under the row lock makes the reconnect and
--     the deliberate disconnect win. Returns true only for the first flag; repeated calls
--     preserve flagged_at and the reconnect reason. Already-flagged episodes retry incomplete
--     email groups without counting a new flag.
CREATE OR REPLACE FUNCTION public.flag_whatsapp_disconnect_episode(
  p_account_id uuid,
  p_episode_id text,
  p_reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- is_active goes with needs_reauth: a dead Evolution session is inactive by design (the
  -- webhook deactivates the row the same way), and the QR setup page only offers an inactive
  -- account for a rescan.
  --
  -- The episode is stamped with flagged_at in the SAME statement. That stamp is what makes
  -- the episode "the one the watcher flagged", and it is the only thing that allows a later
  -- healthy poll to restore the account (see restore_whatsapp_disconnect_account). Without it
  -- an account that was inactive for any other reason could be resurrected by a poll.
  UPDATE public.social_accounts
     SET is_active = false,
         needs_reauth = true,
         last_refresh_error = p_reason,
         account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect,flagged_at}',
           to_jsonb(clock_timestamp()::text),
           true)
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND NOT (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_user_disconnected_at')
     AND account_metadata->'whatsapp_disconnect'->>'episode_id' = p_episode_id
     AND account_metadata->'whatsapp_disconnect'->>'flagged_at' IS NULL;

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.flag_whatsapp_disconnect_episode(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_whatsapp_disconnect_episode(uuid, text, text) TO service_role;

-- 6c. A healthy poll restores an account that THIS WATCHER deactivated.
--     The watcher sets is_active = false when it flags an account, and the account stays
--     inactive until the owner scans a new QR code. But the session can come back on its
--     own: Evolution reports "open" again while the row is still flagged, and then the
--     account is a healthy account that nobody can use, because the red flag and the
--     inactive row only go away through a reconnect.
--
--     The restore is conditional, and the conditions are the whole safety of it:
--       * the row is inactive -- an active row is the clear's business, not this one's;
--       * the OPEN episode carries flagged_at, so it is the episode the watcher flagged and
--         not one the owner or the webhook opened;
--       * the row carries no deliberate-disconnect marker, so an account the owner
--         disconnected on purpose is never resurrected.
--     The activation and the episode reset happen in ONE statement, and the reactivation
--     trigger (section 7) clears the same keys in the same statement.
--     Returns false when the conditions do not hold: "not ours to restore" is not an error.
CREATE OR REPLACE FUNCTION public.restore_whatsapp_disconnect_account(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_restored boolean;
BEGIN
  UPDATE public.social_accounts
     SET is_active = true,
         needs_reauth = false,
         last_refresh_error = NULL,
         account_metadata = COALESCE(account_metadata, '{}'::jsonb)
                              - 'whatsapp_disconnect'
                              - 'whatsapp_disconnect_claimed_at'
                              - 'whatsapp_disconnect_user_email_at'
                              - 'whatsapp_disconnect_admin_email_at'
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND NOT is_active
     AND NOT (COALESCE(account_metadata, '{}'::jsonb) ? 'number_mismatch')
     AND NOT (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_user_disconnected_at')
     AND (COALESCE(account_metadata, '{}'::jsonb)->'whatsapp_disconnect'->>'flagged_at') IS NOT NULL;
  v_restored := FOUND;

  -- A restored account starts a new episode, so the payloads of the closed one go with it.
  IF v_restored THEN
    DELETE FROM public.whatsapp_disconnect_email_payloads
     WHERE social_account_id = p_account_id;
  END IF;

  RETURN v_restored;
END;
$fn$;
REVOKE ALL ON FUNCTION public.restore_whatsapp_disconnect_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_whatsapp_disconnect_account(uuid) TO service_role;

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

  -- The reactivation closes the episode, so its stored payloads go with it. The trigger
  -- function is SECURITY DEFINER, so the delete runs as the table owner and is not
  -- stopped by the table's RLS.
  DELETE FROM public.whatsapp_disconnect_email_payloads
   WHERE social_account_id = NEW.id;

  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.clear_whatsapp_disconnect_on_reactivate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS social_accounts_clear_whatsapp_disconnect_on_reactivate
  ON public.social_accounts;
CREATE TRIGGER social_accounts_clear_whatsapp_disconnect_on_reactivate
  BEFORE UPDATE OF is_active ON public.social_accounts
  FOR EACH ROW
  WHEN (NEW.is_active IS TRUE)
  EXECUTE FUNCTION public.clear_whatsapp_disconnect_on_reactivate();

-- 7a. One-time backfill of the deliberate-disconnect marker.
--     The watcher skips every account carrying whatsapp_user_disconnected_at, and the marker
--     is written by the teardown -- but the teardown only ran AFTER this feature existed.
--     An account that the owner disconnected BEFORE the rollout therefore carries no marker,
--     and the watcher would treat its still-closed remote session as a fresh outage and
--     email the owner about a disconnect they performed on purpose.
--
--     So every evolution_qr WhatsApp account that was ALREADY INACTIVE when this migration
--     ran is treated as deliberately disconnected: it gets the marker with the rollout
--     instant, and the watcher never polls it. The choice is deliberately conservative --
--     a missed alert is recoverable, a false "please reconnect" email on an account the
--     owner closed on purpose is not.
--
--     These accounts come back into the watching when they are reactivated: the
--     reactivation trigger (section 7) clears the marker in the same statement as the
--     activation, and only the owner coming back takes it away.
--
--     The backfill is a function so that the SQL proof can run it again against synthetic
--     rows: the one-time call below is the rollout, the function is the rule.
CREATE OR REPLACE FUNCTION public.backfill_whatsapp_legacy_disconnects(p_rollout_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_stamped integer;
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_user_disconnected_at}',
           to_jsonb(p_rollout_at::text))
   WHERE platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND NOT is_active
     AND NOT (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_user_disconnected_at');

  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  RETURN v_stamped;
END;
$fn$;
REVOKE ALL ON FUNCTION public.backfill_whatsapp_legacy_disconnects(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_whatsapp_legacy_disconnects(timestamptz) TO service_role;

DO $do_backfill_whatsapp_legacy_disconnects$
DECLARE
  -- The rollout instant of this feature. Every evolution_qr WhatsApp account that was
  -- already inactive at this instant is treated as deliberately disconnected from now on.
  v_rollout_at CONSTANT timestamptz := '2026-11-13 00:00:00+00';
  v_stamped integer;
BEGIN
  v_stamped := public.backfill_whatsapp_legacy_disconnects(v_rollout_at);
  RAISE NOTICE 'whatsapp disconnect backfill: % pre-rollout inactive account(s) marked as deliberately disconnected',
    v_stamped;
END $do_backfill_whatsapp_legacy_disconnects$;

-- 8. The base URL the cron job calls. It is never a literal domain in this file: the
--    deployment supplies it, the same way the cron secret is supplied through the vault.
--    Resolution order: the database-level app.settings.supabase_url setting, then the
--    vault secret functions_base_url. NULL means "not configured".
--    An app_settings row is NOT a source. That table is editable by an application admin,
--    and the resolved value is the host the cron secret is sent to in an Authorization
--    header: an editable row would let an admin redirect the secret to a host of their
--    choosing. The operator therefore sets the vault secret (or the database setting),
--    neither of which the application can write.
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

  -- The vault is optional: a database without it still resolves the setting above.
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
    RAISE WARNING 'whatsapp-disconnect-watch has no functions base URL yet: set the app.settings.supabase_url database setting or the vault secret functions_base_url. The job skips its call until one is configured.';
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
  -- Migrations alone must never start alerts. Deploy the shared teardown and both
  -- functions, rerun backfill_whatsapp_legacy_disconnects(clock_timestamp()), then
  -- explicitly enable this job with cron.alter_job(jobid, active := true).
  PERFORM cron.alter_job(jobid, active := false)
    FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch';
END $do_cron_whatsapp_disconnect_watch$;
