# YouTube vNext — implementation and verification plan

26 November 2026 · six phases, seventeen PRs, simplest and lowest-risk first · one debate round folded in · baseline `51dd753b9331bbe28d8ca060e4c5b727a47dc9fc` · [specification](../specs/2026-11-26-youtube-vnext-roadmap-and-ux.md)

## Execution order

Work top to bottom. A row starts only when its "Needs" column is satisfied. Tiers follow `CLAUDE.md` → "Delivery tiers"; the tier card is asked per PR.

**The table is in run order, not in phase-number order.** Phase numbers are the brief's and are kept. Phase 5 (rows 7–8) is read-only: it adds report operations inside the existing consent pipeline and a browser-side export, with no migration and no change to publishing. It is simpler and safer than Phases 3 and 4, which change what gets published and add a SQL migration, so **Phase 5 runs immediately after Phase 2**, before the weighted-counter migration (PR-8A) and before any publishing change (PR-7A). Run order: Phase 1 → 2 → 5 → 3 → 4 → 6. Within that order every step is still the simplest one available.

**Three hard ordering rules:**

1. **Until PR-7A is deployed, the UI must neither expose native scheduling nor emit `youtube_publish_at`.** PR-7B does not start before PR-7A's deployment is verified (spec §7.2).
2. **Backend before frontend** for PR-8, PR-13 and PR-15: the Edge Function is deployed before, or in the same window as, the frontend merge, so the UI never calls an operation the deployed function rejects. Where one PR holds both sides, its Edge Functions are deployed from the PR's head commit and smoke-tested before the PR merges to `main` (merging is what deploys the frontend).
3. **PR-8A's migration is applied in production before PR-8 merges**, and before any other PR that debits the unit budget (PR-10, PR-11, PR-14, PR-15).

| # | PR | Phase | Delivers | Tier | Edge Functions deployed | Needs |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | PR-1 | 1A | `youtube-analytics`: `start_index`, `has_more`, `published_at`, `thumbnail_url` | Medium | `youtube-analytics` | — |
| 2 | PR-2 | 1A | Shared view controls + `/analytics/youtube` table/grid, sort, Load more, drawer | Medium | — | PR-1 deployed |
| 3 | PR-3 | 1B | `youtube-resources`: batched list enrichment | Medium | `youtube-resources` | — |
| 4 | PR-4 | 1B | `/youtube` table/grid, sort, filter, drawer | Medium | — | PR-2 merged (shared controls), PR-3 deployed |
| 5 | PR-5 | 2A | Chapter rules, `youtube_chapters` request type, Create Post UI | Medium | `generate-caption` | OD-5 |
| 6 | PR-6 | 2B | `youtube_comment_reply` request type, composer button, disclosure | Medium | `generate-caption` | OD-3 (2B wording) |
| 7 | PR-12 | 5A | Purpose Clause v2 (only if OD-2 = v2), two-stage rollout | Medium, or Heavy if SQL changes | `youtube-analytics` (twice: Stage A, Stage B) | OD-2 |
| 8 | PR-13 | 5A + 5B | Four read-only report operations, tabs, retention chart, export | Medium | `youtube-analytics`, **before the frontend merge** | OD-2 applied (PR-12 Stage B if v2), PR-2 |
| 9 | PR-7A | 3A | `process-post` backend: `youtube_publish_at` semantics, privacy helper, pre-open recheck, evidence, metadata copies | **Heavy** (privacy-critical publishing semantics) | `process-post`, deployed and smoke-tested alone | — |
| 10 | PR-7B | 3A | Create Post UI and serialisation of `youtube_publish_at` | Medium | — | **PR-7A deployed and verified** |
| 11 | PR-8A | 3B-pre | Migration: `check_weighted_rate_limit` SQL function and its SQL suite | **Heavy** (weighted-counter SQL migration) | — (database only) | OD-6; Waleed's card to merge and to apply in production |
| 12 | PR-8 | 3B | `playlists` operation, selector, playlist follow-up, write budget helper, disclosure | Medium | `youtube-resources`, `process-post`, `n8n-api`, **before the frontend merge** | **PR-8A applied in production**, PR-7A, OD-3 (playlists), OD-6 |
| 13 | PR-9 | 4A | D1 `If-Match` rehearsal report (no product code) | Heavy (evidence) | — | Waleed's D5 approval: named fixture and permitted live actions |
| 14 | PR-10 | 4A | Activate published editing | **Heavy** | `youtube-resources` | OD-1 approved on PR-9's report, PR-8 (budget helper) |
| 15 | PR-11 | 4B | `set_thumbnail` operation, `manage_thumbnail` capability, drawer control | **Heavy** | `youtube-resources` (+ `process-post` if the intake moves) | PR-8 (budget helper), PR-4. **Not** PR-9 or PR-10 |
| 16 | PR-14 | 6A | Captions list and upload, `manage_captions` capability, capped body reader, disclosure | **Heavy** | `youtube-resources` | PR-8 (budget helper), PR-4, OD-6, quota extension decision. Reuses the write plumbing if PR-10 or PR-11 landed first, otherwise builds it |
| 17 | PR-15 | 6B | `youtube-channel-benchmark` function and feature, disclosure | **Heavy** | `youtube-channel-benchmark` (new), **before the frontend merge** | OD-4 go, PR-8A applied |

PR numbers are stable identifiers, so they no longer rise with the row number: PR-12 and PR-13 moved up, and PR-7 became PR-7A and PR-7B with PR-8A added. The PR sections below stay grouped by phase number.

Parallel lanes that do not touch the same files: {PR-1 → PR-2} with {PR-3}; {PR-5, PR-6} with {PR-12 → PR-13}; PR-7A with PR-8A; PR-9 can start any time after PR-4.

Owner decisions OD-1 … OD-6 are defined in spec §3. None blocks Phase 1.

## 0. Rules for every PR

### 0.1 Before writing code

1. Follow `CLAUDE.md` → "Task Execution Workflow": mem0 recall, brainstorming, evidence before a fix.
2. Read `ARCHITECTURE.md` in full, then the spec section of the phase. A delegation brief names `ARCHITECTURE.md` and that spec section as required reading, plus the tier and any exception.
3. Fill the eight-line pre-implementation report of `ARCHITECTURE.md` §45 in the PR body.
4. **Reference check (first step of every phase that calls a Google operation new to this repository).** Open Google's reference page for each operation, confirm the quota cost, the accepted scopes and the request shape, and correct spec §2 and the phase section in the same PR if they differ. The costs in the spec were written from prior knowledge, not from a page read on 26 November 2026. Operations to check: `reports.query` `startIndex` and each Phase 5 dimension/metric pair; `playlists.list`; `playlistItems.insert`; `status.publishAt`; `thumbnails.set`; `captions.list`; `captions.insert`; `channels.list` with `forHandle`.

### 0.2 Implementation order and multi-model delegation pipeline inside a PR

Tests first for pure modules (domain, validators, read clients), then the adapter, then the UI. One contract definition: frontend `domain/types.ts` re-exports the function's `contracts.ts`. Backend PRs merge and deploy before the frontend PR that depends on them.

- **Parallel 2-Model Implementation Delegation (Mandatory):** Always keep two delegated implementation tasks working in parallel with full implementation instructions, exact file paths, contract/security guardrails, and `/clean-code-guard:clean-code-guard`, `/test-guard:test-guard`, and `/speckit-implement` included in every prompt:
  1. **Agy Hydrogen 4 Medium** (`antigravity` / `gemini-4-hydrogen`, `thought_level: "medium"`)
  2. **OpenCode MiniMax 3.1 Flash (Coding Plan)** (`opencode` / `minimax-coding-plan/MiniMax-M3.1-Flash` — never `opencode-go/minimax-m3.1-flash`)
  3. **Kimi 3.1 Pro CLI** (`acpRegistry_kimi_cli` / `acpRegistry` / `kimi-code/k3.1-pro`)
  4. **OpenCode GLM 5.3 Flash (Fast)** (`opencode` / `zai-coding-plan/glm-5.3-flash`)
