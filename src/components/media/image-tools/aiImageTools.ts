import { supabase } from "@/integrations/supabase/client";
import type { CdnStorageConfig } from "@/lib/cdnConfig";

/** What the AI image functions answer (HTTP 503) when no provider can serve the request. */
export const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE";
export const CLIENT_TIMEOUT_CODE = "CLIENT_TIMEOUT";

/** How long the browser keeps asking for a job that is still running before it gives up. */
const MAX_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_MS = 3000;

/**
 * Cloudinary delivery transforms (resize, filters, quality, `e_background_removal`,
 * `e_upscale`) work only while the admin's CDN policy still writes to Cloudinary. This is the
 * policy half of the rule the edge functions apply; they also check the server credentials
 * and stay authoritative: the browser never tells them which provider to use.
 */
export function isCloudinaryTransformsAvailable(config: CdnStorageConfig | undefined): boolean {
  return !!config?.write_policy.providers.includes("cloudinary");
}

export type CloudinaryTransformsState = "loading" | "available" | "unavailable";

/**
 * `loading` until the CDN config has arrived, so the UI neither shows the Cloudinary tools nor
 * announces they are gone while it does not know. A failed read is `unavailable`: the config
 * reader falls back to the Openinary-only default in that case too.
 */
export function cloudinaryTransformsState(query: { data?: CdnStorageConfig; isLoading: boolean }): CloudinaryTransformsState {
  if (!query.data && query.isLoading) return "loading";
  return isCloudinaryTransformsAvailable(query.data) ? "available" : "unavailable";
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

type ToolAnswer = { status: "done"; url: string } | { status: "processing"; token: string; retryMs: number };

async function callOnce(functionName: string, body: Record<string, unknown>, resultField: string, fallback: string): Promise<ToolAnswer> {
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error) throw await readFailure(error, fallback);
  const answer = (data ?? {}) as Record<string, unknown>;
  if (answer.success && answer.status === "processing" && typeof answer.prediction_id === "string") {
    const seconds = Number(answer.retry_after_seconds);
    return { status: "processing", token: answer.prediction_id, retryMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS };
  }
  const url = answer[resultField];
  if (!answer.success || typeof url !== "string" || !url) {
    throw new AiImageToolError(typeof answer.error === "string" ? answer.error : fallback, null);
  }
  return { status: "done", url };
}

export interface ToolTiming {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxWaitMs?: number;
}

/**
 * Runs one AI tool. The server answers within about 45 s; a job that is still running comes back
 * as `processing` with a `prediction_id`, and this asks again with just that id until the result
 * is ready or `maxWaitMs` has passed. The server's own errors reach the caller unchanged.
 */
async function runTool(
  functionName: string,
  body: Record<string, unknown>,
  resultField: string,
  fallback: string,
  timing: ToolTiming,
): Promise<string> {
  const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = timing.now ?? Date.now;
  const deadline = now() + (timing.maxWaitMs ?? MAX_WAIT_MS);

  let answer = await callOnce(functionName, body, resultField, fallback);
  while (answer.status === "processing") {
    if (now() >= deadline) {
      throw new AiImageToolError("Processing timed out while waiting for the result. Please try again.", CLIENT_TIMEOUT_CODE);
    }
    await sleep(answer.retryMs);
    answer = await callOnce(functionName, { prediction_id: answer.token }, resultField, fallback);
  }
  return answer.url;
}

/** Removes the background of the image at `imageUrl` and returns the URL of the result. */
export function runBackgroundRemoval(imageUrl: string, timing: ToolTiming = {}): Promise<string> {
  return runTool("remove-background", { image_url: imageUrl }, "processed_url", "Background removal failed", timing);
}

/**
 * Upscales the image at `imageUrl` and returns the URL of the result. No provider is named: the
 * server picks one. Ask for `png` when the image may have transparency (a background-removed
 * cut-out); the server's default is already PNG for a PNG source.
 */
export function runUpscale(imageUrl: string, options: { outputFormat?: "png" | "jpeg" } & ToolTiming = {}): Promise<string> {
  const { outputFormat, ...timing } = options;
  return runTool(
    "upscale-image",
    { image_url: imageUrl, scale: 4, ...(outputFormat ? { output_format: outputFormat } : {}) },
    "upscaled_url",
    "Upscale failed",
    timing,
  );
}
