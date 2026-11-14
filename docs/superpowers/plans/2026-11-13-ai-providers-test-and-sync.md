# AI provider health and catalogue sync ? implementation and rollout plan

Status: implementation reconciled with PR #414 round 2 on 2026-11-13.
Design: [approved requirements and final design](../specs/2026-11-13-ai-providers-test-and-sync-design.md).

This plan describes the shipped implementation. Earlier illustrative copies of SQL,
runner code and tests were removed because they diverged from the executable sources.
The files and regression tests below are authoritative for signatures and behavior.

## 1. Database: expand before merge, contract after deployment

Files:

- `supabase/migrations/20261113180000_ai_provider_health.sql` (EXPAND).
- `supabase/migrations/20261113180100_ai_model_catalog_drop_legacy_unique.sql` (CONTRACT).
- `supabase/tests/ai_model_catalog_expand.sql` and `ai_model_catalog_contract.sql`.
- `supabase/tests/ai_provider_health.sql`.

EXPAND repairs/backfills `ai_models.auth_method`, explicitly sets its default and
NOT NULL, checks `api_key` / `oauth`, and creates the triple unique index. It retains
`ai_models_provider_id_model_id_key`: the live two-column upsert must still work.
API-key/OAuth coexistence is tested only AFTER CONTRACT. EXPAND tests the actual
migration's old-writer compatibility and paused cron jobs, not a recreated schema.
`scripts/db-harness.sh` invokes that proof immediately after applying EXPAND and before
CONTRACT in its migration-application loop.

EXPAND also creates latest health, immutable run completion markers, logical runs,
and the alert outbox. Browser grants are limited to admin SELECT on latest health;
the other state and mutation RPCs are service-only. SQL regressions seed a real
non-admin auth user and an existing health row before proving RLS denial, and also
prove admin read access and mutation denial.

The three catalogue counters are nullable, with no zero defaults. The recording RPC
preserves NULL when no sync was measured. A successful no-change sync records zero.

CONTRACT refuses to run without session deployment attestation. The harness first
proves this refusal, then explicitly attests in its disposable database. An ordinary
automatic migration batch therefore cannot silently drop the deployed writer's key.
CONTRACT activates the four health cron jobs; EXPAND creates them paused.

## 2. Shared probes and catalogue writes

Production sources:

- `_shared/aiProviderTest.ts`: shared admin-card and health probes; injected fetch
  and explicit timeout; catalogue read failures throw `ProviderReadError` before
  any fallback model is used.
- `_shared/providerUrlPolicy.ts`: approved exact HTTPS vendor hosts, no URL userinfo,
  custom ports or fragments; all redirects refused. `ai-config` validates additions
  with this policy and the probe transport validates existing stored endpoints.
- `_shared/aiProviderHealth.ts`: target planning, status categories, run identity,
  chunk selection, cancellation and summaries.
- `_shared/modelCatalogSyncRun.ts`: API-key and OAuth catalogue planning/writing.

The catalogue source registry is required only for upstream API catalogue fetches.
A caller-supplied OAuth catalogue works without an unrelated API source (Kimi
regression). Readers and writers pin the credential kind. Admin list reads fetch
all rows and let `groupCatalogueRows` apply its legacy unknown-kind fallback.

Health catalogue reads carry the target signal through PostgREST. Model writes and
the sync stamp use `write_ai_health_catalog`, one SQL transaction that validates and
locks the HTTP request's live cron lease. Lease takeover/release must wait for that
transaction. Expired holders and stale writes are refused, including after an HTTP
abort. The RPC checks its deadline again after writes so late work rolls back.

Failure reasons use fixed categories and numeric HTTP status only. Raw provider
bodies, arbitrary exception messages, keys, tokens and customer diagnostics are not
health reasons. Redaction also covers standalone credential parameters. Timeout tests
inject a never-settling fetch; 401 tests inject deterministic responses. No test
silently reaches the live provider network.

