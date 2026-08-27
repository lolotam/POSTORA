# AI Agent Model Selection — Design

**Date:** 2026-08-27
**Branch:** `feat/agent-model-selection`
**Status:** approved for planning

## Goal

Three sequential, independently shippable changes to how the Postora AI agent picks
and survives its models:

1. Put a delivery floor under the model chain so a total model failure reaches the
   customer and a human, instead of being dropped silently.
2. Make `ai_agent_allowed_models` and the two fallback columns reproducible from
   `supabase/migrations/` alone.
3. Replace the per-user model catalog with a single global three-slot control that
   applies to every user and every platform.

Each phase is a stop-and-verify gate. Within a phase, each task commits separately so
a reviewer can reject one task while approving its neighbour.

## Constraints that hold across all three phases

- `ai_agent_allowed_models`, `ai_agent_configs.fallback_model_1` and
  `ai_agent_configs.fallback_model_2` are never dropped from the database. Phase 3
  stops reading the columns and stops rendering the catalog; the objects stay.
- Nothing under the n8n API, the partner API, cron jobs, content-generation
  functions, or webhooks unrelated to message delivery is touched.
- Every edge function change deploys by the manual volume-copy procedure in
  `docs/runbooks/deploy-edge-function.md`. `npx supabase functions deploy` targets
  Supabase Cloud and fails against this self-hosted stack.
- **Reload with `docker compose restart functions`, never `docker compose up -d
  --no-deps functions`.** The runbook's "Why restart, not `up -d`" section is explicit:
  the function sources are a bind mount, so `up -d` reports `Container ... Running` and
  changes nothing when the compose config is unchanged — the container keeps serving
  the old code and the deploy looks successful. `CLAUDE.md` still names the `up -d`
  form; the runbook is the correct source.
- Hashes are compared after normalising line endings (`tr -d '\r'`), because the local
  Windows copy is CRLF and would otherwise never match.
- The deployed functions volume has drifted from the repo before (the
  `refresh-tokens` server-only hotfix). Every deploy step begins by diffing the
  deployed file against the repo copy, so a hotfix is not silently regressed.
- Persona behaviour is out of scope. `persona_instructions`, `business_profile_text`,
  knowledge retrieval scoping, and the DM/comment split via `SURFACE_INSTRUCTIONS`
  all stay exactly as they are.

## Findings that contradict the original brief

Recorded here because the brief required contradictions to be reported rather than
assumed away. All four were verified against the repo at `0642c878` and against the
production database on 2026-08-27.

### 1. The callers never delivered replies

The brief describes four callers that check `!response.ok` and therefore miss the
HTTP-200 failure. They do check that — but they also discard the response body
entirely. All four are fire-and-forget:

- `supabase/functions/whatsapp-webhook/index.ts:981`
- `supabase/functions/whatsapp-evolution-webhook/index.ts:236`
- `supabase/functions/facebook-instagram-webhook/index.ts:522`
- `supabase/functions/_shared/commentAutomation.ts:98`

`ai-agent-reply` sends the message itself, at `index.ts:693`, through the sender that
`buildReplySender` (`index.ts:251`) resolves for the request's platform. That resolver
already covers WhatsApp Cloud API, WhatsApp Evolution/QR, the Facebook and Instagram
Send API, and comment replies via `_shared/commentActions.ts`.

Consequence: Phase 1 lives entirely inside `ai-agent-reply`. No caller changes.
The brief's instruction to "reuse whatever the webhook already uses to deliver a
normal AI reply" resolves to `buildReplySender`.

The brief also names three caller files while counting four callers;
`whatsapp-evolution-webhook` is the fourth.

### 2. Three users hold configs, not two

```
user      platform   is_enabled
1122a2d5  instagram  true
1122a2d5  whatsapp   true
12f4ba6a  whatsapp   true
7fe4d34e  whatsapp   false
```

Four rows across three distinct `user_id`s. The "3 of them actively serving replies"
count is correct.

### 3. Replaying the allow-list seed would undo an admin decision

