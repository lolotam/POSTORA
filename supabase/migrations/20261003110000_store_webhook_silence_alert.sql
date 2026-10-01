-- Store webhook silence alert (#213: disabled-webhook monitoring).
--
-- WooCommerce disables a webhook after repeated failed deliveries and tells nobody, so the COD,
-- review and back-in-stock flows stop silently -- on 2026-10-01 a store's three webhooks kept
-- pointing at a binding that had been deleted. Postora cannot see a webhook's state on the
-- store, so it watches the one thing it does see: authenticated deliveries.
--
-- Why a heartbeat table rather than counting store_events and the ignored-delivery logs:
--   * most verified deliveries leave neither -- a routine order update or product edit starts
--     no flow and is not "ignored" either -- so a busy store would look silent;
--   * both are keyed to the binding, and deleting a binding cascades its store_events away,
--     so a connection whose store still targets an old binding URL could never be reported.
-- store-webhook calls record_store_webhook_delivery() for every request that passes signature
-- verification. The heartbeat is keyed to the connector and outlives any one binding.
--
-- A connection counts as silent when its last delivery is older than p_quiet_minutes but newer
-- than p_active_days. The activity floor keeps a store that never sent anything, or one long
-- abandoned, from alerting every day.
--
-- Functions return jsonb / void, not RETURNS TABLE: a composite RETURNS TABLE crashed this
-- PG 17 cluster once.

CREATE TABLE IF NOT EXISTS public.store_webhook_heartbeats (
  connector_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  social_account_id uuid NOT NULL,
  last_delivery_at timestamptz NOT NULL,
  CONSTRAINT store_webhook_heartbeats_connector_fkey
    FOREIGN KEY (connector_id, user_id) REFERENCES public.ai_agent_tools (id, user_id) ON DELETE CASCADE,
  CONSTRAINT store_webhook_heartbeats_account_fkey
    FOREIGN KEY (social_account_id, user_id) REFERENCES public.social_accounts (id, user_id) ON DELETE CASCADE
);

-- Written and read only through the service-role functions below; no policies on purpose.
ALTER TABLE public.store_webhook_heartbeats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.store_webhook_heartbeats FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_store_webhook_delivery(p_binding_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.store_webhook_heartbeats (connector_id, user_id, social_account_id, last_delivery_at)
  SELECT b.connector_id, b.user_id, b.social_account_id, now()
  FROM public.store_webhook_bindings b
  WHERE b.id = p_binding_id
  ON CONFLICT (connector_id) DO UPDATE
    SET last_delivery_at = EXCLUDED.last_delivery_at,
        social_account_id = EXCLUDED.social_account_id;
$$;

CREATE OR REPLACE FUNCTION public.silent_store_connections(
  p_quiet_minutes integer,
  p_active_days integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'connector_id', h.connector_id,
      'user_id', h.user_id,
      'social_account_id', h.social_account_id,
      -- The binding the store should be calling now; null when it was deleted outright.
      'binding_id', b.id,
      'last_delivery_at', h.last_delivery_at
    ) ORDER BY h.last_delivery_at),
    '[]'::jsonb
  )
  FROM public.store_webhook_heartbeats h
  LEFT JOIN public.store_webhook_bindings b ON b.connector_id = h.connector_id
  WHERE h.last_delivery_at > now() - make_interval(days => p_active_days)
    AND h.last_delivery_at <= now() - make_interval(mins => p_quiet_minutes);
$$;

-- service_role only: the results name other users' connections.
REVOKE ALL ON FUNCTION public.record_store_webhook_delivery(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_store_webhook_delivery(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.silent_store_connections(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.silent_store_connections(integer, integer) TO service_role;

-- Seed from the deliveries already on record, so a store that went quiet before this deploy
-- is not invisible until its next delivery. Ignored deliveries live in system_logs.
-- Evidence is credited to the connection the store should be calling now, not only to the
-- binding that received it: deleting a binding cascades its store_events and leaves its logs
-- naming a binding that no longer exists -- the stale-URL outage this alert is for. Such a log
-- counts for its account's live binding when the account has exactly one.
WITH live AS (
  SELECT b.id, b.connector_id, b.user_id, b.social_account_id,
         count(*) OVER (PARTITION BY b.user_id, b.social_account_id) AS per_account
  FROM public.store_webhook_bindings b
),
logged AS (
  SELECT l.user_id, l.created_at, (l.metadata->>'binding_id')::uuid AS binding_id,
         l.metadata->>'social_account_id' AS social_account_id
  FROM public.system_logs l
  WHERE l.source = 'store-webhook'
    AND l.metadata->>'binding_id' ~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
),
evidence AS (
  SELECT v.connector_id, e.created_at
  FROM public.store_events e
  JOIN live v ON v.connector_id = e.connector_id
  UNION ALL
  SELECT v.connector_id, g.created_at
  FROM logged g
  JOIN live v ON v.user_id = g.user_id
  WHERE g.binding_id = v.id
     OR (v.per_account = 1
         AND g.social_account_id = v.social_account_id::text
         AND NOT EXISTS (SELECT 1 FROM public.store_webhook_bindings x WHERE x.id = g.binding_id))
)
INSERT INTO public.store_webhook_heartbeats (connector_id, user_id, social_account_id, last_delivery_at)
SELECT v.connector_id, v.user_id, v.social_account_id, max(ev.created_at)
FROM evidence ev
JOIN live v ON v.connector_id = ev.connector_id
GROUP BY v.connector_id, v.user_id, v.social_account_id
ON CONFLICT (connector_id) DO UPDATE
  SET last_delivery_at = greatest(public.store_webhook_heartbeats.last_delivery_at, EXCLUDED.last_delivery_at);

INSERT INTO public.observability_alert_configs
  (name, description, trigger_type, threshold_value, threshold_operator, time_window_minutes,
   notification_channels, notification_emails, cooldown_minutes, is_active)
SELECT
  'Store Webhook Silent',
  'A store connection that received deliveries in the last 7 days has had none for 24 hours. WooCommerce may have disabled its webhooks or still be calling an old URL: check they are Active and point at the connection''s current URL.',
  'store_webhook_silence', 0, 'gt', 1440,
  ARRAY['email'], ARRAY['dr.vet.waleedtam@gmail.com'], 1440, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.observability_alert_configs WHERE trigger_type = 'store_webhook_silence'
);
