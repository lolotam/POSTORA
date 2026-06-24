# Plan: IG-via-FB account picker (card UI) + LinkedIn single pathway

## Part A — Instagram-via-Facebook account picker

### Problem
`instagram-business-oauth` GET callback (`exchangeAndPersist`, lines 153–201) loops through every Facebook Page with a linked IG Business account and upserts them all into `social_accounts`. User wants to pick one at a time from a card grid (~2–3 inch squares: page/IG logo on top, name below).

The Facebook flow already implements the exact "stash + redirect to picker" pattern we need (`oauth_pending_facebook_selections` table, `?connected=facebook&select=<id>` redirect, `get_pending_selection` POST action, `useFacebookOAuth.loadPendingFacebookSelection`, `PageSelectionDialog`). We'll mirror it.

### Backend — `supabase/functions/instagram-business-oauth/index.ts`
- Split `exchangeAndPersist` into:
  - `exchangeAndListIg(code)` → `{ candidates: [{ ig_user_id, ig_username, ig_profile_picture_url, facebook_page_id, facebook_page_name, page_access_token }], long_lived_token, expires_in }`.
  - `persistOneIgAccount(supabase, user_id, social_profile_id, candidate, expires_in)` → upsert one row using the existing shape (lines 164–195).
- GET callback: after listing, insert candidates into new `oauth_pending_instagram_selections` row and 302 to `${return_to}?connected=instagram_business&select=<id>`. Keep `no_instagram_business` redirect when zero candidates.
- New POST actions (auth via `authenticateCaller`):
  - `get_pending_selection` → returns `{ success, social_profile_id, ig_accounts: [{ ig_user_id, ig_username, ig_profile_picture_url, facebook_page_name }] }`. Page tokens never leave the server.
  - `store_ig_account` → `{ selection_id, ig_user_id, social_profile_id? }`. Loads stash row, finds the matching candidate, calls `persistOneIgAccount`, returns `{ success, ig_username, facebook_page_name }`. Stash row is **not** deleted until `clear_pending_selection` (or natural expiry), so the user can connect multiple IG accounts from the same picker.
  - `clear_pending_selection` → `{ selection_id }` deletes the stash row.

### Database — manual SQL (per project rule, not executed)
New file: `supabase/manual-sql/20260624_instagram_pending_selections.sql`. Mirrors `oauth_pending_facebook_selections`:

```sql
CREATE TABLE IF NOT EXISTS public.oauth_pending_instagram_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  social_profile_id UUID,
  ig_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  long_lived_token TEXT NOT NULL,
  expires_in INTEGER NOT NULL DEFAULT 5184000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes')
);
GRANT SELECT ON public.oauth_pending_instagram_selections TO authenticated;
GRANT ALL ON public.oauth_pending_instagram_selections TO service_role;
ALTER TABLE public.oauth_pending_instagram_selections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pending ig selection read"
  ON public.oauth_pending_instagram_selections
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_oauth_pending_ig_expires
  ON public.oauth_pending_instagram_selections (expires_at);
DELETE FROM public.oauth_pending_instagram_selections WHERE expires_at < now();
```

### Frontend
- `src/hooks/oauth/useInstagramOAuth.ts`: add `igSelectionData`, `selectingIg`, `loadPendingInstagramSelection`, `handleSelectIgAccount`, `clearIgSelection`.
- `src/hooks/useProfileOAuth.tsx`: expose them.
- `src/hooks/oauth/useOAuthRedirectHandler.ts`: handle `?connected=instagram_business&select=<id>` and call `loadPendingInstagramSelection`, then strip params.
- New component `src/components/profiles/InstagramSelectionDialog.tsx`:
  - `AlertDialog` `max-w-2xl`.
  - Search input (filters username + page name).
  - Grid: `grid grid-cols-2 sm:grid-cols-3 gap-3`. Each card `aspect-square` ~200px (≈2 inches at typical DPI).
  - Card content stacked, centered: profile picture (rounded, ~72px) on top → fallback to Instagram glyph; `@username` below; small `via {facebook_page_name}` line under it.
  - Click → `onSelect(ig_user_id)`. While `selectingIg === ig_user_id` overlay a spinner. Dialog stays open after a success so additional accounts can be picked; "Done" button calls `clearIgSelection` (which invokes `clear_pending_selection`) and closes.
