# YouTube Stage 6 — disclosures, quota and approval/demo package

26 November 2026 · tier **Medium** · documentation and public legal copy plus offline component tests · implementation baseline `1985f724a52abf53fd72584664441ef22db44c14` · [implementation plan](../plans/2026-11-26-youtube-stage6-disclosures-quota-package.md)

## 1. Outcome

Postora's public Google/YouTube legal pages, OAuth verification guide, and approval/demo package will describe the behavior that actually shipped in Stages 1–5 at the baseline. A Google reviewer and Mr Saad will be able to trace every requested scope to a user-facing feature, an API operation, exact code, quota controls, and a masked demonstration journey. Automated tests will prevent the three legal pages from drifting back to incomplete scope descriptions or nondeterministic dates.

This stage changes no OAuth scope, API operation, feature flag, rollout policy, database object, token behavior, or analytics acceptance behavior. It makes no live Google or production request. It adds no dependency.

## 2. Verified baseline and required corrections

The baseline contains these shipped capabilities:

| Stage | Shipped user-facing behavior | Primary implementation evidence |
| --- | --- | --- |
| 1 — OAuth lifecycle | Three-scope native connection with offline access, account chooser and explicit permission prompt; attempt-bound callbacks; leased token refresh; shared-grant-aware disconnect with RFC 7009 revocation and access-token fallback; immediate local credential clearing | `supabase/functions/youtube-oauth/handler.ts`, `index.ts`, `revoke.ts`; `supabase/functions/_shared/youtubeTokenRefresh.ts`; `src/hooks/useSocialProfiles.tsx` |
| 2 — Channel and video browse | Channel identity/health, uploads paging and complete owned-video details at `/youtube`; owner-bound native reads; per-user rate limits | `supabase/functions/youtube-resources/{handler.ts,youtubeReadClient.ts,index.ts}`; `src/features/youtube-management/` |
| 3 — Published edit and publishing | Owner-instruction metadata editing through `videos.update` (implemented behind a hard-off activation gate at this baseline); new video/Short upload and optional custom thumbnail; no video-byte replacement and no video deletion | `supabase/functions/youtube-resources/{editLifecycle.ts,editProvider.ts}`; `supabase/functions/process-post/{youtubePublisher.ts,youtubeResumableUpload.ts,youtubeUploadFollowUps.ts}` |
| 4 — Comments and moderation | Owned-upload comment reading (Published and Held for review), top-level comments, replies, editing/deleting the channel's own comments, publishing or rejecting comments (moving a published comment to `heldForReview` is disabled at this baseline), and optional separately confirmed author ban | `supabase/functions/comment-manager/stage4/`; `src/features/youtube-comments/`; legacy own-comment deletion in `supabase/functions/_shared/commentActions.ts` |
| 5 — On-demand analytics | Channel/video Analytics API v2 reports at `/analytics/youtube` after connection-scoped in-app acceptance of Analytics Purpose Clause v1; immediate withdrawal; no analytics-number storage; Data API ownership/title enrichment | `supabase/functions/youtube-analytics/`; `src/features/youtube-analytics/`; acceptance decision in `supabase/migrations/20261126120000_youtube_reauth_permission_prompt_and_consent.sql` |

The three public pages are only partly reconciled with that baseline:

- `GoogleApiDisclosure.tsx` calculates its update date from the viewer's clock; its broad-scope rationale says Postora does not need existing-video editing even though Stage 3 edits metadata; its scope sections omit Stage 2 browsing and most Stage 3/4 capabilities; its disconnect path and retention wording are stale.
- `Privacy.tsx` and `Terms.tsx` still show 8 January 2026 and describe only publishing, basic channel display, comments, and analytics. They omit owned-video browsing/details and published metadata editing.
- Privacy's generic statement that disconnected-account tokens are deleted within 24 hours does not distinguish native YouTube's immediate server-side clearing and Google revocation behavior.
- The verification guide does not document the complete Stage 1–5 scope justifications, the exact OAuth prompt parameters, revocation fallback, or connection-scoped analytics acceptance.

## 3. Requirements

### 3.1 Public legal reconciliation

All three pages render exactly `Last updated: November 26, 2026`.

`src/pages/GoogleApiDisclosure.tsx` must:

1. Replace the computed date with the fixed date.
2. Explain all three requested scopes and their shipped purposes:
   - `youtube.readonly`: channel identification and health, uploaded-video browsing and complete video details at `/youtube`, and on-demand channel/video Analytics API v2 reports at `/analytics/youtube` after in-app acceptance of Analytics Purpose Clause Version 1, dated November 26, 2026.
   - `youtube.upload`: new videos/Shorts with owner-selected metadata and optional custom thumbnails through `thumbnails.set`.
   - `youtube.force-ssl`: owner-instruction published metadata editing through `videos.update` (title, description, tags, category, privacy, language, made-for-kids and synthetic-media declarations; implemented behind a hard-off activation gate at this baseline), and comment reading (Published and Held for review), creation, replies, own-comment edit/delete, and moderation (publishing or rejecting comments, with optional `banAuthor` on rejection; moving a published comment to hold is disabled at this baseline) on the owner's videos.
3. State that Postora does not replace existing video media bytes and does not delete videos. It must not claim that existing video metadata cannot be edited. The broad `youtube` scope remains unnecessary because Postora does not manage playlists, change channel settings, replace existing video bytes, or delete videos.
4. Add browse and metadata editing to the data-use summary while preserving the Analytics Purpose Clause wording and date.
5. Under **Revoking Access & Data Deletion → Option 1: Through Postora**, name **Profiles → Connected Accounts → Disconnect**. Explain that native disconnect revokes the Google OAuth token only when no other active connection of the same user shares that grant, clears stored credentials immediately, and ends analytics acceptance for the current connection. Disconnect is not a consent-withdrawal event; a new connection requires fresh acceptance (D13 = B). The access token is the fallback when the refresh token is absent or already invalid. An unconfirmed provider revocation fails closed rather than producing false success.
6. Keep valid links to the Google API Services User Data Policy, YouTube Terms (`https://www.youtube.com/t/terms`), Google Privacy Policy (`https://policies.google.com/privacy`), and Google Account Permissions (`https://myaccount.google.com/permissions`).

`src/pages/Privacy.tsx` must:

1. Add uploaded-video browsing/details and owner-instruction published metadata editing to §§2.1, 3.1, and the **Data We Collect from YouTube** subsection under §5.2. Comment creation/editing/moderation and connection-scoped on-demand analytics must be explicit in all three places.
2. In §7, distinguish native YouTube from the generic retention rule: credentials are cleared immediately on successful disconnect, and the Google grant is revoked when the user has no other active connection sharing it. On-demand analytics numbers are never stored. Acceptance history contains no analytics numbers and the old connection's acceptance no longer authorizes a new connection.

`src/pages/Terms.tsx` §4.1 must list video publishing, channel/video browsing, published metadata editing, comment management/moderation, and on-demand analytics under the owner's instructions and the applicable in-app purpose acceptance.

No edit is permitted to `src/features/youtube-analytics/domain/purposeText.ts`. The pinned English and Arabic strings, Analytics Purpose Clause Version 1, and 26 November 2026 date remain byte-identical.

### 3.2 Verification guide and approval package

Update `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` so its scope table, privacy block, API checklist, and demonstration requirements cover all three scopes and every Stage 1–5 purpose. Document `access_type=offline`, `prompt=consent select_account`, and the absence of `include_granted_scopes`; RFC 7009 refresh-token revocation with access-token fallback; shared-grant protection; immediate credential clearing; and in-app Analytics Purpose Clause v1 acceptance/withdrawal keyed to `connection_revision`. Remove the stale implication that the dedicated `yt-analytics.readonly` scope is currently requested. The current implementation requires the three existing scopes for analytics and does not request the dedicated analytics scope.

Create `docs/reports/2026-11-26-youtube-stage6-approval-package.md` with:

1. A complete scope → user capability → provider operation → exact code-path mapping for Stages 1–5.
2. Google's official quota costs and Postora's implemented limiter/budget model, including:
   - Data API default: 10,000 shared units/day for endpoints other than `search.list` and `videos.insert`, resetting at midnight Pacific.
   - Stage 2 reads: `channels.list`, `playlistItems.list`, and `videos.list`, 1 unit each; 30 requests/10 minutes and 300/24 hours per user.
   - Stage 3 edit: one `videos.list` plus `videos.update` = 51 units before read-after-write verification. New upload: `videos.insert` in its own default 100-call/day bucket at one unit/call; optional `thumbnails.set` costs 50 shared units.
   - Stage 4 reads: `commentThreads.list` and `comments.list`, 1 unit each; writes: `commentThreads.insert`, `comments.insert`, `comments.update`, `comments.setModerationStatus`, and `comments.delete`, 50 units each. Stage 4 limiters (`stage4:<action>:<user_id>`) apply per user, per action: 120 reads/minute per read action, 20 writes/minute per write action, and 5 ban-confirmation requests/24 hours per user, each fail-closed. The Stage 3 published-edit production gate is hard-off at the baseline and its write guard refuses every attempt; no numeric edit-write limiter is active.
   - Stage 5 Data API ownership/title enrichment: `videos.list`, 1 unit; shared `youtube-analytics:budget:data:<YYYY-MM-DD>` ceiling of 1,000 units/Pacific day. This caps Stage 5's draw and leaves up to 9,000 units of the documented default for other consumers; it is not a cross-feature reservation ledger.
   - Analytics API v2 `reports.query`: one quota unit/request per Google's data-model documentation. Postora caps attempts with `youtube-analytics:budget:analytics:<YYYY-MM-DD>` at 2,000/Pacific day. Per-user limits are 120 admissions/minute, 60 data reads/10 minutes, and 300 data reads/24 hours. The 2,000 value is Postora's ceiling, not a claimed Google allocation.
