# Webhooks

## Subscribe

- `POST /v1/webhooks` — `url` (public HTTPS), `events` (certified types only). Response carries `secret` once.
- `GET /v1/webhooks`, `GET /v1/webhooks/{id}` — reads never return `secret`.
- `PATCH /v1/webhooks/{id}` — update `url`, `events`, `is_active`. Setting `is_active: true` clears a disabled reason.
- `DELETE /v1/webhooks/{id}` — deletes queued deliveries with it.
- `POST /v1/webhooks/{id}/rotate-secret` — returns new `secret`; previous secret verifies for 24h (`previous_secret_expires_at`).
- `POST /v1/webhooks/{id}/test` — queues a `webhook.test` event, answers `202`. Refused unless the subscription is active and subscribed to `webhook.test`.

Scope: `webhooks:read` for reads, `webhooks:manage` for mutations.

## Signature verification

Each delivery carries:

- `X-Postora-Event` — event type.
- `X-Postora-Event-Id` — delivery row id (`evt_` prefix), immutable across retries.
- `X-Postora-Timestamp` — seconds since epoch when the signature was computed.
- `X-Postora-Signature` — `sha256=<hex>` of `<timestamp>.<raw body>` signed with HMAC-SHA256 under the subscription's secret.

Worked verification (signing line and header names match `supabase/functions/_shared/partnerWebhookDelivery.ts`):

```
expected = HMAC_SHA256(secret, timestamp + "." + rawBody)  // rawBody = exact bytes POSTed
           hex-encoded and prefixed "sha256="  // over `${timestamp}.${body}`
if expected != header["X-Postora-Signature"] → reject
// Receiver's own replay window — we suggest 5 minutes:
if abs(nowSeconds - header["X-Postora-Timestamp"]) > 300 → reject
```

The secret used is the one captured at enqueue (`secret_version`). Past the 24h overlap a retry is delivered under the new secret and `reVersioned` is recorded.

## Dedupe, retries, ordering

- Deduplicate on `X-Postora-Event-Id`. Retries carry the same id.
- Retry ladder: `1m / 5m / 30m / 2h / 6h`, then exhausted. Any non-2xx (including 4xx) is retried until ladder exhaustion. `MAX_DELIVERY_ATTEMPTS = 6`.
- Ordering is not guaranteed — handle out-of-order delivery.

## Certified event types

Read `supabase/functions/_shared/partnerWebhookEvents.ts` `CERTIFIED_EVENT_TYPES`: `webhook.test`, `message.received`, `message.accepted`, `message.delivered`, `message.read`, `message.failed`, `account.reauthorization_required`, `post.scheduled`. No other name is subscribable.

Reference: `supabase/functions/_shared/partnerWebhookDelivery.ts`, `docs/decisions/2026-09-02-d5-webhook-substrate.md`, `docs/api/openapi.yaml` `/functions/v1/partner-api/v1/webhooks`.
