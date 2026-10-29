# Task 8 spec: competitor UI and lifecycle retention

Date: 2026-10-30. Status: design for review; no implementation or production verification performed.

Evidence baseline: fetched `origin/main` at `191152935ecf8cc160721e2cdf9fcdc28a602d5f`, isolated branch `feat/competitor-ui`. All existing-code `path:line` citations below refer to this immutable baseline. Names explicitly marked **new/proposed** are design contracts, not existing columns or endpoints.

Read with the [parent plan](../plans/2026-10-26-instagram-insights-and-competitor-tracking.md), especially §3–4, Task 8, Task 11 and §10 binding clarifications, the [source spec](2026-10-26-instagram-insights-and-competitor-tracking.md), and the [implementation plan](../plans/2026-10-30-competitor-ui-and-retention.md). Architecture ownership remains in `ARCHITECTURE.md`; task workflow remains in `CLAUDE.md`.

## 1. Outcome, scope and verified gaps

An authenticated owner can track an Instagram handle from a search result, see collected public history, understand missing or incomplete measurements, retry collection, soft-remove a competitor, and reactivate it while retained. A separate retention worker removes only eligible inactive history after 90 elapsed days. Quotas remain concurrent active entries: Free 5 / Pro 20 / Business 30 / admin unlimited, with existing overrides and non-destructive downgrade behavior.

The current code supports part of this, but does not already provide a competitor report:

| Evidence | Design consequence |
|---|---|
| `supabase/migrations/20261026130000_instagram_insight_tracking_schema.sql:600`, `:690`, `:744` | Watchlist and profile/media history exist, with composite ownership keys. Use these actual relations, not the initial DDL sketch. |
| Same migration `:986`, `:1336`, `:1517`, `:1756` | Reuse owner quota/add/update RPCs. Browser table writes are not the management contract. |
| `supabase/functions/competitor-snapshot-sync/handler.ts:158`, `:710`, `:751` | User modes are `entry`, `force`, `status`; this is a collection/status endpoint, not a report reader. |
| `supabase/functions/instagram-insights-report/handler.ts:151`; `reportStore.ts:260` in that folder | Existing report takes `social_account_id` and reads owner insight tables. A watchlist ID cannot be passed as an owner account. Preserve its DTO. |
| `supabase/functions/competitor-snapshot-sync/graphProvider.ts:840`, `:914`; `syncWorker.ts:688` | Provider computes `truncated`; capture persistence omits it. Current successful capture is not evidence of complete weekly inventory. |
| `supabase/migrations/20261026150000_instagram_durable_collection_jobs.sql:696`, `:1197`; `competitor-snapshot-sync/handler.ts:733` | Generic checkpoints contain inventory fields, but the competitor HTTP status projection drops inventory and `last_partial_at`. Default checkpoint false values cannot prove coverage. |
| `src/types/brand-intelligence.ts:6`; `src/hooks/useBrandScrape.ts:6`, `:110`; `supabase/functions/brand-scrape/index.ts:687`, `:716` | Interactive profile/hook has no source contract; the provider saves `strategy_used` to sessions but does not expose an authoritative source through all response/cache/history paths. U4 needs the parent Task 2 provenance prerequisite. |
| `src/components/AnimatedRoutes.tsx:255`, `:271`; `src/pages/analytics/InstagramAnalytics.tsx:29`, `:184` | `/brand-intelligence` redirects to the live Instagram page, which hosts Performance and Analyze. Editing only the old page would not deliver a reachable feature. |
| `src/features/instagram-insights/ui/InstagramPerformanceScreen.tsx:24`; `tests/architecture.test.ts:41` in that feature | Reuse injected gateway/composition and workspace patterns. Its React Query hooks currently live under application; new competitor hooks must live under UI as required by the parent plan. |

These are source findings, not claims about which migrations are installed or which production switches are enabled. This document authorizes no provider probes, credentials access, production SQL or deployment.

## 2. Journeys and navigation

The canonical tracked list is `/analytics/instagram?tab=competitors`. Preserve `/analytics/instagram/performance`, `?tab=analyze`, the existing default Performance view, and the `/brand-intelligence` redirect. Add a third tab, **Tracked competitors**, alongside existing Performance and Brand & Competitors/search. The legacy `BrandIntelligence.tsx` may compose the same exported feature if rendered elsewhere; it must not own persistence or analytics.

Use public exports `CompetitorTrackingScreen`, `TrackCompetitorControl` and `CompetitorSourceBadge` from `src/features/competitor-tracking/index.ts`. `ProfileCard` receives an optional action slot and explicit source prop. The route composes the exported Track control for Instagram only. This avoids adding feature internals or database access to the shared card and leaves its Facebook, Threads and TikTok callers unchanged.

