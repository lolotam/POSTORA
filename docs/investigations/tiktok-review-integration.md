# TikTok review — integration contract

Task 1 deliverable for [the plan](../superpowers/plans/2026-09-30-tiktok-publishing-review-plan.md).
Every "today" claim was traced in this worktree on 2026-09-30. The deployed copies of
`tiktok-demo-publish`, `tiktok-webhook`, `tiktok-check-status`, `process-scheduled-posts`,
`process-post` and `tiktok-oauth` on Contabo were SHA-256 compared with this checkout
(CRLF-normalised) and **match**. This document is the contract the implementation is
judged against. Where it differs from the plan, this document wins, and the plan's
review table records why.

## 1. Provider facts (TikTok docs, fetched 2026-09-30)

- `POST /v2/post/publish/video/init/`: `post_info` = `title` (≤2200 UTF-16 units), `privacy_level` (required, must be one of `creator_info.privacy_level_options`), `disable_comment`, `disable_duet`, `disable_stitch`, `video_cover_timestamp_ms`, `brand_content_toggle`, `brand_organic_toggle`, `is_aigc`. `source_info.source` = `FILE_UPLOAD` | `PULL_FROM_URL`. **There is no scheduling field** — the demo function's `post_info.schedule_time` is not part of the contract. Rate limit is 6 requests/min per token.
- `POST /v2/post/publish/creator_info/query/` → `creator_nickname`, `creator_username`, `creator_avatar_url` (TTL 2h), `privacy_level_options[]`, `comment_disabled`, `duet_disabled`, `stitch_disabled`, `max_video_post_duration_sec`. Blocking errors: `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `reached_active_user_cap`. Rate limit is 20/min.
- `POST /v2/post/publish/status/fetch/` → `status` ∈ `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, `FAILED`; `fail_reason`; `publicaly_available_post_id[]` (sic). Rate limit is 30/min.
- Webhooks are at-least-once and retried for 72 hours; the receiver must answer 200 immediately. Header `TikTok-Signature: t=<ts>,s=<hex>`, HMAC-SHA256(client_secret, `"<t>.<rawBody>"`). No tolerance is specified; we keep 300 s. The envelope is `{client_key, event, create_time, user_openid, content}`, and **`content` is a JSON-encoded string**. Content Posting events: `post.publish.complete` {publish_id, publish_type}, `post.publish.failed` {publish_id, reason, publish_type}, `post.publish.inbox_delivered`, `post.publish.publicly_available` {publish_id, post_id, publish_type}, `post.publish.no_longer_publicaly_available` (sic).
- UX guideline wording is carried over from the existing TikTok settings component. Branded content cannot be `SELF_ONLY`. An **unaudited client can only post `SELF_ONLY`** (`unaudited_client_can_only_post_to_private_accounts`), so Task 8 live evidence uses Only me.

## 2. What exists today (the trace)

**Durable publishing already exists, and we reuse it.** `posts` + `platform_posts` are the job and the attempt:

- Immediate: the browser inserts `posts` with `status='pending'`, `scheduled_at=null`, and `metadata.selected_account_ids` + `metadata.tiktok_*` (`src/pages/CreatePost.tsx:455-486`, `src/hooks/usePlatformSettings.tsx:443-459`). It then invokes `process-post {post_id}` with the user JWT.
- Scheduled: the insert uses `status='scheduled'` with `scheduled_at`. `process-scheduled-posts` (cron) selects `status IN ('pending','scheduled') AND scheduled_at <= now()` and calls `process-post {post_id, expected_scheduled_at}` with the service role.
- `process-post` claims the post with `UPDATE posts SET status='processing' WHERE id=$1 [AND scheduled_at=$2]` (`_shared/postProcessingClaim.ts:34-48`). Zero rows gives 409. **The claim has no status predicate**, so two calls without `expected_scheduled_at` can both claim.
- `postToTikTok` (`process-post/index.ts:6248-6563`) runs the creator_info preflight. **Failures other than an invalid token are logged and ignored.** Privacy defaults to `SELF_ONLY`; `disable_*` is sent only when `allow_*===false`. `tiktok_disclose_content` is ignored. `max_video_post_duration_sec` is logged but never compared. The function always uses `FILE_UPLOAD` and downloads the whole file into memory. The publish_id exists at ~6450 but is **not persisted** until the `platform_posts` insert at ~1718, which comes after upload and up to about 60 s of inline polling.
- A TikTok `platform_posts` row is inserted `status='pending'` with `response_data.tiktok_publish_id`. Background polling (`pollTikTokPublishStatus`, 60×2 s) settles it through `partner_settle_platform_post`; if polling gives up, the row stays pending forever.
- `posts.status` becomes `completed` even while TikTok is still pending (`process-post/index.ts:1816-1824`). The settle RPC recomputes it later.

