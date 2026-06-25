## Plan

### Goal
Stop the repeated `POST /auth/v1/token?grant_type=refresh_token` 500 loop caused by a stale persisted browser auth session, while keeping normal sign-in and token refresh behavior intact.

### Implementation
1. Update `src/integrations/supabase/client.ts` to use a stable explicit auth storage key for Postora.
2. Add a small custom auth storage wrapper that:
   - reads/writes the normal Supabase session payload,
   - detects obviously expired or malformed persisted sessions before Supabase initializes,
   - removes invalid stored sessions so the app falls back to signed-out state instead of retrying refresh forever.
3. Keep `persistSession: true` and `autoRefreshToken: true` for valid sessions.
4. Avoid touching backend auth, database SQL, OAuth provider settings, or the self-hosted Supabase configuration.

### Validation
- Run available validation commands:
  - `npm run lint`
  - `npm run build`
  - report `typecheck` and `tests` as unavailable if no scripts exist.
  - `git diff --check`
- Run CleanCodeGuard on changed production code.
- TestGuard: no test files planned to change, so no test-code review required.

### Manual actions after deployment
- Users currently stuck in this state may need to refresh the page once after the frontend update; the app should then clear the stale local auth session automatically.