| Journey | Behavior and finish condition |
|---|---|
| J3 → J5 / U5 | Search a handle, activate Track, save through existing add RPC, then enqueue `entry`. Show the saved row immediately as pending; successful enqueue means queued, not snapshot collected. Link to the tracked list without clearing the search. Already active handles show Tracked and do not consume another slot or force a refresh. |
| J5 / first baseline | First committed profile observation displays its timestamp and nullable followers. 7/30-day growth stays unavailable until a valid baseline exists. The old J5 phrase “growth appears from the next day” is not a promise of seven days of history; parent §5.4 cutoff rules supersede that shortcut. Do not backfill historical observations from search results. |
| J6 / U5 | At the cap, show actual resolved limit and usage plus `/pricing`. No upgrade prompt for unlimited admins. A server quota rejection wins over stale client availability. Existing active entries remain visible and collected after downgrade. Removal frees a slot; reactivation consumes one. |
| J7 / U6 | Open a competitor detail panel, select 7 or 30 days, inspect latest media metrics and server outlier labels. Too early, small baseline and unavailable are explanatory neutral states, never a numeric zero score. |
| J2, J9 (Task 8 integration) | `scope_missing`/`token_invalid` show the appropriate reconnect explanation and `/profiles` action. Old competitor observations remain visible with their original capture times. One failed viewer/target does not hide other competitors. Discovery's provider/OAuth repair remains parent Task 2. |
| J4 (Task 8 integration) | Confirmed `target_unavailable` explains Business/Creator/public eligibility and shows persisted next retry time. A viewer error must not be called a private target. Manual Retry uses server-authorized force; no paid fallback switch in this UI. |
| T8-L1 remove | Confirmation names the handle and explains stopping collection, freeing a slot and 90-day history retention. On confirmed RPC success move it to Removed. Failure keeps the current row; indeterminate response triggers read reconciliation, never a claim of removal. |
| T8-L2 reactivate | Removed list displays retention eligibility date and Reactivate. Same row/history is reused while it exists, quota checked, removal marker cleared, then collection enqueued. After physical cleanup, adding the handle creates a new identity with no promise of recovery. |

J1/J8/J10 and E1 remain owner-flow regressions, not new competitor requirements. Task 11 must combine J2–J7/J9 with live backend evidence and E2; mocked UI tests cannot prove those full journeys.

## 3. Screen layout and state inventory

### Reference lock

Primary reference: `src/features/instagram-insights/ui/InstagramInsightsWorkspace.tsx:94` (compact toolbar, solid bordered cards, status before metrics, loading/error treatment). Secondary references: `src/components/brand-intelligence/ProfileCard.tsx:104` (identity, initials/avatar slot, logical end alignment) and `src/pages/analytics/InstagramAnalytics.tsx:142` (existing page/tab placement). Use shared shadcn/Radix `Tabs`, `Button`, `Alert`, `AlertDialog`, `Table`, `Badge`, `Skeleton` and `Sheet` primitives. Refero's focus/form craft guidance supplements these repository targets; no external visual redesign is proposed.

Preserve `bg-card`, `bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`, existing font and spacing tokens, compact numeric hierarchy, and solid surfaces. Existing decorative page header stays outside this feature. No frosted glass, `backdrop-blur`, new global theme, decorative gradient metric cards or invented profile imagery.

List order: heading and active quota → Active/Removed selector → state banner → competitor rows → bounded Load more. Desktop columns: identity, observed followers, 7d growth, 30d growth, observed posts/week, source, collection state, actions. At narrow widths use stacked labeled rows/cards, keeping identity/actions and all metric reasons available. A selected row opens a detail Sheet with observation/freshness, growth interval explanations, weekly completeness and latest posts/outliers. Do not render a chart before there are comparable points; no chart is required for Task 8.

