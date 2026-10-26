# Implementation plan: Instagram insights and competitor tracking

Date: 2026-10-26

Status: Planning only; implementation not authorized. Three Grok 4.7 debate rounds completed and adjudicated; implementation blocked on decisions/capability gates below. Final-round corrections were reviewed by the orchestrator, not a fourth Grok pass.
Spec: [Instagram insights and competitor tracking](../specs/2026-10-26-instagram-insights-and-competitor-tracking.md). Preserve that supplied draft; the clarifications below are proposed amendments, not silently approved product decisions.

## 1. Run ownership and boundary

- Plan author: current orchestrator, OpenAI GPT-6.1 Sol (`openai/gpt-6.1-sol`).
- Independent debater: Grok 4.7, three bounded rounds. Direct `xai/grok-4.7` dispatch failed authentication (`invalid_grant`) without edits; successful CLI smoke test and review dispatch use Cursor `grok-4.7-high`. No different model substituted.
- Workspace: current checkout, branch `plan/instagram-insights-competitors`, initial HEAD `4d1a16c390e38e08b45a309e298c72d9af749a2e`.
- Deliverable now: researched plan, findings and verdicts, local documentation commits, then ask Waleed which delegate model implements. No production code, SQL execution, push, PR, merge, or deployment now.
- Implementation/test models, integration branch, execution method and landing state: choose after debate. SQL author must follow the pipeline's restricted Migrations lane (Muse Spark, with an announced orchestrator waiver only if unavailable).
- Read: `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, `PROJECT_AGENT.md`, supplied spec, quota spec, edge deploy runbook and the relevant code below.
- Tool limitations: mem0 connector unavailable (recall/save not performed); brainstorming, writing-plans and docs-guard skills unavailable in this harness. Structured intent/plan/document review is a disclosed substitute, not a claim those skills ran.
- Graph orientation: graphify CLI unavailable; read-only graph traversal found `scrapeInstagramOfficial()` → `calculateEngagementScore()` at `brand-scrape/index.ts:L14/L52`. Graph lacks the newer proxy/retention symbols; direct code inspection supplies those details. No code changes means no AST graph update is needed in this planning stage.
- Deployment hazard: `main` auto-deploys frontend; the runbook also documents a two-minute edge reconciler. Do not assume it is enabled, or that migrations are automatic. Reconcile live deploy state before an eventual release, via Postora Contabo tools only.

## 2. Evidence and fresh research

### Repository evidence at the initial HEAD

| Evidence | Proven consequence |
|---|---|
| `supabase/functions/brand-scrape/index.ts:14–55` | Uses `video_view_count`, maps all VIDEO to REEL, coerces missing likes/views to zero, has no timeout or pagination. |
| Same file `:541–553` | Only `facebook_page` is selected; an `EAAS` prefix is treated as capability evidence. |
| Same file `:411–503, :689–707` | Cache key is global `platform:username`, and cached response has no authoritative source; cache/history paths can bypass new reconnect/source behavior unless updated. |
| `facebook-oauth/index.ts:20–29` and scope/metadata search | Insights scope is absent; no `granted_scopes` or `scopes_checked_at` persistence exists in this flow. |
| `instagram-business-oauth/index.ts:134–149, :203–226` | Permission-read failures currently become empty arrays; stores Page tokens with type `facebook_business`, ignored by discovery. |
| `_shared/messengerCredentials.ts:17–28` | Messaging classifier includes legacy metadata signals. Leave messaging consumers intact; new discovery/insights use protected login classification, never client-editable keys. |
| `n8n-api/serviceProxy.ts:233–251` | Analytics supports Threads/TikTok only and already validates periods/ownership. |
| `src/hooks/useBrandScrape.ts:6–11, :47–65, :110–130` | Source and typed error codes are lost; historical sessions return only profile/posts. |
| `src/components/AnimatedRoutes.tsx:258, :271`; `layout/DashboardLayout.tsx:199` | Existing Instagram analytics URL is `/analytics/instagram`; preserve inbound URLs when separating performance from competitors. |
| `media-retention/run.ts:3–4, :61–83, :149+` | Existing pattern uses a 40s budget, claims and releases. Copy architectural shape, not its domain semantics. |

These are code-proven gaps, not proof of live token state, granted access, runtime errors, or App Dashboard call counts. Verify those before production acceptance.

### Official Meta references fetched 2026-10-26

1. [Business Discovery](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery): Facebook Login only; Facebook **User** token documented; required insights/basic/page-engagement scopes, plus ads scope for relevant Business Manager roles. Uses `business_discovery.username(name){...}` field expansion; nested media provides cursors, not next URLs; `view_count` example is present.
2. [Media insights](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights): empty ≠ zero; up to 48h lag; host/token differs by login; album children unsupported; Stories expire; code 10 can also mean insufficient viewers, not missing permission. Current docs show v26.0, not evidence v22.0 is invalid.
3. [Account insights](https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights): `follows_and_unfollows` uses `follow_type` breakdown; needs 100 followers; date range documented inclusive. Parse breakdowns explicitly rather than treating aggregate as follows and unfollows.
4. [Insights overview](https://developers.facebook.com/docs/instagram-platform/insights): user/account history available up to 90 days; owner media organic metrics and public competitor paid+organic counts are not interchangeable. Old examples in overview still show deprecated metrics; prefer endpoint references.

Research-driven changes to the spec sketch: validate credential type instead of assuming Page tokens work; use documented field expansion; separate follow breakdown query; delayed account-day reconciliation; bounded resumable work; distinguish insufficient data from permission failure. Do not migrate unrelated v18 calls or upgrade the app version globally.

## 3. Decisions to approve before the affected task starts

| ID | Decision | Recommendation, NOT an approved default | Blocks |
|---|---|---|---|
| P1 | Implementation base/integration branch and release scope | Fresh implementation worktree based on the manager-selected non-main branch; keep this planning branch separate | All implementation dispatch |
| P2 | Stories | Skip in v1; hide unsupported Story filter. Four-hour polling/webhook work is a separately accepted Phase 1b | Task 6/9 scope |
| P3 | Competitor quota per plan, admin override and downgrade behavior | Add `max_tracked_competitors` to canonical plan/effective-quota path; owner chooses plan numbers. Reject new/reactivated entries above entitlement; do not silently delete history on downgrade | Tasks 3/7/8 |
| P4 | Optional competitor MCP tools and scope | Defer tools in v1; existing `get_post_analytics` remains `posts:read`. If included, approve scope and use `okUntrusted` | Task 10 optional slice |
| P5 | Scheduled Apify fallback/cost policy | Interactive fallback unchanged; scheduled fallback OFF unless explicitly approved, bounded and fail-closed on unreadable settings | Tasks 7/8 |
| P6 | Continuation cadence | Daily enqueue at specified times, short bounded drain ticks until due queue empty; ticks must not recollect every completed account | Task 4 scheduling |
| P7 | Outlier undefined cases and comparison units | Null result on zero median; exclude nulls, use same metric/source cohort, no mixed reach/interactions ratios | Task 5 |
| P8 | Credential storage | Server-only protected credential relation for Facebook User tokens if existing credentials cannot serve documented API; never add User tokens to browser-readable account metadata | Tasks 2/3/6 |

Task 1 can resolve technical unknowns after implementation is authorized, but must not resolve these business decisions on Waleed's behalf. Unanswered decisions are explicit blockers, not permission to build a guessed variant.

## 4. Global constraints (quote verbatim in every delegate brief)

1. Read `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md` (§3–4, §12–17, §23–28, §31–39), `PROJECT_AGENT.md`, this plan and the source spec before changing code. Follow directory-scoped instructions.
2. Implement only the numbered task(s) assigned. Do not commit, push, merge, deploy, run production SQL, modify secrets or touch the standalone n8n node repository. The orchestrator reviews and commits scoped files.
3. Preserve unrelated user work and existing API behavior. No broad refactors, platform-version migration, scraping index, Facebook insights, hashtag search, Ad Library, or optional work without explicit approval.
4. Derive caller identity from verified auth. Service-role reads and writes must structurally enforce resource ownership, including denormalized user IDs and post/account links. RLS alone does not protect service-role work.
5. Null means unavailable, never zero. Failed reads/writes are failures, never empty data or successful syncs. Validate untrusted inputs/responses, sanitize client errors, redact logs, and log every refusal/early exit.
6. No token-prefix heuristics, raw tokens in frontend/contracts/logs, browser-readable new credentials, or provider URLs containing credentials in logs. Provider calls use explicit timeout, bounded retries and trusted-host cursor construction.
7. Scheduled and on-demand work uses atomic durable claims, expiring leases, checkpoints, idempotent upserts and bounded wall-clock/request budgets. No unbounded waitUntil jobs or browser-owned scheduling.
8. Keep UI → application ports/domain; infrastructure implements ports; only feature composition roots wire infrastructure. React Query hooks belong to UI, not framework-independent application modules. New modules must have real production callers.
9. Rehearse additive migrations and tenant-negative tests before release. Apply and verify prerequisites before deploying dependent functions/frontend. Enable new schedules only after functions boot and readiness is verified.

## 5. Proposed technical contract

### 5.1 Discovery, scopes, source and cache

- Pure viewer selector receives owner-scoped active IG candidates using protected capability records; excludes reauth/direct and explicitly unsupported auth types; orders trusted granted scope > unknown > denied (denied never selected), newest connected time then ID for stable ties. Only a new successful service-recorded permission read is authoritative: `[]` = denied. All legacy metadata scope arrays, absent state and failed reads are unknown. Never backfill trusted success from metadata.
- Remove the EAAS gate. Credential adapter resolves a documented usable token for the selected viewer. No User token means typed reconnect/capability error, not a guessed Page-token success. Test the currently stored Page token in a controlled, owner-authorized compatibility probe before deciding a new protected store is necessary. Do not claim the probe already happened.
- Use `fields=business_discovery.username(<validated username>){...,media.limit(25).after(<cursor>){...}}` with escaped/validated grammar values. Rebuild requests on approved host; detect repeated cursors and duplicate IDs; cap requests at ceil(maxPosts/25). Never request video-only fields by silently treating omission as zero.
- New Instagram result contract: `source: official | apify | graph_own`; typed error `IG_INSIGHTS_SCOPE_MISSING`. Successful admin-permitted fallback returns source `apify` plus a typed reconnect warning; no fallback yields a typed non-2xx error. Own-account path returns `graph_own`.
- Preserve provenance through cache, history, hook and UI. Version the Instagram cache key, scope it by owner and credential capability, and invalidate on reconnect/permissions change so one user's fallback/own-account cache cannot masquerade as another user's official result. Do not rewrite Facebook/TikTok cache semantics. Legacy cache/session entries with no provenance render source unknown, never invented Official.
- Update numeric `BrandPost` consumers (cards, sorting, charts, exports, AI analysis payloads) for nullable likes/views/score. Unknown-dependent engagement score is null; known scores sort first, deterministic tie order; display `—`, not 0. Audit other platforms and stored JSON compatibility.

### 5.2 Data integrity and quota

- Implement the five snapshot/watchlist tables, explicit SELECT-owner RLS and grants; snapshots service-write-only. Add source/status CHECK constraints, nonnegative finite metric validation, unique daily keys and owner/account/media/date query indexes.
- Enforce `(user_id, social_account_id)` and `(user_id, watchlist_id)` consistency using parent unique constraints/composite foreign keys or guarded database write functions, not trusted TypeScript arguments. Prevent cross-user post links; verify `(social_account_id, platform_post_id, post_id)` through owned platform-post lookup. Choose a schema-safe delete action that nulls only optional post reference, not required owner columns. Immutable parent ownership or explicit reassignment rules must preserve these invariants.
- Add actual `captured_at`/`updated_at` separately from Kuwait `captured_on`. Store owner media thumbnail URL/caption if required by table/UI; DDL sketch omits them. Separate follower/profile point-in-time `observed_at` from interaction `metric_date`; don't label today's followers as yesterday's total.
- Work state is durable: queue/job tables (owner-scoped or service-only as appropriate), target/date unique work keys, lease token/expiry, retry eligibility, media cursor and remaining IDs, account-day checkpoints, attempt/success timestamps and sanitized reasons. Completion writes use lease-token compare-and-set so an expired worker cannot overwrite newer state.
- Quota mutations serialize per user (advisory lock or locked quota/owner row), resolve canonical effective entitlement, and cover INSERT, reactivation, owner/username updates and direct browser paths. `user_id` immutable for normal callers. Normalize username lower-case/no @ and unique per owner/platform in DB. Soft removal is `is_active=false, removed_at=now()`; no physical owner DELETE that cascades history. Remove/re-add same identity reactivates row and is quota checked; 90-day cleanup only for still-inactive rows using removed_at.
- Admin/effective override and -1/unlimited semantics match existing quota arbiter. Keep admin plan editor and `useQuotas`/DB types in sync; seed only approved numbers without overwriting edited values. Test simultaneous adds/reactivations and a downgrade with existing over-limit entries.

### 5.3 Sync lifecycle and provider contracts

- Daily enqueue: owner at 00:30 UTC, competitor at 01:00 UTC; source day is Asia/Kuwait. Separate idempotent drain tick consumes only due jobs, at most 25 accounts/50 entries per invocation, 40s target wall-clock budget as a starting point, configurable downward to measured runtime limits. Lease TTL exceeds a single bounded slice; start calls only when remaining budget covers timeout/write/release reserve. Never process 25 × 60 × 10s synchronously.
- Owner media inventory: four pages of 50 per inventory pass, last 90 days, newest first, max 60 media insight operations per slice. Persist unprocessed IDs/cursor, and report truncation if inventory cap excludes older in-window media. Do not assert complete 90-day coverage when capped. Continuations fairly rotate accounts; no permanently throttled/invalid account monopolizes oldest-first order.
- A due media succeeds once per Kuwait capture day; failed items stay retryable. Cadence uses last successful snapshot day at 7/30/90-day boundaries. Same-day forced refresh may overwrite idempotently; ordinary continuation does not repeatedly spend the 60-media budget on the first items. Reconcile spec D9 with explicit normal vs forced behavior.
- User sync is an ownership-checked enqueue, not a long request. Atomic per-account 15-minute accepted-request throttle shared across processes; competitors get bounded per-entry/user anti-abuse throttling too. Return 202 job/status, and poll RLS-safe status. No browser timer drives provider work. Cron/admin can enqueue all; user JWT can enqueue own single target only. Service-role internal callers cannot impersonate user calls without explicit validation.
- Owner transport uses the service-written login kind only (direct vs page-linked), configured `FACEBOOK_GRAPH_API_VERSION` default v22.0 and matching validated credentials. Do not call the metadata-based messaging classifier from this path. New version-specific metrics must be fixture/probe verified for that version; docs v26.0 does not authorize silently changing it.
- Media metrics use spec product lists, parent only, no breakdowns in combined calls; skip unknown/AD. Parse values[] and total_value safely with numeric validation and watch-time units verified. One targeted unsupported-metric retry only when the rejected metric is unambiguously identified; otherwise fail that item safely, not drop arbitrary metrics or mark account scope_missing.
- Account interactions: common total_value daily query excluding follows_and_unfollows; separate single-metric follow_type query for FOLLOWER/NON_FOLLOWER mapping. Missing breakdowns remain null. Query Kuwait yesterday plus previous two days to repair 48-hour lag, within request budget and durable day checkpoints. Respect inclusive since/until using nonoverlapping day endpoints, test at midnight (UTC+3) and leap/month boundaries. Never divide nonadditive reach by summed daily values or claim unique period reach from their sum.
- Errors: OAuth 190 follows established refresh status transitions for only that account. True permission errors mark insights scope_missing, not needs_reauth; code 10 insufficient viewers/empty data stays metric unavailable. Distinguish inaccessible target from viewer permissions/reauth/network failures before declaring competitor unavailable. Weekly retry only for confirmed unavailable targets, with manual retry controls and due_at persisted.
- Parse both Meta usage headers (including nested usage objects) after every response, including errors. Usage >80% or 429 stops provider work and persists backoff; also recognize structured Meta throttle errors in non-429 responses. At most two 5xx/network retries (three attempts) with bounded backoff inside wall-clock budget; no retry 190/permission or success. Usage/throttle state shared by workers in the relevant app/token bucket, not just local memory.
- Persistence failures must not advance success/freshness. `last_attempt_at`, `last_success_at`, partial progress, status and retry_at are distinct; metadata updates must merge atomically without clobbering concurrent OAuth/refresh metadata. Stale lease results never override newer reconnect state.

### 5.4 Outlier and report semantics

- Canonical algorithm `_shared/outlierScore.ts`, pure and runtime-neutral, used by a real backend report reader. Frontend consumes returned scores or a tested contract, not a duplicate implementation.
- Sort by published_at then stable ID; baseline contains at most 12 strictly earlier, mature (48h), valid-valued items of same format and metric/source cohort; exclude self and nulls. At least six baseline items. Latest snapshot per media is selected before scoring; baseline history is fetched independently of display-period filters.
- Owner non-reels must not mix reach and interaction values in one median. Prefer reach cohort; if unavailable, compute an explicitly labelled interaction-only fallback cohort. Competitor public views may include paid engagement unlike owner organic insights; never compare owner and competitor ratios as absolute comparable performance. Keep official/Apify cohorts separate unless equivalence is validated.
- Proposed precedence: no_data for null/invalid value, too_early for valid immature value, small_baseline for <6 mature valid prior items; median=0 => no_data, score=null (never Infinity/NaN). Thresholds exactly >=3, >=1.5, <=0.5. Require P7 sign-off because the spec leaves zero/precedence cases undefined.
- Owner API: existing account ownership check; database-only read, validated period 7/14/30/90. Return daily account metrics, latest media snapshots, outliers, synced_at (last successful completion), observed_at/partial/truncation flags and 48-hour lag note. Define media display period by published_at; snapshots chosen by latest capture, not accidental captured_on filter. Unavailable metric reasons are typed. No provider calls on report reads.
- Competitor growth: absolute delta and percentage only when baseline exists and baseline followers>0. Use latest snapshot on/before target 7/30-day cutoff with explicit maximum staleness and actual interval; otherwise null. Posts/week reflects distinct published IDs observed in a complete seven-day interval, otherwise visibly partial—not all media snapshot rows counted as new posts.

## 6. Numbered implementation tasks

Each task needs focused tests plus orchestrator diff review and scoped commit. Tasks below are dependency ordered; do not blindly dispatch all phases in parallel.

### Task 1 — Resolve decisions and verify live capability without changing production

Files: plan decision appendix; new redacted provider fixtures under relevant test directories only once implementation authorized.

Read current OAuth flows, scope mirrors, token refresh, quota arbiter/admin consumers, MCP connection modes, route flags and SQL test runner. Get P1–P8 answers. With approved Contabo read-only access, inspect schema migration state, token *type/availability* (never print values), existing scope records and relevant logs; verify App Dashboard access separately rather than hardcoding a claim. Probe one owner-authorized direct-login and one page-linked account using documented token/host combinations, discovery syntax, media metrics, breakdown and day bounds. If User credentials are unavailable, finalize protected-storage/reconnect design before Task 2.

Acceptance: signed decision table, credential strategy with evidence, sanitized fixtures, exact runtime budgets/config locations and test commands; no production mutation or secret recorded. Unavailable access leaves a clearly named blocker, not fabricated proof.

### Task 2 — Discovery/OAuth repair and nullable/source compatibility (spec Phase 0)

Files: `_shared/instagramDiscoveryViewer.ts` + tests; extracted provider/media adapter under `brand-scrape/` or shared Instagram capability with actual sync consumer; `brand-scrape/index.ts`; `facebook-oauth/index.ts`; `instagram-business-oauth/index.ts` only for truthful scope-state handling; `src/hooks/oauth/useFacebookOAuth.ts`; `src/types/brand-intelligence.ts`; `useBrandScrape.ts`; affected brand-intelligence consumers; admin Instagram checklist.

Implement §5.1, scope-list equality regression, successful /me/permissions persistence and merge-safe reconnect state. If protected storage is required, depend on Task 3 credential prerequisite before persisting it; never add it as plain account metadata. Checklist records observed approval only; documentation isn't evidence of grant.

Acceptance: D1–D7/I1–I2/I6–I7 plus denied-vs-unknown, non-EAAS usable token, cache isolation/provenance/reconnect, legacy history, FEED video and null rendering/export tests. FB/TikTok and own-IG search behavior preserved. No backend/provider error bodies leak.

### Task 3 — Additive schema, ownership, quotas and durable work primitives

Files: new ordered `supabase/migrations/*_instagram_insights_schema.sql`, `*_competitor_tracking_schema.sql` (names chosen at execution to avoid collisions); `supabase/tests/*instagram*.sql`; maintained DB types; canonical quota reader/writer/admin paths discovered in Task 1. Protected credential relation migration only if needed by P8.

Implement §5.2 and atomic job enqueue/claim/checkpoint/complete primitives for §5.3, including service-only grants for workers. Separate schema from cron activation. Do not modify applied migration files. Add guarded RPCs with fixed search_path and least privileges; browser status excludes credentials/internal errors. Owner watchlist soft removal replaces physical DELETE from the sketch to honor 90-day history requirement.

Acceptance: spec S1–S5; cross-owner service writes and post links rejected; client cannot forge status/source/snapshot; concurrent quota N+1 and reactivation rejected; claims exclusive/recoverable/fenced; safe cleanup on deletion; migration rehearse on throwaway DB; type diff reviewed. Schema precedes dependent release.

### Task 4 — Provider gateway and bounded worker scheduling infrastructure

Files: feature-specific `instagram-insights-sync/{index,handler,run,deps,graph}.ts` and tests; `competitor-snapshot-sync/` equivalent thin entry and ports; new enqueue/drain cron migration; relevant `supabase/config.toml`/runtime registration only if required after inspection.

Implement auth/strict Zod union, explicit cron/admin vs user modes, request logs, 202 enqueue/readable status, shared-DB throttle, lease/checkpoint/fencing, deadline and stop reasons; use existing shared auth/CORS/sanitizer/timeout/Meta logging. Cron migration is idempotent, dispatches authenticated HTTP via get_cron_secret, and is activated only after workers exist. Core provider capabilities can be shared only where both discovery/sync genuinely call them.

Acceptance: H1–H3 plus parallel requests, crash recovery, expired-worker write rejection, malformed method/body, service/admin edge cases, per-account fairness, >25/>50 target drain, HTTP 400 Meta throttles, usage header stop and deadline/fetch-backoff reserve. Enqueue does not imply successful sync.

### Task 5 — Canonical outlier domain and report assembly

Files: `_shared/outlierScore.ts`, tests; backend Instagram report reader/adapters with tests (feature-specific, called later by proxy and UI boundary).

Implement §5.4 after P7 approval. The reader applies owner/account scope structurally and latest-per-media before scoring. Baseline selection cannot shrink when UI chooses 7 days.

Acceptance: D11–D14 plus unsorted inputs, equal timestamps, null baselines, zero median, no future/self inclusion, sparse format, mixed units/source, and period invariance. No nonfinite JSON. Production consumer must be wired in Task 10 before this slice is considered release-complete.

### Task 6 — Owner insights collection and reconciliation (spec Phase 1)

Files: `instagram-insights-sync/` use case/gateway/repository and tests; only necessary refresh-status helper/metadata RPC integration.

Implement owner inventory, product metrics/cadence, account-day reconciliation, follower observed_at, local platform-post link, credential transport and classified errors per §5.3. Stories remain blocked by P2; do not request stories accidentally via unsupported inventory semantics. Preserve good values on provider transport failure; successful unavailable metrics remain explicit null with reasons.

Acceptance: D8–D10/A1–A9/I3–I5; 200-media inventory and >60-due-media continuation, capped inventory partial flags, same-day force vs normal, 48h correction, fewer than 100 followers, unsupported metric/insufficient viewers, metadata race and write-failure freshness tests. Both login types covered by fixtures.

### Task 7 — Competitor watchlist application and sync (spec Phase 2)

Files: `competitor-snapshot-sync/`; feature-owned watchlist domain/application/infrastructure; protected admin settings if scheduled Apify approved.

Implement normalized add/reactivate/soft-remove, quota-safe path, immediate durable enqueue, daily profile/media upserts (<=30), viewer reuse, weekly unavailable due dates, verified source and typed failure reasons. Optional Apify only if P5 approved; do not call a user-JWT brand-scrape handler from cron as service role—reuse a bounded internal gateway. Missing/unreadable settings fail closed for scheduled paid work.

Acceptance: A10–A13, concurrent duplicates/add/remove/reactivate, invalid username, permanent target vs temporary viewer errors, fallback off/on/cost caps, source changes, weekly retry and unchanged inactive history. Snapshot write failure must not set status ok.

### Task 8 — Competitor UI and lifecycle retention

Files: new feature-owned `src/features/competitor-tracking/{domain,application,infrastructure,ui,tests,index.ts}`; `BrandIntelligence.tsx` composition only; `ProfileCard.tsx`; translations; bounded competitor-retention function/cron and SQL tests (route via Migrations lane).

Before visual implementation, load Refero/UI skills and ground patterns in existing screens/references; no redesign of unrelated Brand Intelligence. Add Track control only for Instagram, competitors tab, correct growth/outliers/source/error/partial/first-baseline states and remove/reactivate controls. Arabic/English, RTL, keyboard/accessibility, responsive existing style. Retention deletes only still-inactive records after removed_at+90 days with ownership safeguards; include cleanup of media/profile snapshots and completed jobs without deleting active history.

Acceptance: U4–U6; growth missing/zero baseline and incomplete weekly inventory; soft-remove survives 89 days, cleanup eligible at 90; reactivation resets removal marker and prevents cleanup; UI tests cover quota/retry/errors. No raw Supabase in pages/components.

### Task 9 — Instagram Performance UI and compatible navigation

Files: `src/features/instagram-insights/{domain,application,infrastructure,ui,tests,index.ts}`; `AnimatedRoutes.tsx`; `DashboardLayout.tsx`; `src/pages/analytics/InstagramAnalytics.tsx` only as compatibility composition; translations.

After reference-grounded UI preparation, thin UI query hooks call application ports and infrastructure is wired only at composition root. Add `/analytics/instagram/performance`; establish competitor canonical path and redirect old `/analytics/instagram` there without loops. Respect existing auth and analytics feature flags. Account picker explicitly owned IG; user-isolated React Query keys/reset, type/period controls, thumbnails (fallback for expired/missing URL), null-aware table, trend chart with metric labels/units, status/freshness and 202 Sync now feedback. Engagement rate null if denominator<=0 or any required numerator is unavailable; don't quietly sum null as 0. Only show Story when approved/collected.

Acceptance: U1–U3/U6 and route compatibility/flags; logged-out and switched-user cache isolation, polling stops on terminal state, failed sync preserves visible historical data, mixed sources/metric labels and translated RTL/mobile states.

### Task 10 — Read API, MCP and integration contract

Files: `n8n-api/serviceProxy.ts` + deps wiring/tests; `n8n-api/index.ts` only required route wiring; `mcp/index.ts` tool description/tests; `toolScopes.ts` if new tools approved; canonical response schemas/compatibility tests.

Wire the database-only owner report reader into existing get_post_analytics. No standalone node changes. Existing Threads/TikTok response behavior unchanged; Facebook remains unsupported. Keep posts:read. Ensure caption-bearing third-party competitor results use existing okUntrusted connection-mode handling if optional tools included. If those tools are deferred, no partial registrations/scopes are added. Paginate/cap reports with stable cursors, inspect query plans; no unbounded historical snapshots in MCP output. UI and API must agree on outlier/null/freshness semantics via one backend reader/compatible contract; choose authenticated backend report endpoint or secure RPC explicitly before UI wiring.

Acceptance: A14–A16/H4 and no-provider-call read test; cross-owner non-enumerable 404, failed DB reads produce errors, stable pagination/dedup, both report consumers identical fixtures, registry-vs-scope fail-closed suite. No tokens in serialized payloads.

### Task 11 — Assembled gates, journeys and release handoff

Files: targeted `e2e/analytics.spec.ts`, seeded fixtures, Arabic `docs/journeys/2026-10-26-instagram-insights-and-competitor-tracking.md`, feature runbook, final plan decision/validation log.

Implement E1–E2 plus reconnect/source/sync/track/remove/limit tests from J1–J10; omit story/optional tools only with documented accepted scope. Record exact migration names, function/shared-module deployment manifest, schedules and rollback switches. Check all new modules have non-test callers. Run docs/production/test guards and final independent code review where tools exist; unavailable mandatory guards block implementation completion until supplied or explicitly waived, never claim they ran.

Acceptance: all approved spec IDs traced to tests, no unreviewed skips, exact gate outputs, no secrets/unrelated diffs. Local validation is not live Meta acceptance. Production checks remain pending unless Waleed separately authorizes release.

## 7. Dependency and execution map

Logical order: Task 1 → Task 3a protected capability/credential prerequisites (mandatory capability state; credentials if needed) → Task 2 → Task 3b remaining schema/quota/jobs → Task 4 → Tasks 5/6/7 → Task 10a frozen report contract and backend wiring → Tasks 8/9 → Task 10b optional competitor tools if approved → Task 11 cross-consumer integration verification. Task 3a/3b are separately briefed portions of Task 3, not permissions to run other tasks.

- SQL portions always Migrations lane; do not bundle migrations into a general implementer brief.
- Parallel backend tasks only after frozen job/response contracts; Task 6 and 7 own disjoint function folders. Shared adapter fixes serialize.
- Tasks 8 and 9 use separate feature paths, but overlapping ProfileCard/routes/translations and Task 10 response contract integration serialize on integration branch.
- Isolated worktrees start from known integration baseline, dependencies installed; capture HEAD/status before every dispatch. Implementer never commits. Orchestrator reviews actual diff, reruns gates, commits before dependent slice.
- Delivery slices: Phase 0 repair; schema/owner collection/read/UI; tracking; outlier reporting (algorithm may be developed earlier). No slice claims complete until all its live production callers are wired.

## 8. Validation commands and evidence policy

Run repository scripts: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:i18n`. Deno: `deno check` changed entrypoints and `deno test` targeted new functions/shared algorithms plus existing proxy/MCP regression suites using only necessary permissions. Inspect repository Deno config/import/permission pattern in Task 1 before fixing exact invocation. SQL: repository SQL test harness against throwaway migrated Postgres; never production. E2E: `npx playwright test e2e/analytics.spec.ts` against seeded local/test environment. Log environment failures separately from defects.

Coverage: source spec D1–D15, A1–A16, I1–I7, H1–H4, S1–S6, U1–U6, E1–E2, J1–J10 plus the concurrency, tenancy, lag, cursor, cache, metric-null and lease cases above. Amend D9 and S4 deliberately as noted (forced re-sync distinction; soft removal instead of cascading physical delete).

## 9. Eventual release ordering (not authorized now)

1. Rehearse schema, quota, ownership, job/retention and cron migrations against disposable database. Check rollback compatibility and exact live schema before any execution.
2. Apply/verify additive prerequisites with new schedules inactive. Confirm grants/RLS/credential visibility via live negative checks. No production secret in documentation.
3. Deploy reviewed changed functions and shared modules from immutable fetched ref via Contabo; verify SHA256 and per-function boot. Account for runbook reconciler and CLAUDE mandatory manual verification; do not race a scheduled overwrite.
4. Canary one direct and one page-linked owner, then one competitor. Validate source/null/metrics/date/permission behavior, API report and durable queue/usage stop. App Dashboard counts and nonzero views are observations conditional on available account data, not deterministic unit gates.
5. Enable daily enqueue and bounded drain only after backend/schema ready; verify first full due-target drain (including capped continuations), not merely first HTTP 200. Ship frontend through chosen landing route; main release may also auto-sync functions, so schema must already exist.
6. Verify applied migration IDs, deployed exact hashes/ref, latest success/partial states, quota/tenant tests, frontend journeys and no token logs. Rollback pauses new schedules and disables UI/new workers first; leave additive tables/history intact. Never reset server checkout or drop history as rollback.

## 10. Debate record

Three rounds requested by Waleed. Each reviewer receives spec, current plan, repository evidence and prior verdicts. Requested findings only, no file edits. Record dispatch baseline and verify HEAD/status plus file hashes unchanged; do not claim an enforced read-only sandbox when using a writable agent tool.

### Round 1

Reviewer: Cursor `grok-4.7-high`. HEAD remained `718940fe210c93abac79a37179055e5eb300a5d6`; status unchanged, tracked diff empty; plan/spec SHA256 unchanged (`1FEBC2CC…E5F61D2` / `E6EDDB35…7AE97E`). This verifies requested no-edit behavior; it is not an enforced sandbox claim.

| # | Finding | Sev | Verdict | Reason |
|---|---|---|---|---|
| R1.1 | Legacy empty scope arrays falsely deny discovery | P1 | accept | Legacy writer sets timestamp on failed reads; add explicit read-state migration semantics below. |
| R1.2 | Same-day reruns starve continuation | P1 | partial | Normal/forced distinction already in §5.3; make completion/freshness and capped-inventory acceptance explicit below. |
| R1.3 | Three-day total_value corrupts daily rows | P1 | partial | §5.3 already requires day checkpoints, but one-request-per-day and observation separation now mandatory. |
| R1.4 | Quota arbiter return type cannot be replaced additively | P1 | accept | Avoid destructive drop/recreate: dedicated competitor entitlement RPC shares existing precedence and tested subscription selection; trigger covers direct writes. |
| R1.5 | Existing metadata RPC cannot serve cron; status client-writable | P1 | accept | Put authoritative sync state outside account metadata; new service-only fenced update; audit existing user_token exposure. |
| R1.6 | Code 10 is not a permission classification | P1 | partial | Distinction already required in §5.3; freeze fixtures/table before collector implementation. Unknown cases do not guess scope. |
| R1.7 | Cache SELECT still globally allowed | P2 | reject | Later migration `20260419214711…sql:97–108` removes all SELECT policies, matching baseline RLS. Verify deployed grants/policies in Task 1; do not claim old policy is current. |
| R1.8 | Optional guard leaves service writes cross-owner | P2 | accept | Require structural composite FKs and guarded unambiguous post linking, not a TypeScript-only alternative. |
| R1.9 | Top-30 inventory can look like a full week | P2 | accept | Add conservative completeness signals and media_count-delta check; return partial rather than invented posting rate. |
| R1.10 | Performance UI may compute a second report | P2 | accept | Freeze and wire report boundary before Task 9; UI may format, not recalculate analytics. |

#### Binding clarifications after round 1 (override looser wording above)

1. **Scope state:** newly read permissions persist `scopes_read_state=ok|failed` (or a versioned equivalent) in protected state. Only `ok` makes the recorded set authoritative for grant or denial. ALL legacy arrays, including nonempty arrays/timestamps, are unknown until a successful bounded service-side reread; do not backfill `ok`. Never overwrite an established successful scope record with a failed read. Client-patched metadata is not proof of grants: canonical capability state is service-write-only. Spec D3 skips lists lacking insights only for protected `ok` reads; unknown candidates remain selectable at lower rank.
2. **Complete means complete:** normal continuation skips successful captures today, retries failed IDs and retains remaining IDs/cursor. A budget-ended slice is partial/requeued, not job-complete. A capped inventory remains visibly truncated; do not advance full-coverage last_success_at. Store last_partial_at separately so useful partial metrics are readable. Replace spec Phase 1's one-cron/all-90-days sentence with: every eligible account is attempted fairly; all discoverable due work drains across bounded continuations, and cap-excluded coverage is explicitly reported. A forced request creates a generation/revision without allowing competing same-day workers.
3. **Account days:** yesterday and preceding two dates each get their own total_value call; interactions and follow breakdown have independent `(provider_date, query_kind)` outcomes/checkpoints. Never send a three-day total then fan it into daily rows. Task 1 must establish actual provider timezone/alignment/inclusivity with adjacent-window request/response fixtures spanning both UTC and Kuwait midnight, including documented bucket labels. Only after that evidence freeze bounds and persist `period_start`, `period_end`, `provider_timezone` and `metric_date` matching the actual aggregation. Kuwait is the scheduler/display timezone, not permission to relabel a provider-day bucket. If custom Kuwait ranges are unsupported, propose explicit provider-day reporting to Waleed; do not synthesize Kuwait daily unique reach from indivisible totals. Until verified this collector is blocked, not guessed. Equal numerical totals on adjacent days are valid and are NOT evidence of overlap. Profile followers/media_count are separate observations keyed by capture time/day; never copy today's observation into repair rows.
4. **Quota compatibility:** add approved competitor columns to subscription_plans/user_quotas. Do not change `effective_user_quotas(uuid)` return type or drop it. Add service-only `effective_competitor_quota(uuid)` using identical deterministic plan selection, active/past_due behavior and override→plan→approved free fallback; admin bypass lives in the watchlist enforcement trigger and owner quota-read boundary, matching media's writer pattern. Test precedence/selection parity, not literal equality between limits for different resources. Browser gets only its resolved quota through owner-bound read boundary. Enforce add/reactivate in DB: insert a missing user_quotas row using canonical NULL-means-inherit limits, ON CONFLICT DO NOTHING, then lock it FOR UPDATE and count active watchlist entries; do not lock auth.users. Include approved competitor column as NULL, avoid defaults inventing other-resource overrides, and enforce direct PostgREST writes. Restrict owner updates to label/active controls; protect operational columns, immutable username/owner and physical DELETE. Extend frontend quota resolution/editor without altering legacy entitlement results. This is an intentional narrower alternative to reviewer-proposed cascading arbiter replacement.
5. **Credentials/status:** Task 1 inspects existing Facebook Page metadata `user_token` (`facebook-oauth/index.ts:754/:946`) and browser selects without printing it. Existing exposed credentials are not a precedent. If reused, migrate to server-only storage, redact browser-readable metadata, audit cached client projections and identify other backend consumers before removal; no unsafe duplication. `instagram-business-oauth` currently discards its User token after listing pages. Protected sync/capability/job state is authoritative; account_metadata insights_* is at most a compatibility mirror, never used as authority for freshness, scope or rate limits. Existing patch_account_metadata (auth.uid-bound) and workspace-specific variant are not cron adapters. Add service-only owner-bound atomic update/checkpoint RPC with lease/generation/credential-version checks; no success update can clear newer needs_reauth or overwrite OAuth metadata.
6. **Classifier:** fixtures must distinguish 190, confirmed account-level missing scope, insufficient media viewers, unsupported metric, empty data, throttle, and unknown code 10. Insufficient viewers is null with reason, not reconnect. Unclassified code 10 is a bounded retryable item failure, not permanent permission denial. Do not classify by code number alone.
7. **Foreign keys:** require parent `UNIQUE(id,user_id)` and composite snapshot FKs for account/watchlist ownership. Require owner-consistent optional post reference and a guarded writer resolving owned platform_posts/account/media; missing or ambiguous mapping yields null, never arbitrary first match. FK deletion behavior must preserve required owner keys. If existing dirty parent data prevents constraints, Task 1 reports it and designs a non-destructive preparation migration; don't silently skip constraints.
8. **Report wiring:** freeze canonical response DTO and implement authenticated `instagram-insights-report` read boundary (or an explicitly selected equivalent secure RPC) in Tasks 5/10 before Task 9 begins. The same pure report assembler/repository powers the UI boundary and the proxy's Instagram branch. UI infrastructure calls that boundary only; it does not read raw snapshot tables or compute a second engagement/outlier/freshness algorithm. Keep report pagination/display separate from independent baseline history retrieval. Update execution order to Task 5 → Task 10 report contract/wiring → Task 9; Task 10 optional competitor tools remain separate.
9. **Inventory completeness:** persist oldest returned timestamp, ordering guarantees, cursor presence, capture interval and inventory-gap reasons. A saturated 30-result window is incomplete for the seven-day interval only if it does not establish coverage back to its start (oldest timestamp still inside window and older items may exist); an unfollowed cursor covering posts older than the interval does not itself make that interval incomplete. Require verified chronological provider semantics; otherwise report unknown/partial. media_count delta is a diagnostic for possible gaps, not proof of exact missing feed IDs (removal/Stories can affect totals). Missing scheduled intervals also require coverage evidence from later inventory; otherwise partial. Show observed count/interval, not an invented complete rate, and test established accounts with 30 lifetime posts but only 3 this week.
10. **Direct-login fields:** freshly fetched [IG Media reference](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media) documents media_product_type as Facebook-Login-only and media_url as optional. Task 1 must verify actual direct-login version/response support before specifying its list fields. Missing product type cannot make all direct media skipped or all VIDEO inferred REELS: use verified supported classification/metric capability with explicit unknown fallback and tests; block affected collection if no safe classification is available. Thumbnails/permalinks remain usable when media_url is absent.
11. **Actual DB harness:** `supabase/tests/README.md` and `scripts/db-harness.sh` use schema baseline + newer delta migrations, not historical full replay. Use the isolated supabase/postgres image and disposable harness DB with cron preload settings. Register new suites in the runner (not merely add SQL files); run two-session quota/lease race tests separately. No migration ledger may exist: production verification includes catalog/object definitions and transaction execution evidence, not merely checking a presumed migration-history table.

### Round 2

Reviewer: Cursor `grok-4.7-high`. Same HEAD/status, tracked diff empty; plan/spec hashes unchanged during dispatch (`2E4FC218…BCD4D75` / `E6EDDB35…7AE97E`).

| # | Finding | Sev | Verdict | Reason |
|---|---|---|---|---|
| R2.1 | Protected capability prerequisite comes after its consumer | P1 | accept | Task 3a is mandatory before Task 2; legacy metadata never establishes authority. |
| R2.2 | Kuwait ranges may not equal provider days | P1 | partial | Reviewer asserts unsupported boundary behavior without provider evidence; retain a blocking probe/explicit bucket contract, not the asserted fact or invalid 'totals must differ' gate. |
| R2.3 | One date checkpoint loses failed follow query | P1 | accept | Independent query-kind outcomes; transport failures stay due and dates remain retryable beyond repair window until terminal outcome. |
| R2.4 | Report/UI acceptance introduces dependency cycle | P1 | accept | Split Task 10a backend contract vs Task 11 UI/proxy comparison; rewrite execution order and include server engagement in DTO. |
| R2.5 | Full page always means incomplete week | P2 | accept | Use oldest timestamp and relevant-window coverage, not total returned count alone. |
| R2.6 | Admin bypass in wrong quota layer; owner-row lock | P2 | partial | Correct bypass placement/insert-then-lock pattern; parity is selection semantics, not equality of unrelated resource limits. |
| R2.7 | Mutable username relabels historical snapshots | P2 | accept | Username immutable; different handle gets its own row/history through add/reactivate. |

#### Binding clarifications after round 2

- Task 3a establishes a service-write-only Instagram connection/capability record (owner/account/token reference, trusted login kind, credential generation, permission read result). Task 2/6 use a new pure transport selector taking ONLY that trusted login kind, not `isDirectInstagramAccount`'s metadata heuristics. Existing messaging helper/callers stay unchanged. All legacy scope metadata is unknown until server revalidation, even a nonempty array. Prevent authenticated mutation of capability-driving ig_auth_type and relevant legacy metadata keys through direct updates AND patch RPC paths; preserve existing legitimate UI metadata writes with an explicit allowlist/compatibility audit, not a global revoke that breaks other features. OAuth/refresh are authoritative writers. No capability permits cross-owner token lookup.
- A successful empty/insufficient-data response is a typed unavailable query result; a timeout/5xx/parse/write error is not. Account-day queries have independent committed outcomes. A repair scan may reread successful recent query results for lag correction while failed queries remain durable due jobs; they do not disappear when older than the three-day repair horizon. A date is complete only when all approved query kinds have success or explicit terminal-unavailable outcomes, never because one row exists.
- Task 10a completion requires report assembler + authenticated boundary + Instagram proxy wiring and identical backend fixtures, NOT an existing UI. Task 9 consumes its frozen DTO (including nullable engagement_rate and metric-basis/reason fields) and formats only; remove spec's proposed frontend engagement computation as a plan amendment. D15 tests null numerator as well as null/zero reach. UI/proxy end-to-end agreement belongs to Task 11. Task 5 may be committed as a dependency but is not release-complete until Task 10a calls it.
- Watchlist username and owner are immutable in database for normal mutations. A different target handle is a separate add/reactivate under quota; old snapshots remain associated with their observed identity. Real Instagram rename detection and cross-handle history merging are not silently implemented.

### Round 3

Reviewer: Cursor `grok-4.7-high`. Reviewer reported shell denied in this invocation; evidence is from its read-only file inspection and prior context, not reviewer-reconfirmed HEAD. Orchestrator independently verified unchanged HEAD/status, empty tracked diff, plan/spec SHA256 unchanged during dispatch (`2667488D…98797C` / `E6EDDB35…7AE97E`).

| # | Finding | Sev | Verdict | Reason |
|---|---|---|---|---|
| R3.1 | Earlier scope wording still contradicts protected state | P1 | accept | Replaced old legacy-array wording and explicitly amended D3; no trusted backfill. |
| R3.2 | Metadata classifier remains in transport prose | P1 | accept | Replaced core §5.3/evidence wording: new selector takes protected login kind only; legacy messaging unchanged. |
| R3.3 | Credential cutover omits readers/refresh writers | P1 | accept | Explicit Task 3a/2 credential slice scope and generation writer contract below; consumer search confirmed three metadata readers. |
| R3.4 | Force generation retains success checkpoints | P1 | accept | One daily job row, generation-specific checkpoint reset and fenced upserts below. |
| R3.5 | Old failures can starve current account-day repair | P1 | accept | Fresh-day reservation, bounded cross-slice backoff and oldest-due fairness below. |

#### Final binding execution details

These details and the corrected core sections are the current plan. Debate tables retain historical findings, not alternative implementation choices. Where initial spec sketches conflict, the named amendments require approval before implementation.

- **Credential-cutover subtask (Task 3a schema + Task 2 writers/readers):** scope explicitly includes `facebook-oauth`, `instagram-business-oauth`, relevant Instagram/Facebook paths in `refresh-tokens` (including `handleRefreshSuccess`), `ad-analytics`, `threads-location-search`, `facebook-places-search`, and their tests plus any additional `user_token` readers/writers found in Task 1. Do not alter unrelated platforms' refresh semantics. Establish protected store and transactional writer first; copy/revalidate old credentials without exposing values; deploy compatible server readers/writers before removing browser-visible user_token keys. During bounded cutover, legacy browser exposure already present is a documented risk to eliminate, not permission to create a new exposed copy. Remove old metadata key only after every active reader is switched and rollback compatibility reviewed; preserve protected row ownership/cascade deletes. Page access tokens/messaging migration is not implicitly included. If compatible cutover cannot be made within approved scope, block and request scope approval, not redact credentials and break existing readers.
- **Generation ownership:** credential replacement/reconnect/revocation atomically updates protected credential generation alongside authoritative token/status change. Refresh writer and sync completion use the same owner/account-scoped transactional contract; do not merely increment a counter in a later network request. In-flight sync may persist data only with a still-valid claim and matching connection generation; stale results never clear reauth. Browser ownership changes/deletes are checked by the same structural constraints.
- **Force semantics:** one work row per account/capture day. An accepted force after the shared 15-minute throttle reopens that row transactionally: bump job generation, set due, reset that generation's media/query success checkpoints, and supersede old claims. No duplicate worker row and no ON CONFLICT DO NOTHING that discards force. Snapshot upsert must be inside the fenced transaction (claim token + job generation + credential generation), not only fence the final job-status update. Old workers cannot overwrite a newer forced snapshot even if their HTTP response arrives late. Normal continuations skip success only within their current generation; force actually recollects.
- **Fair retry:** reserve a bounded share of each account's request budget for latest eligible daily reconciliation and media progress; use the remainder for older failed query kinds. Claim only eligible retry_at<=now. Persist attempts and exponential backoff across invocations with a cap (proposed 1m→5m→15m→1h→6h), plus jitter; exact timings confirmed in Task 1 runtime configuration. Old persistent failures stay visible/durable and retry at capped intervals, never occupy every tick. Classifier-recognized permanent/expired-provider-window outcomes become terminal-unavailable with reason, not silent deletion. App throttle backoff overrides all queues. Tests pin one permanently failing old date alongside successful fresh dates and media so current data advances.

No fourth review round is implied; final corrections are orchestrator-adjudicated. Product/credential/provider-day decisions and implementation gates remain open, so three debate rounds do not mean authorization or live readiness.

## 11. Planning-stage completion

Three requested rounds completed; 22 findings adjudicated (including evidence-backed partial/rejected claims), revisions incorporated. A concurrent process committed the supplied spec and gap analysis unchanged in `718940fe` while this plan was being drafted; preserve that user work and do not recommit it. Commit only this debated plan. Documentation validation: task/debate structure and local links checked, diff whitespace/secret-pattern review performed before commit. Dedicated docs-guard unavailable, so this is manual documentation review, not a passed guard invocation; implementation requires available guards or explicit waiver. Production/test guards and application suites not applicable to this documentation-only diff; no production code changed. mem0 recall/save unavailable. No push, merge, deployment or production access performed. Ask implementer choice; implementation remains paused until chosen and remaining decisions/configuration are confirmed.
