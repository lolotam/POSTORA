/**
 * Higgsfield per-model parameter specifications.
 *
 * Every Higgsfield model takes a *different* set of knobs: GPT Image 2 has
 * `resolution` (1k/2k/4k) *and* `quality` (low/medium/high), Nano Banana has
 * only `resolution`, Soul 2.0 calls its knob `quality` but the values are
 * 1.5k/2k, and the accepted aspect ratios differ per model too. Sending a
 * parameter a model does not accept is an error upstream, not a no-op — so the
 * UI and the edge function both have to know the shape of each model.
 *
 * This table is a snapshot of `models_explore(action:"list")` taken from the
 * live catalog. It is the *baseline*: "Sync models from Higgsfield" writes the
 * catalog it sees into `ai_models.metadata`, and {@link mergeModelSpec} layers
 * that over the snapshot so a model whose options change upstream does not need
 * a code change.
 *
 * Mirrored (deliberately, since edge functions cannot import from `src/`) by
 * `supabase/functions/_shared/higgsfield-model-spec.ts`. Keep both in step.
 *
 * @module lib/higgsfieldModelSpecs
 */

export type ModelParamType = "string" | "number" | "bool" | "string_array";

export interface ModelParamSpec {
  name: string;
  type: ModelParamType;
  required: boolean;
  description: string;
  default?: string | number | boolean;
  /** Enumerated values, for `string` params rendered as a dropdown. */
  options?: string[];
  min?: number;
  max?: number;
}

export interface HiggsfieldModelSpec {
  id: string;
  name: string;
  providerName: string;
  description: string;
  outputType: "image" | "video" | "audio" | "3d";
  parameters: ModelParamSpec[];
  aspectRatios: string[];
  /** Discrete durations, when the model offers a fixed set (video only). */
  durations?: number[];
  /** Continuous duration window, when the model offers a range (video only). */
  durationRange?: { min: number; max: number };
  /** How many reference images the model accepts. 0 means text-only. */
  maxReferenceImages: number;
  /** Roles a reference image may be attached under (`image`, `start_image`, …). */
  referenceRoles: string[];
  /** True when the model cannot run without a reference image. */
  requiresReferenceImage: boolean;
  tags: string[];
  supportsUnlim: boolean;
}

/** Shorthand for the common `resolution` knob so the table stays readable. */
function resolutionParam(options: string[], fallback: string): ModelParamSpec {
  return {
    name: "resolution",
    type: "string",
    required: false,
    description: "Output resolution. Higher costs more credits.",
    default: fallback,
    options,
  };
}

