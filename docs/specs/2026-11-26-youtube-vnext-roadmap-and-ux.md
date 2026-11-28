# YouTube vNext — full feature suite and UX upgrade

26 November 2026 · six phases, ordered simplest first · tiers per phase in §2 · implementation baseline `51dd753b9331bbe28d8ca060e4c5b727a47dc9fc` (`feat/youtube-vnext-roadmap-and-ux`) · [implementation plan](../plans/2026-11-26-youtube-vnext-roadmap-and-ux.md)

Amended 27 November 2026: **Phase 7** (§14) added after Phases 1–6 shipped — UX debug fixes, an embedded drawer player and five creator extensions, `PR-15A` and `PR-16` … `PR-20`. Phase 7 baseline: `origin/main` at `24ec1698` (PR #506).

## 1. Outcome

One roadmap that takes the shipped YouTube Stages 1–6 to a complete creator surface:

1. `/analytics/youtube` and `/youtube` get table and grid views, numbering, sortable columns, paging and a side drawer, fed by two small additive contract enrichments.
2. AI drafts chapters for a new upload and a reply for a comment. Nothing is sent without the creator.
3. A new upload can be scheduled natively on YouTube and added to a playlist.
4. Published metadata editing is activated and an existing video's thumbnail can be replaced.
5. Analytics gains traffic source, geography, device and retention reports, plus browser-side export.
6. Caption tracks can be listed and uploaded, and public channels can be compared.

Every phase is independently shippable. A later phase never blocks an earlier one.

**Rules that hold in every phase** (from `ARCHITECTURE.md` §§4, 12–17, 22, 26, 33 and `AGENTS.md` rule 1, "Edge Functions run under the service role, so RLS is not enforcing tenancy"):

- Identity comes from the JWT only. A body `user_id` is never read. Every account row is loaded with `id` **and** `user_id` and re-checked in code; a foreign account and a missing one are the same `404 not_found`.
- A video is treated as owned only when Google returns it with `snippet.channelId` equal to the bound channel. A foreign video and an absent one are the same answer.
- No raw provider error text, status line, SQL fragment or token reaches a response or a log. Failures map to the stable codes in each function's `contracts.ts`.
- Every provider call has an explicit timeout. A non-idempotent write (comment, playlist insert, caption insert) is sent once and never retried; a lost answer is `unknown` / `outcome_unknown`.
- Limiters that fence a **write** fail closed: an unreadable counter refuses the write.
- `youtube-analytics` responses keep `Cache-Control: no-store`, and no analytics number is written to the database, a log or browser storage.
- Contracts stay single-sourced: frontend `domain/types.ts` re-exports the function's `contracts.ts` (§22). All wire changes are additive.
- UI layering stays `ui → application → domain`; only the composition root imports `infrastructure`; no feature deep-imports another feature (enforced by each feature's `tests/architecture.test.ts`).
- Arabic and English ship together. New strings use the namespace named per phase, with English defaults inline and Arabic in `src/i18n/locales/ar/<namespace>.json`; `npm run check:i18n` gates it.

## 2. Phase map

| Phase | Scope | Why this position | Tier | New Google cost | Migration |
| --- | --- | --- | --- | --- | --- |
| 1A | `/analytics/youtube` most-viewed table/grid, sort, Load more, drawer | Pure UI plus fields already in a response we fetch | Medium | 0 for enrichment; each Load more = 1 Analytics + 1 Data unit | No |
| 1B | `/youtube` library table/grid, sort, filter, drawer | Pure UI plus one batched read | Medium | +1 Data unit per videos page | No |
| 2A | AI chapters in Create Post | No Google call; one new AI request type and a pure validator | Medium | 0 | No |
| 2B | AI reply suggestion in the comment studio | No Google call; draft only | Medium | 0 | No |
| 3A | Native scheduled publish (`status.publishAt`) | Touches the publish path, one field; a mistake publishes a video early | **Heavy** (privacy-critical publishing semantics) | 0 | No |
| 3B-pre | Weighted counter SQL function (§4.3) | Prerequisite of every 50- and 400-unit budget debit | **Heavy** (migration) | 0 | **Yes** |
| 3B | Playlist selector and post-upload insert | New read operation plus a non-idempotent follow-up | Medium | 1 per list page; 1 + 50 per insert | No (uses 3B-pre) |
| 4A | Activate published metadata editing | First write on existing videos; gated by owner evidence (OD-1) | **Heavy** | 53 per save | No (verify) |
| 4B | Replace an existing video's thumbnail | Write, but no lost-update risk | **Heavy** | 51 per change | No |
| 5A | Traffic, geography, device, retention reports | Four new operations inside the consent pipeline (OD-2) | Medium; Heavy if OD-2 needs a migration | 1 Analytics unit each; retention +1 Data | Verify |
| 5B | CSV and print export | Browser only | Light-sized, ships inside 5A's PR (Medium) | 0 | No |
| 6A | Caption list and upload | Most expensive call in the API (400 units) | **Heavy** | 50 per list, 1 + 400 per upload | No |
| 6B | Public channel benchmark | Reverses a Stage 2 invariant; policy review (OD-4) | **Heavy** | Up to 3 per channel (1 not found, 2 no uploads) | No |
| 7.0 | UX debug fixes: AI Suggest context, embedded drawer player, edit toggle, rich thumbnail dialog, caption error reporting (§14.1) | Fixes on shipped surfaces; changes the CSP and adds browser-side storage writes (OD-7, OD-8) | **Heavy** | 0 (the player is an embed, not an API call) | No (verify storage policies) |
| 7A | Segment-timed transcription, `.srt`/`.vtt` builder, auto-timed chapters (§14.2) | Additive field on an existing function plus pure formatters | Medium | 0 | No |
| 7B | Upload-time captions and the `captions.insert` follow-up (§14.3) | Fourth non-idempotent follow-up; caption text stored on the post (OD-9) | **Heavy** | 400 per captioned upload | No |
| 7C | Inline "+ New playlist" (`playlists.insert`) (§14.4) | New write; reverses a stated non-goal and a pinned legal sentence (OD-10) | **Heavy** | 50 per playlist | No |
| 7D | AI title and thumbnail packaging score (§14.5) | No Google call; one AI request type and a pure scorer | Medium | 0 | No |
| 7E | Privacy editing of a published video in the drawer (§14.6) | Server contract already live; UI exposes a visibility-changing write (OD-11) | **Heavy** | 53 per save (unchanged) | No |

**Phase numbers and run order.** Phase numbers follow the brief and are kept so the two documents stay comparable. By risk, however, Phase 5 is simpler than Phases 3 and 4: it is read-only, lives inside a pipeline that already exists, and needs no migration (unless OD-2 finds one) and no change to publishing. Phases 3 and 4 change what gets published and add a SQL migration. **Phase 5 therefore runs immediately after Phase 2**, before the weighted-counter migration and before any publishing change. The run order is Phase 1 → 2 → 5 → 3 → 4 → 6; the plan's execution table is written in that order.

**Backend before frontend, always.** No frontend may call an operation, send a field or show a control whose Edge Function side is not deployed and smoke-tested. This matters most where the new field changes who can see a video (§7.2) and where the frontend would call an operation the deployed function rejects (§§7.3, 9, 11.2). Each affected phase states its own rule.

Unit costs and scopes for operations that are new to this repository come from prior knowledge of Google's reference, not from a page read in this session. **Each phase's first plan step re-reads the Google reference page and corrects this table before any code is written** (plan §0.1 step 4).

**Values this specification proposes, which the brief did not set.** They are defaults for Waleed to confirm or change, not requirements handed down: the 500-character list description; the grid default of 5 columns; the 15-minute and 2-year bounds on `publishAt`; leaving privacy changes out of the first edit activation; the 2 MB thumbnail cap; the caption content cap of 512 KiB in UTF-8 bytes, 10 caption lists and 2 caption uploads per user per day; every ceiling in §10; the benchmark limits of 10 per 10 minutes and 30 per day; and the AI caps of 8,000 input characters for chapters and 500 output characters for a reply. The brief's own numbers (10 rows per page, `start_index` 1..191, 10 edits per 10 minutes and 50 per 24 hours, up to 3 benchmark channels) are used as given.

## 3. Brief versus repository — owner decisions

The brief conflicts with the baseline in six places for Phases 1–6 (OD-1 … OD-6) and in six more for Phase 7 (OD-7 … OD-12). Nothing here is silently resolved; each is a card for Waleed before its phase starts.

| ID | Phase | Brief says | Repository says | Recommendation |
| --- | --- | --- | --- | --- |
| OD-1 | 4A | Replace `PUBLISHED_EDIT_WRITE_ENABLED = false` with a write rate limiter and `stillBound`. | The gate exists for a different reason. `editComposition.ts` says activation "requires a code change backed by approved D1 (If-Match enforcement) and D5 (fixture/rollout) evidence". The Stage 3 plan defines them: **D1** — "Keep editing disabled if Google ignores If-Match or enforcement is unproven… A bogus and valid conditional no-op on a named private fixture is the first provider rehearsal; measure ETag stability separately." **D5** — "Approve activation controls and name any private fixtures and permitted live actions… each real write rehearsal needs explicit scope. No fixture operation is authorized by this document." Waleed approved D1–D3 on 2026-11-22; D5 is still open. A limiter is neither piece of evidence. | Phase 4A starts only after (a) Waleed gives the D5 approval naming the fixture and the permitted live actions, (b) the D1 rehearsal is run and recorded, and (c) Waleed approves activation on that record. If Google ignores `If-Match`, 4A does not ship. 4B and 6A do not depend on D1 (§8, §11.1). |
| OD-2 | 5A | The new reports are "governed by the existing connection-scoped Analytics Purpose Clause v1". | The pinned v1 text (`src/features/youtube-analytics/domain/purposeText.ts`, `whatWeRead`) names exactly: views, watch time, average view duration, subscribers gained and lost, likes, comments, shares. It does not name viewer country, device type, traffic source or audience retention. Stage 6 forbids editing that file. | Publish **Purpose Clause v2** naming the new data and require re-acceptance. The mechanics already exist (`consent.state = "outdated"`, `consent_version_stale`). Alternative: Waleed rules that v1 covers them and records the ruling. |
| OD-3 | 2B, 3B, 4, 6 | Not mentioned. | `GoogleApiDisclosure.tsx` line 98 states Postora "does not manage playlists". The Stage 6 package and `YouTubeLegalDisclosures.test.tsx` pin that wording. Phases 2B (comment text sent to an AI provider), 3B (playlist insert), 4 (edit goes live), 6A (captions) and 6B (other channels' public data) each change disclosed behaviour. | Each of those phases updates the three legal pages, the legal test and `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` in the same PR. Waleed decides whether a change needs a fresh Google OAuth verification submission before rollout. |
| OD-4 | 6B | Compare public channels through `youtube-resources`-style reads. | `youtubeReadClient.getVideo` and the handler guarantee "this endpoint cannot look up videos outside the connected channel". `src/features/competitor-tracking/` already exists (no YouTube support). YouTube's API Services Developer Policies restrict how API data about other channels may be shown and combined; that page was not read in this session. | Build 6B as its own Edge Function and its own feature folder so the Stage 2 invariant stays literally true. Do the policy read first; Waleed decides go/no-go and whether it should live under competitor tracking instead. |
| OD-5 | 2A | AI "generates YouTube-valid timestamps". | Nothing in the upload flow knows what happens when in the video. `transcribe-media` returns plain text plus a duration, with no segment times. A model given only a title invents timestamps. | Ship 2A with a timed source required: the creator's outline with times, or pasted timed text. Offer an "estimated" mode only with a visible warning. Segment-timed transcription is a follow-up (2A.2). |
| OD-6 | 3B, 4, 6 | Per-user caps only. | `YOUTUBE_RESOURCE_QUOTA_POLICY.provider_quota` is `"not_tracked"`. The project default is 10,000 Data API units per Pacific day. At the brief's 50 edits per user per day and 53 units per save, one user can spend 2,650 units; four users exhaust the project. One caption upload is 4% of the daily quota. | Add one fail-closed project-wide write budget (§10) before any Phase 4 or 6 write goes live, and request a Google quota extension before Phase 6A is offered to all users. Numbers in §10 are proposals for Waleed. |
| OD-7 | 7.0 | Embed the YouTube IFrame player in the drawer with a custom toolbar that includes a **quality selector** (`setPlaybackQuality`) and `modestbranding=1`. | The production CSP (`nginx.conf`, `public/_headers`) is `default-src 'self'` with **no `frame-src`**, so cross-origin iframes are blocked while same-origin frames are allowed through `default-src 'self'`. Read on 27 November 2026: the IFrame API reference no longer documents `setPlaybackQuality` (only the `onPlaybackQualityChange` event); the player-parameters page says `modestbranding` "is deprecated and has no effect"; `rel=0` now limits related videos to the same channel; with `enablejsapi=1` the page says to always send `origin`. "Required Minimum Functionality" demands a viewport of at least 200 × 200 px, no element in front of any part of the player, and no automatic playback before the player is more than half visible. | **Approved (with `D-P7-1`):** Add `frame-src 'self' https://www.youtube-nocookie.com;` to both CSP files so existing same-origin frames stay permitted alongside the YouTube privacy-enhanced embed host. Ship **no quality selector** (quality stays in the player's own gear menu, with a hint + reported quality label in the toolbar), drop `modestbranding`, send `origin`. Toolbar sits below the player, never over it. No iframe and zero requests to `youtube-nocookie.com` occur before the creator clicks Play. §14.1.2. |
| OD-8 | 7.0 | Drive the player "using the YouTube IFrame Player `postMessage` API". | Google documents the JavaScript wrapper (`https://www.youtube.com/iframe_api`, `YT.Player`), not the raw message format. The wrapper is a third-party script running **inside Postora's origin**, next to the session token; the raw messages keep Google's code inside its own frame. | **Approved:** Use raw `postMessage` (`event: "listening"`, `event: "command"`) with strict origin (`https://www.youtube-nocookie.com`) and `event.source === iframe.contentWindow` checks, and keep the custom toolbar's playback controls resilient: when the player does not answer within 3 s of `load` the playback group hides and a one-line hint tells the creator to use the native player controls while Size (`Compact`, `Theater`, `Mini`), `Fullscreen`, and `Open on YouTube / Pop-out` stay active. No third-party script is loaded into Postora's origin. §14.1.2. |
| OD-9 | 7B | Add `youtube_caption: { language, name, format, content }` to `PlatformMetadata`. | §13 says "No storage of … caption files in Postora's database". The key puts up to 512 KiB of caption text into `posts.metadata`, which is read by the publisher, the history views and the n8n API. | **Approved (with `D-P7-4` & `D-P7-5`):** Accept the key as specified, with four guards (§14.3): the public n8n API neither accepts nor returns `youtube_caption.content`; no evidence, log line or list view carries `content`; `content` is scrubbed from the stored metadata across all terminal settlement paths (`completed`, `partial`, `failed`), leaving `{ language, name, format }`; §13 is amended. |
| OD-10 | 7C | Create playlists from Create Post; capability "`readonly` + `force-ssl` or `upload`". | §13 and the pinned legal sentence say Postora "does not create, rename, reorder, or delete playlists" (`YouTubeLegalDisclosures.test.tsx`). Read on 27 November 2026: `playlists.insert` is authorised by `youtube`, `youtube.force-ssl` and `youtubepartner` — **not** by `youtube.upload` — and costs 50 units. | **Approved (with `D-P7-6`):** Capability `manage_playlists` requires `youtube.readonly` **and** `youtube.force-ssl` (unknown/absent capability disables creation fail-closed). §13, the three legal pages, the legal test and the verification guide change in the same PR. §14.4. |
| OD-11 | 7E | Add privacy editing to `update_video` (`editLifecycle.ts`, `editComposition.ts`). | It is already there. `UpdateVideoRequest` accepts `privacy_status` with `privacy_confirmation`, `validateEditChanges` refuses a schedule-protected video and `update` checks the confirmation, all before `authorizeWrite`. Phase 4A left only the UI out ("Privacy changes stay out of the first activation", §8.1). | **Approved (with `D-P7-8`):** 7E adds tests that pin that order, maps `restrictions.scheduleProtected` from the `edit_snapshot` envelope onto the frontend port (`restrictions?.scheduleProtected !== false` disables the privacy select fail-closed), adds the drawer control with explicit confirmation checkbox, and updates the disclosure. §14.6. |
| OD-12 | 7A | `transcribe-media/handler.ts` returns `segments` beside `text` and `durationSeconds`. | There is no `handler.ts`; the function is one `index.ts`. Its response fields are `transcript`, `language` and `duration`. It already sends `response_format: "verbose_json"` to OpenAI. It has three provider tiers, and the Gemini tier returns plain text with no times. | **Approved (with `D-P7-3`):** Keep the existing field names. `segments` is additive and **optional**: present only when the provider returned usable times, never synthesised. Extracting `handler.ts` with sanitized error logging (no signed URLs or raw transcript/segment text in logs) is part of the PR (§12 adapter shape). §14.2. |

## 4. Shared building blocks

### 4.1 View controls (Phase 1, used by 1A and 1B)

`StudioVideoPicker.tsx` owns grid/table controls today, inside `youtube-comments`. The architecture tests forbid importing it. The controls are business-neutral and get two consumers in one phase, so they qualify as shared code (§40):

```text
src/components/data-view/
├── ViewModeToggle.tsx        # "grid" | "table", aria-pressed, Grid3X3 / LayoutList icons
├── GridColumnControls.tsx    # 4 | 5 | 6, aria-pressed, GRID_COLUMN_CLASSES
├── SortableColumnHeader.tsx  # <th aria-sort> + <button> with ▲ / ▼
├── sortRows.ts               # pure: stable sort, null/undefined last in both directions
├── useStoredChoice.ts        # localStorage read/write in try/catch, validated against allowed values
└── __tests__/
```

- `GRID_COLUMN_CLASSES` is copied verbatim from `StudioVideoPicker.tsx` (4: `lg:grid-cols-4`, 5: `xl:grid-cols-5`, 6: `xl:grid-cols-6`). Default 5.
- `sortRows(rows, accessor, direction, collator?)`: numbers compare numerically, strings through `Intl.Collator(locale, { numeric: true, sensitivity: "base" })`, `null`/`undefined`/`NaN` always sort after real values, ties keep input order.
- `SortableColumnHeader` sets `aria-sort="ascending" | "descending" | "none"` on the `<th>`. The button's accessible name is the column label. First click: descending for numbers and dates, ascending for text. Second click reverses.
- `StudioVideoPicker.tsx` is **not** refactored in this roadmap (§35, no cosmetic refactor). Adopting the shared controls there is an optional follow-up.
- Zero Dead Modules: call sites are `TopVideosTable.tsx` and `YouTubeVideoLibrary.tsx`.

### 4.2 Drawer rules (1A, 1B)

`src/components/ui/sheet.tsx` positions with physical classes and caps width at `sm:max-w-sm`. Both drawers therefore:

- pass `side={locale === "ar" ? "left" : "right"}`;
- pass `className="w-full sm:max-w-xl lg:max-w-2xl overflow-y-auto"`;
- set `dir={locale === "ar" ? "rtl" : "ltr"}` on `SheetContent`, because the portal renders outside the screen's `dir` wrapper;
- render a `SheetTitle` (the video title, or a translated fallback) and a visually hidden `SheetDescription`;
- close on Escape, overlay click and the close button, returning focus to the row or card that opened them.

### 4.3 Fail-closed counter (Phases 3B, 4, 6)

`_shared/rate-limiter.ts` (`checkUserRateLimit`) and `youtube-resources/rateLimit.ts` (`toRateLimitDecision`) both answer `allowed: true` when the RPC fails or returns an unexpected shape. That is acceptable for reads and wrong for writes. Writes use a new strict helper in `youtube-resources/writeLimits.ts` modelled on `youtube-analytics/limits.ts` `callCounter`: it calls the counter RPC, requires `allowed: boolean`, finite non-negative `count` and `retry_after`, and returns `null` on anything else. `null` refuses the write.

**Two different counters are needed.**

- **Per-user request counters** (10 edits per 10 minutes, 2 caption uploads per day, and so on) count one per attempt. They use the existing `check_rate_limit(p_endpoint, p_identifier, p_max_requests, p_window_seconds)` unchanged.
- **The unit budget** (§10) must add 50 or 400 in one step. `check_rate_limit` (`supabase/manual-sql/20260627213616_rate_limit_buckets.sql`) increments by exactly 1 and takes no cost parameter, and calling it 50 times is neither atomic nor affordable. Phase 3B-pre therefore adds, in a new migration, a dedicated function and leaves `check_rate_limit` untouched:

  ```sql
  check_weighted_rate_limit(p_key text, p_cost integer, p_max integer, p_window_seconds integer)
    RETURNS jsonb   -- { allowed: boolean, count: integer, retry_after: integer }
  ```

  Rules: reject `p_cost <= 0`, `p_max <= 0` or `p_window_seconds <= 0` by raising; insert the bucket row if absent, then `SELECT … FOR UPDATE` it, as `check_rate_limit` does; reset the window when it has expired; allow **only when `current_count + p_cost <= p_max`** and then add `p_cost` in the same statement; when refused, change nothing and return the seconds to the window's end. `count` is the value after the call. A refused call never partially debits. It uses the same `rate_limit_buckets` table with its own key prefix, the same privileges as `check_rate_limit` (service role only, no `SECURITY DEFINER`), and a controlled `search_path`. The migration is additive and reversible by dropping the function.

## 5. Phase 1 — UI/UX upgrade and lightweight enrichment

### 5.1 Phase 1A — `/analytics/youtube` most viewed videos

#### Backend contract (`supabase/functions/youtube-analytics/contracts.ts`)

```ts
export const YOUTUBE_ANALYTICS_TOP_VIDEOS_PAGE_SIZE = 10;
export const YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_RESULTS = 200;
export const YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_START_INDEX = 191;

export interface YouTubeAnalyticsTopVideoRow {
  video_id: string;
  title: string | null;
  published_at: string | null;        // new; RFC 3339 from snippet.publishedAt
  thumbnail_url?: string | null;      // new; https URL on a ytimg.com host
  link: string;
  metrics: YouTubeAnalyticsMetric[];
}

export interface YouTubeAnalyticsTopVideosData {
  rows: YouTubeAnalyticsTopVideoRow[];
  titles: "complete" | "partial" | "unavailable";   // semantics unchanged
  has_more: boolean;                  // new
  next_start_index: number | null;    // new
}

export interface YouTubeAnalyticsTopVideosRequest extends YouTubeAnalyticsDataRequestBase {
  operation: "top_videos";
  start_index?: number;               // new; integer 1..191, default 1
}
```

- `has_more = rows.length === 10 && startIndex + 10 <= 191` (`YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_START_INDEX`). `next_start_index = has_more ? Math.min(startIndex + 10, YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_START_INDEX) : null`.
- `start_index` is 1-based, matching Google's `startIndex`. The client only sends `1 + 10k`. The server accepts any integer in range; overlap is harmless because the client de-duplicates.
- A final page of exactly 10 rows reports `has_more: true`; the next request returns zero rows and `has_more: false`. The client must render that without an error.
- `schema_version` stays 1. All additions are optional or additive.

#### Handler (`handler.ts`)

- `TopVideosRequest` gains `start_index: z.number().int().min(1).max(191).optional()`. The schema stays `.strict()`.
- `startIndex` is passed to `ports.reader.readTopVideos`. The response rows gain `published_at` and `thumbnail_url` from the enrichment lookup, `null` when the lookup failed or did not return the video.
- The admission, decision, window, data-limit, credential, debit and final-decision sequence is unchanged. The enrichment keeps using `runAttempt("data", …)` (no forced refresh), exactly like today's title lookup.

#### Read client (`analyticsReadClient.ts`)

- `YouTubeAnalyticsReportInput` gains `startIndex?: number`. `readTopVideos` calls `url.searchParams.set("startIndex", String(input.startIndex ?? 1))` next to `maxResults=10`.
- `lookupVideoTitles` keeps its name and its `titles` map and adds a second map:

  ```ts
  Promise<YouTubeAnalyticsReadResult<{
    titles: Record<string, string>;
    details: Record<string, { published_at: string | null; thumbnail_url: string | null }>;
  }>>
  ```

  An entry is written only for an item whose `id` was requested **and** whose `snippet.channelId === input.channelId`, the same test that guards `titles` today. `published_at` is kept only if it parses as a date. `thumbnail_url` takes the first of `medium`, `high`, `default` and is kept only if it is an `https:` URL whose host is `ytimg.com` or a subdomain of it; anything else is `null`.
- The call stays `videos.list?part=snippet&id=…` — one unit, no new part, no new request.

#### Quota

| Action | Analytics API | Data API | Per-user data limiter |
| --- | --- | --- | --- |
| Enrichment fields | 0 extra | 0 extra | 0 extra |
| Each **Load more** click | 1 `reports.query` | 1 `videos.list` | 1 request |

Twenty pages (200 videos) cost 20 + 20 units and 20 of the user's 60 requests per 10 minutes. Budgets and limiter keys are unchanged.

#### Frontend

Files (all under `src/features/youtube-analytics/`):

| File | Change |
| --- | --- |
| `application/ports.ts` | `topVideos(params: YouTubeAnalyticsDataParams & { startIndex?: number })` |
| `infrastructure/supabaseYouTubeAnalyticsGateway.ts` | Send `start_index` only when `startIndex > 1`, so page 1 is byte-identical to today's request |
| `application/useYouTubeTopVideos.ts` | Becomes a `useInfiniteQuery` (below) |
| `domain/topVideosView.ts` (new, pure) | `mergeTopVideoPages`, `sortTopVideoRows`, column definitions |
| `ui/TopVideosTable.tsx` | Container: toolbar, table view, Load more |
| `ui/TopVideosGrid.tsx` (new) | Grid cards |
| `ui/VideoAnalyticsSheet.tsx` (new) | `Sheet` around `VideoAnalyticsPanel` |
| `ui/VideoAnalyticsPanel.tsx` | Accepts `title?: string \| null`; its own Close button is dropped when rendered in the sheet |
| `ui/YouTubeAnalyticsScreen.tsx` | Wires pages, reset, sheet |

**Paging design.** `useYouTubeTopVideos` uses the existing key from `youtubeAnalyticsQueryKey(userId, accountId, connectionRevision, "top_videos", windowEnd, periodDays, null)` with `initialPageParam: 1` and `getNextPageParam: (last) => last.data.next_start_index ?? undefined`. Consequences that must hold:

- The key shape is unchanged, so `isAccountAnalyticsQueryKey` still purges it on consent withdrawal and connection change.
- **Every page** runs the same validation `reportQuery.ts` applies today: `connection_revision`, `requested_window.end_date` and `requested_window.days` must equal the request's, otherwise `YouTubeAnalyticsClientError("internal_error")`.
- `staleTime: Infinity`, `gcTime: Infinity`, `retry: false`, no refetch on mount/focus/reconnect, the cached-error latch and `onError` forwarding are all preserved.
- **Next-page errors follow the existing access rules** (`useAccessLease.ts` `reportDataError`, `domain/errors.ts`). The error is still forwarded through `onError`:
  - An **account-scoped** code (`not_enabled`, `consent_required`, `missing_scope`, `not_found`, `provider_unsupported`, `reconnect_required`, `connection_changed`) means access itself is gone. Today's behaviour applies unchanged: every report for the account is purged and the report area is replaced by the denial, or by the latched notice for `missing_scope` and `reconnect_required`. Loaded rows are not kept.
  - Any **other** code (`rate_limited`, `capacity_reached`, `quota_exceeded`, `upstream_unavailable`, `internal_error`, `invalid_request`, `settings_unavailable`) keeps the pages already shown and renders an `AnalyticsNotice` beside the Load more button; Retry repeats only the failed page.
  - `window_stale` also keeps the rows, but its Retry runs the screen's Refresh (advance the window, trim to page 1), because the pinned window can no longer be paged.
- **Trimming.** `trimTopVideosToFirstPage(queryClient, key)` is the one function that drops extra pages. When the key has data it sets the cache to exactly `{ pages: [old.pages[0]], pageParams: [1] }`; when the key has no data it leaves it absent (it never creates an empty entry). **`pageParams` must be reset together with `pages`**: an infinite query refetches one request per entry in `pageParams`, so trimming only `pages` would still refetch every page and would leave the two arrays out of step.
- **When it runs.** Four places, and no others: (1) whenever `(accountId, periodDays, windowEnd)` changes, on the newly active key — account, period and window are part of the key, and because cached data never expires, returning to an earlier key would otherwise show its old extra pages; (2) before `Refresh`; (3) before the latched-error retry; (4) on `window_stale` recovery. No network call is made by trimming itself.
- **Cost of Refresh.** After trimming, `refetch()` sends one request, so Refresh costs exactly one Analytics unit and one Data unit for this block however many pages had been loaded.

**Merging and numbering.** `mergeTopVideoPages` flattens pages in order and keeps the first occurrence of each `video_id`. Default order is the server's (views, descending). The `#` column shows the row's position in the **current** sort order, 1-based, so with the default order it equals the views rank.

**Table view.** Columns, in order: `#` · Video (thumbnail 16:9, 96 px wide, plus title; `Video unavailable` when `title` is null) · Date published · Views · Watch time · Likes · Subscribers gained · Actions (`Inspect`, `Open`). Every header except `#` and Actions is a `SortableColumnHeader`. Sorting is client-side over all loaded rows; nulls last. Numbers stay inside `LtrValue` with `formatMetric`. The date is formatted with `Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" })`; null renders `—`. Thumbnails use `loading="lazy"`, empty `alt`, and a neutral placeholder when the URL is null. The table keeps `overflow-x-auto` and its `min-w`.

**Grid view.** Cards in `GRID_COLUMN_CLASSES[columns]`: `#` badge, 16:9 thumbnail, two-line title, date, then views, watch time, likes and subscribers gained with their labels. The whole card opens the drawer; `Open` is a separate link. A compact "Sort by" select plus direction button stands in for the headers.

**Toolbar.** `ViewModeToggle`, `GridColumnControls` (grid only), loaded count. Choices persist under `ytAnalyticsTopVideosView` and `ytAnalyticsTopVideosGridColumns`.

**Load more.** Rendered under the table or grid only when `hasNextPage`. Disabled while fetching. Appends 10.

**Drawer.** Clicking a row title, a card or `Inspect` sets `pickedVideo`; `VideoAnalyticsSheet` is open while `selectedVideoId !== null` and follows §4.2. Its title is the row's title when the video is among the loaded rows, otherwise the translated "Video analytics" plus the id. The `?video=` deep link (`initialVideoId`) therefore opens the drawer even for a video that is not in the loaded pages; ownership is still decided by the server (`video_not_found` renders inside the drawer). Closing clears `pickedVideo`. Changing the channel closes it (already the case).

**i18n** (namespace `analytics`): `youtube.rank`, `youtube.datePublished`, `youtube.viewTable`, `youtube.viewGrid`, `youtube.viewMode`, `youtube.perRow`, `youtube.loadedCount`, `youtube.loadMore`, `youtube.loadingMore`, `youtube.sortBy`, `youtube.sortAscending`, `youtube.sortDescending`, `youtube.videoDrawerDescription`.

#### Tests

| Suite | Cases |
| --- | --- |
| `analyticsReadClient.test.ts` | `startIndex` on the URL; default 1; enrichment maps owned items only; foreign `channelId` yields no `details` entry; non-https and non-ytimg thumbnails become null; unparseable date becomes null; still exactly one `videos.list` call with `part=snippet` |
| `handler.test.ts` | `start_index` 0, 192, 1.5 and `"1"` are `invalid_request`; 191 accepted; `has_more`/`next_start_index` for 10 rows at 1, 10 rows at 191, 9 rows, 0 rows; rows carry the new fields; failed enrichment gives nulls with `titles: "unavailable"`; `Cache-Control: no-store` on success and refusal; unknown extra key still rejected |
| `tests/domain.test.ts` | merge de-duplicates; sort per column both directions with nulls last; negative net likes sort numerically; stable ties |
| `tests/gateway_and_keys.test.ts` | `start_index` omitted for page 1, sent for 11; key unchanged and purgeable |
| `tests/access_lease_and_screen.test.tsx` | toggle and persistence; `#` renumbers after sort; `aria-sort` values; Load more appends without duplicates and hides at the end; empty last page; the four-step trim test — (1) load 3 pages, (2) switch period and return, (3) assert only page 1 remains and the cached `pageParams` is `[1]`, (4) press Refresh and assert exactly one `topVideos` gateway call (one Analytics and one Data unit); trimming a key with no data leaves it absent; drawer side `right` in English and `left` in Arabic; deep link opens the drawer; next page failing with `rate_limited` keeps rows and retries one page; with `reconnect_required` replaces the report area; with `window_stale` retries through Refresh |
| `src/components/data-view/__tests__` | `sortRows`, header a11y, stored choice validation |

Existing fixtures in `supabase/functions/youtube-analytics/fixtures.ts` and `src/features/youtube-analytics/tests/fixtures.ts` gain the new fields.

### 5.2 Phase 1B — `/youtube` channel and uploaded videos

#### Backend contract (`supabase/functions/youtube-resources/contracts.ts`)

```ts
export const YOUTUBE_VIDEO_LIST_DESCRIPTION_MAX = 500;

export interface YouTubeVideoListItem {
  id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  privacy_status: string | null;
  url: string;
  description?: string | null;          // new; first 500 characters only
  duration_iso8601?: string | null;     // new
  statistics?: {                        // new
    view_count: number | null;
    like_count: number | null;
    comment_count: number | null;
  };
}
```

`YOUTUBE_RESOURCE_QUOTA_POLICY.unit_costs.videos_page` changes from `1` to `2`.

The list description is truncated because a page of 50 full descriptions can reach 250 KB and the list needs it only for search and the Shorts heuristic. The drawer reads the full text through the existing `video` operation.

#### Read client (`youtubeReadClient.ts`, `listUploads`)

After the `playlistItems.list` page is parsed into `items`:

1. If `items.length === 0`, return as today. No second call.
2. Otherwise send **one** `videos.list?part=snippet,contentDetails,statistics,status&id=<ids joined by ",">` with the same token, timeout and `send` helper. A page holds at most 50 ids, which is the `videos.list` limit.
3. Parse with `VideoListSchema`. Use an entry only when its `id` is one of the requested ids **and** `snippet.channelId === input.channelId`.
4. Merge per item: `description` (truncated), `duration_iso8601`, `statistics` via the existing `count()` helper. Base fields from `playlistItems` win; `privacy_status` is filled from the enrichment only when the base value is null.
5. **Degradation.** If the enrichment call returns non-2xx (including 401, 403 and quota), throws, times out, or fails schema validation, every item gets `description: null`, `duration_iso8601: null` and `statistics` with three nulls. An item missing from an otherwise good enrichment gets the same nulls. The page is still `ok: true` with its `next_page_token`.
6. An enrichment 401 does **not** set `unauthorized: true`. Only a 401 from `playlistItems.list` reaches `providerRead`'s single forced refresh, as today.
7. A degraded enrichment logs one structured line, `{ event: "youtube_resources_enrichment_degraded", class }`, where `class` is the `classifyGoogleError` class or `"network"`. No body text.

The handler does not change. The per-user limiter still counts one request per page, so the daily ceiling of 300 requests can now mean up to 600 units for a user who only pages videos; the capabilities response reports the new unit cost.

#### Frontend

Files (all under `src/features/youtube-management/`):

| File | Change |
| --- | --- |
| `domain/videoLibraryView.ts` (new, pure) | `filterLibraryVideos`, `sortLibraryVideos`, `isLikelyShort`, column definitions |
| `domain/formatIsoDuration.ts` | Add `isoDurationSeconds(value): number \| null` for sorting |
| `ui/YouTubeVideoLibrary.tsx` | Container; **props unchanged** |
| `ui/YouTubeVideoLibraryTable.tsx`, `ui/YouTubeVideoLibraryGrid.tsx`, `ui/YouTubeVideoLibraryToolbar.tsx` (new) | Views and controls |
| `ui/YouTubeVideoDrawer.tsx` (new) | `Sheet` shell with loading, error and content states |
| `ui/YouTubeVideoDetail.tsx` | Rebuilt as the drawer's detail sections |
| `ui/YouTubeVideoEditCard.tsx` | Passes the category label down; otherwise unchanged in Phase 1 |
| `ui/YouTubeManagementScreen.tsx` | Removes the inline card under the list; renders the drawer |

**Toolbar.** `ViewModeToggle`; `GridColumnControls` (grid only); type filter All / Videos / Shorts; search box over title, description and id; loaded count. Persistence keys `ytManagementLibraryView` and `ytManagementLibraryGridColumns`.

**Shorts filter.** `YouTubeVideoListItem` has no `is_short`. `isLikelyShort` is true when title or description matches `/#shorts?\b/i`, the same rule Stage 4 falls back to (`comment-manager/stage4/handler.ts`). It is a best-effort label, stated as such in a tooltip. When enrichment degraded, description is null and only the title is tested.

**Table view.** Columns: `#` · Video (16:9 thumbnail with a duration badge, plus title) · Visibility (icon and label: Public, Unlisted, Private, `—`) · Date published · Duration · Views · Likes · Comments. All but `#` are sortable; duration sorts by seconds, visibility by label, nulls last. Counts use `Intl.NumberFormat(i18n.language)`; null renders `—`. `#` is the position in the current filtered and sorted order.

**Grid view.** Cards: `#` badge, 16:9 thumbnail with duration overlay, two-line title, date with privacy icon, then views, likes and comments.

**Selection.** The title cell and each card are buttons with `aria-pressed={video.id === selectedVideoId}`; activating one calls `onSelect`.

**Pagination.** `Load more` renders if and only if `hasMore`. Three empty states stay distinct:

- no items and `hasMore` → "More results are available, load the next page" plus the button (unchanged);
- no items and no `hasMore` → "This channel has no uploaded videos yet." (unchanged);
- items exist but the filter hides them all → "No uploads match these filters" plus Reset, and the button still shows when `hasMore`.

**Refresh.** `videos` is an infinite query, and `refetch()` on it re-requests every loaded page (two units each after this phase). Before `videos.refetch()`, the `refresh` handler in `YouTubeManagementScreen.tsx` trims the cached data to `{ pages: [firstPage], pageParams: [null] }` (`null` is this query's `initialPageParam`); absent data stays absent. Refresh therefore makes exactly one `listVideos` call however many pages were loaded. The same trim runs before the retry that follows an `invalid_cursor` error, which already restarts from the first page.

**Drawer.** `YouTubeVideoDrawer` is open while `selectedVideoId !== null`, follows §4.2, and closes by clearing `pickedVideo`. It shows the loading line while `video.isPending`, `YouTubeResourceNotice` on error, and otherwise these sections in one scroll container:

1. 16:9 thumbnail preview (placeholder when null).
2. Title, with "Open on YouTube" and, when `flags.analyticsYoutube`, "View analytics" (existing link and query string).
3. Metadata grid of nine cells: Views, Likes, Comments, Duration, Privacy, Published date, Category, Default language, Made for Kids. Category shows the catalog label from `useYouTubeCategories` when available and the id otherwise. Made for Kids shows Yes, No or Not available.
4. Description in a bordered box, `max-h-64 overflow-y-auto whitespace-pre-wrap`. Plain text only; never rendered as HTML.
5. Tags as `Badge` chips; the section is omitted when there are none.
6. "Edit video details": `YouTubeVideoEditCard`'s edit controls, with the existing capability-driven disabled state and reason.
7. "Updated {{time}}" footer.

All nine metadata fields already exist on `YouTubeVideoDetails`; the `video` operation is unchanged.

**i18n** (namespace `accounts`): `youtubeManagement.library.{viewTable,viewGrid,viewMode,perRow,loadedCount,filterAll,filterVideos,filterShorts,shortsHint,searchPlaceholder,searchLabel,noMatch,resetFilters,colRank,colVideo,colVisibility,colPublished,colDuration,colViews,colLikes,colComments,visibilityPublic,visibilityUnlisted,visibilityPrivate,sortBy}` and `youtubeManagement.drawer.{title,description,publishedDate,category,defaultLanguage,madeForKids,yes,no,descriptionHeading,noDescription}`.

#### Tests

| Suite | Cases |
| --- | --- |
| `youtubeReadClient.test.ts` | Exactly two provider calls for a non-empty page and one for an empty one; ids joined; merge by id; foreign-channel enrichment item ignored; description truncated at 500; enrichment 401/403/500/timeout/bad schema each degrade to nulls with the page still ok and `unauthorized` false; `playlistItems` 401 still `unauthorized: true`; 404 empty page unchanged; `invalid_cursor` unchanged |
| `contracts.test.ts`, `capabilities.test.ts` | `videos_page: 2` |
| `handler.test.ts` | Envelope carries the new fields; a `playlistItems` 401 still triggers one forced refresh |
| `ui/__tests__/YouTubeVideoLibrary.test.tsx` | Both views; `#` renumbers; each sort with nulls last; `aria-sort`; search and Shorts filter; three empty states; Load more visible with zero items when `hasMore`; hidden otherwise |
| `ui/__tests__/YouTubeManagementScreen.test.tsx`, `tests/wiring.test.tsx`, `src/pages/youtube/YouTubeManagementPage.test.tsx` | After loading three pages, Refresh makes exactly one `listVideos` call and the cached `pageParams` is `[null]`; no inline card under the list; drawer opens on select, side by locale, closes and restores focus; account change closes it |
| `ui/__tests__/YouTubeVideoDetail.test.tsx` | Nine metadata cells, description box, tag chips, both links |
| `e2e/youtube-stage3.spec.ts` | Update selectors that assumed the inline card |

## 6. Phase 2 — AI assistance

No Google API call is made in this phase. Both features use `generate-caption`, which already authenticates the user, applies the plan's hourly and daily AI limits, routes to the user's or the platform's model and logs through `logAiCall`.

**Logging rule for both new branches.** New branches log only stable error codes, sanitized error classes, request IDs, model/tier identifiers, and suggestion counts. They must not reuse the existing raw `response.text()`, `errMsg`, or `error_stack` logging pattern.

The existing YouTube branch in `generate-caption/handler.ts` reads the provider's failure body with `response.text()` and logs `error_message` and `error_stack`. For these two request types that would put a creator's outline, a viewer's comment or a provider's echo of them into `system_logs`. The new branches therefore have their own failure path: a failed provider response is classified by HTTP status into a fixed class (`auth`, `rate_limit`, `provider_error`, `timeout`, `invalid_output`), the body is discarded unread, and a caught exception is logged by `error.name` only. Neither the prompt, the context, the model output nor any provider text is passed to `logAiCall`, the logger or `console`.

### 6.1 Phase 2A — chapters generator (`YouTubeSettings.tsx`)

**Pure rules** — `supabase/functions/_shared/youtubeChapters.ts`, imported by the Edge Function and by the frontend the same way `youtubeVideoTitle.ts` already is:

```ts
export interface YouTubeChapter { startSeconds: number; title: string }
export function parseChapterLines(text: string): YouTubeChapter[] | null;
export function validateChapters(chapters: YouTubeChapter[], durationSeconds: number | null):
  { ok: true } | { ok: false; reason: "too_few" | "first_not_zero" | "not_ascending" | "too_short" | "beyond_duration" | "bad_title" };
export function formatChapters(chapters: YouTubeChapter[]): string;   // "00:00 Title\n…"
export function upsertChaptersBlock(description: string, block: string, maxLength: number): { ok: true; value: string } | { ok: false; reason: "too_long" };
```

Validation is YouTube's published rule set: at least 3 chapters, the first at exactly `00:00`, strictly ascending, each at least 10 seconds long (including the last, when the duration is known), every start below the duration, titles 1–100 characters with no line breaks and no `<` or `>`. Format is `MM:SS`, or `H:MM:SS` once any start reaches one hour.

**Request** — `generate-caption` gains `requestType: "youtube_chapters"`:

```ts
{ requestType: "youtube_chapters", platform: "youtube", language: "english" | "arabic",
  context: string,                 // outline or timed text, ≤ 8000 chars
  durationSeconds?: number,        // integer 30..43200
  timing: "provided" | "estimated" }
```

**Response** — `{ suggestions: string[] }` with zero or one formatted block, plus `timing`. The server parses the model output with `parseChapterLines` and runs `validateChapters`; an invalid result is discarded and answered as `422 { error: "chapters_invalid" }`. The model is never trusted to have followed the rules, and its raw text is never returned on failure.

**Prompt safety.** The outline is user text placed inside a delimited block and described to the model as data. In `"provided"` mode the prompt instructs the model to keep the creator's times and only clean the titles; the server additionally rejects any output whose start times are not a subset of the times parsed from the input.

**UI.** `YouTubeAISuggestions` gains `type: "chapters"`, rendered under the description field: an outline textarea, the detected video duration (read from the selected video's metadata in the browser; "unknown" when unavailable), a timing switch, Generate, and a preview. In `"estimated"` mode a warning stays visible on the preview: "These times are estimates. Check them against your video before publishing." **Insert** calls `upsertChaptersBlock` on `settings.description`: it replaces a previously inserted block (recognised as a run of three or more consecutive timestamp lines starting at `00:00`) or appends after a blank line, and refuses with a message if the result would exceed 5,000 characters. Nothing is written until the creator clicks Insert.

**i18n** (namespace `postsettings`): `youtubeAI.chapters.*`.

**Tests.** Deno unit tests for every validator branch and for `upsertChaptersBlock` (append, replace, too long, Arabic titles); `generate-caption/handler.test.ts` for the new branch (valid, invalid output discarded, time-subset rule, oversize context, missing auth); a **log-capture test**: the outline carries a unique marker string and the stubbed provider fails with a body containing a second marker; with `console` and the logger captured, neither marker appears in any log call on the success, invalid-output, provider-failure and thrown-exception paths; a Vitest component test for generate → preview → insert and the estimate warning.

### 6.2 Phase 2B — AI reply suggestion (`YouTubeCommentsScreen.tsx`)

**Request** — `generate-caption` gains `requestType: "youtube_comment_reply"`:

```ts
{ requestType: "youtube_comment_reply", platform: "youtube", language: "english" | "arabic" | "auto",
  context: JSON.stringify({ video_title: string /* ≤ 100 */, comment_text: string /* ≤ 2000 */ }) }
```

**Response** — `{ suggestions: [string] }`: one plain-text reply, trimmed, at most 500 characters, with control characters and markup stripped server-side. `"auto"` asks for the language of the comment.

**Rules.**

- The function receives text only. It makes no YouTube call and resolves no account, video or comment id, so there is no tenancy surface: the creator sends text already on their screen.
- The comment is hostile input. It goes inside a delimited data block; the system prompt says to ignore instructions inside it, never to include links, contact details or promises, and to produce nothing but the reply.
- **Never auto-send.** The suggestion only fills the reply composer's draft. Sending stays the existing fenced `stage4.reply` path with its operation id, receipt and recovery behaviour, triggered by the existing Reply button.
- If the draft is not empty, the button asks before replacing it. Stage 4's draft persistence (`stage4Drafts.ts`) treats the suggestion as ordinary typed text.

**Frontend.** The comments feature keeps its layering: `application/ports.ts` adds `YouTubeReplySuggestionGateway { suggestReply(input: YouTubeReplySuggestionInput): Promise<string> }` (where `YouTubeReplySuggestionInput` carries `videoTitle`, `commentText`, optional `language`, and optional `signal`); `infrastructure/supabaseReplySuggestionGateway.ts` implements it; `application/useReplySuggestion.ts` holds loading state, manages an unmount `AbortController`, and returns `{ suggestReply, isSuggesting }` with `{ suggestion, error }` results; `Composer` (reply mode only) renders "Suggest AI reply". The existing composition root wires the default. AI errors go through `handleAIError` (401, 402, 429).

**Disclosure (OD-3).** A viewer's comment text and the video title are sent to the configured AI provider when the creator clicks the button. `Privacy.tsx`, `GoogleApiDisclosure.tsx` and the legal test gain that sentence in the same PR.

**i18n** (namespace `automation`): `youtubeStage4.ai.{suggest,suggesting,replaceDraftTitle,replaceDraftBody,replace,keep,failed}`.

**Tests.** Handler branch (length cap, stripping, hostile comment fixture cannot change the output contract, auth, rate limit); a **log-capture test with a hostile comment marker**: the comment text contains a unique marker and the stubbed provider's failure body contains another; across success, provider failure and thrown exception, neither the marker nor the raw provider body appears in any captured `console`, logger or `logAiCall` argument, while the stable error class and request id do; component tests proving the draft is filled, nothing is sent, the replace prompt appears, and an AI failure leaves the draft untouched; the comments `architecture.test.ts` stays green.

## 7. Phase 3 — native scheduling and playlists

Both features change the publish path. `supabase/functions/process-post/index.ts` is legacy-critical (§41): new logic goes into the existing extracted modules, never into the entrypoint.

### 7.1 Metadata keys (Phase 3, both parts)

| Key | Type | Meaning |
| --- | --- | --- |
| `youtube_publish_at` | RFC 3339 UTC string or null | Native scheduled publish time |
| `youtube_playlist_id` | string or null | Playlist to add the new video to |

**Presence semantics of `youtube_publish_at`.** `undefined`, `null`, and an empty string mean no native schedule and preserve existing behavior byte-for-byte. Any non-empty malformed, too-soon, or expired value forces `private` without `publishAt`.

"Non-empty" includes a value of the wrong type (a number, an object): anything other than `undefined`, `null` or `""` is treated as an attempt to schedule, and an attempt that cannot be honoured always ends private. Presence is decided by one pure function, `hasYoutubeScheduleRequest(metadata)`, so the publisher, the privacy helper and the evidence cannot disagree about it.

Per §§22 and 42 the keys are added to all three `interface PlatformMetadata` copies (`process-post/index.ts`, `n8n-api/index.ts`, `_shared/platforms/types.ts`), to `usePlatformSettings.tsx` serialisation and to `CreatePost.tsx` rehydration. Older stored posts that omit them behave exactly as today. The public n8n API does not accept the new options in this phase.

### 7.2 Phase 3A — `status.publishAt`

Google accepts `status.publishAt` only when `status.privacyStatus` is `private` and the video has never been published; at that time YouTube makes the video **public**. A time in the past publishes at once.

**Rollout rule (P0).** Until PR-7A is deployed, the UI must neither expose native scheduling nor emit `youtube_publish_at`.

The reason is concrete. The deployed `process-post` ignores keys it does not know and reads `youtube_visibility` directly. If a frontend that emits `youtube_publish_at` reached production first, a creator who chose "Public" and a schedule time next week would get a video uploaded **public immediately**. The work is therefore split: **PR-7A** is the whole backend (metadata keys, publisher, privacy helper, both `index.ts` reads, resumable-upload recheck, evidence), deployed and smoke-tested alone; **PR-7B** is the Create Post UI and the serialisation of the key, and it does not start until PR-7A's deployment is verified. PR-7B also keeps the control behind the server's answer: the UI must not show the schedule option when the publish path cannot honour it (Composio accounts).

**Publisher (`process-post/youtubePublisher.ts`).** `buildStatus(metadata, now)`:

1. `hasYoutubeScheduleRequest(metadata)` false (`undefined`, `null`, `""`) → today's behaviour, byte for byte. The request body, the `part` list and the upload URL are identical to the current output; a test compares them to a recorded fixture.
2. Otherwise read the value through a new pure `resolveYoutubePublishAt(value, now)` in `_shared/youtubePublishOptions.ts`. Valid means: a string that parses as RFC 3339, at least 15 minutes after `now`, and at most 2 years ahead.
3. Valid → `privacyStatus: "private"` regardless of `youtube_visibility`, and `publishAt: <normalised UTC ISO string>`.
4. Non-empty but malformed, too soon, expired, too far ahead or of the wrong type → no `publishAt`, `privacyStatus: "private"`, and the stale-schedule warning: "The YouTube schedule time could not be used, so the video was uploaded as private and not scheduled." The video is never published earlier or wider than asked.

**Recheck seam (`process-post/youtubeResumableUpload.ts`).** Time passes between building the request and opening the provider session: a stored upload session can be picked up by a later worker, after its `publishAt` has gone by. Both the first attempt and every continuation reach Google through the same call, `createYoutubeResumableSession`, in `youtubeResumableUpload.ts`. The recheck lives **immediately before that call, in that common path**, and nowhere else:

- If the body about to be sent carries `status.publishAt`, run `resolveYoutubePublishAt` against the current time. If it no longer qualifies, remove `publishAt` from the body (privacy is already `private`) and record the stale-schedule warning.
- **A session whose provider session URI already exists is never rewritten.** Google fixed that session's metadata when it was opened; the recheck only applies when a new provider session is about to be created. A resumed byte upload to an existing URI sends no metadata and is left alone.
- The warning travels with the upload outcome, so it reaches the settlement evidence on **both** paths: the run that uploads in one go and the continuation that finishes an interrupted upload (`youtubeUploadContinuation.ts`). A test covers each.

**One privacy answer.** `process-post/index.ts` reads `youtube_visibility` directly in two more places, outside the publisher: the settlement evidence (`requestedPrivacy: post.metadata?.youtube_visibility ?? "private"`) and the native upload function (`const privacyStatus = metadata?.youtube_visibility || "private"`, used at least in its log line). Left alone, a scheduled upload sent as private would be recorded and logged as public. A new pure `effectiveYoutubePrivacy(metadata)` in `_shared/youtubePublishOptions.ts` returns `"private"` whenever `hasYoutubeScheduleRequest(metadata)` is true (valid or not) and the normalised `youtube_visibility` otherwise. `buildStatus`, both `index.ts` reads and `youtubePublishSafety.ts` `youtubeUploadPrivacy` all call it. The implementer traces every use of the local `privacyStatus` variable in the upload function before changing it.

**Evidence.** `youtubePublishEvidence.ts` adds `requested_publish_at: string | null`, `scheduled: boolean` and `schedule_warning: "stale_schedule" | null`, so the settled row says whether the video was scheduled or left private and why. The pre-send preview treats a scheduled upload as private.

**Composio.** The Composio path cannot express `publishAt`. For a Composio-managed account the control is disabled with the existing mismatch pattern and the key is not sent.

**UI (`YouTubeSettings.tsx`, state in `YouTubeSettingsState`).** A "Publish" choice with two options: "Use the privacy above" and "Schedule on YouTube". The second shows a date-time picker (local time, converted to UTC) and replaces the privacy control with a fixed line: "Private until then. YouTube makes it public at the scheduled time." Validation mirrors the server's 15-minute and 2-year bounds. The pre-send preview states the scheduled time. Help text explains the difference from Postora's own schedule: Postora's schedule decides when the upload starts; YouTube's decides when the uploaded video becomes public.

**Tests.** `youtubePublishOptions.test.ts` for `hasYoutubeScheduleRequest`, `resolveYoutubePublishAt` and `effectiveYoutubePrivacy`; an `index.test.ts` case that a scheduled post with `youtube_visibility: "public"` settles with `requestedPrivacy: "private"`; `youtubePublisher.test.ts` — `undefined`, `null` and `""` each byte-identical to the recorded current request; valid; and each of malformed, too soon, expired, too far and wrong type forcing `private` without `publishAt` even when `youtube_visibility` is `"public"`; `youtubeResumableUpload.test.ts` — stale `publishAt` removed immediately before `createYoutubeResumableSession`, a still-valid one kept, and a session with an existing provider URI not rewritten; `youtubeUploadContinuation.test.ts` — the stale-schedule warning present in the settlement evidence on the continuation path as well as the initial one; `youtubePublishEvidence.test.ts`; `youtubeDispatchMode.test.ts` (Composio); a `YouTubeSettings` component test; `CreatePost` rehydration test.

### 7.3 Phase 3B — playlist selector and insert

#### Read operation (`youtube-resources`)

```ts
// request
{ operation: "playlists", account_id: string, page_token?: string }

// contracts.ts
export interface YouTubePlaylistListItem {
  id: string;
  title: string;
  privacy_status: string | null;
  thumbnail_url: string | null;
}
export interface YouTubePlaylistsPage {
  items: YouTubePlaylistListItem[];
  next_page_token: string | null;
}
```

- Provider call: `playlists.list?part=snippet,status&mine=true&maxResults=50` (+ `pageToken`). One unit. `unit_costs.playlists_page: 1`.
- It runs through the same `admit()` and `providerRead()` path as `channel`, `videos` and `video`. `requestedOperationOf` learns the literal.
- Only items with `snippet.channelId === account.channelId` are returned; a Google account that manages several channels must not leak another channel's playlists into this account's selector.
- Paging beyond 50 uses `next_page_token`, the same cursor rules as `videos` (a 400 with a cursor is `invalid_cursor`).
- Scope: readable under `youtube.readonly`, already granted.

#### Follow-up (`process-post/youtubeUploadFollowUps.ts`)

`YoutubeFollowUpRequest` gains `playlistId: string | null`. `YoutubeFollowUpResults` gains `playlist: YoutubeFollowUpOutcome`. Order becomes thumbnail, first comment, **playlist**, so existing follow-ups keep their place and their share of the worker's time.

`addToYoutubePlaylist`:

1. `budgetMs() <= 0` → `skipped / no_time`.
2. `canWrite()` false → `skipped / authority_lost`.
3. Pre-check: `playlists.list?part=snippet&id=<playlistId>` (1 unit); the playlist must exist and belong to `request.channelId`, else `failed / not_owned`. This also covers a second channel of the same Google account.
4. Project write budget refused (§10) → `skipped / quota_budget`. The debit comes after the ownership check so a bad playlist id never spends shared budget.
5. `POST playlistItems?part=snippet` with `{ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }` and `AbortSignal.timeout(budgetMs)`. 50 units. `youtube.force-ssl` covers it.
6. 2xx → `applied`. Non-2xx → `failed / refused`, with the body logged only through `redactProviderText`. Thrown or timed out → `unknown / answer_lost`.

The insert is **sent once and never retried**: a second insert adds the video to the playlist twice, and a timeout says nothing about whether the first arrived. Like the other follow-ups, it only runs in the run that created the video and can never fail the publish or erase the upload receipt.

`playlistId` is validated as `^[A-Za-z0-9_-]{10,64}$` before use.

**Consumers of the new `playlist` key** that must tolerate its absence on older rows: both `runYoutubeFollowUps` call sites in `process-post/index.ts`, `youtubeUploadContinuation.ts`, `youtubePublishEvidence.ts` (adds `playlist: YoutubeFollowUpEvidence`, `not_requested` when the metadata key is absent), `n8n-api/youtubeEvidenceView.ts`, and any `src/` renderer of publish evidence.

#### UI

`YouTubeSettings.tsx` replaces the unused `playlist` string with a selector fed by a new `useYouTubePlaylists(accountId)` hook, built like `useYouTubeCategories`: options "No playlist" plus the channel's playlists with a privacy icon, "Load more" while a cursor exists, a retry state when the list cannot be read, and disabled for Composio accounts. `YouTubeSettingsState.playlist` holds the playlist id. The post result view shows the playlist outcome next to thumbnail and first comment.

**More than one channel.** A playlist belongs to exactly one channel, and one post has one `youtube_playlist_id`. When more than one **distinct native YouTube channel** is selected, the selector is disabled, any chosen playlist is cleared, `youtube_playlist_id` is not sent, and a helper note explains: "Playlists belong to a single channel. Select one YouTube channel to add this video to a playlist." Two selected accounts that are the same channel count as one. With exactly one native channel (alongside any number of Composio accounts or other platforms) the selector lists that channel's playlists.

**Deploy order.** The `playlists` operation and the follow-up must be deployed before, or together with, the frontend that calls and emits them. An undeployed `youtube-resources` answers `invalid_request` to the new operation, and an undeployed `process-post` silently ignores `youtube_playlist_id`.

#### Disclosure (OD-3)

`GoogleApiDisclosure.tsx` line 98 and the Stage 6 scope table stop saying Postora does not manage playlists. New wording: Postora lists the channel's playlists and, on the owner's instruction, adds a newly uploaded video to one; it does not create, rename, reorder or delete playlists or remove items. `YouTubeLegalDisclosures.test.tsx` and the verification guide follow.

#### Tests

`youtubeReadClient.test.ts` and `handler.test.ts` (playlists paging, foreign-channel item dropped, admission and 401 refresh shared, `invalid_cursor`); `youtubeUploadFollowUps.test.ts` (each numbered branch above, exactly one insert attempt on timeout, order preserved, playlist failure leaves thumbnail and comment outcomes intact); `youtubePublishEvidence.test.ts`; `n8n-api` evidence view with and without the key; a selector component test; a **two-channel component test** (two distinct native channels selected → selector disabled, helper note shown, previously chosen playlist cleared, no `youtube_playlist_id` emitted; the same channel selected twice → enabled); the legal test.

## 8. Phase 4 — activation of writes on existing videos

**Precondition for 4A: OD-1 is resolved in favour of activation** — D5 approval, then the D1 rehearsal recorded under `docs/reports/`, then Waleed's activation approval.

**4B and 6A do not wait for OD-1.** A thumbnail or caption upload does not merge with existing metadata, so the `If-Match` question does not apply to them. To keep them genuinely independent:

- `YouTubeAccountCapabilities.capabilities` gains two additive optional keys, `manage_thumbnail?` and `manage_captions?`, derived on their own (reconnect → `reconnect_required`; Composio → `provider_unsupported`; `manage_thumbnail` available with `youtube.upload` or `youtube.force-ssl`; `manage_captions` available with `youtube.force-ssl`; a recorded scope list without them → `missing_scope`; otherwise `unknown`). Neither reads `PUBLISHED_EDIT_WRITE_ENABLED`, and `edit_metadata` stays `unavailable` until 4A.
- The shared write plumbing — `youtube-resources/writeLimits.ts` (strict per-user counters and the budget debit as two separate functions) and the real `stillBound` re-read — is built by **whichever of 4A, 4B and 6A lands first**, in a module that does not import `editComposition.ts`. The later phases reuse it.

### 8.1 Phase 4A — published metadata editing

Everything that is switched, so none is missed:

| Location | Today | After |
| --- | --- | --- |
| `editComposition.ts` `PUBLISHED_EDIT_WRITE_ENABLED` | `false as const` | `true as const`; header comment rewritten to cite the evidence report |
| `index.ts` `writeGuard.authorizeWrite` | `() => Promise.resolve(false)` | Real limiter (below) |
| `index.ts` `writeGuard.stillBound` | `() => Promise.resolve(false)` | Real re-read (below) |
| `capabilities.ts` `edit_metadata` | Hard-coded `unavailable / provider_unsupported` | Derived (below) |
| `handler.ts` edit branch | Runs before `admit()` | Runs after `admit()` |
| `editComposition.ts` `update` return | Pre-write `snapshot` | Snapshot built from the verified re-read |
| `editLifecycle.ts` `EditFailureCode` | No rate-limit code | Adds `rate_limited` |
| `editProvider.ts` `EditWriteResult` / `updateVideo` | A lost answer is `upstream_unavailable` | A lost answer is `outcome_unknown` (below) |
| `editComposition.guard.test.ts` | Two refusal tests | Extended (below) |
| `YouTubeManagementScreen.tsx` `disabledReason` | "…until conditional write enforcement is verified." | Reason derived from the capability |
| Legal pages, legal test, Stage 6 package | "behind a hard-off activation gate at this baseline" | Editing described as live |

**Write limiter.** `EditWriteGuard.authorizeWrite` changes from `Promise<boolean>` to:

```ts
Promise<{ ok: true } | { ok: false; code: "rate_limited" | "upstream_unavailable"; retryAfterSeconds?: number }>
```

It checks, with the strict parsing of §4.3, in order: `youtube-resources:edit:burst` (10 per 600 s, per user) and `youtube-resources:edit:day` (50 per 86,400 s, per user), both through `check_rate_limit`; then it debits 50 units from the project write budget (§10) in one `check_weighted_rate_limit` call. A refused counter is `rate_limited` with `retry_after_seconds`; an unreadable counter is `upstream_unavailable`. Either way no catalog read and no provider write happens. Counters count attempts, including refused ones. The limiter stays where it is in `update`: after the snapshot read (which is the ownership proof) and the revision check, before the category catalog read. The shared budget is therefore only ever debited for a video Google has confirmed as owned; requests naming other ids are stopped by `admit()`'s read limiter and the `not_found` answer.

**`stillBound`.** Immediately before `provider.updateVideo`, re-load the account by `id` and `user_id` and require: active, `platform = "youtube"`, native provider, `needs_reauth` false, `platform_user_id` equal to the channel captured at the start, and the stored access token equal to the token about to be used. Any difference, or a failed read, is `false` and the write is refused as `reconnect_required`.

**Lost-answer semantics in `editProvider.ts`.** Today `updateVideo` answers `upstream_unavailable` in three cases where the `PUT` may already have been applied: the fetch throws or times out, a 2xx body cannot be parsed, and a 2xx body parses to a different video id. `upstream_unavailable` tells the creator "nothing happened, try again", which is false here and invites a second write on top of an unknown first one. `EditWriteResult` becomes:

```ts
export type EditWriteResult =
  | { ok: true; id: string }
  | { ok: false; code: "edit_conflict" | "reconnect_required" | "upstream_unavailable" | "outcome_unknown" };
```

| Situation in `updateVideo` | Code |
| --- | --- |
| Fetch throws, aborts or times out after the request was dispatched | `outcome_unknown` |
| 2xx with a body that is not JSON | `outcome_unknown` |
| 2xx with a body that fails `parseVideo`, or whose id is not the requested video | `outcome_unknown` |
| Explicit non-2xx (412, 401, 403, 404, 429, 5xx) | Unchanged: `writeFailure(status)` keeps its typed categories |
| Any refusal before the request is sent (limiter, budget, `stillBound`, plan validation) | Unchanged: typed pre-write refusals |

`editComposition.ts` already maps a non-ok write straight into `EditFailure(written.code)`, and `outcome_unknown` is already in `EditFailureCode` and in `YOUTUBE_RESOURCE_ERROR_STATUS` (502), so the handler and the UI's existing "YouTube may have saved this change. Check current details." message need no new code. The write is attempted **exactly once**: no retry after a lost answer, and never a retry that substitutes a newer ETag.

**Capability.** `deriveYouTubeCapabilities` receives `editWriteEnabled: boolean` from the composition. `edit_metadata` is: `unavailable / reconnect_required` when the account needs reconnecting; `unavailable / provider_unsupported` for Composio or when the constant is false; `available` when `youtube.force-ssl` is granted; `unavailable / missing_scope` when a scope list was recorded without it; otherwise `unknown`.

**Admission.** `edit_snapshot` and `update_video` pass through `admit()` first, so Composio, the browse capability, the stored channel and the per-user read limiter apply. Today the snapshot read would be unthrottled once the port exists.

**Scope of the first activation.** Title, description, tags and category. The gateway port (`application/ports.ts` `updateVideo.changes`) gains `description` and `tags`; the edit card gains a description textarea (5,000) and a tag editor. Privacy changes stay out of the first activation: the server contract keeps validating `privacy_status` with `privacy_confirmation`, and the inert visibility checkbox in `YouTubeVideoEditCard.tsx` is removed until that follow-up. After a save the drawer refetches the `video` query and shows the verified values.

**Cost.** One save: `videos.list` snapshot (1) + category catalog (1; `update` reads it unconditionally today) + `videos.update` (50) + verification `videos.list` (1) = **53 units**. Opening the editor: 1.

**Tests.** Guard suite: burst refusal, daily refusal, unreadable counter, budget refusal, each proving zero catalog and zero provider-write calls; `stillBound` false for each differing field; refused limiter surfaces `429 rate_limited` with `retry_after_seconds`. `handler.test.ts`: edit operations refused by `admit()` (Composio, reconnect, read limit) before the port is called; response carries the post-write revision. `capabilities.test.ts`: full derivation table. `editLifecycle.test.ts` stays green unchanged. `editProvider.test.ts`: existing cases stay (`If-Match` always present, 412 is `edit_conflict`); new cases prove that a thrown fetch, a timeout, a non-JSON 2xx and a 2xx with a mismatched id are each `outcome_unknown`; that 401, 403, 412 and 500 keep their existing codes; and, with a counting fetch stub, that `updateVideo` makes **one** request in every one of those cases and never sends a second `PUT` with a different `If-Match`. UI: edit, save, conflict and unknown outcomes inside the drawer. `e2e/youtube-stage3.spec.ts` updated. The legal test updated.

### 8.2 Phase 4B — replace the thumbnail of an existing video

```ts
// request
{ operation: "set_thumbnail", account_id: string, video_id: string, media_file_id: string /* uuid */ }
// success data
{ video_id: string; applied: true }
```

New stable error codes in `YOUTUBE_RESOURCE_ERROR_STATUS`: `thumbnail_not_allowed: 403` (the channel may not set custom thumbnails) and `media_not_usable: 400` (not an owned raster image, or too large). An old client maps an unknown code to `upstream_unavailable` through `isYouTubeResourceErrorCode`, as designed.

Server sequence, in `youtube-resources/thumbnailComposition.ts` behind a `YouTubeThumbnailPort` so `index.ts` stays an adapter:

1. Authenticate; load the account by id and owner; `admit()`.
2. Load the media row by `id` **and** `user_id`. The row's declared type must be an image and its MIME must be exactly `image/jpeg` or `image/png`. Not found, foreign or any other type → `media_not_usable`. The client never supplies a URL.

   **WebP is rejected here.** Google's `thumbnails.set` reference lists JPEG and PNG as the accepted upload types. The upload-time intake (`process-post/youtubeThumbnailIntake.ts`, `THUMBNAIL_RASTER_MIMES`) also admits `image/webp`, because that path can convert or deliver through the media pipeline; this operation sends the stored bytes to Google directly, so it uses its own narrower allow-list, `DIRECT_THUMBNAIL_MIMES = ["image/jpeg", "image/png"]`, and does not reuse the wider set. The accepted formats are re-confirmed against the reference in the plan's reference check.
3. Per-user write counters: the same `youtube-resources:edit:burst` and `:day` keys as 4A. Refused or unreadable → no further step.
4. Ownership pre-check with `getVideo` (1 unit): a foreign or absent video is `not_found`.
5. Download the bytes from Postora's own storage with a timeout and a hard 2 MB cap (YouTube's thumbnail limit); over the cap → `media_not_usable`. **Verify the bytes**, not only the stored MIME: the file must begin with the JPEG signature (`FF D8 FF`) or the PNG signature (`89 50 4E 47 0D 0A 1A 0A`), and the signature must agree with the declared MIME. A mismatch, including WebP bytes stored under a JPEG label, is `media_not_usable`. The `Content-Type` sent to Google is the verified type.
6. Project write budget debit of 50 units (§10), then `stillBound`. The debit is last among the checks, so a wrong video id, a foreign media id or an oversize file never spends shared budget.
7. `POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=<id>` with the image bytes and its MIME type, 30 s timeout. `youtube.upload` and `youtube.force-ssl` both cover it.
8. 2xx → success. 403 → `thumbnail_not_allowed`. 401 → `reconnect_required` (no blind repeat of the upload). Thrown or timed out → `outcome_unknown`. Never retried automatically.

The owner-scoped media lookup is shared with the upload-time intake where its ports allow (moved to `_shared/youtubeThumbnailIntake.ts` with a re-export at the old path, or implemented locally if the ports are specific to `process-post`). The MIME allow-list is **not** shared: upload-time intake keeps `THUMBNAIL_RASTER_MIMES`, this operation keeps `DIRECT_THUMBNAIL_MIMES`, and a comment at each names the other and the reason they differ.

**UI.** The drawer gains "Change thumbnail" beside the preview: it opens the existing media library picker restricted to images, shows the chosen image, asks for confirmation ("This replaces the thumbnail viewers see on YouTube"), then shows applied, not allowed, or unknown ("YouTube may have applied it. Refresh to check."). Enabled by the `manage_thumbnail` capability, with its reason shown when unavailable.

**Tests.** Composition tests for every numbered step and its refusal, each asserting no upload call happened; foreign media id; oversize; non-image; **an owned `image/webp` row is `media_not_usable`**; WebP bytes under an `image/jpeg` label are `media_not_usable`; JPEG and PNG each succeed with the matching `Content-Type`; lost answer; handler schema; component flow (the picker offers only JPEG and PNG).

## 9. Phase 5 — advanced analytics and export

**Precondition: OD-2 is decided.** If v2 of the purpose clause is chosen, it lands first, in its own PR: new pinned EN/AR text, `ANALYTICS_PURPOSE_VERSION = 2`, the digest test updated deliberately, legal pages updated, and a check of `supabase/migrations/20261125120000_youtube_stage5_analytics_rollout.sql` and `20261126120000_…` for any place the version is fixed in SQL. If SQL changes, that PR is Heavy and needs Waleed's card.

**v2 rollout must not strand v1 clients.** The function and the frontend deploy separately, and a browser tab can run the old bundle for hours. If the function simply switched to "version 2 only", an open v1 tab would lose its reports and could only offer a v1 acceptance the server now refuses. PR-12 is therefore two stages:

1. **Stage A — accept both.** The function is deployed accepting purpose versions 1 **and** 2 for `consent_accept`, and treating an existing v1 acceptance as still valid. `status` reports the newest version, 2. Nothing changes for a v1 client. Then the frontend deploys with the v2 text and sends `purpose_version: 2`.
2. **Stage B — require v2.** After the frontend has been live long enough for old tabs to turn over (proposed: 48 hours, Waleed's call), the function is redeployed requiring version 2. A v1 acceptance now reads as `outdated`, and a stale v1 tab that tries to accept gets `consent_version_stale`, whose notice tells the user to reload. That notice is verified to exist in the v1 bundle before Stage B; if it does not, Stage B waits for one.

If Waleed prefers a single coordinated deploy, the function and the frontend go out in the same window with the function first, and the `consent_version_stale` reload path is the safety net for tabs opened before it. The Phase 5A operations (PR-13) deploy only after Stage B, so no new report is ever served under a v1 acceptance.

**Deploy order for 5A.** `youtube-analytics` validates `operation` with a strict discriminated union, so an undeployed function answers `invalid_request` to the four new operations. The function is deployed before, or together with, the frontend that calls them.

### 9.1 Phase 5A — four report operations

`YOUTUBE_ANALYTICS_OPERATIONS` gains `"traffic_sources"`, `"geography"`, `"devices"`, `"retention"`. The audit allow-list (`audit.ts`) reads that constant, so audit rows need no schema change.

```ts
export type YouTubeAnalyticsBreakdownDimension = "traffic_source" | "country" | "device";

export interface YouTubeAnalyticsBreakdownRow {
  key: string;                        // validated provider enum value or ISO country code
  metrics: YouTubeAnalyticsMetric[];  // views, watch_time
}
export interface YouTubeAnalyticsBreakdownData {
  dimension: YouTubeAnalyticsBreakdownDimension;
  rows: YouTubeAnalyticsBreakdownRow[];
  has_data: boolean;
}
export interface YouTubeAnalyticsRetentionPoint {
  ratio: number;                          // elapsedVideoTimeRatio, 0 < ratio ≤ 1
  watch_ratio: number | null;             // audienceWatchRatio
  relative_performance: number | null;    // relativeRetentionPerformance, 0..1
}
export interface YouTubeAnalyticsRetentionData {
  points: YouTubeAnalyticsRetentionPoint[];
  has_data: boolean;
}
```

| Operation | Request | `reports.query` | Row validation |
| --- | --- | --- | --- |
| `traffic_sources` | base | `dimensions=insightTrafficSourceType`, `metrics=views,estimatedMinutesWatched`, `sort=-views` | key matches `^[A-Z_]{1,40}$`, unique, at most 40 rows |
| `geography` | base | `dimensions=country`, same metrics, `sort=-views`, `maxResults=25` | key matches `^[A-Z]{2}$`, unique, at most 25 |
| `devices` | base | `dimensions=deviceType`, same metrics, `sort=-views` | key matches `^[A-Z_]{1,40}$`, unique, at most 20 |
| `retention` | base + required `video_id` | `dimensions=elapsedVideoTimeRatio`, `metrics=audienceWatchRatio,relativeRetentionPerformance`, `filters=video==<id>`, `sort=elapsedVideoTimeRatio` | at most 100 points, strictly ascending ratio in (0, 1], finite non-negative values |

"base" is `account_id`, `period_days`, `window_end`. Every schema is `.strict()`.

- All four run the unchanged pipeline: admission limit → decision (consent, scopes, rollout) → window → per-user data limit → credential decision → token → `analytics` budget debit → provider → final decision → `no-store` envelope → background audit. `retention` first runs `lookupVideoOwnership` (one `data` debit), exactly as `summary` and `daily` do for a `video_id`.
- `exactHeaders` checks the column headers of each report. Any row that fails validation makes the whole answer `upstream_unavailable`; a partially understood report is never shown.
- Unknown enum values that still match the pattern pass through; the client labels the ones it knows and shows the rest under "Other". No raw provider text beyond these validated identifiers is returned.
- Cost: one Analytics unit per operation; `retention` plus one Data unit. Limits and budget ceilings are unchanged.

**Frontend.** `YouTubeAnalyticsDataOperation`, `youtubeAnalyticsQueryKey` and `useYouTubeAnalyticsReportQuery` extend to the new operations (retention carries `videoId` in the key). New hooks `useYouTubeAnalyticsBreakdown` and `useYouTubeVideoRetention`. UI: a tab strip under the overview — Overview (today's content) · Audience (geography, devices) · Traffic — and a retention chart inside the video drawer.

**Fetching is lazy.** A breakdown is requested only when its tab is first opened, and retention only when the drawer's retention section is expanded. Opening the page costs what it costs today (three Analytics units, one Data unit). Eager loading would double that against the 60-per-10-minute user limit and the shared daily ceiling.

Charts use `recharts`, as `DailyTrend.tsx` already does; no new dependency. Country names come from `Intl.DisplayNames(locale, { type: "region" })`. Every chart has a table alternative for screen readers, and numbers stay in `LtrValue`.

**i18n** (namespace `analytics`): `youtube.tabs.*`, `youtube.traffic.*`, `youtube.geography.*`, `youtube.devices.*`, `youtube.retention.*`.

**Tests.** `analyticsReadClient.test.ts` per report: URL, header mismatch, bad key, duplicate key, too many rows, empty report, retention ordering. `handler.test.ts` per operation: consent required, withdrawn, missing scope, stale window, budget refusal, foreign `video_id` for retention is `video_not_found`, `no-store`, audit operation recorded. `composition.test.ts` and `decision_limits.test.ts` extended. Frontend: lazy fetch proven by call counts; purge on withdrawal covers the new keys; RTL rendering.

### 9.2 Phase 5B — export

- `domain/exportCsv.ts` (pure): builds CSV text from the report data **already held in memory** for the active tab. RFC 4180 quoting, CRLF line ends, UTF-8 with BOM so Arabic opens correctly in Excel. A string cell beginning with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with `'` (formula injection: video titles are attacker-influenced). Numeric cells are written as numbers, so a negative net likes value is not prefixed. Header rows state channel title, period, Pacific time zone and `fetched_at`.
- `ui/ExportMenu.tsx`: "Download CSV" and "Print / save as PDF". CSV uses a `Blob` and a temporary object URL that is revoked after the click. File name: `youtube-analytics_<channel-slug>_<start>_<end>.csv`.
- Print uses `window.print()` and a print stylesheet that hides navigation and controls and expands the tables. No PDF library.
- **No network request is made by either action**, nothing is written to browser storage, and the server never receives or produces a file. Export is disabled while the active tab has no loaded data and is unavailable when consent is not accepted.

**Tests.** `exportCsv` unit tests (quoting, BOM, injection guard, negative numbers, Arabic, empty report); a component test asserting zero gateway calls on export and that the object URL is revoked.

## 10. Project-wide write budget (OD-6)

Proposal for Waleed. The default project quota is 10,000 Data API units per Pacific day.

| Consumer | Units per action | Tracked today |
| --- | --- | --- |
| Stage 5 ownership and title reads | 1 | Yes — `youtube-analytics:budget:data:<day>`, ceiling 1,000 |
| Stage 2 reads, plus Phase 1B and 3B reads | 1–2 per request | Per user only |
| Stage 4 comment writes | 50 | Per user only |
| Upload thumbnail (`thumbnails.set`) | 50 | No |
| Phase 3B playlist insert | 51 | **New budget** |
| Phase 4A save | 53 | **New budget** (50 debited) |
| Phase 4B thumbnail change | 51 | **New budget** (50 debited) |
| Phase 6A caption list / upload | 50 / 401 | **New budget** |
| Phase 6B channel lookup | 3 | **New budget** (own bucket) |
| Phase 7B caption at upload (§14.3) | 400 | Same write bucket; shares the 2-per-day user counter with 6A |
| Phase 7C playlist creation (§14.4) | 50 | Same write bucket; 5 per user per day |

- New bucket `youtube-resources:budget:write:<YYYY-MM-DD Pacific>`, proposed ceiling **4,000 units**, debited by the write's own cost (50 or 400) in **one atomic call** to `check_weighted_rate_limit` (§4.3, added by the Phase 3B-pre migration) and read through the strict parser. A debit that would pass the ceiling is refused whole: a 400-unit caption upload with 300 units left is refused and leaves the 300 untouched. `check_rate_limit` cannot do this and is not used for unit budgets. The bucket is keyed on the same Pacific-day arithmetic Stage 5 uses (`youtube-analytics/window.ts` `pacificBudgetBucketKey`; the day calculation is extracted to `_shared` when its second consumer arrives, with the analytics keys unchanged).
- Interactive writes are refused with `quota_exceeded` when the budget is spent or unreadable. The playlist follow-up is `skipped / quota_budget`.
- Phase 6B gets its own bucket, proposed **300 units** per day, debited through the same weighted function by the units each lookup actually spends (1, 2 or 3).
- No budget debit of this section can ship before the Phase 3B-pre migration is applied in production. Applying it is Waleed's action.
- Worst case if every ceiling is hit: 1,000 + 4,000 + 300 = 5,300 units, leaving 4,700 for untracked reads, comment writes and upload thumbnails. This is still not a full ledger: untracked consumers can exhaust the project first, and then Google's own `quotaExceeded` maps to `quota_exceeded`.
- The budget debits only the write itself (50 or 400); the 1-unit reads around it are covered by the per-user request limits. At 4,000 units it allows 80 edits or thumbnail changes, or 10 caption uploads, per day across **all** users. Phase 6A is not viable for general availability without a quota extension from Google.
- **Debit order.** Everywhere the budget is used, the order is: per-user counter, then the ownership read, then the budget debit, then the write. A caller can exhaust only their own allowance with requests that would never have been sent to Google.

## 11. Phase 6 — captions and channel benchmark

### 11.1 Phase 6A — caption tracks

```ts
// requests
{ operation: "captions", account_id: string, video_id: string }
{ operation: "upload_caption", account_id: string, video_id: string,
  language: string,      // BCP-47, ^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$
  name: string,          // 0..150 characters, no line breaks
  format: "srt" | "vtt",
  content: string }      // file text, ≤ 512 * 1024 UTF-8 bytes (524,288)

// contracts.ts
export interface YouTubeCaptionTrack {
  id: string;
  language: string;
  name: string;
  track_kind: string | null;   // "standard" | "ASR" | "forced"
  is_draft: boolean | null;
  status: string | null;
  last_updated: string | null;
}
```

- New error codes: `caption_conflict: 409` (a track with that language and name exists) and `caption_invalid: 400`.
- **Transport.** `youtube-resources/handler.ts` reads the body with an uncapped `req.json()` today. This phase replaces it with `readJsonBodyCapped` (`_shared/cappedJsonBody.ts`, already used by `youtube-analytics`) at 1.5 MB with a read timeout, for every operation. Over the cap is `invalid_request`.
- **Content limit in bytes, not characters.** `content` is limited to `512 * 1024` UTF-8 bytes, measured with `new TextEncoder().encode(content).byteLength`, and exceeding it is `caption_invalid`. A character count would be the wrong unit: Arabic letters are 2 bytes each in UTF-8 and JSON escaping can add more, so a 1,000,000-character Arabic file could exceed the 1.5 MB body cap and be refused as a generic `invalid_request` before the caption check ever ran. A 512 KiB ceiling leaves about one megabyte of the 1.5 MB body for JSON overhead, so a caption within the limit, sent as ordinary UTF-8 JSON, always reaches the caption validator, and one over the limit is answered `caption_invalid`. The gateway sends the text as raw UTF-8 (the default of `JSON.stringify`), never `\uXXXX`-escaped. The browser checks the same byte limit before sending and shows the limit in KB.
- **Format check.** `youtube-resources/captionFile.ts` (pure): SRT must be numbered cues with `HH:MM:SS,mmm --> HH:MM:SS,mmm`; VTT must start with `WEBVTT` and use `HH:MM:SS.mmm --> …` or `MM:SS.mmm --> …`; at least one cue; cue times non-decreasing; no NUL bytes. Failure is `caption_invalid`. The file text is never logged.
- **List.** `captions.list?part=snippet&videoId=<id>` — 50 units, requires `youtube.force-ssl`. Preceded by the ownership pre-check (1 unit). Sequence: `admit()` → per-user cap (10 lists per 24 h, strict counter) → ownership (1) → write budget debit 50 → list.
- **Upload.** `POST https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart` with `{ snippet: { videoId, language, name, isDraft: false } }` and the file part — 400 units. Sequence: `admit()` → format check (free, so a bad file costs nothing) → per-user cap (**2 uploads per 24 h**, strict counter) → ownership (1) → write budget debit 400 → `stillBound` → upload with a 60 s timeout.
- In both sequences the shared budget is debited only after Google confirmed the video is owned. A caller sending invalid video ids exhausts their own per-user cap and nothing else.
- **Outcomes.** 2xx → the created track. 409 → `caption_conflict`. 403 → `missing_scope` or `not_found` through the existing classifier. Thrown or timed out → `outcome_unknown`; it is never retried, and the UI tells the creator to refresh the track list before trying again.
- **Out of scope.** Downloading, replacing, deleting or auto-translating tracks.

**UI.** A "Captions" section in the `/youtube` drawer: a "Show caption tracks" button (not automatic — each list costs 50 units), the track table, and an upload form with file input (`.srt`, `.vtt`), language select, track name, the remaining daily allowance, and a confirmation step. Shown only when the `manage_captions` capability is available.

**Disclosure (OD-3).** Legal pages, test and guide add caption listing and upload under `youtube.force-ssl`.

**Tests.** `captionFile` unit tests (valid and invalid SRT and VTT, Arabic text, BOM, CRLF); an **Arabic UTF-8 byte-boundary test** — Arabic caption text of exactly 524,288 bytes is accepted, 524,289 bytes is `caption_invalid`, and a file of about 300,000 Arabic characters (under the old character idea, over the byte limit) is `caption_invalid` rather than `invalid_request`; a valid Arabic file near the limit passes the 1.5 MB body cap; composition tests for both sequences proving order and that a refusal at any step makes no later call; oversize body; conflict; lost answer makes one attempt; per-user and budget refusals; component tests for the confirm-then-upload flow.

### 11.2 Phase 6B — public channel benchmark

**Precondition: OD-4 go decision after the policy read.**

- **Own function:** `supabase/functions/youtube-channel-benchmark/` (`index.ts` adapter, `handler.ts`, `contracts.ts`, `benchmarkReadClient.ts`). `youtube-resources` is not touched, so "this endpoint cannot look up videos outside the connected channel" stays true where it is stated.
- **Own feature:** `src/features/youtube-benchmark/` with the standard layers and its own `architecture.test.ts`. Whether it is surfaced inside competitor tracking is part of OD-4.

```ts
// request
{ account_id: string, channels: string[] }   // 1..3 entries, unique
// each entry: handle ^@[A-Za-z0-9._-]{3,30}$  or channel id ^UC[A-Za-z0-9_-]{22}$

export type YouTubeBenchmarkChannelStatus = "found" | "not_found" | "unavailable";

export interface YouTubeBenchmarkChannel {
  input: string;
  status: YouTubeBenchmarkChannelStatus;
  /** Present when status is "unavailable", or when status is "found" and the uploads/videos lookup failed. */
  error?: "quota_exceeded" | "reconnect_required" | "upstream_unavailable";
  channel_id: string | null;
  title: string | null;
  thumbnail_url: string | null;
  subscriber_count: number | null;        // null when hidden
  subscriber_count_hidden: boolean;
  view_count: number | null;
  video_count: number | null;
  recent_videos: Array<{
    id: string; title: string; published_at: string | null;
    view_count: number | null; like_count: number | null; comment_count: number | null;
  }>;                                      // up to 10
}
```

- `account_id` is the caller's **own** native YouTube account, loaded by id and owner exactly as elsewhere. It supplies the credential only. Its channel is never used as a lookup target and the request cannot name another user's account.
- Per channel, in order, stopping as early as possible:
  1. `channels.list?part=snippet,statistics,contentDetails&forHandle=<handle>` or `&id=<id>` — 1 unit.
  2. `playlistItems.list` on `contentDetails.relatedPlaylists.uploads` with `maxResults=10` — 1 unit. Skipped when step 1 found no channel.
  3. `videos.list?part=snippet,statistics&id=…` — 1 unit. **Skipped when step 2 returned zero upload ids**; `recent_videos` is then `[]`.

  **Three units per channel is the maximum, not the fixed cost**: 1 unit when the channel is not found, 2 when it has no uploads, 3 otherwise. Nine units is the ceiling for three channels. The budget is debited by the units actually spent. All three calls are readable under `youtube.readonly`.
- **Three per-channel states, and they are not interchangeable.**
  - `"found"` — step 1 returned the channel. A failure in step 2 or 3 after that still reports `"found"` with `recent_videos: []` and `error` set, so real channel figures are never discarded.
  - `"not_found"` — **only** when step 1 succeeded (2xx) and returned zero items. This is the single case that may be shown as "No channel with this handle". The response does not distinguish "does not exist" from "hidden".
  - `"unavailable"` — step 1 itself failed: quota, an expired or revoked grant, a timeout, a 5xx, an unreadable body. `error` carries the typed reason: `quota_exceeded`, `reconnect_required` or `upstream_unavailable`. It is never reported as `"not_found"`; telling a creator a real competitor does not exist because the quota ran out would be wrong.
- Channels are fetched independently; one channel's state never changes another's. If the caller's own grant is rejected (401 after the single forced refresh), the whole request fails as `reconnect_required` instead of returning three `"unavailable"` rows, because no lookup can succeed.
- Limits: per user 10 requests per 10 minutes and 30 per 24 h (`check_rate_limit`, strict parse); project bucket of 300 units per Pacific day (§10, weighted function).
- Only public fields are read. Nothing is written to the database. Responses carry `Cache-Control: no-store`.
- **Client cache:** React Query, in memory, **one entry per channel** keyed by user, account and the normalised input, not persisted (the app has no query persistence configured; this feature must not add one). Signing out or switching user clears it. Only settled answers are kept for 30 minutes: `"found"` without `error`, and `"not_found"`. An `"unavailable"` result, a `"found"` result carrying `error`, and a request-level failure are **not** cached as fresh — they are stored with `staleTime: 0` (or not stored at all), so the next Compare retries them instead of showing a quota or outage answer for half an hour. Retrying one unavailable channel does not re-spend units on the channels that already succeeded.
- **Deploy order.** The function is new. It is deployed, and its feature flag left off, before the frontend that calls it merges.

**UI.** Each column shows its own state: figures for `"found"`, "No channel with this handle" for `"not_found"`, and for `"unavailable"` the notice for its `error` with a Retry that refetches that channel only. Up to three inputs, a side-by-side table (subscribers, total views, videos, and per-recent-video averages computed in the browser), the "fetched at" time, and an attribution line that the figures are public data from YouTube.

**Disclosure (OD-3).** Legal pages, test and guide add reading public data of channels the user names.

**Tests.** Input validation; call counts of 1 (not found), 2 (no uploads, `videos.list` never called) and 3 per channel, nine at most for three, with the budget debited by the same numbers; an empty 2xx is `"not_found"`; quota, 5xx and timeout on the channel lookup are `"unavailable"` with the matching `error` and never `"not_found"`; a failure after the channel was found keeps `"found"` with `error`; one channel's failure leaves the others intact; a rejected grant fails the whole request as `reconnect_required`; hidden subscriber count; an `"unavailable"` result is refetched on the next Compare while a `"found"` one is served from cache; limiter and budget refusals; foreign `account_id` is `404`; `no-store`; client cache keyed and cleared; the new `architecture.test.ts`.

## 12. Acceptance criteria

Each phase is accepted separately.

- [x] **1A** Table and grid with numbering, six sortable headers with `aria-sort`, Load more in steps of 10 without duplicates, reset on account/period/window change, drawer from the right in English and the left in Arabic, `?video=` deep link opens it. No added Google cost outside Load more. `no-store` intact.
- [x] **1B** Library table and grid with numbering, seven sortable headers, search and Shorts filter, Load more keyed on `hasMore` only, drawer with nine metadata cells, description box, tag chips and the edit section. One extra unit per page; degraded enrichment still shows the page.
- [x] **2A** Inserted chapters always pass `validateChapters`; invalid model output never reaches the description; estimated timing is always labelled.
- [x] **2B** A suggestion only fills the draft; no reply is sent without the Reply button; hostile comment text cannot change the output contract.
- [x] **3A** PR-7A deployed and smoke-tested before the UI exposes scheduling or emits `youtube_publish_at`. `undefined`, `null` and `""` are byte-identical to today; any other unusable value ends private without `publishAt`; a valid one is sent `private` with `publishAt`; the recheck sits before `createYoutubeResumableSession`; the warning reaches evidence on both settlement paths.
- [x] **3B-pre** `check_weighted_rate_limit` applied in production by Waleed; `check_rate_limit` unchanged; a refused debit changes nothing.
- [x] **3B** The selector lists only the bound channel's playlists and is disabled for more than one distinct native channel; the insert is attempted at most once; its failure never changes the upload receipt.
- [x] **4A** OD-1 evidence recorded and approved; every switch in §8.1 made; write limiter and budget fail closed; a lost `videos.update` answer is `outcome_unknown` after exactly one attempt; the saved response carries the post-write revision.
- [x] **4B** Only an owned JPEG or PNG of at most 2 MB, verified by its bytes, can become the thumbnail of an owned video; WebP is refused; a lost answer is reported as unknown.
- [x] **5A** OD-2 decided and applied; four operations inside the unchanged consent and budget pipeline; fetched lazily; nothing stored.
- [x] **5B** Export makes no network request and writes nothing to storage; CSV is injection-safe and opens correctly with Arabic text.
- [x] **6A** Format-checked before any quota is spent; two uploads per user per day; project budget enforced; no retry on a lost answer.
- [x] **6B** OD-4 go decision recorded; own function and feature; at most three units per channel; `found`, `not_found` and `unavailable` kept distinct; unavailable results not cached; nothing stored.
- [x] **2A, 2B** No outline, comment text, model output or provider body in any log line, proven by the log-capture tests.
- [x] **1A, 1B** Refresh costs one page on both screens however many were loaded.
- [x] **Every phase** Its Deno, Vitest, typecheck, ESLint and i18n gates pass (plan §0.3); guard skills run for its tier; legal pages and their test match shipped behaviour; changed Edge Functions are deployed per `docs/runbooks/deploy-edge-function.md` and verified.

Phase 7 (§14), completed:

- [x] **7.0 AI Suggest** Description suggestions use the title alone when the description is empty and title plus draft when it is not; tag suggestions use both; no title, draft or provider body appears in any log line (log-capture test); every returned suggestion fits YouTube's limits and carries no `<` or `>`.
- [x] **7.0 Player** OD-7 and OD-8 recorded. Nothing is requested from Google until the creator presses Play; the iframe URL is built only from an id matching `^[A-Za-z0-9_-]{11}$`; messages are accepted only from `https://www.youtube-nocookie.com` and from the player's own window; no element is drawn over the player; the player is never smaller than 200 × 200 px; it is removed on Stop, on drawer close and on video change; `frame-src` names that one host and nothing else.
- [x] **7.0 Edit toggle** The button opens and closes the editor; a successful save closes it and the "Current details match your changes." line stays visible; every other outcome leaves the editor open.
- [x] **7.0 Thumbnail dialog** Upload, library and AI tabs each end in an owned JPEG or PNG `media_files` row of at most 2 MB; `set_thumbnail` still receives only a `media_file_id`; `youtube-resources` is unchanged; the write is sent once per confirmed choice.
- [x] **7.0 Caption errors** Each of `missing_scope`, `reconnect_required`, `rate_limited`, `quota_exceeded`, `not_found` and a retryable failure shows its own message; Retry is offered only where a repeat can succeed; deployed `youtube-resources` matches `main` by SHA256.
- [x] **7A** `segments` is returned only when the provider supplied times and they pass validation; the generated `.srt` and `.vtt` pass `validateCaptionUploadInput`; the timed outline fits 8,000 characters and starts at `00:00`; chapters built from it pass the time-subset rule.
- [x] **7B** OD-9 recorded. The caption is validated before any quota is spent, counts against the creator's two uploads per day, debits 400 units once, is sent once, and never changes the upload receipt; `content` appears in no log, evidence row or API view and is removed from the stored post on settlement.
- [x] **7C** OD-10 recorded. A playlist is created only with `youtube.force-ssl`, at most five per user per day, after a 50-unit debit, in one attempt; a lost answer is `outcome_unknown`; the new playlist is selected only when Google's answer names the bound channel.
- [x] **7D** `overall_score` is computed by the server from validated parts; `thumbnail_synergy` is `null` when no thumbnail description was given; "Use this title" only fills a field; no title or thumbnail text reaches a log.
- [x] **7E** OD-11 recorded. Privacy cannot be saved without the confirmation matching the chosen value; a scheduled video's privacy control is disabled and a forged request is refused with zero counter, budget and provider-write calls; the saved response is the verified re-read.

## 13. Non-goals

- No new OAuth scope. Every operation here is covered by the three scopes already granted (`youtube.readonly`, `youtube.upload`, `youtube.force-ssl`), subject to the plan's reference check.
- No video deletion, no replacement of video bytes, no playlist rename, reorder, deletion or item removal (playlist creation on the owner's explicit instruction shipped in PR-18), no caption download, replacement or deletion.
- No storage of analytics numbers, competitor figures or caption files in Postora's database.
- No change to the n8n community node or to the public n8n API options.
- No refactor of `StudioVideoPicker.tsx`, `process-post/index.ts` or the three `PlatformMetadata` copies beyond the two added keys.
- No unified project-wide quota ledger; §10 is a bounded write budget, not an accounting of every unit.
- No PDF library and no new runtime dependency in any phase.

**Amendments made by Phase 7.** Two lines above stop being true when their PR ships, and each is rewritten in that PR, not before:

- "no playlist creation" ends with PR-18 (OD-10). Rename, reorder, deletion and item removal stay non-goals.
- "No storage of … caption files" is narrowed by PR-17 (OD-9): a caption chosen for a **new upload** is held on that post until it settles, then removed. Captions of existing videos are still never stored.

Phase 7 adds its own non-goals in §14.7.

## 14. Phase 7 — post-vNext UX fixes, drawer player and creator extensions

Six PRs. `PR-15A` repairs and completes surfaces Phases 2, 4 and 6 shipped; `PR-16` … `PR-20` add five features that each reuse plumbing already in `main`. Every rule of §1 holds. Statements below about current code were read from `origin/main` at `24ec1698`; statements about Google's behaviour were read from Google's reference pages on 27 November 2026 unless marked "from the brief".

| PR | Phase | Section | Tier | Edge Functions changed | Owner decisions |
| --- | --- | --- | --- | --- | --- |
| PR-15A | 7.0 | §14.1 | **Heavy** | `generate-caption` | OD-7, OD-8 |
| PR-16 | 7A | §14.2 | Medium | `transcribe-media` | OD-12 |
| PR-17 | 7B | §14.3 | **Heavy** | `process-post`, `n8n-api`, `youtube-resources` (re-export only) | OD-9, OD-6 |
| PR-18 | 7C | §14.4 | **Heavy** | `youtube-resources` | OD-10, OD-3 |
| PR-19 | 7D | §14.5 | Medium | `generate-caption` | — |
| PR-20 | 7E | §14.6 | **Heavy** | `youtube-resources` (tests; code only if step 0 finds a gap) | OD-11, OD-3 |

### 14.1 Phase 7.0 — `PR-15A`: UX debug fixes, drawer player, rich thumbnail dialog

Five independent items in one PR. None changes `youtube-resources`.

#### 14.1.1 `/post` AI Suggest — title, description, tags

**Defect.** `YouTubeSettings.tsx` already passes `secondaryContext={settings.description}` to the description suggester, but `YouTubeLegacyAISuggestions` sends `context` alone unless `type === "tags"`, so a creator's draft description is ignored. On the server, `generate-caption/handler.ts` cuts the context to 1,000 characters (500 for titles), which would truncate "title + draft" even if it arrived.

**Client (`src/components/post/settings/YouTubeAISuggestions.tsx`).** The request `context` is built by one pure function, `buildYouTubeSuggestContext(type, title, description)`:

| `type` | `requestType` | `context` sent |
| --- | --- | --- |
| `title` | `youtube_title` | `settings.title` |
| `description`, description empty (`!secondaryContext?.trim()`) | `youtube_description` | `settings.title` |
| `description`, draft present | `youtube_description` | `` `Title: ${context}\nDraft Description / Notes: ${secondaryContext}` `` |
| `tags` | `youtube_tags` | `` `Title: ${context}\nDescription: ${secondaryContext || ""}` `` |

A written title stays required for all three (the existing guard and its three messages are unchanged). `YouTubeSettings.tsx` already passes the right props; it changes only if a prop name does.

**Server (`supabase/functions/generate-caption/handler.ts`).**

- Context caps become 500 characters for `youtube_title` (unchanged) and **6,000** for `youtube_description` and `youtube_tags` (a 100-character title, a 5,000-character description and the labels fit; the body schema's 10,000 limit is unchanged).
- The creator's text is placed inside a delimited block after `escapePromptTagDelimiters`, and the system prompt calls it data and says to ignore instructions inside it. Today it is interpolated between plain quotes.
- **`youtube_title`:** five click-worthy, search-optimised titles, each at most 100 characters, in the selected language. The model is not given trend data and no web search runs, so neither the prompt nor the UI claims live trends.
- **`youtube_description`:** three descriptions of roughly 900–1,500 characters, each with a hook in the first two lines (the part shown before "Show more"), key points, a call to action, relevant search keywords in natural sentences, three to five hashtags at the end, and these placeholders, exactly as written, for the creator to replace: `[MEETING / BOOKING LINK]`, `[OTHER CHANNEL / PARTNER CHANNEL]`, `[YOUR WEBSITE]`, `[YOUR INSTAGRAM]`, `[YOUR TIKTOK]`, `[YOUR TWITTER/X]`. When the context has a `Draft Description / Notes:` part, the prompt says to expand and optimise that draft and keep its facts, links and names; otherwise to write from the title alone. The prompt forbids inventing URLs, statistics or promises.
- **`youtube_tags`:** five comma-separated tag sets derived from the title **and** the description.
- **Output filter.** Before answering, the server drops any suggestion that is not a string, is empty, contains `<` or `>`, or is over its field's limit (title 100, description 5,000, tag set 500 characters). Zero survivors is `422 { error: "suggestions_invalid" }`; the raw model text is never returned. Today's bracket-repair fallback, which can return the raw text as one suggestion, is removed for these three types.
- **Logging.** A creator's draft now enters the prompt, so these three request types move onto the sanitized pipeline Phase 2 built (`invokeYouTubeAi`, `logYouTubeAiSuccess`, `logYouTubeAiFailure`; `YouTubeAiFeature` gains the three literals). The branch stops calling `response.text()` on a failure and stops logging `error_message` and `error_stack`. The response shape `{ suggestions: string[] }` is unchanged.
- **Token budget.** `invokeYouTubeAi` today sends `max_tokens: 1024` and `temperature: 0.4` for everything except chapters, while this branch used 4,096 and 0.8. Three 1,500-character descriptions do not fit 1,024 tokens, least of all in Arabic, and would fail the output filter almost every time. The helper therefore takes its budget per feature: `youtube_title`, `youtube_description` and `youtube_tags` keep **4,096 tokens and temperature 0.8**; chapters keep 4,096 and 0.4; the comment reply keeps 1,024 and 0.4. Stripping a Markdown code fence around the model's JSON stays; only the fallback that returns unparsed text as a suggestion goes.

**Tests.** A Vitest table for `buildYouTubeSuggestContext` (four rows above, whitespace-only draft counts as empty); a component test that the description request carries both parts when a draft exists; `handler.test.ts` for the three caps, the delimited block, the output filter (over-length, angle brackets, empty set → 422), and a **log-capture test** with one marker in the title, one in the draft and one in the stubbed provider's failure body, none of which may appear in any `console`, logger or `logAiCall` argument on the success, invalid-output, provider-failure and thrown-exception paths.

#### 14.1.2 `/youtube` drawer — embedded video player

**Precondition: OD-7 and OD-8.** The player is an embed. It makes no Data API call and spends no quota; the creator's own browser talks to YouTube.

**Files.**

| File | Change |
| --- | --- |
| `src/features/youtube-management/domain/player.ts` (new, pure) + test | `YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/`; `YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com"`; `buildYouTubeEmbedUrl(videoId, pageOrigin): string \| null`; `buildYouTubeWatchUrl(videoId): string \| null`; `YOUTUBE_PLAYBACK_RATES`; `playerCommand(func, args)`; `parsePlayerMessage(data): PlayerInfo \| null` |
| `src/features/youtube-management/ui/YouTubeVideoPlayer.tsx` (new) + test | Poster, iframe, toolbar, size modes |
| `ui/YouTubeVideoDetail.tsx` | Renders `YouTubeVideoPlayer` where `YouTubeVideoThumbnail` is today |
| `ui/YouTubeVideoDrawer.tsx` | Owns the drawer width for Theater mode; unmounts the player on close and on video change |
| `nginx.conf`, `public/_headers`, `src/lib/__tests__/cspRegression.test.ts` | `frame-src 'self' https://www.youtube-nocookie.com;` |
| `src/pages/Privacy.tsx`, `src/pages/GoogleApiDisclosure.tsx`, `src/pages/__tests__/YouTubeLegalDisclosures.test.tsx`, `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` | Embedded-player sentence (below) |

**Click to play (`D-P7-1`).** Until the creator presses Play the component renders a poster only: the video's `thumbnail_url` (or a local SVG placeholder when `thumbnail_url` is null), the duration badge (`formatIsoDuration`), a privacy note and a real `<button>` labelled "Play video". No iframe exists and zero requests to `youtube-nocookie.com` (YouTube's embed player) occur before Play. Pressing Play mounts the iframe; that press is the user gesture, and the drawer is open and in view, so the autoplay requirement (player more than half visible) is met.

**Embed URL.** `buildYouTubeEmbedUrl` returns `null` unless the id matches `YOUTUBE_VIDEO_ID_PATTERN`; a `null` leaves the poster in place with no Play button. Otherwise:

```text
https://www.youtube-nocookie.com/embed/<id>?enablejsapi=1&playsinline=1&rel=0&autoplay=1&origin=<encodeURIComponent(window.location.origin)>
```

The id is the only variable part and comes from the `video` operation, which already proved the video belongs to the bound channel. `modestbranding` is not sent (deprecated, no effect). `controls` is left at its default, so the native controls are always present. The iframe carries `title`, `allow="autoplay; encrypted-media; picture-in-picture; fullscreen"`, `allowFullScreen` and `referrerPolicy="strict-origin-when-cross-origin"`.

**Messaging rules (OD-8).**

- Commands go out with `iframe.contentWindow.postMessage(json, YOUTUBE_EMBED_ORIGIN)`. The target origin is that constant, never `"*"`.
- An incoming message is used only when `event.origin === YOUTUBE_EMBED_ORIGIN` **and** `event.source === iframe.contentWindow`. Its `data` is parsed defensively by `parsePlayerMessage`; anything that is not the expected shape is ignored. Only these fields are read: player state, volume, muted, playback rate, available playback rates and the current quality label. No field is rendered as HTML.
- The listener is added when the iframe mounts and removed when it unmounts.
- **Handshake — unverified, proven by a spike before the component is built.** The raw format is not documented, so this specification does not assert it. The expectation, from how Google's own wrapper behaves, is that the embed stays silent until the parent posts a `listening` event to it after `load`, and then reports its state. Plan step 2.0 proves on a real embed which message starts the reports and which fields they carry, and records the captured shapes in `domain/player.test.ts` as fixtures. If no reliable handshake exists, the playback group of the toolbar is not built and the player ships with native controls plus the size, fullscreen and open-on-YouTube controls; that outcome is reported to Waleed under OD-8.
- **Degradation.** If no valid player message arrives within 3 seconds of the iframe's `load` event, the custom toolbar's playback group is hidden and a one-line note says to use the controls inside the player. Size, fullscreen and "Open on YouTube" keep working because they do not depend on messages.

**Toolbar.** Rendered in a `role="toolbar"` row **below** the player, never over it.

| Control | Mechanism |
| --- | --- |
| Play / Pause / Stop | `playVideo`, `pauseVideo`, `stopVideo`. Stop also unmounts the iframe and returns to the poster, which ends the connection to YouTube |
| Mute / Unmute, volume slider 0–100 | `mute`, `unMute`, `setVolume` |
| Speed | `setPlaybackRate`. Options start as 0.25×, 0.5×, 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2× and are narrowed to the rates the player reports for this video once known; the shown value follows the player's own report |
| Quality | **No selector** (OD-7). A hint reads "Change quality from the gear menu in the player", with the current quality label when the player reports one |
| Size: Compact | Default. Player fills the drawer's content width at 16:9 |
| Size: Theater | The drawer widens to `sm:max-w-[min(96vw,1200px)]`; the player grows with it. The same iframe element stays mounted, so playback continues |
| Size: Mini | The player shrinks to 356 × 200 px and becomes `sticky top-0` inside the drawer's scroll container, so it stays in view while the creator scrolls the details. Never below 200 × 200 px. It is not moved to a portal: reparenting an iframe reloads it, and the drawer's transform would capture a `position: fixed` child |
| Fullscreen | `requestFullscreen()` on the wrapper that holds the iframe and the toolbar; a rejected promise is caught and the button is hidden when `document.fullscreenEnabled` is false |
| Open on YouTube / Pop-out | A link, and `window.open(url, "_blank", "noopener,noreferrer,width=960,height=600")`, both to `buildYouTubeWatchUrl(id)`, never to a string taken from a message |

**Private and unfinished videos.** For `privacy_status === "private"` a notice is shown on the poster and stays under the player: "This video is private. It plays here only if this browser is signed in to the Google account that owns it. Otherwise open it on YouTube." When `upload_status` is not `processed`, a note says YouTube may still be processing the video. Neither state is detected from the player; both come from the `video` operation.

**Lifecycle.** One player at most. It is unmounted when the drawer closes, when the selected video changes and when the account changes, so nothing keeps playing out of sight.

**CSP (`D-P7-1`).** Both `nginx.conf` and `public/_headers` gain `frame-src 'self' https://www.youtube-nocookie.com;` so existing same-origin frames stay permitted alongside the YouTube privacy-enhanced embed host, and nothing else changes in the policy. `cspRegression.test.ts` gains: the `frame-src` segment equals `'self' https://www.youtube-nocookie.com` in both files, the two files' policies are identical, and the existing no-wildcard rule still passes.

**Disclosure.** "When you press Play on a video in Postora, your browser loads YouTube's embedded player from youtube-nocookie.com. Google receives the request directly from your browser under YouTube's Terms of Service and Google's Privacy Policy. Postora does not receive or store playback data."

**i18n** (namespace `accounts`): `youtubeManagement.player.*`.

**Tests.** `player.test.ts`: id pattern (10 and 12 characters, a slash, a query string and an empty value are refused), the exact URL, `parsePlayerMessage` on valid, non-JSON, wrong-shape and oversized input. Component: no iframe before Play; the iframe `src` after Play; a message from another origin and one from another window are ignored; a command's target origin is the constant; the toolbar hides after 3 s of silence; Stop, drawer close and video change each remove the iframe; the mini size is at least 200 × 200; the private notice; Arabic rendering with the toolbar in RTL and its numeric values (speed, volume) kept left-to-right.

#### 14.1.3 `/youtube` drawer — "Edit video details" toggle and close on save

`YouTubeVideoEditCard.tsx` only.

- The button toggles. Closed → `openEditor()` as today (fresh draft, snapshot read). Open → `setEditing(false)` with no save and no request; the draft is discarded and the next open starts from a new snapshot. The button carries `aria-expanded` and `aria-controls`, and is disabled while `saving` so an editor cannot be closed over a write in flight.
- A save whose outcome is `"saved"` calls `setEditing(false)`. Every other outcome (`edit_conflict`, `rate_limited`, `refused`, `outcome_unknown`) leaves the editor open with the draft intact.
- The outcome line moves **out of** the `editing` block to directly under the button row, keeping `role="status"`. Today it is rendered inside the block, so closing the editor would hide the confirmation. It is cleared when the editor is opened again and when the video changes, as now.
- The post-write revision handling and the dirty-field rules are unchanged.

**Tests.** Second click closes with zero `onSave` calls; reopening calls `onSnapshot` again; `"saved"` closes the form and "Current details match your changes." is in the document; `edit_conflict` keeps the form open; the button is disabled while saving; `aria-expanded` follows the state.

#### 14.1.4 `/youtube` drawer — rich thumbnail dialog and small preview

**Invariant kept.** `set_thumbnail` still takes `{ account_id, video_id, media_file_id }` and nothing else. The server still loads the row by `id` and `user_id`, requires `image/jpeg` or `image/png`, downloads at most 2 MB from Postora's own storage and checks the magic bytes (§8.2). No URL reaches the server. **`youtube-resources` is not modified by this item.** Every tab below ends by producing an owned `media_files` row; the confirmation step and the single write are the ones Phase 4B shipped.

**Contracts (frontend only).**

```ts
// domain/thumbnail.ts
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
export interface YouTubeThumbnailCandidate {
  id: string; file_name: string; mime_type: string; file_type: string; file_size: number | null;
  preview_url: string | null;                    // new; display only
}
export function sniffThumbnailType(head: Uint8Array): "image/jpeg" | "image/png" | null;
export function checkThumbnailFile(input: { declaredType: string; size: number; head: Uint8Array }):
  { ok: true; mimeType: "image/jpeg" | "image/png" } | { ok: false; reason: "not_jpeg_png" | "too_large" | "type_mismatch" };

// application/ports.ts
export interface YouTubeThumbnailMediaGateway {
  listOwnedImages(params: { userId: string }): Promise<YouTubeThumbnailCandidate[]>;
  uploadOwnedImage(params: { blob: Blob; fileName: string; mimeType: "image/jpeg" | "image/png" }):
    Promise<YouTubeThumbnailCandidate>;          // new
}
export interface YouTubeThumbnailAiGateway {     // new
  generate(params: { prompt: string; referenceImage?: string; signal?: AbortSignal }): Promise<{ imageUrl: string }>;
}
```

- `checkThumbnailFile` mirrors the server's rule so a bad file is refused before any upload; the server stays the authority.
- `uploadOwnedImage` (in `infrastructure/supabaseYouTubeThumbnailMediaGateway.ts`, `D-P7-2`) takes the user id from the session, never from a parameter; generates a deterministic client UUID `id = crypto.randomUUID()` and storage path `{userId}/{id}.{ext}` per upload attempt; uploads to bucket `media` under `{userId}/{id}.{ext}`; inserts the `media_files` row with `id`, `user_id`, `file_path`, `file_type: "image"`, the verified `mime_type`, `storage_bucket: "media"`, `file_size` and the original file name in `metadata`; and returns the candidate. If the row insert throws or returns an error after the object was stored (including a lost response where the insert may have succeeded), the gateway checks whether the row with `id` and `user_id` exists in `media_files`: if found, it returns that candidate without deleting the stored object; only when the row is confirmed absent does it remove the stored object and fail. It reuses the row shape and path convention of the app's existing library upload (plan step 0 names it), so the file also appears in the media library.
- **Tenancy.** These are browser writes under the creator's own JWT, so storage and table RLS are the enforcement. Plan step 0 verifies that the `media` bucket's insert policy confines a user to their own `{auth.uid()}/` prefix and that `media_files` insert requires `user_id = auth.uid()`. If either is missing, the item stops and a card goes to Waleed; it is not papered over in the client.
- `preview_url` is resolved by the gateway the way `MediaLibrary.tsx` resolves a library file's URL (`libraryFilePublicUrl` in `src/pages/media-library/utils.ts`). It is used only as an `<img src>`, is never sent to an Edge Function, and `null` renders a placeholder.

**Small preview.** Beside the "Change thumbnail" button: a 96 px wide 16:9 image of the video's current `thumbnail_url`. After an `applied` outcome it shows the applied candidate's `preview_url` with the caption "YouTube may take a few minutes to show the new thumbnail" until the `video` query's refetch returns.

**Dialog (`YouTubeThumbnailChange.tsx`, replacing the radio list).** A `Dialog` with three tabs, `dir` set from the locale:

1. **Upload file.** A file input accepting JPEG and PNG. The first bytes are read and `checkThumbnailFile` runs; a refusal shows its reason and uploads nothing. A pass calls `uploadOwnedImage` and selects the returned candidate.
2. **Media library.** The owned JPEG and PNG candidates as image cards (preview, file name, size), single selection, with the existing loading, empty, error-and-retry and "some images were excluded" states.
3. **Generate with AI.** The flow of `/post`: `ResolvedModelCards`, a prompt textarea, up to five reference images from device upload, `MediaLibraryPicker` or `StockMediaPicker`, then `YouTubeThumbnailAiGateway.generate`, which sends the same `generate-image` request `/post` sends today (`prompt`, `aspectRatio: "16:9"`, the first reference image, `async: true`). `generate-image` is not changed. Choosing a result **materialises** it: the image is fetched in the browser, drawn to a 1280 × 720 canvas (cover fit), encoded as JPEG at decreasing quality (0.9 down to 0.5) until it is at most 2 MB, checked with `checkThumbnailFile`, then stored through `uploadOwnedImage`. If the image cannot be fetched, decoded or brought under 2 MB, the message is "This image could not be prepared as a thumbnail" and nothing is stored or sent. AI errors go through `handleAIError`; generation counts against the creator's existing AI image limits.

Whichever tab produced it, the selected candidate goes to the existing confirmation ("This replaces the thumbnail viewers see on YouTube"), and Confirm calls `onSetThumbnail(candidate.id)` once. Stock photos are reference images for the AI tab only; a stock image is never sent to YouTube directly.

**Layering.** `ui/` files receive both gateways as props from the composition root (`YouTubeManagementScreen.tsx`), which stays the only `ui/` file importing `infrastructure`. The shared pickers are imported from `@/components/…` the way `YouTubeCategorySelect` already is. `tests/architecture.test.ts` must stay green.

**i18n** (namespace `accounts`): `youtubeManagement.thumbnail.dialog.*`.

**Tests.** `thumbnail.test.ts`: signatures, 2 MB boundary (2,097,152 accepted, 2,097,153 refused), a PNG labelled JPEG is `type_mismatch`, WebP and GIF refused. Gateway: path starts with the session user id; the row shape; cleanup when the insert fails. Component: each tab ends with `onSetThumbnail` called once with a media id and never with a URL; an oversize upload makes no gateway call; the AI path that cannot reach 2 MB stores nothing; preview fallback; the confirmation still gates the write.

#### 14.1.5 `/youtube` drawer — "Show caption tracks" error reporting

**Two causes, stated at their evidence level.**

1. **Hypothesis, to be verified first:** production `youtube-resources` may be older than `main` and answer `400 invalid_request` to `operation: "captions"`. The first plan step compares the SHA256 of every deployed `youtube-resources` and imported `_shared` file with `git show origin/main:<path>`. If they differ, redeploying is the fix for that cause. If they match, this cause is ruled out and the report says so.
2. **Proven from the code:** `YouTubeCaptionsSection.tsx` `loadTracks` uses a bare `catch {}` and always shows "Postora could not read the caption tracks of this video.", so a creator cannot tell a missing permission from a spent allowance.

**Fix.** `domain/captions.ts` gains a pure mapper beside `captionOutcomeFromErrorCode`:

```ts
export type CaptionListFailure =
  | "missing_scope" | "reconnect_required" | "rate_limited" | "quota_exceeded"
  | "not_found" | "unavailable" | "retryable" | "failed";
export function captionListFailureFromErrorCode(code: string | null | undefined): CaptionListFailure;
```

| Server code | Failure | Message (English default) | Retry button |
| --- | --- | --- | --- |
| `missing_scope` | `missing_scope` | "Reconnect this channel and allow Postora to manage your YouTube account to read captions." | No; link to reconnect |
| `reconnect_required` | `reconnect_required` | "This channel needs to be reconnected before captions can be read." | No; link to reconnect |
| `rate_limited` | `rate_limited` | "You have reached today's limit for reading caption tracks. Try again in {{time}}." (generic wording when no wait is given) | No |
| `quota_exceeded` | `quota_exceeded` | "Postora's YouTube quota for today is used up. Try again tomorrow." | No |
| `not_found` | `not_found` | "This video is no longer on the connected channel." | No |
| `write_not_enabled`, `provider_unsupported`, `invalid_request` | `unavailable` | "Captions are not available for this channel right now." | No |
| `upstream_unavailable` | `retryable` | "YouTube did not answer. Try again." | **Yes** |
| anything else, or not a `YouTubeResourceError` | `failed` | Today's generic sentence | No |

Retry is offered for `retryable` only, because a list costs 50 units and one of ten daily reads; repeating a refusal that cannot change wastes both. `loadTracks` reads `error.code` and `error.retryAfterSeconds` from the `YouTubeResourceError` the screen already rethrows; a failed read still never looks like an empty list.

**i18n** (namespace `accounts`): `youtubeManagement.captions.listError.*`.

**Tests.** `captions.test.ts`: one case per row; `invalid_request` maps to `unavailable`, not to a retry. Component: each failure renders its own message; Retry appears only for `upstream_unavailable`; the wait is shown for `rate_limited`.

### 14.2 Phase 7A — `PR-16`: segment-timed transcription, `.srt`/`.vtt` builder, auto-timed chapters

This is follow-up 2A.2 named in OD-5. **Precondition: OD-12.**

**`transcribe-media`.** The function becomes `index.ts` (adapter: CORS, authentication, body parsing, response) plus a new `handler.ts` holding the tier logic, moved without behaviour change (§12). The request (`mediaUrl`, optional `model`) and today's response fields are unchanged; one field is added:

```ts
{ success: true, transcript: string, language: string, duration: number,
  modelUsed: string, tierUsed: string,
  segments?: Array<{ start: number; end: number; text: string }> }   // new; seconds
```

- The OpenAI tier already sends `response_format: "verbose_json"`; it additionally sends `timestamp_granularities[]=segment` and reads `segments[].start`, `.end`, `.text`. The plan's reference check confirms which configured models accept that parameter; a model that does not is called exactly as today and yields no segments.
- A tier that returns no times (Gemini today) yields **no** `segments` key. Times are never estimated from text length.
- **Validation before returning.** Segments are kept only if every one has finite `0 <= start < end`, starts are non-decreasing, `end <= duration + 1` when the duration is known, and the trimmed text is 1–500 characters; at most 5,000 segments. If any check fails the whole array is dropped (the transcript is still returned). A partly trusted timeline is worse than none.
- **Sanitized logging (`D-P7-3`).** Neither the transcript, the segments, nor the `mediaUrl` (which may be a signed URL containing a token query string) may appear in any log line added or moved into `handler.ts`; provider failures log only the tier identifier, HTTP status, and a stable error code.
- An old client ignores the new key; a new client treats a missing key as "timing unavailable".

**Pure formatters — `supabase/functions/_shared/youtubeTranscriptFormats.ts`** (new), imported by the frontend the way `youtubeChapters.ts` is:

```ts
export interface TranscriptSegment { start: number; end: number; text: string }
export function segmentsToSrt(segments: TranscriptSegment[]): string;
export function segmentsToVtt(segments: TranscriptSegment[]): string;
export function segmentsToTimedOutline(segments: TranscriptSegment[], maxChars?: number): string; // default 8000
```

- **SRT:** cues numbered from 1, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, blank line between cues, CRLF-free `\n` line ends. **VTT:** first line `WEBVTT`, then `HH:MM:SS.mmm --> HH:MM:SS.mmm` cues. In both, cue text has NUL removed, any `-->` replaced, and line breaks collapsed to spaces; an empty input yields `""`.
- Both outputs must pass `validateCaptionUploadInput` (the Phase 6A validator) for the same segments; a test asserts it, including Arabic text. A result over 512 KiB is not truncated by the formatter; the caller reports it through the validator's `caption_invalid`.
- **Timed outline:** lines `MM:SS text` (or `H:MM:SS` from one hour), times floored to whole seconds, built by grouping segments into windows of at least 30 seconds, one line per window. Widening windows alone cannot make a long transcript fit, because the spoken text stays the same length, so **each line's text is also cut** at a word boundary: the per-line limit starts at 160 characters and the window starts at 30 seconds; while the outline is longer than `maxChars` the window doubles (up to 10 minutes) and then the per-line limit halves (down to 24 characters). The outline is a list of timed cues for the chapter model, not a transcript. **The first line is always `00:00`.** That makes the outline a legal input for `youtube_chapters` in `"provided"` mode: it fits the 8,000-character cap, and because the server's time-subset rule only allows times that appear in the input, a chapter list starting at `00:00` is reachable.

**UI (`YouTubeAISuggestions.tsx`, `type: "chapters"`).** A button, "Extract chapters and subtitles from the video's audio", enabled only when `videoSourceUrl` is an `https:` URL the function can fetch; a local `blob:` preview of a file that has not been uploaded yet keeps it disabled with the hint "Available after the video is uploaded". It is an explicit click because transcription spends the creator's AI allowance. It calls the existing `useTranscription` hook (which gains `segments`), then:

- with segments: fills the outline box with `segmentsToTimedOutline`, sets timing to `"provided"`, and offers "Download .srt" and "Download .vtt" (a `Blob` and a revoked object URL, no network call). Chapters are then generated, previewed and inserted by the unchanged Phase 2A flow;
- without segments: shows "This transcription has no timing, so chapters and subtitles cannot be built from it" and changes nothing.

**i18n** (namespace `postsettings`, `src/i18n/locales/ar/postsettings.json`): `youtubeAI.chapters.fromAudio.*`.

**Tests.** Deno: formatter cases (ordering, hour rollover, `-->` in text, Arabic, empty input, validator round-trip, outline under 8,000 characters for a three-hour fixture, first line `00:00`, a chapters fixture built from the outline passes `parseChapterLines` and the subset rule); `handler.test.ts` (new) for segments present, absent on the no-timing tier, dropped when out of order or past the duration, and unchanged legacy fields. Vitest: button disabled without a URL; the two branches above; downloads make no gateway call.

### 14.3 Phase 7B — `PR-17`: upload-time captions and the `captions.insert` follow-up

**Precondition: OD-9; OD-6's ceiling.** Read on 27 November 2026: `captions.insert` costs 400 units, is authorised by `youtube.force-ssl`, and uploads to `https://www.googleapis.com/upload/youtube/v3/captions`.

**Rollout rule.** Until `process-post` with this follow-up is deployed and smoke-tested, the UI neither shows the section nor emits `youtube_caption`. An older `process-post` ignores the key silently, and a creator would believe subtitles were attached. The plan therefore delivers `PR-17` as two pull requests, PR-17A (backend) and PR-17B (UI), the way Phase 3A was split.

**Shared validator.** `youtube-resources/captionFile.ts` moves to `supabase/functions/_shared/captionFile.ts` with its tests; the old path becomes a re-export so `youtube-resources` is byte-for-byte unchanged in behaviour. `validateCaptionUploadInput`, `CAPTION_CONTENT_MAX_BYTES` (512 KiB, UTF-8 bytes), `CAPTION_LANGUAGE_PATTERN` and `CAPTION_NAME_MAX_LENGTH` have one definition.

**Metadata key** (all three `PlatformMetadata` copies — `process-post/index.ts`, `n8n-api/index.ts`, `_shared/platforms/types.ts` — per `ARCHITECTURE.md` "Known live violation"; no fourth copy):

```ts
youtube_caption?: { language: string; name: string; format: "srt" | "vtt"; content: string } | null;
```

`undefined` and `null` mean no caption and leave the publish path byte-identical. Any other value is a request; one that fails validation is never sent to Google.

**Guards on the stored text (`OD-9`, `D-P7-4`, `D-P7-5`).**

- The public n8n API does not accept the key on create and strips `youtube_caption.content` from every post it returns.
- Evidence, logs, error messages and the history views never contain `content`. Evidence records the language, the format and the byte length only.
- When the post settles across any terminal settlement path (`completed`, `partial`, `failed`), `content` is scrubbed from the stored `posts.metadata.youtube_caption` object via a pure helper (`scrubSettledYoutubeCaptionMetadata`), leaving `{ language, name, format }`.
- `content` is plain text. It is never rendered as HTML anywhere.

**Follow-up (`process-post/youtubeUploadFollowUps.ts`).** `YoutubeFollowUpRequest` gains `caption: { language; name; format; content } | null`; `YoutubeFollowUpResults` gains `caption: YoutubeFollowUpOutcome`. Order becomes thumbnail, first comment, playlist, **caption**, so the three existing follow-ups keep their place and their share of the worker's time. `uploadYoutubeCaption`:

1. `validateCaptionUploadInput` — free. Invalid → `skipped / invalid_caption`.
1a. Scope (`D-P7-4`) — free. `captions.insert` requires `youtube.force-ssl` in the account's `granted_scopes`. When `hasCaptionScope()` returns `false` (i.e. `youtube.force-ssl` is not explicitly present in `granted_scopes`), the result is `skipped / missing_scope` with zero counter and budget calls: an unverified or missing scope must never spend the creator's daily upload or 400 project units. The answer arrives through `hasCaptionScope(): boolean`, computed by the caller from the account row it already loaded.
2. `budgetMs() <= 0` → `skipped / no_time`.
3. `canWrite()` false → `skipped / authority_lost`.
4. Per-user allowance: the **same** counter Phase 6A uses, `youtube-resources:caption-upload:day` (2 per 24 h), through the strict parser. Refused or unreadable → `skipped / rate_limited`. A creator therefore gets two caption uploads a day in total, whichever screen they use; without this one account could drain the project budget from Create Post.
5. Project write budget: debit **400** in one `check_weighted_rate_limit` call. Refused or unreadable → `skipped / quota_budget`.
6. `canWrite()` again, then one multipart `POST …/upload/youtube/v3/captions?part=snippet&uploadType=multipart` with `{ snippet: { videoId, language, name, isDraft: false } }` and the file part, `AbortSignal.timeout(min(budgetMs, 60 s))`.
7. 2xx → `applied`. 409 → `failed / conflict`. Other non-2xx → `failed / refused`, logging only the HTTP status and stable error code (never raw provider text that could echo caption content, `D-P7-4`). Thrown or timed out → `unknown / answer_lost`.

No ownership read is needed: the video id is the one this run just created on `request.channelId`. The insert is **sent once and never retried**. It runs only in the run that created the video and can never fail the publish or erase the upload receipt.

**Dependencies.** `YoutubeFollowUpDeps.debitWriteBudget` changes from `() => Promise<boolean>` to `(units: number) => Promise<boolean>`; the playlist step passes 50 and the caption step 400. A new dep, `checkCaptionUploadAllowance(): Promise<boolean>`, is implemented with the strict counter helper, which moves from `youtube-resources/writeLimits.ts` to `_shared/youtubeWriteCounters.ts` (re-exported at the old path, keys and limits unchanged) so `process-post` does not import another function's folder.

**Evidence.** `youtubePublishEvidence.ts` adds `caption: YoutubeFollowUpEvidence` (`not_requested` when the key is absent, which covers every older row); `n8n-api/youtubeEvidenceView.ts` and every `src/` renderer of publish evidence show it beside thumbnail, first comment and playlist.

**UI (`YouTubeSettings.tsx`, `usePlatformSettings.tsx`, `CreatePost.tsx`).** A "Subtitles / CC" section: a file input (`.srt`, `.vtt`) or "Use subtitles from the audio" (PR-16's generated file, when present), a language select, a track name (0–150 characters), the file size against the 512 KB limit, and the note "Counts as one of your two caption uploads per day. Added after the video is uploaded." Validation runs in the browser with the shared validator before the value is stored. The section is disabled with the existing mismatch pattern for Composio accounts and when the selected native account lacks the `manage_captions` capability, and the key is then not sent. When no caption is chosen the key is **omitted**. Rehydration restores language, name and format; if `content` was already removed (a settled post reopened), the section shows the track as "already submitted" and offers a new file.

**Disclosure (OD-3).** The legal pages, their test and the guide add that a caption file the creator attaches to a new upload is sent to YouTube after the upload under `youtube.force-ssl`.

**Tests.** `captionFile` suite green at its new path and through the re-export. `youtubeUploadFollowUps.test.ts`: every numbered branch; an invalid caption makes zero counter, budget and provider calls; a refused allowance makes zero budget and provider calls; the debit is called once with 400; exactly one request on timeout; a caption failure leaves the other three outcomes intact; order preserved; the playlist step still debits 50 through the new signature. `youtubePublishEvidence.test.ts` and the n8n view with and without the key. A **log-capture test** with a marker in the caption text across success, refusal and thrown paths. `n8n-api`: the key is rejected on create and absent on read. A settlement test: `content` is gone from the stored metadata, the other three fields remain. Component and rehydration tests: omitted key, Composio disabled, byte-limit refusal, autofill from PR-16.

### 14.4 Phase 7C — `PR-18`: inline "+ New playlist"

**Precondition: OD-10.**

```ts
// request (youtube-resources)
{ operation: "create_playlist", account_id: string,
  title: string,             // 1..150 characters after trim, no "<" or ">", no line breaks
  description?: string,      // 0..5000 UTF-8 bytes, no "<" or ">"
  privacy_status: "public" | "unlisted" | "private" }

// success data
{ playlist: YouTubePlaylistListItem }
```

- `YOUTUBE_RESOURCE_QUOTA_POLICY.unit_costs.playlist_create: 50`. The title and description limits are the brief's; Google's reference page states neither, so a provider `400` is mapped to `invalid_request` through the existing classifier.
- `YouTubeAccountCapabilities.capabilities` gains an additive optional `manage_playlists?`, derived like `manage_captions`: reconnect → `reconnect_required`; Composio → `provider_unsupported`; available with `youtube.readonly` **and** `youtube.force-ssl`; a recorded scope list without them → `missing_scope`; otherwise `unknown`. `youtube.upload` does not authorise this call (OD-10).
- The schema is `.strict()`; `requestedOperationOf` learns the literal; the body still arrives through `readJsonBodyCapped`.

**Sequence — `youtube-resources/playlistWriteComposition.ts`** (new), behind a `YouTubePlaylistWritePort` so `index.ts` stays an adapter:

1. Authenticate; load the account by `id` and owner; `admit()`.
2. `manage_playlists` must be `available`, else the capability's reason.
3. Validate the three fields — free.
4. `checkPlaylistCreateCounter` (`youtube-resources:playlist-create:day`, **5 per 24 h** per user, strict parser, in `writeLimits.ts`). Refused → `rate_limited` with `retry_after_seconds`; unreadable → `upstream_unavailable`.
5. `debitWriteBudget(50)` on the project write bucket (§10). Refused or unreadable → `quota_exceeded`.
6. `stillBound` (the Phase 4A re-read).
7. One `POST https://www.googleapis.com/youtube/v3/playlists?part=snippet,status` with `{ snippet: { title, description }, status: { privacyStatus } }` and a 15 s timeout.
8. 2xx whose body parses, has an id matching `YOUTUBE_PLAYLIST_ID_PATTERN` and has `snippet.channelId` equal to the bound channel → success. A 2xx that fails any of those, a thrown fetch or a timeout → `outcome_unknown`. 401 → `reconnect_required`; 403 → the existing classifier; other non-2xx → its typed code. **Never retried**: a second call creates a second playlist.

No ownership pre-read is needed, because nothing existing is modified and `stillBound` ties the token to the channel; the answer's `channelId` is checked instead. The counter counts attempts, including refused ones.

**UI (`YouTubeSettings.tsx`, `src/hooks/useYouTubePlaylists.ts`, `D-P7-6`).** A "+ New playlist" entry in the selector opens a dialog (title, description, privacy with no default selected). On success the hook's query is refetched and the new id is selected. On `outcome_unknown` the dialog closes, the list is refetched and a notice says "YouTube may have created the playlist. Check the list before trying again."; nothing is auto-selected and no automatic retry ever runs. The entry is hidden under the same conditions that disable the selector (Composio, more than one distinct native channel) and enabled **only when `manage_playlists?.state === "available"`** (when `manage_playlists` is absent on an older backend response or not `"available"`, playlist creation is disabled with its reason). The gateway port gains `createPlaylist?`.

**Disclosure.** `/google-api-disclosure`, `/privacy`, `/terms`, `YouTubeLegalDisclosures.test.tsx` and the guide: Postora can create a playlist on the owner's instruction; it still does not rename, reorder or delete playlists or remove items. The pinned sentence in the legal test changes with it.

**Tests.** `contracts.test.ts`, `capabilities.test.ts` (full derivation table, `upload` alone is not enough); composition tests for each numbered step proving no later call after a refusal, zero budget debit on a validation or counter refusal, one `POST` on timeout, a 2xx naming another channel is `outcome_unknown`; `handler.test.ts` (strict schema, admission shared, `retry_after_seconds`); `writeLimits.test.ts`; hook and dialog tests (refetch, select, unknown outcome selects nothing, hidden for two channels); the legal test.

### 14.5 Phase 7D — `PR-19`: AI title and thumbnail packaging score

No Google call. The model sees text only: **no image is sent**. The creator may describe the thumbnail in words.

**Pure rules — `supabase/functions/_shared/youtubePackagingScore.ts`** (new), shared with the frontend:

```ts
export interface PackagingScore {
  overall_score: number;                       // integer 0..100, computed, never taken from the model
  breakdown: { hook: number; clarity: number; mobile_length: number; thumbnail_synergy: number | null };
  strengths: string[];                         // 0..3, each 1..140 characters
  fixes: string[];                             // 0..3, each 1..140 characters
  better_titles: [string, string, string];
}
export function scoreMobileLength(title: string): number;
export function validatePackagingModelOutput(raw: unknown, input: { title: string; hasThumbnailText: boolean }):
  { ok: true; value: PackagingScore } | { ok: false; reason: "bad_shape" | "bad_score" | "bad_title" | "bad_text" };
```

- `mobile_length` is deterministic (full marks up to 60 characters, falling to zero at 100) and is computed by the server, not asked of the model.
- `hook` and `clarity` come from the model and must be integers 0–100. When `hasThumbnailText` is `true` (`thumbnail_text` non-empty after trim), `thumbnail_synergy` from the model **must** be an integer 0–100 (missing or non-integer fails validation with `bad_score` → `422 score_invalid`, `D-P7-7`). When `hasThumbnailText` is `false`, `thumbnail_synergy` is forced to `null` whatever the model returned.
- `overall_score` is the rounded weighted mean — hook 35, clarity 30, mobile length 15, thumbnail synergy 20 — with the weights rescaled over the parts that are present (sum 100 when synergy is present; sum 80 rescaled to 100 when synergy is `null`).
- Each `better_titles` entry must be 1–100 characters, single-line, free of `<` and `>`, and different from the input title and from each other. Strings in `strengths` and `fixes` have control characters stripped. Any failure is a refusal; nothing partial is returned.

**Request** — `generate-caption` gains `requestType: "youtube_title_thumbnail_score"`:

```ts
{ requestType: "youtube_title_thumbnail_score", platform: "youtube", language: "english" | "arabic",
  context: JSON.stringify({ title: string /* 1..100 */, thumbnail_text?: string /* ≤ 300 */, description?: string /* ≤ 1000 */ }) }
```

**Response** — `{ score: PackagingScore }`, or `422 { error: "score_invalid" }`. Budget: 2,048 tokens, temperature 0.4 (the JSON answer with three titles and six short strings does not fit the helper's 1,024 default in Arabic). It runs on the sanitized pipeline (`invokeYouTubeAi`, `logYouTubeAiSuccess`, `logYouTubeAiFailure`): only the stable class, the request id, the model and tier identifiers and the numeric scores may be logged; no title, thumbnail text, description, model output or provider body. All three inputs are hostile text inside a delimited block.

**UI — `src/components/post/settings/YouTubePackagingScoreCard.tsx`** (new). A presentational card with an injected `requestScore(input)`; it does not import Supabase. It shows the overall score, the four bars (the synergy bar reads "Describe your thumbnail to score this" when `null`), strengths, fixes and three titles, each with "Use this title". The score is advice, labelled "AI estimate, not a YouTube metric".

- In `YouTubeSettings.tsx`: under the title field; "Use this title" calls `onSettingsChange({ title })`.
- In the `/youtube` drawer: inside the open editor; "Use this title" fills the draft title and marks it dirty. It never saves. `requestScore` reaches the drawer from the composition root through a new `YouTubePackagingScoreGateway` port.

**i18n**: `postsettings` `youtubeAI.score.*`; `accounts` `youtubeManagement.score.*`.

**Tests.** Deno: every validator branch, the weight rescale with and without synergy, missing/non-integer `thumbnail_synergy` when `hasThumbnailText` is `true` refused (`D-P7-7`), `scoreMobileLength` boundaries, duplicate and over-long titles refused; handler branch (valid, invalid output → 422, hostile fixture cannot change the contract, auth, rate limit); a **log-capture test** with four markers (in the title, the thumbnail text, the description, and the provider's failure body). Vitest: card states, the `null` synergy bar, "Use this title" in both hosts, no save triggered in the drawer, AI errors through `handleAIError`.

### 14.6 Phase 7E — `PR-20`: privacy editing of a published video

**Precondition: OD-11.**

**What exists.** `UpdateVideoRequest` (`handler.ts`) accepts `changes.privacy_status` and `privacy_confirmation: { to }`. In `editComposition.ts` `update`, after the snapshot read and the revision check, `validateEditChanges` refuses a privacy change on a snapshot whose `restrictions.scheduleProtected` is true, and a missing or mismatched confirmation is refused, both as `invalid_request` and both **before** `authorizeWrite`. `planEditUpdate` writes `status.privacyStatus`; `verifyEditResult` fails as `outcome_unknown` when the re-read privacy differs. `editEnvelope` in `handler.ts` already returns `restrictions: { scheduleProtected: boolean }` inside `data`, and the frontend port's `updateVideo` already carries `privacy_status` and `privacyConfirmation`.

**Server & Gateway work (`D-P7-8`).**

- Tests that pin the order, in `editLifecycle.test.ts` and `editComposition.guard.test.ts`: a privacy change on a schedule-protected video, a missing confirmation and a confirmation naming a different value each end as `invalid_request` with **zero** per-user counter calls, zero budget debits, zero catalog reads and zero provider writes; a confirmed change writes once and returns the verified re-read; a re-read showing another privacy is `outcome_unknown`.
- Expose `restrictions?: { scheduleProtected: boolean }` on the frontend `YouTubeEditSnapshot` port (`src/features/youtube-management/application/ports.ts`) and map `data.restrictions` in `supabaseYouTubeResourcesGateway.ts` `getEditSnapshot`. No server envelope change is required because `editEnvelope` already returns `restrictions.scheduleProtected`.
- A scheduled video (`status.publishAt` set) keeps its privacy protected: changing it would cancel or pre-empt the schedule, which is outside this phase.

**UI (`YouTubeVideoEditCard.tsx`, `YouTubeManagementScreen.tsx`).**

- A Privacy select (Public, Unlisted, Private) in the editor, seeded from the snapshot's `privacyStatus`. It is disabled, with the reason "This video is scheduled on YouTube. Its privacy changes at the scheduled time.", whenever `snapshot.restrictions?.scheduleProtected !== false` (fail-closed if `restrictions` is absent, `D-P7-8`), and disabled without a value when the current privacy is not one of the three.
- When the selected value differs from the snapshot's, a required checkbox appears: "I understand this changes who can see this video on YouTube." For a change **to** Public the label adds "It becomes visible to everyone." **Save** stays disabled until it is ticked. Changing the select again clears the tick.
- `privacy_status` and `privacyConfirmation: { to }` are sent only when the value changed and the box is ticked; an unchanged privacy is omitted from the request, so a title-only save is identical to today's.
- Outcomes, limits and cost are those of §8.1: 53 units per save, the same burst and daily counters, one write, `outcome_unknown` on a lost answer.

**Disclosure.** `/google-api-disclosure`, `/privacy`, `/terms`, the legal test and the guide: the editable fields become title, description, tags, category **and privacy**, changed only on the owner's explicit confirmation.

**i18n** (namespace `accounts`): `youtubeManagement.detail.privacy*`.

**Tests.** Server cases above. Component: select seeded from the snapshot; disabled when schedule-protected; Save disabled until the box is ticked; the tick clears when the value changes; an unchanged privacy sends neither field; a changed one sends both with matching values; the Public wording. `e2e/youtube-stage3.spec.ts`: a privacy change in the drawer. The legal test.

### 14.7 Phase 7 non-goals

- No change to `set_thumbnail`, `captions`, `upload_caption` or any other existing `youtube-resources` operation's contract.
- No programmatic quality control, no playlist or autoplay-next inside the embedded player, no playback analytics, no player on any page but the `/youtube` drawer.
- No image is sent to an AI model for scoring; no vision model.
- No playlist rename, reorder or deletion; no removal of playlist items.
- No caption download, replacement, deletion or translation; no captions for Composio-managed accounts.
- No change to a scheduled video's privacy or publish time from the drawer.
- No new option in the public n8n API or the n8n community node.
- No new OAuth scope and no new runtime dependency.