## 3. Runner, request admission and daily scheduling

Sources: `supabase/functions/ai-provider-health/{run,handler,deps,index}.ts`.
Regression suites: `run.test.ts`, `handler.test.ts`, `deps.test.ts` and SQL health suite.

- Enumerate active configured API-key providers and active OAuth connections.
  Current OAuth support is Anthropic, OpenAI Codex and OpenRouter. OpenRouter uses
  its existing Vault permanent key and pi-ai's `openrouter` API-key adapter/registry;
  it does not ask pi-ai for an OpenRouter OAuth refresh adapter.
- `needs_relogin` is a declared target marker. Report a stored reauth requirement
  immediately without a probe or sync.
- Use `deriveRunId`: SHA-256 of the UTC day for daily scope; preserve the browser
  `crypto.randomUUID()` token unchanged for manual scope. Validate manual UUIDs at
  the handler boundary so every chunk and retry keeps the same identity.
- Generate a fresh lease-holder UUID for EVERY HTTP request. Do not derive the
  holder from the stable logical run ID; same-holder renewals permit overlap.
- `admit_ai_provider_health_run` serializes logical admission. Every unexpired
  unfinished run rejects another run, regardless of scope, including an expired run
  trying to resume over a newer active one. Daily scope is accepted only from cron.
  A completed logical run is a no-op on replay when no other run is active. Manual chunks
  may continue with their existing run ID; new manual runs observe the per-admin
  cooldown from `app_settings.admin_ai_provider_health_cooldown_seconds` (default 60).
- Persist completion under `(run_id, provider_code, auth_method)` independently of
  latest status. Another run cannot erase a daily marker. Keep seven days of markers.
- Remove recorded targets, then select the first six unfinished targets on each call.
  Re-plan after membership changes; never use a numeric target offset.
- Allow three providers concurrently, but serialize API-key/OAuth work for the same
  `provider_code`. Probe, refresh and sync share one signal; reserve up to two
  seconds of the same target budget for persistence with a later write deadline.
- Start the 40-second runner deadline BEFORE discovery and key reads. Every target
  receives the smaller of its 15-second budget and remaining run time. Alerts receive
  at most eight seconds of the SAME remaining budget; each send at most five seconds.
  The handler caps the request at 45 seconds and reduces the runner budget for time
  already spent in authorization/admission, reserving time for lease release.
- Collect the actual `runOneTarget` outcome shape (`result` or `skipReason`). Failed
  result persistence is retryable skipped work, never a durable result and never
  `done: true`. Other providers continue. `markAlertNotified` is the singular port.

`supabase/config.toml` sets `[functions.ai-provider-health] verify_jwt = false`,
following `process-store-events`. In-handler cron-secret/admin authentication remains
mandatory. Three initial jobs run at 03:05, 03:12 and 03:19 UTC. The fourth recurs
every seven minutes during 03:00-23:59 UTC to drain unfinished targets and retry
pending alerts. All calls share the daily run ID; chunk numbers are request labels,
never offsets.

## 4. Durable admin alerts

Sources: `_shared/aiProviderAlert.ts`, `ai-provider-health/mailer.ts`, health migration.

Each connected-to-broken transition creates an immutable outbox event with an
`alert_id` and frozen status/reason. Recovery and later breaks do not delete unsent
events. Claim for ten minutes, send through Resend with the event's Idempotency-Key,
then mark THAT event notified. A failed send/mark remains retryable; another event
for the same provider must not be closed by that acknowledgement.

Exactly-once deduplication is bounded by Resend's 24-hour idempotency retention;
indefinite exactly-once delivery across a send/mark crash is not claimed. Recipients
are admins, using the existing profiles/user_roles email pattern. The production
sender is `admin@postora.cloud` unless `RESEND_FROM_EMAIL` supplies another verified
non-resend.dev address. No global `admin_notifications` broadcast is created.

## 5. Browser integration

Sources: `useAiProviderHealth.ts`, `ProviderHealthButton.tsx`, `AiProvidersCard.tsx`.

