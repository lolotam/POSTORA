# Plan — Bounded Owner Instagram Collection Worker (Slice O2)

Status: Draft / Ready for Independent Review
Spec: `docs/specs/2026-10-29-instagram-owner-collection-worker.md`
Parent Milestone: Milestone 2 (Owner Analytics Flow) — Tasks 4 & 6

---

## 1. Scope and Modules

Slice O2 introduces the service collection worker under `supabase/functions/instagram-insights-sync/`:
1. `worker.ts`: Orchestration of job claiming, execution loop, lease deadlines, and batch completion.
2. `workerStore.ts`: Service-role database adapter executing `claim_instagram_collection_jobs`, `persist_instagram_collection_snapshot`, `complete_instagram_collection_job`, and `record_instagram_provider_throttle`.
3. `graphProvider.ts`: Meta Graph API client fetching account insights and media inventory with strict error classification (rate limits, expired tokens, permissions).
4. `worker.test.ts`: Unit tests verifying loop orchestration, budget enforcement, error recovery, and graceful shutdown.
5. `graphProvider.test.ts`: Hermetic mock tests for Graph API endpoints and payload parsing.
6. `workerStore.test.ts`: Real-SQL tests against Postgres 17 verifying atomic claim, snapshot persistence, and lease fencing.
7. `index.ts` / `handler.ts`: Wire `action: "drain"` for service_role / cron dispatch.

---

## 2. Hard Boundaries and Security

- **Tenancy**: Worker runs as `service_role` and verifies caller authorization. Target social accounts must belong to verified users.
- **No Production Deploy**: Work remains local on branch `feat/instagram-insights-competitors`. PR #294 stays draft.
- **Collection Mode**: Automated background cron remains OFF. Worker is invoked on-demand or through test harnesses.
- **No Competitor Work**: Only owner accounts (`p_target_kind = 'owner'`) are claimed and processed. Competitor tracking remains Milestone 3.

---

## 3. Independent Verification Gates

1. **Deno Typecheck and Unit Tests**:
   - `worker.test.ts`, `graphProvider.test.ts`, `workerStore.test.ts`.
   - All existing 14 O1 gates retained.
2. **Real-SQL Postgres 17 Controls**:
   - Claim 25 accounts under normal UTC.
   - Verify snapshot persistence into `instagram_account_daily_metrics` and `instagram_media_daily_metrics`.
   - Verify lease expiry and fencing.
3. **Full Regression Inventory**:
   - Node Vitest (2,211 tests across 320 files).
   - TypeScript `npm run typecheck`.
   - `npm run build`.
   - `lint-i18n-regression.mjs` against PR base `a57dc86d`.
