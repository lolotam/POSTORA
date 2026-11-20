# YouTube stage 2: resource browse, details and capability contracts — specification

Date: 2026-11-20. Status: proposal for owner review, nothing implemented. Tier of this document: LIGHT (docs only).

Parent documents (not on `main`; read them with `git show`):

- Plan: `git show 72844bd3:docs/plans/2026-11-03-youtube-integration-completion.md`, section "2. Add resource browse/details and capability contracts".
- Specification: `git show 72844bd3:docs/specs/2026-11-03-youtube-integration-completion.md`.
- Report: `git show 72844bd3:docs/reports/2026-11-03-youtube-approval-readiness-saad.md`.

Implementation plan for this specification: `docs/plans/2026-11-20-youtube-stage2-resource-browse.md`.

Every recommendation marked "(recommended)" is a proposal. The open choices are collected in [Decisions needed from Waleed](#decisions-needed-from-waleed). The plan is written against the recommended options and names the tasks that change when another option is picked.

## 1. Goal and non-goals

### Goal

Give the owner of a connected YouTube channel three things that do not exist today:

1. A **capability contract**: one server answer per account that says what Postora may show or do for it (scopes recorded, browse, upload, comments, the quota policy), so the UI stops guessing from raw `account_metadata`.
2. A **resource browse and details API**: channel details, a paginated list of the channel's uploads, and details of one video, each bound to the authenticated owner and the account.
3. A **real page** that consumes both: account selection, channel summary, video library and video details, with distinct loading, empty, denied, reconnect, quota and failure states.

### Non-goals

- No write to YouTube. `videos.update`, comment creation, moderation and thumbnails belong to stages 3 and 4 of the parent plan.
- No YouTube Analytics reports (stage 5, owned by another workstream).
- No change to publishing, to the comment manager, to the comment poller or to stage 1 (OAuth attempts, refresh lease, disconnect).
- No `search.list` call. It has its own 100-call daily bucket and is never needed to list a channel's own uploads.
- No database migration under the recommended options.
- No live Google call in any automated test.

## 2. Verified current state

Verified by reading `origin/main` at `546b88ac` on 2026-11-20.

| Fact | Evidence |
|---|---|
| Stage 1 is merged: attempt-based OAuth state, provider-aware disconnect, DB refresh lease | `supabase/functions/youtube-oauth/handler.ts` (`createYouTubeOAuthHandler`), `supabase/functions/youtube-oauth/revoke.ts`, `supabase/functions/_shared/youtubeTokenRefresh.ts` |
| A native access token is obtained through one function | `refreshYouTubeAccountToken(options)` in `_shared/youtubeTokenRefresh.ts`; the service-role store is `createSupabaseYouTubeRefreshStore(admin: unknown)` in the same file |
| Native OAuth requests three scopes | `handler.ts`: `youtube.readonly`, `youtube.upload`, `youtube.force-ssl` |
| Granted scopes are recorded in `social_accounts.account_metadata.granted_scopes` | `_shared/youtubeGrantedScopes.ts` (`recordGrantedScopes`, `dropGrantedScope`); read by `grantedScopes(metadata)` in `_shared/youtubeCommentCapability.ts` |
| Older rows have no recorded scopes | Comment in `_shared/youtubeCommentCapability.ts`: "Older rows carry `{}` and must reconnect" |
| The only capability function today is for comments | `youtubeCommentCapability(account)` returns `"capable"` or `"reconnect_required"`; a Composio row is `"capable"` by construction |
| There is no channel details call after connection | `youtube-oauth/index.ts` calls `channels?part=snippet&mine=true` once, during `google.complete` |
| The only video listing is a comment-manager helper | `listChannelVideos` in `_shared/youtubeComments.ts`: one page of 25, no page token, title and date only |
| That helper is not a base for a browse API | `_shared/youtubeComments.ts` starts with `/* eslint-disable @typescript-eslint/no-explicit-any */`, returns Google's own `error.message` to the caller, drops the `force-ssl` scope on any `insufficientPermissions`, and routes Composio rows |
| Google errors are already classified | `classifyGoogleError(status, body)` in `_shared/youtubeApiErrors.ts` returns `scope_missing`, `quota`, `unauthorized`, `not_found`, `forbidden` or `upstream` |
| The comment poller spends from the same Google project quota | `supabase/functions/youtube-poll-comments/poll.ts` calls `listThreads` once per eligible channel per run; `CLAUDE.md` lists the cron as every 5 minutes |
| There is no quota counter for YouTube anywhere in the repository | `git grep -n quota supabase/functions/_shared/youtube*.ts` finds only the error class and comments |
| A per-user rate limiter exists in the code | `checkUserRateLimit(supabaseAdmin, endpoint, userId, maxRequests, windowSeconds)` in `_shared/rate-limiter.ts` calls the SQL function `check_rate_limit`. It answers `allowed: true` when the RPC fails (fail open). `_shared/aiImageAtlasRoute.ts` already uses it |
| That SQL function is not in `supabase/migrations/` | It is defined in `supabase/manual-sql/20260627213616_rate_limit_buckets.sql` (manual execution, per `docs/security/audit-2026-06.md`). It is a fixed window that starts at the caller's first request and returns `retry_after` in seconds. Whether it is present in production was **not** checked for this document; the 2b rollout checks it |
| The limiter's TypeScript type and its SQL disagree on one key | The SQL returns `retry_after`; `RpcRateLimitResult` declares `retryAfter` and the helper only casts, so `retryAfter` can be `undefined` at runtime. Stage 2 reads the result defensively and does not change the shared helper; the mismatch is reported to the owner as a possible follow-up |
| Edge workers are short-lived | `docs/runbooks/deploy-edge-function.md`: `workerTimeoutMs` is 150 s and a worker serves several requests in that lifetime. Server memory is therefore not a dependable cache |
| A merge to `main` deploys edge functions within about two minutes | `docs/runbooks/deploy-edge-function.md`, "Automatic deploy (Dokploy Schedule)". The schedule sends `OPTIONS` to each changed function to prove it boots |
| The reference frontend feature layout | `src/features/instagram-insights/{domain,application,infrastructure,ui,tests}` with `index.ts`, consumed by `src/pages/analytics/InstagramAnalytics.tsx` |
| A frontend feature may share one contract file with its edge function | `src/features/instagram-insights/domain/types.ts` re-exports from `supabase/functions/instagram-insights-report/contracts.ts`, which is runtime-neutral |
| Feature flags default from code when the database has no row | `src/hooks/useFeatureFlags.tsx`: `globalFlagMap[key] ?? DEFAULT_FLAGS.<name>`; the admin page upserts into `app_settings` (`src/pages/admin/AdminFeatureFlags.tsx`) |
| `system_logs.category` is constrained | `supabase/migrations/20260928120000_store_events_worker.sql` adds `system_logs_category_check` with eleven allowed values; `oauth` is not one of them. `youtube-oauth/index.ts` inserts refusal rows with `category: "oauth"` and does not read the returned error. Whether production rejects those rows was **not** checked; it is reported to the owner as a possible stage 1 follow-up and is outside this stage |
| Routes and the sidebar | `src/components/AnimatedRoutes.tsx` (`lazyWithRetry`, `ProtectedRoute`, `AnimatedPage`); `src/components/layout/DashboardLayout.tsx` (`navEntries`, namespace `nav`) |

Not verified in this document: runtime state of production (deployed hashes, flag rows, the Google Cloud Console quota allocation).

## 3. Design

### 3.1 Shape

One new edge function, `supabase/functions/youtube-resources/`, and one new frontend feature, `src/features/youtube-management/`.

```text
browser page  ->  feature ui  ->  application hooks  ->  gateway (infrastructure)
                                                          |
                                         POST /functions/v1/youtube-resources
                                                          |
index.ts (adapter: CORS, wiring)  ->  handler.ts (auth, validation, use cases, error mapping)
                                          |                 |                    |
                                  accounts port      tokens port          youtube port
                                (service role,     (refreshYouTube-    (youtubeReadClient.ts:
                                 owner filter)      AccountToken)       typed, native, read only)
```

Files of the edge function:

| File | Responsibility |
|---|---|
| `contracts.ts` | The single contract: request and response types, error codes, HTTP status per code, policy numbers. Runtime-neutral (no Deno API, no import). The frontend imports its types from here |
| `capabilities.ts` | Pure function `deriveYouTubeCapabilities(account)` |
| `youtubeReadClient.ts` | Typed native Data API reads with timeout, response validation and stable error mapping. It never routes Composio and never mutates account metadata |
| `handler.ts` | `createYouTubeResourcesHandler(ports)`: CORS, method, authentication, Zod validation, ownership, use cases, response mapping. All I/O is behind ports |
| `index.ts` | Builds the ports from the service-role client and serves the handler. Contains no business rule |

The browse API does **not** reuse `callYouTube` or `listChannelVideos` from `_shared/youtubeComments.ts`, for the four reasons in the table above.

### 3.2 Endpoint

`POST /functions/v1/youtube-resources` with a JSON body discriminated on `operation`. Any other method than `POST` and `OPTIONS` is refused with `method_not_allowed`.

Authentication: a user JWT in the `Authorization` header, validated by `authenticateCaller(req)` from `_shared/auth-helper.ts`. The function never passes a body `user_id` to it, so a service-role bearer is always refused (the helper throws when a service-role call carries no `user_id`). Every request schema is strict, so a body that contains `user_id` or any other unknown key is refused with `invalid_request`.

Request schemas (Zod, in `handler.ts`):

```ts
const AccountId = z.string().uuid();

const CapabilitiesRequest = z.object({
  operation: z.literal("capabilities"),
  account_id: AccountId,
}).strict();

const ChannelRequest = z.object({
  operation: z.literal("channel"),
  account_id: AccountId,
}).strict();

const VideosRequest = z.object({
  operation: z.literal("videos"),
  account_id: AccountId,
  page_size: z.number().int().min(1).max(50).optional(),   // default 25
  page_token: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
}).strict();

const VideoRequest = z.object({
  operation: z.literal("video"),
  account_id: AccountId,
  video_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
}).strict();

const RequestSchema = z.discriminatedUnion("operation", [
  CapabilitiesRequest, ChannelRequest, VideosRequest, VideoRequest,
]);
```

Success envelope (every operation):

```ts
interface YouTubeResourceSuccess<T> {
  schema_version: 1;
  request_id: string;                       // UUID minted per request
  freshness: {
    fetched_at: string;                     // ISO 8601, server clock
    source: "database" | "provider";        // "database" for capabilities, "provider" otherwise
  };
  data: T;
}
```

Error envelope (every refusal):

```ts
interface YouTubeResourceFailure {
  error: YouTubeResourceErrorCode;          // stable code, never provider text
  request_id: string;
  retry_after_seconds?: number;             // only with rate_limited
}
```

`error` is a string so the existing helper `invokeErrorMessage` (`src/lib/functionInvokeError.ts`) keeps working for any caller that does not know the feature.

### 3.3 Capability contract (stage 2a)

Operation `capabilities` reads one `social_accounts` row and calls no provider. It costs zero Google quota units and is not rate limited.

```ts
type YouTubeScopeState = "granted" | "missing" | "unknown";

type YouTubeCapabilityReason =
  | "reconnect_required"
  | "missing_scope"
  | "provider_unsupported";

type YouTubeCapabilityState =
  | { state: "available" }
  | { state: "unknown" }
  | { state: "unavailable"; reason: YouTubeCapabilityReason };

interface YouTubeAccountCapabilities {
  account_id: string;
  channel_id: string | null;                // social_accounts.platform_user_id
  channel_title: string | null;             // social_accounts.platform_username
  provider: "native" | "composio";
  connection: "ok" | "reconnect_required";
  scopes: {
    readonly: YouTubeScopeState;            // https://www.googleapis.com/auth/youtube.readonly
    upload: YouTubeScopeState;              // https://www.googleapis.com/auth/youtube.upload
    force_ssl: YouTubeScopeState;           // https://www.googleapis.com/auth/youtube.force-ssl
  };
  capabilities: {
    browse: YouTubeCapabilityState;
    upload: YouTubeCapabilityState;
    comments: YouTubeCapabilityState;
  };
  quota: {
    provider_quota: "not_tracked";          // Postora keeps no counter of Google units
    unit_costs: { channel: 1; videos_page: 1; video: 1 };
    per_user_burst: { limit: 30; window_seconds: 600 };
    per_user_daily: { limit: 300; window_seconds: 86400 };
  };
}
```

Derivation rules, in this order:

1. `provider` is `"composio"` when `auth_provider === "composio"`, otherwise `"native"` (a null `auth_provider` is native, as in `youtube-oauth/index.ts`).
2. `connection` is `"reconnect_required"` when `needs_reauth === true`, or when a native row has neither an access token nor a refresh token. Otherwise `"ok"`.
3. `scopes`: the recorded list is `grantedScopes(account_metadata)`. For a Composio row, and for a native row whose recorded list is empty, all three are `"unknown"`. Otherwise each is `"granted"` when its full URL is in the list and `"missing"` when it is not.
4. `capabilities.browse`: Composio gives `unavailable/provider_unsupported`; `connection` not ok gives `unavailable/reconnect_required`; `readonly` granted gives `available`; `readonly` unknown gives `unknown`; `readonly` missing gives `unavailable/missing_scope`.
5. `capabilities.upload`: `connection` not ok gives `unavailable/reconnect_required`; Composio gives `unknown` (the parent specification forbids presenting an unverified managed-provider capability as available); `upload` or `force_ssl` granted gives `available`; scopes unknown gives `unknown`; otherwise `unavailable/missing_scope`.
6. `capabilities.comments`: `connection` not ok gives `unavailable/reconnect_required`; otherwise it mirrors the existing function exactly: `youtubeCommentCapability(account) === "capable"` gives `available`, anything else gives `unavailable/missing_scope`. No second rule for comments is introduced.

`unknown` is a real third state, not a synonym of unavailable. Stage 2 does not change publishing or the comment manager, so a row whose scopes were never recorded keeps working exactly as today. Its browse behaviour under `unknown` is decision D5.

Which scopes Google accepts for `channels.list`, `playlistItems.list` and `videos.list` is **not stated on the official pages fetched for this document** (section 9). The contract uses `youtube.readonly` because the parent specification names it for every read. Google's own `403 insufficientPermissions` stays the final authority and is mapped to `missing_scope`.

### 3.4 Resource operations (stage 2b)

Common rules for `channel`, `videos` and `video`:

1. The account is loaded with the service-role client and the filter `id = account_id AND user_id = <caller> AND platform = 'youtube' AND is_active = true`. No row means `not_found`. The status and the body are the same for an unknown ID, another user's ID, a non-YouTube account and an inactive account (only `request_id` differs between two requests), so IDs cannot be enumerated.
2. A Composio row owned by the caller gives `provider_unsupported` (decision D3). It is the caller's own account, so the specific code leaks nothing.
3. `capabilities.browse` is derived. `unavailable/reconnect_required` gives `reconnect_required`; `unavailable/missing_scope` gives `missing_scope`. Both happen before any provider call. `unknown` proceeds (decision D5). A row with no stored channel ID gives `reconnect_required`.
4. The per-user rate limit is checked (section 5). A refusal gives `rate_limited`.
5. The access token comes from the tokens port, which is `refreshYouTubeAccountToken` with the loaded row as the snapshot and `createSupabaseYouTubeRefreshStore(admin)` as the store. The handler never reads Google's token endpoint itself.
6. One provider request is sent with a 15 second timeout. On HTTP 401, when the token was not minted by this request, the token is refreshed once with `force: true` and the same request is sent once more. A second 401 gives `reconnect_required`. There is no other retry.
7. The provider answer is validated with Zod and mapped to the DTO below. A body that does not match gives `upstream_unavailable`. A failed read is never returned as an empty success.
8. No identifier that selects a Google resource owner comes from the browser: the channel ID and the uploads playlist ID are derived from the owned row.

#### `channel`

Google call: `GET https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,status&mine=true&maxResults=50` (parent specification: "channels.list with mine"). The parent also lists the `contentDetails` part; it is left out because nothing in stage 2 reads it and the uploads playlist is derived without it. The item whose `id` equals the row's `platform_user_id` is used. When no such item is returned, the answer is `reconnect_required`, because the stored grant no longer covers the stored channel.

```ts
interface YouTubeChannelDetails {
  id: string;
  title: string;
  description: string;
  custom_url: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  country: string | null;
  privacy_status: string | null;
  statistics: {
    view_count: number | null;
    subscriber_count: number | null;        // null when subscriber_count_hidden is true
    subscriber_count_hidden: boolean;
    video_count: number | null;
  };
}
```

#### `videos`

Google call: `GET .../playlistItems?part=snippet,contentDetails,status&playlistId=<uploads>&maxResults=<page_size>[&pageToken=<page_token>]`. The uploads playlist ID comes from `uploadsPlaylistId(platform_user_id)`, the function the comment manager already uses in `_shared/youtubeComments.ts` (the `UC` to `UU` convention; it is a repository convention in production since September 2026 and is not stated on the fetched official pages).

```ts
interface YouTubeVideoListItem {
  id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  privacy_status: string | null;
  url: string;                              // https://www.youtube.com/watch?v=<id>
}

interface YouTubeVideosPage {
  items: YouTubeVideoListItem[];
  next_page_token: string | null;
  total_results: number | null;
}
```

Pagination: `page_size` defaults to 25 and is capped at 50 (Google's documented maximum for `maxResults`). `next_page_token` is Google's `nextPageToken`, passed through as an opaque string. It is safe to pass through because the playlist ID is always derived from the owned row: a token copied from another account can only page the caller's own uploads or be rejected by Google. When a `page_token` was sent and Google answers HTTP 400, the code is `invalid_cursor`. Items without a video ID are dropped.

A list page deliberately carries no duration and no statistics: those need a second call (`videos.list`), which would double the cost of every page (decision D2).

#### `video`

Google call: `GET .../videos?part=snippet,contentDetails,statistics,status&id=<video_id>`.

Ownership rule: the video is accepted only when `snippet.channelId` equals the row's `platform_user_id`. An empty `items` array and a video of another channel give the same `not_found`, so the endpoint cannot be used to look up arbitrary videos.

```ts
interface YouTubeVideoDetails {
  id: string;
  channel_id: string;
  title: string;
  description: string;
  thumbnail_url: string | null;
  published_at: string | null;
  tags: string[];
  category_id: string | null;
  default_language: string | null;
  duration_iso8601: string | null;          // e.g. "PT4M13S", not parsed server side
  privacy_status: string | null;
  upload_status: string | null;
  made_for_kids: boolean | null;
  statistics: {
    view_count: number | null;
    like_count: number | null;
    comment_count: number | null;
  };
  url: string;
}
```

The Google field names behind these DTOs (`snippet.customUrl`, `statistics.hiddenSubscriberCount`, `contentDetails.duration`, `status.madeForKids`, `pageInfo.totalResults` and the rest) come from Google's resource representations and were **not** re-read for this document. Every provider field is optional in the Zod schemas, so a renamed field degrades to `null` instead of failing the request. The implementer re-checks them against the resource pages listed in section 9 before the read client merges.

Statistics shown here are Data API counters. The UI must not label them as watch time, retention or any Analytics report (parent specification).

## 4. Error taxonomy

Stable codes. The response never contains Google's message, a token, a SQL fragment or a table name.

| Code | HTTP | When |
|---|---|---|
| `invalid_request` | 400 | Body is not JSON, fails the schema, or carries an unknown key |
| `invalid_cursor` | 400 | Google refused a request that carried a `page_token` with HTTP 400 |
| `unauthorized` | 401 | Missing, invalid or service-role bearer |
| `missing_scope` | 403 | Recorded scopes exclude `youtube.readonly`, or Google answered `insufficientPermissions` |
| `not_found` | 404 | Account not owned, not YouTube, inactive or absent; video absent or of another channel; Google 404; Google 403 that is not a scope or quota error |
| `method_not_allowed` | 405 | Any method other than `POST` and `OPTIONS` |
| `provider_unsupported` | 409 | The caller's own account is Composio-managed and the operation is a native read |
| `reconnect_required` | 409 | `needs_reauth`, no refresh token, a second 401 after a forced refresh, or the grant no longer covers the stored channel |
| `rate_limited` | 429 | Postora's own per-user limit. Carries `retry_after_seconds` |
| `quota_exceeded` | 429 | Google answered with a quota reason or HTTP 429 |
| `upstream_unavailable` | 502 | Timeout, network failure, Google 5xx, unclassified Google error, invalid provider body, or a token refresh that is temporarily refused |
| `internal_error` | 500 | A database read failed or an unexpected exception was caught |

Mapping from `classifyGoogleError`: `scope_missing` to `missing_scope`, `quota` to `quota_exceeded`, `unauthorized` to `reconnect_required` (only after the single forced refresh), `not_found` and `forbidden` to `not_found`, `upstream` to `upstream_unavailable`. The parent specification treats forbidden and not-found as one class; this document keeps that.

Mapping from `refreshYouTubeAccountToken`: status `needs_reauth` or reason `no_refresh_token` to `reconnect_required`; `retryable_refusal` and `failed` to `upstream_unavailable`.

`conflict` and `indeterminate` from the parent taxonomy belong to writes and are not emitted in stage 2.

Every refusal that happens after authentication writes one sanitised row through the log port; `method_not_allowed` and `unauthorized` are not written, so an anonymous caller cannot fill the table. The row goes to `system_logs` with category `edge`, source `youtube-resources` and metadata `{ operation, code, request_id, account_id }`. The category must be one the table accepts: migration `20260928120000_store_events_worker.sql` restricts it to `auth`, `edge`, `database`, `token`, `post`, `system`, `ai`, `scheduler`, `webhook`, `payment`, `media`. The adapter checks the insert's returned `error` and reports a failed write with `console.warn`; a failure of the log write never changes the response.

## 5. Caching and quota budget

### 5.1 Official numbers

All retrieved on 2026-11-20 from the pages in section 9.

| Fact | Value | Source |
|---|---|---|
| `channels.list` | 1 unit | `determine_quota_cost`, `docs/channels/list` |
| `playlistItems.list` | 1 unit | `determine_quota_cost`, `docs/playlistItems/list` |
| `videos.list` | 1 unit, flat (the page states no dependence on `part`) | `determine_quota_cost`, `docs/videos/list` |
| `playlists.list` | 1 unit | `determine_quota_cost`, `docs/playlists/list` |
| `commentThreads.list` | 1 unit | `determine_quota_cost` |
| `videos.update` | 50 units | `determine_quota_cost` |
| `search.list` | own bucket: 100 calls per day, 1 per call | `determine_quota_cost` |
| `videos.insert` | own bucket: 100 calls per day, 1 per call | `determine_quota_cost` |
| Default allocation for all other endpoints | 10,000 units per day combined ("subject to change") | `determine_quota_cost`, `getting-started` |
| Each further page of a list | costs the call again | `determine_quota_cost` |
| An invalid request | costs at least one unit | `determine_quota_cost`, `getting-started` |
| Daily reset | midnight Pacific Time | `determine_quota_cost` |
| `maxResults` for `playlistItems.list` | 0 to 50, default 5 | `docs/playlistItems/list` |

Unverified, and marked as such wherever it is used:

- **Postora's real allocation.** 10,000 is Google's documented default, not a reading of the Google Cloud Console. The owner supplies the real number (parent plan stage 6).
- **The maximum number of IDs in one `videos.list` call.** The fetched page gives none. Stage 2 never sends more than one ID.
- **Which OAuth scopes authorise the three read methods.** See section 3.3.

### 5.2 What stage 2 spends

| Action | Provider calls | Units |
|---|---|---|
| `capabilities` | none | 0 |
| Open the workspace for one account (`channel` + first `videos` page) | 2 | 2 |
| Each further page of videos | 1 | 1 |
| Open one video's details | 1 | 1 |
| A typical session: open, two more pages, three details | 6 | 6 |

Against the documented default of 10,000 units, and ignoring every other consumer, that is about 1,600 typical sessions per day.

The existing consumer in the same bucket is the comment poller: every 5 minutes is 288 runs per day, and each eligible channel costs at least 1 unit per run (`commentThreads.list`), so at least 288 units per pollable channel per day. Ten pollable channels are at least 2,880 units, which leaves about 7,100 of the default for everything else. This document does not change the poller.

### 5.3 Guard (recommended option, decision D4)

1. **Validate before calling.** An invalid request costs a unit at Google, so the schema and the ownership check run first. A refused request reaches no provider.
2. **Per-user rate limit** on the three provider operations, through the existing `checkUserRateLimit`: 30 requests per 600 seconds (endpoint key `youtube-resources:burst`) and 300 requests per 86,400 seconds (endpoint key `youtube-resources:day`). One request is one unit, so one user can spend at most 300 units per day, 3% of the documented default. The helper fails open when its RPC errors; that is accepted because the limit is a budget guard, not a security boundary (ownership is enforced separately). The window is fixed, not sliding: it starts at the user's first request and the counter resets when it ends.
3. **No polling, no background refresh.** The feature only calls Google on a user action.
4. **Honest quota errors.** When Google refuses for quota, the answer is `quota_exceeded` and the UI says the limit resets at midnight Pacific Time. Nothing is retried.

Worst case under this guard: 20 users each exhausting their daily limit spend 6,000 units. That is why the page ships behind a feature flag that is off by default (decision D6) and is widened deliberately.

### 5.4 Caching

- **Server: none.** A worker lives at most 150 seconds, so memory is not a cache. A database cache needs a migration and a retention answer for stored YouTube API data, which is an open decision of the parent specification (decision D1).
- **Client: React Query, in memory only.** `staleTime` 5 minutes for channel, video pages and video details; 60 seconds for capabilities. `refetchOnWindowFocus` false. No `refetchInterval`. Every query key contains the user ID and the account ID, and no query uses `placeholderData` from a previous key, so switching account can never display the previous account's data. A visible "Refresh" control invalidates the selected account's queries; it spends units and is subject to the rate limit.

## 6. Frontend structure

```text
src/features/youtube-management/
├── domain/
│   ├── types.ts                 re-exports the contract types from supabase/functions/youtube-resources/contracts.ts
│   ├── errors.ts                YouTubeResourceError (carries the stable code), isRetryableYouTubeError
│   └── accountOptions.ts        toYouTubeAccountOptions (pure)
├── application/
│   ├── ports.ts                 YouTubeResourcesGateway
│   ├── queryKeys.ts             query key builder, stale times, retry rule
│   ├── useYouTubeCapabilities.ts
│   ├── useYouTubeChannel.ts
│   ├── useYouTubeVideos.ts      useInfiniteQuery over next_page_token
│   └── useYouTubeVideo.ts
├── infrastructure/
│   └── supabaseYouTubeResourcesGateway.ts   the only file that imports the Supabase client
├── ui/
│   ├── YouTubeManagementScreen.tsx          the only ui file that imports infrastructure (default wiring)
│   ├── YouTubeAccountPicker.tsx
│   ├── YouTubeChannelSummary.tsx
│   ├── YouTubeVideoLibrary.tsx
│   ├── YouTubeVideoDetail.tsx
│   └── YouTubeResourceNotice.tsx            one component for denied, reconnect, quota, rate limit, failure
├── tests/
│   └── architecture.test.ts                 same three checks as instagram-insights
└── index.ts
```

Dependency direction follows ARCHITECTURE.md §4: `ui -> application -> domain`, `infrastructure -> application ports and domain`. The screen receives the gateway as an optional prop with the Supabase gateway as the default, which is how `InstagramPerformanceScreen` is wired.

Real consumer (ARCHITECTURE.md §1, zero dead modules):

- Page `src/pages/youtube/YouTubeManagementPage.tsx` renders `DashboardLayout` and `YouTubeManagementScreen`. It reads accounts with the existing `useSocialAccounts()` hook and passes the YouTube ones to the screen, so the feature itself imports no legacy hook.
- Route `/youtube` in `src/components/AnimatedRoutes.tsx`, wrapped in `ProtectedRoute` and `AnimatedPage`, loaded with `lazyWithRetry`.
- Sidebar entry in `src/components/layout/DashboardLayout.tsx`, shown when the flag `youtubeManagement` is on (decision D6). With the flag off the page itself redirects to `/dashboard`.

Screen behaviour:

- No YouTube account: an empty state with a link to `/profiles`.
- Account picker lists the user's YouTube accounts. Changing it clears the selected video and the loaded pages.
- Capabilities load first. When `browse` is `unavailable`, the provider operations are not called and the notice explains the reason (`reconnect_required` and `missing_scope` link to `/profiles`; `provider_unsupported` says the channel is connected through the managed connector).
- Channel summary and video library load in parallel. "Load more" requests the next page. The list distinguishes loading, empty (zero uploads), and each error code.
- Selecting a video loads its details. Counters are labelled as YouTube counters with the fetch time.
- Every text goes through `useTranslation("accounts")` with keys under `youtubeManagement.*`, each with an Arabic entry in `src/i18n/locales/ar/accounts.json`. The sidebar label is `sidebar.youtubeManagement` in `src/i18n/locales/ar/nav.json`.

## 7. Security rules

1. Identity comes only from the JWT. The body never carries a user identifier; strict schemas refuse one.
2. The service-role client is used only inside `index.ts` adapters, and every account read filters on the authenticated user and on `platform = 'youtube'`.
3. Foreign and missing identifiers are indistinguishable (`not_found`, same status, same body apart from `request_id`).
4. Refused requests make zero provider calls and read zero credentials beyond the single owned-row lookup. Tests assert this with call counters.
5. No token, authorization header or provider body appears in a response or a log line. Tests assert that the serialised response does not contain the fixture token strings.
6. Tokens are obtained only through `refreshYouTubeAccountToken`. The function has no other path to Google's token endpoint.
7. The uploads playlist ID and the channel ID are derived server side. The browser cannot name a provider resource owner.
8. CORS is `restrictedCorsHeaders(req)` from `_shared/cors.ts`, never the wildcard headers.
9. Every provider call has a 15 second timeout and at most one repeat (the 401 case). All three operations are reads, so the repeat cannot duplicate a side effect.
10. Composio rows never reach the native read client.
11. The feature flag is a UI switch. The endpoint enforces authentication, ownership, capability and rate limit regardless of the flag.

## 8. Test strategy

| Layer | Runner | What it proves |
|---|---|---|
| Contract (`contracts.ts`) | Deno | Every error code has an HTTP status; the policy numbers match this document |
| Capability derivation (`capabilities.ts`) | Deno | The six rules of section 3.3, including empty recorded scopes, Composio, `needs_reauth` and parity with `youtubeCommentCapability` |
| Read client (`youtubeReadClient.ts`) | Deno, fake `fetch` | Request URL and parts, timeout, DTO mapping, each `classifyGoogleError` class, invalid body, `invalid_cursor`, no provider text in the result |
| Handler (`handler.ts`) | Deno, fake ports | Unauthenticated, service role, unknown key, foreign account, Composio, `needs_reauth`, missing scope, rate limit, 401 then forced refresh, second 401, more than 25 videos across pages, invalid cursor, foreign video equals missing video, database read failure is `internal_error` and not an empty list, call counters at zero after every refusal, no token in any response |
| Frontend domain | Vitest | `toYouTubeAccountOptions`, error classification |
| Frontend infrastructure | Vitest, mocked `supabase.functions.invoke` | Request bodies, error code extracted from the response body, unknown code falls back to `upstream_unavailable` |
| Frontend application | Vitest, fake gateway | Query keys include the account; switching account never returns the previous account's pages; a failed page is an error, not an empty page |
| Frontend ui | Vitest and Testing Library | Each notice state, empty state, load more, account switch clears the detail panel |
| Feature layering | Vitest (`tests/architecture.test.ts`) | Only infrastructure imports the Supabase client; application and domain import no infrastructure |
| Route wiring | Vitest | The page is reachable at `/youtube` and the sidebar entry follows the flag |
| Browser-to-handler contract | Deno and Vitest, one shared fixture | `supabase/functions/youtube-resources/requestExamples.fixture.ts` holds one request body per operation. The Deno handler test proves the handler accepts each; the Vitest gateway test proves the gateway sends each |

No SQL suite is needed under the recommended options because there is no migration. No test calls Google.

The parent plan's exit criterion for this stage is a "fixture-driven UI-to-handler integration [that] exercises actual wiring, including foreign channel denial". No single test process runs both React (Vitest) and the Deno handler in this repository, so this specification substitutes three linked proofs: the shared request fixture above ties the gateway to the handler's schemas; the screen test drives the real hooks and components through the gateway port; and the handler and read-client tests prove the denial of a foreign account and of a foreign channel's video. A browser-level end-to-end test is left to the authorised demo of the parent plan's stage 6.

## 9. Official references

Retrieved on 2026-11-20. None of the pages displayed a "last updated" date in the fetched text.

- Quota cost table: https://developers.google.com/youtube/v3/determine_quota_cost
- Quota usage overview: https://developers.google.com/youtube/v3/getting-started
- Quota and compliance audits: https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits
- `channels.list`: https://developers.google.com/youtube/v3/docs/channels/list
- `playlistItems.list`: https://developers.google.com/youtube/v3/docs/playlistItems/list
- `videos.list`: https://developers.google.com/youtube/v3/docs/videos/list
- `playlists.list`: https://developers.google.com/youtube/v3/docs/playlists/list

To re-check at implementation time (not fetched for this document): the resource representations of `channels`, `playlistItems` and `videos`, and the authorization section of each list method.

## 10. Rollout and rollback

Three pull requests, each deployable on its own (decision D7).

| Order | Stage | Contains | Visible to users |
|---|---|---|---|
| 1 | 2a | `youtube-resources` with the `capabilities` operation, its CI step | No |
| 2 | 2b | Read client, `channel`, `videos`, `video`, rate limit | No |
| 3 | 2c | Frontend feature, page, route, sidebar entry, flag (off by default), i18n | Only after the flag is turned on |

Rollout steps:

1. Merge 2a after CI and review. The Dokploy schedule deploys the function within about two minutes and probes it with `OPTIONS`. Verify with one authenticated `capabilities` call for an owned account and one for a random UUID (expect `not_found`).
2. Before merging 2b, confirm with a read-only query that `public.check_rate_limit` exists in production (it comes from `supabase/manual-sql/`, and the helper fails open without it). Then merge 2b the same way. Verify, with an account the owner authorises for the check, one `channel` call, one `videos` call and one `video` call, and one `video` call with the ID of a video from another channel (expect `not_found`). Also check a channel with zero uploads and record what Google answers; this document maps a 404 there to `not_found`, not to an empty list.
3. Merge 2c. The frontend deploys on the push to `main`. The page stays hidden because the flag defaults to off.
4. The owner turns the flag on in Admin, Feature Flags. Before that, confirm that a non-admin session can read the new `app_settings` key the same way it reads the other `feature_` keys.

Honest note on ARCHITECTURE.md §1: in 2a and 2b the production caller of the new modules is the serving entrypoint `youtube-resources/index.ts`; no browser calls the endpoint until 2c. The three stages should therefore merge close together. Decision D7 offers a single pull request for an owner who prefers no interval at all.

Rollback:

- Hide the feature: turn the flag off. No deploy needed.
- Remove the frontend: revert the 2c merge; the frontend redeploys on push.
- Remove the backend: revert the 2b merge first, then the 2a merge (2b rewrites 2a's `handler.ts`, `index.ts`, `contracts.ts`, `.github/workflows/ci.yml` and `CLAUDE.md`, so reverting 2a first conflicts), or revert the combined range in one commit. The schedule mirrors `origin/main`, so the function directory disappears from the volume on the next tick. There is no schema and no stored data to clean up.
- The rate limiter leaves at most two small rows per user in `rate_limit_buckets`. The same manual SQL file defines `cleanup_rate_limit_buckets()`; whether its cron schedule is active in production was not checked. The rows are harmless if they stay.

Nothing in this stage is applied to production by hand.

## 11. Acceptance checklist

Backend:

- [ ] A call without a valid user JWT gets `401 unauthorized` and no database or provider access.
- [ ] A service-role bearer gets `401 unauthorized`.
- [ ] A body with `user_id` or another unknown key gets `400 invalid_request`.
- [ ] `capabilities` for a native row with all three scopes recorded reports browse, upload and comments `available`.
- [ ] `capabilities` for a native row with no recorded scopes reports the three scopes `unknown`, browse and upload `unknown`, comments `unavailable/missing_scope`.
- [ ] `capabilities` for a Composio row reports browse `unavailable/provider_unsupported`, upload `unknown`, comments `available`.
- [ ] `capabilities` for a row with `needs_reauth` reports all three `unavailable/reconnect_required`.
- [ ] Another user's account ID and a random UUID give the same `404 not_found` body for every operation.
- [ ] `channel` returns the details of the stored channel and `freshness.source = "provider"`.
- [ ] `videos` returns 25 items by default, at most 50, and a `next_page_token` that fetches the next page; 60 uploads are fully reachable in three pages of 25.
- [ ] `videos` with a token Google rejects gives `400 invalid_cursor`.
- [ ] `video` for a video of another channel gives `404 not_found`, identical to an absent video.
- [ ] A Google quota refusal gives `429 quota_exceeded`; the 31st provider request of one user inside 10 minutes gives `429 rate_limited` with `retry_after_seconds`.
- [ ] A Google 401 triggers exactly one forced refresh and one repeat; a second 401 gives `409 reconnect_required`.
- [ ] A database read failure gives `500 internal_error`, never an empty list.
- [ ] No response and no log line contains a token.

Frontend:

- [ ] With the flag off there is no sidebar entry and `/youtube` redirects to `/dashboard`; with it on the entry opens `/youtube`.
- [ ] A user with no YouTube account sees the empty state with a link to Profiles.
- [ ] Switching account never shows a video or a channel of the previous account, including while the new one loads.
- [ ] More than 25 videos are reachable with "Load more".
- [ ] The Refresh control refetches the channel and the video list.
- [ ] `reconnect_required`, `missing_scope`, `provider_unsupported`, `quota_exceeded`, `rate_limited` and `upstream_unavailable` each render a distinct message; none renders as an empty list.
- [ ] Every new string has an Arabic entry and `npm run check:i18n` passes.
- [ ] No new `eslint-disable` and no new `any` in the diff.

## Decisions needed from Waleed

The first option of every row is the recommendation. The plan is written against the first options.

**Owner decisions, 2026-11-20 (Waleed, by approval cards):** every recommendation above is approved as written. D1 to D6 and D8 take their first option; D3 is "capabilities only" (browse answers `provider_unsupported` for Composio accounts); D7 and D9 are three independent PRs with 2a Heavy, 2b Heavy and 2c Medium. The plan stands as written. Nothing in this stage needs a database migration under these choices.

Process notes agreed with the owner for this stage: the Heavy tasks (2a and 2b) get one Codex Astra 6.2 debate round on this plan before implementation starts; implementation is by OpenCode `zai-coding-plan/glm-5.3-flash` (the model list offers `low`, `high` and `max`, no `medium`); the implementer runs `clean-code-guard`, `test-guard` and, on Heavy tasks, `waleed-security-reviewer`; the manager runs `/code-review` once on each whole PR.

| # | Decision | Options (recommended first) | Reason for the recommendation | Plan tasks that change otherwise |
|---|---|---|---|---|
| D1 | Where are browse results cached? | **A. Browser memory only (React Query), no server cache.** B. Database cache table with a TTL (new migration). C. No cache at all | No migration, no stored YouTube data, so no retention question to answer before Google's review | B adds a Heavy migration task and an SQL suite before 2b-3, plus a retention decision from the parent specification |
| D2 | What does a video list page carry? | **A. Title, thumbnail, date and privacy from `playlistItems.list` (1 unit per page).** B. Also duration and view count through `videos.list` (2 units per page) | Half the quota per page; duration and counters are one click away in the details | B changes 2b-2, 2b-4 and the list DTO, and doubles section 5.2 |
| D3 | What does a Composio-managed YouTube account get? | **A. `capabilities` answers; browse answers `provider_unsupported` with a clear message.** B. Hide Composio accounts from the page. C. Full Composio browse parity | The parent specification puts native first; A is honest to the owner of the account and costs nothing | B changes 2c-1 and 2c-4. C is a separate specification (new provider contracts and paid calls) |
| D4 | Quota guard | **A. Existing per-user rate limiter (30 per 10 minutes, 300 per day) plus honest `quota_exceeded`.** B. Project-wide unit ledger in the database (new migration). C. No guard, rely on Google's refusal | A needs no migration and bounds one user to 3% of the documented default | B adds a Heavy migration task and changes 2b-3. C removes the rate-limit port from 2b-3 and 2b-6 |
| D5 | Browse for accounts whose scopes were never recorded (older connections) | **A. Allow the call and let Google's `403` decide.** B. Refuse and ask the user to reconnect first | A keeps old connections working; a real missing scope still surfaces as `missing_scope` | B changes one branch in 2a-2 and 2b-3 |
| D6 | How is the page gated? | **A. New feature flag `feature_youtube_management`, off by default, admin toggle.** B. Reuse `feature_tab_youtube`. C. No flag | The parent plan requires new features to ship gated; the flag needs no migration because the code default applies when the row is absent | B and C shrink 2c-6 (no flag files to edit) |
| D7 | Pull request granularity | **A. Three PRs: 2a, 2b, 2c.** B. Two PRs: backend (2a+2b), frontend (2c). C. One PR | Smallest reviewable units; each is independently revertible | B and C only change the PR tasks 2a-5 and 2b-7 |
| D8 | First resource types | **A. Channel, uploads list, video details (the parent plan's list).** B. Also the channel's playlists (`playlists.list`, 1 unit) | Playlists are not in the parent plan and no later stage edits them | B adds one client method, one operation and one UI list (three tasks) |
| D9 | Delivery tier of the implementation | **A. 2a and 2b Heavy (new authenticated endpoint that handles OAuth tokens), 2c Medium.** B. All Medium. C. All Heavy | Ownership and token handling are security work under the tier rule; the frontend is not | Review rounds and the pre-implementation debate only |
