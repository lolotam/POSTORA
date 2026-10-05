// Triage for the AI agent: one fast call that says which parts of the reply pipeline a
// message needs. Two kinds of tier answer the same questions:
//  - "decision": TypeSafe Jev on a decision API (about 0.4s), typed choices and
//    probabilities, never text.
//  - "chat": any fast chat model (DeepSeek, Gemini, OpenRouter...) asked for the same
//    answers as strict JSON (about 1s), so the ladder is not Jev all the way down.
// The chat model still writes every reply.
// Spec: docs/superpowers/specs/2026-09-25-jev-agent-triage-design.md,
//       docs/superpowers/specs/2026-10-05-vision-ladder-and-model-cleanup.md (Phase C)

/** Providers that serve the decision API. */
export type TriageProvider = "openrouter" | "vercel";
export type TriageKind = "decision" | "chat";
export interface TriageTier { provider: string; model: string; kind: TriageKind }
export interface TriageConnector { name: string; description: string }
export interface TriageInput {
  message: string;
  history: Array<{ role: string; content: string }>;
  connectors: TriageConnector[];
  askHandoff: boolean;
}
/** What the customer wants, from the new message. Drives the WhatsApp intent labels. */
export const INTENTS = ["pricing", "order_status", "complaint", "lead", "booking", "greeting", "other"] as const;
export type Intent = typeof INTENTS[number];
export interface TriageAnswers {
  needsKnowledge: number | null;
  smalltalk: number | null;
  handoff: number | null;
  connector: { choice: string; confidence: number } | null;
  intent: { choice: Intent; confidence: number } | null;
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

export function triageRequestBody(tier: TriageTier & { provider: TriageProvider }, input: TriageInput): Record<string, unknown> {
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
      "In the new message, the customer explicitly asks to talk to a human person instead of the assistant.",
    );
  }
  questions.intent = {
    type: "choice",
    instructions: "What does the customer want in the new message?",
    criteria: {
      pricing: "Asks about a price, cost, offer or discount",
      order_status: "Asks where an order is, about delivery status or tracking",
      complaint: "Unhappy, reports a problem, or wants a refund or return",
      lead: "Shows buying interest: wants to order, subscribe or be contacted",
      booking: "Wants to book, reserve or schedule an appointment or service",
      greeting: "Only greets, thanks or acknowledges",
      other: "Anything else",
    },
  };
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
  const intent = answers.intent as { choice?: unknown; confidence?: unknown } | undefined;
  // An intent outside the seven choices, or a confidence that is not a finite
  // probability in [0, 1], is no intent at all: the caller labels nothing.
  const usableIntent = typeof intent?.choice === "string" && INTENTS.includes(intent.choice as Intent) &&
      typeof intent.confidence === "number" && Number.isFinite(intent.confidence) &&
      intent.confidence >= 0 && intent.confidence <= 1
    ? { choice: intent.choice as Intent, confidence: intent.confidence }
    : null;
  return {
    needsKnowledge: probability(answers.needs_knowledge, field),
    smalltalk: probability(answers.smalltalk, field),
    handoff: probability(answers.handoff, field),
    connector: typeof connector?.choice === "string" && typeof connector.confidence === "number"
      ? { choice: connector.choice, confidence: connector.confidence }
      : null,
    intent: usableIntent,
  };
}

// ========== Chat-model tiers ==========

const CHAT_TRIAGE_SYSTEM =
  "You route customer messages for a business's messaging assistant. Do NOT answer the customer. " +
  "Read the conversation and return ONLY a JSON object with these fields, where every probability " +
  "is a number from 0 to 1:\n";

/**
 * The same questions the decision API answers, asked of a chat model as strict JSON.
 * Field names match the decision API's so one parser shape serves both.
 */
