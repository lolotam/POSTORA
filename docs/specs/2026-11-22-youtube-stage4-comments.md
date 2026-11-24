# YouTube Stage 4 — comments and moderation (revised Heavy specification)

22 November 2026 · **Heavy** · one delivery, one additive migration · revised after the independent debate rounds, including the Astra 6.2 Medium Heavy debate of docs head `28694147`, whose five blockers and acceptance amendments are resolved here · ready for implementation under the approvals in the plan. [Implementation and acceptance plan](../plans/2026-11-22-youtube-stage4-comments.md)

This document replaces the first Stage 4 draft (docs commit `665fa859`, never merged). Product baseline is the Stage 3 merge `21447f2de26b373a41acc23a5509a0718be1248c`; every code path below is cited at that commit. The roadmap scope is §4 of `docs/specs/2026-11-03-youtube-integration-completion.md` at `72844bd3`.

## 1. Decisions and assumptions this design rests on

| # | Statement | Source | Status |
|---|---|---|---|
| O1 | Stage 4 ships as **one Heavy delivery** that includes one purpose-built additive migration for a durable write receipt. No 4a/4b split. | Waleed, relayed by the manager on 2026-11-22 | Owner decision |
| O2 | **Ban-author is in scope.** It is attached to Reject only. | Waleed, same relay | Owner decision |
| O3 | The inbox has exactly two lists, **Published** and **Held for review**. **Reject is an action**, not a list. No rejected list and no spam tab. | Waleed, same relay | Owner decision. It narrows roadmap §4's "published/held/rejected" filter wording, because Google cannot list rejected comments (§3). |
| A1 | **Native only** for every new Stage 4 action (reads and writes). A Composio-connected channel keeps today's inbox unchanged and is told the new actions are unavailable for its connection type. | Manager's working assumption, not an owner decision | Assumption. Reason: the cached Composio tool list has no tool for top-level creation or edit (`_shared/connectorRegistry.ts:774-792`), its thread-list arguments carry no `moderationStatus` (`_shared/youtubeComments.ts:438-448`), and adding tools to that list would hand the AI agent new write capabilities (`ai-agent-reply/composioTools.ts:117`). |
| A2 | **No OAuth change.** `youtube.force-ssl` is already requested and is the only scope Google lists for every Stage 4 write (§3). Requested scopes, callbacks, token storage and consent stay untouched. The only change in `youtube-oauth` is the explicit provider reset in §6.3. | Debate receipt (`youtube-oauth/handler.ts:417`) and Google reference | Verified offline |
| A3 | Hold and Publish remain moderation actions alongside Reject. | Roadmap §4 item 7 ("explicitly hold/publish/reject"); O3 names Reject only | Adopted (§16, D3) |
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
- **`204` is the only documented success of a moderation call**, so it is the only thing Stage 4 treats as acceptance of a reject or a ban.

## 4. Baseline behaviour that must not change

| Entry point at `21447f2d` | Stage 4 boundary |
|---|---|
| `comment-manager/index.ts` actions `get_youtube_comments`, `get_youtube_videos` (first 25 uploads, `_shared/youtubeComments.ts:683`), `reply_comment`, `hide_comment`, `delete_comment`; service-role callers limited to three read actions (`index.ts:25`, `:166`). | Unchanged request and response shapes. New actions are added beside them and are refused for service-role callers by the existing rule. The legacy account lookup, which checks neither `is_active` nor platform (`index.ts:190-195`), is left alone; new actions never use it. |
| `_shared/youtubeComments.ts`: `listThreads`, `listYouTubeRepliesPage`, `replyToThread` (reply-to-reply normalised to the parent), `setModerationStatus`, `getYouTubeComment`, `deleteOwnComment`; `parseThread` puts the **thread** ID on the row (`:400-414`). | Existing exports keep their signatures, return values and error classes. Stage 4 adds private typed operations beside them. The shared classifier `classifyGoogleError` is not modified. |
| `_shared/commentActions.ts`: hide → `rejected`, unhide → `published`, own-comment delete with provider author check. | Preserved, including failure propagation and the legacy one-time `401` resend. See finding F2 (§15) on unhide. |
| `_shared/commentOps.ts` and `partner-api/v1/comments.ts`: bound list/get, paged replies, reply, hide; YouTube delete is `unsupported_capability`. Entitlement uses `feature_youtube_comments` (`_shared/partnerEntitlement.ts`). | **No new public parity.** Envelopes, opaque IDs and cursors, idempotency header and replay stay byte-compatible. Private Stage 4 actions never route through this module's switch. |
| `n8n-api/index.ts`: YouTube returns `INVALID_PLATFORM` on the public comment mutations. | Unchanged. |
| `ai-agent-reply` and comment workflows deliver replies through `_shared/commentActions.ts` under the service role; `youtube-poll-comments` cadence, seeding, dedup and self-author suppression. | Unchanged. No new tool is added to the connector registry `tools` or `mutating` lists. Stage 4 reads never ingest or dispatch automation events. |
| MCP comment tools and the first-comment follow-up in `process-post/youtubeUploadFollowUps.ts`. | Unchanged, including the follow-up's existing success rule (§15, F6). |
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

A receipt is only meaningful for the connection it was created under. These are the things that happen to a YouTube account row at the baseline:

| Event | How it is written | Binding effect required |
|---|---|---|
| **Trusted token refresh**, including a rotated refresh token | Two `SECURITY DEFINER` functions: `store_youtube_refreshed_token` (`20261118230000`) and `store_youtube_refreshed_token_with_lease` (`20261120130000_youtube_refresh_lease_fixes.sql:242-258`). They write `access_token`, `token_expires_at`, optionally `refresh_token`, plus `needs_reauth`, `failure_count`, `last_refresh_error`, `account_metadata`, `updated_at`. | **Same binding.** Receipts stay usable, with or without a new refresh token. |
| **Generic update by the owner's browser** | `authenticated` holds table privileges on `social_accounts` (`supabase/tests/baseline_schema.sql:22988`) and the policy "Users can update own social accounts" allows any column of an owned row (`20260101204652…sql:116-118`). | A change to **metadata** keeps the binding. A change to **credentials or identity** is a new binding: the browser is not a trusted refresher. |
| **Disconnect** | Browser sets `is_active = false` (`src/hooks/useSocialAccounts.tsx:73-77`); the server path does the same and clears credentials (`youtube-oauth/index.ts:196-210`). Profile or user deletion hard-deletes the row. | **Binding ends.** |
| **Native re-consent or reconnect** | Service-role upsert into the same row on `(user_id, platform, platform_user_id)`, writing tokens, a new `connected_at`, `is_active = true` (`youtube-oauth/index.ts:131-149`). It does **not** name `auth_provider` or `connection_id`, so on conflict those keep whatever the row had. | **New binding**, and the row must end up unambiguously native. |
| **Composio activation** | Upsert that sets `auth_provider = 'composio'`, `connection_id`, null tokens (`composio-connect/activation.ts:217-229`). | **New binding.** Stage 4 actions then refuse the account (A1). |
| **Delete and re-create** | New row, new ID. | Old receipts unreachable (§7.5). |