`supabase/manual-sql/20260712120000_ai_agent_allowed_models.sql` ends with a seed
block inserting `gpt-4o-mini`, `gpt-4o` and `gpt-4.1-mini`. Production's allow-list
holds five rows and none of them is an OpenAI model — the admin removed them.
Copying the file verbatim into `migrations/` would re-insert all three against the
current production database, which is an insert, not the no-op the brief requires. It
would also make `gpt-4o-mini` a valid model again in the `messaging-api` allow-list
check — the exact string behind the persona-loss bug fixed in `0642c878`.

Resolution: the migration replicates the shape the brief enumerates (columns,
`UNIQUE (provider, model_id)`, `idx_ai_agent_allowed_models_active`, the two grants,
and both RLS policies) and omits the seed block. Seed data is not part of that
enumeration.

### 4. `escalateToHuman` writes half-orphaned assignment rows

`whatsapp_conversation_assignments` has since gained `workspace_id` and
`conversation_cache_id`, both nullable, both foreign-keyed. The insert at
`supabase/functions/ai-agent-reply/tools.ts:148` supplies neither, so an
AI-escalated assignment is very likely invisible to the workspace-scoped inbox UI.

Pre-existing and out of scope. Recorded so it is not mistaken for a regression
introduced by this work, and so it can be scheduled separately.

## Verified facts this design depends on

- `ai_agent_logs.status` carries no CHECK constraint, so a new status value needs no
  migration. `ai_agent_logs.platform` already permits `threads`.
- `ai_agent_logs` has no metadata column. `logOutcome` (`index.ts:184`) writes the
  structured `meta` object to `system_logs.metadata` instead. `status` is therefore
  the only queryable discriminator on `ai_agent_logs` itself.
- `ai_providers.provider_code` values in production are `brave_search`, `claude`,
  `elevenlabs`, `exa`, `firecrawl`, `gemini`, `higgsfield`, `minimax`, `openai`,
  `openrouter`, `perplexity`, `xai`, `zai`. Google's code is `gemini`, matching
  `SUPPORTED_PROVIDERS` in `AdminAiAgentSection.tsx:22-26`.
- `ai_agent_allowed_models` rows use provider `google` for Gemini models, while
  `ai_providers` uses `gemini`. `KNOWN_MODEL_PROVIDERS` (`logic.ts:49`) accepts both,
  so both resolve at runtime.
- `detectReplyLanguage` (`logic.ts:25`) returns exactly `"ar" | "en"`.
- `messaging-api` validates model fields only when they are present in the payload:
  `modelFields.filter((field) => field in updates)` at `index.ts:453`.
- Two rows exist in `whatsapp_agents`, five in `whatsapp_conversation_assignments`.
- The platform's main service creates every function worker with
  `workerTimeoutMs = 1 * 60 * 1000` — a hard 60-second ceiling. Read from
  `/home/deno/functions/main/index.ts` inside
  `postorasupabase-supabase-j8axyh-supabase-edge-functions` on 2026-08-27.
  `memoryLimitMb` is 150 in the same block.
- `CHAT_TIMEOUT_MS` is 25 s (`index.ts:75`), applied per model call via
  `AbortSignal.timeout` inside `chatCompletion` (`index.ts:88-109`), which currently
  takes no timeout parameter.
- `escalated` is declared at `index.ts:581` and set by any tool returning
  `{escalated: true}`; the model loop continues to a further iteration afterwards so
  the model can phrase a closing message.

## Review record

This design was reviewed adversarially by Codex (`gpt-5.6-sol`, medium effort,
read-only) on 2026-08-27, which returned REJECT with nine blocking objections. Every
one was verified against source before being accepted. The material outcomes are folded
into the sections above rather than listed separately; the four that changed the
design's substance rather than its wording were:

- The deploy command in the first draft would have silently served old code.
- Apologising before escalating created a permanent apology loop on a failed mode
  write, and let the copy claim a notification that had not happened.
- A tool-driven escalation followed by a failing iteration escalated twice.
- The 60-second worker ceiling makes a three-model chain unable to complete at all on
  slow failures, so the floor as first designed would not have run in the case that
  matters most.

