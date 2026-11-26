# YouTube Stage 6 — OAuth approval and Mr Saad demo package

26 November 2026 · implementation baseline `1985f724a52abf53fd72584664441ef22db44c14` · [verification guide](../YOUTUBE-OAUTH-VERIFICATION-GUIDE.md) · [Stage 6 specification](../specs/2026-11-26-youtube-stage6-disclosures-quota-package.md)

## 1. Evidence legend and release state

This package distinguishes four kinds of evidence:

- **Code:** inspected at the baseline commit. File paths below are repository-relative and exact at that commit.
- **Release history:** merge commits and public PR descriptions in `lolotam/POSTORA`.
- **Offline verification:** tests whose files exist at the baseline or were added by Stage 6. A suite's presence is not a claim that Stage 6 reran it.
- **Live evidence:** production migration records, deployed-file parity, Cloud Console readings, and provider behavior. Stage 6 is offline and does not independently verify these. A merged PR is not, by itself, deployed-SHA or live-provider proof.

Feature availability remains subject to the shipped rollout controls. In particular, `PUBLISHED_EDIT_WRITE_ENABLED` is `false` at this baseline and the production edit guard returns `false`; the published-edit write path therefore fails closed until a separately reviewed activation change. Stage 4 comment capabilities and Stage 5 analytics are also gated per account. The demo script names these prerequisites rather than implying every feature is enabled for every channel.

Public legal pages:

- `https://postora.cloud/google-api-disclosure`
- `https://postora.cloud/privacy`
- `https://postora.cloud/terms`

All show `Last updated: November 26, 2026` after the Stage 6 frontend deployment.

## 2. Scope → operation → code mapping

Native OAuth requests exactly these YouTube scopes with `access_type=offline` and `prompt=consent select_account`, and omits `include_granted_scopes`:

- `https://www.googleapis.com/auth/youtube.readonly`
- `https://www.googleapis.com/auth/youtube.upload`
- `https://www.googleapis.com/auth/youtube.force-ssl`

The dedicated `yt-analytics.readonly` scope is not requested at this baseline. Analytics uses the three existing scopes and also requires the owner's connection-scoped in-app acceptance of **Analytics Purpose Clause, Version 1, dated November 26, 2026**.

### 2.1 `youtube.readonly`

| Stage | User-facing capability | Provider operation | Exact implementation path |
| --- | --- | --- | --- |
| 1 | Identify the connected channel and show its name/avatar | `channels.list?part=snippet&mine=true` | `supabase/functions/youtube-oauth/index.ts` |
| 1 | Check that the connection remains healthy | `channels.list?part=snippet&mine=true` | `supabase/functions/check-connection-health/index.ts`; shared refresh path `supabase/functions/_shared/youtubeTokenRefresh.ts` |
| 2 | Show owned channel summary on `/youtube` | `channels.list` | `supabase/functions/youtube-resources/youtubeReadClient.ts` (`getChannel`); owner/rate admission in `handler.ts` and `index.ts` |
| 2 | Page the channel's uploaded videos | `playlistItems.list` | `supabase/functions/youtube-resources/youtubeReadClient.ts` (`listUploads`); UI `src/features/youtube-management/ui/YouTubeVideoLibrary.tsx` |
| 2 | Show full details of one owned video | `videos.list` | `supabase/functions/youtube-resources/youtubeReadClient.ts` (`getVideo`); UI `src/features/youtube-management/ui/YouTubeVideoDetail.tsx` |
| 5 | Confirm a video belongs to the admitted channel before per-video analytics | `videos.list?part=snippet&id=...` | `supabase/functions/youtube-analytics/analyticsReadClient.ts`; attempt order in `handler.ts` |
| 5 | Enrich top-video rows with owned titles | `videos.list?part=snippet&id=<up to 10 IDs>` | `supabase/functions/youtube-analytics/analyticsReadClient.ts`; display `src/features/youtube-analytics/ui/TopVideosTable.tsx` |
| 5 | Read channel and per-video totals, daily trends, and top-video reports after in-app acceptance | YouTube Analytics API v2 `reports.query` | `supabase/functions/youtube-analytics/analyticsReadClient.ts`; consent/credential enforcement in `handler.ts`, `decision.ts`, `credentials.ts`; page `src/features/youtube-analytics/ui/YouTubeAnalyticsScreen.tsx` |

