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
for f in knowledgeEmbeddings.ts ollamaEmbeddings.ts cors.ts cron-auth.ts; do
  git show "origin/main:supabase/functions/_shared/$f" > "$VOL/_shared/$f"
done
git show "origin/main:supabase/functions/ai-knowledge-ingest/chunking.ts" > "$VOL/ai-knowledge-ingest/chunking.ts"

# Verify — the two hashes on the line must match:
sha256sum <(git show "origin/main:supabase/functions/ai-knowledge-excel-worker/index.ts") "$VOL/ai-knowledge-excel-worker/index.ts"
```

## 2. Add the compose service

Edit `$STACK/docker-compose.yml` and add this service. **Before applying, diff
it against the stack's existing `functions` service** — image tag conventions,
the `env_file`, the functions volume mount, and the network must match what the
stack already uses (the sketch below follows the `functions` service
conventions as of 2026-07-12):

```yaml
  ai-knowledge-excel-worker:
    image: denoland/deno:2.1.7
    # Poll mode: the entrypoint loop claims one source every 15s. Without
    # EXCEL_WORKER_POLL the same image serves the bounded HTTP mode instead.
    environment:
      - EXCEL_WORKER_POLL=1
    env_file:
      - ./.env
    command:
      [
        "run",
        "--allow-env",
        "--allow-net",
        "/home/deno/functions/ai-knowledge-excel-worker/index.ts",
      ]
    volumes:
      - ../files/volumes/functions:/home/deno/functions:ro
    restart: unless-stopped
    deploy:
      replicas: 1
```

Notes:

- `env_file: ./.env` supplies `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `OLLAMA_BASE_URL` (and `CRON_SECRET` for the HTTP mode). The worker refuses
  to start without the first two.
- The volume is mounted **read-only**; the worker only reads code from it.
- Exactly **one replica**: claims use `FOR UPDATE SKIP LOCKED`, but a single
  poller is what the embedding checkpoint cadence was designed around.
- The service must join the same Docker network as the `ollama` and Supabase
  services (the compose default unless the stack declares named networks —
  mirror whatever `functions` uses).

## 3. Start and verify

```bash
cd "$STACK" && docker compose up -d --no-deps ai-knowledge-excel-worker
docker compose logs --tail=40 ai-knowledge-excel-worker
```

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