A second round on 2026-08-27 returned REJECT again: objections 1, 2, 4, 7 and 8 were
confirmed CLOSED, and five new defects were raised. All five are now fixed —
`deliverModelOutageFloor` moved to its own module (it could not compile in either
`index.ts` or `tools.ts`), `humanNotified` propagated through `ToolResult` instead of
inferred, the floor's reserve split so a stalled admin notification cannot starve the
customer's message, the conversation-mode snapshot moved out of git, and the deploy
preflight reduced to a single mechanical boolean.

Two objections remain open by decision rather than oversight, both recorded above: the
concurrent-message apology race (needs a compare-and-set claim; deferred until
production shows duplicates) and the workspace-blind assignment writes (finding 4's
follow-up; mitigated here by making the apology copy honest rather than by rebuilding
the handoff).

Line-number corrections from both rounds are applied throughout.

---

# Phase 1 — a delivery floor under the model chain

## Problem

`index.ts:615` throws when every model in the chain fails. The throw lands in the
outer catch at `index.ts:748`, which returns `jsonResponse({ok: false, error})`.
`jsonResponse` (`_shared/cors.ts:45`) defaults to HTTP 200, and the callers discard
the body regardless. The customer's message is dropped with no apology, no retry, and
no human handoff. The only trace is a row in `ai_agent_logs` with `status: "error"`,
indistinguishable from any other failure.

`escalateToHuman` (`tools.ts:116`) is a working handoff mechanism, but it is reachable
only as a tool the model chooses to call — so it is unavailable exactly when every
model has failed.

## Design

### Discriminating exhaustion from every other error

A dedicated error class, thrown at the existing site:

```ts
export class ModelChainExhaustedError extends Error {}
```

Declared in `logic.ts` so it can be unit-tested and imported by both files.
`index.ts:615` throws it instead of a bare `Error`; the outer catch runs the floor
only for that class. Flooring every caught error would escalate on transient database
or send failures, which is beyond the problem being solved and would generate noise
that trains the team to ignore escalations.

### Hoisting what the catch needs

Two values are currently declared inside the try and are invisible to the catch:

- `const replySender = dryRun ? null : await buildReplySender(admin, request)` — `index.ts:523`
- `const language = detectReplyLanguage(...)` — `index.ts:508`

Both become `let … = null` declared above the try and assigned at their current
positions, along with `modelChain` (`index.ts:590`, needed by the exhaustion log) and
`escalated` (`index.ts:581`, needed by the double-escalation guard). Five hoists in
total.

`buildReplySender` can itself throw — for example `"WhatsApp account not found for AI
reply"`. That is a plain `Error` raised at `:523`, *before* the model loop, so it never
produces a `ModelChainExhaustedError` and the floor correctly does not run: there is no
model outage, and no sender to apologise through. An earlier draft of this spec claimed
that case "skips the apology but still escalates", which was wrong.

### What the floor does

Guarded by `!dryRun` in full. **Escalation runs first, and the apology is conditional
on it.** In order:

1. **Escalation.** A new exported `escalateConversation()` in `tools.ts`, extracted
   from the body of `escalateToHuman` and called by both. Its first write is
   `ai_conversation_modes` → `human_first` (`tools.ts:127`), keyed
   `(user_id, platform, conversation_id)` and therefore platform-agnostic. Assignment
   to an online `whatsapp_agents` row and the admin WhatsApp notification follow
   unchanged. It returns an `EscalationOutcome` reporting whether an agent was
   assigned and how many admins were reached.

   Skipped when the model already escalated through the `escalate_to_human` tool
   earlier in this same request — see "Not twice in one request" below.

2. **Apology.** A static, non-AI string, sent through `replySender`, **only if step 1
   succeeded** (or had already happened). Skipped when `replySender` is null and
   **skipped entirely when `request.comment_id` is set** — on a public comment, a
   visible "we are having trouble" reply is worse than silence, so a failed comment
   escalates without posting anything.

