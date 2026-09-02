# Authentication

## Header

Send your key in `x-postora-key`:

```
x-postora-key: pk_live_REPLACE_ME
```

`Authorization: Bearer` is not read by the Partner API. The alias and `/v1` read only `x-postora-key` (`supabase/functions/partner-api/index.ts`, `supabase/functions/_shared/partnerApiKeys.ts:104`).

## Key prefixes and environments

- `pk_live_` — production (`PARTNER_API_ENVIRONMENT=production`, the default when unset).
- `pk_test_` — staging (`PARTNER_API_ENVIRONMENT=staging`).

A staging key never authenticates against production and a production key never authenticates against staging. The door checks the prefix before any database lookup and answers `invalid_key` 401 for a cross-environment key, indistinguishable from an unknown key (`partnerApiKeys.ts:104-131`).

## Non-enumerable 401

Unknown, malformed and other-environment keys share the non-enumerable `invalid_key` 401 — no body reveals whether the key exists. `key_revoked` and `key_expired` are distinct codes answered after a successful lookup, so they do confirm the key existed. Do not branch on message text — branch on `code`.

## Expiry and revocation

- `expires_at` — when set, the key answers `key_expired` 401 after that instant (`partnerApiKeys.ts:137`).
- `revoked_at` — when set, the key answers `key_revoked` 401 (`partnerApiKeys.ts:134`).

Revocation is one-way. A revoked key cannot be un-revoked — the operator must mint a new one.

Reference: `supabase/functions/_shared/partnerApiKeys.ts` and `docs/api/openapi.yaml` `components.securitySchemes.PartnerApiKey`.
