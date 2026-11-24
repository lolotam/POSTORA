# YouTube Stage 5 — YouTube Analytics reports (specification)

24 November 2026 · proposal for owner review, nothing implemented · tier **Heavy**, with a migration (reason in the plan) · [Implementation and acceptance plan](../plans/2026-11-24-youtube-stage5-analytics.md)

Code baseline: `main` at `5d020ed`. `git diff --stat f7d49921 5d020ed` over code, scripts and workflows is empty (the commits since are documents), so every path and line number below, read with `git show` at `f7d49921` (itself identical in code to the Stage 4 merge `44b426cc`), holds. Stage 5 depends on two things Stage 4 created in `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql`: the health-neutral token store (`store_youtube_refreshed_token_with_lease_neutral`) and the `social_accounts.binding_generation` counter. The manager confirmed on 2026-11-24 that the migration is applied in production and that a real token refresh succeeded through the new store; this document did not check production.

This is the **fourth revision**. The owner's decisions are built in and the options he did not choose are gone (§11); the last two, D10 and D11, arrived after the third revision. The plan debate's seven blocking objections and the third automated review are answered in §14; rounds 1 and 2 are condensed in §13. **Stage 5 carries one database migration** (§5.2): a policy, a nullable column with a trigger on `social_accounts`, **one small table that records each owner's acceptance of the analytics purpose** (§7.3), and a small set of functions. It stores no analytics.

Google pages were fetched on 2026-11-23. Each provider fact carries its URL and one of two marks:

- **[V]** the sentence was read word for word on the page;
- **[D]** the plan debate verified the fact on the cited URL; this document did not re-fetch it;
- **[S]** the page was too long to read in full and the fact comes from an automated summary of it. An [S] fact is **unverified** and is never the only support for a design rule; plan step 1 re-reads it.

## 1. Purpose and non-goals

### Purpose

The owner of a connected YouTube channel opens a page in Postora and sees how the channel performed over a chosen period: views, watch time, average view duration, subscribers gained and lost, likes, comments and shares, a day-by-day trend, the most viewed videos of the period, and the same numbers for one chosen video. The numbers come from the YouTube Analytics API, the same source YouTube Studio uses, and are read for that owner's channel only.

Today Postora shows only YouTube's public lifetime counters (total views, subscribers, likes per video) on the YouTube Channel page. It cannot answer "how did the last 30 days go?".

### Non-goals

- **No revenue or ad numbers.** They need a different Google permission and a channel in the YouTube Partner Program (§3.1).
- **No stored YouTube analytics data** (decision D2). No analytics table, no cron job, no history beyond what Google returns on request. The one table this stage adds holds acceptance records, not YouTube data (§7.3).
- **No numbers Postora computes itself**: no net subscribers, no engagement rate, no "+12% versus the previous period" (§3.6).
- **No audience breakdowns in the first release**: traffic sources, countries, devices, age and gender are listed as later options (§4.2).
- **No write to YouTube** and no change to publishing, comments, moderation, the comment poller, the OAuth attempt flow, the refresh lease or disconnect.
- **No change to the Meta analytics pipeline** (Facebook, Instagram, Threads), to TikTok analytics, to the Partner API, the n8n node, or the MCP tools. `get_account_analytics` keeps refusing YouTube.
- **No managed-connector (Composio) support.** A Composio-connected channel is told analytics is unavailable for its connection type, as in Stage 2 (`docs/specs/2026-11-20-youtube-stage2-resource-browse.md`, decision D3).
- **No live Google call in any automated test.**

## 2. Verified current state

### 2.1 YouTube, after Stage 4