3. **Log.** One of two statuses, so the log never overstates what happened:
   - `escalated_after_model_exhaustion` — the conversation was muted for the AI and
     the handoff completed. Note this means the mode write succeeded; whether a person
     was actually *reached* is carried separately in `human_notified`, because
     `escalateConversation` can succeed with no online agent and no admin numbers.
   - `model_exhaustion_unhandled` — every model failed *and* the escalation failed.
     Nothing was sent; the conversation is still on the AI.

   Both are error-level in `system_logs` (see "Log level" below). `model_chain`,
   `model_errors`, `fallback_level`, `apology_sent` and `human_notified` all flow into
   `system_logs.metadata` through the existing `meta` argument of `logOutcome`.

The response body stays `{ok: false, error}` at HTTP 200. Changing the status code is
not in scope and would have no effect, since no caller reads it for anything but a
log line.

### Why escalation comes first

An earlier draft of this design apologised first and escalated second, and claimed the
mode flip made repeat apologies impossible. It does not — `shouldAiReply` rejects
`human_first` at `logic.ts:99`, but only once the mode row has actually been written.
Apologising first opens two repeat paths:

- The mode write fails, the apology has already gone out, and **every subsequent
  message repeats it forever**.
- The apology claims a human was notified when the escalation that would have notified
  them had not yet run, and might fail.

Escalating first closes both. A failed escalation now means no apology at all, logged
as `model_exhaustion_unhandled` — staying quiet is better than an apology loop, and
far better than a false promise.

One race survives: two messages arriving inside the same outage can both read the old
mode before either writes it, producing two apologies. This is accepted for now. It
needs a compare-and-set claim to close properly, which would add a migration to a
phase that is otherwise code-only. If `ai_agent_logs` shows two
`escalated_after_model_exhaustion` rows for one `conversation_id`, that is the signal
to build it.

### Not twice in one request

`escalated` (`index.ts:581`) is set when the model calls the `escalate_to_human` tool.
The loop then runs another iteration so the model can phrase a closing message — and
if every model fails in *that* iteration, the floor would escalate a second time:
closing and recreating the active assignment, appending duplicate history, and
notifying admins twice.

`escalated` is therefore hoisted alongside the other four values, and the floor skips
step 1 when it is already true. The apology still goes out, because the customer
received no reply either way.

### Apology text

Four strings: two languages × two outcomes.

`detectReplyLanguage` picks the language, honouring `config.language_mode` first, then
`request.language_hint`, then a character tally of the inbound text. This reuses the
resolution path established by `7f599cca` and `0065633c`; a hardcoded English string
would re-open the Arabic-customer class of bug those commits closed.

The outcome picks the wording, because the handoff is not guaranteed to reach anyone:
`escalateConversation` writes WhatsApp-shaped assignment rows on every platform and
notifies nobody when `admin_phone_numbers` is empty. So the copy only claims a
notification when `EscalationOutcome` proves one happened:

- `assigned || adminsNotified > 0` → "Someone from our team has been notified and will
  get back to you shortly."
- otherwise → "Your message is saved and we'll get back to you as soon as we can."

The second string is true regardless: the mode flip does silence the AI, so whoever
next opens the conversation sees it. Making the handoff itself workspace-aware and
platform-aware is finding 4's follow-up, not this phase.

### The floor must be reachable

`CHAT_TIMEOUT_MS` is 25 s (`index.ts:75`), and the platform's main service creates
every function worker with `workerTimeoutMs = 1 * 60 * 1000` — a hard **60-second**
ceiling, read from the running container on 2026-08-27.

Three sequential model attempts therefore need up to 75 s and **cannot complete**,
never mind leave room for the floor. `index.ts:72` already records what happens: the
isolate is killed with "an opaque 500 and no log row". A slow or hanging provider
would defeat the floor entirely, so the floor would only ever catch models that fail
*fast*. That is a pre-existing bug this phase has to fix to deliver its own guarantee.

The fix is a deadline rather than a fixed per-call timeout:

```
WORKER_BUDGET_MS  60_000   the platform's hard kill
FLOOR_RESERVE_MS  12_000   one customer send plus the escalation writes
SAFETY_MARGIN_MS   5_000   response serialisation and log writes
```

