// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  INTENTS, NO_TOOL, parseTriageAnswers, planFromAnswers, selectConnectorTools, triageEndpoint, triageRequestBody,
  type TriageAnswers, type TriageInput,
} from "./agentTriage.ts";

const input: TriageInput = {
  message: "how much is the large box?",
  history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello! How can I help?" }],
  connectors: [{ name: "store_catalog", description: "Products and prices" }],
  askHandoff: true,
};

Deno.test("each provider gets its own endpoint and yes/no question type", () => {
  const router = triageRequestBody({ provider: "openrouter", model: "typesafe/jev-1.13", kind: "decision" }, input);
  const gateway = triageRequestBody({ provider: "vercel", model: "typesafe-ai/jev", kind: "decision" }, input);
  const q = (body: Record<string, unknown>) => body.questions as Record<string, { type: string }>;
  assertEquals(q(router).needs_knowledge.type, "noul");
  assertEquals(q(gateway).needs_knowledge.type, "boolean");
  assertEquals(q(router).connector.type, "choice");
  assertEquals(router.model, "typesafe/jev-1.13");
  assertEquals(triageEndpoint("openrouter"), "https://openrouter.ai/api/v1/systemone");
  assertEquals(triageEndpoint("vercel"), "https://ai-gateway.vercel.sh/v1/evaluate");
});

Deno.test("the connector question lists each connector plus a no-tool option, and is omitted without connectors", () => {
  const withTools = triageRequestBody({ provider: "vercel", model: "m", kind: "decision" }, input);
  const criteria = (withTools.questions as any).connector.criteria;
  assertEquals(Object.keys(criteria).sort(), [NO_TOOL, "store_catalog"]);
  const bare = triageRequestBody({ provider: "vercel", model: "m", kind: "decision" }, { ...input, connectors: [], askHandoff: false });
  assertEquals(Object.keys(bare.questions as object).sort(), ["intent", "needs_knowledge", "smalltalk"]);
});

Deno.test("the request carries an intent choice question with exactly the seven intents", () => {
  const body = triageRequestBody({ provider: "vercel", model: "m", kind: "decision" }, input);
  const intent = (body.questions as Record<string, { type: string; criteria: Record<string, string> }>).intent;
  assertEquals(intent.type, "choice");
  assertEquals(Object.keys(intent.criteria), [...INTENTS]);
});

Deno.test("the state carries the recent turns and the message, bounded in size", () => {
  const body = triageRequestBody({ provider: "vercel", model: "m", kind: "decision" }, { ...input, message: "x".repeat(20_000) });
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
  const expected: TriageAnswers = { needsKnowledge: 0.9, smalltalk: 0.05, handoff: null, intent: null,
    connector: { choice: "store_catalog", confidence: 0.93 } };
  assertEquals(router, expected);
  assertEquals(gateway, expected);
});

Deno.test("a confident known intent parses; the confidence stays attached", () => {
  const parsed = parseTriageAnswers("vercel", { answers: {
    intent: { type: "choice", choice: "pricing", confidence: 0.91 },
  } });
  assertEquals(parsed.intent, { choice: "pricing", confidence: 0.91 });
});

Deno.test("triage accepts a confident booking intent", () => {
  const parsed = parseTriageAnswers("vercel", { answers: {
    intent: { type: "choice", choice: "booking", confidence: 0.9 },
  } });
  assertEquals(parsed.intent, { choice: "booking", confidence: 0.9 });
});

Deno.test("an intent outside the contract parses to null", () => {
  for (const intent of [
    { choice: "spam", confidence: 0.99 }, // unknown choice
    { choice: "pricing", confidence: NaN }, // NaN confidence
    { choice: "pricing", confidence: 1.5 }, // above 1
    { choice: "pricing", confidence: -0.1 }, // below 0
  ]) {
    const parsed = parseTriageAnswers("vercel", { answers: { intent } });
    assertEquals(parsed.intent, null, JSON.stringify(intent));
  }
  // A missing answer is the same as an unusable one.
  assertEquals(parseTriageAnswers("vercel", { answers: {} }).intent, null);
});

Deno.test("only confident answers change the plan", () => {
  const names = ["store_catalog", "crm"];
  const unsure = planFromAnswers({ needsKnowledge: 0.5, smalltalk: 0.6, handoff: 0.7, intent: null,
    connector: { choice: "crm", confidence: 0.6 } }, names);
  assertEquals(unsure, { skipKnowledge: false, smalltalk: false, handoff: false, connectors: "all" });
  const sure = planFromAnswers({ needsKnowledge: 0.1, smalltalk: 0.02, handoff: 0.01, intent: null,
    connector: { choice: "crm", confidence: 0.95 } }, names);
  assertEquals(sure, { skipKnowledge: true, smalltalk: false, handoff: false, connectors: ["crm"] });
});

