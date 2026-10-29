# Owner intake/status contract — O1

Status: implemented and accepted locally at `bf74af2a`; [canonical acceptance and evidence](../plans/2026-10-26-instagram-insights-and-competitor-tracking.md#slice-o1-authenticated-owner-intake-and-status-accepted-locally-2026-10-29). The contract was frozen after read-only Astra consultation 45; final consultation 46 accepts the independently verified implementation. This is the first bounded owner-worker infrastructure slice after [Page reconciliation acceptance](../plans/2026-10-26-instagram-insights-and-competitor-tracking.md#p2-protected-page-reconciliation-runtime-accepted-locally), not collection, report/API/UI or complete owner-milestone acceptance. [Execution subplan](../plans/2026-10-28-instagram-owner-intake.md).

## Scope and existing authority

Implement `instagram-insights-sync` as a real authenticated intake/status endpoint only. No provider, claim loop, worker, schedule, frontend, competitor, migration, shared-helper rewrite, dependency or credential change. No placeholder claiming to drain work. Initial implementation remains MiniMax Token Plan `minimax-coding-plan/MiniMax-M3.1-Flash`; corrections remain `grok-4.7-build-fast/high`; Astra remains read-only.

The accepted authority is `supabase/migrations/20261026150000_instagram_durable_collection_jobs.sql`. Its owner enqueue/status RPCs derive ownership from **`auth.uid()`**, check targets in SQL, grant EXECUTE to `authenticated` and explicitly revoke it from `service_role`. Do not change those grants or impersonate users with a service client. Admin JWTs are ordinary owners for O1, without cross-owner override.

## HTTP input

POST only; retain shared OPTIONS/CORS handling. Other methods return 405. Validate a strict Zod discriminated union:

```json
{"action":"enqueue","social_account_id":"UUID","mode":"normal"}
```

```json
{"action":"status","social_account_id":"UUID","captured_on":"YYYY-MM-DD"}
```

`mode` may be omitted, defaulting to `normal`, or explicitly `normal`/`force`. `captured_on` may be omitted, but not null; it must be a real Gregorian calendar date in years 0001–9999, not a normalized invalid day. UUID fields are clean hyphenated UUID strings, with no surrounding whitespace or controls; canonicalize their hexadecimal case for comparison with PostgreSQL's lowercase output. Reject unknown fields, arrays, invalid action shapes, owner/user IDs, target kinds, job IDs, credentials and service/drain/batch actions. Malformed input returns sanitized 400; a body over **4 KiB** returns 413. Enforce the byte limit during a bounded streaming read, not solely through Content-Length.

## Identity and composition

- Require one verified incoming Bearer JWT. Use server-verified `auth.getClaims(jwt)` output, not independently decoded claims. Validate the raw own-data envelope with explicit `error: null`, verified claims with usable UUID `sub` and `role: "authenticated"`; reject service identities and missing/undefined/inherited/accessor/error envelopes. Validate values before using them; do not invoke getters to test their shape.
- Compose the owner RPC client with the public project key and **the same verified incoming bearer token**. Pass a narrow user-context RPC caller to the store, not a service client carrying a user ID argument. No global mutable per-request token/client state.
- The service client may read only server-controlled settings and attempt sanitized logging in this slice. Do not use the accepted shared auth helper's body-user service impersonation path, or rewrite that helper. Gateway JWT checks are additional protection; application authentication is mandatory.
- Use existing CORS, redaction and logging conventions without adding a generic auth/validation framework. `index.ts` owns clients/environment/composition; handler/store have narrow injected ports and active production callers.

## Availability gates, both actions

Read independent server-controlled settings through strict validated driver responses and the existing setting resolvers:

- `collection_instagram_insights_enabled`: absent/default false → **503 `collection_disabled`**.
- Enabled collection with `credential_facebook_user_mode` absent/default `legacy` → **503 `protected_credentials_required`**.
- Malformed/unreadable required settings → **503 `settings_unavailable`**, never silently absent or OFF.

Validate every setting that is actually required/read; a failed read is not absence. Do not inspect new job schema, credentials or providers before passing these gates. A protected credential mode with collection OFF stays protected; no switch is changed. Gating status too is deliberate staged availability: stored history is retained but this endpoint does not expose it while disabled. There is no hidden read-only exception or activation permission.

## Store and SQL projections

Every RPC envelope requires own data and own explicit null error; reject missing, undefined, inherited or accessor fields before reading them. Arrays are not objects. Parse closed result projections and construct responses from validated fields; no raw driver object reaches clients/logs. Safe integer counts/generations, finite zoned timestamps, valid calendar dates and explicit null semantics are mandatory. Unknown keys cannot leak leases, cursors, credentials or error text.

### Enqueue

Call only:

```text
enqueue_instagram_collection_job(
  p_target_kind: "owner",
  p_target_id: requested social_account_id,
  p_mode: validated mode
)
```

The accepted result has exactly eight keys:

```text
accepted: true
reason: "enqueued" | "already_enqueued" | "forced"
job_id: UUID
job_generation: positive safe integer
status: queued | leased | retry | partial | completed | unavailable | error
captured_on: valid date
created: boolean
accepted_at: finite zoned timestamp
```

Return **202** preserving this nonsecret projection. A normal request permits `enqueued` (created true) or `already_enqueued` (created false); a force permits `forced`. Newly enqueued/forced work is queued. An existing normal job may truthfully be completed; do not label it a new successful sync. Do not invent owner/target fields absent from this receipt: ownership is enforced by the same authenticated SQL call.

The throttle result has exactly four keys: `accepted: false`, `reason: "throttled"`, `retry_after_seconds` (nonnegative safe integer, at most the accepted 900-second window), `captured_on` (valid date). Return **429** with that validated Retry-After value. The atomic window spans midnight; no automatic retry, fallback enqueue or second write. SQL owns normal idempotence, force generation invalidation and the accepted-request throttle.

### Status

Call only `read_instagram_collection_job_status(p_target_kind: "owner", p_target_id: requested account, p_capture_day: requested date or SQL default/null when omitted)`.

The actual-job result has exactly these **14** keys:

```text
target_kind: "owner"
target_id: requested account UUID
captured_on: valid date
status: queued | leased | retry | partial | completed | unavailable | error
job_generation: positive safe integer
attempts: nonnegative safe integer
due_at: finite zoned timestamp
next_retry_at: finite zoned timestamp | null
last_attempt_at: finite zoned timestamp | null
last_partial_at: finite zoned timestamp | null
last_success_at: finite zoned timestamp | null
reason_code: null | /^[a-z0-9_]{1,64}$/
inventory: object below
pending_operations: nonnegative safe integer
```

`pending_operations` is a **scalar count**, not an array or raw internal operation rows. The inventory has exactly six own-data keys: booleans `truncated`, `partial`, `window_covered`; nullable zoned timestamp `oldest_returned_at`; nullable snake_case `gap_reason` under the same regex; nonnegative safe integer `pages_fetched`.

The legitimate no-job result has the same first 13 keys, `status: "none"`, generation/attempts zero, all time/reason fields null, inventory booleans false/oldest and gap null/pages zero, and **omits `pending_operations`**. Do not require or fabricate it in that variant. Neither variant has `job_id`, lease material, cursors or provider text.

Return **200** for either valid variant. Require returned target kind/account agreement; if an explicit date was requested, require that date. If omitted, accept the valid DB-selected Kuwait date without independently calculating UTC today. A failed read is 503, never `none` or empty history. Missing/cross-owner targets both map to the same sanitized **404**. SQLSTATE 22023 is a malformed request/refusal, not missing; absent schema/unusable contracts remain unavailable.

## One deadline and truthful outcomes

Use **15 seconds total**, starting before body reading, **five-second dependency ceilings** and **one second reserved for logging/response completion**. Body, auth, settings and RPC waits consume the same remaining budget, never fresh additive time. Bound stream reads, headers and body work; cancel where supported and attach late rejection handling. CPU-bound parsing is constrained by the 4-KiB limit and bounded projections.

- Enqueue timeout, lost/malformed response or transport ambiguity → **503 `enqueue_indeterminate`**. The write may have committed; do not claim rollback, retry enqueue or automatically read status as a substitute receipt.
- Status timeout/read/contract failure → **503 `status_unavailable`**, not 404/none.
- Auth refusal → sanitized 401; unavailable/malformed configuration → sanitized 503; method/body errors retain their explicit statuses.
- No provider work exists in any branch. SQL work is not implicitly cancelled merely because the caller stops waiting.

Attempt one bounded sanitized log for every terminal/refusal path, including off-state and malformed requests; retain existing preflight conventions. Record action, verified caller where available, validated account and stable reason, not JWTs, raw bodies, driver text or credential-bearing URLs. Logging failure/timeout must not repeat work or claim a row was saved. Avoid unbounded profile/subscription enrichment; do not use token-refresh history for this endpoint.

## Acceptance boundary

Require maintained and independent actual registered-handler controls, strict malformed envelope/accessor/auth/settings/input controls, off-state with new job RPCs unavailable and zero calls, all legitimate SQL variants, explicit/omitted day behavior, one-invocation indeterminate writes, bounded waits/redaction, relocation and behaviorally failing copied identity/routing mutation. Real production adapter calls must run against disposable PostgreSQL with authenticated role and real request claims/auth.uid, plus service-role denial and cross-owner negatives, normal/force/throttle/completed behavior and cleanup. Preserve accepted SQL/catalog/types and all previous CI inventory. Full immutable regressions and final read-only review precede a scoped local commit.

Acceptance means only authenticated owner intake/status. The bounded service collector, provider/day/media validation, ingestion, DB report/API/proxy, owner UI and complete owner journey remain later slices. PR294 remains draft; legacy active; collection OFF. No push, production migration, merge, deployment, activation or competitor implementation is authorized.