A search of `supabase/functions`, `src` and the YouTube migrations found no periodic writer of `is_active`, `connected_at`, `auth_provider` or `connection_id` on a YouTube row (the Composio `connected_at` at `activation.ts:281` is on the connection record; `_shared/socialAccountReconnect.ts` is Threads-only). Plan step 1 repeats the inventory on the implementation head.

### 6.2 Decision: a trigger-maintained generation with one trusted exception

The single migration adds to `public.social_accounts`:

- `binding_generation bigint NOT NULL DEFAULT 1` — constant default, no table rewrite;
- one `BEFORE INSERT OR UPDATE` row trigger, `SECURITY INVOKER`, that **only assigns `NEW.binding_generation`** and reads no other relation.

Rule for a row where old or new `platform = 'youtube'` (any other row: `OLD.binding_generation`, always):

| Changed columns | Result |
|---|---|
| **Identity columns** — `user_id`, `platform`, `platform_user_id`, `auth_provider`, `connection_id`, `connected_at`, or `is_active` in either direction | `OLD + 1`, for every caller without exception. |
| **Credential columns** — `access_token`, `refresh_token` — and no identity column | `OLD` **only in the trusted refresh context**; otherwise `OLD + 1`. |
| Anything else (`token_expires_at`, `needs_reauth`, `failure_count`, `last_refresh_error`, `account_metadata`, `avatar_url`, `updated_at`, …) | `OLD`. |
| Insert | `1`. A client-supplied value is overwritten in every case. |

**Trusted refresh context** is defined structurally, not by convention, via an **exclusive narrowly privileged authority**. The migration creates a dedicated NOLOGIN role, `youtube_stage4_refresh`, that is a member of no role and holds no role as a member. It owns **EXACTLY** three trusted refresh functions and nothing else: the two named in §6.1 and `store_youtube_refreshed_token_with_lease_neutral`, the health-neutral store Stage 4 uses (§11). It is granted the minimal privileges those three bodies need: SELECT on `social_accounts`; UPDATE on only the columns they write (`access_token`, `refresh_token`, `token_expires_at`, `needs_reauth`, `failure_count`, `last_refresh_error`, `account_metadata`, `updated_at`), never an identity column; and SELECT, INSERT, UPDATE and DELETE on `youtube_token_refresh_leases`. Inside those two functions `current_user` is `youtube_stage4_refresh`; everywhere else it is `authenticated`, `anon`, `service_role`, `supabase_admin` or a caller. The role cannot log in and cannot be assumed by any other statement, so no statement other than those two function bodies can ever execute as it. The trigger preserves the generation only when `current_user = 'youtube_stage4_refresh'`; every other writer advances it.

A browser or a direct service-role PostgREST write can never satisfy this, and neither can any other function on this stack, because none of them is owned by the narrow role. The migration does not edit the bodies of the refresh functions: what changes is their **owner**, so their effective role becomes the narrow authority instead of the superuser that owns everything else. Their EXECUTE grants are restated and their existing suites stay green, which is the compatibility proof. A future migration that has to replace either body must first take the ownership back to `supabase_admin` and return it afterwards; a future migration that adds a fourth trusted writer must own it with the same role. The SQL test pins both halves: the role is NOLOGIN and a member of nothing, and it owns exactly the two named functions.

Consequences, each a test obligation (plan step 2):

- A rotated refresh token through either refresh function keeps the generation; the same column change made by `authenticated` or by a direct service-role update advances it.
- A metadata-only update by the owner's browser keeps the generation.
- Disconnect, re-activation, native re-consent, provider switch in both directions, and `connection_id` change each advance it by one. It never decreases and cannot be set by a client.
- The baseline already has a trigger on this table that reacts to a credential change (`delete_youtube_refresh_lease_on_credential_change`, `20261120130000`); the new trigger is independent of it and both must keep working in either firing order.
- Old code keeps working: the column is additive, deployed writers never name it, and the trigger needs no privilege of its own — deliberately the opposite shape from the cascade trigger that failed on 2026-11-05 (`20261105120000`).

### 6.3 Explicit provider and connection reset on native re-consent

Because the native upsert does not name `auth_provider` or `connection_id`, Stage 4 changes that one write in `youtube-oauth` to set `auth_provider: 'native'` and `connection_id: null` explicitly. This is a binding-correctness change only: requested scopes, callback, consent and token storage are untouched (A2 holds). The existing guards stay (`youtube-oauth/index.ts:165` skips Composio rows on its lookup; activation refuses `channel_already_native`). Tests read the **actual** provider columns after the upsert in both directions and assert the generation advanced. Every Stage 4 predicate reads the stored `auth_provider`; none infers it from the presence of a token.

Rejected alternative: a snapshot tuple with no schema change. It cannot tell a trusted rotation from a browser credential swap, a re-activation by `is_active = true` would resurrect an old binding, and nothing structural stops a future writer from forgetting `connected_at`.

**Account schema change: yes, inside the one migration** — one column and one trigger on `social_accounts`. This remains the highest-risk statement in the delivery.

## 7. The receipt

### 7.1 Table `public.youtube_comment_operations`

RLS enabled, **no policies**, no grants to `anon` or `authenticated`; access only through the service-only functions in §7.4.