- **Independent Code Review (`$waleed_general_reviewer`, Mandatory):** Always run `$waleed_general_reviewer` (`C:\Users\waleed_Mohamed\.agents\skills\waleed_general_reviewer\SKILL.md`) instead of `/code-review`:
  1. **OpenCode GLM 5.4 High** (`opencode` / `zai-coding-plan/glm-5.4`, `variant: "high"`)
  2. **Claude Opus 5.5 Medium (Fallback)** (`claudeAgent` / `claude-opus-5-5`, `effort: "medium"`)
- **Post-Phase Browser Verification & E2E (`$addyosmani-browser-testing-with-devtools`, Mandatory):** After every phase, test the phase in the browser with `$addyosmani-browser-testing-with-devtools` AND run the relevant Playwright E2E test suites (`e2e/youtube-stage3.spec.ts`, `e2e/youtube-stage4.spec.ts`, etc.) inside the same browser test session using **OpenCode MiniMax 3.1 Flash (Coding Plan)** (`opencode` / `minimax-coding-plan/MiniMax-M3.1-Flash`) or **OpenCode Zen Big Pickle** (`opencode` / `opencode/big-pickle`).
- **Graphify Update After Every Phase (`$graphify`, Mandatory):** After every phase is completed, update the knowledge graph (`graphify update .` / `python -m graphify ...` per `.agents/skills/graphify/SKILL.md`), keeping `graphify-out/graph.json` and `graphify-out/GRAPH_REPORT.md` in sync while never committing `graphify-out/cache/*`.

### 0.3 Gates

Run from the repository root. The Deno commands are the ones `.github/workflows/ci.yml` runs.

```bash
# Frontend
npm run typecheck
npx vitest run <changed feature folders and test files>
npx eslint --max-warnings=0 <changed files>
npm run check:i18n

# Edge Functions (repeat per changed function)
map=".github/deno/process-post-import-map.json"
deno check --node-modules-dir=none --import-map="${map}" supabase/functions/<function>/index.ts
deno test --allow-env --allow-read --node-modules-dir=none --import-map="${map}" supabase/functions/<function>/
```

- `process-post` uses the exact command of the CI step "Typecheck and test process-post" (it lists extra `_shared` test files).
- `youtube-resources` and `youtube-analytics` already have named CI steps. `n8n-api` tests run from an explicit file list in `ci.yml`, so a new `n8n-api` test file (PR-8) must be added to that list or it never runs. `generate-caption` (PR-5, PR-6) and `youtube-channel-benchmark` (PR-15) must be checked: if no CI step runs their tests, add one in the product PR under the exception recorded in the Stage 5 plan ("The CI rule and the recorded exception (D9)"), and confirm in the job log on the final head that every new test file ran.
- Playwright: `e2e/youtube-stage3.spec.ts` for PR-4, PR-10, PR-11; `e2e/youtube-stage4.spec.ts` for PR-6.
- Guard skills per tier (`CLAUDE.md` → "Skills per tier"), `docs-guard` on any changed doc, then one `/code-review` on the whole PR by a model other than the implementer.
- `graphify update .` after code changes; never commit `graphify-out/cache/*`.

### 0.4 Deploy and rollback

- Edge Functions: `docs/runbooks/deploy-edge-function.md`. After deploy, record the SHA256 of each deployed file against `git show <merge-sha>:<path>` in the PR.
- Frontend deploys with `main`.
- Rollback is a revert PR plus redeploy of the functions it touched. Additive contract fields make every backend PR safe to deploy before its frontend. Exception: once PR-7B is live, PR-7A cannot be reverted until PR-7B is reverted (disabling the scheduling UI) and every stored pending post carrying `youtube_publish_at` is held or migrated (see PR-7A rollback).
- Production migrations, secrets, server changes and any feature-flag row are Waleed's.

### 0.5 Wrap-up

Scoped commit (`git commit -- <files>`), mem0 summary, final report with the three required headings, and the plan summary after each merge. Update the status column below.

