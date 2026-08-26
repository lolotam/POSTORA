# AI Agent Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI agent a delivery floor when every model fails, make its schema reproducible from `supabase/migrations/`, and replace per-user model choice with one global three-slot admin control.

**Architecture:** Phase 1 adds a typed exhaustion error to `ai-agent-reply` and a last-resort path in its outer catch that apologises to the customer and escalates to a human without needing a working model. Phase 2 copies two `manual-sql` objects into real migrations. Phase 3 moves model selection out of `ai_agent_configs` and into three global `system_settings` rows written by a restructured admin page, reusing the Chat Models components verbatim.

**Tech Stack:** Deno edge functions (Supabase self-hosted), React 18 + TypeScript + Vite, TanStack Query v5, shadcn/ui, Vitest, Deno test, PostgreSQL 15.

**Spec:** `docs/superpowers/specs/2026-08-27-agent-model-selection-design.md`

## Global Constraints

- Never drop `ai_agent_allowed_models`, `ai_agent_configs.fallback_model_1`, or `ai_agent_configs.fallback_model_2` from the database. Phase 3 stops reading them; the objects stay.
- Do not modify the n8n API, the partner API, cron jobs, content-generation functions, or webhooks unrelated to message delivery.
- Do not change `persona_instructions`, `business_profile_text`, knowledge-retrieval scoping, or the DM/comment split via `SURFACE_INSTRUCTIONS`.
- Never run `npx supabase functions deploy` — it targets Supabase Cloud and fails against this self-hosted stack. Use the volume-copy procedure in `docs/runbooks/deploy-edge-function.md`.
- Before any edge-function deploy, diff the deployed file against the repo copy. The functions volume has drifted from the repo before (the `refresh-tokens` server-only hotfix) and a blind copy regresses it.
- Branch: `feat/agent-model-selection`. Commit scoped to each task's files: `git commit -m "..." -- <files>`. Never commit `b64.txt`, logs, backups, `.env*`, or any secret file.
- Gate commands, run from the repo root: `bun run lint`, `bun run typecheck`, `bun run test`. Edge-function unit tests: `deno test --allow-none supabase/functions/ai-agent-reply/tools.test.ts`.
- `supabase/functions/ai-agent-reply/logic.ts` is pure — no Deno or network imports. It is unit-tested from Vitest at `src/lib/__tests__/aiAgentReplyLogic.test.ts`, which imports it by relative path.
- The admin-facing provider list for the agent is exactly `openai`, `openrouter`, `gemini`. A provider without an entry in `PROVIDER_ENDPOINTS` must never appear.
- New `system_settings` keys are exactly `default_ai_model_agent`, `default_ai_model_agent_fallback`, `default_ai_model_agent_fallback_2`.
- New `ai_agent_logs.status` value is exactly `escalated_after_model_exhaustion`.

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `supabase/functions/ai-agent-reply/logic.ts` | Pure decisions. Gains `ModelChainExhaustedError` and the apology strings. | 1 |
| `src/lib/__tests__/aiAgentReplyLogic.test.ts` | Vitest cover for the above. | 1 |
| `supabase/functions/ai-agent-reply/tools.ts` | Tool executors. `escalateConversation` extracted so the floor can escalate without a model. | 1 |
| `supabase/functions/ai-agent-reply/tools.test.ts` | Deno cover for the extraction. | 1 |
| `supabase/functions/ai-agent-reply/index.ts` | Request pipeline. Hoists, typed throw, the floor, and later the global chain read. | 1, 3 |
| `supabase/migrations/20260827100000_ai_agent_allowed_models.sql` | Allow-list table, reproducible. | 2 |
| `supabase/migrations/20260827100100_ai_agent_fallback_models.sql` | The two fallback columns, reproducible. | 2 |
| `docs/records/2026-08-27-ai-agent-config-models-snapshot.csv` | Pre-cutover record of per-user choices. | 3 |
| `src/hooks/ai-config/types.ts` | `ModelCategory` and the three category maps gain `agent`. | 3 |
| `src/hooks/useAIConfiguration.ts` | `MODEL_CATEGORIES` and the two empty maps gain `agent`. | 3 |
| `src/hooks/__tests__/useAIConfiguration.test.ts` | Vitest cover for `parseSettingsRows` routing the new keys. | 3 |
| `src/components/admin/DefaultModelSelector.tsx` | `CATEGORY_MODALITY` and `CATEGORY_LAST_RESORT` gain `agent`. | 3 |
| `src/components/admin/AdminAiAgentSection.tsx` | Catalog CRUD out, three-slot selector in. | 3 |
| `src/components/messaging/AiAgentManager.tsx` | Per-user model pickers out. | 3 |
| `src/components/messaging/__tests__/AiAgentManager.test.tsx` | Two model tests rewritten. | 3 |
| `src/hooks/useAllowedAiAgentModels.ts` | Deleted — last caller removed. | 3 |

---

# Phase 1 — a delivery floor under the model chain

### Task 1: Exhaustion error and apology strings

**Files:**
- Modify: `supabase/functions/ai-agent-reply/logic.ts`
- Test: `src/lib/__tests__/aiAgentReplyLogic.test.ts`

**Interfaces:**
- Consumes: `ReplyLanguage` (`"ar" | "en"`), already exported from `logic.ts:5`.
- Produces: `class ModelChainExhaustedError extends Error` and `modelOutageApology(language: ReplyLanguage): string`. Task 3 imports both.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/aiAgentReplyLogic.test.ts`:

```ts
describe("ModelChainExhaustedError", () => {
  it("is distinguishable from a plain Error", () => {
    const exhausted = new ModelChainExhaustedError("everything failed");
    expect(exhausted).toBeInstanceOf(ModelChainExhaustedError);
    expect(exhausted).toBeInstanceOf(Error);
    expect(exhausted.message).toBe("everything failed");
    expect(new Error("everything failed")).not.toBeInstanceOf(ModelChainExhaustedError);
  });

  it("carries a default message when none is given", () => {
    expect(new ModelChainExhaustedError().message).toBe("All AI models failed");
  });
});

