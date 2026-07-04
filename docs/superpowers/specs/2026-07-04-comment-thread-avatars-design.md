# Avatar support for Facebook conversations, comment manager, and Threads replies

## Context

Instagram DM conversation avatars (`/messaging/instagram`) already work end-to-end and are live in production. This spec covers the remaining gaps the user identified:

1. Facebook conversation avatars (`/messaging/facebook`) — reported still not showing.
2. Instagram comment-manager commenter avatars.
3. Facebook comment-manager commenter avatars.
4. Threads mentions avatars — reported as needing a fix.
5. Threads reply avatars — reported as needing a fix.

All root causes below were confirmed with live evidence against the production Meta Graph API and the production database (Contabo self-hosted stack), not assumption. Two of the five "problems" turn out not to be buildable the way the user described, for reasons rooted in what Meta's APIs expose — this spec documents that honestly rather than building something that can't work.

## Root-cause findings (evidence-based)

### 1. Facebook conversation avatars — confirmed code bug, fixable

`messaging-api/index.ts`'s `fetchParticipantProfile()` requests `fields=name,username,profile_pic` for **every** platform. Live-tested against a real production Facebook Page token (`Xsellpoint`, confirmed valid via `debug_token` with `pages_messaging` scope for the correct page):

```
GET /{PSID}?fields=name,username,profile_pic  →  error 100/33 "Object does not exist"
GET /{PSID}?fields=first_name,last_name,profile_pic  →  200 OK, real profile_pic URL returned
```

`name` and `username` are Instagram-only fields on Meta's identity APIs. Facebook's Messenger User Profile API only recognizes `first_name`/`last_name`/`profile_pic`. Requesting an unrecognized field on this endpoint fails the **entire** call (unlike nested `participants{}` expansions, which just silently drop unsupported fields) — so every Facebook avatar lookup has been failing 100% of the time, silently, since the field list is shared with Instagram. This is why `messaging_cache` currently has zero Facebook rows despite 25+ Instagram rows.

This is a genuine, fully fixable code bug — not a Meta permission gap.

### 2. Instagram comment-manager avatars — Meta platform limitation, best-effort only

Confirmed against Meta's official docs (Instagram Graph API Comment reference, Messenger Platform User Profile API docs):
- The IG Comment object's `from` field only exposes `id` and `username` — there is no picture field on comments at all.
- The only way to get a photo is the same per-user profile lookup DM conversations use, but that API's consent model is explicit: consent is established only when a user **messages** the business (or taps an icebreaker/persistent menu) — commenting alone does not qualify.

There is no reliable way to fetch a real photo for someone who has only ever commented, never messaged. Per the approved approach, we reuse what's already been resolved for messaging: if a commenter's ID also appears as a DM participant we've already cached an avatar for, show that avatar for free. Everyone else shows initials, exactly as today.

### 3. Facebook comment-manager avatars — feasible today, no extra permission

Confirmed against Meta's docs (Comment reference, User `picture` field: "Permissions: None"): a Facebook Comment's `from` field expands to a full User/Page object, and `picture` is public data requiring no special scope or Feature — this is a completely different code path from Messenger PSIDs (which are gated by Business Asset User Profile Access). None of the currently-connected Facebook pages have live comments to test the exact field-expansion response against, so this needs a real-comment smoke test during implementation (see Testing). If Meta ever silently drops the field, the UI degrades to initials exactly like every other avatar in this codebase — no functional risk either way.

### 4. Threads mentions avatars — pipeline already correct; DB has 2 stale legacy rows

`threads-mentions/index.ts` and `threads-webhook/index.ts` both already fetch `threads_profile_picture_url` per unique mention author and cache it to Cloudinary — this is the same working pattern as Instagram DMs. The only two rows in `threads_mentions` in production both have `mention_author_id = NULL`, dated from a one-time batch backfill (both rows share the identical `created_at` timestamp, from a bulk insert, not the live poll/webhook path) that predates ID capture. Per the user's decision, this will be verified live during implementation (trigger a real mentions sync against a connected account) rather than assumed. If the live pipeline in fact populates ID + avatar correctly for a fresh row, **no code change is needed** for this item — only a note that the 2 legacy rows are harmless stale data.

### 5. Threads reply avatars — hard Meta API limitation, not buildable as originally scoped

This finding reverses part of what was verbally proposed earlier in this task. Live-tested directly against Meta's Threads Graph API on a populated reply set (account with 5 real external replies):

