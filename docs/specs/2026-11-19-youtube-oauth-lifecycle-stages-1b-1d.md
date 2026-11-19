# YouTube OAuth lifecycle, stages 1b, 1c and 1d: specification

Date: 2026-11-19. Parent plan: `docs/plans/2026-11-03-youtube-integration-completion.md` stage 1 (on branch `docs/youtube-saad-readiness-20261103`, commit `72844bd3`). Stage 1a (the `youtube_oauth_attempts` table and its RPCs) is merged and applied on prod (`20261119130000`, PR #442).

## Verified problems in `supabase/functions/youtube-oauth/index.ts` (main at `b2a29fd5`)

1. `action: "refresh"` has no authentication. It uses the service role, accepts any `account_id` and accepts a raw `refresh_token` from the request body. No code in `src/` or `supabase/functions/` calls it (the cron uses `refresh-tokens/youtubeProviderRefresh.ts`).
2. The OAuth `state` is an HMAC-signed JSON blob with no expiry and no single-use guarantee, so it can be replayed.
3. `social_profile_id` is accepted from the body and never checked against the caller.
4. `return_to` comes from the request body and is not checked against approved origins.
5. The account upsert writes `refresh_token: refresh_token ?? null`. When Google omits the refresh token on a re-consent, the stored one is erased.
6. Nothing serialises concurrent token refreshes (cron against user action).
7. There is no provider-aware disconnect: removing a channel never revokes anything at Google and does not consider sibling channels that share one grant.

## Decisions (owner, 2026-11-19)

| Topic | Decision |
|---|---|
| Refresh fence (1c) | A DB lease (token plus expiry), not `pg_advisory_lock` and not a CAS on `token_expires_at` |
| `refresh` action (1b) | Deleted. It then answers 400 `Invalid action` |
| Shared grant on disconnect (1d) | Revoke at Google only when the channel is the last active account using that grant. Otherwise delete local data only |
| State cutover (1b) | Hard cut. Legacy HMAC states are rejected as soon as 1b is deployed. The nonce TTL is 10 minutes, so the worst case is one failed attempt that the user repeats |

## Design principles

- Fail closed on any database error. Never return a success the database or Google did not confirm.
- No token, nonce, code or refresh token in any response, log line or error message. Test fixtures contain no credentials.
- Applied migrations are immutable. Every schema change is a new migration, applied to prod from the fetched PR ref before the PR is merged.
- Each stage is its own PR. The edge function of a stage is deployed through the normal Dokploy schedule after the merge.
- Handlers are extracted into `handler.ts` with injected ports so they are testable offline. Do not import a serving entrypoint into a test.

## Stage 1b: authenticated authorize and callback on attempts

### 1b-0 migration (new file, additive)

Two gaps in 1a surfaced while designing the callback:

- The Google redirect hits the function with `GET ?code&state` and no user session. `consume_youtube_oauth_attempt` needs `(nonce, user, profile)`, which the GET path does not have.
- `return_to` has no column, so the callback cannot recover the validated return URL without trusting the request.

The migration adds:

- Column `return_to text NOT NULL` is not added in place (the table may hold rows). Add it nullable, require it in the new create path, and treat NULL as "use the default return URL".
- `create_youtube_oauth_attempt_v2(p_user_id, p_social_profile_id, p_return_to, p_ttl_seconds)` that stores `return_to` and returns the nonce once. The 1a function stays untouched.
- `consume_youtube_oauth_attempt_by_nonce(p_nonce)` (service role only): atomic, expiring, single use. On success it returns `{ok:true, user_id, social_profile_id, return_to}`. Refusals return `{ok:false, reason}` with the same stable reason codes as 1a. It never returns a digest.
- SQL suite `supabase/tests/youtube_oauth_attempts_v2.sql` (registered in `scripts/db-harness.sh`): success, replay refused, expired refused, unknown nonce, wrong-length nonce, concurrent consume (exactly one winner), no PUBLIC/anon/authenticated EXECUTE.

### 1b handler

- `authorize` (authenticated): validate the profile belongs to the caller, validate `return_to` against the approved origins already used for other providers (`src/lib/oauthRedirects.ts` and its server counterpart, found during implementation), create the attempt, and send the nonce as the OAuth `state`. The `state` carries nothing else.
- GET callback: consume by nonce, then complete OAuth with the returned user and profile. Redirect only to the stored `return_to`.
- POST `callback` (used by the app): authenticated, same consume path with the caller as an extra check (the attempt's user must equal the caller).
- `refresh` action removed.
- `social_profile_id` is `NOT NULL` on attempts. If any caller can pass a null profile today, the handler resolves the user's default profile server-side, and if none exists it answers 400 `profile_required`. The implementer verifies the callers in `src/hooks/oauth/useYouTubeOAuth.ts` and records the result.
- Upsert preserves the stored `refresh_token` when Google omits one, and preserves unrelated `account_metadata` keys.
- Every refusal logs one sanitised row through the repo's existing refusal logging.

Exit: new handler tests pass; no legacy-state acceptance remains in the code; SQL suite passes in the harness.

## Stage 1c: scoped refresh with a DB lease

New migration with a lease on the account, for example `youtube_token_refresh_leases(social_account_id pk, lease_token, expires_at)` or columns on `social_accounts` (implementer picks the one that does not widen `social_accounts` write surface, and records why). RPCs, service role only:

- `acquire_youtube_refresh_lease(p_account_id, p_ttl_seconds)` returns a lease token or a refusal when another holder is live. An expired lease is taken over.
- `release_youtube_refresh_lease(p_account_id, p_lease_token)` releases only for the matching token.

All refresh paths (`refresh-tokens/youtubeProviderRefresh.ts` and every on-demand refresh found by grep) take the lease first. A caller that does not get the lease re-reads the account and uses the fresh token if one was just written, otherwise reports a retryable refusal. Rules:

- `invalid_grant` sets `needs_reauth` and never loops.
- A refresh response without a new refresh token keeps the stored one.
- Writes are fenced on the lease token. A stale holder writes nothing.
- The SQL suite proves: two concurrent acquires give one winner, expiry takeover, release by wrong token does nothing, stale writer rejected.

## Stage 1d: provider-aware disconnect

- New authenticated action `disconnect` on `youtube-oauth` (or a sibling function if the implementer shows a cleaner seam), taking `account_id`. The account must belong to the caller.
- Grant identity: accounts that share the same stored refresh token share one grant. Count other active accounts with the same grant.
  - Last user of the grant: call Google's revoke endpoint. A non-2xx answer (other than "already invalid") aborts and returns an error. Local data stays, so there is no false success.
  - Other active accounts remain: skip revoke, clear this account's local credentials only.
- Local cleanup: null the tokens, mark inactive, and remove channel-scoped data per the repo's disconnect conventions.
- Frontend: the disconnect path in `src/hooks/useSocialProfiles.tsx` calls the action and shows an honest error when revoke fails.
- Tests: missing grant, `invalid_grant` on revoke (treated as already revoked), sibling channels sharing a grant, metadata read failure, metadata write failure, upstream 5xx.

## Out of scope

Stages 2 to 7 of the parent plan, any change to Composio-managed accounts, any live Google call in tests, changes to already applied migrations.
