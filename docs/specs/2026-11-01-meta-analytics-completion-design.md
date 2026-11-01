# Completing owned-account analytics for Instagram, Facebook Pages and Threads — design

**Status:** design, not an activation approval.
**Date:** 2026-11-01.
**Baseline:** `main` at `dd7f02c303c5210147ab49184ce82c17be7a4ae9`. Current-state evidence lives in the status review `docs/journeys/2026-11-01-meta-analytics-status.md` ([PR #327](https://github.com/lolotam/POSTORA/pull/327)); this spec does not repeat it.
**Plan:** [`docs/plans/2026-11-01-meta-analytics-completion.md`](../plans/2026-11-01-meta-analytics-completion.md).
**Required reading for implementers:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §§4, 10–17, 22–24, 27–28, 31–34 and 36–39 (dependencies, adapters, authentication, contracts, storage, scheduling, testing and compatibility); [`docs/specs/2026-10-30-instagram-release-gates.md`](./2026-10-30-instagram-release-gates.md); [`docs/runbooks/instagram-collection-rollout.md`](../runbooks/instagram-collection-rollout.md).

---

## 1. Goal

The analytics section is complete when, for each of Instagram, Facebook Pages and Threads:

1. the data shown for a connected, owned account is **correct** (reconciled against Meta's own UI or API within the tolerances in §9),
2. it is **persisted** and **refreshed on a schedule**,
3. missing, partial, stale and failed data is **shown as such**, never as `0`,
4. ownership is enforced and covered by tests at every boundary, and
5. the user journeys in §10 pass on production for a named pilot account.

## 2. Non-goals

- Competitor tracking, competitor retention, and the deferred paid Apify path. They keep their existing approvals and are not part of any gate here.
- Public API v1 analytics (`docs/developer/analytics.md`), TikTok, YouTube, Pinterest.
- Replacing `brand-scrape`. It stays the **public Page / profile analysis** tool; owned-Page insights are a separate surface.

## 3. Facts this design rests on (verified against source)

| Fact | Evidence |
|---|---|
| Instagram service-role report calls fail with 401: the composition root calls `authenticateCaller(req)` without the body user id; the helper requires it for service-role callers. | `supabase/functions/instagram-insights-report/index.ts:35`, `supabase/functions/_shared/auth-helper.ts:37-54` |
| The report handler's cursor accepts only `publishedAt`/`mediaId`. | `supabase/functions/instagram-insights-report/handler.ts:35-52` |
| The overview card sums daily `reach` and labels it "Unique accounts reached"; one available day is enough to show a period total. | `src/features/instagram-insights/ui/MetricsOverviewCards.tsx:29-40`, `:63-65` |
| The Instagram report DTO already carries `coverage`, `truncated`, `lastPartialAt`, `retryAt`. | `src/features/instagram-insights/domain/types.ts:159` |
| Instagram followers are point-in-time observations, stored separately from daily insights. | `supabase/migrations/20261026130000_instagram_insight_tracking_schema.sql:533-542` |
| Durable collection job SQL and the worker store accept only `platform = 'instagram'` targets. | `supabase/migrations/20261026150000_instagram_durable_collection_jobs.sql:428-432`, `supabase/functions/instagram-insights-sync/workerStore.ts:854` |
| Facebook analytics reads **public** Page data with an **app** token; no owned-Page `/insights` call exists in `supabase/functions`. | `supabase/functions/brand-scrape/index.ts:163-241` |
| `facebook-oauth` **requests** `read_insights` and `pages_read_engagement`; requesting is not proof of grant. | `supabase/functions/facebook-oauth/index.ts:72-75` |
| `threads-insights` is live-only, coerces missing metrics and failed previous-period/per-post reads to `0`, fetches post insights sequentially without timeouts for the latest 25 posts only, and falls back to another Threads account if the requested `accountId` is not found or the read fails. | `supabase/functions/threads-insights/index.ts:94-114`, `:192-224`, `:235-258` |
| `threads_manage_insights` is probed at connect time. | `supabase/functions/threads-oauth/index.ts:33`, `:185` |
| The service proxy forwards `threads-insights` and `instagram-insights-report` with a 45 s timeout and periods `7/14/30/90`. | `supabase/functions/n8n-api/serviceProxy.ts:47`, `:54`, `:239-252` |
| The Threads UI renders the current response as plain numbers. | `src/components/brand-intelligence/ThreadsInsightsPanel.tsx:448` |

## 4. Unified analytics contract

One contract, defined in the domain layer and mirrored once for Deno:

- Frontend: `src/features/analytics-contract/domain/` (types, metric registry, pure helpers).
- Edge: `supabase/functions/_shared/analyticsContract.ts`.
- A parity test compares the canonical serialized schema and registry in full: all fields, discriminated unions, unavailable reasons, coverage, registry metadata, period and sync-status constraints and `analyticsContractVersion`. Shared behavioral fixtures cover calendar, aggregation, delta and freshness rules in both runtimes; a deliberate isolated-copy mutation must fail parity. Matching only keys/status names is insufficient.

### 4.1 Metric value

```ts
type MetricValue =
  | { status: "available"; value: number }
  | { status: "partial"; value: number; coverage: { availableDays: number; expectedDays: number } }
  | { status: "unavailable"; reason: UnavailableReason };

type UnavailableReason =
  | "capability_unverified" // provider support has not been verified
  | "not_offered"          // the platform has no such metric
  | "permission_missing"   // scope not granted / token lacks permission
  | "reauth_required"      // expired, revoked or invalid credentials; reconnect
  | "outside_retention"    // requested window older than the provider keeps
  | "not_collected"        // not yet synced / collection off
  | "provider_error"       // provider call failed
  | "window_mismatch";     // provider buckets cannot represent the requested bounds
```

Rules:

- `unavailable` is never rendered or aggregated as `0`. A provider-reported `0` is `available` with value `0`.
- Completeness is measured **per metric**, not per row. `availableDays` counts distinct expected provider-day buckets containing a finite, valid value for that metric and scope. A present `ok` row with a null/absent/failed metric does not count; retries never add an extra day. Only all expected metric values produce `available`; some produce `partial` with coverage; no values produce `unavailable` with the actual cause. A genuine numeric zero counts as available. No daily-sum calculation applies to `not_summable` metrics.
- Truncation (`truncated`), partial collection (`lastPartialAt`) and back-off (`retryAt`) from the Instagram report are kept at report level, not dropped.

### 4.2 Metric definition (registry entry)

Each registry entry states: `key`; `platform`; provider metric name and API version; level (`account` | `post`); unit (`count` | `accounts` | `percent`); window kind (`day` | `period_total` | `lifetime` | `point_in_time`); aggregation (`sum` | `last` | `not_summable`); provider bucket timezone; i18n definition keys (ar/en); minimum permission; and capability status (`unverified` | `available` | `not_offered`). The latter two require a stable probe evidence reference and verification timestamp. Capability describes provider support; `MetricValue` describes this particular response, account and window.

`not_summable` metrics (for example unique reach) are never summed across days; a period value comes only from a provider period total or is `unavailable`. `views` and `impressions` are distinct keys; a platform that offers only one leaves the other `not_offered`.

### 4.3 Common metric set

Registry platform configuration also declares `staleAfterSeconds`, a positive integer measured from the last successful persisted collection's `collectedAt` to evaluation time, for that platform's report sync state. The proposed pilot value is 172800 seconds for each platform, reviewed with B2 evidence before activation. Equality is fresh; a greater age is stale. Missing success is `never_synced`; active work, failed attempts and partial collection retain their explicit states rather than being masked by the age calculation. A provider's observation window and its data lag remain separate metadata; a historical period is not made stale merely because its `since` is old.

Reach, views, impressions, engagements (with components: likes, comments/replies, shares/reposts, saves, quotes), followers (point-in-time count and net change), per-post performance, previous-period delta.

`profile_views` is a separate normalized key from content `views`. The selected Threads account's provider metric named `views` describes profile visits; its post-level metric describes content views. Account profile visits must never be relabelled as content views or compared as the same measure across platforms. Cumulative follower counts use `last`/observation comparison, never daily summation.

The per-platform mapping table is **filled from the live probe evidence (§6)**, not from memory. An unverified registry cell maps to `unavailable: capability_unverified`; verified absence maps to `not_offered`. `not_collected` is reserved for verified capabilities whose collection has not run or is off. None of these states proves permission for a specific account.

The [live evidence record](../journeys/2026-11-01-meta-live-capabilities.md) now establishes the following candidate meanings. These are not fully verified registry entries: provider calendar, exact-window behavior, retention and remaining permission prerequisites still need the complete §6 evidence. Definitions came from actual provider response metadata captured at `2026-11-01T05:03:27Z`; no private measurement values are reproduced here.

| Platform / level | Provider metric / observed version | Normalized meaning | Aggregation constraint |
|---|---|---|---|
| Facebook account | `page_media_view` / `v25.0` | Content displays, including Page posts, stories and ads; candidate `views`. | Sum only complete aligned daily buckets; preserve the inclusive content definition. |
| Facebook account | `page_total_media_view_unique` / `v25.0` | Unique media viewers; candidate unique-audience metric. | `not_summable`; exact-period reach remains unavailable without a proven provider total. |
| Facebook account | `page_post_engagements` / `v25.0` | Daily post interaction actions. | Sum only complete aligned daily buckets; never label as unique engaged accounts. |
| Facebook account | `page_follows` / `v25.0` | Cumulative lifetime follower balance, despite response `period: day`. | `last`; never sum across days or treat a daily snapshot as new follows. |
| Facebook post | `post_media_view`, `post_total_media_view_unique` / `v25.0` | Observed numeric lifetime views / unique viewers; unique metric also returns daily rows. | Select the proven row/window explicitly; never mix daily and lifetime rows. |
| Threads account | `views` / requested `v1.0` | Profile visits; `profile_views`. | Keep all daily buckets and validate calendar coverage before aggregation. |
| Threads account | `likes`, `replies`, `reposts`, `quotes` / requested `v1.0` | Interaction action totals; returned without dated daily buckets in the initial capture. | Do not invent daily trends from these totals; exact requested-window behavior remains to be verified. |
| Threads account | `followers_count` / requested `v1.0` | Current total follower count. | Point-in-time observation; growth requires two valid persisted boundary samples. |
| Threads post | `views`, `likes`, `replies`, `reposts`, `quotes`, `shares` / requested `v1.0` | Observed numeric lifetime per-post metrics. | Preserve lifetime scope; do not claim these are interactions occurring within the selected reporting period. |

`post_engaged_users` was explicitly rejected as an invalid insights metric on the observed Facebook surface. That rejection alone neither identifies its replacement nor proves all post-engagement metrics are unavailable. Instagram's selected Page-linked account has no protected credential binding, so no live metric-support claim is made for it.

### 4.4 Period and delta

- Period `{ since, until, timezone }`: `since` and `until` are RFC3339 UTC instants, with inclusive start and exclusive end `[since, until)`; `timezone` is the pinned IANA report/bucket timezone from the verified registry, not the browser's timezone. Supported selections contain 7/14/30/90 **closed calendar days**, ending at the start of today in that timezone. Previous period contains the same number of calendar days immediately before `since`. Calendar arithmetic handles month/year boundaries and DST; neither expected-day counts nor previous periods assume every day lasts 86,400 seconds.
- Provider bucket boundaries and timezone are retained alongside the normalized period. A provider total is usable only for the exact requested bounds; daily aggregates are not redistributed or prorated into a different timezone. Unsupported timezone/boundary combinations return `window_mismatch`. Raw timestamped events may be rebucketed only where the adapter can prove complete event coverage. Tests cover inclusive/exclusive boundaries, month/year rollover, DST and provider/report timezone mismatch.
- Delta is `unavailable` if either side is not `available`, or if the previous value is `0` (no percentage; the absolute difference may be shown).
- A previous period older than the provider's retention is `outside_retention`, never a silent zero.

### 4.5 Sync status

`never_synced | syncing | fresh | stale | partial | failed(reason)`, plus `asOf` (data end), `collectedAt` (last successful write) and `retryAt`. "Stale" thresholds are per platform and set in the registry.

### 4.6 Versioning and compatibility

The unified contract uses the distinct discriminator `analyticsContractVersion: 1` in both request and response. It does not reuse the existing Instagram owner's `schemaVersion: 1`. Omitting the new field preserves each endpoint's legacy response; explicitly requesting `analyticsContractVersion: 1` selects the unified shape, including for Instagram and the proxy. Unsupported contract versions are rejected explicitly. Existing consumers (Threads panel, service proxy / MCP) keep their legacy requests until migrated. Compatibility tests cover default legacy requests, explicit unified requests and unsupported versions across the real composition boundaries.

## 5. Workstream 1 — Instagram defects and pilot

1. **#326** (Sync rejection message) is reviewed, valid review findings are resolved, and the exact passing revision is merged.
2. **401 fix** in the composition root: pass the validated body `user_id` to `authenticateCaller`, so service-role callers resolve identity and user-JWT callers keep JWT identity (the helper already prefers the JWT on mismatch). Ownership stays structural (account looked up by `user_id` + `id`). Regression runs through the real composition, plus cross-owner rejection.
3. **Cursor contract:** one codec owned by the report contract; the gateway uses it. A boundary test round-trips gateway → handler.
4. **Pagination:** the screen passes the cursor and `onLoadMore`; pages accumulate without duplicates; end of list is detected.
5. **Correct totals:** unique `reach` is never a sum of daily values. It requires an exact provider period total or is `unavailable`; this scope adds no daily-sum reach metric. Summable metrics use per-metric coverage from §4.1. This is a precondition of the pilot.
6. **Pilot (owner analytics only):** local owner readiness uses separately named owner-only artifacts and does not satisfy or replace the canonical Task 11 G-X checker. That checker's full acceptance inventory, including unresolved competitor work, remains intact and fail-closed. Before any pilot, the authoritative release prerequisites must be satisfied, or an explicit owner-approved scope amendment must be recorded in their owning specification; this design is not that approval. Then the applicable operations are B1 (manifest/preflight), B2 (separately approved deployment of the A2–A5 candidate), B3 (pilot user list), C1–C2 (reconnect/session checks), C3 (separately approved test post), D1 (RC-proven target admission) and D2 (exactly one owner, all other targets excluded). D3, E1 cohort widening and E3 competitor retention remain out of scope. A separately approved **pilot-only schedule step**, before stability measurement, names the owner enqueue/drain jobs, exact cadences, candidate and allow-list. It is not a completion claim for canonical E2's wider-cohort/scale acceptance. No deployment occurs in the earlier local-fix tasks.
7. **Reconciliation** against Meta (§9) before any wider rollout.

## 6. Workstream 2 — live capability verification for all three platforms

A read-only **capability probe** per platform, run against owner-approved connected accounts, produces a committed evidence record. It gates workstream 4.

For each metric × level × window: requested API version, HTTP result, value present / absent / error code, earliest date that returns data, maximum request window, provider bucket timezone/bounds, pagination behaviour, rate-limit headers and the error-to-`UnavailableReason` mapping.

- **Facebook:** owned Page insights with the stored **Page** token (`/{page-id}/insights`, `/{post-id}/insights`), checked against current Meta documentation for deprecated metrics and their replacements at the pinned Graph version. Granted scopes are read from the token debug result, not from the requested list.
- **Instagram:** owned account and media insights with the approved account's stored token, including exact-period reach support, daily bucket boundaries, follower observations and pagination. A7/A8 evidence may be reused only when it supplies every required field for that registry cell; otherwise B2 must probe the missing capability. Stored data alone does not prove capability for a new metric or window.
- **Threads:** `threads_insights` (account), `/{media-id}/insights` (post), listing pagination, retention window per metric.

The probe never writes provider data to analytics tables and never logs tokens. Expired/revoked-token and missing-permission behavior is tested with sanitized fixtures at the real adapter/HTTP boundary. Live probes may observe such a state if it already exists; they never expire, revoke, downgrade or replace a pilot grant to create it. A destructive live negative test is optional and requires its own approval, a named disposable account/token, blast-radius limits, and a verified reconnect/recovery procedure before execution.

## 7. Workstream 3 — contract adoption on live paths

- **Instagram compatibility path:** add explicit unified-contract negotiation to `instagram-insights-report`, its gateway and the service proxy before the shared UI migration. The legacy owner DTO remains the default. The unified assembler uses verified registry cells and persisted metric provenance; absent period totals or unproven capabilities remain unavailable. Endpoint and proxy tests cover legacy/default, explicit unified and unsupported versions through the real composition boundaries.
- **Threads live path** first decodes provider responses correctly: missing metric → `unavailable`; failed previous period → delta `unavailable`; one failed post → that post's metrics `unavailable`, others intact; multi-day series kept.
- **Account selection:** a requested `accountId` that is not found, inactive, or not owned is rejected (404-style, non-enumerating); a database error is a 5xx; neither falls back to another account; the provider is not called.
- **Bounded work:** per-request limits on pages, provider calls and wall time below the proxy's 45 s; per-call timeouts; parallelism cap; throttling surfaced as `retryAt`; continuation cursor returned to the caller (opaque, never a provider URL containing a token).
- **Facebook live path:** an owned-Page insights read adapter mapped to the contract, separate from `brand-scrape`.

## 8. Workstream 4 — history for Facebook and Threads

### 8.1 Storage

Per platform, mirroring the Instagram split:

- account daily insights: `fb_page_insight_daily`, `threads_account_insight_daily`;
- post snapshots: `fb_post_insight_snapshots`, `threads_post_insight_snapshots`;
- point-in-time observations (followers, fans): `fb_page_profile_observations`, `threads_account_profile_observations`. Follower growth is the difference between two valid observations; the current count is never back-filled into past days.

Ownership, RLS (deny by default), grants and metric whitelists follow the Instagram tables. Only metrics proven by the probe are whitelisted.

**Per-metric provenance:** every persisted daily, post, profile and exact-period measurement carries a validated metric state, sanitized `UnavailableReason` when unavailable, provider window, capture time and evidence/source reference. A nullable numeric column and row-level status are insufficient: omitted metrics, missing permission, `reauth_required` and provider failures remain distinguishable inside an otherwise successful response. C1 selects the concrete relational/JSON representation and constraints; C2 adds it before workers/report readers rely on it, including an additive Instagram provenance extension where needed for unified adoption. Older Instagram nulls have unknown cause and must not be relabelled as a proven permission/provider failure. Worker → persistence → report round-trip tests cover each failure cause and true zero; credentials/raw provider errors are never persisted in provenance.

**Business keys and indexes:** daily rows are unique on `(user_id, social_account_id, metric_date)`, where `metric_date` is the pinned provider-day bucket. Post snapshots are unique on `(user_id, social_account_id, platform_post_id, captured_on)`, where `captured_on` is the UTC capture day. Profile observations are unique on `(user_id, social_account_id, capture_id)`; `capture_id` identifies one provider response and is reused for write retries, while a genuinely new provider read receives a new capture ID and its actual observation time. Composite ownership/platform foreign keys prevent cross-owner or cross-platform links. Range indexes begin with owner/account and then date; post-report indexes additionally cover post ID, and profile selection uses `(observed_at DESC, id DESC)`. Upserts are fenced by the live claim and credential generation and cannot overwrite a newer capture with an older retry. Tests cover duplicate writes, same-day recapture, stale retries and cross-owner conflicts.

**Follower growth:** select the latest valid observation at or before each period boundary, using `(observed_at DESC, id DESC)` for deterministic ties, for the same owner/account. Samples must have passed the write fence at capture time; a later reconnect does not invalidate correctly persisted history from an earlier credential generation. Each selected observation must be within 24 hours before its boundary, and the end sample must be later than the start sample. Return both actual `observedAt` values with the change so this is explicitly a change between observations near the boundaries, not an invented historical count. Missing/stale boundaries yield `unavailable: not_collected`; provider/permission failures retain their actual reason. No later observation fills an earlier boundary, and zero growth from valid samples remains available.

**Retention:** the new Facebook/Threads history keeps a 365-day application window, which covers both supported 90-day comparison periods and repair lag. The floor is pinned at cleanup start (`UTC midnight today - 365 calendar days`). Daily rows are eligible only when their provider bucket ends at or before that floor; post snapshots only when their UTC `captured_on` is before the floor's date; profile observations only when `observed_at` is before the floor, retaining the latest valid pre-floor anchor per account. Rows overlapping or on the retained boundary remain. Retention never deletes account records, credentials, an active worker's target data, or rows needed by supported current/previous report windows. Reports must carry a consistent retention/as-of watermark; a cursor whose required history has expired is rejected explicitly. Cleanup is bounded and serialized with writes through the selected job model's target fence; no deletion proceeds for a target with an active collection lease. The C1 ADR must specify actual lock/fence order, foreign-key-safe deletion order, batch limit and race tests before C2 migrations. New retention switches default off and jobs are inactive; production deletion requires a reviewed dry-run count and its own subsequent activation approval. Instagram and competitor retention contracts are unchanged.

### 8.2 Collection jobs

**Exact-period identity:** C1 must define storage and indexes for verified period-total measurements in addition to the daily/post/profile tables. The business key includes owner/account, level and subject ID, metric key, provider API version, provider timezone, exact normalized provider `since` and `until` bounds and UTC capture day. A 7-day and a 30-day total ending together are distinct keys. Same-day recapture uses the latest fenced capture; retries reuse their capture ID and cannot overwrite newer responses. C2 adds ownership/window constraints and tests for both overlapping windows, same-day recapture, stale retries and exact-boundary report selection before C3/C4 use the model. The C1 ADR names the concrete tables/representation; it cannot omit this identity.

The Instagram job SQL and worker store are Instagram-only (§3), so they are **not** reused directly. Before any migration, the plan decides between:

- (a) additive migrations that widen the job model to a platform-tagged target with per-platform credential contexts, or
- (b) per-platform job tables reusing the Instagram TypeScript modules where they are platform-neutral.

Either way: applied migration bytes are never edited; platform isolation, lease fencing and reconnect behaviour have SQL/Deno tests; each platform has its own collection switch and rollout policy (`off` by default, explicit target allow-list), its own cron entries created **inactive**, and a retention policy.

### 8.3 Reports

A report function per platform (or one function with per-platform assemblers) returns the contract, with ownership checked per request and service-role identity handled as in §5, item 2.

## 9. Workstream 5 — unified UI and gradual rollout

- Shared components: account picker, period picker, summary cards, trend charts, top posts, sync-status banner. They render every `MetricValue` status explicitly and show definitions on hover.
- Instagram, Facebook and Threads screens consume the contract; Facebook's public Page analysis remains a separate tab.

**Reconciliation tolerances (pilot acceptance):** for each pilot account and each available common metric over a closed 7-day window, the stored/reported value matches the value Meta shows for the same window: counts exactly for provider period totals; daily sums within ±2 % or ±5 absolute (whichever is larger) to allow late provider adjustments; any larger gap blocks rollout until explained.

**Pilot stability gate (per platform):** measurement starts only after separate approval and activation of the exact pilot-only enqueue/drain schedule manifest. Each platform must have one scheduled collection for the named target on each of 7 consecutive closed provider-calendar days (7 distinct due-date receipts); drain invocations and duplicate retries do not count as additional scheduled collections. Every due collection succeeds or has a recorded retry to success, with no missed day, ownership/isolation failure, budget overrun or non-pilot writes. Zero scheduled runs cannot pass. The runbook records exact cron names/cadences, active flags, expected versus actual due dates, receipts and continuation/backoff evidence. Stop conditions include cross-owner reads, non-allow-listed writes, repeated permission errors, budget overrun and missed due dates. Rollback disables the target switch/eligibility and deactivates its enqueue/drain schedules; queries must prove inactivity and no further writes before the gate can be signed off. Canonical E2 wider-cohort/scale evidence remains separate.

## 10. Acceptance journeys

Scheduled-job success is separate from metric availability. A verified `not_offered` or genuinely `outside_retention` metric may remain unavailable in a successful job, with its cause persisted. `capability_unverified` or `not_collected` for an expected in-scope measurement cannot establish complete collection. `permission_missing` or `reauth_required` blocks pilot acceptance until corrected; `provider_error` requires a retry that completes before the same next-due deadline, otherwise the due date fails. A pilot also needs reconciled available measurements (including genuine zeros) for at least one supported account metric and one supported post metric; an all-unavailable job cannot alone prove working analytics. Negative fixture outcomes do not count as successful production receipts.

Reconciliation additionally covers point-in-time and derived values. Point-in-time counts must exactly match the provider response for the same capture/`observedAt`, retained as sanitized evidence; a later live count is not an interchangeable reference. Follower net change must equal the difference of the two individually reconciled boundary observations, with both actual timestamps disclosed. Lifetime post counts use that post's same-capture provider values. Percentages require independently reconciled numerator/denominator and identical metric/window definitions; compare the recomputed percentage within 0.01 percentage points (two-decimal display precision). Previous-period absolute change must match exactly from reconciled inputs, while its percentage uses the same 0.01-point rule and stays unavailable for a zero/missing/incomplete previous value. A compact/rounded UI count, unmatched observation time or mismatched window is insufficient evidence; obtain the exact API reference or keep that acceptance pending.

Each scheduled collection must succeed strictly before the next scheduled daily due instant for that target. A later retry may repair history but records the original due date as missed/stale and cannot pass the seven-day gate. Record due instant, completion instant, next-due deadline and retry lineage for every receipt; calendar/DST scheduling determines the deadline, not an assumed fixed day length.

After each rollback rehearsal, completion requires a separate owner-approved restoration of the same frozen candidate, target eligibility/allow-list and exact enqueue/drain schedules, followed by active-setting evidence, a successful post-restoration scheduled collection and zero non-pilot writes. Rollback safety evidence is retained; a system left disabled cannot pass §1's scheduled-refresh requirement. This is restoration within the approved scope, not cohort widening.

Per platform, on production for the approved pilot account: open analytics → choose account and period → see summary, trend, top posts with sync status → paginate posts to the end without duplicates → confirm values against Meta (§9). Separately, the isolated fixture journey must show `permission_missing` and expired/revoked-token states through the real adapter and UI. Production negative states are observed only when already present; deliberately changing a live grant follows the optional separately approved disposable-account procedure in §6, not the read-only probe or normal pilot journey.

## 11. Security and data rules

- Layering and Edge Function shape per `ARCHITECTURE.md`.
- Service role only for workers and the proxy; every user-facing read checks ownership structurally.
- No tokens in logs, responses, cursors or evidence records.
- Migrations precede the runtime that depends on them; SQL tests cover ownership, grants and concurrency.

## 12. Approvals (owner decisions)

Retention activation is also a distinct owner decision: approve the bounded dry run first, then separately approve the exact retention switch, deletion scope and cleanup schedule after reviewing its counts. Neither a collection-switch approval nor a general cron approval authorizes production deletion.

Bounded read-only probes under §6 require owner-authorized targets. During this session Waleed expressly delegated selection among accounts connected to the administrator, then specified the platform targets; the latest explicit selection governs. The restricted authorization record retains the exact owner/account mapping and instruction order, while the [public journey](../journeys/2026-11-01-meta-live-capabilities.md) uses opaque aliases. These explicit instructions cover the named reads without another confirmation; a general task request alone does not replace this target-approval record. Preliminary operator-selected observations are diagnostic only and do not establish target-approved acceptance retrospectively.

This selection is not admission to a collection pilot. The scope excludes token renewal/revocation, permission changes, posts, analytics writes, collection switches, allow-list admission, schedules and paid Apify. Public evidence contains capability metadata and artifact hashes, excluding account handles, owner associations, private measurements and credentials; exact target mappings and detailed measurements remain restricted.

Each needs Waleed's explicit approval at the time it happens: merging migrations; applying migrations in production; deploying canaries; enabling any collection switch or allow-list entry; activating any cron; naming collection pilot accounts; live probes beyond the already requested bounded verification; widening rollout.
