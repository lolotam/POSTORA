# Idempotency

Every side-effecting POST requires `Idempotency-Key`. Missing key → `missing_idempotency_key` 400.

Covered routes: `POST /v1/messages`, `POST /v1/media`, `POST /v1/posts`. `POST /v1/posts/{id}/schedule` and every webhook route do not require it — setting the same schedule twice is the same state; a duplicate subscription is harmless. Webhook routes deliberately do not require it.

## Same key + same body → replay

The stored response (status + body) is replayed verbatim, with `Idempotency-Replayed: true` — every `/v1` replay carries this header. No second side effect occurs. The body hash is canonical (sorted keys), so key ordering does not matter (`supabase/functions/_shared/partnerApiIdempotency.ts`).

## Same key + different body → conflict

`idempotency_conflict` 409, `retryable: false`. The key is bound to the first body. Use a new key for a different request.

## In-progress

Concurrent retry while the first attempt is still processing returns `idempotency_in_progress` 409, `retryable: true`. Retry after backoff with the same key and same body. The lease is 300s (`p_lease_seconds`); after expiry a new caller may take over.

## Indeterminate

`idempotency_indeterminate` 409, `retryable: false`. Means the outcome is unknown and may have been delivered. **Do not retry.** Reconcile by listing the conversation's messages (`GET /v1/conversations/{id}/messages`) and matching `provider_message_id` to the wamid you received on the accepted send, or wait for `message.accepted` (payload `message_id` = wamid). Contact support with `X-Postora-Request-Id` if needed. A taken-over `intended` dispatch never re-calls the provider (see `messaging.md`).

Reference: `supabase/functions/_shared/partnerApiIdempotency.ts` header comment and `docs/api/openapi.yaml` `components.parameters.IdempotencyKey`.