**Current page** `src/pages/TikTokPublish.tsx` (1203 lines, route `/tiktok-publish` at `AnimatedRoutes.tsx:502-509`, `ProtectedRoute`) talks to `tiktok-demo-publish`. That function drops the duet, stitch, your-brand, branded and AI flags, sets both brand toggles from `disclose`, sends `schedule_time`, uploads base64 in the JSON body, and persists nothing. `useTikTokStatusPolling.tsx` and `TikTokProcessingStatus.tsx` have **no consumers**.

**Security defects found (in scope, fixed by this work):**

| Where | Defect |
| --- | --- |
| `tiktok-check-status/index.ts:20-86,173-208` | No caller authentication. Uses the service role with a body `account_id` (not filtered by `user_id`), or looks up any user's token by `publish_id`. Interpolates `publish_id` into `.or()`. Writes `platform_posts` directly. |
| `tiktok-oauth/index.ts:472-480, 549-604` | Actions `creator_info` and `refresh` do not check the caller owns `account_id`. `refresh` writes tokens. |
| `tiktok-webhook/index.ts:211` | Reads `body.publish_id` at the top level. The real envelope nests it in the `content` string, so **no event has ever matched a post**. No `user_openid` check, no dedupe, and `publicly_available` is not handled. |

**Media duration:** `media_files.metadata.duration` is written only from a Cloudinary result (`cloudinary-upload/index.ts:792`). Cloudinary has been disabled since 2026-09-29, so it is `null` for new uploads.

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Drafts live in new `tiktok_review_drafts`, **not** in `posts`. | A `posts` row is charged by the post-quota trigger, fires `post.scheduled` partner events, and is visible to the scheduler. A draft must be none of those. |
| D2 | Submitting creates an ordinary `posts` row (`source='tiktok_review'`) through one RPC that also writes the submission link and flips the draft, all in one transaction. | Reuses the existing claim, dispatch, settle, history and scheduler. Keeps a single publishing engine (spec §3, option 3). |
| D3 | The RPC builds `posts.metadata.tiktok_*` **from the locked draft row**, not from handler input. | The published snapshot is then exactly the reviewed revision. |
| D4 | Strict TikTok validation lives in pure `_shared/tiktokPublishPolicy.ts`. The review handler calls it before submit. `process-post` calls it **only** for posts whose metadata carries `tiktok_review_submission_id`, and uses `buildTikTokPostInfo` for them. CreatePost's legacy path is untouched. | Stop condition "two modules own one rule": one module owns it, with two callers. It does not change CreatePost behaviour in this release. |
| D5 | Immediate dispatch: after the RPC commits, the handler sets `dispatch_state` from `pending_dispatch` to `dispatching` (compare-and-set) and calls `process-post {post_id, expected_scheduled_at:null}` with the service role inside `EdgeRuntime.waitUntil` (50 s timeout, under the worker ceiling). Completion compare-and-sets from `dispatching` or `publishing`: a 2xx sets `dispatched`; 409 and non-2xx set `needs_attention`; a timeout or throw sets `unknown`. The handler **never re-dispatches**. A repeat `submit` with the same `requestId` returns the existing submission. | No blind retry after an ambiguous outcome (AC7). Returns fast. |
| D6 | Before init, `process-post` claims a review submission in one atomic UPDATE (`dispatching`\|`scheduled` → `publishing`, scoped to id/post/user, only while `provider_publish_id IS NULL`); zero rows → `NEEDS_ATTENTION:ALREADY_DISPATCHED`, no init. Right after a successful init it records `provider_publish_id` (same scoping, only in `publishing`). Publishing uses the submission **snapshot** (caption, media, settings), and a post edited after consent fails with `SNAPSHOT_MISMATCH`. If the worker dies after init, the status reader settles the publish from `provider_publish_id` once the submission is older than 3 minutes. | A History retry or "Publish now" cannot publish twice; the published content is exactly what was approved; an init with no `platform_posts` row is still reconciled. |
| D7 | Scheduling uses the existing scheduler. The due-time claim uses `expected_scheduled_at`. At execution, `process-post`'s strict review branch re-fetches creator info. If the reviewed settings are no longer allowed (privacy not offered, a disabled interaction requested, duration over the maximum, posting blocked), the attempt fails with a `TIKTOK_REVIEW_NEEDS_ATTENTION:<reason>` error and **no init**. The status reader maps that to `needs_attention`. | Spec §7: never silently alter the user's choices. |
| D8 | Duration: use `media_files.metadata.duration` when present, else the browser-measured `mediaDurationSec` saved on the draft. The policy blocks when both are missing. TikTok's `duration_check_failed` is the final authority. | A server-side probe is unavailable (no ffprobe in the edge runtime, Cloudinary disabled). The client value is a UX gate, not a security boundary. |
| D9 | Webhooks: parse `content` and dedupe into a new `tiktok_webhook_events` table (`UNIQUE(event, publish_id, create_time)`). Match by publish_id **and** `social_accounts.platform_user_id = user_openid`. Apply terminal outcomes only to a `pending` row, via `partner_settle_platform_post`; never regress. Unmatched events stay unapplied, and the status reader applies them later. | Covers early arrival, duplicates, disorder and spoofing (AC8). |
| D10 | The status reader (`tiktok-review` `status` action) is owner-scoped. If the row is pending and was last checked more than 15 s ago, it does one bounded `status/fetch` with the owner's token and settles through the RPC. The UI polls it with backoff. `tiktok-check-status` gains owner authentication and a safe filter; it keeps its response shape. | Spec R6: no manual publish-ID entry. Fixes the IDOR. |
| D11 | `tiktok-demo-publish` `publish`/`schedule` return `{success:false, error_code:'deprecated', user_message:'Use the TikTok review workspace.'}`; `status` stays, owner-scoped as today. | The new page replaces its only caller. A stale browser tab gets a clear refusal instead of a bypass. |
| D12 | Review states are `pending_review`, `rejected`, `archived`, `submitted`. The plan's `draft` state is dropped. A `submitted` draft can be **reopened** (`submitted → pending_review`, revision + 1, so consent is invalidated) only when no pending/success TikTok row exists for its latest submission and either no publish id was recorded (`dispatch_state` in `needs_attention`, `dispatched`, or `unknown` older than 10 minutes) or TikTok reported that attempt FAILED. | No transition produced it (YAGNI). A new draft starts in `pending_review` and the queue defaults to it. |
| D13 | FILE_UPLOAD only, via `process-post`'s existing chunked upload. No `PULL_FROM_URL`. | `PULL_FROM_URL` needs a verified domain, which is not configured. |
| D14 | "Send to TikTok inbox" (Brandora popover) is **out of scope**. | Upload/inbox mode is a different endpoint. |