describe("modelOutageApology", () => {
  it("returns Arabic for an Arabic conversation", () => {
    expect(modelOutageApology("ar")).toMatch(/[؀-ۿ]/);
  });

  it("returns English for an English conversation", () => {
    expect(modelOutageApology("en")).toMatch(/^[\x20-\x7E]+$/);
  });

  it("never returns an empty string", () => {
    for (const language of ["ar", "en"] as const) {
      expect(modelOutageApology(language).trim().length).toBeGreaterThan(0);
    }
  });
});
```

Add `ModelChainExhaustedError` and `modelOutageApology` to the existing import block at the top of that file (it already imports from `"../../../supabase/functions/ai-agent-reply/logic"`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/lib/__tests__/aiAgentReplyLogic.test.ts`
Expected: FAIL — `ModelChainExhaustedError is not defined` / `modelOutageApology is not a function`.

- [ ] **Step 3: Implement**

Append to `supabase/functions/ai-agent-reply/logic.ts`, after `formatModelRef`:

```ts
/**
 * Thrown when every model in the chain failed. The outer catch in index.ts is
 * shared with database, send, and validation errors; only this class means "no
 * model could answer", which is the one case that escalates to a human.
 */
export class ModelChainExhaustedError extends Error {
  constructor(message = "All AI models failed") {
    super(message);
    this.name = "ModelChainExhaustedError";
  }
}

// Sent verbatim when no model could answer, so it must not depend on a model.
// Language is resolved by detectReplyLanguage, the same path that decides a
// normal reply's language -- a fixed English string here would answer an Arabic
// customer in English, the bug closed by commits 7f599cca and 0065633c.
const MODEL_OUTAGE_APOLOGY: Record<ReplyLanguage, string> = {
  en: "Sorry — I can't answer right now. Someone from our team has been notified and will get back to you shortly.",
  ar: "عذرًا، لا أستطيع الرد في الوقت الحالي. تم إبلاغ أحد أفراد فريقنا وسيتواصل معك قريبًا.",
};

export function modelOutageApology(language: ReplyLanguage): string {
  return MODEL_OUTAGE_APOLOGY[language];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- src/lib/__tests__/aiAgentReplyLogic.test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai-agent): a typed error and a static apology for total model failure" -- \
  supabase/functions/ai-agent-reply/logic.ts \
  src/lib/__tests__/aiAgentReplyLogic.test.ts
```

---

### Task 2: Extract `escalateConversation` from the escalation tool

**Files:**
- Modify: `supabase/functions/ai-agent-reply/tools.ts:116-196`
- Test: `supabase/functions/ai-agent-reply/tools.test.ts`

**Interfaces:**
- Consumes: `pickEscalationAgent` and `waRecipient` from `logic.ts` (already imported at `tools.ts:3`).
- Produces:
  ```ts
  export interface EscalationTarget {
    admin: any;
    userId: string;
    platform: string;
    conversationId: string;
    customerName: string;
    adminPhoneNumbers: string[];
    sendWhatsAppText: (recipientPhone: string, text: string) => Promise<void>;
  }
  export interface EscalationOutcome {
    assigned: boolean;
    assignmentNote: string;
    adminsNotified: number;
  }
  export function escalateConversation(target: EscalationTarget, reason: string): Promise<EscalationOutcome>;
  ```
  `ToolContext` already has every field of `EscalationTarget`, so it satisfies the type structurally and needs no adapter. Task 3 imports `escalateConversation` and `EscalationTarget`.

- [ ] **Step 1: Write the failing test**

Append to `supabase/functions/ai-agent-reply/tools.test.ts`:

```ts
// The floor in index.ts escalates without going through the model, so the
// escalation body has to be callable on its own. This test pins that contract:
// the conversation is muted for the AI first, because that mute is what stops a
// second apology going out on the customer's next message.
Deno.test("escalateConversation mutes the conversation before anything else", async () => {
  const calls: string[] = [];
  const admin = {
    from(table: string) {
      calls.push(table);
      return {
        upsert: () => Promise.resolve({ error: null }),
        select: () => ({
          eq: () => ({ is: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
          then: (resolve: (v: unknown) => void) => resolve({ data: [] }),
        }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
  };

  const outcome = await escalateConversation({
    admin,
    userId: "00000000-0000-0000-0000-000000000001",
    platform: "instagram",
    conversationId: "ig-conversation",
    customerName: "Test customer",
    adminPhoneNumbers: [],
    sendWhatsAppText: () => Promise.resolve(),
  }, "All configured AI models failed");

  assertEquals(calls[0], "ai_conversation_modes");
  assertEquals(outcome.assigned, false);
  assertEquals(outcome.adminsNotified, 0);
});

Deno.test("escalateConversation notifies every configured admin number", async () => {
  const notified: string[] = [];
  const admin = {
    from() {
      return {
        upsert: () => Promise.resolve({ error: null }),
        select: () => ({
          eq: () => ({ is: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
          then: (resolve: (v: unknown) => void) => resolve({ data: [] }),
        }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
  };

  const outcome = await escalateConversation({
    admin,
    userId: "00000000-0000-0000-0000-000000000001",
    platform: "whatsapp",
    conversationId: "wa-conversation",
    customerName: "Test customer",
    adminPhoneNumbers: ["+96500000001", "+96500000002"],
    sendWhatsAppText: (recipient) => { notified.push(recipient); return Promise.resolve(); },
  }, "All configured AI models failed");

  assertEquals(notified, ["96500000001", "96500000002"]);
  assertEquals(outcome.adminsNotified, 2);
});
```

Add `escalateConversation` to the import from `"./tools.ts"` at the top of that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-none supabase/functions/ai-agent-reply/tools.test.ts`
Expected: FAIL — `escalateConversation` is not exported by `./tools.ts`.

- [ ] **Step 3: Implement the extraction**

In `supabase/functions/ai-agent-reply/tools.ts`, add the two interfaces above `escalateToHuman`, move the body of `escalateToHuman` (currently `tools.ts:125-193`, everything after the `dryRun` early return) into a new exported function, and leave `escalateToHuman` as the tool-facing wrapper:

```ts
/**
 * Everything an escalation needs, with no dependency on a model having run.
 * ToolContext satisfies this structurally, so escalateToHuman passes itself.
 */