| State | Presentation and permitted action |
|---|---|
| Auth loading / signed out | Do not fetch or reveal previous user's data. Existing protected routing handles sign-in. |
| First list read | Skeleton rows, `aria-busy`, translated loading label; no zero quota or “no competitors” assertion. |
| Successful empty Active list | “Track your first Instagram competitor”, explanation and Go to search action. Removed count/list remains accessible. |
| Successful empty Removed list | “No removed competitors”; no loading or failure disguised as empty. |
| List/detail read failure | Inline error + Retry loading. Retain same-user prior data with stale warning on refetch failure. First-load failure has no empty-list CTA. |
| Quota unavailable | “Limit unavailable”, Retry loading limit. Do not manufacture free allowance; server add remains authoritative if the user attempts it. |
| Normal active row | Handle/optional user label, nullable counts, actual observed timestamp, source badge, detail, Retry collection and Remove. No profile display name/avatar is assumed to be stored. |
| Pending, no observation | “Waiting for first snapshot”. Show enqueue progress separately; all numeric metrics are `—`. Do not say “tonight” unless a verified deployed schedule guarantees it. |
| First observation, no baseline | Followers can show; growth shows “Not enough history”. Weekly count may be partial. Never synthesize a baseline from zero. |
| Missing/zero/stale/source-changed baseline | Show the server reason. For zero baseline, both named growth outputs are null per parent §5.4; display the observed endpoints separately if needed. Never Infinity/NaN or 100% by convention. |
| Complete weekly coverage | “N observed posts / 7 days” with actual interval. This measures observed public posts, not deleted posts or private history. |
| Partial/unknown weekly coverage | “N posts observed · incomplete coverage”, reason and actual interval; no extrapolated rate. Zero observed can be shown with incomplete qualifier, not “posted zero”. |
| New collection queued/leased/partial/retry | Keep prior observations, show state and due/backoff where available. Disable duplicate collection action while pending; allow Remove. |
| Capture failed, history exists | Error banner alongside prior data, historical source/capture timestamps unchanged. |
| `target_unavailable` | Explain target eligibility, next retry date, Retry and Remove; retain history. |
| `viewer_unavailable` | Explain a compatible page-linked viewer is needed; `/profiles`. Do not infer permissions from account metadata. |
| `scope_missing` / `token_invalid` | Permission/reconnect-specific copy; `/profiles`, no endless automatic retries. |
| `apify_disabled` | Official capture unavailable and scheduled third-party fallback is disabled. No paid enablement or purchase action. |
| `rate_limited` / HTTP 429 | Display server retry time/seconds, keep data, defer manual retry until due. Countdown is presentation only. |
| `provider_error`, `storage_error`, `credential_changed` | Stable translated failure; retry when allowed. Unknown codes use generic failure without raw provider text. |
| `collection_disabled` / `protected_credentials_required` | Explain collection is not currently available; retain stored reports and lifecycle controls. Do not guess an account reconnect will enable a global switch. |
| Settings/report deployment unavailable | Unavailable + retry-read, not empty/no-history. |
| Add succeeded, enqueue failed/indeterminate | “Tracked; collection could not be confirmed.” Preserve row and quota. Read status; offer explicit retry after reconciliation. Never add again automatically or roll back tracking. |
| Add/remove/reactivate outcome indeterminate | “Could not confirm the change.” Reload owned list/entry before enabling another mutation. No optimistic success. |
| Remove confirmation / pending / failure | Focus-trapped dialog, Cancel default, named Remove. Pending single submission; failure retains dialog and error. Success returns focus to next row or list heading. |
| Removed, retained | Read-only historical detail, removed date and “Eligible for cleanup on …”; Reactivate. No Retry collection while inactive. |
| Removed >=90 days but not yet cleaned | “Cleanup eligible; retained data may be removed.” Reactivation remains possible while row exists and wins the database lock before a cleanup batch. |
| Cleanup occurred / cross-owner / missing detail | Non-enumerable not found, clear selection, reload list. New tracking starts fresh. |
| Outlier states | `outlier`, `above`, `normal`, `below`: label + finite score when present. `too_early`, `small_baseline`, `no_data`: neutral text and reason. No success/failure color alone. |
| Media/thumbnail absent or expired | Fixed-size neutral placeholder, metric `—`, safely validated permalink if present; no broken-image layout shift. |
| Pagination loading/error/end | Independent Load more spinner/error; existing page retained. End removes Load more. Changing filter/owner resets cursors. |

## 4. Existing data and mutation contracts

### Actual storage (not the original sketch)

All numeric metrics below are nullable nonnegative `bigint`; transport must reject unsafe/nonfinite conversion rather than silently round. Date/timestamp fields must preserve their meaning: `captured_on` is a capture day, `captured_at` is an instant, `published_at` is publication time.

| Relation and source | Fields used |
|---|---|
| `competitor_watchlist`, schema migration `20261026130000…:600` | `id`, `user_id`, `platform` (Instagram only), `username`, nullable `label`, `is_active`, nullable `removed_at`, `status` (`pending/ok/unavailable/error`), nullable `last_error_code`, `last_synced_at`, `next_retry_at`, `source` (`official/apify/null`), `created_at`, `updated_at`. `last_error` exists but is not displayed raw. No avatar, profile name or follower count column exists here. |
| `competitor_profile_snapshots`, same migration `:690` | `id`, `watchlist_id`, `user_id`, `captured_on`, `captured_at`, `capture_timezone`, nullable `followers_count`, `media_count`, `source`, `status`, `created_at`. No profile picture/name. |
| `competitor_media_snapshots`, same migration `:744` | `id`, `watchlist_id`, `user_id`, `ig_media_id`, `captured_on`, `captured_at`, `capture_timezone`, nullable `media_product_type`, `media_type`, `thumbnail_url`, `caption`, `permalink`, required `published_at`, nullable `like_count`, `comments_count`, `view_count`, `source`, `status`, `created_at`. No stored outlier or growth field. |
| `instagram_collection_jobs`, `20261026150000…:464` | `id`, `user_id`, `target_kind`, `target_id`, `watchlist_id`, `captured_on`, `job_generation`, `status` (`queued/leased/retry/partial/completed/unavailable/error`), `due_at`, `retry_at`, `attempts`, `last_attempt_at`, `last_partial_at`, `last_success_at`, `last_reason_code`. Lease and credential context are internal, never frontend DTO fields. |
| `instagram_collection_job_checkpoints`, same migration `:696` | Existing inventory cursor/remaining IDs, pages, partial/truncated, oldest timestamp, window start/end, window-covered and gap reason are generic job state. They are not currently a trustworthy historical competitor coverage ledger. |

Ownership is structural: snapshot `(watchlist_id,user_id)` FKs at `20261026130000…:703/:765`; job FK at `20261026150000…:545`. Normal mutation cannot change username or owner (`20261026130000…:1201`). SELECT-owner policies and write revokes are in that migration `:807` onward. No “admin can read everyone's competitors” exception is introduced.

### Existing RPCs consumed only by the feature infrastructure adapter