## 4. Schema — `supabase/migrations/20261002150000_tiktok_review_lifecycle.sql`

Additive only. Old UI unaffected.

```sql
tiktok_review_drafts (
  id uuid PK default gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  social_account_id uuid NOT NULL,
  revision int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state text NOT NULL DEFAULT 'pending_review'
    CHECK (state IN ('pending_review','rejected','archived','submitted')),
  caption text NOT NULL DEFAULT '',
  media_file_id uuid NULL,
  media_duration_sec numeric NULL CHECK (media_duration_sec > 0),
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  rejection_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (social_account_id, user_id) REFERENCES social_accounts(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (media_file_id, user_id) REFERENCES media_files(id, user_id) ON DELETE SET NULL (media_file_id)
)
index (user_id, social_account_id, state, updated_at DESC)

tiktok_review_submissions (
  id uuid PK default gen_random_uuid(),
  draft_id uuid NOT NULL, user_id uuid NOT NULL, social_account_id uuid NOT NULL,
  revision int NOT NULL, request_id uuid NOT NULL,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('now','scheduled')),
  scheduled_at timestamptz NULL, time_zone text NOT NULL,
  snapshot jsonb NOT NULL, consented_at timestamptz NOT NULL,
  dispatch_state text NOT NULL CHECK (dispatch_state IN
    ('scheduled','pending_dispatch','dispatching','publishing','dispatched','unknown','needs_attention')),
  provider_publish_id text NULL,
  last_status_check_at timestamptz NULL,
  created_at, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, revision), UNIQUE (user_id, request_id),
  CHECK ((mode = 'scheduled') = (scheduled_at IS NOT NULL)),
  FOREIGN KEY (draft_id, user_id) REFERENCES tiktok_review_drafts(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (social_account_id, user_id) REFERENCES social_accounts(id, user_id) ON DELETE CASCADE
)
index (provider_publish_id) WHERE provider_publish_id IS NOT NULL; index (post_id)

tiktok_webhook_events (
  id bigint GENERATED ALWAYS AS IDENTITY PK,
  event text NOT NULL, user_openid text NOT NULL, publish_id text NOT NULL,
  provider_post_id text NULL, reason text NULL, create_time bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz NULL,
  UNIQUE (event, publish_id, create_time)
)
index (publish_id) WHERE applied_at IS NULL
```

