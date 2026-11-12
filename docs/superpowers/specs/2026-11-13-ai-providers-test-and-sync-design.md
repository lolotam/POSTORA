# AI Providers — One-Click Test & Model Sync, and a Daily Health Check

**Status:** approved by the owner on 2026-11-13 (final decisions below).
**Scope:** admin-only feature on `/admin/settings?tab=ai&sub=Providers`, plus one pg_cron job.
**Branch:** `feat/ai-providers-health-sync` (cut from `origin/main` `a9f3f34b`).
**Companion plan:** `docs/superpowers/plans/2026-11-13-ai-providers-test-and-sync.md`.

---

## 1. Owner decisions (binding)

1. **One button replaces today's "Sync all".** It
   - tests the connection of every configured provider;
   - then syncs the model catalogue of every provider whose test passed;
   - then shows **one result table**, with one row per provider:
     `connected` / `failed (sanitized reason)` / `needs re-login`, plus how many
     models were **added**, **updated** and **switched off**.
   - **A per-provider failure never stops the others.**
2. **The button covers BOTH credential kinds.**
   - API-key providers.
   - Subscription-login (OAuth) providers: Anthropic and OpenAI today; OpenRouter,
     xAI, Kimi, MiniMax and Z.ai later.
   - OAuth models are synced into the OAuth / "Auth" group (`auth_method = 'oauth'`),
     kept separate from the API-key models.
   - An OAuth connection that fails refresh shows **"needs re-login"** and **must not
     erase its models**.
3. **ALSO run automatically once a day.**
   - A `pg_cron` job calls a **cron-authenticated edge function** that does the same
     test + sync server-side.
   - It stores the latest per-provider result, so the UI shows **"last checked"** and
     the status.
   - It **notifies admins** when a provider changes from `connected` to `failed` or
     `needs re-login`. Reuse the existing admin notification mechanism; do not invent one.

---

## 2. Problem statement

Today the admin AI Providers card has a **"Sync all"** button
(`src/components/admin/settings/ai/SyncAllButton.tsx`). It is browser-driven: the browser
walks `SYNCABLE_PROVIDER_CODES` one provider at a time and calls
`ai-config` → `sync-models` for each. Three gaps follow from that split:

- **It never tests the connection.** The card has a separate per-provider **Test** button
  (`useAIConfiguration.ts` → `useTestConnection`), so an admin who syncs a provider whose
  key is dead gets a catalogue error instead of a clear "this provider is down".
- **It only covers API-key providers.** `SYNCABLE_PROVIDER_CODES` is
  `vercel, openrouter, deepseek, claude, gemini, openai, zai, minimax, xai` — all
  key-based. The OAuth logins added on 2026-11-12 (`ai_provider_oauth_connections`)
  are invisible to it, and their models live only in the pi-ai capability list, not in
  `ai_models`.
- **It has no server-side half.** There is no scheduled provider check, no stored
  "last checked" timestamp, and no alert when a provider silently breaks at 03:00.

The daily job and the button must therefore be **one implementation**, not two.

---

## 3. Goals / non-goals

### Goals

- G1. One button that tests then syncs every configured provider (API-key **and** OAuth)
  and shows one result table.
- G2. A per-provider failure is isolated: it never aborts the run.
- G3. One server-side implementation serves both the button and the daily cron job.
- G4. The latest per-provider result is stored, so the UI can show "last checked" and
  the status without running anything.
- G5. Admins are notified when a provider degrades from `connected` to `failed` /
  `needs re-login`, exactly once per transition.
- G6. The design admits the six future OAuth providers (OpenRouter, xAI, Kimi,
  MiniMax, Z.ai) with **no rework**.
- G7. No credential ever reaches the browser, the logs, the database, or an API response.

### Non-goals

- Changing how the *runtime* picks a model or how tiers resolve (out of scope).
- Changing the `admin_notifications` table or the notification bell.
- Per-user BYOK providers (`UserAiModelOverrides`).
- Turning the `feature_ai_provider_oauth` flag on.
- Migrating API-key calls to pi-ai.
- Redesigning the API/Auth grouping in the model selectors (owned by the concurrent
  branch — see §8).

---

## 4. Current state (evidence)