Deno.test("small talk and handoff take precedence over connector routing", () => {
  const names = ["crm"];
  const hi = planFromAnswers({ needsKnowledge: 0.4, smalltalk: 0.97, handoff: 0.01, intent: null,
    connector: { choice: "crm", confidence: 0.9 } }, names);
  assertEquals(hi, { skipKnowledge: true, smalltalk: true, handoff: false, connectors: [] });
  const human = planFromAnswers({ needsKnowledge: 0.9, smalltalk: 0.01, handoff: 0.92, intent: null,
    connector: { choice: "crm", confidence: 0.9 } }, names);
  assertEquals(human, { skipKnowledge: true, smalltalk: false, handoff: true, connectors: [] });
});

Deno.test("a confident no-tool choice offers no connectors; an unknown name offers all", () => {
  const none = planFromAnswers({ needsKnowledge: null, smalltalk: null, handoff: null, intent: null,
    connector: { choice: NO_TOOL, confidence: 0.9 } }, ["crm"]);
  assertEquals(none.connectors, []);
  const unknown = planFromAnswers({ needsKnowledge: null, smalltalk: null, handoff: null, intent: null,
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
    { provider: "openrouter", model: "typesafe/jev-1.13", kind: "decision" },
    { provider: "vercel", model: "typesafe-ai/jev", kind: "decision" },
  ]);
  assertEquals(TRIAGE_SETTING_KEYS.includes("agent_triage_enabled"), true);
});

const okJson = { answers: { needs_knowledge: { type: "boolean", probability: 0.05 },
  smalltalk: { type: "boolean", probability: 0.02 } } };
const tiers = [
  { provider: "openrouter", model: "a", kind: "decision" as const },
  { provider: "vercel", model: "b", kind: "decision" as const },
];
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

Deno.test("two tiers on the same provider resolve its key once", async () => {
  const sameProviderTiers = [
    { provider: "openrouter", model: "a", kind: "decision" as const },
    { provider: "openrouter", model: "b", kind: "decision" as const },
  ];
  let keyCalls = 0;
  const countingKey = () => { keyCalls += 1; return Promise.resolve("k"); };
  const fetchImpl = (() => Promise.resolve(new Response("{}", { status: 500 }))) as typeof fetch;
  const run = await runTriage(sameProviderTiers, input, countingKey, 1500, fetchImpl);
  assertEquals(keyCalls, 1);
  assertEquals(run.errors.length, 2);
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

// Regression 2026-09-30: a cold Vercel call held the whole 1.5 s budget and no fallback ran.
Deno.test("a hanging first tier is cut at 0.9 s so the fallback still answers inside the budget", async () => {
  const fetchImpl = ((url: string, init?: RequestInit) => {
    if (url.includes("vercel")) return Promise.resolve(new Response(JSON.stringify(okJson), { status: 200 }));
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as typeof fetch;
  const startedAt = Date.now();

  const run = await runTriage(tiers, input, key, 1500, fetchImpl);

  assertEquals(run.outcome?.provider, "vercel");
  assertEquals(run.errors, [{ model: "openrouter/a", error: "TimeoutError" }]);
  const elapsed = Date.now() - startedAt;
  assertEquals(elapsed >= 850 && elapsed < 1400, true, `took ${elapsed} ms`);
});

// Regression 2026-09-25: with "I want a human" in the recent turns, a later "hi" was
// judged a handoff (0.97), because the question did not say which message it was about.
Deno.test("every yes/no question is about the new message, not the earlier turns", () => {
  const body = triageRequestBody({ provider: "openrouter", model: "m", kind: "decision" }, input);
  const questions = body.questions as Record<string, { type: string; instructions: string }>;
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "choice") continue;
    assertEquals(question.instructions.includes("new message"), true, name);
  }
});

// ---------------------------------------------------------------------------
// Chat-model tiers (2026-10-05): DeepSeek, Gemini or any OpenRouter chat model can
// take a triage slot, answering the same questions as strict JSON.
// ---------------------------------------------------------------------------
import {
  chatTriageRequestBody,
  parseChatTriageAnswers,
  TRIAGE_BUDGET_MS,
  TRIAGE_CHAT_BUDGET_MS,
  triageBudgetFor,
  type TriageChatCall,
} from "./agentTriage.ts";

const enabled = { key: "agent_triage_enabled", value: { enabled: true } };

Deno.test("a slot is a decision tier only when the catalogue says its model is a decision model", () => {
  const rows = [
    enabled,
    { key: "default_ai_model_agent_triage", value: slot("vercel", "typesafe-ai/jev") },
    { key: "default_ai_model_agent_triage_fallback", value: slot("openrouter", "mistralai/ministral-8b-2512") },
    { key: "default_ai_model_agent_triage_fallback_2", value: slot("deepseek", "deepseek-flash") },
  ];
  assertEquals(triageChainFromSettings(rows, new Set(["vercel/typesafe-ai/jev"])), [
    { provider: "vercel", model: "typesafe-ai/jev", kind: "decision" },
    { provider: "openrouter", model: "mistralai/ministral-8b-2512", kind: "chat" },
    { provider: "deepseek", model: "deepseek-flash", kind: "chat" },
  ]);
});

Deno.test("when the catalogue read fails, decision providers keep the decision API (Jev still works)", () => {
  const rows = [enabled, { key: "default_ai_model_agent_triage", value: slot("openrouter", "typesafe/jev-1.13") }];
  assertEquals(triageChainFromSettings(rows, null), [{ provider: "openrouter", model: "typesafe/jev-1.13", kind: "decision" }]);
});

Deno.test("a chat tier widens the budget; a decision-only chain keeps 1.5 s", () => {
  assertEquals(triageBudgetFor(tiers), TRIAGE_BUDGET_MS);
  assertEquals(triageBudgetFor([...tiers, { provider: "deepseek", model: "deepseek-flash", kind: "chat" }]), TRIAGE_CHAT_BUDGET_MS);
});

Deno.test("the chat prompt asks the decision questions as JSON, about the new message only", () => {
  const body = chatTriageRequestBody(input);
  assertEquals(body.response_format, { type: "json_object" });
  const messages = body.messages as Array<{ role: string; content: string }>;
  const system = messages[0].content;
  for (const field of ['"needs_knowledge"', '"smalltalk"', '"handoff"', '"intent"', '"connector"', '"no_tool"']) {
    assertEquals(system.includes(field), true, field);
  }
  assertEquals(messages[1].content.includes("Customer (new message): "), true);
  const bare = chatTriageRequestBody({ ...input, connectors: [], askHandoff: false }).messages as Array<{ content: string }>;
  assertEquals(bare[0].content.includes('"handoff"'), false);
  assertEquals(bare[0].content.includes('"connector"'), false);
});

Deno.test("a chat answer parses into the same answers shape; anything malformed is unsure, not a guess", () => {
  const answers = parseChatTriageAnswers(
    '```json\n{"needs_knowledge":0.92,"smalltalk":0.03,"handoff":0.01,"intent":{"choice":"pricing","confidence":0.9},' +
      '"connector":{"choice":"no_tool","confidence":0.85}}\n```',
  );
  assertEquals(answers, {
    needsKnowledge: 0.92, smalltalk: 0.03, handoff: 0.01,
    intent: { choice: "pricing", confidence: 0.9 },
    connector: { choice: "no_tool", confidence: 0.85 },
  });
  const wild = parseChatTriageAnswers('{"needs_knowledge":1.7,"smalltalk":"yes","intent":{"choice":"refund","confidence":0.99}}');
  assertEquals(wild, { needsKnowledge: null, smalltalk: null, handoff: null, connector: null, intent: null });
  assertEquals(parseChatTriageAnswers("Sure! Here is my analysis"), null);
  assertEquals(parseChatTriageAnswers("[1,2]"), null);
});

Deno.test("a chat tier answers through the caller's chat call and plans from its JSON", async () => {
  const chatTiers = [{ provider: "deepseek", model: "deepseek-flash", kind: "chat" as const }];
  const seen: Array<{ tier: string; timeoutMs: number }> = [];
  const callChat: TriageChatCall = (tier, _body, timeoutMs) => {
    seen.push({ tier: `${tier.provider}/${tier.model}`, timeoutMs });
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"needs_knowledge":0.02,"smalltalk":0.97,"intent":{"choice":"greeting","confidence":0.95}}' } }],
    }), { status: 200 }));
  };
  const run = await runTriage(chatTiers, input, key, undefined, (() => {
    throw new Error("the decision API must not be called");
  }) as unknown as typeof fetch, Date.now, callChat);
  assertEquals(run.outcome?.provider, "deepseek");
  assertEquals(run.outcome?.plan.smalltalk, true);
  assertEquals(seen, [{ tier: "deepseek/deepseek-flash", timeoutMs: TRIAGE_CHAT_BUDGET_MS }]);
});

