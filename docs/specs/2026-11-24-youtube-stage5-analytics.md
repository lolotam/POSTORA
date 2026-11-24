# YouTube Stage 5 — YouTube Analytics reports (specification)

24 November 2026 · proposal for owner review, nothing implemented · tier **Heavy**, with a migration (reason in the plan) · [Implementation and acceptance plan](../plans/2026-11-24-youtube-stage5-analytics.md)

Code baseline: `main` at `f7d49921`. The commits since the Stage 4 merge (`44b426cc`, PR #471) are documents only, so every path and line number below, first read with `git show` at the identical Stage 4 tree, holds unchanged. Stage 5 depends on two things Stage 4 created in `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql`: the health-neutral token store (`store_youtube_refreshed_token_with_lease_neutral`) and the `social_accounts.binding_generation` counter. The manager confirmed on 2026-11-24 that this migration is applied in production and that a real token refresh succeeded through the new store; this document did not check production.

This is the second revision. The owner's decisions are recorded in §11 and are built into the design; the options he did not choose have been removed. The two automated review rounds on pull request #472 are answered in §13 and §14. **Stage 5 now carries one database migration** (§5.2).

Google pages were fetched on 2026-11-23. Each provider fact carries its URL and one of two marks:

- **[V]** the sentence was read word for word on the page;
- **[S]** the page was too long to read in full and the fact comes from an automated summary of it. An [S] fact is **unverified** and is never the only support for a design rule; plan step 1 re-reads it.

## 1. Purpose and non-goals

### Purpose

The owner of a connected YouTube channel opens a page in Postora and sees how the channel performed over a chosen period: views, watch time, average view duration, subscribers gained and lost, likes, comments and shares, a day-by-day trend, the most viewed videos of the period, and the same numbers for one chosen video. The numbers come from the YouTube Analytics API, the same source YouTube Studio uses, and are read for that owner's channel only.

Today Postora shows only YouTube's public lifetime counters (total views, subscribers, likes per video) on the YouTube Channel page. It cannot answer "how did the last 30 days go?".

### Non-goals

- **No revenue or ad numbers.** They need a different Google permission and a channel in the YouTube Partner Program (§3.1).
- **No stored YouTube analytics data** (decision D2). No table, no cron job, no history beyond what Google returns on request. The one migration of this stage adds a policy and four functions, and stores nothing.
- **No numbers Postora computes itself**: no net subscribers, no engagement rate, no "+12% versus the previous period" (§3.6).
- **No audience breakdowns in the first release**: traffic sources, countries, devices, age and gender are listed as later options (§4.2).
- **No write to YouTube** and no change to publishing, comments, moderation, the comment poller, the OAuth attempt flow, the refresh lease or disconnect.
- **No change to the Meta analytics pipeline** (Facebook, Instagram, Threads), to TikTok analytics, to the Partner API, the n8n node, or the MCP tools. `get_account_analytics` keeps refusing YouTube.
- **No managed-connector (Composio) support.** A Composio-connected channel is told analytics is unavailable for its connection type, as in Stage 2 (`docs/specs/2026-11-20-youtube-stage2-resource-browse.md`, decision D3).
- **No live Google call in any automated test.**

## 2. Verified current state

### 2.1 YouTube, after Stage 4

| Fact | Evidence at `f7d49921` |
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
| Stage 4 added `social_accounts.binding_generation`: a trigger-maintained counter that advances on every disconnect, reactivation, re-consent or provider switch and stays unchanged only for the trusted token-refresh functions. | `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql:361`; `docs/specs/2026-11-22-youtube-stage4-comments.md` §6.2 |
| The refresh helper reads credentials by account ID alone, with no owner or generation filter. | `supabase/functions/_shared/youtubeTokenRefresh.ts:440-449`, `:706-718` |
| The shared rate limiter lets traffic through when its database call fails; Stage 4 wrote a fail-closed limiter on the same database function. | `supabase/functions/_shared/rate-limiter.ts:40-49`; `supabase/functions/comment-manager/stage4/rateLimit.ts` |
| Stage 4 bounds refusal audit rows with a rate bucket and a suppression counter. | `supabase/functions/comment-manager/stage4/audit.ts` |
| The browser's query client retries a failed query once by default. | `src/App.tsx:27` |
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
| Most viewed videos, metrics | A documented sample uses `metrics=estimatedMinutesWatched,views,likes,subscribersGained` with `dimensions=video`. **This is the one metric list the first release uses** (§5.5). | [V] | [Sample requests](https://developers.google.com/youtube/analytics/sample-requests) |
| Most viewed videos, wider metrics | Whether `averageViewDuration` and `comments` are allowed with `dimensions=video` was not read word for word. An unsupported mix fails every request with `400`. | [S] | [Channel reports](https://developers.google.com/youtube/analytics/channel_reports). Not requested in the first release. |

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
| The default daily limit of the Analytics API is **not stated** on any page fetched. The Data API quota table (10,000 units a day, one pool for the whole Google project) lists Data API methods only. | — | [Quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) |
| `channels.list` and `videos.list` cost 1 unit each. | [V] | [channels.list](https://developers.google.com/youtube/v3/docs/channels/list); [videos.list](https://developers.google.com/youtube/v3/docs/videos/list) |
| No maximum date range is stated. A `video` filter accepts up to 500 IDs; the design sends exactly one. | [V] | [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query) |
| How many IDs one `videos.list` call accepts is not stated on the fetched page. | — | Not stated. The design asks for at most 10 and degrades if refused (§5.5). |
| "Some YouTube Analytics data is limited when metrics do not meet a certain threshold." The thresholds "are not published". Demographics and geography are named. | [V] | [Data model](https://developers.google.com/youtube/analytics/data_model) |

### 3.5 Errors

The Analytics reference has **no error table** (the `reports.query` page has no Errors section, and the errors URL redirects to an overview). Only two errors are documented:

- unsupported or mutually exclusive combinations cause "an HTTP `400 badRequest` error with the message `The query is not supported`" [V] ([Channel reports](https://developers.google.com/youtube/analytics/channel_reports));
- revenue metrics for a channel outside the Partner Program return `403 Forbidden` [V] (same page).

How this API reports a missing scope, an exhausted quota, an expired token or an API that is not enabled for the project is **not documented on the pages fetched**. The design therefore classifies by HTTP status first and by Google's reason string only where one is present, and treats anything it does not recognise as a temporary failure. Most of these shapes cannot be observed safely on a real channel and stay unverified (§9.5).

### 3.6 YouTube developer policy on stored and derived data

These rules sit deep in a long page that could not be read word for word. They are all [S] and **unverified**; plan step 1 re-reads them before any text or behaviour depends on them.

| Rule as summarised | Source |
|---|---|
| Stored API data must be deleted or refreshed after 30 calendar days. The Analytics data model page repeats this for resource metadata, and that sentence **was** read: "API clients must either delete or refresh stored resource metadata from that API after 30 days." [V] | [Developer policies](https://developers.google.com/youtube/terms/developer-policies) III.E.4; [Data model](https://developers.google.com/youtube/analytics/data_model) |
| Data from the Analytics API may be kept as long as needed, but the client must confirm every 30 days that the user still authorises it. | Same policy page, [S] |
| A client must not use API data "to create new or derived data or metrics", and must not aggregate data across channels of different owners. An exception exists only for audited developers who applied for it. | Same policy page and its [guide](https://developers.google.com/youtube/terms/developer-policies-guide), [S] |
| After a user revokes access in the app, stored data must be deleted "within 7 calendar days of the revocation". | [V] [Developer policies](https://developers.google.com/youtube/terms/developer-policies), section D.2 |
| "Do not try to future-proof your access to data by asking for permissions that would enable features" not yet built. | [V] Same page, III.D.2.b |

The design stores nothing and derives nothing, so it complies under either reading of the unverified rules.

## 4. Proposed scope

### 4.1 The first release (decision D3)

One page, "YouTube analytics", for one selected channel and one selected period.

| Block | What the owner sees | Provider requests |
|---|---|---|
| Header | Channel picker, period picker (last 7, 14, 30 or 90 days, decision D4), a Refresh button, and two lines: "Period: <start> – <end>, Pacific time" (the dates Postora asked for) and "Last day with daily numbers: <date>" (the last day Google actually returned, §5.8). | none |
| Overview cards | Views · Watch time · Average view duration · Subscribers gained · Subscribers lost · Likes · Comments · Shares, each the total for the period, exactly as YouTube returns it. | 1 Analytics request |
| Daily trend | One line chart with a metric switch: views, watch time, subscribers gained, subscribers lost. One point per day Google returned; a day Google did not return is a gap in the line, never a zero. | 1 Analytics request |
| Most viewed videos | The ten most viewed videos of the period: title, views, watch time, likes, subscribers gained. One fixed metric set (§5.5). | 1 Analytics request + 1 Data API request for titles |
| One video | Clicking a video (here, or "View analytics" on the YouTube Channel page, decision D5) shows the same overview cards and daily trend filtered to that video. Subscriber cards carry a note that, for one video, YouTube counts only subscriptions from the video's watch page. | 2 Analytics requests + 2 Data API requests (each of the two reads confirms the video's ownership itself) |

Fixed rules for the first release:

- **Periods** are whole days ending three days before today in Pacific time. That is the period Postora *asks for*. It is not a promise about what Google has finished processing; the page shows the two separately (§5.8).
- **Nothing is computed by Postora.** Subscribers gained and lost are two cards, not one net number. There is no comparison with the previous period. Units are converted for display only (minutes shown as hours and minutes; seconds shown as minutes and seconds).
- **Native connections only.**
- **On demand.** Google is called when the owner opens the page, changes the channel or period, or presses Refresh. There is no polling of Google and no background job.

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
| More columns in the top-videos table | Average view duration and comments per video. | Only after Google's rule for the video report has been read word for word (§3.2, §5.5). |
| Revenue | Estimated revenue and ad performance. | Needs the monetary scope, Partner Program membership, and a Google verification decision. |
| Saved history | Daily numbers stored in Postora for trends longer than a query, exports, cross-platform summaries. | Not chosen (decision D2). It would be its own specification: tables, a cron job, a retention rule and a reading of Google's storage policy. |
| Managed-connector (Composio) channels | The same page for Composio connections. | Separate specification, as in Stage 2. |
| Agent, n8n and MCP access | `get_account_analytics` for YouTube. | Changes the public tool surface; out of scope here. |

## 5. Design

### 5.1 Where the data comes from: on demand, nothing stored

**Decided (D2): read from Google when the owner asks, and store nothing.** Reasons:

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
| A private, default-absent rollout key with the `off` / `allowlist` / `all` vocabulary of Facebook analytics (`supabase/migrations/20261115100000_facebook_analytics_all.sql:159-169`), hidden by a database policy and evaluated in SQL, as both Facebook's and Stage 4's are (decision D6, §5.2). | |
| The fail-closed limiter and the bounded refusal audit that Stage 4 introduced (§5.6, §6). | |

### 5.2 The database side: one migration, no table

The owner chose to protect the per-channel switch the way Stage 4 does (decision D6). Stage 5 therefore carries **one forward-only migration**. It creates no table and changes no existing table or function. It follows the shape of `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql`: the RESTRICTIVE policy at `:728-741`, the state reader at `:754`, the per-account status at `:914`, the yes/no evaluator at `:1048`, the grants at `:1895-1907`, and the closing assertions at `:2103-2150`.

| Object | What it is |
|---|---|
| Policy `app_settings_youtube_stage5_rollout_private` | RESTRICTIVE, `FOR ALL`, `TO anon, authenticated`. A row whose key is `youtube_analytics_stage5_rollout` or `youtube_analytics_stage5_consent` is visible and writable only to an admin (`public.has_role(auth.uid(), 'admin')`). The service role bypasses RLS. The consent key is covered from the start so that branch B needs no second policy. |
| `youtube_analytics_stage5_rollout_state()` | Reads the rollout key once and returns `{status, mode, account_ids}` with `status` one of `ok`, `rollout_missing`, `rollout_invalid`. A key that cannot be read **raises** (`ERRCODE 55000`, as Stage 4 does) so that "unreadable" is never mistaken for "off". |
| `youtube_analytics_stage5_capability_status(p_owner_id, p_account_id)` | The admission answer for one account: `{found, admitted, reason, channel_id, binding_generation, auth_provider, needs_reauth, granted_scopes, has_credentials}`. It returns **no token**. |
| `youtube_analytics_stage5_credentials(p_owner_id, p_account_id, p_expected_channel, p_expected_generation)` | Returns `access_token`, `refresh_token`, `token_expires_at` **only if** the account is still owned, active, native, admitted by the policy, and its channel and `binding_generation` equal the expected values. Otherwise it returns `{ok: false, reason}` and no credential. |
| `youtube_analytics_stage5_admits(p_owner_id, p_account_id, p_expected_channel, p_expected_generation)` | The single yes/no evaluator, with the same conditions as the credentials function. Fails closed. |

Rules for all four functions, as in Stage 4: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`, applied as `supabase_admin`. The migration ends with an assertion block that fails the migration if any function is not `SECURITY DEFINER` with the pinned path, if a browser role holds `EXECUTE`, or if either key has been seeded.

**One snapshot per decision.** The three account functions each decide inside **one SQL statement** that reads the account row and the policy row together, so "is this account admitted" and "is this still the same connection" are answered from the same instant. Stage 5 uses no row locks: it performs no write that needs fencing, and a lock would only delay a disconnect.

The account predicate, identical in all three: `id = p_account_id AND user_id = p_owner_id AND platform = 'youtube' AND is_active`. A row that fails it is reported as not found, the same for a foreign, missing, inactive and non-YouTube account. Admins get no bypass.

Policy document:

```json
{ "version": 1, "mode": "allowlist", "account_ids": ["<social_accounts.id>"] }
```

`mode` is `off`, `allowlist` or `all`. Missing key → `rollout_missing`. Not an object, unknown version, unknown mode, `account_ids` not an array, an entry that is not a UUID, or more than 200 entries → `rollout_invalid`. Both mean **deny for every account**. A malformed entry invalidates the whole document, as in Stage 4.

### 5.3 Edge function

One new function, `supabase/functions/youtube-analytics/`. It is not added to `youtube-resources`, whose handler already carries browse, categories and edit; analytics is a different job with a different provider host (ARCHITECTURE §13: no unrelated workflows in one handler).

| File | Responsibility |
|---|---|
| `contracts.ts` | The single contract: operations, response types, error codes with HTTP status, metric keys and units, the one top-videos metric list, the video-ID pattern, periods, limits, budgets, the required-scope set. Runtime-neutral, so the frontend imports its types from it (the Stage 2 pattern). |
| `window.ts` | Pure: turns "last N days" and a clock into the requested `startDate` and `endDate` in Pacific time, ending three days back. |
| `rollout.ts` | Thin adapter over the SQL functions of §5.2, like `supabase/functions/comment-manager/stage4/rollout.ts`. It decides nothing itself and caches nothing across requests. A failed call is an error, never "off". |
| `capability.ts` | Pure rule over the admission answer: connection type, connection health, recorded scopes. |
| `limits.ts` | The limiters of §5.6, all on the `check_rate_limit` function and all failing closed, following `supabase/functions/comment-manager/stage4/rateLimit.ts`. |
| `credentials.ts` | A refresh store for `refreshYouTubeAccountToken` whose account read is the bound credentials function of §5.2 (§5.4). |
| `analyticsReadClient.ts` | Typed calls to `youtubeanalytics.googleapis.com` and the two `videos.list` uses (ownership, titles). Timeout, per-report row validation, stable error mapping. Never touches the database. |
| `audit.ts` | Bounded audit rows (§6, rule 7). |
| `handler.ts` | `createYouTubeAnalyticsHandler(ports)`: CORS, method, authentication, validation, admission, capability, limits, bound credentials, use case, final recheck, response mapping. All I/O behind ports. |
| `index.ts` | Builds the ports and serves the handler. No business rule (ARCHITECTURE §12). |

`POST /functions/v1/youtube-analytics`, JSON body discriminated on `operation`, every schema strict. **Every response carries `Cache-Control: no-store`**, success and refusal alike, so no proxy or browser cache keeps private numbers.

| Operation | Input | Provider calls on success | Result |
|---|---|---|---|
| `status` | `account_id` | none | Whether analytics is available for this account, and if not, one reason. Also `connection_revision` and the policy numbers (periods, limits). The page renders from this. |
| `summary` | `account_id`, `period_days` (7, 14, 30, 90), optional `video_id` | 1 Analytics (+1 Data when `video_id` is present) | One value per metric for the requested period. |
| `daily` | same | 1 Analytics (+1 Data when `video_id` is present) | One row per day Google returned, four metrics, plus the observed coverage (§5.8). |
| `top_videos` | `account_id`, `period_days` | 1 Analytics + 1 Data | Up to ten rows with video ID, title, link and the four metrics of §5.5. |

`video_id` must match `^[A-Za-z0-9_-]{6,64}$`, the pattern `youtube-resources` already uses (`supabase/functions/youtube-resources/handler.ts:101`). The same pattern is applied to every video ID Google returns before it is used in a title lookup or a link. Every Google request is built with structured URL parameters, never by joining strings.

Success envelope, the same shape as `youtube-resources` (`contracts.ts:73-78`) plus the requested window and the connection revision:

```ts
interface YouTubeAnalyticsSuccess<T> {
  schema_version: 1;
  request_id: string;
  connection_revision: string;  // opaque; changes whenever the channel is disconnected or reconnected
  freshness: { fetched_at: string; source: "database" | "provider" };
  requested_window: {           // absent on `status`
    start_date: string;         // YYYY-MM-DD, what Postora asked Google for
    end_date: string;           // YYYY-MM-DD, what Postora asked Google for
    days: 7 | 14 | 30 | 90;
    time_zone: "America/Los_Angeles";
  };
  data: T;
}

interface YouTubeAnalyticsMetric {
  key: "views" | "watch_time" | "average_view_duration" | "subscribers_gained"
     | "subscribers_lost" | "likes" | "comments" | "shares";
  unit: "count" | "minutes" | "seconds";
  value: number | null;         // null only when Google sent an explicit null for that cell
}

interface YouTubeAnalyticsDaily {
  rows: Array<{ day: string; metrics: YouTubeAnalyticsMetric[] }>;   // only days Google returned
  coverage: {
    first_day: string | null;   // null when no row came back
    last_day: string | null;
    days_returned: number;
    days_missing: number;       // requested days with no row
  };
}
```

`connection_revision` is a keyed hash of the account ID and its `binding_generation`. It reveals nothing but equality. `requested_window` never claims coverage; only `daily.coverage` does, and only from rows Google sent.

#### Checks, in this order, on every request

1. **Caller.** A user JWT, validated the way `youtube-resources` does it. A service-role bearer is refused.
2. **Admission limit** for that user, covering every operation including `status` (§5.6). It runs before any other database work. A request refused here ends at once: no audit row, no second database call (§6, rule 7).
3. **Validation.** Strict schema. A body with `user_id`, `channel_id` or any unknown key fails; so does a `video_id` that does not match the pattern.
4. **Admission.** One call to `youtube_analytics_stage5_capability_status(caller, account_id)`. It answers ownership, the rollout policy and the binding from one snapshot.
   - not found → `not_found`, identical for a foreign, missing, inactive and non-YouTube account;
   - not admitted → `not_enabled`;
   - the call fails or the policy cannot be read → `settings_unavailable`, never a quiet "off".
   The `channel_id` and `binding_generation` it returns are the **admitted binding** for the rest of the request.
5. **Capability.** Composio is `provider_unsupported`. `needs_reauth`, or no stored credential, is `reconnect_required`. A recorded scope list that lacks a required scope is `missing_scope`. An empty recorded list proceeds and lets Google decide (Stage 2, D5).
   `status` ends here and returns `connection_revision`.
6. **Per-user data limit** (§5.6).
7. **Bound credentials.** `youtube_analytics_stage5_credentials(caller, account, admitted channel, admitted generation)`. If the channel was disconnected, reconnected or switched off since step 4, it returns no credential and the answer is `connection_changed` (or `not_enabled`). Nothing has been sent to Google.
8. **Token**, through `refreshYouTubeAccountToken` in health-neutral mode, given the step-7 credentials as its snapshot and the **bound store** of §5.4. A token that is still valid is used as it is, and it is by construction the admitted connection's. If a refresh is needed, the helper's own credential read is again the bound function, so it cannot read a replacement connection. A refusal is `reconnect_required`, `connection_changed` or `upstream_unavailable`, in the response only.
9. **Video ownership**, only when `video_id` is present. Before the request: one unit is debited from the Data budget (§5.6). Then `videos.list?part=snippet&id=<video>`, 15-second timeout.
   - A valid `200` that contains that ID with `snippet.channelId` equal to the admitted channel → continue.
   - A valid `200` without such an item → **`video_not_found`**, identical for a missing video and another channel's video. This is the only path to it.
   - `401` → see "The `401` rule" below.
   - A quota refusal → `quota_exceeded`. An insufficient-permission refusal → `missing_scope`. A timeout, a network failure, a `5xx`, an unrecognised error or a malformed body → `upstream_unavailable`.
   - After any outcome other than "continue", **no Analytics request is made**.
10. **One Analytics request.** Before it: one unit is debited from the Analytics budget. `ids=channel==<the admitted channel ID>`, 15-second timeout. The channel ID comes from the admission answer, never from the browser.
11. **Validate the answer** by report (table below). Anything that does not fit is `upstream_unavailable`.
12. **Titles** (`top_videos` only), §5.5, after one more Data debit.
13. **Final recheck.** `youtube_analytics_stage5_admits(caller, account, admitted channel, admitted generation)`, as the last step before the response is written. If it answers no, **the provider result is discarded**: `connection_changed` when the binding moved, `not_enabled` when the rollout was withdrawn, `settings_unavailable` when the call failed.

**The `401` rule.** A request may force **one** token refresh in total, and only for a token it did not itself obtain by refreshing.

- `401` on a token that step 8 returned without refreshing, and no forced refresh used yet → force a refresh through the bound store, then repeat that one Google call once (after its own budget debit).
- `401` in any other case → **`reconnect_required`**, with no further Google call. That covers: a token this request has just refreshed; a second `401` after the repeat; and a `401` from the Analytics call when the forced refresh was already spent on the ownership lookup.

A forced refresh that finds the binding changed returns `connection_changed` and repeats nothing.

#### Row validation, per report

| Report | Column headers must be exactly | Each row | Other rules |
|---|---|---|---|
| `summary` | the eight metric names, in the requested order | At most one row. Eight cells. Each a finite number ≥ 0, or an explicit JSON `null`. | No `rows` → every metric is `null` and the block shows "no numbers". |
| `daily` | `day`, then the four metric names | `day` is a `YYYY-MM-DD` calendar date inside the requested window, with no duplicates. Four metric cells as above. | No `rows` → empty series. A day missing from the answer is simply absent from `rows`; nothing is filled in on the wire. |
| `top_videos` | `video`, then the four metric names of §5.5 | `video` is a **string** matching the video-ID pattern, with no duplicates. Four metric cells as above. At most ten rows. | No `rows` → empty list, and no title lookup. |

A row with the wrong number of cells, a non-numeric metric, a negative number, a malformed date, a date outside the window or an ID that fails the pattern makes the whole answer `upstream_unavailable`. An explicit `null` cell becomes `value: null` and is shown as "—". A missing cell is never turned into `null` or zero.

#### Error codes

Each has a fixed HTTP status and fixed English and Arabic copy. The response never carries Google's text.

| Code | HTTP | When | Scope in the page |
|---|---|---|---|
| `invalid_request` | 400 | Not JSON, fails the schema, unknown key, unsupported period, malformed `video_id`. | This request |
| `unauthorized` | 401 | Missing, invalid or service-role bearer. | Session |
| `not_enabled` | 403 | The rollout policy does not admit this account, at step 4, 7 or 13. | **Account** |
| `missing_scope` | 403 | The recorded scopes lack a required one, or Google refuses for insufficient permission. | **Account** |
| `not_found` | 404 | Account not owned, not YouTube, inactive or absent. | **Account** |
| `video_not_found` | 404 | A **successful** ownership lookup found no owned video. | **This video only** |
| `method_not_allowed` | 405 | Anything other than `POST` and `OPTIONS`. | — |
| `provider_unsupported` | 409 | The caller's own account is Composio-managed. | **Account** |
| `reconnect_required` | 409 | `needs_reauth`, no refresh token, or a `401` that may not be retried. | **Account** |
| `connection_changed` | 409 | The channel was disconnected or reconnected while the request was running. | **Account** |
| `rate_limited` | 429 | Postora's own per-user limits; carries `retry_after_seconds`. | This block |
| `capacity_reached` | 429 | Postora's shared daily budget for a Google API is spent (§5.6). | This block |
| `quota_exceeded` | 429 | Google refuses for quota. | This block |
| `settings_unavailable` | 503 | The rollout functions or a limit counter could not be read. | This block (§5.7) |
| `upstream_unavailable` | 502 | Timeout, network failure, Google `5xx`, an unrecognised Google error (including `The query is not supported` and "API not enabled"), or an answer that fails validation. | This block |
| `internal_error` | 500 | An unexpected exception. | This block |

Only the codes marked **Account** make the page drop that account's reports (§5.7). A stale or foreign video link does not.

#### Provider calls each outcome must show

"Token calls" are requests to Google's token endpoint. Each Data and Analytics call below is preceded by exactly one budget debit.

| Outcome | Token | Data API | Analytics |
|---|---|---|---|
| Any refusal at steps 1–7, and `status` | 0 | 0 | 0 |
| Binding changed before a needed refresh (step 8) | 0 | 0 | 0 |
| Refresh needed and refused by Google | 1 | 0 | 0 |
| Budget spent before the first Google call | 0 or 1 | 0 | 0 |
| `summary` or `daily`, valid token, success | 0 | 0 | 1 |
| `summary` or `daily`, refreshed token, success | 1 | 0 | 1 |
| Same, refreshed token, then `401` → `reconnect_required` | 1 | 0 | 1 |
| Valid token, `401`, forced refresh, success | 1 | 0 | 2 |
| Valid token, `401`, forced refresh, `401` → `reconnect_required` | 1 | 0 | 2 |
| Valid token, `401`, binding changed at the forced refresh → `connection_changed` | 0 | 0 | 1 |
| With video: lookup succeeds, video not owned → `video_not_found` | 0 | 1 | 0 |
| With video: lookup fails (quota, permission, timeout, `5xx`, malformed) | 0 | 1 | 0 |
| With video: lookup `401`, forced refresh, lookup ok, Analytics ok | 1 | 2 | 1 |
| With video: lookup `401`, forced refresh, lookup ok, Analytics `401` → `reconnect_required` | 1 | 2 | 1 |
| With video: lookup ok, Analytics budget spent → `capacity_reached` | 0 | 1 | 0 |
| With video, success | 0 | 1 | 1 |
| Analytics refusal (quota, permission, unsupported query, `5xx`) | 0 | 0 or 1 | 1 |
| `top_videos`, success | 0 | 1 | 1 |
| `top_videos`, title lookup fails, or the Data budget is spent before it | 0 | 1 or 0 | 1 |
| `top_videos`, no rows | 0 | 0 | 1 |
| Final recheck says no (step 13) | as above | as above | as above, **and no number is returned** |

### 5.4 Credentials, refresh and what they may change

Analytics is an optional read. A problem with it must never break publishing or comments, and it must never use or refresh a connection other than the one that was admitted.

**Why a bound store.** The shared helper reads credentials by account ID alone (`supabase/functions/_shared/youtubeTokenRefresh.ts:440-449`) and reads them again under the lease just before it calls Google (`:712-718`, exchange at `:786-792`). If the owner reconnected between admission and that read, the helper would send the *new* connection's refresh token to Google and store the result. A recheck afterwards could protect the report but could not undo that exchange.

The helper takes its store as a parameter (`store: YouTubeRefreshStore`, same file `:157`). Stage 5 passes a store that is the standard one (`createSupabaseYouTubeRefreshStore`) with a single method replaced: `readAccount` calls `youtube_analytics_stage5_credentials` with the admitted channel and generation. Consequences:

- A reconnect or disconnect **before** the helper's read → the read returns nothing → the helper answers "account not found" → **no token exchange is started**. The handler reports `connection_changed`.
- A reconnect **during** an exchange that was started for the admitted connection → that exchange cannot be recalled, but its result is not stored: a credential change deletes the refresh lease (`delete_youtube_refresh_lease_on_credential_change`, `supabase/migrations/20261120130000_youtube_refresh_lease_fixes.sql:377-411`), so the store call fails as a stale lease and writes nothing. The helper's follow-up read is again the bound function and returns nothing.
- The shared helper file is not edited.

**Generation.** `social_accounts.binding_generation` (`supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql:361`) advances on every disconnect, reactivation, re-consent and provider switch, never decreases, and stays unchanged only for the trusted refresh functions (`docs/specs/2026-11-22-youtube-stage4-comments.md`, §6.2). The health-neutral store is one of those functions, so an analytics refresh does not advance it.

**What an analytics request may write:**

- the refresh lease row, taken and released;
- on a successful refresh, `access_token`, `token_expires_at`, a rotated `refresh_token` if Google sends one, and `updated_at`, through `store_youtube_refreshed_token_with_lease_neutral` (same migration, `:201-276`).

**What it never writes:** `needs_reauth`, `failure_count`, `last_refresh_error`, `account_metadata.granted_scopes`. It never calls `dropGrantedScope`. A `403` from either Google API is shown to the owner and nothing is recorded; otherwise a late refusal could remove a grant that publishing or comments rely on (Stage 4's finding F7).

**Residuals, stated plainly.**

- The neutral store does not check `is_active`. A browser-side disconnect only clears that flag (`src/hooks/useSocialAccounts.tsx:73-77`) and deletes no lease, so a refresh already in flight can still store a token on the just-disconnected row. That is existing behaviour for every caller of the helper; Stage 5 does not change it, and the final recheck discards the report.
- Between the final recheck and the bytes leaving the server there is a window of milliseconds that no check can close (§5.7).

### 5.5 The top-videos report: one metric list, and titles

**One definition, used by the query, the validator, the fixtures and the table:**

```text
dimensions = video
metrics    = estimatedMinutesWatched,views,likes,subscribersGained     (this order)
sort       = -views
maxResults = 10
```

This is the documented sample, read word for word (§3.2). There is no wider set and no fallback. `averageViewDuration` and `comments` per video are a later option. The table columns are: title · views · watch time · likes · subscribers gained (with the watch-page note of §4.1).

**Titles.** The Analytics API returns video IDs only. Titles come from one `videos.list?part=snippet&id=<up to 10 validated IDs>` call. A row is given a title only when Google returns that ID with `snippet.channelId` equal to the admitted channel. A row without a match is shown as "Video unavailable" with its numbers; Google states that deleted items stay in totals but not in per-video rows ([Data model](https://developers.google.com/youtube/analytics/data_model), [V]). If the title call fails for any reason, or the Data budget is spent before it, the list is still returned with IDs and a `titles: "unavailable"` marker: the Analytics call has already been made and paid for, so its numbers are not withheld.

### 5.6 Limits and the shared Google quota

All limiters use the existing `check_rate_limit` database function (`supabase/manual-sql/20260627213616_rate_limit_buckets.sql:36`), which increments a counter atomically under a row lock. All **fail closed**: if the counter cannot be read, the request is refused (`settings_unavailable`), following Stage 4's limiter (`supabase/functions/comment-manager/stage4/rateLimit.ts`) and not the shared helper, which lets traffic through when its database call fails (`supabase/functions/_shared/rate-limiter.ts:40-49`).

| Limiter | Counted | Limit | Purpose |
|---|---|---|---|
| Admission, per user | Once per request, every operation including `status` | 120 a minute | Bounds the database work one signed-in user can cause. |
| Data, per user | Once per `summary`, `daily` or `top_videos` request | 60 per 10 minutes and 300 per day | Bounds one user's share. |
| **Shared daily budget, whole project** | **Once immediately before every actual Google request**: each ownership lookup, each Analytics call, each title lookup, **and each repeat after a `401`** | **Data API: 1,000 a day. Analytics API: 2,000 a day.** (decision D8) | Caps what Stage 5 as a whole can draw. |

**The debit is per attempt, not per operation.** A request is never admitted for "the calls it will probably make". Each Google call asks for its own unit just before it is sent, so a repeat after a `401` cannot pass a spent ceiling, and a title lookup that never happens is never charged. When a debit is refused:

- before the first Google call of the request → `capacity_reached`, nothing sent;
- after the ownership lookup but before the Analytics call → `capacity_reached`; the lookup's unit is spent and nothing is returned;
- before the title lookup → the report is returned with `titles: "unavailable"`.

Token-endpoint calls are not debited; they do not use YouTube API quota.

**What the ceiling does and does not do.** It limits **Stage 5's own contribution** to the shared pools. The Data API allowance is one pool of 10,000 units a day by default for the whole Google project (§3.4), shared with the comment poller, browse, video edits and comment writes. The ceiling means analytics can never spend more than 1,000 of it. It does **not** guarantee that publishing or comments have quota left: if they have already used 9,900 units, analytics may still spend the last 100. Protecting existing traffic absolutely would need a project-wide ledger that every feature debits, which is out of scope. Before the feature is opened to everyone, both ceilings are reviewed against the real limits in the Cloud Console **and** against the observed daily peak of the existing features, leaving explicit headroom (decision D8).

Whether `check_rate_limit` exists in production with the behaviour assumed here was **not** checked for this document; plan step 0 confirms it read-only.

**Honest quota errors.** A Google quota refusal is `quota_exceeded`. Nothing is repeated automatically, on the server or in the browser (§5.7).

### 5.7 Frontend

```text
src/features/youtube-analytics/
├── domain/          types.ts (re-exports contracts.ts), errors.ts, format.ts, trendSeries.ts
├── application/     ports.ts, queryKeys.ts, useYouTubeAnalyticsStatus.ts, useYouTubeAnalyticsSummary.ts,
│                    useYouTubeAnalyticsDaily.ts, useYouTubeTopVideos.ts, useAccessLease.ts
├── infrastructure/  supabaseYouTubeAnalyticsGateway.ts        (the only file that imports the Supabase client)
├── ui/              YouTubeAnalyticsScreen.tsx, OverviewCards.tsx, DailyTrend.tsx, TopVideosTable.tsx,
│                    VideoAnalyticsPanel.tsx, AnalyticsNotice.tsx
├── tests/           architecture.test.ts
└── index.ts
```

- Dependency direction per ARCHITECTURE §§3–4: `ui → application → domain`; `infrastructure → application ports and domain`. The screen takes the gateway as an optional prop with the Supabase gateway as default.
- **Real consumer** (ARCHITECTURE §1): page `src/pages/analytics/YouTubeAnalytics.tsx`, route `/analytics/youtube` in `src/components/AnimatedRoutes.tsx`, sidebar child in the Analytics group of `src/components/layout/DashboardLayout.tsx`, shown when `flags.analyticsYoutube` is on. With the flag off the page redirects to `/dashboard`. The YouTube Channel page's video detail (`src/features/youtube-management/ui/YouTubeVideoDetail.tsx`) gains a "View analytics" link to `/analytics/youtube?account=…&video=…`, shown only when the flag is on. That is a frontend-only change; the `youtube-resources` function and its contract are untouched.
- The flag `feature_analytics_youtube` is added to `src/hooks/useFeatureFlags.tsx` beside the other four, default `false`. The code default applies when the row is absent, so the flag needs no migration.
- The chart uses `recharts`, the library the saved-report trend already uses (`src/features/analytics-contract/ui/SavedAnalyticsReport.tsx:69-71`). No new dependency.

**Caching.** No server cache. In the browser, React Query memory only, `staleTime` 30 minutes for the three data operations.

**Query keys carry the connection.** Every data query key is `[user, account, connection_revision, period, video]`. `connection_revision` comes from `status`. A data query does not run until `status` has answered "available" with a revision. When a later `status` returns a different revision, every cached report under the old revision is removed, even though the account is still "available". A data response whose own `connection_revision` differs from the key it was requested under is dropped.

**No request the owner did not ask for.** The application default retries a failed query once (`src/App.tsx:27`). The library is `@tanstack/react-query` 5.x (`package.json:52`). For every Stage 5 data query:

- no automatic retry after a failure;
- no refetch when the network returns;
- no refetch when a block that holds an error is mounted again;
- no refetch on window focus, and no interval.

A failed block is fetched again only when the owner presses its retry control, changes the period or channel, or presses Refresh. The behaviour is the contract; the option names (`retry`, `refetchOnReconnect`, `retryOnMount`, `refetchOnWindowFocus`) are confirmed against the installed version in plan step 6 and proved by tests that simulate a connectivity change and a remount after a refusal.

**The access lease: reports are shown only under a recent successful check.**

1. While the page is visible it asks `status` every 60 seconds. `status` calls no provider and spends no Google quota.
2. Reports for an account are displayed **only while the last successful `status` for it — "available", same `connection_revision` — is at most 90 seconds old.** That is the lease.
3. If a `status` call fails, times out, or answers `settings_unavailable`, the lease is simply not renewed. When it expires, the reports are **hidden** and the page shows "Checking access…". They stay in memory and reappear when a `status` succeeds with the same revision.
4. If `status`, or any data operation, answers an **account-scoped** code (`not_enabled`, `not_found`, `reconnect_required`, `connection_changed`, `provider_unsupported`, `missing_scope`), the reports for that account are **removed from memory**, its in-flight requests are cancelled, and the matching state is shown. A response that arrives afterwards for that account is dropped.
5. A hidden tab stops polling. When it becomes visible again, or the device comes back online, nothing is shown until a fresh `status` succeeds.
6. `video_not_found` affects that video's panel only. Channel reports and other requests are untouched.

**What this guarantees, and what it does not.**

| Situation | Bound |
|---|---|
| Rollout switched off, page open and online | New requests are refused at once. Reports leave the screen at the next `status`, at most about 60 seconds later. |
| Rollout switched off, page open, `status` failing or device offline | Reports are hidden when the lease expires, at most 90 seconds after the last successful check. |
| Rollout switched off, tab in the background | Nothing is shown when the tab returns until a check succeeds, and that check removes the reports. |
| Channel reconnected or disconnected in another tab | The next successful `status` carries a new revision and the old reports are removed. |
| Request in flight when access is withdrawn | Its result is discarded if the final recheck sees the withdrawal (§5.3, step 13). |
| **Not guaranteed** | A response whose final recheck passed a few milliseconds before the switch is delivered. Numbers a person has already read cannot be taken back. Both are handled as incident steps (plan §6). |

States, each distinct, none rendered as an empty report:

| State | Shown |
|---|---|
| Loading | Skeletons per block. Blocks load independently; one failing block does not hide the others. |
| Checking access | Reports hidden; "Checking access…". Shown while the lease is expired and unrenewed. |
| No YouTube channel | Empty state with a link to Profiles. |
| Not enabled | "YouTube analytics is not switched on for this channel yet." No reconnect prompt: reconnecting cannot change rollout. |
| Managed connection | "This channel is connected through the managed connector, which does not provide analytics." |
| Reconnect needed | "Reconnect this channel on Profiles", linking to `/profiles`. |
| Permission missing | "Reconnect this channel and allow access to YouTube analytics", linking to `/profiles`. Under branch B it is shown only when the consent gate admits the user (§7.4); otherwise the account is "not enabled". |
| Connection changed | "This channel was reconnected or disconnected. Reload to continue." |
| Video not found | In the video panel only: "This video is not available on this channel." |
| Empty | "YouTube has no numbers for this period yet." Typical for a new channel or new video. |
| Days not returned | The trend shows gaps, and a note says: "YouTube did not return daily numbers for <n> day(s) of this period." |
| Google quota | "YouTube's daily limit was reached. Try again tomorrow." |
| Postora capacity | "Analytics is busy today. Try again tomorrow." |
| Rate limited | "Too many requests. Try again in N minutes." |
| Temporary failure | "YouTube analytics could not be loaded", with a retry control and the request reference. |
| Video unavailable | A top-video row whose title could not be confirmed. |

English is inline; Arabic is added under a `youtube` group in `src/i18n/locales/ar/analytics.json`, and the sidebar label in `src/i18n/locales/ar/nav.json`. The page works right-to-left; numbers, dates and durations render left-to-right inside it, as the competitor screens already do (`src/features/competitor-tracking/ui/LtrValue.tsx`). Every control is keyboard reachable and the chart has a table alternative. Counters on the YouTube Channel page stay labelled as YouTube counters; they are a different source from this page and are not mixed with it.

### 5.8 The requested period and what Google actually returned

Google says "The response for a query with the `day` dimension will not contain rows for the most recent days" and that processing "typically" takes 48 to 72 hours (§3.3). Ending the period three days back makes missing days unlikely, not impossible.

- The **requested period** comes from the clock and is shown as "Period: <start> – <end>, Pacific time". It is labelled as the period, never as coverage.
- The **last returned day** comes only from the `daily` answer and is shown as "Last day with daily numbers: <date>". If the `daily` block has not loaded or failed, the line is not shown.
- **A missing row means only that Google did not return that date.** The page does not say the data is unpublished, and it does not say the totals will change: it has no evidence for either. The note is exactly "YouTube did not return daily numbers for <n> day(s) of this period."
- **Totals carry no coverage claim.** `summary` and `top_videos` have no per-day signal, so the page never says they are complete or incomplete.
- **On the wire the rows stay sparse**: only days Google returned. **For the chart only**, `trendSeries.ts` builds one point per requested day and sets the value to `null` for a day with no row. The line is drawn with `connectNulls={false}`, as the saved-report chart does (`SavedAnalyticsReport.tsx:71`), so a missing day breaks the line. Without the `null` points the library would join the neighbouring days and hide the gap. No missing day is ever drawn as zero, and the table alternative lists missing days as "—".

## 6. Security and privacy

1. **Identity comes only from the JWT.** Strict schemas refuse a body `user_id`; a service-role bearer is refused.
2. **Ownership, admission and the binding are decided in SQL**, in one statement, on every request (§5.2), with the same refusal for a foreign and a missing account.
3. **The browser cannot name a channel.** `ids=channel==…` is built from the admission answer. A browser-supplied video ID is format-checked, then ownership-checked, before it is used.
4. **Credentials are released only for the admitted connection.** The token is read through a function that requires the admitted channel and generation, at first use and inside any refresh (§5.4). A result is returned only after a final recheck of the same conditions.
5. **The rollout and consent keys are private by policy**, not by convention: a RESTRICTIVE policy hides them from every non-admin browser session, and the functions that read them are executable by the service role only (§5.2).
6. **Nothing new is stored.** No analytics value, video title or provider body is written to the database or to a log. The **one permitted write of a token** is the existing one: when a token has to be refreshed, the health-neutral store saves it to the account row (§5.4), exactly as publishing and comments already do. No token is written anywhere else. No token or provider text appears in any response or log; tests assert the serialised response and log rows contain neither the fixture tokens nor the fixture provider messages.
7. **Audit work is bounded.**
   - Rows go to `system_logs` (`category` edge, `source` youtube-analytics) with `operation` (only if it is a known operation name, otherwise `unknown`), `code`, `request_id`, and `account_id` only once it is verified as the caller's.
   - `unauthorized` and `method_not_allowed` write nothing, so an anonymous caller writes nothing.
   - **A request refused by the admission limiter is a cheap terminal path:** no audit row, no further database call, and at most one console line per worker per minute. Sustained over-limit traffic therefore costs one counter call per request and nothing else.
   - **Other refusals: at most 20 rows per user per minute**, enforced by a shared atomic bucket in `check_rate_limit`, so the bound holds across all workers. A refusal beyond it writes no row.
   - **The count of suppressed refusals is best effort.** Stage 4 keeps its tally in the memory of one worker (`supabase/functions/comment-manager/stage4/audit.ts:38`), which cannot count across workers or restarts. Stage 5 does not promise an exact figure: each worker emits one sanitised console line per minute with its own count, and no counter row is written. What is exact is the row bound.
   - Each **successful data operation** writes one `info` row with the same fields and no numbers, bounded by the per-user data limit. Its purpose is incident scoping.
   - A failed audit write never changes the response.
8. **Refresh is health-neutral and grant-neutral** (§5.4).
9. **CORS** is `restrictedCorsHeaders(req)`, never the wildcard (ARCHITECTURE §25). **Every response is `Cache-Control: no-store`.**
10. **The flag is a visibility switch only.** It does not stop the endpoint. The rollout policy is the access switch (§8).
11. **One channel at a time.** No number from two channels is ever added together or shown side by side (§3.6).
12. **Disconnect.** Nothing is stored, so nothing has to be deleted. Browser memory is cleared on sign-out, on account switch, on a changed connection revision and when access is withdrawn (§5.7).

## 7. OAuth: which permission, and what it means for connected channels

### 7.1 Two branches

| | **Branch A — use permissions Postora already has** | **Branch B — add the analytics permission** |
|---|---|---|
| Scope used | Existing scopes only (`supabase/functions/youtube-oauth/handler.ts:414-417`). Exactly which of them are required is what P1 establishes (§7.2). | `https://www.googleapis.com/auth/yt-analytics.readonly` in addition. |
| Basis | Authorization guide: `youtube.readonly` "Grants `reports.query` access to non-monetary metrics" [V]; the notice on the `reports.query` page [V]. | The `reports.query` scope table lists it [V]. |
| Code change in `youtube-oauth` | **None.** | The scope is added to the consent request **behind a server-side gate** (§7.4). |
| Channels connected today | Channels whose recorded scopes contain the proven set work at once. Channels with no recorded scopes are tried and Google decides. No reconnect. | A channel gets analytics only after its owner reconnects and grants the new scope. Publishing and comments keep working with the old grant. |
| Google verification | No new scope. Postora's stated use of an existing scope changes. Whether Google requires a new review for that is **not stated** on the pages fetched. | If the Cloud Console marks the scope sensitive, the app must be approved for it "before your app can start to call these APIs"; until then "your app's users will experience the unverified app screen and the app will be subject to the 100-user cap" [V] ([Google Cloud help](https://support.google.com/cloud/answer/13464018)). Google's pages disagree on how long that takes: "up to 10 days" [V] ([Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)) and "verification might require several months" [V] ([Unverified apps](https://support.google.com/cloud/answer/7454865)). |
| Consent screen | Unchanged. | One more permission line, only for users the gate admits. Under Google's granular permissions, "Users can select which permissions they want to approve", and the app "can't assume users grant all requested scopes" [V] ([Granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)). |

How many of the connected channels have recorded scopes, and which scopes, was **not** checked. Whether the consent screen is still in "Testing" was not checked either; if it is, only listed test users can connect at all, under either branch.

### 7.2 The check that decides: probe P1

The owner decided: probe first, and add the analytics permission only if a positive test shows it is needed. The probe is a real, read-only Google request on one of the owner's channels. **Each part needs its own approval at the time it is run.** Nothing in this document authorises it.

**How the probe learns which scopes its token really carries.** The earlier revision said the refresh helper returns them. It does not, in the mode the probe must use: in health-neutral mode the helper returns `grantedScopes: null` even when Google sent a `scope` field (`supabase/functions/_shared/youtubeTokenRefresh.ts:906`), and it also returns `null` when it reuses a token another worker refreshed (`:765-771`). Running it in the normal mode instead would rewrite the recorded grants and could mark the account as needing reconnection on a refusal (`:808-816`). The probe therefore does this:

1. It obtains the access token through the helper **in health-neutral mode**, so the only possible writes are those listed in §5.4.
2. It asks **Google's token information endpoint about that exact access token** and reads the `scope` list from the answer. The endpoint is `https://oauth2.googleapis.com/tokeninfo`; its behaviour and whether it accepts the token in a request body are **unverified** here (no Google page for it was fetched) and are read from Google's documentation before P1 is approved. This is a second read-only Google request. It uses no YouTube API quota.
3. If that answer is not a `200` with a `scope` field, the probe is **inconclusive and stops** before any Analytics request.

**Which tokens count as evidence.** The connect flow asks for three scopes and also sets `include_granted_scopes=true` (`handler.ts:414-427`), so a token can carry grants from an older consent that today's flow would never request. If such a token succeeded, the result could be credited to the wrong scope set and every channel would then be asked for a permission the connect flow cannot give.

- **P1-a counts only if the token's effective scopes are all among the three the connect flow requests** (`youtube.readonly`, `youtube.upload`, `youtube.force-ssl`) and do not include `yt-analytics.readonly`. Any other scope on the token → that channel is unsuitable; choose another or stop.
- **P1-c counts only if its token's effective scopes are exactly the P1-a set plus `yt-analytics.readonly`**, with no other difference. Anything else → inconclusive.

| Part | Token | Result | What it establishes |
|---|---|---|---|
| **P1-a** | A production token for one named channel, obtained as above, whose effective scopes pass the rule above. | `ok` | **Branch A is viable for channels that hold every scope on that token.** The required set is exactly that observed set. |
| | | `insufficient_permission` | Branch A fails for that set. **Not yet branch B**: run P1-c. |
| | | Anything else | **Inconclusive.** Fix the cause if it is `api_not_enabled` and repeat once; otherwise stop and report. |
| **P1-b** (optional, only after `ok` in P1-a) | A token whose effective scopes are `youtube.readonly` and nothing else, obtained by the owner for his own channel through a separate consent. | `ok` | The required set narrows to `youtube.readonly` alone, which also covers an owner who unticked the other permissions. |
| | | Refusal, or the token turns out wider | The required set stays at the P1-a set. |
| **P1-c** (only after `insufficient_permission` in P1-a) | A token for the owner's own channel that passes the P1-c rule above. It must be obtained **by refreshing the stored refresh token after the re-consent**, not taken from the consent callback (see below). | `ok` | **Branch B is confirmed**, including that the stored grant can mint analytics-capable tokens. |
| | | Refusal | Neither branch is established. Stop. |

**Why P1-c uses a refreshed token.** On a re-consent, if Google returns no new refresh token, the save keeps the old one (`supabase/functions/youtube-oauth/index.ts:126-128`) while recording the new scopes (`:156`). If the kept refresh token could not mint tokens with the new scope, analytics would work until the first access token expired and then fail, sending the owner round the same reconnect again. Only a token minted from the stored refresh token proves the durable grant.

**What the probe records, and only this:** the part, the date, the HTTP status of each of the two Google requests, the token's effective scope list, and **one classification from a fixed list** — `ok`, `insufficient_permission`, `api_not_enabled`, `quota`, `unauthorized`, `unsupported_query`, `server_error`, `timeout`, `unrecognised`. On success it also records the column header names and the number of rows. **It records no Google message text, no response body, no channel name, no token and no numbers.** Fixtures are written by hand; nothing copied from a production response is committed or stored in `mem0`.

**What the probe writes:** nothing to YouTube. In Postora's database, at most what any token use writes: the refresh lease taken and released, and, if the token had to be refreshed, the token columns through the health-neutral store. No health column, no recorded grant.

**The scope question must be closed before any channel is enabled.** If P1 cannot be run before implementation, the code may be built with a provisional required set (all three existing scopes). But **no channel may be added to the rollout policy until** P1 has a recorded conclusion **and** the required-scope set on the deployed head equals it (plan §5, gate G-P1). If the conclusion differs from the provisional set, the constant is changed by a reviewed PR first.

### 7.3 True under both branches

- **The capability is derived from recorded scopes against one required set**, a constant in `supabase/functions/youtube-analytics/contracts.ts`, used only by that function. Its value is what P1 proved. The `youtube-resources` capability contract is **not** changed.
- **The public disclosure must change before any channel is enabled.** `src/pages/GoogleApiDisclosure.tsx` must list the scopes Postora really requests (it omits `youtube.force-ssl` today, `:85-87`, `:105`) and must stop saying Postora never reads YouTube Analytics (`:97-98`, `:107`). The two corrections are separate changes (plan step 6), because the first is true whatever happens to this feature. The privacy policy text in `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` and on `/privacy` needs the same sentence. The wording is the owner's to approve.
- **The YouTube Analytics API must be enabled** for the Google Cloud project.
- **Existing refresh tokens are expected to keep working.** No fetched page says that adding a scope to future consent requests invalidates stored tokens, but none says the opposite either, so this is **unverified**.

### 7.4 Branch B only: the consent gate (decision D7, still open)

This section applies only if P1 leads to branch B. Decision D7 has not been put to the owner, because it may never arise.

If the scope were simply added to the list in `handler.ts`, every new connection and every reconnect would ask for it from the moment `youtube-oauth` deploys, about two minutes after the merge. Neither analytics switch touches that. A user reconnecting only to publish would see the extra permission and, if Google has not yet approved the scope, the unverified-app screen. Switching analytics off would not undo it.

**Recommended design: the scope is requested only when a server-side consent gate says so.**

- A second private key, `youtube_analytics_stage5_consent`, absent by default, already covered by the policy of §5.2:

  ```json
  { "version": 1, "mode": "users", "user_ids": ["<auth.users.id>"] }
  ```

  `mode` is `off`, `users` or `all`. It is evaluated by one more service-only SQL function, `youtube_analytics_stage5_consent_admits(p_user_id)`, added by a **second small migration** in the branch B change. Absent, unreadable or malformed → **no**, and the connect flow proceeds with today's three scopes. A failure here must never block a connection.
- The authorise action adds the analytics scope only when the gate admits the signed-in user. Everyone else gets today's request, byte for byte.
- **Data rollout may not run ahead of consent.** While the consent gate is not `all`, the rollout policy must stay at `allowlist`, and every listed channel's owner must be in the consent gate's `user_ids`. Otherwise a user could be admitted to analytics, be told to reconnect and grant a permission, and find that the connect flow does not ask for it. This is enforced in SQL, not left to the runbook: under branch B the rollout state function reports `rollout_blocked_by_consent` (deny for everyone) when `mode` is `all` and the consent mode is not `all`; and an allow-listed account whose owner the consent gate does not admit is reported as not admitted.
- `mode: "all"` for consent is allowed only after Google has approved the scope for the app's audience (or the Cloud Console shows the scope needs no review). Opening data to everyone comes **after** that, as its own approval.
- Setting the gate back to `off` restores the previous consent request at the next click. Users who already granted the scope keep it harmlessly.
- The disclosure page lists the fourth scope from the moment the gate admits anyone.
- After the first pilot owner reconnects, the P1-c check is repeated on that account (a token minted from the stored refresh token must carry the scope) before the channel is added to the rollout policy.

**What cannot be gated.** Once a user has granted the scope, Postora holds it for that connection until the user disconnects or revokes it. And the app-level consequences of an unapproved sensitive scope in use (the 100-user cap counts users who saw the unverified screen) apply to the Google project as a whole. The gate keeps that number to the named pilot.

The alternatives the owner would be offered: **(B)** no analytics scope for anyone until Google has approved it, with branch B shipping as a later change; **(C)** the scope for everyone at deploy, which is not recommended.

## 8. Rollout

**Dark by default.** After the migration and the merge nothing changes for any user until the rollout policy is set.

| Switch | What it controls | Where | Default | Who may change it |
|---|---|---|---|---|
| **Rollout policy `youtube_analytics_stage5_rollout`** | **Access.** Whether the endpoint will call Google for a channel. | `app_settings`; hidden from non-admin sessions by the policy of §5.2; evaluated in SQL. | **Absent = off for every channel.** The migration does not seed it and asserts that it is absent. | Waleed only. |
| Visibility flag `feature_analytics_youtube` | **Visibility.** Whether the page and its links appear. | `app_settings`, browser-readable like every `feature_*` key (`supabase/migrations/20261029170000_media_upload_limits.sql:17-39`) | Off (code default; no row needed) | Waleed, in Admin → Feature Flags |
| Native connection with the required scopes | Whether a given channel qualifies | The account row | — | The channel's owner, by connecting |
| *Branch B only:* consent gate | Whether the consent screen asks for the analytics scope | `app_settings`, private by the same policy | Absent = off | Waleed only |

**The policy is the access switch.** The flag is read by the browser and enforced nowhere on the server. The moment the policy lists a channel, the endpoint serves that channel's owner, whether or not the flag is on. Therefore:

- approving the policy change **is** the go-live approval for that channel;
- turning the flag off hides the page and does **not** stop access; only the policy does;
- the flag-off, policy-on state is tested explicitly (§9.1).

The policy is evaluated in SQL at the start of every request, again when credentials are released, and again as the last step before a data response is written. Nothing is cached across requests. So a change takes effect at the next click in running instances; a request in flight has its result discarded if its final recheck sees the change; an open page hides or removes its reports within the bounds of §5.7. The few milliseconds after a final recheck are the stated residual.

**Order of enablement**, each step a separate approval by Waleed:

1. P1 (§7.2), before implementation if it can be run.
2. The production snapshot, then the migration, **before the merge** (plan §5).
3. The merge.
4. **Gate G-P1:** a recorded P1 conclusion, and the deployed required-scope set equal to it. Without it, step 5 does not happen.
5. The rollout policy with one named channel. **This is the go-live for that channel.**
6. The flag on, so the page is visible. Rehearsal R1 (§9.5).
7. The remaining pilot channels, by adding their IDs.
8. `mode: "all"`, only after both Google limits have been read in the Cloud Console, the two ceilings have been reviewed against them and against the existing features' observed peak (§5.6), and the disclosure text is live. Under branch B, also only after the consent gate is `all` (§7.4).

No capability is implied by a merge or by an earlier approval.

## 9. Testing

All automated evidence is offline: fake provider, synthetic accounts, disposable database, no public egress.

### 9.1 Deno

| Suite | Proves |
|---|---|
| `contracts.test.ts` | Every error code has a status and a page scope; metric keys, units, periods, limits, ceilings, the video-ID pattern and the single top-videos metric list match this document. |
| `window.test.ts` | The requested Pacific-time window for each period, across both daylight-saving changes and the year boundary; the end is three days back; a clock at 23:59 and at 00:01 Pacific. |
| `rollout.test.ts` | The adapter maps each SQL answer to the right code, and a failed call to `settings_unavailable`, never to "off". It contains no policy logic of its own. |
| `limits.test.ts` | Each limiter refuses when the counter call fails. **The shared budget is debited once before every Google call, including a repeat after `401` and a title lookup.** With one unit left: the first call is sent and the repeat is refused; a budget spent after the ownership lookup answers `capacity_reached` with no Analytics call; a budget spent before the title lookup returns the report without titles; a title lookup that does not happen is not debited. |
| `credentials.test.ts` | The bound store's `readAccount` calls the credentials function with the admitted channel and generation; when that returns nothing, the helper starts **no** token exchange. |
| `analyticsReadClient.test.ts` | Exact request URL and parameters per operation, built from structured parameters; `ids` from the admission answer. **Per-report validation:** a non-empty top-videos answer with string IDs is accepted; an ID that fails the pattern, a duplicate ID, a non-numeric or negative metric, a wrong row width, a header mismatch → `upstream_unavailable`; an explicit `null` cell → `value: null`; a daily answer missing its latest requested day and one missing a middle day are accepted with the right coverage and no filled-in rows; a day outside the window is rejected; missing `rows` → empty. Each error class; no provider text in any result; titles only for rows whose channel matches. |
| `handler.test.ts` (fake ports) | Unauthenticated; service role; unknown key including `user_id` and `channel_id`; malformed `video_id`; each admission answer; Composio; `needs_reauth`; recorded scopes without a required one; empty recorded scopes proceeds; the handler has no flag input at all; each limiter. **Every row of the provider-call table in §5.3, with the token, Data and Analytics counters and the number of budget debits all asserted**, including the three `401` cases that end in `reconnect_required` without a repeat. A successful ownership lookup with no owned video is `video_not_found`; a quota refusal, a timeout, a `5xx` and a malformed body in that lookup are each their own code. **Every response, success or refusal, carries `Cache-Control: no-store`.** No token in any response. |
| Binding races | With a fake store that changes the account between steps: disconnect, reconnect on the same row, and switch to Composio, each injected (a) after admission and before the credentials read, (b) after the credentials read and before a needed refresh, (c) during a token exchange, (d) at a forced refresh, (e) after the Analytics answer. Expected: (a), (b), (d) → `connection_changed` with **zero token-endpoint calls and zero YouTube calls after the change**; (c) → the exchange in flight completes, **nothing is stored**, `connection_changed`; (e) → `connection_changed` with the result discarded. A token refresh alone does not trip any check. |
| Revocation in flight | The policy is switched off while the provider call is pending → `not_enabled`, result discarded. A switch after the final recheck is delivered; the test documents that residual instead of pretending it away. |
| Audit bound | With **two handler instances** sharing one bucket: 30 refusals by one user in a minute write 20 rows in total. A request refused by the admission limiter writes no row and makes no second database call; 500 such requests produce 500 counter calls, zero rows and at most one console line per worker. Anonymous refusals write none. A successful data operation writes one `info` row with no numbers. No row contains a token, provider text or an unverified identifier. A failed insert leaves the response unchanged. |
| Health neutrality | After every failure path — `401`, `403` insufficient permission, `403` unknown, quota, `invalid_grant` on refresh — the fake store shows **no** write to `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`. A request with an expired token stores the refreshed token through the neutral store and writes nothing else. `dropGrantedScope` is never imported by the function. |
| Compatibility | The `youtube-resources` capability and handler suites, the `youtube-oauth` suite and the refresh-lease suite pass unchanged; none of those files is edited. |
| Composition | `index.ts` builds the real handler with real ports. |

### 9.2 SQL harness

A new suite, `supabase/tests/youtube_analytics_stage5_rollout.sql`, registered in `SUITES` in `scripts/db-harness.sh` (`:107`), run on the baseline plus every migration in the disposable database. Concurrency cases use two real sessions over `dblink`, the pattern of the Stage 4 suite.

| Area | Assertion |
|---|---|
| Old-code compatibility | With the migration applied and no new code: every existing suite stays green; `app_settings` reads and writes of every other key behave as before for `anon`, `authenticated`, an admin and the service role. |
| Privacy | With either key present, `anon` and a non-admin `authenticated` session read zero rows for it and cannot insert, update or delete it; an admin can; `service_role` can. The read allow-list is unchanged. |
| Privileges | `anon` and `authenticated` cannot execute any of the four functions; `service_role` can; each is `SECURITY DEFINER` with the pinned `search_path`. |
| Policy parsing | Absent → `rollout_missing`; not an object, wrong version, unknown mode, `account_ids` not an array, a non-UUID entry, 201 entries → `rollout_invalid`; `off`; `allowlist` listed and not listed; `all`. All non-`ok` states deny every account. An unreadable key raises. |
| Tenant isolation | Two owners; one owner with two accounts; crossed owner and account IDs; a foreign, a missing, an inactive and a non-YouTube account all return the identical "not found". An admin owner gets no bypass. |
| Binding | Credentials and `admits` refuse when the expected channel or generation differs; after a disconnect, a reactivation, a native re-consent, a switch to Composio and back, the generation has advanced and both refuse. After a trusted token refresh, with and without a rotated refresh token, both still accept. |
| No credential leak | `capability_status` never returns a token; the credentials function returns none on any refusal. |
| One snapshot | Session A evaluates while session B, in an open transaction, removes the account from the policy and reconnects it: A's answer is entirely "before" or entirely "after", never admitted-with-the-new-generation. |
| Seeding | Neither key exists after the migration. |

### 9.3 Vitest and Testing Library

Formatting (minutes to hours, seconds to minutes, zero and null); the gateway sends each request body in a shared fixture and maps each error code, with an unknown code falling back to `upstream_unavailable`; **switching account never shows the previous account's numbers, including while the new one loads**; one failing block does not hide the others; every state in §5.7 renders its own message and none renders as an empty report; subscribers gained and lost are separate and no net figure appears; the top-videos table has exactly the four metric columns of §5.5.

- **Connection revision.** Query keys contain the revision; no data query runs before `status` returns one; a `status` with a new revision removes the old revision's reports while the account stays "available" — tested with a reconnect that completes between two polls and **no data request in flight**; a data response with a different revision is dropped.
- **Access lease.** Reports are shown only within 90 seconds of a successful `status`; a failing, timed-out or `settings_unavailable` `status` hides them when the lease expires and a later success with the same revision shows them again; a tab that was hidden shows nothing until a check succeeds; going offline hides them at expiry; each account-scoped code removes them.
- **Video scope.** `video_not_found` changes the video panel only; channel reports stay, and no other request is cancelled.
- **No request the owner did not ask for.** With the real query client configuration: after a `quota_exceeded`, `capacity_reached`, `rate_limited`, `missing_scope` or `not_enabled` answer there is exactly one gateway call; a simulated network return causes none; unmounting and remounting the failed block causes none; pressing the retry control causes one.
- **Trend.** `trendSeries` yields one point per requested day with `null` for a day not returned; the rendered line is broken at that day; no zero appears; the note reads "did not return".

Also: Arabic and right-to-left; the route and sidebar entry follow the flag; `tests/architecture.test.ts` for the layering; the "View analytics" link appears only with the flag on. One shared request fixture is accepted by the Deno handler and sent by the Vitest gateway.

### 9.4 Journey with a fake provider

`scripts/stage5-e2e.mjs`, modelled on `scripts/stage4-e2e.mjs`, starts the disposable harness database **with the Stage 5 migration applied**, a local server (`e2e/fixtures/youtubeStage5Server.ts`) that composes the **real** `youtube-analytics` handler and the **real SQL functions** with a fake provider that counts requests separately for the token endpoint and the two YouTube hosts, and the app built with its real query client configuration. `e2e/youtube-stage5.spec.ts` runs in English and Arabic:

1. policy absent → "not switched on"; all provider counts are zero;
2. policy admits the channel → overview, trend and top videos appear; counts are 3 Analytics and 1 Data;
3. change the period → the period line and numbers change; counts rise by 3 and 1;
4. open an owned video → its cards and trend; counts rise by 2 and 2. Another channel's video ID in the URL shows "not available on this channel" **in the video panel while the channel reports stay on screen**; counts rise by 0 Analytics and 2 Data;
5. a channel with no data → the empty state, not an error;
6. a daily answer missing its last two days and one middle day → three breaks in the line, the last-returned-day line, and the "did not return" note;
7. the provider answers with a permission refusal → the reconnect notice, exactly one request per block, and the account row's health columns and recorded scopes are unchanged in the database;
8. the provider answers with a quota refusal → the quota message and exactly one request per block, also after the browser goes offline and online again;
9. the shared budget is exhausted → the capacity message and zero provider requests;
10. the policy is switched off while the page is open → the reports disappear at the next status check and "not switched on" shows; no further provider request;
11. the status endpoint is made to fail while the page is open → the reports are hidden at lease expiry with "Checking access…", and return when it recovers;
12. the channel is reconnected in a second tab with no request in flight → at the next status check the first tab removes the old reports and loads again under the new revision;
13. the channel is reconnected while a request is pending → "connection changed", no numbers shown;
14. switch to a second channel mid-load → nothing of the first channel is shown;
15. a second user with a channel not in the policy sees nothing of the first user's data;
16. with the flag off and the policy on, a direct call to the endpoint by the owner is served, and the page is not reachable.

The run fails on any unexpected external request. Playwright is not a CI job in this repository, so this is local evidence recorded in the PR with the command, head SHA and result, as in Stage 4.

### 9.5 What cannot be proven without a real channel

| Unknown | Settled by |
|---|---|
| Which scope set Google accepts for `reports.query`. | P1 (§7.2). |
| That the token information endpoint reports the scopes of an access token as assumed. | Google's documentation, read before P1 is approved; then P1 itself. |
| The real shape of a permission refusal. | P1-a, only if it happens to be refused. Otherwise **stays unverified**. |
| The real shapes of an exhausted quota, an API that is not enabled, and an expired token. | **Not rehearsed.** They stay unverified; the classifier treats what it does not recognise as a temporary failure, and the fixtures are written by hand. |
| Under branch B: that a re-consent leaves a refresh token able to mint analytics-capable tokens. | P1-c, and the repeat of it on the first pilot account. |
| That `channel==<ID>` behaves as documented for a Google account with more than one channel. | R1, if the pilot account has more than one; otherwise unverified. |
| How often recent days are not returned, and whether three days back is right. | R1: the last-returned-day line. |
| What a small channel gets when data is below Google's thresholds. | R1 on a small channel, if one is available. |
| The real daily limits of both Google APIs, and the existing features' daily peak. | The owner reads them in the Cloud Console. |
| That the numbers match YouTube Studio for the same Pacific-time range. | R1: the owner compares one period by eye. |

**Rehearsal R1**: read-only, the one pilot channel, after the first enablement, approved separately. It opens the page for each period and one video, and records **only what was actually observed**: which blocks loaded, the requested period and the last returned day, the provider request counts, and the owner's yes or no on the Studio comparison. It does not try to cause errors. It writes nothing to YouTube and records no numbers and no Google text.

## 10. Risks and open questions

| # | Risk or question | Handling |
|---|---|---|
| R-1 | The scope question is unresolved until P1, and P1 needs its own approval. | Two branches designed; the required set is one constant; **gate G-P1 blocks the first enablement** until the conclusion is recorded and deployed. |
| R-2 | Google's policy on derived metrics and stored data was not read word for word (§3.6). | The first release stores and derives nothing. Plan step 1 re-reads the page. |
| R-3 | The Analytics API has no documented error table, and most error shapes will stay unobserved. | Classify by status; unknown is a temporary failure, never a health change and never "not found"; hand-written fixtures. |
| R-4 | The limits of both Google APIs for this project are unknown, and the ceiling caps analytics without reserving quota for other features. | Per-attempt, fail-closed ceilings (§5.6); pilot by allowlist; `mode: "all"` only after the Console readings and the peak review. |
| R-5 | The migration adds a RESTRICTIVE policy to `app_settings`, a table every feature flag and setting lives in. A mistake in its expression could hide or block other keys. | The expression names two keys and nothing else; the SQL suite proves every other key behaves as before for every role; snapshot before applying; the same shape has been in production since Stage 4. |
| R-6 | The code is useless without the migration, and a merge deploys within two minutes. | Migration before merge (plan §5). If the functions are missing, every request answers `settings_unavailable` and nothing is sent to Google. |
| R-7 | The public disclosure page is already inaccurate and becomes more so. | Corrected in this delivery in two separate changes; live before any channel is enabled; the copy needs the owner's approval. |
| R-8 | Under branch B, Google verification may be required, and an ungated scope would change consent for everyone. | §7.4; decision D7, still open. |
| R-9 | Numbers will differ from the YouTube Channel page counters and from Studio's default local-time view. `views` changed meaning on 30 April 2025 and 16 November 2026. | The page states the source, the requested period, the last returned day and the Pacific time zone; one fixed footnote links to YouTube's explanation; the two sources are never mixed. |
| R-10 | A response whose final recheck passed just before a withdrawal is delivered; a report already read cannot be withdrawn. | Stated (§5.7). The audit row of each successful read lets an incident be scoped (plan §6). |
| R-11 | The access lease hides reports when the status check fails for 90 seconds, so a brief outage of the status call blanks a working page. | Accepted: hiding private numbers on doubt is the safer failure. Reports return without a new Google call when the check recovers. |
| R-12 | The verification guide says the consent screen is in "Testing". If still true, only test users can connect. | Not checked; the owner confirms in the Cloud Console before the pilot. |
| R-13 | A refresh in flight can store a token on a row that a browser-side disconnect has just deactivated. | Existing behaviour of the shared helper for every caller (§5.4); not changed here; the report is discarded. |

## 11. Decided, and still open

### Decided by the owner

| # | Question | Decision |
|---|---|---|
| D1 | Which Google permission? | **Probe first.** Add `yt-analytics.readonly` only if a positive test shows it is needed. The probe is a gated step with its own approval when run. |
| D2 | Store, or read on demand? | **Read on demand, store nothing.** |
| D3 | First release content | **Channel overview cards, daily trend, top ten videos, and the same cards and trend for one video.** |
| D4 | Periods | **7, 14, 30, 90 days.** |
| D5 | Where the page is | **Analytics menu at `/analytics/youtube`, plus a "View analytics" link from each video on the YouTube Channel page.** |
| D6 | How the per-channel switch is protected | **As in Stage 4: a small migration with a policy that hides the key and SQL functions that evaluate it; no table.** This was not the option this document first recommended. It is now the design (§5.2), and it also carries the binding checks. |
| D8 | Shared allowance | **Ceilings of 1,000 Data API units and 2,000 Analytics requests a day for all users, reviewed against the real limits before opening to everyone.** |
| D9 | CI registration | **Recorded exception:** the test step and the SQL suite are registered in the product PR, with the measurements of plan §4. |

Also settled: the merge needs the owner's card; the migration is applied before the merge, after a production snapshot.

### Still open

| # | Question | When it must be answered | Recommendation |
|---|---|---|---|
| **D7** | If P1 shows the analytics permission is needed: when does the consent screen start asking for it? Options: **A.** only for users named in a private server-side gate, then for everyone once Google has approved it (§7.4); **B.** for nobody until Google has approved it; **C.** for everyone at deploy. | Only if P1 leads to branch B, and before any branch B code is written. | A |
| **P1 approvals** | Each part of the probe (P1-a, and P1-b or P1-c if they arise) is a real request to Google on the owner's channel, plus one token-information request. | When each part is about to be run. | Run P1-a before implementation starts. |

Recorded assumptions, not owner decisions, unless the owner objects: native connections only; no revenue; no agent, n8n or MCP access; no comparison with the previous period until the Google policy has been read in full.

## 12. Verification performed for this document

- Baseline: `main` at `f7d49921`. `git diff --stat 44b426cc f7d49921` over `supabase`, `src`, `scripts` and `.github` is empty: the commits since the Stage 4 merge are documents only, so every code citation holds at `f7d49921`. The manager confirmed on 2026-11-24 that the Stage 4 migration is applied in production and that a real token refresh succeeded through the health-neutral store; this document did not check production.
- Read through `git show` for this revision, in addition to the earlier list: the Stage 4 migration's policy, state reader, capability status, evaluator, grants, closing assertions and neutral store (`:196-276`, `:722-742`, `:745-1082`, `:1895-1907`, `:2095-2150`); `_shared/youtubeTokenRefresh.ts` in full for the refresh path (`:120-166`, `:600-935`); `youtube-oauth/index.ts:96-160`; `comment-manager/stage4/handler.ts:183-200`; `supabase/manual-sql/20260627213616_rate_limit_buckets.sql` (signature and locking); `SavedAnalyticsReport.tsx:66-73`; `package.json:52`; the lease trigger in `20261120130000_youtube_refresh_lease_fixes.sql:377-421`.
- Earlier list, unchanged: `ARCHITECTURE.md` §§12–17, 22–28, 37–38; the Stage 2 specification; the Stage 4 specification and plan; `youtube-oauth/handler.ts`; `_shared/youtubeGrantedScopes.ts`, `_shared/youtubeCommentCapability.ts`, `_shared/rate-limiter.ts`; `youtube-resources/capabilities.ts`, `contracts.ts`, handler and index wiring; `comment-manager/stage4/rollout.ts`, `audit.ts`, `rateLimit.ts`; `scripts/stage4-e2e.mjs`; `.github/workflows/ci.yml` step list; `src/App.tsx`; `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`; `src/pages/GoogleApiDisclosure.tsx`; the analytics contract, schema, calendar, gateway, flags, routes and sidebar lines of §2.2.
- The Meta pipeline was mapped in one research pass; its line numbers for the collection, retention, cron and readiness files were not individually re-read.
- Google pages fetched on 2026-11-23 are the ones linked in §3 and §7. None was re-fetched for either review round.
- **Not verified:** everything marked [S]; Google's token information endpoint (no page fetched); the sensitivity class of either scope; both Google APIs' real daily limits; the Analytics error shapes; whether a scope-limited consent yields a scope-limited token; whether a re-consent returns a new refresh token; the exact TanStack Query option names for the installed version; whether `check_rate_limit` behaves in production as assumed; production state other than what the manager reported.
- Not done, by instruction: code, migration, branch, commit, PR, production access, any call to a Google API.

## 13. Review round 1

Pull request #472 (documents only) received 33 automated comments from two reviewers. They reduced to 23 distinct findings, all judged real; one style note was not adopted. Section numbers below are those of this revision.

| # | Finding | Verdict | Where it is answered now |
|---|---|---|---|
| F1 | The scope probe read recorded grants and its outcomes proved neither branch | Real | §7.2 (further corrected in round 2) |
| F2 | The probe exported raw Google error text | Real | §7.2 fixed classification list |
| F3 | Branch B changed consent for everyone at deploy | Real | §7.4 |
| F4 | Token refresh and provider reads not bound to the admitted connection | Real | §5.2, §5.4 (redesigned in round 2) |
| F5 | The ownership lookup ran before a usable token existed | Real | §5.3 steps 8–9 |
| F6 | Any lookup failure was classified as a missing video | Real | §5.3 step 9 |
| F7 | Row validation rejected string video IDs | Real | §5.3 row validation |
| F8 | The video filter accepted an unbounded string | Real | §5.3 pattern |
| F9 | Per-user limits do not protect the shared Google quota | Real | §5.6 |
| F10 | Switching the rollout off did not clear loaded reports | Real | §5.7 (strengthened in round 2) |
| F11 | Three different top-videos metric sets | Real | §5.5 |
| F12 | The requested end date was presented as coverage | Real | §5.8 |
| F13 | The browser retries once by default | Real | §5.7 |
| F14 | Signed-in refusals could write unbounded audit rows | Real | §6 rule 7 |
| F15 | The visibility flag does not gate provider access | Real | §8 |
| F16 | The merge gate omitted the owner's card | Real | Plan §1 |
| F17 | Refusal tests demanded impossible provider counts | Real | §5.3 provider-call table |
| F18 | The rehearsal could not observe the listed error shapes | Real | §9.5 |
| F19 | The CI rule was declared "not triggered" | Real | Decision D9; plan §4 |
| F20 | The disclosure rollback did not match runtime behaviour | Real | Plan §6 |
| F21 | The denied-effects gate forbade the existing token store | Real | §6 rule 6 |
| F22 | Acceptance assumed options the owner might not pick | Settled by the decisions of §11 | Plan §7 |
| F23 | Release steps used a flag one page option removed | Settled by decision D5 | Plan §5 |

## 14. Review round 2

A second automated review of the revised documents left 21 comments (GitHub issue #473): 8 marked HIGH, 13 MEDIUM. Two are the same finding, giving 20 distinct findings. The owner's decisions arrived in the same round. Verdicts are this document's.

| # | Finding (reviewer's label) | Verdict | What changed |
|---|---|---|---|
| G1 | P1 cannot observe the token's effective scopes through a health-neutral refresh (HIGH) | **Real.** Confirmed at `youtubeTokenRefresh.ts:906` and `:765-771`. | §7.2: the probe keeps health-neutral mode and reads the scopes of the exact token from Google's token information endpoint; inconclusive if that fails; its possible writes are listed. |
| G2 | If P1 cannot run, nothing stops the pilot starting with the scope unresolved (HIGH) | **Real** | §7.2 last paragraph; §8 step 4; plan §5 gate G-P1 and acceptance gate. |
| G3 | On branch B, broad rollout came before broad consent (HIGH) | **Real** | §7.4: data rollout may not run ahead of consent, enforced in SQL; §8 step 8; plan step 7 and §5. |
| G4 | Budget admission was per operation, not per attempt (HIGH) | **Real** | §5.6: one debit immediately before every Google call, including repeats and title lookups, with the answer for a mid-request refusal; §5.3 steps 9, 10, 12; `limits.test.ts`. |
| G5 | The binding was checked after the helper could already have refreshed a replacement connection (HIGH) | **Real.** Confirmed at `youtubeTokenRefresh.ts:712-718` and `:786-792`. | §5.2 credentials function; §5.4 bound store: the helper's own credential read requires the admitted generation, so no exchange starts for a replacement. The in-flight case is separated and its result is not stored. Race tests (a)–(e). |
| G6 | Cached reports were not tied to the connection generation (HIGH), and `status` could not reveal a binding change (MEDIUM) | **Real** (one finding, two comments) | `connection_revision` in `status` and in every data response; in every query key; old revision purged (§5.3, §5.7). |
| G7 | A failed status check left private reports visible (HIGH) | **Real** | §5.7 access lease: reports are shown only within 90 seconds of a successful check; hidden tabs and offline devices show nothing until revalidated. |
| G8 | A pilot token's historical grants could become mandatory for every channel (HIGH) | **Real.** `handler.ts:426` sets `include_granted_scopes`. | §7.2: P1-a counts only if the effective scopes are within the three the connect flow requests; P1-c only if the difference is exactly the analytics scope. |
| G9 | CI timing compared non-equivalent run cohorts (MEDIUM) | **Real** | Plan §4: the rule's own measurement — five comparable first-attempt code PR runs before and after, main and reruns kept apart, runner minutes, failures and retries, an owner and a due date, a two-week report. |
| G10 | The journey required a capacity state that option D8-B removes (MEDIUM) | **Settled by decision D8.** The option no longer exists. | Alternatives removed from tests, gates and release steps. |
| G11 | The first `401` that may not be retried had no outcome (MEDIUM) | **Real** | §5.3 "The `401` rule"; three new rows in the provider-call table. |
| G12 | Containment promised more than the final recheck can guarantee (MEDIUM) | **Real** | The final recheck is the last step before the response; §5.7 table states the residual; plan §6. |
| G13 | Private responses lacked a no-store requirement (MEDIUM) | **Real** | `Cache-Control: no-store` on every response (§5.3, §6 rule 9); asserted in the handler test and on the deployed route (plan §5). |
| G14 | Turning off retry does not turn off automatic refetch (MEDIUM) | **Real** | §5.7 "No request the owner did not ask for"; tests for network return and remount. |
| G15 | A Stage 5 cap does not prevent shared-quota exhaustion (MEDIUM) | **Real as a wording fault.** The design is unchanged and decision D8 stands. | §5.6 now says the ceiling limits Stage 5's contribution and guarantees nothing to other features; the review before `all` includes their observed peak. |
| G16 | A video "not found" revoked account-wide report access (MEDIUM) | **Real** | New code `video_not_found`, scoped to the video panel; error table has a page-scope column. |
| G17 | Missing daily rows were treated as proof of unpublished data, and sparse rows would be joined by the chart (MEDIUM) | **Real.** Confirmed at `SavedAnalyticsReport.tsx:69-71`. | §5.8: the note says only that Google did not return the days; chart-only `null` points break the line. |
| G18 | Stage 4's audit tally cannot count across workers (MEDIUM) | **Real.** Confirmed at `stage4/audit.ts:38`. | §6 rule 7: the row bound is exact through a shared bucket; the suppressed count is declared best effort; tested with two handler instances. |
| G19 | Admission refusals could still trigger unbounded audit work (MEDIUM) | **Real** | §6 rule 7: an admission refusal is a terminal path with no audit row and no second database call. |
| G20 | A reconnect can leave the old refresh grant in place (MEDIUM) | **Real, branch B only.** Confirmed at `youtube-oauth/index.ts:126-128`. Whether Google returns a new refresh token is unverified. | §7.2: P1-c must use a token minted from the stored refresh token; §7.4: repeated on the first pilot account before it is enabled. |

**Did moving the evaluation into SQL answer some of these?** Yes, three. G5: the credential read and the admission decision are now one statement with the expected generation, and the refresh helper reads through it. G12, in part: admission and binding are rechecked together, from one snapshot, as the last step. G3: the consent-before-data rule is a condition inside the state function, not a line in a runbook. It did not help with G6 and G7, which are about what the browser already holds, or with G4, which is about when a counter is debited.