const IMAGE_SPECS: HiggsfieldModelSpec[] = [
  {
    id: "nano_banana_2",
    name: "Nano Banana 2",
    providerName: "Google",
    description: "Fast, next-gen high-quality images",
    outputType: "image",
    parameters: [resolutionParam(["1k", "2k", "4k"], "1k")],
    aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "9:16", "16:9", "21:9"],
    maxReferenceImages: 4,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["fast", "photorealistic", "4k", "text-to-image", "image-to-image"],
    supportsUnlim: true,
  },
  {
    id: "nano_banana_pro",
    name: "Nano Banana Pro",
    providerName: "Google",
    description: "Ultimate quality, text and diagrams",
    outputType: "image",
    parameters: [resolutionParam(["1k", "2k", "4k"], "1k")],
    aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "9:16", "16:9", "21:9"],
    maxReferenceImages: 4,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["quality", "text-rendering", "diagrams", "4k"],
    supportsUnlim: true,
  },
  {
    id: "gpt_image_2",
    name: "GPT Image 2",
    providerName: "OpenAI",
    description: "Text rendering and editing, 1k/2k/4k with low/medium/high quality tiers",
    outputType: "image",
    parameters: [
      resolutionParam(["1k", "2k", "4k"], "1k"),
      {
        name: "quality",
        type: "string",
        required: false,
        description: "Image quality. Higher costs more credits.",
        default: "low",
        options: ["low", "medium", "high"],
      },
    ],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    maxReferenceImages: 4,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["text-rendering", "editing", "typography", "4k"],
    supportsUnlim: true,
  },
  {
    id: "soul_2",
    name: "Higgsfield Soul 2.0",
    providerName: "Higgsfield",
    description: "Realistic UGC, fashion editorial and character generation",
    outputType: "image",
    parameters: [
      {
        name: "quality",
        type: "string",
        required: false,
        description: "Output quality tier.",
        default: "2k",
        options: ["1.5k", "2k"],
      },
      {
        name: "soul_id",
        type: "string",
        required: false,
        description: "Soul-ID for personalized generation, from your Higgsfield account.",
      },
    ],
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    maxReferenceImages: 1,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["ugc", "fashion", "editorial", "character", "portrait"],
    supportsUnlim: true,
  },
  {
    id: "soul_v2",
    name: "Higgsfield Soul 2.0",
    providerName: "Higgsfield",
    description: "Realistic UGC, fashion editorial and character generation",
    outputType: "image",
    parameters: [
      {
        name: "quality",
        type: "string",
        required: false,
        description: "Output quality tier.",
        default: "2k",
        options: ["1.5k", "2k"],
      },
      {
        name: "soul_id",
        type: "string",
        required: false,
        description: "Soul-ID for personalized generation, from your Higgsfield account.",
      },
    ],
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    maxReferenceImages: 1,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["ugc", "fashion", "editorial", "character", "portrait"],
    supportsUnlim: true,
  },
  {
    id: "soul_cinematic",
    name: "Soul Cinema",
    providerName: "Higgsfield",
    description: "Cinema-grade stills and concept art",
    outputType: "image",
    parameters: [
      {
        name: "quality",
        type: "string",
        required: false,
        description: "Output quality tier.",
        default: "2k",
        options: ["1.5k", "2k"],
      },
      {
        name: "soul_id",
        type: "string",
        required: false,
        description: "Soul Cinema character id for personalized cinematic generation.",
      },
    ],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    maxReferenceImages: 1,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["cinematic", "concept-art", "film"],
    supportsUnlim: false,
  },
  {
    id: "cinematic_studio_2_5",
    name: "Cinema Studio Image 2.5",
    providerName: "Higgsfield",
    description: "Cinematic stills, up to 4K",
    outputType: "image",
    parameters: [resolutionParam(["1k", "2k", "4k"], "1k")],
    aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "16:9", "9:16", "21:9"],
    maxReferenceImages: 4,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["cinematic", "4k", "film"],
    supportsUnlim: false,
  },
  {
    id: "marketing_studio_image",
    name: "Marketing Studio Image",
    providerName: "Higgsfield",
    description: "One-click product image ads for social campaigns",
    outputType: "image",
    parameters: [resolutionParam(["1k", "2k", "4k"], "1k")],
    aspectRatios: [
      "auto", "1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "9:16", "16:9", "21:9",
    ],
    maxReferenceImages: 4,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["marketing", "ads", "product", "social-media"],
    supportsUnlim: false,
  },
  {
    id: "ms_image",
    name: "DTC Ads",
    providerName: "Higgsfield",
    description: "DTC ad images with brand-kit-aware prompts, avatars and ad formats",
    outputType: "image",
    parameters: [
      {
        name: "style_id",
        type: "string",
        required: true,
        description:
          "Marketing Studio image style id. This model has no default style and fails without one.",
      },
      {
        name: "brand_kit_id",
        type: "string",
        required: false,
        description: "Marketing Studio brand kit id — folds logo, colours and tone into the prompt.",
      },
      resolutionParam(["1k", "2k", "4k"], "1k"),
      {
        name: "quality",
        type: "string",
        required: false,
        description: "Output quality. Affects cost.",
        default: "low",
        options: ["low", "medium", "high"],
      },
      {
        name: "batch_size",
        type: "number",
        required: false,
        description: "Images generated per job. Cost scales linearly.",
        default: 1,
        min: 1,
        max: 20,
      },
    ],
    aspectRatios: [
      "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4",
      "21:9", "27:16", "16:27", "9:8", "8:9", "4:9", "9:4", "auto",
    ],
    maxReferenceImages: 14,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["marketing", "ads", "brand-kit", "dtc"],
    supportsUnlim: false,
  },
  {
    id: "image_auto",
    name: "Auto",
    providerName: "Higgsfield",
    description: "Auto-selects the best image model from the prompt",
    outputType: "image",
    parameters: [],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
    maxReferenceImages: 4,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: ["auto", "routing"],
    supportsUnlim: false,
  },
  {
    id: "soul_location",
    name: "Soul Location",
    providerName: "Higgsfield",
    description: "Environment and location generation",
    outputType: "image",
    parameters: [],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "9:21"],
    maxReferenceImages: 0,
    referenceRoles: [],
    requiresReferenceImage: false,
    tags: ["environment", "location", "scene"],
    supportsUnlim: false,
  },
  {
    id: "soul_cast",
    name: "Soul Cast",
    providerName: "Higgsfield",
    description: "Consistent cinematic character identity",
    outputType: "image",
    parameters: [
      {
        name: "budget",
        type: "number",
        required: false,
        description: "Generation budget.",
        default: 50,
        min: 10,
        max: 500,
      },
    ],
    aspectRatios: ["16:9"],
    maxReferenceImages: 0,
    referenceRoles: [],
    requiresReferenceImage: false,
    tags: ["character", "identity", "cinematic"],
    supportsUnlim: false,
  },
  {
    id: "autosprite",
    name: "AutoSprite Animation",
    providerName: "Higgsfield",
    description: "Turn a character image into a game-ready sprite sheet",
    outputType: "image",
    parameters: [
      {
        name: "kind",
        type: "string",
        required: false,
        description: "Animation preset.",
        default: "idle",
        options: ["idle", "walk", "run", "attack", "jump", "custom"],
      },
      {
        name: "video_tier",
        type: "string",
        required: false,
        description: "Quality and cost tier.",
        default: "turbo",
        options: ["turbo", "pro", "max"],
      },
      {
        name: "frame_count",
        type: "number",
        required: false,
        description: "Frames in the sprite sheet.",
        default: 25,
        min: 2,
        max: 64,
      },
      {
        name: "frame_size",
        type: "number",
        required: false,
        description: "Frame width and height in pixels.",
        default: 256,
        min: 32,
        max: 512,
      },
      {
        name: "remove_bg",
        type: "string",
        required: false,
        description: "Background removal mode.",
        default: "default",
        options: ["default", "ultra"],
      },
      {
        name: "is_humanoid",
        type: "bool",
        required: false,
        description: "Whether the source character is humanoid.",
        default: true,
      },
    ],
    aspectRatios: [],
    maxReferenceImages: 1,
    referenceRoles: ["image"],
    requiresReferenceImage: true,
    tags: ["sprite", "animation", "game"],
    supportsUnlim: false,
  },
];

