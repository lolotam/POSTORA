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

// ========== Task 3: Triage runtime ==========

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
