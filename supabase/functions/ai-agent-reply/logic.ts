// Pure decision logic for the AI agent reply pipeline. No Deno or network
// imports here — this module is unit-tested from the frontend vitest suite.

export type EngagementMode = "ai_first" | "human_first" | "human_then_ai";
export type ReplyLanguage = "ar" | "en";
export type LanguageMode = "auto" | ReplyLanguage;

// Gemini similarity scores are compressed. The documented live calibration
// placed irrelevant matches at 0.52 and relevant ones at 0.62.
export const SIMILARITY_FLOOR = 0.55;

const ARABIC_CHAR_RE = /[؀-ۿ]/g;
const LATIN_CHAR_RE = /[A-Za-z]/g;

export function detectReplyLanguage(inboundText: string, languageMode: LanguageMode): ReplyLanguage {
  if (languageMode === "ar" || languageMode === "en") return languageMode;
  const arabicCount = (inboundText.match(ARABIC_CHAR_RE) || []).length;
  const latinCount = (inboundText.match(LATIN_CHAR_RE) || []).length;
  return arabicCount > latinCount ? "ar" : "en";
}

export function resolveEngagementMode(override: string | null | undefined, defaultMode: string): EngagementMode {
  const modes: EngagementMode[] = ["ai_first", "human_first", "human_then_ai"];
  if (override && modes.includes(override as EngagementMode)) return override as EngagementMode;
  if (modes.includes(defaultMode as EngagementMode)) return defaultMode as EngagementMode;
  return "human_then_ai";
}

// Providers the reply engine has chat-completion endpoints for (see
// PROVIDER_ENDPOINTS in index.ts). "gemini" is the ai_providers catalog
// code for Google; "google" is kept for values stored before that mapping.
export const KNOWN_MODEL_PROVIDERS = ["openai", "openrouter", "google", "gemini"] as const;

export interface ModelRef {
  provider: string;
  model: string;
}

// Allow-list values are stored as "provider/model_id"; legacy configs hold
// bare OpenAI model ids. OpenRouter model ids contain "/" themselves
// (e.g. "openrouter/anthropic/claude-3.5-haiku"), so only the first segment
// is treated as a provider — and only when it names a known provider.
export function parseModelRef(value: string): ModelRef {
  const separator = value.indexOf("/");
  if (separator > 0) {
    const prefix = value.slice(0, separator);
    if ((KNOWN_MODEL_PROVIDERS as readonly string[]).includes(prefix)) {
      return { provider: prefix, model: value.slice(separator + 1) };
    }
  }
  return { provider: "openai", model: value };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export interface GraphRelationFact {
  source_name: string;
  source_type: string;
  relation: string;
  target_name: string;
  target_type: string;
}

export function formatRelatedFacts(facts: GraphRelationFact[]): string {
  if (!facts.length) return "";
  return [
    "Related facts:",
    ...facts.map((fact) => `- ${fact.source_name} ${fact.relation} ${fact.target_name}`),
  ].join("\n");
}

export interface ReplyGateParams {
  mode: EngagementMode;
  humanAssignedAndOnline: boolean;
  withinServiceWindow: boolean;
  cooldownActive: boolean;
  dailyCapReached: boolean;
}

export function shouldAiReply(params: ReplyGateParams): { reply: boolean; reason: string } {
  if (params.mode === "human_first") return { reply: false, reason: "mode_human_first" };
  if (params.mode === "human_then_ai" && params.humanAssignedAndOnline) {
    return { reply: false, reason: "human_agent_active" };
  }
  if (!params.withinServiceWindow) return { reply: false, reason: "outside_service_window" };
  if (params.cooldownActive) return { reply: false, reason: "cooldown_active" };
  if (params.dailyCapReached) return { reply: false, reason: "daily_cap_reached" };
  return { reply: true, reason: "ok" };
}

export interface EscalationAgentCandidate {
  id: string;
  user_id: string;
  status: string;
  current_conversations: number | null;
}

// Prefers the business owner's own agent when online; otherwise the online
// agent with the lightest load. Returns null when nobody is online.
export function pickEscalationAgent(
  agents: EscalationAgentCandidate[],
  ownerUserId: string,
): EscalationAgentCandidate | null {
  const online = agents.filter((agent) => agent.status === "online");
  if (!online.length) return null;
  const owner = online.find((agent) => agent.user_id === ownerUserId);
  if (owner) return owner;
  return [...online].sort(
    (a, b) => (a.current_conversations ?? 0) - (b.current_conversations ?? 0),
  )[0];
}

// Graph API "to" field wants bare digits (the webhook's `from` field format),
// while admin numbers are stored E.164 with a leading plus.
export function waRecipient(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export interface SystemPromptParams {
  persona: string | null;
  language: ReplyLanguage;
  knowledgeBlocks: string[];
  nowIso: string;
  isAdmin?: boolean;
}

export function buildSystemPrompt(params: SystemPromptParams): string {
  const languageInstruction = params.language === "ar"
    ? "Reply in Arabic (العربية)."
    : "Reply in English.";
  const knowledge = params.knowledgeBlocks.length
    ? params.knowledgeBlocks.map((block, index) => `[${index + 1}] ${block}`).join("\n\n")
    : "(no business knowledge matched this message)";

  const adminInstruction = params.isAdmin
    ? [
      "IMPORTANT: You are talking to the BUSINESS ADMIN (verified number), not a customer.",
      "You may use the operational tools: list_connected_accounts, search_posts, get_posting_summary, create_scheduled_post.",
      "Before create_scheduled_post, always confirm the exact caption, platforms, and time with the admin and wait for their yes.",
    ].join("\n")
    : "";

  return [
    `Current date/time (UTC): ${params.nowIso}`,
    "You are a customer-service assistant answering on WhatsApp for a business.",
    adminInstruction,
    params.persona ? `Business persona and instructions:\n${params.persona}` : "",
    languageInstruction,
    "Rules:",
    "- Answer ONLY from the business knowledge below plus general courtesy. Never invent prices, availability, or policies.",
    "- If the knowledge does not contain the answer, say you will check with the team, and use the escalate_to_human tool.",
    "- If the customer asks for a person/human/agent, use the escalate_to_human tool and tell them someone will follow up.",
    "- Use the search_knowledge tool to look up product or policy details before saying something is unavailable.",
    "- Keep replies short and WhatsApp-friendly (a few sentences, no markdown headings).",
    "Business knowledge:",
    knowledge,
  ].filter(Boolean).join("\n\n");
}
