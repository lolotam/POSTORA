# YouTube Stage 5 — YouTube Analytics reports (specification)

24 November 2026 · proposal for owner review, nothing implemented · proposed tier **Heavy** (reason in the plan) · [Implementation and acceptance plan](../plans/2026-11-24-youtube-stage5-analytics.md)

Code baseline: the Stage 4 head `7b8fe42b` (PR #471), which sits on the Stage 3 merge `21447f2d`. Every path and line number below was read at `7b8fe42b` with `git show`. If Stage 4 merges at a different head, plan step 1 repeats the checks. Stage 5 depends on Stage 4 being merged **and its migration applied**: the health-neutral token store it uses (`store_youtube_refreshed_token_with_lease_neutral`) is created by `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql`.

Google pages were fetched on 2026-11-23. Each provider fact carries its URL and one of two marks:

- **[V]** the sentence was read word for word on the page;
- **[S]** the page was too long to read in full and the fact comes from an automated summary of it. An [S] fact is **unverified** and is never the only support for a design rule; plan step 1 re-reads it.

## 1. Purpose and non-goals

### Purpose

The owner of a connected YouTube channel opens a page in Postora and sees how the channel performed over a chosen period: views, watch time, average view duration, subscribers gained and lost, likes, comments and shares, a day-by-day trend, the most viewed videos of the period, and the same numbers for one chosen video. The numbers come from the YouTube Analytics API, the same source YouTube Studio uses, and are read for that owner's channel only.

Today Postora shows only YouTube's public lifetime counters (total views, subscribers, likes per video) on the YouTube Channel page. It cannot answer "how did the last 30 days go?".

### Non-goals

- **No revenue or ad numbers.** They need a different Google permission and a channel in the YouTube Partner Program (§3.1).
- **No stored YouTube analytics data** under the recommended design (§5.1). No table, no cron job, no history beyond what Google returns on request.
- **No numbers Postora computes itself**: no net subscribers, no engagement rate, no "+12% versus the previous period" (§3.6).
- **No audience breakdowns in the first release**: traffic sources, countries, devices, age and gender are listed as later options (§4.2).
- **No write to YouTube** and no change to publishing, comments, moderation, the comment poller, the OAuth attempt flow, the refresh lease or disconnect.
- **No change to the Meta analytics pipeline** (Facebook, Instagram, Threads), to TikTok analytics, to the Partner API, the n8n node, or the MCP tools. `get_account_analytics` keeps refusing YouTube.
- **No managed-connector (Composio) support.** A Composio-connected channel is told analytics is unavailable for its connection type, as in Stage 2 (`docs/specs/2026-11-20-youtube-stage2-resource-browse.md`, decision D3).
- **No live Google call in any automated test.**

## 2. Verified current state

### 2.1 YouTube, as it will be after Stage 4

| Fact | Evidence at `7b8fe42b` |
|---|---|
| Native OAuth requests exactly three scopes: `youtube.readonly`, `youtube.upload`, `youtube.force-ssl`, with `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`. | `supabase/functions/youtube-oauth/handler.ts:414-427` |
| The `scope` string Google returns at connection is stored as `account_metadata.granted_scopes`. | `supabase/functions/youtube-oauth/index.ts:156`; `supabase/functions/_shared/youtubeGrantedScopes.ts:35-43` |
| Older rows have no recorded scopes and are treated as "unknown", not as "missing". | `supabase/functions/youtube-resources/capabilities.ts:72-74` |
| One pure function derives what an account may do: `browse`, `upload`, `edit_metadata`, `comments`. There is no `analytics` entry. | `supabase/functions/youtube-resources/capabilities.ts:68-111`; contract in `supabase/functions/youtube-resources/contracts.ts:52-71` |
| A missing scope is shown to the owner as a notice that links to Profiles to reconnect. The precedent is the comments scope. | `supabase/functions/_shared/youtubeCommentCapability.ts:1-8`; `src/features/youtube-management/ui/YouTubeResourceNotice.tsx`; `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` ("Current YouTube Scopes") |
| Access tokens are obtained only through the lease-based helper. It has a **health-neutral mode**: the token is refreshed and stored, but the call never sets `needs_reauth`, the failure counter or the stored grants. | `supabase/functions/_shared/youtubeTokenRefresh.ts:145-152`, `:473-483`, `:603-616` |
| `dropGrantedScope` removes a recorded scope after a Google `403`. It is keyed by account ID only and is called by the legacy comment path. Stage 4 code deliberately never calls it. | `supabase/functions/_shared/youtubeGrantedScopes.ts:46-57`; `supabase/functions/_shared/youtubeComments.ts:236`; `supabase/functions/comment-manager/stage4/provider.ts:11` |
| `youtube-resources` is the reference shape for a YouTube read endpoint: strict Zod schemas, user JWT only, owner-filtered account read, restricted CORS, per-user rate limit (30 per 10 minutes, 300 per day), sanitised refusal rows in `system_logs`. | `supabase/functions/youtube-resources/handler.ts:2`, `:79-119`, `:220-221`; `supabase/functions/youtube-resources/index.ts:91-99`, `:136-138`; `supabase/functions/youtube-resources/contracts.ts:33-38` |
| Google errors are already classified into `scope_missing`, `quota`, `unauthorized`, `not_found`, `forbidden`, `upstream`. | `supabase/functions/_shared/youtubeApiErrors.ts` |
| The only YouTube numbers Postora reads today are Data API counters. | `supabase/functions/youtube-resources/contracts.ts:98-103`, `:138-142` |
| Stage 4's rollout is a private `app_settings` key, absent by default, per account, hidden from browsers by a RESTRICTIVE policy and evaluated in SQL. | `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql:126-140`, `:728-741`; `supabase/functions/comment-manager/stage4/rollout.ts:1-8` |
| Stage 3 gates published edits with a code constant, not a per-account key. | `supabase/functions/youtube-resources/editComposition.ts:23` |
| The Stage 4 browser journey runs the real handler against a disposable database and a fake provider that counts requests. | `scripts/stage4-e2e.mjs:1-16`; `e2e/fixtures/youtubeStage4Server.ts` |
| CI has one named Deno step per YouTube function. | `.github/workflows/ci.yml:457-485` |
| The YouTube Channel page is `/youtube`, behind `feature_youtube_management`, default off. | `src/components/layout/DashboardLayout.tsx:195`; `src/hooks/useFeatureFlags.tsx:171`, `:326` |
| **The public Google disclosure page says Postora requests "exactly" two YouTube scopes, never reads YouTube Analytics, and does not request `youtube.force-ssl`.** It is already out of date for `force-ssl`, and Stage 5 makes the analytics sentence false. | `src/pages/GoogleApiDisclosure.tsx:85-87`, `:97-98`, `:105`, `:107` |
| The verification guide records the Google consent screen as "Testing" with a 100-user cap. | `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` ("Current Configuration"). Whether this is still true was **not** checked. |

### 2.2 The existing analytics work, and why YouTube does not drop into it

The Stage 2 specification says analytics belongs to another workstream. That workstream is the "owned analytics" pipeline for Meta. What it is:

| Question | Answer | Evidence |
|---|---|---|
| How is data collected? | By cron into tables. The browser never reaches a provider. Facebook and Threads share `meta-owned-analytics-sync`; Instagram has its own `instagram-insights-sync`. All cron jobs are installed inactive. | `supabase/functions/meta-owned-analytics-sync/handler.ts:13-18`; `supabase/migrations/20261101143000_meta_owned_analytics_cron.sql:10-13`; `supabase/migrations/20261031092000_instagram_collection_cron.sql:20-22` |
| Why collect? | Each job captures only the two most recent closed days plus per-post lifetime numbers. There is no backfill; history exists only because Postora stores it. | `supabase/functions/meta-owned-analytics-sync/worker.ts:20-43` |
| Where is it stored? | Per-platform tables, each pinned to one platform by a CHECK constraint: `fb_*`, `threads_*`, `ig_*`. | `supabase/migrations/20261101130000_meta_owned_analytics_history.sql:166`, `:325`, `:1314` |
| How long is it kept? | 365 days for Facebook and Threads, removed by a `retention` action. Instagram owner data has no retention job. | Same file `:169`; `supabase/functions/meta-owned-analytics-sync/retention.ts:17-19` |
| How is it read? | Through an edge function, not a table read: `meta-owned-analytics-report` or `instagram-insights-report`. Periods are 7, 14, 30 or 90 days. Posts are paged 25 at a time with a signed cursor. | `src/features/analytics-contract/infrastructure/supabaseSavedAnalytics.ts:21-26`; `supabase/functions/_shared/analyticsCalendar.ts:1`; `supabase/functions/meta-owned-analytics-report/cursor.ts:7-20` |
| How is it shown? | `/analytics/facebook`, `/analytics/instagram`, `/analytics/threads`, each behind its own `feature_analytics_*` flag (default off) under one "Analytics" sidebar group. English text is inline; Arabic lives in `src/i18n/locales/ar/analytics.json`. | `src/components/AnimatedRoutes.tsx:275-280`; `src/components/layout/DashboardLayout.tsx:198-203`; `src/hooks/useFeatureFlags.tsx:167-170`, `:322-325` |
| How is rollout gated? | Private `app_settings` keys per platform (`collection_facebook_analytics_enabled` and `_policy`, and so on), hidden from browsers, evaluated in SQL, per account or `all`. | `supabase/migrations/20261115100000_facebook_analytics_all.sql:152-187`; `supabase/migrations/20261031090000_instagram_collection_rollout_controls.sql:184-222` |
| Is there an on-demand precedent? | Yes. TikTok analytics is on a separate path: it calls the provider live and uses no saved history and no shared contract. | `src/pages/analytics/TikTokAnalytics.tsx:42-44`; `docs/developer/analytics.md` (tool table) |

**What is missing for YouTube.** Nothing in the pipeline mentions YouTube. To store YouTube data in it, all of the following would have to change:

| Layer | What blocks YouTube today | Evidence |
|---|---|---|
| Platform list | `ANALYTICS_PLATFORMS = ["instagram", "facebook", "threads"]` | `supabase/functions/_shared/analyticsContract.ts:6` |
| Metric keys | Fifteen Meta keys. No watch time, no view duration, no subscribers gained or lost. | Same file `:20-23` |
| Units | `"count" \| "accounts" \| "percent"`. No minutes or seconds. | Same file `:33` |
| Report validity | A report must carry **exactly** the fifteen keys at each level, each matching the registry; the API version must look like `v25.0`. | `supabase/functions/_shared/analyticsSchema.ts:55`, `:250-252` |
| SQL validator | The metric CHECK accepts fourteen Meta keys and is described as "a database constraint projection of analyticsRegistry.ts … New verified capabilities need a migration." | `supabase/migrations/20261101130000_meta_owned_analytics_history.sql:26-31`, `:81` |
| Tables | Every table is pinned to one Meta platform. There are no `yt_*` tables. | Same file `:166`, `:325`, `:1314` |
| Readiness | The readiness function refuses any platform other than Instagram and Facebook. | `supabase/migrations/20261115140000_instagram_bootstrap_readiness.sql:18` |
| Read path | The browser gateway sends every non-Instagram platform to `meta-owned-analytics-report`, whose request schema accepts only `facebook` or `threads`. | `src/features/analytics-contract/infrastructure/supabaseSavedAnalytics.ts:22-23`; `supabase/functions/meta-owned-analytics-report/handler.ts:8-10` |
| Parity test | Browser and edge must serialise the same contract artefact. | `src/features/analytics-contract/contractParity.test.ts:8-10` |

Conclusion: joining the **storage** pipeline is a large migration and a contract version change that touches three working platforms. Joining the **surface** (the Analytics menu, the flag pattern, the period choices, the Arabic file, the private rollout key pattern) is small. §5.1 explains why the surface is the right fit.

Line numbers in this subsection for the collection, retention and rollout migrations were gathered in one research pass over `7b8fe42b`; the contract, schema, gateway, flag, route and CHECK lines were re-read directly afterwards.

## 3. Provider facts

### 3.1 API and permissions

| Fact | Mark | Source |
|---|---|---|
| The endpoint is `GET https://youtubeanalytics.googleapis.com/v2/reports`. `ids`, `startDate`, `endDate` and `metrics` are required; `dimensions`, `filters`, `sort`, `maxResults`, `startIndex` are optional. Dates are `YYYY-MM-DD`. | [V] | [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query) |
| "All YouTube Analytics API requests must be authorized." | [V] | Same page |
| That page's scope table lists four scopes: `yt-analytics.readonly`, `yt-analytics-monetary.readonly`, `youtube`, `youtubepartner`. `youtube.readonly` is **not** in the table. | [V] | Same page |
| The same page carries a notice above the table: "API requests to this method now require access to the `https://www.googleapis.com/auth/youtube.readonly` scope." It has no date and does not say "in addition to" or "instead of". | [V] | Same page |
| The authorization guide says `yt-analytics.readonly` "Grants `reports.query` access to non-monetary user activity metrics", and that `youtube.readonly` "Grants `reports.query` access to non-monetary metrics". | [V] | [Authorization guide](https://developers.google.com/youtube/reporting/guides/authorization) |
| `yt-analytics-monetary.readonly` is "Required for `reports.query` requests that retrieve monetary or revenue metrics", and the channel must be in the YouTube Partner Program; otherwise `403 Forbidden`. | [V] | Same guide; [Channel reports](https://developers.google.com/youtube/analytics/channel_reports) |
| `youtube.force-ssl` is not mentioned on any Analytics page fetched. | — | Not stated |
| `ids=channel==MINE` is the documented form. `channel==<CHANNEL_ID>` is also allowed: "The user authorizing the request must be the owner of the channel." | [V] | [Channel reports](https://developers.google.com/youtube/analytics/channel_reports) |
| The YouTube Analytics API must be enabled for the Google Cloud project. | [V] | [Authorization guide](https://developers.google.com/youtube/reporting/guides/authorization) |
| Whether `yt-analytics.readonly` or `youtube.readonly` is a "sensitive" scope is **not stated** on any page fetched. Google says the category is shown in the Cloud Console: "Sensitive scopes require review by Google and have a *sensitive* indicator on the Google Cloud Console's OAuth consent screen configuration page." | [V] | [OAuth scopes](https://developers.google.com/identity/protocols/oauth2/scopes) |

**The two Google pages disagree about which permission is enough.** One reading is that the permission Postora already holds (`youtube.readonly`) is sufficient. The other is that the dedicated analytics permission is needed. This document cannot settle it without one real request, which it is not allowed to make. §7 handles both outcomes and names the check that decides.

### 3.2 Reports, metrics and dimensions proposed for use

| Report | Request | Mark | Source |
|---|---|---|---|
| Channel totals for a period | No dimension. Metrics "Use 1 or more" from a list that includes `views`, `estimatedMinutesWatched`, `averageViewDuration`, `subscribersGained`, `subscribersLost`, `likes`, `comments`, `shares`. Optional filter: "Use 0 or 1" of `video`, `group`. | [V] | [Channel reports](https://developers.google.com/youtube/analytics/channel_reports) |
| Day-by-day series | Dimension "Use exactly 1 `day`, `month`". Same metric list. `video` is an allowed filter. Sample: `dimensions=day`, `sort=day`. | [V] | Same page; [Sample requests](https://developers.google.com/youtube/analytics/sample-requests) |
| Most viewed videos | `dimensions=video`, `maxResults=10`, `sort=-views`. The sample page says the request "requires you to specify a value for the `sort` request parameter and to set the `maxResults` parameter to an integer value of `10` or less." | [V] | [Sample requests](https://developers.google.com/youtube/analytics/sample-requests) |
| Most viewed videos, full rule | Up to 200 rows, sort required, descending sort keys only. | [S] | [Channel reports](https://developers.google.com/youtube/analytics/channel_reports). The first release asks for 10, which satisfies both statements. |
| Most viewed videos, metrics | A documented sample uses `metrics=estimatedMinutesWatched,views,likes,subscribersGained` with `dimensions=video`. That set is the **verified fallback**. | [V] | [Sample requests](https://developers.google.com/youtube/analytics/sample-requests) |
| Most viewed videos, wider metrics | Whether `averageViewDuration` and `comments` are allowed with `dimensions=video` was not read word for word. An unsupported mix fails every request with `400`. | [S] | [Channel reports](https://developers.google.com/youtube/analytics/channel_reports). Plan step 1 reads the rule; if it cannot be confirmed, the block ships with the fallback set. |

| Metric | Definition used | Mark | Source |
|---|---|---|---|
| `views` | Includes "co-views when multiple people watch together on a television screen" (from 16 November 2026). For Shorts it has counted starts and replays since 30 April 2025. | [V] | [Metrics](https://developers.google.com/youtube/analytics/metrics); [Revision history](https://developers.google.com/youtube/analytics/revision_history) |
| `estimatedMinutesWatched` | Minutes watched; includes co-views. | [V] | Same |
| `averageViewDuration` | "The average length, in seconds, of video playbacks." | [V] | [Metrics](https://developers.google.com/youtube/analytics/metrics) |
| `subscribersGained`, `subscribersLost` | Channel-wide in a channel report; in a report filtered to one video, only subscriptions from that video's watch page. | [V] | Same |
| `likes`, `comments`, `shares` | Core metrics. | [V] | Same |
| `engagedViews` | Viewed "past the first frame, or the user clicks/taps to play". Not used in the first release. | [V] | Same |

The response is a table: `columnHeaders[]` (name, type) and `rows[]`, columns in the order dimensions then metrics. "If no data is available... the `rows` element will be omitted." [V] ([reports.query](https://developers.google.com/youtube/analytics/reference/reports/query))

### 3.3 Freshness and time zone

| Fact | Mark | Source |
|---|---|---|
| "Data processing typically introduces a latency of 48 to 72 hours." | [V] | [Data model](https://developers.google.com/youtube/analytics/data_model) |
| "The response for a query with the `day` dimension will not contain rows for the most recent days." | [V] | [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query) |
| "All dates refer to the time period beginning at 12:00AM Pacific time (UTC-7 or UTC-8)." | [V] | [Dimensions](https://developers.google.com/youtube/analytics/dimensions) |
| Whether a day already returned can change later is **not stated** for this API. | — | Not stated |
| For live counters Google recommends `videos.list` of the Data API. | [V] | [Data model](https://developers.google.com/youtube/analytics/data_model) |

### 3.4 Quota and limits

| Fact | Mark | Source |
|---|---|---|
| "Each API request that you make counts as one unit of your API usage quota." "Quota limits are visible on the Quotas panel in the Google Cloud console." | [V] | [Data model](https://developers.google.com/youtube/analytics/data_model) |
| A second page says "The API server evaluates each query to determine its quota cost." | [V] | [YouTube Reporting overview](https://developers.google.com/youtube/reporting) |
| The default daily limit of the Analytics API is **not stated** on any page fetched. The Data API quota table (10,000 units a day) lists Data API methods only. | — | [Quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) |
| `channels.list` and `videos.list` cost 1 unit each. | [V] | [channels.list](https://developers.google.com/youtube/v3/docs/channels/list); [videos.list](https://developers.google.com/youtube/v3/docs/videos/list) |
| No maximum date range is stated. A `video` filter accepts up to 500 IDs. | [V] | [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query) |
| How many IDs one `videos.list` call accepts is not stated on the fetched page. | — | Not stated. The design asks for at most 10 and degrades if refused (§5.4). |
| "Some YouTube Analytics data is limited when metrics do not meet a certain threshold." The thresholds "are not published". Demographics and geography are named. | [V] | [Data model](https://developers.google.com/youtube/analytics/data_model) |

### 3.5 Errors

The Analytics reference has **no error table** (the `reports.query` page has no Errors section, and the errors URL redirects to an overview). Only two errors are documented:

- unsupported or mutually exclusive combinations cause "an HTTP `400 badRequest` error with the message `The query is not supported`" [V] ([Channel reports](https://developers.google.com/youtube/analytics/channel_reports));
- revenue metrics for a channel outside the Partner Program return `403 Forbidden` [V] (same page).

How this API reports a missing scope, an exhausted quota, an expired token or an API that is not enabled for the project is **not documented on the pages fetched**. The design therefore classifies by HTTP status first and by Google's reason string only where one is present, treats anything it does not recognise as a temporary failure, and names a rehearsal that records the real shapes (§9.5).

### 3.6 YouTube developer policy on stored and derived data

These rules sit deep in a long page that could not be read word for word. They are all [S] and **unverified**; plan step 1 re-reads them before any text or behaviour depends on them.

| Rule as summarised | Source |
|---|---|
| Stored API data must be deleted or refreshed after 30 calendar days. The Analytics data model page repeats this for resource metadata, and that sentence **was** read: "API clients must either delete or refresh stored resource metadata from that API after 30 days." [V] | [Developer policies](https://developers.google.com/youtube/terms/developer-policies) III.E.4; [Data model](https://developers.google.com/youtube/analytics/data_model) |
| Data from the Analytics API may be kept as long as needed, but the client must confirm every 30 days that the user still authorises it. | Same policy page, [S] |
| A client must not use API data "to create new or derived data or metrics", and must not aggregate data across channels of different owners. An exception exists only for audited developers who applied for it. | Same policy page and its [guide](https://developers.google.com/youtube/terms/developer-policies-guide), [S] |
| After a user revokes access in the app, stored data must be deleted "within 7 calendar days of the revocation". | [V] [Developer policies](https://developers.google.com/youtube/terms/developer-policies), section D.2 |
| "Do not try to future-proof your access to data by asking for permissions that would enable features" not yet built. | [V] Same page, III.D.2.b |

The recommended design stores nothing and derives nothing, so it complies under either reading of the unverified rules.

## 4. Proposed scope

### 4.1 Recommended first release

One page, "YouTube analytics", for one selected channel and one selected period.

| Block | What the owner sees | Provider requests |
|---|---|---|
| Header | Channel picker, period picker (last 7, 14, 30 or 90 days), a Refresh button, and a line: "Numbers through <date> (Pacific time). YouTube needs two to three days to finalise a day." | none |
| Overview cards | Views · Watch time · Average view duration · Subscribers gained · Subscribers lost · Likes · Comments · Shares, each the total for the period, exactly as YouTube returns it. | 1 Analytics request |
| Daily trend | One line chart with a metric switch: views, watch time, subscribers gained, subscribers lost. One point per day. | 1 Analytics request |
| Most viewed videos | The ten most viewed videos of the period: title, views, watch time, likes, and — if Google accepts them in this report — average view duration and comments (§3.2). | 1 Analytics request + 1 Data API request for titles |
| One video | Clicking a video (here, or "View analytics" on the YouTube Channel page) shows the same overview cards and daily trend filtered to that video. Subscriber cards carry a note that, for one video, YouTube counts only subscriptions from the video's watch page. | 2 Analytics requests + 2 Data API requests (each of the two reads confirms the video's ownership itself) |

Fixed rules for the first release:

- **Periods** are whole days ending three days before today in Pacific time, so every day in the range is normally final. The page says which date the numbers run through.
- **Nothing is computed by Postora.** Subscribers gained and lost are two cards, not one net number. There is no comparison with the previous period. Units are converted for display only (minutes shown as hours and minutes; seconds shown as minutes and seconds).
- **Native connections only.**
- **On demand.** Google is called when the owner opens the page, changes the channel or period, or presses Refresh. There is no polling and no background job.

A typical visit (open the page, change the period once, open two videos) costs 10 Analytics requests and 6 Data API units: 3 + 1 for each of the two page loads, and 2 + 2 for each video.

### 4.2 Later options, not in the first release

Each is a separate decision and none is designed here beyond the note in the last column.

| Option | What it adds | Note |
|---|---|---|
| Traffic sources | Where views came from (search, suggested, Shorts feed, external). | One more request per period. Capped by Google at 50,000 videos × days per query ([Revision history](https://developers.google.com/youtube/analytics/revision_history), 15 November 2024). |
| Countries and devices | Views and watch time by country and by device type. | One request each. Geography is subject to Google's unpublished thresholds. |
| Age and gender | Share of viewers by age group and gender. | Often withheld for small channels (§3.4); must be shown as "limited by YouTube", not as an error. |
| Shorts versus long videos | The same numbers split by content type. | Uses the `creatorContentType` dimension, with data from 2019. |
| Comparison with the previous period | "+12% versus the previous 30 days". | A derived number. Blocked until the policy in §3.6 has been read in full. |
| Revenue | Estimated revenue and ad performance. | Needs the monetary scope, Partner Program membership, and a Google verification decision. |
| Saved history | Daily numbers stored in Postora for trends longer than a query, exports, cross-platform summaries. | The alternative design in §5.1: a migration, a cron job, a retention rule and a policy reading. |
| Managed-connector (Composio) channels | The same page for Composio connections. | Separate specification, as in Stage 2. |
| Agent, n8n and MCP access | `get_account_analytics` for YouTube. | Changes the public tool surface; out of scope here. |

## 5. Design

### 5.1 Where the data comes from: on demand, nothing stored

**Recommended: read from Google when the owner asks, and store nothing.** Reasons:

1. **Google returns history on request.** Meta's pipeline stores data because each collection run sees only the two latest days (§2.2). The YouTube Analytics API accepts any `startDate` and `endDate`, so storing adds nothing the first release needs.
2. **Nothing to retain, expire or delete.** The stored-data rules of §3.6 are unverified. With nothing stored they cannot be broken, and a disconnect leaves nothing behind.
3. **No migration to the three working Meta platforms.** §2.2 lists what joining the storage pipeline would touch.
4. **There is a precedent.** TikTok analytics is already on demand and outside the saved-history contract (§2.2).
5. **It is the Stage 2 decision again.** The owner chose "browser memory only, no server cache" for YouTube browse (`docs/specs/2026-11-20-youtube-stage2-resource-browse.md`, D1).

What "fits the existing analytics work" then means, concretely:

| Shared with the analytics workstream | Kept separate |
|---|---|
| A page at `/analytics/youtube` in the existing Analytics sidebar group. | The report contract. YouTube gets its own, because the shared one requires fifteen Meta metrics and has no time unit (§2.2). |
| A `feature_analytics_youtube` flag beside the four existing `feature_analytics_*` flags. | The collection worker, cron jobs, tables, retention and readiness SQL. None is used. |
| The period choices 7, 14, 30 and 90 days (`supabase/functions/_shared/analyticsCalendar.ts:1`). | The saved-report gateway (`supabaseSavedAnalytics.ts`). YouTube has its own gateway to its own function. |
| Arabic text in `src/i18n/locales/ar/analytics.json`, English inline. | |
| A private, default-absent rollout key with the same `off` / `allowlist` / `all` vocabulary as Facebook (`20261115100000_facebook_analytics_all.sql:159-169`). Only the vocabulary is shared: Facebook's key, like Stage 4's, is hidden by a database policy and evaluated in SQL. The recommended Stage 5 gate is read by the server instead, which departs from both precedents (§8, decision D6). | |

**Alternative: collect into tables** (decision D2). It would need `yt_*` tables with RLS and no browser grants, a daily cron job per channel, a retention job, a new SQL metric validator, a decision on the policy in §3.6, and either a second contract or a new version of the shared one. It is the right design only if the owner wants history that outlives a query, exports, or cross-platform summaries. It can be added later without changing the first release's page.

### 5.2 Edge function

One new function, `supabase/functions/youtube-analytics/`. It is not added to `youtube-resources`, whose handler already carries browse, categories and edit; analytics is a different job with a different provider host (ARCHITECTURE §13: no unrelated workflows in one handler).

| File | Responsibility |
|---|---|
| `contracts.ts` | The single contract: operations, response types, error codes with HTTP status, metric keys and units, periods, limits. Runtime-neutral, so the frontend imports its types from it (the Stage 2 pattern). |
| `window.ts` | Pure: turns "last N days" and a clock into `startDate` and `endDate` in Pacific time, ending three days back. |
| `rollout.ts` | Pure parser of the rollout policy, plus the port that reads it. Fails closed. |
| `analyticsReadClient.ts` | Typed calls to `youtubeanalytics.googleapis.com` and the one `videos.list` title lookup. Timeout, response validation, stable error mapping. Never touches the database. |
| `handler.ts` | `createYouTubeAnalyticsHandler(ports)`: CORS, method, authentication, validation, ownership, gate, capability, rate limit, use case, response mapping. All I/O behind ports. |
| `index.ts` | Builds the ports and serves the handler. No business rule (ARCHITECTURE §12). |

`POST /functions/v1/youtube-analytics`, JSON body discriminated on `operation`, every schema strict:

| Operation | Input | Provider calls | Result |
|---|---|---|---|
| `status` | `account_id` | none | Whether analytics is available for this account, and if not, one reason: `not_enabled`, `provider_unsupported`, `reconnect_required`, `missing_scope`. Also the policy numbers (periods, limits). The page renders from this. |
| `summary` | `account_id`, `period_days` (7, 14, 30, 90), optional `video_id` | 1 Analytics (+1 Data when `video_id` is present) | One value per metric for the period. |
| `daily` | same | 1 Analytics (+1 Data when `video_id` is present) | One row per day, four metrics. |
| `top_videos` | `account_id`, `period_days` | 1 Analytics + 1 Data | Up to ten rows with title, link and five metrics. |

Success envelope, the same shape as `youtube-resources` (`contracts.ts:73-78`) plus the window:

```ts
interface YouTubeAnalyticsSuccess<T> {
  schema_version: 1;
  request_id: string;
  freshness: { fetched_at: string; source: "database" | "provider" };
  window: {                     // absent on `status`
    start_date: string;         // YYYY-MM-DD
    end_date: string;           // YYYY-MM-DD, the last day covered
    days: 7 | 14 | 30 | 90;
    time_zone: "America/Los_Angeles";
  };
  data: T;
}

interface YouTubeAnalyticsMetric {
  key: "views" | "watch_time" | "average_view_duration" | "subscribers_gained"
     | "subscribers_lost" | "likes" | "comments" | "shares";
  unit: "count" | "minutes" | "seconds";
  value: number | null;         // null = YouTube returned no value
}
```

Checks, in this order, on every request:

1. **Caller.** A user JWT, validated the way `youtube-resources` does it. A service-role bearer is refused. A body with `user_id`, `channel_id` or any unknown key fails validation.
2. **Account.** One service-role read filtered on `id`, `user_id = caller`, `platform = 'youtube'`, `is_active = true`. No row is `not_found`, identical for a foreign, missing, inactive or non-YouTube account. A failed read is `internal_error`, never "not found".
3. **Gate.** The rollout policy admits this account (§8). Not admitted is `not_enabled`. A policy that cannot be read is `settings_unavailable`, never a quiet "off".
4. **Capability.** Composio is `provider_unsupported`. `needs_reauth`, or no token at all, is `reconnect_required`. A recorded scope list that lacks the required scope is `missing_scope`. An empty recorded list proceeds and lets Google decide (Stage 2, D5). All of these happen before any provider call.
5. **Rate limit** (§5.5).
6. **Video ownership**, only when `video_id` is present: `videos.list?part=snippet&id=<video>` must return that ID with `snippet.channelId` equal to the account's channel. Anything else is `not_found`, identical for a missing video and another channel's video. This is the Stage 2 rule.
7. **Token.** Through `refreshYouTubeAccountToken` in **health-neutral mode**.
8. **One Analytics request**, 15-second timeout, `ids=channel==<the stored channel ID>`. The channel ID comes from the account row, never from the browser. On `401`, when the token was not minted by this request, one forced refresh and one repeat. These are reads, so the repeat cannot duplicate anything. A second `401` is `reconnect_required` in the response only.
9. **Validate the answer.** The column names must be exactly the dimensions and metrics requested, in order, and every value must be a finite number (or a date for `day`). Anything else is `upstream_unavailable`. Missing `rows` is a valid empty answer.

Error codes, each with a fixed HTTP status and fixed English and Arabic copy. The response never carries Google's text.

| Code | HTTP | When |
|---|---|---|
| `invalid_request` | 400 | Not JSON, fails the schema, unknown key, unsupported period. |
| `unauthorized` | 401 | Missing, invalid or service-role bearer. |
| `not_enabled` | 403 | The rollout policy does not admit this account. |
| `missing_scope` | 403 | The recorded scopes exclude the required one, or Google refuses for insufficient permission. |
| `not_found` | 404 | Account not owned, not YouTube, inactive or absent; video absent or of another channel. |
| `method_not_allowed` | 405 | Anything other than `POST` and `OPTIONS`. |
| `provider_unsupported` | 409 | The caller's own account is Composio-managed. |
| `reconnect_required` | 409 | `needs_reauth`, no refresh token, or a second `401`. |
| `rate_limited` | 429 | Postora's own per-user limit; carries `retry_after_seconds`. |
| `quota_exceeded` | 429 | Google refuses for quota. |
| `settings_unavailable` | 503 | The rollout policy could not be read or is malformed. |
| `upstream_unavailable` | 502 | Timeout, network failure, Google `5xx`, an unrecognised Google error (including `The query is not supported` and "API not enabled"), or an answer that fails validation. |
| `internal_error` | 500 | A database read failed or an unexpected exception. |

### 5.3 What the refresh path may and may not change

Analytics is an optional read. A problem with it must never break publishing or comments.

- The function refreshes tokens only through the existing lease helper, in health-neutral mode (`youtubeTokenRefresh.ts:145-152`). A refreshed access token is stored under the lease, as every other caller does.
- It **never** sets `needs_reauth`, changes `failure_count` or `last_refresh_error`, or edits `account_metadata.granted_scopes`.
- It **never** calls `dropGrantedScope`. A `403` from the Analytics API is shown to the owner and nothing is written. Otherwise a late Analytics refusal could remove a grant that publishing or comments rely on (the same race Stage 4 recorded as its finding F7).

### 5.4 Titles for the top-videos list

The Analytics API returns video IDs only. Titles come from one `videos.list?part=snippet&id=<up to 10 IDs>` call. A row is given a title only when Google returns that ID with `snippet.channelId` equal to the account's channel. A row without a match is shown as "Video unavailable" with its numbers; Google states that deleted items stay in totals but not in per-video rows ([Data model](https://developers.google.com/youtube/analytics/data_model), [V]). If the title call fails, the list is still shown with IDs and a "titles could not be loaded" note; the numbers are not withheld.

### 5.5 Caching and quota

- **Server: no cache.** Workers are short-lived, and a database cache is stored YouTube data (§5.1).
- **Browser: React Query, memory only.** `staleTime` 30 minutes for the three data operations (a finished day does not change within a visit), 60 seconds for `status`. No refetch on focus, no interval. Every query key contains user, account, period and video, and no query shows data from a previous key, so switching channel can never display the previous channel's numbers. Refresh invalidates the selected account's queries and spends quota.
- **Per-user rate limit**, on the existing limiter (`_shared/rate-limiter.ts`), counted per data operation: 60 per 10 minutes (`youtube-analytics:burst`) and 600 per day (`youtube-analytics:day`). `status` is not limited and calls no provider. The limiter fails open when its database call fails, as in Stage 2; it is a budget guard, not a security boundary.
- **Honest quota errors.** A Google quota refusal is `quota_exceeded`; nothing is retried.
- **These numbers are provisional.** The Analytics API's daily limit is not published (§3.4). The owner reads the real figure in the Cloud Console before the feature is opened beyond the pilot, and the limits are adjusted to it.
- Title lookups and video ownership checks spend Data API units from the same 10,000-unit bucket as the comment poller and browse: at most one unit per operation.

### 5.6 Frontend

```text
src/features/youtube-analytics/
├── domain/          types.ts (re-exports contracts.ts), errors.ts, format.ts (minutes → h m, seconds → m:ss)
├── application/     ports.ts, queryKeys.ts, useYouTubeAnalyticsStatus.ts, useYouTubeAnalyticsSummary.ts,
│                    useYouTubeAnalyticsDaily.ts, useYouTubeTopVideos.ts
├── infrastructure/  supabaseYouTubeAnalyticsGateway.ts        (the only file that imports the Supabase client)
├── ui/              YouTubeAnalyticsScreen.tsx, OverviewCards.tsx, DailyTrend.tsx, TopVideosTable.tsx,
│                    VideoAnalyticsPanel.tsx, AnalyticsNotice.tsx
├── tests/           architecture.test.ts
└── index.ts
```

- Dependency direction per ARCHITECTURE §§3–4: `ui → application → domain`; `infrastructure → application ports and domain`. The screen takes the gateway as an optional prop with the Supabase gateway as default.
- **Real consumer** (ARCHITECTURE §1): page `src/pages/analytics/YouTubeAnalytics.tsx`, route `/analytics/youtube` in `src/components/AnimatedRoutes.tsx`, sidebar child in the Analytics group of `src/components/layout/DashboardLayout.tsx`, shown when `flags.analyticsYoutube` is on. With the flag off the page redirects to `/dashboard`. The YouTube Channel page's video detail gains a "View analytics" link to `/analytics/youtube?account=…&video=…`, shown only when the flag is on. This is a frontend-only change; the `youtube-resources` function and its contract are untouched.
- The flag `feature_analytics_youtube` is added to `src/hooks/useFeatureFlags.tsx` beside the other four, default `false`. No migration: the code default applies when the row is absent.
- The chart uses `recharts`, the library the saved-report trend already uses (`src/features/analytics-contract/ui/SavedAnalyticsReport.tsx:5`). No new dependency.

States, each distinct, none rendered as an empty report:

| State | Shown |
|---|---|
| Loading | Skeletons per block. Blocks load independently; one failing block does not hide the others. |
| No YouTube channel | Empty state with a link to Profiles. |
| Not enabled | "YouTube analytics is not switched on for this channel yet." No reconnect prompt: reconnecting cannot change rollout. |
| Managed connection | "This channel is connected through the managed connector, which does not provide analytics." |
| Reconnect needed | "Reconnect this channel on Profiles", linking to `/profiles`. |
| Permission missing | "Reconnect this channel and allow access to YouTube analytics", linking to `/profiles`. |
| Empty | "YouTube has no numbers for this period yet", with the date the data runs through. Typical for a new channel or new video. |
| Quota | "YouTube's daily limit was reached. Try again tomorrow." |
| Rate limited | "Too many requests. Try again in N minutes." |
| Temporary failure | "YouTube analytics could not be loaded", with a retry and the request reference. |
| Video unavailable | A top-video row whose title could not be confirmed. |

English is inline; Arabic is added under a `youtube` group in `src/i18n/locales/ar/analytics.json`, and the sidebar label in `src/i18n/locales/ar/nav.json`. The page works right-to-left; numbers, dates and durations render left-to-right inside it, as the competitor screens already do (`src/features/competitor-tracking/ui/LtrValue.tsx`). Every control is keyboard reachable and the chart has a table alternative. Counters on the YouTube Channel page stay labelled as YouTube counters; they are a different source from this page and are not mixed with it.

## 6. Security and privacy

1. **Identity comes only from the JWT.** Strict schemas refuse a body `user_id`; a service-role bearer is refused.
2. **Ownership is checked server-side on every request**, with the same refusal for a foreign and a missing account, and for a foreign and a missing video.
3. **The browser cannot name a channel.** `ids=channel==…` is built from the owned row.
4. **No new table, no new grant, no new RLS policy** under the recommended design. The function reads `social_accounts` and one `app_settings` key with the service role, inside `index.ts` adapters only. (The alternative in decision D6 adds one RESTRICTIVE policy and one service-only SQL function, and no table.)
5. **Nothing is stored.** No analytics value, video title or provider body is written to the database or to a log.
6. **No token or provider text in any response or log.** Tests assert the serialised response does not contain the fixture tokens.
7. **Refusal audit.** Every refusal after authentication writes one row to `system_logs` (`level` warn, `category` edge, `source` youtube-analytics) with `operation`, `code`, `request_id`, and `account_id` only once it is verified as the caller's. `unauthorized` and `method_not_allowed` are not written, so an anonymous caller cannot fill the table. A failed log write never changes the response. This is the `youtube-resources` rule.
8. **Refresh is health-neutral and grant-neutral** (§5.3).
9. **CORS** is `restrictedCorsHeaders(req)`, never the wildcard (ARCHITECTURE §25).
10. **The flag is a visibility switch.** The endpoint enforces authentication, ownership, the rollout policy, capability and rate limit whatever the flag says.
11. **One channel at a time.** No number from two channels is ever added together or shown side by side (§3.6).
12. **Disconnect.** Nothing is stored, so nothing has to be deleted. Browser memory is cleared on sign-out and account switch.

## 7. OAuth: which permission, and what it means for connected channels

### 7.1 Two branches

| | **Branch A — use the permission Postora already has** | **Branch B — add the analytics permission** |
|---|---|---|
| Scope used | `youtube.readonly`, already requested (`handler.ts:414-417`). | `https://www.googleapis.com/auth/yt-analytics.readonly`, added to that list. |
| Basis | Authorization guide: `youtube.readonly` "Grants `reports.query` access to non-monetary metrics" [V]; the notice on the `reports.query` page [V]. | The `reports.query` scope table lists it [V]. |
| Code change in `youtube-oauth` | **None.** | One line in the scope list, and the capability contract learns the scope. |
| The six channels connected today | Channels with `youtube.readonly` recorded work at once. Channels with no recorded scopes are tried and Google decides. No reconnect. | **Every channel must reconnect once.** Until then the page shows "Reconnect this channel and allow access to YouTube analytics". Publishing and comments keep working with the old grant. |
| Google verification | No new scope. Postora's stated use of an existing scope changes. Whether Google requires a new review for that is **not stated** on the pages fetched. | If the Cloud Console marks the scope sensitive, the app must be approved for it "before your app can start to call these APIs"; until then "your app's users will experience the unverified app screen and the app will be subject to the 100-user cap" [V] ([Google Cloud help](https://support.google.com/cloud/answer/13464018)). Google's pages disagree on how long that takes: "up to 10 days" [V] ([Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)) and "verification might require several months" [V] ([Unverified apps](https://support.google.com/cloud/answer/7454865)). |
| Consent screen | Unchanged. | One more permission line. Under Google's granular permissions, "Users can select which permissions they want to approve", and the app "can't assume users grant all requested scopes" [V] ([Granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)). An owner may untick analytics and keep the rest; the recorded scope list already handles this. |

How many of the six channels have recorded scopes was **not** checked (no production access for this document). Whether the consent screen is still in "Testing" was not checked either; if it is, only listed test users can connect at all, under either branch.

### 7.2 The check that decides

**Probe P1**, read-only, one named channel, approved by the owner, run before implementation starts: one `reports.query` request for one metric over seven days with a token that carries `youtube.readonly` and not `yt-analytics.readonly`.

- `200` → Branch A. No OAuth change.
- A permission refusal → Branch B.

The probe also records the error shape, which §3.5 lacks. It needs the YouTube Analytics API enabled in the Cloud project (an owner action). It writes nothing to YouTube.

### 7.3 True under both branches

- **The capability is derived from recorded scopes**, so the same code serves either branch: the required scope is one constant in `supabase/functions/youtube-analytics/contracts.ts`, used only by that function. The `youtube-resources` capability contract is **not** changed; the YouTube Channel page shows its "View analytics" link on the flag alone, and the analytics page reports the real availability.
- **The public disclosure must change before any channel is enabled.** `src/pages/GoogleApiDisclosure.tsx` must stop saying Postora never reads YouTube Analytics, and must list the scopes Postora really requests (it omits `youtube.force-ssl` today). The privacy policy text in `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` and on `/privacy` needs the same sentence. The wording is the owner's to approve.
- **The YouTube Analytics API must be enabled** for the Google Cloud project.
- **Existing refresh tokens are expected to keep working.** No fetched page says that adding a scope to future consent requests invalidates stored tokens, but none says the opposite either, so this is **unverified**. The refresh path is unchanged.
- **The reconnect experience** (Branch B, or a channel whose grant lacks the scope) is the comments precedent: a notice on the analytics page linking to Profiles, the normal Google consent screen, and the scope recorded on return. No automatic prompt, and no other feature is blocked meanwhile.

## 8. Rollout

**Dark by default.** After the merge nothing changes for any user until two switches are set.

| Gate | Where | Default | Who may change it |
|---|---|---|---|
| Visibility flag `feature_analytics_youtube` | `app_settings`, browser-readable like every `feature_*` key | Off (code default; no row needed) | Waleed, in Admin → Feature Flags |
| **Rollout policy `youtube_analytics_stage5_rollout`** | `app_settings`. Not `feature_`-prefixed and not on the browser read allow-list (`supabase/migrations/20261029170000_media_upload_limits.sql:17-39`), so non-admin browsers cannot read it. | **Absent = off for every channel.** Nothing seeds it. | Waleed only. `app_settings` writes are admin-only by RLS. |
| Native connection with the required scope | The account row | — | The channel's owner, by connecting |

Policy shape:

```json
{ "version": 1, "mode": "allowlist", "account_ids": ["<social_accounts.id>"] }
```

`mode` is `off`, `allowlist` or `all`, the Facebook analytics vocabulary. Missing key, unknown version, unknown mode, malformed JSON, an ID that is not a UUID, or more than 200 IDs → **deny**. A read that fails is an error (`settings_unavailable`), never a deny that looks like "off". Admins get no bypass.

The policy is read by the edge function with the service role on every request and never cached across requests, so a change takes effect at the next click, in running instances too.

**Why no migration is recommended for the gate.** Stage 4 made its key structurally private with a RESTRICTIVE policy and evaluated it in SQL because its gate guarded public, irreversible writes at a transactional boundary. Stage 5 reads an owner's own numbers and has no such boundary. The key is already unreadable by ordinary browsers: the read policy for signed-in users lists eleven named keys plus `feature_%` and nothing else (read directly at the lines cited above), and a SQL test pins that on the baseline plus every migration. This departs from the Stage 4 and Facebook precedents, which both use a database policy and SQL evaluation. The cost avoided is a production DDL step, a snapshot and a migration approval for a read-only feature. The stricter alternative is decision D6.

**Order of enablement**, each step a separate approval by Waleed:

1. P1 on one named channel (§7.2).
2. After the merge: policy `allowlist` with that one channel, then the flag on. Rehearsal R1 (§9.5).
3. The remaining pilot channels, by adding their IDs.
4. `mode: "all"`, only after the real Analytics quota has been read in the Cloud Console and the disclosure text is live.

No capability is implied by a merge or by an earlier approval.

## 9. Testing

All automated evidence is offline: fake provider, synthetic accounts, no public egress.

### 9.1 Deno

| Suite | Proves |
|---|---|
| `contracts.test.ts` | Every error code has a status; metric keys, units, periods and limits match this document. |
| `window.test.ts` | The Pacific-time window for each period, across both daylight-saving changes and the year boundary; the end date is three days back; a clock at 23:59 and at 00:01 Pacific. |
| `rollout.test.ts` | Absent, malformed, wrong version, unknown mode, over 200 IDs, non-UUID → deny; `off`, `allowlist` (listed and not listed), `all`; a failed read is an error, not a deny. |
| `analyticsReadClient.test.ts` | Exact request URL and parameters per operation; `ids` built from the account; timeout; column-header mismatch, non-numeric value and wrong row width → `upstream_unavailable`; missing `rows` → empty; each error class of §5.2; `The query is not supported` → `upstream_unavailable`; no provider text in any result; title lookup accepts only rows whose channel matches. |
| `handler.test.ts` (fake ports) | Unauthenticated; service role; unknown key including `user_id` and `channel_id`; foreign account equals missing account; inactive; non-YouTube; Composio; `needs_reauth`; recorded scopes without the required one; empty recorded scopes proceeds; policy absent, off, not listed, unreadable; rate limit; `401` then one forced refresh and one repeat; second `401`; foreign video equals missing video; database read failure is `internal_error`; **provider call counters at zero after every refusal**; no token in any response; a refusal row per refusal with no unverified identifier. |
| Health neutrality | After every failure path — `401`, `403` insufficient permission, `403` unknown, quota, `invalid_grant` on refresh — the fake store shows **no** write to `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`, and `dropGrantedScope` is never imported by the function. |
| Compatibility | The `youtube-resources` capability and handler suites pass unchanged; that function's files are not edited. |
| Composition | `index.ts` builds the real handler with real ports (catches a handler that is built but not wired). |

### 9.2 SQL harness

One small suite, `supabase/tests/youtube_analytics_rollout_privacy.sql`, registered in `SUITES` in `scripts/db-harness.sh`: with the key present, `anon` and a non-admin `authenticated` user read zero rows for it and cannot write it; an admin can read and write it; `service_role` can read it. No migration is needed for the suite to run. (Under decision D6 the suite also covers the policy and the evaluator.)

### 9.3 Vitest and Testing Library

Formatting (minutes to hours, seconds to minutes, zero and null); the gateway sends each request body in a shared fixture and maps each error code, with an unknown code falling back to `upstream_unavailable`; query keys contain user, account, period and video, and **switching account never shows the previous account's numbers, including while the new one loads**; one failing block does not hide the others; every state in §5.6 renders its own message and none renders as an empty report; subscribers gained and lost are separate and no net figure appears; the "numbers through" line shows the server's end date; Arabic and right-to-left; the route and sidebar entry follow the flag; `tests/architecture.test.ts` for the layering; the "View analytics" link appears only with the flag on. One shared request fixture is accepted by the Deno handler and sent by the Vitest gateway, tying browser to server as in Stage 2.

### 9.4 Journey with a fake provider

`scripts/stage5-e2e.mjs`, modelled on `scripts/stage4-e2e.mjs`, starts the disposable harness database, a local server (`e2e/fixtures/youtubeStage5Server.ts`) that composes the **real** `youtube-analytics` handler with a fake provider that counts requests for both Google hosts, and the built app. `e2e/youtube-stage5.spec.ts` runs in English and Arabic:

1. policy absent → the page says "not switched on" and the provider count is zero;
2. policy admits the channel → overview, trend and top videos appear; the provider count equals §4.1;
3. change the period → the dates and numbers change;
4. open a video → its cards and trend; another channel's video ID in the URL shows "not found" and makes no Analytics request;
5. a channel with no data → the empty state, not an error;
6. the provider answers with a permission refusal → the reconnect notice, and the account row's health columns and recorded scopes are unchanged in the database;
7. the provider answers with a quota refusal → the quota message, no retry;
8. switch to a second channel mid-load → nothing of the first channel is shown;
9. a second user with a channel not in the policy sees nothing of the first user's data.

The run fails on any unexpected external request. Playwright is not a CI job in this repository, so this is local evidence recorded in the PR with the command, head SHA and result, as in Stage 4.

### 9.5 What cannot be proven without a real channel

| Unknown | Settled by |
|---|---|
| Which scope Google accepts for `reports.query`. | P1 (§7.2). |
| The real error shapes: missing scope, quota, API not enabled, expired token. | P1 and R1. |
| That `channel==<ID>` behaves as documented for a Google account with more than one channel. | R1. |
| How many recent days are really missing, and whether three days back is right. | R1. |
| What a video filter for another channel's video returns (the design never sends one, but the answer confirms the ownership check is not the only barrier). | Not rehearsed; the check stands on its own. |
| What a small channel gets when data is below Google's thresholds. | R1 on a small channel, if one is available. |
| The real daily quota of the Analytics API. | The owner reads it in the Cloud Console. |
| That the numbers match YouTube Studio for the same Pacific-time range. | R1: the owner compares one period by eye. |

**Rehearsal R1**: read-only, the one pilot channel, after the merge and the first enablement, approved separately. It opens the page for each period and one video, and records the answers above in the PR and in `mem0`. It writes nothing to YouTube and stores no numbers.

## 10. Risks and open questions

| # | Risk or question | Handling |
|---|---|---|
| R-1 | The scope question (§3.1) is unresolved until P1. | Two branches designed; P1 before implementation; the capability is one constant. |
| R-2 | Google's policy on derived metrics and stored data was not read word for word (§3.6). | The first release stores and derives nothing. Plan step 1 re-reads the page; a comparison feature is blocked until then. |
| R-3 | The Analytics API has no documented error table (§3.5). | Classify by status; unknown is a temporary failure, never a health change; P1 and R1 record the real shapes and fixtures are updated. |
| R-4 | The Analytics daily quota is unknown (§3.4). | Per-user limits; pilot by allowlist; `mode: "all"` only after the Cloud Console reading. |
| R-5 | The public disclosure page is already inaccurate and becomes more so. | It is corrected in this delivery and must be live before any channel is enabled. The copy needs the owner's approval. |
| R-6 | Under Branch B, verification may be required and existing channels must reconnect. | Stated to the owner in decision D1; nothing else is blocked meanwhile. |
| R-7 | Numbers will differ from the YouTube Channel page counters (lifetime, public, live) and from Studio's default local-time view. | The page states the source, the period, the date the data runs through and the Pacific time zone; the two sources are never mixed. |
| R-8 | `views` changed meaning on 30 April 2025 (Shorts) and 16 November 2026 (co-views). A 90-day period can straddle the second date. | One fixed footnote under the overview cards linking to YouTube's explanation. No adjustment is attempted. |
| R-9 | The rollout key's privacy rests on an allow-list, not a policy. | Pinned by a SQL test; decision D6 offers the structural alternative. |
| R-10 | The rate limiter fails open (Stage 2 finding). | Unchanged and accepted, as in Stage 2. |
| R-11 | Stage 4 may merge at a head other than `7b8fe42b`. | Plan step 1 repeats the citations on the real base. |
| R-12 | The verification guide says the consent screen is in "Testing". If still true, only test users can connect. | Not checked; the owner confirms in the Cloud Console before the pilot. |

Open question that needs no decision before implementation: whether `videos.list` accepts ten IDs in one call (plan step 1; the design degrades if it does not).

## 11. Decisions for the owner

The first option of each row is the recommendation. The plan is written against the first options and names what changes otherwise.

| # | Question | Options (recommended first) | Why the recommendation | What changes otherwise |
|---|---|---|---|---|
| **D1** | Which Google permission does Postora use to read analytics? | **A. Run the one-request check P1 on one channel first. If Google accepts the permission Postora already has, use it; otherwise add the analytics permission.** B. Add the analytics permission now, without the check. | A may need no reconnect and no Google review at all, and costs one read-only request. B is certain to work but makes all six channels reconnect and may start a Google review. | B adds plan step 7 from the start, makes the merge an owner-card merge (permissions), and adds the reconnect notice to the pilot. |
| **D2** | Does Postora store YouTube analytics, or read it when asked? | **A. Read it from Google when the owner opens the page; store nothing.** B. Collect daily numbers into Postora's database, like Facebook. C. A now, B later if longer history or exports are wanted. | Google returns history on request, so storing adds nothing to the first release, and storing brings a migration, a cron job, a retention rule and an unread Google policy. | B replaces §5.1 with a new specification: tables, cron, retention, a policy reading, and a much larger Heavy delivery. |
| **D3** | What does the first release show? | **A. Channel overview, daily trend, ten most viewed videos, and the same for one video (§4.1).** B. Channel overview and daily trend only. C. A plus traffic sources, countries and devices. | A answers "how did the channel do, and which videos did it" in four requests. C triples the requests and brings in data Google often withholds for small channels. | B removes the top-videos and video operations (plan steps 3–5 shrink). C adds three operations, three blocks and their states. |
| **D4** | Which periods? | **A. Last 7, 14, 30 and 90 days, as on the Facebook and Threads pages.** B. Last 7, 28, 90 and 365 days, as in YouTube Studio. | One set of periods across Postora's analytics pages. | B changes one constant and its tests; 365 days makes the daily chart denser. |
| **D5** | Where is the page? | **A. In the Analytics menu at `/analytics/youtube`, with a "View analytics" link from each video on the YouTube Channel page.** B. A tab inside the YouTube Channel page only. | It is analytics, and the Analytics menu is where the other platforms are; the link covers the per-video path. | B drops the route, flag and sidebar entry and reuses `feature_youtube_management`; plan step 5 changes. |
| **D6** | How is the per-channel switch protected? | **A. A private settings key read by the server, with no database migration.** B. The same key plus a small migration that makes it unreadable by policy and evaluates it in SQL, as Stage 4 did. | The feature only reads an owner's own numbers; A avoids a production database change, a snapshot and a migration approval. | B adds one migration (one policy, one function, no table), a larger SQL suite, a snapshot and an owner-card merge. |

Recorded assumptions, not owner decisions, unless the owner objects: native connections only; no revenue; no agent, n8n or MCP access; no comparison with the previous period until the Google policy has been read in full.

## 12. Verification performed for this document

- Read at `7b8fe42b` through `git show`: `ARCHITECTURE.md` §§12–17, 22–28, 37–38 and the section list; the Stage 2 specification in full; the Stage 4 specification and plan in full; `youtube-oauth/handler.ts` and `index.ts` (scope and grant lines); `_shared/youtubeGrantedScopes.ts`, `_shared/youtubeCommentCapability.ts`, `_shared/youtubeTokenRefresh.ts` (exports and the health-neutral mode); `youtube-resources/capabilities.ts`, `contracts.ts`, and the handler and index wiring lines; `comment-manager/stage4/rollout.ts`; the Stage 4 migration's rollout section; `scripts/stage4-e2e.mjs`; `.github/workflows/ci.yml` step list; `docs/runbooks/youtube-comments-rollout.md`; `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`; `src/pages/GoogleApiDisclosure.tsx` (scope sentences); the analytics contract, schema, calendar, gateway, flags, routes and sidebar lines cited in §2.2.
- The Meta pipeline was mapped in one research pass over the same commit (collection worker, cron migrations, retention, rollout keys, readiness SQL, CI and Playwright set-up). Its line numbers for those files were not individually re-read.
- Google pages fetched on 2026-11-23 are the ones linked in §3 and §7.
- **Not verified:** everything marked [S]; the sensitivity class of either scope; the Analytics API's daily quota and error shapes; production state of any kind (the six channels' recorded scopes, the consent-screen status, whether the Analytics API is enabled); the maximum number of IDs per `videos.list` call.
- Not done, by instruction: code, migration, branch, commit, PR, production access, any call to a Google API.
