# Postora Ollama bge-m3 Production Migration Tracker

**Status:** Phase 0 preflight complete; production work blocked pending an approved runtime-file delivery method and per-phase approval.

## Objective

Safely migrate Postora RAG/knowledge embeddings from Gemini's 1536-dimension vector space to self-hosted Ollama `bge-m3:latest` at 1024 dimensions. The existing Gemini workflow remains the active production path until the owner explicitly approves a cutover.

## Current Status

| Area | Status | Evidence |
| --- | --- | --- |
| Gemini production RAG | Active and unchanged | `public.ai_knowledge_chunks.embedding` remains `vector(1536)` with 53 populated rows. |
| Ollama service | Ready, private-only | Internal endpoint is `http://ollama:11434`; no public route is permitted. |
| Safe dual-provider code | Complete in Git | Corrective commit `1a17495b27523003010ebc4e676367b0cd9ba606` is pushed to `origin/main`. |
| Edge Functions runtime | Not updated | Contabo has no Postora Git checkout or repository credentials. |
| Pilot database column | Not applied | `embedding_bge_m3 vector(1024)` exists only in the repository migration. |
| Backfill | Not started | No 1024-dimension vectors have been written to production. |
| Evaluation and cutover | Not started | Gemini remains the default and rollback path. |

## Confirmed Production Facts

### Infrastructure

- Server: Contabo Docker/Dokploy self-hosted environment.
- Supabase Docker network: `postorasupabase-supabase-j8axyh`.
- Postgres container: `postorasupabase-supabase-j8axyh-supabase-db`.
- Database: `postgres`; database user: `supabase_admin`.
- pgvector version: `0.8.2`.
- Functions volume: `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions`.
- Stack directory: `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code`.

### Ollama

- Container: `postorasupabase-ollama-mhvo0j-ollama-1`.
- Private endpoint: `http://ollama:11434`.
- Model: `bge-m3:latest`.
- Model digest: `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`.
- Capability: embeddings only; dimensions: `1024`; context: `8192`.
- Arabic/English semantic cosine similarity test: `0.8462`.
- Warm English embedding request: HTTP `200`, approximately `655 ms` wall time.
- Observed memory after test: approximately `1.328 GiB / 11.68 GiB`.

### Existing RAG

- Table: `public.ai_knowledge_chunks`.
- Existing vector column: `embedding vector(1536)`.
- Existing vectors: `53 / 53` populated, all Gemini-generated.
- Gemini/1536 is the active production workflow and must remain functional until approved cutover.
- Existing retrieval RPC: `match_ai_knowledge_chunks`.

## Safety Rules

1. Never alter, truncate, cast, delete, or overwrite `public.ai_knowledge_chunks.embedding`.
2. Never write a 1024-dimension vector into the Gemini `embedding vector(1536)` column.
3. Never deploy runtime code or apply a production migration until the relevant files are present, checksummed, and approved.
4. Keep Gemini code, configuration, vectors, and index available until the bge-m3 backfill and retrieval evaluation pass and the owner approves cutover.
5. Keep Ollama private: no Docker ports, Traefik labels, public domain, or reverse-proxy route.
6. Use only `POST http://ollama:11434/api/embed` with `model: "bge-m3:latest"` and `keep_alive: "30m"`.
7. Never log API keys, JWT secrets, database passwords, service-role keys, or GitHub tokens.
8. Before every production write, migration, deployment, or restart, provide the exact command, expected result, rollback procedure, and wait for approval.

## Repository Implementation

### Completed

- Commit `73a82e84b7d1e070ac69f801d9231f5c196257f4` introduced an unsafe Ollama switch.
- Corrective commit `1a17495b27523003010ebc4e676367b0cd9ba606` supersedes it and is pushed to `origin/main`.
- The corrective commit keeps Gemini the default provider and rejects unsafe configuration combinations.
- The destructive reset migration was removed.
- Additive pilot migration and a pilot-only rollback migration were added.
- Focused Deno tests passed (`9 passed`), changed production modules passed `deno check`, targeted ESLint passed, and `git diff --check` passed.