| Fact | Where |
|---|---|
| "Sync all" button, browser-driven, one `sync-models` call per provider | `src/components/admin/settings/ai/SyncAllButton.tsx` |
| Button mounted in the Providers card header | `src/components/admin/settings/ai/AiProvidersCard.tsx:176-180` |
| Syncable provider list (9, all API-key) | `src/hooks/ai-config/useSyncModels.ts:4-6`, `supabase/functions/_shared/modelCatalogSyncRun.ts:7-9` |
| Per-provider **Test** button (separate) | `src/hooks/useAIConfiguration.ts` → `useTestConnection` |
| `ai-config` `test-connection` action | `supabase/functions/ai-config/index.ts:96-140` |
| `ai-config` `sync-models` action (admin-gated) | `supabase/functions/ai-config/index.ts:236-257` |
| Provider probes live **inside** `ai-config/index.ts` (`testTarget`, `runProviderTest`, `testFirecrawl`… `testOpenAI`) | `supabase/functions/ai-config/index.ts:310-…` |
| Probe-kind mapping | `supabase/functions/ai-config/providerTestKind.ts` |
| Failure → human sentence mapper | `supabase/functions/_shared/providerErrors.ts` (`describeProviderFailure`) |
| Key resolution order (saved key → env var) | `supabase/functions/_shared/providerKeys.ts` (`resolveProviderKey`) |
| Catalogue planner + its safety rules | `supabase/functions/_shared/modelCatalogSync.ts` (`planCatalogSync`) |
| Catalogue runner + `SyncReport { added, updated, deactivated, kept_in_use, … }` | `supabase/functions/_shared/modelCatalogSyncRun.ts` |
| OAuth credential store + single-flight refresh | `supabase/functions/_shared/aiOAuth/credentials.ts` (`getFreshOAuthCredential`) |
| OAuth error codes, incl. `reauth_required` | `supabase/functions/_shared/aiOAuth/errors.ts` |
| OAuth login/test adapter (pi-ai) | `supabase/functions/ai-provider-auth/{index,handler}.ts` |
| Cron **or** admin authorizer, already existing | `supabase/functions/_shared/cron-auth.ts` (`verifyCronOrAdmin`) |
| Generic run lease (acquire/extend/release) | `supabase/migrations/20261031100000_cron_run_lease.sql` |
| Guarded cron schedule pattern (no literal secret) | `supabase/migrations/20261030140000_sweep_ai_image_staging_cron.sql` |
| Admin notification table + bell + admin page | `admin_notifications` (`supabase/migrations/20260107000440_…sql`), `src/hooks/useNotifications.tsx`, `src/pages/admin/AdminNotifications.tsx` |
| i18n gate (ar bundles only; English is the call-site default) | `scripts/check-i18n-coverage.mjs`, `src/i18n/index.ts` |

### 4.1 The planner's safety rules (inherited, not restated)

`planCatalogSync` already guarantees, and this feature **must not weaken**:

1. A catalogue entry that carries no name / price / context / description never erases the
   stored value.
