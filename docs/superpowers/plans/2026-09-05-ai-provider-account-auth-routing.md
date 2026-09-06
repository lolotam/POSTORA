# User BYOK Keys, Anthropic Integration, Codex Waitlist — Implementation Plan

**Date:** 2026-09-06 (supersedes the 2026-09-05 draft; revised after the Codex review round)
**Design:** `docs/superpowers/specs/2026-09-05-ai-provider-account-auth-routing-design.md`
**Branch:** `byok` (worktree `F:\Postora-byok`), PR against `main`.

## Goal

Ship the three scoped tasks in one PR: user BYOK keys with routing modes, Anthropic as a
platform and user provider in caption/hashtag/agent-reply flows, and the Codex waitlist card.
All behind `feature_byok_providers`.

## Delivery order and lanes

```text
Slice 1  migration + harness suite + SUITES registration   OpenCode Muse Spark 1.3 (free)
Slice 2  _shared adapters + routing + agent + captions      Codex gpt-6-astra medium
Slice 3  user-ai-providers Edge Function                    Codex gpt-6-astra medium
Slice 4  frontend feature + flag wiring + admin list        Codex gpt-6-astra medium
Slice 5  review, gates, migrate, deploy, activate, PR       orchestrator
```

Slices 1–3 are disjoint by path and run in parallel; Slice 4 starts when 2 or 3 finishes.
Every brief names `ARCHITECTURE.md` as required reading and AGENTS.md rules 1–5.

## Slice 1 — Migration, harness suite, registration (Muse Spark)

Files owned:

- `supabase/migrations/20260906120000_byok_provider_keys_and_routing.sql`
- `supabase/tests/byok_provider_keys.sql`
- `scripts/db-harness.sh` — **only** the `SUITES=(...)` array (the harness refuses to run
  with an unregistered suite on disk).

Migration content, idempotent:

1. `user_ai_provider_keys` per spec §5.1: RLS, `REVOKE ALL FROM anon, authenticated`,
   column-level SELECT grant, `user_ai_provider_key_status` view with
   `security_invoker = on`, `updated_at` trigger, AFTER DELETE reclaim trigger via a new
   `reclaim_user_ai_provider_key_secret()` cloned from `reclaim_ai_agent_tool_secret()`, with
   `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` on that function too.
2. `get_user_ai_provider_key(uuid, text, boolean DEFAULT false)` per spec §5.2, plpgsql,
   explicit revoke plus `GRANT ... TO service_role`. One function, one signature.
3. `user_ai_routing_preferences` per spec §5.3 with both CHECKs and four owner policies.
4. `ai_provider_waitlist` per spec §5.4.
5. Catalog: rename `openai`/`claude` display names (**no activation**); upsert the three
   Anthropic models on `(provider_id, model_id)`; deactivate the retired `claude-3-*` and
   `claude-sonnet-4-20250514` rows.
6. `app_settings`: `feature_byok_providers = 'false'::jsonb` `ON CONFLICT (key) DO NOTHING`.
   No policy change (`20260709090000` admits `feature\_%`).
7. If the save-serialisation choice in spec §7.5 is the advisory-lock wrapper, add
   `save_user_ai_provider_key_row(...)` SECURITY DEFINER, service_role only, taking the
   lock then upserting the row; otherwise document the re-read strategy in the suite header.

Harness suite (`RAISE EXCEPTION` per failed assertion, positive controls first, self-cleaning,
ends with the `ALL CHECKS PASSED` sentinel as the last stdout line):

- baseline-safe assertions (always run): anon cannot SELECT the table; user A sees only own
  rows and only the granted columns; `credentials_secret_id` SELECT denied; the view returns
  A's row to A and none to B and has no secret columns; `has_function_privilege` false for
  `anon`/`authenticated` and true for `service_role` on `get_user_ai_provider_key` and the
  reclaim function; exactly one `pg_proc` row for the RPC; both preference CHECKs; RLS WITH
  CHECK rejects a row for another user; waitlist ownership, duplicate, and CHECK; catalog
  rows (providers renamed and still inactive, models present and active, retired inactive);
  `feature_byok_providers` present and readable as `authenticated`;
- Vault-backed assertions (only when `supabase_vault` is installed, else one NOTICE):
  positive read returns the key for A and NULL for B; `p_include_invalid` behaviour; deleting
  A's row removes the `vault.secrets` row.

Gate: `DB_URL='postgres://supabase_admin:harness@localhost:55433/postgres' bash
scripts/db-harness.sh`; replay the migration a second time; run the suite alone; mutation
test the consent CHECK.

## Slice 2 — Shared adapters, routing, agent loop, captions (Codex)

Files owned: `_shared/anthropic-adapter.ts`(+test), `_shared/ai-user-routing.ts`(+test),
`_shared/ai-routing-errors.ts`, `_shared/ai-fallback.ts` (+ `ai-fallback-chain.test.ts`),
`ai-agent-reply/index.ts`, `ai-agent-reply/logic.ts` (+ `providerChain.test.ts`),
`generate-caption/index.ts`, `generate-hashtags/index.ts`.

1. Adapter per spec §7.2 (frozen normalised shape; `temperature`/`top_p` dropped;
   `callAnthropicJson` returning `{status, json}`).