Tenancy: drafts and submissions have RLS enabled with one policy, `SELECT TO authenticated USING (user_id = auth.uid())`. `REVOKE INSERT, UPDATE, DELETE ... FROM anon, authenticated`; `GRANT SELECT ... TO authenticated`. `tiktok_webhook_events`: RLS enabled, no policies, `REVOKE ALL FROM anon, authenticated`. All writes go through the service role in `tiktok-review` / `tiktok-webhook` / `process-post`. Composite FKs make cross-user account and media combinations structurally impossible, even under the service role. An `updated_at` trigger uses the existing `update_updated_at_column()`.

### RPCs

All are `LANGUAGE plpgsql`, `SET search_path = public, pg_temp`, `SECURITY INVOKER`. They do `REVOKE ALL ... FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE ... TO service_role`. Errors use `RAISE EXCEPTION '<CODE>' USING ERRCODE='P0001'`, where `<CODE>` is one of `TIKTOK_REVIEW_NOT_FOUND`, `TIKTOK_REVIEW_REVISION_CONFLICT`, `TIKTOK_REVIEW_INVALID_STATE`, `TIKTOK_REVIEW_ACCOUNT_NOT_FOUND`, `TIKTOK_REVIEW_MEDIA_REQUIRED`, `TIKTOK_REVIEW_REASON_REQUIRED`, `TIKTOK_REVIEW_SCHEDULE_INVALID`. `POST_QUOTA_*` from the posts trigger propagates unchanged.