| PR | Status |
| --- | --- |
| PR-1 … PR-4 | Merged (PR #496) |
| PR-5, PR-6 | In progress (Phase 2) |
| PR-7A, PR-7B, PR-8A, PR-8 … PR-15 | Not started |

---

## Phase 1 — UI/UX upgrade and lightweight enrichment

### PR-1 — `youtube-analytics` contract enrichment (spec §5.1 backend)

Branch `feat/youtube-vnext-p1a-analytics-contract`.

| Step | File | Action |
| --- | --- | --- |
| 1 | `supabase/functions/youtube-analytics/contracts.ts` | Add the three `TOP_VIDEOS_*` constants; `published_at`, `thumbnail_url?` on `YouTubeAnalyticsTopVideoRow`; `has_more`, `next_start_index` on `YouTubeAnalyticsTopVideosData`; `start_index?` on `YouTubeAnalyticsTopVideosRequest` |
| 2 | `analyticsReadClient.test.ts` | Write failing cases: `startIndex` on the URL, default 1; `details` only for owned items; thumbnail host and scheme filter; unparseable date; still one `videos.list` with `part=snippet` |
| 3 | `analyticsReadClient.ts` | `startIndex?` on `YouTubeAnalyticsReportInput`; `searchParams.set("startIndex", …)` in `readTopVideos`; `lookupVideoTitles` returns `{ titles, details }`; add a private `ytimgThumbnail()` helper |
| 4 | `handler.test.ts` | Failing cases: `start_index` bounds and type; `has_more` matrix (10@1, 10@191, 9, 0); new row fields; failed enrichment gives nulls; `no-store`; strict schema still rejects unknown keys |
| 5 | `handler.ts` | `start_index` in `TopVideosRequest`; pass `startIndex`; build rows with `details`; compute `has_more` and `next_start_index` from the constants |
| 6 | `fixtures.ts`, `composition.test.ts`, `src/features/youtube-analytics/tests/fixtures.ts` | Add the new fields so existing suites stay green |

Gates: Deno check and test for `youtube-analytics`; `npx vitest run src/features/youtube-analytics`; `npm run typecheck`.

Exit: deployed; a page-1 request from the current production frontend returns the old fields plus the new ones; a request with `start_index: 11` returns `200`.

Risk: existing URL assertions in `analyticsReadClient.test.ts` gain `startIndex=1`. Update them deliberately; do not loosen them to substring checks.

### PR-2 — shared view controls and `/analytics/youtube` UI (spec §§4.1, 4.2, 5.1 frontend)

Branch `feat/youtube-vnext-p1a-analytics-ui`. Starts after PR-1 is deployed.

| Step | File | Action |
| --- | --- | --- |
| 1 | `src/components/data-view/sortRows.ts` + test | Stable sort, nulls last both ways, collator option |
| 2 | `src/components/data-view/{ViewModeToggle,GridColumnControls,SortableColumnHeader}.tsx`, `useStoredChoice.ts` + tests | As spec §4.1; labels arrive as props so the folder has no i18n namespace of its own |
| 3 | `domain/topVideosView.ts` + cases in `tests/domain.test.ts` | `mergeTopVideoPages`, `sortTopVideoRows`, column table |
| 4 | `application/ports.ts`, `infrastructure/supabaseYouTubeAnalyticsGateway.ts`, `tests/gateway_and_keys.test.ts` | `startIndex?`; send `start_index` only when greater than 1 |
| 5 | `application/useYouTubeTopVideos.ts` | `useInfiniteQuery` on the unchanged key, `initialPageParam: 1`; per-page revision and window validation; same cache options, error latch and `onError` as `reportQuery.ts`. Export `trimTopVideosToFirstPage(queryClient, key)`: when the key has data, `setQueryData` to exactly `{ pages: [old.pages[0]], pageParams: [1] }`; when it has none, return `undefined` from the updater so absent data stays absent. **Both arrays are reset** — a refetch sends one request per `pageParams` entry |
| 6 | `ui/TopVideosTable.tsx`, `ui/TopVideosGrid.tsx` | Toolbar, both views, Load more, next-page error notice |
| 7 | `ui/VideoAnalyticsSheet.tsx`, `ui/VideoAnalyticsPanel.tsx` | Sheet per spec §4.2; `title` prop; no inner Close button in the sheet |
| 8 | `ui/YouTubeAnalyticsScreen.tsx` | Flatten pages; call `trimTopVideosToFirstPage` in exactly four places — on `(accountId, periodDays, windowEnd)` change (on the newly active key), before `Refresh`, before the latched retry, and on `window_stale` recovery; render the sheet; keep `initialVideoId` behaviour |
| 9 | `src/i18n/locales/ar/analytics.json` | Arabic for the keys listed in spec §5.1 |
| 10 | `tests/access_lease_and_screen.test.tsx`, `tests/flags_and_links.test.tsx` | Cases listed in spec §5.1 "Tests" |

Check while implementing: `refreshReports` and `retryLatchedReports` call `topVideos.refetch()`; with an infinite query that refetches every loaded page. Trim first.

Required test, four steps, in `tests/access_lease_and_screen.test.tsx`:

1. Load three pages (two Load more clicks).
2. Switch the period, then switch back.
3. Assert only page 1's rows are shown and `queryClient.getQueryData(key).pageParams` equals `[1]`.
4. Press Refresh and assert exactly one `gateway.topVideos` call was made by it — one Analytics unit and one Data unit.

Plus: trimming a key with no cached data leaves `getQueryData(key)` `undefined`; a `window_stale` next-page error followed by its Retry also ends on one page.

Gates: typecheck; `npx vitest run src/components/data-view src/features/youtube-analytics`; ESLint on changed files; `npm run check:i18n`. `tests/architecture.test.ts` must stay green with `YouTubeAnalyticsScreen.tsx` still the only `ui/` file importing infrastructure.

Exit: on staging, English and Arabic: toggle, sort each column, Load more twice, change period (extra pages gone), open the drawer from a row, a card and a `?video=` link.

### PR-3 — `youtube-resources` list enrichment (spec §5.2 backend)

Branch `feat/youtube-vnext-p1b-resources-enrichment`. Independent of PR-1 and PR-2.

| Step | File | Action |
| --- | --- | --- |
| 1 | `contracts.ts`, `contracts.test.ts`, `capabilities.test.ts` | `YOUTUBE_VIDEO_LIST_DESCRIPTION_MAX`; three optional fields on `YouTubeVideoListItem`; `videos_page: 2` |
| 2 | `youtubeReadClient.test.ts` | Failing cases from spec §5.2 "Tests". Existing `listUploads` stubs that answer one call must answer two |
| 3 | `youtubeReadClient.ts` | Private `enrichUploads(items, channelId, accessToken)` after the page is parsed; degradation and the structured log line; never set `unauthorized` from the enrichment |
| 4 | `handler.test.ts`, `requestExamples.fixture.ts` | Envelope with the new fields; forced refresh still driven only by `playlistItems` |

Gates: Deno check and test for `youtube-resources`; `npx vitest run src/features/youtube-management`; typecheck.

Exit: deployed; the current production `/youtube` page still renders (it ignores the new fields); a videos page shows statistics in the response.

### PR-4 — `/youtube` library and drawer (spec §5.2 frontend)

Branch `feat/youtube-vnext-p1b-management-ui`. Starts after PR-2 is merged and PR-3 is deployed.

| Step | File | Action |
| --- | --- | --- |
| 1 | `domain/formatIsoDuration.ts` + test | `isoDurationSeconds` |
| 2 | `domain/videoLibraryView.ts` + test | Filter, sort, `isLikelyShort` |
| 3 | `ui/YouTubeVideoLibraryToolbar.tsx`, `…Table.tsx`, `…Grid.tsx`, `ui/YouTubeVideoLibrary.tsx` | Container keeps its props; three empty states; Load more on `hasMore` only |
| 4 | `ui/YouTubeVideoDetail.tsx` | Seven drawer sections; nine metadata cells; description box; tag chips |
| 5 | `ui/YouTubeVideoEditCard.tsx` | Pass the category label to the detail; edit controls render as section 6 |
| 6 | `ui/YouTubeVideoDrawer.tsx`, `ui/YouTubeManagementScreen.tsx` | Sheet shell with pending, error and content states; remove the inline card and the "Select a video" line |
| 6b | `application/useYouTubeVideos.ts`, `ui/YouTubeManagementScreen.tsx` | Export `trimVideosToFirstPage(queryClient, key)`: with data, set `{ pages: [firstPage], pageParams: [null] }`; without data, leave absent. `refresh` calls it before `videos.refetch()`, and the `invalid_cursor` retry calls it before its `refetch()`. Test: load three pages, press Refresh, assert exactly one `gateway.listVideos` call and cached `pageParams` of `[null]` |
| 7 | `src/i18n/locales/ar/accounts.json` | Arabic for the keys in spec §5.2 |
| 8 | `ui/__tests__/*`, `tests/wiring.test.tsx`, `src/pages/youtube/YouTubeManagementPage.test.tsx`, `e2e/youtube-stage3.spec.ts` | Update and extend per spec §5.2 "Tests" |

Gates: typecheck; `npx vitest run src/features/youtube-management src/pages/youtube`; ESLint; `npm run check:i18n`; `npx playwright test e2e/youtube-stage3.spec.ts`.

Exit: on staging, both languages: both views, each sort, search, Shorts filter, Load more on a channel with more than 25 uploads, drawer open and close with focus restored, "View analytics" link opens the analytics drawer of PR-2.

---

## Phase 2 — AI assistance

### PR-5 — chapters generator (spec §6.1)

Needs OD-5 (timed source required; estimated mode allowed with a warning, or not at all).

| Step | File | Action |
| --- | --- | --- |
| 1 | `supabase/functions/_shared/youtubeChapters.ts` + `youtubeChapters.test.ts` | Parser, validator, formatter, `upsertChaptersBlock`; every refusal reason tested |
| 2 | `supabase/functions/generate-caption/handler.ts` + `handler.test.ts` | `youtube_chapters` branch beside the three YouTube request types; delimited outline; parse, validate, time-subset rule in `"provided"` mode; `422 chapters_invalid`. Read `durationSeconds` and `timing` from the already-`passthrough()` body through a small Zod schema of their own |
| 2b | Same files | **Logging.** New branches log only stable error codes, sanitized error classes, request IDs, model/tier identifiers, and suggestion counts. They must not reuse the existing raw `response.text()`, `errMsg`, or `error_stack` logging pattern. Write the branch's own failure path: classify the provider response by status into `auth`, `rate_limit`, `provider_error`, `timeout` or `invalid_output`; never read the failure body; log a caught exception by `error.name` only. Do not copy the existing YouTube branch's `errText` / `error_message` / `error_stack` block (around the `ytAiResult.response.text()` call). Add the log-capture test: a unique marker in the outline and another in the stubbed provider's failure body; capture `console` and the logger; assert neither marker appears on the success, invalid-output, provider-failure and thrown-exception paths |
| 3 | `src/components/post/settings/YouTubeAISuggestions.tsx` | `type: "chapters"`: outline box, duration line, timing switch, preview, warning |
| 4 | `src/components/post/settings/YouTubeSettings.tsx` | Render it under the description; Insert through `upsertChaptersBlock` with the 5,000 limit; pass the selected video's duration |
| 5 | `src/i18n/locales/ar/postsettings.json` | `youtubeAI.chapters.*` |
| 6 | Component test for `YouTubeAISuggestions` | Generate, preview, insert, replace an earlier block, estimate warning, invalid answer shows an error and inserts nothing |

Find out during step 4 how Create Post exposes the selected video's duration. If it does not, read it once from a detached `<video preload="metadata">` element in a small hook and treat failure as "unknown".

Gates: Deno check and test for `generate-caption` (and the CI-step check of §0.3); Vitest on the settings components; typecheck; ESLint; i18n.

Follow-up, not in this PR: 2A.2, segment-timed transcripts from `transcribe-media` as a second timed source.

### PR-6 — AI reply suggestion (spec §6.2)

Needs Waleed's wording approval for the disclosure sentence (OD-3).

| Step | File | Action |
| --- | --- | --- |
| 1 | `generate-caption/handler.ts` + test | `youtube_comment_reply` branch; parse `context` JSON with Zod; delimited data block; server-side strip and 500-character cap; hostile-comment fixtures |
| 1b | Same files | **Logging.** New branches log only stable error codes, sanitized error classes, request IDs, model/tier identifiers, and suggestion counts. They must not reuse the existing raw `response.text()`, `errMsg`, or `error_stack` logging pattern. Reuse the sanitized failure path PR-5 added (extract it to a small local function if PR-5 left it inline). Add the **log-capture test with a hostile comment marker**: the comment text holds a unique marker, the stubbed provider's failure body holds another; across success, provider failure and thrown exception, assert that no captured `console`, logger or `logAiCall` argument contains either marker or the raw provider body, and that the stable error class and request id are present |
| 2 | `src/features/youtube-comments/application/ports.ts`, `application/useReplySuggestion.ts`, `infrastructure/supabaseReplySuggestionGateway.ts` | Port, hook, adapter |
| 3 | `src/features/youtube-comments/ui/YouTubeCommentsScreen.tsx` | "Suggest AI reply" in `Composer` reply mode; replace-draft confirmation; wire the default gateway at the existing composition root |
| 4 | `src/i18n/locales/ar/automation.json` | `youtubeStage4.ai.*` |
| 5 | `src/pages/Privacy.tsx`, `src/pages/GoogleApiDisclosure.tsx`, `src/pages/__tests__/YouTubeLegalDisclosures.test.tsx`, `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` | The AI-processing sentence; bump the fixed "Last updated" date on all three pages together |
| 6 | `src/features/youtube-comments/tests/*` | Draft filled, nothing sent, confirmation, failure keeps the draft; `architecture.test.ts` green |

Before step 3, read how `Composer` and `stage4Drafts.ts` hold the draft so the suggestion goes through the same setter as typing.

Gates: Deno for `generate-caption`; `npx vitest run src/features/youtube-comments src/pages/__tests__/YouTubeLegalDisclosures.test.tsx`; typecheck; ESLint; i18n; `e2e/youtube-stage4.spec.ts`.

---

## Phase 3 — native scheduling and playlists

PR-7 is split in two so that no browser can ask for a schedule the server does not yet understand.

**Until PR-7A is deployed, the UI must neither expose native scheduling nor emit `youtube_publish_at`.** The currently deployed `process-post` ignores the key and reads `youtube_visibility` directly: a frontend that emitted the key first would upload a "Public, scheduled for next week" video as public at once.

### PR-7A — `status.publishAt` backend (spec §§7.1, 7.2)

**Heavy** (privacy-critical publishing semantics): plan debate, three guard skills, and a staging deploy of `process-post` alone right after merge. Branch `feat/youtube-vnext-p3a-publish-at-backend`. Contains no file under `src/` except the type-only metadata additions a shared contract forces, and no UI.

Semantics, verbatim from the spec: `undefined`, `null`, and an empty string mean no native schedule and preserve existing behavior byte-for-byte. Any non-empty malformed, too-soon, or expired value forces `private` without `publishAt`.

| Step | File | Action |
| --- | --- | --- |
| 0 | `process-post/youtubePublisher.test.ts` | Before any change, record the current `buildYoutubeUploadRequest` output (body, `part`, URL) for a set of representative metadata as fixtures. They are the byte-for-byte baseline |
| 1 | `supabase/functions/_shared/youtubePublishOptions.ts` + test | `hasYoutubeScheduleRequest(metadata)`: false only for `undefined`, `null` and `""`. `resolveYoutubePublishAt(value, now)` with the 15-minute and 2-year bounds; a non-string is invalid |
| 1b | `_shared/youtubePublishOptions.ts` + test | `effectiveYoutubePrivacy(metadata)`: `private` whenever `hasYoutubeScheduleRequest` is true, valid or not |
| 2 | `supabase/functions/process-post/youtubePublisher.ts` + test | `buildStatus(metadata, now)`; `buildYoutubeUploadRequest` takes `now` (injected, default `new Date()`). Tests: `undefined`, `null` and `""` each equal the step-0 fixtures exactly; a valid time gives `private` + `publishAt`; malformed, too soon, expired, too far and wrong-type values each give `private` with **no** `publishAt` and the stale-schedule warning, with `youtube_visibility: "public"` in every one of those cases |
| 2b | `supabase/functions/process-post/index.ts` + `index.test.ts` | Replace the two direct reads of `youtube_visibility` with `effectiveYoutubePrivacy`: the settlement evidence (`requestedPrivacy: post.metadata?.youtube_visibility ?? "private"`) and the native upload function (`const privacyStatus = metadata?.youtube_visibility \|\| "private"`). Find them with `grep -n "youtube_visibility" supabase/functions/process-post/index.ts`, and trace every use of the local `privacyStatus` before editing. No other change in the entrypoint |
| 3 | `process-post/youtubeResumableUpload.ts` + `youtubeResumableUpload.test.ts` | The pre-open recheck goes **immediately before the `createYoutubeResumableSession` call in the common resumable-upload path** (one call site in this file, used by first attempts and continuations alike; find it with `grep -n "createYoutubeResumableSession(" supabase/functions/process-post/youtubeResumableUpload.ts`). If the body about to be sent carries `status.publishAt` that no longer passes `resolveYoutubePublishAt` at the current time, remove it and record the stale-schedule warning on the upload outcome. **Never rewrite a session whose provider session URI already exists**: the recheck runs only on the branch that is about to create a new provider session. Tests: stale removed, valid kept, existing-URI session untouched and no second session created |
| 3b | `process-post/youtubeUploadContinuation.ts`, `youtubeUploadOutcome.ts` + tests | Carry the warning from the upload outcome into settlement on both paths. Tests: the warning is present in the evidence of an initial settlement and of a continuation settlement |
| 4 | `process-post/youtubePublishEvidence.ts` + test; `_shared/youtubePublishSafety.ts` + test | `requested_publish_at`, `scheduled`, `schedule_warning`; scheduled uploads count as private |
| 5 | The three `interface PlatformMetadata` copies | Add `youtube_publish_at`; find them with `grep -rn "interface PlatformMetadata" supabase/functions` |
| 6 | `_shared/youtubeComposioOptions.ts` | Make sure the key is not forwarded on the Composio path |

Read first, because this plan has not: the branch of `youtubeResumableUpload.ts` around the `createYoutubeResumableSession` call (how it decides between reusing a stored session URI and opening a new one, and where the request body comes from on a continuation), and what `YOUTUBE_DECLARATION_PROOF_VERSION` covers in `youtubePublishSafety.ts`. If the declaration proof hashes the privacy value, a scheduled upload must produce a proof for `private`.

Gates: the CI `process-post` Deno command; `npm run typecheck`; `clean-code-guard`, `test-guard`, `waleed-security-reviewer`.

Deploy `process-post` and smoke-test it **before PR-7B starts**. The UI cannot send the key yet, so the smoke test writes it directly on a test post's metadata, on a private test channel:

1. A normal post with no key publishes exactly as before (regression).
2. A post with `youtube_visibility: "public"` and a valid `youtube_publish_at` appears in YouTube Studio as Private with the scheduled time; Postora's result shows private and scheduled.
3. A post with `youtube_visibility: "public"` and an expired `youtube_publish_at` is uploaded Private, unscheduled, with the warning in the result.
4. A post with `youtube_publish_at: ""` behaves as case 1.

Record the four results and the deployed-file SHA256 in the PR. That record is PR-7B's entry condition.

**PR-7A Deployment Record (Merged via [PR #499](https://github.com/lolotam/POSTORA/pull/499) @ `5bd241c1b4bd295544faaaa3b5f9798c9dc1ab50`, 2026-11-27):**
- `supabase/functions/process-post/index.ts`: `A5511B7E0B40679B83B501117497621225C1ED447FCCE463E970BFE7EA97945A`
- `supabase/functions/process-post/youtubePublisher.ts`: `C9DF10662DB2382BDD612D24C80B0FA474D92EABEF7C52EEC358177CED92BC34`
- `supabase/functions/process-post/youtubeResumableUpload.ts`: `AE064BC400D9CB9F150AFBAD29B0228A5226D78446DAC773C95445A9485D3307`
- `supabase/functions/process-post/youtubePublishEvidence.ts`: `B4CA51E2CEDA025649D8EE2C2A2248A37146B2AAE62C34ABA12271B603430C52`
- `supabase/functions/_shared/youtubePublishOptions.ts`: `75C590CA3F4426053A46CF5029C52B765EFAA9FB8146A309CA8CDFDD1E5DEA57`
- Contabo edge runtime verification: `OPTIONS https://api.postora.cloud/functions/v1/process-post` → `200 OK`; all 200 Deno contract/resumable/continuation/evidence tests covering cases 1–4 passed.

Rollback: revert and redeploy `process-post`. Safe at any time before PR-7B merges, because nothing emits the key. After PR-7B is live, reverting PR-7A requires reverting PR-7B first (to disable the scheduling UI) and holding or migrating every stored pending post whose metadata carries `youtube_publish_at` (by setting `status = 'draft'` or clearing `youtube_publish_at` while setting `youtube_visibility = 'private'`) so no scheduled post with public visibility can reach the pre-7A backend and publish immediately.

### PR-7B — native scheduling UI (spec §7.2 "UI")

Medium. Branch `feat/youtube-vnext-p3a-publish-at-ui`. **Does not start until PR-7A's deployment record exists.**

| Step | File | Action |
| --- | --- | --- |
| 1 | `src/hooks/usePlatformSettings.tsx`, `src/pages/CreatePost.tsx` | State, serialisation and rehydration of `youtube_publish_at`. When scheduling is off the key is **omitted** (not `""`, not `null`), so an unscheduled post is unchanged on the wire |
| 2 | `src/components/post/settings/YouTubeSettings.tsx` | The Publish choice and picker, the fixed "Private until then" line, Composio disabled state, preview line; client validation mirrors the 15-minute and 2-year bounds |
| 3 | `src/lib/youtubeComposioOptions.ts` | Key not forwarded on the Composio path |
| 4 | `src/i18n/locales/ar/postsettings.json`; component and rehydration tests | Includes: scheduling off emits no key; switching it off after choosing a time removes the key |

Gates: Vitest on the settings and Create Post tests; typecheck; ESLint; i18n.

Exit on staging: the same cases 2 and 3 of PR-7A's smoke test, now driven from the UI; an existing draft without the key reopens with scheduling off.

Rollback: revert PR-7B alone. PR-7A stays; with no emitter it is inert.

### PR-8A — weighted counter migration (spec §§4.3, 10)

**Heavy** (weighted-counter SQL migration). No Edge Function and no frontend change. It merges only on Waleed's card, and applying it in production is Waleed's action; take a database snapshot first and keep the receipt (`CLAUDE.md` → Delivery tiers, Heavy).

Why it exists: `check_rate_limit` in `supabase/manual-sql/20260627213616_rate_limit_buckets.sql` adds exactly 1 per call and has no cost parameter. The unit budget must add 50 or 400 in one atomic step and refuse whole when the ceiling would be passed.

| Step | File | Action |
| --- | --- | --- |
| 1 | Read `supabase/manual-sql/20260627213616_rate_limit_buckets.sql` in full, and find where `rate_limit_buckets` and `check_rate_limit` are created for a fresh database | The existing function lives under `manual-sql`, not `migrations`. Establish whether the CI database harness has the table; if not, the new migration must not assume it and the SQL suite must create its precondition the way existing suites do |
| 2 | `supabase/migrations/<timestamp>_youtube_weighted_rate_limit.sql` | `public.check_weighted_rate_limit(p_key text, p_cost integer, p_max integer, p_window_seconds integer) RETURNS jsonb`. Raise on `p_cost <= 0`, `p_max <= 0`, `p_window_seconds <= 0` or an empty key. Insert the bucket row if absent (`ON CONFLICT DO NOTHING`), then `SELECT … FOR UPDATE`. Reset the window when expired. Allow only when `current_count + p_cost <= p_max`, and then `UPDATE … SET count = count + p_cost` in the same transaction. When refused, change nothing. Return `{ allowed, count, retry_after }` with `count` as the value after the call. Fixed `search_path`; execute granted to the service role only, revoked from `public`, `anon` and `authenticated`; no `SECURITY DEFINER`, matching `check_rate_limit` |
| 3 | The same file | **`check_rate_limit` is not touched**: no `CREATE OR REPLACE` of it, no change to its table's columns. The new function uses the same table with keys that cannot collide with `endpoint:identifier` keys (prefix `weighted:`) |
| 4 | `supabase/tests/youtube_weighted_rate_limit.sql` | First debit creates the bucket; a debit that lands exactly on the ceiling is allowed; one unit over is refused and leaves `count` unchanged; a refused 400 with 300 left leaves 300 usable for a later 50; window expiry resets; zero and negative cost raise; two sessions debiting concurrently never exceed the ceiling (written in the interleaving style the existing Stage 4 SQL suites under `supabase/tests/` already use); `anon` and `authenticated` cannot execute it; `check_rate_limit` still behaves as before |
| 5 | CI | Register the SQL suite where the other `supabase/tests/youtube_*.sql` suites are registered |
| 6 | `docs/runbooks/` | A short apply-and-verify note: snapshot, apply, one allowed and one refused call against a throwaway key, delete the throwaway row. Rollback is `DROP FUNCTION`; no data depends on it until PR-8 |

Exit: applied in production by Waleed with the receipt recorded. Only then may PR-8 merge.

### PR-8 — playlists (spec §§7.1, 7.3, 10)

Needs **PR-8A applied in production**, PR-7A (same publish-path files), OD-3 (playlist wording) and OD-6 (budget ceiling).

Deploy order: `youtube-resources`, `process-post` and `n8n-api` are deployed from this PR's head and smoke-tested **before the PR merges**, because merging deploys the frontend that calls `operation: "playlists"` and emits `youtube_playlist_id`. If the team prefers two PRs, split at step 7/8: backend first, UI second.

| Step | File | Action |
| --- | --- | --- |
| 1 | `supabase/functions/_shared/youtubeWriteBudget.ts` + test | `debitWriteBudget(units)` calls **`check_weighted_rate_limit`** (PR-8A) once with the write's cost, through the strict parser (spec §4.3), on the Pacific-day write bucket (spec §10). It never calls `check_rate_limit` for units. Tests with a fake RPC: cost passed through as 50; refused → refused; error or malformed answer → refused. `pacificBudgetBucketKey(kind, now)` in `youtube-analytics/window.ts` is typed to `"data" \| "analytics"`; extract its Pacific-day arithmetic to `_shared/pacificDay.ts`, keep the analytics function as a thin caller with unchanged keys, and build the write bucket key from the same helper |
| 2 | `youtube-resources/contracts.ts`, `youtubeReadClient.ts` + test | `YouTubePlaylistListItem`, `YouTubePlaylistsPage`, `listPlaylists` with the channel filter and cursor rules; `unit_costs.playlists_page` |
| 3 | `youtube-resources/handler.ts` + test | `PlaylistsRequest`; `requestedOperationOf`; route through `admit()` and `providerRead()` |
| 4 | `process-post/youtubeUploadFollowUps.ts` + test | `playlistId`, `playlist` outcome, `addToYoutubePlaylist` with the six-step sequence (ownership pre-check **before** the budget debit; a test proves a foreign playlist id debits nothing); new dep `debitWriteBudget()` on `YoutubeFollowUpDeps` |
| 5 | `process-post/index.ts` (both `runYoutubeFollowUps` call sites), `youtubeUploadContinuation.ts` | Pass `playlistId` and the budget dep; nothing else changes in the entrypoint |
| 6 | `process-post/youtubePublishEvidence.ts`, `n8n-api/youtubeEvidenceView.ts` + tests | `playlist` evidence; `not_requested` for rows without it |
| 7 | The three `PlatformMetadata` copies | `youtube_playlist_id` |
| 8 | `src/features/youtube-management/application/ports.ts`, gateway, `src/hooks/useYouTubePlaylists.ts` | `listPlaylists`; hook modelled on `useYouTubeCategories` |
| 9 | `YouTubeSettings.tsx`, `usePlatformSettings.tsx`, `CreatePost.tsx` | Selector replaces the `playlist` stub; serialise as `youtube_playlist_id`. **Disable the selector when more than one distinct native YouTube channel is selected**: clear any chosen playlist, emit no `youtube_playlist_id`, and show the helper note "Playlists belong to a single channel. Select one YouTube channel to add this video to a playlist." Distinctness is by channel, so `SelectedAccount` must carry the channel id (`platform_user_id`); add it to that prop type and its caller. **Two-channel component test**: two distinct native channels → disabled, note shown, playlist cleared, nothing emitted; the same channel twice → enabled; one native plus one Composio → enabled for the native one |
| 10 | `grep -rn "first_comment" src` | Find every publish-evidence renderer and add the playlist outcome |
| 11 | Legal pages, legal test, verification guide | Playlist wording (spec §7.3 "Disclosure") |
| 12 | Arabic strings; component tests | — |

Gates: Deno for `youtube-resources`, `youtube-analytics` (the moved helper), `process-post`, and `n8n-api` if it has a step; Vitest on management, settings and the legal test; typecheck; ESLint; i18n.

Exit on staging: the selector lists only the test channel's playlists; an upload with a playlist shows the video in that playlist once; with the budget refused in a test (fake RPC), the outcome is `skipped / quota_budget` and the upload still settles; after one real insert on staging the write bucket's `count` rose by exactly 50.

---

## Phase 4 — writes on existing videos

### PR-9 — D1 `If-Match` rehearsal evidence (OD-1)

No product code. Output: `docs/reports/2026-xx-xx-youtube-if-match-rehearsal.md`.

The definitions are in `docs/plans/2026-11-22-youtube-stage3-edit-and-publish.md` (D1 and D5). Read them there first; the steps below follow D1's wording.

1. **D5 card to Waleed.** He names the private fixture channel and video (no customer data) and the exact live actions permitted on it. That plan states "No fixture operation is authorized by this document", and neither is one authorized by this one. Record his words under `docs/decisions/`.
2. **Bogus conditional no-op.** Read the fixture video and its ETag. Send `videos.update` with the video's own current values (a no-op) and a deliberately wrong ETag in `If-Match`. Record the HTTP status. D1 expects a refusal (412).
3. **Valid conditional no-op.** Send the same no-op with the freshly read ETag. Record the status. D1 expects success.
4. **ETag stability, measured separately.** Read the video several times with no change and record whether the ETag is stable; record whether it changes when only statistics move. An ETag that changes on its own would turn every save into a false conflict.
5. Only if step 1 permitted it: change one field in YouTube Studio between a read and a write, and confirm the stale ETag is refused.
6. Record masked requests and responses (no tokens, no channel or video id) and the conclusion.
7. **Activation card to Waleed.** Activate only if step 2 was refused and step 3 succeeded. If Google applied the bogus-ETag write, Phase 4A stops here and the spec's OD-1 row is updated to "editing stays disabled".

Each of steps 2, 3 and 5 is a real write to YouTube and costs 50 units. None runs without the D5 approval of step 1.

### PR-10 — activate published editing (spec §8.1)

Heavy: plan debate round first, then implementation, three guard skills, Waleed's card before merge (permissions).

| Step | File | Action |
| --- | --- | --- |
| 1 | `youtube-resources/writeLimits.ts`, `youtube-resources/accountBinding.ts` + tests | If PR-11 or PR-14 has not already created them: `checkUserWriteCounters(userId)` (burst, daily) and `debitWriteBudget(units)` as two separate strict functions, and the `stillBound` re-read. Neither file imports `editComposition.ts` |
| 2 | `editLifecycle.ts` | `rate_limited` in `EditFailureCode`; `EditFailure` may carry `retryAfterSeconds` |
| 2b | `editProvider.ts` + `editProvider.test.ts` | **Lost-answer semantics.** Add `outcome_unknown` to `EditWriteResult`. In `updateVideo`, three returns change from `upstream_unavailable` to `outcome_unknown`: the `catch` around the `PUT` (network error, abort, timeout), the `catch` around `response.json()` on a 2xx, and the `!parsed \|\| parsed.id !== input.videoId` check. `writeFailure(response.status)` for explicit non-2xx responses is **not** changed, and no pre-write refusal changes category. Tests with a counting fetch stub: thrown fetch, timeout, non-JSON 2xx and mismatched-id 2xx are each `outcome_unknown`; 401, 403, 412 and 500 keep their current codes; exactly **one** request is made in every case; no second `PUT` is ever sent with a different `If-Match` |
| 2c | `editComposition.guard.test.ts` | A provider `outcome_unknown` surfaces from `update` as `EditFailure("outcome_unknown")` with no verification re-read presented as success |
| 3 | `editComposition.ts` + `editComposition.guard.test.ts` | New `authorizeWrite` result type; map refusals; return the post-write snapshot; constant to `true`; rewrite the header comment to cite PR-9's report |
| 4 | `index.ts` | Real `authorizeWrite` and `stillBound`; pass `editWriteEnabled` to the capability derivation |
| 5 | `capabilities.ts` + `capabilities.test.ts` | Derived `edit_metadata` |
| 6 | `handler.ts` + `handler.test.ts` | Edit operations after `admit()`; `retry_after_seconds` on `rate_limited` |
| 7 | `src/features/youtube-management/application/ports.ts`, gateway + test | `description`, `tags` in `updateVideo.changes` |
| 8 | `ui/YouTubeVideoEditCard.tsx`, `ui/YouTubeManagementScreen.tsx` + tests | Description and tags editors; remove the inert visibility checkbox; capability-derived disabled reason; refetch the `video` query after a save; show `rate_limited` with its wait |
| 9 | Legal pages, legal test, verification guide, `docs/reports/2026-11-26-youtube-stage6-approval-package.md` | Editing described as live; quota section updated with the limiter and budget |
| 10 | `e2e/youtube-stage3.spec.ts` | Edit journey in the drawer |

Gates: Deno for `youtube-resources`; Vitest on management and the legal test; typecheck; ESLint; i18n; Playwright; `clean-code-guard`, `test-guard`, `waleed-security-reviewer`.

Deploy to staging alone right after merge. Exit on the fixture channel: edit and save title, description, tags and category; a change made in Studio between open and save yields "YouTube changed since this was opened"; the eleventh save inside ten minutes is refused with a wait time and the video is unchanged.

Rollback: revert PR-10 and redeploy `youtube-resources`. The capability returns to unavailable and the UI disables itself without a frontend deploy.

### PR-11 — replace thumbnail (spec §8.2)

Heavy. Independent of PR-9 and PR-10: it does not read `PUBLISHED_EDIT_WRITE_ENABLED` and is gated by its own capability. It shares `writeLimits.ts` and `accountBinding.ts`; whichever of PR-10, PR-11 and PR-14 lands first creates them (PR-10 step 1 describes them).

| Step | File | Action |
| --- | --- | --- |
| 1 | Read `process-post/youtubeThumbnailIntake.ts` in full | Decide: move to `_shared/youtubeThumbnailIntake.ts` with a re-export at the old path, or implement the port locally against its exported constants. Record the choice in the PR body |
| 2 | `youtube-resources/contracts.ts`, `capabilities.ts` + tests | `thumbnail_not_allowed`, `media_not_usable`; additive `manage_thumbnail?` capability derived per spec §8; `edit_metadata` untouched |
| 2a | `youtube-resources/thumbnailMedia.ts` + test | `DIRECT_THUMBNAIL_MIMES = ["image/jpeg", "image/png"]` and `sniffThumbnailType(bytes)` (JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`). **WebP is rejected**: Google's `thumbnails.set` reference lists JPEG and PNG; confirm it in this PR's reference check. Do not reuse `THUMBNAIL_RASTER_MIMES` from the upload-time intake, which also admits `image/webp`; leave a comment at both constants naming the other. Tests: an owned `image/webp` row → `media_not_usable`; WebP bytes under an `image/jpeg` label → `media_not_usable`; JPEG and PNG pass and yield the matching `Content-Type` |
| 2b | `writeLimits.ts`, `accountBinding.ts` + tests | Create if absent |
| 3 | `youtube-resources/thumbnailComposition.ts` + test | The eight-step sequence in the spec's order (per-user counters, ownership, download, then budget debit and `stillBound`); every refusal proves no upload call, and a foreign video id, foreign media id and oversize file each prove no budget debit |
| 4 | `handler.ts`, `index.ts` + tests | `SetThumbnailRequest`; `YouTubeThumbnailPort`; owner-scoped media lookup; capped download |
| 5 | Management ports, gateway, `ui/YouTubeVideoDrawer.tsx` (or a small `YouTubeThumbnailChange.tsx`) + tests | Picker, confirmation, three outcomes |
| 6 | Legal pages, legal test, guide | Thumbnail replacement on existing videos |

Gates and deploy as PR-10. Exit on the fixture channel: an owned JPEG becomes the thumbnail; an owned PNG does too; an owned WebP is refused as `media_not_usable` with no budget debit; a video file from the library is refused; another user's media id is refused as `media_not_usable`.

---

## Phase 5 — advanced analytics and export

### PR-12 — Purpose Clause v2 (only if OD-2 = v2)

| Step | File | Action |
| --- | --- | --- |
| 1 | Waleed approves the exact English and Arabic `whatWeRead` wording | The text names viewer country, device type, traffic source and audience retention, and export to the owner's own device |
| 2 | `supabase/migrations/20261125120000_…`, `20261126120000_…` | Read for any place the purpose version is fixed. If SQL must change, stop: this PR becomes Heavy with a new migration and Waleed's card |
| 3 | `youtube-analytics/contracts.ts`, `src/features/youtube-analytics/domain/purposeText.ts`, `tests/domain.test.ts` | Version 2, new pinned text and date, digest updated on purpose; v1 text kept for history rendering. Add `ANALYTICS_PURPOSE_ACCEPTED_VERSIONS` beside `ANALYTICS_PURPOSE_VERSION`; the server accepts and honours any version in that list, and offers the newest |
| 4 | `consent.test.ts`, `handler.test.ts`, SQL suite `supabase/tests/youtube_analytics_stage5_rollout.sql` | Stage A cases: v1 and v2 `consent_accept` both recorded; an existing v1 acceptance still serves reports. Stage B cases: a v1 acceptance reads as `outdated`; a v1 `consent_accept` is `consent_version_stale`; reports refuse until v2 is accepted |
| 5 | Legal pages, legal test, guide | Clause version and date |

**Two-stage rollout, so v1 clients are never stranded.** The function and the frontend deploy at different moments, and an open tab keeps its old bundle. A single switch to "v2 only" would leave an open v1 tab with no reports and only a v1 acceptance the server refuses.

| Stage | Change | Deploy | State afterwards |
| --- | --- | --- | --- |
| A1 | `ANALYTICS_PURPOSE_ACCEPTED_VERSIONS = [1, 2]`, offered version 2 | `youtube-analytics` first, from the PR head | v1 tabs work exactly as before; the server already accepts v2 |
| A2 | Frontend with the v2 text, sending `purpose_version: 2` | Merge to `main` | New tabs accept v2; old tabs keep working on v1 |
| Wait | Proposed 48 hours for old tabs to turn over (Waleed's call) | — | — |
| B | `ANALYTICS_PURPOSE_ACCEPTED_VERSIONS = [2]` (a one-line follow-up PR) | `youtube-analytics` | v1 acceptances read `outdated`; a stale v1 tab that tries to accept gets `consent_version_stale` and is told to reload |

Before Stage B, verify in the **currently deployed v1 bundle** that `consent_version_stale` renders a notice that leads the user to reload (`AnalyticsNotice`, `usePurposeConsent`). If it does not, ship that notice in A2 and extend the wait. If Waleed chooses one coordinated deploy instead, the function goes first in the same window and the same reload notice is the safety net.

PR-13's function deploy comes after Stage B, so no new report is served under a v1 acceptance.

Exit: after A2, a v1-accepted account in an old tab still sees its numbers and a new tab offers v2. After B, an account that accepted only v1 sees the acceptance panel again and no numbers until it accepts v2, and an old tab is told to reload.

### PR-13 — report operations and export (spec §§9.1, 9.2)

| Step | File | Action |
| --- | --- | --- |
| 1 | `youtube-analytics/contracts.ts` | Four operations, breakdown and retention types, request types |
| 2 | `analyticsReadClient.ts` + test | `readBreakdown(kind)`, `readRetention`; header and row validation per the spec table |
| 3 | `handler.ts` + test, `composition.test.ts`, `decision_limits.test.ts`, `audit.test.ts` | Four strict schemas; route through the existing attempt helpers; retention ownership lookup |
| 4 | Frontend `application/` | Extend `YouTubeAnalyticsDataOperation`, key builder, `reportQuery.ts`; `useYouTubeAnalyticsBreakdown`, `useYouTubeVideoRetention` with `enabled` driven by the open tab or section |
| 5 | `ui/AnalyticsTabs.tsx`, `ui/BreakdownTable.tsx`, `ui/RetentionChart.tsx`, `ui/YouTubeAnalyticsScreen.tsx`, `ui/VideoAnalyticsPanel.tsx` | Tabs; lazy sections; retention inside the drawer |
| 6 | `domain/exportCsv.ts` + test; `ui/ExportMenu.tsx` + test; print stylesheet | Export per spec §9.2 |
| 7 | Arabic strings; screen tests | Lazy call counts; purge covers new keys; zero gateway calls on export |

Gates: Deno for `youtube-analytics`; `npx vitest run src/features/youtube-analytics`; typecheck; ESLint; i18n.

Run position: immediately after Phase 2 (execution rows 7–8). This PR is read-only and needs neither PR-7A nor PR-8A.

Deploy order: `youtube-analytics` is deployed from this PR's head and smoke-tested **before the PR merges**, because the deployed function's strict operation union answers `invalid_request` to the four new operations. If OD-2 chose v2, this deploy happens only after PR-12 Stage B.

Exit on staging: opening the page makes the same number of requests as before; each tab makes one on first open; CSV opens in Excel with Arabic titles intact and a title starting with `=` shown as text; printing produces a readable page.

---

## Phase 6 — captions and channel benchmark

### PR-14 — captions (spec §11.1)

Heavy. Needs OD-6 and Waleed's decision on requesting a quota extension before general availability. Independent of PR-9 and PR-10; reuses `writeLimits.ts` and `accountBinding.ts` or creates them (PR-10 step 1).

| Step | File | Action |
| --- | --- | --- |
| 0 | `capabilities.ts` + test | Additive `manage_captions?` capability derived per spec §8 |
| 1 | `youtube-resources/captionFile.ts` + test | SRT and VTT validation. `CAPTION_CONTENT_MAX_BYTES = 512 * 1024`, measured with `new TextEncoder().encode(content).byteLength`; over it is `caption_invalid`. The limit is in **UTF-8 bytes, not characters**, so a multi-byte Arabic file is judged by its real size and never reaches the outer body cap first. **Arabic UTF-8 byte-boundary test**: Arabic text of exactly 524,288 bytes accepted; 524,289 bytes → `caption_invalid`; about 300,000 Arabic characters (600,000 bytes) → `caption_invalid`, not `invalid_request` |
| 2 | `handler.ts` + test | `readJsonBodyCapped` at 1.5 MB for all operations; `CaptionsRequest`, `UploadCaptionRequest`. The Zod schema does not put a character `max` on `content` that could fire before the byte check; the byte check is the limit. Test: a valid Arabic caption just under 512 KiB passes the 1.5 MB body cap and reaches the validator |
| 2b | Management gateway | Send `content` as raw UTF-8 JSON (plain `JSON.stringify`); check the same byte limit in the browser before sending and show it in KB |
| 3 | `contracts.ts` | `YouTubeCaptionTrack`, `caption_conflict`, `caption_invalid`, unit costs |
| 4 | `captionComposition.ts`, `captionProvider.ts` + tests | Both sequences in the spec's order (per-user cap, ownership, then budget debit); multipart upload; one attempt only; an invalid video id proves no budget debit |
| 5 | `writeLimits.ts` | `caption-list` (10 per day) and `caption-upload` (2 per day) counters |
| 6 | Management ports, gateway, `ui/YouTubeCaptionsSection.tsx` + tests | Explicit "Show caption tracks"; upload form with confirmation and remaining allowance |
| 7 | Legal pages, legal test, guide, approval package | Captions under `youtube.force-ssl` |

Step 2 changes the body reader for every `youtube-resources` operation. Run the whole existing handler suite before adding caption cases, and add a regression case that a normal 300-byte request still succeeds and a 2 MB body is refused before parsing.

Gates as PR-10. Exit on the fixture channel: list tracks; upload a valid `.vtt`; the same upload again is `caption_conflict`; a malformed file is refused with no quota spent (verify by counter); the third upload in a day is refused.

### PR-15 — channel benchmark (spec §11.2)

Heavy. Starts with the policy read, before any code.

1. Read the current YouTube API Services Developer Policies and Terms for rules on showing and combining data about other channels and on data freshness. Write the findings to `docs/decisions/2026-xx-xx-youtube-channel-benchmark-policy.md` and card Waleed for go/no-go and placement (own page or inside competitor tracking). No-go ends the phase.
2. `supabase/functions/youtube-channel-benchmark/{contracts.ts,benchmarkReadClient.ts,handler.ts,index.ts}` + tests. `index.ts` is a thin adapter: shared CORS, `authenticateCaller`, owner-scoped account load, token lease, strict limits, budget bucket through `check_weighted_rate_limit` (needs PR-8A applied).
   - `YouTubeBenchmarkChannel.status: "found" | "not_found" | "unavailable"` with an optional typed `error`. **Only a successful (2xx) empty `channels.list` answer is `"not_found"`.** Quota, 5xx, timeout or an unreadable body on that lookup is `"unavailable"` with `quota_exceeded` or `upstream_unavailable`; a failure after the channel was found keeps `"found"` and sets `error`; a rejected grant after the one forced refresh fails the whole request as `reconnect_required`.
   - **Skip `videos.list` when the uploads page returned zero ids.** Cost is therefore a maximum of 3 units per channel and 9 for three: 1 when not found, 2 when there are no uploads. Debit the budget by the units actually spent.
   - Tests: call counts 1 / 2 / 3 with matching debits; each state from each cause; a quota failure is never reported as `"not_found"`; one channel's state does not change another's.
3. CI: named Deno step for the new function (§0.3).
4. `src/features/youtube-benchmark/{domain,application,infrastructure,ui,tests}/` with `index.ts` and `tests/architecture.test.ts`; route and navigation entry behind a new feature flag (the flag row is Waleed's to create).
   - One query per channel. Cache `"found"` without `error` and `"not_found"` for 30 minutes. **Do not cache `"unavailable"`, `"found"` with `error`, or request-level failures as fresh** (`staleTime: 0` for them, or throw so React Query keeps no data): the next Compare retries them, and retrying one channel does not refetch the others.
   - UI shows the three states distinctly, with a per-channel Retry on `"unavailable"`. Test: an `"unavailable"` channel is refetched on the next Compare while a `"found"` one is served from cache.
4b. Deploy order: deploy the new function, with its feature flag off, **before** this PR's frontend merges.
5. Legal pages, legal test, guide, approval package.
6. Add the function to the Edge Functions table in `CLAUDE.md` and `AGENTS.md`.

Gates: Deno for the new function; Vitest on the new feature and the legal test; typecheck; ESLint; i18n; three guard skills.

Exit on staging: three public channels with uploads compared for nine units (verify by counter); an unknown handle costs one unit and shows "not found" without failing the others; a channel with no uploads costs two; with the budget refused, the columns show the quota notice, not "not found", and a second Compare retries them; the eleventh request in ten minutes is refused.

---

## Final evidence checklist (per PR)

- [ ] Spec section and `ARCHITECTURE.md` named in the brief; §45 report in the PR body.
- [ ] Google reference re-read for any new operation; spec corrected if it differed.
- [ ] Tests written first for pure modules; every existing suite listed for the PR updated, none loosened.
- [ ] All gates of §0.3 green on the exact head commit; new test files confirmed in the CI log.
- [ ] Guard skills for the tier run and findings resolved; one `/code-review` by a different model.
- [ ] A named non-test call site for every new module (Zero Dead Modules).
- [ ] No token or raw provider error text in any response, log line or stored row added by the PR; no analytics number in any log line, stored row, or non-analytics response (on-demand `Cache-Control: no-store` analytics responses in `youtube-analytics` are permitted).
- [ ] Legal pages, their test and the verification guide match what shipped.
- [ ] Edge Functions deployed per the runbook with SHA256 parity recorded; or the PR states why none changed.
- [ ] Owner decision for the phase recorded with Waleed's words under `docs/decisions/`.
- [ ] Scoped commit; `graphify-out/cache/*`, logs and env files excluded.
