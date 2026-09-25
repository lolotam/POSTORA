# Jev Agent Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before the chat model runs, a fast TypeSafe Jev call decides whether a DM or comment needs the knowledge base, which single connector it needs, whether it needs a human, and whether it is small talk, so the AI agent does less work per reply.

**Architecture:**
- A new pure-plus-runtime module `supabase/functions/_shared/agentTriage.ts` does five things:
  - builds the Jev request;
  - speaks both provider dialects (OpenRouter `/api/v1/systemone`, Vercel `/v1/evaluate`);
  - parses the answers;
  - turns them into a `TriagePlan`;
  - fails open: returns `null` on any error or a timeout.
- `ai-agent-reply/index.ts` loads the triage chain. It starts triage and knowledge retrieval at the same time, awaits triage, and then:
  - skips retrieval when triage says it isn't needed;
  - narrows the tools sent to the model;
  - adds a handoff hint or uses a small-talk prompt.
- Admins switch triage on and pick the Jev models in the AI Agent settings section.

**Tech Stack:** Deno edge functions (TypeScript, `deno test`), React + TanStack Query + shadcn (Vitest), and Supabase `system_settings` and `ai_models`.

**Spec:** `docs/superpowers/specs/2026-09-25-jev-agent-triage-design.md`

## Global Constraints

- Required reading before editing `supabase/functions/**` or `src/**`: `ARCHITECTURE.md`. It covers Edge Function shape, security rules and dependency direction.
- Confidence threshold: **0.80**. Triage time budget across all tiers: **1500 ms**.
- Fail-open: a Jev error, timeout, missing key, disabled switch or empty chain means today's pipeline runs **unchanged**.
- Provider dialects, exactly:
  - **OpenRouter:** `POST https://openrouter.ai/api/v1/systemone`. The yes/no question type is `"noul"`, and its answer field is `noul`.
  - **Vercel:** `POST https://ai-gateway.vercel.sh/v1/evaluate`. The yes/no question type is `"boolean"`, and its answer field is `probability`.
  - **Both:** a choice question is `{ type: "choice", instructions, criteria: { key: description } }`, and its answer is `{ choice, probabilities, confidence }`.
- Keys: `resolveProviderKey(db, providerCode)` from `_shared/providerKeys.ts` (saved key first, then env). Never log or return a key.
- Settings keys:
  - `agent_triage_enabled`, value `{ "enabled": true }`;
  - `default_ai_model_agent_triage`, `default_ai_model_agent_triage_fallback` and `default_ai_model_agent_triage_fallback_2`, each value `{ provider_code, model_id }`.
- New `ai_models` capability: `"triage"`. It has no DB constraint, so no migration is needed.
- Accepted triage providers: `openrouter`, `vercel`. Any other provider in a slot is ignored.
- The chat model still writes every reply. Triage never sends text itself.
- Deno tests: `cd supabase/functions && deno test -A --no-check --node-modules-dir=none <paths>`. Type check: `deno check <file>`.
- Frontend tests: `node_modules/.bin/vitest run <path>`. Type check: `node_modules/.bin/tsc --noEmit -p tsconfig.app.json`. Never `npx tsc`.
- Match the neighbouring code style, add no new `any`, and follow the Postora conventions from the repo.

## Rulings recorded against the spec

1. **Triage details are logged in `system_logs.metadata.triage`**, through `logOutcome`'s existing `meta` argument, not in a new `ai_agent_logs` column. That avoids a migration, and `/admin/logs` already shows this metadata.
2. **Handoff is a hint, not a skipped model call.** A closing message still has to reach the customer, so a confident `handoff` adds a system line telling the model to call `escalate_to_human`, and narrows the tools to the agent's base tools.
3. **The chosen connector is narrowed, not forced.** `tool_choice` stays `"auto"`. Forcing a named function is not supported the same way by every provider in the agent chain (Anthropic goes through `callAnthropicJson`).
4. **Off switch.** Model slots cannot be cleared in the UI, so triage has its own `agent_triage_enabled` switch. Triage runs only when the switch is on and the primary slot is set.

---

### Task 1: Catalogue maps Jev to the `triage` capability

**Files:**
- Modify: `supabase/functions/_shared/modelCatalogSync.ts`:
  - `VERCEL_TYPE_CAPABILITY` (about line 54);
  - the `Capability` type;
  - `mapOpenRouterCatalog` (about line 160).
- Test: `supabase/functions/_shared/modelCatalogSync.test.ts`

**Interfaces:**
- Produces:
  - `Capability` now includes `"triage"`;
  - Vercel `type: "evaluation"` maps to `["triage"]`;
  - OpenRouter `output_modalities` containing `"decisions"` maps to `["triage"]`;
  - both mappers include `"triage"` in `managedCapabilities`.

- [ ] **Step 1: Update the failing expectations in the existing tests**

In `modelCatalogSync.test.ts`:

In `"mapVercelCatalog assigns one capability per gateway type and skips unused types"`:
- add `"typesafe-ai/jev": ["triage"],` to the expected `caps` object;
- change the skipped assertion to `assertEquals(mapped.skippedByType, { realtime: 1, reranking: 1 });`;
- change the managed assertion to `["chat", "embedding", "image", "stt", "triage", "tts", "video"]`.

In `"mapOpenRouterCatalog adds embedding models with their measured width and skips what nothing can call"`:
- the model list becomes `["some/new-embedder", "thenlper/gte-large", "typesafe/jev-1.13", "voyageai/voyage-4"]`;
- skipped becomes `{ batch: 1, image: 1 }`;
- managed becomes `["chat", "embedding", "image", "triage"]`.

