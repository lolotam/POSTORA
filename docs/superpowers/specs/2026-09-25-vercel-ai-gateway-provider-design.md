# Vercel AI Gateway provider + model catalogue sync — design

Date: 2026-09-25 · Branch: `feat/vercel-ai-gateway-provider` · Status: draft for review

## Goal

1. Add **Vercel AI Gateway** as a provider on `/admin/settings?tab=ai`, with a Test card on
   *Providers* and its models shown only in the sub-tab they belong to (chat models in
   *Chat Models* and *AI Agent*, embedding models in *Embedding*, image models in
   *Image Generation*, and so on).
2. Make every section's selected Vercel model **actually callable**: chat, agent, embedding,
   image, video, text-to-speech and speech-to-text.
3. Add a direct **DeepSeek** provider (`https://api.deepseek.com`, OpenAI-compatible).
4. Bring the model lists of OpenRouter, OpenAI, Anthropic (`claude`), xAI, z.ai (`zai`) and
   DeepSeek up to date, and keep Vercel and OpenRouter current with a "Sync models" button.

## Facts this design rests on (verified 2026-09-25)

- The AI tab is database-driven. Providers live in `ai_providers`, models in `ai_models`
  (`capabilities text[]` decides which sub-tab lists them), and the chosen defaults live in
  `system_settings.default_ai_model_<category>[_fallback|_fallback_2]`. Keys come from
  `provider_api_keys` (written by *Save & Test*), with the provider's `api_key_env_var`
  environment variable taking priority.
- **Runtime calls ignore `ai_providers.api_endpoint`**, except in `generate-image`. Each
  runtime has its own hardcoded list of provider URLs:
  - `_shared/ai-fallback.ts getAiEndpoint`, used by captions, hashtags and other chat callers
  - `ai-agent-reply/index.ts PROVIDER_ENDPOINTS`, with `logic.ts KNOWN_MODEL_PROVIDERS`
  - `_shared/knowledgeEmbeddings.ts selectionConfig`, which throws on any unknown provider
  - `AdminAiAgentSection.tsx AGENT_PROVIDER_CODES`, the provider allow-list for the AI Agent tab
- `GET https://ai-gateway.vercel.sh/v1/models` is public and typed. It lists 390 models:
  language 264, video 35, image 34, embedding 26, realtime 9, speech 8, transcription 8,
  reranking 5, evaluation 1.
- The key the user supplied **authenticates**: a request with a bad key gets 401, while the
  real key gets 403 `customer_verification_required`. **The Vercel team has no credit card on
  file, so every inference call fails until one is added.** The Test card must report this
  plainly rather than showing a bare "failed".
- `parseModelRef` splits on the first `/` only when the prefix is a known provider, so agent
  refs like `vercel/openai/gpt-5.5` parse correctly once `vercel` is added to the list.
- Video already runs as background jobs: `generate-video` inserts an `ai_generation_jobs`
  row, and `ai-generation-status` polls the job per provider. TTS has **no runtime
  consumer** today.

## Design

### 1. Data (one migration)

- Insert into `ai_providers`:
  - `vercel`: name "Vercel AI Gateway", `api_type='openai'`,
    `api_endpoint='https://ai-gateway.vercel.sh/v1'`,
    `api_key_env_var='AI_GATEWAY_API_KEY'`
  - `deepseek`: name "DeepSeek", `api_type='openai'`,
    `api_endpoint='https://api.deepseek.com'`,
    `api_key_env_var='DEEPSEEK_API_KEY'`
- No models are seeded here; Section 2's sync fills them in.
- **The API key never goes in the migration or the repo.** The admin enters it through the
  Providers card's *Save & Test*.
- The one-off refresh for OpenAI, `claude`, `xai` and `zai` (Section 2b) ships as a second,
  data-only migration so it can be reviewed separately.

### 2. Model catalogue sync

**2a. Live sync (Vercel, OpenRouter, DeepSeek)** is a new admin-only
`ai-config` action, `sync-models { provider_code }`. It follows the existing Higgsfield
`sync_models` pattern and lives in one pure mapping module,
`_shared/modelCatalogSync.ts`, so the mapping can be unit-tested.

| Source | Field | Maps to `capabilities` |
|---|---|---|
| Vercel `/v1/models` | `type` | `language`→chat, `image`→image, `video`→video, `embedding`→embedding, `speech`→tts, `transcription`→stt |
| OpenRouter `/api/v1/models` | `architecture.output_modalities` | contains `image`→image; `embeddings` output→embedding; otherwise text output→chat |
| DeepSeek `/models` | none (a handful of ids) | chat |