Analytics values are read on demand, returned with `Cache-Control: no-store`, and never stored by Postora. Acceptance is recorded separately by `supabase/functions/youtube-analytics/consent.ts` and `src/features/youtube-analytics/application/usePurposeConsent.ts`; its text is pinned in `src/features/youtube-analytics/domain/purposeText.ts` and its digest in `src/features/youtube-analytics/tests/domain.test.ts`.

### 2.2 `youtube.upload`

| Stage | User-facing capability | Provider operation | Exact implementation path |
| --- | --- | --- | --- |
| 3 | Upload a new video or Short with user-chosen title, description, tags, category, privacy, language, audience, synthetic-media declaration, and other supported settings | `videos.insert` with `uploadType=resumable` | `supabase/functions/process-post/youtubePublisher.ts`; resumable session/offset handling in `youtubeResumableUpload.ts` and `youtubeUploadContinuation.ts`; Create Post UI `src/pages/CreatePost.tsx` and `src/components/post/settings/YouTubeSettings.tsx` |
| 3 | Set an optional custom thumbnail on the newly uploaded video | `thumbnails.set` | `supabase/functions/process-post/youtubeUploadFollowUps.ts`; owner-bound intake in `youtubeThumbnailIntake.ts` |

The upload path creates a new video. It does not replace media bytes of an existing video and does not delete videos.

### 2.3 `youtube.force-ssl`

| Stage | User-facing capability | Provider operation | Exact implementation path |
| --- | --- | --- | --- |
| 3 | Read the current writable projection before a published edit | `videos.list` | `supabase/functions/youtube-resources/editProvider.ts`; snapshot composition in `editComposition.ts` and `editLifecycle.ts` |
| 3 | Edit published title, description, tags, category, privacy, language, made-for-kids and synthetic-media declarations on the owner's instruction | `videos.update` | `supabase/functions/youtube-resources/editProvider.ts`; conditional planning/verification in `editLifecycle.ts` and `editComposition.ts`; editor `src/features/youtube-management/ui/YouTubeVideoEditCard.tsx` |
| 3 | Read the assignable category catalog for editing/publishing | `videoCategories.list` | `supabase/functions/youtube-resources/categoryClient.ts`; shared UI `src/components/post/settings/YouTubeCategorySelect.tsx` |
| 3/4 | Optionally create a first top-level comment after upload | `commentThreads.insert` | `supabase/functions/process-post/youtubeUploadFollowUps.ts` |
| 4 | Page owned uploads for the comment workspace | `playlistItems.list` | `supabase/functions/comment-manager/stage4/provider.ts`; UI `src/features/youtube-comments/ui/StudioVideoPicker.tsx` |
| 4 | Verify that the selected video belongs to the connected channel | `videos.list` | `supabase/functions/comment-manager/stage4/provider.ts`; owner checks in `handler.ts` |
| 4 | Read Published and Held for review threads | `commentThreads.list` | `supabase/functions/comment-manager/stage4/provider.ts`; UI `src/features/youtube-comments/ui/YouTubeCommentsScreen.tsx` |
| 4 | Read replies and verify a comment target | `comments.list` | `supabase/functions/comment-manager/stage4/provider.ts` |
| 4 | Create a top-level comment | `commentThreads.insert` | `supabase/functions/comment-manager/stage4/provider.ts`; fenced dispatch in `handler.ts` |
| 4 | Reply to a top-level comment | `comments.insert` | `supabase/functions/comment-manager/stage4/provider.ts`; fenced dispatch in `handler.ts` |
| 4 | Edit a comment written by the connected channel | `comments.update` | `supabase/functions/comment-manager/stage4/provider.ts`; author/target checks in `handler.ts` |
| 4 | Delete a comment written by the connected channel | `comments.delete` | `supabase/functions/_shared/youtubeComments.ts` (`deleteOwnComment`); action guard `supabase/functions/_shared/commentActions.ts` |
| 4 | Publish, hold for review, or reject a comment; optionally request author ban only with rejection | `comments.setModerationStatus` | `supabase/functions/comment-manager/stage4/provider.ts`; separately confirmed `banAuthor` flow in `handler.ts` and `src/features/youtube-comments/application/useYouTubeStage4.ts` |

Postora does not offer video deletion. The separate legacy video-delete helper is not part of the Stage 6 disclosure or demo scope.

## 3. Quota model and capacity reserve

### 3.1 Official Google costs

Sources, read for Stage 6 on 26 November 2026:

- [YouTube Data API v3 quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost): default 100 `search.list` calls, 100 `videos.insert` calls, and **10,000 units/day combined for all other endpoints**, resetting at midnight Pacific Time. Both named methods have their own buckets and cost one unit per call.
- [YouTube Analytics API data model — Quota usage](https://developers.google.com/youtube/analytics/data_model#quota-usage): each API request counts as one unit of API usage quota; the actual project limit appears in Cloud Console.

| API operation | Stage/use | Official cost | Postora budget/rate treatment |
| --- | --- | --- | --- |
| `channels.list` | 1 identity/health; 2 channel summary | 1 shared unit | Stage 2: 30 provider operations/10 min and 300/24 h per user |
| `playlistItems.list` | 2 uploads pages; 4 comment video picker | 1 shared unit per page | Same Stage 2 guard for `/youtube`; Stage 4 read guard for comment workspace |
| `videos.list` | 2 details; 3 edit pre-read/verification; 4 ownership/target checks; 5 ownership/title enrichment | 1 shared unit per call | Charged to the calling feature's guard; Stage 5 also debits the shared Data budget before every attempt |
| `videoCategories.list` | 3 category catalog | 1 shared unit | Published-edit composition checks its write guard before catalog read; production edit remains disabled |
| `videos.update` | 3 published metadata edit | 50 shared units | Production `PUBLISHED_EDIT_WRITE_ENABLED = false`; `authorizeWrite` and `stillBound` both refuse. No numeric edit-write allowance is active at baseline |
| `videos.insert` | 3 new upload | **1 unit/call in its own default 100-call/day bucket** | Do not subtract this from the 10,000-unit shared pool; resumable continuation does not open a replacement session after an uncertain send |
| `thumbnails.set` | 3 optional thumbnail after upload | 50 shared units | Separate follow-up outcome; a thumbnail failure does not erase the uploaded-video receipt |
| `commentThreads.list` | 4 Published/Held thread pages | 1 shared unit per page | Stage 4 read limiter: 120 requests/60 s per user, fail closed |
| `comments.list` | 4 replies/target verification | 1 shared unit per call | Same Stage 4 read limiter |
| `commentThreads.insert` | 3 first comment; 4 top-level comment | 50 shared units | Stage 4 write limiter: 20 requests/60 s per user, fail closed; durable one-send receipt |
| `comments.insert` | 4 reply | 50 shared units | Same Stage 4 write limiter and durable receipt |
| `comments.update` | 4 edit own comment | 50 shared units | Same Stage 4 write limiter and durable receipt |
| `comments.setModerationStatus` | 4 publish/hold/reject; optional `banAuthor` | 50 shared units | Stage 4 write limiter; ban confirmation has a separate 5 requests/24 h limit per user |
| `comments.delete` | 4 delete own comment | 50 shared units | Existing own-author guard; repeat-safe legacy action, not a new Stage 4 receipted send |
| Analytics v2 `reports.query` | 5 summary/daily/top-videos, channel or one video | 1 Analytics quota unit/request | Per-user admission 120/60 s; data 60/600 s and 300/86400 s; project attempt ceiling 2,000/Pacific day |

A normal Stage 3 edit needs one pre-read `videos.list` plus one `videos.update`: **51 shared units before the read-after-write verification**. The verification read costs one additional unit, so a completed read → update → verify sequence costs **52 units**. Category catalog retrieval, when needed, adds one unit.

### 3.2 Stage 5 Pacific-day ceilings and reserve arithmetic

| Control | Exact key / constant | Limit and behavior |
| --- | --- | --- |
| Data API shared budget | `youtube-analytics:budget:data:<YYYY-MM-DD>` from `supabase/functions/youtube-analytics/window.ts` | **1,000 units per Pacific day**, project-wide. Each ownership lookup, title lookup, and repeat is debited before its provider call |
| Analytics API shared budget | `youtube-analytics:budget:analytics:<YYYY-MM-DD>` | **2,000 attempts per Pacific day**, project-wide. This is Postora's own ceiling, not a claimed Google allocation |
| Admission limiter | `youtube-analytics:admit:<user_id>` | 120 requests/60 s per user |
| Data burst limiter | `youtube-analytics:data:10m:<user_id>` | 60 data operations/600 s per user |
| Data daily limiter | `youtube-analytics:data:24h:<user_id>` | 300 data operations/86,400 s per user |
| Stage 2 browse limiters | `youtube-resources:burst`, `youtube-resources:day` | 30/600 s and 300/86,400 s per user. The existing shared helper fails open if its counter RPC fails; ownership checks remain independent |
| Stage 4 limiters | `stage4:<action>:<user_id>` | Reads 120/60 s, writes 20/60 s, ban confirmation 5/86,400 s per user; all fail closed |

The two Stage 5 budget keys use the Pacific calendar date and a 48-hour counter window, so a counter cannot reset inside its named Pacific day. A debit requires `allowed: true` and `count >= 1`; an unreadable counter fails closed. A debit is not refunded when a later authorization check or provider attempt fails.

Against the documented 10,000-unit Data API default, capping Stage 5 at 1,000 leaves **up to 9,000 units/day** for publishing follow-ups, metadata edits, browsing, comments, and other consumers. This is capacity arithmetic, not a unified reservation ledger: another feature can consume its share first. Before `youtube_analytics_stage5_rollout.mode = "all"`, the owner must read actual Cloud Console limits and recent Data API peaks and review the ceilings and headroom.

## 4. Release receipts

### 4.1 Merge history

| Stage | Release | Merge commit / receipt |
| --- | --- | --- |
| 1a | OAuth attempt storage and RPCs | [PR #442](https://github.com/lolotam/POSTORA/pull/442), `b2a29fd5e46303f8d257943e9ccd84ac85032fc4` |
| 1b | Attempt-based authorize/callback | [PR #445](https://github.com/lolotam/POSTORA/pull/445), `b475d5bf171310b258eee338e8542264278403a5` |
| 1c | DB refresh lease | Commit [`a90d68fa`](https://github.com/lolotam/POSTORA/commit/a90d68fa), with later review fixes including `f0145ab1` |
| 1d | Provider-aware disconnect | [PR #446](https://github.com/lolotam/POSTORA/pull/446), `6943fed9b7b3e1b54f8a167e91ab31e98f0a10c3` |
| 2a | Capability contract | [PR #455](https://github.com/lolotam/POSTORA/pull/455), `f5b277d72f16808ea68d2245ad900a27e34a0fb2` |
| 2b | Native channel/video browse API | [PR #458](https://github.com/lolotam/POSTORA/pull/458), `41837b1f6ba5b6350e03eee8e9fccee699d400b5` |
| 2c | `/youtube` management UI | [PR #461](https://github.com/lolotam/POSTORA/pull/461), `2bc5e95f7a79fdd370e5c733e3579515036a747b` |
| 3 | Published edit and durable publishing | [PR #467](https://github.com/lolotam/POSTORA/pull/467), `21447f2de26b373a41acc23a5509a0718be1248c` |
| 4 | Comments and moderation | [PR #471](https://github.com/lolotam/POSTORA/pull/471), `44b426ccf41d3877f7fc34fea546cde042c7d149` |
| 4 follow-up | Review and key-integrity migration | [PR #478](https://github.com/lolotam/POSTORA/pull/478), `13468c2e6ffafbe5d4d02049bca6f19feb36ee92` |
| 4 follow-ups | Runbook/guards, unmount guards, Studio UI, audit reconciliation | [PR #484](https://github.com/lolotam/POSTORA/pull/484) `f43f0e011adfbf93f7f04d863501ab806f293383`; [PR #486](https://github.com/lolotam/POSTORA/pull/486) `87fa9337158f0f905d545e34db919d26840c2566`; [PR #487](https://github.com/lolotam/POSTORA/pull/487) `acd682e067c3ea8ac43219edcd909430f020d0fe`; [PR #490](https://github.com/lolotam/POSTORA/pull/490) `061cbc4961d8ca89d46646f9a0b2d7f11aed7394` |
| 5 PR A | Analytics rollout SQL and decision | [PR #491](https://github.com/lolotam/POSTORA/pull/491), `eb37ea204b9b936073500e5ea91c4640c6855b42` |
| 5 PR B | Analytics Edge Function and Deno suite | [PR #492](https://github.com/lolotam/POSTORA/pull/492), `7452a0a6c20840f0d92fd3a895502ed381938ac3` |
| 5 PR C | Analytics UI, acceptance panel, disclosures | [PR #493](https://github.com/lolotam/POSTORA/pull/493), `acec4274e1da6654b943a8f1dce9c234c5ca32ca` |
| 5 follow-up | Permission prompt, connection-scoped acceptance, signed net metrics | [PR #494](https://github.com/lolotam/POSTORA/pull/494), `1985f724a52abf53fd72584664441ef22db44c14` |

PR #494 records offline validation of 204 Deno tests, 56 analytics Vitest tests, 119 SQL suites, typecheck, and zero-warning ESLint. Those are historical PR receipts, not Stage 6 reruns.

### 4.2 Applied migration sequence and current file hashes

The release sequence applies the following migrations before the code that depends on them. The hashes below were recomputed from the Stage 6 baseline working tree, which matches `1985f724` for these files. Stage 6 did not query the production migration table; retain the production application/verification receipts with the submission evidence.

| Migration | Purpose | Baseline SHA-256 |
| --- | --- | --- |
| `20261119130000_youtube_oauth_attempts.sql` | Stage 1a OAuth attempts | `9870acbda8f6068ef72a69d5bffd1f9eb86c6963b38b5becac5710ef9a8074bd` |
| `20261120100000_youtube_oauth_attempts_v2.sql` | Stage 1b nonce-only callback attempts | `6c698b4db022aa1909750ee214a833e5994a420892211f18ec741110fd25a219` |
| `20261120110000_youtube_refresh_lease.sql` | Stage 1c refresh lease | `a1ceba9da39d79d60eaf3b9eddd6b93993fad55a2af321d0a694ab012cb0f5ae` |
| `20261120130000_youtube_refresh_lease_fixes.sql` | Lease hardening and credential-change fencing | `b65090eb4b5863492ac1b260210096676fac21a7b5c188eb888126f9c67f259f` |
| `20261122130000_youtube_stage4_comment_operations.sql` | Stage 4 receipts, binding generation, rollout | `9bfd81080286c1ad2f75e937d04f799d03160b7aaa706da8e5d667cf93111485` |
| `20261124120000_youtube_stage4_key_integrity.sql` | Stage 4 digest/key integrity | `9c41107e9ae7aaf5e10aaf19771355057755cd56bd0a492808c7212972c60946` |
| `20261125120000_youtube_stage5_analytics_rollout.sql` | Stage 5 policy, incarnation, acceptance, bound wrappers | `5c8ee39800a70fc1c214ed3e521b696485cd67af45844de5184bd8e385a299d2` |
| `20261126120000_youtube_reauth_permission_prompt_and_consent.sql` | D13-B connection-scoped acceptance | `7312da83a8ef4295d7d0daf5b7ef1cdc4e967d156b56c1da1eff1ec37c7deb19` |

### 4.3 Deployed Edge Function SHA verification summary

The release runbooks require the Edge Functions Sync schedule to run for each merge commit and per-file SHA-256 comparison between the deployed functions volume and `git show <merge>:<path>`. The Stage 5 rollout checkpoint additionally requires a deployed-route `status` smoke test and `Cache-Control: no-store`.

Stage 6 changed no Edge Function and performed no deployment or production read. It therefore cannot add a new deployed-parity receipt. The following **repository reference hashes**, computed at the baseline, are anchors for the required deployed comparison—not evidence that the comparison already succeeded:

| File | Baseline SHA-256 |
| --- | --- |
| `supabase/functions/youtube-oauth/handler.ts` | `f634614d4ef86f7dbc15401db79a277d80b7af9a9c98b3215b1014c59160b928` |
| `supabase/functions/youtube-oauth/index.ts` | `5012e1c1beb02f2778d47049ca198c8f03d0dcb5f4f0539f86754dd7f2faf6e2` |
| `supabase/functions/youtube-oauth/revoke.ts` | `450ff24b02e3e66cd9846688b3d4c47a3aaeb21b98ca227ddf9015a43eeed972` |
| `supabase/functions/youtube-resources/handler.ts` | `54b244fb019879c2560f3149bffc1125cf6eaec2f98445d8328b713301630936` |
| `supabase/functions/youtube-resources/editProvider.ts` | `ea4c321ee249fbf6d01af031c43917755446481605c3b307b34f92c60263a775` |
| `supabase/functions/comment-manager/stage4/handler.ts` | `f1db4f88e6a60377a9ec5149ee0ca4e15865e556425abb1ebb78c8ffa069e490` |
| `supabase/functions/comment-manager/stage4/provider.ts` | `65b53e552206f5464031045e0e20c6f40f2333f476f2ecd45312830f71029452` |
| `supabase/functions/process-post/youtubePublisher.ts` | `53c918873ae2432db4efb9aef8cf1c451029da378687ad30f3cc81bfea7b46ac` |
| `supabase/functions/process-post/youtubeResumableUpload.ts` | `729109f2f691f1607b1f70e1d7b48ddb303d9545979f20d1b73e00d431118318` |
| `supabase/functions/process-post/youtubeUploadFollowUps.ts` | `8cd2061ff94c43f1305b95045a645f0851bb193f59481baf7e757ea1b08883a0` |
| `supabase/functions/youtube-analytics/handler.ts` | `61f9263c67f06cf07428a6ae73e995f88279d19e241b3f5e1d9b6a054c98ebb5` |
| `supabase/functions/youtube-analytics/analyticsReadClient.ts` | `8317064198fcc74767cd5b67589ec8b96edc1f7f4eb762fb1c4fcae5f0f6506b` |
| `supabase/functions/youtube-analytics/contracts.ts` | `78203eacca052aec70560cd410d27bfa1ff397a6a8ca33afd54ba51706e7cc1a` |

Before external submission, attach the full per-directory deployed hash output and sync-schedule log for the exact release being demonstrated. Do not substitute this reference subset for that full check.

## 5. Offline test suite inventory

### 5.1 Deno suites at the baseline

| Area | Test files |
| --- | --- |
| OAuth | `supabase/functions/youtube-oauth/handler.test.ts`, `refusalLog.test.ts` |
| Resources/browse/edit | `supabase/functions/youtube-resources/{capabilities,categoryClient,contracts,editComposition.guard,editLifecycle,editProvider,handler,rateLimit,tokens,youtubeReadClient}.test.ts` |
| Stage 4 | `supabase/functions/comment-manager/stage4/{handler,provider,route}.test.ts` |
| Analytics | `supabase/functions/youtube-analytics/{analyticsReadClient,audit,composition,consent,contracts_window,credentials,decision_limits,handler}.test.ts` |
| Publishing | 16 `supabase/functions/process-post/youtube*.test.ts` files: `youtubeComposio`, `youtubeDispatchMode`, `youtubePublishEvidence`, `youtubePublishOptions`, `youtubePublisher`, `youtubeResumableUpload`, `youtubeThumbnailIntake`, `youtubeTokenRefresh`, `youtubeUploadContinuation`, `youtubeUploadFollowUps`, `youtubeUploadHandoff`, `youtubeUploadOutcome`, `youtubeUploadPolicy`, `youtubeUploadSession`, `youtubeUploadSource`, `youtubeVideoSource` |
| Shared YouTube | `supabase/functions/_shared/{youtubeVideoTitle,youtubeTokenRefresh,youtubePublishSafety,youtubeComposioOptions,youtubePollEligibility,youtubeGrantedScopes,youtubeComments,youtubeCommentNormalize,youtubeCommentCapability,youtubeApiErrors}.test.ts` |

### 5.2 Disposable-database SQL suites

- `supabase/tests/youtube_oauth_attempts.sql`
- `supabase/tests/youtube_oauth_attempts_v2.sql`
- `supabase/tests/youtube_refresh_lease.sql`
- `supabase/tests/youtube_token_refresh.sql`
- `supabase/tests/youtube_upload_sessions.sql`
- `supabase/tests/youtube_comments.sql`
- `supabase/tests/youtube_comment_operations.sql`
- `supabase/tests/youtube_stage4_key_integrity.sql`
- `supabase/tests/youtube_composio_provider.sql`
- `supabase/tests/youtube_analytics_stage5_rollout.sql`

The registered runner is `scripts/db-harness.sh`; an unregistered file is not release evidence.

### 5.3 Vitest and Testing Library suites

- **Management:** 14 files under `src/features/youtube-management/`, covering account options/errors/duration, capabilities/videos, gateway, architecture/wiring, and all major UI components including the editor.
- **Comments:** 12 files under `src/features/youtube-comments/tests/`, covering admission, architecture, gateway capabilities/reasons, operation identity/recovery, pending guards/freshness, reply lists, status recovery, screen behavior, and user switching.
- **Analytics:** `access_lease_and_screen.test.tsx`, `architecture.test.ts`, `domain.test.ts`, `flags_and_links.test.tsx`, and `gateway_and_keys.test.ts`. The domain suite pins the English and Arabic Analytics Purpose Clause digests.
- **Stage 6:** `src/pages/__tests__/YouTubeLegalDisclosures.test.tsx` renders all three public legal pages and pins scopes, capabilities, dates, disconnect behavior, and required policy links.

Stage 6 verification command:

```bash
npx vitest run src/pages/__tests__/YouTubeLegalDisclosures.test.tsx src/features/youtube-analytics
```

### 5.4 Offline Playwright journeys present at the baseline

- `e2e/youtube-stage3.spec.ts` with `e2e/fixtures/youtubeStage3.ts` and `playwright.stage3.config.ts`.
- `e2e/youtube-stage4.spec.ts` with `e2e/fixtures/youtubeStage4Server.ts` and `scripts/stage4-e2e.mjs`.

No `e2e/youtube-stage5.spec.ts` exists at the baseline, so this package does not claim that the planned Stage 5 Playwright journey ran. Analytics has Deno and Vitest coverage instead.

All automated provider calls in these suites use fakes/fixtures. No test should contact Google or production.

## 6. Masked Google verification and Mr Saad demo script

### 6.1 Recording setup and safety

1. Use an owner-controlled test Google account and YouTube channel, plus synthetic content explicitly approved for publishing/editing/commenting. Enable only the feature gates needed for the current journey.
2. Prepare a second test account only for same-user shared-grant or tenant-denial checks. Never use a customer's channel, comments, or analytics.
3. Open the browser's masked profile. Hide bookmarks, email avatars, notifications, and unrelated tabs. Blur account email addresses, channel IDs, account UUIDs, video IDs where private, request IDs, and personal commenter identities in the captured output.
4. Never record OAuth client secrets, access/refresh tokens, cookies, authorization headers, full callback URLs containing `code` or `state`, Supabase service-role values, database rows containing credentials, or provider response bodies with private data.
5. Do not induce a write against another tenant. Cross-tenant denial uses a random UUID or an owner-controlled fixture whose expected response is already known. Missing-scope denial uses a test grant with a permission intentionally withheld, not token tampering.
6. Keep each journey's before/after evidence: visible UI result and, where available, sanitized offline test receipt or system-log event with identifiers masked. Do not show secrets to prove server behavior.
7. Narrate scope purpose while showing the corresponding feature. State when a capability is gated and do not demonstrate a disabled write as if production accepted it.

### Journey 1 — Connect with account chooser and permission dialog

**Actions:** Profiles → Connected Accounts → YouTube → Connect. At Google, select the test account, review all three permissions, and approve. Return to Postora.

**Expected:** Google shows account selection and consent because the request uses `prompt=consent select_account`; Postora shows the correct channel. No `include_granted_scopes` is sent.

**Capture:** Profiles entry, Google permission screen with account identity masked, and connected-channel success state. Stop the recording during callback URL exposure if any sensitive query parameter is visible.

### Journey 2 — Channel and video browse

**Actions:** Open `/youtube`, select the connected channel, page uploads, open an owned video, and refresh.

**Expected:** Channel identity/summary, uploaded-video list, pagination where available, and complete details load. No other channel's video can be opened by ID; empty, loading, reconnect, rate-limit, and failure states are distinct.

**Capture:** Channel summary, uploads, and full detail view with private identifiers masked. Mention `channels.list`, `playlistItems.list`, and `videos.list` at one shared unit each and the 30/10-minute plus 300/24-hour per-user guard.

### Journey 3 — Edit published video metadata

**Prerequisite:** a separately reviewed activation must enable the write path and its D1/D5 evidence. At the Stage 6 baseline the write gate is hard-off. If that gate is still false, show the disabled state and code/test evidence only; do not claim a live edit occurred.

**Actions when activated:** On `/youtube`, open an existing owned video → Edit video details. Change title/description/tags/category/privacy/language or declarations as appropriate for the fixture. Review and save; wait for YouTube verification; open the original watch URL.

**Expected:** The same video has the new metadata and preserved media bytes. There is no video deletion or replacement. Conflict and unknown-outcome states never trigger an automatic second write.

**Capture:** Before/after editor, verified result, and unchanged watch URL. Narrate the 51-unit read+update cost, plus one unit for verification and one for category catalog when used.

### Journey 4 — Upload a new video

**Actions:** Create Post → select the native YouTube channel and a test video → choose metadata/privacy/declarations → optionally select a custom thumbnail → publish. Open History and the resulting watch page.

**Expected:** A new video/Short is created with the chosen supported settings. Thumbnail and first-comment follow-ups have independent outcomes. No duplicate upload is created by retry/recovery.

**Capture:** Create Post settings, pending/receipt states, History link, and the new watch page with private IDs masked. Narrate `videos.insert`'s separate 100-call/day default bucket and optional 50-unit `thumbnails.set`.

### Journey 5 — Comments and moderation

**Actions:** Open Comments → YouTube → test account/video. Page Published and Held for review. Create a top-level test comment, reply, edit the channel's own comment, and delete it if desired. On a controlled comment, demonstrate hold/publish/reject. Only if `ban` is enabled for this account, select ban-author and complete the separate server-issued confirmation.

**Expected:** Reads and own-comment actions affect only the selected owned video/thread. Rejection cannot be republished through the API. `banAuthor` is sent only with rejection after separate confirmation; Postora never claims it can read or undo a ban. Indeterminate writes are not automatically resent.

**Capture:** Lists, create/reply/edit states, moderation confirmation, and resulting visible state with commenter identities masked. Narrate one-unit reads and 50-unit writes, plus 120-read/minute, 20-write/minute, and 5-ban-confirmation/day limits.

### Journey 6 — On-demand analytics acceptance and withdrawal

**Actions:** With the account admitted by the analytics rollout policy, open `/analytics/youtube`. Before accepting, confirm reports do not load. Read Analytics Purpose Clause v1 and choose Allow. View channel summary, daily trend, top videos, and one-video analytics. Choose Stop using analytics for this channel and confirm. Reject any subsequent data reload until acceptance is given again.

**Expected:** No report or credential release occurs before in-app acceptance. Reports show only the owner's own channel/video numbers, on demand; missing days are not zero-filled. Withdrawal removes reports immediately and blocks the next read without changing Google permissions, publishing, or comments. Disconnect/reconnect later creates a new `connection_revision` and requires fresh acceptance; trusted token refresh preserves it.

**Capture:** Acceptance panel, reports with all values/identifiers approved for recording or masked, withdrawal confirmation, and post-withdrawal state. Do not include actual analytics values in the written submission package. Narrate the 1,000 Data-unit and 2,000 Analytics-attempt Pacific-day ceilings and per-user limiters.

### Journey 7 — Cross-tenant and missing-scope denial

**Actions:** Use a synthetic unknown/foreign account or video identifier in the appropriate offline fixture or owner-controlled test call. Separately, connect a test account with a required permission withheld and open the affected capability. Never send a write.

**Expected:** Unknown and foreign resources produce the same safe `not_found` behavior without revealing existence. Missing scope produces the capability-specific reconnect message and no provider write. Failed reads never appear as empty successful lists/reports. Analytics additionally refuses before acceptance or after withdrawal.

**Capture:** Sanitized request/response code or UI denial with every identifier masked. Include the corresponding offline handler test receipt where possible rather than a live attack attempt.

### Journey 8 — Disconnect, revoke, and reconnect re-prompt

**Actions:** Profiles → Connected Accounts → Disconnect for the native YouTube channel. Confirm the result, then reconnect through the normal Connect action.

**Expected:** Postora checks other active grant holders for the same user. If none shares the grant, it revokes the refresh token through RFC 7009, using the access token when necessary. Stored credentials clear immediately after the required provider step; the row disappears. A failed required revocation reports failure instead of false success. Disconnect ends the old connection's analytics authorization. Reconnect shows account chooser and permission prompt again and requires fresh analytics purpose acceptance.

**Capture:** Disconnect confirmation/result, removed connection, and Google re-prompt with secrets masked. If demonstrating a shared grant, use two connections owned by the same test user and show that disconnecting one does not revoke the grant still needed by the other.

## 7. Submission checklist

- [ ] Stage 6 frontend deployment serves the three legal pages with the fixed date and complete Stage 1–5 wording.
- [ ] Cloud Console consent configuration names only the three YouTube scopes used by the demonstrated build; YouTube Data API v3 and YouTube Analytics API v2 are enabled.
- [ ] Production migration application and verification receipts cover all eight migrations in §4.2.
- [ ] Full deployed Edge Function per-file SHA-256 output and Edge Functions Sync log match the demonstrated merge commit.
- [ ] Actual Data and Analytics quota limits and recent Data API feature peaks are read from Cloud Console and compared with §3.
- [ ] Feature activation state is stated accurately, including the published-edit write gate and per-account Stage 4/5 rollout controls.
- [ ] All eight demo journeys are recorded with masking rules applied and no secret/private evidence exposed.
- [ ] Offline test outputs are attached for the exact candidate head, including Stage 6 legal tests, analytics tests, typecheck, and targeted zero-warning ESLint.
- [ ] Any remaining live unknown is labeled as such; no repository-only evidence is presented as live production proof.
