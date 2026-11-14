# Text model lists: API and Auth

Date: 2026-11-14. Status: design only; no production implementation or rollout performed.

Repository baseline: `7c7b48911115f9f81b4b50adfcf27d64a4cc4488` (`main`, including PR #414). Delivery branch: `feat/ai-model-lists-api-auth-split`.

## 1. Goal and governing rules

At `/settings?tab=ai&sub=AI+Agent` and the other text AI settings, an administrator must be able to choose API-key or subscription authentication independently for Primary, Fallback, and Fallback 2. Cover `chat`, `caption`, `hashtags`, `agent_triage`, and the main messaging `agent`, including actual tool calling over Claude and OpenAI Codex subscriptions. Showing an Auth option that still calls an API-key endpoint does not satisfy this requirement.

`ARCHITECTURE.md` was read before investigation and governs implementation: §§4 and 11 for dependency direction and frontend access, §§12–17 and 24 for authenticated Edge Functions and redaction, §§20–22 for capabilities and contracts, §§23 and 36 for additive compatibility, §§26–28 for bounded calls and duplicate prevention, §§37–39 for credentials, quotas, and admin authorization. Follow its linked task workflow and `docs/runbooks/deploy-edge-function.md`; do not duplicate their operational rules here.

Owner delegated design choices to the recommended option. Recommendations below are decisions for the implementation brief, not questions awaiting approval. This document does not authorize production changes, provider calls, or deployment during the design task.

Image generation and video lists are excluded. Embeddings, speech-to-text, and text-to-speech are different operations and gain no subscription capability from this change. Image/document understanding remains capability constrained; text output alone does not make a multimodal model eligible. Search is addressed explicitly below so a text-looking list cannot accidentally promise unsupported browsing.

## 2. Evidence from the baseline

All repository citations below refer to the baseline above, not moving `main`. They distinguish observed behavior from proposed changes.

### 2.1 Why Auth disappears

| Evidence | Actual behavior |
| --- | --- |
| `src/components/admin/DefaultModelSelector.tsx:79–89` | `OAUTH_CATEGORIES = ['chat', 'agent_triage']`; the accompanying comment deliberately excludes `agent` because tools were outside the earlier design. |
| `src/components/admin/DefaultModelSelector.tsx:163–168`, `:294–313`, `:421–439` | Capability fetching is category gated. Auth group exists only when an active provider is connected or needs reauthentication. A never-connected provider disappears entirely. |
| `src/components/admin/DefaultModelSelector.tsx:319–342`, `:387–395` | API and Auth selections already have separate identities. Auth saves `auth_method: 'oauth'`; API selection omits the field. Subscription-only providers are removed from the API group only in the currently OAuth-enabled categories. |
| `src/hooks/useAIConfiguration.ts:115–124` | PR #414 already separates catalogue `models` (API) from `oauthModels`. The selector receives API models, while its Auth model IDs come from the capability endpoint. |
| `src/components/admin/AdminAiAgentSection.tsx:29–45`, `:65–79`, `:105–120` | Main Agent uses `category='agent'`, `capability='chat'` and forwards authentication on every mutation. Its provider allowlist already includes Claude/OpenAI. Triage filters Claude from the API provider prop; the shared selector independently constructs its Auth providers. The prop filter is not proof that Claude Auth is absent from triage. |
| `src/components/admin/settings/ai/AiCategoryCards.tsx:50–86`, `:113–127`, `:248–256` | Generic category cards forward authentication and all three tiers. A Chat card exists; separate caption/hashtag cards do not. |

Consequently the production connection state is not the cause of main-Agent invisibility. The category gate is. The catalogue split alone cannot remove this gate or provide tool transport.

### 2.2 Stored tiers and their real consumers

| Path | Stored value and consumption |
| --- | --- |
| `src/hooks/useAIConfiguration.ts:20–40`, `:64–86`, `:130–169` | `system_settings` keys are `default_ai_model_<category>`, suffixed `_fallback` and `_fallback_2`. API values remain `{provider_code, model_id}`; Auth adds `auth_method: 'oauth'`. The legacy unsuffixed `default_ai_model` is separately parsed. |
| `src/hooks/ai-config/types.ts:53–77` | `ModelCategory` does not yet contain `caption` or `hashtags`. Adding UI labels alone would not establish independent runtime ladders. |
| `supabase/functions/_shared/ai-fallback.ts:189–247`, `:260–303` | `fetchCategoryAiSettings` retains each tier's Auth marker; API third-tier validation filters `auth_method='api_key'`, whereas OAuth third-tier validation uses the pi-ai registry. Some comments claiming subscription models have no catalogue row are now stale after #414. |
| `supabase/functions/_shared/ai-fallback.ts:315–369`, `:403–407` | `resolveChatModelConfig` reads Chat tiers and places a valid per-user override first. Its override query reads only `provider, model, expires_at`; overrides are currently API-only. `platformChatTiers` carries authentication into platform tiers. |
| `supabase/functions/_shared/ai-fallback.ts:417–442`, `:445–471` | `callChatCompletion` and `callAiChain` already branch to `callOAuthTier` before resolving platform API keys. This shared dispatch supports subscription text calls. |
| `supabase/functions/generate-caption/index.ts:458–463`, `:569–586`, `:667–669`, `:732` | Brand intelligence, YouTube content, and normal captions all resolve the Chat configuration, then use the shared chain plus user routing. Client `model` does not override the admin ladder. The YouTube request requires `max_tokens: 4096`. |
| `supabase/functions/generate-hashtags/index.ts:154–156`, `:191` | Hashtags also use Chat configuration and shared dispatch, ignoring client model selection. |
| `supabase/functions/_shared/agentTriage.ts:149–174`, `:184–192`, `:268–327` | Triage has its own three keys, carries `authMethod`, accepts Claude only on OAuth, asks chat tiers for JSON with `max_tokens: 200`, and treats malformed JSON as uncertainty. Triage never executes tools. |
| `supabase/functions/ai-agent-reply/index.ts:590–611`, `:1657–1675` | Global Agent reads its contiguous three-tier chain, preserves `authMethod`, and composes it with user routing. Missing Primary yields no chain; gaps terminate it. |
| `supabase/functions/ai-agent-reply/index.ts:258–307` | **Additional runtime blocker:** Agent's local `chatCompletion` ignores `authMethod`, resolves an API key for every platform tier, and calls Anthropic/API chat endpoints. Carrying the marker through settings is insufficient. |
| `supabase/functions/ai-agent-reply/index.ts:1746–1782`, `:1824–1837`, `:1889–1900` | Each model round offers tool definitions, accepts tool calls, appends the assistant turn, then executes tools through existing serial/parallel paths. This is the integration point, not a replacement agent runtime. |

The proven defect has three layers: UI eligibility excludes the Agent, the subscription bridge rejects tools, and the main-Agent dispatcher does not dispatch OAuth at all. A UI-only patch would leave subscription choices nonfunctional or charge the wrong credential.

### 2.3 Subscription machinery already present

`supabase/functions/_shared/aiOAuth/clients.ts:19–29` maps `claude` to pi-ai `anthropic`, and `openai` to `openai-codex`; preserve these stored provider codes. OpenRouter is also in that registry, but is not a Claude/Codex subscription: `credentials.ts:21–43` explains its permanent-key behavior. Preserve existing OpenRouter Auth behavior without relabeling it a subscription plan.

The existing modules provide PKCE login (`loginFlow.ts`, `pkce.ts`), credential retrieval/refresh (`credentials.ts:18–47`, `:100`, `:235`), a global flag (`flag.ts:3–23`), and tier dispatch (`chainTier.ts:71–86`, `:98–124`). Refresh already uses leases and fenced persistence; do not create a second token manager.

`ai-provider-auth/handler.ts:102–130` authorizes admin access before returning sanitized provider status, model IDs, activity and API-key availability. `ai-provider-auth/index.ts:56` gets model IDs from pinned pi-ai, so zero OAuth database rows does not currently mean zero capability model IDs.

`piCall.ts:1` pins `@mariozechner/pi-ai@0.73.1`. However:

- `piCall.ts:62–87` flattens text, synthesizes assistant turns, and treats other roles as user turns. It cannot preserve tool history.
- `piCall.ts:90–101`, `:169–173` returns only text, dropping tool calls and provider continuation metadata.
- `piCall.ts:142–148` rejects any defined `tools` with `tools_unsupported`, and rejects capped Codex requests with `max_tokens_unsupported` before network I/O.
- `chainTier.ts:42–50`, `:122–124` maps these refusals into stable skip reasons. Keep that safe fallback behavior until a request is fully representable.

PR #414 already writes OAuth catalogue rows from the pi-ai registry: `ai-provider-health/deps.ts:260–281`. They are tagged `chat`, not a proof of tool, strict-JSON, vision, or search capability. Sync identity includes auth method (`_shared/modelCatalogSyncRun.ts:225–263`). Existing schema is sufficient for the platform ladders.

### 2.4 Read-only production observations

Observed on 2026-11-14 around 01:22–01:25 UTC through the Contabo connector (`mcp__waleed_mcp_hub__ssh_contaboo_mcp__run_command`), using `psql` inside `postorasupabase-supabase-j8axyh-supabase-db`. `read_command` did not accept the Docker inspection command; its connector returned `read-command only accepts read-only commands, got: safe`. The subsequent connector call ran SELECT-only SQL in an explicit `BEGIN TRANSACTION READ ONLY` transaction. No token, secret, provider probe, catalogue sync, or setting mutation was requested.

| Query projection | Observed result |
| --- | --- |
| `ai_provider_oauth_connections(provider_code,status)` | `claude connected`; `openai connected` |
| `system_settings` exact key `feature_ai_provider_oauth` | JSON boolean `true` |
| `information_schema.columns`, `public.ai_models.auth_method` | Column exists, type `text` |
| `ai_models GROUP BY auth_method` | `api_key: 1491`; no OAuth group, therefore `oauth: 0` |
| `pg_indexes`, relevant `ai_models` indexes | Three-column unique index `ai_models_provider_model_auth_method_key` exists; legacy two-column index absent |
| `system_settings` caption/hashtag key prefixes | No rows |

The initial OAuth catalogue population remains an operational prerequisite; zero OAuth rows is the observed pre-population state, not evidence of missing connections. Do not fabricate OAuth rows or assume that a successful migration triggered sync. The SELECTs establish current state, not that a token can successfully call a provider or that deployed function files match this checkout. Catalogue sync and token/provider verification belong to rollout.

Schema evidence: `supabase/migrations/20261113180000_ai_provider_health.sql:163–175`, `:275–276`; the companion `20261113180100_ai_model_catalog_drop_legacy_unique.sql` documents the expand/deploy/drain/contract ordering. Do not rerun those migrations blindly.

## 3. Recommended approach and alternatives

**Recommend capability-aware grouped selectors plus one subscription transport adapter, integrated with existing chains.** Keep the current settings shape, Vault, catalogue, routing precedence, tool executor, and outbox. Add optional caption/hashtag ladders and stage the Agent integration behind separate tool flags. This fixes every proven layer while keeping existing API traffic stable.

Alternative: only expand `OAUTH_CATEGORIES`. Small change, but rejected: tool requests still fail and the Agent still resolves API keys.

Alternative: run Claude Code/Codex CLI agents or build a separate subscription agent service. Rejected: introduces another executor, credential/runtime boundary, and side-effect/retry system. The pinned inference library already has tool transport primitives; Postora should remain the sole tool executor.

## 4. UI and list semantics

### 4.1 Every platform text slot

Use a single presentation policy for all three slots of Chat, Caption, Hashtags, Triage, and Messaging Agent. Provider selection always shows headings **API** and **Auth**. Model selection stays within the chosen group/provider and repeats its group in the trigger/current-value summary, so identical provider/model names cannot collide. Use `API · Claude` versus `Auth · Claude subscription` and `Auth · OpenAI Codex subscription`; retain existing non-subscription Auth labeling for OpenRouter.

Group identity is `(provider_code, auth_method)`; model identity is `(provider_code, model_id, auth_method)`. Never match parameters, selection state, deduplication, or React keys by model ID alone. Changing provider/group clears the model draft, not the stored tier; persistence occurs only after choosing an eligible model. Switching to API must remove a prior OAuth marker. Save errors retain the last persisted value and display an actionable error.

The selector reads API rows from `models` and Auth rows from `oauthModels`, joined with sanitized capability/status data. Prefer persisted catalogue activity and category tags for eligibility. Before the first OAuth sync, capability registry IDs may populate a clearly labeled provisional Auth catalogue for supported text operations; absence of catalogue rows alone must not hide a connected subscription. These provisional entries cannot bypass runtime capability checks and must not pretend to have admin parameters, prices, or verified tool support. Once a successful sync exists for that provider, respect persisted inactive rows; never resurrect them from registry fallback. A failed catalogue read is an error, not permission to use a provisional empty or stale list.

### 4.2 Availability and disabled states

| State | Required presentation and behavior |
| --- | --- |
| Loading | Skeleton/loading message; do not report no models or alter saved selection. |
| Capabilities/catalogue read failed | Error and Retry; no successful-empty substitution or automatic saves. Existing values remain visible. |
| No subscription connected | Auth heading remains visible with disabled Claude/Codex options and “Connect a subscription in AI Providers.” No login starts from choosing a model. |
| Feature flag off | Auth visible but disabled with “Subscription calls disabled.” Stored Auth value remains visible with its reason. |
| Provider inactive | Disabled in both groups. Do not confuse admin deactivation with missing credentials. |
| Reauthentication required/disconnected | Disabled Auth option, reconnect/manage link, saved selection retained as unavailable. Runtime may try configured fallbacks. |
| API key absent | API option disabled with “API key required,” even when the same provider has a working subscription. User-key-only routing is handled in its own UI. |
| Connected, no compatible models | Provider visible with disabled model picker and capability-specific explanation; expose sync action/status, not an arbitrary default model. |
| Tools flag off/unsupported tool schema | Agent Auth model disabled with a precise reason. Never silently strip tools. |
| Request requires output cap unsupported by Codex | Explain request-specific API fallback. Disable Codex for categories with a mandatory cap, especially triage, until verified support exists. |
| Saving | Disable both pickers for the affected slot; prevent overlapping saves and reflect server validation failure. |

Use keyboard-accessible group labels and disabled reasons available without hover. No first-model auto-selection or rewriting of unavailable saved tiers. Caption and Hashtag cards initially show “Inherits Chat” with the effective three slots; an explicit “Customize this category” starts their independent ladder. Returning to inheritance atomically removes that category's overrides.

### 4.3 Remaining text lists and boundary cases

- Search (`AiCategoryCards.tsx:138–146`) retains its search capability requirement. Give its provider/model picker the same API/Auth headings, but disable Claude/Codex Auth with “Search transport not supported” unless the existing search execution path can honor the required operation. Never infer web search from `chat` or expose provider-native browsing through this change.
- The active admin user override surface is `UserAiModelOverrides.tsx:72–74`, `:154–168`, `:359–369`, mounted by `src/pages/admin/AdminSettings.tsx:70`. It currently offers only Google/OpenRouter and stores no auth discriminator. Bring its text lists under the same grouping and explicit authentication contract in phase 5; otherwise “every list” would be incomplete. Its per-user scope does not authorize end users to choose platform subscription accounts.
- Admin Agent sandbox overrides currently accept a provider/model string and allowlisted API models (`ai-agent-reply/modelOverride.ts:1–47`; `index.ts:1665–1669`). Add an admin-only structured auth-aware selection alongside legacy strings when enabling Auth comparisons. Never let a live request body override credentials. Render grouped options only after that server contract is deployed.
- BYOK routing (`src/features/ai-providers/ui/AiRoutingCard.tsx:15–59`) intentionally selects the user's API key; `user-ai-providers/handler.ts:163` filters API rows. Show API/Auth separation with Auth disabled as “Managed by POSTORA administrator; use POSTORA providers.” Do not expose platform connection status/accounts through an admin-only endpoint to ordinary users or reinterpret `user_only` as platform Auth.
- Repository search found no production import of `src/components/settings/AiSettingsSection.tsx` or `src/components/admin/AdminAiSettings.tsx`. They contain legacy text pickers (`AiSettingsSection.tsx:49–68`; `AdminAiSettings.tsx:167–190`). Do not revive them or change legacy scalar settings. If an implementation discovers a live import, route it to the shared policy rather than shipping a second selector contract.

## 5. Data, resolution, and authorization

**Recommendation: no new tables.** Reuse `ai_models.auth_method`, `ai_provider_oauth_connections`, `system_settings`, existing Vault RPCs, and existing logs/health records. Keep API tiers' old two-key JSON byte shape; normalize missing auth to `api_key` in memory. Reject unknown explicit authentication values at mutation boundaries rather than accidentally routing them as API.

Add `caption` and `hashtags` to the category contract and settings parser. Their keys follow the existing pattern. No category rows means inherit the complete Chat ladder; a customized category requires Primary and contiguous fallbacks, with no slot-by-slot mixing with inherited Chat. Keep existing Chat hardcoded-floor behavior; main Agent retains no hardcoded unchosen model. New categories reuse Chat's floor policy explicitly, not the unknown-category branch of `CATEGORY_LAST_RESORT` by accident.

Use one category-aware text configuration resolver with the current Chat resolver as a compatibility entry point. Preserve the valid admin user override precedence, expiry behavior, user routing/consent, and maximum three effective tiers. Caption normal/brand-intelligence/YouTube paths read `caption`; hashtags read `hashtags`. Other existing Chat consumers, including `ai-knowledge-excel-worker/websiteSetup.ts:173`, continue reading Chat. Auth is available only on platform tiers; a user tier always means the user's key. Do not add platform fallbacks to a `user_only` route.

For the active admin per-user override list, add a backward-compatible `auth_method` column to the **existing** `user_ai_model_overrides` table, default `api_key` with the same two-value constraint. This is necessary because `provider,model` cannot distinguish API Claude from Auth Claude. Deploy the additive migration first, then update the authenticated admin writer, `resolveChatModelConfig` override projection, generated database types, and all override display/read paths. API overrides preserve existing behavior; OAuth override tiers carry `credentialSource='platform'` and the Auth marker through category inheritance and fallback composition. Do not migrate end-user BYOK preferences into platform OAuth or create duplicate override tables.

**Legacy-writer guard (required before any OAuth override row is enabled).** A column default only applies on insert: an already-open or rolled-back override UI that upserts `(user_id, provider, model)` without `auth_method` would update an existing OAuth row to the requested API provider while keeping its OAuth marker, and the resolver would then dispatch the API choice as Auth. The additive migration therefore also adds a `BEFORE INSERT OR UPDATE` trigger on `user_ai_model_overrides` that resets `auth_method` to `api_key` on EVERY insert or update that does not carry the auth-aware writer's transaction-local marker (a setting only that writer sets), regardless of whether `provider` or `model` changed. Keying the reset on a provider/model change would miss a legacy API-only picker re-saving the same OpenRouter model over an OAuth row, so the rule is the marker, not the diff, and the auth-aware writer is the only path allowed to write `oauth`. OAuth overrides stay disabled (flag-gated, writer refuses them) until the trigger is deployed and a database test proves a legacy upsert over an OAuth row yields an API row. UI rollback must keep the auth-aware writer contract: roll back the picker, never the writer or the trigger.

Settings mutations need authoritative validation, not just disabled options. Place a narrow admin mutation in the existing AI configuration boundary, with RLS/RPC enforcement for direct writes as needed; avoid a new catch-all endpoint. Validate category, slot, authentication, provider activity, model eligibility, and contiguous effective chain. Refuse failed reads. Use the existing role model. Every ladder mutation, including ordinary slot saves and inheritance resets, runs in one transaction that first takes a per-category transaction-scoped advisory lock (`pg_advisory_xact_lock` keyed on the category) before reading or changing any of the category's three keys, so validation and writes are serialized. Without that lock, one administrator could insert a fallback while another deletes the Primary to restore inheritance, and both could commit against different keys, leaving a fallback-only category that runtime validation refuses. A database test must run two concurrent mutations on one category and assert the ladder invariant holds. Read paths must still reject/skip unusable tiers since stored rows can outlive credentials or flags.

**Capped category ladders.** Caption and Hashtags ladders (inherited from Chat or customized) must satisfy the cap rule per tier capability, not per credential kind: Codex cannot honor a mandatory output cap (spec 6.5) while Claude subscription tiers and API tiers can. A category that issues capped requests (YouTube caption, `max_tokens: 4096`) therefore requires at least one effective tier whose capability can honor that cap, checked after user-first composition and the three-tier cap exactly as for the Agent below. A Claude-only Auth ladder is valid and keeps inherited Chat behavior; only a ladder whose every effective tier is cap-incapable (for example Codex-only) is rejected on save or on restoring inheritance. At runtime, if no compatible tier remains, keep the typed refusal.

For an Auth main-Agent chain, require at least one later configured, active tool-capable API tier before saving/enabling it. This makes the requested fallback concrete without inventing a provider/model. The same requirement applies to Auth sandbox comparisons through a separate explicit fallback configuration only if the admin chooses to test fallback; default comparisons stay single-model and report refusal. All-Auth Agent chains and an Auth final rung are rejected while guaranteed API fallback is the policy. Connectivity can change after validation; total exhaustion follows the existing logged escalation/outage path.

Also validate the effective runtime chain after user-first composition and its three-tier cap (`_shared/ai-user-routing.ts:168–176`). If composition drops the required API recovery tier, skip the Auth tool tier with a logged capability refusal; do not add a fourth attempt or displace the user's chosen primary. This preserves routing consent while making the limitation visible. Each slot still renders both groups, with the chain-level recovery requirement shown before saving an invalid combination.

## 6. Tool calling over subscriptions

### 6.1 Verified upstream protocol, not assumed API compatibility

The following primary sources were inspected at the pinned **v0.73.1**, not `latest`:

- [pi-ai context/message contracts](https://github.com/badlogic/pi-mono/blob/v0.73.1/packages/ai/src/types.ts#L178-L244): tools use named JSON schemas, assistant content includes `toolCall`, and results are `toolResult` messages with matching IDs, names, error state and timestamps. Preserve full provider/API/model identity and opaque continuation blocks in the server-side transcript.
- [Anthropic adapter](https://github.com/badlogic/pi-mono/blob/v0.73.1/packages/ai/src/providers/anthropic.ts#L783-L873): OAuth uses Bearer authentication, Claude Code identity headers/system content, streaming Messages, and a serialized output limit. Tool transport exists. Its conversion maps `tool_use` and `tool_result`, normalizes some tool-name casing, and projects tool schema properties/required fields. This is not proof that every Postora schema survives unchanged. Test and refuse schemas whose semantics cannot be retained; do not use this mechanism to add CLI tools or permissions.
- [Codex request builder](https://github.com/badlogic/pi-mono/blob/v0.73.1/packages/ai/src/providers/openai-codex-responses.ts#L318-L362): uses the ChatGPT backend Responses protocol, `store:false`, streaming, automatic tool choice, and parallel tool calls. It serializes context tools but not `maxTokens`. Account identity is derived from the credential and supplied in headers by the adapter. Do not send its token to the public OpenAI chat-completions endpoint.
- [Responses history conversion](https://github.com/badlogic/pi-mono/blob/v0.73.1/packages/ai/src/providers/openai-responses-shared.ts#L150-L259): function calls/results have paired IDs; the library preserves additional item/continuation information, including reasoning signatures. Keep these opaque on the server. Do not round-trip a Codex exchange through text alone or forward another provider's private continuation blocks.

These sources establish transport primitives, not entitlement, terms approval, or end-to-end success in Postora. No production inference was performed for this spec.

### 6.2 Recommended adapter contract

Extend the existing `aiOAuth` infrastructure seam; do not create another agent. The application owns a validated provider-neutral transcript with text, assistant tool requests, and tool results. The transport owns provider-specific conversion and a request-local, provider/model-bound continuation sidecar. Keep it out of client responses, `system_settings`, normal transcript storage, tool arguments, and logs. No new persistence table is needed for a single bounded reply invocation. Recovered deliveries must use existing durable outbox results; do not require an ephemeral continuation sidecar to send an already-generated reply.

Input conversion must:

1. Map only supported function definitions into pi-ai context tools, retaining descriptions and schema meaning. Reject unsupported schemas, forced/named tool choices, or other required options before provider I/O. Initially support the Agent's current `tool_choice:'auto'`; do not claim general tool-choice compatibility.
2. Preserve assistant `tool_calls`, nullable text, unique call IDs and validated JSON arguments. Convert each `role:'tool'` turn into the matching pi-ai `toolResult`, never a user prompt. Detect unmatched, duplicate, malformed, or out-of-order results.
3. Reuse full native assistant continuation only for the same provider/model. For a different provider, construct a sanitized canonical transcript containing completed tool facts/results, omitting incompatible signatures and internal IDs. Validate its pairing before sending; if conversion is unsafe, refuse that tier.
4. Treat a text-only final round with prior tool history as a tool-history request. Removing `tools` on the last round does not permit flattening earlier calls/results.

Output conversion returns the current OpenAI-shaped completion to existing consumers, including `message.tool_calls`, stable call IDs, serialized arguments, text/null content, usage, and a mapped finish reason. Retain opaque native state separately. Reject aborted, malformed, partially streamed, truncated-tool-argument, or unsupported responses before the executor sees any call. Only a complete validated result may become the selected completion. Reuse `completionFailure` (`ai-agent-reply/logic.ts:1127`) and strengthen validation at the seam as necessary.

Dispatch Auth platform tiers from the Agent's local `chatCompletion` **before API key or endpoint resolution**. Keep API behavior behind the existing API branch. Shared `callAiChain` and `callChatCompletion` use the same capability policy and error taxonomy. Adapt integration behind small modules, not another provider implementation inside the large Agent entrypoint. Every extracted module must have a real consumer in the same merge, per `ARCHITECTURE.md` §1.

### 6.3 Safety boundary

**Subscription authentication grants inference only. It never grants additional tool privileges.** pi-ai may describe proposed tool calls; only Postora may execute them.

- Offer only tools already resolved for the authenticated user, account/workspace, current connector bindings and verified admin context. Preserve ownership checks, schema validation, SSRF/URL restrictions, confirmation rules, quotas, outbox claims, serial write ordering and iteration limits. Provider output and tool results remain untrusted input.
- Never expose shell, filesystem, browser, provider-native computer use, CLI agent tools, arbitrary MCP discovery, or a provider's account-level tools merely because a subscription transport accepts tools. The existing Postora allowlist remains authoritative.
- Do not pass OAuth credentials, API keys, connector secrets, or server authority in tool definitions/results. Redact failures and record method/provider/model/slot, stable refusal code, attempt, duration, and usage only. Do not log continuation signatures, raw prompts, tool payloads, or provider response bodies.
- Complete request/tier budgets, refresh deadlines, stream byte limits, tool count/argument limits and bounded library retries remain mandatory. Select the stateless SSE transport for Codex integration; do not depend on a process-global WebSocket session/cache in an Edge isolate.
- A caller cannot pick a connection, auth method, or admin credential through a normal request body. Only the validated admin configuration and explicitly authorized dry-run override can do so. RLS alone does not enforce tenant scope under service role.

### 6.4 Fallback and replay rules

Perform a capability preflight before refreshing credentials where possible. A disabled flag, missing connection, unsupported tools/history/schema/choice, hard output cap, or unsafe continuation conversion yields a typed refusal and a sanitized attempt row. Preserve current `oauth_tools_unsupported` and `oauth_max_tokens_unsupported` compatibility; proposed additional codes are `oauth_tool_history_unsupported`, `oauth_schema_unsupported`, and `oauth_response_invalid`.

Before tools execute, a failed/refused Auth inference can advance to the next admin-configured API tier with the **same tools and constraints**. Do not retry without tools to manufacture a successful response, reinterpret OAuth as API on the same slot, or automatically spend an unchosen provider's key.

After tools execute, fallback continues from the validated transcript with those completed results. It must not restart the user turn or replay the executor. Track executed calls in the existing reply orchestration; derive the action identity from the invocation, the tool and the canonical arguments, and treat it **fail-closed**: a transcript ordinal cannot tell a replay from a legitimate second identical mutation, so none is used. After fallback, a model-issued call whose tool and canonical arguments equal a completed MUTATING call in the same invocation is not executed again; it returns the recorded outcome and is logged as a suppressed duplicate. A tool that must legitimately repeat an identical mutation within one invocation has to carry an explicit model-supplied distinguishing argument in its schema (for example a client request key), which makes its canonical arguments distinct; a mutating tool without that is not enabled for Auth Agent runs. Read-only calls are never suppressed and follow current budgets. If fallback repeats a completed mutation, reuse its recorded outcome; if a mutation is in an unknown/in-flight state, stop and reconcile/escalate instead of invoking again. Review existing executor/outbox deduplication and use existing durable receipts where required; inference retry safety cannot be inferred from delivery deduplication alone. Repeated read-only calls follow current budgets.

If safe continuation or duplicate suppression cannot be established for an enabled mutating tool, refuse that Auth Agent run before execution or stop safely after the uncertain result. Log the refusal and use the configured API path only when no side effect can be repeated. A protocol error must never yield a partially authorized tool execution or a falsely successful reply.

### 6.5 Output caps and structured responses

**Recommendation: preserve mandatory output caps.** With pi-ai 0.73.1, Codex remains unavailable for triage's required 200-token cap and falls back to API for capped caption subrequests such as YouTube. UI and logs must expose this limitation. Do not silently discard a cap or claim that response truncation or a timeout enforces a provider generation limit. Main Agent can use Codex on its current uncapped request, subject to total request/tool budgets. A future library upgrade or separate reviewed transport may enable capped Codex only after a real wire-level contract test proves it.

Claude triage can use prompt-requested JSON and the existing strict parser; the current subscription bridge does not forward `response_format`. Advertise this as parsed JSON, not provider-enforced JSON mode. Invalid JSON yields uncertainty/next tier, with no tools and no narrowing of normal reply access. A request that actually requires guaranteed provider JSON-schema output must refuse an unsupported transport. Reject unknown mandatory options rather than dropping them silently.

## 7. Flags and compatibility

Keep `feature_ai_provider_oauth` as the global master; production is already true. Add the following **proposed** JSON settings, default false/missing:

| Proposed flag | Purpose |
| --- | --- |
| `feature_ai_text_auth_lists` | New grouped list policy and caption/hashtag UI. Must not disable already working Chat/Triage OAuth runtime when false. |
| `feature_ai_category_text_ladders` | Category-aware caption/hashtag resolution; when false these continue using Chat. |
| `feature_ai_oauth_tools_claude` | Enables tested Claude tool transport and corresponding Agent options. |
| `feature_ai_oauth_tools_codex` | Independently enables tested Codex tool transport and corresponding Agent options. |

Auth tool execution requires master + provider tool flag + request capability checks. Flags are server authoritative; capability responses report effective readiness and stable disabled reasons to UI. Current global flag reader returns false on read error (`aiOAuth/flag.ts:18–23`); retain safe refusal but distinguish/log configuration-read failure in new capability handling. Never show a failed status read as “not connected.”

Turning a provider tool flag off preserves saved Auth selections, refuses new tool calls for that transport, and advances safely to configured API fallback. Turning category resolution off returns caption/hashtag behavior to Chat without deleting their saved settings. Roll back UI independently after the backend; do not drop schema columns or convert saved Auth selections to API. Do not change flags automatically from a provider inference error.

## 8. Independently mergeable phases

Each phase is a reviewable change with active consumers, meaningful tests and its own deployment/rollback receipt. Later phases depend on earlier merged contracts; “independently mergeable” does not mean deploy in arbitrary order. No phase may expose a selectable option before its backend supports it.

| Phase | Deliverable and activation | Acceptance/rollback |
| --- | --- | --- |
| 1. Common list policy and Chat | Establish typed group identity, eligibility/disabled reasons, compatible settings validation, and sanitized capability readiness; wire the existing Chat selector immediately. Add proposed flags default-off. Keep working Chat/Triage Auth behavior available. | API/Auth selections with identical IDs remain distinct; no secrets/non-admin status access; zero OAuth catalogue state has useful provisional text entries. Roll back UI/policy flag without touching saved tiers. |
| 2. Caption and hashtags | Add optional category keys, parser/types and category-aware resolver, wire every caption/hashtag branch, inheritance/customization transaction and two cards. Category flag stays off until backend deployed. | No rows reproduces current Chat behavior, including overrides/BYOK. Independent choices affect the correct endpoint. Capped Codex subrequests skip safely to API. Roll back category flag to Chat. |
| 3. Triage | Wire shared grouping/readiness into `agent_triage`, retaining decision-model API behavior. Claude Auth uses parsed JSON and existing uncertainty behavior; Codex stays disabled for the cap. | No tool execution; invalid JSON/timeouts preserve normal Agent behavior; API Jev continues working. Master-off and reauth cases have logged refusals. |
| 4. Claude tool round trip and Agent | Extend subscription conversion/continuation plus Agent dispatch; wire real tool rounds and text-only final rounds. Keep provider flag false until fixture/side-effect tests and controlled non-production inference pass. Require configured API fallback. | Claude Auth invokes a permitted tool and produces a final reply without an API key. Unknown/mutating tool and fallback replay tests pass. Disable Claude tool flag to restore API fallback. |
| 5. Every remaining admin text picker | Apply additive `user_ai_model_overrides.auth_method` migration before reader/writer changes; group the active admin override picker and add auth-aware sandbox selection. Add API/Auth explanation to BYOK and capability-disabled Search. Audit remaining live text list call sites. | Legacy API overrides/strings still work, non-admin/live sandbox escalation denied, inherited category precedence verified. Roll back the picker UI only; the auth-aware writer, the legacy-writer trigger and the additive column are never rolled back while any OAuth override row exists. To fully revert, first convert or delete OAuth override rows, then the writer may be reverted. |
| 6. Codex tool round trip | Enable the same Agent contract on Codex with provider/model-bound continuation, SSE and cross-provider fallback fixtures. No output-cap workaround. | Tool call/result IDs and opaque history survive multiple rounds; no API key needed; interrupted stream and API fallback do not repeat mutations. Enable Codex tool flag independently; cap-dependent uses stay disabled. |
| 7. Operational rollout | Verify deployed schema/indexes and function hashes, run the existing authorized catalogue sync, then canary in order Chat → Caption → Hashtags → Triage/Claude → Agent/Claude → Agent/Codex. | Confirm OAuth row population, compare per-method attempts and refusals, validate the actual configured API fallback. Record each activation; stop at first integrity, tenancy, duplicate-action or budget failure. Roll back the narrowest flag first. |

Production sync is a later authorized operation, not part of this design commit. Use PR #414's existing sync/health path and preserve catalogue leases. A metadata-only registry sync is not a tool round-trip health check. Do not treat connection status or `chat` tags as verified tools support.

For future implementation, apply guard skills to changed production/tests/docs, run appropriate checks, then deploy changed Edge Functions through the canonical runbook with hash verification. Frontend auto-deploy behavior does not deploy shared Edge Function code. Migration gates and provider enablement gates remain separate.

## 9. Required validation

Extend existing suites rather than testing helper internals alone:

- `DefaultModelSelector.authGroups.test.tsx`, `__tests__/DefaultModelSelector.test.tsx`, `useAIConfiguration` parser/mutation tests: all five categories × three tiers; exact headings; duplicate API/Auth IDs; missing key; off/inactive/reauth/disconnected states; current unavailable values; cache invalidation; save failure; loading/read errors; zero OAuth rows; successful sync/inactive rows; keyboard behavior. Verify a failed fetch never overwrites a tier.
- Category resolver and caption/hashtag endpoint integration: legacy/JSON-string compatibility where currently supported, no-row inheritance, independent ladders, partial/malformed configuration refusal, contiguous chain rules, all caption branches, override expiry and auth marker, user-first consent and `user_only` isolation. No regression to other Chat consumers or media categories.
- Existing `aiOAuth/piCall.test.ts`, `chainTier.test.ts`, `credentials.test.ts`: exact tool/schema conversion, assistant calls/results including nullable text, multiple calls, errors, missing/mismatched IDs, malformed JSON, unsupported options, final round with tool history, usage/finish reason, both output-cap spellings, abort/deadline, refresh contention/rotation/disconnect, redaction and stable skip reasons. Ensure unsupported requests perform no inference request and avoid refresh when preflight suffices.
- Provider wire fixtures at pinned 0.73.1: Claude OAuth headers/system constraints and tool schema preservation; Codex Responses tool definitions, function-call/result pairing, opaque continuation and SSE completion. Include schema constraints the Anthropic converter would narrow. Test successful same-provider continuation and safe sanitized API fallback after prior tool execution.
- Main-Agent integration: prove subscription dispatch occurs before platform API-key lookup; three-tier fallback/level/auth logging; existing API path unchanged; tool selection/execution/final response; text-only final round; malformed HTTP 200; empty/partial stream; reconnect and kill switch; no executor run on rejected completion. Cross-tenant/admin tool denial and live sandbox override rejection are mandatory.
- Side effects: Auth outage before execution, after read, after completed mutation, and while a mutation outcome is unknown; repeated call with new provider ID but same action; existing outbox redelivery. Assert external mutation count and safe escalation, not just returned text. A missing idempotency guarantee blocks enabling the affected tool/provider combination.
- Existing `_shared/agentTriage.test.ts`: valid/invalid parsed Claude JSON, Codex cap refusal, bounded overall triage budget, decision API regression and unchanged uncertainty fallback.
- Database/admin integration: legacy override rows default API; auth-aware override round trip; direct non-admin write denial; settings mutation authorization; transactional inheritance; strict auth discriminator; API/OAuth catalogue uniqueness and no token leakage. No new table is expected.

Run relevant Vitest and Deno suites, frontend typecheck/build, and changed-file lint during implementation. Record actual results and known baseline lint findings. Live subscription probes must be explicit controlled tests using synthetic data and tools without external side effects; never use customer production conversations or arbitrary tool execution as a smoke test.

For **this design-only change**, validation consists of baseline line-citation checks, primary-source protocol inspection, read-only production facts, documentation guard and `git diff --check`. No implementation tests, production sync, inference test or deployment is claimed.

## 10. Risks and final recommendations

| Risk/decision | Recommended disposition |
| --- | --- |
| Subscription endpoint/entitlement/terms drift | Treat as an operational dependency; connected status is insufficient. Keep the existing accepted master-flag policy and separate provider kill switches. No new entitlement assumptions. |
| pi-ai version coupling | Keep 0.73.1 for this design's verified behavior; upgrade only with revalidated OAuth and tool fixtures. No speculative promise that a future version fixes caps. |
| Schema narrowing or continuation loss | Refuse before tools execute; support only proven faithful conversion. Preserve native state only at the infrastructure seam. |
| Codex cannot honor mandatory output caps | Keep capped categories/requests on API fallback; do not remove the caller's cap. This limitation remains open until transport evidence changes. |
| Claude JSON is prompt requested, not enforced mode | Keep strict local parsing and uncertainty fallback; refuse requests needing guaranteed structured output. |
| Broad “every text list” versus credential scope | Complete all active admin platform lists and override/sandbox lists; BYOK Auth remains disabled with an explicit route to admin-managed platform settings. Search remains disabled without search capability. No platform credentials become user-owned. |
| Independent caption/hashtag ladders | Add optional settings with whole-ladder Chat inheritance, preserving legacy behavior and per-user routing. Do not silently seed choices or split user override precedence. |
| Empty OAuth catalogue | Use registry-backed provisional text choices plus explicit sync status; later sync populates existing table. Respect deactivations after successful sync. |
| API fallback cost | Require an explicitly chosen usable API fallback for Agent Auth. Surface the method actually used and refusal reason; never reinterpret a saved Auth slot as API. |
| Replayed external mutations | Existing delivery claims are not sufficient proof of tool idempotency. Block affected Auth tool activation until action receipts/reconciliation tests establish no duplicate execution. |
| Partial runtime deployment | Deploy backend before exposing selectable UI or flags; verify shared dependency hashes and deployed consumers. Migration/merge is not runtime proof. |

Completion means all five required text categories expose explicit groups for each slot, persisted authentication reaches the correct runtime, Claude and Codex each complete a permitted tool round trip on supported requests, unavailable subscriptions fail visibly into configured safe fallback, and no duplicate side effect or authorization widening occurs. Honest disabled states for real protocol constraints are part of the design; silently calling an API key after selecting Auth is never acceptable.
