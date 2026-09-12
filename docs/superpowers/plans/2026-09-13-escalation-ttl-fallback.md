# Escalation Fallback and Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An escalated conversation never stays silent for ever: the override expires on a configurable timeout, the assistant keeps answering when no human is online, and an operator can release a chat in one click.

**Architecture:** One additive migration (with provenance-backed remediation of existing rows); one shared pure module (`_shared/conversationModeOverride.ts`) that every reader of `ai_conversation_modes` uses; `escalateConversation` writes a bounded first row and tightens it only after a human was actually assigned, with conditional writes so an operator's newer decision always wins; the frontend adds a timeout control and an escalation badge with a release button.

**Tech Stack:** Postgres (self-hosted Supabase), Deno edge functions, React 18 + TypeScript + shadcn/ui, vitest, Deno test.

**Spec:** `docs/superpowers/specs/2026-09-13-escalation-ttl-fallback-design.md`

## Global Constraints

- Read `ARCHITECTURE.md` §12–§17 (edge function shape, validation, error handling, logging), §23 (migrations), §24 (service role: tenancy must be structural, every query scoped by `user_id` or workspace), §36 (backward compatibility: additive only).
- Every early return that refuses work in an edge function writes a log row; a discarded `error` beside a `maybeSingle()` is forbidden (AGENTS.md reviewer rules 3 and 4). A failed read of `ai_conversation_modes` must never be treated as "no override".
- The migration lands on the live database **before** the code that reads the new columns is merged. There is no missing-column tolerance in code.
- `expires_at` is set only by escalation. Manual overrides from the inbox (`ai_set_conversation_mode`) and the partner API write `expires_at: null`.
- Writes that change an override after the first escalation write are **conditional** on the row still holding what this run observed (`mode` and `expires_at`); a newer decision by an operator or another run wins.
- The stored timeout is always whole minutes; the UI converts hours to minutes on change and never stores hours. Switching the display unit never changes the stored value.
- Timeout range: integer 1..10080. Default 240. `null`, `undefined` or `0` at escalation time means 240.
- No new dependencies. No changes to `whatsapp_conversation_assignments` semantics.
- Implementers do not commit. Implementers do not deploy, do not run migrations, and do not touch `F:/Postora_new`.
- Gates: `deno test --allow-env --allow-net --allow-read <changed test files>` and `deno check <changed modules>` from `supabase/functions`; `bun run typecheck`; `bunx eslint <changed files>`; `npx vitest run <changed suites>` from the worktree root.

---