export interface EscalationTarget {
  admin: any;
  userId: string;
  platform: string;
  conversationId: string;
  customerName: string;
  adminPhoneNumbers: string[];
  sendWhatsAppText: (recipientPhone: string, text: string) => Promise<void>;
}

export interface EscalationOutcome {
  assigned: boolean;
  assignmentNote: string;
  adminsNotified: number;
}

/**
 * Hands a conversation to a human. Callable from the escalate_to_human tool and
 * from index.ts's model-outage floor, which has no working model to call a tool
 * with.
 *
 * The mode upsert comes first deliberately: it is platform-agnostic and it is
 * what silences the AI for this conversation from the next inbound message on.
 * The assignment tables below it are WhatsApp-shaped, so on other platforms the
 * mode flip plus the admin notification is the whole of the handoff.
 */
export async function escalateConversation(
  target: EscalationTarget,
  reason: string,
): Promise<EscalationOutcome> {
  const { error: modeError } = await target.admin
    .from("ai_conversation_modes")
    .upsert(
      {
        user_id: target.userId,
        platform: target.platform,
        conversation_id: target.conversationId,
        mode: "human_first",
      },
      { onConflict: "user_id,platform,conversation_id" },
    );
  if (modeError) throw modeError;

  const { data: agents } = await target.admin
    .from("whatsapp_agents")
    .select("id, user_id, status, current_conversations");
  const agent = pickEscalationAgent(agents || [], target.userId);
  let assignmentNote = "No human agent is online right now; the conversation is queued for the team.";

  if (agent) {
    const { data: existing } = await target.admin
      .from("whatsapp_conversation_assignments")
      .select("id, agent_id")
      .eq("conversation_id", target.conversationId)
      .is("unassigned_at", null)
      .maybeSingle();

    if (existing) {
      await target.admin
        .from("whatsapp_conversation_assignments")
        .update({ unassigned_at: new Date().toISOString() })
        .eq("id", existing.id);
    }

    const { error: assignError } = await target.admin
      .from("whatsapp_conversation_assignments")
      .insert({
        conversation_id: target.conversationId,
        agent_id: agent.id,
        assigned_by: target.userId,
        notes: `AI escalation: ${reason}`.slice(0, 500),
      });
    if (assignError) throw assignError;

    await target.admin.from("whatsapp_assignment_history").insert({
      conversation_id: target.conversationId,
      action: existing ? "transferred" : "assigned",
      from_agent_id: existing?.agent_id || null,
      to_agent_id: agent.id,
      performed_by: target.userId,
      reason: `AI escalation: ${reason}`.slice(0, 500),
    });
    assignmentNote = "An online team member has been assigned to this conversation.";
  }

  let adminsNotified = 0;
  for (const phone of target.adminPhoneNumbers) {
    try {
      await target.sendWhatsAppText(
        waRecipient(phone),
        `🤖 AI agent escalation\nCustomer: ${target.customerName}\nReason: ${reason}\n${assignmentNote}`,
      );
      adminsNotified++;
    } catch (error) {
      console.error(
        `[ai-agent-reply] Admin notification to ${phone} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  console.log(
    `[ai-agent-reply] Escalated conversation (agent: ${agent?.id || "none"}, admins notified: ${adminsNotified})`,
  );

  return { assigned: Boolean(agent), assignmentNote, adminsNotified };
}

async function escalateToHuman(context: ToolContext, reason: string): Promise<ToolResult> {
  if (context.dryRun) {
    return {
      output:
        "(test mode — no side effects) Escalation would be recorded, an online agent assigned, and admins notified. Tell the customer a team member will follow up.",
      escalated: true,
    };
  }

  const { assignmentNote } = await escalateConversation(context, reason);

  return {
    output:
      `Escalation recorded. ${assignmentNote} Tell the customer briefly that a team member will follow up.`,
    escalated: true,
  };
}
```

The old `notifyAdmins` helper (`tools.ts:100-114`) is now used only by `notifyAdmin` at `tools.ts:196`. Leave it in place; the loop above is inlined into `escalateConversation` because it must count successes for `EscalationOutcome`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-none supabase/functions/ai-agent-reply/tools.test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(ai-agent): escalation no longer requires a working model" -- \
  supabase/functions/ai-agent-reply/tools.ts \
  supabase/functions/ai-agent-reply/tools.test.ts
```

---

### Task 3: The floor itself

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts` — imports, `:508`, `:523`, `:542`, `:615`, `:748-760`

**Interfaces:**
- Consumes: `ModelChainExhaustedError`, `modelOutageApology` (Task 1); `escalateConversation`, `EscalationTarget` (Task 2); the existing `TextSender` type and `errorMessage` helper in this file.
- Produces: `ai_agent_logs.status = "escalated_after_model_exhaustion"`. Nothing downstream imports from this file.

- [ ] **Step 1: Extend the imports**

In `supabase/functions/ai-agent-reply/index.ts`, add `ModelChainExhaustedError`, `modelOutageApology` and the `ReplyLanguage` type to the existing import from `"./logic.ts"`, and add `escalateConversation` plus the `EscalationTarget` type to the existing import from `"./tools.ts"`.

- [ ] **Step 2: Hoist the four values the catch needs**

Add `ModelRef` to the type import from `"./logic.ts"`. Immediately after `let usedFallbackLevel = 0;` (`index.ts:387`), add:

```ts
// Hoisted out of the try below so the model-outage floor in the catch can reach
// them. A value declared inside the try is invisible to its own catch.
let replySender: TextSender | null = null;
let language: ReplyLanguage = "en";
let escalationTarget: EscalationTarget | null = null;
let modelChain: ModelRef[] = [];
```

Then change the four assignment sites inside the try from declarations to plain assignments:

- `index.ts:508` — `const language = detectReplyLanguage(` becomes `language = detectReplyLanguage(`.
- `index.ts:523` — `const replySender = dryRun ? null : await buildReplySender(admin, request);` becomes `replySender = dryRun ? null : await buildReplySender(admin, request);`
- Immediately after the `const toolContext: ToolContext = { ... };` literal ends (`index.ts:542` onward), add `escalationTarget = toolContext;`
- `index.ts:590` — `const modelChain = (rawChain.length ? ...` becomes `modelChain = (rawChain.length ? ...`

The `buildSystemPrompt` call at `index.ts:511` uses the `language,` shorthand and is unaffected by the hoist. The existing reads of `modelChain` at `:591`, `:596`, `:604`, `:609` and `:661` are unaffected.

- [ ] **Step 3: Add the floor helper**

Add above the `serve(` handler in `index.ts`, next to the other module-level helpers:

```ts
/**
 * Last resort when every model in the chain failed. Without it the customer's
 * message is dropped in silence: the catch below returns HTTP 200 and all four
 * callers are fire-and-forget, so nothing downstream notices.
 *
 * Both steps swallow their own errors on purpose. This runs inside a catch, so
 * throwing here would replace a reported model outage with an unrelated error,
 * and a failed apology must not stop the human handoff.
 */
async function deliverModelOutageFloor(
  request: ReplyRequest,
  sender: TextSender | null,
  replyLanguage: ReplyLanguage,
  target: EscalationTarget | null,
): Promise<{ apology_sent: boolean; escalated: boolean }> {
  let apologySent = false;
  // A public comment gets no apology. "We're having trouble" posted under a
  // customer's comment is readable by everyone and reads worse than silence.
  if (!request.comment_id && sender) {
    try {
      await sender(request.recipient_phone, modelOutageApology(replyLanguage));
      apologySent = true;
    } catch (sendError) {
      console.error("[ai-agent-reply] Outage apology send failed:", errorMessage(sendError));
    }
  }

  let escalated = false;
  if (target) {
    try {
      await escalateConversation(target, "All configured AI models failed");
      escalated = true;
    } catch (escalationError) {
      console.error("[ai-agent-reply] Outage escalation failed:", errorMessage(escalationError));
    }
  }

  return { apology_sent: apologySent, escalated };
}
```

- [ ] **Step 4: Throw the typed error**

At `index.ts:615`, replace:

```ts
      if (!completion) throw lastError instanceof Error ? lastError : new Error("All AI models failed");
```

with:

```ts
      if (!completion) {
        // Typed so the catch can tell a total model outage apart from the
        // database, send, and validation errors that share it. Per-model detail
        // is already in modelErrors.
        throw new ModelChainExhaustedError(
          lastError instanceof Error ? lastError.message : "All AI models failed",
        );
      }
```

- [ ] **Step 5: Run the floor from the catch**

At `index.ts:748`, insert between the `console.error` line and the existing `await logOutcome(...)`:

```ts
    if (error instanceof ModelChainExhaustedError && !dryRun) {
      const floor = await deliverModelOutageFloor(request, replySender, language, escalationTarget);
      await logOutcome(admin, {
        ...baseLog,
        status: "escalated_after_model_exhaustion",
        error: errorMessage(error).slice(0, 500),
        latency_ms: Date.now() - startedAt,
      }, {
        used_model: usedModel,
        fallback_level: usedFallbackLevel,
        model_errors: modelErrors.length ? modelErrors : null,
        model_chain: modelChain.map(formatModelRef),
        ...floor,
      });
      return jsonResponse({ ok: false, error: errorMessage(error), escalated: floor.escalated });
    }
```

The existing `logOutcome` call and `return` below this block are unchanged — they still handle every non-exhaustion error and every dry run.

- [ ] **Step 6: Verify the file type-checks and the suites still pass**

Run: `bun run typecheck && bun run test && deno test --allow-none supabase/functions/ai-agent-reply/tools.test.ts`
Expected: all PASS. `bun run typecheck` covers `src/` only, so also run `deno check supabase/functions/ai-agent-reply/index.ts` and expect no errors.

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(ai-agent): a total model failure now reaches the customer and a human" -- \
  supabase/functions/ai-agent-reply/index.ts
```

- [ ] **Step 8: Deploy and verify against production**

Diff first, then copy, then restart:

```bash
# 1. Diff the deployed copy against the repo before overwriting anything.
#    Any difference that is not this task's change is a hotfix -- stop and ask.
```

Via `ssh-contabo-mcp`, for each of `index.ts`, `logic.ts`, `tools.ts`:
1. `sha256sum /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/ai-agent-reply/<file>` and compare against the pre-change repo copy.
2. Copy the new file into that directory.
3. `sha256sum` again and match the local hash.
4. From the stack directory: `docker compose up -d --no-deps functions`.

Then verify, per the spec's Phase 1 checklist:
- Point a **test** `ai_agent_configs` row (use the disabled `7fe4d34e` whatsapp row, re-enabled temporarily, or a sandbox row — do not touch the three live rows) at three dead model strings.
- Send an inbound WhatsApp message. Confirm: the apology arrives in the customer's language; `select mode from ai_conversation_modes where conversation_id = '...'` is `human_first`; `select status from ai_agent_logs order by created_at desc limit 1` is `escalated_after_model_exhaustion`.
- Repeat on **Instagram** for the `1122a2d5` instagram row using dead models, confirming the floor is not WhatsApp-only. Restore its real models afterwards.
- Trigger the comment path and confirm nothing was posted publicly while the log and mode still updated.
- Send one normal message and confirm a successful reply is unchanged.
- Open the agent logs view in the app and confirm the new status renders without breaking the list.

- [ ] **Step 9: Report Phase 1 and stop**

Report: files changed, the exact status string `escalated_after_model_exhaustion`, and the two-platform test evidence. **Wait for explicit go-ahead before Phase 2.**

---

# Phase 2 — migrations for the manual-sql objects

### Task 4: Both migrations

**Files:**
- Create: `supabase/migrations/20260827100000_ai_agent_allowed_models.sql`
- Create: `supabase/migrations/20260827100100_ai_agent_fallback_models.sql`

**Interfaces:**
- Consumes: `public.has_role(uuid, app_role)`, which exists in the base schema.
- Produces: `public.ai_agent_allowed_models` and `ai_agent_configs.fallback_model_1` / `fallback_model_2`, both already present in production. Nothing in code changes.

- [ ] **Step 1: Write the allow-list migration**

`supabase/migrations/20260827100000_ai_agent_allowed_models.sql`:

```sql
-- Reproduces supabase/manual-sql/20260712120000_ai_agent_allowed_models.sql so a
-- migrations-only replay produces the table. Without it, messaging-api's
-- ai_upsert_config fails at its allow-list query on any fresh environment.
--
-- The manual-sql original ends with a seed of three OpenAI models. That seed is
-- deliberately NOT reproduced: production's allow-list holds five rows and none
-- of them is an OpenAI model, so replaying the seed would re-insert models an
-- admin removed -- and would make "gpt-4o-mini" valid again, the exact string
-- behind the persona-loss bug fixed in 0642c878.

CREATE TABLE IF NOT EXISTS public.ai_agent_allowed_models (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    model_id text NOT NULL,
    label text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 100,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, model_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_allowed_models_active
    ON public.ai_agent_allowed_models (is_active, sort_order);

GRANT SELECT ON public.ai_agent_allowed_models TO authenticated;
GRANT ALL ON public.ai_agent_allowed_models TO service_role;

ALTER TABLE public.ai_agent_allowed_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_agent_allowed_models_read_active" ON public.ai_agent_allowed_models;
CREATE POLICY "ai_agent_allowed_models_read_active"
    ON public.ai_agent_allowed_models FOR SELECT
    TO authenticated
    USING (is_active = true OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "ai_agent_allowed_models_admin_all" ON public.ai_agent_allowed_models;
CREATE POLICY "ai_agent_allowed_models_admin_all"
    ON public.ai_agent_allowed_models FOR ALL
    TO authenticated
    USING (public.has_role(auth.uid(), 'admin'))
    WITH CHECK (public.has_role(auth.uid(), 'admin'));
```

- [ ] **Step 2: Write the fallback-columns migration**

`supabase/migrations/20260827100100_ai_agent_fallback_models.sql`:

```sql
-- Reproduces supabase/manual-sql/20260712120500_ai_agent_fallback_models.sql.
-- Nullable text, no default, no CHECK, no foreign key -- matching production
-- exactly. Phase 3 stops reading these columns but never drops them.

ALTER TABLE public.ai_agent_configs
    ADD COLUMN IF NOT EXISTS fallback_model_1 text,
    ADD COLUMN IF NOT EXISTS fallback_model_2 text;
```

- [ ] **Step 3: Verify a fresh replay produces the right shape**

`supabase start` is broken locally, so rehearse inside the production container against a throwaway database. Via `ssh-contabo-mcp`:

```
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -c "CREATE DATABASE migration_rehearsal;"
```

Replay the migrations directory into `migration_rehearsal`, then compare:

```
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d migration_rehearsal -c "\d public.ai_agent_allowed_models"
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c "\d public.ai_agent_allowed_models"
```

Expected: identical columns, identical `UNIQUE (provider, model_id)`, identical index, both policies present. `select count(*)` on the rehearsal table is `0` — no seed. Drop `migration_rehearsal` afterwards.

- [ ] **Step 4: Verify the no-op against production**

```
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c "select count(*) from ai_agent_allowed_models;"
```

Record the count (expected `5`). Run both migration files against `postgres`. Re-run the count and the two `\d` outputs.
Expected: no error, count still `5`, no column or policy difference.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(db): make the agent allow-list reproducible from migrations" -- \
  supabase/migrations/20260827100000_ai_agent_allowed_models.sql \
  supabase/migrations/20260827100100_ai_agent_fallback_models.sql
```

- [ ] **Step 6: Report Phase 2 and stop**

Report: both migration file names, the fresh-replay comparison, and the production no-op evidence including the before/after row count. **Wait for explicit go-ahead before Phase 3.**

---

# Phase 3 — one global three-slot control

### Task 5: Snapshot, then teach the config layer about `agent`

**Files:**
- Create: `docs/records/2026-08-27-ai-agent-config-models-snapshot.csv`
- Modify: `src/hooks/ai-config/types.ts:76` and the three category interfaces
- Modify: `src/hooks/useAIConfiguration.ts:23-26`
- Test: `src/hooks/__tests__/useAIConfiguration.test.ts`

**Interfaces:**
- Consumes: `parseSettingsRows` and `MODEL_CATEGORIES`, already in `useAIConfiguration.ts`.
- Produces: `ModelCategory` gains `'agent'`; `CategoryDefaults`, `CategoryFallbacks` and `CategoryFallbacks2` each gain `agent: DefaultModel | null`. Tasks 6 and 8 rely on these.

- [ ] **Step 1: Capture the snapshot first**

Via `ssh-contabo-mcp`, before any other step in this phase:

```
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres --csv \
  -c "select user_id, platform, model, fallback_model_1, fallback_model_2, is_enabled from ai_agent_configs order by user_id, platform;"
```

Save the output verbatim to `docs/records/2026-08-27-ai-agent-config-models-snapshot.csv` with a leading comment line:

```
# Per-user AI agent model choices captured 2026-08-27, immediately before the
# global three-slot cutover. For the record only -- no code reads this file.
```

Expected: four data rows, matching the table in the spec's §3f. If the row count differs, **stop and report** — the population changed since the design was approved.

- [ ] **Step 2: Write the failing test**

Create `src/hooks/__tests__/useAIConfiguration.test.ts` (or append if it exists):

```ts
import { describe, expect, it } from "vitest";
import { parseSettingsRows } from "@/hooks/useAIConfiguration";

describe("parseSettingsRows", () => {
  // The three agent slots reuse the Chat Models key shape so they inherit the
  // existing parser and mutations. Suffix order is the trap: "_fallback_2" ends
  // with "_fallback", so a naive match routes tier 2 into tier 1.
  it("routes the three agent slots to their own tiers", () => {
    const parsed = parseSettingsRows([
      { key: "default_ai_model_agent", value: { provider_code: "gemini", model_id: "gemini-2.5-flash" } },
      { key: "default_ai_model_agent_fallback", value: { provider_code: "openai", model_id: "gpt-4o-mini" } },
      { key: "default_ai_model_agent_fallback_2", value: { provider_code: "openrouter", model_id: "nvidia/nemotron-3.5-lightning:free" } },
    ]);

    expect(parsed.categoryDefaults.agent).toEqual({ provider_code: "gemini", model_id: "gemini-2.5-flash" });
    expect(parsed.categoryFallbacks.agent).toEqual({ provider_code: "openai", model_id: "gpt-4o-mini" });
    expect(parsed.categoryFallbacks2.agent).toEqual({
      provider_code: "openrouter",
      model_id: "nvidia/nemotron-3.5-lightning:free",
    });
  });

  it("leaves the agent tiers null when no row exists", () => {
    const parsed = parseSettingsRows([
      { key: "default_ai_model_chat", value: { provider_code: "openai", model_id: "gpt-4o" } },
    ]);
    expect(parsed.categoryDefaults.agent).toBeNull();
    expect(parsed.categoryFallbacks.agent).toBeNull();
    expect(parsed.categoryFallbacks2.agent).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test -- src/hooks/__tests__/useAIConfiguration.test.ts`
Expected: FAIL — `categoryDefaults.agent` is `undefined`, not the parsed object.

- [ ] **Step 4: Add `agent` to the type layer**

In `src/hooks/ai-config/types.ts`, change:

```ts
export type ModelCategory = 'chat' | 'image' | 'tts' | 'video' | 'search' | 'stt' | 'agent';
```

and add `agent: DefaultModel | null;` to each of `CategoryDefaults`, `CategoryFallbacks` and `CategoryFallbacks2`.

Update the `CategoryFallbacks2` doc comment, which currently says only `image` is consumed:

```ts
/**
 * Second fallback tier, tried after CategoryFallbacks.
 *
 * `image` is read by generate-image; `agent` is read by ai-agent-reply as the
 * last entry of the messaging agent's global model chain. The other four are
 * written by the admin UI and read by nothing, pending a resolver that wants them.
 */
```

In `src/hooks/useAIConfiguration.ts`, add `agent: null` to both `emptyCategoryDefaults` and `emptyCategoryFallbacks` (lines 23-24), and `'agent'` to `MODEL_CATEGORIES` (line 26).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test -- src/hooks/__tests__/useAIConfiguration.test.ts && bun run typecheck`
Expected: PASS. `typecheck` catches any other exhaustive switch over `ModelCategory` that now needs an `agent` arm — fix those by following the neighbouring `chat` arm.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(admin): add an agent tier to the model settings layer" -- \
  docs/records/2026-08-27-ai-agent-config-models-snapshot.csv \
  src/hooks/ai-config/types.ts \
  src/hooks/useAIConfiguration.ts \
  src/hooks/__tests__/useAIConfiguration.test.ts
```

---

### Task 6: Restructure the admin page

**Files:**
- Modify: `src/components/admin/DefaultModelSelector.tsx:25-36`
- Modify: `src/components/admin/AdminAiAgentSection.tsx` (whole component body)

**Interfaces:**
- Consumes: `ModelCategory` with `'agent'` (Task 5); `DefaultModelSelector` and its existing props; `useSetDefaultModel`, `useSetFallbackModel`, `useSetFallback2Model` from `useAIConfiguration`.
- Produces: the three `system_settings` rows. Task 7 reads them from the edge function.

- [ ] **Step 1: Add the `agent` entries to the selector's category maps**

In `src/components/admin/DefaultModelSelector.tsx`:

```ts
const CATEGORY_MODALITY: Record<string, string> = {
  chat: 'text', search: 'text', image: 'image', tts: 'audio', video: 'video', agent: 'text',
};

const CATEGORY_LAST_RESORT: Record<string, { provider: string; model: string } | null> = {
  chat: { provider: 'google', model: 'gemini-3-flash-preview' },
  image: { provider: 'google', model: 'gemini-2.5-flash-image' },
  tts: { provider: 'google', model: 'gemini-2.5-flash' },
  video: null,
  search: null,
  stt: null,
  // No last resort. ai-agent-reply's hardcoded gpt-4o-mini default is removed in
  // the same change; an unconfigured chain escalates to a human instead of
  // silently calling a model no admin chose.
  agent: null,
};
```

- [ ] **Step 2: Replace the catalog UI**

Rewrite `src/components/admin/AdminAiAgentSection.tsx` as a thin wrapper around `DefaultModelSelector`. Delete: `provider`/`modelId`/`label`/`orOpen`/`orSearch` state, `catalogModels`, `visibleOrModels`, `pickModel`, the `admin-ai-agent-allowed-models` query, `invalidate`, `addModel`, `toggleModel`, `deleteModel`, the add form, the model list, and every now-unused import (`useState`, `useMutation`, `useQuery`, `useQueryClient`, `supabase`, `toast`, `Input`, `Switch`, `Badge`, `Popover*`, `Command*`, `Check`, `ChevronsUpDown`, `Plus`, `Trash2`, `useOpenRouterModels`, `extractSeries`, `formatPrice`, `AllowedAiModel`, `Select*`, `Label`, `Button`).

The whole file becomes:

```tsx
import { useMemo } from "react";
import { Bot } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DefaultModelSelector } from "@/components/admin/DefaultModelSelector";
import {
  useAIConfiguration,
  useSetDefaultModel,
  useSetFallbackModel,
  useSetFallback2Model,
} from "@/hooks/useAIConfiguration";

// The reply engine can only call providers it holds an endpoint and API key for.
// Must stay in sync with PROVIDER_ENDPOINTS in
// supabase/functions/ai-agent-reply/index.ts. Offering anything else is not a
// cosmetic slip: parseModelRef rewrites an unknown provider prefix to "openai",
// so a Claude or Z AI model would be posted to OpenAI's endpoint under a name it
// does not have.
const AGENT_PROVIDER_CODES = ["openai", "openrouter", "gemini"];

export function AdminAiAgentSection() {
  const { data: aiConfig } = useAIConfiguration();
  const setDefaultModel = useSetDefaultModel();
  const setFallbackModel = useSetFallbackModel();
  const setFallback2Model = useSetFallback2Model();

  const agentProviders = useMemo(
    () => (aiConfig?.providers || []).filter((p) => AGENT_PROVIDER_CODES.includes(p.provider_code)),
    [aiConfig?.providers],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" /> AI Agent Models</CardTitle>
        <CardDescription>
          The models every messaging AI agent uses, on every platform. Each fallback is tried in
          turn when the one before it fails.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DefaultModelSelector
          category="agent"
          capability="chat"
          title="Messaging agent"
          description="Used by WhatsApp, Facebook, Instagram and Threads agents alike"
          icon={Bot}
          providers={agentProviders}
          models={aiConfig?.models || []}
          currentDefault={aiConfig?.categoryDefaults.agent ?? null}
          currentFallback={aiConfig?.categoryFallbacks.agent ?? null}
          currentFallback2={aiConfig?.categoryFallbacks2.agent ?? null}
          onSetDefault={(pc, mid) => setDefaultModel.mutate({ provider_code: pc, model_id: mid, category: "agent" })}
          onSetFallback={(pc, mid) => setFallbackModel.mutate({ provider_code: pc, model_id: mid, category: "agent" })}
          onSetFallback2={(pc, mid) => setFallback2Model.mutate({ provider_code: pc, model_id: mid, category: "agent" })}
          onSetAdminParams={() => {}}
          isSaving={setDefaultModel.isPending || setFallbackModel.isPending || setFallback2Model.isPending}
        />
      </CardContent>
    </Card>
  );
}
```

`onSetAdminParams` is a no-op: per-model generation knobs are a Chat Models feature and the agent reads `config.temperature` from the user's own row instead.

- [ ] **Step 3: Verify the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all PASS. `lint` catches any import left behind by the deletion.

- [ ] **Step 4: Verify in the browser**

Start the dev server (`bun run dev` — note port 8080 is the user's own dev server; 8081 is pgAdmin), open `/admin/settings`, scroll to **AI Agent Models**, and confirm:
- Three slots render: Primary, Fallback 1, Fallback 2.
- The provider dropdown lists exactly OpenAI, OpenRouter and Google Gemini — none of the other ten.
- Selecting a provider and model saves immediately, with no Save button.
- Reloading the page shows the saved selections.
- The old add form, active toggles and delete buttons are gone.

Then confirm persistence server-side:

```
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres \
  -c "select key, value from system_settings where key like 'default_ai_model_agent%' order by key;"
```

Expected: three rows with the values just selected.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(admin): one global three-slot model control for the messaging agent" -- \
  src/components/admin/DefaultModelSelector.tsx \
  src/components/admin/AdminAiAgentSection.tsx
```

---

### Task 7: Runtime cutover

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts:588-590`

**Interfaces:**
- Consumes: the three `system_settings` rows written in Task 6; `ModelChainExhaustedError` from Task 1; `parseModelRef` and `formatModelRef`, unchanged.
- Produces: no new exports. `ai_agent_configs.model` / `fallback_model_1` / `fallback_model_2` stop being read.

- [ ] **Step 1: Add the chain loader**

Add above the `serve(` handler in `index.ts`, next to `deliverModelOutageFloor`:

```ts
// The three admin-managed global slots, in the order they are tried. Written by
// the AI Agent Models card in /admin/settings.
const AGENT_MODEL_KEYS = [
  "default_ai_model_agent",
  "default_ai_model_agent_fallback",
  "default_ai_model_agent_fallback_2",
] as const;

/**
 * Reads the global model chain. One set of models serves every user and every
 * platform; ai_agent_configs.model and its two fallback columns are deprecated
 * and no longer read. A slot the admin never set is simply absent, so the chain
 * is one, two, or three entries long -- or empty, which escalates.
 */
async function loadGlobalModelChain(admin: any): Promise<string[]> {
  const { data, error } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", AGENT_MODEL_KEYS);
  if (error) throw error;

  const byKey = new Map((data || []).map((row: any) => [row.key, row.value]));
  return AGENT_MODEL_KEYS
    .map((key) => byKey.get(key))
    .filter((value: any) =>
      value && typeof value.provider_code === "string" && typeof value.model_id === "string"
    )
    .map((value: any) => `${value.provider_code}/${value.model_id}`);
}
```

- [ ] **Step 2: Replace the chain construction**

At `index.ts:588-590`, replace:

```ts
    // Primary + fallback chain, each entry resolved to its provider endpoint.
    const rawChain = [config.model, config.fallback_model_1, config.fallback_model_2]
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    const modelChain = (rawChain.length ? rawChain : ["gpt-4o-mini"]).map(parseModelRef);
```

with (`modelChain` is already hoisted by Task 3, so this is an assignment):

```ts
    // Primary + fallback chain, each entry resolved to its provider endpoint.
    // Global as of 2026-08-27: config.model, config.fallback_model_1 and
    // config.fallback_model_2 are deprecated, still in the database but no longer
    // read. Scheduled for removal after a verification window -- see
    // docs/superpowers/specs/2026-08-27-agent-model-selection-design.md §3e.
    const rawChain = await loadGlobalModelChain(admin);
    if (!rawChain.length) {
      // No hardcoded last resort. Calling a model no admin selected is how an
      // unlisted gpt-4o-mini kept answering; a human is the better fallback.
      throw new ModelChainExhaustedError("No global AI agent model is configured");
    }
    modelChain = rawChain.map(parseModelRef);
```

- [ ] **Step 3: Verify types and existing suites**

Run: `deno check supabase/functions/ai-agent-reply/index.ts && bun run test && deno test --allow-none supabase/functions/ai-agent-reply/tools.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(ai-agent): replies use the global model chain, not per-user columns" -- \
  supabase/functions/ai-agent-reply/index.ts
```

- [ ] **Step 5: Deploy and verify on two live platforms**

Confirm `docs/records/2026-08-27-ai-agent-config-models-snapshot.csv` is committed before deploying. Then diff, copy, hash-verify and restart `ai-agent-reply` as in Task 3 Step 8.

Verify:
- Send a real inbound **WhatsApp** message to one of the three enabled accounts. Then:
  ```
  docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres \
    -c "select metadata->>'used_model', created_at from system_logs where source='ai-agent-reply' order by created_at desc limit 3;"
  ```
  Expected: the new global primary — **not** that user's former `config.model`.
- Repeat on **Instagram** with the `1122a2d5` instagram account. Same expectation.
- Confirm `ai_agent_allowed_models` still holds its five rows, its index and both policies.

- [ ] **Step 6: Report and continue to Task 8**

Report the `used_model` values observed on both platforms.

---

### Task 8: Remove the per-user pickers

**Files:**
- Modify: `src/components/messaging/AiAgentManager.tsx` — imports, `:31`, `:39-40`, `:61`, `:74-76`, `:87-113`, `:146`, `:213-250`, `:316`
- Modify: `src/components/messaging/__tests__/AiAgentManager.test.tsx`
- Delete: `src/hooks/useAllowedAiAgentModels.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: an `ai_upsert_config` payload with no `model`, `fallback_model_1` or `fallback_model_2` key. `messaging-api/index.ts:453` validates model fields only when present (`field in updates`), so omitting them skips the allow-list check entirely and cannot re-open the persona bug.

- [ ] **Step 1: Rewrite the two model tests**

In `src/components/messaging/__tests__/AiAgentManager.test.tsx`:

Delete the `useAllowedAiAgentModels` mock block, the `allowedModels` array, the `modelsResult` variable and its reset in `beforeEach`.

Replace the first test's expectation, keeping the regression comment and updating it:

```tsx
  // Regression, 2026-08-26: this page sent a hardcoded "gpt-4o-mini" that was not
  // on the admin allow-list, so messaging-api answered 400 and NOTHING saved --
  // reported as "the persona text is gone when I come back". Since 2026-08-27 the
  // model is global and admin-managed, so the page must send no model field at
  // all: messaging-api only validates fields the payload actually carries.
  it("saves the persona and sends no model fields", () => {
    render(<AiAgentManager platform="threads" />);

    fireEvent.change(screen.getByLabelText("Persona and instructions"), {
      target: { value: "Answer in Arabic, keep it short." },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    const payload = savedPayload();
    expect(payload).toMatchObject({ persona_instructions: "Answer in Arabic, keep it short." });
    expect(payload).not.toHaveProperty("model");
    expect(payload).not.toHaveProperty("fallback_model_1");
    expect(payload).not.toHaveProperty("fallback_model_2");
  });
```

Replace the second test (stale-model normalisation) with one proving a stored model is ignored rather than resent:

```tsx
  it("ignores a model stored on an existing config instead of sending it back", () => {
    config = {
      is_enabled: true,
      default_mode: "human_then_ai",
      persona_instructions: "Existing persona",
      business_profile_text: "",
      language_mode: "auto",
      model: "openrouter/tencent/hy3:free",
      fallback_model_1: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      fallback_model_2: "google/gemini-2.5-pro",
      temperature: 0.4,
      admin_phone_numbers: [],
      daily_message_cap: 50,
      reply_cooldown_seconds: 0,
      max_tool_iterations: 5,
      handoff_on_request: true,
      handoff_on_low_confidence: false,
    };
    render(<AiAgentManager platform="whatsapp" />);

    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    const payload = savedPayload();
    expect(payload).toMatchObject({ persona_instructions: "Existing persona" });
    expect(payload).not.toHaveProperty("model");
  });
```

Delete the third test (`"lets a model be chosen from the admin allow-list"`) and the fourth (`"blocks saving and says why when no model has been enabled"`) — both assert on UI that no longer exists.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/components/messaging/__tests__/AiAgentManager.test.tsx`
Expected: FAIL — the payload still has a `model` property.

- [ ] **Step 3: Strip the pickers from the component**

In `src/components/messaging/AiAgentManager.tsx`:
- Delete the `useAllowedAiAgentModels` import (`:14`), the `NO_FALLBACK` constant (`:39-40`), the hook call (`:61`), the `allowedValues` memo and the normalisation effect (`:87-113`).
- Delete `model`, `fallback_model_1` and `fallback_model_2` from `defaultConfig` (`:31`) and from the form-population block (`:74-76`).
- Delete the entire model-picker `<div className="space-y-3">` block (`:213-250`), from the opening tag through the closing `</div>` after the helper paragraph.
- Change the loading gate at `:146` from `if (isLoading || modelsLoading)` to `if (isLoading)`.
- Change the save button at `:316` from `disabled={upsertConfig.isPending || allowedValues.length === 0}` to `disabled={upsertConfig.isPending}`.
- Remove `useMemo` and `useEffect` from the React import if nothing else in the file uses them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- src/components/messaging/__tests__/AiAgentManager.test.tsx`
Expected: PASS, two tests.

- [ ] **Step 5: Delete the orphaned hook**

```bash
git rm src/hooks/useAllowedAiAgentModels.ts
```

Confirm nothing imports it:

```bash
grep -rn "useAllowedAiAgentModels\|formatAllowedModelValue" src/
```

Expected: no output.

- [ ] **Step 6: Run the full gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all PASS, with no fewer test files than the pre-change baseline minus none (the two deleted tests are within `AiAgentManager.test.tsx`, which still runs).

- [ ] **Step 7: Commit**

```bash
git commit -m "refactor(ai-agent): drop the per-user model pickers, now admin-managed" -- \
  src/components/messaging/AiAgentManager.tsx \
  src/components/messaging/__tests__/AiAgentManager.test.tsx \
  src/hooks/useAllowedAiAgentModels.ts
```

- [ ] **Step 8: Verify in the browser**

Open `/automation/agents?platform=whatsapp&surface=dms`. Confirm:
- No AI model or Fallback selects render.
- Editing the persona, saving, navigating away and returning shows the saved persona.
- The Save button is enabled regardless of the allow-list.

- [ ] **Step 9: Report Phase 3**

Report: every file changed across Tasks 5-8, the exact `system_settings` keys used, the `used_model` evidence from both platforms in Task 7, and confirmation that `ai_agent_allowed_models` still exists with five rows.

---

## Post-plan follow-ups (not in scope)

Record these; do not implement them here.

1. **Decommission the deprecated objects** after a verification window: `ai_agent_allowed_models` with its index, grants and both policies; `ai_agent_configs.model` / `fallback_model_1` / `fallback_model_2`; the validation block at `messaging-api/index.ts:452-475`; and the regenerated type entries. Spec §3e is the reference.
2. **`escalateToHuman` writes half-orphaned assignment rows.** `whatsapp_conversation_assignments` gained `workspace_id` and `conversation_cache_id`; neither is supplied, so AI-escalated assignments are likely invisible to the workspace-scoped inbox. Pre-existing; Task 2 preserves the behaviour rather than changing it.
