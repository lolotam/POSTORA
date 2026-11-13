# AI providers: one-click health check, catalogue sync and daily monitoring

Status: owner-approved scope, final implementation reconciled on 2026-11-13 for PR #414.
Scope: `/admin/settings?tab=ai&sub=Providers` and one daily logical server run.
[Implementation, executable regression map and exact rollout](../plans/2026-11-13-ai-providers-test-and-sync.md).

## 1. Owner decisions (binding)

1. One button replaces the mounted Sync all control. It tests configured providers,
   syncs catalogues only after a passing probe, and shows one result table with one
   row per **provider connection `(provider_code, auth_method)`**. Rows report
   connected, failed with a safe reason, or needs re-login, plus added/updated/switched
   off model counts. A per-provider failure does not stop other providers.
2. Cover API keys and subscription credentials. Anthropic, OpenAI Codex and OpenRouter
   are currently supported. Future xAI, Kimi, MiniMax and Z.ai adapters can supply
   their OAuth catalogue without inventing an API-key catalogue source. New login
   adapters and their registration remain necessary; the runner/schema need no rewrite.
   OAuth models are stored with `auth_method = 'oauth'`, separate from API-key rows.
   Higgsfield is the exception: its platform login is OAuth, but its media catalogue
   stays in the `api_key` partition because `generate-video` and `generate-image`
   read only that partition.
   Refresh failure requires re-login and must never erase existing models.
3. Run the same server implementation automatically each day. Store the latest
   connection status and last checked time. Notify **admins only** on a
   connected-to-failed/needs-relogin transition through the existing admin email
   pattern and Resend. Do not write broadcast `admin_notifications` rows.

## 2. Goals and boundaries

The browser button and cron use one runner, one probe implementation and one catalogue
planner. Health is observable before a click, and incomplete work is reported rather
than presented as a completed healthy run. Provider credentials and raw upstream
responses must never become health reasons, alert text or browser output.

This does not redesign tier selection, change BYOK behavior, enable the OAuth feature
flag, migrate ordinary API-key inference to pi-ai or change the global notification
bell. Existing catalogue safety rules remain: preserve admin-added capabilities and
unknown name/price/context values, protect defaults/fallbacks, and never deactivate a
model whose capabilities are outside the catalogue's managed set.

## 3. Credential kinds and target discovery

A provider is an `ai_providers` row; a target/connection is that provider plus
`api_key` or `oauth`. The same `model_id` can exist once per credential kind.
`ai_models.auth_method` is repaired/backfilled, has NOT NULL/default `api_key`, and
is constrained to the two supported values. The triple unique index is additive in
EXPAND. The legacy pair constraint remains until guarded post-deployment CONTRACT.

API-key targets are every active provider whose saved key or configured environment
key resolves (round 3 scope correction). `SYNCABLE_PROVIDERS` controls catalogue
support only. Firecrawl and Apify also support standalone saved/environment keys;
EXPAND seeds missing provider identities without overriding disabled rows. Providers
without a catalogue API are probed with NULL model counts. OAuth targets are supported
connection rows
whose corresponding provider is active. A stored `reauth_required` connection is
reported without a network call or sync. Providers without a configured credential
are not targets and not failures. Status reads apply the same current-configuration
filter, excluding removed keys, disconnected subscriptions and disabled providers.

OpenRouter already uses a dedicated PKCE flow and permanent Vault key in
`_shared/aiOAuth/{clients,credentials}.ts`. Health retrieves that key and calls
pi-ai's ordinary `openrouter` adapter; its model registry supplies the OAuth
catalogue. It does not ask pi-ai for an OpenRouter OAuth refresh implementation.
Anthropic and OpenAI Codex use their existing refresh/probe adapters and registry.

API-key catalogue readers pin `auth_method = 'api_key'`; OAuth readers pin `oauth`.
The admin list intentionally reads both and uses `groupCatalogueRows`, whose legacy
fallback preserves unknown/missing kinds as API-key rows. The login dialog and
provider administration read the same persisted OAuth catalogue after sync.

## 4. Request, run identity and concurrency

`ai-provider-health/index.ts` composes CORS, authentication, validated request handling,
runner ports and sanitized responses. `verifyCronOrAdmin` checks cron/service secret
or an authenticated admin JWT and supplies the verified admin identity for cooldowns.
Gateway `verify_jwt = false` follows `process-store-events`; this allows the cron
secret through to the mandatory in-handler authentication.

`deriveRunId` hashes the UTC date with SHA-256 for daily scope. Manual scope
preserves the browser-generated `crypto.randomUUID()` token after UUID validation.
Every HTTP request has a fresh, independent lease-holder UUID.
A stable logical run ID must never be reused as the generic lease holder, because a
holder can renew its own lease and let concurrent retries overlap.

The request lease lasts 120 seconds and is released in finally. Logical admission is
separate and atomic: an unfinished daily run reserves its 30-minute recovery window
across gaps between cron calls. Manual requests during that window get 409 busy.
Completion ends the reservation; completed-run replays are no-ops. A crashed run's
reservation expires. New manual runs have a per-admin cooldown (default 60 seconds,
`app_settings` key `admin_ai_provider_health_cooldown_seconds`); chunks of the admitted
manual run can continue. Another unfinished manual run also refuses new manual work.

Immutable completion markers use `(run_id, provider_code, auth_method)`, independent
of the latest-status row. A manual run cannot erase daily completion. Seven days of
markers are retained. Each chunk re-plans, removes recorded targets and takes the first
six unfinished targets. Changed membership cannot shift an offset past unfinished work.

Three different providers may run concurrently. API-key and OAuth targets sharing a
`provider_code` serialize their entire probe/sync/write sequence. Known re-login targets
short-circuit before either network operation. Failures remain isolated per connection.

