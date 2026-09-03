# Changelog

Format follows Keep a Changelog. Every entry that changes a partner's integration states what they must do.

## Unreleased

### Added
- `GET /v1/connectors`, `POST /v1/connectors/{type}/connect-link`, `POST /v1/tools/execute` — the connectors and tools surface (`supabase/functions/partner-api/v1/connectors.ts`, `tools.ts`; see `connectors.md`). **Must do:** scopes `connectors:read` / `connectors:manage` / `tools:execute`; send `Idempotency-Key` on both POSTs; treat `tool_not_found` as non-enumerable, and `tool_execution_timeout` (504) as an unknown outcome to reconcile, never to re-execute.
- Generic scopes `connectors:read`, `connectors:manage`, `tools:execute`. **Must do:** ask the operator to reissue the key if you need them; no existing scope satisfies them.
- Error codes `connection_inactive`, `connector_tool_not_allowed`, `connector_type_not_connectable`, `connector_unavailable`, `connector_write_not_allowed`, `tool_execution_failed`, `tool_execution_timeout`, `tool_not_found`. **Must do:** branch on `code` and honour `retryable`, as with every other code.
- `GET /v1/usage` — monthly meters `reserved`/`confirmed`/`indeterminate`/`charged` (`supabase/functions/partner-api/v1/usage.ts`). **Must do:** scope `usage:read`.
- Environment-bound keys (`pk_test_` staging prefix, `environment` on every key, a staging key never authenticates against production) (`supabase/functions/_shared/partnerApiKeys.ts:12`). **Must do:** use `pk_live_REPLACE_ME` against production only.
- Developer documentation under `docs/developer/` — no contract change.
- Generated Postman collection and environments (`docs/api/postman/`, `scripts/generate-postman.ts`). **Must do:** use `{{baseUrl}}` + `/v1` paths; credentials remain `pk_live_REPLACE_ME` placeholders.

### Changed
- `POST /v1/messages` 2xx bodies now carry `request_id` (`supabase/functions/partner-api/v1/messages.ts:50`). **Must do:** correlate via `request_id`.
- Every `/v1` replay now carries `Idempotency-Replayed: true` (`supabase/functions/_shared/partnerApiIdempotency.ts`, `messages.ts:59`). **Must do:** branch on header if you need replay detection.
- `POST /v1/media` now documents the `Idempotency-Key` it always required (`docs/api/openapi.yaml:335`). **Must do:** send the header.
- A `/v1` 429 now carries `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0` and, when the limiter supplied a reset, `X-RateLimit-Reset` and `Retry-After` (`supabase/functions/_shared/partnerApiMetering.ts` via `authenticated.ts`). **Must do:** back off `Retry-After`; handle its absence.
- `POST /v1/messages` and `GET /v1/templates` are now described in the OpenAPI contract (`docs/api/openapi.yaml:443`, `546`). No behavior change — contract now matches code.

## 1.0.0 — 2026-09-02

Live today on `main`: base URL `https://api.postora.cloud/functions/v1/partner-api`, all routes under `/v1`.

### Added
- `GET /v1/accounts`, `GET /v1/accounts/{id}` — bound accounts (D4, D11). **Must do:** scope `accounts:read`, filter by returned `acc_` ids only.
- `GET /v1/conversations`, `GET /v1/conversations/{id}`, `GET /v1/conversations/{id}/messages`, `GET /v1/messages/{id}` — WhatsApp reads, cursor-paginated on `(last_message_at,id)` / `(timestamp,id)` with `next_cursor`. **Must do:** `conversations:read` / `messages:read`, loop on `next_cursor`.
- `POST /v1/media` (`Idempotency-Key`), `GET /v1/media/{id}` — byte-sniffed allowlist, per-kind limits, workspace-scoped. **Must do:** `media:write`/`media:read`, reference by `media_id` only.
- `POST /v1/messages` (Idempotency-Key, D13 dispatch boundary), media types `image|video|audio|document` via `media_id`, capability matrix at the door (Phase 9.2), scan-state refusals `media_pending`/`media_rejected` (Phase 9.3). **Must do:** `messages:send`, handle `unsupported_direct_qr`, `media_pending`, D13 indeterminate reconciliation.
- `GET /v1/templates` — proxied from Meta, `next_cursor` always `null`. **Must do:** `templates:read`.
- `POST /v1/posts`, `GET /v1/posts/{id}`, `GET /v1/posts/{id}/status`, `POST/DELETE /v1/posts/{id}/schedule` — posts surface (Phase 8). Only API-created posts are addressable. **Must do:** `posts:write`/`posts:read`/`posts:schedule`, publish by scheduling.
- `GET /v1/webhooks`, `POST /v1/webhooks`, `GET/PATCH/DELETE /v1/webhooks/{id}`, `POST /v1/webhooks/{id}/rotate-secret`, `POST /v1/webhooks/{id}/test` — webhook substrate with HMAC `sha256=<hex>` over `<timestamp>.<body>`, headers `X-Postora-Event`/`X-Postora-Event-Id`/`X-Postora-Timestamp`/`X-Postora-Signature`, ladder `1m/5m/30m/2h/6h`, 6 attempts, 24h rotation overlap, certified events `webhook.test`, `message.received/accepted/delivered/read/failed`, `account.reauthorization_required`, `post.scheduled`. **Must do:** `webhooks:read`/`webhooks:manage`, verify signature as documented, dedupe on `X-Postora-Event-Id`.

### Changed
- Error envelope carries `error.retryable` typed retry verdict (D2). **Must do:** retry only when `retryable: true`, never on status family alone. Divergence from PRD documented.

### Deprecated
- Action alias `POST /functions/v1/partner-api` — frozen, no new actions (D1).
- Scopes `whatsapp:template.send`, `whatsapp:templates.read`, `whatsapp:webhooks.manage` — frozen, not issuable to new keys (D3).

### Security
- Keys stored as SHA-256 hash, prefix check before lookup, non-enumerable 401, signed storage URLs, per-hop webhook URL revalidation.

---

Divergences from PRD published here: `retryable` in envelope (D2) and D13's at-most-once guarantee with indeterminate reconciliation (not exactly-once).