| RPC | Parameters / returned JSON |
|---|---|
| `read_own_competitor_quota()` (`20261026130000…:986`) | No owner argument. `{max_tracked_competitors, unlimited, tracked_active, remaining}`. `-1` and `unlimited=true` mean unlimited; remaining is null in that case. |
| `add_competitor_watchlist(p_username,p_label)` (`:1336`) | Normalize trim/lowercase/remove leading `@` in DB. Returns `{watchlist_id,username,is_active,status,reactivated,already_tracked}`; new/reactivated replies also include `quota`, already-tracked replies omit it. Do not require quota in every success envelope. |
| `update_competitor_watchlist(p_watchlist_id,p_label,p_is_active)` (`:1517`) | Pass `false` to remove, `true` to reactivate. Returns `{watchlist_id,username,label,is_active,removed_at,status,quota}`. `p_label=null` preserves the label; this feature does not introduce a clear-label convention. |

Database validates username shape and 120-character label limit (`:627/:630`), locks quota state, rejects N+1 activations, preserves original removal marker on later edits, and clears it on activation (`:1077`, `:1216`). Map known SQLSTATE plus stable `COMPETITOR_*` identifiers to typed feature errors in infrastructure, never parse message text in UI or expose arbitrary SQL details. Unknown failures stay errors. Disable mutation auto-retry; reconcile a lost response by read.

### Existing sync HTTP contract

`POST competitor-snapshot-sync` accepts strict `{mode:"entry"|"force"|"status",watchlist_id}`. Do not use owner sync's `action`/`social_account_id` body. See `handler.ts:158` and `:751`.

- `entry` after newly added/reactivated rows; `force` only after an explicit Retry collection gesture.
- HTTP 202: `{accepted:true,reason,job_id,job_generation,status,captured_on}`. HTTP 429: `{accepted:false,reason,retry_after_seconds,captured_on}`, plus `Retry-After` (`handler.ts:772`).
- HTTP 200 status: `{target_kind,target_id,captured_on,status,job_generation,attempts,due_at,next_retry_at,last_attempt_at,last_success_at,reason_code,pending_operations}` (`:733`). `none` is distinct from a failed read; store parser handles the no-job SQL variant. This projection does not include inventory or `last_partial_at`.
- Errors are `{error:<stable code>}`; use the exact codes at `handler.ts:99`. User modes reject service credentials and require a verified authenticated identity (`:591/:623`). Collection/protected-mode gates precede store access (`:665`).
- Poll only visible, selected, active work after an accepted enqueue: every 5 seconds, at most 12 polls, then show “Still queued; check status”. Stop on terminal state, deferred retry/backoff, disablement, unmount or auth change. User can reload status. Polling never invokes providers or schedules work. A new request is not auto-replayed after `enqueue_indeterminate`.

## 5. New read boundary and proposed DTO v1

Choose **new authenticated `competitor-tracking-report`**. It uses a **new authenticated-only `read_own_competitor_tracking_report` RPC** with the verified bearer forwarded to PostgreSQL. RPC derives `auth.uid()`, explicitly rejects anonymous/service impersonation, and structurally scopes every watchlist/snapshot/job join to that owner. Edge service privilege, if needed, is confined to sanitized audit logging. Reject supplied `user_id`. Missing and other-owner IDs return the same 404.

Alternatives considered: browser snapshot queries would distribute analytics and baseline selection across clients; extending `instagram-insights-report` would mix owner organic metrics/account identifiers with competitor public metrics/watchlist identifiers. A separate boundary preserves owner DTO v1 and makes both security and source-specific analytics reviewable. Frontend only formats report values; no second growth/outlier/freshness algorithm.

New POST request discriminated union:

```ts
{ action: "list", state: "active" | "removed", limit?: number, cursor?: string }
{ action: "detail", watchlist_id: string, period_days: 7 | 30,
  limit?: number, cursor?: string }
```

Strict schemas: list/detail default 20 rows, max 50; opaque bounded versioned cursor (max 2048 characters), no unknown keys, UUID validation, body <=4 KiB. Cursor carries owner/request-scope binding and exact SQL timestamp/ID position, not rounded JavaScript milliseconds. Invalid/cross-scope cursors fail 400. Read deadline 15 seconds, each dependency <=5 seconds with an audit reserve. No Meta, Apify or enqueue call in either read action. A read remains useful when collection is disabled; missing report schema produces unavailable, never a fallback empty result.

The RPC returns a bounded, consistent raw projection for the server assembler, including owner quota in the same transaction. It is not the frontend response. SQL selects latest capture per media before pagination and independently retrieves up to 12 valid prior baseline candidates per displayed media/source/format/metric cohort. No application-side scan through all daily snapshots or all unlimited-admin entries. Limit+1 keyset paging and indexed owner/watchlist predicates are required. Candidate truncation must suppress affected scores and be reported, never silently use a short baseline as if complete.

Proposed public response fields (new DTO fields, not database columns):