const VIDEO_SPECS: HiggsfieldModelSpec[] = [
  {
    id: "cinematic_studio_3_0",
    name: "Cinema Studio Video 3.0",
    providerName: "Higgsfield",
    description: "Most advanced cinema-grade model",
    outputType: "video",
    parameters: [
      resolutionParam(["480p", "720p", "1080p", "4k"], "720p"),
      {
        name: "genre",
        type: "string",
        required: false,
        description: "Cinematic genre hint.",
        default: "auto",
        options: ["auto", "action", "horror", "comedy", "noir", "drama", "epic"],
      },
      {
        name: "generate_audio",
        type: "bool",
        required: false,
        description: "Generate audio for the video.",
        default: false,
      },
    ],
    aspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationRange: { min: 4, max: 15 },
    maxReferenceImages: 2,
    referenceRoles: ["image", "start_image", "end_image"],
    requiresReferenceImage: false,
    tags: ["cinematic", "premium", "film"],
    supportsUnlim: false,
  },
  {
    id: "cinematic_studio_video",
    name: "Cinema Studio Video",
    providerName: "Higgsfield",
    description: "Solid cinematic, dramatic compositions",
    outputType: "video",
    parameters: [
      {
        name: "slow_motion",
        type: "bool",
        required: false,
        description: "Enable a slow motion effect.",
        default: false,
      },
      {
        name: "sound",
        type: "bool",
        required: false,
        description: "Enable sound generation.",
        default: true,
      },
    ],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
    durations: [5, 10],
    maxReferenceImages: 2,
    referenceRoles: ["image", "start_image", "end_image"],
    requiresReferenceImage: false,
    tags: ["cinematic", "sound"],
    supportsUnlim: false,
  },
  {
    id: "cinematic_studio_video_v2",
    name: "Cinema Studio Video v2",
    providerName: "Higgsfield",
    description: "Refined cinematic camera and colour, genre control",
    outputType: "video",
    parameters: [
      {
        name: "genre",
        type: "string",
        required: false,
        description: "Video genre or style.",
        default: "auto",
        options: [
          "auto", "action", "horror", "comedy", "western", "suspense", "intimate", "spectacle",
        ],
      },
      {
        name: "mode",
        type: "string",
        required: false,
        description: "Quality mode.",
        default: "std",
        options: ["pro", "std"],
      },
      {
        name: "sound",
        type: "string",
        required: false,
        description: "Generate audio. Use 'off' for a silent video.",
        default: "on",
        options: ["on", "off"],
      },
      {
        name: "speedramp",
        type: "string",
        required: false,
        description: "Speed-ramp time effect.",
        default: "auto",
        options: ["auto", "custom", "linear", "slowmo", "speedup", "impact"],
      },
      {
        name: "cfg_scale",
        type: "number",
        required: false,
        description: "Prompt adherence strength.",
        default: 0.5,
        min: 0,
        max: 1,
      },
    ],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
    durationRange: { min: 3, max: 12 },
    maxReferenceImages: 2,
    referenceRoles: ["image", "start_image", "end_image"],
    requiresReferenceImage: false,
    tags: ["cinematic", "genre", "refined"],
    supportsUnlim: false,
  },
  {
    id: "marketing_studio_video",
    name: "Marketing Studio",
    providerName: "Higgsfield",
    description: "One-click product ads, TikTok and Reels ready",
    outputType: "video",
    parameters: [
      resolutionParam(["480p", "720p", "1080p"], "720p"),
      {
        name: "generate_audio",
        type: "bool",
        required: false,
        description: "Generate audio for the video.",
        default: true,
      },
      {
        name: "mode",
        type: "string",
        required: false,
        description: "Marketing preset slug — the creative format (UGC, unboxing, review, …).",
      },
    ],
    aspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationRange: { min: 12, max: 15 },
    maxReferenceImages: 2,
    referenceRoles: ["image", "start_image", "end_image"],
    requiresReferenceImage: false,
    tags: ["marketing", "ugc", "ads", "tiktok", "reels"],
    supportsUnlim: false,
  },
  {
    id: "higgsfield_preset",
    name: "Higgsfield Preset",
    providerName: "Higgsfield",
    description: "Preset-routed image-to-video generation",
    outputType: "video",
    parameters: [
      {
        name: "preset_id",
        type: "string",
        required: true,
        description: "Preset id from the Higgsfield preset library.",
      },
    ],
    aspectRatios: ["16:9", "9:16", "1:1"],
    maxReferenceImages: 1,
    referenceRoles: ["image"],
    requiresReferenceImage: true,
    tags: ["preset", "image-to-video", "template"],
    supportsUnlim: false,
  },
];

