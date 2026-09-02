# Getting Started

You need an operator-issued partner key before you can call the Partner API. There is no self-service UI for partner keys in v1.

## 1. Obtain a key

Contact your Postora operator. The operator mints the key with `scripts/create-partner-key.ts` using a user JWT (service-role is refused) and gives you the plaintext once. Store it securely — it is shown once and stored only as a SHA-256 hash.

Keys are environment-bound (`pk_live_` for production, `pk_test_` for staging). See `authentication.md`.

## 2. First call

List the accounts bound to your key:

```bash
curl -H "x-postora-key: pk_live_REPLACE_ME" \
  https://api.postora.cloud/functions/v1/partner-api/v1/accounts
```

Success is `200` with a `CollectionEnvelope` containing `data: Account[]`, `next_cursor: null`.

## 3. Read the request ID

Every response — success or error — carries `X-Postora-Request-Id`. The same value appears inside the v1 error envelope as `error.request_id`. Include it when asking for support.

```bash
curl -i -H "x-postora-key: pk_live_REPLACE_ME" \
  https://api.postora.cloud/functions/v1/partner-api/v1/accounts | grep -i x-postora-request-id
```

## Next steps

- `authentication.md` — header name and environment rule.
- `scopes.md` — which scope your key needs.
- `errors.md` — how to read failures.

Reference: `docs/api/openapi.yaml` paths `/functions/v1/partner-api/v1/accounts` and `components.headers.X-Postora-Request-Id`.
