// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@3.23.8";

export type VideoProvider = "higgsfield" | "vercel";

/** An ai_models row for the requested model_id, joined to its provider. */
export interface VideoModelRow {
  model_id: string;
  metadata: unknown;
  is_active: boolean;
  capabilities: string[] | null;
  ai_providers: { provider_code: string; is_active: boolean } | null;
}

// When one model_id is listed under both providers the choice must not depend on row order.
const PRIORITY: readonly VideoProvider[] = ["higgsfield", "vercel"];

/**
 * The provider that serves this model: an active video row, higgsfield first. The Vercel
 * provider must itself be active; Higgsfield keeps its prior rule (the model row alone).
 */
export function pickVideoProvider(rows: VideoModelRow[]): { provider: VideoProvider; row: VideoModelRow } | null {
  const usable = rows.filter((r) =>
    r.is_active && (r.capabilities ?? []).includes("video") &&
    (r.ai_providers?.provider_code !== "vercel" || r.ai_providers.is_active)
  );
  for (const provider of PRIORITY) {
    const row = usable.find((r) => r.ai_providers?.provider_code === provider);
    if (row) return { provider, row };
  }
  return null;
}

export const VercelVideoInput = z.object({
  duration: z.number().int().positive().max(60).optional(),
  aspect_ratio: z.string().regex(/^\d+:\d+$/).optional(),
  image_url: z.string().url().refine((u) => u.startsWith("https://"), "image_url must be https").optional(),
});

/** The model generate-video falls back to when neither the request nor the admin ladder names one it can run. */
export const DEFAULT_VIDEO_MODEL_ID = "cinematic_studio_3_0";

/**
 * The model to use when the request names none: the first rung of the admin's Video
 * ladder (/admin/settings → Video Generation) on a provider this function can run.
 * Rungs on other providers (xAI, MiniMax, ...) have no runtime here and are skipped
 * rather than failing the request.
 */
export function videoModelFromLadder(settings: {
  primaryProvider: string; primaryModel: string;
  fallbackProvider: string; fallbackModel: string;
  lastResortProvider: string; lastResortModel: string;
}): string {
  const rungs = [
    [settings.primaryProvider, settings.primaryModel],
    [settings.fallbackProvider, settings.fallbackModel],
    [settings.lastResortProvider, settings.lastResortModel],
  ];
  for (const [provider, model] of rungs) {
    if ((PRIORITY as readonly string[]).includes(provider) && model) return model;
  }
  return DEFAULT_VIDEO_MODEL_ID;
}
