// deno-lint-ignore-file no-import-prefix
// The only module that imports the AI SDK. Image, video, speech and transcription
// on the gateway are not plain OpenAI endpoints; the SDK owns their wire format.
//
// The SDK is loaded lazily (see `loadSdk` below), not via a top-level import.
// `npm:@ai-sdk/gateway@4.0.92` pulls in `@vercel/oidc`, whose CJS module calls
// `os.hostname()` at load time, which requires `--allow-sys`. A top-level
// import would force every consumer of this module — and every edge function
// that imports it, whether or not it ever calls Vercel — to carry that
// permission and risk a boot failure. Deferring the import until a wrapper
// actually runs keeps `--allow-sys` out of the repo's edge test gate.
import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import type { JobSnapshot } from "./higgsfield-job-payload.ts";
import type { RowReader } from "./providerEndpoint.ts";
import { resolveProviderKey } from "./providerKeys.ts";

/**
 * Memoize an async loader, but only while it keeps succeeding.
 *
 * A plain `cached ??= fn()` would pin a transient failure (registry hiccup,
 * cold-start network blip) into the module scope forever — every later call
 * on that warm isolate would re-throw the same stale rejection with no way
 * to recover short of a redeploy. Clearing the memo in the `catch` means the
 * next call retries `fn()` from scratch instead.
 */
export function memoizeRetryable<T>(fn: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      cached = fn().catch((error) => {
        cached = null;
        throw error;
      });
    }
    return cached;
  };
}

type Sdk = { ai: typeof import("npm:ai@7.0.114"); gw: typeof import("npm:@ai-sdk/gateway@4.0.92") };

const loadSdk: () => Promise<Sdk> = memoizeRetryable(() =>
  Promise.all([
    import("npm:ai@7.0.114"),
    import("npm:@ai-sdk/gateway@4.0.92"),
  ]).then(([ai, gw]) => ({ ai, gw }))
);

export interface VercelVideoSnapshot extends JobSnapshot {
  outputBase64: string | null;
  outputMediaType: string | null;
}

export type VideoStatusLike =
  | { status: "pending" }
  | { status: "completed"; videos: Array<
      | { type: "url"; url: string; mediaType: string }
      | { type: "base64"; data: string; mediaType: string }
      | { type: "binary"; data: Uint8Array; mediaType?: string }> }
  | { status: "error"; error: string };

export function resolveVercelKey(db: RowReader | undefined): Promise<string | null> {
  return resolveProviderKey(db, "vercel");
}

export function toVideoSnapshot(status: VideoStatusLike): VercelVideoSnapshot {
  const base = { outputUrl: null, outputBase64: null, outputMediaType: null, error: null, pollAfterSeconds: 10 };
  if (status.status === "pending") return { ...base, state: "running", status: "pending" } as VercelVideoSnapshot;
  if (status.status === "error") return { ...base, state: "failed", status: "error", error: status.error } as VercelVideoSnapshot;
  const video = status.videos[0];
  if (!video) return { ...base, state: "failed", status: "completed", error: "Gateway returned no video" } as VercelVideoSnapshot;
  if (video.type === "url") return { ...base, state: "succeeded", status: "completed", outputUrl: video.url, outputMediaType: video.mediaType } as VercelVideoSnapshot;
  const b64 = video.type === "base64" ? video.data : encodeBase64(video.data);
  return { ...base, state: "succeeded", status: "completed", outputBase64: b64, outputMediaType: video.mediaType ?? "video/mp4" } as VercelVideoSnapshot;
}

export async function vercelGenerateImage(apiKey: string, modelId: string, prompt: string, aspectRatio: string) {
  const { ai, gw } = await loadSdk();
  const ratio = /^\d+:\d+$/.test(aspectRatio) ? aspectRatio as `${number}:${number}` : undefined;
  const { image } = await ai.generateImage({
    model: gw.createGateway({ apiKey }).imageModel(modelId), prompt, aspectRatio: ratio,
    abortSignal: AbortSignal.timeout(50_000),
  });
  return { imageUrl: `data:${image.mediaType};base64,${image.base64}`, description: "Image generated successfully" };
}

export async function vercelStartVideo(
  apiKey: string, modelId: string,
  input: { prompt: string; duration?: number; aspectRatio?: string; imageUrl?: string },
) {
  const { ai, gw } = await loadSdk();
  const result = await ai.experimental_startVideo({
    model: gw.createGateway({ apiKey }).videoModel(modelId),
    // Image-to-video takes a hosted URL: the gateway caps a persisted start request at 300 KiB.
    prompt: input.imageUrl ? { image: input.imageUrl, text: input.prompt } : input.prompt,
    duration: input.duration,
    aspectRatio: input.aspectRatio as `${number}:${number}` | undefined,
    abortSignal: AbortSignal.timeout(30_000),
  });
  const job = (result.providerMetadata as { gateway?: { asyncJob?: { jobId?: unknown } } } | undefined)?.gateway?.asyncJob;
  return { operation: result.operation, gatewayJobId: typeof job?.jobId === "string" ? job.jobId : null };
}

export async function vercelVideoStatus(apiKey: string, modelId: string, operation: unknown) {
  const { ai, gw } = await loadSdk();
  const status = await ai.experimental_getVideoStatus(gw.createGateway({ apiKey }).videoModel(modelId), {
    operation: operation as Parameters<Sdk["ai"]["experimental_getVideoStatus"]>[1]["operation"], abortSignal: AbortSignal.timeout(20_000),
  });
  return toVideoSnapshot(status as VideoStatusLike);
}

export async function vercelGenerateSpeech(
  apiKey: string, modelId: string, text: string, voice?: string, outputFormat = "mp3", timeoutMs = 45_000,
) {
  const { ai, gw } = await loadSdk();
  const result = await ai.generateSpeech({
    model: gw.createGateway({ apiKey }).speechModel(modelId), text, voice, outputFormat,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return { base64: result.audio.base64, mediaType: result.audio.mediaType };
}

export async function vercelTranscribe(apiKey: string, modelId: string, audio: Uint8Array) {
  const { ai, gw } = await loadSdk();
  const result = await ai.transcribe({
    model: gw.createGateway({ apiKey }).transcriptionModel(modelId), audio,
    abortSignal: AbortSignal.timeout(50_000),
  });
  return { transcript: result.text, language: result.language ?? "unknown", duration: result.durationInSeconds ?? 0 };
}
