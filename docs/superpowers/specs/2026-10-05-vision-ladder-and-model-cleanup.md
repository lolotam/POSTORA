# Vision ladder, dead-model cleanup, triage and search/video wiring

Date: 2026-10-05 · Status: A + B shipped (PR #267), C implemented, D designed only

## Why

On 2026-10-05 Google denied the old Gemini project (403). The replacement key belongs to a
new project, and new projects get **404 "no longer available to new users"** for
`gemini-2.5-flash`, `gemini-2.5-flash-lite` and `gemini-2.5-pro`. Images and PDFs sent to the
messaging agent are read through the **Speech-to-Text** ladder, where only the Gemini rung
can see, so one overloaded or retired Gemini model blinds the agent ("I'm not able to view
images"). This was observed on two WhatsApp accounts the same day.

Probe evidence (one real call per active Gemini model, new key):

| Result | Models |
|---|---|
| 404 retired for new users | gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro |
| 200 | gemini-3-flash-preview, 3.1-flash-lite(-preview), 3.5-flash(-lite), 3.6/3.7/3.8-flash, flash(-lite)-latest, 3.5-transcribe, embedding-001/2 |
| 429 quota (billing not enabled on the new project, not retired) | Pro, image-generation, omni models |

Also found: 72 active OpenRouter `:batch` models. They return 404 on
`/chat/completions` ("cannot be used with the chat/completions endpoint"), so selecting one
in any real-time ladder silently burns a rung. `default_ai_model_agent_fallback_2` held one.

## Phase A — dead-model cleanup (data + code constants)

Migration `…_retire_gemini_25_and_batch_models.sql`:
1. Repoint every setting / row that names a retired model to `gemini-3.1-flash-lite`
   (system_settings ladders, `ai_agent_configs.model` (deprecated, unread), 
   `profiles.ai_model` + its column default (ignored by the backend since the admin Chat
   config governs), `user_ai_model_overrides.model`).
2. Replace any `:batch` model in a `default_ai_model_*` slot with its non-batch twin.
3. Delete `ai_agent_allowed_models` rows and `ai_models` rows for the three retired models
   (`ai_model_preferences` cascades; it holds none).
4. Deactivate (`is_active=false`) every `:batch` model — kept, not deleted, because the
   catalog sync would re-insert them; inactive rows are hidden from every picker.

Code constants still calling a retired model at runtime (all → `gemini-3.1-flash-lite`):
`_shared/ai-fallback.ts` (default primary, image/tts last resorts),
`transcribe-media/index.ts`, `ai-knowledge-ingest/parsing.ts` (VISION_MODEL),
`ai-knowledge-ingest/index.ts` (GRAPH_MODEL), `_shared/inboundMediaUnderstanding.ts`
(DEFAULT_MODELS.gemini). Frontend placeholders/defaults updated to match.

## Phase B — "Image & Document Understanding" ladder (category `vision`)

Goal: images and PDFs that customers send follow their own admin-configured ladder
(default → fallback → fallback 2), exactly like the other AI categories. Voice notes stay on
Speech-to-Text.

Backend
- `_shared/inboundMediaUnderstanding.ts`
  - New `callOpenRouter` (chat/completions, `image_url` data URI for images,
    `file` part for PDFs), same `ProviderDeadline`, status-only errors, key in header.
  - `tierSupports`: image/document → `gemini` | `openrouter`; audio unchanged.
  - `attemptTier` routes `openrouter`; result parsing shared with Gemini (`visualResult`).
- `_shared/inboundMediaPipeline.ts`
  - `resolveCategoryTiers(admin, category)` generalises `resolveSttTiers`;
    `PROVIDER_KEY_ENV.openrouter = ["OPENROUTER_API_KEY"]`.
  - Tiers chosen by kind: audio → `stt`, image/document → `vision`.
- `_shared/ai-fallback.ts`: `CATEGORY_LAST_RESORT.vision = openrouter/google/gemini-3.1-flash-lite`
  (a different vendor account than the Gemini key, so one outage cannot take out both).

Data (migration `…_vision_category.sql`)
- Capability `vision` on: gemini `gemini-3.1-flash-lite`, `gemini-3.5-flash`;
  openrouter `google/gemini-3.1-flash-lite`, `google/gemini-3.5-flash`,
  `google/gemma-4-31b-it:free` (inserted if missing).
- Seed ladder (only if unset): gemini/gemini-3.1-flash-lite →
  openrouter/google/gemini-3.1-flash-lite → openrouter/google/gemma-4-31b-it:free.

Frontend
- `ModelCategory` + `MODEL_CATEGORIES` gain `vision`.
- `VisionModelsCard` ("Image & Document Understanding") in `AiCategoryCards.tsx`,
  registered in `AdminSettings.tsx` + `settingsCatalog.ts` (sub-tab next to Speech to Text).
- Speech-to-Text card description says it covers voice only.

Tests: provider routing per kind, OpenRouter request shape + parsing, ladder order, a
retired/failed first rung falling through, category resolution by kind.

## Phase C — Triage with chat models (implemented)

Triage calls provider-specific yes/no endpoints (`openrouter …/systemone`,
`vercel …/evaluate`) that only Jev answers, so all three slots held Jev.

- `agentTriage.ts`: each tier has a `kind`. A slot is `decision` only when its model has
  catalogue capability `triage` on a decision provider; every other slot (DeepSeek,
  Gemini, any OpenRouter chat model) is `chat` and gets the same questions as strict JSON
  (`chatTriageRequestBody` / `parseChatTriageAnswers`). Malformed answers are "unsure",
  never guessed. Claude slots stay ignored (no JSON mode on its API).
- Budget: 1.5 s for decision-only chains (unchanged), 3 s when a chat tier is present;
  first-tier cap 0.9 s (decision) / 1.8 s (chat). Knowledge retrieval runs concurrently.
- `ai-fallback.callChatCompletion` reaches a chat tier with the agent's own key and
  endpoint resolution; `ai-agent-reply` reads which slot models are decision models.
- Admin picker: triage lists `triage` and `triage_chat` models. `triage_chat` is a
  separate tag because the catalogue sync manages `triage` on OpenRouter.
- Measured on the real triage prompt, 2026-10-05 (3 messages × 4 models, all 12 correct):
  ministral-8b 0.90–1.28 s, gemini-3.1-flash-lite (OpenRouter) 0.81–0.95 s,
  gpt-5.4-nano 1.30–1.45 s, deepseek-flash direct 1.36–1.44 s. Rejected: qwen3.5-flash
  (non-JSON), llama-4-scout (404), deepseek-v4-flash via OpenRouter (2.7–4.8 s).
- Migration `20261005150000_triage_chat_models.sql` tags them and moves the last slot
  from a second Jev to ministral-8b. Applied **after** the code deploys: the old code
  would send that model to the decision API.

## Phase D — Video and Search ladders (designed, later PR)

Verified: neither `default_ai_model_video*` nor `default_ai_model_search*` is read at
runtime; no web-search feature or toggle exists; `VideoGenerator.tsx` is not mounted.
- Fix first: `CATEGORY_LAST_RESORT[category] || chat` falls back to a chat model for
  `video`/`search`.
- Search: new `_shared/webSearch.ts` running the search ladder (perplexity/sonar,
  brave, exa adapters). Opt-in only: a per-agent "Use web search" switch (new column on
  the agent config, `web_search` tool registered only when on) and a `webSearch` flag on
  `generate-caption`. Off by default because it adds latency.
- Video: `generate-video` builds the ladder when the client sends no `model_id`, and
  advances a tier when start fails.
