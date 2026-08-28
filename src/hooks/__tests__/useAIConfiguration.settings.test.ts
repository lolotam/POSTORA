import { describe, expect, it } from "vitest";
import { parseSettingsRows } from "../useAIConfiguration";

describe("parseSettingsRows", () => {
  it("routes each key to its tier", () => {
    const out = parseSettingsRows([
      { key: "default_ai_model", value: { provider_code: "openai", model_id: "gpt-4o" } },
      { key: "default_ai_model_image", value: { provider_code: "higgsfield", model_id: "gpt_image_2" } },
      { key: "default_ai_model_image_fallback", value: { provider_code: "higgsfield", model_id: "nano_banana_2" } },
      { key: "default_ai_model_image_fallback_2", value: { provider_code: "gemini", model_id: "imagen-4.0-generate-001" } },
    ]);
    expect(out.defaultModel).toEqual({ provider_code: "openai", model_id: "gpt-4o" });
    expect(out.categoryDefaults.image?.model_id).toBe("gpt_image_2");
    expect(out.categoryFallbacks.image?.model_id).toBe("nano_banana_2");
    expect(out.categoryFallbacks2.image?.model_id).toBe("imagen-4.0-generate-001");
  });

  it("leaves untouched categories null and ignores unknown keys", () => {
    const out = parseSettingsRows([
      { key: "default_ai_model_video_fallback_2", value: { provider_code: "higgsfield", model_id: "cinematic_studio_3_0" } },
      { key: "default_ai_model_nonsense", value: { provider_code: "x", model_id: "y" } },
    ]);
    expect(out.categoryFallbacks2.video?.model_id).toBe("cinematic_studio_3_0");
    expect(out.categoryFallbacks2.image).toBeNull();
    expect(out.categoryDefaults.chat).toBeNull();
  });

  // The longer key ends with the shorter one, so a naive endsWith check routes
  // _fallback_2 into the _fallback slot and silently loses the third tier.
  it("does not mistake _fallback_2 for _fallback", () => {
    const out = parseSettingsRows([
      { key: "default_ai_model_image_fallback_2", value: { provider_code: "gemini", model_id: "imagen-4.0-generate-001" } },
    ]);
    expect(out.categoryFallbacks.image).toBeNull();
    expect(out.categoryFallbacks2.image?.model_id).toBe("imagen-4.0-generate-001");
  });

  it("treats a malformed setting value as unset rather than throwing", () => {
    const out = parseSettingsRows([
      { key: "default_ai_model_image", value: { provider_code: "higgsfield" } },
      { key: "default_ai_model_image_fallback", value: null },
    ]);
    expect(out.categoryDefaults.image).toBeNull();
    expect(out.categoryFallbacks.image).toBeNull();
  });

  // The embedding category writes the same three system_settings keys the
  // edge-function ladder reads (default_ai_model_embedding[_fallback[_2]]);
  // a mis-routed key would silently strand the admin's vector-model choice.
  it("routes the three embedding slots to their own tiers", () => {
    const out = parseSettingsRows([
      { key: "default_ai_model_embedding", value: { provider_code: "ollama", model_id: "bge-m3:latest" } },
      { key: "default_ai_model_embedding_fallback", value: { provider_code: "gemini", model_id: "gemini-embedding-001" } },
      { key: "default_ai_model_embedding_fallback_2", value: { provider_code: "openai", model_id: "text-embedding-3-small" } },
    ]);
    expect(out.categoryDefaults.embedding).toEqual({ provider_code: "ollama", model_id: "bge-m3:latest" });
    expect(out.categoryFallbacks.embedding).toEqual({ provider_code: "gemini", model_id: "gemini-embedding-001" });
    expect(out.categoryFallbacks2.embedding).toEqual({ provider_code: "openai", model_id: "text-embedding-3-small" });
  });

  it("keeps embedding tiers separate from the similarly-suffixed keys", () => {
    const out = parseSettingsRows([
      { key: "default_ai_model_embedding_fallback_2", value: { provider_code: "openai", model_id: "text-embedding-3-small" } },
      { key: "default_ai_model_stt_fallback", value: { provider_code: "openai", model_id: "whisper-1" } },
    ]);
    expect(out.categoryDefaults.embedding).toBeNull();
    expect(out.categoryFallbacks.embedding).toBeNull();
    expect(out.categoryFallbacks2.embedding?.model_id).toBe("text-embedding-3-small");
    expect(out.categoryFallbacks.stt?.model_id).toBe("whisper-1");
  });
});