In `"mapOpenRouterCatalog maps text and image output modalities to chat and image"`:
- managed becomes `["chat", "embedding", "image", "triage"]`.

Add this test:

```ts
Deno.test("Jev decision models map to the triage capability on both catalogues", () => {
  const vercelJev = mapVercelCatalog([{ id: "typesafe-ai/jev", name: "Jev", type: "evaluation" }]).models[0];
  const routerJev = mapOpenRouterCatalog([
    { id: "typesafe/jev-1.13", name: "Jev", architecture: { output_modalities: ["decisions"] } },
  ]).models[0];
  assertEquals(vercelJev.capabilities, ["triage"]);
  assertEquals(routerJev.capabilities, ["triage"]);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `cd supabase/functions && deno test -A --no-check _shared/modelCatalogSync.test.ts`
Expected: the tests above FAIL.

- [ ] **Step 3: Implement**

In `modelCatalogSync.ts`:
- Add `"triage"` to the `Capability` union.
- Add `evaluation: "triage",` to `VERCEL_TYPE_CAPABILITY`.
- In `mapOpenRouterCatalog`, add a branch after the `embeddings` branch:

```ts
    } else if (outputs.includes("decisions")) {
      capabilities.push("triage");
    }
```

- Change its return to `managedCapabilities: ["chat", "image", "embedding", "triage"]`.
- Update the comment above `mapOpenRouterCatalog` so it no longer lists decision models as skipped. Say they map to `triage`, used by the AI agent's triage step.

- [ ] **Step 4: Run and see it pass**

Run: `cd supabase/functions && deno test -A --no-check _shared/modelCatalogSync.test.ts _shared/modelCatalogSyncRun.test.ts && deno check _shared/modelCatalogSync.ts`
Expected: all PASS, and the check is clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): catalogue Jev decision models under a triage capability" -- supabase/functions/_shared/modelCatalogSync.ts supabase/functions/_shared/modelCatalogSync.test.ts
```

---

### Task 2: Pure triage logic: request, dialects, parsing, plan

**Files:**
- Create: `supabase/functions/_shared/agentTriage.ts`
- Test: `supabase/functions/_shared/agentTriage.test.ts`

**Interfaces:**
- Produces (all exported from `agentTriage.ts`):

