# AI Agent Setup restructure — Knowledge & Settings

Date: 2026-09-05
Branch: `feat/agent-setup-restructure`
Status: design approved (advisor-reviewed; user delegated design questions to the advisor)

---

## 1. Problem

`UnifiedAgentSetupPage` is the one place a user configures the agent for WhatsApp,
Facebook, Instagram and Threads. Two of its five tabs have grown into flat walls of
controls:

**Knowledge tab** (`AiKnowledgeManager`, 678 lines) stacks four unrelated cards in one
scroll: a single opaque "Business profile" textarea, a file upload card, an optional
WhatsApp catalog card, the Sources list, and a knowledge-graph export card. The user
cannot tell which of those actually feed the vector database, and the business profile
is one free-text blob with no structure to guide what to write.

**Settings tab** (`AiAgentManager`, 461 lines) is a long form: enable switch, mode,
language, a persona textarea, admin phone numbers, then an "Advanced" card of two
numbers. Tone, response length, business goals, greeting, and hallucination controls
either do not exist or are buried inside the free-text persona where nothing validates
them.

There is also **no website ingestion at all**. `FIRECRAWL_API_KEY` is configured in the
admin panel and is present in the production functions container, but the only code that
touches Firecrawl is `ai-config`'s connectivity test. A user who wants their public site
in the agent's knowledge has to copy-paste it by hand.

## 2. Goals

1. Knowledge becomes three input methods behind sub-tabs — **Manual**, **Upload**,
   **Website** — with one **persistent Sources panel pinned below** that stays visible on
   all three, because it is the live mirror of what is actually in the vector DB.
2. The Manual method becomes a **structured business profile** (industry, products,
   policies, FAQs, notes) instead of one textarea.
3. Settings becomes **modular cards**: Identity & Tone, Business Model & Goals,
   Guardrails, Human Handoff, Advanced. Every control it shows must actually reach the
   model's system prompt.
4. Website scraping via **Firecrawl**, with a live status the user can watch.
5. Everything stays **identical across all four platforms** — this is one component tree
   parameterised by `platform`/`accountId`, exactly as it is today.

## 3. Non-goals

- **DOCX/Word ingestion.** `parsing.ts` and `getKnowledgeSourceType` have no Word path;
  a Deno `.docx` parser is a separate slice. Supported types stay CSV, XLSX, XLS, PDF,
  TXT, MD, PNG, JPG, WEBP.
- **Changing the embedding pipeline.** Chunking, dual embeddings, the graph extraction
  and the retrieval RPCs are untouched.
- **New account/tenancy semantics.** Source visibility keeps the existing
  shared/restricted + `ai_knowledge_source_accounts` model.
- **A redesign of the platform picker or the DMs/Comments surface toggles.**

## 4. Constraints discovered in the codebase (these shape the design)

