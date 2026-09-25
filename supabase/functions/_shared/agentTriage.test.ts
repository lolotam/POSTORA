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

// Task 3 tests
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