`chatCompletion` gains a `timeoutMs` parameter. Before each attempt the loop computes
what is left, breaks out if it is not positive, and otherwise passes
`min(CHAT_TIMEOUT_MS, remaining)`. A model skipped for lack of budget is recorded in
`model_errors` like any other failure, so the chain that ran stays visible in the log.

`CHAT_TIMEOUT_MS` itself stays at 25 s: the clamp handles the multi-model case, and
lowering the constant would cut off a slow-but-successful single model on the happy
path.

### Log level

`logOutcome` (`index.ts:192`) sets `system_logs.level` to `error` only when
`status === "error"`. Both new statuses represent a total model outage, so the
condition becomes a set membership over `error`, `escalated_after_model_exhaustion`
and `model_exhaustion_unhandled`. Without this a production outage is filed as `info`.

## Files

- `supabase/functions/ai-agent-reply/logic.ts` — `ModelChainExhaustedError`, the four
  apology strings and their selector, and the deadline arithmetic.
- `supabase/functions/ai-agent-reply/index.ts` — six hoists; a `timeoutMs` parameter
  on `chatCompletion`; the budget check in the model loop; the typed throw at `:615`;
  the floor call in the catch at `:748`; the error-status set in `logOutcome`.
- `supabase/functions/ai-agent-reply/outage-floor.ts` — **new**. `deliverModelOutageFloor`
  lives here, not in `index.ts` (whose import starts a server) and not in `tools.ts`
  (which would close an `index → tools → index` cycle, since the floor needs
  `ReplyRequest`, `errorMessage` and `TextSender`, all private to `index.ts`). It
  declares its own narrow request and sender interfaces instead.
- `supabase/functions/ai-agent-reply/tools.ts` — extract and export
  `escalateConversation()` returning `EscalationOutcome` and accepting an optional
  deadline; `ToolResult` gains `humanNotified` so a tool escalation's real outcome
  reaches the floor; `escalateToHuman` calls the extracted function.
- Vitest cover in `src/lib/__tests__/aiAgentReplyLogic.test.ts` for everything pure;
  Deno cover in `tools.test.ts` for the extraction.

The floor helper and the deadline arithmetic must be shaped so they can be tested
without a network or a database — the pure parts live in `logic.ts`, and the floor
takes its sender and escalation target as parameters rather than reaching for them.

The 12-second reserve is split: `escalateConversation` receives a 7-second deadline
after which it stops assigning and truncates admin notifications, leaving the rest to
protect the customer's message. Only the `ai_conversation_modes` write is mandatory —
it is what silences the AI, and everything after it is best-effort. `admin_phone_numbers`
has no cap and the sends are sequential, so without that bound a stalled Graph API
could consume the whole reserve.

## Verification

Automated, before deploying:

- The deadline arithmetic: full budget, partially spent, exhausted, and negative.
- The apology selector: both languages × both outcomes, none empty.
- `ModelChainExhaustedError` is distinguishable from a plain `Error`.
- The floor: dry run sends nothing; a comment sends nothing but still escalates; a
  failed escalation suppresses the apology and reports `model_exhaustion_unhandled`;
  an already-escalated request does not escalate twice but still apologises; a failing
  sender still leaves the escalation in place.

Against production, after deploying:

- With a **test** config (not one of the three live rows) pointed at three dead model
  strings, on **WhatsApp**: the apology arrives in the customer's language,
  `ai_conversation_modes` reads `human_first`, and `ai_agent_logs` carries
  `escalated_after_model_exhaustion`.
- The same on **Instagram**, confirming the floor is not WhatsApp-specific.
- A **slow** failure, not only a fast one: point the chain at a model that hangs rather
  than one that 404s, and confirm the floor still runs inside the 60-second worker
  budget. A dead-model test passes in milliseconds and proves nothing about the case
  the deadline exists for.
- A comment-surface run escalates and logs but posts nothing publicly.
- A normal successful reply is unchanged; `model_errors` and `fallback_level` still
  populate when an earlier model fails and a later one succeeds.
- `AiAgentLogsView` renders both new statuses without breaking.