2. `ai-fallback.ts`: discriminated `AiTier`; `resolvePlatformApiKey`; `callAiChain` with the
   three-tier cap, body read inside the deadline, `ProviderHttpError`; `callAiWithFallback`
   wrapper; `logAiCall` metadata fields. Existing `aiFallbackSettings.test.ts` unmodified.
3. `ai-user-routing.ts` per spec §6 and §7.3: reads throw on error; user tier only with a
   non-empty key; `fetchedAt` returned for version-conditional invalidation.
4. Captions (three branches) and hashtags: resolver → tiers → `callAiChain`; 409 on
   `user_only` without key with a log row; `credential_source`/`fallback_reason` logged.
5. Agent: `chatCompletion(tier, ...)`; `claude` endpoint; `ProviderHttpError`; chain from the
   resolver under the existing budget; version-conditional invalidation on 401/403.

Tests listed in the brief. Gates: `deno check` on every touched file; `deno test --no-check
--node-modules-dir=none` on `_shared/` and `ai-agent-reply/`; existing agent tests unmodified.

## Slice 3 — `user-ai-providers` Edge Function (Codex)

Files owned: `supabase/functions/user-ai-providers/{index,handler,validation}.ts` and tests.
Behaviour per spec §7.5: auth first (anon client verifies JWT; service-role bearer rejected);
service-role client with explicit `user_id` filter for every read/write; authenticated
validation endpoints with 401/403 vs transient classification; compensation only for a newly
created secret; `test_key` with `p_include_invalid = true`; delete order; idempotent
waitlist; best-effort rate limit; no key/secret/URL in any response or log.

## Slice 4 — Frontend (Codex)

Files owned: `src/features/ai-providers/` (`application/ports.ts`,
`infrastructure/supabaseAiProvidersGateway.ts`, `ui/*`, `tests/architecture.test.ts`,
`index.ts`), `src/pages/Settings.tsx`, `src/hooks/useFeatureFlags.tsx`,
`src/components/admin/AdminAiAgentSection.tsx`, `src/integrations/supabase/types.ts`.

1. Gateway in `infrastructure/` (only Supabase importer), port in `application/ports.ts`,
   composition in `ui/AiProvidersPanel.tsx`; architecture test copied and re-scoped.
2. Flag wiring: `FeatureFlags.byokProviders`, `FLAG_KEYS`, `FLAG_KEY_MAP`, `DEFAULT_FLAGS`,
   `baseFromDb`, `ALL_FLAGS_ENABLED`, `VISIBILITY_FLAG_KEYS`.
3. Cards per spec §8; consent gate; per-capability overrides; waitlist idempotent.
4. `AGENT_PROVIDER_CODES` gains `claude`; types added for the three tables and the view.

Tests per the brief. Gates: `bun install`, `npm run typecheck`, `npm run lint`, `npx vitest run`.

## Slice 5 — Orchestrator

1. After each delegate run: `ls` deliverables, read the diff, `clean-code-guard` on
   production code, `test-guard` on tests, fix directly, commit per slice.
2. Harness rehearsal on PG17 plus the mutation test.
3. Apply the migration in production as `supabase_admin` via `ssh-contabo-mcp` (fetch the
   branch ref into `/root/postora-runtime`, `git show FETCH_HEAD:<path> | psql -v
   ON_ERROR_STOP=1`). Verify grants with `has_function_privilege` and `pg_policies`.
4. Check `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` presence in the functions env
   (`[ -n "$v" ] && echo SET || echo MISSING`); otherwise the admin enters them through the
   provider card into `provider_api_keys`.
5. Deploy from the branch: `user-ai-providers/`, `ai-agent-reply/`, `generate-caption/`,
   `generate-hashtags/`, and every changed `_shared/` file; hash-verify; `docker compose
   restart functions`. Repeat from `main` after merge.
6. **Then** activate providers: `UPDATE ai_providers SET is_active = true WHERE provider_code
   IN ('openai','claude')` (or the admin toggle). Never before step 5.
7. Full gates in the worktree: Deno first, then `bun install`, `npm run typecheck`,
   `npm run lint`, `npm run test`.
8. Push, open the PR referencing the spec commit; `@codex review`; CodeRabbit; one fix round;
   merge (frontend auto-deploys).
9. Verify live with the flag on for the admin by `user_feature_overrides`: save an OpenRouter
   key, `user_only` for Chat, generate a caption, confirm the `system_logs.metadata` row
   carries `credential_source = user`; remove the key; confirm 409; agent sandbox reply on
   `claude/claude-sonnet-5` with a tool call. End state: global flag off, admin override on.

## Test matrix

| Layer | Coverage |
|---|---|
| PostgreSQL harness | replay, RLS, grants, view columns, function privileges, CHECKs, catalog, flag row; Vault reads and reclaim when the extension exists |
| Deno unit | adapter mapping and parameter dropping, chain routing and key isolation, resolver precedence and error propagation, Edge action handlers and classification |
| Vitest | cards, consent gate, flag gate and admin visibility, waitlist, gateway error propagation, architecture rule |
| Live smoke | user-key caption, 409 on `user_only`, agent reply on `claude` in the sandbox |

## PR breakdown

One PR, commits in slice order after the spec and plan commits.

## Definition of done

Migration applied and verified in production; edge functions deployed from `main`;
providers activated after deploy; PR merged; flag off globally and on for the admin; live
smoke recorded in the final report.
