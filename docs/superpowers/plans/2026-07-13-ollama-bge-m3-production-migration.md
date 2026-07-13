# Ollama bge-m3 Production Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely move Postora knowledge embedding generation and retrieval from Gemini 1536-dimensional vectors to private Ollama bge-m3 1024-dimensional vectors while retaining an immediate Gemini rollback path.

**Architecture:** Keep `embedding` and Gemini retrieval unchanged. Add and populate `embedding_bge_m3`, route all RAG entry points through a shared embedding configuration, then select Ollama only by environment configuration after production validation. Deploy only the shared helpers plus the three RAG functions, with checksummed backups and a functions-only restart.

**Tech Stack:** Supabase PostgreSQL with pgvector, Deno Edge Functions, Ollama `bge-m3:latest`, Docker Compose, Deno tests.

---

### Task 1: Complete Shared Retrieval Routing

**Files:**
- Modify: `supabase/functions/ai-agent-reply/tools.ts:5-17,73-102`
- Modify: `supabase/functions/ai-agent-reply/index.ts:506-519`
- Test: `supabase/functions/ai-agent-reply/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add a `search_knowledge` test that gives the tool context an Ollama retrieval RPC name and asserts it calls `match_ai_knowledge_chunks_bge_m3`, never `match_ai_knowledge_chunks`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `deno test --allow-net supabase/functions/ai-agent-reply/tools.test.ts`

Expected: the test fails because the tool calls the Gemini RPC unconditionally.

- [ ] **Step 3: Implement the minimal shared configuration flow**

Add `retrievalRpcName` to `ToolContext`, use it in `searchKnowledge`, and set it from the resolved `embeddingConfig` in `ai-agent-reply/index.ts`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `deno test --allow-net supabase/functions/ai-agent-reply/tools.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the local routing correction**

Run: `git add supabase/functions/ai-agent-reply/tools.ts supabase/functions/ai-agent-reply/index.ts supabase/functions/ai-agent-reply/tools.test.ts docs/superpowers/plans/2026-07-13-ollama-bge-m3-production-migration.md && git commit -m "fix(ai-knowledge): route tool retrieval by embedding provider"`

### Task 2: Verify and Deliver the Runtime

**Files:**
- Read: `docs/runbooks/deploy-edge-function.md`
- Deploy: `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/{_shared,ai-agent-reply,ai-knowledge-ingest,ai-knowledge-excel-worker}`

- [ ] **Step 1: Verify live state without writes**

Use `psql` to confirm the Gemini column remains `vector(1536)` with 53 populated vectors, inspect RLS/indexes, and confirm the target column/function do not exist. Check Ollama from the Edge Functions runtime and verify it returns exactly 1024 values.

- [ ] **Step 2: Back up and checksum live files**

Copy only the five changed runtime files to a timestamped directory under the functions volume, capture `sha256sum` for every source, backup, and target file, and compare the local source hashes to the target hashes after transfer.

- [ ] **Step 3: Deploy and restart only Edge Functions**

Use the repository deployment runbook to copy the five runtime files, verify target hashes, and run `docker compose up -d --no-deps functions` from the Supabase stack directory.

- [ ] **Step 4: Validate the deployed runtime**

Check that the Gemini configuration and response path still work, verify the Ollama endpoint from the live runtime, and inspect fresh function logs for boot/import errors without printing any secret values.

### Task 3: Apply the Reversible Pilot Schema

**Files:**
- Apply: `supabase/migrations/20260713100000_add_bge_m3_embedding_pilot.sql`
- Rollback: `supabase/migrations/20260713100001_rollback_bge_m3_embedding_pilot.sql`

- [ ] **Step 1: Take a targeted logical backup**

Use `pg_dump` to create a timestamped schema-and-data backup limited to `public.ai_knowledge_chunks` and the two retrieval functions, then verify its checksum and row count.

- [ ] **Step 2: Apply the additive migration**

Run the repository migration through `psql -v ON_ERROR_STOP=1`; it must add only `embedding_bge_m3 vector(1024)`, its comment, and the bge-m3 RPC.

- [ ] **Step 3: Verify invariants**

Confirm 53 Gemini vectors remain populated at 1536 dimensions, the new column is 1024-dimensional and empty, and the bge-m3 RPC is callable with an empty result set.

- [ ] **Step 4: Record rollback procedure**

Retain the backup path and the exact rollback migration command; do not execute the rollback unless a phase fails.

### Task 4: Backfill and Evaluate

**Files:**
- Create: `scripts/backfill-bge-m3-embeddings.sh`
- Test: `scripts/__tests__/backfill-bge-m3-embeddings.test.sh`

- [ ] **Step 1: Write a failing dry-run test**

Test a local fake Ollama response to confirm the script refuses non-1024 vectors and emits no SQL update until the dimension check passes.

- [ ] **Step 2: Implement the resumable script**

Select only rows where `embedding_bge_m3 IS NULL`, request batches of five through `POST http://ollama:11434/api/embed` with `bge-m3:latest` and `keep_alive: "30m"`, validate the response, and write only `embedding_bge_m3` with parameterized `psql` updates. Log chunk ID, duration, attempts, and result without content or secrets.

- [ ] **Step 3: Run a three-item dry run**

Embed representative Arabic, English, and mixed-business chunks without database writes. Confirm each vector has 1024 dimensions and record sanitized latency.

- [ ] **Step 4: Run the full resumable backfill**

Backfill all null pilot vectors, retry transient Ollama failures with exponential backoff, stop on validation failure, and rerun until the query shows 53 Gemini vectors and 53 bge-m3 vectors with zero failures.

- [ ] **Step 5: Evaluate retrieval quality**

Run at least ten bilingual questions through both RPCs. Require the expected source in Top 3 for at least 80% and Top 5 for at least 90%, with no material regression or dimension errors.

### Task 5: Controlled Cutover, Verification, and Push

**Files:**
- Modify: Supabase functions environment configuration only

- [ ] **Step 1: Activate Ollama configuration**

Set `EMBEDDING_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://ollama:11434`, `OLLAMA_EMBEDDING_MODEL=bge-m3:latest`, `EMBEDDING_DIMENSIONS=1024`, and `EMBEDDING_COLUMN=embedding_bge_m3`; restart only Edge Functions.

- [ ] **Step 2: Verify production behavior**

Run one live RAG query and one tool-driven `search_knowledge` query, verify bge-m3 RPC usage, review runtime logs, and monitor Ollama memory/latency.

- [ ] **Step 3: Run quality gates**

Run focused Deno tests, Deno checks on changed functions, `npm run lint`, `npx tsc --noEmit`, the project test command, and `git diff --check`.

- [ ] **Step 4: Commit and push**

Commit only migration-related files with a scoped message, then push the current branch after all gates pass.

- [ ] **Step 5: Preserve rollback readiness**

Keep Gemini environment variables, `embedding`, the original RPC, backup files, and the pilot rollback migration available. Revert the five environment values and restart functions to roll back immediately.

## Self-Review

- The plan preserves the original `embedding vector(1536)` column and Gemini RPC throughout every task.
- The plan adds an explicit regression test for the remaining hard-coded retrieval path before production deployment.
- The plan contains a reversible backup and migration sequence, a dimension-validated idempotent backfill, bilingual retrieval acceptance thresholds, and a configuration-only cutover rollback.