export function chatTriageRequestBody(input: TriageInput): Record<string, unknown> {
  const fields = [
    '"needs_knowledge": probability that answering needs facts about this business (products, prices, policies, hours, services)',
    '"smalltalk": probability that the new message is only a greeting, thanks, acknowledgement or emoji',
  ];
  if (input.askHandoff) {
    fields.push('"handoff": probability that the customer explicitly asks to talk to a human person');
  }
  fields.push(
    `"intent": {"choice": one of ${INTENTS.map((i) => `"${i}"`).join(", ")}, "confidence": probability}`,
  );
  if (input.connectors.length) {
    const tools = [`"${NO_TOOL}" (no connected tool is needed)`, ...input.connectors.map((c) =>
      `"${c.name}" (${(c.description || c.name).slice(0, MAX_CRITERION_CHARS)})`
    )];
    fields.push(`"connector": {"choice": one of ${tools.join(", ")}, "confidence": probability}`);
  }
  return {
    temperature: 0,
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CHAT_TRIAGE_SYSTEM + fields.map((f) => `- ${f}`).join("\n") },
      { role: "user", content: triageState(input) },
    ],
  };
}

const unitProbability = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

/**
 * A chat model's JSON reply as TriageAnswers. Anything malformed becomes null, which the
 * plan treats as "unsure" -- that part of the pipeline then runs exactly as without triage.
 */
export function parseChatTriageAnswers(content: string): TriageAnswers | null {
  const unfenced = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(unfenced);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const choice = (raw: unknown) => {
    const pick = raw as { choice?: unknown; confidence?: unknown } | undefined;
    const confidence = unitProbability(pick?.confidence);
    return typeof pick?.choice === "string" && confidence !== null ? { choice: pick.choice, confidence } : null;
  };
  const intent = choice(parsed.intent);
  return {
    needsKnowledge: unitProbability(parsed.needs_knowledge),
    smalltalk: unitProbability(parsed.smalltalk),
    handoff: unitProbability(parsed.handoff),
    connector: choice(parsed.connector),
    intent: intent && INTENTS.includes(intent.choice as Intent)
      ? { choice: intent.choice as Intent, confidence: intent.confidence }
      : null,
  };
}

/** OpenAI-compatible message content: a string, or an array of text parts on some models. */
function chatContent(json: unknown): string {
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> } | null)
    ?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
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
/**
 * A chain with a chat tier gets a wider budget: fast chat models answered the triage
 * prompt in 0.8-1.5s on 2026-10-05 (ministral-8b, gpt-5.4-nano, gemini-3.1-flash-lite,
 * deepseek-flash), against Jev's ~0.4s. Knowledge retrieval runs concurrently, so only
 * the part beyond it is added to the reply.
 */
export const TRIAGE_CHAT_BUDGET_MS = 3000;
// A slow first tier used to spend the whole budget: on 2026-09-30 a cold Vercel call
// timed out at 1521 ms and neither fallback ran. Capping it leaves the rest for them.
const FIRST_TIER_CAP_MS: Record<TriageKind, number> = { decision: 900, chat: 1800 };

export function triageBudgetFor(tiers: TriageTier[]): number {
  return tiers.some((tier) => tier.kind === "chat") ? TRIAGE_CHAT_BUDGET_MS : TRIAGE_BUDGET_MS;
}
const ENABLED_KEY = "agent_triage_enabled";
const SLOT_KEYS = [
  "default_ai_model_agent_triage",
  "default_ai_model_agent_triage_fallback",
  "default_ai_model_agent_triage_fallback_2",
] as const;
export const TRIAGE_SETTING_KEYS: readonly string[] = [ENABLED_KEY, ...SLOT_KEYS];

export interface TriageOutcome {
  provider: string;
  model: string;
  latencyMs: number;
  answers: TriageAnswers;
  plan: TriagePlan;
}
export interface TriageRun { outcome: TriageOutcome | null; errors: Array<{ model: string; error: string }> }

export const isTriageProvider = (code: unknown): code is TriageProvider => code === "openrouter" || code === "vercel";

/** The configured slots, in order, before each is classified. */
export function triageSlotsFromSettings(rows: Array<{ key: string; value: unknown }>): Array<{ provider: string; model: string }> {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  if ((byKey.get(ENABLED_KEY) as { enabled?: unknown } | undefined)?.enabled !== true) return [];
  const slots: Array<{ provider: string; model: string }> = [];
  for (const key of SLOT_KEYS) {
    const slotValue = byKey.get(key) as { provider_code?: unknown; model_id?: unknown } | undefined;
    if (typeof slotValue?.provider_code === "string" && slotValue.provider_code &&
      typeof slotValue.model_id === "string" && slotValue.model_id) {
      slots.push({ provider: slotValue.provider_code, model: slotValue.model_id });
    }
  }
  return slots;
}