## Debate round 1 — verdict table (Codex astra 6 high, read-only relay, 2026-09-13)

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | Settings save silently discards the timeout (`ai_upsert_config` has its own allowlist) | P1 | accept | Verified at `messaging-api/index.ts:492`. Task 3 step 7 adds the field and check there; Task 5 saves a non-default value and reads it back. |
| 2 | Spec and plan prescribed opposite first writes | P1 | accept | The plan's sequence is now authoritative and the spec restates it: first write = `escalationOverride(default, false)` (no mute under `human_then_ai`), tightened to `human_first` only after a human was assigned; `muteRegardless` for the outage floor and recovery. Interrupted-write behaviour is stated. |
| 3 | Expiry cleanup can delete a newer human override | P1 | accept | Delete is conditional on `id` and the observed `expires_at`; a changed row is re-read before the gate. |
| 4 | Final mode update can overwrite operator changes and report an unwritten result | P1 | accept | Conditional update on observed `mode` + `expires_at`, `.select().maybeSingle()`, inside the post-mute try/catch; `EscalationOutcome.mode` is the confirmed persisted mode, re-read on conflict. |
| 5 | Human availability sampled once; helper text promises more | P2 | partial | The exclusive window is by design a bounded window an operator can release; mid-window availability changes are out of scope (spec "Out of scope"). The tooltip and helper text no longer promise a live availability check. |
| 6 | "Resume AI" can leave AI disabled while announcing success | P2 | accept | Button is "Release override"; toast says the account default applies again. |
| 7 | Existing indefinite escalations survive the migration | P1 | accept | Migration sets `expires_at` on `human_first` rows with an `AI escalation:` assignment note (provenance). Rows without provenance are listed at release for a human decision, not blanket-expired. |
| 8 | Recovery escalations ignore account mode and timeout; config loader is owner/platform-scoped and discards errors | P2 | accept | `handToHuman` loads `default_mode, escalation_timeout_minutes` by `social_account_id` + `user_id`, throws on a read error, passes `muteRegardless: true`. |
| 9 | Expiry does not resume an unanswered message | P2 | partial | Defined as future-inbound-only in the spec and the helper text. Reviving cancelled outbox rows is out of scope. |
| 10 | Outage floor loses repeated-apology protection | P2 | accept | Outage floor passes `muteRegardless: true`; Task 5 adds a repeated-inbound regression test. |
| 11 | Recovery `loadContext` treats failed reads as absent overrides | P2 | accept | Both errors are checked and thrown; the claim loop's catch at `process-pending-replies/index.ts:385` keeps the row for the next tick. |
| 12 | Badge misidentifies manual overrides; no expiry refresh | P2 | partial | Badge only when `expires_at` is set (escalation provenance). Query refetches every 60 s. A realtime subscription is out of scope. |
| 13 | `toolContext` object does not type-check | P2 | accept | `ToolContext` gains the same three fields. |
| 14 | Missing-column tolerance is not implementable | P2 | accept | Claim removed; the migration is a hard prerequisite (release ordering). |
| 15 | Changing display units silently changes the timeout | P2 | accept | Unit switch preserves stored minutes; hours shown as a decimal with `step="any"`; typed hours round to whole minutes. Tests cover 1, 30 and 90 minutes. |
| 16 | Acceptance gates can pass without proving fallback | P2 | accept | Release step requires a live escalation on the test chat with a short timeout, an actual expiry, and a verified subsequent reply; the sandbox path performs no escalation writes and does not count. Task 5 adds reader-integration and conflict tests. |

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20260913120000_escalation_ttl.sql` | Two additive columns, one check, provenance remediation, schema reload | 1 |
| `supabase/functions/_shared/conversationModeOverride.ts` (new) | Pure: is an override active, what escalation writes | 2 |
| `supabase/functions/ai-agent-reply/tools.ts` | Bounded first write, conditional tightening after assignment, confirmed outcome | 3 |
| `supabase/functions/ai-agent-reply/index.ts` | Reads through the shared reader, conditional delete of expired rows, passes config into the target | 3 |
| `supabase/functions/ai-agent-reply/outage-floor.ts` | `muteRegardless: true` | 3 |
| `supabase/functions/process-pending-replies/index.ts` | Expiry-aware `humanTookOver`, error-checked context, account-scoped config for `handToHuman` | 3 |
| `supabase/functions/messaging-api/index.ts` | `ai_upsert_config` accepts the field; get/list hide expired rows; set writes `expires_at: null` | 3 |
| `supabase/functions/partner-api/v1/conversationModes.ts` | reads and returns `expires_at`; expired → null; set writes `expires_at: null` | 3 |
| `supabase/functions/_shared/agentConfigOps.ts` | accepts and validates `escalation_timeout_minutes` | 3 |
| `src/integrations/supabase/types.ts` | new columns | 4 |
| `src/hooks/useAiAgentConfig.ts`, `src/components/messaging/AiAgentManager.tsx` | field plumbing | 4 |
| `src/components/messaging/agent-settings/AgentIdentityCard.tsx` | timeout control with tooltip | 4 |
| `src/hooks/useAiConversationMode.ts`, `src/components/messaging/AiConversationModeSelect.tsx` | badge + Release override, 60 s refetch | 4 |
| Tests | Task 5 | 5 |

Slices: **SQL** = Task 1 (Migrations lane). **Backend** = Tasks 2 + 3. **Frontend** = Task 4. The three touch disjoint paths and run in parallel from the same baseline. Task 5 runs after the backend and frontend slices have landed on the integration branch.

---

### Task 1: Migration (Migrations lane — Muse Spark)

**Files:**
- Create: `supabase/migrations/20260913120000_escalation_ttl.sql`

**Interfaces:**
- Produces: `public.ai_conversation_modes.expires_at timestamptz null`; `public.ai_agent_configs.escalation_timeout_minutes integer not null default 240` with check `between 1 and 10080`.

- [ ] **Step 1: Write the migration**

```sql
-- Escalation overrides expire, and the timeout is per agent config.
-- Additive on purpose: code deployed before this migration ignores both
-- columns, and the default keeps every existing config save valid
-- (ARCHITECTURE.md §36).

alter table public.ai_conversation_modes
  add column if not exists expires_at timestamptz;

comment on column public.ai_conversation_modes.expires_at is
  'When an escalation-written override stops applying. NULL = until released. Set only by escalate_to_human; manual overrides write NULL.';

alter table public.ai_agent_configs
  add column if not exists escalation_timeout_minutes integer not null default 240;

alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_escalation_timeout_minutes_check;
alter table public.ai_agent_configs
  add constraint ai_agent_configs_escalation_timeout_minutes_check
  check (escalation_timeout_minutes between 1 and 10080);

comment on column public.ai_agent_configs.escalation_timeout_minutes is
  'Minutes an escalated conversation stays with humans before the override expires and the account default applies again. 1..10080.';

-- Remediation of the failure population this change exists for: overrides an
-- escalation demonstrably wrote (its assignment note starts with
-- "AI escalation:") and that nothing ever expired. Manual overrides carry no
-- such note and are left alone; a person decides those at release.
update public.ai_conversation_modes m
   set expires_at = now() + interval '240 minutes'
 where m.mode = 'human_first'
   and m.expires_at is null
   and exists (
     select 1
       from public.whatsapp_conversation_assignments a
      where a.conversation_id = m.conversation_id
        and a.notes like 'AI escalation:%'
   );