- **Skipped on purpose:** Vercel `realtime`, `reranking` and `evaluation` models. Postora has
  no feature that uses them, and that includes `typesafe-ai/jev`, an *evaluation* model. On
  OpenRouter, typesafe/jev-style ids that report text output are synced as chat.
- **Fields carried over:** `name`, `description`, `context_window`→`context_limit`, and
  pricing per token × 1e6→`cost_per_1m_*`. Embedding models get
  `metadata.embedding_dimensions` where the source reports it; Vercel video models keep
  their capability `tags` (t2v, i2v, r2v) in `metadata.tags`.
- **Upsert** on `(provider_id, model_id)`. A sync never overwrites `admin_params` and never
  reactivates a model the admin switched off.
- **Deactivation guard:** a model that disappears from the provider's list is deactivated,
  **unless** some `default_ai_model_*` setting points at it. Those models stay active, and
  the sync response lists them as "stale but in use" so a routine sync can't silently break
  a fallback chain.
- **Response:** `{ added, updated, deactivated, kept_in_use[], skipped_by_type{} }`, shown as
  a toast.

**2b. One-off refresh (OpenAI, `claude`, `xai`, `zai`).** These providers' `/models`
endpoints return bare ids, so sorting them into sections automatically would misfile models.
Instead, a curated data migration adds the current flagship ids, taken from the Vercel
catalogue and each provider's own docs. For example: OpenAI `gpt-6-astra`, `gpt-6-luna`,
`gpt-5.6-sol|luna|terra`, `gpt-image-2`; Anthropic `claude-opus-5.5`, `claude-sonnet-5`,
`claude-fable-5.1`, `claude-haiku-4.5`; plus current Grok and GLM ids. Each id is checked
against that provider's live `/models` output before it goes in. Retired ids are
deactivated, and the same deactivation guard applies.

### 3. Runtime: one data-driven path for OpenAI-compatible providers

This is the core change, and the reason DeepSeek and any future OpenAI-compatible provider
will need no new code.

- New shared resolver `_shared/providerEndpoint.ts`, with
  `resolveProviderEndpoint(admin, provider_code)` → `{ baseUrl, apiType, headers, apiKey }`.
  It reads the `ai_providers` row and uses the existing key lookup (env var first, then
  `provider_api_keys`). It caches per isolate.
- `getAiEndpoint` (`ai-fallback.ts`) keeps its explicit branches for `claude`, `openai`,
  `openrouter`, `xai` and Google. Any other provider whose row has `api_type='openai'` now
  goes to `{api_endpoint}/chat/completions` instead of falling through to Google.
- `ai-agent-reply`: add `vercel` and `deepseek` to `KNOWN_MODEL_PROVIDERS`, and resolve
  their endpoints through the new resolver rather than the hardcoded map.
  `AGENT_PROVIDER_CODES` in `AdminAiAgentSection.tsx` gains `vercel` and `deepseek`.
- `knowledgeEmbeddings.selectionConfig`: add `vercel`, which posts to `{base}/embeddings` and
  passes `dimensions` to match the target vector column (1536 or 1024). The *Embedding*
  selector lists only Vercel embedding models whose `metadata.embedding_dimensions` can be
  1536 or 1024, or which accept a `dimensions` parameter. That stops an admin from picking
  a model that would fail on insert.
- Chat request bodies use the gateway's standard OpenAI chat-completions format. Vercel
  model ids already include the vendor (`openai/gpt-5.5`), and that is what gets stored in
  `model_id`.

### 4. Image, video, TTS and STT runtimes for Vercel

Gateway image, video and speech are not plain OpenAI endpoints. They go through the gateway's
own model endpoints, which the official `@ai-sdk/gateway` + `ai` packages wrap. Edge
functions import these as `npm:ai` and `npm:@ai-sdk/gateway`, pinned, and all use of them
stays behind one module, `_shared/vercelGateway.ts`, that nothing else imports directly.

- **Image:** `generate-image` gains a `vercel` branch that calls `generateImage` with
  `gateway.imageModel(id)`. The result bytes are uploaded to the existing storage/Openinary
  path, the same as the other providers.
