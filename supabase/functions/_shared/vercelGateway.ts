// deno-lint-ignore-file no-import-prefix no-explicit-any
// The only module that imports the AI SDK. Image, video, speech and transcription
// on the gateway are not plain OpenAI endpoints; the SDK owns their wire format.
import { createGateway } from "npm:@ai-sdk/gateway@4.0.92";
import {
  experimental_getVideoStatus, experimental_startVideo, generateImage, generateSpeech, transcribe,
} from "npm:ai@7.0.114";
import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import type { JobSnapshot } from "./higgsfield-job-payload.ts";

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

const gatewayFor = (apiKey: string) => createGateway({ apiKey });

export async function resolveVercelKey(db: any): Promise<string | null> {
  const fromEnv = Deno.env.get("AI_GATEWAY_API_KEY");
  if (fromEnv) return fromEnv;
  const { data } = await db.from("provider_api_keys").select("api_key").eq("provider_code", "vercel").maybeSingle();
  return data?.api_key ?? null;
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
  const ratio = /^\d+:\d+$/.test(aspectRatio) ? aspectRatio as `${number}:${number}` : undefined;
  const { image } = await generateImage({
    model: gatewayFor(apiKey).imageModel(modelId), prompt, aspectRatio: ratio,
    abortSignal: AbortSignal.timeout(50_000),
  });
  return { imageUrl: `data:${image.mediaType};base64,${image.base64}`, description: "Image generated successfully" };
}

export async function vercelStartVideo(
  apiKey: string, modelId: string,
  input: { prompt: string; duration?: number; aspectRatio?: string; imageUrl?: string },
) {
  const result = await experimental_startVideo({
    model: gatewayFor(apiKey).videoModel(modelId),
    // Image-to-video takes a hosted URL: the gateway caps a persisted start request at 300 KiB.
    prompt: input.imageUrl ? { image: input.imageUrl, text: input.prompt } : input.prompt,
    duration: input.duration,
    aspectRatio: input.aspectRatio as `${number}:${number}` | undefined,
    abortSignal: AbortSignal.timeout(30_000),
  });
  const job = (result.providerMetadata as any)?.gateway?.asyncJob;
  return { operation: result.operation, gatewayJobId: typeof job?.jobId === "string" ? job.jobId : null };
}

export async function vercelVideoStatus(apiKey: string, modelId: string, operation: unknown) {
  const status = await experimental_getVideoStatus(gatewayFor(apiKey).videoModel(modelId), {
    operation: operation as any, abortSignal: AbortSignal.timeout(20_000),
  });
  return toVideoSnapshot(status as VideoStatusLike);
}

export async function vercelGenerateSpeech(apiKey: string, modelId: string, text: string, voice?: string, outputFormat = "mp3") {
  const result = await generateSpeech({
    model: gatewayFor(apiKey).speechModel(modelId), text, voice, outputFormat,
    abortSignal: AbortSignal.timeout(45_000),
  });
  return { base64: result.audio.base64, mediaType: result.audio.mediaType };
}

export async function vercelTranscribe(apiKey: string, modelId: string, audio: Uint8Array) {
  const result = await transcribe({
    model: gatewayFor(apiKey).transcriptionModel(modelId), audio,
    abortSignal: AbortSignal.timeout(50_000),
  });
  return { transcript: result.text, language: result.language ?? "unknown", duration: result.durationInSeconds ?? 0 };
}
