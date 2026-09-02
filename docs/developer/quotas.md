# Quotas

Monthly per-key send quota (`partner_api_keys.monthly_quota`). When `null`, the key is uncapped.

## Meters

`GET /v1/usage` (`supabase/functions/partner-api/v1/usage.ts`) reports:

```json
{"period":{"start":"<last_reset_at>","end":"<next month UTC>"},"meters":[{"meter":"messages","limit":null,"reserved":0,"confirmed":0,"indeterminate":0,"charged":0}],"rate_limit":{"per_minute":60},"request_id":"<uuid>"}
```

- `reserved` — in-flight sends (quota held before provider call).
- `confirmed` — provider accepted.
- `indeterminate` — outcome unknown.
- `charged` — sum of the three, the number that counts against `limit`.
- `limit` — the monthly cap or `null`.
- `period.start` is `last_reset_at` (not necessarily the 1st); `period.end` is the next calendar month in UTC.
- `rate_limit.per_minute` and top-level `request_id` are also returned.

## What is charged

`charged = reserved + confirmed + indeterminate`. A reservation held while a dispatch is in flight is charged. A `confirmed` transition keeps it charged. An `indeterminate` outcome also stays charged — it may have been delivered, so the quota is held rather than refunded. Only a definite provider rejection releases the reservation.

## Errors

`quota_exceeded` 429, `retryable: false`. The period does not reset until the next calendar month; retrying within the same period will not succeed. Back off until `period.end` or ask the operator to raise the quota.

Reference: `supabase/functions/partner-api/v1/usage.ts` and `docs/api/openapi.yaml` `/functions/v1/partner-api/v1/usage` `UsageResponse`.