| Fact | Where | Consequence |
|---|---|---|
| `ai_upsert_config` has a hard-coded `allowedFields` list | `supabase/functions/messaging-api/index.ts:481` | Any new column must be added there **and** to `CONFIG_FIELDS` in `src/hooks/useAiAgentConfig.ts`, or the field is silently dropped. |
| PostgREST rejects the **whole row** on an unknown column (PGRST204) | memory: `postgrest-missing-column-drops-whole-row` | Migrations must land in prod **before** the frontend that references the columns. `main` auto-deploys the frontend. |
| `handoff_on_request` / `handoff_on_low_confidence` are stored but **never read** by `ai-agent-reply` | verified by grep over `ai-agent-reply/*.ts` | They are dead columns today. Either wire them into `buildSystemPrompt` or do not render them. This design wires them. |
| `knowledgeOnlyRule()` and the escalate-on-unknown rule are unconditionally ON | `ai-agent-reply/logic.ts:239-289` | The "Strict knowledge mode" and "Admit not knowing" switches in the Arabic proposal describe behaviour that is **already always on**. Shipping them as toggles would let a user turn off a guard added after the 2026-09-01 hallucination incident. They ship as **locked-on informational rows**, not switches. |
| `loadAgentConfigForAccount` and `useAiKnowledge` both `select("*")` | `_shared/agentConfigLookup.ts:46`, `useAiKnowledge.ts` | New columns flow through to the UI with no read-site change. (Contrast `useSocialAccounts`, which hand-picks columns.) |
| `ai_knowledge_sources` has no `metadata` column | verified against prod | Crawl job state needs one. |
| The edge worker dies at ~60s | `WORK_BUDGET_MS = 45_000` in the excel worker | A full-site crawl cannot run inline. |
| **No cron drains the knowledge queue.** `cron.job` holds only `prune-ai-knowledge-graph-daily`; the standalone `EXCEL_WORKER_POLL` container is **not running** | verified on Contabo | Today a queued source would sit forever. Nothing is stuck right now (0 pending rows), but a queued crawl would never finish. **This design adds the missing cron.** |
| `FIRECRAWL_API_KEY` is set in the prod functions container (35 chars) | verified on Contabo | The scrape path has a working key; resolution follows `ai-config`'s pattern (env first, then `provider_api_keys`). |
| The Settings form's state machine is load-bearing | `AiAgentManager` comments + 5 test files | `configLoaded`, `mergeUntouchedFields`, `loadedAccountId`, `confirm_clear` encode three separate production outages. The card split must be **presentational only**. |

## 5. Architecture

### 5.1 Data model

Two migrations, applied in this order, each ahead of the frontend that uses it.

**Migration A — agent configuration**

```sql
ALTER TABLE public.ai_agent_configs
  ADD COLUMN business_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN agent_behavior   jsonb NOT NULL DEFAULT '{}'::jsonb;
```

`business_profile` shape (all keys optional; unknown keys are rejected server-side):

```jsonc
{
  "industry": "ecommerce",        // ecommerce | clinic | b2b_services | restaurant | other
  "products": "…",                 // free text
  "policies": { "returns": "…", "shipping": "…", "warranty": "…" },
  "faqs": [ { "q": "…", "a": "…" } ],
  "notes": "…"                     // migration target for any existing free-text profile
}
```

`agent_behavior` shape:

```jsonc
{
  "tone": "friendly_professional", // friendly_professional | formal | enthusiastic | concise
  "response_length": "medium",     // short | medium | detailed
  "goals": ["recommend_products", "answer_pricing", "handle_complaints", "capture_leads"],
  "greeting": "…",
  "instruction_blocks": [ { "title": "…", "body": "…" } ]  // max 10, 2000 chars each
}
```

**`business_profile_text` stays, and stays authoritative for ingestion.** The server
renders the structured object into that column inside `ai_upsert_config`. This is the
single most important decision in the design: `ingest_profile_text`, `chunkProfileText`,
`blankedFields`/`confirm_clear`, `mergeUntouchedFields` and the retrieval path all read
`business_profile_text`, and none of them change. A client-side render would put the
composition step behind the same form that has already caused two blanking outages.

The renderer is a pure function in a new `supabase/functions/_shared/businessProfileText.ts`
so the same code can be unit-tested under Deno and mirrored in the UI preview.

Backfill: existing non-empty `business_profile_text` becomes `business_profile.notes`
in the same migration, so no wording is lost and the Manual tab opens pre-filled.

**Migration B — knowledge sources**

```sql
ALTER TABLE public.ai_knowledge_sources
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.ai_knowledge_sources
  DROP CONSTRAINT ai_knowledge_sources_source_type_check,
  ADD CONSTRAINT ai_knowledge_sources_source_type_check
    CHECK (source_type IN ('excel','csv','pdf','doc','image','catalog','profile_text','website'));
```

plus `CREATE OR REPLACE FUNCTION public.claim_ai_knowledge_excel_source()` extended so a
`website` source with `queued_at IS NOT NULL` is claimable — same rule the document types
already use, so a crawl cannot be claimed before the crawl job id has been recorded.

