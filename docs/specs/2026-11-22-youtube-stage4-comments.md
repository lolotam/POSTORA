# YouTube Stage 4 — comments and moderation (revised Heavy specification)

22 November 2026 · **Heavy** · one delivery, one additive migration · revised after one independent debate round · proposed for one Astra 6.2 Medium debate before implementation. [Implementation and acceptance plan](../plans/2026-11-22-youtube-stage4-comments.md)

This document replaces the first Stage 4 draft (docs commit `665fa859`, never merged). Product baseline is the Stage 3 merge `21447f2de26b373a41acc23a5509a0718be1248c`; every code path below is cited at that commit. The roadmap scope is §4 of `docs/specs/2026-11-03-youtube-integration-completion.md` at `72844bd3`.

## 1. Decisions and assumptions this design rests on

| # | Statement | Source | Status |
|---|---|---|---|
| O1 | Stage 4 ships as **one Heavy delivery** that includes one purpose-built additive migration for a durable write receipt. No 4a/4b split. | Waleed, relayed by the manager on 2026-11-22 | Owner decision |
| O2 | **Ban-author is in scope.** It is attached to Reject only. | Waleed, same relay | Owner decision |
| O3 | The inbox has exactly two lists, **Published** and **Held for review**. **Reject is an action**, not a list. No rejected list and no spam tab. | Waleed, same relay | Owner decision. It narrows roadmap §4's "published/held/rejected" filter wording, because Google cannot list rejected comments (§3). |
| A1 | **Native only** for every new Stage 4 action (reads and writes). A Composio-connected channel keeps today's inbox unchanged and is told the new actions are unavailable for its connection type. | Manager's working assumption, not an owner decision | Assumption. Reason: the cached Composio tool list has no tool for top-level creation or edit (`_shared/connectorRegistry.ts:774-792`), its thread-list arguments carry no `moderationStatus` (`_shared/youtubeComments.ts:438-448`), and adding tools to that list would hand the AI agent new write capabilities (`ai-agent-reply/composioTools.ts:117`). |
| A2 | **No OAuth change.** `youtube.force-ssl` is already requested and is the only scope Google lists for every Stage 4 write (§3). Requested scopes, callbacks, token storage and consent stay untouched. | Debate receipt (`youtube-oauth/handler.ts:417`) and Google reference | Verified offline |
| A3 | Hold and Publish remain moderation actions alongside Reject. | Roadmap §4 item 7 ("explicitly hold/publish/reject"); O3 names Reject only | Roadmap-backed; confirmation requested (§16, D3) |
| A4 | Deleting the channel's own comment stays on the existing `delete_comment` action, unchanged. Deleting is repeat-safe, so it needs no receipt. | Roadmap §4 item 6; baseline behaviour | Preserved, not redesigned |

Out of scope and unchanged: Partner API, n8n node, MCP tools, AI agent and workflow comment delivery, polling cadence, Facebook, Instagram and Threads.

## 2. The journey

**Comments → YouTube → account → video.** For a natively connected channel that is admitted by the rollout gate, the owner can:

1. page through **all** owned uploads, including uploads with zero comments;
2. open the **Published** or **Held for review** list of one video and page its threads and replies;
3. post a first top-level comment, and reply to a comment, each **at most once per deliberate submit**;
4. edit a comment or reply the channel wrote;
5. hold, publish or reject a comment on their video, and — as a separate, explicitly confirmed step on Reject — ask YouTube to ban its author.

With the gate off, or on a Composio connection, the YouTube tile behaves exactly as it does at the baseline.

## 3. Provider contract (Google primary reference, read 2026-11-22)

Every provider rule in this design comes from these pages. "Not stated" means the page is silent and the design must not assume an answer.