| Object | Contract / derivation |
|---|---|
| Envelope | `version:1`, `as_of` server timestamp, `capture_timezone:"Asia/Kuwait"`, `quota` using existing four-key quota shape, `next_cursor:string|null`. List adds `entries`; detail adds `entry`, `media`. |
| Entry | `watchlist_id` from watchlist.id; `username`, `label`, `is_active`, `removed_at`, `status`, `last_error_code`, `next_retry_at`; `cleanup_eligible_at = removed_at + 90 elapsed days` or null. No user ID or raw last_error. |
| Observation | `profile:{followers_count,media_count,captured_at,captured_on,source}|null`, using latest successful profile row. `source` on each displayed observation is authoritative for that observation, not copied from a newer failed request. |
| Freshness | `freshness:{last_capture_at,last_full_success_at,last_partial_at,job_status,reason_code}` from committed coverage/jobs; unknown is null. Watchlist `last_synced_at` is existing capture publication, not proof of full inventory. No fabricated stale threshold. Always show actual times. |
| Growth | `growth_7d` and `growth_30d`: `{absolute:number|null,percent:number|null,baseline_at:string|null,observed_at:string|null,interval_days:number|null,reason:null|"first_observation"|"missing_baseline"|"zero_baseline"|"stale_baseline"|"unavailable_metric"|"source_changed"|"baseline_policy_unset"}`. Server computes only under §6. |
| Posting | `weekly:{observed_count:number,posts_per_week:number|null,interval_start,interval_end,coverage:"complete"|"partial"|"unknown",reason:string|null}`. Explicit interval anchored to the latest committed inventory observation, not silently to browser now. Display its end time. |
| Media | `ig_media_id,published_at,captured_at,media_product_type,media_type,thumbnail_url,permalink,caption,like_count,comments_count,view_count,source`; nullable fields keep null. Safe URL projection; captions are plain third-party text, never HTML. |
| Outlier per media | Canonical `{id,score,label,baselineMedian,baselineSize}` plus `metric_basis:"public_views"|"public_interactions"|null`, `source`, and nullable `reason`. Backend invokes `_shared/outlierScore.ts:156`; no frontend copy. |

The frontend runtime schema is versioned against backend fixtures. Unknown envelope version, malformed data, mismatched watchlist, unsafe numbers or database error fail the read. Server responses use stable `{error:{code}}` for `INVALID_REQUEST`, `UNAUTHORIZED`, `NOT_FOUND`, `REPORT_UNAVAILABLE`; frontend normalizes this separately from the existing sync endpoint's string-error envelope.

## 6. Analytics and completeness rules

### Growth

Use latest successful profile observation L; for D=7/30, cutoff is `L.captured_at - D days`. Baseline B is latest successful same-source observation at or before cutoff within approved maximum staleness S. Do not use a later snapshot, interpolate, or pick a baseline based on current UI media filters. Return actual interval `(L-B)/86400 seconds`.

With known follower counts and B.followers >0: absolute = L−B and percent = 100×(L−B)/B. Negative changes are valid. With missing/zero baseline, missing value or unapproved staleness policy, return null outputs and explicit reason. An observed source change between endpoints disqualifies the comparison; do not skip over it to find a convenient same-source value. Retained pre-removal observations may be used after reactivation if they meet the same cutoff/source/staleness rules, with the actual interval shown. The current schema does not retain an activity-transition ledger after `removed_at` is cleared: never invent one or claim continuous collection across the interval. Weekly completeness is qualified independently. Exact maximum S is the one unresolved business decision in §11; implementation of the permissive baseline selector is gated on it, not guessed from a daily cron.

### Weekly inventory

Parent plan §10 clarification 9 is binding. Count distinct observed `ig_media_id` with `published_at` in the displayed seven-day interval. Repeated daily snapshots are not new posts. A full 30-result page is not automatically an incomplete week: 30 lifetime posts with only three this week can establish the week if oldest returned timestamp reaches its start and ordering is verified. A cursor older than the interval does not alone invalidate that interval. Conversely 30 posts all within the week with more possible posts is partial.

Existing storage cannot establish this today. Add **proposed** `competitor_capture_coverage` in a new migration, with one row per `(watchlist_id,captured_on)`, composite `(watchlist_id,user_id)` FK, owner SELECT/service write restrictions, and fields:

`watchlist_id,user_id,captured_on,captured_at,source,job_generation,capture_started_at,capture_ended_at,oldest_returned_at,ordering_verified,cursor_present,exhausted,truncated,gap_reason`.

Timestamp/nullability/CHECK rules: all identity/capture instants and source required; oldest timestamp nullable for a genuinely empty feed; `cursor_present` nullable when unknown; booleans explicit; `capture_started_at <= capture_ended_at`; finite instants; lower-case bounded reason code or null; generation positive. No provider cursor URL, credentials or profile identity fields. Never backfill positive coverage for old snapshots; absence means unknown.

A new versioned, service-only result RPC must persist coverage and snapshots in the same owner/lease/generation-fenced transaction. Keep original v1 writer callable for deployment compatibility. New worker must send coverage through its provider-neutral payload, not infer it in the browser. Preserve good prior data on failed provider/write. Incomplete full inventory updates partial freshness rather than claiming full success; a seven-day window can still be complete even if older inventory is truncated. The new report distinguishes those two facts.

Verified ordering means a tested, version-compatible provider ordering contract plus validated results, not merely sorting a returned array. Until established, report unknown/partial. Repeated/invalid cursors, unknown ordering, collection gaps not covered by a later inventory, or unexplained gaps prevent complete weekly rate. `media_count` delta is diagnostic only. Use `posts_per_week=null` for incomplete coverage and preserve observed count. No new provider calls or larger collection budgets are authorized by this coverage addition.

