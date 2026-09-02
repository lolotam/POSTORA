# Media

## Upload then reference

`POST /v1/media` stores bytes; `POST /v1/messages` references them by `media_id`. No send path accepts an external URL. Requires `Idempotency-Key`. Scope `media:write`.

Accepts `multipart/form-data` with `file` part, or JSON with `data` (base64 or `data:` URL) plus optional `filename`/`mime_type`. Declared `mime_type` is checked against sniffed bytes — mismatch is refused, not corrected.

On success `201` with `{id: media_…, mime_type, kind, size_bytes, created_at}`. No partner-facing URL is returned.

`GET /v1/media/{id}` returns metadata only. Workspace-scoped: a `media_id` from another workspace answers `resource_not_found`. Scope `media:read`.

## Allowlist and size limits

The accepted types and per-kind byte limits are defined in `supabase/functions/_shared/partnerMediaSniff.ts` and pinned in `docs/api/openapi.yaml` `POST /v1/media` description and `docs/decisions/2026-09-01-d10-media-control-matrix.md`. Cite the document for the numbers — the code is the one place they are enforced.

Exceeding the limit → `payload_too_large` 413 `retryable: false`. Sniffed type outside allowlist → `unsupported_capability` 422.

## Scan states

Every `media_id` carries `scan_state`:

- `pending` → `media_pending` 409 `retryable: true` — retry the same request shortly.
- `rejected` → `media_rejected` 422 `retryable: false` — upload different bytes.

Today every partner upload lands `available`; the states exist for when a scanner is introduced (`docs/decisions/2026-09-02-phase9-rich-media.md`).

Reference: `supabase/functions/partner-api/v1/media.ts`, `docs/api/openapi.yaml` `POST /v1/media`.
