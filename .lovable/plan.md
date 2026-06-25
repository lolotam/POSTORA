## Goal

Refresh the `ai_providers` / `ai_models` catalog with the newest publicly available models for every provider already in the DB, across **chat, image, video, TTS, STT, and embeddings**, and add Firecrawl as a visible provider in the admin AI catalog.

Per project rule, **no SQL will run automatically** — everything goes into a single reviewable script under `supabase/manual-sql/`.

---

## 1. Research phase (web search, no code yet)

I'll look up the current production model IDs for each provider as of June 2026. Sources: official provider docs + API references.

Providers to cover (already in `ai_providers`):

| Provider code | Latest models to add (research targets) |
|---|---|
| `openai` | GPT‑5.4 / 5.4‑pro / 5.4‑nano, GPT‑5.5 / 5.5‑pro, o4, o4‑mini, `gpt-image-2`, `gpt-image-1-mini`, `gpt-4o-mini-tts`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `text-embedding-3-large/small`, Sora 2 (video) |
| `claude` (Anthropic) | Claude Opus 4.6 / 4.8, Sonnet 4.6 / 4.8, Haiku 4.6, plus newest 6.x if released |
| `gemini` / `google` | `gemini-3-flash-preview`, `gemini-3.1-flash`, `gemini-3.1-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `gemini-2.5-flash-image` (Nano Banana), `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3-pro-image`, `imagen-4-ultra`, `veo-3`, `gemini-embedding-001`, `gemini-embedding-2` |
| `xai` | Grok 4.1, Grok 4.1 Mini, Grok Code Fast, Grok 4 Heavy, Grok Image v3, Grok video if available |
| `minimax` | MiniMax M2, M1, Speech 2.6 HD, Hailuo 02 (video), abab7-chat |
| `zai` | GLM‑4.7, GLM‑4.7‑Air, GLM‑4.7‑Flash, GLM‑Z1 reasoning, CogVideoX‑2 |
| `openrouter` | Already dynamic via `useOpenRouterModels` — no seed needed |
| Image‑only / video providers in DB (Runway, Luma, Pika, fal, ElevenLabs if seeded) | Latest endpoints (Runway Gen‑4, Luma Ray 2, Kling 2.1, ElevenLabs v3 / Multilingual v2) |

I will **not invent IDs** — anything I can't confirm from official docs gets dropped or flagged as `is_active = false` with a comment.

---

## 2. Catalog refresh SQL (manual, idempotent)

One file: `supabase/manual-sql/20260625_refresh_ai_catalog.sql`

Structure:

```text
-- Section A: ensure missing providers exist (Firecrawl)
-- Section B: insert new chat models per provider
-- Section C: insert new image models
-- Section D: insert new video models
-- Section E: insert new TTS / STT / embedding models
-- Section F: deprecate (is_active=false) clearly retired IDs
```

Patterns used:

- `INSERT … SELECT p.id, …  FROM ai_providers p WHERE p.provider_code = '…' ON CONFLICT (provider_id, model_id) DO NOTHING;` — safe to re‑run.
- `UPDATE ai_models SET name=…, description=…, cost_per_1m_input_tokens=…, cost_per_1m_output_tokens=… WHERE …` for re‑pricing existing rows.
- `UPDATE ai_models SET is_active = false WHERE model_id IN (…)` to retire dead IDs (e.g. `gpt-4`, `claude-3-opus`, `gemini-1.5-*`) without deleting history.

Rollback notes included at the top of the file.

---

## 3. Firecrawl in the admin catalog

Two parts:

**a. Verify v2 usage in code** (read‑only check)
- `supabase/functions/brand-scrape/index.ts` already hits `https://api.apify.com/...` for some flows and other functions may hit Firecrawl. I'll grep for `firecrawl.dev` references and confirm everything is on `/v2/...`. Report any `/v0` or `/v1` leftover; fix only if user approves a follow‑up.

**b. Add Firecrawl as a "provider" row** so it appears in the admin AI dashboard alongside LLMs:
```sql
INSERT INTO public.ai_providers
  (provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming, is_active)
VALUES
  ('firecrawl', 'Firecrawl', 'https://api.firecrawl.dev/v2', 'FIRECRAWL_API_KEY', 'rest', false, true)
ON CONFLICT DO NOTHING;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['search'], true
FROM public.ai_providers p,
  (VALUES
    ('firecrawl-scrape-v2','Firecrawl Scrape v2','Single‑URL scrape, markdown/html/json/branding'),
    ('firecrawl-search-v2','Firecrawl Search v2','Web search with optional scraping'),
    ('firecrawl-map-v2','Firecrawl Map v2','Fast sitemap / URL discovery'),
    ('firecrawl-crawl-v2','Firecrawl Crawl v2','Recursive site crawl')
  ) AS v(model_id, name, description)
WHERE p.provider_code = 'firecrawl'
ON CONFLICT DO NOTHING;
```

UI side: `DefaultModelSelector` already filters by `capability`. Adding `'search'` as a category in `CATEGORY_LAST_RESORT` / `CATEGORY_MODALITY` is already present, so Firecrawl will show up automatically once the SQL runs. No UI code change required.

---

## 4. Frontend / catalog code touch‑ups (small, optional)

- `src/components/admin/DefaultModelSelector.tsx` — extend `CATEGORY_LAST_RESORT` defaults to point to the new flagship IDs (e.g. chat → `gemini-3-flash-preview` already there, image → `gemini-3.1-flash-image` once added).
- No changes to `generate-image`, `generate-caption`, `ai-fallback.ts` runtime logic in this task — model selection stays admin‑controlled.

---

## 5. Validation

- `npm run lint` and `npm run build` (no functional code paths change, but TS still compiles).
- `git diff --check` for whitespace.
- CleanCodeGuard / TestGuard pass (no tests changed → state "no test files changed").
- I will **not** run the SQL. The final report will include:

```text
DATABASE ACTION REQUIRED:
A manual SQL script was created at:
supabase/manual-sql/20260625_refresh_ai_catalog.sql

This SQL was NOT executed automatically.
The project owner must review and run it manually.
```

---

## 6. Out of scope (explicit)

- No edits to historical migrations under `supabase/migrations/`.
- No live provider API verification (would burn credits and need real keys).
- No automatic retirement of models still in active use by `default_models` rows — those need a manual switch in the admin UI before they can be deactivated; the SQL will skip deactivating any model referenced by `default_models`.

---

## Files that will change

- **New:** `supabase/manual-sql/20260625_refresh_ai_catalog.sql`
- **Edited (small):** `src/components/admin/DefaultModelSelector.tsx` (last‑resort defaults only, if newer flagship IDs land)
- **No other code changes.**