### Outliers

Canonical algorithm and cohort duties are documented in `_shared/outlierScore.ts:16` and parent plan §5.4. Select latest per-media observation first; split by watchlist, source, format and metric. Reels use public `view_count`; non-reels use `like_count + comments_count` only if both exist. Unknown/Story/AD product classification gets no score in v1; never infer every VIDEO is a Reel. Baseline contains at most 12 strictly earlier mature valid items, minimum six; maturity 48 hours. No self/future item. Null value → no_data; valid immature → too_early; insufficient baseline → small_baseline; zero median → no_data. Thresholds >=3, >=1.5, <=0.5 remain unchanged. Baseline history is independent of 7/30-day display filtering. Never compare these public paid+organic counts as equivalent to owner organic insight metrics.

## 7. Retention and concurrency contract

Reference shape only: `supabase/functions/media-retention/run.ts:3` uses 40 seconds / 50 items and ports; `handler.ts:1` uses existing cron/admin auth and sanitized logging. Do not reuse its Cloudinary deletion semantics or change its schedule. Competitor rows contain external URLs, not owned media assets to delete at Instagram/Cloudinary.

New `competitor-retention/{index,handler,run,deps}.ts` calls a new service-only SQL batch RPC. Only authenticated cron/service or existing verified admin authority can invoke maintenance; normal owners cannot supply a cutoff or invoke hard deletion. Strict POST body `{dryRun?:boolean}`, no arbitrary owner/IDs/time arguments. Use shared restricted CORS/auth/sanitizer/logging; audit refusals, switch-off/unreadable, no-work, timeout and errors with counts/reasons, never captions, URLs or secrets.

Eligibility is a fresh database predicate: `is_active=false AND removed_at IS NOT NULL AND removed_at <= server_now - interval '2160 hours'`. Exactly 90 elapsed days is eligible; 89 days and 90 days minus one microsecond are not. Eligibility is not a promise of exact-second deletion. Active rows of any age are never candidates. Repeated remove/label changes do not reset the clock; reactivation clears it and a later removal starts a new clock.

Bounded deletion protocol:

1. SQL chooses inactive candidates in `(removed_at,id)` order and locks parent `FOR UPDATE SKIP LOCKED`, rechecking owner, inactivity, unchanged marker and eligibility under the lock. Retention uses the same parent-before-job lock order as collection. A list previously read by an Edge Function is never deletion authority.
2. Maximum 50 parents and 500 deleted child rows total per invocation, each SQL slice capped independently, statement timeout <=5 seconds; Edge stops starting slices before its 40-second budget/write reserve expires. Use indexed lookups for each child relation and return counts plus `has_more`, not a full historical ID list.
3. Skip parents with a currently live job lease; expired leases confer no write authority. Under parent/job locks, delete bounded owned media/profile snapshots and coverage rows, job operations/checkpoints, then competitor jobs (including completed jobs and abandoned queued/retry/partial/error/unavailable or expired leased work), and per-target request throttle rows. Job `target_kind='competitor'`, `target_id=watchlist_id` and matching `user_id` are required in every join. Never touch owner jobs, shared provider throttle buckets, credentials, social accounts or another owner's same handle.
4. Operations/checkpoints must be deleted in bounded chunks before deleting their job; parent deletion occurs only after all relevant children are absent. Do not use the existing cascades to conceal an unbounded purge. Final parent delete repeats owner/marker/inactivity/cutoff predicates in the same transaction. Foreign keys remain safety backstops, not the batching mechanism.
5. A crash rolls back the current SQL slice; committed eligible slices are idempotent progress. If reactivation wins the parent lock, that slice deletes nothing. If a cleanup slice wins after 90 days, it can commit eligible deletions before reactivation; reactivation stops every later slice but cannot resurrect already deleted data. This is why copy promises retention for 90 days and eligibility thereafter, not guaranteed recovery indefinitely. No batch continues from a stale removal marker.

Dry run performs bounded eligibility/count reads with no domain mutations, claims or deletion; an operational audit event is allowed. New server-controlled `competitor_retention_enabled` setting defaults false and fails closed on missing/malformed/read error. RPC deletion also checks this switch, so bypassing the Edge wrapper cannot enable cleanup. Dry run remains available while disabled.

Create one separate idempotent cron job `competitor-retention`, proposed hourly at minute 20 UTC to drain bounded backlog, installed **inactive**. Use runtime `get_cron_secret()`/`net.http_post` pattern (`20261001100000_media_retention.sql:1093`), no secret literals. Do not activate collection or retention during migrations. Only a later authorized rollout enables it after migration/catalog checks, function boot and dry-run verification. Disabled schedules do not imply live retention works.

## 8. Feature architecture, errors and state isolation

`src/features/competitor-tracking/{domain,application,infrastructure,ui,tests,index.ts}` owns this feature. Domain owns DTO schemas, typed errors, pure handle/formatting helpers; application owns gateway port and add→enqueue/remove/reactivate orchestration; infrastructure implements RPC/function calls; UI owns React Query hooks, presentation state and controls. Only `CompetitorTrackingScreen` and `TrackCompetitorControl` composition roots wire the infrastructure adapter. No dependency on `instagram-insights` internals, no global provider/store.

