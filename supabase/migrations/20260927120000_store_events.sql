-- Store-event flows (Spec B, PR 1): receive and store WooCommerce deliveries.
--
-- store-webhook verifies each delivery and persists the minimal filter output
-- into store_events; a later worker (PR 2) claims due rows and sends openers.
-- Nothing here sends anything.
--
-- Tenancy is structural, not RLS-based: the Edge Functions run under the
-- service role, which bypasses RLS, so the binding proves "same owner" with
-- composite foreign keys. social_accounts already carries UNIQUE (id, user_id)
-- (20260828140000, reused below, not recreated); ai_agent_tools does not, so
-- the (id, user_id) key is added here for the connector leg of the binding.
--
-- Webhook secrets live in Vault (one row per binding, following the connector
-- credential pattern of 20260831140000/20260831150000): the two wrappers are
-- plpgsql so this file still applies on a database without the supabase_vault
-- extension (a LANGUAGE sql body would fail at CREATE time). Bodies resolve
-- vault.* only at execution, under the service role.
--
-- Idempotent: every object is created IF NOT EXISTS / dropped IF EXISTS
-- first, so this file applies twice without error.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Composite key on ai_agent_tools so a binding can prove connector
--    ownership structurally. social_accounts (id, user_id) already exists
--    (social_accounts_id_user_id_key) and is reused, not recreated.
-- ---------------------------------------------------------------------------
-- Added only when missing: a DROP on re-run would fail once the binding FK depends on it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_agent_tools_id_user_id_key'
      AND conrelid = 'public.ai_agent_tools'::regclass
  ) THEN
    ALTER TABLE public.ai_agent_tools
      ADD CONSTRAINT ai_agent_tools_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B. store_webhook_bindings: one row per WooCommerce connector, addressed by
--    the webhook URL (/store-webhook/<binding id>). The receiver resolves the
--    account and connector from the binding only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_webhook_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  secret_id uuid NOT NULL,
  previous_secret_id uuid,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_webhook_bindings_account_same_owner
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id) ON DELETE CASCADE,
  CONSTRAINT store_webhook_bindings_connector_same_owner
    FOREIGN KEY (connector_id, user_id)
    REFERENCES public.ai_agent_tools (id, user_id) ON DELETE CASCADE
);

ALTER TABLE public.store_webhook_bindings
  DROP CONSTRAINT IF EXISTS store_webhook_bindings_connector_id_key;
ALTER TABLE public.store_webhook_bindings
  ADD CONSTRAINT store_webhook_bindings_connector_id_key UNIQUE (connector_id);

ALTER TABLE public.store_webhook_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_webhook_bindings_owner_select
  ON public.store_webhook_bindings;
CREATE POLICY store_webhook_bindings_owner_select
  ON public.store_webhook_bindings
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.store_webhook_bindings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.store_webhook_bindings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_webhook_bindings TO service_role;

-- ---------------------------------------------------------------------------
-- C. store_events: one row per actionable WooCommerce delivery. Service-role
--    only: no policies, no grants below service_role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  social_account_id uuid,
  connector_id uuid,
  binding_id uuid NOT NULL
    REFERENCES public.store_webhook_bindings (id) ON DELETE CASCADE,
  flow text NOT NULL
    CHECK (flow IN ('cod_confirm', 'review_request', 'back_in_stock')),
  external_id text NOT NULL,
  delivery_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'sending', 'sent', 'skipped', 'failed')),
  outbound_message_id text,
  skip_reason text,
  due_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  send_attempt_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE public.store_events
  DROP CONSTRAINT IF EXISTS store_events_binding_flow_external_key;
ALTER TABLE public.store_events
  ADD CONSTRAINT store_events_binding_flow_external_key
  UNIQUE (binding_id, flow, external_id);

CREATE INDEX IF NOT EXISTS store_events_binding_idx
  ON public.store_events (binding_id);
CREATE INDEX IF NOT EXISTS store_events_due_idx
  ON public.store_events (status, due_at);

ALTER TABLE public.store_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.store_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_events TO service_role;

