# Errors

## Envelope

Every `/v1` failure uses one envelope:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Rate limit exceeded",
    "retryable": true,
    "request_id": "018f3a2e-7b1a-7c9d-9e0f-1a2b3c4d5e6f",
    "details": { "meta_code": 131047 }
  }
}
```

`code` is stable — branch on it. `message` is human-readable and not stable. `details` is optional. `request_id` equals the `X-Postora-Request-Id` response header.

The alias (`POST /functions/v1/partner-api`) uses a different envelope (`{success:false, error:{…}, request_id}`) deliberately. Do not unify them.

## Retry verdict

**The typed `retryable` boolean is the retry verdict, never the HTTP status family.** This is the D2 divergence from the PRD and is stated here as such. Example: `temporarily_unavailable` is `503` with `retryable: false` (policy suspension), while `limiter_unavailable` is `503` with `retryable: true`.

Act only on `retryable: true`. A `503` with `retryable: false` will never succeed by retrying.

## Request ID for support

Include `error.request_id` / `X-Postora-Request-Id` when contacting support. It correlates the client error with server logs.

## Where the codes live

Do not copy the table into prose. The authoritative list is `docs/api/openapi.yaml` `components.schemas.V1ErrorCode` and the single policy table `supabase/functions/partner-api/v1/errors.ts` (`V1_ERROR_POLICY`) that pins each code's status and retryable flag.
