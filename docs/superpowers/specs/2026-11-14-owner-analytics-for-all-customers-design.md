# Owner analytics for all eligible customers

Date: 2026-11-14. Status: design recommendation; no implementation or production action performed.
Source baseline: `bc3479425cbf8312b5857ba9da9b493489e0cc70`, branch `investigate/noor-analytics`.

## 1. Outcome, authority, and evidence

Every eligible existing or future customer must have a supported path from connection to durable analytics, without a hidden pilot dependency. A customer whose connection cannot collect must receive the current cause and an action that can resolve it. Enabling a policy is not evidence of collection. Success requires saved measurements, truthful report/UI/MCP output, scheduled continuation, and tenant isolation.

This task creates only this design document. The owner delegated design choices to the recommended option; every recommendation below is therefore the selected design, not an invitation for another design questionnaire. That delegation does not approve production mutations, provider probes, migration application, schedule changes, or release activation. The existing [release gates §6](../../specs/2026-10-30-instagram-release-gates.md#6-activation-gates-be--approval-required-at-every-step), including the retained complete G-X requirement, remain binding. Architecture and task lifecycle remain in [ARCHITECTURE.md](../../../ARCHITECTURE.md) and [CLAUDE.md](../../../CLAUDE.md).

Evidence classes:

- **Supplied production evidence:** `F:/Dev/Temp/noor-analytics-investigation/evidence.md`, including its final “Follow-up evidence” section. It reports 23 active Instagram accounts, only the original pilot admitted, exactly one capability row, and no OAuth attempts after 5 November. Noor's two accounts reconnected through `facebook_business` on 13 November. These facts were not rechecked against production in this task.
- **Source proof:** file/line references below refer to the baseline above. Migration replacements were followed; historical specifications describe intended behavior and do not prove implementation or deployment.
- **Prior investigation:** `F:/Dev/Temp/noor-analytics-investigation/report.md`. Its staged-rollout recommendation is retained, but follow-up evidence adds capability and credential bootstrap as prerequisites. Its older statement that Noor's capability is unknown is superseded by the supplied follow-up.
- **Unproved:** current deployed hashes/catalog, real credential availability/validity, historical permission-event provenance, Facebook's first failed stage, and prior release approvals. No live Meta support or throughput is asserted from source alone.

Graph navigation used a read-only scoped traversal of the existing graph JSON to avoid the query CLI's previously observed cache-file creation under the one-new-file constraint. Its stale `persistOneIgAccount` location was treated only as navigation; citations were taken from source.

## 2. Proven connection gap

### 2.1 Paths customers can reach

| Path | Reachable UI and backend | Legacy behavior | Lifecycle behavior |
|---|---|---|---|
| Instagram via Facebook Business | `InstagramConnectDialog.tsx:41,59`; `useInstagramOAuth.ts:160-220` invokes `instagram-business-oauth` with `action: authorize`, then its picker saves `store_ig_account`. | `instagram-business-oauth/index.ts:292-344,803-858` stores a Page token, `flow/source=facebook_business`, metadata scopes and health flags. It does not call the capability or binding writer. | Same endpoint, protected branch at `:647-677,743-795`: captured attempt, safe selection, atomic `protectedCommit`, followed by `refreshPageLinkedInstagramPermissions`. |
| Facebook Page connect, optionally linked Instagram | `useFacebookOAuth.ts:101-110,136-149`; `facebook-oauth/index.ts:1088-1130,1291-1356`. `target_platform=instagram` is also supported by this route. | Page upsert at `:1394-1426`; optional legacy IG auto-import at `:1437-1483`. SDK/provider-token compatibility actions also remain. | Captures `facebook_page` or `instagram_page_linked` attempt; Page commit can create/adopt a companion and bind both to the verified User grant. |
| Direct Instagram Business Login | Dialog's direct option; `useInstagramOAuth.ts:64-77,209-220` invokes `instagram-oauth`. | `instagram-oauth/index.ts:651-684` persists a legacy callback without trusted capability. | Signed lifecycle callback at `:612-647`, protected commit/permission evidence at `:449-490`, authorize selection at `:725-755`. Direct authority uses an Instagram token, not a Facebook User binding. |

These are two provider login families and multiple backend entrypoints; “OAuth attempt lifecycle” is the protected branch within those entrypoints, not a separate missing UI route.

**Why legacy still runs:** [protectedPageConnect.ts:143-206](../../../supabase/functions/facebook-oauth/protectedPageConnect.ts) selects protected behavior when global `credential_facebook_user_mode=protected`, when continuing an already captured attempt, or when an `authorize` caller is in `credential_facebook_user_protected_pilot_user_ids` under global `legacy`. Otherwise it calls `legacy()`. [protectedAccountCutover.ts:177-226](../../../supabase/functions/_shared/protectedAccountCutover.ts) treats absent/malformed/unreadable pilot membership as nobody. The production metadata and absence of recent attempts are consistent with ordinary customers being outside that selection. Exact flag values, deployed drift, or a historic rollback are not supplied; do not claim a rollback occurred. Source proves the route is wired and gated, not that its current deployed flag was read here.

Already protected accounts remain protected for consumers through per-account authority ([protectedAccountCutover.ts:142-171](../../../supabase/functions/_shared/protectedAccountCutover.ts)); removing a pilot UUID does not downgrade them. Captured callbacks continue their lifecycle after a flag change. Unsupported SDK/provider-token-only actions cannot substitute for a captured attempt ([protectedPageConnect.ts:91-126](../../../supabase/functions/facebook-oauth/protectedPageConnect.ts)).

**Which customers hit which:** supplied evidence proves Noor uses the legacy Facebook Business path and the pilot used lifecycle. Twenty-two active accounts lack capabilities; this alone does not prove all 22 have the same login kind or token source. Inventory must classify every one; never relabel a direct token as a User token.

### 2.2 Refine the “only writer” finding

The absolute claim is **refuted**. [20261026140000…sql:1394,1679](../../../supabase/migrations/20261026140000_facebook_user_credential_bindings.sql) defines `write_instagram_account_capability`, including an INSERT when absent; credential/reconnect compatibility writers also update capabilities. [pageLinkedInstagramPermissions.ts:22,73-101](../../../supabase/functions/_shared/pageLinkedInstagramPermissions.ts) actively calls that writer after lifecycle commit to establish permission evidence. The lifecycle bump first inserts `unknown`, clears scopes and advances generation, not `ok` ([20261027110000…sql:2759-2810](../../../supabase/migrations/20261027110000_meta_oauth_attempt_lifecycle.sql)).

The operational diagnosis **is supported**: the normal legacy saver never bootstraps trusted state; the protected commit calls `meta_oauth_attempt_bump_instagram_capability`, creates/updates the protected grant/binding, then reads permissions. The latest commit replacement preserves that chain ([20261105140000…sql:1036-1120](../../../supabase/migrations/20261105140000_meta_oauth_page_only_reconnect_keeps_companion.sql)). The single production row's `oauth_lifecycle_commit` reason matches that chain. Metadata permission reads in the legacy saver are best effort and do not establish trusted state. Repeating that same reconnect cannot repair missing capability/binding.

## 3. Admission requirements and actual failures

These stages are deliberately distinct; today's enqueue does not prove all worker prerequisites.

| Stage / requirement | Actual baseline outcome when missing | Customer implication / selected correction |
|---|---|---|
| Owned active target | Missing/foreign target is indistinguishable not-found; inactive target refused. | Preserve non-enumerable 404, never reveal another owner. |
| Master enabled and complete valid rollout policy | `collection_disabled` or `settings_unavailable`; excluded owner gets `collection_not_eligible` before capability/throttle. | Not enabled or temporarily unavailable; no reconnect advice. |
| Capability row with generation | Owner enqueue checks row plus non-null generation only. Absent gives `reconnect_required`, HTTP 409; policy exclusion is HTTP 403. | Current raw code overstates reconnect need. Classify bootstrap eligibility first; missing trusted state can be repaired internally. |
| Claimed context | Claim binds live login kind/generation. Old jobs without context previously abandoned as `context_missing`; latest claim settlement records `capability_missing`. | Do not present old job history as current credential diagnosis. |
| `permission_read_state=ok`, matching generation/login/lease | Provider/write fences refuse unknown/failed permission authority. Dedicated settlement records unavailable `capability_missing`; no provider request. | Verification pending/unavailable, not a proven denied scope. |
| Page-linked protected User grant | Owner-scoped binding must resolve `credentialKind=facebook_user`, token, credential ID/revision and matching capability generation. Missing/expired grant produces retry `credential_unavailable`; stale generation abandons `credential_changed`. | Internal bootstrap if verified stored User token exists; reconnect only for unusable/missing grant after supported repair assessment. Page token is not a fallback. |
| Nonempty `platform_user_id` | `readOwnerTarget` throws `invalid_envelope`; worker treats store failure as failed work, not verified permissions denial. | Account identity repair required; do not invent a provider ID from username. |
| Direct authority | Uses `read_instagram_direct_collection_credential`, matched job/lease/generation/IG identity; direct missing authoritative `instagram_business_manage_insights` yields `direct_login_unsupported`. | Direct login can collect owner insights when supported; never use as Business Discovery viewer. Refine raw legacy reason into an honest supported-feature/permission state. |
| Provider refusal after authority | Code 190 becomes `token_invalid`; true permission refusal becomes `scope_missing`; rate limit becomes `rate_limited`; retryable provider/storage failures stay separate. | Only current verified token failure warrants reconnect. Only positive permission denial warrants permissions-missing. |

Sources: [owner enqueue migration:63-128](../../../supabase/migrations/20261104150000_instagram_owner_enqueue_reconnect_required.sql), [handler.ts:1173-1188](../../../supabase/functions/instagram-insights-sync/handler.ts), [workerStore.ts:970-1089](../../../supabase/functions/instagram-insights-sync/workerStore.ts), [worker.ts:1553-1760](../../../supabase/functions/instagram-insights-sync/worker.ts), [rollout fence SQL:915-1040](../../../supabase/migrations/20261031090000_instagram_collection_rollout_controls.sql), [context settlement SQL:90-180,488](../../../supabase/migrations/20261105200000_instagram_context_missing_settlement.sql).

Generation zero is possible in older capability primitives; non-null at enqueue is weaker than the worker's integer generation >=1 check. Bootstrap must establish >=1. `permission_read_state=ok` is authority provenance, not proof every endpoint/metric is supported. No current token expiry or metadata scope list overrides these fences.

**Minimal safe path:** prove existing stored credential identity and Page/IG relationship; install a fenced protected binding plus positive generation; perform a complete fresh permission read on that generation; admit the named account under rollout; enqueue normally and run bounded worker; verify durable legacy owner measurements and report output. If safe stored authority cannot be recovered, use the repaired lifecycle reconnect once. Adding an allowlist UUID alone is insufficient.

## 4. Selected implementation design

### 4.1 Alternatives and recommendation

1. **Selected: controlled credential bootstrap plus lifecycle for new connections.** More migration/security work, but repairs recoverable accounts without customer consent loops and closes the recurring gap.
2. Require every legacy customer to reconnect through lifecycle. Simpler bootstrap surface, but unnecessary friction for valid stored User grants; retain only as exception path.
3. Synthesize capability from metadata or let collectors use operational Page tokens. Reject: bypasses permission provenance, grant type and fencing, and still does not solve Facebook admission safely.

### 4.2 Bootstrap boundary, evidence, and state machine

Add a small server-owned bootstrap use case with database ports, provider verification adapter and strict handler. Keep it separate from report reads and ordinary collection workers. **All names in this subsection are proposed, absent at baseline:** `analytics_legacy_bootstrap_enabled` default false; `analytics_legacy_bootstrap_policy` with explicit account allowlist and request budget; `analytics_legacy_bootstrap_jobs` durable service-only jobs; `begin_analytics_legacy_bootstrap` and `commit_analytics_legacy_bootstrap` service-only RPCs. No operator may call these until the implementing migration and deployed contract are verified. No general raw-token endpoint is added.

Jobs record owner/account, platform/login family, state (`pending`, `verifying`, `permission_pending`, `ready`, `needs_reconnect`, `permissions_missing`, `retry`, `blocked`), lease/revision, input fence, sanitized reason, attempts, next retry and audit correlation. RLS on; revoke anon/authenticated table and RPC access; structural composite owner keys; controlled search path. Privileged operation derives owner from the account; ordinary users cannot nominate another owner's credential or submit token/evidence payloads.

Selected bootstrap policy shape is `{"version":1,"account_ids":[],"max_accounts_per_run":5,"max_attempts_per_account_per_day":3}`. The empty list admits nobody; UUID duplicates, unknown keys, invalid types or limits above these initial ceilings refuse activation. A missing/false master is off; unreadable/malformed enabled policy is unavailable. Begin accepts only an account UUID already in that policy and an idempotency key; it derives owner, source credential and all captured versions. Its secret-bearing executor projection is service-only and cannot be returned by the HTTP handler. Commit accepts the opaque capture/lease identity and validated verification evidence, never a caller-selected destination owner or replacement token. The database rechecks current policy, capture expiry and full fences. Stop after durable installation if the policy is revoked before permission completion; report permission pending until a newly authorized repair can resume.

Process each of the 22 missing-capability accounts and any later gaps:

1. **Inventory, no secrets returned.** Read login family candidates, active/reauth status, provider IDs, protected authority, account version and presence/type of possible stored credential. Metadata flow is a hint, not authority. Existing valid protected binding is preferred and never overwritten by bootstrap. A present capability with failed permissions takes permission refresh, not generation reset. Classify direct accounts separately.
2. **Capture before network.** Lock parent accounts in stable UUID order, then existing account/capability advisory locks, then credential locks in established order. Capture absence/existing binding, credential revision, connection-fence version, capability absence/generation, account identity/active/health, and exact relevant secret/version fingerprint internally. Existing `updated_at` alone is not a sufficient fence against a token write that omits it. A new bootstrap capture must compare a digest of relevant fields under lock at commit; never expose token-derived digests to clients/logs. Capture the complete bound set for any shared credential operation; bootstrap should attach without replacing a shared grant.
3. **Find a real stored User token.** For page-linked legacy IG, check an existing same-owner protected User grant; otherwise inspect the same-owner linked Facebook Page's server-side `account_metadata.user_token` as a candidate. Noor's IG row stores a Page token; its metadata scopes cannot recreate the User token. Expired OAuth pending selections are not durable authority and must not be revived. No cross-owner lookup/deduplication and no token equality as identity proof. Missing candidate means `stored_user_credential_missing`, eligible for repaired reconnect; count it explicitly rather than promising all 22 are repairable.
4. **Verify with Meta, within budget.** App-authenticated token inspection must establish token is a valid User token for the configured app and provider user, including expiry/data-access constraints. With that token, prove `/me` User identity and enumerate authorized Pages, then the exact Page's linked Instagram identity; compare canonical IDs with the captured owned account and same-owner Page. Validate pagination/host/size/timeout; a partial page list, wrong app, Page-token candidate or mismatched IG ID is not proof. Do not request publishing, messaging or consent changes. Treat provider code 190, permission denial, wrong app/identity, rate/network failure and malformed response separately. Configured-version compatibility remains live gate G-L.
5. **Atomic install from verified evidence.** Reacquire captured locks; reject stale/expired capture, logout/reconnect/disconnect, changed source token, new binding/capability, or expired bootstrap lease. Install/attach protected User credential, verified Page/IG binding and monotonically allocated connection fence, capability `page_linked` generation >=1 with `unknown` permission state, and a receipt/audit in one transaction. Preserve operational Page token, account UUID/profile, health and publishing history. Never label this as a new `oauth_exchange` or `token_refresh` if neither happened.
6. **Read permissions after install.** The grant's installation time starts the new generation; run a fresh complete permission read after that commit so `scopes_read_at` is newer than `credential_updated_at`. Reuse/refactor the strict bounded reader from `pageLinkedInstagramPermissions.ts:145-185`, rather than the legacy best-effort parser. Commit only on the captured binding/revision/connection version/generation; failed read is failed/unknown, never authoritative empty scopes. Successful empty list is authoritative missing permission. Preserve existing monotonic successful evidence on a later transient failed read while reporting its latest failure separately. Ready requires confirmed `ok` and feature-required scope evidence, not merely a successful binding RPC.
7. **Reconcile, do not blindly replay.** Lost commit response queries the durable job/receipt by idempotency key; stale results are discarded, then reread only on a new bounded attempt. Installation never auto-enqueues analytics. Rollout admission remains independent. All refusal/early-return paths write sanitized audit or report audit failure explicitly.

**Provenance gap must close in the same phase:** current credential provenance enums and binding evidence allow historical migration/compatibility labels and `oauth_exchange`/`token_refresh`; Facebook authority accepts only the latter two ([credential SQL:297-365,456-481](../../../supabase/migrations/20261026140000_facebook_user_credential_bindings.sql), [history SQL:489-515](../../../supabase/migrations/20261101130000_meta_owned_analytics_history.sql)). Add a narrowly scoped `verified_legacy_bootstrap` provenance with verification timestamp and evidence receipt. Update relevant constraints, protected readers, status projections, OAuth/refresh captured-authority validators and Facebook analytics authority to recognize only a fully verified bootstrap binding. Search all evidence-source consumers at implementation; do not weaken them to accept compatibility rows. Grant existing primitives no new browser permissions. Prefer a dedicated atomic wrapper over a sequence of capability/bind RPCs; do not invoke the lifecycle bump outside its captured attempt or fabricate an OAuth receipt.

For direct legacy accounts, verify the direct token and canonical IG identity with its configured app/host, mint the trusted direct capability and generation under the same capture rules, then obtain authoritative direct permission evidence. Keep the direct token in its existing protected operational transport; no Facebook binding. If the supported direct permission/identity proof cannot be obtained, return an explicit supported reconnect path, and retain the separately approved Page-linked rollout until direct G-L evidence exists. Never silently exclude direct accounts from “all eligible.”

### 4.3 Rate, retry, and abuse controls

Selected bootstrap defaults are initial safety limits to be validated, not provider quota claims: one global bootstrap worker, one grant at a time, one account install at a time; at most five candidate jobs per invocation and 40 seconds total. Share provider usage/backoff accounting by app and verified grant with collection/discovery, so 23 accounts sharing a grant do not each get a fresh budget. Cache a permission read only across the identical captured grant/revision during that bounded run; commit per-account fences independently. Reuse the four-page/100-per-page/8-second permission reader ceiling; truncated reads are unavailable.

At most three retryable verification attempts per account per 24 hours with durable exponential backoff and jitter; obey longer provider retry/usage pauses. Permission denial or invalid token is terminal until a new generation or an explicit supported repair. No retries for indeterminate mutations before reconciliation. Customer Sync now must not bypass bootstrap or create a verification storm. Stop bootstrap on a token leak, ownership/identity breach, unexpected shared-grant mutation, missing audit or repeated app mismatch; pause on rate/budget exhaustion. Keep paid fallback disabled.

### 4.4 New connections and reconnects

Add a **proposed**, separate server connect-routing control `meta_oauth_lifecycle_rollout_policy` (`off`, named users, `all`), default off; keep global `credential_facebook_user_mode=legacy`. Expand supported `authorize` selection to use this control and existing protected account monotonicity; do not set global protected mode just to make new customers collect. Invalid/unreadable control must fail a selected lifecycle start explicitly rather than silently produce a new legacy connection. While the default is off, existing legacy behavior remains documented until rollout; `all` is the final default for supported new browser connects after gates.

Use exact proposed shape `{"version":1,"mode":"off","user_ids":[]}`; mode is `off|allowlist|all`, at most 500 unique UUIDs, and all requires an empty list. The existing pilot user list remains an enrollment source during transition; do not remove its users or in-flight protections. A failed read of the new control cannot distinguish a selected caller safely, so refuse new supported authorize starts with configuration unavailable until repaired; existing captured continuations remain governed by their own attempt. Do not fall back to legacy on a control read error.

Wire the existing dialog/hooks and all three backend entrypoints through captured begin/claim/complete/commit; test actual handlers and picker contracts. Preserve current opaque `attempt_id`/`selection_key` transport; no browser tokens. Protected Facebook Page commit must bootstrap its linked IG companion and run the companion permission reader. Return connection success separately from `analytics_readiness` (`ready`, `verification_pending`, `permissions_missing`); permission read failure must not pretend consent is missing or replay account creation. Schedule bounded permission completion through the durable repair queue.

Inventory every compatibility action (`list_pages`, `store_account`, standalone `store_instagram`, unsigned callback). Do not quietly let one create new legacy gaps after lifecycle `all`. Route supported browser consumers first; explicitly refuse unsupported raw-token creation for covered users with `supported_connect_required` and a safe reconnect URL/route. Preserve already in-flight legacy picker sessions until a bounded expiry or require restart with a precise message; never reinterpret them as captured attempts. Test Page-only reconnect preserving an existing companion and identity aliasing/rebind behavior. Final invariant: every successful supported new IG connection has trusted capability with positive generation and, if Page-linked, protected verified binding; permissions can remain pending but cannot remain silently untracked.

Rollback turns off new lifecycle enrollment for unprotected users; in-flight attempts and existing protected accounts remain lifecycle/protected. Do not revert to a runtime that lacks protected readers or writer fences.

## 5. Honest report, UI, and API/MCP contract

### 5.1 Current misleading behavior

[reportStore.ts:148-161](../../../supabase/functions/instagram-insights-report/reportStore.ts) maps `capability_missing` to `scope_missing`, and credentials/context/direct unsupported to reauth. At `:192-199`, any last attempt can yield partial freshness without saved data. [formatters.ts](../../../src/features/instagram-insights/domain/formatters.ts) turns the former into a permissions/reconnect hint. The owner report reads `instagram_collection_jobs` and legacy owner measurement tables through [read_instagram_owner_report_snapshot:338](../../../supabase/migrations/20261104130000_instagram_owner_period_reach.sql). Empty `ig_analytics_captures`/`ig_analytics_report_state` from the newer Meta-owned pipeline do not prove the legacy report has no jobs. The reported 5 November attempt must be correlated with those legacy jobs; if absent, investigate deployed drift/account selection/cache. Do not delete history to remove an old warning.

### 5.2 Canonical readiness versus stored data

Extend the owner snapshot RPC in a **new migration**, then report contracts/assembler, proxy and UI. The read is database-only, one consistent owner-scoped snapshot; it never probes Meta, writes a bootstrap job, mutates settings or returns policy lists/credentials. Reuse SQL policy evaluation internally rather than duplicate it in React. Foreign/missing account stays 404.

Add versioned `collection` with `state`, `reason_code`, `reason_source`, `observed_at`, `next_action`, `reconnect_can_help`, nullable `retry_at`, and an opaque support correlation ID. Separate `connection`, `permission`, `data` and dated `last_attempt` evidence. Effective collection reason precedence: unavailable configuration/read; disabled/excluded policy; identity/account state; recoverable bootstrap; proven unusable credentials; authoritative missing permissions; queued/running/retry; data readiness. Retain the underlying independent states, so policy exclusion can coexist with verification-needed without confusing them. Read failure is unavailable, never empty/denied.

| Stable proposed reason | Visible state and copy | Action / reconnect |
|---|---|---|
| `collection_disabled`, `collection_not_eligible` | **Not enabled:** “Analytics collection is not enabled for this account yet.” | `contact_support`; reconnect false. |
| `bootstrap_required`, `permission_verification_pending` | **Preparing analytics:** “We are verifying this connection for analytics.” | `wait`/support; reconnect false while recoverable. |
| `stored_user_credential_missing`, `token_invalid`, verified expiry/revocation | **Needs reconnect:** “Connect again to restore analytics access.” | `reconnect` only when repaired route is available and will create required authority. |
| `permission_missing` | **Permissions missing:** name only required feature permissions verified missing for current grant. | `grant_permissions` through supported consent; reconnect_can_help true only if that flow can actually request them. |
| `app_mismatch`, `identity_mismatch`, `account_identity_invalid` | **Connection needs review:** “We could not verify this connection.” | support/configuration repair; no generic reconnect unless diagnosed as actionable. |
| `queued`, `running`, `awaiting_first_capture` | **Syncing:** distinguish queued from actively collecting; no completion promise. | `wait`, poll existing DB job status with bounded backoff. |
| `rate_limited`, `provider_error`, `settings_unavailable`, `audit_unavailable` | Retry/unavailable with exact retry time when known. | `retry_after` or support; reconnect false. |

Keep raw worker `scope_missing` only in dated historical/raw evidence or positive provider permission failures; normalize new public reason to `permission_missing` with provenance. Missing capability never maps to missing scope. Existing fields remain additive for compatibility, but their derived freshness/partial values must be corrected immediately. Version the contract if a closed enum consumer cannot accept additions.

`data.state` is `empty`, `partial`, `complete`, or `stale`, with counts of real persisted observations, requested-period coverage and last successful capture. “Partially synced” requires saved relevant observations AND incomplete coverage; attempt-only history is empty with current collection status. Zero is a measurement, null is unavailable. No blanket 48-hour provider-lag banner before the first successful measurement; show provider windows only for metrics whose capture evidence supports it. Preserve saved reports when collection is disabled and show last data timestamp independently. Update English/Arabic translations and report export consumers without changing architecture direction (`ui → application → domain`, database gateway in infrastructure).

### 5.3 Agent tools

Actual chain: `mcp/index.ts:492-567` → `n8n-api` analytics routes → `serviceProxy.ts:472-580` → owner report/sync or Meta-owned report/sync; `analyze_brand` invokes the separate public discovery path. Keep MCP `posts:read`/`posts:write` authorization distinct from provider grants. Current MCP success is based only on HTTP status, so Facebook HTTP-200 `ok:false` can be misclassified ([owned sync handler:87-113](../../../supabase/functions/meta-owned-analytics-sync/handler.ts)).

Add shared runtime output schema and MCP `structuredContent` plus matching readable text. Preserve old successful payloads additively. A requested mutation refusal is `isError:true` even if legacy transport returned HTTP 200; a readable report with unavailable metrics is a successful read with explicit collection state. Unknown/malformed results are unavailable, never queued. Keep transport status, `ok`, `reason_code` and status coherent through the actual proxy chain.

For example, a future normalized sync refusal is `{"contract_version":2,"ok":false,"accepted":false,"queued":false,"status":"not_enabled","reason_code":"collection_not_eligible","reason_source":"rollout_policy","next_action":"contact_support","reconnect_can_help":false,"retry_at":null}`. A successful competitor save can simultaneously return `saved:true` and `collection:{queued:false,reason_code:"page_linked_viewer_required"}`; tool success describes the save and must not claim collection succeeded. Correlation identifiers are opaque, with no credential identity or policy lists embedded.

| Tool | Required result |
|---|---|
| `get_account_analytics` | Current readiness plus stored data coverage, timestamps/source, unavailable metrics with reasons, account/period pagination scope. No network collection. Never infer permissions from missing measurements. |
| `trigger_analytics_sync` | `accepted`, `queued`, current job state/ID when safe, exact reason/source/action/retry. Queued is not collected; already-complete day is not forced fresh. Instagram raw `collection_not_eligible` remains stable across proxy, with no reconnect hint. Normalize Facebook `ok:false` body semantics. |
| `track_competitor` | `saved`, `operation` (`created`, `already_tracked`, `reactivated`), owned watchlist ID, effective quota and a separate `collection` receipt. Selected behavior: bounded best-effort guarded initial enqueue after durable save, matching browser intent. Enqueue failure never rolls back a successful save or returns false “queued”; uncertain enqueue returns `indeterminate`, reconciled by natural key. No provider calls in track. |
| `list_competitors` | Actual owned active/removed entries, saved/capture/job states, current eligibility/viewer reason and quota independent of page size. Follow bounded cursor; empty list is not tool unavailability. |
| `analyze_brand` | Explain it is immediate official public Facebook/IG discovery, independent of stored watchlist history; return actual viewer/configuration/refusal, provenance/capture time/coverage. No private competitor reach/saves/audience promises, paid fallback or fabricated baseline. Mark external captions/profile text untrusted. |

Competitor `all` with empty targets admits targets by policy; it does not provide a usable viewer. [competitor store:967-1045](../../../supabase/functions/competitor-snapshot-sync/store.ts) still requires same-owner active non-reauth Page-linked trusted capability, authoritative scope and protected User credential. Direct-only customers get `page_linked_viewer_required`, with supported connection action, not repeated reconnect of an already direct account. Owner collection membership and viewer eligibility are independent.

Do not state “20 competitors” as a platform constant. Effective quota is override → active/past_due plan → free/default 5; admin boundary/unlimited `-1` applies ([tracking schema:943-1020](../../../supabase/migrations/20261026130000_instagram_insight_tracking_schema.sql)). Return `max_tracked_competitors`, `unlimited`, `tracked_active`, `remaining`; verify Noor's actual value at read time. Username-only tracking is Instagram, normalized 1–30 characters, no URLs/consecutive periods; list/report page size 1–50 is not plan quota. Competitor historical reports support 7/30 days; owner IG periods and Facebook/Threads periods differ as documented in [analyticsToolSchemas.ts:1-44](../../../supabase/functions/_shared/analyticsToolSchemas.ts) and MCP registry. First capture is after a successful run, not guaranteed in one or two days; growth requires real baselines and coverage. Do not invent history before collection.

## 6. Facebook: identify the first failed stage before repair

Facebook is independent: `collection_facebook_analytics_enabled` plus `collection_facebook_analytics_policy={"account_ids":[...]}`. Baseline supports at most 100 IDs, no `mode:all`; empty admits nobody ([worker progress SQL:4-41](../../../supabase/migrations/20261101141000_meta_owned_analytics_worker_progress.sql)). Noor's missing metadata scopes do not explain this collector: it uses protected User token inspection plus operational Page identity, requiring both `read_insights` and `pages_read_engagement` ([permissionProvider.ts:22-112](../../../supabase/functions/meta-owned-analytics-sync/permissionProvider.ts)).

Order: configured flag/list → policy enumeration/sweep ticket → prepare/authority → live admission permission observation → daily job → claim → operations/inventory/checkpoints → received captures → saved report. Missing binding can refuse before report-state insertion; a cron definition alone proves none of these ran. Current authority needs same-owner active Page, operational token, connection-version fence, verified provider user and live protected credential ([history SQL:489-515,598-675](../../../supabase/migrations/20261101130000_meta_owned_analytics_history.sql), [admission SQL:4-49](../../../supabase/migrations/20261101140000_meta_owned_analytics_worker_admission.sql)). Daily dispatch uses a current Los Angeles-day observation with matching authority; IG collection capture dates are Kuwait dates.

**Selected repair ladder:** correct confirmed settings/exclusion through approved explicit Page allowlist; if authority missing, use the same verified bootstrap with Facebook-compatible provenance; if no recoverable User token, repaired lifecycle Page reconnect; if app/identity failure, repair configuration/linkage first; if true missing permission, request that permission through supported consent; if dispatch/worker failure, repair that stage with durable retry and preserve measurements. Never copy metadata scopes or reuse a Page token as permission-token authority. Keep existing list policy for current Facebook scale; before >100 eligible Pages, separately implement/review scalable all/allowlist semantics with equivalent request/write fences. No unsupported `all` JSON in today's operator instructions.

### 6.1 Exact read-only query pack (future authorized operator)

These queries are **not executed by this task**. Run only on Postora's authorized Contabo database route with catalog-owner read permission. They deliberately do not call `prepare_*`, credential readers, admission/enqueue/claim RPCs, or VOLATILE policy evaluators: those may mutate or return secrets even when called with SELECT. Keep output private and bounded. No `SELECT *` against account/credential/capture/log tables. Check schema existence with Q0; a missing object is the first catalog gap, not “zero rows.” Run each diagnostic transaction with `BEGIN READ ONLY; SET LOCAL statement_timeout='10s';` and finish `ROLLBACK;`. If a query times out, report unknown and narrow it; never treat it as empty.

Q0 — deployed database inventory and function identity. Compare definitions/hashes privately with the immutable release manifest; do not print credential-bearing function results.

```sql
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       p.provolatile, p.prosecdef,
       md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
 'enqueue_instagram_collection_job_for_user','authorize_instagram_collection_provider_call',
 'get_instagram_collection_rollout_policy','set_instagram_collection_rollout_policy',
 'prepare_fb_analytics_account','meta_analytics_current_authority',
 'read_fb_analytics_admission_credential','next_meta_analytics_dispatch_target',
 'commit_meta_analytics_dispatch_target') ORDER BY p.proname,args;
SELECT table_name,column_name,data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name IN (
 'facebook_user_credentials','facebook_user_credential_bindings',
 'facebook_user_credential_connection_fences','instagram_account_capabilities',
 'fb_analytics_report_state','fb_analytics_permission_observations',
 'meta_analytics_enqueue_sweeps','fb_analytics_collection_jobs',
 'fb_analytics_collection_operations','fb_analytics_collection_checkpoints',
 'fb_analytics_captures') ORDER BY table_name,ordinal_position;
```

Q1 — exact nonsecret controls. Absent rows must be reported as absent. Pilot user lists are restricted operator data, never customer output.

```sql
SELECT key,value,updated_at FROM public.app_settings WHERE key IN (
 'collection_instagram_insights_enabled','collection_instagram_rollout_policy',
 'credential_facebook_user_mode','credential_facebook_user_protected_pilot_user_ids',
 'collection_facebook_analytics_enabled','collection_facebook_analytics_policy') ORDER BY key;
SELECT count(*) AS attempts, min(created_at),max(created_at) FROM public.meta_oauth_attempts;
```

Q2 — all active Instagram readiness, without secrets. Raw eligibility still requires the real SQL fences; booleans here are evidence, not a grant.

```sql
SELECT a.id,a.user_id,a.platform_username,a.platform_user_id,a.needs_reauth,
 a.token_expires_at,a.connected_at,
 a.account_metadata->>'flow' AS legacy_flow,
 a.account_metadata->>'token_type' AS legacy_token_type,
 c.login_kind,c.permission_read_state,c.credential_generation,c.generation_reason,
 c.scopes_read_at,c.last_read_failed_at,
 COALESCE(c.granted_scopes @> ARRAY['instagram_manage_insights']::text[],false) AS page_insights_scope,
 COALESCE(c.granted_scopes @> ARRAY['instagram_business_manage_insights']::text[],false) AS direct_insights_scope,
 b.credential_id,b.connection_version,f.connection_version AS fence_version,
 b.evidence_source,
 (b.verified_facebook_user_id=g.provider_user_id) AS user_identity_matches,
 g.revision,g.lifecycle,g.token_expires_at AS user_token_expires_at,
 (NULLIF(btrim(g.token),'') IS NOT NULL) AS protected_token_present
FROM public.social_accounts a
LEFT JOIN public.instagram_account_capabilities c ON c.social_account_id=a.id AND c.user_id=a.user_id
LEFT JOIN public.facebook_user_credential_bindings b ON b.social_account_id=a.id AND b.user_id=a.user_id AND b.platform=a.platform
LEFT JOIN public.facebook_user_credential_connection_fences f ON f.social_account_id=a.id AND f.user_id=a.user_id AND f.platform=a.platform
LEFT JOIN public.facebook_user_credentials g ON g.id=b.credential_id AND g.user_id=b.user_id
WHERE a.platform='instagram' AND a.is_active ORDER BY a.user_id,a.id;
```

Q3 — Noor Page identity, token presence, credential lifecycle/fences. Restrict both UUIDs AND owner; never return token text, whole metadata or whole authority JSON.

```sql
SELECT a.id,a.platform_user_id,a.is_active,a.needs_reauth,a.token_expires_at,
 (NULLIF(btrim(a.access_token),'') IS NOT NULL) AS operational_token_present,
 (NULLIF(btrim(a.account_metadata->>'user_token'),'') IS NOT NULL) AS legacy_user_token_candidate_present,
 b.credential_id,b.connection_version,f.connection_version AS live_fence,
 b.evidence_source,b.verified_facebook_page_id,b.verified_facebook_user_id,
 g.revision,g.provider_user_id,g.lifecycle,g.provenance_source,
 g.token_expires_at AS user_token_expires_at,
 (NULLIF(btrim(g.token),'') IS NOT NULL) AS protected_user_token_present
FROM public.social_accounts a
LEFT JOIN public.facebook_user_credential_bindings b ON b.social_account_id=a.id AND b.user_id=a.user_id AND b.platform='facebook'
LEFT JOIN public.facebook_user_credential_connection_fences f ON f.social_account_id=a.id AND f.user_id=a.user_id AND f.platform='facebook'
LEFT JOIN public.facebook_user_credentials g ON g.id=b.credential_id AND g.user_id=b.user_id
WHERE a.user_id='1870eed2-8353-4991-86d8-1d92c429dd3e' AND a.platform='facebook'
AND a.id IN ('6f999090-58f5-42af-a58d-57700d3a4d3a','06168394-6e00-4c17-a17d-86d10e86335b') ORDER BY a.id;
```

Q4 — Facebook prepare, permission, sweep outcomes. A recent verified observation must match CURRENT identity/revision/fence, not merely exist. The authority fields below are nonsecret version fields; inspect no arbitrary JSON body.

```sql
SELECT social_account_id,credential_guarded,report_revision,updated_at
FROM public.fb_analytics_report_state
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e';
SELECT social_account_id,state,granted_scopes,observed_at,source_ref,
 authority->>'credential_id' AS credential_id,
 authority->>'credential_revision' AS credential_revision,
 authority->>'connection_version' AS connection_version,
 authority->>'platform_user_id' AS page_id
FROM public.fb_analytics_permission_observations
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e';
SELECT s.due_on,s.policy_digest,s.dispatch_round,s.complete,s.last_account_id,s.updated_at,
 e.key AS account_id,e.value->>'outcome' AS outcome,e.value->>'reason' AS reason,
 e.value->>'job_id' AS job_id
FROM public.meta_analytics_enqueue_sweeps s
LEFT JOIN LATERAL jsonb_each(s.outcomes) e ON e.key IN (
 '6f999090-58f5-42af-a58d-57700d3a4d3a','06168394-6e00-4c17-a17d-86d10e86335b')
WHERE s.platform='facebook' AND s.due_on>=current_date-7
ORDER BY s.due_on DESC,s.updated_at DESC LIMIT 50;
```

Q5 — distinguish job, operation, inventory and received measurement stages. Job/operation success without received captures is insufficient. Do not print claims, inventory cursors, post text or capture payloads.

```sql
SELECT id,social_account_id,due_on,job_generation,state,attempts,retry_at,
 lease_until,last_success_at,last_partial_at,reason_code,updated_at
FROM public.fb_analytics_collection_jobs
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e'
ORDER BY due_on DESC,social_account_id LIMIT 100;
SELECT social_account_id,job_id,job_generation,kind,state,reason_code,count(*)
FROM public.fb_analytics_collection_operations
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e'
GROUP BY social_account_id,job_id,job_generation,kind,state,reason_code
ORDER BY job_id,kind LIMIT 200;
SELECT social_account_id,job_id,job_generation,pages_fetched,
 inventory_complete,inventory_truncated,cardinality(post_ids) AS post_count,updated_at
FROM public.fb_analytics_collection_checkpoints
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e' ORDER BY updated_at DESC LIMIT 100;
SELECT social_account_id,kind,count(*) AS requests,
 count(received_at) AS received,max(received_at) AS latest_received
FROM public.fb_analytics_captures
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e'
GROUP BY social_account_id,kind ORDER BY social_account_id,kind;
```

Q6 — schedule execution and sanitized admission/refusal logs. Use existing request-correlation evidence to associate cron execution with actual HTTP completion; cron SQL success only means the HTTP request was submitted. HTTP response-table presence/retention is installation-specific; do not guess an RPC. If available, inspect only the correlated request ID/status code, not body/headers.

```sql
SELECT jobid,jobname,schedule,active FROM cron.job WHERE jobname IN (
 'facebook-analytics-enqueue-daily','facebook-analytics-drain',
 'instagram-insights-enqueue-daily','instagram-insights-drain',
 'competitor-snapshot-enqueue-daily','competitor-snapshot-drain') ORDER BY jobname;
SELECT j.jobname,d.runid,d.status,d.start_time,d.end_time
FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
WHERE j.jobname IN ('facebook-analytics-enqueue-daily','facebook-analytics-drain')
 AND d.start_time>=now()-interval '24 hours' ORDER BY d.start_time DESC LIMIT 100;
SELECT created_at,source,level,metadata->>'event' AS event,
 metadata->>'reason_code' AS reason_code,metadata->>'reason' AS reason,
 metadata->>'status' AS status,
 COALESCE(metadata->>'accountId',metadata->>'account_id',metadata->>'target_id') AS account_id
FROM public.system_logs
WHERE created_at>=now()-interval '7 days'
AND (user_id='1870eed2-8353-4991-86d8-1d92c429dd3e'
 OR COALESCE(metadata->>'accountId',metadata->>'account_id',metadata->>'target_id') IN (
 '6f999090-58f5-42af-a58d-57700d3a4d3a','06168394-6e00-4c17-a17d-86d10e86335b',
 '0415c97e-62c6-4c86-acbf-092aa7120d0e','fd85cc1d-6e55-4431-a89d-fdc905f69cea'))
ORDER BY created_at DESC LIMIT 200;
```

The following exact read-only discovery identifies whether pg_net's usual response relation is installed; it does not submit a request. If it exists with the listed columns, the second query is valid. Without a durable dispatch request ID these statuses are uncorrelated evidence only; add sanitized dispatch/request correlation in the relevant worker phase rather than guessing which response belongs to a customer.

```sql
SELECT table_schema,table_name,column_name,data_type FROM information_schema.columns
WHERE table_schema='net' AND table_name='_http_response'
AND column_name IN ('id','status_code','timed_out','created') ORDER BY ordinal_position;
-- Run only after the preceding catalog query confirms all four columns.
SELECT id,status_code,timed_out,created FROM net._http_response
WHERE created>=now()-interval '24 hours' ORDER BY created DESC LIMIT 100;
```

Q7 — legacy Instagram report evidence and true first measurements, including old attempts. These are the owner's real report tables; query newer `ig_analytics_*` separately if diagnosing that other pipeline.

```sql
SELECT social_account_id,id,captured_on,job_generation,status,last_attempt_at,
 last_success_at,last_partial_at,last_reason_code,retry_at
FROM public.instagram_collection_jobs
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e' AND target_kind='owner'
ORDER BY captured_on DESC,social_account_id LIMIT 100;
SELECT social_account_id,status,count(*) AS rows,
 count(reach) AS measured_reach,count(views) AS measured_views,max(captured_at) AS latest_capture
FROM public.ig_account_insight_daily
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e' GROUP BY social_account_id,status;
SELECT social_account_id,status,count(*) AS rows,
 count(followers_count) AS measured_followers,max(observed_at) AS latest_observation
FROM public.ig_account_profile_observations
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e' GROUP BY social_account_id,status;
SELECT social_account_id,status,count(*) AS rows,max(captured_at) AS latest_capture
FROM public.ig_media_insight_snapshots
WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e' GROUP BY social_account_id,status;
```

Pending/unavailable all-null rows are not numerical measurements. Inspect requested-period coverage and provider-specific unavailable reasons before declaring a successful capture. To verify the reported competitor limit without returning subscription/customer details, use the existing STABLE entitlement functions in the same read-only operator transaction:

```sql
SELECT CASE WHEN public.has_role('1870eed2-8353-4991-86d8-1d92c429dd3e'::uuid,'admin'::public.app_role)
 THEN -1 ELSE public.effective_competitor_quota('1870eed2-8353-4991-86d8-1d92c429dd3e'::uuid) END AS effective_limit,
 (SELECT count(*) FROM public.competitor_watchlist
  WHERE user_id='1870eed2-8353-4991-86d8-1d92c429dd3e' AND is_active) AS tracked_active;
```

Interpret Q1–Q7 in stage order. An excluding list is the first current failure even if credentials also need repair; record both. A passed prepare but no observation points to admission/app/provider; matching observation but no job points to dispatch/enqueue; job without claim/operations points to drain; operations/checkpoint without received capture points to provider/storage; real captures but empty report points to report assembly/selection. No query here proves live token validity or deployed Edge identity; those require separately authorized gate evidence.

## 7. Controlled rollout and real operator procedure

### 7.1 Policy setter discrepancy

Baseline has `ig_collection_rollout_normalize_policy`, internal evaluators, and an AFTER INSERT/UPDATE audit trigger, but no `get_instagram_collection_rollout_policy` or `set_instagram_collection_rollout_policy`. Internal helpers have revoked service RPC grants. The actual fingerprint hashes JSONB text; the spec's semantic array canonicalization/CAS/direct-write denial is not implemented ([rollout SQL:194-261,2402-2458](../../../supabase/migrations/20261031090000_instagram_collection_rollout_controls.sql); [rollout spec §2](../../specs/2026-10-30-instagram-collection-rollout-controls.md#2-server-owned-eligibility)).

**Selected:** close this gap before widening beyond the named pilot. New additive migration implements the specified getter and CAS setter, validated/canonical arrays, duplicate refusal, asserted actor/approval reference (nonblank <=200 characters), before/after server fingerprints and audit in the same transaction, plus denial of alternate writes/deletes. Malformed stored policy uses raw-fingerprint recovery while all collection remains refused. Test stale edit after rollback, missing key and malformed recovery, actual grants, and RC-17. Never edit R1 migration bytes. Update the real [rollout runbook](../../runbooks/instagram-collection-rollout.md), types and operator tests in that implementation phase.

Until then, an explicitly approved named pilot may use the real database settings path with **one operator transaction**: lock the existing `app_settings` row `FOR UPDATE`; compare exact reviewed old JSON and fingerprint; abort if stale/missing; replace only the complete `owners` member using `jsonb_set`, preserving version and competitors; require one affected row; set real operator `updated_by`; commit; fresh readback and verify the committed `rollout_policy_changed` audit. Preserve the old JSON, old/new fingerprint, actor, approval reference and time in the private release receipt, because the current audit stores only the new fingerprint and no approval reference. Do not delete/reinsert, blind upsert, invoke a nonexistent setter, or call the internal normalizer via a service RPC. After setter deployment use only its verified reviewed signature; unexpected direct-write denial means stop, not bypass.

### 7.2 Gates and expansion

All boxes remain unchecked in this design. Reconcile actual prior approval receipts instead of claiming none ever occurred or treating the current active schedules as proof of approval.

| Gate | Concrete required evidence / action |
|---|---|
| A / G-X | Complete assembled release, including G-D/G-O/G-C/G-R/G-S/G-U/G-E and required acceptance/dependency evidence; preserve the 1 November owner decision retaining complete G-X before owner pilot. No owner-only exception inferred. |
| B1 | Waleed approves exact immutable schema/runtime manifest and preflight; compare Q0, installed grants/definitions, release ledger and protected-compatible rollback. Apply separately approved additive migrations first; new jobs/flags default off. |
| B2 | Separately approve deploy of exact function import closures and frontend; verify hashes, boot/off-state and redacted errors. Merged functions are not automatically proof of deployment. |
| B3 | If existing pilot-user enrollment is used, separately approve exact users, keep global mode legacy. New lifecycle/bootstrap controls need equally explicit named activation approval; record the selected amendment to legacy-bootstrap coverage rather than pretending a reconnect happened. |
| C1 | Existing gate requires approved real reconnect/consent for each selected login type. Retain it for lifecycle verification. For no-reconnect bootstrap, Waleed must approve a concrete equivalent named stored-credential verification/installation action and acceptance evidence as an amendment; this spec does not waive C1 or fabricate consent. |
| C2/C3 | Separately approved login/session/refresh regression and exact harmless publishing test, including siblings/nonpilot; these are especially necessary because installing protected authority changes consumer selection. No post/test deletion implicit. |
| D1 | Server isolation and RC-01–RC-17 proofs, durable daily dispatch, protected/direct authority and current eligibility fences. Record which setter gap is still open if manual pilot procedure is used; it cannot be called RC-17 complete. Therefore an unresolved required RC-17 blocks D1 unless the owner explicitly amends the prerequisite. Recommendation: finish setter first. |
| D2 | Retain one-account-at-a-time manual proof. First `smartenergykw` (`0415c97e-62c6-4c86-acbf-092aa7120d0e`), then a separate scoped approval for `quality_light1` (`fd85cc1d-6e55-4431-a89d-fdc905f69cea`). Preserve the original `xsellpoint_kw` member; prove other targets receive no newly authorized calls. Two-account Noor pilot is the stage outcome, not a silent waiver of the single-account gate. |
| D3 | Separately reconcile/prove a named competitor target/viewer official journey, nullable metrics, coverage, no paid fallback and isolation. Existing competitors `all` is supplied state, not evidence D3 passed. Do not change it casually; reconcile exact prior approvals and seek a separate narrowing/continuation decision where needed. |
| E1 cohort | Approve explicit additional ready owners; selected next cohort: five ready legacy accounts spanning at least three other tenants and a shared-grant sibling case, chosen from Q2, plus direct login only after its separate live proof. Record named exclusion list/reasons. Competitors remain under their own approval; preserve their policy. |
| E2 | Separately approve exact schedules/cadences/capacity. IG source daily enqueue is 00:30 UTC and drain every two minutes; supplied schedules are already active, so reconcile receipts and observed executions rather than claiming “install inactive” happened now. Do not increase cadence. Complete pending sweeps across ticks, prove >25 owners/>50 competitors with synthetic scale where live population is smaller. |
| E1 all, then E4 | After pilot and cohort observations, separately approve owners `{"mode":"all","account_ids":[]}` including future otherwise-eligible accounts, and exact measured exclusions. Preserve `version:1` and competitors verbatim. Keeping IDs with all is invalid and can disable both populations. E4 accepts exact release evidence only after observation; global credential-mode change remains separate. |
| E3 | Retention dry-run approval followed by distinct deletion/activation approval, only if retention is changed; this fix does not add retention work or use cleanup to conceal failures. |

**Readiness before each stage:** Q0/Q1 deployed controls match manifest; Q2 each named IG has correct owner/identity, active health, permission state `ok`, positive matching generation, required feature scope and valid protected binding/fence (or direct fenced reader); bootstrap receipt audited; known-expired grant is excluded; no read failure treated as ready. Q3–Q6 separately for Facebook. Compare saved report and authenticated UI/MCP on the same account/period. Record exact before/after policies privately, account counts/exclusions, grant grouping, current queue ages, usage, worker/runtime hashes, approval/operator/time and rollback candidate. Never issue raw-token read RPCs as “readiness queries.”

**Observation selected:** at least 72 hours and three completed Kuwait daily capture cycles for the Noor stage and again for the cohort, before owners all. Manual D2 proof precedes separately approved scheduling. A cycle needs actual expected target jobs and saved observations or explicit provider-supported unavailable metrics, not only sweep completion. Every recoverable eligible account must reach a received measurement; persistent per-account failure remains an exclusion requiring a fix, not a success-rate rounding error. Track lag/backfill obligations separately; never invent pre-enrollment follower history. Facebook observations use its provider day separately.

### 7.3 Stops and rollback

Stop immediately on cross-owner data/provider access, leaked token, wrong identity/app proof, unexpected grant/sibling mutation, false success receipt, missing audit, or unapproved provider calls. Pause expansion on any unclassified bootstrap failure, newly growing backlog across two drain intervals without progress, rising expired leases, provider rate limiting, incomplete daily sweep at next capture-day boundary, missing receipts or inconsistent report/UI/MCP reasons. Selected rollout operating threshold: no increase to the next stage while any added target lacks its first measurement or documented provider-specific unsupported result; investigate provider usage at >=70%, stop new bootstrap at the worker's stricter applicable stop threshold or >=80% usage, whichever is lower. These are conservative operator thresholds, not Meta quota guarantees. Capacity owner records calls/grant/day and chooses any later increase through a new approval.

Rollback first pauses proposed bootstrap/lifecycle enrollment and affected collection schedules under the approved incident procedure; narrow affected population or turn master off if isolation/audit/security uncertain. Shared master affects competitors too, so record that impact. Preserve competitors when a safe owners-only narrowing suffices. Restore the reviewed last-good policy using fresh CAS (or locked comparison before setter), never a stale cached upsert; verify audit/readback. No credential deletion, generation decrement, protected-to-legacy downgrade, global credential-mode flip, forced queue purge, fabricated success or schema reversal. Saved data remain readable.

Per-request policy permits stop subsequent calls and write fences refuse now-ineligible results; already-sent HTTP calls cannot be unsent. Observe bounded requests and 120-second job leases settling; verify no new permits/captures before declaring quiescence. If uncertain keep master off and escalate. A pre-rollout worker is not a safe rollback binary. Resume only through renewed scoped approval, fresh readiness and exclusion proof. Bootstrap rollback leaves verified bindings in place for compatible consumers; if one is demonstrably wrong, revoke through the reviewed lifecycle incident path, not direct row deletion.

## 8. Independently mergeable phases

Each phase produces its own reviewed PR during later implementation; this design task opens none. Every implementation brief must require ARCHITECTURE.md §§1,4,12–17,23–28 and the relevant security/tenancy rules. No new helper ships without a reachable non-test caller. Migration applies and verifies before dependent runtime; copy reviewed function import closure from fetched commit, verify SHA256 and restart through the self-hosted deployment runbook. Frontend follows compatible backend; flags activate only after separate gates. Never deploy from a dirty server checkout or use Supabase Cloud deploy.

| Phase | Mergeable deliverable and flags | Required tests / evidence | Deploy order / rollback |
|---|---|---|---|
| 1. Truthful readiness | Additive snapshot contract, report reasons/data-state fix, UI translations, compatible MCP read projection. No collection activation. | Real SQL snapshot and proxy/UI tests for excluded+missing-capability+historical attempt, zero captures, genuine partial, denied vs unknown scopes, read failure, cross-owner 404 and cache/account switch. Prove reports never invoke Meta. | Snapshot migration/types first, report runtime/proxy, UI. Rollback to compatible report runtime retaining schema; avoid restoring misleading hints. |
| 2. Operator controls | Implement promised CAS getter/setter and direct-write restriction, actual runbook updates. Flags unchanged. | RC-17 two-session stale removal/edit, malformed recovery, ACLs, audit atomicity/failure and policy all/empty/duplicate tests; full relevant RC suite. | Migration and verified catalog first; operator tooling afterward. Retain setter on rollback, narrow through current CAS. |
| 3. Credential bootstrap | Add capture/job/provenance migrations, atomic install and bounded repair worker with live caller; both proposed bootstrap controls default off. Include Facebook authority recognition and direct adapter only where fully proven. | SQL races against reconnect/disconnect/token refresh, absent-to-present ABA, shared-grant set change, generation zero, failed/empty/truncated permission reads, wrong app/type/Page/IG, expired lease, lost reply, RLS/service impersonation, redaction and call budgets. Full credential/OAuth/refresh/publishing regression. | Constraints/ACLs/types before runtime; deploy closures with bootstrap off. Named action only after B/C readiness approval. Rollback disables worker; preserve verified authority and receipts. |
| 4. Lifecycle by default | New routing control default off, all supported hooks/entrypoints/pickers, companion permission completion queue, explicit compatibility refusal. | Real registered route → attempt → commit → binding/capability → permissions → collector/readiness. Both login families, fresh connect/reconnect/rebind, Page-only companion, stale callback, flag transition, pending legacy selection, declined scope and no browser token exposure. | Schema/control seed first, compatible OAuth and repair runtime, UI; named users then all supported connects after gates. Disable new enrollment only; preserve protected/in-flight flows. |
| 5. Agent actions | Shared result schema, semantic error handling, saved/queued competitor receipt, quota/hints/descriptions and official discovery provenance. | Actual MCP → API → function → SQL chain, HTTP-200 refusal, 403/409/429/503, unknown body, read vs mutation isError, quota override/admin/unlimited, created/already/reactivated, saved-but-refused/indeterminate enqueue, no-viewer, no scheduled paid call and prompt-injection text treated as untrusted. | Additive SQL receipt if needed first, API/shared closure then MCP. Keep saved status independent; disable optional initial enqueue if faulty without losing tracking. |
| 6. Activation and capacity | Named bootstrap/collection pilot, Facebook first-stage diagnosis and approved Page admission; cohort then owners all. No production switch enabled by merge. | G-X/RC and B–E ledger, Q0–Q7 baseline/readback, live configured Meta versions, three-cycle observations, zero unauthorized calls, fairness/backoff and rollback rehearsal. At larger scale include >25/>50 synthetic continuations, not only 23-account smoke test. | Approve and perform migrations/runtime before settings. Existing schedules reconciled, not silently reactivated. Reverse eligibility/enrollment first; retain additive schema/data. |

Phases 1 and 2 can be delivered before bootstrap and are useful independently. Phase 3 does not require routing all new connections; phase 4 uses the accepted repair boundary. Phase 5 can follow stable phase-1 output without waiting for owners all. No phase may declare end-to-end fixed before phase-6 measurement evidence. Production/test guards apply to later changed code/tests; this document receives docs-guard and spec self-review. Application suites are not evidence for a documentation-only change and were not run here.

## 9. Risks, exclusions, and completion criteria

- **Rate limits and cost:** account count is not call count. Backfill/lag repair, Page discovery pagination, per-media insights, shared User grants and interactive discovery compete for app/grant quota. Measure usage and calls, keep existing bounded claims/40-second workers, durable fairness, accepted-request throttle and no scheduled paid scraping. Stagger bootstrap from daily collection, cap retries and avoid bulk force. Do not promise 23+ accounts will fit until observations establish capacity; infrastructure/storage cost still exists without paid provider fallback.
- **Token handling:** legacy User-token candidates may be absent, expired, tied to another app or mutable through old writers. Bootstrap is a one-time privileged verification boundary with evidence fences, not permission to expand raw-token access. Never log/provider-body dump/copy tokens into reports, memory or this document. Internal snapshots/digests stay restricted. No weakening of protected consumers to “try metadata.”
- **Privacy/tenancy:** explicit same-owner Page/IG proofs and composite keys; do not merge grants across tenants even if provider identity/token matches. Minimize retained identity/evidence, keep existing retention policy, private operator receipts with opaque IDs rather than customer emails in public release notes. Competitor data remain public observations, not private insights.
- **Operational side effects:** installing protected authority changes refresh/publishing transport even if collection stays off. C2/C3 and a protected-compatible rollback are mandatory. Preserve account IDs, profile association, posting state and sibling grants. Current source/deployed drift must be reconciled before applying new migrations.
- **Unknowns that block the relevant gate:** exact deployed source/catalog and approvals; how many of the 22 have usable stored User/direct tokens; Noor's Page linkage/token app/type/expiry proof; direct provider permission/classification support; historical 5 November event; actual Facebook policy/admission failure; competitor watchlist/quota and current schedule receipts; live provider throughput. Each has a named diagnostic/proof above; none is silently assumed true.

Completion means every inventoried account has a durable disposition (`collecting`, specific permissions/reconnect action, supported-type exclusion, or operator repair with owner), every newly supported connect creates trusted authority, Noor's two ready accounts have saved measurements shown consistently across UI/report/MCP, Facebook's first failed stage is proven and repaired or explicitly blocked with evidence, and all eligible current/future owners are admitted under approved owners-all after observation. An excluded account is counted honestly; “all eligible” is never shorthand for “only the pilot works.”

## 10. Design verification record

Read supplied evidence including follow-up, prior report, architecture/workflow, release-gates and rollout controls; traced actual connect UI/handlers, replacement migrations, protected credential/permission readers, owner worker/report and MCP/proxy. Reviewed proposed versus existing symbols, operator query columns and links; preserved source-versus-production distinction. No production tool/provider call, deployment, code change, application test, reconnect or PR was performed. Later implementation and live gates remain required.