---

# Phase 2 — migrations for the manual-sql objects

## Problem

`ai_agent_allowed_models` and the `fallback_model_1` / `fallback_model_2` columns
exist only under `supabase/manual-sql/`. Replaying `supabase/migrations/` alone
produces neither, so a fresh, branched, or rebuilt environment fails at the allow-list
query in `supabase/functions/messaging-api/index.ts:456` before any other change is
involved.

## Design

Two new files under `supabase/migrations/`, dated 2026-08-27:

1. `ai_agent_allowed_models` — `CREATE TABLE IF NOT EXISTS` with the live column set,
   `UNIQUE (provider, model_id)`, `CREATE INDEX IF NOT EXISTS
   idx_ai_agent_allowed_models_active ON (is_active, sort_order)`, the `SELECT` grant
   to `authenticated` and `ALL` to `service_role`, `ENABLE ROW LEVEL SECURITY`, and
   both policies (`ai_agent_allowed_models_read_active`,
   `ai_agent_allowed_models_admin_all`). **No seed block** — see finding 3.

   **The policies are created only when absent, not dropped and recreated.** The
   `manual-sql` original uses `DROP POLICY IF EXISTS` followed by `CREATE POLICY`,
   which is fine for a first run against a fresh database but is not a no-op against
   production: run through plain `psql` without an enclosing transaction, the drop
   commits on its own, and until the create lands ordinary users read zero rows and
   admin writes are denied. A failure between the two leaves the policy permanently
   missing. Guarding each `CREATE POLICY` behind a `pg_policies` existence check
   instead never touches a live policy at all.
2. `ai_agent_configs.fallback_model_1` and `fallback_model_2` —
   `ADD COLUMN IF NOT EXISTS`, nullable `text`, no default, no CHECK, no foreign key.

No column type, constraint, default or policy differs from what is live. This phase
makes the existing state reproducible; it does not improve the schema.

The `manual-sql/` originals stay in place as historical record.

## Verification

- Replay `supabase/migrations/` against a throwaway database inside the production
  container (the rehearsal method — `supabase start` is broken locally) and compare
  the resulting table and column definitions against production.
- Run both migrations against the production database, which already holds these
  objects: expect no error, no row change in `ai_agent_allowed_models`, and no column
  alteration.

---

# Phase 3 — one global three-slot control

## Decision context

The current design is a catalog: an admin curates many allowed models and each user
picks a primary plus two fallbacks per platform. It is being replaced by a global,
admin-only Primary / Fallback 1 / Fallback 2 that applies to every user and every
platform identically.

This is deliberate, with the consequence accepted: the four production config rows
are forced onto the global slots on the next `ai-agent-reply` run, with no opt-out and
no per-user override. No migration-safety escape hatch is built.

## 3a — storage

Three `system_settings` rows, following the key and value shape Chat Models already
uses:

```
default_ai_model_agent             {"provider_code": "...", "model_id": "..."}
default_ai_model_agent_fallback    {"provider_code": "...", "model_id": "..."}
default_ai_model_agent_fallback_2  {"provider_code": "...", "model_id": "..."}
```

The brief offered `default_ai_model_agent_primary` / `_agent_fallback` /
`_agent_fallback_2` as an example and explicitly delegated the choice. Naming the
first slot `default_ai_model_agent` matters: `parseSettingsRows`
(`src/hooks/useAIConfiguration.ts:41`) routes rows by matching
`default_ai_model_${category}` and its two suffixes, longest first. Adding `agent` to
`MODEL_CATEGORIES` (`useAIConfiguration.ts:26`) therefore makes the parser, all three
upsert mutations (`useSetDefaultModel`, `useSetFallbackModel`, `useSetFallback2Model`)
and `DefaultModelSelector` work with no new code. The brief's naming would need a
bespoke parser branch and three bespoke mutations for no functional gain.

A dedicated table was considered and rejected: three global scalars are exactly what
`system_settings` is for, and the existing hooks already read and write that shape.

No migration is needed — `system_settings` rows are created by the upsert on first
save.

## 3b — admin UI