export const HIGGSFIELD_MODEL_SPECS: Record<string, HiggsfieldModelSpec> = Object.fromEntries(
  [...IMAGE_SPECS, ...VIDEO_SPECS].map((spec) => [spec.id, spec]),
);

/**
 * Fallback for a model the snapshot has not seen.
 *
 * The catalog is synced at runtime, so an unknown id is expected rather than
 * exceptional. It gets a permissive, parameter-free spec: better to send only
 * prompt + aspect ratio than to guess at knobs the model may reject.
 */
export function unknownModelSpec(modelId: string, outputType: "image" | "video" = "image"): HiggsfieldModelSpec {
  return {
    id: modelId,
    name: modelId,
    providerName: "Higgsfield",
    description: "",
    outputType,
    parameters: [],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
    maxReferenceImages: 1,
    referenceRoles: ["image"],
    requiresReferenceImage: false,
    tags: [],
    supportsUnlim: false,
  };
}

export function getHiggsfieldModelSpec(
  modelId: string | null | undefined,
): HiggsfieldModelSpec | null {
  if (!modelId) return null;
  return HIGGSFIELD_MODEL_SPECS[modelId] ?? null;
}

/**
 * Layer live catalog metadata (from `ai_models.metadata`) over the snapshot.
 *
 * Only fields the sync actually recorded are taken, so a partially populated
 * metadata blob cannot blank out known-good snapshot values.
 */