3. Release receipts and PR links, migrations `20261119130000` through `20261126120000`, an honest deployed-SHA verification summary, and the actual offline Deno, SQL, Vitest, and Playwright suite inventory present at the baseline. Repository evidence must not be described as live deployment evidence. Stage 6 performs no deployment and attaches no fabricated production receipt.
4. A masked, step-by-step Google OAuth Verification and Mr Saad demo script with exactly eight journeys: connect with chooser/permission dialog; channel and video browse; published metadata edit; new upload; comments and moderation; analytics acceptance and withdrawal; cross-tenant/missing-scope denial; disconnect/revoke/reconnect re-prompt.
5. A recording safety section that prohibits real tokens, cookies, customer data, private channel identifiers, OAuth client secrets, and unmasked personal information in captured evidence. Denial demonstrations use synthetic IDs or owner-controlled fixtures and never induce writes against another tenant.

### 3.3 Automated legal disclosure tests

Create `src/pages/__tests__/YouTubeLegalDisclosures.test.tsx` using Vitest, Testing Library, and `MemoryRouter`. Render all three real pages and assert:

- All three full scope URLs occur with their Stage 1–5 purposes.
- Publishing, uploaded-video browsing/details, published metadata editing, comment management/moderation, and on-demand analytics under Analytics Purpose Clause Version 1, November 26, 2026 are disclosed.
- The disclosure permits metadata editing but explicitly forbids video-byte replacement and video deletion. A negative assertion must target the obsolete statement rather than a broad substring that also matches the correct sentence.
- The four required external policy/account links have the exact expected `href` values.
- Every page renders exactly `Last updated: November 26, 2026`.
- The disclosure names Profiles → Connected Accounts → Disconnect and the connection-scoped acceptance/reconnect behavior.

The existing `src/features/youtube-analytics/tests/domain.test.ts` purpose-digest guard must remain unchanged and green.

## 4. Acceptance criteria

- [ ] The specification and plan exist at the required paths and accurately reflect the implementation baseline.
- [ ] All public-page requirements in §3.1 hold without changing product behavior or purpose text.
- [ ] The verification guide and approval package include every requirement in §3.2, with official source links and clear separation between repository facts and unverified production evidence.
- [ ] The legal disclosure test suite passes.
- [ ] `npx vitest run src/pages/__tests__/YouTubeLegalDisclosures.test.tsx src/features/youtube-analytics` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npx eslint --max-warnings=0 src/pages/GoogleApiDisclosure.tsx src/pages/Privacy.tsx src/pages/Terms.tsx src/pages/__tests__/YouTubeLegalDisclosures.test.tsx` passes.
- [ ] `clean-code-guard`, `test-guard`, and `docs-guard` findings are addressed.
- [ ] Only Stage 6 files are committed to `feat/youtube-stage6-disclosures-quota-package`; `graphify-out/cache/last_query_stamp` and unrelated files are excluded.
- [ ] No Edge Function changed, so no Edge Function redeployment is required.

## 5. Non-goals and evidence limits

- No live verification submission, live demo recording, production migration verification, OAuth grant change, rollout enablement, or Google quota-console reading.
- No implementation of a unified project-wide quota ledger. The 9,000-unit headroom is arithmetic from the documented default and Stage 5's own cap, not a guarantee when other consumers exhaust quota first.
- No claim that real deployed-file SHA parity, production migration application, or live provider behavior was checked in this offline task. The approval package names the evidence required before external submission and the receipts available in Git history.
- No new UI layout, styling system, translation architecture, API, schema, or dependency work.
