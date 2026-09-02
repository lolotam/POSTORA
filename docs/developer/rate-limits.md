# Rate Limits

Per-key, per-minute, enforced by `consume_partner_rate_v2` (`supabase/functions/_shared/partnerApiMetering.ts`).

## Headers

- `X-RateLimit-Limit` — configured limit for the key (`rate_limit_per_min`).
- `X-RateLimit-Remaining` — requests remaining in the current window.
- `X-RateLimit-Reset` — seconds until the current window ends (1..60, from Postgres).

On success the three headers are set. On `rate_limited` 429 the response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0` and, when the limiter supplied a reset, `X-RateLimit-Reset` and `Retry-After` (same value); `Retry-After` may be absent if no reset was computed. Pre-auth failures omit rate-limit headers.

## Errors

- `rate_limited` 429, `retryable: true` — back off for `Retry-After` seconds.
- `limiter_unavailable` 503, `retryable: true` — the limiter itself is down; retry shortly.

## Why reads may proceed during a limiter outage while writes refuse

The limiter classifies actions by risk (D7). Class A — bounded local reads (`GET /v1/accounts`, `/v1/conversations`, `/v1/messages/{id}`, `GET /v1/usage`, `GET /v1/webhooks`, `GET /v1/webhooks/{id}`, etc.) — fails **open** when the limiter is unavailable, because letting a read through unthrottled has bounded cost. Class B and C — unbounded or mutating operations (`GET /v1/templates`, `POST /v1/messages`, `POST /v1/media`, `POST /v1/posts`, webhook mutations) — fail **closed** with `limiter_unavailable`, because unmetered writes or outbound calls during an incident compound the outage.

Reference: `supabase/functions/_shared/partnerApiMetering.ts` `LimiterRiskClass`, `docs/api/openapi.yaml` per-path `D7 class A/B/C` notes.