2. A capability an admin added by hand (outside the catalogue's managed set) is kept.
3. Additive catalogues never remove a capability.
4. A model that is a **default or fallback** (`system_settings` keys
   `default_ai_model%`) is never switched off (`kept_in_use`).
5. A model with no managed capability is never switched off.

---

## 5. Terminology and the single source of truth

### 5.1 Terms

| Term | Meaning |
|---|---|
| **Provider** | a row in `public.ai_providers` (`provider_code` unique). |
| **Credential kind** (`auth_method`) | `api_key` or `oauth`. |
| **Target** | one (provider_code, auth_method) pair that the run can check. |
| **Connection** | the pair a human sees: e.g. *Claude — API key* and *Claude — subscription*. |

### 5.2 The single source of truth for models

> **Models are keyed by `(provider_code, auth_method, model_id)`.**

Today `ai_models` is keyed by `(provider_id, model_id)` only
(`UNIQUE(provider_id, model_id)` in `20260323193759_…sql`). That cannot hold two
credential kinds for one provider: `claude` as an API key and `claude` as a Claude
subscription would collide on the same `model_id`.

The design therefore adds `ai_models.auth_method text NOT NULL DEFAULT 'api_key'` and
replaces the unique constraint with `UNIQUE (provider_id, model_id, auth_method)`.
Both the OAuth sync and the API-key sync write into `ai_models`; **the OAuth model list
shown by the login dialog and the model list shown outside it are then the same rows.**
This is the dependency on the concurrent branch (§8).

`AiAuthMethod` already exists in the frontend (`src/hooks/ai-config/types.ts:39`:
`export type AiAuthMethod = 'api_key' | 'oauth'`), and the saved tier shape already
carries `auth_method?`. The database is the only thing missing it.

### 5.3 Target enumeration

| auth_method | Source of truth | Key | Model catalogue source |
|---|---|---|---|
| `api_key` | `ai_providers` where `is_active` and `provider_code` ∈ `SYNCABLE_PROVIDERS` | `resolveProviderKey` | the provider's own `/models` (today) |
| `oauth` | `ai_provider_oauth_connections` (one row per pi-ai OAuth provider) | Vault credential via `getFreshOAuthCredential` | pi-ai's model list for that OAuth provider |

A target exists only when its credential is actually configured:

- `api_key`: `resolveProviderKey` returns a key (saved `provider_api_keys` row, else the
  provider's `api_key_env_var`).
- `oauth`: the connection row exists **and** its stored status is not `reauth_required`.
  A connection already in `reauth_required` is reported as **needs re-login** without
  touching its models.

Providers with no configured credential are **not** targets. They are not failures.

---

## 6. Architecture

### 6.1 Component map

```
                    ┌──────────────────────────────────────────────┐
  Admin browser ───▶│  ai-provider-health  (edge function)         │
  (admin JWT)      │  verifyCronOrAdmin()                          │
                    │    POST {action:'run',  chunk, run_token}     │
                    │    GET  {action:'status'}                    │
                    └───────────────┬──────────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────────┐
  pg_cron  ───────▶│  same function, Bearer CRON_SECRET           │
  (03:05/12/19/26) │  action 'run', chunk 1..4, scope 'daily'      │
                    └───────────────┬──────────────────────────────┘
                                    │
             ┌──────────────────────▼──────────────────────────────┐
             │ run.ts  — the runner (ports injected)              │
             │  plan targets → slice chunk → test → sync → record │
             └───────┬──────────────────────┬────────────────────┘
                     │                      │
        _shared/aiProviderTest.ts   _shared/modelCatalogSyncRun.ts
        (probe + timeout + map)     (catalogue planner/runner)
                     │                      │
                     └──────────┬───────────┘
                                ▼
                     public.ai_provider_health   (latest result per target)
                     public.ai_models             (models, per auth_method)
                     public.admin_notifications   (the admin alert)
```

New files:

| File | Responsibility |
|---|---|
| `supabase/functions/_shared/aiProviderHealth.ts` | **pure** planning, classification, sanitisation, budget slicing |
| `supabase/functions/_shared/aiProviderTest.ts` | the provider probe, extracted from `ai-config` so both callers share one implementation |
| `supabase/functions/ai-provider-health/index.ts` | HTTP entry: auth, routing, CORS, JSON shapes |
| `supabase/functions/ai-provider-health/run.ts` | the runner: plan → slice → test → sync → record → notify |
| `supabase/functions/ai-provider-health/deps.ts` | the real ports (supabase client, fetch, key resolver, credential reader, logger) |

### 6.2 Where the work runs — server-side or in the browser?

**All provider I/O runs server-side. The browser owns no provider logic.**

The browser only: (a) asks for a run, (b) loops the chunks until the server says
`done`, (c) renders the table it gets back.

**Why not keep the orchestration in the browser (today's shape)?**

1. **One implementation, two callers.** The daily job must run *the same* test + sync.
   If the plan lives in the browser, the cron needs a second copy of the plan, the
   classification rules and the sync policy — the exact drift that produced the
   "three copies of the probe chain" comment in `providerTestKind.ts`. One server-side
   runner removes that class of bug by construction.
2. **The lock has to be real.** "A lock so the cron run and a manual click do not
   overlap" is only enforceable if both paths pass through one entry point. Two
   entry points mean two locks, and the race returns.
3. **The results must survive the tab.** The daily job has to leave a stored result
   ("last checked" + status). If the run lives in the browser, the browser is the
   only place that knows the outcome.
4. **Credentials stay behind the boundary.** The probe needs the key; the catalogue
   sync needs the key. Keeping them in one server-side pipeline keeps the browser
   out of the credential path entirely, and keeps one redaction point.

**What the browser still owns:** the *chunk loop*. The edge function has a hard 50 s
budget; the browser issues several short calls instead of one long one, and renders
the partial table as it arrives. The browser holds no policy, so a cron chunk and a
browser chunk are literally the same code path.

**What the browser must never do:** read a key, decide whether a provider is healthy,
or write to `ai_models` / `ai_provider_health` directly. All writes go through the
service role inside the edge function.

### 6.3 The run pipeline (per target)

For one target:

1. **Resolve the credential.**
   - `api_key`: `resolveProviderKey(db, provider_code)`. No key → the target does not
     exist; skip.
   - `oauth`: `getFreshOAuthCredential(db, oauthProvider)`. It refreshes under a
     single-flight lease and throws `AiOAuthError('reauth_required')` when the refresh
     fails.
2. **Test the connection.**
   - `api_key`: the probe from `_shared/aiProviderTest.ts`, chosen by
     `providerTestKind`, with an explicit timeout.
   - `oauth`: the pi-ai `complete` probe already used by `ai-provider-auth`'s `test`
     action, with an explicit timeout.
3. **Classify.**
   - ok → `connected`.
   - OAuth refresh/credential failure → `needs_relogin`.
   - anything else → `failed`, with a **sanitized** reason.
4. **Sync the catalogue** — only when the test passed.
   - `api_key`: `runCatalogSync(db, provider_code, fetch, { authMethod: 'api_key' })`.
   - `oauth`: the pi-ai model list for that OAuth provider, upserted into `ai_models`
     with `auth_method = 'oauth'`.
5. **Record** the row in `ai_provider_health` (counts, reason, latency, `run_id`).
6. Continue with the next target — **a failure in steps 2-5 never aborts the run.**

For `oauth` targets that fail, step 4 is **skipped entirely**: the OAuth models are
never touched, never deactivated, never deleted. This is the owner's rule "must not
erase its models", implemented by *not running the sync at all* rather than by trying
to undo it afterwards.

### 6.4 Batching and the 50 s budget

Three numbers, all server-side constants in `_shared/aiProviderHealth.ts`:

| Constant | Value | Why |
|---|---|---|
| `HEALTH_RUN_CONCURRENCY` | `3` | 16 targets × 3 s ≈ 48 s sequential — over budget. Three in flight ≈ 16 s, and each *provider* still sees only one concurrent request. |
| `HEALTH_TARGET_TIMEOUT_MS` | `12_000` | One probe. Today the probes in `ai-config/index.ts` have **no timeout**; a hung provider would hang the whole run. |
| `HEALTH_RUN_DEADLINE_MS` | `40_000` | Server-side hard stop, 10 s of headroom under the 50 s platform limit. |

`HEALTH_CHUNK_SIZE` is `6`: one HTTP call handles at most 6 targets, so a single call
stays far inside 50 s even when every probe times out (6 × 12 s ÷ 3 = 24 s).

**The chunk contract**

- `POST { action: 'run', chunk: n, run_token }` → processes the *n*-th slice of the
  target list and returns
  `{ run_id, chunk, done, next_chunk, results: ProviderHealthResult[], summary }`.
- `done` is `true` when `chunk` is past the last slice. The browser stops.
- A manual click therefore makes **⌈targets / 6⌉** calls — for the realistic 9 API-key
  plus 2 OAuth targets, **2 calls**.

**The cron cannot loop.** `pg_cron` fires a SQL statement; `net.http_post` is
fire-and-forget, so a single job cannot wait for chunk 2. The daily job is therefore
**four cron entries seven minutes apart**, each calling the same endpoint with
`chunk: 1..4`:

| cron job name | schedule | body |
|---|---|---|
| `ai-provider-health-1` | `5 3 * * *` | `run`, chunk 1 |
| `ai-provider-health-2` | `12 3 * * *` | `run`, chunk 2 |
| `ai-provider-health-3` | `19 3 * * *` | `run`, chunk 3 |
| `ai-provider-health-4` | `26 3 * * *` | `run`, chunk 4 |

Each entry is guarded by `DO $$ … $$` exactly like
`20261030140000_sweep_ai_image_staging_cron.sql`: it checks that `pg_cron` and
`public.get_cron_secret()` exist, and it never contains a literal secret — the
secret comes from `get_cron_secret()` inside the job body.

Worst case today: 11 targets → chunk 1 does 6, chunk 2 does 5, chunks 3 and 4 are
no-ops. Worst case after the future OAuth providers land: 16 targets → chunks 1-3 do
6/6/4 and chunk 4 is a no-op. Four entries cover the maximum without rework.

**The daily run is idempotent per day.** The daily `run_id` is derived from the current
UTC date, so the four entries share one id and a target already recorded with that id
is skipped. Re-running a chunk (a retry, a manual trigger of the same day) never
double-syncs a provider.

### 6.5 Idempotency and the lock

**Idempotency rules**

| Rule | Where |
|---|---|
| A target already recorded with the current `run_id` is skipped. | runner |
| The catalogue sync is a planner + upsert: re-running it produces the same rows. | `planCatalogSync` / `runCatalogSync` |
| `record_ai_provider_health` overwrites the row; it never appends. | SQL |
| A notification fires only on a **transition**, and the claim is atomic. | SQL |

**The lock.** The existing generic lease is reused — no new lock table:

```sql
acquire_cron_run_lease(p_job, p_holder, p_ttl)  -- true = taken or extended
release_cron_run_lease(p_job, p_holder)          -- true = released
```

- `p_job` is always `'ai-provider-health'`.
- `p_holder` is derived from the **run id**, not from the HTTP request:
  - manual click → a holder derived from the browser's `run_token` (stable across that
    click's chunks, so chunk 2 *extends* the lease instead of failing);
  - daily job → a holder derived from the UTC date (stable across the four cron
    entries).
- `p_ttl` is `15 minutes`. The daily window is therefore 03:05 → ~03:41 UTC.
- Because the holder is the run id, the daily entries extend one lease across the four
  of them, and a manual click inside that window gets `false` → the API answers
  `409 { error: 'busy' }` and the UI says *"the daily check is running — try again in a
  few minutes"*. A manual click outside the window takes the lease normally.

**Why not `EdgeRuntime.waitUntil`:** `ARCHITECTURE.md` §27 — "Do not treat Edge
Functions as durable queues." The continuation is four cron entries, not a background
promise that dies with the response.

### 6.6 Data model, RLS and grants

New table:

```sql
CREATE TABLE public.ai_provider_health (
  provider_code      text   NOT NULL REFERENCES public.ai_providers(provider_code) ON DELETE CASCADE,
  auth_method       text   NOT NULL DEFAULT 'api_key' CHECK (auth_method IN ('api_key','oauth')),
  status            text   NOT NULL CHECK (status IN ('connected','failed','needs_relogin')),
  previous_status   text   CHECK (previous_status IN ('connected','failed','needs_relogin')),
  reason            text,                       -- sanitized, <= 500 chars, never a key
  models_added      integer NOT NULL DEFAULT 0,
  models_updated    integer NOT NULL DEFAULT 0,
  models_deactivated integer NOT NULL DEFAULT 0,
  latency_ms        integer,
  run_id            uuid,
  checked_at        timestamptz NOT NULL DEFAULT now(),
  notified_at       timestamptz,
  claim_token       uuid,
  claimed_at        timestamptz,
  PRIMARY KEY (provider_code, auth_method)
);
```

- **`status` values:** `connected`, `failed`, `needs_relogin`. There is no `skipped`
  row — a provider without a credential is not a target, so it has no row.
- **`previous_status`** is what makes the transition detectable: the writer copies the
  old `status` into it. A row is "newly degraded" when
  `previous_status = 'connected'` and `status ∈ ('failed','needs_relogin')`.
- **`claim_token` / `claimed_at` / `notified_at`** implement a two-phase notification
  claim, so a crash between "decided to notify" and "notified" does not lose the alert
  and does not send it twice.

**RLS and grants** (`ARCHITECTURE.md` §23, §39):

- `ALTER TABLE public.ai_provider_health ENABLE ROW LEVEL SECURITY;`
- `CREATE POLICY ai_provider_health_admin_all ON public.ai_provider_health FOR ALL TO
  authenticated USING (public.has_role(auth.uid(), 'admin'));`
  — **admin only**. A normal authenticated user gets zero rows; the policy denies by
  default because no `USING (true)` policy exists for them.
- `REVOKE ALL ON TABLE public.ai_provider_health FROM PUBLIC, anon;`
- `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_provider_health TO service_role;`
  — the edge function is the only writer.
- No grant to `authenticated` for writes: the browser never writes this table, it only
  reads it through the edge function (`action: 'status'`).

**The change to `ai_models`**

- `ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'api_key';`
- `ALTER TABLE public.ai_models DROP CONSTRAINT IF EXISTS ai_models_provider_id_model_id_key;`
- `CREATE UNIQUE INDEX IF NOT EXISTS ai_models_provider_model_auth_method_key
  ON public.ai_models (provider_id, model_id, auth_method);`

Every statement is idempotent so the migration is safe next to the concurrent branch
(§8). `ai_models` keeps its existing RLS: `ai_models_select` for `authenticated`
(`USING (true)`) and `ai_models_admin_all` for admins. The new column defaults to
`'api_key'`, so **every existing row keeps working untouched** — no data migration is
needed and no read path changes.

**New RPCs** (service-role only, `SECURITY DEFINER`, `SET search_path = public`,
`REVOKE … FROM PUBLIC, anon, authenticated`):

| RPC | Returns | Purpose |
|---|---|---|
| `record_ai_provider_health(p_provider_code, p_auth_method, p_status, p_reason, p_models_added, p_models_updated, p_models_deactivated, p_latency_ms, p_run_id)` | `void` | upsert the row, copying the old `status` into `previous_status` |
| `claim_ai_provider_health_notifications(p_claim_token uuid)` | `TABLE(provider_code text, auth_method text, status text, reason text, previous_status text)` | atomically claim the newly-degraded rows; a claim older than 10 minutes is re-claimable |
| `mark_ai_provider_health_notified(p_claim_token uuid)` | `void` | close the claim after the notification was sent |

`record_ai_provider_health` does the read-old/write-new under a row lock
(`SELECT … FOR UPDATE`), so two concurrent runs cannot both see `connected` and both
fire an alert.

### 6.7 Sanitized errors

**Rule: a reason may name a provider, a status code and a category. It may never
contain a key, a token, a header value or a raw provider body.**

The pipeline, in order:

1. The probe throws `ProviderTestError(message, status, body)`.
2. `describeProviderFailure(name, status, bodyText)` — **already in
   `_shared/providerErrors.ts`** — maps it to a fixed sentence: *"Invalid API key"*,
   *"API key lacks required permissions"*, *"Rate limit exceeded"*, *"…insufficient
   balance…"*. Only the fallback branches echo provider text.
3. That text is passed through `redactProviderError(message, apiKey)` — **already in
   `_shared/ai-routing-errors.ts`** — which replaces the exact key with `[REDACTED]`,
   strips `authorization:` / `x-api-key:` header values, and truncates to 500 chars.
4. The reason is truncated to 500 characters and stored in `ai_provider_health.reason`.
5. It is written to the log with `event`, `provider_code`, `auth_method`,
   `error_code`, `duration_ms` — `ARCHITECTURE.md` §17 — never the body.

The OAuth branch has no key to leak: `AiOAuthError` carries a **stable code**
(`reauth_required`, `refresh_failed`, `refresh_timeout`, …) and a fixed message. The
runner maps the code to a status and to one of a small set of fixed sentences. A raw
pi-ai error is replaced by `"<provider> subscription sign-in could not be refreshed"` —
never by the provider's own text.

`ai_provider_health.reason` is readable by admins only, and is still sanitized:
it is a sentence for a human, not a log line.

### 6.8 Rate limits

| Layer | Limit | Why |
|---|---|---|
| Manual run, per admin | 1 run in flight; a second click while the lease is held returns `409 busy` | the lease is the limit |
| Manual run, cooldown | a finished manual run blocks a new one for 60 s (`app_settings` key `admin_ai_provider_health_cooldown_seconds`, default 60) | stops an admin hammering 9 providers × 2 calls |
| Daily run | 4 cron entries per day, 7 minutes apart | fixed by the schedule |
| Targets per run | ≤ 16 | 9 API-key + 7 OAuth |
| Concurrent probes | 3 | one per provider, no provider sees two at once |
| Probe timeout | 12 s | a hung provider cannot eat the budget |
| Provider-facing requests | one probe + one catalogue fetch per target per run | no retries inside a run; the next run retries |
| OAuth refresh | the existing single-flight lease in `_shared/aiOAuth/credentials.ts` | two runs never refresh the same credential twice |

There is **no retry inside a run**. A failed probe is recorded as `failed` and the next
run retries. Retrying a probe inside the run would multiply the provider load exactly
when a provider is already struggling.

### 6.9 The notification path

**Mechanism: the existing `public.admin_notifications` table.** It is the codebase's
admin notification mechanism — created by the admin UI
(`src/pages/admin/AdminNotifications.tsx`), read by the bell
(`src/hooks/useNotifications.tsx`) and by `src/pages/admin/AdminNotifications.tsx`
itself. The runner inserts one row with `title` and `message`; `created_by` stays NULL
because the writer is the service role, not a person.

**When:** exactly when a row transitions `connected → failed` or
`connected → needs_relogin`.

**How it is exactly once:**

1. `record_ai_provider_health` stores `previous_status = 'connected'` and
   `status = 'failed'`.
2. `claim_ai_provider_health_notifications` claims that row (sets `claim_token`,
   `claimed_at`) and returns it. Rows claimed more than 10 minutes ago with no
   `notified_at` are re-claimable, so a crash does not lose the alert.
3. The runner inserts the `admin_notifications` row.
4. `mark_ai_provider_health_notified` sets `notified_at` and clears the claim.

**Content:** the provider name, the credential kind, and the sanitized reason. No key,
no token, no user data. The title is
`"AI provider needs attention: <Provider>"` and the message is
`"<Provider> (<api key|subscription>) is <failed|needs re-login>: <sanitized reason>."`

**Caveat, stated plainly:** `admin_notifications` is a **broadcast to every signed-in
user** — it is the table behind the global bell. The message therefore carries no
secret and no user data, but a Postora user will see "the operator's OpenAI key is
failing". If the owner prefers an admin-only channel, the alternative is the existing
admin-email pattern (`notify-expiring-ai-overrides`: an `app_settings` toggle + the
admins from `user_roles`/`profiles` + Resend). That is **open question 1** in §11.

**No duplicate spam:** the transition is detected in SQL, so a second run on the same
day that also finds the provider broken does **not** notify again — `previous_status`
is no longer `connected`.

### 6.10 OAuth specifics

- **Never erase models.** An OAuth target that fails gets **no sync at all**. Its
  `ai_models` rows (`auth_method = 'oauth'`) are untouched: nothing is deactivated,
  nothing is deleted, capabilities are untouched.
- **Needs re-login** is reserved for a credential problem:
  `AiOAuthError('reauth_required')`, or a connection row already in status
  `reauth_required`. Anything else (a network timeout, a provider 500) is `failed`.
- **Models.** The OAuth catalogue is pi-ai's model list for that OAuth provider, the
  same list the login dialog shows today. The runner upserts it into `ai_models` with
  `auth_method = 'oauth'`, using the same planner rules as the API-key path (never
  erase a curated name/price/context, never remove an admin-granted capability, never
  switch off a default or fallback).
- **The in-use set is scoped per credential kind.** A tier in
  `system_settings.default_ai_model_*` points at `(provider_code, model_id,
  auth_method?)`. Today `defaultModelsInUse` ignores `auth_method`, which would let an
  API-key tier protect an OAuth row and the other way round. The runner must scope the
  in-use set to the credential kind being synced, so "never switch off a model used as
  default or fallback" holds **per (provider, auth_method)**.

### 6.11 Future OAuth providers (no rework)

The design admits OpenRouter, xAI, Kimi, MiniMax and Z.ai without touching the run
pipeline:

- The target enumeration reads `ai_provider_oauth_connections`, not a hard-coded list.
  A new connection row is a new target on the next run.
- The provider code map already exists in `_shared/aiOAuth/clients.ts`
  (`anthropic → claude`, `openai-codex → openai`, and the five future entries).
- The OAuth probe and the model list are read through pi-ai, so a provider pi-ai
  supports works without new code here.
- The only per-provider constant is the **probe kind**, and OAuth probes do not use it
  (they use the pi-ai probe).

Two things must be true for this to hold, and both are stated as constraints in the
plan: the OAuth provider id set is data, not code; and the API-key catalogue source
stays per provider (the `CATALOGUE` map in `modelCatalogSyncRun.ts`), so adding an
API-key provider is a map entry, not a pipeline change.

### 6.12 i18n

English is **not** shipped as a bundle in this repository: every call site passes its
English copy as the `t(key, "English copy")` default (`src/i18n/index.ts:9-15`).
Arabic is a real bundle. The gate is `npm run check:i18n`
(`scripts/check-i18n-coverage.mjs`), which enforces three things:

1. every namespace a component asks for is registered in the `ns` array of
   `src/i18n/index.ts`;
2. every key used in code exists in `src/i18n/locales/ar/<ns>.json`;
3. every key in a bundle is still used (no orphans).

So the feature adds **one** new namespace, `adminai`:

- `src/i18n/locales/ar/adminai.json` — the Arabic copy;
- `src/i18n/index.ts` — the import, the `ns` array entry, `en: { adminai: {} }` and
  `ar: { adminai }`;
- every call site passes its English copy as the default.

The keys are listed in the plan (§Task 10). The strings are the button label, the run
phases, the four status names, the three count labels, the "last checked" label and the
four error/busy messages.

---

## 7. The admin UI

`/admin/settings?tab=ai&sub=Providers` → the **AI Providers** card header.

**Before:** a `Sync all` button that syncs and shows a toast per provider.

**After:** one **"Check & sync all providers"** button, and a result table below the
card header.

The table has one row per connection:

| Provider | Credential | Status | Reason | Added | Updated | Switched off | Checked |
|---|---|---|---|---|---|---|---|
| Claude | API key | Connected | — | 2 | 0 | 1 | 2 min ago |
| Claude | Subscription | Needs re-login | Sign-in expired — reconnect the subscription | — | — | — | 2 min ago |
| OpenRouter | API key | Failed | Rate limit exceeded | — | — | — | 2 min ago |

- The **status** column uses the same three states as the stored row.
- The **counts** are empty (`—`) when the provider failed: nothing was synced, so there
  is nothing to count.
- **"Last checked"** is shown per row from `checked_at`, and is always present — the
  daily job fills it even when no admin ever clicks.
- The counts for a provider that was **not** synced because its test failed are `—`,
  never `0`: `0` would claim a sync happened and changed nothing.
- A provider that was skipped because it has no credential does not appear.
- The table renders from `action: 'status'` when the card opens, so the admin sees the
  last known state before clicking anything.

The button is disabled while a run is in flight and shows the phase
("Testing…" → "Syncing…" → "Done"). On `409 busy` it shows the busy message and the
stored table stays visible.

`SyncAllButton.tsx` and its test are **deleted**: one button, one implementation.

---

## 8. Concurrency with the other branch

Another agent is fixing, on a separate branch, a bug where **OAuth providers appear under
"API" instead of "Auth" in the model selectors**, and where **the login dialog's model
list differs from the outside list**.

**What this design does not do:** it does not redesign the grouping, does not touch
`AiProvidersCard`'s `isOAuthProvider`, and does not change how the selectors group.

**What this design depends on:**

1. **One source of truth for models per `(provider, auth_method)`** (§5.2). The OAuth
   sync writes into `ai_models` with `auth_method = 'oauth'`; the selectors and the
   login dialog read the same rows. The concurrent branch's fix — making the login
   dialog and the outside list agree — is only correct **after** the OAuth rows exist
   in `ai_models`.
2. **`ai_models.auth_method`** must exist. This migration adds it idempotently
   (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, `CREATE UNIQUE INDEX IF
   NOT EXISTS`), so whichever branch lands first, the second is a no-op on the schema.

**Merge order:** this branch's migration first (`20261113180000`), then the concurrent
branch's migration on top. If the concurrent branch adds the same column with a
different constraint name, the unique index below still applies — the index is the
constraint that matters for the upsert, and `runCatalogSync` upserts on
`provider_id, model_id, auth_method`.

**If the concurrent branch does not add `auth_method`:** this branch's migration adds
it, and the concurrent branch's frontend fix must be rebased on top of it. The
frontend grouping is unchanged by this design either way.

---

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| One provider's probe fails | that row is `failed` with a sanitized reason; the run continues |
| One provider's catalogue fetch fails after a passed test | the row is `failed` with the reason; its models are untouched (the planner never applied) |
| The whole run exceeds the 40 s deadline | the server returns what it has, `done: false`; the browser asks for the next chunk; the daily entries pick it up on the next slot |
| A chunk is requested beyond the last slice | `done: true`, no targets, no writes |
| The lease is held (daily run or another click) | `409 { error: 'busy' }`; the UI keeps the stored table |
| The OAuth refresh fails | `needs_relogin`; **no sync**; the OAuth models are untouched |
| The OAuth connection is already `reauth_required` | `needs_relogin`; no network call for the probe |
| `record_ai_provider_health` fails (DB down) | the target is reported as `failed` with reason *"could not record the result"*; the run continues |
| The notification insert fails | the claim is left open; the next run re-claims it after 10 minutes and notifies. The run itself is unaffected |
| A provider returns a huge body | the body is never stored; only the mapped sentence is, truncated to 500 chars |
| The service role is missing | the function answers `500` with a generic message and logs `ai_provider_health misconfigured` |

---

## 10. Security review

| Threat | Control |
|---|---|
| A key leaks into the API response | the browser only receives `{ provider_code, auth_method, status, reason, counts, latency_ms, checked_at }`. `reason` is a fixed sentence or a redacted, truncated string. |
| A key leaks into the DB | no code path writes a key to `ai_provider_health`. `reason` is produced by `describeProviderFailure` + `redactProviderError`. |
| A key leaks into the logs | `redactProviderError` runs before logging; the log fields are `event`, `provider_code`, `auth_method`, `error_code`, `duration_ms` (`ARCHITECTURE.md` §17). |
| A key leaks into `admin_notifications` | the message is built from the provider name and the sanitized reason only. |
| A non-admin triggers a run | `verifyCronOrAdmin` resolves the bearer token to a signed-in admin (`user_roles.role = 'admin'`). Anything else is `401`. A route guard alone is never the control (`ARCHITECTURE.md` §39). |
| A non-admin reads the results | `ai_provider_health` has an admin-only policy; the `status` action goes through the same authorizer; the table is not granted to `anon`. |
| A caller forges the cron secret | `verifyCronOrAdmin` compares with a constant-time check against `CRON_SECRET`; a mismatch is `401`. The secret never appears in a migration. |
| The cron overlaps a manual click | the `ai-provider-health` lease in `cron_run_leases`; the second caller gets `false` → `409 busy`. |
| A run overlaps itself | the run id skips already-recorded targets; the lease serialises different run ids. |
| The service-role key reaches the browser | never. The browser sends only the user's JWT. |
| SSRF via a provider endpoint | the endpoints come from `ai_providers.api_endpoint`, written by an admin. This feature does not add a user-supplied URL. |
| Denial of service by spamming the button | the lease + the 60 s cooldown + the admin-only authorisation. |

---

## 11. Open questions for the owner

1. **Which channel should the degradation alert use?**
   `admin_notifications` is the existing admin notification mechanism, but it is a
   **broadcast to every signed-in user**. The alternative is the existing admin-email
   pattern (`notify-expiring-ai-overrides`: an `app_settings` toggle + the admins from
   `user_roles`/`profiles` + Resend), which reaches only the operator.
   *Recommendation: keep `admin_notifications` (it is what "reuse the existing admin
   notification mechanism" names) and accept the broadcast; the message contains no
   secret and no user data. Say the word if you want email-only.*
2. **Should the manual click be blocked during the daily window (03:05–03:41 UTC)?**
   The lease is shared, so a click inside that window gets *"the daily check is
   running"*. The alternative is a second lease job name for manual runs, which would
   allow the two to overlap — the thing the lease exists to prevent.
   *Recommendation: keep the shared lease.*
3. **Should a provider with no configured credential appear in the table at all?**
   This design says no (it is not a target). The alternative is a `not_configured` row,
   which would add a fourth status and a fourth colour to the table.
   *Recommendation: keep it out.*

---

## 12. References

- `ARCHITECTURE.md` §0 (document map), §1 (prime directive), §11–16 (layering, data
  flow, error handling, external calls), §17 (logging), §23 (database & migration
  rules), §24 (service role), §25 (CORS), §26 (external HTTP rules), §27 (background
  work), §28 (scheduling rules), §39 (admin authorization), §40 (shared code rule),
  §43 (naming), §44 (comments), §45 (agent workflow).
- `CLAUDE.md` — Task Execution Workflow (authoritative), MCP routing guide, deployment.
- `docs/superpowers/plans/2026-09-25-sync-all-providers.md` — today's Sync all and the
  planner safety rules this feature inherits.
- `docs/superpowers/specs/2026-11-12-ai-provider-auth-methods-design.md` and
  `docs/superpowers/plans/2026-11-12-ai-provider-auth-methods.md` — the OAuth logins,
  the test and model lists, the `auth_method` tier shape.
- `docs/superpowers/specs/2026-11-12-ai-provider-auth-more-providers-design.md`
  (branch `69a8a167`, not yet on this branch) — the six future OAuth providers and the
  `credential_kind` split.
- `supabase/migrations/20261031100000_cron_run_lease.sql` — the lease RPCs.
- `supabase/migrations/20261030140000_sweep_ai_image_staging_cron.sql` — the guarded
  cron pattern.
