# Owner analytics for all eligible customers

Date: 2026-11-14. Status: design recommendation; no implementation or production action performed.
Source baseline: `bc3479425cbf8312b5857ba9da9b493489e0cc70`, branch `investigate/noor-analytics`.

## 1. Outcome, authority, and evidence

**Owner decision, 2026-11-14: the required end state is Instagram owner collection enabled for ALL customers, with `collection_instagram_insights_enabled=true` and `collection_instagram_rollout_policy.owners={"mode":"all","account_ids":[]}`. Facebook owner analytics must reach the same all-customers enrollment end state through its independent controls. A pilot or a maintained customer allowlist is not a completed delivery.** Both populations include future customers automatically; each collection still requires valid owner/identity, supported account type, current permissions and protected credentials. Those prerequisites are safety checks, not a reason to leave rollout restricted to the pilot.

Every eligible existing or future customer must have a supported path from connection to durable analytics, without a hidden pilot dependency. A customer whose connection cannot collect must receive the current cause and an action that can resolve it. Enabling a policy is not evidence of collection. Success requires saved measurements, truthful report/UI/MCP output, scheduled continuation, and tenant isolation. **Bootstrap/backfill of all 22 currently missing-capability Instagram accounts precedes the owners-all policy flip.** Policy-only widening merely changes `403 collection_not_eligible` into `409 reconnect_required` and perpetuates wrong advice for internally repairable connections.

