# Implementation plan — Unified rate limits

Revision 2 (after Codex round 1). Companion to
`docs/specs/2026-08-23-unified-rate-limits.md`. Ordered, each step independently
reviewable. The orchestrator commits; Grok produces diffs.

---

## Step 0 — Branch

Create `feat/unified-rate-limits` off the current `fix/threads-poll-replies` HEAD
(that branch already carries the `requestGuards.ts` work this plan builds on).
Commit only files this plan names; the repo has a large unrelated untracked set.

## Step 1 — Seed migration

**File:** `supabase/migrations/20260823120000_unify_rate_limits.sql` (new)

Single `INSERT ... ON CONFLICT (endpoint) DO UPDATE` over the 14 rows in spec R1
(13 from the brief plus `/api/v1/media`). The `DO UPDATE SET` list is exactly
`display_name`, `max_requests`, `window_minutes` — `is_active` is deliberately
absent so an admin's disable survives.

A header comment states the one-time-baseline semantics from spec R1: this file is
applied once and must not be replayed after admins tune values, because the
`DO UPDATE` would clobber them.

**Verify:** applying twice against a scratch database leaves 14 rows and does not
flip a row whose `is_active` was manually set to `false`. (Value idempotence is
explicitly *not* claimed — see above.)

## Step 2 — Resolver module

**File:** `supabase/functions/n8n-api/rateLimitConfig.ts` (new)

```ts
export interface ResolvedRateLimit {
  requests: number;
  windowMs: number;
  enforced: boolean;   // false => unmetered (rate_limit_settings.is_active = false)
  source: "user_override" | "global_setting" | "fallback";
}
```

Exports:

- `FALLBACK_RATE_LIMITS` — the map moved out of `index.ts`, numbers updated to
  match the R1 seed, plus the existing `default` entry.
- `rateLimitKeyForPath(path)` — normalizes a request path to its canonical
  settings key per spec R2a. Unrecognised paths return unchanged.
- `resolveRateLimit(endpointKey, deps)` — `deps` carries two injected async
  functions (`fetchUserOverride`, `fetchGlobalSetting`) so tests need no DB.
  Priority: live user override → global setting → fallback map → `default`.
  - An override with `expires_at` in the past is skipped.
  - A row with non-finite or non-positive `max_requests` / `window_minutes` is
    malformed and skipped, continuing to the next level.
  - A live override outranks a disabled global setting (spec R2).
  - A rejecting dep is caught, logged once, and falls through to the map.
  - `window_minutes` converts to ms as `minutes * 60_000`.
- `fetchUserOverride(supabase, userId, endpointKey)` and
  `fetchGlobalSetting(supabase, endpointKey)` — the thin Supabase adapters,
  exported separately so a stub client can assert the filters they pass and how
  they handle `{ data, error }`.

**File:** `supabase/functions/n8n-api/index.ts` (edit)

- Delete the local `RATE_LIMITS` constant; import from the new module.
- `checkRateLimit` takes the resolved config instead of looking it up:
  - `enforced === false` → skip the count query, allow, and write the `api_logs`
    row with `request_data: { rate_limit: 'unmetered' }` (spec R2c);
  - the metered count query gains `.is('request_data', null)` so unmetered rows
    never count toward a later re-enabled limit;
  - `resetAt` becomes `new Date(Date.now() + windowMs)`, with a comment stating it
    is a conservative upper bound on a rolling window (spec R2b);
  - keep the existing `logError` check and `clientIpFromHeaders` usage untouched.
- `withRateLimitHeaders` takes the resolved config and performs **no** lookup of
  its own (spec R2b). Unmetered responses report the resolved value as both limit
  and remaining.
- The router call site (index.ts ~2084) computes
  `const key = rateLimitKeyForPath(path)`, resolves the config once, and passes it
  to both `checkRateLimit` and `withRateLimitHeaders` (index.ts:2252).

**Verify:** `deno check supabase/functions/n8n-api/index.ts`.

## Step 3 — Tests

**File:** `supabase/functions/n8n-api/rateLimitConfig.test.ts` (new)

Follows `requestGuards.test.ts` (`Deno.test` + `@std/assert`). Every case asserts
on `source` as well as the numbers, so a test cannot pass by coincidence when the
priority order breaks.

*Resolver:*
1. live user override beats a global setting
2. expired override ignored → global setting applies
3. live override beats a **disabled** global setting
4. expired override + disabled global → `enforced: false`
5. no override; global applies; `windowMs` converted from minutes
6. `is_active = false` → `enforced: false`
7. no rows → fallback map entry for a known endpoint
8. unknown endpoint → `default` fallback entry
9. rejecting dep → fallback, no throw
10. malformed override (`max_requests: 0`) → continues to **global**, not
    straight to fallback
