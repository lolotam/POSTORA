# Postora Partner API v1 — Developer Documentation

Base URL: `https://api.postora.cloud/functions/v1/partner-api`

All v1 routes live under the `/v1` prefix, e.g. `GET /v1/accounts`. The alias `POST /functions/v1/partner-api` is frozen (see `deprecations.md`).

Contract and tooling: the canonical OpenAPI 3.1 document is `docs/api/openapi.yaml` and the derived Postman collection and environments are described in `docs/api/README.md`.

## Pages

- `getting-started.md` — Obtain a key, first call, request IDs.
- `authentication.md` — `x-postora-key` header, environments, expiry, revocation.
- `api-keys.md` — Lifecycle: issue, rotate, revoke.
- `scopes.md` — Scope vocabulary and route → scope table.
- `pagination.md` — Cursor pagination.
- `idempotency.md` — `Idempotency-Key` semantics.
- `rate-limits.md` — Rate-limit headers and 429/503 handling.
- `quotas.md` — Monthly quota and usage meters.
- `errors.md` — Error envelope and retry verdict.
- `webhooks.md` — Subscriptions, signature verification, delivery.
- `messaging.md` — Sending messages, suspension, D13 guarantee.
- `media.md` — Upload and reference.
- `publishing.md` — Posts: create, schedule, status.
- `social-accounts.md` — Bound accounts.
- `contacts.md` — Not available in v1 (stub).
- `analytics.md` — Not available in v1 (stub).
- `ai.md` — Not available in v1 (stub).
- `oauth.md` — Not available in v1 (stub).
- `integration-guides.md` — End-to-end walkthrough.
- `versioning.md` — Compatibility policy.
- `deprecations.md` — Deprecation records.
- `changelog.md` — Release history.

Reference links at the end of each page point to the exact source lines in `docs/api/openapi.yaml` or the `_shared` module they describe. A fact belongs in exactly one place — if you need the contract detail, follow the link.