-- PostgREST caches the column list; without this a write naming the new
-- column is rejected with PGRST204 until the next restart.
notify pgrst, 'reload schema';
```

- [ ] **Step 2: Rehearse it** (orchestrator) against the throwaway database `rehearsal_ttl` on Contabo: `docker exec -i <db> psql -U supabase_admin -d rehearsal_ttl -v ON_ERROR_STOP=1 -q < file`, then confirm both columns and the constraint in `information_schema`. Never against production.

- [ ] **Step 3: Commit** (orchestrator): `git add supabase/migrations/20260913120000_escalation_ttl.sql && git commit -m "feat(db): escalation override expiry and per-config escalation timeout"`

---

### Task 2: Shared override reader and escalation decision (pure module)

**Files:**
- Create: `supabase/functions/_shared/conversationModeOverride.ts`
- Create: `supabase/functions/_shared/conversationModeOverride.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ConversationModeRow { mode: string; expires_at?: string | null }
export const DEFAULT_ESCALATION_TIMEOUT_MINUTES = 240;
export const MAX_ESCALATION_TIMEOUT_MINUTES = 10080;
export function isOverrideExpired(row: ConversationModeRow, nowMs: number): boolean;
export function activeOverrideMode(row: ConversationModeRow | null | undefined, nowMs: number): string | null;
export interface EscalationOverride { mode: "human_first" | "human_then_ai"; expires_at: string }
export function escalationOverride(
  defaultMode: string | null | undefined,
  humanAssigned: boolean,
  timeoutMinutes: number | null | undefined,
  nowMs: number,
): EscalationOverride;
```

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/conversationModeOverride.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { activeOverrideMode, escalationOverride, isOverrideExpired } from "./conversationModeOverride.ts";

const NOW = Date.parse("2026-09-13T10:00:00Z");

Deno.test("an override with no expiry applies until released", () => {
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: null }, NOW), "human_first");
  assertEquals(activeOverrideMode({ mode: "human_first" }, NOW), "human_first");
});

Deno.test("an override past its expiry is treated as absent", () => {
  const row = { mode: "human_first", expires_at: "2026-09-13T09:59:59Z" };
  assertEquals(isOverrideExpired(row, NOW), true);
  assertEquals(activeOverrideMode(row, NOW), null);
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: "2026-09-13T10:00:01Z" }, NOW), "human_first");
});

Deno.test("an unparseable expiry never silences a conversation for ever", () => {
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: "garbage" }, NOW), null);
});

Deno.test("escalation gives humans an exclusive window only when one was assigned", () => {
  assertEquals(escalationOverride("human_then_ai", true, 30, NOW), { mode: "human_first", expires_at: "2026-09-13T10:30:00.000Z" });
  assertEquals(escalationOverride("human_then_ai", false, 30, NOW).mode, "human_then_ai");
  assertEquals(escalationOverride("ai_first", false, 30, NOW).mode, "human_first");
  assertEquals(escalationOverride("human_first", false, 30, NOW).mode, "human_first");
  assertEquals(escalationOverride(undefined, false, 30, NOW).mode, "human_first");
});

Deno.test("escalation timeout defaults to 240 minutes and is clamped to the allowed range", () => {
  assertEquals(escalationOverride("ai_first", false, null, NOW).expires_at, "2026-09-13T14:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, 0, NOW).expires_at, "2026-09-13T14:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, 999999, NOW).expires_at, "2026-09-20T10:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, -5, NOW).expires_at, "2026-09-13T10:01:00.000Z");
});
```

- [ ] **Step 2: Run it to verify it fails** — `cd supabase/functions && deno test --allow-env _shared/conversationModeOverride.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/conversationModeOverride.ts
/**
 * The one place that decides whether a per-conversation mode override still
 * applies, and what an escalation writes.
 *
 * Every reader of ai_conversation_modes (the reply gate, the outbox recovery,
 * the inbox endpoints, the partner API) goes through activeOverrideMode. Until
 * 2026-09-13 an escalation wrote `human_first` with no expiry; with the only
 * human agent offline that silenced a conversation for good.
 */
export interface ConversationModeRow {
  mode: string;
  expires_at?: string | null;
}

export const DEFAULT_ESCALATION_TIMEOUT_MINUTES = 240;
export const MAX_ESCALATION_TIMEOUT_MINUTES = 10080;

export function isOverrideExpired(row: ConversationModeRow, nowMs: number): boolean {
  if (row.expires_at === null || row.expires_at === undefined) return false;
  const expiresMs = Date.parse(row.expires_at);
  // A value that will not parse is treated as expired: a broken timestamp must
  // never become a permanent mute.
  if (Number.isNaN(expiresMs)) return true;
  return expiresMs <= nowMs;
}

export function activeOverrideMode(
  row: ConversationModeRow | null | undefined,
  nowMs: number,
): string | null {
  if (!row) return null;
  return isOverrideExpired(row, nowMs) ? null : row.mode;
}

export interface EscalationOverride {
  mode: "human_first" | "human_then_ai";
  expires_at: string;
}

function clampTimeoutMinutes(timeoutMinutes: number | null | undefined): number {
  if (timeoutMinutes === null || timeoutMinutes === undefined || !Number.isFinite(timeoutMinutes) || timeoutMinutes === 0) {
    return DEFAULT_ESCALATION_TIMEOUT_MINUTES;
  }
  return Math.min(MAX_ESCALATION_TIMEOUT_MINUTES, Math.max(1, Math.trunc(timeoutMinutes)));
}

/**
 * Under human_then_ai a human gets an exclusive window only when one was
 * actually assigned; otherwise the assistant keeps answering and the row only
 * marks the escalation. Every other default mutes the assistant for the
 * window, which is what those modes ask for.
 */
export function escalationOverride(
  defaultMode: string | null | undefined,
  humanAssigned: boolean,
  timeoutMinutes: number | null | undefined,
  nowMs: number,
): EscalationOverride {
  const minutes = clampTimeoutMinutes(timeoutMinutes);
  const expires_at = new Date(nowMs + minutes * 60_000).toISOString();
  const mode = defaultMode === "human_then_ai" && !humanAssigned ? "human_then_ai" : "human_first";
  return { mode, expires_at };
}
```