### Files Introduced or Updated by `1a17495b`

- `supabase/functions/_shared/knowledgeEmbeddings.ts`
- `supabase/functions/_shared/knowledgeEmbeddings.test.ts`
- `supabase/functions/_shared/ollamaEmbeddings.ts`
- `supabase/functions/_shared/ollamaEmbeddings.test.ts`
- `supabase/functions/ai-agent-reply/index.ts`
- `supabase/functions/ai-knowledge-ingest/index.ts`
- `supabase/functions/ai-knowledge-excel-worker/index.ts`
- `supabase/migrations/20260713100000_add_bge_m3_embedding_pilot.sql`
- `supabase/migrations/20260713100001_rollback_bge_m3_embedding_pilot.sql`

## Phase Checklist

### Phase 0: Discover and Verify

**Status:** SAFE TO PROCEED - completed without changes.

- [x] Identify functions volume and stack paths.
- [x] Identify updated helper and function files from the corrective commit.
- [x] Confirm Gemini `embedding vector(1536)` remains active with 53 populated vectors.
- [x] Confirm Ollama is private on the Supabase Docker network.
- [x] Confirm Contabo has no Postora checkout or GitHub credentials.
- [x] Identify the blocker: runtime files cannot yet be safely delivered to the functions volume.

**Remaining Phase 0 verification before any deploy:**

- [ ] Verify Ollama connectivity from the actual Edge Functions runtime, rather than a temporary Docker curl container.
- [ ] Re-check deployed runtime file hashes and confirm the live code still uses Gemini/1536.
- [ ] Inspect live primary key, content columns, metadata/document identifiers, indexes, and relevant RLS policies for `ai_knowledge_chunks`.

### Phase 1: Deliver Updated Runtime Files

**Status:** BLOCKED - needs an approved delivery method.

Preferred delivery options, in order:

1. Read-only GitHub deploy key limited to `lolotam/postora`.
2. Fine-grained, read-only GitHub PAT limited to `lolotam/postora`.
3. Approved SCP, SFTP, or rsync transfer limited to the runtime files listed above.

**TODO after delivery method approval:**

- [ ] Record source and destination SHA-256 hashes for every deployed runtime file.
- [ ] Back up current runtime files with a timestamp and checksums.
- [ ] Copy only the shared helpers and the three updated function files into the functions volume.
- [ ] Verify ownership and read permissions against the existing runtime files.
- [ ] Restart only the functions runtime using the approved deployment runbook.
- [ ] Run non-destructive health checks for the existing Gemini path and the new Ollama embedding path.
- [ ] Verify `bge-m3:latest` returns exactly 1024 dimensions and that logs contain no secrets.

**Safety impact:** production runtime change, reversible by restoring the timestamped function backup and restarting only the functions runtime.

### Phase 2: Safe Dual-Column Migration

**Status:** NEEDS APPROVAL after Phase 1 succeeds.

Repository migration: `supabase/migrations/20260713100000_add_bge_m3_embedding_pilot.sql`.

**Planned reversible write:**

```sql
ALTER TABLE public.ai_knowledge_chunks
ADD COLUMN IF NOT EXISTS embedding_bge_m3 vector(1024);
```

The applied migration must retain a SQL comment that records the model, dimensions, internal Ollama provider, current model digest, and migration date. It must not alter `embedding vector(1536)` or create an HNSW index during the 53-row pilot.

**TODO:**

- [ ] Take and verify a logical backup of schema and `ai_knowledge_chunks` data.
- [ ] Present exact backup command, path, timestamp, SQL, expected result, and rollback before execution.
- [ ] Obtain explicit owner approval for the production write.
- [ ] Apply the additive migration.
- [ ] Verify old vectors remain `53` at dimension `1536`.
- [ ] Verify `embedding_bge_m3 vector(1024)` exists and begins empty.

