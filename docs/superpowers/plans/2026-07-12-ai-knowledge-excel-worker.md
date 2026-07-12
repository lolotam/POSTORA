# AI Knowledge Excel Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process uploaded Excel knowledge sources in a Docker worker instead of the memory-constrained Supabase Edge Runtime.

**Architecture:** `ai-knowledge-ingest` queues Excel rows and returns immediately. A one-replica Deno service claims one pending or stale source at a time, indexes it using the existing chunk, embedding, and graph contracts, then persists a terminal status.

**Tech Stack:** Deno 2, Supabase JS, PostgreSQL RPC, SheetJS, Gemini OpenAI-compatible embeddings and graph extraction, Docker Compose.

---

### Task 1: Add Atomic Queue Claiming

**Files:**
- Create: `supabase/manual-sql/20260712190000_ai_knowledge_excel_queue.sql`
- Test: SQL verification against self-hosted Postgres

- [ ] **Step 1: Add an atomic claim RPC**

Create `claim_ai_knowledge_excel_source()` using `FOR UPDATE SKIP LOCKED`. It must select one Excel source with `status = 'pending'`, or one Excel source that has been `processing` for more than ten minutes, update it to `processing`, clear its error, and return the claimed row.

- [ ] **Step 2: Verify the RPC finds no work when the queue is empty**

Run:

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c "SELECT * FROM public.claim_ai_knowledge_excel_source();"
```

Expected: zero rows when no pending/stale Excel source exists.

- [ ] **Step 3: Apply the migration and verify the function is executable by `service_role`**

Run the migration against production, then query `pg_proc` and call the RPC with the service-role worker client.

- [ ] **Step 4: Commit the migration**

```bash
git add supabase/manual-sql/20260712190000_ai_knowledge_excel_queue.sql
git commit -m "feat(ai-knowledge): add excel ingestion queue claim"
```

### Task 2: Queue Excel Requests From the Edge Function

**Files:**
- Modify: `supabase/functions/ai-knowledge-ingest/index.ts:604-652`
- Test: `supabase/functions/ai-knowledge-ingest/index.test.ts`

- [ ] **Step 1: Write a failing test for the Excel queue response**

Test that an owned Excel source is left `pending`, returns HTTP 202 with `{ ok: true, queued: true }`, and does not call the XLSX parser.

- [ ] **Step 2: Run the test and verify it fails because the current handler parses Excel synchronously**

Run:

```bash
deno test --allow-env --allow-net supabase/functions/ai-knowledge-ingest/index.test.ts
deno check supabase/functions/ai-knowledge-ingest/index.ts
```

Expected: failure because the response is synchronous and no `queued` field exists.

- [ ] **Step 3: Implement the smallest queue branch**

After source validation, add:

```ts
if (source.source_type === "excel") {
  await (admin as any)
    .from("ai_knowledge_sources")
    .update({ status: "pending", error: null })
    .eq("id", source.id);
  return jsonResponse({ ok: true, queued: true }, 202);
}
```

- [ ] **Step 4: Re-run the focused test and Deno check**

Run:

```bash
deno test --allow-env --allow-net supabase/functions/ai-knowledge-ingest/index.test.ts
```

Expected: queue test passes and Deno type checking succeeds.

- [ ] **Step 5: Commit the edge queue behavior**

```bash
git add supabase/functions/ai-knowledge-ingest/index.ts supabase/functions/ai-knowledge-ingest/index.test.ts
git commit -m "feat(ai-knowledge): queue excel ingestion"
```

### Task 3: Add the Deno Excel Worker

**Files:**
- Create: `supabase/functions/ai-knowledge-excel-worker/index.ts`
- Test: `supabase/functions/ai-knowledge-excel-worker/index.test.ts`

- [ ] **Step 1: Write failing worker tests**

Cover three real behaviors: a claimed workbook writes chunks and `ready`; parser or embedding failures write `failed` plus an error; no claimed row exits without work.

- [ ] **Step 2: Run the worker tests and verify they fail before the worker exists**

Run:

```bash
deno test --allow-env --allow-net supabase/functions/ai-knowledge-excel-worker/index.test.ts
```

Expected: failure because the worker module is missing.

- [ ] **Step 3: Implement one-pass worker processing**

The worker must call `claim_ai_knowledge_excel_source`, download only the validated Cloudinary or storage path, parse SheetJS rows, generate Gemini embeddings in batches of 64, replace source chunks, perform bounded graph extraction, then set the source `ready`. Wrap processing in `try/catch` so ordinary errors set `failed` with a 500-character error.

- [ ] **Step 4: Add a polling loop**

Run one source at a time every 15 seconds, logging only source IDs, statuses, chunk counts, and sanitized error messages. Do not log user data, tokens, URLs with signatures, or environment variables.

- [ ] **Step 5: Verify worker tests and type checking**

Run:

```bash
deno test --allow-env --allow-net supabase/functions/ai-knowledge-excel-worker/index.test.ts
```

Expected: all worker tests pass and type checking succeeds.

- [ ] **Step 6: Commit the worker**

```bash
git add supabase/functions/ai-knowledge-excel-worker
git commit -m "feat(ai-knowledge): process excel sources in worker"
```

### Task 4: Deploy the Worker and Recover the Failed Source

**Files:**
- Modify production `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/docker-compose.yml`
- Modify production functions volume `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`

- [ ] **Step 1: Add a one-replica `ai-knowledge-excel-worker` service**

Use `denoland/deno:2.1.7`, the existing `.env`, the existing functions volume mounted read-only, and the same Supabase Docker network. Run:

```yaml
command: ["run", "--allow-env", "--allow-net", "/home/deno/functions/ai-knowledge-excel-worker/index.ts"]
```

- [ ] **Step 2: Copy the worker files and start only the new service**

Run:

```bash
rsync -av --delete /root/postora/supabase/functions/ai-knowledge-excel-worker/ /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/ai-knowledge-excel-worker/
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code && docker compose up -d ai-knowledge-excel-worker
```

- [ ] **Step 3: Requeue the stranded source after the worker is healthy**

Run:

```sql
UPDATE public.ai_knowledge_sources
SET status = 'pending', error = NULL
WHERE id = 'f0a391fb-adc7-4e66-a655-a1a54deb22df'
  AND status = 'processing';
```

- [ ] **Step 4: Verify terminal status and chunks**

Query the source status and chunk count until it reaches `ready` or `failed`; tail only the worker logs for the matching source ID.

- [ ] **Step 5: Commit code and documentation changes**

```bash
git add docs/superpowers/specs/2026-07-12-ai-knowledge-excel-worker-design.md docs/superpowers/plans/2026-07-12-ai-knowledge-excel-worker.md
git commit -m "docs(ai-knowledge): document excel worker design"
```