| Column | Rule |
|---|---|
| `id uuid` primary key | |
| `owner_id uuid NOT NULL` → `auth.users` ON DELETE CASCADE | The receipt dies only with its owner. |
| `operation_id uuid NOT NULL` | Minted by the browser, one per deliberate submit. **Unique `(owner_id, operation_id)`.** |
| `social_account_id uuid` → `social_accounts(id)` **ON DELETE SET NULL** | Mirrors `youtube_upload_sessions`. `CASCADE` would erase "possibly sent" evidence; `RESTRICT` would block disconnect. |
| `account_ref uuid NOT NULL`, `channel_id text NOT NULL`, `binding_generation bigint NOT NULL`, `auth_provider text NOT NULL CHECK (= 'native')` | Immutable snapshot written by the claim under a row lock on the account. |
| `action text NOT NULL` | `create_thread`, `reply`, `edit`, `moderate`. |
| `video_id`, `thread_id`, `parent_comment_id`, `comment_id`, `author_channel_id` (text) | Presence enforced per action by CHECK. For `reply`, `parent_comment_id` is always the **top-level** comment ID that is sent to Google. |
| `moderation_status text`, `ban_author boolean NOT NULL DEFAULT false` | CHECK: `ban_author` implies `action = 'moderate'`, `moderation_status = 'rejected'`, non-empty `author_channel_id`. |
| `intent_digest text NOT NULL`, `logical_digest text`, `digest_key_version int NOT NULL` | §7.2. `logical_digest` is set only for `create_thread` and `reply`. |
| `state text NOT NULL` | `claimed`, `dispatched`, `confirmed`, `refused`, `indeterminate`. |
| `attempt_token uuid NOT NULL` | Returned only to the claim winner. |
| `reason`, `provider_class`, `request_id`, `result_thread_id`, `result_comment_id`, `claimed_at`, `dispatched_at`, `settled_at` | Allow-listed enums and confirmed provider IDs only. |

**Never stored:** comment text, tokens, provider bodies, cursors, handles, display names.

### 7.2 Digests that survive key rotation

Digests are **not** keyed with the service-role key, because rotating that key would silently disable every stored fence. The migration adds a second private table, `youtube_comment_digest_keys (version int primary key, key bytea NOT NULL, created_at, retired_at)`, RLS on, no policies, no client grants, with version 1 generated in the migration from core functions only (`sha256` over two `gen_random_uuid()` values; no extension is assumed). A service-only function returns the active and retained keys to the Edge handler, which computes HMAC-SHA-256 and never logs or returns a key.

- `intent_digest` covers action, account, generation, video, target IDs, status, ban flag and normalised text. It detects reuse of one key for a different intent.
- `logical_digest` covers **`(channel_id, video_id, canonical parent, normalised text)`** and nothing else — not the operation key, not the account row ID, not the generation. The **canonical parent** is empty for a top-level comment and the top-level comment ID for every reply, including a reply aimed at a reply. Two replies with the same text to different replies in one thread are therefore the same logical operation, which is what Google would make of them.
- Text normalisation is fixed (Unicode NFC, line endings to `\n`, surrounding whitespace trimmed) and versioned with the key.
- **Rotation** adds a version and never deletes one while any row references it. A claim carries the logical digest under every retained version, and the fence compares version to version, so evidence written under an old key still blocks.

Handles and cursors are short-lived (§8.2) and keep the existing HMAC sealing pattern (`_shared/commentOps.ts:52-70`); rotating that key only expires them.

### 7.3 State machine and numeric limits

```text
claim ──► claimed ──(mark_dispatched, CAS)──► dispatched ──► confirmed
             │                                    │   ├────► refused        (definite Google 4xx for this request)
             └──► refused (never sent)            │   └────► indeterminate  (may have been accepted)
                                                  └─ unsettled after 90 s ─► indeterminate
```

| Limit | Value | Meaning |
|---|---|---|
| Provider HTTP timeout | 15 s | One attempt. |
| Handler deadline | 60 s | Whole request. |
| `claimed` is stale after | **120 s** | It may then be closed to `refused / abandoned_before_dispatch` by compare-and-set on `state = 'claimed'`. |
| `dispatched` reads as `indeterminate` after | **90 s** | Converted by compare-and-set in the status function. |
| Recent-confirmation window | **10 min** | §7.5. |
| Pruning | rows with `dispatched_at IS NULL`, state `refused`, older than **30 days**; at most **20 per claim**, same owner only | The **only** deletion in the design. |

- `claimed` means **definitely not sent**. It is the only state ever reclaimed, closed or pruned.
- `dispatched` is committed **before** the HTTP request. From that instant the operation is never sent again by anyone under any key, and its row is never deleted.
- `indeterminate` is **permanent** for `create_thread`, `reply` and any `moderate` to `rejected`. It is never retried, swept, pruned, or cleared by a timeout, a later read, a flag change, a rollback or another caller. **Exactly one thing resolves it:** the original attempt, presenting its `attempt_token`, settling with definitive evidence about this request — `confirmed` on a complete, matching `2xx` (a `204` for moderation), `refused` on a `4xx` carrying a Google error envelope. **A `5xx` is always indeterminate, with or without an envelope.** A late settlement racing the 90-second conversion is safe in both orders: each step is a compare-and-set and `indeterminate → confirmed|refused` is open only to the token holder.
- **What a new submit may do while an earlier one is unresolved.** The original key blocks, permanently, any second send *under that key*: it is never re-sent. A *new deliberate submit under a new key* is a different question, and the answer depends on the earlier receipt: while it may still land (`claimed`, `dispatched`) or cannot be read, the interface does not offer one; once it is `indeterminate` the interface does, because the server's fences guard the original. For `create_thread` and `reply`, the logical fence refuses the same text while the original is unresolved and for 10 minutes after a confirmation (the same text again after that window is a new comment), and a different text is a different comment. For `edit` and `moderate` there is no logical fence: a new deliberate edit or a new Reject is allowed, and a Reject must still verify its target.
- **Status closes what only a status read can close.** A `dispatched` receipt unsettled after 90 seconds reads `indeterminate`, and a `claimed` one that never reached the mark reads `refused` (`abandoned_before_dispatch`) after 120 seconds, both by a state-checked conditional update whose losing side answers with the winning row. The mark takes a share lock on the two rollout settings rows before it evaluates them, so a revocation either commits before the mark reads (and stops it) or waits until the mark commits (and orders after it).
- No background job touches either table.

### 7.4 Service-only functions

All `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`, applied as `supabase_admin`.