One button replaces the mounted Sync all control. The unused old component and
its test are removed under `ARCHITECTURE.md` §1. One table row per
provider connection includes credential kind, status, sanitized reason, nullable
model counts and last checked time. OAuth models remain separate in `oauthModels`.

Expose status read errors, including failed refreshes over cached data. Empty history
is displayed only after a successful empty read; an empty refresh clears stale rows.
Status reads filter against currently configured active targets, so removed keys,
disconnected OAuth and disabled providers do not retain misleading visible results.

The browser walks chunks with one token, retries skipped chunks at most three times,
and reports incomplete runs. Successful and partial runs invalidate BOTH
`['ai-provider-health']` and `['ai-config']`, including catalogue sync timestamps.
English call-site defaults and the Arabic `adminai` locale cover messages.

## 6. Validation gates

Run before the consolidated scoped commit and explicit-refspec push:

```bash
npx tsc --noEmit -p tsconfig.app.json
npx eslint <changed .ts/.tsx files>
npx vitest run <changed or related frontend test files>
deno test --allow-all <changed function directories and shared test files>
bash scripts/db-harness.sh
```

The CI Deno step explicitly includes `_shared/aiModelsAuthMethod.test.ts` and
`providerUrlPolicy.test.ts`, plus health/catalogue suites. Tests are typechecked;
there is no prescribed `--no-check`. The database harness runs in disposable Docker
Postgres, never production. Run clean-code-guard, test-guard and docs-guard before
commit. Keep graph output, logs and credentials out of the commit.

## 7. Exact owner rollout (not performed by this implementation task)

1. Apply **only** `20261113180000_ai_provider_health.sql` to self-hosted production
   BEFORE merge. Verify old two-column upserts work and all four health jobs are paused.
   Verify pg_cron, pg_net, get_cron_secret() and get_cron_functions_base_url() exist.
   If prerequisites were missing at EXPAND, install them and reapply EXPAND first.
   Do not submit both files as an unattended migration batch. Manual health admission
   stays busy until CONTRACT, so the new OAuth writer cannot race legacy uniqueness.
2. Merge after checks/review gates, then deploy `ai-provider-health`, `ai-config` and
   all changed shared modules/consumers through the self-hosted deployment runbook.
   Verify deployed SHA256 hashes and gateway configuration. Do not use Supabase Cloud
   function deployment commands.
3. Verify the new three-column writer is live and **drain all old function instances**.
   In the SAME SQL session used to apply CONTRACT, attest explicitly:

   ```sql
   SET postora.ai_catalog_writer_ready = 'true';
   ```

   Then apply `20261113180100_ai_model_catalog_drop_legacy_unique.sql`.
   Verify the legacy pair constraint is gone and the four cron jobs are active.
4. Run one admin health check. Verify both catalogue groups, current status, skipped
   work handling, last checked time and an admin-only alert in a controlled failure.
   `supabase/manual-sql/20260625_refresh_ai_catalog.sql` also requires CONTRACT; its
   additions, retirements and documented rollback affect API-key rows only.

No merge, deployment, production SQL or server mutation is authorized in this delegate
phase. Final receipt must list findings, evidence, pushed head and actual gate results.

## 8. Round 5 implementation sequence

- [x] Reproduce findings with backend, frontend, and migration-boundary regressions.
- [x] Preserve typed OAuth storage failures and target cancellation at the RPC boundary;
      centralize runner classification for absent credentials and catalogue refusals.
- [x] Add Higgsfield platform discovery and MCP probe; reuse the health lease while
      keeping media models in the api_key partition.
- [x] Retry alerts on completed admissions; preserve sync results if lease release fails.
- [x] Handle configuration read failures and reject malformed health timestamps.
- [x] Gate health admission on CONTRACT and validate cron prerequisites/schedules.
- Final delivery gate: guard passes, local checks, scoped commit/push, and signed thread receipts.
