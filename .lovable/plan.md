## Part 1 — Persist & reuse searches on `/analytics/threads`

Today only the **Keyword Search** tab saves recent searches (via the existing `threads_recent_searches` table + dropdown). The **Analyze** and **Discovery** tabs both use `BrandSearchBar` (username input) with no history.

### Changes
1. **DB (manual SQL only — per project rules):**
   `supabase/migrations/<ts>_brand_search_history.sql`
   - New table `public.brand_search_history`:
     - `id uuid pk`, `user_id uuid`, `platform text` (`threads` for now, extensible), `scope text` (`analyze` | `discovery`), `query text`, `last_used_at timestamptz`, `use_count int`, `created_at`.
     - Unique on `(user_id, platform, scope, lower(query))`.
   - GRANTs to `authenticated` (CRUD) and `service_role` (ALL); RLS = `auth.uid() = user_id`.
   - Rollback note included.

2. **Frontend — `BrandSearchBar`:**
   - Accept new optional props `platform` (already passed) and `scope: "analyze" | "discovery"`.
   - On focus / typing, show a dropdown of the user's previous searches for that (platform, scope), ordered by `last_used_at desc`, with a per-row "×" to delete.
   - On successful search submit, upsert into `brand_search_history` (increment `use_count`, bump `last_used_at`).
   - Click a row → fill input and trigger `onSearch`.

3. **ThreadsAnalytics.tsx:**
   - Pass `scope="analyze"` to the BrandSearchBar in the Analyze tab and `scope="discovery"` to the one inside `ThreadsDiscoveryPanel`.

4. **Keyword Search tab:** already has saved searches — no change.

## Part 2 — Instagram messaging/comments audit & debug

### A. Scope/permission audit
Current IG scopes (`instagram-business-oauth/index.ts`):
`pages_show_list, pages_read_engagement, business_management, pages_manage_metadata, instagram_basic, instagram_content_publish, instagram_manage_comments, instagram_manage_insights`

Findings:
- ❌ **Missing `instagram_manage_messages`** — required for Instagram DM Inbox (`/{page-id}/conversations?platform=instagram` + sending). This is the primary reason the Instagram Inbox is empty while Facebook works.
- ⚠️ **`instagram_manage_insights`** is needed for post likes/insights counts; OK.
- ⚠️ For mentions/comments-on-comments visibility we may also want `instagram_manage_comments` (already present) + the IG account must be **Business or Creator** linked to a FB Page (verify in account metadata at connect time).

Action:
- Add `instagram_manage_messages` to META_SCOPES.
- Show a one-time reconnect banner on `/messaging/instagram` when an active IG account is missing this scope (detected via stored `granted_scopes`/account_metadata, or by a 10/200 Graph error code).

### B. Why Instagram comments/messages/likes look incomplete

`comment-manager`:
- IG comments are fetched via `/{ig_user_id}/media?fields=...,comments{...}` with `limit=25` (only last 25 media, only the first page of comments per media, no pagination). For active accounts this drops older media and replies-to-replies.
- IG Graph returns the `from{id,username}` of a comment **only** when the commenter is a Business/Creator account or the post owner. Personal commenters return `from = null` — currently rendered as "Unknown", and on some API errors the whole `comments` edge is dropped silently.
- Likes are not fetched at all for IG (no `like_count` field requested on media).

`messaging-api` (Instagram Inbox):
- Uses `/{pageId}/conversations?platform=instagram` — this is the correct endpoint, but it requires `instagram_manage_messages` (missing above). Without it the response is empty / 200 with `data: []`, which the UI shows as "no messages".
- 24-hour messaging window + webhook subscription must be active on the Page → IG account for new DMs to surface in `conversations`.

### Fixes (frontend + edge, no business-logic changes beyond what's needed to fetch)
1. **`instagram-business-oauth/index.ts`** — add `instagram_manage_messages` to scopes; persist `granted_scopes` from the token exchange into `social_accounts.account_metadata.granted_scopes` so the UI can detect missing scopes.
2. **`comment-manager/index.ts` — `get_ig_comments`:**
   - Request fields `id,caption,timestamp,like_count,comments_count,comments.limit(50){id,from{id,username},text,timestamp,hidden,username,replies{id,from{id,username},text,timestamp,hidden,username}}` with `limit=50` on media.
   - Add `after` pagination param so the UI can load older media.
   - On per-media `comments` error, return the media item with `comments: []` instead of dropping it.
3. **`messaging-api/index.ts` — `get_conversations` (IG):**
   - Detect Graph error subcode `10` / `200` (permission) and return a structured `{ ok:false, reason:"missing_scope", scope:"instagram_manage_messages" }` so the inbox UI can render a "Reconnect Instagram" CTA instead of an empty list.
4. **UI:**
   - `CommentManagerPanel` (Instagram): show `like_count`, `comments_count` from the new fields; render replies under each comment; add a "Load more" button using pagination.
   - `MessagingInbox` (Instagram): when `reason === "missing_scope"`, show reconnect banner targeting `/profiles` → Instagram Business reconnect.

### Known IG platform limitations (will be surfaced in UI, not "fixed" — informational)
- IG Graph only returns DMs received **after** the IG account was linked to the Page and the webhook subscription was created. Historical DMs predating connection are not retrievable.
- Comments from non-Business personal accounts appear without `from` (Meta privacy limitation).
- Likes per post are exposed via `like_count` only (no per-user list).

## Files changed
- `supabase/migrations/<ts>_brand_search_history.sql` (new, manual)
- `src/components/brand-intelligence/BrandSearchBar.tsx`
- `src/hooks/useBrandSearchHistory.ts` (new)
- `src/pages/analytics/ThreadsAnalytics.tsx` (pass `scope`)
- `src/components/brand-intelligence/ThreadsDiscoveryPanel.tsx` (pass `scope`)
- `supabase/functions/instagram-business-oauth/index.ts` (scopes + persist granted scopes)
- `supabase/functions/comment-manager/index.ts` (IG fields/pagination/likes)
- `supabase/functions/messaging-api/index.ts` (IG missing-scope structured error)
- `src/components/comments/CommentManagerPanel.tsx` (likes, replies, load more)
- `src/components/messaging/MessagingInbox.tsx` (missing-scope CTA)

## Database changes
Manual SQL file only — `brand_search_history` table + RLS + GRANTs. Owner runs it on self-hosted Postgres.

## Env changes
None.

## Deployment notes
- Sync `instagram-business-oauth`, `comment-manager`, `messaging-api` to the self-hosted `functions` volume and restart only the functions container.
- After deploy, existing Instagram accounts must **reconnect once** to grant `instagram_manage_messages`. The UI banner will prompt them.

## Remaining manual actions
- Run the new SQL migration on self-hosted Postgres.
- In Meta App Dashboard, confirm `instagram_manage_messages` is enabled on the app (already part of IG Graph standard permissions; App Review required for non-tester users).

## Final status
`completed_requires_manual_sql` + `ready_for_provider_console_update` after I implement.
