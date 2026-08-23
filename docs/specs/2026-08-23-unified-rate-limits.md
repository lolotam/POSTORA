# Spec — Unify platform-wide rate limiting under AdminRateLimits

Date: 2026-08-23
Revision 3. Codex round 1 raised 9 blocking objections (§7); round 2 confirmed 6
resolved, 2 partial, 1 unresolved, and raised 3 remaining blockers (§8). All 12
distinct objections are folded in. The debate is capped at two rounds, so the
round-2 dispositions stand as recorded rather than being re-litigated.

**Goal:** every rate limit that `n8n-api` enforces becomes configurable from the
admin Rate Limits page without an edge-function redeploy, alongside the AI
endpoints that are already DB-backed.

**Completion gates** (the goal does *not* close on merge): merged to `main`
**and** the seed migration applied on prod **and** `n8n-api` redeployed **and** a
live call confirms an admin edit takes effect. Merging `main` auto-deploys the
frontend only; enforcement is unchanged until steps 2–4 of §5 run.

## Deliberately NOT in scope (stated to bound the goal honestly)

- `generate-hashtags` has a `rate_limit_settings` row but **no enforcement code**
  today. `post-create` likewise has a row and no consumer. Both rows pre-date this
  work; this change re-seeds their numbers but does not make them enforce.
- `supabase/functions/ecommerce-whatsapp-api/index.ts` and
  `supabase/functions/_shared/rate-limiter.ts` keep their own hardcoded limits.
- `generate-caption` / `generate-image` already resolve from the DB and are not
  touched.

---

## 1. Problem

`supabase/functions/n8n-api/index.ts` enforces rate limits from a module-level
constant `RATE_LIMITS`. Changing any n8n/REST limit therefore requires an edge
function redeploy. Meanwhile `generate-caption` / `generate-image` already resolve
their limits from the database (`user_rate_limits` → `tier_rate_limits` →
`rate_limit_settings`), and the admin page `src/pages/admin/AdminRateLimits.tsx`
edits those tables — but only ever lists the four seeded AI/web rows.

Live state confirmed on prod (`ssh-contabo-mcp`, 2026-08-23):

```text
rate_limit_settings: generate-caption(20/60), generate-hashtags(30/60),
                     generate-image(10/60), post-create(60/60)   -- 4 rows
tier_rate_limits:    9 rows, AI endpoints only
user_rate_limits:    0 rows
```

No row exists for any `/api/v1/*` endpoint, so the admin page cannot express an
n8n limit at all, and the override dropdown (which iterates `rate_limit_settings`)
cannot target one.

## 2. Already done on this branch (verified, not re-implemented)

The original brief listed three items under Step 2. Two are already shipped:

- **IP logging (Step 2.2)** — `supabase/functions/n8n-api/requestGuards.ts`
  exports `clientIpFromHeaders`, preferring `cf-connecting-ip` and otherwise taking
  the first usable hop of `x-forwarded-for`. `checkRateLimit` checks the
  `api_logs` insert error and logs it instead of discarding it. This was the
  `22P02`/`inet` root cause that silently disabled rate limiting.
- **UUID pre-validation (Step 2.3)** — `isValidUuid` guards
  `handleMessageReply` (index.ts:1835), `loadOwnedCommentAccount` (index.ts:1883),
  and `handleRegisterWebhook` via `parseSubscriptionFilters`
  (`webhookFilters.ts:16`). Each returns 400 `INVALID_ACCOUNT_ID` / `INVALID_FILTER`
  rather than letting Postgres raise 22P02.

Scope therefore narrows to: **DB seed + dynamic resolution + admin UI + node
ergonomics**.

## 3. Requirements

### R1 — Seed migration (DML only, no schema change)

`supabase/migrations/20260823120000_unify_rate_limits.sql` upserts one
`rate_limit_settings` row per platform endpoint:

| endpoint | display_name | max_requests | window_minutes |
|---|---|---|---|
| `/api/v1/messages/reply` | n8n: Message Reply | 600 | 60 |
| `/api/v1/comments/reply` | n8n: Comment Reply | 1200 | 60 |
| `/api/v1/comments/hide` | n8n: Comment Hide | 600 | 60 |
| `/api/v1/comments/delete` | n8n: Comment Delete | 300 | 60 |
| `/api/v1/post` | n8n: Post Creation | 60 | 60 |
| `/api/v1/upload-media` | n8n: Media Upload | 120 | 60 |
| `/api/v1/webhooks` | n8n: Webhooks | 60 | 60 |
| `/api/v1/accounts` | n8n: List Accounts | 300 | 60 |
| `/api/v1/posts` | n8n: List Posts | 300 | 60 |
| `/api/v1/media` | n8n: Get Media by ID | 300 | 60 |
| `generate-caption` | AI Caption Generation | 60 | 60 |
| `generate-image` | AI Image Generation | 30 | 60 |
| `generate-hashtags` | AI Hashtag Generation | 60 | 60 |
| `post-create` | Web App Post Creation | 60 | 60 |

- `ON CONFLICT (endpoint) DO UPDATE SET display_name, max_requests, window_minutes`.
- **`is_active` is never overwritten on conflict** — an admin's deliberate disable
  is the one piece of state that must survive.
