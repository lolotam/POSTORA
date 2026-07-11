import { describe, expect, it } from "vitest";
import { buildAiAgentConfigPayload } from "@/hooks/useAiAgentConfig";
import { normalizeE164Phone } from "@/lib/phone";

describe("buildAiAgentConfigPayload", () => {
  it("keeps only server-approved AI agent config fields", () => {
    const payload = buildAiAgentConfigPayload({
      is_enabled: true,
      default_mode: "ai_first",
      language_mode: "ar",
      persona_instructions: "Helpful and concise",
      business_profile_text: "Postora support",
      model: "gpt-4o-mini",
      temperature: 0.4,
      admin_phone_numbers: ["+965 5000-0000"],
      daily_message_cap: 75,
      reply_cooldown_seconds: 90,
      max_tool_iterations: 4,
      handoff_on_request: true,
      handoff_on_low_confidence: false,
      user_id: "must-not-be-sent",
      platform: "instagram",
      unexpected: "must-not-be-sent",
    });

    expect(payload).toEqual({
      is_enabled: true,
      default_mode: "ai_first",
      language_mode: "ar",
      persona_instructions: "Helpful and concise",
      business_profile_text: "Postora support",
      model: "gpt-4o-mini",
      temperature: 0.4,
      admin_phone_numbers: ["+96550000000"],
      daily_message_cap: 75,
      reply_cooldown_seconds: 90,
      max_tool_iterations: 4,
      handoff_on_request: true,
      handoff_on_low_confidence: false,
    });
  });
});

describe("normalizeE164Phone", () => {
  it("accepts an E.164-style phone number", () => {
    expect(normalizeE164Phone("+96550000000")).toBe("+96550000000");
  });

  it("strips spaces and dashes while preserving the leading plus", () => {
    expect(normalizeE164Phone("+965 5000-0000")).toBe("+96550000000");
  });

  it.each(["96550000000", "+9655abc", "+"])("rejects invalid numbers", (value) => {
    expect(normalizeE164Phone(value)).toBeNull();
  });
});