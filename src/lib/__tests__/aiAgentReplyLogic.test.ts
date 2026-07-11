import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  detectReplyLanguage,
  pickEscalationAgent,
  resolveEngagementMode,
  shouldAiReply,
  waRecipient,
  type EscalationAgentCandidate,
  type ReplyGateParams,
} from "../../../supabase/functions/ai-agent-reply/logic";

describe("detectReplyLanguage", () => {
  it.each([
    ["كم سعر التوصيل؟", "auto", "ar"],
    ["How much is delivery?", "auto", "en"],
    ["price سعر التوصيل والشحن", "auto", "ar"],
    ["السعر for the blue one please and thank you", "auto", "en"],
    ["", "auto", "en"],
  ] as const)("detects %j with mode %s as %s", (text, mode, expected) => {
    expect(detectReplyLanguage(text, mode)).toBe(expected);
  });

  it("forces English on Arabic text when language_mode is en", () => {
    expect(detectReplyLanguage("كم السعر؟", "en")).toBe("en");
  });

  it("forces Arabic on English text when language_mode is ar", () => {
    expect(detectReplyLanguage("How much?", "ar")).toBe("ar");
  });
});

describe("resolveEngagementMode", () => {
  it("prefers a valid conversation override over the default", () => {
    expect(resolveEngagementMode("ai_first", "human_first")).toBe("ai_first");
  });

  it("falls back to the default when the override is missing", () => {
    expect(resolveEngagementMode(null, "human_first")).toBe("human_first");
    expect(resolveEngagementMode(undefined, "ai_first")).toBe("ai_first");
  });

  it("falls back to human_then_ai when both values are invalid", () => {
    expect(resolveEngagementMode("bogus", "also-bogus")).toBe("human_then_ai");
  });
});

describe("shouldAiReply", () => {
  const openGate: ReplyGateParams = {
    mode: "ai_first",
    humanAssignedAndOnline: false,
    withinServiceWindow: true,
    cooldownActive: false,
    dailyCapReached: false,
  };

  it("replies when the gate is fully open", () => {
    expect(shouldAiReply(openGate)).toEqual({ reply: true, reason: "ok" });
  });

  it("never replies in human_first mode, even with no human online", () => {
    expect(shouldAiReply({ ...openGate, mode: "human_first" }).reply).toBe(false);
    expect(shouldAiReply({ ...openGate, mode: "human_first" }).reason).toBe("mode_human_first");
  });

  it("stays silent in human_then_ai mode while an online human is assigned", () => {
    const result = shouldAiReply({ ...openGate, mode: "human_then_ai", humanAssignedAndOnline: true });
    expect(result).toEqual({ reply: false, reason: "human_agent_active" });
  });

  it("replies in human_then_ai mode when no online human is assigned", () => {
    expect(shouldAiReply({ ...openGate, mode: "human_then_ai" }).reply).toBe(true);
  });

  it("replies in ai_first mode even when a human is assigned", () => {
    expect(shouldAiReply({ ...openGate, humanAssignedAndOnline: true }).reply).toBe(true);
  });

  it.each([
    [{ withinServiceWindow: false }, "outside_service_window"],
    [{ cooldownActive: true }, "cooldown_active"],
    [{ dailyCapReached: true }, "daily_cap_reached"],
  ] as const)("blocks with %j → %s", (overrides, reason) => {
    expect(shouldAiReply({ ...openGate, ...overrides })).toEqual({ reply: false, reason });
  });
});

describe("pickEscalationAgent", () => {
  const agent = (overrides: Partial<EscalationAgentCandidate>): EscalationAgentCandidate => ({
    id: "agent-id",
    user_id: "someone",
    status: "online",
    current_conversations: 0,
    ...overrides,
  });

  it("returns null when no agent is online", () => {
    expect(pickEscalationAgent([agent({ status: "away" }), agent({ status: "offline" })], "owner")).toBeNull();
  });

  it("prefers the business owner's own agent when online, even if busier", () => {
    const owner = agent({ id: "owner-agent", user_id: "owner", current_conversations: 9 });
    const idle = agent({ id: "idle-agent", current_conversations: 0 });
    expect(pickEscalationAgent([idle, owner], "owner")).toBe(owner);
  });

  it("falls back to the online agent with the fewest active conversations", () => {
    const busy = agent({ id: "busy", current_conversations: 5 });
    const idle = agent({ id: "idle", current_conversations: 1 });
    expect(pickEscalationAgent([busy, idle], "owner")?.id).toBe("idle");
  });
});

describe("waRecipient", () => {
  it("strips the plus and separators from an E.164 number", () => {
    expect(waRecipient("+965 5000-0000")).toBe("96550000000");
  });
});

describe("buildSystemPrompt", () => {
  it("embeds the persona, language instruction, and numbered knowledge blocks", () => {
    const prompt = buildSystemPrompt({
      persona: "Friendly Kuwaiti perfume shop",
      language: "ar",
      knowledgeBlocks: ["Name: Oud 30ml\nPrice: 12 KWD"],
      nowIso: "2026-07-11T00:00:00.000Z",
    });
    expect(prompt).toContain("Friendly Kuwaiti perfume shop");
    expect(prompt).toContain("Reply in Arabic");
    expect(prompt).toContain("[1] Name: Oud 30ml");
    expect(prompt).toContain("escalate_to_human");
  });

  it("marks the knowledge section as empty when nothing matched", () => {
    const prompt = buildSystemPrompt({ persona: null, language: "en", knowledgeBlocks: [], nowIso: "2026-07-11T00:00:00.000Z" });
    expect(prompt).toContain("no business knowledge matched");
    expect(prompt).toContain("Reply in English");
  });
});