Query keys include authenticated user ID, action, active/removed state, watchlist, period and cursor. Abort in-flight reads and discard previous identity's data on auth change. Do not use keepPreviousData across owners. Mutation invalidation updates list, entry, quota and Track identity state together. Block duplicate submission per target, not the whole screen. Reuse existing normalized identity; `@Foo` and `foo` must not appear as two local tracking states.

Backend errors remain typed. UI uses localized error mapping, never server `last_error` or `error.message` as display copy. Same-user stale results may remain visibly stale; different-user results must never flash. External links require safe http/https parsing; no `javascript:`/data URLs, no HTML caption rendering. Report and collection code never trusts a client-provided owner or source.

## 9. English/Arabic, RTL and accessibility

Follow the actual i18n setup (`src/i18n/index.ts:7`): English defaults at every `t()` call; Arabic entries in `src/i18n/locales/ar/analytics.json`; no new English JSON bundle. All new keys use `analytics` namespace, `competitors.*` prefix. Use Egyptian Arabic style consistent with current bundles. Representative exact copy/keys:

| Key suffix under `competitors.` | English default | Arabic |
|---|---|---|
| `tab` | Tracked competitors | المنافسين اللي بتتابعهم |
| `active` / `removed` | Active / Removed | نشطين / تمت إزالتهم |
| `track` / `tracked` | Track / Tracked | تابع / بتتابعه |
| `reactivate` / `remove` | Reactivate / Remove | فعّل المتابعة تاني / إزالة |
| `viewReport` | View report for @{{username}} | شوف تقرير @{{username}} |
| `quota` | {{used}} of {{limit}} tracked | بتتابع {{used}} من {{limit}} |
| `unlimited` | Unlimited tracking | متابعة من غير حد أقصى |
| `quotaExceeded` | Your limit is {{limit}} active competitors. | الحد الأقصى عندك {{limit}} منافس نشط. |
| `quotaUnavailable` | Limit unavailable | مش قادرين نعرض الحد دلوقتي |
| `upgrade` | View plans | شوف الخطط |
| `emptyActive` | Track your first Instagram competitor | تابع أول منافس ليك على إنستجرام |
| `emptyRemoved` | No removed competitors | مفيش منافسين تمت إزالتهم |
| `search` | Go to search | روح للبحث |
| `loading` | Loading competitors | بنحمّل المنافسين |
| `retryRead` / `retryCollection` | Retry loading / Retry collection | حمّل تاني / حاول تجمع البيانات تاني |
| `loadFailed` | Could not load competitors. | مقدرناش نحمّل المنافسين. |
| `firstSnapshot` | Waiting for first snapshot | مستنيين أول لقطة بيانات |
| `firstBaseline` | Not enough history | لسه مفيش بيانات تاريخية كفاية |
| `source.official` / `source.apify` | Official / Third-party | رسمي / طرف تالت |
| `source.graphOwn` / `source.unknown` | Own account / Source unknown | حسابك / المصدر مش معروف |
| `observedAt` | Observed {{date}} | تم الرصد {{date}} |
| `growth7d` / `growth30d` | Follower change · 7 days / Follower change · 30 days | تغيّر المتابعين · ٧ أيام / تغيّر المتابعين · ٣٠ يوم |
| `growthInterval` | Compared with {{date}} ({{days}} days) | مقارنة بـ {{date}} ({{days}} يوم) |
| `zeroBaseline` | No percentage: baseline was zero | مفيش نسبة: نقطة البداية كانت صفر |
| `missingBaseline` | No comparable baseline | مفيش نقطة بداية ينفع نقارن بيها |
| `staleBaseline` | Baseline is too old | نقطة البداية قديمة قوي |
| `weeklyComplete` | {{count}} observed posts / 7 days | {{count}} بوست مرصود / ٧ أيام |
| `weeklyPartial` | {{count}} posts observed · incomplete coverage | رصدنا {{count}} بوست · البيانات مش كاملة |
| `removeTitle` | Remove @{{username}}? | تشيل @{{username}} من المتابعة؟ |
| `removeBody` | Collection stops and a slot is freed. History is kept for 90 days, then eligible for cleanup. | جمع البيانات هيقف ومكان هيفضى. البيانات القديمة بتفضل ٩٠ يوم، وبعدها ممكن تتمسح. |
| `cleanupEligibleAt` | Eligible for cleanup on {{date}} | ممكن تتمسح من {{date}} |
| `outcomeUnknown` | Could not confirm the change. Reload to check. | مقدرناش نتأكد إن التغيير تم. حمّل تاني عشان تتأكد. |
| `trackedEnqueueFailed` | Tracked; collection could not be confirmed. | المتابعة اتسجلت؛ مش قادرين نأكد بدء جمع البيانات. |
| `outlier.tooEarly` / `outlier.smallBaseline` | Too early / Not enough earlier posts | لسه بدري / البوستات السابقة مش كفاية |
| `outlier.noData` | Data unavailable | البيانات مش متاحة |