| Function | Contract |
|---|---|
| `youtube_comments_stage4_admits(account, capability)` | The single rollout evaluator (§13). Fails closed. |
| `youtube_comment_digest_keys()` | Active and retained digest keys. |
| `youtube_comment_op_claim(owner, account, expected_channel, expected_generation, operation_id, action, targets, intent_digest, logical_digests, capability, request_id)` | In **one transaction**, under `FOR UPDATE` on the account row: requires `id = account AND user_id = owner AND platform = 'youtube' AND is_active AND auth_provider = 'native' AND NOT needs_reauth` **and** `platform_user_id = expected_channel` **and** `binding_generation = expected_generation`; calls the evaluator for the capability; applies both fences. The expected values are the ones every earlier verification step used, so a rebinding between verification and claim fails here. A miss is `not_found`, identical for foreign, absent and re-bound rows. Same key + same digest + same generation → existing state, no token. Same key + different digest → `conflict`. Logical fence hit → `possible_duplicate` or `recently_posted` (§7.5). |
| `youtube_comment_op_mark_dispatched(owner, operation_id, attempt_token, expected_channel, expected_generation)` | Same lock and the same predicate, generation and evaluator checks, then CAS `claimed → dispatched`. On a failed precondition the row becomes `refused` with the reason and the function returns false. **A true return is the final authorisation to send** (§9.1). |
| `youtube_comment_op_settle(owner, operation_id, attempt_token, outcome, reason, result IDs)` | Token holder only; transitions as in §7.3. `refused` after dispatch is accepted only with a `4xx` provider class; a `5xx` class is rejected as a reason for `refused`. It does **not** require a live binding: the truth about a send is recorded even if the account was disconnected mid-flight. |
| `youtube_comment_op_status(owner, account, operation_id)` | Returns the row only when the account currently satisfies owner, platform and active checks **and its `binding_generation` equals the row's**. Otherwise `not_found`. Applies the 90-second conversion. Reads no provider. **Not gated by the rollout policy**, so it works with every capability off. |

### 7.5 Evidence across keys, reloads, rebinding and deletion

Two fences, enforced inside the claim under a transaction-scoped advisory lock on `(owner, channel, logical digest)`:

1. **Unresolved fence** — a partial unique index on `(owner_id, channel_id, digest_key_version, logical_digest)` where the action is `create_thread` or `reply` and the state is `claimed`, `dispatched` or `indeterminate`. A second submit of the same logical operation is refused as `possible_duplicate` under any key, in any tab, on any generation, on a re-created account row.
2. **Recent-confirmation fence** — a `confirmed` row with the same logical digest and `settled_at` within the last 10 minutes refuses a **different** key with `recently_posted`. This closes the case where the send succeeded and settled but the browser lost the answer and its stored key. Under the same live binding the refusal carries the confirmed comment ID so the UI can show the comment; across a binding change it is the bare reason. After 10 minutes a deliberate identical comment is allowed.

Why this cannot expose or replay:

- **Exposure.** Status is the only receipt read and it compares the live generation with the stored one; after any disconnect or reconnect it fails, for the same owner too. A hard-deleted account leaves `social_account_id` null, which can never match. Across bindings a fence refusal returns one enum and no field of the other row.
- **Replay.** A claim made under generation *n* cannot pass `mark_dispatched` under *n+1*. A `dispatched` or `indeterminate` row is never sent again by construction.
- **Deletion and re-creation.** Fences are keyed by owner and channel, not by account row, so they survive a hard delete followed by a fresh connection of the same channel.

### 7.6 PR 2 amendments (migration `20261124120000_youtube_stage4_key_integrity.sql`)

Four rules the first migration left open. They change §7.2 and §7.4 as follows, and nothing else in this document.

