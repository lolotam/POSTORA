# Codex Implementation Brief — Postora AI Agent: Knowledge Graph (GraphRAG) + follow-ups

**Author:** Claude (Opus 4.8), 2026-07-12
**For:** Codex (Terra 5.6) to implement autonomously; Claude will review the diff + rerun gates when done.
**Repo:** `F:\Postora_new` (`https://github.com/lolotam/postora.git`), branch `main`.

---

## 0. GROUND RULES — read before writing any code

1. **Backend is self-hosted Supabase on Contabo `86.48.2.205`**, Dokploy stack `postorasupabase-supabase-j8axyh`. Runtime API is `https://api.postora.cloud`.
2. **Edge functions do NOT deploy via git.** They live in a Docker volume and must be copied + reloaded:
   ```bash
   FN=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
   scp -i ~/.ssh/contabo_key <local>/index.ts root@86.48.2.205:$FN/<fn-name>/index.ts
   # verify sha256 matches, then from the stack code dir:
   ssh -i ~/.ssh/contabo_key root@86.48.2.205 \
     'cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code && docker compose restart functions'
   ```
   Use `docker compose restart functions` (NOT `up -d --no-deps`, which can skip the reload). `~/.ssh/contabo_key` is the working key (`contabo_ed25519` fails). The `ssh-contabo-mcp` MCP has a ~1000-char cap and is flaky — prefer direct `ssh`/`scp` via Bash.