**Rollback:** apply `supabase/migrations/20260713100001_rollback_bge_m3_embedding_pilot.sql` or, only when explicitly approved, run:

```sql
ALTER TABLE public.ai_knowledge_chunks
DROP COLUMN IF EXISTS embedding_bge_m3;
```

### Phase 3: Resumable bge-m3 Backfill

**Status:** NOT STARTED - requires Phase 2 success and owner approval.

**Required behavior:**

- [ ] Read only confirmed source text columns.
- [ ] Select only rows where `embedding_bge_m3 IS NULL`.
- [ ] Submit batches of five records by default to `http://ollama:11434/api/embed`.
- [ ] Send `model: "bge-m3:latest"` and `keep_alive: "30m"`.
- [ ] Require exactly 1024 returned values before each parameterized write.
- [ ] Never modify `embedding`.
- [ ] Retry transient failures using exponential backoff.
- [ ] Record chunk ID, result, duration, retry count, model, digest, and timestamp.
- [ ] Stop safely on validation failure and remain idempotent on rerun.

**Dry run before writes:**

- [ ] Embed one Arabic chunk, one English chunk, and one mixed/business chunk if available.
- [ ] Do not write vectors in dry-run mode.
- [ ] Report dimensions, latency, and sanitized errors.
- [ ] Obtain explicit approval before full backfill.

**Full-backfill acceptance:**

- [ ] Total rows: 53.
- [ ] Gemini 1536 vectors: 53.
- [ ] bge-m3 1024 vectors: 53.
- [ ] Failed rows: 0.

### Phase 4: Retrieval Quality Evaluation

**Status:** NOT STARTED - requires Phase 3 success.

- [ ] Create at least 10 real, non-sensitive evaluation questions.
- [ ] Include Arabic-to-Arabic, English-to-English, Arabic-to-English, and English-to-Arabic retrieval.
- [ ] Include invoices, payments, CRM/customer context, and business documentation when available.
- [ ] Compare Gemini and bge-m3 Top 3 and Top 5 results, expected source/chunk rank, latency, and query language.
- [ ] Confirm expected chunk is Top 3 for at least 80% and Top 5 for at least 90% of queries.
- [ ] Confirm no material regression from Gemini, no dimension errors, and relevant cross-lingual results.
- [ ] Propose, but do not apply, a separate `embedding_bge_m3 vector_cosine_ops` HNSW migration if justified by growth.

### Phase 5: Controlled Cutover

**Status:** NOT STARTED - explicit owner approval required after Phase 4 passes.

**Planned configuration:**

```text
EMBEDDING_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_EMBEDDING_MODEL=bge-m3:latest
EMBEDDING_DIMENSIONS=1024
EMBEDDING_COLUMN=embedding_bge_m3
```

**TODO:**

- [ ] Prefer an internal/admin tenant rollout if scoped rollout is supported.
- [ ] Monitor function errors, Ollama CPU/RAM, request latency, ingestion failures, retrieval failures, database errors, and quality feedback.
- [ ] Keep Gemini configuration, code, vectors, and index unchanged.

**Immediate rollback configuration:**

```text
EMBEDDING_PROVIDER=gemini
EMBEDDING_DIMENSIONS=1536
EMBEDDING_COLUMN=embedding
```

## Required Report Format for Every Phase

1. **Status:** SAFE TO PROCEED, BLOCKED, NEEDS APPROVAL, or FAILED.
2. **Evidence:** command output summary, paths, counts, dimensions, and health responses.
3. **Planned action:** exact command or SQL.
4. **Safety impact:** read-only, reversible write, production runtime change, or destructive.
5. **Rollback:** exact command or configuration change.
6. **Decision required:** the precise owner approval needed before proceeding.

## Next Decision

Approve one temporary, least-privilege Phase 1 runtime delivery method: a repository-scoped read-only deploy key, a repository-scoped read-only fine-grained PAT, or a limited SCP/SFTP/rsync transfer. No production action should occur until that method, the exact commands, expected results, and rollback steps are reviewed and explicitly approved.