```sql
tiktok_review_create_draft(p_user_id uuid, p_social_account_id uuid)
  RETURNS tiktok_review_drafts
  -- account must be user's, platform='tiktok', is_active → else ACCOUNT_NOT_FOUND

tiktok_review_save_draft(p_user_id uuid, p_draft_id uuid, p_expected_revision int,
  p_caption text, p_media_file_id uuid, p_media_duration_sec numeric, p_settings jsonb)
  RETURNS tiktok_review_drafts
  -- state IN (pending_review, rejected) → state := pending_review, rejection_reason := null,
  -- revision := revision + 1. Missing row → NOT_FOUND; revision mismatch → REVISION_CONFLICT;
  -- other state → INVALID_STATE. Foreign media → FK violation 23503 (handler maps to 422).

tiktok_review_transition(p_user_id uuid, p_draft_id uuid, p_expected_revision int,
  p_action text, p_reason text)
  RETURNS tiktok_review_drafts
  -- 'reject':  pending_review → rejected, reason trimmed non-blank else REASON_REQUIRED
  -- 'archive': pending_review|rejected → archived
  -- 'restore': archived → pending_review
  -- revision += 1 on every transition. Same error mapping as save.

tiktok_review_submit(p_user_id uuid, p_draft_id uuid, p_expected_revision int,
  p_request_id uuid, p_mode text, p_scheduled_at timestamptz, p_time_zone text)
  RETURNS jsonb  -- {submission_id, post_id, mode, scheduled_at, dispatch_state, created}
  -- 1. existing submission for (p_user_id, p_request_id) → return it, created=false.
  -- 2. SELECT draft FOR UPDATE (id, user_id) → NOT_FOUND / REVISION_CONFLICT;
  --    state <> pending_review → INVALID_STATE; media_file_id null → MEDIA_REQUIRED;
  --    mode='scheduled' requires p_scheduled_at > now(); mode='now' requires null → SCHEDULE_INVALID.
  -- 3. INSERT posts(user_id, caption, platforms '{tiktok}', media_file_ids {media},
  --    status CASE mode WHEN 'scheduled' THEN 'scheduled' ELSE 'pending' END, scheduled_at,
  --    source 'tiktok_review', metadata) where metadata =
  --    { selected_account_ids:[account], schedule_timezone, tiktok_review_submission_id,
  --      tiktok_privacy_level: settings.privacy, tiktok_title: caption,
  --      tiktok_allow_comment/duet/stitch: settings.allow*, tiktok_ai_generated: settings.aiGenerated,
  --      tiktok_disclose_content: settings.disclose,
  --      tiktok_your_brand: disclose AND yourBrand, tiktok_branded_content: disclose AND brandedContent }
  --    (booleans default false when absent).
  -- 4. INSERT submission (snapshot = caption, media_file_id, media_duration_sec, settings,
  --    account id, revision), consented_at = now(),
  --    dispatch_state = CASE mode WHEN 'scheduled' THEN 'scheduled' ELSE 'pending_dispatch' END.
  -- 5. UPDATE draft SET state='submitted'.
  -- The submission id is generated first so it can be written into posts.metadata.

tiktok_review_set_dispatch_state(p_submission_id uuid, p_from text[], p_to text)
  RETURNS boolean  -- compare-and-set; true when a row changed
```

**Harness:** `supabase/tests/tiktok_review_lifecycle.sql`, following `supabase/tests/README.md`. It must cover:

- a fresh apply;
- a user A draft on user B's account or media failing (23503);
- a stale revision raising CONFLICT;
- the transitions;
- submit idempotency on `request_id`;
- a second `request_id` after submit raising INVALID_STATE;
- the scheduled row being picked by the scheduler predicate while `now` is not;
- `authenticated` unable to INSERT, UPDATE, DELETE or EXECUTE;
- RLS SELECT isolation;
- the webhook event dedupe.

## 5. `tiktok-review` HTTP contract

`POST /functions/v1/tiktok-review`, user JWT only. A service-role bearer gets 403. CORS uses `restrictedCorsHeaders`. The shape is `index.ts` (wiring), `handler.ts` (`handleRequest(req, deps)`), `validation.ts` (zod `npm:zod@3.23.8`), `errors.ts`, following `supabase/functions/user-ai-providers/`. Envelope: `200 {ok:true,data}`; errors `{ok:false, code, message}` with HTTP 400 validation, 401 auth, 403 forbidden, 404 `NOT_FOUND`, 409 `REVISION_CONFLICT`/`INVALID_STATE`/`REQUEST_REUSED` (a requestId already used for another draft), 422 business (`MEDIA_REQUIRED`, `MEDIA_NOT_OWNED`, `MEDIA_NOT_VIDEO`, `POLICY_*`, `SCHEDULE_INVALID`, `REASON_REQUIRED`, `TOKEN_INVALID`), 429 quota, 502 `PROVIDER_UNAVAILABLE`, 500 `INTERNAL`. Every refusal writes a sanitized `system_logs` row via `_shared/logging.ts` (`source:'tiktok-review'`) with action, code, draft/submission id and user id. Tokens, captions, signed URLs and payloads are never logged. All provider calls use `_shared/request-timeout.ts` (10 s).

```ts
type TikTokSettings = { privacy: string | null; allowComment: boolean; allowDuet: boolean;
  allowStitch: boolean; disclose: boolean; yourBrand: boolean; brandedContent: boolean;
  aiGenerated: boolean };
type ReviewState = 'pending_review' | 'rejected' | 'archived' | 'submitted';
type ReviewDraft = { id: string; accountId: string; revision: number; state: ReviewState;
  caption: string; mediaFileId: string | null; mediaDurationSec: number | null;
  settings: TikTokSettings; rejectionReason: string | null; updatedAt: string;
  submission: { id: string; postId: string; mode: 'now' | 'scheduled';
    scheduledAt: string | null } | null };
type CreatorInfo = { nickname: string; username: string; avatarUrl: string | null;
  privacyLevelOptions: string[]; commentDisabled: boolean; duetDisabled: boolean;
  stitchDisabled: boolean; maxVideoPostDurationSec: number;
  postingBlocked: boolean; postingBlockedReason: string | null };
type PublishState = 'scheduled' | 'queued' | 'processing' | 'published' | 'failed' | 'needs_attention';
type PublishStatus = { state: PublishState; updatedAt: string; reason: string | null;
  postUrl: string | null };
```

