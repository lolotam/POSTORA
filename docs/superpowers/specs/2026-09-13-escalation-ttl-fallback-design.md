# Escalation fallback and timeout — design

**Date:** 2026-09-13 · **Branch:** `feat/escalation-ttl-fallback` · **Status:** approved in brainstorming; revised after debate round 1 (Codex astra 6 high, 2026-09-13) — verdict table in the plan

## Problem (proven on production, 2026-09-12)

`escalate_to_human` upserts a per-conversation row in `ai_conversation_modes` with `mode = 'human_first'`. That row outranks the account's `default_mode` for ever: `shouldAiReply` returns `mode_human_first` unconditionally, nothing expires the row, and the inbox gives no sign it exists. With the only human agent offline, conversation `wa_96592280746_96555683677` was silenced from 20:38 until the row was deleted by hand; nine such rows were written in the last 30 days.

## Goal

An escalated conversation is never silenced indefinitely. A human gets an exclusive window only while a human is actually available; otherwise the assistant keeps answering. Every escalation override expires on an operator-configured timeout, and an operator can release a conversation in one click.

## Decisions (from brainstorming, 2026-09-13)

1. **What escalation writes** depends on the account default and on whether a human was assigned:
   - default `human_then_ai`, a human online and assigned → override `human_first` with `expires_at` (exclusive human window).
   - default `human_then_ai`, nobody online → override `human_then_ai` with `expires_at` (assistant keeps answering; the row exists so the inbox can show the badge and the outbox can see the escalation).
   - default `ai_first` → override `human_first` with `expires_at`.
   - default `human_first` → override `human_first` with `expires_at` (identical to today once expired, since the default is human anyway).
2. **The timeout field** appears in agent settings for `human_then_ai` and `ai_first`. Hidden for `human_first`.
3. **An expired override is ignored by every reader and deleted by the reply path** when it meets one, so the badge disappears on its own.
4. **The badge and the "Resume AI" button live inside `AiConversationModeSelect`**, so the WhatsApp pane and the FB/IG conversation detail both get them.

## Data model (additive, migration `20260913120000_escalation_ttl.sql`)

- `public.ai_conversation_modes.expires_at timestamptz null` — null means "until released". Set only by escalation; a manual override from the inbox or the partner API never sets it.
- `public.ai_agent_configs.escalation_timeout_minutes integer not null default 240`, `check (escalation_timeout_minutes between 1 and 10080)` (1 minute to 7 days).
- **Remediation of the existing failure population:** rows with `mode = 'human_first'` and `expires_at is null` that an escalation demonstrably wrote — a `whatsapp_conversation_assignments` row for the same conversation whose `notes` start with `AI escalation:` — get `expires_at = now() + 240 minutes`. Unassigned escalations left no provenance and are indistinguishable from manual overrides, so they are **not** blanket-expired; the release step lists the remaining null-expiry `human_first` rows per account for a human decision.
- `notify pgrst, 'reload schema'` at the end, because PostgREST caches columns (a missing column drops a whole PostgREST write with PGRST204).
- **The migration is a hard prerequisite.** Code that selects `expires_at` fails against a schema without it; there is no missing-column tolerance.
- No new tables, no policy changes: the existing owner policy on `ai_conversation_modes` and the config policies cover the new columns.

## Server behaviour

### One shared reader: `supabase/functions/_shared/conversationModeOverride.ts`

```ts
export interface ConversationModeRow { mode: string; expires_at?: string | null }
/** The override that applies now, or null when there is none or it has expired. */
export function activeOverrideMode(row: ConversationModeRow | null | undefined, nowMs: number): string | null
export function isOverrideExpired(row: ConversationModeRow, nowMs: number): boolean
export interface EscalationOverride { mode: "human_first" | "human_then_ai"; expires_at: string }
/** Decision 1, as a pure function. timeoutMinutes null/undefined/0 → 240. */
export function escalationOverride(defaultMode: string, humanAssigned: boolean, timeoutMinutes: number | null | undefined, nowMs: number): EscalationOverride
```

