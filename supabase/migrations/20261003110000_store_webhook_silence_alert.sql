-- Store webhook silence alert (#213: disabled-webhook monitoring).
--
-- WooCommerce disables a webhook after repeated failed deliveries and tells nobody, so the COD,
-- review and back-in-stock flows stop silently -- on 2026-10-01 a store's three webhooks kept
-- pointing at a binding that had been deleted. Postora cannot see a webhook's state on the store,
-- so it watches the one thing it does see: deliveries.
--
-- A binding counts as silent when it received at least one delivery in the last p_active_days
-- but none in the last p_quiet_minutes. The active-days floor keeps a store that never sent
-- anything, or one long abandoned, from alerting every day.
--
-- A delivery is either a store_events row or an ignored delivery, which store-webhook logs to
-- system_logs instead (source 'store-webhook', metadata.binding_id). Counting only store_events
-- would call a store silent while every order it sent was being ignored.
--
-- Returns jsonb rather than RETURNS TABLE: a composite RETURNS TABLE crashed this PG 17 cluster
-- once, and observability-alerts needs only the list.

CREATE OR REPLACE FUNCTION public.silent_store_webhook_bindings(
  p_quiet_minutes integer,
  p_active_days integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH deliveries AS (
    SELECT e.binding_id, e.created_at
    FROM public.store_events e
    WHERE e.created_at > now() - make_interval(days => p_active_days)
    UNION ALL
    SELECT (l.metadata->>'binding_id')::uuid, l.created_at
    FROM public.system_logs l
    WHERE l.source = 'store-webhook'
      AND l.created_at > now() - make_interval(days => p_active_days)
      AND l.metadata->>'binding_id' ~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
  ),
  silent AS (
    SELECT b.id, b.user_id, b.social_account_id, max(d.created_at) AS last_delivery_at
    FROM public.store_webhook_bindings b
    JOIN deliveries d ON d.binding_id = b.id
    GROUP BY b.id, b.user_id, b.social_account_id
    HAVING max(d.created_at) <= now() - make_interval(mins => p_quiet_minutes)
  )
  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'binding_id', s.id,
      'user_id', s.user_id,
      'social_account_id', s.social_account_id,
      'last_delivery_at', s.last_delivery_at
    ) ORDER BY s.last_delivery_at),
    '[]'::jsonb
  )
  FROM silent s;
$$;

-- service_role only: the result names other users' bindings.
REVOKE ALL ON FUNCTION public.silent_store_webhook_bindings(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.silent_store_webhook_bindings(integer, integer) TO service_role;

INSERT INTO public.observability_alert_configs
  (name, description, trigger_type, threshold_value, threshold_operator, time_window_minutes,
   notification_channels, notification_emails, cooldown_minutes, is_active)
SELECT
  'Store Webhook Silent',
  'A store connection that received deliveries in the last 7 days has had none for 24 hours. WooCommerce may have disabled its webhooks: check they are Active and point at the connection''s current URL.',
  'store_webhook_silence', 0, 'gt', 1440,
  ARRAY['email'], ARRAY['dr.vet.waleedtam@gmail.com'], 1440, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.observability_alert_configs WHERE trigger_type = 'store_webhook_silence'
);