```ts
export type TriageProvider = "openrouter" | "vercel";
export interface TriageTier { provider: TriageProvider; model: string }
export interface TriageConnector { name: string; description: string }
export interface TriageInput {
  message: string;
  history: Array<{ role: string; content: string }>;
  connectors: TriageConnector[];
  askHandoff: boolean;
}
export interface TriageAnswers {
  needsKnowledge: number | null;   // probability of yes
  smalltalk: number | null;
  handoff: number | null;
  connector: { choice: string; confidence: number } | null;
}
export interface TriagePlan {
  skipKnowledge: boolean;
  smalltalk: boolean;
  handoff: boolean;
  connectors: "all" | string[];    // names to offer; [] = none
}
export const TRIAGE_CONFIDENCE = 0.8;
export const NO_TOOL = "no_tool";
export function triageRequestBody(tier: TriageTier, input: TriageInput): Record<string, unknown>;
export function triageEndpoint(provider: TriageProvider): string;
export function parseTriageAnswers(provider: TriageProvider, json: unknown): TriageAnswers;
export function planFromAnswers(answers: TriageAnswers, connectorNames: string[]): TriagePlan;
export function selectConnectorTools<T extends { name: string }>(tools: T[], plan: TriagePlan | null): T[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  NO_TOOL, parseTriageAnswers, planFromAnswers, selectConnectorTools, triageEndpoint, triageRequestBody,
  type TriageAnswers, type TriageInput,
} from "./agentTriage.ts";

const input: TriageInput = {
  message: "how much is the large box?",
  history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello! How can I help?" }],
  connectors: [{ name: "store_catalog", description: "Products and prices" }],
  askHandoff: true,
};

Deno.test("each provider gets its own endpoint and yes/no question type", () => {
  const router = triageRequestBody({ provider: "openrouter", model: "typesafe/jev-1.13" }, input);
  const gateway = triageRequestBody({ provider: "vercel", model: "typesafe-ai/jev" }, input);
  const q = (body: Record<string, unknown>) => body.questions as Record<string, { type: string }>;
  assertEquals(q(router).needs_knowledge.type, "noul");
  assertEquals(q(gateway).needs_knowledge.type, "boolean");
  assertEquals(q(router).connector.type, "choice");
  assertEquals(router.model, "typesafe/jev-1.13");
  assertEquals(triageEndpoint("openrouter"), "https://openrouter.ai/api/v1/systemone");
  assertEquals(triageEndpoint("vercel"), "https://ai-gateway.vercel.sh/v1/evaluate");
});

Deno.test("the connector question lists each connector plus a no-tool option, and is omitted without connectors", () => {
  const withTools = triageRequestBody({ provider: "vercel", model: "m" }, input);
  const criteria = (withTools.questions as any).connector.criteria;
  assertEquals(Object.keys(criteria).sort(), [NO_TOOL, "store_catalog"]);
  const bare = triageRequestBody({ provider: "vercel", model: "m" }, { ...input, connectors: [], askHandoff: false });
  assertEquals(Object.keys(bare.questions as object).sort(), ["needs_knowledge", "smalltalk"]);
});

Deno.test("the state carries the recent turns and the message, bounded in size", () => {
  const body = triageRequestBody({ provider: "vercel", model: "m" }, { ...input, message: "x".repeat(20_000) });
  const state = body.state as string;
  assertEquals(state.includes("Assistant: Hello! How can I help?"), true);
  assertEquals(state.length <= 6000, true);
});

Deno.test("answers parse from either dialect into one shape", () => {
  const router = parseTriageAnswers("openrouter", { answers: {
    needs_knowledge: { type: "noul", noul: 0.9 }, smalltalk: { type: "noul", noul: 0.05 },
    connector: { type: "choice", choice: "store_catalog", confidence: 0.93 },
  } });
  const gateway = parseTriageAnswers("vercel", { answers: {
    needs_knowledge: { type: "boolean", probability: 0.9 }, smalltalk: { type: "boolean", probability: 0.05 },
    connector: { type: "choice", choice: "store_catalog", confidence: 0.93 },
  } });
  const expected: TriageAnswers = { needsKnowledge: 0.9, smalltalk: 0.05, handoff: null,
    connector: { choice: "store_catalog", confidence: 0.93 } };
  assertEquals(router, expected);
  assertEquals(gateway, expected);
});

Deno.test("only confident answers change the plan", () => {
  const names = ["store_catalog", "crm"];
  const unsure = planFromAnswers({ needsKnowledge: 0.5, smalltalk: 0.6, handoff: 0.7,
    connector: { choice: "crm", confidence: 0.6 } }, names);
  assertEquals(unsure, { skipKnowledge: false, smalltalk: false, handoff: false, connectors: "all" });
  const sure = planFromAnswers({ needsKnowledge: 0.1, smalltalk: 0.02, handoff: 0.01,
    connector: { choice: "crm", confidence: 0.95 } }, names);
  assertEquals(sure, { skipKnowledge: true, smalltalk: false, handoff: false, connectors: ["crm"] });
});

Deno.test("small talk and handoff take precedence over connector routing", () => {
  const names = ["crm"];
  const hi = planFromAnswers({ needsKnowledge: 0.4, smalltalk: 0.97, handoff: 0.01,
    connector: { choice: "crm", confidence: 0.9 } }, names);
  assertEquals(hi, { skipKnowledge: true, smalltalk: true, handoff: false, connectors: [] });
  const human = planFromAnswers({ needsKnowledge: 0.9, smalltalk: 0.01, handoff: 0.92,
    connector: { choice: "crm", confidence: 0.9 } }, names);
  assertEquals(human, { skipKnowledge: true, smalltalk: false, handoff: true, connectors: [] });
});

Deno.test("a confident no-tool choice offers no connectors; an unknown name offers all", () => {
  const none = planFromAnswers({ needsKnowledge: null, smalltalk: null, handoff: null,
    connector: { choice: NO_TOOL, confidence: 0.9 } }, ["crm"]);
  assertEquals(none.connectors, []);
  const unknown = planFromAnswers({ needsKnowledge: null, smalltalk: null, handoff: null,
    connector: { choice: "ghost", confidence: 0.99 } }, ["crm"]);
  assertEquals(unknown.connectors, "all");
});

Deno.test("selectConnectorTools keeps everything without a plan and narrows with one", () => {
  const tools = [{ name: "crm" }, { name: "store_catalog" }];
  assertEquals(selectConnectorTools(tools, null), tools);
  assertEquals(selectConnectorTools(tools, { skipKnowledge: false, smalltalk: false, handoff: false, connectors: "all" }), tools);
  assertEquals(selectConnectorTools(tools, { skipKnowledge: false, smalltalk: false, handoff: false, connectors: ["crm"] }), [{ name: "crm" }]);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `cd supabase/functions && deno test -A --no-check _shared/agentTriage.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `agentTriage.ts` (pure part)**

```ts
// TypeSafe Jev triage for the AI agent: one fast decision call (about 0.4s) that says
// which parts of the reply pipeline a message needs. Jev returns typed choices and
// probabilities, never text; the chat model still writes every reply.
// Spec: docs/superpowers/specs/2026-09-25-jev-agent-triage-design.md

export type TriageProvider = "openrouter" | "vercel";
export interface TriageTier { provider: TriageProvider; model: string }
export interface TriageConnector { name: string; description: string }
export interface TriageInput {
  message: string;
  history: Array<{ role: string; content: string }>;
  connectors: TriageConnector[];
  askHandoff: boolean;
}
export interface TriageAnswers {
  needsKnowledge: number | null;
  smalltalk: number | null;
  handoff: number | null;
  connector: { choice: string; confidence: number } | null;
}
export interface TriagePlan {
  skipKnowledge: boolean;
  smalltalk: boolean;
  handoff: boolean;
  connectors: "all" | string[];
}

export const TRIAGE_CONFIDENCE = 0.8;
export const NO_TOOL = "no_tool";
const MAX_STATE_CHARS = 6000;
const MAX_CRITERION_CHARS = 300;
const HISTORY_TURNS = 2;

const ENDPOINTS: Record<TriageProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1/systemone",
  vercel: "https://ai-gateway.vercel.sh/v1/evaluate",
};
// The same yes/no primitive has a different name, and a different answer field, per provider.
const YES_NO: Record<TriageProvider, { type: string; field: string }> = {
  openrouter: { type: "noul", field: "noul" },
  vercel: { type: "boolean", field: "probability" },
};

export function triageEndpoint(provider: TriageProvider): string {
  return ENDPOINTS[provider];
}

// The recent turns are kept whole; the new message is what gets cut to fit.
function triageState(input: TriageInput): string {
  const turns = input.history.slice(-HISTORY_TURNS)
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "Customer"}: ${turn.content.slice(0, 1000)}`);
  const label = "Customer (new message): ";
  const room = Math.max(0, MAX_STATE_CHARS - turns.join("\n").length - label.length - 1);
  return [...turns, label + input.message.slice(0, room)].join("\n");
}