11. malformed `window_minutes` (0, negative, NaN) skipped
12. `expires_at` null / future / exactly-now boundary

*Path normalization:*
13. every row of the spec R2a table, plus an unrecognised path passing through

*Adapters (stub client):*
14. `fetchUserOverride` passes the correct `user_id` and `endpoint` filters
15. `fetchGlobalSetting` passes the correct `endpoint` filter
16. both surface `{ data: null, error }` as a failure the resolver falls through on

**File:** `supabase/functions/n8n-api/rateLimitEnforcement.test.ts` (new)

`checkRateLimit` and `withRateLimitHeaders` against a stub Supabase client:
17. `enforced: false` skips the count query and writes the `unmetered` marker
18. the metered path issues a count filtered by `.is('request_data', null)`
19. `resetAt` is strictly greater than the request time
20. `withRateLimitHeaders` reports a resolved limit that **differs** from the
    fallback map value — the assertion a seeds-equal-fallbacks smoke test cannot
    make (Codex #3)

**Verify:** `deno test supabase/functions/n8n-api/`.

## Step 4 — Admin UI

**File:** `src/pages/admin/AdminRateLimits.tsx` (edit)

- Extend `ENDPOINT_LABELS` with all 14 endpoints.
- Add `ENDPOINT_CATEGORIES` mapping endpoint → `"AI Generation"` |
  `"Postora Web App"` | `"n8n / REST API"`, with a helper that buckets a list of
  settings into ordered categories and puts anything unrecognised in a trailing
  "Other" group (so a future seeded endpoint still renders).
- Global Defaults tab: render one subsection per category instead of one flat
  table. Same row markup and same edit dialog — grouping only.
- Override dialog dropdown: wrap the existing `globalSettings.map` in grouped
  labels. No query changes.
- Existing frontend test conventions apply (no `userEvent` — clipboard is
  unusable in this suite).

**Verify:** `npx tsc --noEmit` and `npm test`.

## Step 5 — Guards

- `clean-code-guard` over `rateLimitConfig.ts`, the `index.ts` diff, and
  `AdminRateLimits.tsx`.
- `test-guard` over both new Deno test files and any touched frontend test.
- Fix findings inline; re-run both until clean.

## Step 6 — Full gates

- `deno test supabase/functions/n8n-api/`
- `npx tsc --noEmit`
- `npm test` (baseline 474 passed / 0 failed)
- `npm run build`

All four green before the PR opens.

## Step 7 — PR and review rounds

Push `feat/unified-rate-limits`, open a PR whose body links the spec, lists the
behaviour change in R1 (AI limits raised), notes that enforcement does not change
until Step 8 runs, and pastes the gate output. Wait for the bot review
(CodeRabbit / Codex). Apply findings, re-run Steps 5–6, re-request. Cap at two
rounds, then merge.

## Step 8 — Deploy and live verification (part of completion, Codex #9)

After merge (frontend auto-deploys):

1. `ssh-contabo-mcp` → apply `20260823120000_unify_rate_limits.sql` inside
   `postorasupabase-supabase-j8axyh-supabase-db`.
2. `ssh-contabo-mcp` → copy `supabase/functions/n8n-api/{index.ts,rateLimitConfig.ts}`
   into the functions volume, verify SHA256, `docker compose up -d --no-deps functions`.
3. Live check: set a user override to a distinctive value in the admin UI, call an
   `/api/v1/*` endpoint as that user, confirm `X-RateLimit-Limit` reports the
   override with **no redeploy** in between, and confirm `X-RateLimit-Reset` is in
   the future.

**The goal does not close until step 3 passes.**

## Step 9 — n8n node (separate repo, after this PR merges)

In `F:\N8N\Postora-n8n-community-node` only: fallback expressions + pre-flight
UUID validation, then `npx tsc --noEmit`, `npm test`, `npm run build`, version
bump 1.8.0 → 1.9.0, push, `gh release create`. Verify
`npm view n8n-nodes-postora version`.

---

## Delegation map

| Step | Owner |
|---|---|
| 1–4 | Grok via `grok-delegate-local` (enforced git boundary) |
| 3 | Grok writes tests, gated by `test-guard` |
| 5–8 | orchestrator (Claude) |
| 9 | orchestrator via `n8n-node-release` |

## Risks

- **Raised AI limits** (R1) are a deliberate, user-requested behaviour change and
  must be called out in the PR body.
- **Two extra queries per n8n request** — accepted; matches `generate-caption`.
- **Seed/code ordering** — safe in both directions by design (fallback map), but
  neither alone completes the goal; both are Step 8 gates.
- **One-time migration semantics** — re-running the seed after admin tuning would
  clobber values. Stated in the migration header and the spec.