| Method | Facts used | Reference |
|---|---|---|
| `commentThreads.list` | Filters are exactly one of `allThreadsRelatedToChannelId`, `id`, `videoId`. `moderationStatus` accepts **`heldForReview`, `likelySpam`, `published`** only; default `published`; **`rejected` is not a value**. Under `heldForReview` a thread "can be included in the response if the top-level comment or at least one of the replies to that comment are awaiting review". The parameter "can only be used in a properly authorized request". `maxResults` 1–100, default 20. `moderationStatus`, `maxResults`, `order`, `pageToken` are not supported together with `id`. Errors: `commentsDisabled` 403, `forbidden` 403, `videoNotFound` 404, `channelNotFound` 404, `commentThreadNotFound` 404, `processingFailure` 400, `operationNotSupported` 400. 1 unit. | [commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list) |
| `commentThreads` resource | `id` is the thread ID. `snippet.videoId` is "the ID of the video to which the comments refer". `snippet.topLevelComment` is a comment resource with its own `id`. `replies.comments[]` "is only a subset of the total number of replies available"; all replies come from `comments.list` with `parentId`. | [commentThreads](https://developers.google.com/youtube/v3/docs/commentThreads) |
| `comments.list` | Filters `id` or `parentId`; "YouTube currently supports replies only for top-level comments". `maxResults` 1–100 and `pageToken` are not supported with `id`. Whether held or rejected replies are returned under `parentId` is **not stated**. Errors: `forbidden` 403, `commentNotFound` 404, `operationNotSupported` 400. 1 unit. | [comments.list](https://developers.google.com/youtube/v3/docs/comments/list) |
| `comments` resource | **There is no `snippet.videoId` property.** `snippet.moderationStatus` (values `heldForReview`, `likelySpam`, `published`, `rejected`) "is only returned if the API request was authorized by the owner of the channel or the video" and **is not set when the request used the `id` filter**. `snippet.authorChannelId.value` is the author's channel "if available". `snippet.parentId` "is only set if the comment was submitted as a reply". `snippet.textOriginal` "is only returned to the authenticated user if they are the comment's author". | [comments](https://developers.google.com/youtube/v3/docs/comments) |
| `commentThreads.insert` | Body requires `snippet.channelId`, `snippet.videoId`, `snippet.topLevelComment.snippet.textOriginal`. Errors: `channelOrVideoIdMissing`, `commentTextRequired`, `commentTextTooLong`, `invalidCommentThreadMetadata`, `processingFailure` (400); `forbidden`, `ineligibleAccount` (403); `channelNotFound`, `videoNotFound` (404). Scope `youtube.force-ssl`. 50 units. | [commentThreads.insert](https://developers.google.com/youtube/v3/docs/commentThreads/insert) |
| `comments.insert` | "Creates a reply to an existing comment." Body requires `snippet.textOriginal` and `snippet.parentId`. Errors include `parentIdMissing`, `parentCommentIsPrivate`, `commentTextRequired`, `commentTextTooLong`, `invalidCommentMetadata`, `invalidCustomEmoji`, `operationNotSupported`, `processingFailure` (400); `forbidden`, `ineligibleAccount` (403); `parentCommentNotFound` (404). Scope `youtube.force-ssl`. 50 units. | [comments.insert](https://developers.google.com/youtube/v3/docs/comments/insert) |
| `comments.update` | `part` must include `snippet`; the settable property is `snippet.textOriginal`. Errors: `commentTextTooLong`, `invalidCommentMetadata`, `operationNotSupported`, `processingFailure` (400); `forbidden`, `ineligibleAccount` (403); `commentNotFound` (404). Scope `youtube.force-ssl`. 50 units. | [comments.update](https://developers.google.com/youtube/v3/docs/comments/update) |
| `comments.setModerationStatus` | `id` is "a comma-separated list of up to 50 IDs". `moderationStatus` is `heldForReview`, `published` or `rejected`. "You can't change the moderation status of a rejected comment to `published`." Rejecting "effectively hides all replies to the rejected comment". **`banAuthor`** "lets you indicate that you want to automatically reject any additional comments written by the comment's author. Set the parameter value to `true` to ban the author. This parameter is only valid if the `moderationStatus` parameter is also set to `rejected`." "The API request must be authorized by the owner of the channel or video associated with the comments." Success is **HTTP 204**. Errors: `banWithoutReject`, `operationNotSupported`, `processingFailure` (400); `forbidden` (403); `commentNotFound` (404). Scope `youtube.force-ssl`. 50 units. **Undoing a ban, or reading whether an author is banned, is not stated anywhere in the reference.** | [comments.setModerationStatus](https://developers.google.com/youtube/v3/docs/comments/setModerationStatus) |
| `videos` resource | `snippet.channelId` is "the ID that YouTube uses to uniquely identify the channel that the video was uploaded to". `videos.list` costs 1 unit. | [videos](https://developers.google.com/youtube/v3/docs/videos) |
| `playlistItems.list` | `maxResults` 0–50, default 5. 1 unit. | [playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list) |
| Quota | Default allocation "10,000 units per day combined" for these endpoints, "subject to change". Every Stage 4 write costs 50 units. | [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) |

Three consequences shape the whole design:

- **A comment cannot be bound to a video by reading the comment.** The comment resource has no video field. The binding must come from the thread (`snippet.videoId`) or from the parent chain. The first draft's "require provider comment.id and videoId to match" is not implementable as written.
- **A comment's moderation status cannot be read back by ID**, and a rejected comment cannot be listed. So a reject, and any ban, can never be confirmed by a later read.
- **Whether held replies are retrievable is not stated.** The design is fail-closed on this point and names a rehearsal gate (§8.4).

## 4. Baseline behaviour that must not change

| Entry point at `21447f2d` | Stage 4 boundary |
|---|---|
| `comment-manager/index.ts` actions `get_youtube_comments`, `get_youtube_videos` (first 25 uploads, `_shared/youtubeComments.ts:683`), `reply_comment`, `hide_comment`, `delete_comment`; service-role callers limited to three read actions (`index.ts:25`, `:166`). | Unchanged request and response shapes. New actions are added beside them and are refused for service-role callers by the existing rule. The legacy account lookup, which checks neither `is_active` nor platform (`index.ts:190-195`), is left alone; new actions never use it. |
| `_shared/youtubeComments.ts`: `listThreads`, `listYouTubeRepliesPage`, `replyToThread` (reply-to-reply normalised to the parent), `setModerationStatus`, `getYouTubeComment`, `deleteOwnComment`; `parseThread` puts the **thread** ID on the row (`:400-414`). | Existing exports keep their signatures, return values and error classes. Stage 4 adds private typed operations beside them. The shared classifier `classifyGoogleError` is not modified. |
| `_shared/commentActions.ts`: hide → `rejected`, unhide → `published`, own-comment delete with provider author check. | Preserved, including failure propagation. See finding F2 (§15) on unhide. |
| `_shared/commentOps.ts` and `partner-api/v1/comments.ts`: bound list/get, paged replies, reply, hide; YouTube delete is `unsupported_capability`. Entitlement uses `feature_youtube_comments` (`_shared/partnerEntitlement.ts`). | **No new public parity.** Envelopes, opaque IDs and cursors, idempotency header and replay stay byte-compatible. Private Stage 4 actions never route through this module's switch. |
| `n8n-api/index.ts`: YouTube returns `INVALID_PLATFORM` on the public comment mutations. | Unchanged. |
| `ai-agent-reply` and comment workflows deliver replies through `_shared/commentActions.ts` under the service role; `youtube-poll-comments` cadence, seeding, dedup and self-author suppression. | Unchanged. No new tool is added to the connector registry `tools` or `mutating` lists. Stage 4 reads never ingest or dispatch automation events. |
| `CommentManagerPage`, `CommentManagerPanel`, `useCommentInbox`, `CommentActions`, thread/row/list components. | Unchanged for Facebook, Instagram, Threads, Composio YouTube and gate-off native YouTube. |

## 5. Why a migration, and why no existing table will do

Posting a comment or a reply cannot be made safe to repeat: a second send is a second public comment. The design therefore needs a durable record that (a) lets **at most one** send happen per deliberate submit, (b) keeps that fence **permanently** once a send may have reached Google, and (c) is bound to owner and account inside SQL. The debate examined every existing primitive; none satisfies all three (migration line numbers as cited in the debate receipt):

| Candidate | Why it cannot be the fence |
|---|---|
| `partner_api_idempotency` | Keyed to a partner API key by foreign key (`20260813120000_partner_api_foundation.sql`); a dashboard user has none. Rows expire after 7 days and the lease can be taken over, so the fence is not permanent. |
| `partner_dispatch_intents` | A trigger requires a partner key; sent rows must carry a WhatsApp message ID (`20260901120000_partner_dispatch_intents.sql`). |
| `background_jobs` (closest) | Browser-readable; a stale running job can be re-claimed; a kind-agnostic sweep rewrites old queued or running rows to failed or stalled every minute (`20261108120000_background_jobs.sql`), which would overwrite "possibly sent" evidence. No account foreign key. |
| `comment_workflow_events` | Platform foreign key allows only facebook, instagram, threads; keyed by the incoming comment; stores comment text (`20260904120000_comment_workflow.sql`). |
| `cron_run_leases` | Expired leases can be taken over; no owner (`20261031100000_cron_run_lease.sql`). |
| `posts` / `platform_posts` | Natural only for posts; comments would pollute History and the `process-post` pipeline. `platform_posts` cascades on account delete. |
| `youtube_token_refresh_leases`, `connector_call_logs` | One row per account, or telemetry with no unique key. |
| An in-memory key | Cannot fence concurrent function instances or survive a reload. |

**Conclusion: one additive migration is required.** It contains exactly the objects in §6 and §7. Refusal audit does **not** need a new table (§12).

## 6. Account binding and generation

### 6.1 What "binding" has to mean

A receipt is only meaningful for the connection it was created under. Three things happen to a YouTube account row, and they must be told apart:

| Event at the baseline | How it is written | Binding effect required |
|---|---|---|
| **Native token refresh** | Service-only RPCs update `access_token`, `token_expires_at`, optionally `refresh_token`, `needs_reauth`, `failure_count`, `last_refresh_error`, `account_metadata`, `updated_at` (`20261118230000`, `20261120110000`, `20261120130000`). They never write `connected_at`, `is_active`, `auth_provider`, `connection_id`, `platform_user_id` or `user_id`. | **Same binding.** Receipts stay usable. |
| **Disconnect** | The browser updates `is_active = false` on its own row under RLS (`src/hooks/useSocialAccounts.tsx:73-77`); the server's own path does the same and clears credentials (`youtube-oauth/index.ts:196-210`). A profile or user deletion hard-deletes the row by cascade. | **Binding ends.** |
| **Reconnect** | Native: a PostgREST upsert on `(user_id, platform, platform_user_id)` into the **same row**, writing a new `connected_at` and `is_active = true` (`youtube-oauth/index.ts:131-149`). Composio: an upsert that rewrites `connection_id` on the same row (`composio-connect/activation.ts:217-229`). After a hard delete, a new row with a new ID. | **New binding.** Old receipts must not be exposed and no old claim may dispatch. |

A search of `supabase/functions`, `src` and the YouTube migrations at the baseline found no other writer of `connected_at`, `is_active`, `auth_provider` or `connection_id` on a YouTube row: the Composio activation's `connected_at` (`activation.ts:281`) is on the connection record, not the account; `_shared/socialAccountReconnect.ts` is used only by Threads; the token refresh and health paths do not write these columns. So no periodic job would advance the generation. Plan step 1 repeats this inventory on the implementation head, because a routine writer would make receipts disappear.

YouTube has no connection generation today; only Meta has `connection_version`. None of the writers above goes through one shared RPC, and two of them are already-deployed code paths the migration cannot change.

### 6.2 Decision: a trigger-maintained generation column

The single migration adds to `public.social_accounts`:

- `binding_generation bigint NOT NULL DEFAULT 1` — a constant default, so no table rewrite on the supported Postgres major;
- one `BEFORE INSERT OR UPDATE` row trigger that **only assigns `NEW.binding_generation`**:
  - on insert: `1`;
  - on update of a row where old or new `platform = 'youtube'`: `OLD.binding_generation + 1` when any of `user_id`, `platform`, `platform_user_id`, `auth_provider`, `connection_id`, `connected_at` is distinct, or `is_active` changes in either direction; otherwise `OLD.binding_generation`;
  - on update of any other row: `OLD.binding_generation`.

Properties this gives, each a test obligation in the plan:

- **Monotonic and unforgeable.** The trigger overwrites any client-supplied value, so the owner's RLS update cannot set, lower or replay a generation.
- **Refresh keeps the generation**; disconnect, reconnect, provider switch and re-consent (new `connected_at`) each advance it. Bumping on disconnect as well as on reconnect means a claim made before a disconnect is dead even if a later check of `is_active` were skipped.
- **Old code keeps working.** The column is additive with a default; deployed writers never name it. The trigger reads and writes no other relation and no other column, and it runs with the caller's privileges without needing any: this is deliberately the opposite shape from the cascade trigger that failed on 2026-11-05 (`20261105120000`), which touched tables the caller could not reach.

Rejected alternative: a snapshot tuple `(account id, user_id, platform_user_id, auth_provider, connection_id, connected_at)` with no schema change. It works only because today's two reconnect writers happen to write `connected_at`; the owner can rewrite that column from the browser, a re-activation by `is_active = true` alone would resurrect an old binding, and nothing structural stops a future writer from forgetting it. AGENTS.md review rule 1 asks for structural enforcement. The receipt still stores the tuple's channel and provider fields as audit context.

**Account schema change: yes, inside the one migration** — one column and one trigger on `social_accounts`. This is the highest-risk statement in the delivery because the table is shared by every platform; the plan carries its own compatibility proof (plan step 2).

## 7. The receipt

### 7.1 Table `public.youtube_comment_operations`

RLS enabled, **no policies**, no grants to `anon` or `authenticated`; all access through service-only functions. Columns:

| Column | Rule |
|---|---|
| `id uuid` primary key | |
| `owner_id uuid NOT NULL` → `auth.users` ON DELETE CASCADE | The receipt dies only with its owner. |
| `operation_id uuid NOT NULL` | Minted by the browser, one per deliberate submit. **Unique `(owner_id, operation_id)`.** |
| `social_account_id uuid` → `social_accounts(id)` **ON DELETE SET NULL** | Mirrors `youtube_upload_sessions` (`20261118120000`): the evidence must outlive the account row. `CASCADE` would erase "possibly sent" evidence on profile deletion; `RESTRICT` would block disconnect. |
| `account_ref uuid NOT NULL`, `channel_id text NOT NULL`, `binding_generation bigint NOT NULL`, `auth_provider text NOT NULL CHECK (= 'native')` | Immutable snapshot taken inside the claim under a row lock on the account. |
| `action text NOT NULL` | `create_thread`, `reply`, `edit`, `moderate`. |
| `video_id`, `thread_id`, `parent_comment_id`, `comment_id`, `author_channel_id` (text) | Presence enforced per action by CHECK. |
| `moderation_status text`, `ban_author boolean NOT NULL DEFAULT false` | CHECK: `ban_author` implies `action = 'moderate'`, `moderation_status = 'rejected'` and a non-empty `author_channel_id`. |
| `intent_digest text NOT NULL` | Keyed HMAC-SHA-256 over the canonical request (action, account, generation, video, target IDs, status, ban flag, normalised text). Detects key reuse with a different intent. |
| `logical_digest text` | Keyed HMAC over `(channel_id, video_id, parent_comment_id, normalised text)`; set only for `create_thread` and `reply`. |
| `state text NOT NULL` | `claimed`, `dispatched`, `confirmed`, `refused`, `indeterminate`. |
| `attempt_token uuid NOT NULL` | Returned only to the claim winner. |
| `reason text`, `provider_class text`, `request_id uuid`, `result_thread_id text`, `result_comment_id text`, `claimed_at`, `dispatched_at`, `settled_at` | Allow-listed enums and confirmed provider IDs only. |

**Never stored:** comment text, access or refresh tokens, provider bodies, cursors, display names.

Uniqueness that carries the fences:

- `UNIQUE (owner_id, operation_id)` — the per-submit fence.
- `UNIQUE (owner_id, channel_id, logical_digest) WHERE action IN ('create_thread','reply') AND state IN ('claimed','dispatched','indeterminate')` — the **logical-operation fence**. While one create or reply is unresolved, a second submit of the same text to the same place is refused even under a fresh key, in any tab, on any binding generation of the same owner and channel.

### 7.2 State machine

```text
claim ──► claimed ──(mark_dispatched, CAS)──► dispatched ──► confirmed
             │                                    │   ├────► refused        (provider said no, definitely)
             └──► refused (never sent)            │   └────► indeterminate  (may have been accepted)
                                                  └─ no settlement within the timeout budget ─► indeterminate
```

- `claimed` means **definitely not sent**. A stale `claimed` row (older than the handler deadline) may be closed as `refused / abandoned_before_dispatch` by a later claim, by compare-and-set on `state = 'claimed'`. Nothing else is ever reclaimed.
- `dispatched` is written **before** the HTTP request. From that instant the operation is never sent again, by anyone, under any key.
- `indeterminate` is **permanent** for `create_thread`, `reply` and any `moderate` to `rejected`. It is never retried, never swept, never cleared by a flag change, a rollback, a timeout, a later read or any other caller. **Exactly one thing can resolve it:** the original attempt, holding the attempt token, settling with its own late and definite provider response (`confirmed` on complete evidence, `refused` on a Google error envelope).
- No background job touches this table.

### 7.3 Service-only functions

All `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ... TO service_role`, applied as `supabase_admin`.

| Function | Contract |
|---|---|
| `youtube_comments_stage4_admits(account, capability)` | The single rollout evaluator (§13). Fails closed. |
| `youtube_comment_op_claim(owner, account, operation_id, action, targets, intent_digest, logical_digest, request_id)` | Locks the account row with the predicate `id = account AND user_id = owner AND platform = 'youtube' AND is_active AND auth_provider = 'native' AND NOT needs_reauth`; a miss is `not_found`, identical for foreign and absent rows. Calls the evaluator. Inserts or finds the row. Same key, same digest, same generation → the existing state, without a token. Same key, different digest → `conflict`. Same key, older generation → `not_found`. Logical fence hit → `possible_duplicate`, with no detail of the other row. |
| `youtube_comment_op_mark_dispatched(owner, operation_id, attempt_token)` | CAS `claimed → dispatched`, only if the token matches, the account row still satisfies the claim predicate **with the same `binding_generation`**, and the evaluator still admits. On a failed precondition the row becomes `refused` with the reason, and the function returns false. **The handler sends only when this returns true.** |
| `youtube_comment_op_settle(owner, operation_id, attempt_token, outcome, reason, result IDs)` | Token holder only. `dispatched|indeterminate → confirmed|refused|indeterminate`; `claimed → refused`. It does **not** require a live binding: the truth about a send is recorded even if the account was disconnected mid-flight. |
| `youtube_comment_op_status(owner, account, operation_id)` | Returns the row only when the account currently satisfies owner, platform and active checks **and its `binding_generation` equals the row's**. Otherwise `not_found`. Converts a `dispatched` row older than the timeout budget to `indeterminate` by CAS. Works with the rollout gate off, so recovery survives a rollback. |

### 7.4 Why this cannot authorise or replay across a rebinding

- **Exposure.** Status is the only read path, and it compares the live generation with the stored one. After any disconnect or reconnect the comparison fails, for the same owner as well as for anyone else. A hard-deleted account leaves `social_account_id` null, which can never match.
- **Replay.** A claim made under generation *n* cannot pass `mark_dispatched` under generation *n+1*. A `dispatched` or `indeterminate` row is never sent again by construction.
- **Duplicate after reconnect.** The logical fence is keyed by owner and channel, not by generation, so an unresolved create from the old binding still blocks the identical create under the new one. The refusal is the bare reason `possible_duplicate`; no field of the old receipt is returned. This is a deliberate trade: it leaks one bit ("something identical is unresolved") to the same owner about the same channel, in exchange for never double-posting.

## 8. Private actions

Added to the deployed `comment-manager` handler. `index.ts` only routes: when `action` is in the Stage 4 set, it hands the already-authenticated caller to a separate handler module **before** the legacy account lookup. The handler is built from injected ports (auth result, database, provider, clock, IDs, refusal log) so it is testable without Supabase (ARCHITECTURE §§12, 34).

Common rules: user JWT only; one Zod schema per action with **strict keys** (unknown keys are refused, so a `banAuthor`, `user_id` or `channel_id` field in the body fails validation); bounded strings; UUIDs validated; every response carries `request_id`; errors are a stable `reason` enum with fixed English/Arabic copy keys — never provider text, SQL text or a raw provider object.

| Action | Input beyond `social_account_id` | Provider calls | Result |
|---|---|---|---|
| `youtube_stage4_capabilities` | — | none | Per-capability booleans with a reason each: `browse`, `create`, `reply`, `edit`, `moderate`, `ban_author`. The UI renders controls from this and nothing else. |
| `youtube_video_page` | optional cursor | `playlistItems.list` on the channel's uploads playlist, 25 per page | Video ID, title, published time, next cursor. Uploads with zero comments are listed. |
| `youtube_thread_page` | `video_id`, `list` = `published` \| `heldForReview`, optional cursor | `videos.list` (ownership), `commentThreads.list?videoId=&moderationStatus=`, 20 per page | Rows as in §8.2, next cursor, and a list-level state (§11). |
| `youtube_reply_page` | parent **handle**, optional cursor | `comments.list?parentId=`, 50 per page | Reply rows, next cursor. |
| `youtube_create_thread` | `video_id`, `text`, `operation_id` | `videos.list`, then `commentThreads.insert` | Receipt state. |
| `youtube_reply` | target **handle**, `text`, `operation_id` | `comments.list?id=` (parent still exists), then `comments.insert` | Receipt state. New fenced action; legacy `reply_comment` is untouched and stays unfenced for automation and public callers (§15, F4). |
| `youtube_edit_comment` | target **handle**, `text`, `operation_id` | `comments.list?id=` (author check), then `comments.update` | Receipt state. |
| `youtube_moderate_comment` | target **handle**, `status` = `heldForReview` \| `published` \| `rejected`, `operation_id`; optionally `ban_author: true` with `ban_ack` (§10) | `videos.list`, `comments.list?id=`, then `comments.setModerationStatus` | Receipt state. |
| `youtube_operation_status` | `operation_id` | none, except the edit observation in §9.3 | Receipt state; available with the gate off. |

### 8.1 Tenant and ownership checks, in order, on every request

1. **Account.** One query with owner, account ID, `platform = 'youtube'`, `is_active`, `auth_provider = 'native'`; the channel ID and `binding_generation` are read from that row, never from the body. A failed read is an error, never "not found" (AGENTS.md review rule 3). Foreign and missing accounts get the identical refusal.
2. **Gate.** `feature_youtube_comments` must be true and the evaluator must admit the account for the capability (§13). Rechecked inside `claim` and `mark_dispatched`.
3. **Video.** With the bound credential, `videos.list?part=snippet&id=<video>` must return exactly that ID with `snippet.channelId` equal to the account's channel. Picker membership, public visibility and a commenter's identity prove nothing.
4. **Target.** By handle (§8.2), then a fresh `comments.list?part=snippet&id=<comment>` immediately before dispatch: the comment must still exist, its `id` must match, its `snippet.parentId` must equal the handle's parent (absent for a top-level comment). Edit additionally requires a non-empty `authorChannelId.value` equal to the account's channel. Moderation accepts a foreign author. If the response happens to carry an undocumented video field that disagrees with the handle, the request is refused.

The target read depends on `comments.list` with the `id` filter, for which Google lists an `operationNotSupported` error (§3). The baseline already depends on the same call for reply and own-delete (`getYouTubeComment`, `_shared/youtubeComments.ts:570`). If that read is refused or returns nothing, the target is unverified and **no write is sent**.

A competing change on YouTube between the last check and the send remains possible and is stated in the UI copy for edits.

### 8.2 Rows, IDs and handles

A thread has **two** identifiers and the baseline parser keeps only one. The private projection extracts both and never substitutes one for the other:

| Field | Source | Used for |
|---|---|---|
| `thread_id` | `commentThread.id` | display grouping, cursor context |
| `comment_id` of the top-level comment | `commentThread.snippet.topLevelComment.id` | `parentId` of replies, edit, moderation |
| `comment_id` of a reply | `comment.id` from `replies.comments[]` or `comments.list?parentId=` | edit, moderation |
| `parent_comment_id` of a reply | `comment.snippet.parentId` | binding the reply to its thread |
| `video_id` | `commentThread.snippet.videoId` only | binding everything under the thread to the video |
| `moderation_status` of each row | that row's own `snippet.moderationStatus`, from a list call that did **not** use the `id` filter | which controls the row gets |

Fixtures must use deliberately **unequal** thread and top-level comment IDs.

Because a comment cannot be bound to a video by reading it (§3), the server mints a **target handle** for every row it returns: an integrity-protected token containing owner, account, `binding_generation`, channel, video, thread ID, comment ID, kind (top-level or reply), parent comment ID, author channel ID, observed status and expiry (30 minutes). Mutations and reply paging accept the handle, **not raw IDs**. A handle proves that Google returned this comment under this video to this owner's credential under this binding. Handles and cursors reuse the existing HMAC sealing pattern (`_shared/commentOps.ts:53-70`) with distinct prefixes; no new secret is introduced. A cursor is bound to owner, account, generation, video, list or parent, and action, and is validated before its provider page token is used. Malformed, expired, cross-context or cyclic tokens are refused.

### 8.3 Lists

- **Published** asks for `moderationStatus=published`; **Held** asks for `heldForReview`. `likelySpam` is never requested and `rejected` cannot be. There is no third list.
- Replies merge by comment ID across inline previews and reply pages; one bounded page per user action until no cursor remains; a failed page keeps earlier rows and offers a retry of that page only.
- A reply to a reply is posted against the thread's top-level comment, taken from the handle (the provider rule in §3), not from a second lookup.

### 8.4 Held replies — fail closed

Google includes a thread in the Held list when "at least one of the replies" is awaiting review, but does not state that the held reply itself, or its `moderationStatus`, is returned by `replies.comments[]` or by `comments.list?parentId=`. Therefore:

- A row gets Publish or Reject-as-held controls **only** when that row's own status reads `heldForReview`.
- A row whose status is missing or `likelySpam` is shown read-only with an "open in YouTube Studio" hint and gets **no** moderation controls.
- A thread that appears in the Held list while neither its top-level comment nor any loaded reply reads `heldForReview` shows "A reply in this thread is awaiting review, but YouTube did not return it here", with no action.
- **Rehearsal gate R-held:** before the Held list is enabled for any account, one separately authorised, read-only observation on a named fixture records, as a sanitised offline fixture, what the two reply sources return for a held reply. Until then the Held list ships with the conservative behaviour above and the plan's fake-provider fixtures cover both possible answers. This document does not authorise that live read.

## 9. Sending, uncertainty and reconciliation

### 9.1 One send, counted honestly

The browser mints one `operation_id` per deliberate submit, keeps only the key and target context across a reload, disables the control while pending and never retries a mutation automatically. The handler order is fixed: validate → account → gate → verify video and target → **claim** → **mark dispatched** → send once → **settle**. If the claim cannot be written, nothing is sent.

Stage 4 writes use their own private mutation transport, because the shared `sendNative` reports a network failure as the same `upstream` class whether or not the request left the process (`_shared/youtubeComments.ts:174-199`). The private transport has a 15-second timeout and **no retry**, with one exception inherited from the baseline: a `401` on a token this call did not mint is answered by one forced refresh and one resend (`:216`), which is safe because Google rejects a `401` before executing anything. Tests count **accepted dispatches** — requests not answered by `401` — and require at most one per operation.

### 9.2 Classification after `dispatched`

| Observation | Receipt | Shown to the user |
|---|---|---|
| Refresh fails, or `mark_dispatched` returns false | `refused` (never sent) | Not sent; draft kept; may submit again. |
| `2xx` with complete, matching evidence — create: thread ID, top-level comment ID, `snippet.videoId` and `snippet.channelId` equal to the request; reply: comment ID and `snippet.parentId` equal to the parent; edit: `id` equal to the target; moderation: `204` | `confirmed` | Done. |
| `4xx` carrying a parseable Google error envelope (including quota) | `refused` with the mapped reason | Not applied; reason shown; draft kept. |
| Network error, timeout or abort after `dispatched`; any `5xx`; `2xx` with missing, malformed or mismatched IDs; a `4xx` without a Google envelope | **`indeterminate`** | "This may or may not have been posted." |
| Settlement write fails after a real response | Row stays `dispatched`, then reads as `indeterminate` | Same. The request is logged with its `request_id`. |

### 9.3 Read-only reconciliation

Nothing here writes to YouTube, and nothing clears an `indeterminate` receipt except the original attempt's late response.

| Action | What can be observed afterwards | What the UI offers |
|---|---|---|
| Create, reply | Nothing trustworthy. Matching text or time is not proof of this attempt; a missing row is not proof of failure. | A "refresh the thread" action. **Never a resend control.** A submit of the same text to the same place is refused as `possible_duplicate` while the receipt is unresolved. Changing the text is a different comment and is allowed. |
| Edit | The channel is the author, so `comments.list?id=` returns `textOriginal`. The status call reports `requested_text_observed`, `different_text_observed` or `unavailable` as a separate observation; it does **not** claim this attempt caused it and does not change the receipt. | Review, then a new deliberate edit if wanted (an edit sets a state; repeating it is harmless). |
| Hold, publish | The refreshed list shows each row's own current status. | The list is the truth; a new deliberate action is allowed. |
| Reject, with or without ban | **Nothing.** Rejected comments are not listable, status is not returned by ID, and no method reads a ban. A comment vanishing from a list is equally consistent with the author deleting it. A `404` is never read as success. | "Reject may or may not have been applied." A new deliberate Reject, with a fresh confirmation (and a fresh ban confirmation if wanted), is allowed if the target still verifies; if it no longer verifies, the request is refused without effect. |

## 10. Moderation and ban-author

### 10.1 Moderation

- One comment per call. The `id` parameter accepts up to 50 comma-separated IDs, so the server validates the target as a single strict ID from the handle and never forwards client text into that parameter.
- Controls follow the row's observed status: `published` → Hold, Reject; `heldForReview` → Publish, Reject; anything else → none.
- **Reject is confirmed in a dialog that states both documented consequences:** replies to the comment are hidden with it, and a rejected comment cannot be published again through the API. The new queue offers no undo.

### 10.2 Ban-author

Ban is a **separately confirmed native moderator intention**, bound to one exact account, video, comment and author, and it travels only on Reject.

1. **Reachability.** Only `youtube_moderate_comment`, only with a user JWT, only on a native account, only when the rollout policy's `ban_author` switch is on for that account. It is unreachable from the service role, the AI agent, workflows, Partner API, n8n and MCP. No registry tool is added.
2. **Shape.** `ban_author: true` is valid only with `status: 'rejected'`. Any other combination is refused before the claim (`ban_requires_reject`), mirroring Google's `banWithoutReject`. **Reject alone never sends the parameter:** the `banAuthor` key is omitted from the query entirely — not sent as `false`.
3. **Second confirmation.** The Reject dialog carries an unchecked "Also ban this author" option. Ticking it opens a second dialog that names the author (display name as plain text plus the author channel ID) and states the limits in 10.3. Confirming sends `ban_ack` equal to that author channel ID.
4. **Binding.** The server requires `ban_ack` to equal the handle's author channel ID **and** the `authorChannelId.value` from the fresh pre-dispatch read. The receipt stores the author channel ID and `ban_author = true`; the intent digest covers both.
5. **Ambiguity refuses the whole operation, with no effect.** Missing or empty author channel ("if available" is Google's wording), a mismatch between acknowledgement, handle and fresh read, a target that no longer verifies, an account that is not exactly the bound one, or an author equal to the account's own channel: the request is refused before the claim. It is **never** downgraded to a plain reject; the user must submit that deliberately.
6. **Limits.** Ban requests have their own low per-owner daily cap, enforced server-side.

### 10.3 What Postora can and cannot say about a ban

| Statement | Basis |
|---|---|
| "YouTube accepted the reject-and-ban request for this comment." | A `204` to a request that carried `moderationStatus=rejected` and `banAuthor=true`. This is **moderation evidence**: proof that the request was accepted. |
| "This author is banned." | **Never shown.** No documented method returns an author's ban status, so it is unobservable. |
| "Undo ban." | **Never offered.** The reference documents no method to lift a ban. The copy tells the owner that Postora cannot show or reverse it and that hidden users are managed in YouTube Studio (general product knowledge, not from the API reference; the Arabic and English copy must not promise a specific Studio path). |
| What the ban does | Google's own words only: it will "automatically reject any additional comments written by the comment's author". The copy does not add scope or duration claims the reference does not make. |
| A lost response on reject-and-ban | `indeterminate` for **both** effects. Postora does not report the reject as done and the ban as unknown, or the reverse. |

## 11. Distinguishing "disabled", "no permission" and "empty"

| Provider result | Classified as | Scope of effect | UI |
|---|---|---|---|
| `200`, zero items, no next token | `empty` | this list | "No comments yet", composer available. |
| `200`, zero items, next token present | continue | this list | The page advances; not shown as empty. |
| `403 commentsDisabled` | `comments_disabled` | **this video only** | "Comments are turned off for this video." No composer. Other videos unaffected. |
| `403` with an insufficient-scope reason | `scope_missing` | the comment capability of this account | Existing native grant-loss handling (`dropGrantedScope`) and the existing reconnect path. Other capabilities stay. |
| `401` after the forced refresh | `unauthorized` | account | Reconnect prompt. |
| `403 forbidden` (other) | `forbidden` | this request | Stated plainly; no health or grant mutation. |
| `403` quota reasons | `quota` | project-wide, temporary | "YouTube's daily limit was reached." Writes pause; nothing is retried. |
| `404 videoNotFound`, `commentNotFound`, `parentCommentNotFound`, `commentThreadNotFound` | `not_found` | this target | Row or video marked unavailable. |
| `403 ineligibleAccount` | `ineligible_account` | account | Stated plainly. |
| Text errors (`commentTextRequired`, `commentTextTooLong`, `invalidCustomEmoji`) | `invalid_text` | this draft | Inline, draft kept. |
| Anything unrecognised, malformed pages or IDs | `upstream` | this request | Error with request reference. **No** health, grant or `needs_reauth` mutation. |

The mapping lives in a private Stage 4 classifier that wraps the shared one. Shared classifier behaviour, and therefore every other consumer, is unchanged and regression-tested.

## 12. Refusal audit

The existing `public.system_logs` table is adequate and is the sink Stage 2 and Stage 3 already use for the same purpose (`youtube-resources/index.ts:135-151`). **No audit table is added.**

- Every refusal of an **authenticated** request writes one row: `level = 'warn'`, `category = 'edge'`, `source = 'comment-manager'`, `user_id`, and metadata limited to `action`, `reason`, `provider_class`, `request_id`, and — only once verified against the owner — `account_id` and `operation_id`.
- **Never logged:** comment text, author names, headers, credentials, cursors, handles, provider bodies, or any identifier supplied by a caller that has not been verified.
- **Unauthenticated or unparseable requests** get a sanitised console event with the reason code only and no database row. This follows the merged `youtube-resources` handler, which refuses anonymous callers without a log row so that an unauthenticated client cannot write to the audit table at will. It is a stated exception to AGENTS.md review rule 4 and is put to the debate (§16, D5).
- If the log insert fails, a sanitised fallback diagnostic is emitted and the response is unchanged.
- A write is different: its durable intent is the receipt row itself. **If the claim cannot be recorded, nothing is dispatched.**

## 13. Rollout, capabilities and who may change what

**Environment.** There is one environment: the self-hosted production Supabase at `https://api.postora.cloud` (Dokploy stack `postorasupabase-supabase-j8axyh` on the Contabo host). **No staging stack exists.** The Heavy tier's "deploy to staging" is therefore read as "deploy to production with the gate off", and every live step is Waleed's.

**Gates, all required, all server-side:**

| Gate | Where | Default | Notes |
|---|---|---|---|
| Existing tile flag `feature_youtube_comments` | `app_settings`, browser-readable like every `feature_*` key (`20261029170000_media_upload_limits.sql`) | as today | Unchanged meaning. Also drives Partner entitlement. Necessary, never sufficient. |
| **New server-only key `youtube_comments_stage4_rollout`** | `app_settings`. The name deliberately does **not** start with `feature_` and is not added to the authenticated read allow-list, so non-admin browsers cannot read the pilot list. | **Absent = off.** The migration does not seed it. | Value: `{ "version": 1, "mode": "off" \| "allowlist", "account_ids": [<social_accounts.id>…], "ban_author": false }`. There is no `all` mode in Stage 4. Missing key, unknown version, malformed JSON, `off`, or an account not listed → deny. A failed read is an **error**, never a deny that looks like "off". Precedent: the private `collection_instagram_rollout_policy` key (`20261031090000`). Stage 3's edit gate is a compile-time constant and is not a precedent for a key. |
| Native connection with the comment scope still granted | account row and existing scope record | — | Composio → `provider_unsupported` under A1. |

One SQL evaluator, `youtube_comments_stage4_admits`, answers for the handler, for `claim` and for `mark_dispatched`, so the gate is re-read at the last moment before a send and a stale function instance cannot dispatch after the key is turned off. Admins get no bypass.

**No exposure from flags or stale clients.**

- Flipping `feature_youtube_comments` alone exposes nothing new.
- An old frontend against the new backend uses only legacy actions, which are unchanged.
- A new frontend against an old backend calls `youtube_stage4_capabilities`, receives the legacy "Unknown action" answer, and renders the baseline inbox.
- A tab left open across a gate-off, a disconnect or a reconnect holds handles and cursors bound to a generation and an expiry; every request re-checks account, generation and gate server-side.

**Separation of permissions.** These are independent and none implies another:

| Permission | Holder |
|---|---|
| Approving and applying the migration; deploying; creating or editing the rollout key; enabling `ban_author`; any live rehearsal | Waleed (deployment owner). Note: `app_settings` writes are admin-only by RLS, and the admin role can write any key from the dashboard; the rollout key is therefore an owner action, not a secret. |
| Using Stage 4 on a channel | The Postora owner of an admitted, natively connected account, via their own JWT. |
| AI agent, workflows, Partner API, n8n, MCP | Exactly their baseline capabilities. Stage 4 adds none. |

## 14. Interface requirements

- New controls, cache keys, drafts, cursors, handles and operation state are scoped to user, account, video and thread, and are discarded on account switch and sign-out; a response for a previous selection is dropped.
- The top-level composer is separate from per-row reply controls. A refused submit keeps the draft. A lost response shows a status check, never optimistic success.
- After a disconnect or reconnect — including the reconnect that scope loss asks for (§11) — a pending or indeterminate operation from the previous binding answers `not_found`. The client then shows "This action was started before the channel was reconnected, so its result can no longer be checked here. Check the video on YouTube." It offers no resend, and an identical create or reply is still refused as `possible_duplicate` (§7.4).
- Provider and commenter text is rendered as plain text.
- English and Arabic copy for every state in §§9–11; RTL layout; keyboard reachable; focus returns to the triggering control after a dialog; status changes are announced.
- Code lives under `src/features/youtube-comments/` (`domain`, `application`, `infrastructure`, `ui`) per ARCHITECTURE §3, mounted from the existing panel only when capabilities allow.

## 15. Findings at the baseline that this stage records but does not change

| # | Finding | Why untouched | Proposed handling |
|---|---|---|---|
| F1 | **The AI agent may already be able to send `banAuthor`.** On a Composio connection the agent's `YOUTUBE_SET_COMMENT_MODERATION_STATUS` call forwards model-chosen `parameters` unfiltered (`ai-agent-reply/composioExecution.ts:118-123`). Whether the cached tool schema exposes `banAuthor` cannot be checked offline; no fixture of it exists in the repository. | The brief preserves all existing Composio behaviour. | **Decision D1.** If the schema exposes it, this contradicts "ban is an explicit human intention" and should be closed by a separate small security change that strips the argument. |
| F2 | Legacy unhide maps to `published`, and the agent guide says "Hiding is reversible" (`_shared/connectorRegistry.ts:797`). Google says a rejected comment cannot be published. | Legacy parity is a requirement. | **Decision D2**: separate follow-up to correct the guide and the unhide behaviour. |
| F3 | The legacy account lookup in `comment-manager` checks neither `is_active` nor platform. | Out of scope; new actions do not use it. | Follow-up issue. |
| F4 | Legacy `reply_comment` is unfenced, so an agent or public retry can still double-post. | Changing it would alter automation and public behaviour. | Dashboard replies move to the fenced action; the legacy path is a follow-up. |
| F5 | `comment-manager` answers with `Access-Control-Allow-Origin: *`. | Existing endpoint; bearer-token auth, so CORS is not its authorisation boundary. ARCHITECTURE §25 forbids copying this into **new** functions; none is added. | Follow-up issue. |
| F6 | `commentThreads.insert` already exists once, in `process-post/youtubeUploadFollowUps.ts`. | — | Stage 4 puts the request builder and response validator in one shared pure module and points the follow-up at it with no behaviour change, proven by its existing tests (ARCHITECTURE §40). |

## 16. Decisions still open

| # | Question | Recommendation | Owner |
|---|---|---|---|
| D1 | F1: verify the cached Composio schema and, if it exposes `banAuthor`, strip it in a separate change? | Yes, separately, before `ban_author` is enabled anywhere. | Waleed |
| D2 | F2: correct the agent guide and legacy unhide separately? | Yes, separate Medium change. | Manager |
| D3 | A3: keep Hold and Publish as actions? | Yes. | Waleed, by confirmation |
| D4 | Account schema change on `social_accounts` (§6.2) versus the snapshot tuple. | Generation column and trigger. | Debate, then Waleed with the migration approval |
| D5 | No audit row for unauthenticated refusals (§12). | Keep the merged precedent. | Debate |
| D6 | Logical fence spans binding generations and returns a bare `possible_duplicate` (§7.4). | Keep. | Debate |
| D7 | A1: should a Composio channel get the new read-only lists later? | Not in Stage 4. | Manager |
| D8 | Rehearsal R-held, and any live write rehearsal, on a named private fixture. | Authorise separately after merge; nothing here authorises it. | Waleed |
