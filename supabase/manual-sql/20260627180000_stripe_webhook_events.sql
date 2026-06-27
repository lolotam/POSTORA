-- P2-1: Stripe webhook idempotency
-- Creates a dedupe table keyed by Stripe event.id. The stripe-webhook function
-- inserts a row before processing; if the insert conflicts on the primary key,
-- the event has already been seen and the handler returns 200 immediately
-- without re-running any side effects.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.stripe_webhook_events;

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'received',  -- received | processed | failed
  error       TEXT
);

-- Auth-only / service-only table. Only the edge function (service_role) writes
-- here; no anon/auth client access. Service-role bypasses RLS but we still
-- enable RLS so accidental anon/auth grants are inert.
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stripe_webhook_events FROM PUBLIC;
REVOKE ALL ON public.stripe_webhook_events FROM anon;
REVOKE ALL ON public.stripe_webhook_events FROM authenticated;
GRANT ALL ON public.stripe_webhook_events TO service_role;

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received_at
  ON public.stripe_webhook_events (received_at DESC);
