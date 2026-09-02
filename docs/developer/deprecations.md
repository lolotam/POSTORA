# Deprecations

Each entry records: `replacement`, `deprecation_date`, `planned_removal_date`, `migration`. No removal without a migration path announced in `changelog.md`.

## Frozen action alias — `POST /functions/v1/partner-api`

- **Status:** Frozen (D1). Still served. No new actions are accepted on it.
- **Replacement:** REST `POST /v1/messages`, `GET /v1/templates`, and `GET /v1/usage` as applicable.
- **Deprecation date:** Not deprecated — frozen. The alias is frozen (D1) and its sunset has three conditions that are not yet met; no date.
- **Planned removal:** No date.

Do not build new integrations against the alias.

## Legacy `whatsapp:*` scopes

- **Status:** Frozen at current capability, not issuable to new keys (D3).
- **Affected values:** `whatsapp:template.send`, `whatsapp:templates.read`, `whatsapp:webhooks.manage` (the last authorises nothing).
- **Replacement:** `messages:send`, `templates:read`, `webhooks:manage` respectively (`whatsapp:webhooks.manage` has no replacement — it never authorised anything).
- **Deprecation date:** deprecated when the generic vocabulary shipped; date not recorded.
- **Planned removal:** No date — existing keys remain valid at frozen capability until their operator reissues them.
- **Migration:** Ask the operator to reissue the key with generic scopes.

Reference: `supabase/functions/_shared/partnerScopes.ts` `LEGACY_SCOPES`.
