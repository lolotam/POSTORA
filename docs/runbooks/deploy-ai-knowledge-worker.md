# Deploy the ai-knowledge-excel-worker as a container

The worker (`supabase/functions/ai-knowledge-excel-worker/index.ts`) ingests queued
`excel` and `csv` knowledge sources. It has two run modes:

- **Standalone poller (this runbook)** — a one-replica long-lived container that
  claims a source every 15s and processes it to completion with no wall-clock
  budget. Selected by `EXCEL_WORKER_POLL=1`.
- **HTTP-driven edge function** — `POST /functions/v1/ai-knowledge-excel-worker`
  processes a bounded slice of work (~45s) per invocation, authenticated with
  `CRON_SECRET` or the service-role key (`_shared/cron-auth.ts`). Useful before
  the container exists, or from any scheduler.

Both modes are resumable: `ai_knowledge_sources.chunk_count` is the checkpoint,
and the claim function re-offers a stale `processing` source after 10 minutes.

## ⚠️ ORDER MATTERS — read before applying the migration

Migration `20260828110000_ai_embedding_models_and_csv_queue.sql` **section D**
routes CSV uploads into this worker's queue. **Do not apply section D until the
worker container from this runbook is running and healthy.** Applying it first
turns today's loud ~35s sync failure into a silent permanent `pending`.

Sections A–C of that migration (provider/models/settings seeding) are safe to
apply at any time.

## Paths

```bash
VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
```

## 1. Copy the worker code into the functions volume

Local files are CRLF; the deployed volume must be LF (hash comparisons and the
Deno runtime both care). Prefer deploying from the server-side git checkout,
which always produces LF:

```bash
cd /root/postora-runtime
git fetch origin "+refs/heads/main:refs/remotes/origin/main"
mkdir -p "$VOL/ai-knowledge-excel-worker"
git show "origin/main:supabase/functions/ai-knowledge-excel-worker/index.ts" > "$VOL/ai-knowledge-excel-worker/index.ts"

# Also refresh the shared modules the worker imports, if they changed:
for f in knowledgeEmbeddings.ts ollamaEmbeddings.ts cors.ts cron-auth.ts knowledgeSourceFiles.ts; do
  git show "origin/main:supabase/functions/_shared/$f" > "$VOL/_shared/$f"
done

# The worker imports these from the ingest function's directory. parsing.ts is
# what lets it handle doc/pdf/image rather than workbooks only; without it the
# worker cannot resolve its import and dies on restart, and the queue-widening
# migration then strands every queued source.
for f in chunking.ts parsing.ts; do
  git show "origin/main:supabase/functions/ai-knowledge-ingest/$f" > "$VOL/ai-knowledge-ingest/$f"
done

# Verify — each pair of hashes on a line must match. parsing.ts is included
# deliberately: a missing dependency fails at runtime, not at copy time.
for f in ai-knowledge-excel-worker/index.ts ai-knowledge-ingest/chunking.ts ai-knowledge-ingest/parsing.ts; do
  sha256sum <(git show "origin/main:supabase/functions/$f") "$VOL/$f"
done
```

## 2. Add the compose service

> **Deployed 2026-09-05.** The service below is live in the stack as
> `ai-knowledge-excel-worker` (container
> `postorasupabase-supabase-j8axyh-supabase-ai-knowledge-worker`). Follow this
> section again only if it has to be recreated.

Dokploy keeps this stack's compose as a **raw record in its own database**
(`compose."composeFile"`, composeId `YrlABDQZh5Z2fw8-gvTIv`) and rewrites
`$STACK/docker-compose.yml` from it on every redeploy. Add the service to
**both**: the on-disk file (so `docker compose up` sees it now) and the record
(so the next Dokploy redeploy keeps it). A service added only on disk
disappears at the next redeploy.

This is the block that is deployed. It mirrors the stack's `functions` service:
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **not** in the stack's
`.env` (it holds `SERVICE_ROLE_KEY`), so they are set in `environment:`
exactly as `functions` does, and the stack declares a named network.

```yaml
  ai-knowledge-excel-worker:
    container_name: ${CONTAINER_PREFIX}-ai-knowledge-worker
    image: denoland/deno:2.1.7
    env_file:
      - ./.env
    restart: unless-stopped
    volumes:
      - ../files/volumes/functions:/home/deno/functions:ro
    environment:
      # Poll mode: the entrypoint loop claims one source every 15s. Without
      # EXCEL_WORKER_POLL the same file serves the bounded HTTP mode instead.
      EXCEL_WORKER_POLL: "1"
      SUPABASE_URL: http://kong:8000
      SUPABASE_SERVICE_ROLE_KEY: ${SERVICE_ROLE_KEY}
    command:
      - run
      - --allow-env
      - --allow-net
      - --allow-read=/home/deno/functions
      - /home/deno/functions/ai-knowledge-excel-worker/index.ts
    networks:
      - postorasupabase-supabase-j8axyh
```

Insert it before the `analytics:` service in both copies, then update the
record from the edited copy:

```bash
docker cp compose-db.yml dokploy-postgres.1.<id>:/tmp/compose-db.yml
docker exec dokploy-postgres.1.<id> psql -U dokploy -d dokploy -c \
  "update compose set \"composeFile\" = pg_read_file('/tmp/compose-db.yml') where \"composeId\"='YrlABDQZh5Z2fw8-gvTIv'"
```

Notes:

- The worker refuses to start without `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY`. `OLLAMA_BASE_URL` is unset and falls back to
  `http://ollama:11434`; the Ollama container is joined to this stack's network.
- The volume is mounted **read-only**; the worker only reads code from it.
- Exactly **one replica**: claims use `FOR UPDATE SKIP LOCKED`, but a single
  poller is what the embedding checkpoint cadence was designed around.
- The cron-driven HTTP mode keeps running alongside it. A source the poller is
  embedding is `processing`, so the cron leaves it alone; a source the cron
  hands back as `pending` is picked up by the poller within 15s.

## 3. Start and verify

```bash
cd "$STACK" && docker compose -p postorasupabase-supabase-j8axyh up -d --no-deps ai-knowledge-excel-worker
docker compose -p postorasupabase-supabase-j8axyh logs --tail=40 ai-knowledge-excel-worker
```

Always pass `-p postorasupabase-supabase-j8axyh`: that is the project name
Dokploy runs the stack under, and a bare `docker compose` from `$STACK` would
create a second project named after the directory.

Healthy looks like: no startup error about missing Supabase configuration, no
crash loop, and idle silence between polls (the poller only logs when it
processes or fails a source). Requeue a stranded test source if you have one:

```sql
UPDATE public.ai_knowledge_sources
SET status = 'pending', error = NULL
WHERE id = '<source-id>' AND status IN ('processing', 'failed');
```

…then watch for the `ready source=<id> chunks=<n>` log line.

## 4. Only now apply migration section D

With the worker confirmed processing, apply section D of
`20260828110000_ai_embedding_models_and_csv_queue.sql` (the
`claim_ai_knowledge_excel_source` replacement widening the queue to CSV).
Upload a small CSV from the UI and confirm it reaches `ready` via the worker.

## Rollback

```bash
cd "$STACK" && docker compose stop ai-knowledge-excel-worker
# then remove the service block from docker-compose.yml
```

Sources already queued as `pending` simply wait; they can be processed via the
HTTP mode or re-processed after the worker returns.