This task updates only this design document and its branch. The owner delegated design choices to the recommended option; every recommendation below is the selected design. Proceed with this revision, commit and push without another approval question. The owner decision fixes the destination and the accelerated sequence: named Noor verification, a small cohort, then all; §7 replaces the earlier duplicated 72-hour pre-all waits. It does not authorize this design task to access production, probe Meta, apply migrations, reconnect, publish, change schedules or deploy. Preserve the technical proofs and applicable live-action records from [release gates §6](../../specs/2026-10-30-instagram-release-gates.md#6-activation-gates-be--approval-required-at-every-step), including complete local G-X; do not invent a new design-decision wait at each stage or claim an unexecuted gate passed. Architecture and task lifecycle remain in [ARCHITECTURE.md](../../../ARCHITECTURE.md) and [CLAUDE.md](../../../CLAUDE.md).

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

**Required population prerequisite, selected recommendation:** inventory all 23 active accounts, complete the bootstrap/backfill pass for the 22 missing capabilities, and reconcile any newly connected accounts before switching owners to all. Each repairable account must be `ready` with positive generation, confirmed permission evidence and its correct binding/transport. A real missing/invalid token, positively missing scope or unsupported account type may remain as an explicitly evidenced customer-action exception, with accurate UI/MCP advice and a working lifecycle repair route; do not fabricate trusted rows or force a reconnect to satisfy a count. No recoverable `pending`, `retry`, `unknown`, unexplained failure, or missing bootstrap receipt is a completed backfill. A provider outage/rate limit is a real stop condition. Record numerator/denominator and exact exception reasons; never redefine the eligible population to hide an unfinished migration. Bootstrap here means trusted capability/credential initialization, not a requirement to finish every historical metric repair before all. The pilot verifies collection only after that preparation; §7 defines promotion.

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

### 5.2.1 Readiness precedence and independent evidence

Phase 1 uses the following ordered decision table. SQL owns eligibility; both report assemblers call `projectOwnerAnalyticsReadiness` for the final saved-data projection. A lower row never replaces a higher row, even when saved data exists.

| Priority | Current evidence | Collection reason/source |
|---|---|---|
| 1 | Invalid configuration, disabled collection, excluded target | `settings_unavailable`/configuration, or `collection_disabled`/`collection_not_eligible`/rollout_policy |
| 2 | Invalid identity, inactive account, unusable credential, absent trusted bootstrap | Diagnosed connection reason/connection |
| 3 | Terminal provider token or permission refusal for the current authority, not superseded by a newer successful permission read | `token_invalid`/connection or `permission_missing`/job |
| 4 | Unknown/failed permission verification or positively missing named scopes | `permission_verification_pending` or `permission_missing`/permission |
| 5 | Current scheduled retry | `rate_limited` or `provider_error`/job, with `retry_at` |
| 6 | Queued/pending work, or current running/leased work | `queued` or `running`/job |
| 7 | All prerequisites satisfied | `awaiting_first_capture`/data; only this fallback becomes `ready` when accepted account-wide numerical observations exist |

`last_attempt` is dated history, not an additional precedence row. An obsolete generation/login/viewer or Facebook authority can retain history but cannot block current readiness. Instagram's actual terminal outcomes are `unavailable/token_invalid` and `unavailable/scope_missing`; Facebook uses `failed/reauth_required` and `failed/permission_missing`.

Connection and permission evidence are evaluated independently of the winning collection reason. An unnamed permission denial requires a matching terminal provider refusal and timestamp, regardless of policy/configuration precedence. Today's Facebook permission freshness remains required; a newer successful verification still supersedes an older refusal across Los Angeles midnight, leaving verification pending rather than resurrecting the refusal. A failed verification does not supersede a proven refusal.

The 42-row table in `supabase/tests/owner_analytics_readiness.sql` asserts real SQL snapshots. The admission integration suite executes that same table and passes every snapshot through the shared TypeScript projection with and without saved measurements. Inventory discovery alone cannot complete period data: supported in-window media require completed saved captures, in addition to the expected measured days.

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

## 6. Facebook: repair the first failed stage, then enable all customers

Facebook is independent: `collection_facebook_analytics_enabled` plus `collection_facebook_analytics_policy={"account_ids":[...]}`. Baseline supports at most 100 IDs, no `mode:all`; empty admits nobody ([worker progress SQL:4-41](../../../supabase/migrations/20261101141000_meta_owned_analytics_worker_progress.sql); the later [retention migration:20-35](../../../supabase/migrations/20261101142500_meta_owned_analytics_retention.sql) replaces the reader but retains list parsing). Noor's missing metadata scopes do not explain this collector: it uses protected User token inspection plus operational Page identity, requiring both `read_insights` and `pages_read_engagement` ([permissionProvider.ts:22-112](../../../supabase/functions/meta-owned-analytics-sync/permissionProvider.ts)).

Order: configured flag/list → policy enumeration/sweep ticket → prepare/authority → live admission permission observation → daily job → claim → operations/inventory/checkpoints → received captures → saved report. Missing binding can refuse before report-state insertion; a cron definition alone proves none of these ran. Current authority needs same-owner active Page, operational token, connection-version fence, verified provider user and live protected credential ([history SQL:489-515,598-675](../../../supabase/migrations/20261101130000_meta_owned_analytics_history.sql), [admission SQL:4-49](../../../supabase/migrations/20261101140000_meta_owned_analytics_worker_admission.sql)). Daily dispatch uses a current Los Angeles-day observation with matching authority; IG collection capture dates are Kuwait dates.

**Selected repair ladder:** use Q1–Q6 to prove the first failed stage, with initial collection restricted to the verification set; if authority missing, use the same verified bootstrap with Facebook-compatible provenance; if no recoverable User token, repaired lifecycle Page reconnect; if app/identity failure, repair configuration/linkage first; if true missing permission, request that permission through supported consent; if dispatch/worker failure, repair that stage with durable retry and preserve measurements. Never copy metadata scopes or reuse a Page token as permission-token authority. The list is temporary staging. Implement the all-customers contract below now, regardless of whether there are fewer than 100 Pages; do not defer it to a future scale project or call Noor-only Page admission the final fix. Never write the proposed all JSON to today's strict list parser.

### 6.1 Required Facebook all-customers contract (proposed implementation)

**Selected policy:** retain the existing master key, and extend `collection_facebook_analytics_policy` to exact version-2 shape `{"version":2,"mode":"off","account_ids":[]}`, with mode `off|allowlist|all`. All requires an empty array; allowlist accepts at most 100 unique owned-target UUID entries for staging, with structural ownership checked per operation rather than trusted from settings. Missing/malformed/unreadable configuration fails closed; an empty allowlist admits nobody. Final state is `collection_facebook_analytics_enabled=true` and `{"version":2,"mode":"all","account_ids":[]}`. It includes current and future supported Facebook Pages for every customer, while retaining current credential and permission admission. Threads and retention policies keep their existing formats and behavior.

**Selected compatibility/deploy order:** a new migration first adds a Facebook-specific parser/evaluator path that accepts the legacy exact `{account_ids:[...]}` shape as allowlist and the new v2 shape, plus matching enqueue/claim/request/write fences, dispatch continuation and types. Do not broaden the shared `meta_analytics_policy_ids` parser to accept `all` for Threads or retention. Preserve the current master/policy while deploying compatible SQL, the reachable `meta-owned-analytics-sync` closure, report/proxy/MCP readiness and verified runtime hashes. Only then canonicalize the current Facebook list to v2 allowlist through an audited compare-and-set. Keep the old raw JSON/fingerprint and a tested v2-aware last-good runtime; a pre-v2 reader is not a safe rollback while v2 is stored.

**Policy revision, not only content identity:** a canonical content fingerprint repeats when policy A changes to B and is rolled back to A, so an operator holding the original A fingerprint could then submit a stale edit and overwrite the rollback. Every policy setter (Facebook here, Instagram in 7.1) therefore also carries a monotonically increasing `revision` stored with the policy and incremented on every successful write including rollbacks; the compare-and-set takes both `p_expected_fingerprint` and `p_expected_revision`, and refuses unless both match. The test for stale edit after rollback must hold the original fingerprint and revision across an A to B to A sequence and assert the stale edit is refused.

**Selected operator boundary:** add proposed service-only `get_facebook_analytics_collection_policy()` and `set_facebook_analytics_collection_policy(p_expected_fingerprint,p_policy,p_actor,p_approval_ref)`, with the same atomic CAS, canonical fingerprints, bounded nonblank asserted actor/reference, fail-closed recovery, audit and alternate-write/delete denial as the Instagram setter. These functions do not exist at baseline and are not executable operator instructions until their migration/catalog is verified. The reference records the concrete release authorization/owner decision; no new choice about the all-customers destination is required. Preserve Instagram/Threads/retention settings in every Facebook update.

**Selected bounded outcome storage:** the existing sweep progress row accumulates every visited account in one `outcomes` JSON object capped at 65,536 bytes (`meta_analytics_sweep` progress migration `20261101141000`, `outcomes jsonb ... pg_column_size(outcomes)<=65536`, appended per account in the commit function), so an all-customers sweep over a large population would violate that constraint and stop advancing. Replace it for ALL Facebook sweep modes (allowlist, all, and the rollback back to allowlist, so allowlist verification stages and rollbacks keep their outcomes visible and every diagnostic reads one place) with a normalized per-target outcome table keyed by `(platform, due_on, policy_digest, dispatch_round, social_account_id)` (the existing sweep table has no surrogate id; its composite primary key is `(platform, due_on, policy_digest)`, so the outcome table carries that exact key as a composite foreign key to it with `ON DELETE CASCADE`, which also gives sweep cleanup for free) with a unique index, so a reopened sweep (the dispatcher increments `dispatch_round` and clears outcomes on the same row) never shows previous-round results for targets not yet visited: reopening writes the new round number and queries always filter on the current round, and old-round rows are pruned atomically in the same statement that reopens the sweep, written by the commit function instead of appending to the JSON object, indexed for the retry accounting and diagnostic queries, pruned with the sweep, and with the progress row keeping only counters and the keyset cursor. The commit, retry accounting and every read-only diagnostic query in section 6.2 must be updated to read outcomes from that table, and a test must sweep more targets than the old byte cap allows.

**Selected durable enumeration:** current `meta_analytics_dispatch_next_id(jsonb,uuid)` enumerates only the policy array and cannot implement all ([worker progress SQL:56-61,71-92,132-174](../../../supabase/migrations/20261101141000_meta_owned_analytics_worker_progress.sql)). Replace its Facebook usage in BOTH ticket production and commit validation with the same database-selected ordered traversal of active `social_accounts` where `platform='facebook'`; derive each owner from that row. In allowlist mode intersect that set with the approved IDs. Enumerate active Pages even when credential admission subsequently refuses, so gaps produce a durable reason and do not disappear from population counts. Keep the existing Threads array dispatcher unchanged. Preserve platform/day/policy-digest/round tickets, current Los Angeles day, bounded 50-target visits and 40-second invocation, idempotent jobs and admission retry accounting. Use indexed UUID keyset traversal, never materialize an unbounded all-account array in settings or a response. Validate the selected target again under current policy and account locks at commit; a removed/reowned/inactive Page cannot be admitted by an old ticket.

On policy change, old tickets fail stale and a new digest/round enumerates the current population. Completed sweeps restart through the existing explicit daily-dispatch start behavior; a new connection with an ID behind the current cursor is enrolled by a bounded new dispatch round after connection readiness, or the next scheduled hourly dispatcher, without an operator adding its ID. Resume pending sweeps across invocations until complete, and ensure transient/provider-refused targets cannot starve later accounts. No cursor loops, queue deletion or force recollection. Preserve current-authority permission verification before enqueue and recheck the policy, lease and credential authority at every provider call and write. The baseline worker already re-reads its fenced credential in `beforeRequest` ([worker.ts:45-57](../../../supabase/functions/meta-owned-analytics-sync/worker.ts)); do not replace that with one cached admission for the whole job.

**Selected continuation caller:** wire a bounded pending-Facebook-sweep resume into the registered drain path, using `p_start=false` so a drain cannot open/reopen a completed sweep by itself. The explicit enqueue-daily action starts/reopens rounds; ordinary drain ticks finish a pending round with no external cursor consumer. Spend at most 15 seconds and five target admissions on resume, then leave at least 25 seconds of the existing 40-second combined budget for measurement work; a pending admission that cannot finish inside that slice remains durable for the next tick. The existing outer 50-target dispatch cap is a ceiling, not a reason to spend the whole drain budget enumerating. Test a non-first page reached by this actual caller, no-work/completed-sweep behavior, timeouts, retry accounting, and fair coexistence with Threads. No new schedule/cadence, self-HTTP recursion or unbounded background task is needed.

**Selected readiness prerequisite:** inventory and finish the verified-bootstrap/admission pass for ALL current active Facebook Pages, not just Noor's. Each recoverable Page must have its protected User binding/fence, usable operational Page token, verified app/User/Page identity and current `read_insights` plus `pages_read_engagement` observation; real consent/token exceptions remain explicit with a working reconnect route. Count all inventory rows and any new-connection delta. No unknown or unfinished internally repairable bootstrap is eligible for the all-policy flip. Keep positive admission evidence tied to current authority and provider day, not copied metadata.

The baseline `admit` path calls `prepare_fb_analytics_account`, which requires collection membership; it cannot prepare excluded Pages before the all flip. **Selected gap closure:** extend the separately gated bootstrap boundary to verify/store a current-authority permission observation for an explicitly bootstrapped Page while collection admission remains restricted. Under current account/binding locks, compare captured identity, credential revision, connection fence, token/expiry and provider-day evidence; record the service-only observation/receipt without enqueueing, claiming or calling measurement APIs. Do not call the baseline policy-blocked prepare RPC or add every Page to the collection allowlist just to obtain readiness. The verification flag grants only bootstrap proof work; ordinary collection enqueue/claim/request/write still requires the independent collection policy. Test this exact sequence with a Page excluded throughout bootstrap, then admitted by the all transition, and test revocation between proof and admission.

**Selected staged sequence:** after that prerequisite and local/security proofs, verify Noor's `Smart Energy` Page (`6f999090-58f5-42af-a58d-57700d3a4d3a`) and `Quality Light` Page (`06168394-6e00-4c17-a17d-86d10e86335b`); then up to five additional ready Pages across at least three other tenants where available, including a shared-grant sibling; then v2 all. Preserve already admitted Pages throughout. If fewer other Pages exist, use every remaining ready Page and the synthetic multi-tenant/shared-grant fixtures rather than wait to recruit customers. Advance on the same evidence and stop rules as §7, using Facebook's provider day and current hourly-enqueue/five-minute-drain cadence. A Facebook-specific failure pauses Facebook; it does not turn the Instagram all destination back into an optional pilot. Shared credential/security faults stop both affected populations.

**Selected tests and rollback:** legacy-to-v2 conversion, all/off/empty/malformed/duplicate settings, real anon/auth/service ACLs, per-request revocation and write fencing, Page reownership, current-day authority mismatch, concurrent policy CAS, and stale ticket rejection must pass. Test more than 100/1,000 Pages with bounded continuation, a newly connected Page before/behind a completed cursor, invalid early targets followed by ready later targets, loss/retry and day rollover, zero foreign calls, unchanged Threads and retention. Rollback uses the v2-aware setter to restore the last-good explicit allowlist or `mode:off`, and stops only Facebook jobs/master unless the incident is shared; never restore a legacy-only binary under v2 or edit credentials/history. Keep pre-install list rollback only as a documented database-locked recovery path before the new setter exists.

### 6.2 Exact read-only query pack (future authorized operator)

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
 'get_facebook_analytics_collection_policy','set_facebook_analytics_collection_policy',
 'meta_analytics_collection_policy','meta_analytics_policy_ids','meta_analytics_dispatch_next_id',
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

Before the named Q3 probe, the all-customers Facebook inventory is this separate read-only query. It supplies the denominator and repair worklist for §6.1; it makes no live validity claim. Use all returned account/owner pairs to run the Q4–Q5 stage projections in bounded batches during release execution, not only Noor's two rows.

```sql
SELECT a.id,a.user_id,a.platform_user_id,a.is_active,a.needs_reauth,a.token_expires_at,
 (NULLIF(btrim(a.access_token),'') IS NOT NULL) AS operational_token_present,
 (NULLIF(btrim(a.account_metadata->>'user_token'),'') IS NOT NULL) AS legacy_user_token_candidate_present,
 b.credential_id,b.connection_version,f.connection_version AS live_fence,
 b.evidence_source,g.revision,g.lifecycle,g.token_expires_at AS user_token_expires_at,
 (b.verified_facebook_user_id=g.provider_user_id) AS user_identity_matches,
 (b.verified_facebook_page_id=a.platform_user_id) AS page_identity_matches,
 o.state AS observation_state,o.observed_at,
 COALESCE(o.granted_scopes @> ARRAY['read_insights','pages_read_engagement']::text[],false) AS feature_scopes_present,
 o.authority->>'credential_revision' AS observed_revision,
 o.authority->>'connection_version' AS observed_connection
FROM public.social_accounts a
LEFT JOIN public.facebook_user_credential_bindings b ON b.social_account_id=a.id AND b.user_id=a.user_id AND b.platform='facebook'
LEFT JOIN public.facebook_user_credential_connection_fences f ON f.social_account_id=a.id AND f.user_id=a.user_id AND f.platform='facebook'
LEFT JOIN public.facebook_user_credentials g ON g.id=b.credential_id AND g.user_id=b.user_id
LEFT JOIN public.fb_analytics_permission_observations o ON o.social_account_id=a.id AND o.user_id=a.user_id
WHERE a.platform='facebook' AND a.is_active ORDER BY a.user_id,a.id;
```

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

**Selected:** close this gap before the verification rollout; implement Facebook's own boundary in the same operator-controls phase. New additive migration implements the specified Instagram getter and CAS setter, validated/canonical arrays, duplicate refusal, asserted actor/approval reference (nonblank <=200 characters), before/after server fingerprints and audit in the same transaction, plus denial of alternate writes/deletes. Malformed stored policy uses raw-fingerprint recovery while all collection remains refused. Test stale edit after rollback, missing key and malformed recovery, actual grants, and RC-17. Never edit R1 migration bytes. Update the real [rollout runbook](../../runbooks/instagram-collection-rollout.md), types and operator tests in that implementation phase. The setter is a finite implementation prerequisite, not an unresolved design approval.

**Existing-path recovery, not the selected launch shortcut:** before a setter exists, the real database settings path requires one operator transaction: lock the existing `app_settings` row `FOR UPDATE`; compare exact reviewed old JSON and fingerprint; abort if stale/missing; replace only the complete `owners` member using `jsonb_set`, preserving version and competitors; require one affected row; set real operator `updated_by`; commit; fresh readback and verify the committed `rollout_policy_changed` audit. Preserve the old JSON, old/new fingerprint, actor, authorization reference and time in the private receipt, because the current audit stores only the new fingerprint. Do not delete/reinsert, blind upsert, invoke a nonexistent setter, or call the internal normalizer via a service RPC. This documents the baseline recovery mechanism; the selected rollout finishes and verifies the setter first. After deployment use only its verified reviewed signature; unexpected direct-write denial means stop, not bypass.

### 7.2 Fastest safe sequence to all (selected recommendation)

The destination and ordering are settled by the 14 November owner decision. Pilot and cohort are short verification steps, never alternate end states. Prepare one concrete release packet covering both all transitions, account-selection rules, immutable candidate, exact settings/cadences, required live actions and rollback, so a future authorized implementation session can progress on evidence without reopening the same design choice. This document performs no live action and claims no prior B–E receipt. Preserve independently required execution authorization and technical gates; do not create additional per-account design approval waits. Once execution is authorized, record each transition and advance immediately when its pass conditions hold.

| Stage | Instagram recommendation and required pass evidence | Facebook recommendation and required pass evidence |
|---|---|---|
| 0. Complete population preparation | Deploy compatible controls/readiness/bootstrap/lifecycle after local G-X and security proofs. Finish the backfill for all 22 missing-capability accounts plus new-connection delta, with each repairable connection ready and genuine customer-action exceptions recorded. Verify the original pilot remains valid. Do not widen to all during an incomplete backfill. | Deploy and verify v2 policy/dispatcher/CAS support while the old list still applies; inventory every active Page and complete all recoverable protected-authority/admission repairs, with genuine exceptions recorded. No v2 all before that pass and no fabricated permission observations. |
| 1. Noor first verification | Add `smartenergykw` (`0415c97e-62c6-4c86-acbf-092aa7120d0e`) then `quality_light1` (`fd85cc1d-6e55-4431-a89d-fdc905f69cea`) in the same verification session, preserving `xsellpoint_kw` and current competitors. For each: accepted normal enqueue, actual received numerical observation, correct metric date/units/null handling, and matching UI/report/MCP readiness. Execute account proofs sequentially to isolate failures, not as two new design decisions. | Add Noor's two Page UUIDs from §6.1 to the v2 staging allowlist while preserving existing admitted Pages. Prove fresh protected User/Page identity, current-day admission, a durable job and received capture with real measurements, then UI/report/MCP parity. Same sequential proof, separate Facebook policy. |
| 2. Small cohort | Add up to five ready non-Noor legacy accounts spanning at least three other tenants when available, including a shared-grant sibling and each supported login family represented in inventory. Verify all selected targets reach a measurement through real bounded dispatcher/drain continuation, no other owner is called while excluded, normal repeats are idempotent and one subsequent drain tick is healthy. Use all remaining ready accounts if fewer than five exist. | Add up to five additional ready Pages across other tenants, including shared-grant and different-User cases where available; the same received-capture, current-authority, isolation, continuation and healthy-next-drain checks apply. If the available population is smaller, use every remaining ready Page plus synthetic scale/isolation proofs; do not wait for customers to join. |
| 3. All immediately after passes | Reconcile inventory/backfill receipts and new connections again; use verified CAS to set only `owners={"mode":"all","account_ids":[]}`, preserving `version:1` and competitors, with master true. Read back and verify audit. Start the existing `instagram-insights-sync` `{"action":"enqueue-daily"}` dispatcher to reopen today's normal sweep, then drain at the existing cadence; do not wait until tomorrow's cron or force old successes. Include all current/future customers without further per-customer policy edits. | Use verified Facebook CAS to set `{"version":2,"mode":"all","account_ids":[]}` with master true; read back and audit. Start existing `meta-owned-analytics-sync` with `{"action":"enqueue-daily","platform":"facebook"}`, then current drains; never send v2 to an old parser. Verify every ready current Page gets its normal job, and fixture/live evidence proves future Page enrollment without an ID edit. |
| 4. Observe all and finish | Keep all enabled while measuring three Kuwait daily cycles and lag/backfill completion, unless a §7.3 stop fires. Every ready target must have numerical data or a specific provider-supported unavailable metric, not merely a completed sweep; track exceptions individually and repair them. | Keep Facebook all enabled over three Los Angeles provider-day cycles, with fresh authority observations, actual captures and complete sweeps. Measure it independently of Instagram; neither platform can be declared complete while its production enrollment remains a staging list. |

**Promotion timing selected:** remove the earlier recommendation of 72 hours at Noor AND another 72 hours at cohort before all. There is no fixed pilot/cohort soak; both may finish in the same release session when real measurements, a complete bounded sweep, a healthy next drain and exclusion/capacity proofs are present. After stage 3, retain one continuous observation period of at least 72 hours containing three respective provider-day cycles before final E4 acceptance. This changes the recommended rollout timing under the latest owner decision, not the requirement for honest lag repair, live compatibility or real measurements. Actual provider backoff, unresolved safety evidence or authorization outside this design scope can delay execution; do not label elapsed time itself a pass. Run the two platform tracks in parallel within shared app/grant rate budgets and advance each independently. Do not postpone a ready Instagram all transition for an unrelated Facebook-specific defect, or vice versa.

**Technical gate mapping retained:** A/local G-X and RC-01–RC-17 prove assembled security and isolation; B1/B2 cover schema-before-runtime manifest, deployed hashes and off-state; B3/C1 capture real lifecycle or explicitly identified verified stored-credential bootstrap evidence, without claiming a bootstrap was fresh consent; C2/C3 retain required login/refresh/publishing regression evidence and action authorization. D1 requires implemented controls, not a missing-setter waiver. D2 is stage-1 named collection proof; D3/competitor evidence remains part of the existing applicable assembled gate, with no competitor policy expansion in this task. E1 is the committed cohort-to-all destination, E2 verifies current dispatch/drain execution and capacity, E4 accepts the post-all observation. E3 is unchanged and not used to add retention work here. The selected implementation updates the release packet/runbook's timing and references to this owner decision; it does not pretend source checkboxes were executed.

**Readiness before each transition:** Q0/Q1 deployed controls match the candidate; Q2 and bootstrap receipts cover every inventoried IG connection and new delta, with correct owner/identity, active health, permission state `ok`, generation >=1 and matched protected binding/fence or direct transport for every repairable account. Facebook's population Q3 plus Q4–Q6 prove corresponding current authority/admission. Use the report's true observation counts/coverage, not attempt history; unknown reads are not readiness. Record the fixed total, ready count, terminal customer-action exceptions, zero unresolved repairable cases, group-by-grant usage, eligible oldest-job age/progress, runtime hashes, exact old/new policy, authorization/operator/time and rollback candidate. An existing exception must never turn the all policy into a private allowlist; return its honest action through every channel.

### 7.3 Stops and rollback

**Selected stop rules, applied independently to each platform unless the fault is shared:** stop immediately on cross-owner data/provider access, leaked token, wrong identity/app proof, unexpected grant/sibling mutation, false success receipt, missing audit, or unauthorized provider work. Do not promote if any of the 22 Instagram bootstrap records (or any recoverable Facebook Page record) remains pending/retry/unknown, if a newly connected account reopens the legacy gap, or if a named verification/cohort account has not produced its first numerical measurement. A provider-specific unsupported metric is not a reason to treat all other metrics as collected. A real customer-action exception may be carried forward only with current evidence, accurate advice and a working supported repair route; an unexplained migration failure cannot be relabeled as a consent exception.

Pause promotion, and narrow/disable the affected all population if the same condition arises after stage 3, on: no eligible-job/checkpoint/capture progress over two consecutive scheduled drain intervals while due work exists (four minutes at current IG cadence, ten at current Facebook cadence); increasing expired leases; an unfinished sweep crossing its next provider-day boundary; a missing dispatch/capture receipt; provider rate limiting; or report/UI/MCP disagreement about the current cause. Inspect provider usage at >=70%; pause new bootstrap/enrollment work and new collection requests at the stricter existing worker threshold or >=80%, whichever is lower, respecting longer provider retry times. Shared app/grant budget exhaustion pauses both affected workers. These are initial operating thresholds, not Meta quota guarantees. Preserve durable retries; resume bounded work only after usage/backoff and freshness checks permit it. Log a concrete cause and next action as soon as a stage cannot advance; no unattended pilot plateau or periodic approval check-in is the operating plan.

**Selected rollback:** first pause affected bootstrap/lifecycle enrollment and collection schedules under the execution packet's incident procedure. Instagram narrows `owners` through fresh verified CAS to the last-good explicit cohort, preserving competitors; use `owners.mode=off` or the IG master off for uncertain isolation/security. The IG master also affects competitors, so record that impact. Facebook uses its v2-aware CAS to restore the last-good Page cohort or `mode:off`; turn only the Facebook master off when needed. An unrelated healthy platform stays enabled for all. A shared credential/app/security incident stops both affected populations. Verify audit/readback and old/new fingerprints; never use a stale cached upsert. No credential deletion, generation decrement, protected-to-legacy downgrade, global credential-mode flip, forced queue purge, fabricated success or schema reversal. Saved data remain readable.

Per-request fences stop subsequent calls and refuse now-ineligible writes; already-sent HTTP calls cannot be unsent. Observe bounded requests and current 120-second collection leases settling; verify no new authorized requests or captures for removed targets before declaring quiescence. If uncertain keep the affected master off and escalate. A pre-rollout IG worker or pre-v2 Facebook reader is not a safe rollback binary. Resume after the execution packet's required incident authorization and renewed readiness/exclusion proofs, then return through the same short verification sequence to all; rollback is a temporary safety measure, not a revised pilot-only destination. Bootstrap rollback leaves verified bindings in place for compatible consumers; revoke a demonstrably wrong binding only through the reviewed lifecycle incident path.

## 8. Independently mergeable phases

Each phase produces its own reviewed PR during later implementation; this design task opens none. Every implementation brief must require ARCHITECTURE.md §§1,4,12–17,23–28 and the relevant security/tenancy rules. No new helper ships without a reachable non-test caller. Migration applies and verifies before dependent runtime; copy reviewed function import closure from fetched commit, verify SHA256 and restart through the self-hosted deployment runbook. Frontend follows compatible backend; flags activate under the concrete execution packet after technical/live-action gates. Never deploy from a dirty server checkout or use Supabase Cloud deploy.

| Phase | Mergeable deliverable and flags | Required tests / evidence | Deploy order / rollback |
|---|---|---|---|
| 1. Truthful readiness | Additive IG/Facebook snapshot contract, report reasons/data-state fix, UI translations and essential MCP reason projection. No collection activation. | Real SQL snapshot and proxy/UI tests for excluded+missing-capability+historical attempt, zero captures, genuine partial, denied vs unknown scopes, read failure, cross-owner 404 and cache/account switch. Prove reports never invoke Meta. | Snapshot migration/types first, report runtime/proxy, UI. Rollback to compatible report runtime retaining schema; avoid restoring misleading hints. |
| 2. Operator controls | Implement promised Instagram CAS getter/setter and direct-write restriction, plus Facebook CAS boundary accepting the unchanged baseline list and prepared v2 contract. Update actual runbook; flags unchanged. | RC-17 two-session stale removal/edit, malformed recovery, ACLs, audit atomicity/failure and policy all/empty/duplicate tests; full relevant RC suite. New Facebook v2 writes are refused until phase-6 capability is installed. | Migration and verified catalog first; operator tooling afterward. Retain setter on rollback, narrow through current CAS. |
| 3. Credential bootstrap | Add capture/job/provenance migrations, atomic install and bounded repair worker with live caller; bootstrap controls default off. Include Facebook authority recognition, policy-independent fenced permission proof and supported direct adapter. | SQL races against reconnect/disconnect/token refresh, absent-to-present ABA, shared-grant set change, generation zero, failed/empty/truncated permission reads, wrong app/type/Page/IG, expired lease, lost reply, RLS/service impersonation, redaction and call budgets. Prove excluded FB Page can be verified without collection or calls to blocked prepare. Full credential/OAuth/refresh/publishing regression. | Constraints/ACLs/types before runtime; deploy closures with bootstrap off. Run complete 22-account IG and all-current-Facebook passes during stage 0, under the concrete execution packet, before respective all flips. Rollback disables worker; preserve verified authority/receipts. |
| 4. Lifecycle by default | New routing control default off, all supported hooks/entrypoints/pickers, companion permission completion queue, explicit compatibility refusal. | Real registered route → attempt → commit → binding/capability → permissions → collector/readiness. Both login families, fresh connect/reconnect/rebind, Page-only companion, stale callback, flag transition, pending legacy selection, declined scope and no browser token exposure. | Schema/control seed first, compatible OAuth and repair runtime, UI; named users then all supported connects after gates. Disable new enrollment only; preserve protected/in-flight flows. |
| 5. Agent actions | Shared result schema, semantic error handling, saved/queued competitor receipt, quota/hints/descriptions and official discovery provenance. | Actual MCP → API → function → SQL chain, HTTP-200 refusal, 403/409/429/503, unknown body, read vs mutation isError, quota override/admin/unlimited, created/already/reactivated, saved-but-refused/indeterminate enqueue, no-viewer, no scheduled paid call and prompt-injection text treated as untrusted. | Additive SQL receipt if needed first, API/shared closure then MCP. Keep saved status independent; disable optional initial enqueue if faulty without losing tracking. |
| 6. Facebook all support | Compatible Facebook-only v2 parser/evaluator and array-free durable population enumeration; update ticket and commit selection, wire bounded pending-sweep resume into drain, and retain all fences, future-Page enrollment and readiness projection. Master/current list unchanged by merge; phase-2 setter unlocks v2 writes only after this catalog is verified. | All tests in §6.1, especially >100/>1,000 Pages, actual drain continuation/budget, cursor/new-connection/day-rollover, policy revocation mid-request, stale tickets and current-authority admission. Actual runtime → SQL → provider bridge; no Threads/retention change. | SQL/types before compatible sync/report/proxy closure; convert to v2 allowlist only afterward. Keep v2-aware rollback runtime; narrow or off through CAS, retain schema/history. |
| 7. Activation and capacity | Finish whole-population bootstrap, then Noor verification, small cohort and respective Instagram/Facebook all transitions. Policy-only widening and pilot-only closure are forbidden. No production switch enabled by merge. | G-X/RC and B–E evidence mapping, Q0–Q7 population/readback, live configured Meta versions, first measurements, healthy next drains, zero unauthorized calls and rollback rehearsal. Three-cycle observation follows all. Include >25 IG/>50 competitor continuation and large Facebook synthetic proofs. | Migrations/runtime, then completed bootstrap pass, then bounded pilot/cohort, then all immediately on passes. Existing schedules reconciled; explicitly start normal sweeps after policy changes. Reverse affected eligibility/enrollment first on a stop; retain data. |

**Selected critical path:** phases 1/2/3/4 supply trusted state, honest advice and future-connection readiness for Instagram; finish the whole 22-account pass, then phase-7 short verification and owners all. Implement phase 6 for Facebook concurrently with phase-3 Page repair; after its whole-population pass, use its own short phase-7 sequence to all. Phase-2 Facebook setters can ship safely while refusing v2 activation until phase 6 exists. Stage-0 execution overlaps final compatible rollout preparation only where no unmet security/live-action prerequisite is bypassed. Phase 5's optional competitor initial-enqueue and presentation work can finish alongside rollout; it must not create an unrelated delay to a technically ready all transition, while essential honest MCP reasons remain in phase 1. Do not wait for all historical metric backfill or a newly recruited cohort member. No end-to-end completion claim before both all transitions and phase-7 measurement/observation evidence. Production/test guards apply to later changed code/tests; this document receives docs-guard and spec self-review. Application suites are not evidence for a documentation-only change and were not run here.

## 9. Risks, exclusions, and completion criteria

- **Rate limits and cost:** account count is not call count. Backfill/lag repair, Page discovery pagination, per-media insights, shared User grants and interactive discovery compete for app/grant quota. Measure usage and calls, keep existing bounded claims/40-second workers, durable fairness, accepted-request throttle and no scheduled paid scraping. Stagger bootstrap from daily collection, cap retries and avoid bulk force. Do not promise 23+ accounts will fit until observations establish capacity; infrastructure/storage cost still exists without paid provider fallback.
- **Token handling:** legacy User-token candidates may be absent, expired, tied to another app or mutable through old writers. Bootstrap is a one-time privileged verification boundary with evidence fences, not permission to expand raw-token access. Never log/provider-body dump/copy tokens into reports, memory or this document. Internal snapshots/digests stay restricted. No weakening of protected consumers to “try metadata.”
- **Privacy/tenancy:** explicit same-owner Page/IG proofs and composite keys; do not merge grants across tenants even if provider identity/token matches. Minimize retained identity/evidence, keep existing retention policy, private operator receipts with opaque IDs rather than customer emails in public release notes. Competitor data remain public observations, not private insights.
- **Operational side effects:** installing protected authority changes refresh/publishing transport even if collection stays off. C2/C3 and a protected-compatible rollback are mandatory. Preserve account IDs, profile association, posting state and sibling grants. Current source/deployed drift must be reconciled before applying new migrations.
- **Unknowns that block the relevant gate:** exact deployed source/catalog and approvals; how many of the 22 have usable stored User/direct tokens; Noor's Page linkage/token app/type/expiry proof; direct provider permission/classification support; historical 5 November event; actual Facebook policy/admission failure; competitor watchlist/quota and current schedule receipts; live provider throughput. Each has a named diagnostic/proof above; none is silently assumed true.

**Required completion, selected recommendation:** Instagram master is true and owners mode is all with empty IDs; Facebook master is true and its verified v2 mode is all with empty IDs. The 22-account Instagram bootstrap/backfill pass and the all-current-Page Facebook pass are reconciled before their respective all flips, with no unfinished internally repairable state. Noor's four ready IG/Page targets and every other eligible target have real saved measurements, truthful UI/report/MCP reasons, healthy durable scheduling and post-all observation evidence. Future supported connections create trusted authority and enter collection without an operator allowlist edit. Genuine token/consent/account-type exceptions have current evidence and a working repair action; an unresolved Postora migration/dispatcher failure keeps the delivery incomplete. If Facebook remains blocked, report that blocked platform explicitly and continue the ready Instagram track, but do not close the combined task as finished. A cohort policy, pilot-only success, policy readback alone, or zero-data attempt history never meets the all-customers end state.

## 10. Design verification record

Read supplied evidence including follow-up, prior report, architecture/workflow, release-gates and rollout controls; traced actual connect UI/handlers, replacement migrations, protected credential/permission readers, owner worker/report and MCP/proxy. Reviewed proposed versus existing symbols, operator query columns and links; preserved source-versus-production distinction. No production tool/provider call, deployment, code change, application test, reconnect or PR was performed. Later implementation and live gates remain required.

Revision for the 2026-11-14 owner decision: made both all-customers end states mandatory, moved complete capability/credential population preparation before all, replaced two pre-all 72-hour waits with immediate promotion on concrete proofs, and specified Facebook's missing v2 policy/dispatcher/CAS/readiness work. Reviewed phase dependencies, policy-blocked Facebook prepare versus separate bootstrap verification, population queries, stop/rollback scope and proposed-versus-existing symbols. This revision still changes only this spec; no live behavior or test pass is claimed.