- [ ] **Step 4: Run the test** → 5 passed. `deno check _shared/conversationModeOverride.ts` clean.

- [ ] **Step 5: Commit** (orchestrator): `git commit -m "feat(agent): shared reader for expiring conversation-mode overrides"`

---

### Task 3: Edge functions honour expiry and write bounded escalations

**Files:**
- Modify: `supabase/functions/ai-agent-reply/tools.ts` (`ToolContext` ~line 15, `EscalationTarget` ~186, `EscalationOutcome` ~197, `escalateConversation` ~215–360)
- Modify: `supabase/functions/ai-agent-reply/index.ts` (mode read ~line 606; `toolContext` ~line 843)
- Modify: `supabase/functions/ai-agent-reply/outage-floor.ts` (~line 56)
- Modify: `supabase/functions/process-pending-replies/index.ts` (`handToHuman` ~133, `AgentConfigForEscalation`/`loadAgentConfig` ~170, `loadContext` ~184)
- Modify: `supabase/functions/messaging-api/index.ts` (`ai_upsert_config` allowlist ~492 and its validation; `ai_get_conversation_mode` ~663; `ai_set_conversation_mode` ~682; `ai_list_conversation_modes` ~706)
- Modify: `supabase/functions/partner-api/v1/conversationModes.ts` (`MODE_COLUMNS`, `ModeRow`, response builder, upsert)
- Modify: `supabase/functions/_shared/agentConfigOps.ts` (`CONFIG_FIELDS` ~116, validation ~150)

**Interfaces:**
- Consumes: Task 2's module.
- Produces: `EscalationTarget` / `ToolContext` fields `defaultMode?: string | null`, `escalationTimeoutMinutes?: number | null`, `muteRegardless?: boolean`; `EscalationOutcome.mode: string` (confirmed persisted mode, or `"released"`), `EscalationOutcome.expiresAt: string`.

- [ ] **Step 1: `tools.ts` — extend `ToolContext`, `EscalationTarget` and `EscalationOutcome`**

Add to **both** `ToolContext` and `EscalationTarget`:

```ts
  /** The account default; decides whether an unassigned escalation still lets the assistant answer. */
  defaultMode?: string | null;
  /** ai_agent_configs.escalation_timeout_minutes; null/undefined/0 means 240. */
  escalationTimeoutMinutes?: number | null;
  /** Mute for the whole window whatever the default. The outage floor and outbox recovery set it. */
  muteRegardless?: boolean;
```

```ts
export interface EscalationOutcome {
  assigned: boolean;
  assignmentNote: string;
  adminsNotified: number;
  /** The mode confirmed in the row when this returned; "released" if the row is gone. */
  mode: string;
  expiresAt: string;
}
```

- [ ] **Step 2: `tools.ts` — bounded first write, conditional tightening after assignment**

Replace the first upsert with:

```ts
  const nowMs = Date.now();
  // The first write happens before assignment, exactly as before, but bounded
  // by the timeout. Under human_then_ai it deliberately does NOT mute: the
  // exclusive human window is granted only once a human was actually assigned.
  // The outage floor and recovery ask for the mute regardless.
  const first = target.muteRegardless
    ? { mode: "human_first" as const, expires_at: escalationOverride("ai_first", false, target.escalationTimeoutMinutes, nowMs).expires_at }
    : escalationOverride(target.defaultMode, false, target.escalationTimeoutMinutes, nowMs);
  const { error: modeError } = await target.admin
    .from("ai_conversation_modes")
    .upsert(
      {
        user_id: target.userId,
        platform: target.platform,
        conversation_id: target.conversationId,
        mode: first.mode,
        expires_at: first.expires_at,
      },
      { onConflict: "user_id,platform,conversation_id" },
    );
  if (modeError) throw modeError;
```

After the assignment `try/catch` block and before the admin notifications, add — **inside its own try/catch**, because nothing after the first write may throw:

```ts
  let persistedMode: string = first.mode;
  const decided = target.muteRegardless
    ? first
    : escalationOverride(target.defaultMode, assigned, target.escalationTimeoutMinutes, nowMs);
  if (decided.mode !== first.mode) {
    try {
      // Conditional on the row still holding what this run wrote: an operator
      // or a newer escalation that changed it meanwhile wins.
      const { data: updated, error: decideError } = await target.admin
        .from("ai_conversation_modes")
        .update({ mode: decided.mode })
        .eq("user_id", target.userId)
        .eq("platform", target.platform)
        .eq("conversation_id", target.conversationId)
        .eq("mode", first.mode)
        .eq("expires_at", first.expires_at)
        .select("mode")
        .maybeSingle();
      if (decideError) throw decideError;
      if (updated) {
        persistedMode = updated.mode;
      } else {
        const { data: current, error: currentError } = await target.admin
          .from("ai_conversation_modes")
          .select("mode")
          .eq("user_id", target.userId)
          .eq("platform", target.platform)
          .eq("conversation_id", target.conversationId)
          .maybeSingle();
        if (currentError) throw currentError;
        persistedMode = current?.mode ?? "released";
      }
    } catch (decideFailure) {
      console.error(
        "[ai-agent-reply] escalation mode decision failed; the first write stands for at most the window:",
        typeof decideFailure === "object" && decideFailure !== null && "message" in decideFailure
          ? String((decideFailure as { message: unknown }).message)
          : String(decideFailure),
      );
    }
  }
```

Return `{ assigned, assignmentNote, adminsNotified, mode: persistedMode, expiresAt: first.expires_at }`. Import `escalationOverride` from `../_shared/conversationModeOverride.ts`. Existing callers that destructure the outcome keep working; `escalateToHuman`'s `ToolResult.output` may append `` (mode: ${outcome.mode}, until ${outcome.expiresAt}) `` so the sandbox and logs say what was written.

- [ ] **Step 3: `index.ts` — read through the shared reader, delete expired rows conditionally, pass config into the target**

Replace the mode read (~line 606):

```ts
    const { data: modeOverride, error: modeReadError } = await admin
      .from("ai_conversation_modes")
      .select("id, mode, expires_at")
      .eq("user_id", request.user_id)
      .eq("platform", request.platform)
      .eq("conversation_id", request.conversation_id)
      .maybeSingle();
    // A failed read must not look like "no override": that would let the
    // assistant answer a chat a human has taken (AGENTS.md reviewer rule 3).
    if (modeReadError) throw modeReadError;
    let overrideMode = activeOverrideMode(modeOverride, Date.now());
    if (modeOverride && overrideMode === null) {
      // Expired. Delete it so the badge and the outbox stop seeing it -- but only
      // the exact row observed: an operator may have replaced it meanwhile, and
      // that newer decision wins. Scoped by user_id because this runs as the
      // service role (ARCHITECTURE.md §24). Never fatal.
      const { data: deleted, error: expireError } = await admin
        .from("ai_conversation_modes")
        .delete()
        .eq("id", modeOverride.id)
        .eq("user_id", request.user_id)
        .eq("expires_at", modeOverride.expires_at)
        .select("id");
      if (expireError) {
        console.error("[ai-agent-reply] expired override cleanup failed:", expireError.message);
      } else if (!deleted?.length) {
        const { data: replaced, error: replacedError } = await admin
          .from("ai_conversation_modes")
          .select("mode, expires_at")
          .eq("user_id", request.user_id)
          .eq("platform", request.platform)
          .eq("conversation_id", request.conversation_id)
          .maybeSingle();
        if (replacedError) throw replacedError;
        overrideMode = activeOverrideMode(replaced, Date.now());
      }
    }
    const mode = resolveEngagementMode(overrideMode, config.default_mode);
```

Import `activeOverrideMode` from `../_shared/conversationModeOverride.ts`. In `toolContext` (~line 843) add:

```ts
      defaultMode: config.default_mode ?? null,
      escalationTimeoutMinutes: config.escalation_timeout_minutes ?? null,
```

(`loadAgentConfigForAccount` selects `*`, so the new column arrives without changes there.)

- [ ] **Step 4: `outage-floor.ts`** — the escalation call becomes `escalateConversation({ ...target, muteRegardless: true }, "All configured AI models failed", Date.now() + ESCALATION_BUDGET_MS)`. Update the doc comment: the mute is now bounded by the timeout, and the apology suppression holds for the window.

- [ ] **Step 5: `process-pending-replies/index.ts`**