export function mergeModelSpec(
  modelId: string,
  metadata: unknown,
  outputType: "image" | "video" = "image",
): HiggsfieldModelSpec {
  const base = getHiggsfieldModelSpec(modelId) ?? unknownModelSpec(modelId, outputType);
  if (!metadata || typeof metadata !== "object") return base;

  const meta = metadata as Record<string, unknown>;
  const merged: HiggsfieldModelSpec = { ...base };

  const params = readParameters(meta.parameters);
  if (params) merged.parameters = params;

  const ratios = readStringArray(meta.aspect_ratios);
  if (ratios) merged.aspectRatios = ratios;

  const durations = readNumberArray(meta.durations);
  if (durations && durations.length > 0) {
    merged.durations = durations;
    merged.durationRange = undefined;
  }

  const range = meta.duration_range as { min?: unknown; max?: unknown } | undefined;
  if (range && Number.isFinite(Number(range.min)) && Number.isFinite(Number(range.max))) {
    merged.durationRange = { min: Number(range.min), max: Number(range.max) };
    merged.durations = undefined;
  }

  const medias = readMedias(meta.medias);
  if (medias) {
    merged.maxReferenceImages = medias.max;
    merged.referenceRoles = medias.roles;
    merged.requiresReferenceImage = medias.required;
  }

  const tags = readStringArray(meta.tags);
  if (tags) merged.tags = tags;

  if (typeof meta.supports_unlim === "boolean") merged.supportsUnlim = meta.supports_unlim;
  if (typeof meta.output_type === "string") {
    merged.outputType = meta.output_type as HiggsfieldModelSpec["outputType"];
  }

  return merged;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length === value.length ? out : out;
}

function readNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(Number).filter((n) => Number.isFinite(n));
}

function readParameters(value: unknown): ModelParamSpec[] | null {
  if (!Array.isArray(value)) return null;

  const out: ModelParamSpec[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string") continue;

    const type = item.type;
    out.push({
      name: item.name,
      type:
        type === "number" || type === "bool" || type === "string_array" ? type : "string",
      // The catalog reports this as the string "required" / "optional".
      required: item.required === "required" || item.required === true,
      description: typeof item.description === "string" ? item.description : "",
      default: item.default as ModelParamSpec["default"],
      options: readStringArray(item.options) ?? undefined,
      min: Number.isFinite(Number(item.min)) ? Number(item.min) : undefined,
      max: Number.isFinite(Number(item.max)) ? Number(item.max) : undefined,
    });
  }
  return out;
}

function readMedias(value: unknown): { max: number; roles: string[]; required: boolean } | null {
  if (!Array.isArray(value)) return null;

  let max = 0;
  let required = false;
  const roles = new Set<string>();

  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "image") continue;

    // An absent `max` means "no stated limit"; treat it as the catalog's own
    // practical ceiling rather than unbounded.
    const itemMax = Number.isFinite(Number(item.max)) ? Number(item.max) : 4;
    max = Math.max(max, itemMax);
    if (item.required === true) required = true;
    for (const role of readStringArray(item.roles) ?? []) roles.add(role);
  }

  if (max === 0 && roles.size === 0) return { max: 0, roles: [], required: false };
  return { max, roles: [...roles], required };
}

/** The parameter values a model starts with in the UI. */
export function defaultParamsFor(spec: HiggsfieldModelSpec): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const param of spec.parameters) {
    if (param.default !== undefined) out[param.name] = param.default;
  }
  return out;
}