For a `website` source: `file_path` holds the URL, `file_name` holds the display title,
and `metadata` holds `{ mode, crawl_job_id, stage, pages_done, pages_total, url }`.
`stage` is one of `submitted | crawling | extracting | embedding` and is what the
"live checklist" in the UI renders — the source list already polls every 5s while a
source is `pending`/`processing`, so no new transport is needed.

### 5.2 Prompt wiring

`buildSystemPrompt` in `ai-agent-reply/logic.ts` gains one new block, inserted **between
the persona and the `Rules:` list**, built by a new pure function `behaviorRules(behavior)`:

- tone → one sentence
- response_length → an explicit length instruction (short ≈ 1–2 sentences, medium ≈ a
  short paragraph, detailed ≈ full explanation with steps)
- goals → a bulleted "Your objectives in this conversation" list
- greeting → used only on the first assistant turn of a conversation
- instruction_blocks → rendered as titled sub-sections

`handoff_on_request` and `handoff_on_low_confidence` stop being dead columns: the two
existing hard-coded handoff rules become conditional on them, defaulting to `true`
(their current column default), so behaviour is unchanged for every existing config.
The hallucination guard (`knowledgeOnlyRule`) stays unconditional.

`persona_instructions` is kept and relabelled "Additional instructions (free text)".
Every existing persona keeps working untouched.

### 5.3 Component structure

Knowledge (`src/components/messaging/knowledge/`):

```
AiKnowledgeManager.tsx        (container: hooks, state, actions — stays the owner)
├─ KnowledgeMethodTabs.tsx    (Manual | Upload | Website)
│   ├─ ManualProfilePanel.tsx   structured fields + Save & index
│   ├─ UploadPanel.tsx          dropzone + scope select (moved verbatim)
│   └─ WebsitePanel.tsx         URL + mode + Start scraping & indexing
├─ KnowledgeSourcesPanel.tsx  pinned below the tabs — the existing Sources card
└─ KnowledgeGraphCard.tsx     below the sources panel
```

The WhatsApp catalog card moves into the Manual panel (WhatsApp only), where it belongs
as a business-data input rather than a peer of the sources list.

Settings (`src/components/messaging/agent-settings/`):

```
AiAgentManager.tsx            (container: UNCHANGED state machine)
├─ AgentIdentityCard.tsx      enable, name/tone, response length, language
├─ BusinessGoalsCard.tsx      industry + goal checkboxes
├─ GuardrailsCard.tsx         greeting, persona free text, locked-on guard rows
├─ HumanHandoffCard.tsx       handoff switches + admin phone numbers
├─ InstructionBlocksCard.tsx  add/edit/remove titled blocks
└─ AdvancedCard.tsx           daily cap, cooldown
```

Each card is a pure presentational component taking `form`, `update`, and `disabled`.
The container keeps `configLoaded`, the merge-on-refresh effect, `confirm_clear`
computation, the dirty guard and the save callback verbatim. The five existing
`AiAgentManager.*.test.tsx` files are the contract and must pass unmodified.

### 5.4 Website scraping flow

```
UI  → ai-knowledge-ingest  action: "ingest_website" { url, mode, scope }
      │
      ├─ mode = "page"  → POST https://api.firecrawl.dev/v2/scrape   (inline, ~5-15s)
      │                    → markdown → chunkProfileText-style chunking → embed inline
      │                      if chunks ≤ MAX_INLINE_CHUNKS, else hand to the queue
      │
      └─ mode = "site"  → POST https://api.firecrawl.dev/v2/crawl    (returns job id)
                           → metadata.crawl_job_id, stage="crawling",
                             status="pending", queued_at=now()

cron (*/2)  → ai-knowledge-excel-worker (HTTP, CRON_SECRET)
              → claim_ai_knowledge_excel_source() now also returns website sources
              → GET /v2/crawl/{id}: still running → leave pending, bump metadata.stage
                                     done        → chunk + embed pages with the existing
                                                   checkpointing, status="ready"
```