| Fact | Evidence at `5d020ed` |
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
| The refresh helper reads credentials, takes the lease and, through its store, writes the token by account ID alone, with no owner, generation or `is_active` filter. Its fast paths return a token from the snapshot it is given without reading anything. A browser disconnect changes only `is_active` and deletes no lease; the lease is deleted only when a token column changes. | `supabase/functions/_shared/youtubeTokenRefresh.ts:440-449`, `:628-662`, `:706-718`; `supabase/migrations/20261120130000_youtube_refresh_lease_fixes.sql:75-140`, `:377-411`; `src/hooks/useSocialAccounts.tsx:73-77` |
| The neutral store checks neither `is_active` nor the generation. | `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql:226-273` |
| The generation trigger sets the generation to 1 on every insert; the insert policy only requires `auth.uid() = user_id`; `authenticated` holds table-wide privileges and `id` has only a column default. | same migration `:374-384`; `supabase/tests/baseline_schema.sql:17984`, `:22988`, `:7765` |
| The shared rate limiter lets traffic through when its database call fails; Stage 4 wrote a fail-closed limiter on the same database function. `check_rate_limit` starts a window at its first call and resets it after the window length; its guard branch returns `allowed: true` with `count: 0`; cleanup deletes rows past `expires_at`; the function and table are in the harness baseline. | `supabase/functions/_shared/rate-limiter.ts:40-49`; `supabase/functions/comment-manager/stage4/rateLimit.ts`; `supabase/manual-sql/20260627213616_rate_limit_buckets.sql:36-101`; `supabase/tests/baseline_schema.sql:892`, `:1268-1276`, `:7830` |
| Stage 4 bounds refusal audit rows with a rate bucket and a suppression counter. | `supabase/functions/comment-manager/stage4/audit.ts` |
| The browser's query client retries a failed query once by default. | `src/App.tsx:27` |
| Users accepted a privacy text that limits YouTube data use to publishing and showing channel information; no privacy-policy acceptance record exists in the repository. | `src/pages/Privacy.tsx:92-98`; `supabase/migrations/20260910100000_partner_platform_tier.sql:268-270` (a partner flow only) |
| Repository rule: every early return that refuses work must write a log row. | `AGENTS.md`, "Reviewing a pull request", rule 4 |
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
| The scopes of an access token can be read with `POST https://oauth2.googleapis.com/tokeninfo`, the token in an `Authorization: Bearer` header, from the space-delimited `scope` field. | [D] | [Google Auth Library `getTokenInfo`](https://googleapis.dev/nodejs/google-auth-library/latest/classes/OAuth2Client.html) |
| With `include_granted_scopes=true`, "the new access token will also" cover scopes the user previously granted to the application. | [V] (first words quoted; the rest paraphrased) | [Web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server) |
| "The `refresh_token` is only returned on the first authorization." Whether `prompt=consent` changes this is **not stated** on the page. | [V] | Same page |
| Whether `yt-analytics.readonly` or `youtube.readonly` is a "sensitive" scope is **not stated** on any page fetched. Google says the category is shown in the Cloud Console: "Sensitive scopes require review by Google and have a *sensitive* indicator on the Google Cloud Console's OAuth consent screen configuration page." | [V] | [OAuth scopes](https://developers.google.com/identity/protocols/oauth2/scopes) |

**The two Google pages disagree about which permission is enough.** One reading is that the permission Postora already holds (`youtube.readonly`) is sufficient. The other is that the dedicated analytics permission is needed. This document cannot settle it without one real request, which it is not allowed to make. §7 handles both outcomes and names the check that decides.

### 3.2 Reports, metrics and dimensions proposed for use

| Report | Request | Mark | Source |
|---|---|---|---|
| Channel totals for a period | No dimension. Metrics "Use 1 or more" from a list that includes `views`, `estimatedMinutesWatched`, `averageViewDuration`, `subscribersGained`, `subscribersLost`, `likes`, `comments`, `shares`. Optional filter: "Use 0 or 1" of `video`, `group`. | [V] | [Channel reports](https://developers.google.com/youtube/analytics/channel_reports) |
| Day-by-day series | Dimension "Use exactly 1 `day`, `month`". Same metric list. `video` is an allowed filter. Sample: `dimensions=day`, `sort=day`. | [V] | Same page; [Sample requests](https://developers.google.com/youtube/analytics/sample-requests) |
| Most viewed videos | `dimensions=video`, `maxResults=10`, `sort=-views`. The sample page says the request "requires you to specify a value for the `sort` request parameter and to set the `maxResults` parameter to an integer value of `10` or less." | [V] | [Sample requests](https://developers.google.com/youtube/analytics/sample-requests) |
| Most viewed videos, full rule | The general limit is 200 rows with `sort` required; some examples say 10. The first release asks for 10, which satisfies both. | [D] | [Channel reports](https://developers.google.com/youtube/analytics/channel_reports) |
| Most viewed videos, metrics | A documented sample uses `metrics=estimatedMinutesWatched,views,likes,subscribersGained` with `dimensions=video`. **This is the one metric list the first release uses** (§5.5). | [V] | [Sample requests](https://developers.google.com/youtube/analytics/sample-requests) |
| Most viewed videos, wider metrics | The general table also lists `comments` and `averageViewDuration` for this report. Not requested in the first release (§4.2). | [D] | [Channel reports](https://developers.google.com/youtube/analytics/channel_reports) |

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
| The Data API's published default is 10,000 units a day for the endpoints other than `search.list` and `videos.insert`, which have their own quotas; it resets at midnight Pacific Time. It is one pool for the whole Google project. The Analytics API's limit is **not stated**; **2,000 is Postora's own ceiling on request attempts**, not a Google figure. | [V]; [D] for the separate quotas | [Quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) |
| `channels.list` and `videos.list` cost 1 unit each. | [V] | [channels.list](https://developers.google.com/youtube/v3/docs/channels/list); [videos.list](https://developers.google.com/youtube/v3/docs/videos/list) |
| No maximum date range is stated. A `video` filter accepts up to 500 IDs; the design sends exactly one. | [V] | [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query) |
| `videos.list` takes a comma-separated list of IDs; the documented 50 is for `maxResults`, which cannot be used with `id`, so **no limit on the ID list is documented**. The reference documents `404 videoNotFound`. | [D] | [videos.list](https://developers.google.com/youtube/data/reference/rest/v3/videos/list). The design sends at most 10 IDs (§5.5) and treats `404 videoNotFound` like an empty `200` (§5.4). |
| "Some YouTube Analytics data is limited when metrics do not meet a certain threshold." The thresholds "are not published". Demographics and geography are named. | [V] | [Data model](https://developers.google.com/youtube/analytics/data_model) |

### 3.5 Errors

The Analytics reference has **no error table** (the `reports.query` page has no Errors section, and the errors URL redirects to an overview). Only two errors are documented:

- unsupported or mutually exclusive combinations cause "an HTTP `400 badRequest` error with the message `The query is not supported`" [V] ([Channel reports](https://developers.google.com/youtube/analytics/channel_reports));
- revenue metrics for a channel outside the Partner Program return `403 Forbidden` [V] (same page).

How this API reports a missing scope, an exhausted quota, an expired token or an API that is not enabled for the project is **not documented on the pages fetched**. The design therefore classifies by HTTP status first and by Google's reason string only where one is present, and treats anything it does not recognise as a temporary failure. Most of these shapes cannot be observed safely on a real channel and stay unverified (§9.5).

### 3.6 YouTube developer policy on stored data, derived data and consent

| Rule | Mark | Source |
|---|---|---|
| Authorized Analytics data may be retained as needed for the consented purpose, with the user's authorisation rechecked every 30 days; other data have type-specific refresh or deletion duties. Stored resource metadata: "API clients must either delete or refresh stored resource metadata from that API after 30 days." | [D]; the second sentence [V] | [Developer policies](https://developers.google.com/youtube/terms/developer-policies) III.E.4; [Policy guide](https://developers.google.com/youtube/terms/developer-policies-guide); [Data model](https://developers.google.com/youtube/analytics/data_model) |
| A client must not use API data "to create new or derived data or metrics" and must not aggregate data across channels of different owners; permission for derived metrics exists only for audited developers who apply for it. | [D] | Same policy and guide |
| After a user revokes access in the app, the token must be revoked right away and stored data deleted "within 7 calendar days of the revocation". | [V] | Developer policies, section D.2 |
| "Do not try to future-proof your access to data by asking for permissions that would enable features" not yet built. | [V] | Developer policies, III.D.2.b |
| A client "must not use user data for secondary purposes that are not clearly disclosed to users". | [V] | Developer policies, III.D.2 item 3 |
| A client "must require users to agree to a privacy policy before users can access" its services (quote truncated at the source's length limit). | [V] | Developer policies, III.A.2 |
| Users must re-accept the privacy policy before data is used for a purpose outside the one they originally accepted (reported by the debate as III.E.3.c). | **[S] — unverified**; this document could not reach the passage | Developer policies, III.E.3 |

The design stores nothing and derives nothing, so it complies with the storage and derivation rules. The consent rule is met inside the product: no analytics is read for a channel before its owner has accepted the purpose in Postora (§7.3, decision D10).

## 4. Proposed scope

### 4.1 The first release (decision D3)

One page, "YouTube analytics", for one selected channel and one selected period.

| Block | What the owner sees | Provider requests |
|---|---|---|
| Header | Channel picker, period picker (last 7, 14, 30 or 90 days, decision D4), a Refresh button, and two lines: "Period: <start> – <end>, Pacific time" (the window `status` pinned for this page load, §5.4) and "Last day with daily numbers: <date>" (the last day Google actually returned, §5.8). | none |
| Overview cards | Views · Watch time · Average view duration · Subscribers gained · Subscribers lost · Likes · Comments · Shares, each the total for the period, exactly as YouTube returns it. | 1 Analytics request |
| Daily trend | One line chart with a metric switch: views, watch time, subscribers gained, subscribers lost. One point per day Google returned; a day Google did not return is a gap in the line, never a zero. | 1 Analytics request |
| Most viewed videos | The ten most viewed videos of the period: title, views, watch time, likes, subscribers gained. One fixed metric set (§5.5). | 1 Analytics request + 1 Data API request for titles |
| One video | Clicking a video (here, or "View analytics" on the YouTube Channel page, decision D5) shows the same overview cards and daily trend filtered to that video. Subscriber cards carry a note that, for one video, YouTube counts only subscriptions from the video's watch page. | 2 Analytics requests + 2 Data API requests (each of the two reads confirms the video's ownership itself) |

Fixed rules for the first release:

- **Periods** are whole days ending three days before today in Pacific time, pinned once per page load by `status`. That is the period Postora *asks for*. It is not a promise about what Google has finished processing; the page shows the two separately (§5.8).
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

### 5.2 Connection identity and the one SQL decision

**What identifies "the connection that was admitted".** Four values, all read together: the account ID, the channel ID, `binding_generation` (Stage 4: advances on every disconnect, reactivation, re-consent and provider switch, and stays unchanged only for the trusted refresh functions), and a new **`binding_incarnation`**.

Why the generation alone is not enough (debate objection 2). Stage 4's trigger sets the generation to `1` on every insert (`supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql:374-384`). The insert policy only requires `auth.uid() = user_id` and `authenticated` holds table-wide privileges (`supabase/tests/baseline_schema.sql:17984`, `:22988`); `id` has only a column default (`:7765`). A row can therefore be deleted by its owner and inserted again with the same `id`, owner and channel, and it reads as generation 1 — indistinguishable from the original. No existing rule prevents this, so it cannot be argued away. The realistic harm is narrow (same owner, same channel, nothing of theirs stored by Stage 5), but the identity is what every later check compares, so it must be exact.

**`binding_incarnation`** is a nullable `uuid` column on `social_accounts` with one `BEFORE INSERT OR UPDATE` trigger function (`SECURITY INVOKER`, pinned `search_path`, the same shape as `youtube_stage4_assign_binding_generation`, same file `:374-440`):

| Event | Result |
|---|---|
| Insert of a YouTube row | `gen_random_uuid()`, whatever the client sent. |
| Insert of any other platform | `NULL`. |
| Update of a row that stays YouTube | `OLD` value. A client cannot change it. |
| Update that turns a row into YouTube | a new `gen_random_uuid()`. |
| Existing rows | stay `NULL`; the decision reads `NULL` as the all-zero UUID. A re-created row always gets a random value, so it never equals an old row's. |

Adding a nullable column without a default is a catalogue change with no table rewrite. The migration step of the plan repeats Stage 4's inventory for the added column (positional inserts, `%ROWTYPE`, `select("*")` readers, generated types). The owner decided to add it (D11).

**The migration** (decisions D6, D10 and D11) creates exactly these objects, following `20261122130000_youtube_stage4_comment_operations.sql`: the policy at `:728-741`, `SECURITY DEFINER` functions with a pinned `search_path` and service-role-only grants as at `:1895-1907`, and the closing assertions as at `:2103-2150`. It creates **one table**, the acceptance record of §7.3, and changes no existing function, trigger or policy.

| Object | Purpose |
|---|---|
| Policy `app_settings_youtube_stage5_rollout_private` | RESTRICTIVE, `FOR ALL`, `TO anon, authenticated`: a row whose key is `youtube_analytics_stage5_rollout` or `youtube_analytics_stage5_scope_gate` (branch B only, §7.4) is visible and writable only to an admin (`public.has_role(auth.uid(), 'admin')`). Both `USING` and `WITH CHECK`, so a non-admin cannot rename another row into or out of the two keys. The service role bypasses RLS. |
| Column `social_accounts.binding_incarnation` and its trigger | Above (D11). |
| Table `youtube_analytics_purpose_consents` and `youtube_analytics_stage5_record_consent(...)` | The acceptance record and its only writer (§7.3, D10). |
| `youtube_analytics_stage5_parse_policy(policy jsonb, account uuid)` | Pure, reads no table, executable by nobody but the functions below. Returns `ok`, `missing`, `invalid`, `off` or `not_listed`. |
| **`youtube_analytics_stage5_decide(...)`** | The one decision (below). |
| `youtube_analytics_stage5_acquire_lease(...)`, `youtube_analytics_stage5_store_token(...)` | Bound wrappers around the existing lease functions (§5.3). |

Policy document, unchanged: `{ "version": 1, "mode": "off" | "allowlist" | "all", "account_ids": ["<uuid>", …] }`. Not an object, unknown version or mode, `account_ids` not an array, a non-UUID entry, or more than 200 entries → `invalid`. Absent → `missing`. Both deny every account. Admins get no bypass.

**`decide(p_owner, p_account, p_expected_channel, p_expected_generation, p_expected_incarnation, p_required_scopes, p_purpose_version, p_with_credentials)`** returns one JSON object and is **one SQL statement**:

```text
{ ok, reason, channel_id, binding_generation, binding_incarnation, connection_revision,
  provider, needs_reauth, granted_scopes, consent: { state, version }, credentials? }
```

- It reads the account row (owner-filtered), the rollout setting and **the owner's latest acceptance event for that channel** together, by one `SELECT` with joins, and calls the pure parser on the joined setting. PostgreSQL gives a `SELECT` "a snapshot of the database as of the instant the query begins to run", and "two successive `SELECT` commands can see different data" ([Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html), [V]). Two statements could therefore disagree; one cannot. The function is declared `VOLATILE` so it takes its own snapshot when a wrapper calls it after taking a row lock.
- `credentials` (`access_token`, `refresh_token`, `token_expires_at`) is produced **in that same statement**, only when `p_with_credentials` and `ok`. A token can therefore never come from a different snapshot than the decision that released it.
- **Admission** passes no expected values. **Every later use** passes the three expected values the admission returned, which must be given all together or not at all.
- `connection_revision` is the first 32 hex characters of `sha256(account || ':' || incarnation || ':' || generation)`. It is computed here, once, and compares equal only for the same incarnation and generation. It is not secret and is not a credential.
- `p_required_scopes` is the required-scope constant (§7.2). An empty recorded list is "unknown" and passes (Stage 2, D5); a non-empty list that lacks a required scope is `missing_scope`.
- `p_purpose_version` is the current version of the analytics purpose text (§7.3). `consent.state` is `accepted` (latest event is an acceptance of that version), `outdated` (an acceptance of an older version), `withdrawn`, or `none`.

**One reason, one order.** If several conditions hold, the first in this list wins, so the page never gives a recovery instruction that cannot help:

| # | `reason` | Condition |
|---|---|---|
| 1 | `not_found` | Admission only: no row for this owner and account, or the row is not YouTube, or it is inactive. Identical for foreign, missing, inactive and non-YouTube accounts. |
| 2 | `connection_changed` | Expected values were given and the row is absent, foreign, inactive, or its channel, generation or incarnation differs. (The caller is the server, not the browser, so this leaks nothing.) |
| 3 | `provider_unsupported` | `COALESCE(auth_provider, 'native') <> 'native'`. |
| 4 | `not_enabled` | The policy is `missing`, `invalid`, `off` or `not_listed`. Under branch B, also: the scope-gate rule of §7.4. |
| 5 | **`consent_required`** | `consent.state` is not `accepted`: the owner has not accepted the current purpose text for this channel, or has withdrawn (§7.3). |
| 6 | `reconnect_required` | `needs_reauth`, or no stored access and refresh token. |
| 7 | `missing_scope` | Recorded scopes non-empty and lacking a required scope. |
| — | `ok` | None of the above. |

`consent_required` comes after `not_enabled` so that nobody is asked to accept a feature that is not switched on for their channel, and before the two connection reasons so that acceptance is the first thing an admitted owner is asked for. Because it is a reason of `decide`, it is checked wherever `decide` runs: at admission, at credential release, before every Google attempt and before every data response (§5.4). **A withdrawal therefore stops reads at the next of those checks.**

A database error is **not** a reason: the adapter reports it as `settings_unavailable`. Stage 4's adapter turns an error into `false` (`supabase/functions/comment-manager/stage4/rollout.ts:61`); Stage 5 must not copy that line.

### 5.3 Credentials, refresh and persistence bound to the connection

**Why replacing only the account read is not enough** (debate objection 1). Replacing only `readAccount` left three paths open. The lease is acquired by account ID alone (`supabase/migrations/20261120130000_youtube_refresh_lease_fixes.sql:75-140`), so Stage 5 could hold the lease of a *replacement* connection. A browser disconnect changes only `is_active` (`src/hooks/useSocialAccounts.tsx:73-77`), and the lease is revoked only when a token column changes (same migration `:377-411`), so a refresh in flight could store a token on a disconnected row; the neutral store checks neither `is_active` nor the generation (`20261122130000_youtube_stage4_comment_operations.sql:226-273`). And the helper's fast paths return a token from the snapshot it is given without reading anything (`supabase/functions/_shared/youtubeTokenRefresh.ts:628-662`).

**The design: bound variants, the shared functions untouched.** The Stage 5 migration adds two wrappers; it does not change the lease functions, the Stage 4 neutral store, the refresh helper, or any caller of them.

| Wrapper | What it does, in one short transaction |
|---|---|
| `acquire_lease(owner, account, expected binding, required scopes, ttl)` | 1. `SELECT … FOR UPDATE` on the account row (owner-filtered). 2. `decide(…)` with the expected binding, **after** the lock, so the decision cannot be overtaken by a concurrent change to that row. 3. If `ok`, return `acquire_youtube_refresh_lease(account, ttl)` unchanged (it re-locks the same row in the same transaction and then the lease row); otherwise return `{ok:false, reason}`. |
| `store_token(owner, account, expected binding, lease_token, access, expires_at, refresh)` | 1. `SELECT … FOR UPDATE` on the account row. 2. **Binding only**: owner, YouTube, native, **active**, channel, generation, incarnation all equal the expected values; otherwise `{ok:false, reason:'connection_changed'}` and nothing is written. 3. Call `store_youtube_refreshed_token_with_lease_neutral(account, lease, access, expires_at, refresh)` unchanged. |

- **Lock order** is account row, then lease row, the order every other writer uses (the comment at the top of `acquire_youtube_refresh_lease`, same migration). **No lock is held across Google I/O**: each wrapper is one RPC, one transaction, a few statements.
- **A browser disconnect cannot interleave with a store.** `UPDATE … SET is_active = false` needs the row lock the wrapper holds, so the update commits either before the wrapper's check (the check sees an inactive row; nothing is written) or after the wrapper's commit (the token was stored while the connection was still active). There is no third case.
- **No fourth trusted writer.** The neutral store is owned by the narrow role `youtube_stage4_refresh`, so the generation trigger preserves the generation when it writes (`…stage4…sql:374-440`). The wrappers are owned by the normal owner and *call* it; the narrow role's privileges, and the Stage 4 test that it owns exactly three functions (`supabase/tests/youtube_comment_operations.sql:385-389`), are unchanged.
- **Persistence is conditioned on the binding, not on the rollout or on acceptance.** Withdrawing the rollout, or the owner withdrawing acceptance, stops *use* of analytics (the next attempt is refused). It does not discard a token Google has already issued to the admitted connection: refusing to store it could lose a rotated refresh token and break publishing for that channel. A `needs_reauth` mark set meanwhile does not prevent the store either.
- **Other callers.** Publishing, comments, the refresh cron and `youtube-resources` keep calling the shared functions exactly as before. They can still interleave with Stage 5 on the lease: when one holds it, Stage 5's acquire answers `lease_held` and the helper re-reads through the bound read (`resolveFromFreshRead`, `youtubeTokenRefresh.ts:545-587`), reusing the other caller's fresh token.

**The adapter** (`supabase/functions/youtube-analytics/credentials.ts`) is `createSupabaseYouTubeRefreshStore(admin)` with four methods replaced, passed to `refreshYouTubeAccountToken` with `healthNeutral: true`:

| Method | Calls | If refused |
|---|---|---|
| `readAccount` | `decide(…, p_with_credentials = true)` | Returns `null`. For `reconnect_required` because of `needs_reauth`, returns an account with `needs_reauth: true` so the helper's own refusal path runs. |
| `acquireLease` | `acquire_lease` | Returns `account_not_found` (permanent for the helper) so it does not retry. |
| `storeTokenWithLease` | `store_token` | Returns `{ok:false}`; the helper then re-reads through the bound read. |
| `recordFailureWithLease` | — | Throws. Health-neutral mode must never reach it; a test asserts it is never called. |

`releaseLease` stays the shared function: it deletes only a lease whose token matches (`supabase/migrations/20261120110000_youtube_refresh_lease.sql:136`). Every refusal is also recorded in a per-request variable (`lastDenial`) **with its typed reason**, and the handler reads it before it reads the helper's outcome, because the helper's own outcomes cannot say "rollout withdrawn" or "connection changed". A stale `snapshot` passed to the helper is the step-6 credentials from the same request; the per-attempt authorization of §5.4 catches a withdrawal that happens after it.

**What an analytics request may write:** the lease row, taken and released; on a successful refresh, `access_token`, `token_expires_at`, a rotated `refresh_token` and `updated_at`, through the neutral store. **Never:** `needs_reauth`, `failure_count`, `last_refresh_error`, `account_metadata.granted_scopes`; and it never calls `dropGrantedScope`. A `403` from Google is shown to the owner and nothing is recorded (Stage 4's finding F7 is the reason).

### 5.4 Edge function

One new function, `supabase/functions/youtube-analytics/`. It is not added to `youtube-resources`, whose handler already carries browse, categories and edit (ARCHITECTURE §13: no unrelated workflows in one handler).

| File | Responsibility |
|---|---|
| `contracts.ts` | The single contract: operations, envelopes, error codes with HTTP status and page scope, metric keys and units, the one top-videos metric list, the video-ID pattern, periods, limits, ceilings, the required-scope constant. Runtime-neutral; the frontend imports its types from it. |
| `window.ts` | Pure: the Pacific reporting end date (three days back), the accepted window set, the Pacific budget day. |
| `decision.ts` | Adapter over `decide`: typed result; a failed call is `settings_unavailable`; no policy logic. |
| `credentials.ts` | The bound refresh store of §5.3. |
| `limits.ts` | The three limiters and the budget of §5.6, on `check_rate_limit`, all failing closed. |
| `analyticsReadClient.ts` | Typed calls to `youtubeanalytics.googleapis.com` and the two `videos.list` uses. Timeout, per-report row validation, error mapping. No database access. |
| `consent.ts` | Adapter over `record_consent` for the two acceptance operations (§7.3). |
| `audit.ts` | Bounded audit (§6, rule 7). |
| `handler.ts`, `index.ts` | `createYouTubeAnalyticsHandler(ports)`; `index.ts` only builds ports (ARCHITECTURE §12). |

`POST /functions/v1/youtube-analytics`, JSON body discriminated on `operation`, every schema strict, **every response `Cache-Control: no-store`**.

| Operation | Input | Success |
|---|---|---|
| `status` | `account_id` | Availability or one reason; `connection_revision`; `reporting_end_date`; `consent` state and the current purpose version; periods and limits. No provider call. |
| `consent_accept` | `account_id`, `purpose_version`, `locale` | Records an acceptance (§7.3). No provider call, no credential read. |
| `consent_withdraw` | `account_id` | Records a withdrawal (§7.3). No provider call, no credential read. |
| `summary` | `account_id`, `period_days` (7, 14, 30, 90), `window_end`, optional `video_id` | One value per metric. |
| `daily` | same | One row per day Google returned, four metrics, plus observed coverage (§5.8). |
| `top_videos` | `account_id`, `period_days`, `window_end` | Up to ten rows: video ID, title, link, four metrics (§5.5). |

`video_id` must match `^[A-Za-z0-9_-]{6,64}$` (the pattern at `supabase/functions/youtube-resources/handler.ts:101`), and so must every video ID Google returns before it is used in a title lookup or a link. Requests to Google are built with structured URL parameters.

**The reporting window is pinned by the server and carried by every request.** `status` returns `reporting_end_date`, the Pacific date three days before "now". A data request sends it back as `window_end`; the server accepts the current end date and the one before it, and answers `window_stale` for anything else. The start date is `window_end` minus `period_days − 1`. Every block of one page load therefore covers the same dates, across Pacific midnight too, and a response whose window differs from the request is dropped by the client.

```ts
interface YouTubeAnalyticsSuccess<T> {
  schema_version: 1;
  request_id: string;
  connection_revision: string;
  freshness: { fetched_at: string; source: "database" | "provider" };
  requested_window?: { start_date: string; end_date: string; days: 7|14|30|90; time_zone: "America/Los_Angeles" };
  data: T;
}
interface YouTubeAnalyticsMetric {
  key: "views"|"watch_time"|"average_view_duration"|"subscribers_gained"|"subscribers_lost"|"likes"|"comments"|"shares";
  unit: "count"|"minutes"|"seconds";
  value: number | null;            // null only for an explicit null from Google
}
interface YouTubeAnalyticsDaily {
  rows: Array<{ day: string; metrics: YouTubeAnalyticsMetric[] }>;   // only days Google returned
  coverage: { first_day: string|null; last_day: string|null; days_returned: number; days_missing: number };
}
```

#### Order of checks

1. **Caller.** User JWT, as in `youtube-resources`; a service-role bearer is refused.
2. **Admission limiter** (§5.6), every operation. A refusal is a cheap terminal path (§6, rule 7).
3. **Validation.** Strict schema; unknown keys, `user_id`, `channel_id`, a malformed `video_id`, an unsupported period or a malformed `window_end` fail.
4. **Admission.** `decide(owner, account, no expected values, required scopes, purpose version, no credentials)`. Not `ok` → the reason of §5.2 (`not_found`, `provider_unsupported`, `not_enabled`, `consent_required`, `reconnect_required`, `missing_scope`). An RPC error → `settings_unavailable`. Its channel, generation, incarnation and `connection_revision` are the **admitted binding** for the rest of the request. `status` ends here, and `window_stale` is checked here for data operations.
5. **Per-user data limiter.**
6. **Credentials.** `decide(… expected binding …, with credentials)`. Refused → typed reason; no Google call.
7. **Token.** `refreshYouTubeAccountToken` with the bound store. A token that is still valid is used as it is. The step-6 `needs_reauth` value is in the snapshot.
8. **Each Google attempt** — ownership lookup, Analytics call, title lookup, and any repeat — is exactly: **debit one budget unit → `decide(expected binding, no credentials)` → send**. A refused debit ends the attempt (`capacity_reached`). A refused decision ends it with that reason (`connection_changed`, `not_enabled`, `reconnect_required`, `missing_scope`, …) and **nothing is sent**; the debit already made is not refunded. The send follows the decision with no awaited call in between.
9. **Validate** the answer by report (below).
10. **Final decision.** `decide(expected binding, no credentials)` again, as the last awaited step. If it is not `ok`, the provider result is discarded and the typed reason is returned. If it is `ok`, the response is written. The success audit row is written **after** the response, not awaited.

The two acceptance operations stop after step 3: they call `record_consent`, which does its own owner and rollout check in one statement, and return. They never reach credentials, a token or Google.

**The `401` rule.** It applies to the ownership lookup and the Analytics call only; **the title lookup is exempt** (§5.5).

- A `401` on a token that this request did not itself refresh, and with no forced refresh yet used → one forced refresh through the bound store, then one repeat (which is a new attempt with its own debit and decision).
- Any other `401` — a token this request just refreshed, a second `401`, a `401` when the forced refresh was spent on the ownership lookup — is **`reconnect_required`** with no further Google call.
- A forced refresh the bound store refuses is `connection_changed` or the typed reason, and nothing is repeated.

**Ownership lookup.** `videos.list?part=snippet&id=<video>`. A valid `200` containing that ID with `snippet.channelId` equal to the admitted channel → continue. A valid `200` without it, **or a `404` whose reason is `videoNotFound`** (documented for this method, [V per the plan debate](https://developers.google.com/youtube/data/reference/rest/v3/videos/list)) → `video_not_found`. Quota → `quota_exceeded`; insufficient permission → `missing_scope`; timeout, network failure, `5xx`, any other `404`, an unrecognised error or a malformed body → `upstream_unavailable`. After anything but "continue", no Analytics request is made.

#### Row validation, per report

| Report | Column headers exactly | Each row | Other rules |
|---|---|---|---|
| `summary` | the eight metric names, requested order | At most one row; eight cells, each a finite number ≥ 0 or an explicit JSON `null`. | No `rows` → every metric `null`, "no numbers". |
| `daily` | `day`, then four metric names | `day` a `YYYY-MM-DD` date inside the requested window, no duplicates; four metric cells as above. | No `rows` → empty series. A missing day is absent from `rows`; nothing is filled in. |
| `top_videos` | `video`, then four metric names (§5.5) | `video` is a **string** matching the ID pattern, no duplicates; four metric cells as above; at most ten rows. | No `rows` → empty list and no title lookup. |

Anything else — wrong width, non-numeric or negative metric, malformed or out-of-window date, an ID failing the pattern — makes the whole answer `upstream_unavailable`. An explicit `null` is shown as "—"; a missing cell is never turned into `null` or zero.

#### Error codes

Fixed HTTP status and fixed English and Arabic copy; never Google's text. **Page scope** says what the browser does with it (§5.7).

| Code | HTTP | When | Page scope |
|---|---|---|---|
| `invalid_request` | 400 | Not JSON, fails the schema, malformed `video_id` or `window_end`, unsupported period. | Block |
| `window_stale` | 409 | `window_end` is not an accepted end date. | Block (Refresh) |
| `unauthorized` | 401 | Missing, invalid or service-role bearer. | Session |
| `not_enabled` | 403 | Rollout (or, under branch B, the scope gate) does not admit the account. | **Account** |
| `consent_required` | 403 | The owner has not accepted the current purpose text for this channel, or has withdrawn. | **Account** (shows the acceptance panel) |
| `consent_version_stale` | 409 | `consent_accept` named a purpose version that is not the current one. | Block (the panel reloads the text) |
| `missing_scope` | 403 | Recorded scopes lack a required one, or Google refuses for permission. Carries `detail: "grant_not_effective"` when the recorded list *includes* the scope but Google still refuses (§7.4). | **Account** (provider-confirmed: latch) |
| `not_found` | 404 | Account not owned, not YouTube, inactive or absent. | **Account** |
| `video_not_found` | 404 | A successful ownership lookup found no owned video. | **This video only** |
| `method_not_allowed` | 405 | Anything but `POST` and `OPTIONS`. | — |
| `provider_unsupported` | 409 | Composio-managed account. | **Account** |
| `reconnect_required` | 409 | `needs_reauth`, no credentials, or a `401` that may not be repeated. | **Account**; latch when Google confirmed it |
| `connection_changed` | 409 | Disconnected or reconnected while the request ran. | **Account** |
| `rate_limited` | 429 | A per-user limit; carries `retry_after_seconds`. | Block |
| `capacity_reached` | 429 | A shared daily budget is spent. | Block |
| `quota_exceeded` | 429 | Google refuses for quota. | Block |
| `settings_unavailable` | 503 | The decision, a limiter or the budget could not be read. | Block; `status`: lease not renewed |
| `upstream_unavailable` | 502 | Timeout, network failure, `5xx`, an unrecognised Google error (including `The query is not supported` and "API not enabled"), or a failed validation. | Block |
| `internal_error` | 500 | Unexpected exception. | Block |

#### Requests each outcome must show

"Token" counts requests to Google's token endpoint. Every Data and Analytics request is preceded by exactly one budget debit, and by one decision with no credentials. The token state is fixed for each row.

| # | Case (token state at the start) | Token | Data | Analytics | Outcome |
|---|---|---|---|---|---|
| 1 | Any refusal at steps 1–7 (incl. `consent_required`, credentials and a refused bound acquire), any token state; `status`; `consent_accept`; `consent_withdraw` | 0 | 0 | 0 | the reason |
| 2 | `summary`/`daily`, valid | 0 | 0 | 1 | data |
| 3 | same, expired, refresh succeeds | 1 | 0 | 1 | data |
| 4 | same, expired, Google refuses the refresh | 1 | 0 | 0 | `reconnect_required` or `upstream_unavailable` |
| 5 | same, expired, refreshed, Analytics `401` | 1 | 0 | 1 | `reconnect_required` (no repeat) |
| 6 | valid, Analytics `401`, forced refresh ok, repeat ok | 1 | 0 | 2 | data |
| 7 | valid, `401`, forced refresh ok, repeat `401` | 1 | 0 | 2 | `reconnect_required` |
| 8 | valid, `401`, bound acquire refuses (binding changed) | 0 | 0 | 1 | `connection_changed` |
| 9 | valid, `401`, forced refresh ok, repeat's debit refused | 1 | 0 | 1 | `capacity_reached` |
| 10 | debit refused before the first Google call | 0 | 0 | 0 | `capacity_reached` |
| 11 | decision refuses after the debit (withdrawal during the debit) | 0 | 0 | 0 | the reason; one debit spent |
| 12 | with video, valid, owned | 0 | 1 | 1 | data |
| 13 | with video, not owned or `videoNotFound` | 0 | 1 | 0 | `video_not_found` |
| 14 | with video, lookup fails (quota, permission, timeout, `5xx`, malformed) | 0 | 1 | 0 | that failure's code |
| 15 | with video, expired, refreshed; lookup and Analytics ok | 1 | 1 | 1 | data |
| 16 | with video, valid, lookup `401`, forced refresh ok, lookup ok, Analytics ok | 1 | 2 | 1 | data |
| 17 | same, then Analytics `401` (refresh already spent) | 1 | 2 | 1 | `reconnect_required` |
| 18 | with video, lookup ok, Analytics debit refused | 0 | 1 | 0 | `capacity_reached` |
| 19 | `top_videos`, valid, titles ok | 0 | 1 | 1 | data |
| 20 | `top_videos`, title lookup fails for **any** reason, incl. `401` | 0 | 1 | 1 | data, `titles: "unavailable"`, no refresh |
| 21 | `top_videos`, Data debit refused before titles | 0 | 0 | 1 | data, `titles: "unavailable"` |
| 22 | `top_videos`, no rows | 0 | 0 | 1 | empty list |
| 23 | any success whose final decision (step 10) refuses | as its row | as its row | as its row | the reason; **no data returned** |


### 5.5 The top-videos report: one metric list, and titles

```text
dimensions = video
metrics    = estimatedMinutesWatched,views,likes,subscribersGained     (this order)
sort       = -views
maxResults = 10
```

This is the documented sample ([Sample requests](https://developers.google.com/youtube/analytics/sample-requests), [V]). Google's general rule for this report is up to 200 rows with `sort` required; some examples say 10; ten satisfies both ([Channel reports](https://developers.google.com/youtube/analytics/channel_reports), [D]). The general table also lists `comments` and `averageViewDuration` for this report [D]; they stay out of the first release as a later option (§4.2). The query, the validator, the fixtures and the table all use the list above and nothing else. Columns: title · views · watch time · likes · subscribers gained (with the watch-page note of §4.1).

**Titles are optional enrichment.** One `videos.list?part=snippet&id=<up to 10 validated IDs>`, preceded by its own debit and decision. A row gets a title only if Google returns that ID with `snippet.channelId` equal to the admitted channel; otherwise it shows "Video unavailable" with its numbers (deleted videos stay in totals but not in per-video rows, [Data model](https://developers.google.com/youtube/analytics/data_model), [V]). **Any failure of this call — `401`, `403`, `404`, quota, timeout, malformed body, a refused debit or decision — returns the list with IDs and `titles: "unavailable"`. A title `401` triggers no token refresh and no repeat.** The Analytics call has already been made and paid for, so its numbers are not withheld, and a failure here never becomes an account-wide error. How many IDs one call accepts is not documented (§3.4); the design sends at most ten and, if Google refuses the list, does not retry with a smaller one in the first release.

### 5.6 Limits and the shared Google quota

All limiters use `check_rate_limit`, which increments atomically under a row lock (`supabase/manual-sql/20260627213616_rate_limit_buckets.sql:36-101`; the function and the table are also in the harness baseline, `supabase/tests/baseline_schema.sql:892`, `:7830`). All **fail closed**, following `supabase/functions/comment-manager/stage4/rateLimit.ts` and not the shared helper, which lets traffic through on a database error (`supabase/functions/_shared/rate-limiter.ts:40-49`).

| Limiter | Counted | Limit | Purpose |
|---|---|---|---|
| Admission, per user | Once per request, every operation | 120 a minute | Bounds the database work one user can cause. |
| Data, per user | Once per `summary`, `daily`, `top_videos` | 60 per 10 minutes, 300 per 24 hours | Bounds one user's share. A per-user guard; its window is not meant to match Google's day. |
| **Shared budget, project-wide** | **Immediately before every Google request: each lookup, Analytics call, title lookup and repeat** | **Data API: 1,000 units per Pacific day. Analytics: 2,000 attempts per Pacific day.** (D8) | Caps Stage 5's own draw. |

**The budget day is the Pacific calendar day.** Google's Data API quota "resets at midnight Pacific Time" ([Quota costs](https://developers.google.com/youtube/v3/determine_quota_cost), [V] in Stage 2 §5.1); for the Analytics API Google states no reset, and 2,000 is Postora's own ceiling on request **attempts**, not a Google limit. Both ceilings use the same Pacific day.

`check_rate_limit` starts a window at the first call and resets it after the window length (`:69-81`), so a 24-hour window can reset in the middle of a Google day and let the project spend twice its ceiling. The budget therefore does not use a rolling window:

- The bucket key contains the Pacific date: `youtube-analytics:budget:<data|analytics>:<YYYY-MM-DD>`, identifier `project`. The date is computed from the clock with the `America/Los_Angeles` zone, which handles both daylight-saving changes.
- The window length is **48 hours**, longer than any Pacific day (23, 24 or 25 hours), so a bucket never resets inside its own day, and `cleanup_rate_limit_buckets` deletes only rows already past `expires_at` (baseline `:1268-1276`). A new date is a new bucket.
- **A debit counts only if** the result is `allowed: true` **and** `count` is at least 1 and at most the ceiling. The RPC's guard branch returns `allowed: true` with `count: 0` when its row vanishes between the insert and the locked read (`:64-67`); that result is a refusal (`settings_unavailable`), never a free debit. Any RPC error is a refusal.
- Each budget has its own key; the SQL suite proves that `anon` and `authenticated` cannot insert, update or delete `rate_limit_buckets` (row security is enabled on it, `baseline_schema.sql:20077`).
- A unit debited for an attempt that the decision then refuses, or that fails, is not refunded.

**What the ceiling does and does not do.** It limits Stage 5's own contribution. The Data API default is one pool of 10,000 units a day for the whole project, shared with the comment poller, browse, video edits and comment writes (§3.4). The ceiling means analytics cannot spend more than 1,000 of it in a Pacific day. It does not guarantee that other features have quota left: if they have used 9,900, analytics may still spend 100. A project-wide reservation would need a ledger every feature debits, which is out of scope. Before `mode: "all"`, both ceilings are reviewed against the real limits in the Cloud Console and against the existing features' observed daily peak, with explicit headroom (D8).

Whether `check_rate_limit` exists in production as in the baseline was not checked; plan step 0 confirms it read-only.

### 5.7 Frontend

```text
src/features/youtube-analytics/
├── domain/          types.ts (re-exports contracts.ts), errors.ts, format.ts, trendSeries.ts
├── application/     ports.ts, queryKeys.ts, useYouTubeAnalyticsStatus.ts, useAccessLease.ts,
│                    useYouTubeAnalyticsSummary.ts, useYouTubeAnalyticsDaily.ts, useYouTubeTopVideos.ts
├── infrastructure/  supabaseYouTubeAnalyticsGateway.ts        (the only file that imports the Supabase client)
├── ui/              YouTubeAnalyticsScreen.tsx, OverviewCards.tsx, DailyTrend.tsx, TopVideosTable.tsx,
│                    VideoAnalyticsPanel.tsx, AnalyticsNotice.tsx
├── tests/           architecture.test.ts
└── index.ts
```

Layering per ARCHITECTURE §§3–4; the screen takes the gateway as an optional prop. **Real consumer** (ARCHITECTURE §1): page `src/pages/analytics/YouTubeAnalytics.tsx`, route `/analytics/youtube` in `src/components/AnimatedRoutes.tsx`, sidebar child in the Analytics group of `src/components/layout/DashboardLayout.tsx` when `flags.analyticsYoutube` is on (otherwise the page redirects to `/dashboard`), and a "View analytics" link in `src/features/youtube-management/ui/YouTubeVideoDetail.tsx`, shown only with the flag on (frontend only; `youtube-resources` is untouched). The flag `feature_analytics_youtube` is added beside the other four in `src/hooks/useFeatureFlags.tsx`, default `false`. The chart uses `recharts` (`src/features/analytics-contract/ui/SavedAnalyticsReport.tsx:69-71`).

**Query keys.** Every data query key is

```text
["youtube-analytics", user, account, connection_revision, operation, window_end, period_days, video | null]
```

`operation` is `summary`, `daily` or `top_videos`, so the three blocks never share an entry (TanStack Query identifies a query by its key, not its function). `window_end` is the date `status` returned for this page load; `connection_revision` comes from `status`. A response whose revision or window differs from its key is dropped.

**Display and fetching are separate decisions.**

| Decision | Depends on | Does not depend on |
|---|---|---|
| **May fetch** (`enabled`) | an account is selected; `status` has returned a revision; no latched denial; the owner asked (opened the page, changed channel or period, pressed Refresh or Retry) | the access lease |
| **May show** | the access lease is valid; the revision matches the data; no latched denial | whether a fetch is running |

Data queries use `staleTime: Infinity`, `refetchOnMount: false`, `refetchOnWindowFocus: false`, `refetchOnReconnect: false`, `retry: false`, and stay mounted for the life of the page. They are refreshed only by Refresh, Retry, or a change of channel, period or revision. A block is hidden by *not rendering it*, never by unmounting its query, so renewing the lease at the same revision causes **zero** Google requests, however long the lapse. (Option names are confirmed against the installed `@tanstack/react-query` 5.x, `package.json:52`, in plan step 6; the behaviour is the contract. The application default retries once, `src/App.tsx:27`.)

**The access lease.** Per signed-in user and selected account the page keeps `epoch`, `lease` (`started_at`, `revision`), `latch`, and at most one status request in flight.

- **Polling.** While the tab is visible and online, `status` every 60 seconds. A status request has a 20-second deadline (below the 30-second margin between the 90-second lease and the 60-second poll).
- **Lease clock.** A lease starts at the moment its status request was **issued**, not when the answer arrived, and is valid for 90 seconds.
- **Epoch.** `epoch` increases on: any denial, the tab becoming hidden, going offline, a change of user, account, period or channel. A status request remembers the epoch it was issued under and is **applied only if that epoch is still current**; an older answer is discarded, and the request in flight is aborted at the same events. A late answer therefore cannot renew a lease that a denial, a hide or a resume has already ended.
- **Resume.** Hiding the tab or going offline clears the lease. On resume, nothing is shown until a status request **issued after the resume** succeeds. Visibility, focus and online events are coalesced: while a request is in flight, they start no other.
- **Failure.** A failed, timed-out or `settings_unavailable` status leaves the lease to run out by time (blocks are then hidden with "Checking access…" and return when a check succeeds at the same revision). Retries back off 5, 15, 45 seconds, then every 60, and honour `retry_after_seconds`.
- **Denial.** `status` or any data operation answering an **Account**-scoped code (§5.4) removes the account's cached reports from memory, aborts its requests, bumps the epoch and shows the matching state. A new revision does the same for the old revision's entries.
- **Latch.** A provider-confirmed refusal (`missing_scope`, `reconnect_required`, `grant_not_effective`) latches to the revision. A same-revision `status` that says "available" renews the lease **but does not clear the latch**: the notice stays, and fetching stays off. Recovery is a new revision (a reconnect) or the owner pressing Retry, which sends one data request; a success clears the latch.
- `video_not_found`, `window_stale`, `rate_limited`, `capacity_reached`, `quota_exceeded`, `upstream_unavailable`, `internal_error` and `invalid_request` are **Block**-scoped: they change that block only.

**Bounds.**

| Situation | Bound |
|---|---|
| Rollout switched off, page open, `status` working | New requests refused at once; reports leave the screen at the next check, at most about 60 seconds, and stop being shown 90 seconds after the last lease start at the latest. |
| `status` failing, or device offline | Reports hidden when the lease runs out, at most 90 seconds after the last lease start. |
| Tab hidden, then shown | Nothing shown until a fresh status succeeds; that status removes the reports if access was withdrawn. |
| Reconnect or delete-and-recreate of the channel | The next `status` carries a new revision; the old reports are removed. |
| A response in flight at the withdrawal | Discarded if the server's final decision sees the withdrawal (§5.4, step 10). |
| **Not guaranteed** | A response whose final decision passed a few milliseconds before the switch is delivered; so is a `status` decided before the switch and answered after it (its lease starts at issue, so it extends nothing beyond 90 seconds from then). Numbers already read cannot be taken back (plan §6). |

States, each distinct, none rendered as an empty report: loading (skeletons per block; blocks independent); checking access; no YouTube channel (link to Profiles); not enabled ("not switched on for this channel yet", no reconnect prompt); **acceptance needed** (the panel of §7.3, in place of the reports); managed connection; reconnect needed (link to `/profiles`); permission missing, and, with `detail: "grant_not_effective"`, "Google did not keep this permission. Disconnect the channel on Profiles and connect it again"; connection changed ("reload"); video not found (in the video panel only); empty ("YouTube has no numbers for this period yet"); days not returned (§5.8); Google quota; Postora capacity; rate limited ("try again in N minutes"); period moved on (`window_stale`: "Refresh to load the latest period"); temporary failure (retry control and request reference); video unavailable (a top-video row). None repeats a request by itself.

English is inline; Arabic is added under a `youtube` group in `src/i18n/locales/ar/analytics.json` and the sidebar label in `src/i18n/locales/ar/nav.json`. The page works right-to-left; numbers, dates and durations render left-to-right inside it (`src/features/competitor-tracking/ui/LtrValue.tsx`). Every control is keyboard reachable and the chart has a table alternative. YouTube Channel page counters stay labelled as such and are never mixed with this page.

### 5.8 The requested period and what Google actually returned

Google says "The response for a query with the `day` dimension will not contain rows for the most recent days" and that processing "typically" takes 48 to 72 hours (§3.3). Ending the period three days back makes missing days unlikely, not impossible.

- The **requested period** is the pinned window, shown as "Period: <start> – <end>, Pacific time". It is never labelled as coverage.
- The **last returned day** comes only from the `daily` answer: "Last day with daily numbers: <date>". If the `daily` block has not loaded or failed, the line is absent.
- **A missing row means only that Google did not return that date.** The note is exactly "YouTube did not return daily numbers for <n> day(s) of this period." The page does not say the data is unpublished or that totals will change; it has no evidence for either.
- **Totals carry no coverage claim.** `summary` and `top_videos` have no per-day signal.
- On the wire the rows stay sparse. For the chart only, `trendSeries.ts` builds one point per requested day with `null` for a day with no row; the line is drawn with `connectNulls={false}`, as the saved-report chart does (`SavedAnalyticsReport.tsx:71`), so a missing day breaks the line. Without the `null` points the library would join the neighbouring days. No missing day is ever drawn as zero; the table alternative shows it as "—".

## 6. Security and privacy

1. **Identity comes only from the JWT.** Strict schemas refuse a body `user_id`; a service-role bearer is refused.
2. **Ownership, rollout and the connection are decided in SQL, in one statement,** at admission, at credential release, before every Google attempt and before every data response (§5.2, §5.4). The same reasons, in the same order, every time.
3. **The browser cannot name a channel.** `ids=channel==…` is built from the admitted binding. A browser-supplied video ID is format-checked, then ownership-checked.
4. **Credentials are released, and tokens are stored, only for the admitted connection** (§5.3): bound lease acquisition, bound store under the account row lock, no lock across Google I/O.
5. **The rollout key and the branch B scope-gate key are private by policy**, hidden from every non-admin session; the functions that read them are executable by the service role only.
6. **No YouTube data is stored.** No analytics value, video title or provider body reaches the database or a log. The **only permitted token write** is the existing health-neutral store saving a refreshed access token (and a rotated refresh token) to the account row, through the bound wrapper (§5.3). No token is written anywhere else, logged, or returned. Every response is `Cache-Control: no-store`. The one new table holds acceptance events only (§7.3): who, which channel, which text version, when, in which language; no IP address, no user agent, no analytics.
   **No read before acceptance.** `consent_required` is a reason of the one decision, so no credential is released and no Google request is sent for a channel whose owner has not accepted the current purpose text, pilot channels and the owner's own included; a withdrawal stops reads at the next check.
7. **Audit work is bounded, and every refusal that refuses work is recorded** (`AGENTS.md`, "Reviewing a pull request", rule 4: "Every early return that refuses work must write a log row").
   - Rows go to `system_logs` (`category` edge, `source` youtube-analytics): `operation` (known name or `unknown`), `code`, `request_id`, and `account_id` only once verified as the caller's. No tokens, provider text, numbers or unverified identifiers.
   - `unauthorized` and `method_not_allowed` write nothing; an anonymous caller writes nothing.
   - **Admission-limiter refusals:** at most **one row per user per minute**, decided by one extra `check_rate_limit` call on an audit bucket (`max 1`, window 60 seconds); no other database call; at most one console line per worker per minute. Sustained over-limit traffic therefore costs two counter calls per request and one row per minute.
   - **Other refusals:** at most 20 rows per user per minute through a shared bucket, so the bound holds across workers; beyond it, no row. The count of suppressed refusals is **best effort**: Stage 4 keeps its tally in one worker's memory (`supabase/functions/comment-manager/stage4/audit.ts:38`), which cannot count across workers.
   - **Successful data operations** write one `info` row with no numbers, **not awaited** and written after the response, so no awaited I/O sits between the final decision and the response. These rows are best-effort evidence for incident scoping, not a complete record of what was delivered.
   - A failed audit write never changes the response.
8. **Refresh is health-neutral and grant-neutral** (§5.3).
9. **CORS** is `restrictedCorsHeaders(req)` (ARCHITECTURE §25).
10. **The flag is a visibility switch only.** The rollout policy is the access switch (§8).
11. **One channel at a time.** No number from two channels is added or shown side by side (§3.6).
12. **Disconnect.** Nothing is stored, so nothing is deleted. Browser memory is cleared on sign-out, account switch, revision change and withdrawn access (§5.7).

## 7. Google's permission, and the owner's acceptance of the purpose

Two different things are called "consent" and must not be confused. **Google's permission** is what the owner grants on Google's OAuth screen: scopes on a token (§7.1, §7.2, §7.4). **Acceptance of the purpose** is what the owner agrees to inside Postora: that Postora may read their channel's analytics and show it to them (§7.3). A read needs both.

### 7.1 Two branches

| | **Branch A — permissions Postora already has** | **Branch B — add the analytics permission** |
|---|---|---|
| Scope used | Existing scopes only (`supabase/functions/youtube-oauth/handler.ts:414-417`). Which of them are required is what P1 establishes (§7.2). | `https://www.googleapis.com/auth/yt-analytics.readonly` in addition. |
| Basis | Authorization guide: `youtube.readonly` "Grants `reports.query` access to non-monetary metrics" [V]; the notice on the `reports.query` page [V]. | The `reports.query` scope table lists it [V]. |
| Code change in `youtube-oauth` | None. | The scope is added to the consent request **behind a server-side gate** (§7.4). |
| Channels connected today | Channels whose recorded scopes contain the proven set work at once; empty recorded lists are tried and Google decides. | A channel gets analytics only after its owner reconnects and grants the new scope. Publishing and comments keep working with the old grant. |
| Google verification | No new scope. Whether Google requires a new review for a new *use* of an existing scope is **not stated** on the pages fetched. | If the Cloud Console marks the scope sensitive, the app must be approved "before your app can start to call these APIs"; until then "your app's users will experience the unverified app screen and the app will be subject to the 100-user cap" [V] ([Google Cloud help](https://support.google.com/cloud/answer/13464018)). Google's pages disagree on how long that takes: "up to 10 days" [V] ([Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)) and "verification might require several months" [V] ([Unverified apps](https://support.google.com/cloud/answer/7454865)). |
| Consent screen | Unchanged. | One more permission line, only for users the gate admits. Under granular permissions the owner may untick it: "the application must check what scopes are granted by the users" [V] ([Granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)). |

How many connected channels have recorded scopes, which scopes, and whether the consent screen is still in "Testing" were **not** checked.

### 7.2 Probe P1

The owner decided (D1): probe first; add the analytics permission only if a positive test shows it is needed. The probe is real, read-only Google requests on the owner's own channels. **Each part needs its own approval when it is about to run.** Nothing here authorises it.

**What P1 asks.** The four report shapes the product will send (§3.2), each over the same seven-day window ending at the current reporting end date, so that a pass proves the shipped shapes and not only the simplest:

| # | Shape |
|---|---|
| S1 | Channel totals: the eight summary metrics, no dimension. |
| S2 | Daily: `day` and the four trend metrics, `sort=day`. |
| S3 | Top videos: `video` and the four metrics of §5.5, `sort=-views`, `maxResults=10`. |
| S4 | S1 filtered to one video of the channel (`filters=video==<id>`). |

A part is `ok` only if all four are `ok`. Each is classified from the fixed list: `ok`, `insufficient_permission`, `api_not_enabled`, `quota`, `unauthorized`, `unsupported_query`, `server_error`, `timeout`, `unrecognised`.

**How the effective scopes of a token are read.** Not from the database, and not from the refresh helper, which in health-neutral mode returns `grantedScopes: null` even when Google sends a `scope` field (`supabase/functions/_shared/youtubeTokenRefresh.ts:906`) and returns `null` again when it reuses a token another worker refreshed (`:765-771`). The probe asks Google's token information endpoint about **that exact access token**: `POST https://oauth2.googleapis.com/tokeninfo` with the token in an `Authorization: Bearer` header, reading the space-delimited `scope` field ([Google Auth Library](https://googleapis.dev/nodejs/google-auth-library/latest/classes/OAuth2Client.html), `getTokenInfo`, [D]). The token stays out of URLs, logs and recorded headers; the timeout is 10 seconds; the token endpoint, the information endpoint and the Analytics requests are counted separately. If the answer is not a `200` with a `scope` field, the part is **inconclusive and stops**.

**Which tokens count.** The connect flow requests three scopes and sets `include_granted_scopes=true` (`handler.ts:414-427`), so a token can carry grants from older consents, and Google "combines previous grants at the project level" (debate; [include_granted_scopes](https://developers.google.com/identity/protocols/oauth2/web-server), [V] for the parameter). A result is attributed to a scope set only when that set is exactly the token's effective scopes and is obtainable by the normal connect flow.

| Part | Where | Token (effective scopes) | Result and what it establishes |
|---|---|---|---|
| **P1-i** (recommended first) | Isolated (below) | The three existing scopes, on the test client | All four `ok` → an early signal for branch A; build for branch A. `insufficient_permission` → run P1-c (ii) at once; branch B is decided before any code. **Limited evidence**: it is not Postora's client. |
| **P1-a** | Production, one of Waleed's own channels, **after the Stage 5 code is deployed and he has accepted the purpose for that channel in Postora** | A token whose scopes are a subset of the three existing ones and exclude `yt-analytics.readonly`, obtained through the bound path, which `decide` releases only after acceptance | All four `ok` → **branch A is sufficient for exactly that set** (a proper subset is a narrower proof). `insufficient_permission` with a token that carries **all three** → branch B → P1-c. A refusal with a proper subset → **inconclusive**; repeat with a token that carries all three. Anything else → inconclusive. |
| **P1-b** (optional) | Isolated (below) | `youtube.readonly` only | All four `ok` → the required set narrows to `youtube.readonly`, which also covers an owner who unticked the other permissions. Otherwise it stays at the P1-a set. |
| **P1-c** | Isolated (below), the same channel, OAuth client and requests throughout | (i) the three existing scopes (this is P1-i); then (ii) those three plus `yt-analytics.readonly` | (i) must be `insufficient_permission`; if it is `ok` while P1-a refused, the two results conflict and the probe stops. (ii) all four `ok` → **branch B is necessary and sufficient**. (ii) refused → neither branch is established; stop. |

**The isolated procedure (decision D12)** serves P1-i, P1-b and P1-c. It does not depend on any Postora change and does not use Postora's connect flow, so it has no circular dependency on the branch B gate:

- **Recommended: a separate test OAuth client.** A Google Cloud project owned by Waleed with its own OAuth client, the YouTube Analytics and Data APIs enabled, its consent screen in Testing with himself as test user, and tokens obtained in Google's OAuth 2.0 Playground with that client's own credentials, for a channel he owns that is not a customer's. It touches nothing in Postora and nothing in Postora's Google project. **Its evidence is limited**: it shows what Google accepts for these requests and scopes, not what Postora's own project, verification state or stored refresh tokens do. That is enough for P1-b and P1-c, which ask about sufficiency; the durable-grant question is answered per connection (§7.4).
- **Alternative:** Postora's production client in the same Playground, which needs the Playground redirect URI registered on that client. It would add the analytics grant to that account's grants for Postora's client, which later Postora reconnects by that account would pick up through incremental authorization. Not recommended unless the limited evidence above is judged insufficient.
- In both, the client secret is entered only by Waleed, in his own browser, and is never shared with an agent or recorded.

**P1 and the rule "no read before acceptance".** The isolated parts are Waleed's own requests through his own test client; they are not Postora reading anyone's data and they write nothing to Postora. **P1-a is a Postora read and obeys D10 like any other**: it runs only after the code is deployed, the rollout policy lists Waleed's channel, and he has accepted the purpose for it in the product. It uses the bound path of §5.3, so its possible writes are the lease row, taken and released, and, when a refresh was needed, the token columns through the neutral store; no health column and no recorded grant. There is no production probe before the acceptance mechanism exists.

**What is recorded**, in the PR and in `mem0`, and nothing else: the part and date, the HTTP status of each request, the token's effective scope list, the classification, and on success the column header names and the row count. **No Google message text, no response body, no channel name, no token, no numbers.** Fixtures are written by hand.

**Gate G-P1.** The first channel in the rollout policy is the probe channel, Waleed's own. **No other channel is added until** P1-a has a recorded conclusion **and** the required-scope constant on the deployed head equals it (plan §5). The code is built with the set P1-i indicates, or, if no isolated part has run, with a provisional set of all three existing scopes; the constant is changed by a reviewed PR if P1-a concludes otherwise.

### 7.3 The owner's acceptance of the analytics purpose (decision D10)

**The rule.** No analytics is read for a channel — pilot channels and Waleed's own included — before the owner of that channel has accepted the analytics purpose inside Postora. Acceptance is given by the owner, in the product, for one channel; nobody gives it on their behalf, and listing a channel in the rollout policy only *offers* the feature.

**Why it is needed.** Users accepted a privacy text that says YouTube data is used "solely to" upload and publish videos and "display your YouTube channel information" (`src/pages/Privacy.tsx:92-98`), and the disclosure page says Postora does not read YouTube Analytics (`src/pages/GoogleApiDisclosure.tsx:97-98`, `:107`). Google requires that a client "must not use user data for secondary purposes that are not clearly disclosed to users" ([Developer policies](https://developers.google.com/youtube/terms/developer-policies), III.D.2 item 3, [V]) and "must require users to agree to a privacy policy before users can access" its services (III.A.2, [V], quote truncated). The plan debate reports that III.E.3 requires re-acceptance before a use outside the accepted purpose; this document could not reach that passage (**[S]**), and plan step 1 reads it. Changing the text alone does not make an existing user agree to it.

#### What is recorded, and where

**A table is needed, and this is the one table of Stage 5.** The owner chose "no table" for the rollout switch (D6), and that still holds for the switch. An acceptance is a different kind of fact: a durable record that one person agreed to one text at one time, which must survive a reconnect, must not be writable by the browser, and must keep its history when it is withdrawn. Nothing existing can hold it:

| Candidate | Why not |
|---|---|
| `social_accounts.account_metadata` | The owner's browser can update any column of an owned row (the update policy, `supabase/tests/baseline_schema.sql:18206`), so the record would not be server-written; the column is rewritten read-modify-write by other code (`supabase/functions/_shared/youtubeGrantedScopes.ts:19-32`); it dies with the row. |
| `app_settings` | Operator configuration, admin-written. An acceptance must be written by the owner's own action. |
| `system_logs` | A log, not a source of truth: a failed insert is dropped by design (§6, rule 7). |
| The partner risk-consent fields (`supabase/migrations/20260910100000_partner_platform_tier.sql:268-270`) | Tied to partner WhatsApp registration. |

**`public.youtube_analytics_purpose_consents`**, append-only: one row per event, never updated.

| Column | Meaning |
|---|---|
| `id uuid` primary key | |
| `owner_id uuid NOT NULL` → `auth.users` ON DELETE CASCADE | Who accepted or withdrew. From the JWT, never from the request body. |
| `channel_id text NOT NULL` | The YouTube channel, copied from the owned account row by the server. |
| `social_account_id uuid` → `social_accounts(id)` ON DELETE SET NULL | The connection it was given under; for reference only. |
| `event text NOT NULL` | `accepted` or `withdrawn`. |
| `purpose_version integer NOT NULL` | Which version of the purpose text was on screen. |
| `locale text NOT NULL` | `en` or `ar`: the language it was shown in. |
| `method text NOT NULL` | How it was given. One value in this release: `in_app_panel`. |
| `request_id text NOT NULL`, `created_at timestamptz NOT NULL` | The request that recorded it, and when (server clock). |

**Not recorded:** the text itself (it lives in the repository, keyed by version), IP address, user agent, any analytics value.

- **Current state** for an owner and a channel is their latest event. It is valid only if that event is `accepted` **and** its `purpose_version` equals the current one.
- **Keyed by owner and channel**, not by the account row, so it survives a reconnect and a delete and re-insert of the row, and is never shared between two owners of the same channel ID. Disconnecting a channel is not withdrawing (open decision D13).
- **Row security:** enabled, **no policies**; `REVOKE ALL` from `PUBLIC`, `anon`, `authenticated` and `service_role`. Nothing reads or writes the table except two `SECURITY DEFINER` functions with a pinned `search_path`, executable by the service role only: `decide` reads it, `record_consent` inserts into it. No function updates or deletes a row.
- **Retention:** for the life of the user account. Rows are removed only when the user is deleted (the cascade). A withdrawal does not delete the earlier acceptance; it is itself a row. There is no clean-up job; the volume is a few rows per channel.

**`youtube_analytics_stage5_record_consent(p_owner, p_account, p_event, p_purpose_version, p_locale, p_request_id)`** is one statement, `INSERT … SELECT` from the owner-filtered account row joined to the rollout setting:

- `accepted` requires an owned, active, native YouTube account that the rollout policy admits. Otherwise `not_found`, `provider_unsupported` or `not_enabled`, and nothing is inserted: Postora does not collect acceptances for a feature it is not offering.
- `withdrawn` requires only an owned YouTube account row, active or not, so an owner can always withdraw.
- It is idempotent: if the latest event already has the same meaning and version, nothing is inserted.

#### Where it is enforced

Inside the one decision, as its own typed reason (§5.2): **`consent_required`**, fifth in the order, after `not_enabled`. Because every use of a connection goes through `decide`, acceptance is checked at admission, **at credential release, before every outbound Google attempt and before every data response** (§5.4). A withdrawal recorded while a request is running is seen at that request's next check: the attempt is not sent, or the result is discarded. A refresh already in flight may still store the token it was issued (§5.3); nothing is read with it.

The two operations that record events, `consent_accept` and `consent_withdraw` (§5.4), read no credential and call no provider. The edge function compares the submitted `purpose_version` with the current constant and answers `consent_version_stale` if they differ, so an owner cannot accept a text they were not shown.

#### The screen

**Where.** On `/analytics/youtube`, for the selected channel, **in place of the reports** whenever `status` answers `consent_required`. It is a panel in the page, not a dialog over it and not a notification. Nothing is fetched while it is shown. An owner with several channels is asked once per channel.

**What the text must say**, in English and in Arabic, the two carrying the same meaning (the strings are written at implementation and approved by Waleed on the merge card):

1. Which channel it is about, by name.
2. What Postora will read: views, watch time, average view duration, subscribers gained and lost, likes, comments and shares, for the channel and for each video, from YouTube Analytics.
3. Why: to show those numbers to the owner inside Postora. No other use.
4. Who sees them: only the owner, when signed in.
5. That the numbers are read when the owner opens the page and are **not stored** by Postora.
6. That this is separate from, and in addition to, the permissions granted to Postora at Google, and does not change them.
7. How to stop: the control on this page, at any time, with immediate effect.
8. The version and date of the text, and links to the privacy policy and the Google disclosure page.

**Controls.** Two buttons of equal weight: "Allow analytics for this channel" and "Not now". Nothing is pre-selected and there is no "accept for all my channels".

**"Not now" records nothing.** No event is written and nothing is read. The page shows "Analytics is off for this channel until you allow it" with the same button. The owner is not asked again by a pop-up, an email or a banner elsewhere; the panel is simply there when they open the page.

**Withdrawing.** While analytics is allowed, the page carries a quiet "Analytics permission" line with "Stop using analytics for this channel". It asks for one confirmation that states the effect: the reports disappear now; the channel stays connected; publishing and comments are unaffected; the permissions at Google are unchanged; analytics can be allowed again later. Confirming calls `consent_withdraw`, removes that account's reports from memory, and shows the panel again.

**Accessibility.** Keyboard reachable, focus moved to the panel heading when it appears and back to the triggering control after the confirmation, the result announced; right-to-left in Arabic.

#### The purpose text, its version, and the public pages

- `ANALYTICS_PURPOSE_VERSION` is one integer in `supabase/functions/youtube-analytics/contracts.ts`, starting at 1. The panel's strings, in both languages, belong to that version.
- **The disclosure page and the privacy text are corrected in the same delivery** (plan step 6), and their analytics clause is the long form of what the panel says in short. The panel may never say more, or less, than that clause. Both pages name the clause's version and date, and the panel links to them.
- **A material change to the purpose** — what is read, why, who sees it, whether it is stored — changes the clause, the panel strings and the version together, in one change. Every existing acceptance then reads as `outdated`, `decide` answers `consent_required`, and **no report loads until the owner accepts the new text**. A correction of wording that changes no meaning does not raise the version; that judgement is Waleed's.
- A test fails if any panel string changes, in either language, without the version constant changing (§9.3).
- Order of release: the corrected pages and the panel ship in the same deploy, with the rollout policy absent, so no owner can be shown the panel before the pages it links to are live.

#### With the pilot, the rollout modes and branch B

| Situation | What happens |
|---|---|
| Rollout policy absent or the channel not listed | `not_enabled`. The panel is not shown and no acceptance can be recorded. |
| Channel listed (`allowlist`) or `mode: "all"` | The owner sees the panel. Until they allow, nothing is read. Listing is the operator offering; allowing is the owner agreeing. |
| The pilot, and Waleed's own channels | The same. There is no exception and no way to mark a channel as accepted from the admin side. The production probe P1-a runs after he has accepted for that channel (§7.2). |
| `mode: "all"` | No longer waits for a separate mechanism: acceptance is already per owner and per channel. It still needs its own approval and the ceilings review (§8). |
| Rollout switched off | Reads stop. Acceptances stay recorded, so switching it on again does not ask owners twice. |
| Branch B | Independent of the scope gate (§7.4), which concerns Google's permission. An owner needs both: this acceptance, and the Google scope. The page asks for the acceptance first. |
| The owner disconnects, then reconnects the same channel | The acceptance stands (D13). A different owner connecting that channel is asked on their own account. |

### 7.4 Branch B only: the scope gate and per-connection grant checks (decision D7, still open)

Applies only if P1 concludes branch B. This section is about **Google's permission**, not about the owner's acceptance of the purpose (§7.3); the two are independent and a read needs both. Under branch B an admitted owner is asked in this order: accept the purpose in Postora (`consent_required`), then reconnect to grant the Google scope (`missing_scope`). D7 has not been put to the owner because it may never arise.

An unconditional scope added to `handler.ts` would reach every new connection and reconnect about two minutes after the merge, ahead of Google's verification, with nothing switched off by the analytics policy. **Recommended design:**

- A second private key, `youtube_analytics_stage5_scope_gate`, absent by default and already covered by the policy of §5.2: `{ "version": 1, "mode": "off" | "users" | "all", "user_ids": [...] }`. Absent, unreadable or malformed → no, and the connect flow asks for today's three scopes. A failure to read it never blocks a connection.
- The authorise action adds the analytics scope only when the gate admits the signed-in user; everyone else gets today's request byte for byte.
- **The scope-gate rule lives in `decide`** (a second small migration replaces that one function, `CREATE OR REPLACE`). Because every use of a connection goes through `decide` (§5.2), the gate is checked in the same statement, at admission, at credential release, before every Google attempt and before every response: an owner removed from the gate between two of them is refused at the next. In `allowlist` mode an allow-listed account whose owner the gate does not admit is `not_enabled`; `mode: "all"` of the rollout with the scope gate not `all` is `not_enabled` for everyone.
- **Data may not run ahead of the Google permission**: rollout `all` is refused by the decision until the scope gate is `all`, and the scope gate `all` waits for Google's approval (or for the Console to show the scope needs none).
- **A grant is verified per connection, not once.** A re-consent can record the new scopes while the save keeps the old refresh token (`supabase/functions/youtube-oauth/index.ts:126-128`, `:156`), and Google's page says "The `refresh_token` is only returned on the first authorization" ([web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [V]); whether `prompt=consent` changes that is **unverified**. So: before each pilot account is added to the rollout, a token minted from **that account's stored refresh token** is checked with the token information endpoint, under approval (the procedure of P1-a, steps for effective scopes). Under `all`, the same fact is caught at run time: if the recorded scopes include the scope and Google still refuses for permission, the answer is `missing_scope` with `detail: "grant_not_effective"`, and the owner is told to disconnect the channel on Profiles and connect it again (the disconnect revokes the stored token, so the next consent starts clean). Each occurrence is audited; several of them stop the `all` step.
- **Closing the gate does not undo a grant.** Setting it to `off` restores today's *request*. A user who already granted the scope keeps the grant until they disconnect or revoke it, and because the flow sets `include_granted_scopes=true` Google can include that earlier grant in later authorizations. The public disclosure therefore keeps describing the fourth scope for as long as any such grant can exist.

The options the owner would be offered (D7): **A.** gated, as above (recommended); **B.** no analytics scope for anyone until Google has approved it, branch B shipping later; **C.** for everyone at deploy (not recommended).

## 8. Rollout

**Dark by default.** After the migration and the merge nothing changes for any user until the rollout policy is set.

| Switch | Controls | Where | Default | Who |
|---|---|---|---|---|
| **Rollout policy `youtube_analytics_stage5_rollout`** | **Access.** Whether the endpoint will call Google for a channel. | `app_settings`, hidden from non-admin sessions by the policy of §5.2, evaluated by `decide`. | **Absent = off for every channel.** The migration does not seed it and asserts it is absent. | Waleed only |
| Flag `feature_analytics_youtube` | **Visibility.** Whether the page and links appear. | `app_settings`, browser-readable like every `feature_*` key (`supabase/migrations/20261029170000_media_upload_limits.sql:17-39`) | Off | Waleed, in Admin → Feature Flags |
| Native connection with the required scopes | Whether a channel qualifies | The account row | — | The owner, by connecting |
| **The owner's acceptance of the purpose** | Whether Postora may read analytics for that owner's channel at all | The acceptance record (§7.3), written only by the owner in the product | **None = no read** | The channel's owner, in the product; nobody on their behalf |
| *Branch B only:* scope gate | Whether Google's consent screen asks for the analytics scope | `app_settings`, private by the same policy | Absent = off | Waleed only |

**The policy is the operator's access switch; acceptance is the owner's.** The flag is read by the browser and enforced nowhere on the server. The moment the policy lists a channel **and its owner has accepted the purpose**, the endpoint serves that owner whether or not the flag is on; listing a channel by itself reads nothing. Approving a policy change **is** the go-live approval for that channel; turning the flag off hides the page and stops nothing. The flag-off, policy-on state is tested.

`decide` is evaluated at the start of every request, before credentials are released, **before every Google attempt**, and as the last step before a data response. Nothing is cached across requests. A change therefore takes effect at the next attempt, in running instances too. An attempt already authorized when the switch is thrown is in flight and cannot be recalled; a response whose final decision passed a moment earlier is delivered. Those are the stated residuals.

**Order of enablement**, each step a separate approval by Waleed, each able to fail at its own stage:

| # | Step | Evidence required |
|---|---|---|
| 0 | Preconditions: Console readings, `check_rate_limit` and Stage 4 objects confirmed read-only in production; the isolated P1 parts, if approved. | Recorded in the PR |
| 1 | Implementation, guards, review, CI green on the exact head. | CI links |
| 2 | The owner's card: merge, migration hash and object list (including the new table), disclosure and purpose wording. | Approval |
| 3 | Production snapshot; apply the migration; verify it. | Snapshot receipt; verification output |
| 4 | Merge, then the **deployment checkpoint** (plan §5): frontend deployed; the Edge Functions Sync schedule ran for the merge commit and did not park it (`docs/runbooks/deploy-edge-function.md`); synced files match by SHA-256; smoke test on the deployed route. | Schedule log, hashes, smoke output |
| 5 | Dark verification: other features and every other setting unchanged; connect flow asks for the same three scopes; disclosure and privacy text live; page not visible; no acceptance rows. | Checklist |
| 6 | Rollout policy `allowlist` with **Waleed's own channel only**; flag on; he accepts the purpose in the product; **P1-a**; rehearsal R1. | Recorded classification and scope lists |
| **G-P1** | The scope question is closed and the deployed constant equals the conclusion. Under branch B also **G-B**: the per-connection grant check (§7.4). | Recorded conclusions |
| 7 | (a) Further pilot channels, one approval each: listing a channel only *offers* analytics; its owner then accepts or declines in the product. (b) `mode: "all"`: a separate approval after both Google limits and the existing features' peak have been read and the ceilings reviewed (§5.6). No further consent mechanism is needed: acceptance is already per owner and per channel. | Per step |

## 9. Testing

All automated evidence is offline: fake provider, synthetic accounts, disposable database, no public egress. The real refresh helper is exercised against the real SQL functions in the local journey (§9.4); CI covers the SQL functions and the Deno logic with fakes, and the PR says so.

### 9.1 Deno

| Suite | Proves |
|---|---|
| `contracts`, `window` | Every error code has a status and a page scope. The Pacific reporting end date, the accepted window set, and the budget-day key across both daylight-saving changes, the year boundary, and clocks at 23:59 and 00:01 Pacific; `window_stale` for an end date outside the set. |
| `decision` adapter | Each `decide` answer maps to the right code; **an RPC error is `settings_unavailable`, never `ok` and never "off"**; precedence in §5.2. |
| `limits` | Each limiter refuses when its counter cannot be read. The budget key contains the Pacific date; the window is 48 hours; **a result with `allowed: true` and `count: 0` is refused**; a debit just before and just after a Pacific midnight lands in two buckets; ceiling `N` allows `N` debits and refuses `N+1`; a repeat after `401` and a title lookup each debit; a decision that refuses after the debit does not refund it. |
| `analyticsReadClient` | URL and parameters built structurally; `ids` from the admitted binding. **Per-report validation:** a non-empty top-videos answer with string IDs is accepted; a bad or duplicate ID, a non-numeric or negative metric, a wrong width, a header mismatch → `upstream_unavailable`; explicit `null` → `value: null`; a daily answer missing its latest day, and one missing a middle day, are accepted with the right coverage and no filled-in rows; an out-of-window day is rejected; missing `rows` → empty. Ownership: `200` owned, `200` without it, `404 videoNotFound` → `video_not_found`; any other `404` → `upstream_unavailable`. |
| `handler` (fake ports) | Unauthenticated; service role; unknown keys; malformed `video_id`/`window_end`; each admission reason; Composio; the order of checks. **Every row of the requests table of §5.4 with the token, Data, Analytics and debit counters asserted and the token state pinned**, including rows 5, 7, 8, 9, 11, 17, 20, 21 and 23. A failed ownership lookup is never `video_not_found`. A title `401` causes no token request and no repeat. `Cache-Control: no-store` on every response. No token in any response. A refusal decided after a debit does not send. |
| Acceptance | `consent_required` at admission, at credential release, before an attempt and at the final decision, each with **zero** token and Google requests after it; `consent_accept` and `consent_withdraw` never read credentials or call Google; a stale version is `consent_version_stale`; accepting twice is one event; a foreign or not-enabled account cannot accept; acceptance and withdrawal each write one audit row; the owner's identity comes only from the JWT. |
| `credentials` (bound store) | `readAccount`, `acquireLease`, `storeTokenWithLease` call the bound RPCs with the admitted binding; a refusal sets `lastDenial` and the handler prefers it to the helper's outcome; `recordFailureWithLease` is never called; `needs_reauth` in the bound read reaches the helper's refusal path. |
| Binding races (fake store, then real SQL in the journey) | Change injected: (a) after admission, before credentials; (b) after credentials, before a needed refresh; (c) during a token exchange, **by the browser path (`is_active = false` only)** and, separately, by a reconnect that changes a token; (d) at a forced refresh; (e) while a debit is pending; (f) after the Analytics answer. Expected: (a), (b), (d), (e) → no Google request after the change; (c) → the exchange completes, the bound store **refuses** and writes nothing, in both disconnect paths; (f) → result discarded. Withdrawal of the **rollout** at (c) is different by design: the token **is** stored (§5.3), the next attempt is refused. |
| Audit | Two handler instances sharing the buckets: 30 refusals by one user in a minute write 20 rows; 500 admission-limiter refusals write one row and cost 1,000 counter calls, no other database call, one console line per worker; anonymous refusals write none; a success writes its `info` row after the response and never before it; no row holds a token, provider text or numbers; a failed insert changes nothing. |
| Health neutrality | After every failure path no write to `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`; an expired token leads to one write, through the bound store; `dropGrantedScope` is never imported. |
| Compatibility, composition | `youtube-resources`, `youtube-oauth` and refresh-lease suites pass unchanged and none of their files is edited; `index.ts` builds the real handler with real ports. |

### 9.2 SQL harness

New suite `supabase/tests/youtube_analytics_stage5_rollout.sql`, registered in `SUITES` in `scripts/db-harness.sh` (`:107`), on the baseline plus every migration, with two real sessions over `dblink` as in the Stage 4 suite.

| Area | Assertion |
|---|---|
| Old-code compatibility | With the migration applied and no new code, every existing suite stays green; every other `app_settings` key behaves as before for `anon`, `authenticated`, an admin and the service role, **including an admin acting through `authenticated`**, and renaming a row into or out of either protected key. |
| Privacy | With either key present, `anon` and a non-admin `authenticated` session read zero rows for it and cannot insert, update, delete or rename into it; an admin can; `service_role` can. The read allow-list is unchanged. |
| Privileges | Browser roles cannot execute the new functions; `service_role` can execute `decide`, `acquire_lease`, `store_token`; the parser is executable by none. Each is `SECURITY DEFINER` with the pinned `search_path`; the closing assertions of the migration hold. The narrow role still owns exactly the three Stage 4 functions. |
| Incarnation | An insert ignores a client-supplied value; an update cannot change it; a platform switch to YouTube assigns one; **delete and re-insert with the same `id`, owner and channel yields a different incarnation and a different `connection_revision`**; existing rows read as the all-zero value. |
| Acceptance record | Browser roles and the service role hold no privilege on the table; only `record_consent` and `decide` touch it; no function updates or deletes a row. `record_consent` takes the channel from the owned row, never from its arguments; refuses a foreign, missing or non-YouTube account, and for acceptance an inactive, non-native or not-admitted one; is idempotent. `decide`: `none`, `accepted`, `outdated` after a version bump, `withdrawn`; the reason order with `consent_required` in fifth place for every pair; **withdrawal committed between admission and credential release, between credential release and an attempt, and before the final decision refuses at each**; acceptance survives a reconnect and a delete and re-insert of the row (it is keyed by owner and channel); a second owner of the same channel ID has their own record; rows go when the user is deleted and not when the account row is. |
| `decide` | Policy parsing (`missing`, `invalid`, `off`, `not_listed`, `ok`, 200 vs 201 entries, non-UUID); the reason order of §5.2 for every pair of simultaneous conditions; tenant isolation (two owners, one owner with two accounts, crossed IDs; identical `not_found`); `needs_reauth`; scopes (empty recorded list passes, missing scope refuses); expected values all-or-none; no credential in any refusal; credentials only when `ok` and requested. |
| Snapshot | **Discriminating:** a test-only two-statement variant with a barrier between its two reads, committed against by session B, returns an incoherent answer; the same barrier technique run against `decide` cannot interleave, and `decide`'s source is asserted to be one statement reading each of the two tables once. The suite fails if the production function is replaced by the variant. |
| Bound lease and store | Real interleavings: (i) session A holds the account row lock with an uncommitted `is_active = false` while B calls `store_token` → B waits, then refuses `connection_changed`, nothing written; (ii) a reconnect (token change) before `acquire_lease` → refused; (iii) a disconnect without a token change before `acquire_lease` → refused, and the lease table is untouched; (iv) publishing holds the lease → `lease_held`, no second lease; two Stage 5 acquirers → exactly one token; (v) rollout withdrawn between acquire and store → the store **succeeds**; (vi) `needs_reauth` set between → the store succeeds, `decide` refuses afterwards; (vii) no lock is held after either function returns; (viii) the narrow role's generation trigger still preserves the generation on a Stage 5 store. |
| Budget buckets | Against the real RPC: exact exhaustion; the Pacific-day key on both sides of midnight and of both daylight-saving transitions; a row deleted between the insert and the locked read yields `count: 0` and the debit helper refuses; `cleanup_rate_limit_buckets` run during a day leaves the live bucket; browser roles cannot alter `rate_limit_buckets`; the two budgets and the per-user buckets have separate keys. |
| Seeding | Neither key exists after the migration. |

### 9.3 Vitest and Testing Library

Formatting; the gateway sends each request in a shared fixture and maps each code; account switch never shows the previous account's numbers; one failing block does not hide the others; every state renders its own message and none renders as an empty report; subscribers gained and lost are separate; the top-videos table has the four columns of §5.5.

- **Keys.** The three channel operations have **distinct** keys; the video variants differ from the channel ones; the key contains the revision, the window and the period.
- **Real `QueryClient`, with the Stage 5 options:** a lapse longer than 30 minutes (stale time would have expired under the old design) followed by a successful status at the same revision causes **zero** gateway data calls and shows the cached reports; a quota, capacity, rate-limit, permission or not-enabled answer causes exactly one call, also after a simulated network return and after unmounting and remounting the block; Retry causes exactly one.
- **Access lease.** Reports show only within 90 seconds of the **issue** of a successful status; an old status answer arriving after a denial, a hide, an offline period or a channel change is discarded and renews nothing; concurrent visibility, focus and online events produce one status request; a request issued before a hide cannot paint after the resume; failure backs off 5, 15, 45 seconds and honours `retry_after_seconds`; a status in flight when access is withdrawn is applied only up to its issue time.
- **Latch.** After a provider-confirmed `missing_scope` or `reconnect_required`, a same-revision `status` "available" renews the lease, keeps the notice and starts no data request; a new revision, or Retry followed by a success, clears it.
- **Revision and window.** A reconnect that completes between two polls, with no data request in flight, removes the old revision's reports; a block's response with a different window or revision is dropped; the three blocks of one load share one window across a simulated Pacific midnight; `window_stale` shows the refresh message and sends nothing.
- **Scope.** `video_not_found` changes the video panel only.
- **Acceptance panel.** With `consent_required` the reports are not rendered and **no data query is enabled**; the panel names the channel and contains every required element of §7.3 in English and in Arabic (asserted by key, not by wording); "Not now" calls nothing and records nothing; "Allow" sends the displayed version and locale, then `status`, then the reports load; withdrawing asks for confirmation, removes the account's cached reports and shows the panel again; an `outdated` state shows the panel with the new text; **a test fails if any purpose string changes, in either language, without the version constant changing.**
- **Trend.** One point per requested day, `null` where not returned, line broken, no zero, note reads "did not return".

Also Arabic and right-to-left; route and sidebar follow the flag; layering test; the "View analytics" link only with the flag on; a shared request fixture accepted by the Deno handler and sent by the gateway.

### 9.4 Journey with a fake provider (local evidence)

`scripts/stage5-e2e.mjs`, modelled on `scripts/stage4-e2e.mjs`: the disposable database with the Stage 5 migration applied, a local server (`e2e/fixtures/youtubeStage5Server.ts`) composing the **real** handler, the **real refresh helper with the bound store** and the **real SQL functions**, with a fake provider counting requests separately for the token endpoint, the information endpoint and the two YouTube hosts; the app built with its real query client. `e2e/youtube-stage5.spec.ts`, English and Arabic:

1. policy absent → "not switched on"; every provider count zero (steps 2–20 run with the purpose accepted);
2. admitted channel → overview, trend, top videos; counts 3 Analytics, 1 Data;
3. period change → new window and numbers; counts +3, +1;
4. owned video → +2 Analytics, +2 Data; another channel's video ID → "not available on this channel" in the video panel, **channel reports stay**, +0 Analytics, +2 Data;
5. a channel with no data → empty state;
6. a daily answer missing its last two days and one middle day → three breaks, last-returned-day line, "did not return" note;
7. permission refusal → reconnect notice, exactly one request per block, health columns and recorded scopes unchanged, a same-revision status does not clear it, Retry sends one request;
8. quota refusal → one request per block, also across an offline/online cycle and a remount;
9. shared budget exhausted → capacity message, zero provider requests;
10. policy switched off with the page open → reports disappear at the next status check; no further request;
11. status endpoint failing → reports hidden at lease expiry, back when it recovers, **zero data requests on recovery**;
12. a status answer delayed past a withdrawal is discarded;
13. reconnect in a second tab, no request in flight → old reports removed at the next status; a **delete and re-insert of the row with the same id** does the same;
14. reconnect during a pending request → "connection changed", no numbers;
15. **browser disconnect (`is_active = false`) during a token exchange** → the bound store refuses, no token written, "connection changed"; the same with the rollout withdrawn instead → token stored, next attempt refused;
16. title `401` → list without titles, no token request;
17. a window pinned before Pacific midnight and loaded after → all three blocks cover the same dates;
18. channel switched mid-load → nothing of the first channel shown;
19. a second user, channel not in the policy → nothing of the first user's data;
20. flag off, policy on, purpose accepted → a direct call by the owner is served, the page is not reachable;
21. **admitted channel, nothing accepted** → the acceptance panel in place of the reports, in both languages; **every provider count zero**, including for a direct call to `summary`;
22. "Not now" → no acceptance row, no provider request; the panel is still offered on the next visit and nothing nags in between;
23. "Allow" → one `accepted` row with the version and the language shown; the reports load;
24. withdraw with the page open → one `withdrawn` row, reports removed, panel shown, no further provider request; withdraw **during a pending request** → that request's result is discarded;
25. the purpose version is raised → every owner sees the panel again and no report loads until they accept the new text.

The run fails on any unexpected external request. Playwright is not a CI job here (Stage 4 precedent), so this is local evidence recorded in the PR with command, head SHA and result.

### 9.5 What cannot be proven without a real channel

| Unknown | Settled by |
|---|---|
| Which scope set Google accepts for the four shapes. | P1 (§7.2). |
| Token information endpoint behaviour as assumed. | Google's library documentation [D]; P1 itself. |
| The real shape of a permission refusal. | P1, only if one occurs. Otherwise **unverified**. |
| Exhausted quota, "API not enabled", expired token shapes. | **Not rehearsed**; stay unverified; hand-written fixtures; unknown means a temporary failure. |
| Under branch B: that a re-consent leaves a refresh token able to mint analytics-capable tokens; whether `prompt=consent` returns a new refresh token. | The per-connection check (§7.4); P1-c tests sufficiency only. |
| `channel==<ID>` for an account with more than one channel; thresholds for a small channel; how often recent days are missing. | R1, if the pilot allows; otherwise unverified. |
| The real limits of both APIs and the existing features' peak. | The owner, in the Cloud Console. |
| That the numbers match YouTube Studio for the same Pacific range. | R1: the owner compares one period by eye. |
| That the purpose text is adequate under Google's policy and the law that applies to Postora's users. | **Not something this document can verify.** Waleed approves the wording on the merge card; plan step 1 reads Google's III.E.3 word for word. |

**Rehearsal R1**: read-only, the pilot channel, after the first enablement, separately approved. It records only what was observed: blocks loaded, requested window, last returned day, provider counts, the owner's yes or no on the Studio comparison. It does not try to cause errors, writes nothing to YouTube, and records no numbers or Google text.

## 10. Risks and open questions

| # | Risk or question | Handling |
|---|---|---|
| R-1 | The scope question is open until P1, and each part needs approval. | Two branches designed; one constant; **G-P1 blocks the first enablement**. |
| R-2 | Google's policy on stored and derived data and on consent (III.E.2–4) was not read word for word. | Nothing from YouTube is stored or derived; acceptance is collected in the product before any read (§7.3); plan step 1 reads the passages and stops if they require more. |
| R-3 | The acceptance mechanism adds a table, two write operations and a screen to a stage designed as read-only with no table. More to build, review and test in one delivery. | One migration and one PR are kept, because the read path must never exist without the gate (plan §2); the table has no browser access and one writer; scope stated on the owner's card. |
| R-4 | Both Google APIs' limits are unknown; the ceiling caps analytics but reserves nothing for other features. | Per-attempt, fail-closed, Pacific-day ceilings (§5.6); pilot by allowlist; `all` only after readings and a peak review. |
| R-5 | The migration adds a RESTRICTIVE policy on `app_settings` and a column and trigger on `social_accounts`, both shared by every feature. | The policy names two keys only; the suite proves other keys unchanged for every role and rename; the column is nullable with no rewrite; the trigger touches YouTube rows only; snapshot first; the Stage 4 shape has been in production since 2026-11-24. |
| R-6 | The code is useless without the migration, and a merge deploys within two minutes. | Migration before merge. Without the functions every request answers `settings_unavailable` and sends nothing. |
| R-7 | The disclosure and privacy text are inaccurate today and the purpose text must match them. | Two separate corrections; the purpose text is versioned and tied to the policy clause; a changed text asks every owner again (§7.3). |
| R-8 | Branch B: verification, consent for everyone, grants that closing the gate cannot undo. | §7.4; D7. |
| R-9 | Numbers differ from the YouTube Channel page counters and from Studio's local-time view; `views` changed meaning on 30 April 2025 and 16 November 2026. | Source, window, last returned day and time zone stated; one footnote; the sources are never mixed. |
| R-10 | Residuals that no check can close: an attempt already authorized when access is withdrawn; a response whose final decision passed milliseconds earlier; a status answered just after a withdrawal. | Stated in §5.7 and §8; one-event-loop-turn window, no awaited I/O after the decision; audit rows are best-effort evidence; recovery steps in plan §6. |
| R-11 | The access lease blanks a working page when status fails for 90 seconds. | Accepted: hiding private numbers on doubt is the safer failure; reports return with no Google call. |
| R-12 | The consent screen may still be in "Testing". | Owner confirms in the Cloud Console before the pilot. |
| R-13 | A unit debited for an attempt that the decision then refuses is not refunded. | Accepted; it happens only in a withdrawal race. |
| R-14 | The helper-to-SQL composition is proved locally, not in CI. | The PR says so; the SQL functions and the Deno logic are in CI. |

Open question that needs no decision: how many IDs one `videos.list` call accepts (plan step 1).

## 11. Decided, and still open

### Decided by the owner

| # | Question | Decision |
|---|---|---|
| D1 | Which Google permission? | **Probe first.** Add `yt-analytics.readonly` only if a positive test shows it is needed. The probe is a gated step with its own approval when run. |
| D2 | Store, or read on demand? | **Read on demand, store nothing.** |
| D3 | First release | **Channel overview cards, daily trend, top ten videos, and the same cards and trend for one video.** |
| D4 | Periods | **7, 14, 30, 90 days.** |
| D5 | Where | **Analytics menu at `/analytics/youtube`, plus a "View analytics" link from each video on the YouTube Channel page.** |
| D6 | Per-channel switch | **As in Stage 4: a small migration with a policy that hides the key and SQL functions that evaluate it.** The owner chose this with "no table"; that still holds for the switch. The migration also carries the bound wrappers (§5.3), the incarnation column (D11) and, because of D10, one table for acceptance records. |
| D8 | Shared allowance | **1,000 Data API units and 2,000 Analytics request attempts per Pacific day for all users together**, reviewed against the real limits and the existing features' peak before opening to everyone. |
| D9 | CI registration | **Recorded exception:** the test step and the SQL suite are registered in the product PR, with the measurements of plan §4. |
| D10 | How owners agree to the analytics purpose | **In the product, from the start.** No analytics read for any channel, pilot included, before the owner of that channel has accepted the purpose inside Postora. A written agreement outside the app was not chosen. (§7.3) |
| D11 | A non-reusable connection identity | **Yes:** the nullable `binding_incarnation` column and its trigger, in the Stage 5 migration. (§5.2) |

Also settled: the merge needs the owner's card; the migration is applied before the merge, after a production snapshot.

### Still open

| # | Question | When | Options | Recommendation |
|---|---|---|---|---|
| **D7** | Only if P1 concludes branch B: when does **Google's** consent screen start asking for the analytics permission? (§7.4) | Before any branch B code. | **A.** Only for users named in a private scope gate, then everyone after Google approves. **B.** For nobody until Google approves. **C.** For everyone at deploy. | **A** |
| **D12** | How are the isolated probe parts (P1-i, P1-b, P1-c) run? (§7.2) | When one is about to run; P1-i is recommended before implementation. | **A.** A separate test OAuth client and project, a channel Waleed owns. **B.** Postora's production client in the Playground. | **A** |
| **D13** | Does an acceptance survive a reconnect of the same channel by the same owner? (§7.3) | Before the migration is written. | **A.** Yes: it is keyed by owner and channel; disconnecting is not withdrawing. **B.** No: every new connection asks again. | **A** |
| **P1 approvals** | Each part is a real request to Google on the owner's channel. | When each is about to run. | — | Run P1-i before implementation; P1-a after deployment and acceptance. |

Recorded assumptions unless the owner objects: acceptance is given only by the channel's owner in the product, never by an admin on their behalf; declining records nothing; no IP address or user agent is recorded with an acceptance; native connections only; no revenue; no agent, n8n or MCP access; no comparison with the previous period until the Google policy has been read in full.

## 12. Verification performed for this document

- Baseline `main` at `5d020ed`. `git diff --stat f7d49921 5d020ed` over `supabase`, `src`, `scripts` and `.github` is empty: the commits since are documents only, so every code citation at `f7d49921` holds. The manager confirmed on 2026-11-24 that the Stage 4 migration is applied in production and that a real refresh succeeded through the neutral store; this document did not check production.
- Read through `git show` for this revision: `supabase/manual-sql/20260627213616_rate_limit_buckets.sql` (all of `check_rate_limit` and the cleanup); `20261120130000_youtube_refresh_lease_fixes.sql:60-200` and `:370-430` (lease acquisition, credential-change trigger); `20261120110000_youtube_refresh_lease.sql:136`; the Stage 4 migration's neutral store and ownership grants (`:196-330`), trigger (`:374-440`); `supabase/tests/youtube_comment_operations.sql:366-402` (the narrow-role pins); `_shared/youtubeTokenRefresh.ts` (the account read, `resolveFromFreshRead`, the transient-failure and tail paths, `:540-600`, `:828-1000`); `supabase/tests/baseline_schema.sql` (`social_accounts` definition and policies, `check_rate_limit`, `rate_limit_buckets`); `src/pages/Privacy.tsx`; `AGENTS.md` (rule 4). Earlier lists in §13–14 still apply.
- Google and other pages: those linked in §3 and §7, fetched on 2026-11-23 (**[V]**); marked **[D]** where the plan debate verified a fact and this document did not re-fetch it (the token information endpoint, the top-videos general limit, the `videoNotFound` error, the quota-pool description, Analytics storage rules); PostgreSQL Read Committed read on 2026-11-24 (**[V]**); the web-server flow's `include_granted_scopes` and "only returned on the first authorization" sentences (**[V]**).
- **Not verified:** everything **[S]**, including the passage of III.E.3 that the debate cites for re-acceptance; the sensitivity of either scope; both APIs' real limits and the existing features' peak; the Analytics error shapes; whether `prompt=consent` returns a new refresh token; whether a re-consent leaves a refresh token able to mint the new scope; whether `check_rate_limit` and its cleanup behave in production as in the baseline; the maximum IDs per `videos.list`; the exact TanStack Query option names; what each affected user accepted; production state other than what the manager reported.
- Not done, by instruction: code, migration, branch, commit, PR, production access, any call to a Google API.

## 13. Review rounds 1 and 2 (condensed)

Round 1 (33 comments on PR #472) and round 2 (21 comments, issue #473) produced the design points below. They are listed once, with where the current text answers them; rounds 1–2 changed no verdict later reversed except where round 3 says so.

| Finding | Answered in |
|---|---|
| Probe used recorded grants; exported Google text; consent for everyone at deploy (round 1); effective scopes unobservable in neutral mode; no pre-pilot gate; pilot grants becoming mandatory (round 2) | §7.2, §7.4 (rewritten in round 3) |
| Refresh and reads not bound to the connection; final recheck; cached reports tied to the connection | §5.2–5.4, §5.7 (redesigned in round 3) |
| Ownership lookup before a token; lookup failure shown as a missing video; `video_not_found` clearing the account | §5.4 |
| Row validation, video-ID format, one top-videos metric list, requested date shown as coverage | §5.4, §5.5, §5.8 |
| Per-user limits do not protect shared quota; per-attempt debit; ceilings reserve nothing | §5.6 |
| Withdrawal and loaded reports; failed status; retry and refetch; status polling undoing refusals | §5.7 (extended in round 3) |
| Unbounded audit writes; no-store; flag does not gate access; merge gate; CI rule; disclosure rollback | §6, §8, plan §§1, 4, 6 |
| Tests with impossible provider counts; rehearsal cannot observe error shapes | §5.4 table, §9.5 |

## 14. Review round 3 and debate

The plan debate (Codex, one round; verdict **proceed after changes**, seven blocking objections) and a third automated review (32 comments on PR #474) arrived together. The owner's decisions arrived in round 2 and are unchanged.

### The seven blocking objections

| # | Objection | Resolution | Where |
|---|---|---|---|
| 1 | Refresh can lease a replacement connection or store on a withdrawn one; replacing `readAccount` is not enough | **Resolved.** Two bound wrappers around the existing lease functions: account row `FOR UPDATE`, then the full decision, then the unchanged shared function; the neutral store is called under the same lock. No Google I/O under a lock. Shared functions, the Stage 4 neutral store, the refresh helper and every other caller are untouched; no fourth trusted writer. Persistence is bound to the connection, deliberately not to the rollout. | §5.3, §9.2 |
| 2 | Generation restarts at 1 for a re-inserted row | **Resolved; the owner decided D11 = yes.** The insert policy and grants leave `id` client-settable, so reuse cannot be proved impossible. A nullable `binding_incarnation`, trigger-assigned and never client-writable, joins every identity comparison and `connection_revision`. | §5.2, §9.2 |
| 3 | Final check incomplete; "zero requests after withdrawal" too wide | **Resolved.** One SQL statement returns a typed reason in a fixed order, covering owner, binding, provider, rollout, health and scopes; it runs at admission, at credential release, before **every** Google attempt (after the debit) and as the last step before a response. The residual is stated: an attempt already authorized is in flight; no awaited I/O follows the final decision. | §5.2, §5.4, §8, R-10 |
| 4 | Branch B circular; closing the gate does not undo a grant | **Resolved.** P1-c runs in an isolated, separately approved setting that does not use Postora's connect flow; P1-a eligibility and refusal rules; grants verified per connection; rollback no longer claims to restore the grant state. | §7.2, §7.4, D12 |
| 5 | Disclosure text does not cover user consent to the new purpose | **Resolved; the owner decided D10 = in-app acceptance from the start.** An acceptance record, a `consent_required` reason inside the one decision, an acceptance panel before the first view, and withdrawal. | §7.3, §5.2, §9 |
| 6 | The 24-hour limiter window can spend twice the ceiling; a lost row must refuse | **Resolved.** Budgets are keyed by Pacific date with a 48-hour window; a debit counts only with `allowed` and `count ≥ 1`; tests against the real RPC for exhaustion, both daylight-saving changes and cleanup. | §5.6, §9.2 |
| 7 | Query keys identical across operations; lease renewal can restart reports | **Resolved.** Namespace and operation in every key; display and fetching are separate decisions; queries never depend on the lease and never auto-refetch; status is single-flight with epoch, deadline, backoff and `Retry-After`; resume requires a status issued after it. | §5.7, §9.3 |

Non-blocking points taken in: the `app_settings` policy tests (admin through `authenticated`, renames into and out of the keys); discriminating snapshot and provider-count tests with the token state pinned and the title `401` row; explicit release checkpoints (deployment evidence, matching SHA, smoke test on the deployed route); audit rows treated as partial evidence; Google corrections (the top-videos limit, the quota-pool description, `videos.list` ID limits, `videoNotFound`).

### The automated comments that were not duplicates of the debate

| Comment (reviewer's label) | Verdict | Where |
|---|---|---|
| Probe assumes the consent change it gates; P1-c needs a grant the flow cannot request (HIGH, several) | Real; = objection 4 | §7.2 |
| Partial grant cannot establish that the analytics scope is needed (HIGH) | Real | §7.2: a refusal counts toward branch B only with all three existing scopes |
| Scope gate proves only the simplest report (MEDIUM) | Real | §7.2: the probe sends the four shipped shapes |
| Branch B omits consent from credential and final checks (HIGH, several) | Real | §7.4: the scope-gate rule lives in the one `decide` |
| First-pilot verification leaves later reconnects unverified (MEDIUM) | Real | §7.4: per-connection check; `grant_not_effective` at run time |
| Binding not rechecked before provider dispatch (MEDIUM) | Real | §5.4 step 8 |
| Bound refresh reads omit account health (MEDIUM) | Real | `decide` returns `needs_reauth`; bound read passes it to the helper |
| Boolean admission result loses the reason (MEDIUM, several) | Real | One typed decision, fixed order |
| Title lookup has conflicting 401 and failure rules (MEDIUM, several) | Real | Title lookup is exempt; table rows 20–21 |
| Quota debit can report success without charging (MEDIUM) | Real | A debit needs `count ≥ 1` |
| Period length does not identify requested dates (MEDIUM) | Real | Server-pinned `window_end` in every key and request |
| Access lease has no stale-status guard (MEDIUM) | Real | Epoch and issue-time lease clock |
| Status polling can undo provider-confirmed denials (MEDIUM, several) | Real | Latch to the revision |
| Preserve bounded logging for admission refusals (P1, AGENTS.md rule 4) | Real | §6 rule 7: one row per user per minute |
| Recheck admission before `status` returns, or state the residual (Minor) | Real, residual stated | §5.7 table, R-10; the lease starts at issue |
| Refresh-race test assumes disconnect invalidates the lease (MEDIUM, several) | Real | Both disconnect paths tested; the browser path is fenced by the bound store (§9.1, §9.4 step 15) |

All were judged real; none was rejected. Two are answered by a stated residual rather than a guarantee: the `status` response decided just before a withdrawal, and the attempt already authorized when access is withdrawn.

### Fourth revision: decisions D10 and D11

After the third revision the owner answered the two open decisions. **D11: yes** — the incarnation column is now unconditional. **D10: an in-app mechanism from the start**, not the written agreement this document had recommended. What changed: a new §7.3 (the record, the enforcement, the panel, withdrawal, the tie to the policy text); `consent_required` as the fifth reason of `decide` (§5.2); two acceptance operations on the edge function (§5.4); one table in the migration, stated plainly against D6's "no table"; P1-a moved after deployment and acceptance, because a production probe is a read like any other (§7.2); gate G-consent replaced by the product itself; `mode: "all"` no longer waits for a separate mechanism (§8); branch B's key renamed to `youtube_analytics_stage5_scope_gate` so that Google's permission and the owner's acceptance are never called by the same word (§7, §7.4). One new open decision, D13.