```
GET /{media-id}/replies?fields=id,username                    → id, username only
GET /{media-id}/replies?fields=id,username,owner{id,username}  → owner{} silently dropped
GET /{media-id}/replies?fields=id,username,user{id,username}   → user{} silently dropped
GET /{media-id}/replies?fields=id,username,user_id,from        → both silently dropped
```

The Threads Reply object exposes **no author ID field at all** — only `username` (a display string, not a stable identifier). Without an ID, there is no way to call the profile-picture lookup API for an arbitrary replier, and Threads has no username→ID or username→avatar lookup for third parties (no Business Discovery equivalent). This is a hard platform limitation, confirmed empirically, not a gap in Postora's code.

The only avatars a reply can ever show are:
- The connected account replying to its own thread (already handled — `selfAvatar`).
- A replier whose `username` also appears in `threads_mentions` with a cached avatar (already handled today via `ThreadsAuthorAvatarContext.getAvatar(username)`).

**Conclusion: item 5 needs no new code.** It is already running the best available strategy given what Meta exposes. The user's "6 places" is really 5 buildable improvements plus 1 confirmed platform ceiling — this will be stated plainly rather than silently dropped.

## Changes

### A. Fix Facebook conversation avatar field bug (`supabase/functions/messaging-api/index.ts`)

- `fetchParticipantProfile()`: branch the requested fields by platform instead of using one shared list.
  - Facebook Messenger (`platform !== "INSTAGRAM"` and not direct-IG): `fields=first_name,last_name,profile_pic`. Compose `name` from `first_name + " " + last_name` (trimmed), falling back to `null` if both are empty.
  - Instagram (business-login or direct-login): unchanged, `fields=name,username,profile_pic`.
- Add a `participant_id text` column to `messaging_cache` (additive migration, nullable, backfilled going forward only — existing rows keep `participant_id = NULL`). Populate it in `cacheParticipantAvatar()`'s upsert going forward. Add an index on `(user_id, participant_id)` for the read pattern needed by change C below.
- One-time data fix: since Facebook has zero cached rows today (confirmed via production query), there is nothing to force-expire — the migration is additive-only and the code fix takes effect on every Facebook conversation's next load.

### B. Facebook comment-manager avatars (`supabase/functions/comment-manager/index.ts`, `src/hooks/useCommentInbox.ts`, `src/components/comments/CommentList.tsx`)