- `src/pages/Profiles.tsx`: mount `<InstagramSelectionDialog ... />` next to the existing `<PageSelectionDialog />`.

---

## Part B — LinkedIn single pathway (revert)

### Goal
Remove the LinkedIn flow-choice dialog. One LinkedIn connect click runs a single OAuth that requests both member and organization scopes, then stores the member account plus all organizations the user can administer — same end-state as before the dual-flow split. The user picks where to publish from inside the app afterward.

### Backend — `supabase/functions/linkedin-oauth/index.ts`
- Remove the `flow` branch in the `authorize` action (lines ~152–190). Always build the unified scope list (member + organization scopes) — same scopes the `organization` branch currently sends.
- Remove `flow` from the signed state payload.
- In the GET callback (lines ~118–130), drop the `linkedin_organization` marker; always 302 with `?connected=linkedin`.
- Existing org-listing/persistence path (line ~424 onward, `organizationAcls`) stays — it already saves all manageable Company Pages. The member account is also stored as before.
- `include_org_scopes` body override removed (no longer needed; soft-deprecate).

### Frontend
- Delete `src/components/profiles/LinkedInConnectDialog.tsx`.
- `src/hooks/oauth/useLinkedInOAuth.ts`: simplify `handleLinkedInConnect(profileId)` (no `flow` arg, no body field). Remove `connectLinkedInPersonal` / `connectLinkedInOrganization` exports and the `LinkedInFlow` type export.
- `src/pages/Profiles.tsx`:
  - Remove `LinkedInConnectDialog` import, `linkedinConnectProfileId` state, the `if (platform === "linkedin") { setLinkedinConnectProfileId(...); return; }` branch, and the `<LinkedInConnectDialog ... />` JSX.
  - LinkedIn click now falls through to `originalHandleConnectPlatform(profileId, "linkedin")`, which already calls `handleLinkedInConnect`.
- `src/hooks/oauth/index.ts` / any re-exports: drop the `LinkedInFlow` re-export.
- `src/hooks/oauth/useOAuthRedirectHandler.ts`: nothing to change — already handles `connected === "linkedin"`. The now-unused `linkedin_organization` marker can be removed if referenced.

---

## Files

| File | Change |
|------|--------|
| `supabase/functions/instagram-business-oauth/index.ts` | Stash candidates instead of bulk insert; add `get_pending_selection`, `store_ig_account`, `clear_pending_selection` POST actions |
| `supabase/manual-sql/20260624_instagram_pending_selections.sql` | New manual SQL (table + RLS + grants + sweep) |
| `src/hooks/oauth/useInstagramOAuth.ts` | Add IG selection state + handlers |
| `src/components/profiles/InstagramSelectionDialog.tsx` | New card-grid dialog |
| `src/hooks/oauth/useOAuthRedirectHandler.ts` | Hand off `?connected=instagram_business&select=<id>` |
| `src/hooks/useProfileOAuth.tsx` | Expose new IG selection state/handlers |
| `src/pages/Profiles.tsx` | Mount IG dialog; remove LinkedIn flow-choice branch and dialog |
| `supabase/functions/linkedin-oauth/index.ts` | Remove flow branching; always request unified scope set |
| `src/hooks/oauth/useLinkedInOAuth.ts` | Drop `flow` arg and flow-specific helpers |
| `src/components/profiles/LinkedInConnectDialog.tsx` | **Delete** |
| `src/hooks/oauth/index.ts` | Drop `LinkedInFlow` re-export if present |

## Out of scope
- Facebook bulk-page flow.
- Direct Instagram Business Login (`instagram-oauth`).
- LinkedIn token-refresh/posting code.
- n8n, scheduling, posting pipelines.
- Historical migrations.

## Manual steps for the project owner
1. Run `supabase/manual-sql/20260624_instagram_pending_selections.sql` on the self-hosted Supabase.
2. Redeploy edge functions on Contabo:
   ```bash
   npx supabase functions deploy instagram-business-oauth linkedin-oauth --project-ref efruibswazzuuupgyzmf
   ```
3. Confirm LinkedIn app in Developer Portal still has all member + organization scopes approved (no scope additions; the unified set is the same union previously sent only in `organization` mode).

## Final status if implemented
`blocked pending manual SQL` until the new IG pending-selections table is created; LinkedIn change ships immediately.