-- ---------------------------------------------------------------------------
-- D. stock_waitlist: chat opt-ins waiting on a product. Owner SELECT/DELETE;
--    writes are service-role. A row is deleted when its notification is sent
--    (no notified_at); retention is by expires_at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  conversation_id text NOT NULL,
  phone text NOT NULL,
  product_id bigint NOT NULL,
  parent_id bigint,
  product_name text,
  consent_source text NOT NULL DEFAULT 'chat_optin',
  consented_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '60 days',
  CONSTRAINT stock_waitlist_account_same_owner
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id) ON DELETE CASCADE,
  CONSTRAINT stock_waitlist_connector_same_owner
    FOREIGN KEY (connector_id, user_id)
    REFERENCES public.ai_agent_tools (id, user_id) ON DELETE CASCADE
);

ALTER TABLE public.stock_waitlist
  DROP CONSTRAINT IF EXISTS stock_waitlist_connector_phone_product_key;
ALTER TABLE public.stock_waitlist
  ADD CONSTRAINT stock_waitlist_connector_phone_product_key
  UNIQUE (connector_id, phone, product_id);

ALTER TABLE public.stock_waitlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_waitlist_owner_select ON public.stock_waitlist;
CREATE POLICY stock_waitlist_owner_select
  ON public.stock_waitlist
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS stock_waitlist_owner_delete ON public.stock_waitlist;
CREATE POLICY stock_waitlist_owner_delete
  ON public.stock_waitlist
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.stock_waitlist FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.stock_waitlist TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_waitlist TO service_role;

-- ---------------------------------------------------------------------------
-- E. messaging_opt_outs: phones that must never be messaged. Owner
--    SELECT/DELETE; writes are service-role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messaging_opt_outs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  phone text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.messaging_opt_outs
  DROP CONSTRAINT IF EXISTS messaging_opt_outs_user_phone_key;
ALTER TABLE public.messaging_opt_outs
  ADD CONSTRAINT messaging_opt_outs_user_phone_key
  UNIQUE (user_id, phone);

ALTER TABLE public.messaging_opt_outs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messaging_opt_outs_owner_select
  ON public.messaging_opt_outs;
CREATE POLICY messaging_opt_outs_owner_select
  ON public.messaging_opt_outs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS messaging_opt_outs_owner_delete
  ON public.messaging_opt_outs;
CREATE POLICY messaging_opt_outs_owner_delete
  ON public.messaging_opt_outs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.messaging_opt_outs FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.messaging_opt_outs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messaging_opt_outs TO service_role;

-- ---------------------------------------------------------------------------
-- F. create_store_webhook_secret: mint one Vault row, return its id. The name
--    is for humans sweeping vault; it is never used for lookup.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_store_webhook_secret(text);

CREATE FUNCTION public.create_store_webhook_secret(p_secret text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_secret IS NULL OR p_secret = '' THEN
    RAISE EXCEPTION 'webhook secret must not be empty';
  END IF;

  v_id := vault.create_secret(
    p_secret,
    'store_webhook:' || gen_random_uuid()::text,
    'Webhook signing secret for public.store_webhook_bindings (Spec B)'
  );

  RETURN v_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_store_webhook_secret(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_store_webhook_secret(text) TO service_role;

-- ---------------------------------------------------------------------------
-- G. get_store_webhook_secret: the current (and, within rotation, previous)
--    secret for a binding. A missing binding returns NULL rather than an
--    empty-shaped object, so a failed read never looks like an empty one.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_store_webhook_secret(uuid);

CREATE FUNCTION public.get_store_webhook_secret(p_binding_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
-- plpgsql, not sql: a LANGUAGE sql body is validated at CREATE time and fails
-- with "relation vault.decrypted_secrets does not exist" on a database
-- without the supabase_vault extension (the integration harness baseline).
-- A plpgsql body resolves vault.* only when it runs.
DECLARE
  v_secret_id uuid;
  v_prev_id uuid;
  v_rotated timestamptz;
  v_current text;
  v_previous text;
BEGIN
  SELECT b.secret_id, b.previous_secret_id, b.rotated_at
    INTO v_secret_id, v_prev_id, v_rotated
  FROM public.store_webhook_bindings AS b
  WHERE b.id = p_binding_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT decrypted.decrypted_secret INTO v_current
  FROM vault.decrypted_secrets AS decrypted
  WHERE decrypted.id = v_secret_id;

  IF v_prev_id IS NOT NULL THEN
    SELECT decrypted.decrypted_secret INTO v_previous
    FROM vault.decrypted_secrets AS decrypted
    WHERE decrypted.id = v_prev_id;
  END IF;

  RETURN jsonb_build_object(
    'current', v_current,
    'previous', v_previous,
    'rotated_at', v_rotated
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_store_webhook_secret(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_store_webhook_secret(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
