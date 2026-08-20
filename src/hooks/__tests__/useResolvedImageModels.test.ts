import { describe, expect, it } from "vitest";
import { resolveTiers } from "../useResolvedImageModels";
import type { AIModel } from "@/hooks/ai-config/types";

const model = (model_id: string, name: string, provider_code = "higgsfield"): AIModel =>
  ({
    id: `row-${model_id}`,
    provider_id: "p1",
    model_id,
    name,
    description: null,
    capabilities: ["image"],
    context_limit: null,
    is_active: true,
    cost_per_1m_input_tokens: null,
    cost_per_1m_output_tokens: null,
    ai_providers: { provider_code, name: "Higgsfield" },
  }) as AIModel;

const models = [model("gpt_image_2", "GPT Image 2"), model("nano_banana_2", "Nano Banana 2")];

describe("resolveTiers", () => {
  it("returns configured tiers in order, skipping unset ones", () => {
    const out = resolveTiers(models, {
      primary: { provider_code: "higgsfield", model_id: "gpt_image_2" },
      fallback: null,
      fallback2: { provider_code: "higgsfield", model_id: "nano_banana_2" },
    });
    expect(out.map((t) => t.model_id)).toEqual(["gpt_image_2", "nano_banana_2"]);
    expect(out[0].name).toBe("GPT Image 2");
  });

  // sync_models deactivates withdrawn models while the setting still names them.
  it("drops a tier whose model is not in the catalog", () => {
    const out = resolveTiers(models, {
      primary: { provider_code: "higgsfield", model_id: "deleted_model" },
      fallback: null,
      fallback2: null,
    });
    expect(out).toEqual([]);
  });

  // Same model_id can exist under two providers; the pair must both match.
  it("does not match a model id belonging to a different provider", () => {
    const out = resolveTiers(models, {
      primary: { provider_code: "openai", model_id: "gpt_image_2" },
      fallback: null,
      fallback2: null,
    });
    expect(out).toEqual([]);
  });

  // The server dedupes the chain by provider::model, so showing the same model
  // twice would imply a retry that will not happen.
  it("collapses a model configured in more than one tier", () => {
    const out = resolveTiers(models, {
      primary: { provider_code: "higgsfield", model_id: "gpt_image_2" },
      fallback: { provider_code: "higgsfield", model_id: "gpt_image_2" },
      fallback2: { provider_code: "higgsfield", model_id: "nano_banana_2" },
    });
    expect(out.map((t) => t.model_id)).toEqual(["gpt_image_2", "nano_banana_2"]);
  });

  it("returns nothing when no tier is configured", () => {
    expect(resolveTiers(models, { primary: null, fallback: null, fallback2: null })).toEqual([]);
  });
});
