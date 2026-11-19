# YouTube OAuth lifecycle stages 1b, 1c, 1d implementation plan

> For agentic workers: read `ARCHITECTURE.md` (layering, edge function shape, §12 to §16, §23, §26 to §28, §33) before editing. Execute one stage at a time. Tests are written first and must fail for the right reason before the implementation.

**Goal:** Make YouTube connect, refresh and disconnect owner-scoped, replay-safe, race-safe and honest about upstream failures.

**Spec:** `docs/specs/2026-11-19-youtube-oauth-lifecycle-stages-1b-1d.md` (decisions are fixed there).

**Stack:** Deno edge functions, Postgres (self-hosted Supabase), React/TypeScript with Vitest.

## Global constraints

- Applied migrations are immutable. New SQL is a new file `supabase/migrations/2026112x......_name.sql` with a timestamp after `20261119130000`, applied as `supabase_admin`.
- SQL suites run in the Docker harness: `MSYS_NO_PATHCONV=1 docker run --rm --network container:pg-harness -v "$(pwd -W):/repo:ro" -e DB_URL='postgres://supabase_admin:postgres@localhost:5432/postgres' -e HARNESS_DB_NAME=partner_api_harness supabase/postgres:17.6.1.158 bash /repo/scripts/db-harness.sh`. Check `pg_stat_activity` first because several agents share the container. Single suite: `docker exec -i pg-harness psql -X -U supabase_admin -d partner_api_harness -v ON_ERROR_STOP=1 -q < supabase/tests/<suite>.sql`.
- Deno: `deno test --allow-env --allow-read --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json <dir>` and `deno check` with the same import map. Add new test directories to the CI step that runs the other function tests.
- Vitest: `npx vitest run <file>`.
- Never `npx supabase functions deploy`. Edge functions deploy through the Dokploy schedule within about 2 minutes of the merge to main.
- No credentials in code, fixtures, logs or responses.
- Each stage ends with guard passes (`clean-code-guard` on production code, `test-guard` on tests), a scoped commit, and a PR whose description ends with the Claude Code attribution line.

## Stage 1b, branch `T3-CODE/youtube-stage1b-attempt-state`

### Task 1b-1: migration for return_to and consume-by-nonce

- [ ] Write the SQL suite `supabase/tests/youtube_oauth_attempts_v2.sql` first (cases listed in the spec) and register it in `scripts/db-harness.sh`.
- [ ] Run it, confirm it fails because the functions do not exist.
- [ ] Write the migration (`return_to` column, `create_youtube_oauth_attempt_v2`, `consume_youtube_oauth_attempt_by_nonce`, REVOKE from PUBLIC/anon/authenticated, GRANT to service_role).
- [ ] Run the suite and the full harness. Keep a mutation note: break each guard once and show the suite catches it.

### Task 1b-2: extract the handler

Files: create `supabase/functions/youtube-oauth/handler.ts`, `handler.test.ts`; slim `index.ts` to an adapter.

- [ ] Tests first: unauthenticated authorize refused with zero provider and zero DB credential access; profile owned by another user refused; `return_to` outside approved origins refused; replayed nonce refused; expired nonce refused; legacy HMAC state refused; GET callback redirects only to the stored `return_to`; POST callback with a different user than the attempt's refused; `refresh` action answers 400; missing refresh token in Google's answer keeps the stored one; unrelated `account_metadata` keys survive; a database error fails closed.
- [ ] Implement the handler with ports (auth, attempts, google, accounts, clock, log) and wire `index.ts`.
- [ ] Verify the callers of the connect hook and record how a null profile is handled.
- [ ] `deno test`, `deno check`, `npx vitest run src/hooks/oauth`.

### Task 1b-3: PR and rollout

- [ ] Commit, push, open the PR. Apply the migration to prod from the fetched PR ref before merging. Merge after CI is green and bots are answered. Verify the function after the Dokploy schedule, including one real authorize call that returns a URL with an opaque `state`.

## Stage 1c, branch `T3-CODE/youtube-stage1c-refresh-lease`

### Task 1c-1: lease migration and SQL suite

- [ ] `supabase/tests/youtube_refresh_lease.sql` first: concurrent acquire (one winner), expiry takeover, release by wrong token does nothing, stale-token write rejected, no PUBLIC EXECUTE.
- [ ] Migration with the lease storage and the two RPCs. Record why the chosen storage does not widen `social_accounts` write access.

### Task 1c-2: use the lease in every refresh path

- [ ] Grep for every YouTube refresh path (`refresh-tokens/youtubeProviderRefresh.ts` and any on-demand refresh in `_shared` or `process-post`). List them in the PR description.
- [ ] Tests first: contender without the lease re-reads and reuses a fresh token; contender with nothing fresh gets a retryable refusal; `invalid_grant` sets `needs_reauth` once and does not loop; refresh response without a refresh token keeps the stored one; stale holder writes nothing; no token text in logs.
- [ ] Implement, run Deno tests and checks, run the full harness.
- [ ] PR, apply migration to prod from the PR ref before merge, merge, verify after the Dokploy schedule.

## Stage 1d, branch `T3-CODE/youtube-stage1d-disconnect`

### Task 1d-1: disconnect action

- [ ] Tests first: account of another user refused; last user of the grant revokes at Google and clears local data; sibling channels sharing a grant skip revoke and clear local data only; Google `invalid_grant` on revoke counts as already revoked; Google 5xx returns an error and leaves local data; metadata read failure and write failure fail closed; no token in the response.
- [ ] Implement the action with ports and wire it.
- [ ] Frontend: `src/hooks/useSocialProfiles.tsx` calls the action; Vitest proves an upstream failure shows an error and does not remove the account from the UI.
- [ ] Run Deno tests and checks and Vitest.
- [ ] PR and merge after CI and bot review. No migration expected. If one is needed, apply it to prod before the merge.

## Review gate for every stage

After the implementer finishes: the orchestrator inspects the full diff, runs the harness and tests itself, runs the guard skills, reads every bot comment, and merges only on green CI. Findings that are right are fixed in one consolidated push per round.
