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
});
