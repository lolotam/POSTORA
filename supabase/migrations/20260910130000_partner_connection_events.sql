-- ============================================================================
-- Partner connection events — certify the number-lifecycle transitions
--
-- Widens the partner_webhooks_events_certified CHECK to permit three
-- additional event types, keeping every existing one:
--
--   whatsapp_number.connected      the register/attach transition committed
--   whatsapp_number.disconnected   the explicit detach transition committed
--   history_sync.completed         the coexistence history import settled
--
-- The pairing-expiry event is deliberately NOT certified: QR expiry is
-- observed by a poll and is not recorded as a transition anywhere, so nothing
-- would produce it. Certifying an event with no producer advertises a promise
-- that is never kept, and the gap is invisible until a customer reports
-- missing events.
--
-- The paired TypeScript edit is CERTIFIED_EVENT_TYPES in
-- _shared/partnerWebhookEvents.ts -- two enforcement points, two deliberate
-- acts, same change. The producers land with that edit, after this constraint
-- allows them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Certify the three connection events -- and ONLY those three
-- ---------------------------------------------------------------------------
-- Shape mirrors 20260902150000 (post.scheduled): assert the constraint
-- exists so a mis-ordered run fails loudly instead of silently creating a
-- constraint that permits everything, no-op when already widened, otherwise
-- drop and re-add with the whole predicate carried across -- including
-- cardinality(events) > 0, without which a subscription could hold no events
-- at all: a subscription that can never fire and never errors.
DO $widen$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'partner_webhooks_events_certified';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_webhooks_events_certified is missing -- apply 20260902130000 first';
  END IF;
  IF v_def LIKE '%whatsapp_number.connected%'
     AND v_def LIKE '%whatsapp_number.disconnected%'
     AND v_def LIKE '%history_sync.completed%' THEN
    RETURN;  -- already widened; re-running is a no-op
  END IF;

  ALTER TABLE public.partner_webhooks
    DROP CONSTRAINT partner_webhooks_events_certified;
  ALTER TABLE public.partner_webhooks
    ADD CONSTRAINT partner_webhooks_events_certified
    CHECK (
      cardinality(events) > 0
      AND events <@ ARRAY[
        'webhook.test',
        'message.received',
        'message.accepted',
        'message.delivered',
        'message.read',
        'message.failed',
        'account.reauthorization_required',
        'post.scheduled',
        'whatsapp_number.connected',
        'whatsapp_number.disconnected',
        'history_sync.completed'
      ]
    );
END
$widen$;
