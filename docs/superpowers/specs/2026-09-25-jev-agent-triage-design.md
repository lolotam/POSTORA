# Jev triage for AI agent replies — design

**Status:** awaiting approval · **Date:** 2026-09-25

## Goal

Faster social-media replies from the AI agent (DMs and comments), including replies that use connectors.
TypeSafe **Jev** is a *decision* model. It returns typed choices and probabilities, not text, so it
cannot write the reply. It decides, in about 0.4s, which parts of the pipeline a message needs. The
chat model still writes every reply.

## Measured facts (2026-09-25, from the Contabo host)

| | OpenRouter | Vercel AI Gateway |
|---|---|---|
| Model id | `typesafe/jev-1.13` (alias `~typesafe/jev-latest`) | `typesafe-ai/jev` |
| Endpoint | `POST https://openrouter.ai/api/v1/systemone` | `POST https://ai-gateway.vercel.sh/v1/evaluate` |
| Yes/no question type | `noul` → answer `{ noul: p }` | `boolean` → answer `{ probability: p }` |
| Choice question | `{type:"choice", instructions, criteria:{key: description}}` → `{choice, probabilities, confidence}` | same |
| Round trip | 0.41–0.44s | ~0.4s |
| Cost | ~$0.000017 per call (input $0.042/M tokens, output free) | same |
| Limit | 32k tokens (state plus questions) | same |

Both providers answered a sample DM correctly: intent `pricing` at 0.97, and "needs catalogue" at 0.87–0.90.

## Where the time goes today (ai-agent-reply)

About 12 sequential awaits happen before the first model call: config, thread upsert, four gate
checks, outbox, history, embedding config, the knowledge RPC, the graph RPC, tool rows, tool
links, and Composio lookups. All connector tools are sent on every call, and the model loops up to
`max_tool_iterations` (default 5) rounds. No intent step comes before the model.

## Design

### 1. One triage call per inbound message

A new `_shared/agentTriage.ts` builds one Jev request.

- **State:** the message plus the last 2 history turns, truncated to fit the limit.
- **Questions:**
  - `needs_knowledge` (yes/no): does answering need the business's knowledge base?
  - `connector` (choice): one criterion per connector resolved for the account, using its name
    and description, plus `none`.
  - `handoff` (yes/no): is the person angry or asking for a human, or does this need a human?
    Only asked when the account's handoff switch is on.
  - `smalltalk` (yes/no): a greeting, thanks or emoji-only message that needs no facts.

The call starts as soon as the message and account are known. It runs **in parallel** with the
existing gate checks and history load, so it adds almost no time.

### 2. How the answers are used

Each answer applies only at confidence ≥ **0.80**, a constant tuned from the logs.

| Answer | Effect |
|---|---|
| `needs_knowledge` false | Skip the embedding call and both knowledge RPCs. |
| `connector` = X | Send only X's tools plus the base tools, and set `tool_choice: required` on the first round. |
| `connector` = none | Send no connector tools. |
| `handoff` true | Take the existing `escalate_to_human` path directly, with no chat model call. |
| `smalltalk` true | Short prompt, no tools, no knowledge search, and `max_tokens` capped. |

### 3. Fail-open, always

A Jev error, a timeout over **1.5s**, a missing key, or confidence below the threshold means the
pipeline runs exactly as it does today. Triage only removes work; it never blocks or rewrites a reply.

### 4. Settings

- **AI Agent section:** a new "Triage (Jev)" picker in the admin UI, stored in two new
  `system_settings` keys:
  - `default_ai_model_agent_triage`, default `openrouter / typesafe/jev-1.13`;
  - `default_ai_model_agent_triage_fallback`, default `vercel / typesafe-ai/jev`.
- **Off by default.** An empty slot means no triage.
- **Catalogue sync:** the sync stops skipping these models. Vercel `evaluation` and OpenRouter
  `decisions` map to a new capability `triage`, which only this picker lists, so Jev never shows
  up as a chat model.
- **Provider dialects:** one adapter per provider converts the yes/no type (`noul` ↔ `boolean`)
  and its answer field.

### 5. Observability

Each `ai_agent_logs` row gets a `triage` object with the provider, latency, the answers and
confidences, and which shortcuts applied. That lets an admin compare reply times with triage on
and off on real traffic.

## Testing

- **Pure unit tests:** request builder (connector criteria, the conditional handoff question,
  truncation), dialect adapters, and the decision→shortcut mapping (threshold and fail-open).
- **ai-agent-reply tests:** each shortcut, plus the fail-open paths (error, timeout, low
  confidence) proving today's pipeline runs unchanged.
- **Live check after deploy:** a dry-run agent reply with triage on and off, comparing latency and
  the logged decisions.

## Out of scope

- Jev writing replies (it cannot).
- Replacing auto-reply rules.
- OpenRouter image, video, speech and transcription runtimes.

## Open items for the plan

- Does `ai_models.capabilities` have a CHECK or enum constraint that `triage` must be added to?
- The admin-UI location of the picker: the AI Agent sub-tab next to the agent model slots.
