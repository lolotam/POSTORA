
# CleanCodeGuard Review — Facebook OAuth Backend-Callback Migration

Review mode (no edits). Scope: `supabase/functions/facebook-oauth/index.ts`, `src/hooks/oauth/useFacebookOAuth.ts`, `src/hooks/oauth/useOAuthRedirectHandler.ts`, `supabase/manual-sql/20260623_facebook_pending_selections.sql`.

## Findings — by severity

### High

1. **`get_pending_selection` accepts caller-supplied `user_id` (auth/scoping bug)** — `supabase/functions/facebook-oauth/index.ts` ~L498 + L580.
   `authenticateCaller(req, body.user_id)` derives the trusted `user_id` from the bearer token, then `loadPendingSelectionRow` is called with that `user_id` and compares it to `data.user_id`. That is correct, **but** the row was written under the OAuth GET callback using `state.user_id` (signed state). If a caller acquires a `selection_id` (e.g. from a leaked redirect URL) and presents *their own* valid bearer token, the row will be rejected — good. However the legacy `store_page` / `store_instagram` branches still allow a `provider_token` in the request body and let any authenticated user store a page against their own `user_id`. That preserves existing behavior, but the new `selection_id` path must keep the strict `row.user_id === auth.userId` check forever. Add a code comment so a future edit doesn't loosen it. Rule 15/22.

2. **`provider_token` stored in plaintext in `oauth_pending_facebook_selections`** — SQL file + edge function L431.
   Long-lived (≈60-day) user tokens are written to a new table with a 15-minute `expires_at` *but no cleanup job*. If the row is never consumed (user abandons flow), the token sits for 15 min and then lingers forever — RLS hides it from `authenticated`, but it's still on disk. Two concrete fixes:
   - Add a `pg_cron` job or `DELETE ... WHERE expires_at < now()` sweep (note in the SQL file).
   - Delete the row in **all** terminal paths, not only after `store_page` success (currently `store_instagram` success path was not visible in the excerpt — verify it also deletes `pendingSelectionId`).
   Rule 15.

### Medium

3. **Two parallel connect flows with overlapping state** — `useFacebookOAuth.ts`.
   `handleFacebookConnect` (JS SDK, `providerToken` in memory) and `handleFacebookConnectBackend` (selection_id) both populate the same `PageSelectionData`. `handleSelectPage` branches on `selectionId ?? providerToken`. This is fine short-term, but the legacy path is the one to retire — add a `// TODO(remove-legacy-fb-sdk): …` marker and a deprecation comment on `handleFacebookConnect` so it isn't accidentally extended. Rule 14 (no speculative kept-alive code without a sunset note).

4. **Silent swallow in `loadPendingFacebookSelection`** — `useFacebookOAuth.ts` L220.
   On error the function toasts "Connection expired" regardless of the actual failure (network error, 500, 404). Distinguish 404 (expired) from other errors so users aren't told their link expired when the function is down. Rule 15 (no broad catch-all that hides the real failure mode).

5. **`useOAuthRedirectHandler` effect dependency list is incomplete** — L98.
   The middle effect's dep array is `[searchParams, user]` but the body calls `handlers.*` and `setSearchParams`. React-hooks lint will flag this; the new Facebook branch in the third effect (L101–L136) also reads `handlers.loadPendingFacebookSelection` but the dep array is `[searchParams, toast, setSearchParams]` — missing `handlers`, `user`, `queryClient`. Behavior is fine today because effects re-run on `searchParams` changes, but this is fragile.

### Low

6. **Magic strings duplicated** — `FB_OAUTH_SCOPES` in the edge function and the same scope list inline in `useFacebookOAuth.handleFacebookConnect` L57–L66. DRY (rule 11): one source of truth; the legacy SDK path should import from a shared module or accept scopes from the server.

7. **`safeReturnTo` only allows `*.postora.cloud`** — fine for prod, but local dev (`localhost`) and the Lovable preview host will silently fall back to `https://postora.cloud/profiles`, which can confuse devs testing the flow. Consider allowing `localhost` when `Deno.env.get("ENV") !== "production"`. Optional.

8. **`pages_json` shape leaks an internal `has_instagram` flag without typing** — the server builds `{id,name,has_instagram}` (L432–L436) but the client `FacebookPage` interface allows `has_instagram?: boolean`. OK, just note the shape contract in a comment so the two stay aligned. Rule 22.

9. **Long file** — `supabase/functions/facebook-oauth/index.ts` is now ~1051 lines, above the project's 400–500 line guideline (core memory). Splitting `handleFacebookGetCallback`, `store_page`, `store_account`, and the helpers into separate modules under `supabase/functions/facebook-oauth/_lib/` would help. Not blocking; flag for follow-up.

## Imperatives checklist (delta only)

- Names reveal intent ✅
- Functions ≤20 LoC ❌ (`store_account` ≈ 150 LoC, `handleFacebookGetCallback` ≈ 110 LoC) — pre-existing, refactor out of scope for this change.
- ≤4 params ✅ except `mergeUpsertInstagram` (10) — pre-existing.
- No swallowed errors ⚠️ see finding 4.
- No hardcoded success returns ✅
- Read-before-write, neighbor style match ✅
- Refactor preserves behavior ✅ (legacy SDK path intact).

## Recommendation

**Completed with warnings.** No blocking bugs in the new code, but address findings 1, 2, 4, 5 before declaring the migration done. Findings 3, 6, 7, 8, 9 are follow-ups.

No code edits performed (review mode + plan mode). If you want me to apply fixes for findings 1–5, approve this plan and I'll implement them in build mode.
