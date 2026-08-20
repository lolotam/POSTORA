/**
 * Per-model parameter spec tests.
 *
 * These helpers decide what actually reaches Higgsfield. An unknown parameter
 * fails the whole request upstream, so the sanitising and fallback behaviour is
 * covered closely.
 *
 * @module lib/higgsfieldModelSpecs.test
 */

import { describe, it, expect } from "vitest";
import {
  HIGGSFIELD_MODEL_SPECS,
  defaultParamsFor,
  getHiggsfieldModelSpec,
  mergeModelSpec,
  missingRequiredParams,
  optionLabel,
  paramLabel,
  resolveAspectRatio,
  resolveDuration,
  sanitizeParams,
  unknownModelSpec,
} from "./higgsfieldModelSpecs";

describe("model catalog snapshot", () => {
  it("should give GPT Image 2 both a resolution and a quality knob", () => {
    const spec = getHiggsfieldModelSpec("gpt_image_2")!;
    const names = spec.parameters.map((p) => p.name);
    expect(names).toContain("resolution");
    expect(names).toContain("quality");
    expect(spec.parameters.find((p) => p.name === "resolution")?.options).toEqual([
      "1k",
      "2k",
      "4k",
    ]);
    expect(spec.parameters.find((p) => p.name === "quality")?.options).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("should give Nano Banana a resolution knob but no quality knob", () => {
    const spec = getHiggsfieldModelSpec("nano_banana_2")!;
    const names = spec.parameters.map((p) => p.name);
    expect(names).toEqual(["resolution"]);
  });

  it("should record that Soul 2.0 measures quality in 1.5k/2k, not low/medium/high", () => {
    const spec = getHiggsfieldModelSpec("soul_2")!;
    expect(spec.parameters.find((p) => p.name === "quality")?.options).toEqual(["1.5k", "2k"]);
  });

  it("should keep aspect ratio sets distinct per model", () => {
    expect(getHiggsfieldModelSpec("gpt_image_2")!.aspectRatios).not.toContain("21:9");
    expect(getHiggsfieldModelSpec("nano_banana_2")!.aspectRatios).toContain("21:9");
  });

  it("should key every entry by its own id", () => {
    for (const [id, spec] of Object.entries(HIGGSFIELD_MODEL_SPECS)) {
      expect(spec.id).toBe(id);
    }
  });

  it("should return null for a model it has never seen", () => {
    expect(getHiggsfieldModelSpec("kling3_0")).toBeNull();
    expect(getHiggsfieldModelSpec(null)).toBeNull();
  });
});

describe("sanitizeParams", () => {
  const gpt = getHiggsfieldModelSpec("gpt_image_2")!;

  it("should keep values the model declares", () => {
    expect(sanitizeParams(gpt, { resolution: "4k", quality: "high" })).toEqual({
      resolution: "4k",
      quality: "high",
    });
  });

  it("should drop parameters the model does not declare", () => {
    // `soul_id` belongs to Soul 2.0; forwarding it would fail the request.
    expect(sanitizeParams(gpt, { resolution: "2k", soul_id: "abc" })).toEqual({
      resolution: "2k",
      quality: "low",
    });
  });

  it("should fall back to the default for an option outside the allowed set", () => {
    expect(sanitizeParams(gpt, { resolution: "8k" }).resolution).toBe("1k");
  });

  it("should fill in defaults for omitted parameters", () => {
    expect(sanitizeParams(gpt, {})).toEqual({ resolution: "1k", quality: "low" });
  });

  it("should treat empty strings as omitted", () => {
    expect(sanitizeParams(gpt, { resolution: "" }).resolution).toBe("1k");
  });

  it("should tolerate a null or non-object bag", () => {
    expect(sanitizeParams(gpt, null)).toEqual({ resolution: "1k", quality: "low" });
    expect(sanitizeParams(gpt, "nonsense")).toEqual({ resolution: "1k", quality: "low" });
  });

  it("should clamp numbers into the declared range", () => {
    const ms = getHiggsfieldModelSpec("ms_image")!;
    expect(sanitizeParams(ms, { style_id: "s", batch_size: 99 }).batch_size).toBe(20);
    expect(sanitizeParams(ms, { style_id: "s", batch_size: 0 }).batch_size).toBe(1);
  });

  it("should coerce booleans, including the string form a form control sends", () => {
    const video = getHiggsfieldModelSpec("cinematic_studio_3_0")!;
    expect(sanitizeParams(video, { generate_audio: "true" }).generate_audio).toBe(true);
    expect(sanitizeParams(video, { generate_audio: false }).generate_audio).toBe(false);
  });

  it("should keep a free-text parameter that declares no options", () => {
    const soul = getHiggsfieldModelSpec("soul_2")!;
    expect(sanitizeParams(soul, { soul_id: "soul-123" }).soul_id).toBe("soul-123");
  });

  it("should return nothing for a model with no parameters", () => {
    expect(sanitizeParams(getHiggsfieldModelSpec("image_auto")!, { resolution: "4k" })).toEqual({});
  });
});

describe("missingRequiredParams", () => {
  it("should report a required parameter that was not supplied", () => {
    const ms = getHiggsfieldModelSpec("ms_image")!;
    expect(missingRequiredParams(ms, {})).toEqual(["style_id"]);
    expect(missingRequiredParams(ms, { style_id: "  " })).toEqual(["style_id"]);
    expect(missingRequiredParams(ms, { style_id: "editorial" })).toEqual([]);
  });

  it("should report nothing when every parameter is optional", () => {
    expect(missingRequiredParams(getHiggsfieldModelSpec("nano_banana_2")!, {})).toEqual([]);
  });
});

describe("resolveAspectRatio", () => {
  const gpt = getHiggsfieldModelSpec("gpt_image_2")!;

  it("should keep a ratio the model supports", () => {
    expect(resolveAspectRatio(gpt, "16:9")).toBe("16:9");
  });

  it("should fall back when the ratio came from a different model", () => {
    // 21:9 is a Nano Banana ratio; GPT Image 2 does not offer it.
    expect(resolveAspectRatio(gpt, "21:9")).toBe("1:1");
  });

  it("should fall back when nothing was chosen", () => {
    expect(resolveAspectRatio(gpt, null)).toBe("1:1");
  });

  it("should return null for a model that takes no aspect ratio", () => {
    expect(resolveAspectRatio(getHiggsfieldModelSpec("autosprite")!, "1:1")).toBeNull();
  });
});

describe("resolveDuration", () => {
  it("should clamp into a model's duration window", () => {
    const marketing = getHiggsfieldModelSpec("marketing_studio_video")!;
    expect(resolveDuration(marketing, 3)).toBe(12);
    expect(resolveDuration(marketing, 99)).toBe(15);
    expect(resolveDuration(marketing, 13)).toBe(13);
  });

  it("should snap to the nearest offered duration when the set is fixed", () => {
    const fixed = getHiggsfieldModelSpec("cinematic_studio_video")!;
    expect(resolveDuration(fixed, 4)).toBe(5);
    expect(resolveDuration(fixed, 9)).toBe(10);
  });

  it("should fall back for non-numeric input", () => {
    expect(resolveDuration(getHiggsfieldModelSpec("cinematic_studio_3_0")!, "abc")).toBe(4);
    expect(resolveDuration(getHiggsfieldModelSpec("cinematic_studio_video")!, null)).toBe(5);
  });

  it("should return null for a model with no duration knob", () => {
    expect(resolveDuration(getHiggsfieldModelSpec("gpt_image_2")!, 5)).toBe(5);
    expect(resolveDuration(getHiggsfieldModelSpec("gpt_image_2")!, 0)).toBeNull();
  });
});

describe("mergeModelSpec", () => {
  it("should layer live catalog parameters over the snapshot", () => {
    const merged = mergeModelSpec("nano_banana_2", {
      parameters: [
        {
          name: "resolution",
          required: "optional",
          type: "string",
          description: "Output resolution",
          default: "2k",
          options: ["1k", "2k", "4k", "8k"],
        },
      ],
    });
    const resolution = merged.parameters.find((p) => p.name === "resolution")!;
    expect(resolution.options).toContain("8k");
    expect(resolution.default).toBe("2k");
    expect(resolution.required).toBe(false);
  });

  it("should read the catalog's string form of `required`", () => {
    const merged = mergeModelSpec("higgsfield_preset", {
      parameters: [
        { name: "preset_id", required: "required", type: "string", description: "Preset id." },
      ],
    });
    expect(merged.parameters[0].required).toBe(true);
  });

  it("should build a usable spec for a model the snapshot has never seen", () => {
    const merged = mergeModelSpec(
      "kling3_0",
      {
        aspect_ratios: ["16:9", "9:16"],
        duration_range: { min: 5, max: 10 },
        parameters: [
          {
            name: "resolution",
            required: "optional",
            type: "string",
            description: "",
            options: ["720p", "1080p"],
            default: "720p",
          },
        ],
      },
      "video",
    );
    expect(merged.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(merged.durationRange).toEqual({ min: 5, max: 10 });
    expect(sanitizeParams(merged, { resolution: "1080p" })).toEqual({ resolution: "1080p" });
  });

  it("should keep the snapshot when metadata is absent or malformed", () => {
    expect(mergeModelSpec("gpt_image_2", null).parameters).toHaveLength(2);
    expect(mergeModelSpec("gpt_image_2", {}).aspectRatios).toContain("3:2");
    expect(mergeModelSpec("gpt_image_2", "junk").parameters).toHaveLength(2);
  });

  it("should let a fixed duration list replace an inherited range", () => {
    const merged = mergeModelSpec("cinematic_studio_3_0", { durations: [5, 10] }, "video");
    expect(merged.durations).toEqual([5, 10]);
    expect(merged.durationRange).toBeUndefined();
  });

  it("should carry reference-image limits over from the catalog", () => {
    const merged = mergeModelSpec("higgsfield_preset", {
      medias: [{ name: "medias", type: "image", max: 1, required: true, roles: ["image"] }],
    }, "video");
    expect(merged.requiresReferenceImage).toBe(true);
    expect(merged.maxReferenceImages).toBe(1);
    expect(merged.referenceRoles).toEqual(["image"]);
  });
});

describe("defaultParamsFor", () => {
  it("should seed only the parameters that declare a default", () => {
    expect(defaultParamsFor(getHiggsfieldModelSpec("gpt_image_2")!)).toEqual({
      resolution: "1k",
      quality: "low",
    });
    // soul_id has no default and must not be pre-filled with an empty string.
    expect(defaultParamsFor(getHiggsfieldModelSpec("soul_2")!)).toEqual({ quality: "2k" });
  });
});

describe("unknownModelSpec", () => {
  it("should be permissive rather than guess at knobs", () => {
    const spec = unknownModelSpec("brand_new_model");
    expect(spec.parameters).toEqual([]);
    expect(sanitizeParams(spec, { resolution: "4k" })).toEqual({});
  });
});

describe("labels", () => {
  it("should upper-case resolution tiers", () => {
    expect(optionLabel("resolution", "4k")).toBe("4K");
    expect(optionLabel("quality", "1.5k")).toBe("1.5K");
    expect(optionLabel("quality", "medium")).toBe("Medium");
  });

  it("should de-snake unknown parameter names", () => {
    expect(paramLabel("resolution")).toBe("Resolution");
    expect(paramLabel("some_new_knob")).toBe("Some new knob");
  });
});


