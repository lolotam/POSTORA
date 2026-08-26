# Verification of three production defects — evidence log

Date: 2026-08-24. All evidence gathered live against production
(`postorasupabase-supabase-j8axyh`, `postora-evolutionapi-zenkpi`, Higgsfield DCR).

---

## Bug 3 (NEW, live blocker) — QR pairs but the account never activates

### Symptom
User names a QR connection, scans, the phone links — Postora never shows it connected.

### Proven root cause

`social_accounts` carries `UNIQUE (user_id, platform, platform_user_id)` (twice:
`social_accounts_user_id_platform_platform_user_id_key` and
`social_accounts_user_platform_unique`).

The QR flow always INSERTs a fresh row with `platform_user_id = 'pending_<uuid>'`.
On activation `syncEvolutionAccountConnection`
(`supabase/functions/_shared/evolutionQrAccount.ts:147`) rewrites that to the real
number. Re-pairing a number that already has a row for the same user collides:

```text
ERROR:  duplicate key value violates unique constraint
        "social_accounts_user_id_platform_platform_user_id_key"
DETAIL: Key (user_id, platform, platform_user_id)=
        (7fe4d34e-…, whatsapp, ***0350) already exists.
```
(reproduced in a rolled-back transaction against row `a7fc6167`)

**The error is discarded.** The final statement is
`await admin.from("social_accounts").update(updates).eq("id", account.id);` —
no `{ error }` destructure, no check. The rejection is invisible: no log, no 500,
no UI error. `is_active` stays `false`, `platform_user_id` stays `pending_`.

### Evidence chain

| Fact | Value |
|---|---|
| Evolution instance `postora_a7fc6167…` | `connectionStatus=open`, `ownerJid=***0350@s.whatsapp.net`, 13:15:32Z |
| `whatsapp_evolution_instances.a7fc6167` | `last_connection_state=open`, `last_sync_at=13:15:38Z` |
| `social_accounts.a7fc6167` | `is_active=f`, `platform_user_id=pending_a7fc6167…`, `updated_at=11:39:49Z` |
| `social_accounts` UPDATE trigger | `update_social_accounts_updated_at` exists → `updated_at == connected_at` proves **zero** UPDATEs ever applied |
| Blocking row | `93de5a12…`, same user, `platform_user_id=***0350`, `is_active=f`, connected 2026-08-20 |
| service_role | `rolbypassrls=t`, has UPDATE → not a permissions problem |

Three stuck rows, all the same user re-pairing the same number:
`0b29f4fc` (postora), `5d8adccd` (xsellpoint-kw), `a7fc6167` (xsellpoint).

### Fix (two parts)
1. **Check the error.** Destructure and handle the update result in
   `syncEvolutionAccountConnection`; a 23505 must surface, not vanish.
2. **Handle re-pairing.** Activation must adopt/replace the pre-existing row for
   `(user_id, 'whatsapp', ownerNumber)` instead of inserting a second identity —
   or reject the pairing with a clear message naming the existing connection.
   Deleting the stale rows only unblocks today's user; the collision recurs.

---

## Bug 2 — Linked device shows `Google Chrome (Evolution API)`

**Confirmed, environment-only.**

- Swarm `ContainerSpec.Env` = 9 vars, **no** `CONFIG_SESSION_PHONE_*`.
- `docker exec <cid> printenv CONFIG_SESSION_PHONE_CLIENT CONFIG_SESSION_PHONE_NAME` → **empty**.
- Image-baked `/evolution/.env`: `CONFIG_SESSION_PHONE_CLIENT=Evolution API`, `CONFIG_SESSION_PHONE_NAME=Chrome`.
- Runtime log line: `Browser: Evolution API,Chrome,6.8.0-136-generic`.

Editing `/etc/dokploy/applications/.../code/.env` is a no-op — Swarm injects only
the Environment-tab list. Fix in the Dokploy UI, redeploy, verify `printenv`.
Honest resulting label: `Google Chrome (Postora)`. Already-linked devices keep the
old label; only a **new** pairing shows the new one.

---

## Bug 1 — Higgsfield consent logo

**The consent screen is Clerk**, not Higgsfield's own UI:
`https://mcp.higgsfield.ai/oauth2/authorize` → 302 →
`https://clerk.higgsfield.ai/oauth/authorize/continue`. The circular avatar is
Clerk's design; no Postora change removes it.

Registered client (`oauth_clients`, `provider_code='higgsfield'`), issued 2026-08-20:

| Field | Value |
|---|---|
| `client_id` | `YrQ2yw9pILF1J3Fq` |
| `registration_response->logo_uri` | `https://openinary.walidmohamed.com/t/postora.cloud/logo2.png` |
| `client_name` | `Postora` |
| `registration_client_uri` | **absent** |
| `registration_access_token` | **absent** |

Consequences:
- The registration **already points at logo2.png** — it is not stale on favicon.png.
- **RFC 7592 in-place PUT is impossible**; Higgsfield's DCR returned no management
  credentials. Response keys are only: `scope, logo_uri, client_id, client_uri,
  client_name, grant_types, client_secret, redirect_uris, response_types,
  client_id_issued_at, client_secret_expires_at, token_endpoint_auth_method`.

Asset facts (`logo2.png`, measured with PIL):
- 1024×1024, **WebP bytes** served as `Content-Type: image/png`, `etag {"format":"webp"}`.
  Served identically under `Accept: image/png` — a stored transform, not negotiation.
- Mode **RGB, no alpha**. Corners are **opaque white**, not transparent.
- Content is a glossy dark rounded card with the word **POSTORA** under the P. The
  glyph itself occupies well under half the canvas.

So inside Clerk's circular crop: white corners get cut, the dark rounded card reads
as a second box, and the mark looks small. That — not a failed image load — is the
likely mechanism. The WebP-as-PNG mismatch is real but **unproven** as the cause;
browsers content-sniff `<img>` bytes and `nosniff` only blocks non-image MIME types.

### Zero-risk fix
The registered `logo_uri` is a **URL we control**. Replace the *bytes* at that exact
path with a full-bleed square mark — no card border, no wordmark, no white margin —
then **purge the Cloudflare/Openinary cache** (`Cache-Control: max-age=31536000`,
`cf-cache-status: HIT`; a byte swap without a purge changes nothing for a year).
No re-registration, no risk to existing connections.

The `logo_uri` string in `higgsfield-oauth.ts:229` only affects **future**
registrations. Changing it to `favicon.png` (50×50) would make things worse.

Not verified: the rendered consent screen. The authorize probe bounced to Clerk
unauthenticated — before/after confirmation needs the user's signed-in session.