/**
 * Drop, clamp and coerce raw values into what the model actually accepts.
 *
 * Unknown keys are discarded rather than forwarded: Higgsfield rejects the
 * whole request on an unrecognised parameter, so a stale value left over from a
 * previously selected model must not survive a model switch.
 */
export function sanitizeParams(
  spec: HiggsfieldModelSpec,
  raw: unknown,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  for (const param of spec.parameters) {
    const value = input[param.name];

    if (value === undefined || value === null || value === "") {
      if (param.default !== undefined) out[param.name] = param.default;
      continue;
    }

    if (param.type === "bool") {
      out[param.name] = value === true || value === "true";
      continue;
    }

    if (param.type === "number") {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        if (param.default !== undefined) out[param.name] = param.default;
        continue;
      }
      const lower = param.min ?? Number.NEGATIVE_INFINITY;
      const upper = param.max ?? Number.POSITIVE_INFINITY;
      out[param.name] = Math.min(upper, Math.max(lower, num));
      continue;
    }

    const text = String(value);
    if (param.options && !param.options.includes(text)) {
      if (param.default !== undefined) out[param.name] = param.default;
      continue;
    }
    out[param.name] = text;
  }

  return out;
}

/** Required parameters the caller has not supplied a value for. */
export function missingRequiredParams(
  spec: HiggsfieldModelSpec,
  values: Record<string, unknown>,
): string[] {
  return spec.parameters
    .filter((param) => param.required)
    .filter((param) => {
      const value = values[param.name];
      return value === undefined || value === null || String(value).trim() === "";
    })
    .map((param) => param.name);
}

/**
 * Pick an aspect ratio the model supports, preferring the caller's choice.
 *
 * Models advertise different ratio sets, so a ratio carried over from another
 * model has to fall back rather than be sent through and rejected.
 */
export function resolveAspectRatio(
  spec: HiggsfieldModelSpec,
  preferred: string | null | undefined,
): string | null {
  if (spec.aspectRatios.length === 0) return null;
  if (preferred && spec.aspectRatios.includes(preferred)) return preferred;
  for (const fallback of ["1:1", "16:9", "auto"]) {
    if (spec.aspectRatios.includes(fallback)) return fallback;
  }
  return spec.aspectRatios[0];
}

/** Clamp a duration into whatever the video model supports. */
export function resolveDuration(spec: HiggsfieldModelSpec, seconds: unknown): number | null {
  const value = Math.round(Number(seconds));

  if (spec.durations && spec.durations.length > 0) {
    if (!Number.isFinite(value)) return spec.durations[0];
    // Snap to the nearest offered duration.
    return spec.durations.reduce((best, option) =>
      Math.abs(option - value) < Math.abs(best - value) ? option : best,
    );
  }

  if (spec.durationRange) {
    if (!Number.isFinite(value)) return spec.durationRange.min;
    return Math.min(spec.durationRange.max, Math.max(spec.durationRange.min, value));
  }

  return Number.isFinite(value) && value > 0 ? value : null;
}

const PARAM_LABELS: Record<string, string> = {
  resolution: "Resolution",
  quality: "Quality",
  genre: "Genre",
  mode: "Mode",
  sound: "Sound",
  generate_audio: "Generate audio",
  slow_motion: "Slow motion",
  speedramp: "Speed ramp",
  cfg_scale: "Prompt adherence",
  soul_id: "Soul ID",
  style_id: "Style ID",
  brand_kit_id: "Brand kit ID",
  preset_id: "Preset ID",
  batch_size: "Batch size",
  frame_count: "Frame count",
  frame_size: "Frame size",
  video_tier: "Tier",
  remove_bg: "Background removal",
  is_humanoid: "Humanoid character",
  budget: "Budget",
  kind: "Animation",
};

/** Human label for a parameter, falling back to a de-snaked name. */
export function paramLabel(name: string): string {
  const known = PARAM_LABELS[name];
  if (known) return known;
  return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Human label for an enumerated option value. */
export function optionLabel(paramName: string, value: string): string {
  if (paramName === "resolution") {
    return /^\d+k$/i.test(value) ? value.toUpperCase() : value;
  }
  if (paramName === "quality" && /k$/i.test(value)) {
    return value.toUpperCase();
  }
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