Every reader of `ai_conversation_modes` goes through `activeOverrideMode`:

| Reader | Today | After |
|---|---|---|
| `ai-agent-reply/index.ts` mode gate | `select("mode")` | `select("mode, expires_at")`; expired → treated as none **and the row is deleted** (one awaited delete, error logged, never fatal) |
| `process-pending-replies/index.ts` `loadContext` | `mode === "human_first"` | `activeOverrideMode(row, now) === "human_first"` |
| `messaging-api` `ai_get_conversation_mode` | returns the row | returns `null` when expired; otherwise the row including `expires_at` |
| `messaging-api` `ai_list_conversation_modes` | all rows | expired rows filtered out |
| `partner-api/v1/conversationModes.ts` | `mode, updated_at` | adds `expires_at` to the read columns and the response; expired → `mode: null` |

### Escalation: `ai-agent-reply/tools.ts` `escalateConversation`

`EscalationTarget` (and `ToolContext`, which is declared independently and must carry the same fields) gains:

```ts
defaultMode?: string | null;               // config.default_mode
escalationTimeoutMinutes?: number | null;  // config.escalation_timeout_minutes
/** Mute for the whole window whatever the default: set by the outage floor and by outbox recovery. */
muteRegardless?: boolean;
```

**The authoritative write sequence** (the plan is the contract; this section restates it):

1. **First write, before assignment** — `first = muteRegardless ? human_first + expiry : escalationOverride(defaultMode, false, timeout, now)`. Under `human_then_ai` this is `human_then_ai` (the assistant keeps answering; the row exists for the badge and the outbox). Under every other default, and always for the outage floor and recovery, it is `human_first` with an expiry. If this write fails the function throws, exactly as today.
2. **Assignment block, unchanged.**
3. **After assignment** — `decided = escalationOverride(defaultMode, assigned, timeout, now)`. Only when `decided.mode !== first.mode` (that is: `human_then_ai` default and a human was assigned) run one **conditional** update: `update({ mode: "human_first" })` filtered by `user_id, platform, conversation_id` **and** `mode = first.mode` **and** `expires_at = first.expires_at`, with `.select("mode").maybeSingle()`. Inside the post-mute try/catch: an error is logged, never thrown. Zero rows means an operator or a newer escalation changed the row meanwhile; the newer decision wins and is re-read.
4. `EscalationOutcome.mode` is the **confirmed persisted** mode: the first write's mode when no update ran, the updated row's mode when the update returned one, the re-read row's mode (or `"released"` when the row is gone) when the update matched nothing or failed. `EscalationOutcome.expiresAt` is `first.expires_at`.

**A manual override is never touched.** If the conversation already holds a row with `expires_at` null (only the inbox and the partner API write those), the escalation writes nothing, tightens nothing, and reports the row's mode with `expiresAt: null`; the assignment and admin notifications still run. Expiry can therefore never undo a narrowing an operator chose (AGENTS.md rule 5).

**A repeated escalation inside an active window** (a bounded row whose `expires_at` is still in the future) neither rewrites the row — the window is not extended — nor pages the admins again; it may still tighten `human_then_ai` to `human_first` when a human has come online since. `EscalationOutcome.repeated` says so. Without this an unmuted `human_then_ai` chat could re-notify admins and extend its own window on every customer message (code review, 2026-09-13).

**Interrupted between 1 and 3:** the conversation stays in the first write's mode for at most the window — the assistant answering under `human_then_ai`, muted under the others. Both are bounded; neither is the indefinite silence this design removes.

**Outage floor** (`outage-floor.ts`): passes `{ ...target, muteRegardless: true }`. Its apology-suppression contract depends on the mute, and an assistant whose every model failed must not keep answering.

**Outbox recovery** (`process-pending-replies/index.ts` `handToHuman`): loads `default_mode, escalation_timeout_minutes` for the row's exact account (`social_account_id` + `user_id`), fails the hand-off on a read error instead of guessing, and passes `muteRegardless: true` — an interrupted tool run is ambiguous state, so the window is a human's.