export function triageRequestBody(tier: TriageTier, input: TriageInput): Record<string, unknown> {
  const yesNo = (instructions: string) => ({ type: YES_NO[tier.provider].type, instructions });
  const questions: Record<string, unknown> = {
    needs_knowledge: yesNo(
      "Answering the new message needs facts about this business (products, prices, policies, hours, services).",
    ),
    smalltalk: yesNo(
      "The new message is only a greeting, thanks, acknowledgement or emoji and needs no facts or actions.",
    ),
  };
  if (input.askHandoff) {
    questions.handoff = yesNo(
      "The customer asks for a human, is angry, or the request needs a human to handle it.",
    );
  }
  if (input.connectors.length) {
    const criteria: Record<string, string> = { [NO_TOOL]: "No connected tool is needed to answer." };
    for (const connector of input.connectors) {
      criteria[connector.name] = (connector.description || connector.name).slice(0, MAX_CRITERION_CHARS);
    }
    questions.connector = {
      type: "choice",
      instructions: "Which connected tool is needed to answer the new message?",
      criteria,
    };
  }
  return { model: tier.model, state: triageState(input), questions };
}

function probability(answer: unknown, field: string): number | null {
  const value = (answer as Record<string, unknown> | undefined)?.[field];
  return typeof value === "number" ? value : null;
}

export function parseTriageAnswers(provider: TriageProvider, json: unknown): TriageAnswers {
  const answers = ((json as { answers?: Record<string, unknown> } | null)?.answers ?? {});
  const field = YES_NO[provider].field;
  const connector = answers.connector as { choice?: unknown; confidence?: unknown } | undefined;
  return {
    needsKnowledge: probability(answers.needs_knowledge, field),
    smalltalk: probability(answers.smalltalk, field),
    handoff: probability(answers.handoff, field),
    connector: typeof connector?.choice === "string" && typeof connector.confidence === "number"
      ? { choice: connector.choice, confidence: connector.confidence }
      : null,
  };
}

const confidentYes = (p: number | null) => p !== null && p >= TRIAGE_CONFIDENCE;
const confidentNo = (p: number | null) => p !== null && p <= 1 - TRIAGE_CONFIDENCE;

// Precedence: a human is needed > small talk > connector routing. Anything unsure keeps
// today's behaviour for that part of the pipeline.
export function planFromAnswers(answers: TriageAnswers, connectorNames: string[]): TriagePlan {
  if (confidentYes(answers.handoff)) {
    return { skipKnowledge: true, smalltalk: false, handoff: true, connectors: [] };
  }
  if (confidentYes(answers.smalltalk)) {
    return { skipKnowledge: true, smalltalk: true, handoff: false, connectors: [] };
  }
  let connectors: TriagePlan["connectors"] = "all";
  const pick = answers.connector;
  if (pick && pick.confidence >= TRIAGE_CONFIDENCE) {
    if (pick.choice === NO_TOOL) connectors = [];
    else if (connectorNames.includes(pick.choice)) connectors = [pick.choice];
  }
  return { skipKnowledge: confidentNo(answers.needsKnowledge), smalltalk: false, handoff: false, connectors };
}

export function selectConnectorTools<T extends { name: string }>(tools: T[], plan: TriagePlan | null): T[] {
  if (!plan || plan.connectors === "all") return tools;
  const keep = new Set(plan.connectors);
  return tools.filter((tool) => keep.has(tool.name));
}
```

- [ ] **Step 4: Run and see it pass**

Run: `cd supabase/functions && deno test -A --no-check _shared/agentTriage.test.ts && deno check _shared/agentTriage.ts`
Expected: 8 passed, and the check is clean.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agentTriage.ts supabase/functions/_shared/agentTriage.test.ts
git commit -m "feat(agent): pure Jev triage request, dialects and plan" -- supabase/functions/_shared/agentTriage.ts supabase/functions/_shared/agentTriage.test.ts
```

---

### Task 3: Triage runtime: chain loading and a fail-open call

**Files:**
- Modify: `supabase/functions/_shared/agentTriage.ts` (append)
- Test: `supabase/functions/_shared/agentTriage.test.ts` (append)

**Interfaces:**
- Consumes (Task 2): `triageRequestBody`, `triageEndpoint`, `parseTriageAnswers`, `planFromAnswers`, `TriageTier`, `TriageInput`, `TriagePlan`, `TriageAnswers`.
- Produces:

```ts
export const TRIAGE_BUDGET_MS = 1500;
export const TRIAGE_SETTING_KEYS: readonly string[]; // enabled key + 3 slot keys
export interface TriageOutcome {
  provider: TriageProvider; model: string; latencyMs: number;
  answers: TriageAnswers; plan: TriagePlan;
}
export interface TriageRun { outcome: TriageOutcome | null; errors: Array<{ model: string; error: string }> }
export function triageChainFromSettings(rows: Array<{ key: string; value: unknown }>): TriageTier[];
export async function runTriage(
  tiers: TriageTier[], input: TriageInput,
  resolveKey: (providerCode: TriageProvider) => Promise<string | null>,
  budgetMs?: number, fetchImpl?: typeof fetch, now?: () => number,
): Promise<TriageRun>;
```

- [ ] **Step 1: Append the failing tests**