Deno.test("a failing decision tier falls through to a chat tier; an unparseable chat answer falls through too", async () => {
  const mixed = [
    { provider: "vercel", model: "typesafe-ai/jev", kind: "decision" as const },
    { provider: "openrouter", model: "openai/gpt-5.4-nano", kind: "chat" as const },
    { provider: "openrouter", model: "mistralai/ministral-8b-2512", kind: "chat" as const },
  ];
  const fetchImpl = (() => Promise.resolve(new Response("{}", { status: 503 }))) as typeof fetch;
  const callChat: TriageChatCall = (tier) =>
    Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: tier.model.includes("nano") ? "I think it's pricing" : '{"smalltalk":0.01,"needs_knowledge":0.95}' } }],
    }), { status: 200 }));
  const run = await runTriage(mixed, input, key, undefined, fetchImpl, Date.now, callChat);
  assertEquals(run.outcome?.model, "mistralai/ministral-8b-2512");
  assertEquals(run.errors, [
    { model: "vercel/typesafe-ai/jev", error: "HTTP 503" },
    { model: "openrouter/openai/gpt-5.4-nano", error: "unparseable answer" },
  ]);
});

Deno.test("without a chat call a chat tier is recorded, not thrown", async () => {
  const run = await runTriage([{ provider: "deepseek", model: "deepseek-flash", kind: "chat" }], input, key);
  assertEquals(run.outcome, null);
  assertEquals(run.errors, [{ model: "deepseek/deepseek-flash", error: "chat triage unavailable" }]);
});