- **The digest map is required.** `youtube_comment_op_claim` keeps its twelve-argument signature, but `p_intent_digests` is no longer optional: a `NULL` or non-object map is `invalid_request`, answered before the account is read. The map alone decides the stored intent digest (the entry for the key version the claim locked) and the comparison on a retry (the entry for the receipt's key version). `p_intent_digest` stays in the signature and decides nothing beyond being present, like `p_capability`. A retry whose map has no entry for the receipt's key version is the temporary `upstream` and changes nothing; it used to be `conflict`, which a browser shows as a refusal and uses to forget a live operation.
- **Key versions are monotonic and referenced by a foreign key.** `youtube_comment_digest_key_watermark` holds the highest version ever issued; an inserted version must be above it, so a deleted version number is never issued again (a later `INSERT … ON CONFLICT DO NOTHING` on an existing version now raises, because the guard fires on `INSERT`). A foreign key `ON DELETE RESTRICT` from `youtube_comment_operations.intent_key_version` to `youtube_comment_digest_keys.version` makes the delete guard's `EXISTS` an early, readable error rather than the authority: a `REPEATABLE READ` session that took its snapshot before a claim committed cannot delete the key that claim's receipt references. A CHECK ties `digest_key_version` to it (equal for `create_thread` and `reply`, `0` for `edit` and `moderate`).
- **The status read locks the account first.** Once a receipt is known to exist, `youtube_comment_op_status` takes `FOR SHARE` on the owner-scoped account row, then re-reads the receipt: the order the claim and the mark already use (account, then receipt). A rebind or an account delete waits for a status read in flight, and the receipt returned after a lost 90-second conversion belongs to a binding that is still current. An operation id with no receipt locks nothing.

Procedure, rollback and the watermark note: `docs/runbooks/youtube-stage4-pr2-migration.md`.


## 8. Private actions

Added to the deployed `comment-manager` handler. `index.ts` only routes: when `action` is in the Stage 4 set it hands the already-authenticated caller to a separate handler module **before** the legacy account lookup. The handler is built from injected ports so it is testable without Supabase (ARCHITECTURE §§12, 34).

Common rules: user JWT only; one Zod schema per action with **strict keys** (a `banAuthor`, `user_id` or `channel_id` field fails validation); bounded strings; every response carries `request_id`; errors are a stable `reason` enum with fixed English/Arabic copy keys — never provider text, SQL text or a raw provider object.

| Action | Rollout capability | Input beyond `social_account_id` | Provider calls | Result |
|---|---|---|---|---|
| `youtube_stage4_capabilities` | none | — | none | Booleans with a reason each: `read`, `held`, `write`, `ban`. The UI renders controls from this only. |
| `youtube_video_page` | `read` | optional cursor | `playlistItems.list`, 25 per page | Video ID, title, time, next cursor. Empty uploads are listed. |
| `youtube_thread_page` | `read`; `held` for the Held list | `video_id`, `list` = `published` \| `heldForReview`, optional cursor | `videos.list`, `commentThreads.list?videoId=&moderationStatus=`, 20 per page | Rows (§8.2), next cursor, list state (§11). |
| `youtube_reply_page` | `read` | parent **handle**, optional cursor | `comments.list?parentId=`, 50 per page | Reply rows, next cursor. |
| `youtube_create_thread` | `write` | `video_id`, `text`, `operation_id` | `videos.list`, then `commentThreads.insert` | Receipt state. |
| `youtube_reply` | `write` | target **handle**, `text`, `operation_id` | `comments.list?id=`, then `comments.insert` | Receipt state. Legacy `reply_comment` is untouched (F4). |
| `youtube_edit_comment` | `write` | target **handle**, `text`, `operation_id` | `comments.list?id=`, then `comments.update` | Receipt state. |
| `youtube_ban_confirmation` | `ban` | target **handle**, `operation_id` | `comments.list?id=` | A server-issued confirmation token (§10.2). Writes nothing anywhere. |
| `youtube_moderate_comment` | `write`; `ban` when a confirmation token is present | target **handle**, `status`, `operation_id`, optional `ban_confirmation` | `videos.list`, `comments.list?id=`, then `comments.setModerationStatus` | Receipt state. |
| `youtube_operation_status` | none for the receipt; `read` for the edit observation | `operation_id` | none, except §9.3 | Receipt state. |

### 8.1 Checks, in order, on every request

1. **Account.** One query with owner, account ID, `platform = 'youtube'`, `is_active`, stored `auth_provider = 'native'`. Channel ID and `binding_generation` come from that row, never from the body, and are the **expected** values passed to the claim and the mark. A failed read is an error, never "not found". Foreign and missing accounts get the identical refusal.
2. **Gate.** `feature_youtube_comments` true and the evaluator admits this account for this action's capability. Re-evaluated inside claim and mark.
3. **Video.** `videos.list?part=snippet&id=<video>` with the bound credential returns exactly that ID with `snippet.channelId` equal to the account's channel. Picker membership, public visibility and a commenter's identity prove nothing.
4. **Target.** By handle, then a fresh `comments.list?part=snippet&id=<comment>` immediately before the claim: the comment exists, its `id` matches, `snippet.parentId` equals the handle's parent (absent for a top-level comment), `snippet.channelId` — where present — equals the account's channel, and `snippet.videoId` — where present — equals the handle's video. Edit additionally requires a non-empty `authorChannelId.value` equal to the account's channel. Moderation accepts a foreign author.

The target read uses the `id` filter, for which Google lists `operationNotSupported`; the baseline already depends on the same call (`getYouTubeComment`, `_shared/youtubeComments.ts:570`). If it is refused or returns nothing, the target is unverified and **no write is sent**. A competing change on YouTube after the last check remains possible and is stated in the edit copy.

### 8.2 Rows, identifiers and handles

Three different channel-shaped facts are kept apart and never substituted:

| Fact | Source | Meaning |
|---|---|---|
| **Resource channel** | `commentThread.snippet.channelId`, `comment.snippet.channelId` | The channel the comments belong to. Must equal the account's channel. |
| **Author channel** | `comment.snippet.authorChannelId.value` | Who wrote it. Used only for "may edit" and for ban. Never used as evidence of ownership. |
| **Video owner** | `video.snippet.channelId` | Ownership of the video. Must equal the account's channel. |

Identifier sources:

| Field | Source | Used for |
|---|---|---|
| `thread_id` | `commentThread.id` | grouping, cursor context |
| top-level `comment_id` | `commentThread.snippet.topLevelComment.id` | `parentId` of replies, edit, moderation |
| reply `comment_id` | `comment.id` | edit, moderation |
| `parent_comment_id` | `comment.snippet.parentId` | binding a reply to its thread |
| `video_id` | `commentThread.snippet.videoId` | binding the thread to the video |
| `moderation_status` | that row's own `snippet.moderationStatus`, from a call that did not use the `id` filter | which controls the row gets |

Fixtures use deliberately **unequal** thread and top-level comment IDs.

**A handle is sealed only after the whole chain is consistent.** Before the server returns a row it checks, and drops the row with an `upstream` inconsistency count if any check fails:

1. the video was verified as owned in this request;
2. the thread's `snippet.videoId` equals that video and its `snippet.channelId` equals the account's channel;
3. the top-level comment has no `parentId`, and its `snippet.channelId` and `snippet.videoId`, **when Google returns them**, agree with the thread;
4. every reply's `parentId` equals the top-level comment ID, and its `snippet.channelId` and `snippet.videoId`, when present, agree as well.

The reference page for the comment resource lists no `videoId`; the debate found it defined as an optional field in Google's [discovery document](https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest). The design therefore **never relies on its presence and never ignores a contradiction**: absent is acceptable because the thread carries the binding; present-and-different is a refusal.

The handle is an integrity-protected token holding owner, account, `binding_generation`, resource channel, video, thread ID, comment ID, kind, canonical parent, author channel, observed status and a **30-minute** expiry. Mutations and reply paging accept the handle, not raw IDs. Cursors are bound to owner, account, generation, video, list or parent, and action, expire after 30 minutes, and are validated before their provider page token is used. Malformed, expired, cross-context or cyclic tokens are refused.

### 8.3 Lists

- **Published** asks for `moderationStatus=published`; **Held** asks for `heldForReview`. `likelySpam` is never requested and `rejected` cannot be. There is no third list.
- Replies merge by comment ID across inline previews and reply pages; one bounded page per user action; a failed page keeps earlier rows and offers a retry of that page only.
- A reply to a reply is posted against the canonical parent from the handle.

### 8.4 Held status comes from the visible row only

Google includes a thread in the Held list when "at least one of the replies" is awaiting review, but does not state that the held reply, or its status, is returned by either reply source.

- A row gets Publish or Reject controls as a held comment **only** when that row is on screen and its own status reads `heldForReview`. Status is never inferred from the list a thread came from, from a sibling, or from a count.
- A row whose status is missing or `likelySpam` is read-only, with no moderation controls.
- A thread in the Held list in which no loaded row reads `heldForReview` shows "A reply in this thread is awaiting review, but YouTube did not make it available here", with no action.
- **Rehearsal R-held** (read-only, on a named fixture, separately approved, needs only the `read` and `held` capabilities for that account) records what the two reply sources return. Until then the fake-provider fixtures cover both answers. This document does not authorise it.

## 9. Sending, uncertainty and reconciliation

### 9.1 The authorisation boundary and the single attempt

Fixed order for every Stage 4 write:

1. validate → account → gate → verify video and target (reads; these may use the existing refresh-and-retry freely);
2. **prepare the credential**: obtain an access token that is valid now, refreshing through the existing lease path if needed. A refresh failure ends here with nothing claimed;
3. **claim** with the expected owner, account, channel and generation;
4. **mark dispatched** with the same expected values. **Its successful commit is the final authorisation boundary.** Before it, a disconnect, reconnect, gate change or capability change stops the operation. After it, the one request already authorised is *in flight*: turning the gate off or disconnecting does not, and cannot, recall it, and the receipt will record whatever happens;
5. **exactly one HTTP request**, 15-second timeout, with the token prepared in step 2. There is no second attempt of any kind — **including on `401`**. A `401` with a Google envelope settles as `refused / unauthorized`; the user may submit again as a new deliberate operation;
6. **settle**.

The legacy shared path (`callNative`, `_shared/youtubeComments.ts:206-219`) keeps its one-time `401` refresh-and-resend unchanged for legacy callers. Stage 4 writes do not use it; they use a private transport, because the shared `sendNative` also reports a network failure as the same `upstream` class whether or not the request left the process. Tests count **actual HTTP write requests** and require exactly one per marked operation and zero otherwise.

The browser side: before the first network call of a submit, the client writes `{operation_id, account, video, action, target context}` to browser storage scoped to the signed-in user. On reload it restores the entry and asks for status **before** rendering a composer for that target. A new key is minted only by a new user gesture after the previous key reached a state the user was shown. Storage being unavailable does not unblock a resend: the server fences in §7.5 are the authority, and browser storage only makes the common case smooth. Comment text is not required to be stored for this.

### 9.2 Classification after `dispatched`

| Observation | Receipt | Shown |
|---|---|---|
| Credential preparation fails; claim or mark refuses | `refused`, or no row | Not sent; draft kept. |
| `2xx` with complete, matching evidence — create: thread ID, top-level comment ID, `snippet.videoId` and `snippet.channelId` equal to the request; reply: comment ID and `snippet.parentId` equal to the canonical parent; edit: `id` equal to the target. Moderation: **`204` only** | `confirmed` | Done / "accepted by YouTube". |
| `4xx` with a parseable Google error envelope, including `401` and quota | `refused` with the mapped reason | Not applied; draft kept. |
| Network error, timeout or abort; **any `5xx`**; a `2xx` that is not the expected one or has missing, malformed or mismatched IDs (for moderation, any `2xx` other than `204`); a `4xx` without a Google envelope | **`indeterminate`** | "This may or may not have been applied." |
| Settlement write fails after a real response | stays `dispatched`, then `indeterminate` | Same; logged with `request_id`. |

### 9.3 Read-only reconciliation

Nothing here writes to YouTube. Any reconciliation step that calls Google is a read like any other: it re-checks account, live generation and the `read` capability first, and is refused if they do not hold. The local receipt remains readable regardless.

| Action | Observable afterwards | UI |
|---|---|---|
| Create, reply | Nothing trustworthy. Matching text or time is not proof; a missing row is not proof of failure. | "Refresh the thread." **Never a resend control.** The same logical operation is refused while unresolved. Different text is a different comment. |
| Edit | The channel is the author, so `comments.list?id=` returns `textOriginal`. Status reports `requested_text_observed`, `different_text_observed` or `unavailable` as a separate observation that does not change the receipt and does not claim causation. | Review, then a new deliberate edit if wanted. |
| Hold, publish | The refreshed list shows each visible row's own status. | The list is the truth. |
| Reject, with or without ban | **Nothing.** Rejected comments are not listable, status is not returned by ID, no method reads a ban. **A `404`, or the row disappearing, supports no inference in either direction.** | "Reject may or may not have been applied." A new deliberate Reject with fresh confirmations is allowed only if the target still verifies. |

## 10. Moderation and ban-author

### 10.1 Moderation

- One comment per call; the `id` parameter accepts up to 50 IDs, so the server builds it from the handle's single strict ID.
- Controls follow the visible row's own status: `published` → Reject; `heldForReview` → Publish, Reject; anything else → none. **Hold is not offered on a published row**: Google's implementation guide says a comment that is `published` or `rejected` cannot return to `heldForReview`, and a `204` for that call would be recorded as confirmed while the comment stays public. The handler refuses the transition (`invalid_request`) after its fresh target read and before the claim, with no provider write. Both sides read one constant, `STAGE4_HOLD_FROM_PUBLISHED` in `contractTypes.ts`; once a rehearsal on a real channel shows YouTube applies the transition, setting it to `true` restores the control and the acceptance (and this line).
- Reject is confirmed in a dialog stating both documented consequences: replies are hidden with it, and it cannot be published again through the API. No undo is offered.

### 10.2 Ban-author

Ban is a **separately confirmed native moderator intention**, bound to one exact account, binding, video, comment, author and operation, travelling only on Reject.

1. **Reachability.** Only `youtube_moderate_comment`, only with a user JWT, only on a native account that the rollout policy admits for `ban`. Unreachable through Stage 4 from the service role, the AI agent, workflows, Partner API, n8n and MCP. No registry tool is added. (The pre-existing Composio agent path is F1.)
2. **First confirmation** is the Reject dialog. It carries an unchecked "Also ban this author" option.
3. **Second confirmation is issued by the server, not asserted by the client.** Ticking the option calls `youtube_ban_confirmation` with the target handle and the `operation_id` the Reject will use. The server re-verifies account, generation, `ban` capability and the target by fresh read; requires a non-empty author channel different from the account's own; and returns a sealed token bound to **user, account, `binding_generation`, video, comment, author channel and that `operation_id`**, valid for **120 seconds**. The second dialog names the author (display name as plain text plus channel ID) and states the limits in §10.3; confirming submits the Reject with the token. The client discards the token on cancel at either step and whenever account, video, comment or selection changes.
4. **Use.** `youtube_moderate_comment` accepts `ban_confirmation` only with `status: 'rejected'`. The server checks the seal, expiry and every bound field against the current request and a fresh pre-dispatch read. The token is single-use because its `operation_id` is unique in the receipt table. An echoed author ID alone is never accepted as confirmation.
5. **Wire.** `banAuthor=true` is appended only on this path. **Plain Reject omits the `banAuthor` key entirely** — it is not sent as `false`.
6. **Ambiguity refuses the whole operation, with no effect.** Missing or empty author channel, any mismatch, an expired or re-used token, a target that no longer verifies, a changed binding, or an author equal to the account's own channel: refused before the claim. It is **never** downgraded to a plain Reject.
7. **Limits.** A low per-owner daily cap, server-side.
8. **Activation prerequisite.** The `ban` capability is not enabled for any account until F1 is closed (§15).

### 10.3 What Postora can and cannot say

| Statement | Basis |
|---|---|
| "YouTube accepted the reject-and-ban request for this comment." | A **`204`** to a request carrying `moderationStatus=rejected` and `banAuthor=true`. This is **moderation evidence**: the request was accepted. Nothing else counts as acceptance. |
| "This author is banned." | **Never shown.** No documented method returns it; it is unobservable. |
| "Undo ban." | **Never offered.** The reference documents no method. The copy says Postora cannot show or reverse it and that it is managed in YouTube (general product knowledge, not from the API reference; no specific Studio path is promised). |
| What the ban does | Google's words only: it will "automatically reject any additional comments written by the comment's author". No scope or duration is added. |
| A lost response on reject-and-ban | `indeterminate` for **both** effects together. A later `404` or a vanished row changes nothing. |

## 11. Distinguishing "disabled", "no permission" and "empty"

Scopes per endpoint, from §3 and the existing grant record: every comment endpoint (`commentThreads.list` with `moderationStatus`, `comments.list`, and all four writes) requires the recorded `youtube.force-ssl` grant; `videos.list` and `playlistItems.list` are satisfied by `youtube.readonly` or `youtube.force-ssl`. A capability is reported available only when the scope for its endpoints is recorded.

| Provider result | Classified as | Scope of effect | UI |
|---|---|---|---|
| `200`, zero items, no next token | `empty` | this list | "No comments yet", composer available. |
| `200`, zero items, next token present | continue | this list | The page advances. |
| `403 commentsDisabled` | `comments_disabled` | **this video only** | "Comments are turned off for this video." |
| `403` with an insufficient-scope reason | `scope_missing` | this request | "Reconnect to grant comment access", using the existing reconnect path. **Stage 4 code performs no automatic grant mutation.** |
| `401` | `unauthorized` | this request | Reconnect prompt. |
| `403 forbidden` (other) | `forbidden` | this request | Stated plainly. |
| `403` quota reasons | `quota` | temporary | "YouTube's daily limit was reached." Nothing is retried. |
| `404` reasons | `not_found` | this target | Marked unavailable. |
| `403 ineligibleAccount` | `ineligible_account` | account | Stated plainly. |
| Text errors | `invalid_text` | this draft | Inline, draft kept. |
| Unrecognised, malformed or inconsistent | `upstream` | this request | Error with request reference. |

**No Stage 4 path changes stored grants, `needs_reauth`, `failure_count` or account health.** The reason: the existing `dropGrantedScope` reads metadata and writes it back keyed by account ID alone (`_shared/youtubeGrantedScopes.ts:46-57`), so a late `403` from before a reconnect could remove a grant the reconnect just recorded. Stage 4's private transport does not call it. The legacy path keeps its behaviour and the race is recorded as F7. The mapping lives in a private classifier that wraps the shared one; shared behaviour is unchanged and regression-tested.

## 12. Refusal audit

The existing `public.system_logs` table is the sink, as in `youtube-resources/index.ts:135-151`. **No audit table is added.**

- **Every refusal writes a redacted row**, authenticated or not — AGENTS.md review rule 4 is applied without exception. Fields: `level = 'warn'`, `category = 'edge'`, `source = 'comment-manager'`, and metadata limited to `action` (only if it is one of the known action names; otherwise the literal `unknown`), `reason`, `provider_class`, `request_id`.
- `user_id` is set only once the caller is identified. That includes refusals after identification for invalid JSON, schema failure, and a service-role caller on a Stage 4 action. `account_id` and `operation_id` are added only after they are verified against that owner.
- **Unauthenticated refusals are rate-bounded:** one shared bucket on the existing limiter (`_shared/rate-limiter.ts`) admits at most **30 rows per minute** for the whole function; beyond that, a single counter row per minute records how many were suppressed, and each suppressed refusal still emits a sanitised console event. An anonymous caller therefore cannot grow the table without bound, and silence never occurs.
- **Never logged:** comment text, author names, headers, IP-derived identifiers, credentials, cursors, handles, confirmation tokens, digest keys, provider bodies, or any identifier supplied by a caller that has not been verified.
- If the log insert fails, a sanitised fallback diagnostic is emitted and the response is unchanged.
- A write's durable intent is the receipt row. **If the claim cannot be recorded, nothing is dispatched.**

## 13. Rollout, capabilities and who may change what

**Environment.** One environment: the self-hosted production Supabase at `https://api.postora.cloud` (Dokploy stack `postorasupabase-supabase-j8axyh`). **No staging stack exists.** "Deploy to staging" in the Heavy tier is read as "deploy to production with every capability off", and every live step is Waleed's.

**Gates, all required, all server-side:**

| Gate | Where | Default |
|---|---|---|
| Existing tile flag `feature_youtube_comments` | `app_settings`, browser-readable like every `feature_*` key | As today. Necessary, never sufficient. Also drives Partner entitlement. |
| **Server-only key `youtube_comments_stage4_rollout`** | `app_settings`. Not `feature_`-prefixed and not on the authenticated read allow-list (`20261029170000_media_upload_limits.sql`), so non-admin browsers cannot read the pilot list. Precedent: `collection_instagram_rollout_policy` (`20261031090000`). | **Absent = everything off.** The migration does not seed it. |
| Stored native connection with the endpoint scopes of §11 | account row and grant record | Composio → `provider_unsupported` (A1). |

**Policy shape — per account and per capability:**

```json
{
  "version": 1,
  "accounts": {
    "<social_accounts.id>": { "read": true, "held": false, "write": false, "ban": false }
  }
}
```

| Capability | Admits | Requires |
|---|---|---|
| `read` | uploads picker, Published list, reply pages, the edit observation | — |
| `held` | the Held list | `read` |
| `write` | create, reply, edit, hold, publish, reject | `read` |
| `ban` | the ban confirmation and `banAuthor` | `write`, and F1 closed |

A capability whose prerequisite is false is treated as false. Missing key, unknown version, malformed JSON, missing account, missing or non-boolean capability → deny. A failed read is an **error**, never a deny that looks like "off". There is no wildcard and no "all accounts" mode. Two accounts in one policy are independent: enabling `ban` for one does nothing for the other. The approval order in the plan (read pilot → Held rehearsal → writes → ban) maps one-to-one onto these booleans, so each approval enables exactly what was approved.

**Fail-closed at every boundary.** One SQL evaluator answers at:

- every read action, before any provider call (`read`, and `held` for the Held list);
- the claim and the mark of every write (`write`, and `ban` when present) — the **effect boundary**;
- the ban confirmation (`ban`);
- any reconciliation read that calls Google (`read`).

`youtube_operation_status` is deliberately **not** behind the policy: with every capability off, or the key removed, an owner can still read the local receipt of an operation **under the current binding** (§7.4). Admins get no bypass anywhere.

**No exposure from flags or stale clients.**

- Flipping `feature_youtube_comments` alone exposes nothing new.
- An old frontend against the new backend uses only legacy actions.
- A new frontend against an old backend gets the legacy "Unknown action" answer from `youtube_stage4_capabilities` and renders the baseline inbox.
- A tab left open across a policy change, disconnect or reconnect holds tokens bound to a generation and an expiry; every request re-checks account, generation and capability server-side.

**Separation of permissions.**

| Permission | Holder |
|---|---|
| Approving and applying the migration; merging; deploying; creating or editing the rollout key per account and capability; any live rehearsal | Waleed. `app_settings` writes are admin-only by RLS and the admin role can write any key, so the key is an owner action, not a secret. |
| Using Stage 4 on a channel | The Postora owner of an admitted native account, with their own JWT. |
| AI agent, workflows, Partner API, n8n, MCP | Exactly their baseline capabilities. |

## 14. Interface requirements

- Controls, cache keys, drafts, cursors, handles, confirmation tokens and operation state are scoped to user, account, video and thread, and discarded on account switch and sign-out; a response for a previous selection is dropped.
- Operation identity is stored before the first network call and restored on reload (§9.1).
- The top-level composer is separate from per-row reply controls. A refused submit keeps the draft. A lost response shows a status check, never optimistic success.
- After a disconnect or reconnect — including the one that `scope_missing` asks for — a pending or indeterminate operation from the previous binding answers `not_found`. The client shows "This action was started before the channel was reconnected, so its result can no longer be checked here. Check the video on YouTube." No resend is offered and the server fences still apply.
- Provider and commenter text is rendered as plain text.
- English and Arabic copy for every state in §§9–11; RTL; keyboard reachable; focus returns to the triggering control after a dialog; status changes are announced.
- Code lives under `src/features/youtube-comments/` (`domain`, `application`, `infrastructure`, `ui`) per ARCHITECTURE §3, mounted from the existing panel only when capabilities allow.

## 15. Findings at the baseline that this stage records but does not change

| # | Finding | Handling |
|---|---|---|
| F1 | **The Composio execution boundary forwards model-chosen parameters.** The agent path allow-lists the tool name and requires admin or `allow_writes`, then sends `args.parameters` as given (`ai-agent-reply/composioExecution.ts:102-123`); the moderation tool is on the list (`_shared/connectorRegistry.ts:781-790`). Absence of a field from a cached schema would not prove it is refused at execution. | **Separately tracked prerequisite, not part of this delivery:** a defensive follow-up that builds the permitted moderation parameters at the execution boundary from an allow-list and refuses the whole call otherwise, proven with a fake client (permitted call passes; non-permitted call is refused before the client is invoked). **No exploit reproduction.** Stage 4 ships dark without it; **the `ban` capability must not be enabled for any account until it has merged.** Stage 4's gate does not govern that pre-existing path. |
| F2 | Legacy unhide maps to `published`; the agent guide says "Hiding is reversible" (`_shared/connectorRegistry.ts:797`). Google says a rejected comment cannot be published. | Legacy parity preserved. Separate follow-up. |
| F3 | The legacy account lookup in `comment-manager` checks neither `is_active` nor platform. | New actions do not use it. Follow-up. |
| F4 | Legacy `reply_comment` is unfenced. | Dashboard replies move to the fenced action; the legacy path stays for automation and public callers. Follow-up. |
| F5 | `comment-manager` answers `Access-Control-Allow-Origin: *`. | Existing endpoint, bearer-token auth. No new function is added (ARCHITECTURE §25). Follow-up. |
| F6 | `commentThreads.insert` already exists in `process-post/youtubeUploadFollowUps.ts`, which treats `response.ok` as success without inspecting the body (`:126`, `:171`). | Stage 4 shares **only the request builder** with it. The follow-up is **not** routed through Stage 4's response validator: doing so would turn an incomplete `2xx` from "applied" into something else. Its semantics stay exactly as they are, pinned by a regression test. |
| F7 | `dropGrantedScope` is not generation-fenced (§11). | Stage 4 does not call it. Follow-up for the legacy path. |

## 16. Decisions

No owner decision is open before implementation. Each earlier question is closed as follows; production actions keep their own separate approvals (plan §5).

| # | Question | Disposition |
|---|---|---|
| D1 | F1 | Tracked prerequisite for enabling `ban`; not a blocker for dark implementation. |
| D2 | F2 | Follow-up, outside this delivery. |
| D3 | Hold and Publish as actions | Adopted; roadmap §4 item 7. |
| D4 | Generation column and trigger | Adopted, with the trusted-refresh rule of §6.2. |
| D5 | Audit of unauthenticated refusals | Resolved: rate-bounded redacted rows, no exception to the rule. |
| D6 | Fences across bindings | Adopted, extended with the recent-confirmation fence. |
| D7 | Composio read access to the new lists | Not in Stage 4 (A1). |
| D8 | R-held and live write rehearsals | Not authorised here; separate approvals at enablement. |