```ts
import { runTriage, TRIAGE_SETTING_KEYS, triageChainFromSettings } from "./agentTriage.ts";

const slot = (provider_code: string, model_id: string) => ({ provider_code, model_id });

Deno.test("the chain is empty unless the switch is on, and keeps only triage providers in slot order", () => {
  const slots = [
    { key: "default_ai_model_agent_triage", value: slot("openrouter", "typesafe/jev-1.13") },
    { key: "default_ai_model_agent_triage_fallback", value: slot("claude", "x") },
    { key: "default_ai_model_agent_triage_fallback_2", value: slot("vercel", "typesafe-ai/jev") },
  ];
  assertEquals(triageChainFromSettings(slots), []);
  assertEquals(triageChainFromSettings([...slots, { key: "agent_triage_enabled", value: { enabled: false } }]), []);
  assertEquals(triageChainFromSettings([...slots, { key: "agent_triage_enabled", value: { enabled: true } }]), [
    { provider: "openrouter", model: "typesafe/jev-1.13" },
    { provider: "vercel", model: "typesafe-ai/jev" },
  ]);
  assertEquals(TRIAGE_SETTING_KEYS.includes("agent_triage_enabled"), true);
});

const okJson = { answers: { needs_knowledge: { type: "boolean", probability: 0.05 },
  smalltalk: { type: "boolean", probability: 0.02 } } };
const tiers = [{ provider: "openrouter" as const, model: "a" }, { provider: "vercel" as const, model: "b" }];
const key = () => Promise.resolve("k");

Deno.test("a failing first tier falls through to the next and the plan comes from its answers", async () => {
  const calls: string[] = [];
  const fetchImpl = ((url: string) => {
    calls.push(url);
    return Promise.resolve(url.includes("openrouter")
      ? new Response("{}", { status: 500 })
      : new Response(JSON.stringify(okJson), { status: 200 }));
  }) as typeof fetch;
  const run = await runTriage(tiers, input, key, 1500, fetchImpl);
  assertEquals(calls.length, 2);
  assertEquals(run.outcome?.provider, "vercel");
  assertEquals(run.outcome?.plan.skipKnowledge, true);
  assertEquals(run.errors.map((e) => e.model), ["openrouter/a"]);
});

Deno.test("no key, a throw, or an exhausted budget returns no outcome instead of failing the reply", async () => {
  const noKey = await runTriage(tiers, input, () => Promise.resolve(null), 1500,
    (() => { throw new Error("must not be called"); }) as unknown as typeof fetch);
  assertEquals(noKey.outcome, null);
  const throwing = await runTriage(tiers, input, key, 1500,
    (() => Promise.reject(new TypeError("reset"))) as typeof fetch);
  assertEquals(throwing.outcome, null);
  assertEquals(throwing.errors.length, 2);
  let clock = 0;
  const spent = await runTriage(tiers, input, key, 1500,
    (() => { clock += 2000; return Promise.resolve(new Response("{}", { status: 500 })); }) as typeof fetch,
    () => clock);
  assertEquals(spent.errors.length, 1);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `cd supabase/functions && deno test -A --no-check _shared/agentTriage.test.ts`
Expected: FAIL, the new exports are missing.

- [ ] **Step 3: Implement (append to `agentTriage.ts`)**

```ts
export const TRIAGE_BUDGET_MS = 1500;
const ENABLED_KEY = "agent_triage_enabled";
const SLOT_KEYS = [
  "default_ai_model_agent_triage",
  "default_ai_model_agent_triage_fallback",
  "default_ai_model_agent_triage_fallback_2",
] as const;
export const TRIAGE_SETTING_KEYS: readonly string[] = [ENABLED_KEY, ...SLOT_KEYS];

export interface TriageOutcome {
  provider: TriageProvider;
  model: string;
  latencyMs: number;
  answers: TriageAnswers;
  plan: TriagePlan;
}
export interface TriageRun { outcome: TriageOutcome | null; errors: Array<{ model: string; error: string }> }

const isTriageProvider = (code: unknown): code is TriageProvider => code === "openrouter" || code === "vercel";

// Off unless an admin switched it on. Slots holding any other provider are ignored:
// only these two speak the decision API.
export function triageChainFromSettings(rows: Array<{ key: string; value: unknown }>): TriageTier[] {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  if ((byKey.get(ENABLED_KEY) as { enabled?: unknown } | undefined)?.enabled !== true) return [];
  const chain: TriageTier[] = [];
  for (const key of SLOT_KEYS) {
    const slotValue = byKey.get(key) as { provider_code?: unknown; model_id?: unknown } | undefined;
    if (isTriageProvider(slotValue?.provider_code) && typeof slotValue.model_id === "string" && slotValue.model_id) {
      chain.push({ provider: slotValue.provider_code, model: slotValue.model_id });
    }
  }
  return chain;
}

// Never throws: every failure is recorded and the caller runs today's pipeline.
export async function runTriage(
  tiers: TriageTier[],
  input: TriageInput,
  resolveKey: (providerCode: TriageProvider) => Promise<string | null>,
  budgetMs = TRIAGE_BUDGET_MS,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<TriageRun> {
  const startedAt = now();
  const errors: TriageRun["errors"] = [];
  for (const tier of tiers) {
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0) break;
    const label = `${tier.provider}/${tier.model}`;
    try {
      const key = await resolveKey(tier.provider);
      if (!key) {
        errors.push({ model: label, error: "no API key" });
        continue;
      }
      const response = await fetchImpl(triageEndpoint(tier.provider), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(triageRequestBody(tier, input)),
        signal: AbortSignal.timeout(remaining),
      });
      if (!response.ok) {
        errors.push({ model: label, error: `HTTP ${response.status}` });
        continue;
      }
      const answers = parseTriageAnswers(tier.provider, await response.json());
      const plan = planFromAnswers(answers, input.connectors.map((c) => c.name));
      return { outcome: { provider: tier.provider, model: tier.model, latencyMs: now() - startedAt, answers, plan }, errors };
    } catch (error) {
      errors.push({ model: label, error: error instanceof Error ? error.name : "error" });
    }
  }
  return { outcome: null, errors };
}
```

The error strings carry only an HTTP status or an error class name, never a response body or a key.

- [ ] **Step 4: Run and see it pass**

Run: `cd supabase/functions && deno test -A --no-check _shared/agentTriage.test.ts && deno check _shared/agentTriage.ts`
Expected: 11 passed, and the check is clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent): fail-open Jev triage runtime and settings chain" -- supabase/functions/_shared/agentTriage.ts supabase/functions/_shared/agentTriage.test.ts
```