URL validation is SSRF-hardened before submission: `https:` only, public hostnames only,
no credentials in the URL — the same rule set the n8n node's `safeFetchAndStage` applies.
Firecrawl fetches the page, not Postora, but the URL is still user-controlled input that
reaches an outbound request, and a rejected URL must never be recorded as a source.

Key resolution follows `ai-config`: `Deno.env.get("FIRECRAWL_API_KEY")` first, then
`provider_api_keys` by `provider_code = 'firecrawl'`. A missing key returns a 400 naming
the admin setting, never a 5xx (Cloudflare masks origin 5xx — see memory).

**The missing cron is part of this work.** `ai-knowledge-excel-worker` has no scheduled
caller today; a `*/2 * * * *` cron invoking it with `CRON_SECRET` is added in Migration B's
companion SQL. This also un-strands the already-shipped large-document queue path.

## 6. Error handling

- Every knowledge action keeps flowing through the existing `run()` helper, so failures
  surface as the same toasts.
- A crawl that Firecrawl reports as failed sets `status='failed'` with the provider's
  message truncated to 500 chars, exactly as `setFailed` does today.
- A crawl still running after 30 minutes is marked failed with "Crawl timed out"; the row
  stays so the user can retry, and `metadata.crawl_job_id` is kept for support.
- Save on the Settings tab keeps the `confirm_clear` two-step. A structured profile that
  renders to empty text triggers the same guard as clearing the textarea did.
- `agent_behavior`/`business_profile` are validated server-side against their allowed
  keys and enum values; an unknown key is a 400 naming the key, never a silent drop.

## 7. Testing

| Layer | What |
|---|---|
| Vitest (existing, must stay green) | `AiAgentManager.{test,blankSave,loadingLock,staleSave,unsavedGuard}`, `AiKnowledgeManager.{guards,sharing}`, `UnifiedAgentSetupPage.guard` |
| Vitest (new) | sub-tab switching keeps the Sources panel mounted; structured-profile fields round-trip; website URL validation rejects `http:`, private hosts and credentialed URLs; behavior card writes into `form` without touching the dirty machinery |
| Deno (new) | `businessProfileText.ts` renderer (including the empty-object → empty-string case that must trip `confirm_clear`); `behaviorRules()` output in `tools.test.ts` beside the existing `buildSystemPrompt` cases; Firecrawl client with a stubbed fetch, including a 200-carrying-an-error body (see memory `postora-200-with-error-body`) |
| DB harness | Migration A and B applied against the PG17 harness, plus the claim-predicate change proving a `website` row with `queued_at IS NULL` is **not** claimable |

`userEvent` is unusable in this repo (clipboard) — new tests use `fireEvent`.
Deno tests run before `bun install` (`--node-modules-dir` destroys `node_modules`).

## 8. Delivery order

Each slice is independently shippable and independently revertible.

1. **Knowledge shell** — sub-tabs + pinned Sources panel. Pure extraction, no schema change.
2. **Settings cards** — presentational split, no schema change.
3. **Migration A** + server render + `behaviorRules` + allow-list + structured Manual panel
   and the new Settings card contents. Migration applied to prod **before** merge.
4. **Migration B** + Firecrawl client + `ingest_website` + worker crawl-poll + the cron +
   Website panel. Migration applied to prod **before** merge.

## 9. Risks

- **Slices 3 and 4 are merge-order-sensitive.** `main` auto-deploys the frontend while
  migrations are manual. A frontend that names `agent_behavior` before the column exists
  fails *every* config save, not just the new field.
- **The card split touching the state machine.** Mitigated by keeping all state in the
  container and treating the five existing test files as the contract.
- **Firecrawl cost.** A full-site crawl of a large store is billable and produces a large
  embedding job. The Website panel states the page cap (default 50, user-adjustable up to
  200) before the user starts, and the crawl request carries that limit.
- **The new cron drains the pre-existing queue** the first time it runs. There are zero
  pending rows today, so the blast radius is nil, but the deploy note says to check.