- **Video:** `generate-video` gains a `vercel` branch that calls `experimental_startVideo`
  and stores the returned `operation` in the new job row
  (`ai_generation_jobs.provider='vercel'`). The call returns right away, which keeps it
  inside the 60-second worker ceiling. `ai-generation-status` gains a `vercel` branch that
  calls `experimental_getVideoStatus` and downloads the hosted URL into storage before the
  gateway's `expiresAt`. Image inputs go in as hosted URLs; inline base64 has a 300 KiB cap.
  Quota reserve and release follow the Higgsfield flow that already exists.
- **TTS:** a new admin-only `generate-speech` edge function, driven by the Vercel tiers of
  the `default_ai_model_tts` chain, through the AI SDK's `generateSpeech`. It returns base64
  audio and stores nothing. The only UI is a "Try voice" preview on the *Text to Speech*
  card. Wiring TTS into the post composer is a separate follow-up.
- **STT:** `transcribe-media` gains a `vercel` branch for `transcription` models.

### 5. Admin UI

- **Providers card:** the Vercel and DeepSeek rows appear on their own, because the card
  already lists every provider row. The Test button now calls
  `ai-config test-connection`, which uses the provider's first active chat model instead of
  the hardcoded `gpt-4o-mini` (the gateway needs `openai/gpt-4o-mini`). Its result is
  mapped as follows:
  - 403 `customer_verification_required` → "Key valid — add a credit card in Vercel to
    enable requests"
  - 401 → "Invalid key"
- **Sync models button** in the provider dialog for Vercel, OpenRouter and DeepSeek, with a
  last-synced time stored in `system_settings` (`model_catalog_synced_at_<code>`).
- **Save & Test** saves a billing-blocked gateway key and shows a warning, since a 403
  `customer_verification_required` proves the key authenticates.
- **Model selector:** `DefaultModelSelector` already shows a searchable list for OpenRouter.
  That becomes a searchable list for any provider with more than 25 models in the section,
  fed from `ai_models` for Vercel. It groups models by vendor prefix (`openai/`,
  `anthropic/`…). Vercel video models also show their t2v, i2v or r2v tag.

### 6. Error handling

- Gateway `customer_verification_required`, `authentication_error` and 429 are turned into
  `AiError`, so the existing fallback chain moves on to the next tier. The rule from
  `postora-200-with-error-body` still applies: a 200 with no `choices` is a failure.
- A sync that fails partway through writes nothing; the upsert runs as a single batch.
- `providerEndpoint` resolution throws a clear error for inactive providers, and for
  providers whose type isn't openai and that have no explicit branch.

### 7. Testing

- **Unit (Deno):** covers the following.
  - `modelCatalogSync` mapping, using recorded Vercel and OpenRouter fixtures that include
    `typesafe-ai/jev`, the realtime and reranking types that get skipped, and the
    deactivation guard.
  - `resolveProviderEndpoint`
  - `parseModelRef('vercel/openai/gpt-5.5')`
  - error mapping for 403 and 401
- **Frontend (Vitest):** the selector filters Vercel models per capability, the searchable
  list appears for large providers, and the Test result messages are right.
- **DB harness:** the migration applies and replays cleanly, and the provider rows are unique.
- **Live checks after the card is added:** Test card; one chat call through captions; an agent
  reply; one embedding at 1536; one image; one video job to completion; one TTS preview.
  Until the card is on file, only the 403 path can be verified live.

## Out of scope / non-goals

- Realtime voice, reranking and evaluation models, including `typesafe-ai/jev`, because
  Postora has no feature that uses them.
- Using TTS anywhere in the product beyond the admin preview.
- Letting end users bring their own Vercel key: `user-ai-providers` stays limited to
  openai, claude, gemini and openrouter.
- Encrypting `provider_api_keys` at rest, which is an existing gap outside this change.

## Delivery order and deploy

1. Migration: provider rows (applied manually on Contabo before the code, then a PostgREST
   reload).
2. Edge functions: the resolver, sync and runtimes. Deployed through `ssh-contabo-mcp`
   following the runbook; `npx supabase functions deploy` is not used.
3. Frontend (auto-deploys on merge to `main`).
4. Admin: *Save & Test* with the Vercel key, then *Sync models* on Vercel, OpenRouter and
   DeepSeek.
5. Data-only migration for the one-off refresh.

## Prerequisites from the user

- Add a credit card to the Vercel team (AI Gateway → add card) to unlock requests.
- Rotate the Vercel key that was pasted into chat, and enter the new one through *Save & Test*.
- Supply a DeepSeek API key.
