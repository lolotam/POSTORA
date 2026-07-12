# AI Knowledge Excel Worker Design

## Problem

`ai-knowledge-ingest` parses XLSX workbooks inside the Supabase Edge Runtime. A 2 MB workbook uploaded by `xsellpointkw@gmail.com` exceeded the Edge Runtime CPU and memory limits. The runtime supervisor cancelled the request before the function's catch block executed, leaving its `ai_knowledge_sources` row in `processing` with no chunks or persisted error.

## Scope

Move Excel source ingestion to a dedicated Docker worker. Keep the existing Cloudinary upload, source-row schema, chunk format, Gemini embeddings, graph extraction, and Knowledge UI unchanged.

## Architecture

1. The edge function validates ownership and queues Excel sources by setting their status to `pending`, then returns immediately.
2. A single Deno worker service polls the database for pending Excel sources and atomically claims one source at a time.
3. The worker downloads the Cloudinary asset, parses its workbook outside Edge Runtime limits, replaces chunks, generates embeddings, records graph entities and relations, and sets the source to `ready`.
4. The worker records an error and sets the source to `failed` for ordinary failures. Sources stranded in `processing` by a worker restart are eligible for reclaim after a bounded stale interval.

## Data Flow

`AiKnowledgeManager` uploads the file to Cloudinary and inserts `ai_knowledge_sources` exactly as it does now. For `source_type = 'excel'`, `ai-knowledge-ingest` returns `{ queued: true }` instead of parsing in the Edge Runtime. The worker owns the asynchronous transition from `pending` to `processing`, then `ready` or `failed`.

## Safety

- One worker replica and an atomic database claim prevent duplicate processing.
- The worker accepts only Cloudinary CDN URLs or the existing storage-bucket paths.
- Secrets remain in the existing Dokploy `.env` file; no values are committed or logged.
- The worker retries only stale `processing` records. It does not retry terminal `failed` rows without an explicit requeue.

## Acceptance Criteria

- A 2 MB XLSX source reaches `ready` with chunks instead of returning API 500.
- A processing error writes a readable source error and status `failed`.
- A stale source can be reclaimed after a worker interruption.
- Non-Excel source ingestion behavior remains unchanged.
