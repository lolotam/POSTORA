# Messaging

## Send

`POST /v1/messages` with `Idempotency-Key`. Scope `messages:send` (or legacy `whatsapp:template.send` for `type: template` only).

Types: `text` (`text.body`), `template` (`template.name`, `template.language` defaults `en_US`), media (`image`,`video`,`audio`,`document` referencing `media_id` from `POST /v1/media`). `caption` is forbidden for `audio`.

Capability is checked at the door via the Phase 9 matrix (`connection_mode × type`) before any side effect. QR-mode (`evolution_qr`) accounts answer `unsupported_direct_qr` 400 for every type.

## Template sends currently suspended

All `type: template` requests answer `temporarily_unavailable` `503` with `retryable: false`. This is a policy suspension, not an outage — retrying will not succeed until re-enabled via the changelog. Non-template sends are not affected.

See `docs/decisions/2026-08-30-suspend-send-template.md` for the reason and restoration gate.

## D13 delivery guarantee

Dispatch is at-most-once per `Idempotency-Key`:

- A retry with the same key and same body replays the stored response — no second provider call.
- A concurrent retry while the first is in flight answers `idempotency_in_progress` (retry after backoff).
- A takeover that finds an `intended` row never calls the provider; it marks `indeterminate` and returns `idempotency_indeterminate`.

An `indeterminate` answer means the message **may have been delivered**. Do not retry with a new key. Reconcile by listing the conversation's messages (`GET /v1/conversations/{id}/messages`) and matching `provider_message_id` to the wamid from the accepted send, or wait for `message.accepted` (payload `message_id` = wamid). The `biz_opaque_callback_data` reconciliation channel can promote some `indeterminate` records to `reconciled_sent`, but it never makes an indeterminate safe to resend — silence is absence of evidence, not evidence of absence.

This is **not exactly-once**. The PRD's exactly-once phrasing is superseded by `docs/decisions/2026-09-01-d13-dispatch-state-machine.md`.

## QR-mode and capability matrix

`evolution_qr` (Direct QR) supports no messaging type. The full matrix is in `docs/api/openapi.yaml` `POST /v1/messages` description (Phase 9.2 block).

Reference: `supabase/functions/partner-api/v1/messages.ts`, `docs/api/openapi.yaml` paths `/v1/messages` and `docs/decisions/2026-09-01-d13-dispatch-state-machine.md`.