`src/pages/admin/AdminSettings.tsx:419` currently renders `<AdminAiAgentSection />`.
That is the page the brief calls "the AI Providers page". It gains a
`<DefaultModelSelector category="agent" capability="chat" … />` with three
`TierSelector` slots, saving immediately on change through the existing hooks — the
same no-Save-button behaviour Chat Models has.

`TierSelector` needs no export: `DefaultModelSelector` already receives `providers` as
a prop, so the restriction is applied by filtering that prop.

**The provider list for this section is restricted to `openai`, `openrouter` and
`gemini`.** These are exactly the production `provider_code` values matching
`PROVIDER_ENDPOINTS` (`ai-agent-reply/index.ts:80`). The restriction is not cosmetic:
`parseModelRef` (`logic.ts:60`) rewrites an unrecognised provider prefix to
`{provider: "openai"}`, so selecting a `claude` or `zai` model would post that model
name to OpenAI's endpoint and fail with a confusing error. A provider without a
working endpoint in the reply engine must not appear in this dropdown.

`ModelCategory`, `CATEGORY_MODALITY` and `CATEGORY_LAST_RESORT`
(`DefaultModelSelector.tsx:25-36`) each gain an `agent` entry;
`CATEGORY_LAST_RESORT.agent` is `null`, consistent with the removal of the hardcoded
default in 3c.

The catalog UI — the add form, the active toggle, and the delete button in
`AdminAiAgentSection.tsx` — is removed. The `ai_agent_allowed_models` table, its
index, its grants and both RLS policies stay in the database untouched.

## 3c — runtime cutover

`supabase/functions/ai-agent-reply/index.ts:588-590` builds the chain from
`config.model`, `config.fallback_model_1` and `config.fallback_model_2`. It will read
the three `system_settings` rows instead, formatting each as
`${provider_code}/${model_id}` before `parseModelRef`.

**A valid Primary is required, and a gap ends the chain.** Reading the three keys and
simply filtering out the missing ones would let an unset Primary promote Fallback 2
into index 0 — where it would run as the primary model and be logged with
`fallback_level: 0`, hiding both the misconfiguration and which tier actually answered.
So: no valid Primary means an empty chain and therefore `ModelChainExhaustedError`; a
missing or malformed Fallback 1 truncates the chain rather than pulling Fallback 2
forward. "Valid" means the row's value is an object carrying string `provider_code` and
`model_id`.

The `["gpt-4o-mini"]` last resort at `:590` is removed entirely. An empty global chain
throws `ModelChainExhaustedError` into Phase 1's floor rather than silently calling a
model no admin selected.

**The cutover is not freely reversible, so it is gated.** If Task 7 deploys while the
three rows are missing or malformed, every live conversation takes the floor and is
switched to `human_first` — and reverting `index.ts` does *not* undo that, because the
old runtime honours the same mode gate at `:402-443`. The snapshot in §3f records model
choices only; it carries nothing about conversation modes.

Two guards, both immediately before the deploy:

1. Assert that all three keys exist, parse, and name a provider in
   `PROVIDER_ENDPOINTS`. Abort the deploy otherwise.
2. Record the `conversation_id` and current `mode` of every row in
   `ai_conversation_modes`, **to a server-side file outside git** — `conversation_id`
   holds customer phone numbers and PSIDs, which must not enter permanent history.
   Reversal correlates that snapshot with `ai_agent_logs` rows carrying either
   exhaustion status inside the deploy window, since a genuine handoff in the same
   period has no such log and an existing row *changed* to `human_first` would not show
   up as merely absent from the snapshot.

`ai_agent_configs.model`, `fallback_model_1` and `fallback_model_2` stay in the
database, with a code comment at the former read site marking them deprecated and
unused as of this change, pending removal after a verification window.

`parseModelRef` and `KNOWN_MODEL_PROVIDERS` are unchanged — they still parse whatever
the three global slots resolve to. `config.temperature` and `config.max_tool_iterations`
remain per-user.

## 3d — the per-user pickers come out

