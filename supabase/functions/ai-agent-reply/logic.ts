// Pure decision logic for the AI agent reply pipeline. No Deno or network
// imports here — this module is unit-tested from the frontend vitest suite.

export type EngagementMode = "ai_first" | "human_first" | "human_then_ai";
export type ReplyLanguage = "ar" | "en";
export type LanguageMode = "auto" | ReplyLanguage;

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

export interface SystemPromptParams {
  persona: string | null;
  language: ReplyLanguage;
  knowledgeBlocks: string[];
  nowIso: string;
}

export function buildSystemPrompt(params: SystemPromptParams): string {
  const languageInstruction = params.language === "ar"
    ? "Reply in Arabic (العربية)."
    : "Reply in English.";
  const knowledge = params.knowledgeBlocks.length
    ? params.knowledgeBlocks.map((block, index) => `[${index + 1}] ${block}`).join("\n\n")
    : "(no business knowledge matched this message)";

  return [
    `Current date/time (UTC): ${params.nowIso}`,
    "You are a customer-service assistant answering on WhatsApp for a business.",
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