- **Replay is mechanically guarded, not merely documented** (Codex r1 #8, r2 #2).
  A comment saying "do not re-run" is no protection when the deploy runbook pipes
  this file straight through `psql`. The upsert therefore carries a `WHERE` clause:

  ```sql
  ON CONFLICT (endpoint) DO UPDATE SET
    display_name   = EXCLUDED.display_name,
    max_requests   = EXCLUDED.max_requests,
    window_minutes = EXCLUDED.window_minutes
  WHERE rate_limit_settings.updated_at = rate_limit_settings.created_at;
  ```

  `rate_limit_settings` has a `BEFORE UPDATE` trigger
  (`update_rate_limit_settings_updated_at`) that stamps `updated_at`, so a row an
  admin has ever edited has `updated_at > created_at` and is skipped silently by
  Postgres — no error, no clobber. A pristine row converges onto the new baseline.
  This makes the file safe to replay.

  **Consequence to check at deploy time:** if one of the four pre-existing prod
  rows was ever admin-edited, the guard also skips its intended raise (e.g.
  caption 20→60). The live values read on 2026-08-23 (20/30/10/60) are exactly the
  original migration defaults, which suggests none were edited — but §5 now
  verifies pristineness *before* applying, so a skip becomes an explicit decision
  rather than a silent no-op.
- **Behaviour change to state loudly:** this raises the four existing AI/web rows
  (caption 20→60, image 10→30, hashtags 30→60, `post-create` renamed to
  "Web App Post Creation"). These values come from the task brief and are intentional.
  Only caption and image actually enforce; see the out-of-scope note above.
- No `tier_rate_limits` rows are seeded for n8n endpoints — `n8n-api` does not
  consult that table (see R2).

### R2 — Dynamic limit resolution in `n8n-api`

New module `supabase/functions/n8n-api/rateLimitConfig.ts` exporting a resolver
with injected query functions so it is unit-testable without a database (the
pattern `requestGuards.ts` + `requestGuards.test.ts` already establishes).

Resolution order for a given `(userId, endpoint)`:

1. **User override** — `user_rate_limits` row matching `user_id` + `endpoint`,
   used only when `expires_at IS NULL OR expires_at > now()`.
2. **Global setting** — `rate_limit_settings` row matching `endpoint`.
   `is_active = false` means **unlimited** (allow, do not enforce a cap),
   matching `generate-caption`'s existing meaning of the admin toggle.
3. **In-memory fallback** — the existing `RATE_LIMITS` map, used when the DB is
   unreachable or no row matches. Its numbers are updated to match the R1 seed so
   a fallback never silently enforces a different limit than the admin page shows.

Rules for each level:

- An override whose `expires_at` is in the past is skipped entirely and resolution
  continues to the global setting.
- A row with non-finite or non-positive `max_requests` / `window_minutes` is
  **malformed** and is skipped, continuing to the next level — never capping an
  endpoint at zero requests.
- `is_active` exists only on `rate_limit_settings`. A *live* user override
  therefore beats a disabled global setting: an admin who grants one user an
  explicit allowance has said something more specific than "this endpoint is
  unmetered for everyone". A malformed or expired override falls through to the
  disabled global and the endpoint is unmetered for that user.

### R2a — Path normalization (Codex #2)

`checkRateLimit` is keyed on the raw request path, so several **static** routes
never match a settings row:

| request path | canonical settings key |
|---|---|
| `/api/v1/media/upload` (alias of upload-media) | `/api/v1/upload-media` |
| `/api/v1/webhooks/test` | `/api/v1/webhooks` |
| `/api/v1/webhooks/<uuid>` (DELETE) | `/api/v1/webhooks` |
| `/api/v1/media/<uuid>` (GET) | `/api/v1/media` |
| `/api/v1/post/<id>` (GET, index.ts:2204) | `/api/v1/posts` |

`GET /api/v1/post/<id>` maps to the **`/api/v1/posts` read budget (300/hr)**, not
to `/api/v1/post` — the latter is the *write* budget (60/hr) for creating a post.
Fetching one post and listing posts are the same operational family, the way the
webhook routes share one budget. No 15th seed row is added.

`rateLimitKeyForPath(path)` in the new module maps a request path to its canonical
key before lookup, and the router passes that key to both `checkRateLimit` and the
response-header helper. This closes the static gaps and the parameterized ones in
one place. An unrecognised path returns itself and falls to `default`, exactly as
today.

### R2b — Headers must use the resolved config (Codex #3)

`withRateLimitHeaders` (index.ts:1964) currently does its own
`RATE_LIMITS[endpoint]` lookup, independent of `checkRateLimit`. Left alone, an
admin's DB edit would be **enforced** while `X-RateLimit-Limit` still advertised
the hardcoded number — and a smoke test could not catch it, because the seeds
equal the fallback numbers. Its signature changes to accept the already-resolved
config; it performs no lookup of its own.

`X-RateLimit-Reset` is documented, in code and here, as a **conservative upper
bound**: the window is rolling, so quota can reopen earlier as individual
`api_logs` rows age out. `Date.now() + windowMs` is never earlier than the true
reset. The current value (`windowStart + windowMs`) always evaluates to exactly
*now*, which is strictly wrong — that is the bug being fixed.

For an unmetered endpoint (`enforced: false`) the headers still report the
resolved `requests` value as both limit and remaining, with the same reset bound,
so clients see a well-formed, non-throttling response rather than missing headers.

### R2c — Unmetered requests must not poison the counter (Codex #4)

When `enforced === false` the count query is skipped, but the `api_logs` row is
still written — it is the audit trail. Naively that pollutes the future counter:
re-enabling the limit would immediately throttle users on traffic accrued while
the endpoint was unmetered.

`n8n-api/index.ts:72` is the **sole writer** of `api_logs` rows for `/api/v1/*`
endpoints (verified by grep across the repo), so unmetered rows are marked with
`request_data: { rate_limit: 'unmetered' }` and the count query adds
`.is('request_data', null)`. Metered rows continue to write `request_data` as
null, so the filter is exact and no historical row is reclassified.

A DB error while resolving is logged and falls through to the map — never a 5xx.
(Per project history: Cloudflare masks origin 5xx; app errors must not be 5xx.)

### R3 — Admin UI (`src/pages/admin/AdminRateLimits.tsx`)

- Extend `ENDPOINT_LABELS` to cover every seeded endpoint with a human-readable
  title.
- Group the Global Defaults table and the override endpoint dropdown by category:
  **AI Generation**, **Postora Web App**, **n8n / REST API**.
- The User Overrides tab already iterates `globalSettings` for its endpoint
  dropdown, so the seed alone makes n8n endpoints selectable; only labelling and
  grouping are new. No new tables, no new queries, no schema change.

### R4 — n8n community node (separate repo, separate release)

`F:\N8N\Postora-n8n-community-node` **only** — per AGENTS.md/CLAUDE.md the
vendored copy under this repo was deleted on 2026-08-22 and must not return.

- Fallback expressions on message fields:
  `{{ $json.social_account_id ?? $('Postora Trigger').first().json.social_account_id }}`
  and `{{ $json.sender?.id ?? $json.sender?.phone ?? $('Postora Trigger').first().json.sender.id }}`
- Pre-flight UUID validation before issuing the HTTP request, so a bad id fails in
  n8n with a clear message instead of round-tripping to a 400.
- Gates there: `npx tsc --noEmit`, `npm test`, `npm run build`, version bump,
  GitHub release. Landed via the `n8n-node-release` skill, **not** in this PR.

## 4. Non-goals

- No schema migration → `src/integrations/supabase/types.ts` is untouched.
- No caching layer for the two resolver queries (traffic is ~16 events/day;
  `generate-caption` does the same two uncached queries).
- No tier limits for n8n endpoints.
- No change to which routes are rate-limited, only to where their numbers live.

## 5. Deployment (from AGENTS.md runbook)

Merging to `main` auto-deploys **the frontend only**. The backend needs two manual
steps over `ssh-contabo-mcp`:

1. **Pristineness check, before applying anything:**
   ```sql
   SELECT endpoint, updated_at = created_at AS pristine FROM rate_limit_settings;
   ```
   Any row reporting `pristine = false` will be skipped by the R1 replay guard.
   If one of the four AI/web rows is non-pristine, decide explicitly whether to
   apply its new value with a manual `UPDATE` — never let the skip pass silently.
2. Apply the seed migration:
   `docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -f ...`
   then verify all 14 rows hold the intended values.
3. Copy changed `supabase/functions/n8n-api/*` into the functions volume, verify
   SHA256, then `docker compose up -d --no-deps functions`.

Ordering is safe either way: new code with an unseeded table falls back to the
in-memory map; a seeded table with old code is simply ignored.
`npx supabase functions deploy` must not be used — it targets Supabase Cloud.

## 6. Acceptance criteria

**Gates before merge**

- `deno test supabase/functions/n8n-api/` green, covering both the pure resolver
  **and** the Supabase adapters (Codex #5, #6):
  - resolver: live override beats global; expired override skipped; live override
    beats a *disabled* global; expired override + disabled global → unmetered;
    malformed override continues to global (not straight to fallback); malformed
    or non-positive `window_minutes` skipped; `expires_at` null / future /
    exactly-now boundary; `is_active=false` → `enforced:false`; no rows → fallback;
    unknown endpoint → `default`; rejecting dep → fallback without throwing.
  - adapters: `{ data, error }` shapes handled, and the correct `user_id` /
    `endpoint` filters are actually passed (asserted against a stub client) — so a
    typo'd filter fails a test rather than silently matching nothing.
  - `checkRateLimit`: `enforced:false` skips the count query and writes the
    `unmetered` marker; the metered path counts with `.is('request_data', null)`;
    `resetAt` is strictly in the future.
  - `rateLimitKeyForPath` for every row of the R2a table.
- `withRateLimitHeaders` test proving the header reflects a resolved value that
  **differs** from the fallback map — the one assertion a seeds-equal-fallbacks
  smoke test cannot make.
- **Malformed *global* row** (not just a malformed override) falls through to the
  fallback map (Codex r2 #3).
- **Router-wiring tripwires** (Codex r2 #3). The implementation went further than
  this spec first proposed: `index.ts` now exports `handleRequest` and calls
  `Deno.serve` only under `import.meta.main`, so importing the module is
  side-effect free and the tests exercise the **real** `checkRateLimit` and
  `withRateLimitHeaders` rather than copies. (`import.meta.main` was verified
  true under `supabase/edge-runtime:v1.67.4`, the image this stack runs, so the
  server still binds in production.)

  What remains out of reach is a full end-to-end handler test: `handleRequest`
  authenticates an API key and reaches Supabase before it ever gets to rate
  limiting, so driving it would mean standing up an authenticated request
  against a stubbed database — more machinery than the risk warrants. The gap is
  covered instead by three `Function.prototype.toString()` tripwires over the
  live exported functions: the router calls `rateLimitKeyForPath(`, the header
  helper no longer contains `RATE_LIMITS[`, and the 429 branch is wrapped in
  `withRateLimitHeaders`. They are labelled as regression guards in the test
  file. The **authoritative** end-to-end proof is the post-deploy live check.
- **Admin UI, pure parts only**: every seeded endpoint has an `ENDPOINT_LABELS`
  entry; the category bucketing helper groups the three categories correctly; an
  unrecognised endpoint lands in "Other". No full component render — the existing
  suite has no admin-page render harness to reuse.
- `npx tsc --noEmit`, `npm test` (baseline 659 passed | 15 skipped | 0 failed, 2026-08-23), `npm run build`.
- `clean-code-guard` clean on changed production code; `test-guard` clean on tests.
- Codex approves the spec + plan (≤2 rounds); PR bot review resolved (≤2 rounds).

**Gates after merge — the goal does not close until these pass (Codex #9)**

- Seed migration applied on prod; `n8n-api` redeployed to the functions volume.
- Live verification: set a user override to a distinctive value via the admin UI,
  call an `/api/v1/*` endpoint as that user, and confirm `X-RateLimit-Limit`
  reports the override — with **no redeploy** between the edit and the call.
- `X-RateLimit-Reset` observed to be in the future rather than the request time.

---

## 7. Codex round-1 objections and disposition

| # | Objection | Disposition |
|---|---|---|
| 1 | "every platform rate limit" is overstated; hashtags/post-create/ecommerce/_shared not covered | **Accepted** — goal narrowed to "every limit n8n-api enforces"; explicit out-of-scope list added at the top |
| 2 | static routes `/api/v1/media/upload`, `/api/v1/webhooks/test` fall to `default` | **Accepted** — new R2a `rateLimitKeyForPath` normalization + `/api/v1/media` seed row |
| 3 | `withRateLimitHeaders` still reads the fallback map | **Accepted** — new R2b; signature takes the resolved config; a test asserts a value differing from the fallback |
| 4 | logging while unmetered poisons the future counter | **Accepted** — new R2c; `request_data` marker + `.is('request_data', null)` count filter |
| 5 | priority edge cases undefined and untested | **Accepted** — rules written into R2; the full case list is now an acceptance gate |
| 6 | pure-resolver tests can pass while production is broken | **Accepted** — adapter tests against a stub client, `checkRateLimit` tests, and a post-deploy live check added |
| 7 | `Date.now() + windowMs` is not the true rolling reset | **Accepted as documented semantics** — R2b defines the header as a conservative upper bound; computing the true reset would need a `min(created_at)` query nothing consumes |
| 8 | the upsert clobbers admin-edited values on re-run | **Accepted, and superseded by the round-2 fix** — R1 first tried to document the hazard; Codex round 2 rightly rejected a comment as protection, so the upsert now carries `WHERE rate_limit_settings.updated_at = rate_limit_settings.created_at`. Replay is now mechanically safe: admin-edited rows are skipped, not clobbered. The trade-off is that a skipped row also does not receive a changed seed value without an explicit manual `UPDATE`, which is why §5 checks pristineness before applying. |
| 9 | completion cannot close on merge | **Accepted** — completion gates now include prod migration, redeploy, and a live no-redeploy verification |

## 8. Codex round-2 objections and disposition

Round 2 confirmed 6 of the 9 round-1 objections fully resolved, 2 partially, 1 not,
and returned three remaining blockers. All three are accepted and folded in below.
The debate is capped at two rounds, so no round 3 was run; this table is the
record of the disposition and is repeated in the PR body.

| # | Objection | Disposition |
|---|---|---|
| 1 | `GET /api/v1/post/<id>` (index.ts:2204) is missing from R2a, so it stays on the hardcoded `default` budget | **Accepted** - added to the R2a table, mapped to the `/api/v1/posts` read budget (not the `/api/v1/post` write budget), with a test case. No new seed row. |
| 2 | "Do not replay" documents the clobber without preventing it, and the runbook pipes the file through psql | **Accepted** - the upsert now carries `WHERE rate_limit_settings.updated_at = rate_limit_settings.created_at`, which the existing BEFORE UPDATE trigger makes a real mechanical guard. Deployment gains a pre-apply pristineness check so a guarded skip is an explicit decision. |
| 3 | Acceptance suite lacks router wiring, malformed-global validation, and admin UI coverage | **Accepted with a stated trade-off** - malformed-global and the admin UI pure parts get real tests. Router wiring gets source-text tripwires rather than an in-process router test, because `index.ts` calls `Deno.serve` at import and restructuring 2258 lines is riskier than the gap; the post-deploy live check is the authoritative end-to-end proof. |

### Round-2 sanity checks Codex endorsed

- A live user override outranking a disabled global setting is **not** privilege
  escalation - it imposes a user-specific cap while everyone else is unmetered,
  and the admin UI already states that overrides supersede global settings.
- The `unmetered` marker is sound given `n8n-api` is the verified sole writer of
  `/api/v1/*` rows and metered rows leave `request_data` null.
- Sharing one budget across register/list/test/delete webhooks is sound: one
  operational family, still per-user isolated.
