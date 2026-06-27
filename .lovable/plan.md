# LinkedIn OAuth "Connect" Failure — Root Cause + Fix

## Root cause (confirmed in code)

The `authorize` action in the LinkedIn edge function requires `user_id` in the request body, but the client hook never sends it. Every "Connect LinkedIn" click therefore throws inside the function and is caught by the generic handler, which returns a sanitized 500. From the user's side this looks like "the function returned an error and we never reach the LinkedIn login page".

Evidence:

- `src/hooks/oauth/useLinkedInOAuth.ts:23-29` — client body is `{ action: "authorize", social_profile_id, return_to }`. No `user_id`.
- `supabase/functions/linkedin-oauth/index.ts:152,156` — server reads `body?.user_id` and throws `"Missing user_id"` if absent.
- `supabase/functions/linkedin-oauth/index.ts:301-326` — global `catch` returns `{ error: "Authentication failed. Please try again." }` with status 500. `supabase.functions.invoke(...)` surfaces this as `{ data: null, error }`, the hook hits `throw new Error("No authorization URL received")`, the browser never navigates to LinkedIn.

The `callback` action already does this correctly via `authenticateCaller(req, body?.user_id)` (line 201). The `authorize` action was missed.

This is unrelated to deployment — even a freshly redeployed function will fail the same way. Still, since the user said they're "not sure" the function is in sync on the VPS, the plan includes a sync + restart runbook so the fix actually reaches production.

## Fix

### 1. `supabase/functions/linkedin-oauth/index.ts` — derive `user_id` from the caller's JWT

Replace the body-trust pattern in the `authorize` branch (around lines 148–157) so it mirrors the `callback` branch and the rest of the codebase:

```ts
if (action === "authorize") {
  if (!LINKEDIN_CLIENT_ID) throw new Error("LINKEDIN_CLIENT_ID not configured");
  if (!LINKEDIN_CLIENT_SECRET) throw new Error("LINKEDIN_CLIENT_SECRET not configured");

  // Authenticate from JWT; accept optional body user_id as a hint only.
  const auth = await authenticateCaller(req, body?.user_id);
  const userId = auth.userId;

  const socialProfileId = (body?.social_profile_id as string | null | undefined) ?? null;
  const returnTo = body?.return_to as string | undefined;
  if (!returnTo) throw new Error("Missing return_to");
  // ... rest unchanged (state, scopes, auth URL build)
}
```

No other changes to scopes, redirect URI logic, signed-state, or the `callback`/`refresh`/`disconnect` branches. This keeps the existing security model (auth from JWT, not from request body) and resolves the failure.

### 2. `src/hooks/oauth/useLinkedInOAuth.ts` — pass `user_id` defensively

So the fix also works against the currently-deployed function if redeploy is delayed:

```ts
body: {
  action: "authorize",
  user_id: user.id,
  social_profile_id: profileId,
  return_to: `${window.location.origin}/profiles`,
},
```

`user` is already pulled from `useAuth()` in the hook; this is a one-line addition.

### 3. Improve error surfacing in the hook (small DX win)

Right now the `try` block in `handleLinkedInConnect` re-throws without a toast, so the caller sees a vague failure. Add the same toast pattern the `callback` shim already uses, so future failures show the server-returned message instead of being silent.

## Deployment to self-hosted Supabase (required per project rules)

Lovable cannot deploy edge functions to api.postora.cloud — must be done manually on the Contabo VPS. After the file edits land:

1. SSH to `86.48.2.205` (use `ssh-contabo-mcp`).
2. Sync the updated function source to the functions volume:

   ```
   /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/linkedin-oauth/index.ts
   ```

   Diff-verify against `supabase/functions/linkedin-oauth/index.ts` from this repo (sha256sum both sides).

3. Restart only the functions container:

   ```
   cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
   docker compose up -d --no-deps functions
   ```

4. Smoke test from the browser: open `/profiles`, click Connect LinkedIn. Expected: immediate redirect to `https://www.linkedin.com/oauth/v2/authorization?...`. If it still fails, tail the functions container:

   ```
   docker compose logs -f functions | grep -i linkedin
   ```

   The function logs `LinkedIn OAuth action: authorize` and `Generated LinkedIn auth URL (redirect_uri) ...` on success.

5. Env sanity (only if logs show `LINKEDIN_CLIENT_ID not configured`):

   ```
   grep -E '^LINKEDIN_(CLIENT_ID|CLIENT_SECRET|REDIRECT_URI)=' \
     /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/.env
   ```

   Both `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` must be present. `LINKEDIN_REDIRECT_URI` is optional (defaults to `https://api.postora.cloud/functions/v1/linkedin-oauth`); whatever value resolves at runtime must be in the LinkedIn Developer Portal "Authorized redirect URLs" list verbatim.

## Out of scope

- No DB / migration changes.
- No env var changes (no new secrets).
- No scope changes.
- No OAuth flow changes (callback / refresh / disconnect untouched).

## Files

- Edited: `supabase/functions/linkedin-oauth/index.ts` (authorize branch only)
- Edited: `src/hooks/oauth/useLinkedInOAuth.ts` (pass `user_id`, add error toast)

Final status: `completed_requires_manual_redeploy` — Lovable can't push edge functions to the self-hosted stack; the runbook above must be executed for the fix to go live.
