# Scopes

A scope is a capability grant on the key. The Partner API authorises by *action*, and an action lists the scopes that satisfy it (`supabase/functions/_shared/partnerScopes.ts`, `supabase/functions/partner-api/router.ts` `ACTION_SCOPES`).

An unknown scope satisfies nothing. `insufficient_scope` is `403` with `retryable: false` — permanent for that key until the operator reissues it with a broader grant.

New keys may hold only generic scopes. Legacy `whatsapp:*` scopes are accepted at frozen capability for existing keys only and are not issuable to new ones (see `deprecations.md`).

## Route → scope

| Route | Scope |
|---|---|
| `GET /v1/accounts`, `GET /v1/accounts/{id}` | `accounts:read` |
| `GET /v1/conversations`, `GET /v1/conversations/{id}` | `conversations:read` |
| `GET /v1/conversations/{id}/messages` | `messages:read` |
| `GET /v1/messages/{id}` | `messages:read` |
| `POST /v1/messages` — `type: text` or media (`image`,`video`,`audio`,`document`) | `messages:send` |
| `POST /v1/messages` — `type: template` | `messages:send` **or** legacy `whatsapp:template.send` |
| `GET /v1/templates` | `templates:read` (or legacy `whatsapp:templates.read`) |
| `POST /v1/media` | `media:write` |
| `GET /v1/media/{id}` | `media:read` |
| `GET /v1/usage` | `usage:read` |
| `POST /v1/posts` | `posts:write` |
| `GET /v1/posts/{id}` | `posts:read` |
| `GET /v1/posts/{id}/status` | `posts:read` |
| `POST /v1/posts/{id}/schedule`, `DELETE /v1/posts/{id}/schedule` | `posts:schedule` |
| `GET /v1/connectors` | `connectors:read` |
| `POST /v1/connectors/{type}/connect-link` | `connectors:manage` |
| `POST /v1/tools/execute` | `tools:execute` |
| `GET /v1/webhooks`, `GET /v1/webhooks/{id}` | `webhooks:read` |
| `POST /v1/webhooks`, `PATCH /v1/webhooks/{id}`, `DELETE /v1/webhooks/{id}`, `POST /v1/webhooks/{id}/rotate-secret`, `POST /v1/webhooks/{id}/test` | `webhooks:manage` |

`whatsapp:webhooks.manage` authorises nothing on any action.

Reference: `supabase/functions/_shared/partnerScopes.ts` `GENERIC_SCOPES`/`LEGACY_SCOPES`, and `docs/api/openapi.yaml` per-path `description` scope notes.