- `get_page_comments`: change the feed query's field expansion from `comments{id,from,message,created_time,is_hidden,comment_count,parent}` to `comments{id,from{id,name,picture},message,created_time,is_hidden,comment_count,parent}`.
- `Comment` interface (`useCommentInbox.ts`): add `author_avatar?: string | null`.
- `parsePageComments()`: map `c.from?.picture?.data?.url` (Facebook's `picture` field expansion returns `{data:{url, is_silhouette, ...}}`, not a bare string) into `author_avatar`. If `is_silhouette` is `true`, treat as no avatar (`null`) — a silhouette is Meta's placeholder for "no real photo," not a usable image, matching how the existing FB Messenger `/picture` edge probe behaved in this same investigation.
- `CommentList.tsx`: add an `Avatar`/`AvatarImage`/`AvatarFallback` (matching the exact pattern from `ConversationList.tsx`) before the existing author name, for both Facebook and Instagram comment rows (Instagram rows will just always fall back to initials or the DM-overlap avatar from change C).
- No Cloudinary caching needed here: comments are fetched live on every request (no persistent Comment table), and Facebook's public `picture` URLs don't carry the same short-lived-token expiry as Messenger's `profile_pic` — passing the URL straight through keeps this consistent with the rest of `comment-manager`'s fully-stateless design.

### C. Instagram comment-manager avatars via DM overlap (`supabase/functions/comment-manager/index.ts`)

- In `get_ig_comments`, after building the comment list, collect the unique set of `from.id` values (commenter IGSIDs) across all comments and replies.
- Query `messaging_cache` (added `participant_id` column from change A) for rows where `user_id = <the authenticated user>` and `participant_id` is in that set, selecting `participant_id, participant_avatar`.
- Merge matched avatars into each comment's new `author_avatar` field. Unmatched commenters get `author_avatar: null` (renders as initials, unchanged from today).
- **Assumption to validate during implementation**: that an IG comment's `from.id` (IGSID) is the same identifier space as a DM conversation participant's `id` for the same IG Business Account. Both are documented as IGSIDs scoped to the same business account, so they should match — this will be confirmed with a real account that has both a DM history and comment engagement from the same person, if one can be found; otherwise it degrades harmlessly to "no matches, all initials," same as today.

### D. Threads mentions — verification only, no code change unless broken

- During implementation, invoke `threads-mentions` with `action: "refresh"` against a connected Threads account (this is the existing sync action, confirmed in the function source) and inspect the resulting `threads_mentions` row for a populated `mention_author_id` and `mention_author_avatar_url`.
- If it works: no code change. Document that the 2 existing production rows are pre-existing stale/backfilled data, harmless.
- If it's actually broken: diagnose live (same evidence-based method used in this task) and fix within this same task, updating this spec section before implementation is considered complete.

### E. Threads reply avatars — no new code

- No implementation. `ThreadsReplyCard` and `useThreadsAuthorAvatars` already implement the best available strategy (self-avatar + mentions-table cross-reference by username).
- Document this finding for the user directly: Threads' Reply API does not expose a replier's ID, only a display username, so a third party's real avatar cannot be resolved for replies in general — this is a Meta platform ceiling, not a Postora gap.

## Data flow summary

```
Facebook conversation avatar (fixed):
  messaging-api list_conversations
    → resolveParticipantAvatar()
    → fetchParticipantProfile() [platform-correct fields now]
    → cacheAvatarToCloudinary()
    → messaging_cache upsert (participant_id now populated)
    → ConversationList/ConversationDetail render AvatarImage

Facebook comment avatar (new):
  comment-manager get_page_comments
    → Graph feed fetch with from{picture}
    → parsePageComments() maps picture.data.url (unless is_silhouette)
    → CommentList renders AvatarImage directly (no caching layer)

Instagram comment avatar (new, best-effort):
  comment-manager get_ig_comments
    → Graph media fetch (unchanged, no picture field available)
    → collect commenter IGSIDs
    → query messaging_cache by participant_id (already populated by DM flow)
    → merge author_avatar into comments
    → CommentList renders AvatarImage or falls back to initials
```

## Error handling

- All new Graph API field additions follow the codebase's existing convention: never throw on a missing/blocked avatar field, return `null`, let the UI fall back to initials. No new error paths are introduced.
- The Facebook conversation fix preserves the existing silent-failure behavior for genuinely unavailable participants (e.g., deleted accounts) — only the field names change, not the error handling shape.
- The `messaging_cache.participant_id` migration is additive and nullable; no backfill migration touches existing rows, so there is no risk of a migration failure affecting live data.

## Testing

1. `npx tsc --noEmit` after all edits.
2. Facebook conversation avatars: reload `/messaging/facebook` for the Xsellpoint (or any) connected Facebook page with existing conversations; confirm real photos appear (not initials) and confirm new `messaging_cache` rows for `platform = 'facebook'` exist with non-null `participant_avatar` and `participant_id`.
3. Facebook comment-manager avatars: reload the Facebook tab of comment manager against a page with a real comment (may require posting/waiting for one, since no currently-connected page has live comment engagement); confirm avatar renders, confirm `is_silhouette` handling doesn't show a blank placeholder as if it were a real photo.
4. Instagram comment-manager avatars: find or create an account that has both a DM conversation and a comment from the same person; confirm the same avatar appears in both places. Otherwise confirm graceful initials fallback with no errors.
5. Threads mentions: trigger a live sync, confirm a fresh row gets `mention_author_id` and `mention_author_avatar_url` populated. If broken, fix and re-verify.
6. Threads replies: no code change — confirm existing behavior is unchanged (no regression) by loading the Replies tab for an account with real replies.
7. `clean-code-guard` pass on all changed production files; `test-guard` on any changed/added tests.

## Deployment

- `messaging-api` and `comment-manager` are edge functions on the self-hosted Contabo Supabase stack — require the manual SSH-based deploy method (per project runbook / prior session's proven approach), not `git push` alone.
- The `messaging_cache.participant_id` migration must be applied to the production Postgres instance directly (self-hosted, no automatic migration runner confirmed in this environment — apply via the same SSH/psql access used for this investigation, or via the project's standard migration process if one exists).
- Frontend changes (`CommentList.tsx`, types) deploy automatically via Dokploy on push to `main`/the working branch's merge, per standard project flow.