Complete key inventory also includes `cancel`, `confirmRemove`, `removing`, `reactivating`, `followers`, `postsPerWeek`, `media`, `views`, `likes`, `comments`, `publishedAt`, `loadMore`, `loadingMore`, `loadMoreFailed`, `notFound`, `stillQueued`, `collectionDisabled`, `reconnect`, `viewerUnavailable`, `targetUnavailable`, `nextRetryAt`, `retryIn`, `sourceChanged`, `baselinePolicyUnset`, `unavailableMetric`, `coverageUnknown`, `captureGap`, `orderingUnknown`, `staleData`, `partialData`, `thumbnailUnavailable`, `outlier.outlier`, `outlier.above`, `outlier.normal`, `outlier.below`, `outlier.metricBasis`, `error.generic`, `error.invalidHandle`, `error.scopeMissing`, `error.tokenInvalid`, `error.rateLimited`, `error.provider`, `error.storage`, `error.credentialsChanged`, `error.apifyDisabled`, `error.settings`, and status keys for `pending`, `ok`, `unavailable`, `error`, `none`, `queued`, `leased`, `retry`, `partial`, `completed`. Every one needs English default and Arabic copy when implemented; unknown errors use `error.generic`. Interpolation names must match. Use i18next plural rules if a sentence varies by count, with all Arabic forms; avoid hand-built English plural suffixes.

Requirements: inherited `dir`, Radix direction-aware keyboard tabs, logical start/end spacing, `<bdi>`/LTR isolation for handles and signed numeric deltas, `Intl.NumberFormat` and localized dates with explicit Kuwait display timezone. At 320/375/768/1280px and 200% zoom, no lost controls or page-wide horizontal overflow; only the labeled media table region may scroll. Full keyboard operation, focus-visible rings, labels for every icon button, status `aria-live=polite`, errors as alerts without repeated polling announcements, dialog focus return, sensible heading/table semantics, non-color status labels, sufficient contrast and reduced-motion support. Touch targets should be at least 44px where controls are compact. Explain disabled actions in persistent accessible text, not hover-only tooltips.

## 10. Acceptance map

| Local acceptance | Parent IDs / rule | Required proof |
|---|---|---|
| T8-01 source | U4, J2/J3, §5.1 provenance | Official/Apify/own/unknown card fixtures; actual producer→hook→card pass-through; cache/history unknown preserved. Parent Task 2 prerequisite remains explicit. |
| T8-02 management | U5, J5/J6, S4 as amended, §10 quota | Normalize, duplicate/idempotent Track, concurrent quota, admin unlimited/override, downgrade, lost mutation response, add-success/enqueue-failure. |
| T8-03 report boundary | S1–S3, §10 report wiring | No provider calls; owner and admin-own-only; cross-owner/missing 404; all DB errors fail; bounded paging and precise cursor; malformed DTO rejected. |
| T8-04 growth | Task 8, §5.4 | Missing, zero, null, stale, source switch, negative growth, actual interval and chosen S; first observation never fabricates history. |
| T8-05 coverage | Task 8, §10 clarification 9 | 30 lifetime/3 recent complete; 30 recent plus cursor partial; unknown order, missed day not later covered, duplicates, failed persistence, legacy no-coverage unknown. |
| T8-06 outliers | U6, J7, D11–D14 | Canonical thresholds/maturity, zero median, six/twelve limits, same-source units, latest snapshot, display-period invariance. |
| T8-07 retries | Task 8 UI quota/retry/errors; J4/J9 | 202 != collected; 429 Retry-After; indeterminate enqueue not retried; terminal/deferred/auth-change polling stop; history retained on failure; disabled collection. |
| T8-08 retention | Task 8; S4 soft-remove amendment | 89d retained; 90d−1µs retained; 90d eligible; active history untouched; owner-mismatched child rejected; cleanup includes jobs/children; repeated remove stable; reactivate clears marker; later removal resets it. |
| T8-09 retention races | §4 ownership/claims; Task 11 | Real two-session reactivate vs cleanup both orderings, collection writer vs cleanup, locked candidate skip, expired worker denied, rollback/restart and >500-child backlog. |
| T8-10 cron | S6; §4.9 | Reapply schedule definition creates one inactive job; dry-run/no-work/auth/switch failure logs; no provider work or active-row deletion. |
| T8-11 presentation | Task 8 Arabic/English/RTL/a11y/responsive | Every state above, keyboard/focus, mobile/zoom, no blur, identity cache isolation, shared-card non-Instagram regression. |
| T8-12 assembled | E2 and Task 11 | Seeded local authenticated Track→collect fixture/report→remove→reactivate; route reachability; Arabic journey notes; exact migration/function manifest and pending live checks. |

## 11. Open questions for Waleed

1. What maximum staleness is acceptable for the observation used at/before the 7-day or 30-day follower-growth cutoff? The parent plan requires an explicit bound but supplies no value. This governs whether older observations may represent a named period; no number is assumed here. The rest of the feature can be implemented, but the final growth selector/acceptance needs this decision.

Quota numbers, admin unlimited, non-destructive downgrades, 90-day retention, deferred Stories/MCP tools/scheduled Apify are already resolved by the task and parent plan (§12–13); they are not re-opened. Missing coverage persistence, source provenance and live readiness are engineering prerequisites, not business questions.