---

### Task 4: Wire triage into `ai-agent-reply`

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts`
- Test: `supabase/functions/ai-agent-reply/logic.ts` and `logic.test.ts` (or the nearest existing test file) for the one pure helper added here.

**Interfaces:**
- Consumes (Tasks 2–3): `runTriage`, `triageChainFromSettings`, `TRIAGE_SETTING_KEYS`, `selectConnectorTools`, `TriageRun`, `TriageConnector`.
- Consumes from `_shared/providerKeys.ts`: `resolveProviderKey`.
- Consumes (existing, in `index.ts`):
  - `customTools: CustomTool[]` (each has `name`, `description`);
  - `history`;
  - `handoff`;
  - `buildSystemPrompt`;
  - `agentToolDefinitions(handoff)`, `adminToolDefinitions`, `customToolDefinitions(customTools)`;
  - `logOutcome(admin, entry, meta)`.
- Produces in `logic.ts`: `export function triageSystemHint(plan: TriagePlan | null): string | null`. This returns the extra system line for the handoff and small-talk plans, and `null` otherwise.

The code line numbers below refer to `origin/main` at `3a24f33c`.

- [ ] **Step 1: Write the failing test for `triageSystemHint`**

In the existing test file that covers `logic.ts` (find it with `ls supabase/functions/ai-agent-reply/*.test.ts`; if none imports `logic.ts`, create `supabase/functions/ai-agent-reply/triageHint.test.ts`):

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { triageSystemHint } from "./logic.ts";

Deno.test("triage adds a system hint only for handoff and small talk", () => {
  const base = { skipKnowledge: true, smalltalk: false, handoff: false, connectors: [] as string[] };
  assertEquals(triageSystemHint(null), null);
  assertEquals(triageSystemHint(base), null);
  assertEquals(triageSystemHint({ ...base, handoff: true })?.includes("escalate_to_human"), true);
  assertEquals(triageSystemHint({ ...base, smalltalk: true })?.includes("short"), true);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `cd supabase/functions && deno test -A --no-check --node-modules-dir=none ai-agent-reply/`
Expected: FAIL, `triageSystemHint` is not exported.

- [ ] **Step 3: Implement `triageSystemHint` in `logic.ts`**

```ts
import type { TriagePlan } from "../_shared/agentTriage.ts";

// The chat model still writes the reply; triage only tells it what kind of turn this is.
export function triageSystemHint(plan: TriagePlan | null): string | null {
  if (plan?.handoff) {
    return "This customer needs a human. Call escalate_to_human now, then tell them briefly that a person will reply.";
  }
  if (plan?.smalltalk) {
    return "This message is small talk. Reply with one short, friendly sentence in the customer's language.";
  }
  return null;
}
```

- [ ] **Step 4: Rework the pipeline in `index.ts`**

Make these edits inside the `try` of `Deno.serve`:

1. **Imports** (top of the file):

   ```ts
   import { runTriage, selectConnectorTools, TRIAGE_SETTING_KEYS, triageChainFromSettings, type TriageRun } from "../_shared/agentTriage.ts";
   import { resolveProviderKey } from "../_shared/providerKeys.ts";
   import type { RowReader } from "../_shared/providerEndpoint.ts";
   ```

   Add `triageSystemHint` to the existing `./logic.ts` import.

2. **Move knowledge retrieval behind a function, without changing it.** Wrap the block from `let relevantChunks` through the end of the graph-expansion `if` (lines 770–819 at 3a24f33c) into:

   ```ts
   const retrieveKnowledgeContext = async () => { /* the moved block, unchanged */ return { relevantChunks, retrievedChunkIds, relatedFacts, ragError, graphError }; };
   ```

   Leave `const embeddingConfig = await resolveDualEmbeddingConfigFromDb(admin);` where it is, before the function, because `toolContext.retrieveKnowledge` needs it. Declare these as `let` at the old location, with the same empty defaults as today, so later code compiles unchanged:
   - `let relevantChunks: Array<{ id: string; content: string; similarity: number }> = [];`
   - `let retrievedChunkIds: string[] = [];`
   - `let relatedFacts = "";`
   - `let ragError: string | null = null;`
   - `let graphError: string | null = null;`

3. **Start triage and retrieval together, after tool resolution.** Immediately after `const customToolByName = new Map(...)` (line 990), insert:

   ```ts
   const { data: triageRows } = await admin.from("system_settings").select("key, value").in("key", TRIAGE_SETTING_KEYS);
   const triageChain = triageChainFromSettings(triageRows ?? []);
   // Started together: triage (about 0.4s) and retrieval overlap, and retrieval is dropped
   // unawaited when triage is confident it is not needed.
   const knowledgePromise = retrieveKnowledgeContext();
   let triage: TriageRun | null = null;
   if (triageChain.length) {
     triage = await runTriage(triageChain, {
       message: request.inbound_text.slice(0, MAX_INBOUND_CHARS),
       history,
       connectors: customTools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
       askHandoff: handoff.onRequest || handoff.onLowConfidence,
     }, (code) => resolveProviderKey(admin as unknown as RowReader, code));
   }
   const triagePlan = triage?.outcome?.plan ?? null;
   if (triagePlan?.skipKnowledge) {
     knowledgePromise.catch(() => {}); // not awaited; keep a late rejection from being unhandled
   } else {
     ({ relevantChunks, retrievedChunkIds, relatedFacts, ragError, graphError } = await knowledgePromise);
   }
   const offeredTools = triagePlan?.smalltalk || triagePlan?.handoff ? [] : selectConnectorTools(customTools, triagePlan);
   ```

   The `handoff` const must be declared before this block. Move `const handoff = {...}` (lines 1001–1004) up to just above it.

4. **Use `offeredTools` instead of `customTools`** in these three places only:
   - `buildSystemPrompt({... connectorNames: offeredTools.map((tool) => tool.name) })`;
   - the model call's `...customToolDefinitions(offeredTools)`;
   - `connectors_offered` in the success `logOutcome` meta.

   `customToolByName` keeps every tool, so a tool call the model still makes is executed as before.

5. **Small-talk path: no tools at all.** In the model call (lines 1107–1117), build the tools list once, before the iteration loop:

   ```ts
   const toolDefinitions = triagePlan?.smalltalk ? [] : [
     ...agentToolDefinitions(handoff),
     ...(isAdmin ? adminToolDefinitions : []),
     ...customToolDefinitions(offeredTools),
   ];
   ```

   In the payload, send `tools` and `tool_choice` only when `toolDefinitions.length` is non-zero:

   ```ts
   ...(toolDefinitions.length ? { tools: toolDefinitions, tool_choice: "auto" } : {}),
   ```

   When `triagePlan?.smalltalk` is set, also add `max_tokens: 200`.

6. **Hint.** Right after `const messages: any[] = [...]` (line 1060), insert:

   ```ts
   const hint = triageSystemHint(triagePlan);
   if (hint) messages.splice(1, 0, { role: "system", content: hint });
   ```

7. **Log.** Add to the `meta` of the success `logOutcome` call, the `no_reply_generated` call and both catch-block calls:

   ```ts
   triage: triage ? { outcome: triage.outcome, errors: triage.errors.length ? triage.errors : null } : null,
   ```

   `triage` must be declared with `let triage: TriageRun | null = null;` beside the other hoisted variables (lines 563–586), so the catch block can read it. Change the step-3 declaration to an assignment.

- [ ] **Step 5: Run the whole edge suite and the type check**

Run: `cd supabase/functions && deno test -A --no-check --node-modules-dir=none _shared/ ai-agent-reply/ && deno check ai-agent-reply/index.ts`
Expected: all PASS, and the check is clean.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(agent): Jev triage skips unneeded retrieval and narrows connectors" -- supabase/functions/ai-agent-reply/index.ts supabase/functions/ai-agent-reply/logic.ts supabase/functions/ai-agent-reply/triageHint.test.ts
```