## 5. Time budgets and durable writes

The runner starts its 40-second deadline before discovery, key resolution and recorded
marker reads. Discovery and database calls carry cancellation. Each target receives
a total budget capped by 15 seconds and the remaining global deadline. Refresh,
probe and catalogue reads/writes share an earlier signal; up to two seconds of
the same total budget are reserved for result recording with a later write signal.
The probe itself has a 12-second
HTTP timeout. Alerts receive at most eight seconds of remaining global time and each
send at most five seconds. The handler caps a request at 45 seconds, reduces runner
time for earlier authorization/admission and reserves lease-release headroom beneath
the platform's 50-second ceiling.

Health catalogue writes and sync stamps execute together in `write_ai_health_catalog`.
The SQL transaction locks and verifies the request's live `cron_run_leases` row. Lease
takeover or release waits for the transaction; an HTTP abort cannot leave old-holder
writes overlapping a new holder. A stale lease/write is rejected at entry and after
writes, causing rollback. PostgREST reads also carry the target abort signal.

A successful result write atomically updates latest status and inserts the immutable
completion marker. Failed persistence becomes skipped retryable work and forces
`done: false`. It never becomes an ordinary in-memory result. A failed configuration,
OAuth credential or probe-model read, or a local catalogue write/lease refusal, is a
run error, not provider degradation. It never falls back to a guessed model or emits
a false degradation alert. Daily scope is reserved for authenticated cron callers;
logical admission excludes every other active run, including an expired run resuming
over a newer one. Cron HTTP timeouts are 50 seconds to cover the handler deadline.
Unmeasured model counts remain
NULL; zero means a measured no-change sync.

## 6. Safe failure reasons and endpoint policy

Reasons may contain fixed category sentences and numeric HTTP status. They never
contain arbitrary upstream body text, exception text, keys, tokens, headers or customer
diagnostics. `classifyApiKeyFailure` maps authentication/permission/billing/rate-limit/
timeout failures to fixed messages and uses a fixed status-only fallback. Unexpected
probe/sync exceptions also use fixed messages. Redaction includes credentials at the
start of a string or after whitespace as well as query parameters.

Admin-configured endpoints are an SSRF input. `providerUrlPolicy.ts` accepts only exact
reviewed HTTPS vendor hosts, rejecting IP literals, private/loopback/link-local/metadata
names, arbitrary DNS names, URL credentials, custom ports and fragments. The admin
add-provider action validates before persistence; probe transport validates stored
endpoints at use. Redirect mode is `error`, and custom transport redirect responses
are also rejected. Catalogue fetches use the same transport policy. New vendor hosts
require an explicit policy change; an admin session alone cannot allow arbitrary hosts.

## 7. Admin-only alert durability

Each connected-to-broken transition persists an immutable alert outbox event, with
`alert_id`, original status/reason and retry claim state. Pending events survive recovery,
changed health reasons and later independent breaks. Claim for ten minutes, send, then
acknowledge precisely that event. A failed send or acknowledgement leaves retryable work.
Latest health retains its pending indicator; it is not the event delivery ledger.

The event ID is Resend's Idempotency-Key. Retried event content remains frozen.
Resend deduplication lasts 24 hours; the system does not claim indefinite exactly-once
mail delivery across a send/mark crash beyond that transport retention. Alerts use
admin recipients and a production sender (`admin@postora.cloud`, or verified
`RESEND_FROM_EMAIL`); resend.dev test senders are rejected. All mail operations fit
the remaining request budget.

## 8. UI, authorization and observability

One mounted Check & sync all providers control shows Checking providers while running.
The unused `SyncAllButton` and its tests are removed: no production caller remains,
as required by `ARCHITECTURE.md` §1 (zero dead modules). The table
shows one row per connection, credential kind, status, safe reason, nullable counts and
last checked time. NULL counts display a dash. A successful empty status read clears
stale rows; a failed status read shows a warning, even over cached results, and never
claims empty history. Removed credentials do not remain visible as connected.

The browser retains one token across chunks, retries skipped work at most three times,
and reports incomplete runs. Both health and `['ai-config']` caches are invalidated
after successful or partial work so model groups and sync stamps refresh. Busy and
cooldown refusals receive actionable messages. English call-site defaults and Arabic
`adminai` translations remain supported.

Authorization is server-side. Latest health is admin-readable and browser read-only;
run state, completions and alerts are service-only under RLS and explicit grants.
Mutation RPCs are SECURITY DEFINER with controlled search_path and service-role EXECUTE.
Operational failures/refusals log sanitized event names. No production deployment is
implied by a branch push.

## 9. Rollout and verification

The [companion plan](../plans/2026-11-13-ai-providers-test-and-sync.md#7-exact-owner-rollout-not-performed-by-this-implementation-task)
owns the exact operational sequence: apply `20261113180000` before merge with cron
paused; merge and deploy edge/shared code; drain old writer instances; explicitly attest
and apply `20261113180100`, which removes legacy uniqueness and activates cron. CONTRACT
fails closed without that session attestation. Neither migration has been applied to
production by this implementation task.

The four daily jobs run at 03:05, 03:12, 03:19 and 03:26 UTC. SQL regressions exercise
EXPAND alone, guarded CONTRACT, coexistence/invalid kinds, real RLS controls, logical run
admission/cooldown, immutable completion, alert recovery and lease fencing. Deno tests
cover cancellation, ordering, OpenRouter, error privacy and catalogue behavior; frontend
tests cover caches, read failures, empty refresh and incomplete work. CI explicitly
includes the auth-method reader guard. The plan lists the required local gates.

Architectural/workflow authority remains `ARCHITECTURE.md` and `CLAUDE.md`; this document
does not override their layering, migration, review or self-hosted deployment rules.