| action | body | data |
| --- | --- | --- |
| `creator_info` | `{accountId}` | `CreatorInfo` (fresh, owner-checked, posting-blocked codes mapped) |
| `list` | `{accountId, state}` | `ReviewDraft[]` ordered `updated_at desc`, max 100 |
| `get` | `{draftId}` | `ReviewDraft` |
| `create` | `{accountId}` | `ReviewDraft` |
| `save` | `{draftId, expectedRevision, caption, mediaFileId, mediaDurationSec, settings}` | `ReviewDraft` |
| `reject` | `{draftId, expectedRevision, reason}` | `ReviewDraft` |
| `archive` / `restore` / `reopen` | `{draftId, expectedRevision}` | `ReviewDraft` |
| `submit` | `{draftId, expectedRevision, requestId, mode, scheduledAt, timeZone, consent: true}` | `{submissionId, postId, state: 'queued'\|'scheduled'}` |
| `status` | `{submissionId}` | `PublishStatus` |

`save` validates the caption at ≤2200 UTF-16 code units (`string.length`), the settings shape, and a `mediaFileId` owned by the caller. `submit` order:

1. Zod-validate the body.
2. Load the draft (owner) and require `expectedRevision`.
3. Fetch fresh creator info with the owner's token.
4. Run `evaluateTikTokPublishPolicy` (below); any violation returns 422 `POLICY_<CODE>` with no DB write.
5. Call `tiktok_review_submit`.
6. For `mode='now'` with `created=true`, run the D5 dispatch.

`status` mapping from `dispatch_state` and `platform_posts`/`posts`:

| Condition | State |
| --- | --- |
| `scheduled` and `posts.status='scheduled'` | `scheduled` |
| no platform row: `publishing`, or `unknown`/`dispatching` younger than 5 minutes | `processing` |
| no platform row: `pending_dispatch` younger than 5 minutes, or `dispatched` | `queued` |
| platform row `pending` | `processing` |
| row `success` | `published` (postUrl from `platform_post_url`) |
| row `failed` | `failed` (reason = sanitized `error_message`) |
| no platform row: `needs_attention`, or `unknown`/`dispatching`/`pending_dispatch` older than 5 minutes; or a failed row whose error starts `TIKTOK_REVIEW_NEEDS_ATTENTION` (reason text from `policyViolationMessage`, never raw codes) | `needs_attention` |

## 6. Shared pure modules (Deno, no Supabase imports)

```ts
// _shared/tiktokPostInfo.ts
export type TikTokPostSettings = { privacy: string; allowComment: boolean; allowDuet: boolean;
  allowStitch: boolean; disclose: boolean; yourBrand: boolean; brandedContent: boolean;
  aiGenerated: boolean };
export function buildTikTokPostInfo(caption: string, s: TikTokPostSettings): {
  title: string; privacy_level: string; disable_comment: boolean; disable_duet: boolean;
  disable_stitch: boolean; brand_organic_toggle: boolean; brand_content_toggle: boolean;
  is_aigc: boolean };   // exact mapping in plan Task 3; never truncates (policy rejects >2200)

// _shared/tiktokPublishPolicy.ts
export type TikTokCreatorCapabilities = { privacyLevelOptions: string[]; commentDisabled: boolean;
  duetDisabled: boolean; stitchDisabled: boolean; maxVideoPostDurationSec: number;
  postingBlocked: boolean };
export type PolicyViolation = { code: 'POSTING_BLOCKED' | 'PRIVACY_REQUIRED' | 'PRIVACY_NOT_OFFERED'
  | 'COMMENT_NOT_ALLOWED' | 'DUET_NOT_ALLOWED' | 'STITCH_NOT_ALLOWED' | 'DISCLOSURE_INCOMPLETE'
  | 'BRANDED_CONTENT_PRIVATE' | 'CAPTION_TOO_LONG' | 'MEDIA_REQUIRED' | 'DURATION_UNKNOWN'
  | 'DURATION_EXCEEDED'; message: string };
export function evaluateTikTokPublishPolicy(input: { caption: string; settings: TikTokSettings
  /* privacy nullable */; mediaFileId: string | null; durationSec: number | null;
  creator: TikTokCreatorCapabilities }): PolicyViolation[];
```

