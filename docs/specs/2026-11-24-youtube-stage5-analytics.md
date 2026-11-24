# YouTube Stage 5 — YouTube Analytics reports (specification)

24 November 2026 · proposal for owner review, nothing implemented · proposed tier **Heavy** (reason in the plan) · [Implementation and acceptance plan](../plans/2026-11-24-youtube-stage5-analytics.md)

Code baseline: `main` at `44b426cc`, the Stage 4 merge (PR #471). Its tree is identical to the Stage 4 head `7b8fe42b` at which every path and line number below was first read with `git show`, so the citations hold unchanged. Stage 5 depends on two things Stage 4 created in `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql`: the health-neutral token store (`store_youtube_refreshed_token_with_lease_neutral`) and the `social_accounts.binding_generation` counter. The manager reports that this migration is applied in production; this document did not check production.

Revised after review round 1 on pull request #472; the findings and what changed are in §13.

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

### 2.1 YouTube, after Stage 4

| Fact | Evidence at `44b426cc` |
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
| Most viewed videos, metrics | A documented sample uses `metrics=estimatedMinutesWatched,views,likes,subscribersGained` with `dimensions=video`. **This is the one metric list the first release uses** (§5.4). | [V] | [Sample requests](https://developers.google.com/youtube/analytics/sample-requests) |
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
| How many IDs one `videos.list` call accepts is not stated on the fetched page. | — | Not stated. The design asks for at most 10 and degrades if refused (§5.4). |
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

The recommended design stores nothing and derives nothing, so it complies under either reading of the unverified rules.

## 4. Proposed scope

### 4.1 Recommended first release

One page, "YouTube analytics", for one selected channel and one selected period.

| Block | What the owner sees | Provider requests |
|---|---|---|
| Header | Channel picker, period picker (last 7, 14, 30 or 90 days), a Refresh button, and two lines: "Period: <start> – <end>, Pacific time" (the dates Postora asked for) and "YouTube has published daily numbers through <date>" (the last day Google actually returned, §5.7). | none |
| Overview cards | Views · Watch time · Average view duration · Subscribers gained · Subscribers lost · Likes · Comments · Shares, each the total for the period, exactly as YouTube returns it. | 1 Analytics request |
| Daily trend | One line chart with a metric switch: views, watch time, subscribers gained, subscribers lost. One point per day Google returned; a day Google did not return is a gap in the line, never a zero. | 1 Analytics request |
| Most viewed videos | The ten most viewed videos of the period: title, views, watch time, likes, subscribers gained. One fixed metric set (§5.4). | 1 Analytics request + 1 Data API request for titles |
| One video | Clicking a video (here, or "View analytics" on the YouTube Channel page) shows the same overview cards and daily trend filtered to that video. Subscriber cards carry a note that, for one video, YouTube counts only subscriptions from the video's watch page. | 2 Analytics requests + 2 Data API requests (each of the two reads confirms the video's ownership itself) |

Fixed rules for the first release:

- **Periods** are whole days ending three days before today in Pacific time. That is the period Postora *asks for*. It is not a promise about what Google has finished processing; the page shows the two separately (§5.7).
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
| More columns in the top-videos table | Average view duration and comments per video. | Only after Google's rule for the video report has been read word for word (§3.2, §5.4). |
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
| The fail-closed limiter and the bounded refusal audit that Stage 4 introduced (§5.5, §6). | |

**Alternative: collect into tables** (decision D2). It would need `yt_*` tables with RLS and no browser grants, a daily cron job per channel, a retention job, a new SQL metric validator, a decision on the policy in §3.6, and either a second contract or a new version of the shared one. It is the right design only if the owner wants history that outlives a query, exports, or cross-platform summaries. It can be added later without changing the first release's page.

### 5.2 Edge function

One new function, `supabase/functions/youtube-analytics/`. It is not added to `youtube-resources`, whose handler already carries browse, categories and edit; analytics is a different job with a different provider host (ARCHITECTURE §13: no unrelated workflows in one handler).

| File | Responsibility |
|---|---|
| `contracts.ts` | The single contract: operations, response types, error codes with HTTP status, metric keys and units, the one top-videos metric list, the video-ID pattern, periods, limits, budgets. Runtime-neutral, so the frontend imports its types from it (the Stage 2 pattern). |
| `window.ts` | Pure: turns "last N days" and a clock into the requested `startDate` and `endDate` in Pacific time, ending three days back. |
| `rollout.ts` | Pure parser of the rollout policy, plus the port that reads it. Fails closed. |
| `capability.ts` | Pure availability rule: connection type, connection health, recorded scopes. |
| `limits.ts` | The three limiters of §5.5, all on the `check_rate_limit` function and all failing closed, following `supabase/functions/comment-manager/stage4/rateLimit.ts`. |
| `analyticsReadClient.ts` | Typed calls to `youtubeanalytics.googleapis.com` and the two `videos.list` uses (ownership, titles). Timeout, per-report row validation, stable error mapping. Never touches the database. |
| `audit.ts` | Bounded audit rows (§6, rule 7). |
| `handler.ts` | `createYouTubeAnalyticsHandler(ports)`: CORS, method, authentication, validation, ownership, gate, capability, limits, binding rechecks, use case, response mapping. All I/O behind ports. |
| `index.ts` | Builds the ports and serves the handler. No business rule (ARCHITECTURE §12). |

`POST /functions/v1/youtube-analytics`, JSON body discriminated on `operation`, every schema strict:

| Operation | Input | Provider calls on success | Result |
|---|---|---|---|
| `status` | `account_id` | none | Whether analytics is available for this account, and if not, one reason: `not_enabled`, `provider_unsupported`, `reconnect_required`, `missing_scope`. Also the policy numbers (periods, limits). The page renders from this. |
| `summary` | `account_id`, `period_days` (7, 14, 30, 90), optional `video_id` | 1 Analytics (+1 Data when `video_id` is present) | One value per metric for the requested period. |
| `daily` | same | 1 Analytics (+1 Data when `video_id` is present) | One row per day Google returned, four metrics, plus the observed coverage (§5.7). |
| `top_videos` | `account_id`, `period_days` | 1 Analytics + 1 Data | Up to ten rows with video ID, title, link and the four metrics of §5.4. |

`video_id` must match `^[A-Za-z0-9_-]{6,64}$`, the pattern `youtube-resources` already uses (`supabase/functions/youtube-resources/handler.ts:101`). The same pattern is applied to every video ID Google returns before it is used in a title lookup or a link. Every Google request is built with structured URL parameters, never by joining strings, so an ID can never add a second filter or a second list item.

Success envelope, the same shape as `youtube-resources` (`contracts.ts:73-78`) plus the requested window:

```ts
interface YouTubeAnalyticsSuccess<T> {
  schema_version: 1;
  request_id: string;
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
  rows: Array<{ day: string; metrics: YouTubeAnalyticsMetric[] }>;
  coverage: {                   // what Google actually returned
    first_day: string | null;   // null when no row came back
    last_day: string | null;
    days_returned: number;
  };
}
```

`requested_window` never claims coverage. Only `daily.coverage` does, and only from rows Google sent.

#### Checks, in this order, on every request

1. **Caller.** A user JWT, validated the way `youtube-resources` does it. A service-role bearer is refused.
2. **Admission limit** for that user, covering every operation including `status` (§5.5). It runs before any database read of accounts or settings.
3. **Validation.** Strict schema. A body with `user_id`, `channel_id` or any unknown key fails; so does a `video_id` that does not match the pattern.
4. **Account.** One service-role read filtered on `id`, `user_id = caller`, `platform = 'youtube'`, `is_active = true`, returning `platform_user_id`, `auth_provider`, `needs_reauth`, recorded scopes and **`binding_generation`**. No row is `not_found`, identical for a foreign, missing, inactive or non-YouTube account. A failed read is `internal_error`, never "not found". The channel ID and the generation read here are the **admitted binding**.
5. **Gate.** The rollout policy admits this account (§8). Not admitted is `not_enabled`. A policy that cannot be read is `settings_unavailable`, never a quiet "off".
6. **Capability.** Composio is `provider_unsupported`. `needs_reauth`, or no token at all, is `reconnect_required`. A recorded scope list that lacks a required scope is `missing_scope`. An empty recorded list proceeds and lets Google decide (Stage 2, D5).
   `status` ends here.
7. **Data limits**: the per-user data limit, then the shared daily budget for each Google API the operation will use (§5.5).
8. **Token.** Through `refreshYouTubeAccountToken` in health-neutral mode. A refusal is `reconnect_required` or `upstream_unavailable` in the response only (§5.3). No provider call has happened yet.
9. **Binding recheck 1.** The account is read again with the same owner filter. If it is gone, inactive, no longer native, or its `binding_generation` or channel differs from the admitted binding, the answer is `connection_changed` and nothing is sent to Google. (Why this is enough: see "Why the rechecks bind the token" below.)
10. **Video ownership**, only when `video_id` is present: `videos.list?part=snippet&id=<video>` with the token from step 8, 15-second timeout.
    - A valid `200` that contains that ID with `snippet.channelId` equal to the admitted channel → continue.
    - A valid `200` without such an item → `not_found`, identical for a missing video and another channel's video. **This is the only path to `not_found` for a video.**
    - `401`, when the token was not minted by this request → one forced refresh, binding recheck, one repeat. A second `401` → `reconnect_required`.
    - A quota refusal → `quota_exceeded`. An insufficient-permission refusal → `missing_scope`. A timeout, a network failure, a `5xx`, an unrecognised error or a malformed body → `upstream_unavailable`.
    - After any outcome other than "continue", **no Analytics request is made**.
11. **One Analytics request**, 15-second timeout, `ids=channel==<the admitted channel ID>`. The channel ID comes from the account row, never from the browser. On `401`, when the token was not minted by this request: one forced refresh, binding recheck, one repeat. These are reads, so the repeat cannot duplicate anything. A request makes at most one forced refresh in total, whichever call triggered it.
12. **Validate the answer** by report (table below). Anything that does not fit is `upstream_unavailable`.
13. **Titles** (`top_videos` only), §5.4.
14. **Binding recheck 2 and gate recheck.** Before any number is returned, the account binding is checked again as in step 9 and the rollout policy is evaluated again. A changed binding is `connection_changed`; a policy that no longer admits the account is `not_enabled`. In both cases **the provider result is discarded** and never reaches the browser.

**Why the rechecks bind the token.** The refresh helper reads credentials by account ID alone (`supabase/functions/_shared/youtubeTokenRefresh.ts:440-449`, `:706-718`). A disconnect or a reconnect on the same row could therefore hand back a token from a different connection. Stage 4 added `social_accounts.binding_generation` (`supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql:361`): a counter that a trigger advances on every disconnect, reactivation, re-consent or provider switch, never decreases, and keeps unchanged only for the trusted token-refresh functions (`docs/specs/2026-11-22-youtube-stage4-comments.md`, §6.2). So if the generation read at step 9 equals the one read at step 4, no rebinding happened in between, and the token obtained between those two reads belongs to the admitted connection. The same argument covers a forced refresh and the final recheck.

#### Row validation, per report

| Report | Column headers must be exactly | Each row | Other rules |
|---|---|---|---|
| `summary` | the eight metric names, in the requested order | At most one row. Eight cells. Each a finite number ≥ 0, or an explicit JSON `null`. | No `rows` → every metric is `null` and the block shows "no numbers". |
| `daily` | `day`, then the four metric names | `day` is a `YYYY-MM-DD` calendar date inside the requested window, with no duplicates. Four metric cells as above. | No `rows` → empty series, `coverage.days_returned = 0`. A day missing from the answer is simply absent; nothing is filled in. |
| `top_videos` | `video`, then the four metric names of §5.4 | `video` is a **string** matching the video-ID pattern, with no duplicates. Four metric cells as above. At most ten rows. | No `rows` → empty list. |

A row with the wrong number of cells, a non-numeric metric, a negative number, a malformed date, a date outside the window or an ID that fails the pattern makes the whole answer `upstream_unavailable`. An explicit `null` cell becomes `value: null` and is shown as "—". A missing cell is never turned into `null` or zero.

#### Error codes

Each has a fixed HTTP status and fixed English and Arabic copy. The response never carries Google's text.

| Code | HTTP | When |
|---|---|---|
| `invalid_request` | 400 | Not JSON, fails the schema, unknown key, unsupported period, malformed `video_id`. |
| `unauthorized` | 401 | Missing, invalid or service-role bearer. |
| `not_enabled` | 403 | The rollout policy does not admit this account, at step 5 or at step 14. |
| `missing_scope` | 403 | The recorded scopes lack a required one, or Google refuses for insufficient permission. |
| `not_found` | 404 | Account not owned, not YouTube, inactive or absent; or a **successful** ownership lookup found no owned video. |
| `method_not_allowed` | 405 | Anything other than `POST` and `OPTIONS`. |
| `provider_unsupported` | 409 | The caller's own account is Composio-managed. |
| `reconnect_required` | 409 | `needs_reauth`, no refresh token, or a second `401`. |
| `connection_changed` | 409 | The channel was disconnected or reconnected while the request was running. |
| `rate_limited` | 429 | Postora's own per-user limits; carries `retry_after_seconds`. |
| `capacity_reached` | 429 | Postora's shared daily budget for a Google API is spent (§5.5). |
| `quota_exceeded` | 429 | Google refuses for quota. |
| `settings_unavailable` | 503 | The rollout policy or a limit counter could not be read. |
| `upstream_unavailable` | 502 | Timeout, network failure, Google `5xx`, an unrecognised Google error (including `The query is not supported` and "API not enabled"), or an answer that fails validation. |
| `internal_error` | 500 | A database read failed or an unexpected exception. |

#### Provider calls each outcome must show

| Outcome | Data API calls | Analytics calls |
|---|---|---|
| Any refusal at steps 1–9 (caller, limits, validation, account, gate, capability, token, binding) | 0 | 0 |
| `status`, any answer | 0 | 0 |
| Ownership lookup succeeds, video not owned or absent | 1 | 0 |
| Ownership lookup fails (quota, permission, timeout, `5xx`, malformed) | 1 | 0 |
| Ownership lookup `401`, then success | 2 | 1 |
| Ownership lookup `401` twice | 2 | 0 |
| `summary` or `daily` success, no video | 0 | 1 |
| `summary` or `daily` success, with video | 1 | 1 |
| Analytics refusal (quota, permission, unsupported query, `5xx`) | 0 or 1 | 1 |
| Analytics `401`, then success | 0 or 1 | 2 |
| Analytics `401` twice | 0 or 1 | 2 |
| `top_videos` success | 1 | 1 |
| `top_videos`, title lookup fails | 1 | 1 |
| `top_videos`, no rows | 0 | 1 |

### 5.3 What the refresh path may and may not change

Analytics is an optional read. A problem with it must never break publishing or comments.

- The function refreshes tokens only through the existing lease helper, in health-neutral mode (`supabase/functions/_shared/youtubeTokenRefresh.ts:145-152`). A refreshed access token is stored under the lease, as every other caller does. The store it uses, `store_youtube_refreshed_token_with_lease_neutral`, is one of the three trusted refresh functions, so a refresh does not advance `binding_generation`.
- It **never** sets `needs_reauth`, changes `failure_count` or `last_refresh_error`, or edits `account_metadata.granted_scopes`.
- It **never** calls `dropGrantedScope`. A `403` from either Google API is shown to the owner and nothing is written. Otherwise a late refusal could remove a grant that publishing or comments rely on (the race Stage 4 recorded as its finding F7).

### 5.4 The top-videos report: one metric list, and titles

**One definition, used by the query, the validator, the fixtures and the table:**

```text
dimensions = video
metrics    = estimatedMinutesWatched,views,likes,subscribersGained     (this order)
sort       = -views
maxResults = 10
```

This is the documented sample, read word for word (§3.2). There is no wider set and no fallback in the first release. `averageViewDuration` and `comments` per video are a later option, to be added only after the report rule has been read on Google's page; until then they are not requested, not validated and not shown. The table columns are: title · views · watch time · likes · subscribers gained (with the watch-page note of §4.1).

**Titles.** The Analytics API returns video IDs only. Titles come from one `videos.list?part=snippet&id=<up to 10 validated IDs>` call. A row is given a title only when Google returns that ID with `snippet.channelId` equal to the admitted channel. A row without a match is shown as "Video unavailable" with its numbers; Google states that deleted items stay in totals but not in per-video rows ([Data model](https://developers.google.com/youtube/analytics/data_model), [V]). If the title call fails for any reason, the list is still returned with IDs and a `titles: "unavailable"` marker; the numbers are not withheld and the failure is not reported as a missing video.

### 5.5 Caching, limits and the shared Google quota

**Caching.**

- **Server: no cache.** Workers are short-lived, and a database cache is stored YouTube data (§5.1).
- **Browser: React Query, memory only.** `staleTime` 30 minutes for the three data operations. No refetch on focus, no interval for data. **`retry: false` on every Stage 5 query.** The application default is one automatic retry (`src/App.tsx:27`), which would send a second request after a quota, permission or rate-limit refusal; Stage 5 turns it off, and a retry happens only when the owner presses the retry control on a temporary failure. Every query key contains user, account, period and video, and no query shows data from a previous key, so switching channel can never display the previous channel's numbers. Refresh invalidates the selected account's queries and spends quota.

**Three limiters.** All use the existing `check_rate_limit` database function and all **fail closed**: if the counter cannot be read, the request is refused (`settings_unavailable`), following Stage 4's limiter (`supabase/functions/comment-manager/stage4/rateLimit.ts`) and not the shared helper, which lets traffic through when its database call fails (`supabase/functions/_shared/rate-limiter.ts:40-49`).

| Limiter | Applies to | Limit | Purpose |
|---|---|---|---|
| Admission, per user | Every operation, including `status`, before any other database work | 120 requests per minute | Bounds database reads and audit writes that a signed-in user can cause. |
| Data, per user | `summary`, `daily`, `top_videos` | 60 per 10 minutes and 300 per day | Bounds one user's share. |
| **Shared daily budget, whole project** | Every Google request Stage 5 would send, counted per API before it is sent | **Data API: 1,000 units a day. Analytics API: 2,000 requests a day.** Both provisional (decision D8). | **This, not the per-user limit, is what protects the shared Google quota.** |

Why the per-user limit is not enough: the Data API allowance is one pool of 10,000 units a day for the whole Google project by default (§3.4), shared with the comment poller, browse, video edits and comment writes. Seventeen users at 600 Data-backed operations each would exhaust it. The shared budget caps Stage 5's total draw at one tenth of the default pool whatever the number of users. When it is spent, data operations answer `capacity_reached` until the window ends; publishing and comments are not affected, because they do not use this counter.

The budget is **not** a reservation enforced on other features: nothing stops the comment poller from spending the rest. It only guarantees that analytics cannot be the cause of exhaustion. Whether `check_rate_limit` exists in production with the behaviour assumed here was confirmed for Stage 2 according to that stage's rollout notes but was **not** re-checked for this document; plan step 0 confirms it read-only.

**Honest quota errors.** A Google quota refusal is `quota_exceeded`; nothing is retried, on the server or in the browser.

**The numbers are provisional.** The Analytics API's daily limit is not published (§3.4). The owner reads both real limits in the Cloud Console before the feature is opened beyond the pilot, and the two budgets are then set as a deliberate share of them (decision D8).

### 5.6 Frontend

```text
src/features/youtube-analytics/
├── domain/          types.ts (re-exports contracts.ts), errors.ts, format.ts (minutes → h m, seconds → m:ss)
├── application/     ports.ts, queryKeys.ts, useYouTubeAnalyticsStatus.ts, useYouTubeAnalyticsSummary.ts,
│                    useYouTubeAnalyticsDaily.ts, useYouTubeTopVideos.ts, useAnalyticsRevocation.ts
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

**When access is withdrawn while the page is open.** Switching the rollout off stops new requests at the server at once (§8). It cannot by itself remove numbers a browser already holds. The page therefore does this:

1. While the page is visible it asks `status` again every 60 seconds. `status` calls no provider and spends no Google quota.
2. When `status`, or any data operation, answers `not_enabled`, `not_found`, `reconnect_required`, `connection_changed`, `provider_unsupported` or `missing_scope`, the page **removes every cached report for that account from memory**, cancels requests still in flight for it, and shows the matching state. A response that arrives afterwards for that account is dropped.
3. The server discards a result whose request was admitted before the switch but finished after it (§5.2, step 14).

So the bound is: a report already on screen can stay visible for up to about 60 seconds after the switch, and no new or in-flight report is delivered. Numbers a person has already read cannot be taken back; handling that is an incident step, not a product feature (plan §6).

States, each distinct, none rendered as an empty report:

| State | Shown |
|---|---|
| Loading | Skeletons per block. Blocks load independently; one failing block does not hide the others. |
| No YouTube channel | Empty state with a link to Profiles. |
| Not enabled | "YouTube analytics is not switched on for this channel yet." No reconnect prompt: reconnecting cannot change rollout. |
| Managed connection | "This channel is connected through the managed connector, which does not provide analytics." |
| Reconnect needed | "Reconnect this channel on Profiles", linking to `/profiles`. |
| Permission missing | "Reconnect this channel and allow access to YouTube analytics", linking to `/profiles`. |
| Connection changed | "This channel was reconnected or disconnected. Reload to continue." |
| Empty | "YouTube has no numbers for this period yet." Typical for a new channel or new video. |
| Incomplete period | The trend shows gaps, and a note says: "YouTube has not published <n> day(s) of this period yet, so the totals above may still change." |
| Google quota | "YouTube's daily limit was reached. Try again tomorrow." No automatic retry. |
| Postora capacity | "Analytics is busy today. Try again tomorrow." No automatic retry. |
| Rate limited | "Too many requests. Try again in N minutes." No automatic retry. |
| Temporary failure | "YouTube analytics could not be loaded", with a retry control and the request reference. |
| Video unavailable | A top-video row whose title could not be confirmed. |

English is inline; Arabic is added under a `youtube` group in `src/i18n/locales/ar/analytics.json`, and the sidebar label in `src/i18n/locales/ar/nav.json`. The page works right-to-left; numbers, dates and durations render left-to-right inside it, as the competitor screens already do (`src/features/competitor-tracking/ui/LtrValue.tsx`). Every control is keyboard reachable and the chart has a table alternative. Counters on the YouTube Channel page stay labelled as YouTube counters; they are a different source from this page and are not mixed with it.

### 5.7 The requested period and what Google has actually published

Google says "The response for a query with the `day` dimension will not contain rows for the most recent days" and that processing "typically" takes 48 to 72 hours (§3.3). Ending the period three days back makes missing days unlikely, not impossible.

- The **requested period** comes from the clock and is shown as "Period: <start> – <end>, Pacific time". It is labelled as the period, never as coverage.
- The **observed coverage** comes only from the `daily` answer: the last day Google returned. It is shown as "YouTube has published daily numbers through <date>". If the `daily` block has not loaded or failed, the line is not shown at all.
- If the last returned day is earlier than the requested end, or days are missing inside the range, the "Incomplete period" state appears and the trend shows gaps.
- **Totals carry no coverage claim.** The `summary` and `top_videos` answers have no per-day signal, so the page never says they are complete. The "Incomplete period" note is the only statement about them, and it is driven by the `daily` answer.
- Missing days are never drawn as zero and never filled in.

## 6. Security and privacy

1. **Identity comes only from the JWT.** Strict schemas refuse a body `user_id`; a service-role bearer is refused.
2. **Ownership is checked server-side on every request**, with the same refusal for a foreign and a missing account, and for a foreign and a missing video.
3. **The browser cannot name a channel.** `ids=channel==…` is built from the owned row. A browser-supplied video ID is format-checked, then ownership-checked, before it is used.
4. **Every provider read is bound to the admitted connection.** The token is obtained first; the account's `binding_generation` and channel are rechecked after the token is obtained, after any forced refresh, and before a result is returned (§5.2, steps 9, 10, 11, 14). A result from a connection that changed in flight is discarded.
5. **No new table, no new grant, no new RLS policy** under the recommended design. The function reads `social_accounts` and one `app_settings` key with the service role, inside `index.ts` adapters only. (Decision D6-B adds one RESTRICTIVE policy and one service-only SQL function, and no table.)
6. **Nothing new is stored.** No analytics value, video title or provider body is written to the database or to a log. The **one permitted write** is the existing one: when a token has to be refreshed, the refreshed access token is saved to the account row by the existing trusted store (§5.3), exactly as publishing and comments already do. No token is written anywhere else. No token or provider text appears in any response or log; tests assert the serialised response and log rows do not contain the fixture tokens or the fixture provider messages.
7. **Audit rows are bounded.** Stage 4 had the same class of finding for refusals and answered it with a rate-bounded bucket plus a suppression counter (`supabase/functions/comment-manager/stage4/audit.ts`). Stage 5 reuses that answer and extends it to signed-in callers:
   - Rows go to `system_logs` (`category` edge, `source` youtube-analytics) with `operation` (only if it is a known operation name, otherwise `unknown`), `code`, `request_id`, and `account_id` only once it is verified as the caller's.
   - `unauthorized` and `method_not_allowed` are never written, so an anonymous caller writes nothing.
   - **Refusals: at most 20 rows per user per minute.** Beyond that, one counter row per user per minute records how many were suppressed, and each suppressed refusal still emits a sanitised console event.
   - The admission limiter runs first (120 requests a minute), so the total database work one signed-in user can cause is bounded even for `status` and for requests that fail validation.
   - Each **successful data operation** writes one `info` row with the same fields and no numbers. It is bounded by the data limit (300 a day per user). Its purpose is incident scoping: after a problem, it shows which accounts received reports and when.
   - A failed audit write never changes the response.
8. **Refresh is health-neutral and grant-neutral** (§5.3).
9. **CORS** is `restrictedCorsHeaders(req)`, never the wildcard (ARCHITECTURE §25).
10. **The flag is a visibility switch only.** It does not stop the endpoint. The rollout policy is the access switch (§8).
11. **One channel at a time.** No number from two channels is ever added together or shown side by side (§3.6).
12. **Disconnect.** Nothing is stored, so nothing has to be deleted. Browser memory is cleared on sign-out, on account switch and when access is withdrawn (§5.6).

## 7. OAuth: which permission, and what it means for connected channels

### 7.1 Two branches

| | **Branch A — use permissions Postora already has** | **Branch B — add the analytics permission** |
|---|---|---|
| Scope used | Existing scopes only (`supabase/functions/youtube-oauth/handler.ts:414-417`). Exactly which of them are required is what P1 establishes (§7.2). | `https://www.googleapis.com/auth/yt-analytics.readonly` in addition. |
| Basis | Authorization guide: `youtube.readonly` "Grants `reports.query` access to non-monetary metrics" [V]; the notice on the `reports.query` page [V]. | The `reports.query` scope table lists it [V]. |
| Code change in `youtube-oauth` | **None.** | The scope is added to the consent request **behind a server-side gate** (§7.4). |
| Channels connected today | Channels whose recorded scopes contain the proven set work at once. Channels with no recorded scopes are tried and Google decides. No reconnect. | A channel gets analytics only after its owner reconnects and grants the new scope. Publishing and comments keep working with the old grant. |
| Google verification | No new scope. Postora's stated use of an existing scope changes. Whether Google requires a new review for that is **not stated** on the pages fetched. | If the Cloud Console marks the scope sensitive, the app must be approved for it "before your app can start to call these APIs"; until then "your app's users will experience the unverified app screen and the app will be subject to the 100-user cap" [V] ([Google Cloud help](https://support.google.com/cloud/answer/13464018)). Google's pages disagree on how long that takes: "up to 10 days" [V] ([Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)) and "verification might require several months" [V] ([Unverified apps](https://support.google.com/cloud/answer/7454865)). |
| Consent screen | Unchanged. | One more permission line, only for users the gate admits. Under Google's granular permissions, "Users can select which permissions they want to approve", and the app "can't assume users grant all requested scopes" [V] ([Granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)). An owner may untick analytics and keep the rest; the recorded scope list already handles this. |

How many of the connected channels have recorded scopes, and which scopes, was **not** checked (no production access for this document). Whether the consent screen is still in "Testing" was not checked either; if it is, only listed test users can connect at all, under either branch.

### 7.2 The check that decides: probe P1

One real request cannot be avoided, and the first version of this document made it prove more than it can. Three corrections:

- **The scopes that matter are the ones on the token actually sent**, not the ones recorded in the database. The probe therefore starts with a forced token refresh and reads the `scope` field of Google's token response for that exact token. The refresh helper already returns it (`grantedScopes` in `supabase/functions/_shared/youtubeTokenRefresh.ts:104-110`). If Google omits the field, the probe is inconclusive and stops.
- **A production token normally carries all three existing scopes**, because the consent request asks for all three with `include_granted_scopes=true` (`handler.ts:414-427`). A `200` with such a token proves only that *that set* is enough. It does not prove `youtube.readonly` alone is enough.
- **A refusal does not prove that the analytics scope fixes it.** Only a positive test with that scope does.

So P1 has up to three parts, each read-only, each on a channel the owner names, each separately approved:

| Part | Token | Result | What it establishes |
|---|---|---|---|
| **P1-a** | A production token for one named channel, after a forced refresh. Its effective scopes are read from the token response and written down. It must not contain `yt-analytics.readonly`. | `200` | **Branch A is viable for channels that hold every scope on that token.** The capability rule requires exactly that observed set. |
| | | Refusal classified as insufficient permission | Branch A fails for that set. **Not yet branch B**: run P1-c. |
| | | Anything else (API not enabled, quota, `5xx`, timeout, unrecognised) | **Inconclusive.** Fix the cause if it is "API not enabled" and repeat once; otherwise stop and report. |
| **P1-b** (optional, only after a P1-a `200`) | A token that carries `youtube.readonly` **and nothing else**, obtained by the owner for his own channel through a separate consent that requests only that scope without `include_granted_scopes`. | `200` | The rule can be narrowed to `youtube.readonly` alone, which also covers an owner who unticked the other permissions. |
| | | Refusal | The rule stays at the P1-a set. |
| **P1-c** (only after a P1-a permission refusal) | A token for the owner's own channel that carries the P1-a set **plus** `yt-analytics.readonly`. | `200` | **Branch B is confirmed.** |
| | | Refusal | Neither branch is established. Stop; the feature does not start until Google's requirement is understood. |

What the probe records, and only this: the part, the date, the HTTP status, the effective scope list of the token, and **one classification from a fixed list** — `ok`, `insufficient_permission`, `api_not_enabled`, `quota`, `unauthorized`, `unsupported_query`, `server_error`, `timeout`, `unrecognised`. On success it also records the column header names and the number of rows. **It records no Google message text, no response body, no channel name and no numbers.** Fixtures are written by hand to the documented shape of a Google error; nothing copied from a production response is committed or stored in `mem0`.

Whether a separate consent without `include_granted_scopes` really yields a token limited to the requested scope is **unverified**; P1-b reads the effective scopes first and is abandoned if they are wider.

### 7.3 True under both branches

- **The capability is derived from recorded scopes against one required set**, a constant in `supabase/functions/youtube-analytics/contracts.ts`, used only by that function. Its value is what P1 proved: the P1-a set, or `youtube.readonly` alone after P1-b, or the P1-a set plus the analytics scope under branch B. The `youtube-resources` capability contract is **not** changed; the YouTube Channel page shows its "View analytics" link on the flag alone, and the analytics page reports the real availability.
- **The public disclosure must change before any channel is enabled.** `src/pages/GoogleApiDisclosure.tsx` must list the scopes Postora really requests (it omits `youtube.force-ssl` today) and must stop saying Postora never reads YouTube Analytics. The two corrections are separate changes (plan step 6), because the first is true whatever happens to this feature. The privacy policy text in `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` and on `/privacy` needs the same sentence. The wording is the owner's to approve.
- **The YouTube Analytics API must be enabled** for the Google Cloud project.
- **Existing refresh tokens are expected to keep working.** No fetched page says that adding a scope to future consent requests invalidates stored tokens, but none says the opposite either, so this is **unverified**. The refresh path is unchanged.
- **The reconnect experience** (a channel whose grant lacks a required scope) is the comments precedent: a notice on the analytics page linking to Profiles, the normal Google consent screen, and the scope recorded on return. No automatic prompt, and no other feature is blocked meanwhile.

### 7.4 Branch B: the consent screen is not covered by the analytics rollout

If the scope were simply added to the list in `handler.ts`, every new connection and every reconnect would ask for it from the moment `youtube-oauth` deploys, about two minutes after the merge. Neither analytics switch touches that. A user reconnecting only to publish would see the extra permission, and, if Google has not yet approved the scope, the unverified-app screen. Switching analytics off would not undo it.

**Design: the scope is requested only when a server-side consent gate says so.**

- A second private `app_settings` key, `youtube_analytics_stage5_consent`, absent by default:

  ```json
  { "version": 1, "mode": "users", "user_ids": ["<auth.users.id>"] }
  ```

  `mode` is `off`, `users` or `all`. Absent, unreadable or malformed → **`off`**, and the connect flow proceeds with today's three scopes. A failure to read this key must never block a connection.
- The authorise action already knows the signed-in user. It adds the analytics scope to the consent request only when the gate admits that user. Everyone else gets today's request, byte for byte.
- `mode: "users"` is for the named pilot, who are told to expect the unverified-app screen if Google has not approved the scope. `mode: "all"` is allowed **only after** Google has approved the scope for the app's audience (or the Cloud Console shows the scope needs no review), and it is a separate owner approval.
- Setting the gate back to `off` restores the previous consent request at the next click. Users who already granted the scope keep it harmlessly.
- The disclosure page lists the fourth scope from the moment the gate admits anyone, with wording that says it is requested only when analytics is enabled for the account.

**What cannot be gated.** Once a user has granted the scope, Postora holds it for that connection until the user disconnects or revokes it; turning the feature off does not hand it back. And the app-level consequences of having an unapproved sensitive scope in use (the 100-user cap counts users who saw the unverified screen) apply to the Google project as a whole. The gate keeps that number to the named pilot.

The alternatives are decision D7.

## 8. Rollout

**Dark by default.** After the merge nothing changes for any user until the rollout policy is set.

| Switch | What it controls | Where | Default | Who may change it |
|---|---|---|---|---|
| **Rollout policy `youtube_analytics_stage5_rollout`** | **Access.** Whether the endpoint will call Google for a channel. | `app_settings`. Not `feature_`-prefixed and not on the browser read allow-list (`supabase/migrations/20261029170000_media_upload_limits.sql:17-39`), so non-admin browsers cannot read it. | **Absent = off for every channel.** Nothing seeds it. | Waleed only. `app_settings` writes are admin-only by RLS. |
| Visibility flag `feature_analytics_youtube` | **Visibility.** Whether the page and its links appear. | `app_settings`, browser-readable like every `feature_*` key | Off (code default; no row needed) | Waleed, in Admin → Feature Flags |
| Native connection with the required scopes | Whether a given channel qualifies | The account row | — | The channel's owner, by connecting |
| *Branch B only:* consent gate `youtube_analytics_stage5_consent` | Whether the consent screen asks for the analytics scope | `app_settings`, private in the same way | Absent = off | Waleed only |

**The two switches are not equal, and the first version of this document said otherwise.** The flag is read by the browser and enforced nowhere on the server. **The moment the policy lists a channel, the endpoint serves that channel's owner**, whether or not the flag is on; a signed-in owner who called the endpoint directly would get data. Therefore:

- approving the policy change **is** the go-live approval for that channel;
- turning the flag off hides the page and does **not** stop access; only the policy does;
- the flag-off, policy-on state is tested explicitly (§9.1).

Policy shape:

```json
{ "version": 1, "mode": "allowlist", "account_ids": ["<social_accounts.id>"] }
```

`mode` is `off`, `allowlist` or `all`, the Facebook analytics vocabulary. Missing key, unknown version, unknown mode, malformed JSON, an ID that is not a UUID, or more than 200 IDs → **deny**. A read that fails is an error (`settings_unavailable`), never a deny that looks like "off". Admins get no bypass.

The policy is read by the edge function with the service role at the start **and again at the end** of every data request, and is never cached across requests. A change takes effect at the next click in running instances too; a request already in flight has its result discarded (§5.2, step 14); a page already open clears itself within about a minute (§5.6).

**Why no migration is recommended for the gate.** Stage 4 made its key structurally private with a RESTRICTIVE policy and evaluated it in SQL because its gate guarded public, irreversible writes at a transactional boundary. Stage 5 reads an owner's own numbers and has no such boundary. The key is already unreadable by ordinary browsers: the read policy for signed-in users lists eleven named keys plus `feature_%` and nothing else (read directly at the lines cited above), and a SQL test pins that on the baseline plus every migration. This departs from the Stage 4 and Facebook precedents, which both use a database policy and SQL evaluation. The cost avoided is a production DDL step and a snapshot for a read-only feature. The stricter alternative is decision D6.

**Order of enablement**, each step a separate approval by Waleed:

1. P1 (§7.2).
2. After the merge: the rollout policy with one named channel. **This is the go-live for that channel.**
3. The flag on, so the page is visible. Rehearsal R1 (§9.5).
4. The remaining pilot channels, by adding their IDs.
5. `mode: "all"`, only after both real Google limits have been read in the Cloud Console, the two shared budgets have been set against them (decision D8), and the disclosure text is live.

No capability is implied by a merge or by an earlier approval.

## 9. Testing

All automated evidence is offline: fake provider, synthetic accounts, no public egress.

### 9.1 Deno

| Suite | Proves |
|---|---|
| `contracts.test.ts` | Every error code has a status; metric keys, units, periods, limits, budgets, the video-ID pattern and the single top-videos metric list match this document. |
| `window.test.ts` | The requested Pacific-time window for each period, across both daylight-saving changes and the year boundary; the end is three days back; a clock at 23:59 and at 00:01 Pacific. |
| `rollout.test.ts` | Absent, malformed, wrong version, unknown mode, over 200 IDs, non-UUID → deny; `off`, `allowlist` (listed and not listed), `all`; a failed read is an error, not a deny. |
| `limits.test.ts` | Each of the three limiters refuses when the counter call fails; the shared budget is one bucket for all users and is counted per Google API; a spent budget answers `capacity_reached` and sends nothing. |
| `analyticsReadClient.test.ts` | Exact request URL and parameters per operation, built from structured parameters; `ids` from the account. **Per-report validation:** a non-empty top-videos answer with string IDs is accepted; an ID that fails the pattern, a duplicate ID, a non-numeric or negative metric, a wrong row width, a header mismatch → `upstream_unavailable`; an explicit `null` cell → `value: null`; a daily answer missing its latest requested day and one missing a middle day are accepted with the right coverage and no filled-in rows; a day outside the window is rejected; missing `rows` → empty. Each error class; `The query is not supported` → `upstream_unavailable`; no provider text in any result; titles only for rows whose channel matches. |
| `handler.test.ts` (fake ports) | Unauthenticated; service role; unknown key including `user_id` and `channel_id`; malformed `video_id`; foreign account equals missing account; inactive; non-YouTube; Composio; `needs_reauth`; recorded scopes without a required one; empty recorded scopes proceeds; policy absent, off, not listed, unreadable; **flag-independent: the handler has no flag input at all**; each limiter; **every row of the provider-call table in §5.2, with both counters asserted**; a successful ownership lookup with no owned video is `not_found`, while a quota refusal, a timeout, a `5xx` and a malformed body in that lookup are each their own code and never `not_found`; at most one forced refresh per request; database read failure is `internal_error`; no token in any response. |
| Binding races | With a fake store that changes the account between steps: disconnect, reconnect on the same row, and switch to Composio, each injected (a) after admission and before the token, (b) after the token and before the ownership lookup, (c) during a forced refresh, (d) after the Analytics answer. Expected: (a)–(c) `connection_changed` with zero Google calls after the change; (d) `connection_changed` with the result discarded. A token refresh alone does not trip the check. |
| Revocation in flight | The policy is switched off while the provider call is pending → `not_enabled`, result discarded. |
| Audit bound | 21 refusals by one user in a minute write 20 rows and one counter row; anonymous refusals write none; a successful data operation writes one `info` row with no numbers; no row contains a token, provider text or an unverified identifier; a failed insert leaves the response unchanged. |
| Health neutrality | After every failure path — `401`, `403` insufficient permission, `403` unknown, quota, `invalid_grant` on refresh — the fake store shows **no** write to `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`, and `dropGrantedScope` is never imported by the function. |
| Compatibility | The `youtube-resources` capability and handler suites pass unchanged; that function's files are not edited. |
| Composition | `index.ts` builds the real handler with real ports (catches a handler that is built but not wired). |

### 9.2 SQL harness

One small suite, `supabase/tests/youtube_analytics_rollout_privacy.sql`, registered in `SUITES` in `scripts/db-harness.sh`: with the rollout key (and, under branch B, the consent key) present, `anon` and a non-admin `authenticated` user read zero rows for it and cannot write it; an admin can read and write it; `service_role` can read it. No migration is needed for the suite to run. (Under decision D6-B the suite also covers the policy and the evaluator.)

### 9.3 Vitest and Testing Library

Formatting (minutes to hours, seconds to minutes, zero and null); the gateway sends each request body in a shared fixture and maps each error code, with an unknown code falling back to `upstream_unavailable`; query keys contain user, account, period and video, and **switching account never shows the previous account's numbers, including while the new one loads**; one failing block does not hide the others; every state in §5.6 renders its own message and none renders as an empty report; subscribers gained and lost are separate and no net figure appears.

Added in this revision:

- **No automatic retry.** With the real query client configuration, a `quota_exceeded`, `capacity_reached`, `rate_limited`, `missing_scope` or `not_enabled` answer causes exactly one gateway call.
- **Coverage.** The period line shows the requested dates; the "published through" line shows the last day in the daily rows and is absent when the daily block failed; a missing day is a gap in the chart data, not a zero; the "Incomplete period" note appears when the last returned day is before the requested end.
- **Revocation.** When `status` turns to `not_enabled`, cached reports for that account are removed and a late response is dropped; the same on `connection_changed`.
- The top-videos table has exactly the four metric columns of §5.4.

Also: Arabic and right-to-left; the route and sidebar entry follow the flag; `tests/architecture.test.ts` for the layering; the "View analytics" link appears only with the flag on. One shared request fixture is accepted by the Deno handler and sent by the Vitest gateway, tying browser to server as in Stage 2.

### 9.4 Journey with a fake provider

`scripts/stage5-e2e.mjs`, modelled on `scripts/stage4-e2e.mjs`, starts the disposable harness database, a local server (`e2e/fixtures/youtubeStage5Server.ts`) that composes the **real** `youtube-analytics` handler with a fake provider that counts requests **separately for the two Google hosts**, and the app built with its real query client configuration. `e2e/youtube-stage5.spec.ts` runs in English and Arabic:

1. policy absent → the page says "not switched on"; both provider counts are zero;
2. policy admits the channel → overview, trend and top videos appear; counts are 3 Analytics and 1 Data;
3. change the period → the period line and numbers change; counts rise by 3 and 1;
4. open an owned video → its cards and trend; counts rise by 2 and 2. Another channel's video ID in the URL shows "not found"; counts rise by **0 Analytics and 2 Data** (one ownership lookup for each of the two reads);
5. a channel with no data → the empty state, not an error;
6. a daily answer missing its last two days → gaps, the "published through" date is the last returned day, and the incomplete-period note shows;
7. the provider answers with a permission refusal → the reconnect notice, **exactly one request per block**, and the account row's health columns and recorded scopes are unchanged in the database;
8. the provider answers with a quota refusal → the quota message and **exactly one request per block**;
9. the shared budget is exhausted → the capacity message and zero provider requests;
10. the policy is switched off while the page is open → within the status interval the reports disappear and the "not switched on" state shows; no further provider request;
11. the channel is reconnected while a request is pending → "connection changed", no numbers shown;
12. switch to a second channel mid-load → nothing of the first channel is shown;
13. a second user with a channel not in the policy sees nothing of the first user's data.

The run fails on any unexpected external request. Playwright is not a CI job in this repository, so this is local evidence recorded in the PR with the command, head SHA and result, as in Stage 4.

### 9.5 What cannot be proven without a real channel

| Unknown | Settled by |
|---|---|
| Which scope set Google accepts for `reports.query`. | P1 (§7.2). |
| The real shape of a permission refusal. | P1-a, only if it happens to be refused. Otherwise **stays unverified**. |
| The real shapes of an exhausted quota, an API that is not enabled, and an expired token. | **Not rehearsed.** Nobody will exhaust quota or disable the API in production to see the answer. These stay unverified; the classifier treats what it does not recognise as a temporary failure, and the fixtures are written by hand. If one is ever observed in normal operation, only its classification is recorded. |
| That `channel==<ID>` behaves as documented for a Google account with more than one channel. | R1, if the pilot account has more than one; otherwise unverified. |
| How many recent days are really missing, and whether three days back is right. | R1: the observed coverage line. |
| What a video filter for another channel's video returns. | Not rehearsed; the ownership check stands on its own. |
| What a small channel gets when data is below Google's thresholds. | R1 on a small channel, if one is available. |
| The real daily limits of both Google APIs. | The owner reads them in the Cloud Console. |
| That the numbers match YouTube Studio for the same Pacific-time range. | R1: the owner compares one period by eye. |

**Rehearsal R1**: read-only, the one pilot channel, after the merge and the first enablement, approved separately. It opens the page for each period and one video, and records **only what was actually observed**: which blocks loaded, the requested period and the observed coverage date, the provider request counts, and the owner's yes or no on the Studio comparison. It does not try to cause errors. It writes nothing to YouTube and records no numbers and no Google text.

## 10. Risks and open questions

| # | Risk or question | Handling |
|---|---|---|
| R-1 | The scope question (§3.1) is unresolved until P1. | Two branches designed; P1 before implementation, reading the effective scopes of the token it sends; the capability is one constant set to what was proven. |
| R-2 | Google's policy on derived metrics and stored data was not read word for word (§3.6). | The first release stores and derives nothing. Plan step 1 re-reads the page; a comparison feature is blocked until then. |
| R-3 | The Analytics API has no documented error table, and most error shapes will stay unobserved (§9.5). | Classify by status; unknown is a temporary failure, never a health change and never "not found"; hand-written fixtures. |
| R-4 | The limits of both Google APIs for this project are unknown, and analytics shares the Data API pool with existing features. | A fail-closed shared daily budget per API (§5.5); pilot by allowlist; `mode: "all"` only after the Cloud Console readings. |
| R-5 | The public disclosure page is already inaccurate and becomes more so. | Corrected in this delivery in two separate changes; must be live before any channel is enabled. The copy needs the owner's approval. |
| R-6 | Under branch B, Google verification may be required, and an ungated scope would change consent for everyone. | The consent gate of §7.4; `all` only after approval; decision D7. |
| R-7 | Numbers will differ from the YouTube Channel page counters (lifetime, public, live) and from Studio's default local-time view. | The page states the source, the requested period, the observed coverage and the Pacific time zone; the two sources are never mixed. |
| R-8 | `views` changed meaning on 30 April 2025 (Shorts) and 16 November 2026 (co-views). A 90-day period can straddle the second date. | One fixed footnote under the overview cards linking to YouTube's explanation. No adjustment is attempted. |
| R-9 | The rollout key's privacy rests on an allow-list, not a policy. | Pinned by a SQL test; decision D6 offers the structural alternative. |
| R-10 | A report already read by a person cannot be withdrawn. | Stated plainly (§5.6); the audit row of each successful read lets an incident be scoped (plan §6). |
| R-11 | The shared budget does not reserve quota against other features; it only caps analytics. | Stated (§5.5). A project-wide quota ledger is out of scope and would need a migration. |
| R-12 | The verification guide says the consent screen is in "Testing". If still true, only test users can connect. | Not checked; the owner confirms in the Cloud Console before the pilot. |
| R-13 | The binding rechecks are separate reads, not one transaction with the provider call. A rebinding in the few milliseconds between the last recheck and the response cannot be excluded. | Accepted for a read of the same owner's channel: the row's channel ID cannot change on a reconnect (the upsert key includes it), so the worst case is a report for the owner's own channel delivered just after a disconnect. |

Open questions that need no decision before implementation: whether `videos.list` accepts ten IDs in one call (plan step 1; the title lookup degrades if it does not), and whether `check_rate_limit` is present in production as assumed (plan step 0).

## 11. Decisions for the owner

The first option of each row is the recommendation. The plan is written against the first options and names what changes otherwise.

| # | Question | Options (recommended first) | Why the recommendation | What changes otherwise |
|---|---|---|---|---|
| **D1** | Which Google permission does Postora use to read analytics? | **A. Run probe P1 first (§7.2). Use the existing permissions if Google accepts them; add the analytics permission only if a positive test shows it is needed.** B. Add the analytics permission now, without the probe. | A may need no reconnect and no Google review, and costs one to three read-only requests. B is likely to work but makes every channel reconnect and may start a Google review, and it too is unproven until tested. | B builds plan step 7 from the start and makes D7 apply at once. |
| **D2** | Does Postora store YouTube analytics, or read it when asked? | **A. Read it from Google when the owner opens the page; store nothing.** B. Collect daily numbers into Postora's database, like Facebook. C. A now, B later if longer history or exports are wanted. | Google returns history on request, so storing adds nothing to the first release, and storing brings a migration, a cron job, a retention rule and an unread Google policy. | B replaces §5.1 with a new specification: tables, cron, retention, a policy reading, and a much larger delivery. |
| **D3** | What does the first release show? | **A. Channel overview, daily trend, ten most viewed videos (views, watch time, likes, subscribers gained), and overview and trend for one video (§4.1).** B. Channel overview and daily trend only. C. A plus traffic sources, countries and devices. | A answers "how did the channel do, and which videos did it" in four requests. C triples the requests and brings in data Google often withholds for small channels. | B removes the top-videos and video paths (plan steps 3–5 shrink, and the ownership lookup goes). C adds three operations, three blocks and their states. |
| **D4** | Which periods? | **A. Last 7, 14, 30 and 90 days, as on the Facebook and Threads pages.** B. Last 7, 28, 90 and 365 days, as in YouTube Studio. | One set of periods across Postora's analytics pages. | B changes one constant and its tests; 365 days makes the daily chart denser. |
| **D5** | Where is the page? | **A. In the Analytics menu at `/analytics/youtube`, with a "View analytics" link from each video on the YouTube Channel page.** B. A tab inside the YouTube Channel page only. | It is analytics, and the Analytics menu is where the other platforms are; the link covers the per-video path. | B drops the route, flag and sidebar entry and reuses `feature_youtube_management`; plan step 5 changes. |
| **D6** | How is the per-channel switch protected? | **A. A private settings key read by the server, with no database migration.** B. The same key plus a small migration that makes it unreadable by policy and evaluates it in SQL, as Stage 4 did. | The feature only reads an owner's own numbers; A avoids a production database change and a snapshot. | B adds one migration (one policy, one function, no table), a larger SQL suite and a snapshot before the merge. |
| **D7** *(only if P1 leads to branch B)* | When does the consent screen start asking for the analytics permission? | **A. Only for users named in a private server-side gate, then for everyone once Google has approved the permission (§7.4).** B. For nobody until Google has approved it; analytics waits. C. For everyone as soon as the code deploys. | A lets the named pilot start while everyone else's connect flow stays exactly as it is. B is the safest and the slowest. C would show the extra permission, and possibly Google's unverified-app warning, to every user who connects or reconnects for any reason, and switching analytics off would not undo it. | B removes the gate and holds the scope change in a second, later PR. C removes the gate; not recommended. |
| **D8** | How much of the shared Google allowance may analytics use each day? | **A. Provisional ceilings now — 1,000 Data API units and 2,000 Analytics requests a day for all users together — then set them against the real limits read in the Cloud Console before opening to everyone.** B. No shared ceiling; rely on per-user limits and Google's own refusal. | Analytics shares the Data API pool with publishing, comments and browse. A guarantees analytics cannot be what exhausts it. | B removes the shared budget and the `capacity_reached` state, and makes `mode: "all"` a real risk to other features. |
| **D9** | The project rule says CI changes go in their own reviewed PR with before-and-after timing. This delivery must register one test step and one SQL suite for the new code. | **A. Record an exception: register them in the product PR, as Stages 2 to 4 did, and attach the Deno and database job times before and after.** B. Register them in a separate CI PR opened after the product PR merges. | A test for code that does not exist yet cannot be registered first, and under B the new tests would not gate the merge that introduces the code. | B splits plan step 4 and step 8; the product PR merges with its new tests run locally only. |

No longer a choice: **the merge needs the owner's card in every case** (plan §1). The first version left a manager-only merge open under the recommended options; that was wrong.

Recorded assumptions, not owner decisions, unless the owner objects: native connections only; no revenue; no agent, n8n or MCP access; no comparison with the previous period until the Google policy has been read in full.

## 12. Verification performed for this document

- Baseline: Stage 4 merged to `main` as `44b426cc`. Its tree is identical to `7b8fe42b` (both resolve to tree `1ae05f6d`, checked with `git rev-parse`), so every path and line number cited at `7b8fe42b` holds at `44b426cc`. The manager reports that the Stage 4 migration is applied in production; that was not checked from here.
- Read through `git show`: `ARCHITECTURE.md` §§12–17, 22–28, 37–38 and the section list; the Stage 2 specification in full; the Stage 4 specification and plan in full; `youtube-oauth/handler.ts` and `index.ts` (scope and grant lines); `_shared/youtubeGrantedScopes.ts`, `_shared/youtubeCommentCapability.ts`, `_shared/youtubeTokenRefresh.ts` (exports, outcome type, the account read, the health-neutral mode); `_shared/rate-limiter.ts` (the fail-open branch); `youtube-resources/capabilities.ts`, `contracts.ts`, and the handler and index wiring lines; `comment-manager/stage4/rollout.ts`, `audit.ts`, `rateLimit.ts`; the Stage 4 migration's rollout section and the `binding_generation` column; `scripts/stage4-e2e.mjs`; `.github/workflows/ci.yml` step list; `src/App.tsx` (query defaults); `docs/runbooks/youtube-comments-rollout.md`; `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`; `src/pages/GoogleApiDisclosure.tsx` (scope sentences); the analytics contract, schema, calendar, gateway, flags, routes and sidebar lines cited in §2.2.
- The Meta pipeline was mapped in one research pass over the same tree (collection worker, cron migrations, retention, rollout keys, readiness SQL, CI and Playwright set-up). Its line numbers for those files were not individually re-read.
- Google pages fetched on 2026-11-23 are the ones linked in §3 and §7. None was re-fetched for the review round.
- **Not verified:** everything marked [S]; the sensitivity class of either scope; both Google APIs' real daily limits; the Analytics error shapes; whether a scope-limited consent yields a scope-limited token; whether `check_rate_limit` behaves in production as assumed; production state of any kind (recorded scopes of connected channels, the consent-screen status, whether the Analytics API is enabled); the maximum number of IDs per `videos.list` call.
- Not done, by instruction: code, migration, branch, commit, PR, production access, any call to a Google API.

## 13. Review round 1

Pull request #472 (documents only) received 33 automated comments from two reviewers (27 and 6). They reduce to 23 distinct findings. Severity labels are the reviewers'; the verdict is this document's.

| # | Finding (comments) | Verdict | Where the documents changed |
|---|---|---|---|
| F1 | The scope probe reads recorded grants, not the token's effective scopes; a `200` does not prove `youtube.readonly` alone; a refusal does not prove branch B; "true of every channel" was unfounded (1 HIGH) | **Real** | §7.2 rewritten as P1-a, P1-b, P1-c; §7.3 capability set; plan step 0 |
| F2 | The probe exports raw Google error text into the PR, memory and fixtures (1 MEDIUM) | **Real** | §7.2 fixed classification list, no text; §9.5; plan step 0 and step 1 |
| F3 | Branch B changes the consent screen for every connection the moment `youtube-oauth` deploys, while analytics is dark (2 HIGH) | **Real** | New §7.4 consent gate; §8 switch table; decision D7; plan step 7 |
| F4 | Token refresh and provider reads are not bound to the admitted connection (2 HIGH) | **Real** | §5.2 steps 4, 9, 10, 11, 14 and "Why the rechecks bind the token"; §6 rule 4; §9.1 binding races; residual in R-13 |
| F5 | The ownership lookup ran before a usable token existed (1 HIGH, 1 P2) | **Real** | §5.2 order: token at step 8, lookup at step 10, with its own `401` handling |
| F6 | Any lookup failure was classified as a missing video (1 MEDIUM, part of 1 HIGH) | **Real** | §5.2 step 10; error table (`not_found` only after a successful lookup) |
| F7 | Row validation rejected string video IDs; null handling undefined (1 HIGH, 1 P2, 1 Major from the second reviewer) | **Real** | §5.2 "Row validation, per report" |
| F8 | The video filter accepted an unbounded string (1 MEDIUM) | **Real** | §5.2 pattern `^[A-Za-z0-9_-]{6,64}$` on input and on Google-returned IDs; structured URL parameters |
| F9 | Per-user limits do not protect the shared Google quota; the limiter fails open (1 HIGH) | **Real** | §5.5 shared fail-closed daily budget per API; `capacity_reached`; decision D8; R-11 states what it does not do |
| F10 | Switching the rollout off does not clear reports already loaded or in flight (1 HIGH) | **Real** | §5.6 "When access is withdrawn"; §5.2 step 14; §8; plan §6 separates containment from recovery |
| F11 | Three different top-videos metric sets (2 MEDIUM) | **Real** | §5.4 one list, no fallback; §3.2; §4.1; decision D3 wording |
| F12 | The requested end date was presented as coverage (2 MEDIUM, 1 Minor from the second reviewer) | **Real** | New §5.7; envelope `requested_window` and `daily.coverage`; §4.1 header; states table |
| F13 | React Query retries once by default, breaking "nothing is retried" (1 MEDIUM) | **Real** (`src/App.tsx:27`) | §5.5 `retry: false`; §9.3; journey steps 7–8 |
| F14 | Signed-in refusals can write unbounded audit rows; `status` was unlimited (2 MEDIUM) | **Real** | §5.5 admission limiter; §6 rule 7, reusing the Stage 4 bucket-and-counter answer |
| F15 | The visibility flag does not gate provider access; "two switches" was false (1 MEDIUM) | **Real** | §8 rewritten: the policy is the go-live; §6 rule 10; flag-off, policy-on test |
| F16 | The merge gate omitted the owner's card for a new authenticated, token-using endpoint (1 MEDIUM) | **Real.** `CLAUDE.md` says a PR that contains permissions/auth merges only after Waleed's card. | Plan §1 and §5: owner's card in every case; removed as a variable from D1 and D6 |
| F17 | Refusal tests demanded zero provider calls for outcomes that need a Google call (1 MEDIUM, part of 1 HIGH, 1 Minor from the second reviewer) | **Real** | §5.2 provider-call table; §9.1; §9.4 step 4; plan §3 and §7 |
| F18 | The rehearsal cannot observe the error shapes it was asked to record (1 MEDIUM) | **Real** | §9.5: unobservable shapes stay unverified; R1 records only what it sees |
| F19 | The CI rule was declared "not triggered" without an exception (1 MEDIUM) | **Real as a process gap; the remedy is the owner's.** This document cannot grant itself an exception. | Decision D9; plan §4 |
| F20 | The disclosure rollback rule did not match runtime behaviour (1 MEDIUM) | **Real** | Plan step 6 (two separate changes) and §6 |
| F21 | The "denied effects" gate forbade any token write, but a refresh during a read stores the new access token (1 Major) | **Real** | §6 rule 6 names the one permitted write; plan §3 denied effect 5 |
| F22 | The acceptance gate assumed top videos and the one-video view exist, which decision D3-B removes (1 Major) | **Real** | Plan §7: every item names the decision it depends on; plan §8 |
| F23 | The release steps turn on a flag that decision D5-B removes (1 Minor) | **Real** | Plan §5: one enablement sequence per page option; plan §8 |
| — | Style note on the word "exactly" (attached to F7's comment) | **Not real.** Wording preference, no effect on meaning. | None |

No substantive finding was judged "not real". Two findings were narrowed rather than adopted whole: F9 (the budget caps analytics but does not reserve quota for other features, which would need a ledger and a migration) and F4 (the rechecks are separate reads, not a transaction; the residual is R-13).