`loadContext`: select `"mode, expires_at"`, destructure both errors and throw them (the claim loop's catch at ~line 385 logs and keeps the row for the next tick):

```ts
  const [{ data: modeRow, error: modeError }, { count: newer, error: newerError }] = await Promise.all([...]);
  if (modeError) throw new Error(`mode read failed: ${modeError.message}`);
  if (newerError) throw new Error(`newer-message read failed: ${newerError.message}`);
  return {
    humanTookOver: activeOverrideMode(modeRow, Date.now()) === "human_first",
    ...
```

`AgentConfigForEscalation` gains `default_mode: string | null; escalation_timeout_minutes: number | null;`. `loadAgentConfig` selects `"admin_phone_numbers, default_mode, escalation_timeout_minutes"` scoped by `.eq("user_id", row.user_id).eq("social_account_id", row.social_account_id)`, and throws on `error` (a hand-off must not run on guessed settings). `handToHuman`'s target adds `defaultMode: config.default_mode, escalationTimeoutMinutes: config.escalation_timeout_minutes, muteRegardless: true`. Import `activeOverrideMode` from `../_shared/conversationModeOverride.ts`.

- [ ] **Step 6: `messaging-api/index.ts` conversation modes**

`ai_get_conversation_mode`: `return jsonResponse({ mode: data && activeOverrideMode(data, Date.now()) !== null ? data : null });`
`ai_set_conversation_mode`: add `expires_at: null` to the upsert payload (a manual choice clears an escalation's expiry).
`ai_list_conversation_modes`: `const now = Date.now(); return jsonResponse({ modes: (data || []).filter((row) => activeOverrideMode(row, now) !== null) });`

- [ ] **Step 7: `messaging-api/index.ts` `ai_upsert_config`** — add `"escalation_timeout_minutes"` to `allowedFields` and, beside the other integer checks in that handler, `if ("escalation_timeout_minutes" in updates && (!Number.isInteger(updates.escalation_timeout_minutes) || Number(updates.escalation_timeout_minutes) < 1 || Number(updates.escalation_timeout_minutes) > MAX_ESCALATION_TIMEOUT_MINUTES)) return jsonResponse({ error: "escalation_timeout_minutes must be an integer between 1 and 10080" }, 400);`. Read the handler first: mirror exactly how it validates `daily_message_cap`.

- [ ] **Step 8: `partner-api/v1/conversationModes.ts`**

```ts
interface ModeRow { mode: string; updated_at: string | null; expires_at?: string | null; }
const MODE_COLUMNS = "mode, updated_at, expires_at";
```

Response builder: `mode: row && activeOverrideMode(row, Date.now()) !== null ? row.mode : null`, plus `expires_at: row?.expires_at ?? null`. The upsert adds `expires_at: null`.

- [ ] **Step 9: `_shared/agentConfigOps.ts`** — add `"escalation_timeout_minutes"` to `CONFIG_FIELDS` and:

```ts
  if ("escalation_timeout_minutes" in updates) {
    const minutes = updates.escalation_timeout_minutes;
    if (!Number.isInteger(minutes) || Number(minutes) < 1 || Number(minutes) > MAX_ESCALATION_TIMEOUT_MINUTES) {
      invalid(`escalation_timeout_minutes must be an integer between 1 and ${MAX_ESCALATION_TIMEOUT_MINUTES}`);
    }
  }
```

- [ ] **Step 10: Gates** — from `supabase/functions`: `deno check ai-agent-reply/index.ts ai-agent-reply/tools.ts ai-agent-reply/outage-floor.ts process-pending-replies/index.ts messaging-api/index.ts partner-api/index.ts _shared/agentConfigOps.ts` clean; `deno test --allow-env --allow-net --allow-read ai-agent-reply/tools.test.ts ai-agent-reply/outage-floor.test.ts process-pending-replies/ _shared/agentConfigOps.test.ts _shared/agentConfigLookup.test.ts partner-api/` green. Existing `tools.test.ts` fakes may need `expires_at`, `.select()` after `.update()`/`.delete()`, and `.eq` on the new columns; extend the fake minimally, never weaken an assertion.

- [ ] **Step 11: Commit** (orchestrator): `git commit -m "feat(agent): escalation writes a bounded override; every reader honours expiry"`

---

### Task 4: Frontend — timeout control, badge, release

**Files:**
- Modify: `src/integrations/supabase/types.ts` (`ai_conversation_modes` Row/Insert/Update ~line 474; `ai_agent_configs` Row/Insert/Update ~line 300)
- Modify: `src/hooks/useAiAgentConfig.ts` (type ~line 29, `CONFIG_FIELDS` ~line 40)
- Modify: `src/components/messaging/AiAgentManager.tsx` (`defaultConfig` ~line 28, `toFormValues` ~line 42)
- Modify: `src/components/messaging/agent-settings/AgentIdentityCard.tsx`
- Modify: `src/hooks/useAiConversationMode.ts`
- Modify: `src/components/messaging/AiConversationModeSelect.tsx`

**Interfaces:**
- Consumes: messaging-api returns `expires_at` on mode rows and accepts `escalation_timeout_minutes` (Task 3). The UI treats a missing `expires_at` as null.

- [ ] **Step 1: Types and plumbing**

`types.ts`: add `expires_at: string | null` (Row) and `expires_at?: string | null` (Insert, Update) to `ai_conversation_modes`; add `escalation_timeout_minutes: number` (Row) and `escalation_timeout_minutes?: number` (Insert, Update) to `ai_agent_configs`.
`useAiAgentConfig.ts`: `escalation_timeout_minutes: number;` on `AiAgentConfig`; add `"escalation_timeout_minutes"` to `CONFIG_FIELDS`.
`AiAgentManager.tsx`: `escalation_timeout_minutes: 240` in `defaultConfig` (and in its `Required<Pick<...>>` list); `escalation_timeout_minutes: config.escalation_timeout_minutes ?? 240` in `toFormValues`.
`useAiConversationMode.ts`: `expires_at?: string | null;` on `AiConversationMode`; `refetchInterval: 60_000` on the query.

- [ ] **Step 2: `AgentIdentityCard.tsx` — the timeout control**

Directly after the engagement-mode `<p>` description, inside the same `space-y-2` div:

```tsx
{selectedMode !== "human_first" && (
  <EscalationTimeoutField
    minutes={form.escalation_timeout_minutes ?? 240}
    onChange={(minutes) => update("escalation_timeout_minutes", minutes)}
  />
)}
```

Add in the same file (it is only used here):

```tsx
const ESCALATION_TIMEOUT_TOOLTIP =
  "How long an escalated conversation stays with your team before the override expires and the account default applies again, so the AI can resume answering new messages.";
const ESCALATION_TIMEOUT_HELP =
  "When the assistant hands a conversation to your team, this timeout keeps it from staying muted for ever. After it expires the account default applies again to new messages; a message that arrived while the conversation was muted is not answered retroactively.";
const MAX_ESCALATION_TIMEOUT_MINUTES = 10080;

type TimeoutUnit = "minutes" | "hours";

/** Shown value for the stored minutes: hours as a decimal so 90 minutes reads 1.5, not 2. */
function displayValue(minutes: number, unit: TimeoutUnit): number {
  return unit === "hours" ? Math.round((minutes / 60) * 100) / 100 : minutes;
}

function EscalationTimeoutField({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  // The stored value is always whole minutes; the unit is display state.
  // Switching the unit never changes the stored value (debate finding 15).
  const [unit, setUnit] = useState<TimeoutUnit>(minutes >= 60 && minutes % 60 === 0 ? "hours" : "minutes");
  const max = unit === "hours" ? MAX_ESCALATION_TIMEOUT_MINUTES / 60 : MAX_ESCALATION_TIMEOUT_MINUTES;
  const commit = (typed: number) => {
    const asMinutes = unit === "hours" ? typed * 60 : typed;
    onChange(Math.min(MAX_ESCALATION_TIMEOUT_MINUTES, Math.max(1, Math.round(asMinutes))));
  };
  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center gap-1.5">
        <Label htmlFor="escalation-timeout">Escalation fallback timeout</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="What the escalation timeout does" className="text-muted-foreground">
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{ESCALATION_TIMEOUT_TOOLTIP}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex gap-2">
        <Input
          id="escalation-timeout"
          type="number"
          min={unit === "hours" ? 1 / 60 : 1}
          max={max}
          step="any"
          className="w-28"
          value={displayValue(minutes, unit)}
          onChange={(event) => commit(Number(event.target.value) || 0)}
        />
        <Select value={unit} onValueChange={(value) => setUnit(value as TimeoutUnit)}>
          <SelectTrigger className="w-28" aria-label="Timeout unit"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">Minutes</SelectItem>
            <SelectItem value="hours">Hours</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-sm text-muted-foreground">{ESCALATION_TIMEOUT_HELP}</p>
    </div>
  );
}
```

Imports to add: `useState` from react; `HelpCircle` from lucide-react; `Input` from `@/components/ui/input`; `Tooltip, TooltipContent, TooltipProvider, TooltipTrigger` from `@/components/ui/tooltip`.

- [ ] **Step 3: `AiConversationModeSelect.tsx` — badge and Release override**

Wrap the existing `<Select>` in `<div className="flex items-center gap-2">` and add, when `mode?.expires_at` is set (escalation provenance; a manual override never sets it):

```tsx
<Badge
  variant="secondary"
  className="gap-1 text-xs"
  title={`Human window until ${new Date(mode.expires_at).toLocaleString()}`}
>
  <UserRound className="h-3 w-3" />
  {`Escalated to human · until ${new Date(mode.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
</Badge>
<Button
  type="button" size="sm" variant="outline" className="h-8 text-xs"
  disabled={setConversationMode.isPending}
  onClick={() => setConversationMode.mutate("default", {
    onSuccess: () => toast.success("Override cleared. The account default applies again."),
    onError: (error) => toast.error(error.message || "Could not clear the override"),
  })}
>
  Release override
</Button>
```

Imports: `Badge` from `@/components/ui/badge`, `Button` from `@/components/ui/button`, `UserRound` from lucide-react. The `Select` keeps its behaviour and its `aria-label`.

- [ ] **Step 4: Gates** — `bun run typecheck`; `bunx eslint` on the six files; `npx vitest run src/components/messaging src/hooks src/features/whatsapp-inbox` (the WhatsApp inbox test mocks `AiConversationModeSelect`; it must still pass).

- [ ] **Step 5: Commit** (orchestrator): `git commit -m "feat(agent): escalation timeout setting, escalation badge and one-click release"`

---

### Task 5: Tests (Tests lane — agy Gemini 3.8 high)

**Files:**
- Extend: `supabase/functions/ai-agent-reply/tools.test.ts`
- Extend: `supabase/functions/ai-agent-reply/outage-floor.test.ts`
- Extend: `supabase/functions/_shared/agentConfigOps.test.ts`
- Create: `src/components/messaging/__tests__/AiConversationModeSelect.test.tsx`
- Create: `src/components/messaging/__tests__/AgentIdentityCard.timeout.test.tsx`

Each test must name the bug it catches. Mock only the messaging-api boundary (`callMessagingApi`) and `useAuth`; construct real props. Follow `src/components/messaging/__tests__/AiAgentManager.test.tsx` for the mocking pattern and the project's convention that `userEvent` is unusable (use `fireEvent`; Radix selects need `mousedown`).

- [ ] **Step 1: `tools.test.ts`** — using the existing `escalationTarget(db.admin)` fixture and fake DB:
  - "escalation under human_then_ai with an online agent tightens to human_first with an expiry" → target `defaultMode: "human_then_ai", escalationTimeoutMinutes: 30` → stored row `mode === "human_first"`, `expires_at` ≈ now + 30 min, `outcome.mode === "human_first"`.
  - "escalation under human_then_ai with nobody online leaves the assistant answering" → every fake agent `status: "offline"` → stored `mode === "human_then_ai"`, `expires_at` set, `outcome.assigned === false`, `outcome.mode === "human_then_ai"`.
  - "escalation under ai_first mutes for the window" → `defaultMode: "ai_first"`, offline agents → `human_first` with expiry.
  - "muteRegardless mutes even under human_then_ai" → `muteRegardless: true`, offline agents → `human_first`.
  - "a tightening that finds the row changed reports the row's mode, not its own" → make the fake's conditional update return no row and the re-read return `{ mode: "ai_first" }` → `outcome.mode === "ai_first"`.
  - "a failed tightening is logged and the outcome still returns" → fake update throws → resolves, `outcome.mode === "human_then_ai"`.
  - The existing failure-path tests (`AI ${fail} failure is surfaced without claiming assignment or losing the mute`) must keep passing; the first row now also carries `expires_at`.

- [ ] **Step 2: `outage-floor.test.ts`** — "the outage floor mutes regardless of the account default": target with `defaultMode: "human_then_ai"` and offline agents → the stored row is `human_first` with an expiry, so a second inbound during the window does not produce a second apology (assert the escalation was called with `muteRegardless: true` and that the row mode is `human_first`).

- [ ] **Step 3: `agentConfigOps.test.ts`** — "escalation_timeout_minutes outside 1..10080 is refused, inside is stored": `updateAgentConfig` with `{ escalation_timeout_minutes: 0 }` → invalid; `{ escalation_timeout_minutes: 10081 }` → invalid; `{ escalation_timeout_minutes: 90 }` → the fake's update payload contains 90.

- [ ] **Step 4: `AiConversationModeSelect.test.tsx`**
  - "shows the escalation badge and a Release override button while an escalation override is active" — mock `callMessagingApi` so `ai_get_conversation_mode` returns `{ mode: { mode: "human_first", expires_at: "2099-01-01T10:00:00Z", ... } }`; expect text `/Escalated to human/` and a button `Release override`.
  - "a manual override without an expiry shows no badge" — `{ mode: { mode: "human_first", expires_at: null } }` → no badge, no button, the select still shows Human first.
  - "Release override sends the default mode" — click; expect `callMessagingApi` called with `"ai_set_conversation_mode"` and `{ platform: "whatsapp", conversation_id: "c1", mode: "default" }`.

- [ ] **Step 5: `AgentIdentityCard.timeout.test.tsx`**
  - "the timeout control is hidden for human_first and shown for the other modes".
  - "hours are stored as minutes" — `escalation_timeout_minutes: 240` → input shows `4` in Hours; change the input to `2` → `update("escalation_timeout_minutes", 120)`.
  - "switching the unit never changes the stored value" — for 1, 30 and 90 minutes: open in Minutes, switch to Hours → `update` not called; input shows `0.02`, `0.5`, `1.5`.

- [ ] **Step 6: Run** — `deno test --allow-env --allow-net --allow-read _shared/conversationModeOverride.test.ts ai-agent-reply/tools.test.ts ai-agent-reply/outage-floor.test.ts _shared/agentConfigOps.test.ts` and `npx vitest run src/components/messaging/__tests__/AiConversationModeSelect.test.tsx src/components/messaging/__tests__/AgentIdentityCard.timeout.test.tsx`. All green. Then the orchestrator runs `test-guard`.

- [ ] **Step 7: Commit** (orchestrator): `git commit -m "test(agent): escalation expiry, bounded mute, timeout control and release button"`

---

## Release (orchestrator only; not a delegated task)

1. Rehearse `20260913120000_escalation_ttl.sql` on `rehearsal_ttl`; apply on the live database as `supabase_admin`; confirm both columns and the constraint exist and PostgREST answers `select escalation_timeout_minutes from ai_agent_configs limit 1` through `/rest/v1`.
2. List the remaining `human_first` rows with `expires_at is null` per account and hand them to the user for a decision (finding 7).
3. Push, open the PR against `main`, request `@codex review`, merge on the threshold.
4. Confirm the schedule synced the functions (`Deploy successful` on the merge SHA) and the frontend rebuilt.
5. Live acceptance on the Danat WhatsApp account (finding 16): set the timeout to 2 minutes and save; read it back; send a message from the test phone that makes the assistant escalate (nobody online) → the row is `human_then_ai` with `expires_at`; then set the human agent online, escalate again → `human_first` with `expires_at`; wait past expiry; send another message → the assistant replies and the row is gone. Restore the timeout afterwards.