Rules: `allowX === true` while `creator.xDisabled` is a violation; `disclose` with neither brand box set gives `DISCLOSURE_INCOMPLETE`; `brandedContent` with `SELF_ONLY` gives `BRANDED_CONTENT_PRIVATE`; caption `.length > 2200` gives `CAPTION_TOO_LONG`; a null duration gives `DURATION_UNKNOWN`; a duration over the maximum gives `DURATION_EXCEEDED`.

## 7. Frontend feature — `src/features/tiktok-publishing/`

Modelled on `src/features/whatsapp-inbox/` and `ai-providers`:

- `domain/` holds pure types, `reviewRules.ts` (the mirror of policy for UX: eligibility, disabled reasons, consent invalidation key = draft|account|revision|media|settings; the publish mode and time are deliberately not part of it, so choosing Now or a time after confirming the settings does not undo the confirmation — the time is shown as "When: …" in the final confirm dialog and sent with `submit`) and `scheduleRules.ts` (Now / In 1 hour / Tomorrow 09:00 in the displayed IANA zone, reusing `src/features/scheduled/domain/wallClockMove.ts` for DST gap/overlap).
- `application/` holds `ports.ts` (`TikTokReviewGateway` mirroring §5 plus `resolveMediaPreview(mediaFileId)`), `useTikTokReview.ts`, `usePublishStatus.ts` (bounded backoff 3 s→30 s, max 10 min, stops on terminal/unmount/account change, manual refresh).
- `infrastructure/supabaseReviewGateway.ts` invokes `tiktok-review` and reads `error.context` for the envelope, like `supabaseAiProvidersGateway.ts`. It resolves media previews through the same query path `MediaLibraryPicker` uses.
- `ui/` holds `TikTokReviewScreen.tsx` (the **only** composition root that imports infrastructure) and the components from the plan. Styles are scoped under a `.tiktok-review` root with the tokens from [the reference](tiktok-review-reference.md).
- `tests/architecture.test.ts` is copied from ai-providers. `eslint.config.js` gets a `no-restricted-imports` block for `src/features/tiktok-publishing/{application,domain,ui}/**`, ignoring `ui/TikTokReviewScreen.tsx` and tests.
- `src/pages/TikTokPublish.tsx` becomes a thin route wrapper.
- `TikTokVideoPreview` is reused. Its 150-character truncation is a display preview; the editor shows the full caption with a UTF-16 counter.
- Consent is component state only, never persisted.

## 8. Slices and ownership

| Slice | Lane | Paths (disjoint) | Depends on |
| --- | --- | --- | --- |
| S0 migration + harness | Muse Spark 1.3 | `supabase/migrations/20261002150000_tiktok_review_lifecycle.sql`, `supabase/tests/tiktok_review_lifecycle.sql` | §4 |
| S1 shared pure modules | Grok 4.7 medium | `supabase/functions/_shared/tiktokPostInfo.ts`, `_shared/tiktokPublishPolicy.ts` | §6 |
| S2 review function | Grok | `supabase/functions/tiktok-review/**` | S1, §4 RPCs, §5 |
| S3 webhook/status/oauth/process-post/demo | Grok | `tiktok-webhook/**`, `tiktok-check-status/**`, `tiktok-oauth/index.ts`, `process-post/index.ts` (review branch + D6 only), `tiktok-demo-publish/index.ts` | S1, §4 |
| S4 frontend feature | Grok | `src/features/tiktok-publishing/**`, `src/pages/TikTokPublish.tsx`, `eslint.config.js` (one block) | §5, §7 |
| Tests | agy Gemini 3.8 high | `*.test.ts(x)` beside each slice | each slice |

S0 and S1 run first in parallel. S2, S3 and S4 then run in parallel.
