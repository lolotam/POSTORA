# Completing owned-account analytics for Instagram, Facebook Pages and Threads — design

**Status:** design, not an activation approval.
**Date:** 2026-11-01.
**Baseline:** `main` at `dd7f02c303c5210147ab49184ce82c17be7a4ae9`. Current-state evidence lives in the status review `docs/journeys/2026-11-01-meta-analytics-status.md` ([PR #327](https://github.com/lolotam/POSTORA/pull/327)); this spec does not repeat it.
**Plan:** [`docs/plans/2026-11-01-meta-analytics-completion.md`](../plans/2026-11-01-meta-analytics-completion.md).
**Required reading for implementers:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`docs/specs/2026-10-30-instagram-release-gates.md`](./2026-10-30-instagram-release-gates.md), [`docs/runbooks/instagram-collection-rollout.md`](../runbooks/instagram-collection-rollout.md).

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
- A parity test asserts that both copies expose the same metric keys, statuses and schema version.

### 4.1 Metric value

```ts
type MetricValue =
  | { status: "available"; value: number }
  | { status: "partial"; value: number; coverage: { availableDays: number; expectedDays: number } }
  | { status: "unavailable"; reason: UnavailableReason };

type UnavailableReason =
  | "not_offered"          // the platform has no such metric
  | "permission_missing"   // scope not granted / token lacks permission
  | "outside_retention"    // requested window older than the provider keeps
  | "not_collected"        // not yet synced / collection off
  | "provider_error";      // provider call failed
```

Rules:

- `unavailable` is never rendered or aggregated as `0`. A provider-reported `0` is `available` with value `0`.
- A period total built from daily rows is `partial` unless every expected day is present; the UI shows coverage.
- Truncation (`truncated`), partial collection (`lastPartialAt`) and back-off (`retryAt`) from the Instagram report are kept at report level, not dropped.

### 4.2 Metric definition (registry entry)

Each registry entry states: `key`; `platform`; provider metric name and API version; level (`account` | `post`); unit (`count` | `accounts` | `percent`); window kind (`day` | `period_total` | `lifetime` | `point_in_time`); aggregation (`sum` | `last` | `not_summable`); i18n definition keys (ar/en); minimum permission.

`not_summable` metrics (for example unique reach) are never summed across days; a period value comes only from a provider period total or is `unavailable`. `views` and `impressions` are distinct keys; a platform that offers only one leaves the other `not_offered`.

### 4.3 Common metric set

Reach, views, impressions, engagements (with components: likes, comments/replies, shares/reposts, saves, quotes), followers (point-in-time count and net change), per-post performance, previous-period delta.

The per-platform mapping table is **filled from the live probe evidence (§6)**, not from memory. Until a cell is proven, it is `unverified` in the registry and the UI shows it as `unavailable: not_collected`.

### 4.4 Period and delta

- Period `{ since, until, timezone }`; previous period = same length immediately before.
- Delta is `unavailable` if either side is not `available`, or if the previous value is `0` (no percentage; the absolute difference may be shown).
- A previous period older than the provider's retention is `outside_retention`, never a silent zero.

### 4.5 Sync status

`never_synced | syncing | fresh | stale | partial | failed(reason)`, plus `asOf` (data end), `collectedAt` (last successful write) and `retryAt`. "Stale" thresholds are per platform and set in the registry.

### 4.6 Versioning and compatibility

The contract carries `schemaVersion`. Existing responses are not changed in place: new shapes are added behind a version (request field or a new action), and existing consumers (Threads panel, service proxy / MCP) keep working until migrated. Compatibility tests cover both versions while both exist.

## 5. Workstream 1 — Instagram defects and pilot

1. **#326** (Sync rejection message) is reviewed and merged as is.
2. **401 fix** in the composition root: pass the validated body `user_id` to `authenticateCaller`, so service-role callers resolve identity and user-JWT callers keep JWT identity (the helper already prefers the JWT on mismatch). Ownership stays structural (account looked up by `user_id` + `id`). Regression runs through the real composition, plus cross-owner rejection.
3. **Cursor contract:** one codec owned by the report contract; the gateway uses it. A boundary test round-trips gateway → handler.
4. **Pagination:** the screen passes the cursor and `onLoadMore`; pages accumulate without duplicates; end of list is detected.
5. **Correct totals:** daily reach is not summed into "unique accounts"; totals show coverage (`partial`) when days are missing. This is a precondition of the pilot.
6. **Pilot (owner analytics only):** release-gate artefacts, then the named subset of gates from the release-gates spec §6 that applies to owner analytics: B1 (manifest/preflight), B2 (deployment, its own approval), B3 (pilot user list), C1–C2 (reconnect and session/refresh regression), C3 (harmless test post, its own approval), D1 (server-enforced one-account eligibility from the rollout-controls work, with its RC evidence) and D2 (collection for exactly one owner account, other targets excluded). The competitor step D3 and gate E are out of scope.
7. **Reconciliation** against Meta (§9) before any wider rollout.

## 6. Workstream 2 — live verification of Facebook and Threads

A read-only **capability probe** per platform, run against owner-approved connected accounts, produces a committed evidence record. It gates workstream 4.

For each metric × level × window: requested API version, HTTP result, value present / absent / error code, earliest date that returns data, maximum request window, pagination behaviour, rate-limit headers, behaviour with an expired or revoked token, and the error-to-`UnavailableReason` mapping.

- **Facebook:** owned Page insights with the stored **Page** token (`/{page-id}/insights`, `/{post-id}/insights`), checked against current Meta documentation for deprecated metrics and their replacements at the pinned Graph version. Granted scopes are read from the token debug result, not from the requested list.
- **Threads:** `threads_insights` (account), `/{media-id}/insights` (post), listing pagination, retention window per metric.

The probe never writes provider data to analytics tables and never logs tokens.

## 7. Workstream 3 — contract adoption on live paths

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

### 8.2 Collection jobs

The Instagram job SQL and worker store are Instagram-only (§3), so they are **not** reused directly. Before any migration, the plan decides between:

- (a) additive migrations that widen the job model to a platform-tagged target with per-platform credential contexts, or
- (b) per-platform job tables reusing the Instagram TypeScript modules where they are platform-neutral.

Either way: applied migration bytes are never edited; platform isolation, lease fencing and reconnect behaviour have SQL/Deno tests; each platform has its own collection switch and rollout policy (`off` by default, explicit target allow-list), its own cron entries created **inactive**, and a retention policy.

### 8.3 Reports

A report function per platform (or one function with per-platform assemblers) returns the contract, with ownership checked per request and service-role identity handled as in §5.2.

## 9. Workstream 5 — unified UI and gradual rollout

- Shared components: account picker, period picker, summary cards, trend charts, top posts, sync-status banner. They render every `MetricValue` status explicitly and show definitions on hover.
- Instagram, Facebook and Threads screens consume the contract; Facebook's public Page analysis remains a separate tab.

**Reconciliation tolerances (pilot acceptance):** for each pilot account and each available common metric over a closed 7-day window, the stored/reported value matches the value Meta shows for the same window: counts exactly for provider period totals; daily sums within ±2 % or ±5 absolute (whichever is larger) to allow late provider adjustments; any larger gap blocks rollout until explained.

**Pilot stability gate (per platform):** 7 consecutive days with every scheduled run successful or explicitly retried to success, no ownership or isolation test failure, provider calls within the declared budget, zero writes for non-pilot targets. Stop conditions: any cross-owner read, writes for a non-allow-listed target, repeated provider permission errors, budget overrun. Rollback: switch off, cron inactive, verified by query.

## 10. Acceptance journeys

Per platform, on production for the pilot account: open analytics → choose account and period → see summary, trend, top posts with sync status → force a missing-permission case and see `permission_missing` → paginate posts to the end without duplicates → confirm values against Meta (§9).

## 11. Security and data rules

- Layering and Edge Function shape per `ARCHITECTURE.md`.
- Service role only for workers and the proxy; every user-facing read checks ownership structurally.
- No tokens in logs, responses, cursors or evidence records.
- Migrations precede the runtime that depends on them; SQL tests cover ownership, grants and concurrency.

## 12. Approvals (owner decisions)

Each needs Waleed's explicit approval at the time it happens: merging migrations; applying migrations in production; deploying canaries; enabling any collection switch or allow-list entry; activating any cron; naming pilot accounts; running live probes against those accounts; widening rollout.