(Adjust the test path to the file used in Step 1.)

---

### Task 5: Admin UI: triage switch and Jev model picker

**Files:**
- Modify: `supabase/functions/ai-config/index.ts`, the `list` action's settings filter (line 70).
- Modify: `src/hooks/ai-config/types.ts` (the `ModelCategory` union and the three category interfaces).
- Modify: `src/hooks/useAIConfiguration.ts` (`emptyCategoryDefaults`, `emptyCategoryFallbacks`, `MODEL_CATEGORIES`).
- Create: `src/hooks/ai-config/useAgentTriageEnabled.ts`
- Modify: `src/components/admin/AdminAiAgentSection.tsx`
- Test: `src/hooks/__tests__/useAIConfiguration.test.ts` (parse test) and `src/components/admin/__tests__/AdminAiAgentSection.test.tsx` (create if absent).

**Interfaces:**
- Consumes: the `DefaultModelSelector` props (`category`, `capability`, `providers`, `models`, `currentDefault/Fallback/Fallback2`, `onSetDefault/Fallback/Fallback2`, `isSaving`), and `useSetDefaultModel`, `useSetFallbackModel`, `useSetFallback2Model` with `{ provider_code, model_id, category }`.
- Produces:
  - `ModelCategory` includes `'agent_triage'`;
  - `useAgentTriageEnabled(): { enabled: boolean; setEnabled: (on: boolean) => Promise<void>; isSaving: boolean }`.

- [ ] **Step 1: Write the failing tests**

In `src/hooks/__tests__/useAIConfiguration.test.ts`, add:

```ts
it('routes the agent triage slots to their own category, not to agent', () => {
  const parsed = parseSettingsRows([
    { key: 'default_ai_model_agent', value: { provider_code: 'vercel', model_id: 'openai/gpt-5-mini' } },
    { key: 'default_ai_model_agent_triage', value: { provider_code: 'openrouter', model_id: 'typesafe/jev-1.13' } },
    { key: 'default_ai_model_agent_triage_fallback', value: { provider_code: 'vercel', model_id: 'typesafe-ai/jev' } },
  ]);
  expect(parsed.categoryDefaults.agent?.model_id).toBe('openai/gpt-5-mini');
  expect(parsed.categoryDefaults.agent_triage?.model_id).toBe('typesafe/jev-1.13');
  expect(parsed.categoryFallbacks.agent_triage?.model_id).toBe('typesafe-ai/jev');
});
```

Create `src/components/admin/__tests__/AdminAiAgentSection.test.tsx`. Mock `@/hooks/useAIConfiguration` so it returns:
- one `openrouter` provider;
- one model `{ model_id: 'typesafe/jev-1.13', capabilities: ['triage'], is_active: true, provider_id: <that provider's id>, ai_providers: { provider_code: 'openrouter' } }`;
- one chat model.

