# Connectors and tools

A **connector** is a system a Postora workspace has wired up — a database, a store, a CRM, a chat workspace. A **tool** is one connector as it is configured and named in Postora, with the accounts it is available to. The Postora AI agent calls tools while it answers customers; these two routes let your own code call the same tools, without a model in the loop.

## What a key can see and run

Visibility is decided by the same resolver the agent uses. A tool is reachable by a key when it resolves for an account **bound to that key** — either configured for that account, explicitly shared with it, or shared across all of its owner's accounts. Nothing else grants access, so what `GET /v1/connectors` lists is exactly what `POST /v1/tools/execute` accepts.

Tools marked admin-only in Postora are never listed and never executable through the API. Those are reserved for a verified admin inside a conversation, and a key is not a person.

## `GET /v1/connectors`

Scope `connectors:read`, D7 class A. Returns every reachable tool, de-duplicated by `tool_id` — a tool shared with two bound accounts is one entry, not two. The listing is not paginated (it is bounded by the key's own bindings) but still returns `next_cursor: null`, so one paging loop works against every listing.

Each entry carries `tool_id`, `name`, `connector_type`, `auth_strategy`, `category`, `scope`, `social_account_id`, `connection` and `usage_30d`.

`auth_strategy` is `manual_credentials` for a connector configured with credentials held in Postora, or `composio_oauth` for one authenticated through a connected third-party account. Only the second kind has a `connection`, and it shows the connection's `status` and its human `external_account_label`. Provider account identifiers are never returned.

`usage_30d` counts connector calls in the key's **workspace** over the last 30 days, from every door — the AI agent, this API, the connector test button, publishing — not only this key's calls. `failures` counts calls that failed or timed out; a refusal is Postora declining to make the call and is not counted as a connector failure. `p50_latency_ms` is the median over calls that recorded one, and is null when none did. A workspace past 10 000 calls in the window is summarised over its 10 000 most recent calls.

## `POST /v1/connectors/{type}/connect-link`

Scope `connectors:manage`, D7 class C, `Idempotency-Key` required. Starts an authorisation flow for one connector type and returns `{connection_id, redirect_url, expires_at}`.

`{type}` must be a connector type that authenticates through a connected third-party account. A native connector type and an unknown type both answer `connector_type_not_connectable` (400).

The connection is created for the key's own workspace; there is no way to name another. The optional body field `social_account_id` records the account you intend it for — it does not change what is minted, and an account outside the key's binding answers `resource_not_found`.

`connection_id` is not usable when it is returned. A human must open `redirect_url` and finish authorising before `expires_at`. There is nothing to poll: the connection appears with `status: "active"` in `GET /v1/connectors` once it is.

A retry with the same key and body returns the stored link. A mint that **failed** is not stored, so the same key becomes usable again once its claim lease expires; until then a retry answers `idempotency_in_progress` (409, retryable). Use a new key if you need a link sooner.

## `POST /v1/tools/execute`

Scope `tools:execute`, D7 class C, `Idempotency-Key` required. Body `{tool_id, social_account_id, capability, parameters}`; ids are UUIDs from `GET /v1/connectors`, not prefixed ids. `social_account_id` is required even for a tool shared across accounts — it is what authorises the call.

`capability` must be one the connector declares. For a connector authenticated through a third-party account it is the provider's own action name, such as `SLACK_SEARCH_MESSAGES`. Anything else answers `connector_tool_not_allowed` (403).

A capability that **changes data** in the connected account additionally requires the tool's owner to have enabled writes in Postora. A key cannot widen that: without it the answer is `connector_write_not_allowed` (403). Connectors configured as plain webhooks have no typed capability contract and are not executable here.

Success is `200 {ok: true, data, request_id, latency_ms}`, where `data` is what the connector returned, unchanged.

## Errors and what to do about them

`tool_not_found` (404) is the single answer for an unbound account, an unknown `tool_id`, a malformed id, a tool that does not resolve for that account, and a tool whose connection belongs to another workspace. It is deliberately non-enumerable — do not read it as "wrong URL".

`connection_inactive` (409) means the tool's connection is not `active`. Nothing changes on its own; someone reconnects it in Postora, or you mint a new connect link.

`connector_unavailable` (503, retryable) means the connector service is not configured for this deployment, or could not be reached.

`tool_execution_failed` (502, retryable) means the connector ran and reported failure. The body carries the code only — provider messages never pass through. Retrying with the **same** `Idempotency-Key` returns the stored 502 rather than executing again.

`tool_execution_timeout` (504) means the 20-second execution budget expired, and the outcome is **unknown**: the call may have taken effect. Retrying with the same key answers `idempotency_indeterminate` (409) on purpose. Reconcile in the connected system rather than executing again.

## Metering

Every call is recorded against the workspace's connector usage, including every refusal against a tool the key can see; those show up in `usage_30d`. A `tool_not_found` refusal is recorded too but cannot be attributed to a listed tool, so it never appears there. Tool execution consumes no monthly message quota, and its `partner_api_usage` row is non-billable.

Reference: `supabase/functions/partner-api/v1/connectors.ts`, `supabase/functions/partner-api/v1/tools.ts`, `docs/api/openapi.yaml`.
