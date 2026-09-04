# YouTube Comments — Comment Manager, AI Agent, Comment Workflows

**Date:** 2026-09-04 · **Branch:** `feat/youtube-comments` · **Status:** approved in chat, awaiting written review

**Goal:** YouTube channels get the same comment surfaces Facebook, Instagram and Threads have — the Comment Manager tile, the AI agent (auto-reply rules + agent), and comment-workflow funnels — for both auth providers (native Google OAuth and Composio-managed), with multi-channel selection everywhere. Done means merged to `main`, migration applied, functions deployed, and the flow recordable for Google's scope verification.

**Out of scope:** the n8n community node release (the backend event `comment.youtube` ships here; the node's Platform selector is a follow-up in `F:\N8N\Postora-n8n-community-node`). Live-chat messages. Replies beyond the five YouTube inlines per thread on the sweep (see §3.4).

## 0. Facts established before design (2026-09-04, production)

| Probe | Result |
|---|---|
| `commentThreads.list` with a Google API key | 401 `required` — API keys are not accepted by this endpoint |
| `commentThreads.list` with a refreshed native token (`readonly` + `upload`) | 403 `insufficientPermissions` — listing needs `youtube.force-ssl` too |
| Composio YouTube toolkit (`20260721_00`) | 51 tools incl. `YOUTUBE_LIST_COMMENT_THREADS`, `YOUTUBE_LIST_COMMENTS`, `YOUTUBE_CREATE_COMMENT_REPLY`, `YOUTUBE_SET_COMMENT_MODERATION_STATUS`, `YOUTUBE_DELETE_COMMENT`, `YOUTUBE_GET_VIDEO_DETAILS_BATCH`, `YOUTUBE_LIST_PLAYLIST_ITEMS` |
| Composio managed auth config `ac_ZZF6rPlq_i9_` | its scopes include `youtube.force-ssl`; the one live connected account has it granted; `YOUTUBE_LIST_COMMENT_THREADS` returned real threads |
| `social_accounts` where platform = youtube | 4 native + 1 composio, all `is_active`, none `needs_reauth`; every native `token_expires_at` is in the past (YouTube is `cronExcluded`, refresh is just-in-time); `account_metadata = {}`; one channel (`UCGDSIW3C…`) exists as three rows (2 composio, 1 native) under three different users — the unique index `(user_id, platform, platform_user_id)` forbids one user holding a channel twice |
| Cron precedent | `poll-threads-replies` every 2 min (`20260823090000_threads_reply_poller_cron.sql`) |

Consequence: **Composio channels can do comments today; native channels need the new scope and Google re-verification.** Both are in scope.

## 1. Auth and scopes

1.1 `supabase/functions/youtube-oauth/index.ts` requests three scopes: `youtube.readonly`, `youtube.upload`, `youtube.force-ssl` (user decision: all on the main connect, not incremental). `access_type=offline`, `prompt=consent`, `include_granted_scopes=true` stay.

1.2 The token exchange (which today drops Google's `scope` field) and the `action:"refresh"` path both write `account_metadata.granted_scopes: string[]` (the space-separated `scope` string split). `_shared/social-auth.ts` `refreshYouTubeToken` returns `scope` alongside `access_token` / `expires_in`; every caller that persists the token persists the scopes too. Precedent: `instagram-oauth/index.ts:220`, `pinterest-oauth/index.ts:82`.

1.3 **Comment capability** is a pure function `youtubeCommentCapability(account)` in `supabase/functions/_shared/youtubeCommentCapability.ts`, with a mirrored client copy in `src/lib/youtubeCommentCapability.ts`; both are unit-tested against the same fixture table:
- `auth_provider === "composio"` → `"capable"`.
- native with `granted_scopes` containing `https://www.googleapis.com/auth/youtube.force-ssl` → `"capable"`.
- native otherwise → `"reconnect_required"` (covers the 4 existing rows, whose `granted_scopes` is absent).

1.4 Side effect named: `process-post`'s `youtube_first_comment` (`commentThreads.insert`, today failing silently with 403) starts working for reconnected native channels. No code change; noted in the changelog.

1.5 `useSocialAccounts` already selects `account_metadata` and `auth_provider`; the `SocialAccount` interface gains `auth_provider: "native" | "composio"` so consumers stop re-declaring it (the Slice F trap: a fetched-but-undeclared column ships dead).

## 2. Ingest: `youtube-poll-comments`

2.1 New edge function `supabase/functions/youtube-poll-comments/index.ts`, cron-authenticated with `verifyCronAuth` like `threads-poll-replies`. Scheduled by `pg_cron` as `poll-youtube-comments`, `*/5 * * * *`, via `net.http_post` with `get_cron_secret()` (copy of `20260823090000`).

2.2 **Eligibility** (pure, `_shared/youtubePollEligibility.ts`): rows with `platform = 'youtube' AND is_active`, then in code: capability `"capable"`, `resolveCommentAutomationHandler(account_metadata) !== "off"`, and **one row per (user_id, platform_user_id)** — when a composio and a native row both qualify, the composio row is polled and the native row is skipped with a log line (no Google quota on Postora's project, no token to refresh). The unique index makes this pair impossible today; the rule is a guard, not a fix for live data. The same channel connected by different users is polled once per user: each user's automation is their own.

2.3 **Per channel, one call:** `commentThreads.list` with `part=snippet,replies`, `allThreadsRelatedToChannelId=<platform_user_id>`, `order=time`, `maxResults=50`, `textFormat=plainText`. Cost 1 unit; at a 5-minute cadence ≈ 288 units per channel per day against the 10,000-unit daily default. No pagination on the sweep: the newest 50 threads per pass is the window, the same spirit as Threads' `MAX_POSTS_PER_ACCOUNT`.

2.4 **Normalisation** into the existing `CommentPayloadInput` shape (`_shared/n8nMessagingDispatch.ts:141`): `comment.id` = comment id; `kind` = `"comment"` for a top-level comment, `"reply"` for each of `replies.comments[]`; `text` = `snippet.textOriginal`; `parentCommentId` = the thread's top-level comment id for replies, null otherwise; `mediaUrl` = null. `post.id` = `snippet.videoId`, `post.url` = `https://www.youtube.com/watch?v=<videoId>`, `post.caption` = null (titles are not fetched on the sweep). `author.id` = `snippet.authorChannelId.value`, `author.name` = `snippet.authorDisplayName`, `author.username` = null. `timestamp` = `snippet.publishedAt`.

2.5 **Persistence and hand-off** reuse the Threads ingest body, generalised: a new `_shared/polledCommentIngest.ts` holds the platform-neutral steps (upsert into `social_inbox_events` on `(social_account_id, external_event_id)` with `ignoreDuplicates`, own-comment skip, first-pass seed, `runInBackground` → `runCommentWorkflow` then `internal` / `n8n`), and `threadsCommentIngest.ts` becomes a thin caller so its existing tests pass unchanged. The row carries `platform = "youtube"`, `event_type = "comment"`, `external_event_id` = comment id, `payload` = the raw thread or reply item.

2.6 **First pass seeds, never fires**: `count(*)` of `social_inbox_events` for the row is zero ⇒ `dispatch = false`. Enabling comments on a channel with years of history must not wake the agent on all of it.

2.7 **Own comments**: `_shared/commentAuthor.ts` `isOwnComment` gains the youtube branch: `author.id === account.platform_user_id`.

2.8 Failures are per channel and the sweep continues. Response: `{ success, polled, dispatched, skipped: { reconnect_required, duplicate_channel, quota, failed } }`.

## 3. Provider adapter: `_shared/youtubeComments.ts`

3.1 One module, one operation set, each branching on `auth_provider`:

| Operation | Native (Data API v3) | Composio tool (`20260721_00`) |
|---|---|---|
| `listThreads({ channelId or videoId, pageToken? })` | `GET commentThreads` | `YOUTUBE_LIST_COMMENT_THREADS` |
| `listReplies(parentId)` | `GET comments?parentId=` | `YOUTUBE_LIST_COMMENTS` |
| `reply(parentId, text)` | `POST comments` `{snippet:{parentId,textOriginal}}` (50 units) | `YOUTUBE_CREATE_COMMENT_REPLY {parentId,textOriginal}` |
| `setModeration(id, status)` with status `rejected`, `published` or `heldForReview` | `POST comments/setModerationStatus` (50 units) | `YOUTUBE_SET_COMMENT_MODERATION_STATUS {id,moderationStatus}` |
| `remove(id)` | `DELETE comments` (50 units) | `YOUTUBE_DELETE_COMMENT {id}` |
| `videoTitles(ids[])` | `GET videos?part=snippet` | `YOUTUBE_GET_VIDEO_DETAILS_BATCH` |
| `listChannelVideos(channelId)` | `GET playlistItems?playlistId=UU…` (the uploads playlist, 1 unit; `search.list` would be 100) | `YOUTUBE_LIST_PLAYLIST_ITEMS` |

Native calls run a just-in-time refresh when `token_expires_at` is within 30 minutes (reuse `refreshYouTubeToken`) and persist `access_token`, `token_expires_at` and `granted_scopes`. Composio calls go through `withConnectorCall` + `loadActiveConnection` + `executeTool` exactly as `process-post/youtubeComposio.ts` does. The registry entry's `tools` list is extended by the seven slugs above and `mutating` by reply, moderation and delete. Existing Composio connections have a frozen `tool_schema_cache`; the rollout runbook calls `/refresh-schema` for them.

3.2 **Semantics** (YouTube differs from Meta):
- A reply always attaches to the top-level thread: replying to a reply sends `parentId` = that reply's `parentCommentId`.
- Hide = `setModeration(id, "rejected")`; unhide = `"published"`. Hiding is reversible.
- Delete succeeds only for the channel's own comments (`author.id === platform_user_id`). For anyone else's it is refused with "YouTube only lets you delete your own comments — hide it instead.", the way Threads refuses delete.
- No private messages exist. `commentWorkflow.ts:273` `wantsDm` becomes `platformSupportsPrivateReply(platform)` (`facebook` and `instagram` only), shared with the Threads rule.

3.3 **Error classification** (pure, `_shared/youtubeApiErrors.ts`, tested):
- 403 `insufficientPermissions` → `scope_missing`: remove `force-ssl` from `granted_scopes` (self-heal: the row flips to `reconnect_required`), stop polling it, show the reconnect banner. Health columns untouched.
- 403 `quotaExceeded` / `dailyLimitExceeded` / HTTP 429 → `quota`: skip this run for that channel and log. Health columns untouched (the Meta false-reauth lesson).
- 401 → refresh once; if the refresh returns `invalid_grant` → `needs_reauth = true`, `last_refresh_error` set.
- Composio `successful: false` maps through the same classifier using the embedded Google error when present, else `upstreamUnavailable`.

3.4 `_shared/commentActions.ts` gains a `youtube` branch delegating to this adapter, and a **default branch that refuses unknown platforms** (`{ success: false, error: "Unsupported platform" }`) instead of falling into the Meta path. Known limits: the sweep ingests only the ≤5 replies YouTube inlines per thread, and `order=time` sorts by the top-level comment's time, so a new reply on a thread older than the newest 50 (native) or 20 (Composio — its relayed body must stay under the client's 64 KB cap; 50 threads measured 72 KB) is not seen by the sweep; the Comment Manager fetches full replies on demand via `listReplies`. The Comment Manager's YouTube query does not auto-refetch (each read is 2 quota units); the poller's inbox writes invalidate it, and the Refresh button covers the rest.

## 4. Comment Manager (`/comments`)

4.1 `src/pages/comments/CommentManagerPage.tsx`: `youtube` joins `CommentPlatform` and `PLATFORMS` as an inline tile (no `externalPath`), gated by `flags.youtubeComments`.

4.2 `CommentManagerPanel` for youtube: a channel picker over `useSocialAccounts` rows with `platform === "youtube" && is_active` (both providers; rows show `AccountAvatar` + channel title, plus a "Composio" badge on composio rows). Capability `reconnect_required` renders, in the slot the IG-permission banner uses, "Reconnect this channel on Profiles to enable comments" with a link to `/profiles`.

4.3 Data: `useCommentInbox` `useComments` calls `comment-manager` action `get_youtube_comments` `{ social_account_id, page_token? }` → `{ videos: [{ id, title, url, threads: YouTubeThread[] }], next_page_token }` where `YouTubeThread = { id, text, author: { id, name, avatar_url }, published_at, like_count, moderation_status: "published" | "heldForReview" | "rejected" | null, is_own, total_reply_count, replies: YouTubeReply[] }` and `YouTubeReply` is the same minus `replies` / `total_reply_count`, built from `listThreads(channelId)` + `videoTitles`. Reads are live (as FB/IG), `refetchInterval` 30 s, realtime invalidation on `social_inbox_events` for the account (the poller writes those rows).

4.4 Actions reuse the existing `reply_comment` / `hide_comment` / `delete_comment` actions with the adapter behind them. `CommentActions` shows Unhide for rejected comments and disables Delete for other people's comments with the §3.2 copy.

## 5. AI agent setup (`/automation/agents`)

5.1 `UnifiedAgentSetupPage` `PLATFORMS` gains `{ id: "youtube", label: "YouTube", supportsComments: true, colorPreset: "red", description: "Video comment replies and moderation", commentsLabel: "Comments" }` with **no DM surface**: the page forces `surface="comments"` for youtube and hides the DM toggle (`src/lib/agentSurface.ts` is unchanged — it models "no comments", not "no DMs"). `PLATFORM_FLAG.youtube = "youtubeComments"`.

5.2 `useAiAgentConfig` `AiAgentPlatform`, the `AutomationHandlerCard` platform union (comments surface only: message options hidden), `AiAgentManager`, `AutoReplyManager` `copyFor` (comment-only copy, as threads), `AiAgentTestChat` and `AiAgentLogsView` all accept `youtube`.

5.3 `supabase/functions/messaging-api/index.ts:367` `supportedAiAgentPlatforms` adds `"youtube"`. `ai-agent-reply`'s comment sender already resolves the account by request platform and delivers through `replyToComment`, so it works once §3.4 lands.

## 6. Comment workflows

6.1 `src/features/comment-workflow/domain/rule.ts`: the union and `COMMENT_WORKFLOW_PLATFORMS` add `youtube`; `supportsPrivateReply("youtube") === false`. Form copy: "YouTube has no private messages — this workflow replies publicly only." in the slot Threads uses.

6.2 `accountChoices.ts`: `ACCOUNT_NOUN.youtube = "channel"`, placeholder "Choose a YouTube channel", counts seed `youtube: 0`. `isAccountConnected` becomes platform-aware: for youtube it ignores `token_expires_at` (just-in-time refresh) and requires capability `"capable"`. `reconnectNeededCount` therefore counts `reconnect_required` channels, and the line reads "N more channels need reconnecting on Profiles before a workflow can use them."

6.3 Scope "one video": `commentWorkflowApi.fetchRecentPosts("youtube")` calls `comment-manager` action `get_youtube_videos` → `listChannelVideos` (title + published date); `target_post_id` stores the video id.

6.4 Backend: the `comment_workflow_rules` CHECK admits `youtube`; a new constraint `cwr_youtube_has_no_dm` mirrors `cwr_threads_has_no_dm`; `commentWorkflow.ts` uses `platformSupportsPrivateReply`.

## 7. Data, flags, events

7.1 One migration `20260904150000_youtube_comments.sql` (self-committing; rehearsed on the harness):
- widen the `platform` CHECK on `social_inbox_events`, `messenger_auto_replies`, `ai_agent_configs`, `ai_conversation_modes`, `ai_threads`, `ai_agent_logs` and `comment_workflow_rules` to include `'youtube'`, using the same `pg_constraint` lookup-and-replace DO block as `20260822180000_threads_agent_platform.sql` (the constraints were created inline, so they are found by `pg_get_constraintdef(oid) ILIKE '%platform%'`, not by name) and re-adding each as `<table>_platform_check`;
- add `cwr_youtube_has_no_dm` on `comment_workflow_rules`: `CHECK (platform <> 'youtube' OR (dm_message IS NULL AND media_file_id IS NULL))`;
- `cron.unschedule('poll-youtube-comments')` if it exists, then `cron.schedule('poll-youtube-comments', '*/5 * * * *', <net.http_post to https://api.postora.cloud/functions/v1/youtube-poll-comments with the Bearer get_cron_secret() header and body '{}'>)`, the exact statement shape of `20260823090000`;
- `INSERT INTO app_settings (key, value, description) VALUES ('feature_youtube_comments', 'false'::jsonb, 'YouTube comments (Comment Manager, agent, workflows)') ON CONFLICT (key) DO NOTHING`, as `20260904120000:259` does for `feature_comment_workflow`.

7.2 Frontend flag `youtubeComments` ↔ `feature_youtube_comments` through all eight `useFeatureFlags.tsx` sites (type, defaults, DB key list, key map, labels, admin defaults, resolution, exposed list) plus `FeatureFlagIndicator.tsx`. The sidebar is unchanged; `/comments` already exists.

7.3 `n8n-api` `ALLOWED_WEBHOOK_EVENTS` adds `comment.youtube`; `n8nMessagingDispatch` `CommentPlatform` adds `youtube` with `isHandlePlatform` false (YouTube authors carry no handle in the payload).

## 8. Verification, docs, rollout

8.1 Docs: `src/pages/admin/oauth-verification/checklist-data/google.ts` gains a `scope_youtube_force_ssl` item and its `minimum_scopes` text becomes "exactly three"; `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` and `docs/OAUTH-TOKEN-REFRESH-GUIDE.md` scope lists are corrected to match the code; the `API_REFERENCE.md` incremental-auth paragraph is removed (never implemented); the privacy policy page names comment data (read, reply, moderate on the user's behalf). `CLAUDE.md`'s Edge Functions table gains `youtube-poll-comments`.

8.2 Demo recording (user, after go-live): a test user signs in → Profiles → Connect YouTube → the Google consent lists the three scopes → the `/comments` YouTube tile lists comments → reply → the reply appears on YouTube. Composio is not part of the recording.

8.3 Rollout order: migration on Contabo via `ssh-contabo-mcp` → merge (frontend auto-deploys; functions via the runtime checkout + restart) → `/refresh-schema` on the existing Composio YouTube connection → enable `feature_youtube_comments` for the admin → reconnect the admin's native channel → the first poll seeds → the second poll dispatches.

## 9. Testing

- Pure units (Deno and vitest, no network): `youtubeCommentCapability` (both copies, shared fixture table), `youtubePollEligibility` (dedupe prefers composio; handler off excluded; reconnect_required excluded), `youtubeApiErrors` (the four classes plus Composio-embedded errors), normalisation of a recorded `commentThreads.list` fixture (kinds, parent ids, author id, own-comment).
- Adapter tests with a fake fetcher and a fake `executeTool`: reply-to-reply retargets the parent; delete refuses foreign comments; hide and unhide map to moderation statuses; the JIT refresh persists scopes.
- Poller test: the first pass seeds (`dispatch = false`) and the second dispatches; a per-channel failure does not stop the sweep; the duplicate native row is skipped.
- The `threadsCommentIngest` suite passes unchanged after the extraction.
- UI (vitest + RTL, fireEvent): the Comment Manager tile is gated by the flag; the reconnect banner shows for a native row without the scope; the workflow picker uses "channel" copy, counts a scope-less native row as reconnect-needed, and keeps an expired-looking capable row connected; the agent page shows YouTube with comments only.
- DB harness: the migration applies on the baseline dump; inserting a `youtube` row into each widened table succeeds; `cwr_youtube_has_no_dm` rejects a DM; the cron job row exists.
- Gates before merge: Deno suite, `bun run test`, `tsc -p tsconfig.app.json`, eslint, build, CI green; `clean-code-guard` on production code, `test-guard` on tests, `docs-guard` on the doc edits.

## 10. Delegation lanes

Migration + harness suite → OpenCode Muse Spark. Code slices → Codex (`gpt-5.6-sol`, medium); if the Codex quota window is closed, Claude subagents in isolated worktrees. Disjoint path sets per slice; the orchestrator reviews, runs guards, commits and lands.