`AiAgentManager.tsx` gained Model and Fallback selects in `0642c878`, two days before
this work. After 3c those selects configure columns nothing reads.

They are removed, and the form stops sending `model`, `fallback_model_1` and
`fallback_model_2`. This cannot re-open the persona bug: `messaging-api` validates
model fields only when they appear in the payload (`index.ts:453`), so omitting them
skips the allow-list check entirely.

Two of the four tests in
`src/components/messaging/__tests__/AiAgentManager.test.tsx` assert on model values
and are rewritten; the regression test proving the persona saves is kept, with its
assertion narrowed to the persona.

`src/hooks/useAllowedAiAgentModels.ts` loses its last caller here and is deleted as
dead code — see 3e for why it is not repurposed.

## 3e — what becomes of `ai_agent_allowed_models`

Removing the catalog UI leaves the table with no admin interface. That is intentional,
and it goes further than losing an editor: after this phase the table has no reader
either.

Its consumers today are:

| Consumer | State after Phase 3 |
|---|---|
| `AdminAiAgentSection.tsx` (catalog CRUD) | removed in 3b |
| `AiAgentManager.tsx` model pickers | removed in 3d |
| `src/components/messaging/__tests__/AiAgentManager.test.tsx` | rewritten in 3d |
| `src/hooks/useAllowedAiAgentModels.ts` | no callers — deleted in 3d as dead code |
| `messaging-api/index.ts:452-475` | unreachable in practice; retained |
| `src/integrations/supabase/types.ts` | regenerated, entry stays while the table does |

The `messaging-api` validation block stays. It fires only when a payload contains a
model field (`index.ts:453`), and after 3d the web client sends none — but it is a
public API surface reachable by any client with a session, so the guard remains
correct and is cheap to keep.

So no minimal edit path is built. Adding one would present an admin control that
changes nothing at runtime, which is precisely the failure mode 3d exists to remove.

The table is retained only as a rollback artifact for a verification window, alongside
`ai_agent_configs.model` / `fallback_model_1` / `fallback_model_2`. **A follow-up task,
scheduled after that window closes, should drop all four together** — the table with
its index, grants and both policies; the three columns; the `messaging-api` validation
block; and the regenerated type entries. Whoever picks that task up should re-read this
section rather than inferring intent from the orphaned objects.

Until then, the five surviving rows are readable and editable by SQL alone. Nothing
reads them, so an edit has no effect.

## 3f — pre-cutover snapshot

Before any runtime change ships, the current per-user choices are captured to a
committed CSV under `docs/` — for the record only, with no rollback logic reading it.
Values as of 2026-08-27:

| user_id prefix | platform | model | fallback_model_1 | fallback_model_2 | is_enabled |
|---|---|---|---|---|---|
| `1122a2d5` | instagram | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | `openrouter/tencent/hy3:free` | (null) | true |
| `1122a2d5` | whatsapp | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | `openrouter/tencent/hy3:free` | `gemini/gemini-3.5-flash` | true |
| `12f4ba6a` | whatsapp | `google/gemini-2.5-flash` | `google/gemini-2.5-pro` | `openrouter/liquid/lfm-2.5-2.6b:free` | true |
| `7fe4d34e` | whatsapp | `openrouter/tencent/hy3:free` | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | `gemini/gemini-3.5-flash` | false |

The committed file carries full `user_id` values.

## Verification

- The snapshot file exists and is committed before the runtime cutover deploys.
- Saving each of the three slots persists to `system_settings` and survives a reload.
- The provider dropdown in the new section offers only `openai`, `openrouter` and
  `gemini` — never the other ten catalogued providers.
- A real inbound message on **WhatsApp** and one on **Instagram**, for at least one of
  the three existing users, produce replies whose `used_model` in
  `system_logs.metadata` is the new global primary, not that user's former
  `config.model`.
- The catalog UI no longer renders, and `ai_agent_allowed_models` still exists with
  its five rows, its index and both policies.
- `useAllowedAiAgentModels.ts` is deleted and no import of it remains anywhere in
  `src/`.
- The agent setup page saves a persona with no model fields in the payload, and the
  persona survives navigation.