/**
 * Off unless an admin switched it on. A slot is a decision tier when its model is a
 * decision model (catalogue capability `triage`, which only the decision API serves) on
 * a decision provider; every other slot is a chat tier. `decisionModels` holds
 * "provider/model" keys; when the catalogue read failed it is null, and the pre-chat
 * rule applies -- decision providers are decision tiers, so Jev keeps working.
 */
export function triageChainFromSettings(
  rows: Array<{ key: string; value: unknown }>,
  decisionModels: ReadonlySet<string> | null = null,
): TriageTier[] {
  return triageSlotsFromSettings(rows)
    // Claude speaks the Anthropic Messages API, not chat-completions JSON mode; a slot
    // naming it stays ignored, as every non-decision slot was before chat tiers.
    .filter(({ provider }) => provider !== "claude")
    .map(({ provider, model }): TriageTier => {
      const decision = isTriageProvider(provider) &&
        (decisionModels === null || decisionModels.has(`${provider}/${model}`));
      return { provider, model, kind: decision ? "decision" : "chat" };
    });
}

/** Sends a chat-completions body to one chat tier. Supplied by the caller (it owns keys and endpoints). */
export type TriageChatCall = (tier: TriageTier, body: Record<string, unknown>, timeoutMs: number) => Promise<Response>;

// Never throws: every failure is recorded and the caller runs today's pipeline.
export async function runTriage(
  tiers: TriageTier[],
  input: TriageInput,
  resolveKey: (providerCode: TriageProvider) => Promise<string | null>,
  budgetMs = triageBudgetFor(tiers),
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  callChat: TriageChatCall | null = null,
): Promise<TriageRun> {
  const startedAt = now();
  const errors: TriageRun["errors"] = [];
  // Memoized per provider: two tiers on the same provider (primary + fallback)
  // must resolve its key once, not once per tier.
  const keyCache = new Map<TriageProvider, Promise<string | null>>();
  const resolveCachedKey = (provider: TriageProvider): Promise<string | null> => {
    let cached = keyCache.get(provider);
    if (!cached) {
      cached = resolveKey(provider);
      keyCache.set(provider, cached);
    }
    return cached;
  };
  for (const [index, tier] of tiers.entries()) {
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0) break;
    const firstWithFallbacks = index === 0 && tiers.length > 1;
    const timeoutMs = firstWithFallbacks ? Math.min(remaining, FIRST_TIER_CAP_MS[tier.kind]) : remaining;
    const label = `${tier.provider}/${tier.model}`;
    if (tier.kind === "chat") {
      if (!callChat) {
        errors.push({ model: label, error: "chat triage unavailable" });
        continue;
      }
      try {
        const response = await callChat(tier, chatTriageRequestBody(input), timeoutMs);
        if (!response.ok) {
          errors.push({ model: label, error: `HTTP ${response.status}` });
          continue;
        }
        const answers = parseChatTriageAnswers(chatContent(await response.json()));
        if (!answers) {
          errors.push({ model: label, error: "unparseable answer" });
          continue;
        }
        const plan = planFromAnswers(answers, input.connectors.map((c) => c.name));
        return { outcome: { provider: tier.provider, model: tier.model, latencyMs: now() - startedAt, answers, plan }, errors };
      } catch (error) {
        errors.push({ model: label, error: error instanceof Error ? error.name : "error" });
      }
      continue;
    }
    const decisionProvider = tier.provider as TriageProvider;
    try {
      const key = await resolveCachedKey(decisionProvider);
      if (!key) {
        errors.push({ model: label, error: "no API key" });
        continue;
      }
      const response = await fetchImpl(triageEndpoint(decisionProvider), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(triageRequestBody({ ...tier, provider: decisionProvider }, input)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        errors.push({ model: label, error: `HTTP ${response.status}` });
        continue;
      }
      const answers = parseTriageAnswers(decisionProvider, await response.json());
      const plan = planFromAnswers(answers, input.connectors.map((c) => c.name));
      return { outcome: { provider: tier.provider, model: tier.model, latencyMs: now() - startedAt, answers, plan }, errors };
    } catch (error) {
      errors.push({ model: label, error: error instanceof Error ? error.name : "error" });
    }
  }
  return { outcome: null, errors };
}
