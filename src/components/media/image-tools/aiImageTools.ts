import { supabase } from "@/integrations/supabase/client";
import type { CdnStorageConfig } from "@/lib/cdnConfig";

/** What the AI image functions answer (HTTP 503) when no provider can serve the request. */
export const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE";

/**
 * Cloudinary delivery transforms (resize, filters, quality, `e_background_removal`,
 * `e_upscale`) work only while the admin's CDN policy still writes to Cloudinary. This is the
 * policy half of the rule the edge functions apply; they also check the server credentials
 * and stay authoritative for the API.
 */
export function isCloudinaryTransformsAvailable(config: CdnStorageConfig | undefined): boolean {
  return !!config?.write_policy.providers.includes("cloudinary");
}

export class AiImageToolError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = "AiImageToolError";
  }
}

export function isProviderUnavailable(error: unknown): boolean {
  return error instanceof AiImageToolError && error.code === PROVIDER_UNAVAILABLE_CODE;
}

/** The `{ error, code }` body of a failed function call, whatever shape supabase-js wrapped it in. */
async function readFailure(error: unknown, fallback: string): Promise<AiImageToolError> {
  const context = (error as { context?: unknown }).context;
  const response = context instanceof Response ? context : undefined;
  const body = response
    ? (await response.clone().json().catch(() => null)) as { error?: unknown; code?: unknown } | null
    : null;
  const message = typeof body?.error === "string" ? body.error : error instanceof Error ? error.message : fallback;
  return new AiImageToolError(message, typeof body?.code === "string" ? body.code : null);
}

async function runTool(functionName: string, body: Record<string, unknown>, resultField: string, fallback: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error) throw await readFailure(error, fallback);
  const url = (data as Record<string, unknown> | null)?.[resultField];
  if (!(data as { success?: unknown } | null)?.success || typeof url !== "string" || !url) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new AiImageToolError(typeof message === "string" ? message : fallback, null);
  }
  return url;
}

/** Removes the background of the image at `imageUrl` and returns the URL of the result. */
export function runBackgroundRemoval(imageUrl: string): Promise<string> {
  return runTool("remove-background", { image_url: imageUrl }, "processed_url", "Background removal failed");
}

/** Upscales the image at `imageUrl` with AtlasCloud (4K) and returns the URL of the result. */
export function runUpscale(imageUrl: string): Promise<string> {
  return runTool("upscale-image", { image_url: imageUrl, platform: "atlascloud", scale: 4 }, "upscaled_url", "Upscale failed");
}