Also mock `@/hooks/ai-config/useAgentTriageEnabled` so it returns `{ enabled: false, setEnabled, isSaving: false }`. Then assert:
- the text `Reply triage (Jev)` renders;
- clicking the switch with role `switch` and name `/triage/i` calls `setEnabled(true)`.

Follow the mocking style in `src/components/admin/settings/ai/__tests__/SyncModelsButton.test.tsx`. Use `fireEvent`, not `userEvent` (see the project's frontend test conventions).

- [ ] **Step 2: Run and see it fail**

Run: `node_modules/.bin/vitest run src/hooks/__tests__/useAIConfiguration.test.ts src/components/admin/__tests__/AdminAiAgentSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. In `ai-config/index.ts` line 70, change the filter to:

   ```ts
   .or('key.like.default_ai_model%,key.like.model_catalog_synced_at_%,key.eq.agent_triage_enabled')
   ```

   Update the comment above it to mention `agent_triage_enabled`.

2. In `types.ts`, add `'agent_triage'` to `ModelCategory`, and `agent_triage: DefaultModel | null;` to `CategoryDefaults`, `CategoryFallbacks` and `CategoryFallbacks2`.

3. In `useAIConfiguration.ts`, add `agent_triage: null` to both empty objects, and `'agent_triage'` to `MODEL_CATEGORIES`. It must go **before** `'agent'`: the loop `break`s on the first exact match, and exact matching makes the order safe, but keeping the longer key first mirrors the file's suffix-order rule.

4. Create `useAgentTriageEnabled.ts`:

   ```ts
   import { useMutation, useQueryClient } from '@tanstack/react-query';
   import { supabase } from '@/integrations/supabase/client';
   import { useAIConfiguration } from '@/hooks/useAIConfiguration';

   const KEY = 'agent_triage_enabled';

   // Read through the ai-config list (its settings filter includes this key) and written
   // the same way the model-slot hooks write system_settings.
   export function useAgentTriageEnabled() {
     const { data } = useAIConfiguration();
     const queryClient = useQueryClient();
     const row = data?.settings.find((s: { key: string }) => s.key === KEY) as { value?: { enabled?: unknown } } | undefined;
     const mutation = useMutation({
       mutationFn: async (on: boolean) => {
         const { error } = await supabase
           .from('system_settings' as never)
           .upsert({ key: KEY, value: { enabled: on }, updated_at: new Date().toISOString() } as never, { onConflict: 'key' } as never);
         if (error) throw error;
       },
       onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-config'] }),
     });
     return { enabled: row?.value?.enabled === true, setEnabled: (on: boolean) => mutation.mutateAsync(on), isSaving: mutation.isPending };
   }
   ```

   Check the shape of `data.settings` in `src/hooks/ai-config/types.ts` (`AIConfigData.settings`) and type the `find` with it instead of the inline cast, if a type exists.

5. In `AdminAiAgentSection.tsx`, below the existing `DefaultModelSelector`, add a `Separator` and then:
   - a row with a `Switch` (`aria-label="Reply triage (Jev)"`) bound to `useAgentTriageEnabled`, with the label **Reply triage (Jev)** and the help text: "A fast decision model reads each message first and skips work it does not need: the knowledge search, unused connectors, or tools for small talk. It never writes replies. If it is unsure or unavailable, replies run as before."
   - a second `DefaultModelSelector` with:

     ```tsx
     category="agent_triage"
     capability="triage"
     title="Triage model"
     description="TypeSafe Jev via OpenRouter or Vercel. Sync those providers to list it."
     providers={triageProviders}   // aiConfig.providers filtered to ['openrouter', 'vercel']
     currentDefault={aiConfig?.categoryDefaults.agent_triage ?? null}
     currentFallback={aiConfig?.categoryFallbacks.agent_triage ?? null}
     currentFallback2={aiConfig?.categoryFallbacks2.agent_triage ?? null}
     ```

     The `onSet*` handlers are the same as the agent selector's, with `category: "agent_triage"`.
   - Use `toast` from `sonner` for switch success and failure, as the neighbouring cards do.

- [ ] **Step 4: Run and see it pass, then type-check**

Run: `node_modules/.bin/vitest run src/hooks/__tests__/useAIConfiguration.test.ts src/components/admin/__tests__/AdminAiAgentSection.test.tsx src/components/admin && node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
Expected: PASS, with no new tsc errors (compare against `origin/main` if the baseline already has errors).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(admin): Jev triage switch and model picker in AI Agent settings" -- supabase/functions/ai-config/index.ts src/hooks/ai-config/types.ts src/hooks/useAIConfiguration.ts src/hooks/ai-config/useAgentTriageEnabled.ts src/components/admin/AdminAiAgentSection.tsx src/hooks/__tests__/useAIConfiguration.test.ts src/components/admin/__tests__/AdminAiAgentSection.test.tsx
```

---

## After all tasks (controller)

1. Final whole-branch review, then the guard passes (`clean-code-guard`, `test-guard`).
2. Open a PR and merge. Dokploy deploys the edge functions and the frontend. No migration is needed.
3. Run the OpenRouter and Vercel syncs. Expect the Jev rows to appear with capability `triage`.
4. Live check with the dry-run sandbox, using a minted admin JWT:
   - Set the triage slots and switch it on for the test.
   - Send "hi", "how much is X", and "I want to talk to a person".
   - Confirm each `system_logs.metadata.triage` shows a plan, and compare `latency_ms` with triage off.
   - Restore the switch to the state the user wants.
5. mem0 plus the final report.