**One reader for every caller.** `resolveConversationOverride(admin, scope, now)` in the shared module does the read, the expiry check, the conditional cleanup and the re-read; `ai-agent-reply` and `process-pending-replies` both call it, so outbox recovery retires expired rows too. **Expired-row cleanup** deletes conditionally: by `id` **and** the `expires_at` it observed. A row an operator has since replaced (new `expires_at`, or null) is left alone and re-read before the gate.

### Config: `_shared/agentConfigOps.ts`

`escalation_timeout_minutes` joins `CONFIG_FIELDS`; validation: integer, 1 ≤ n ≤ 10080, else `invalid("escalation_timeout_minutes must be between 1 and 10080")`.

**The frontend does not call this module.** `messaging-api` action `ai_upsert_config` (index.ts ~line 492) has its own `allowedFields` list; the field is added there with the same integer check, or the save silently keeps 240.

## Frontend

- `useAiAgentConfig.ts`: `escalation_timeout_minutes: number` on the type and in `CONFIG_FIELDS`.
- `AiAgentManager.tsx`: `toFormValues` copies it; `defaultConfig` gets `escalation_timeout_minutes: 240`.
- `AgentIdentityCard.tsx`: directly under the engagement-mode select, when `selectedMode !== "human_first"`, an **Escalation fallback timeout** control: number input (`min=1`) plus a unit select (Minutes / Hours). The form always stores whole minutes. **Switching the unit never changes the stored value**: hours are shown as a decimal (`minutes / 60`, up to two decimals, `step="any"`), and a typed hours value is rounded to whole minutes on change. A `HelpCircle` icon wrapped in the shadcn `Tooltip` reads: "How long an escalated conversation stays with your team before the override expires and the account default applies again, so the AI can resume answering new messages." Helper text under the input: "When the assistant hands a conversation to your team, this timeout keeps it from staying muted for ever. After it expires the account default applies again to new messages; a message that arrived while the conversation was muted is not answered retroactively."
- `useAiConversationMode.ts`: `expires_at: string | null` on `AiConversationMode`.
- `useAiConversationMode.ts`: the query refetches every 60 s (`refetchInterval`) so a badge created or expired while the pane is open updates without a reload.
- `AiConversationModeSelect.tsx`: when a row is returned **with `expires_at` set** (only escalation sets it, so this is the provenance test; a manual override shows nothing new), render next to the select a badge **Escalated to human · until HH:MM** and a **Release override** button that calls `setConversationMode.mutate("default")` with the toast "Override cleared. The account default applies again." The select itself is unchanged.
- `src/integrations/supabase/types.ts`: `expires_at` on `ai_conversation_modes` Row/Insert/Update; `escalation_timeout_minutes` on `ai_agent_configs` Row/Insert/Update.

## Out of scope

- **Answering retroactively.** Expiry lets the assistant answer **future** inbound messages. A message that arrived while the override blocked the gate was cancelled in the outbox and is not revived; the helper text says so.
- Releasing a human's ownership mid-window when they go offline. The window is the operator's bound; an operator can release it from the inbox at any time.

- A scheduled sweeper for expired rows (the reply path deletes on contact; the badge is hidden by the reader).
- Changing what the assistant says when it escalates, or preventing repeated escalations under `human_then_ai` with nobody online. The model sees its own earlier handoff message in the thread; that is the existing behaviour.
- The Threads/FB/IG assignment tables (WhatsApp-shaped, unchanged).

## Release ordering

1. Apply the migration on the live database (ssh-contabo-mcp, as `supabase_admin`) and confirm both columns exist and PostgREST reloaded.
2. Merge. The schedule syncs the edge functions within two minutes; Dokploy rebuilds the frontend.
3. Verify: a config save with the new field succeeds; an escalation on the Danat test chat writes `expires_at`; a released or expired override lets the assistant reply.

The migration is backward compatible: old code ignores both columns, and the config default keeps every existing save valid.