3. **DB access:** `docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U supabase_admin -d postgres -c "..."`.
4. **SQL migrations** are applied manually to prod (there is no `supabase db push` here). Put new SQL under `supabase/manual-sql/<name>.sql` in the repo AND apply it via `psql`. Add RLS on every new table (users see only their own rows; admin full access) — copy the policy shape from `ai_knowledge_sources` / `ai_agent_allowed_models`.
5. **Typecheck edge functions** from the repo root: `deno check --node-modules-dir=none supabase/functions/<fn>/index.ts`. Frontend: `npx tsc --noEmit`, `npm test`, `npm run build`.
6. **Guards:** after production code changes run `clean-code-guard`; after test changes run `test-guard`. (These are Claude-side skills; if you can't run them, at least self-review against their rules: small functions, specific error handling, no swallowed errors, no hardcoded "ok" returns, names reveal intent.)
7. **Commit hygiene:** commit **only** the files you changed for a task (`git commit -F - -- <paths>`). **NEVER** commit: `b64.txt`, `package-lock.json`/`package.json` if it contains the `vite ^8.1.4` bump (that bump is a known local-build landmine — leave it staged/untracked, do not include it), `.env*`, logs, `stdout.txt`/`stderr.txt`, `.playwright-mcp/`, `.codex-briefs/`, secrets. There is currently a staged `package.json` with `vite ^8.1.4` and other unrelated WIP (`src/hooks/usePosts.tsx`, `src/hooks/useSocialAccounts.tsx`, `src/pages/Analytics.tsx`, `src/pages/ConnectionHealth.tsx`) — **do not commit those; they are not part of this task.**
8. **Push to `main`** only your scoped commits. Frontend auto-deploy via Dokploy does not reliably fire; if you change frontend, trigger a manual deploy of Dokploy app `jdYVwbuASi1kqZrfvKkrx` (POSTORA-PROJETC) via the `dokploy-contaboo-mcp` `application-deploy`.
9. **MCP routing** (use ONLY these for Postora): DB → `supabase_postora_mcp`; host/SSH → `ssh-contabo-mcp` (or direct ssh); deploy → `dokploy-contaboo-mcp`. Never the musalam/Abdelaziz/curemed servers.

---

## 1. ARCHITECTURE — the AI customer-service agent knowledge system

The AI agent answers inbound WhatsApp/Facebook/Instagram messages using the business's own knowledge (RAG) plus tools.

**Runtime flow (`supabase/functions/ai-agent-reply/index.ts`):**
1. Inbound message arrives (webhook → `ai-agent-reply`) with `{ user_id, platform, conversation_id, inbound_text, ... }`.
2. Load config from `ai_agent_configs` (system prompt, model + `fallback_model_1/2`, business profile, toggles).
3. Load conversation history from `ai_thread_messages` (last `HISTORY_LIMIT = 4` turns, ordered by `created_at`).
4. **RAG:** embed the inbound text (`embed()`), call RPC `match_ai_knowledge_chunks(query_embedding, p_user_id, match_count)`, keep chunks above `SIMILARITY_FLOOR = 0.15`, inject as context. On embed failure it degrades gracefully (`ragError`) and still replies.
5. Build the model chain `[model, fallback_model_1, fallback_model_2]`, each `"provider/model_id"`. `parseModelRef` splits provider (first segment if it's a known provider: openai/openrouter/google/gemini). `chatCompletion(provider, payload)` dispatches to the right OpenAI-compatible endpoint (`PROVIDER_ENDPOINTS`). Each call has `AbortSignal.timeout` so a hung free model lets the fallback fire.
6. Persist assistant + user turns to `ai_thread_messages`; mirror an outcome row into `system_logs` (category `"ai"`, surfaced at `/admin/logs`) with model used, fallback level, model_errors, rag_error, tokens, latency.

**Ingestion flow (`supabase/functions/ai-knowledge-ingest/index.ts`):** actions `ingest_source`, `ingest_profile_text`, `sync_catalog`, `delete_source`. It downloads the source file (now from a Cloudinary CDN URL), parses it (CSV/XLSX via `xlsx`, PDF via `unpdf`, TXT/MD as text, images via vision OCR), chunks it, `embed()`s the chunks, and inserts into `ai_knowledge_chunks`. Mirrors events into `system_logs`.

**Key tables (exact columns):**
- `ai_knowledge_sources(id, user_id, source_type, file_name, file_path, status, error, chunk_count, created_at, updated_at)` — `file_path` now holds a **Cloudinary CDN URL** (`https://res.cloudinary.com/...`), and it is **user-writable via RLS**.
- `ai_knowledge_chunks(id, source_id, user_id, content, metadata jsonb, embedding vector(1536), created_at)`.
- `ai_thread_messages(id, thread_id, user_id, role, content, tool_calls jsonb, created_at)` — full chat history; only the last 4 are replayed to the model.
- `ai_agent_configs(... model, fallback_model_1, fallback_model_2, business_profile_text, ...)`.
- `ai_agent_allowed_models(provider, model_id, label, is_active, sort_order)` — admin-curated allow-list (`/admin/settings` → AI Agent Models).
- `system_logs(source, category, level, message, user_id, metadata jsonb, created_at)` — the `/admin/logs` data source; AI rows use `category = "ai"`.
- RPC: `match_ai_knowledge_chunks(query_embedding vector, p_user_id uuid, match_count int DEFAULT 6) RETURNS TABLE(id, source_id, content, metadata, similarity)`.

**Frontend:** `src/components/messaging/AiKnowledgeManager.tsx` (upload/list sources), `AiAgentManager.tsx` (config + model dropdowns), `AdminAiAgentSection.tsx` (admin allow-list), WhatsApp Automation hub (`src/pages/whatsapp/Automation.tsx`, `waNav.ts`).

---

## 2. HISTORY — already DONE (do NOT redo these)

All merged to `main` and deployed/verified live unless noted. Newest first:

| Commit | What |
|--------|------|
| `fcd1ae94` | **Image OCR → Gemini.** `extractImageText` now uses `gemini-2.5-flash` (was `gpt-4o-mini`) via `GOOGLE_AI_STUDIO_KEY`. |
| `a185002a` | **Embeddings → Gemini + history window.** Both `embed()` sites (ai-agent-reply, ai-knowledge-ingest) call Gemini `gemini-embedding-001` with `dimensions:1536` (keeps `vector(1536)` column — no migration). `HISTORY_LIMIT` 10→4. Cloudinary destroy in `delete_source` scoped to caller's `media/{email}/` folder. |
| `0d6bfc19` | **Knowledge files → Cloudinary.** Uploads go through `cloudinary-upload` to `media/{sanitizedEmail}/ai-knowledge/` as `raw` assets; `file_path` stores the CDN URL; ingest downloads from that URL (SSRF-guarded to the Cloudinary prefix). |
| `ebbf3a9b` | Per-call provider timeouts (`AbortSignal.timeout`); OAuth `return_to` allowlist hardened. |
| `a7fe6fec` | Reply degrades gracefully (`ragError`) when the embedding provider is down. |
| `96591b99` | Provider dispatch (`parseModelRef`/`PROVIDER_ENDPOINTS`), server-side model allow-list validation in `messaging-api`, `system_logs` mirroring for admin logs, WhatsApp Automation nav restructure (6 sub-tabs; Human Agent → `/human-agent`), deep-link tab routes. |

**Root cause that drove the recent work:** OpenAI billing is **exhausted** ("You exceeded your current quota"). Everything AI now runs on **Gemini** via `GOOGLE_AI_STUDIO_KEY` using Gemini's OpenAI-compatible endpoints (`https://generativelanguage.googleapis.com/v1beta/openai/...`).

**Verified live 2026-07-12:** Gemini embeddings return exactly 1536 dims; embed→store→`match_ai_knowledge_chunks` round-trip ranked a paraphrased query correctly (return-policy chunk 0.62 > unrelated 0.52); the container has `GOOGLE_AI_STUDIO_KEY`.

**Conversation persistence requirement is DONE:** chats are stored in `ai_thread_messages` and only the last 4 turns are replayed (`HISTORY_LIMIT = 4`). Verify it still meets the user's intent; no new work expected here.

**Current known state:**
- 1 knowledge source exists in status `failed` (id `67cf0200-234f-43cf-97e8-1a0ce93bbb85`, user `7fe4d34e-1975-46fb-9dac-9c2df7a9eed6`) — it failed under the old OpenAI quota. Re-ingesting it (UI refresh button, or `ingest_source`) should now succeed. `ai_knowledge_chunks` currently has 0 rows.

---

## 3. CONCEPTUAL CORRECTION — read before Phase B

The user asked for the knowledge to be "saved as **graphify graph logic**", to "regularly upgrade the **graphify graph html** to **train the model**", and to "add **graphify obsidian**".

Translate this carefully — do **NOT** take it literally:
- **`graphify` in this repo is an AST-based *codebase* knowledge-graph tool** (`graphify-out/`, `graphify query`, `graphify update .`). It graphs the *source code*. It does **not** ingest per-user business documents and is **not** the right tool to run at request time. Do not wire `graphify` the CLI into the runtime agent.
- **"Train the model" is not literal.** There is no fine-tuning. The Gemini models are used as-is. What the user actually wants is **better, faster, more reliable retrieval** so the agent answers accurately. The lever is retrieval quality (RAG + a knowledge graph), not model training. Never attempt fine-tuning / training jobs.
- The **achievable** realization of the vision is **GraphRAG over each user's business knowledge**: extract entities + relations from the ingested chunks into a per-user graph, use it to augment retrieval, and optionally emit a browsable **HTML visualization** and an **Obsidian-style Markdown vault** as inspection artifacts (this is the honest analog of "graphify html" + "graphify obsidian").

Build the achievable version below. Keep it bounded — do not build a generic graph platform.

---

## 4. REMAINING WORK

### Phase A — Retune `SIMILARITY_FLOOR` for Gemini (small, do first)
Gemini cosine scores are compressed vs OpenAI: in testing an *unrelated* chunk still scored ~0.52, so the current `SIMILARITY_FLOOR = 0.15` (in `ai-agent-reply/index.ts`) lets noise through.
- Empirically calibrate: ingest ~2 real docs for a test user, run several real queries, log the similarity of relevant vs irrelevant chunks, and pick a floor that separates them (expected ~0.45–0.60 — **measure, do not guess**).
- Change the one constant, deno-check, deploy (scp + restart), and record the chosen value + the measurements in the commit message.
- **Acceptance:** an off-topic query returns no injected chunks; an on-topic query still retrieves the right chunk.

### Phase B — Per-user knowledge graph extraction + storage
Add graph tables and populate them during ingestion.
- **Schema** (`supabase/manual-sql/ai_knowledge_graph.sql`, apply via psql, add RLS):
  - `ai_knowledge_entities(id uuid pk, user_id uuid, name text, type text, description text, metadata jsonb, created_at)` — dedupe on `(user_id, lower(name), type)`.
  - `ai_knowledge_relations(id uuid pk, user_id uuid, source_entity_id uuid, target_entity_id uuid, relation text, weight real default 1, source_chunk_id uuid, created_at)`.
  - Indexes on `user_id`; unique index for entity dedupe.
- **Extraction:** in `ai-knowledge-ingest`, after chunks are embedded/stored, call Gemini (`gemini-2.5-flash`, JSON output) with a prompt that extracts `{entities:[{name,type,description}], relations:[{source,target,relation}]}` from the chunk text. Upsert entities (dedupe), then relations. Keep it **incremental** (per source) and idempotent (re-ingest of a source replaces that source's contributed entities/relations — track via `source_chunk_id`/a `source_id` column so you can delete-then-reinsert like the existing chunk logic does).
  - Guard for cost/latency: cap entities/relations per chunk; batch; wrap in try/catch so a graph-extraction failure **does not** fail the whole ingest (the vector RAG must still work). Log graph outcomes to `system_logs` (category `"ai"`, source `"ai-knowledge-ingest"`, an `action` like `"extract_graph"`).
- **Acceptance:** ingesting a doc creates entities + relations for that user; deleting/re-ingesting the source replaces them; a vector-only reply still works if extraction fails.

### Phase C — Query-time graph augmentation
Improve retrieval by combining vector search with graph context.
- In `ai-agent-reply`, after the vector `match_ai_knowledge_chunks` step: take the top matched chunks/entities, look up connected entities+relations from `ai_knowledge_relations` (1 hop, capped), and add a compact "Related facts:" block to the model context alongside the chunk text.
- Keep it additive and cheap (one extra indexed query). Preserve the graceful-degradation contract: if the graph query fails, reply with vector RAG only and record it (like `ragError`).
- **Acceptance:** for a query whose answer spans two linked facts (e.g., "which plan includes X and what does it cost"), the reply includes the linked info; latency stays within the existing timeout budget; disabling the graph path still yields a correct vector-only answer.

### Phase D — Scheduled graph refresh + HTML/Obsidian export artifacts
Realize "regularly upgrade the graph" and "graphify html / obsidian".
- **Refresh:** a schedule that keeps the graph current. Prefer event-driven (already incremental in Phase B) plus a lightweight periodic reconcile. If a cron is used, follow the existing `process-scheduled-posts` pattern (there is a pg_cron / scheduled-function mechanism in this project — reuse it; do not invent a new scheduler). Refresh must be idempotent and per-user.
- **HTML visualization:** generate a self-contained interactive graph HTML (inline JS/CSS, no external CDN — same constraints as Artifacts) per user, stored to Cloudinary (`raw`, under `media/{email}/knowledge-graph/graph.html`) or served by a small function; link it from the Knowledge tab (and/or `/admin/logs` for admins) so the user can inspect what the AI "knows". This is the honest version of "graphify html".
- **Obsidian export:** emit the graph as an Obsidian-compatible Markdown vault — one note per entity with `[[wikilinks]]` for relations — zipped/stored the same way, downloadable from the Knowledge tab. This is "graphify obsidian".
- Keep exports **on-demand or throttled** (do not regenerate on every message). These are inspection/quality aids, not on the reply hot path.
- **Acceptance:** user can open an up-to-date HTML graph of their knowledge and download an Obsidian vault; regeneration reflects newly ingested sources; nothing in this phase touches the reply latency path.

### Phase E — Re-verify the "last 4 messages" requirement
Confirm `HISTORY_LIMIT = 4` + `ai_thread_messages` fully satisfy "store chats, replay only last 4 on return." No code change expected — just validate with a real 5+ message conversation that turn 5 only sees turns 1–4's tail, and document the result. If the user meant 4 *exchanges* (8 messages) rather than 4 messages, flag it for Claude/the user rather than guessing.

---

## 5. DELIVERY & REVIEW CHECKLIST (what Claude will verify when you finish)

For each phase, in your final report include:
1. Files changed + commit hashes (scoped commits only; no forbidden files).
2. `deno check` / `tsc` / `npm test` / `npm run build` results (paste output).
3. New SQL: the `supabase/manual-sql/*.sql` file **and** confirmation it was applied to prod (psql `\d` of the new tables + a row count).
4. Which edge functions were scp'd + restarted, with matching sha256 (local vs remote).
5. Live verification evidence per phase's Acceptance criteria (real query → real result).
6. Confirmation that vector-only RAG still works if the graph path fails (degradation preserved).
7. Note any `SIMILARITY_FLOOR` retune value and the measurements behind it.

**Hard constraints to re-check before you commit:** both `embed()` sites still use the identical model + dimensions (a mismatch silently returns zero matches); no OpenAI calls reintroduced anywhere in the AI path; RLS present on every new table; no fine-tuning/"training" attempted; forbidden files not committed.

---

## 6. Quick reference — endpoints & keys
- Embeddings: `POST https://generativelanguage.googleapis.com/v1beta/openai/embeddings` — body `{"model":"gemini-embedding-001","input":<string|string[]>,"dimensions":1536}`, `Authorization: Bearer $GOOGLE_AI_STUDIO_KEY`.
- Chat/vision: `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` — models `gemini-2.5-flash` / `gemini-flash-latest` (both confirmed on this key). `gemini-2.0-flash` did NOT resolve — avoid it.
- Cloudinary upload: edge function `cloudinary-upload` (`fileType: "image"|"video"|"gif"|"raw"`, `subfolder`, `skipMediaFiles: true` for non-media). Folder = `media/{sanitizedEmail}/{subfolder}`. `sanitizeEmailForFolder` must be computed identically on both sides.
- Test user for live checks: `dr.vet.waleedtam@gmail.com` (admin, user_id `7fe4d34e-1975-46fb-9dac-9c2df7a9eed6`).
