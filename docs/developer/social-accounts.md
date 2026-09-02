# Social Accounts

## Binding model

A partner key sees only the social accounts bound to it (`partner_api_key_accounts`, spec D4). The binding may be a strict subset of the workspace's accounts. There is no "list everything in the workspace".

## List and get

- `GET /v1/accounts` — the bound accounts. Not paginated; a too-large binding is refused with `invalid_request` rather than truncated. Scope `accounts:read`. D7 class A.

- `GET /v1/accounts/{id}` — one bound account. An id outside the binding — or a malformed id — answers `resource_not_found` indistinguishably, so the binding is non-enumerable (D11). Scope `accounts:read`. D7 class A.

Every other `/v1` read is scoped to exactly this set. Naming an unbound `account_id` (e.g. `?account_id=` on `GET /v1/conversations`) answers `resource_not_found`, never a distinct forbidden code.

All bound accounts are listed. WhatsApp accounts expose conversations and messages; publishing-only targets have no conversation message history.

Example:

```bash
curl -H "x-postora-key: pk_live_REPLACE_ME" \
  https://api.postora.cloud/functions/v1/partner-api/v1/accounts
```

Reference: `supabase/functions/partner-api/v1/accounts.ts`, `docs/api/openapi.yaml` paths `/v1/accounts` and D11.
