/**
 * process-video: crop or compress a stored video and add the result to the library.
 *
 * The work is done by Openinary (transformed delivery URL, ingested as a new object); see
 * docs/superpowers/specs/2026-10-30-openinary-video-processing-design.md for what Openinary
 * can and cannot do. Cloudinary is only a fallback for a video that exists nowhere else.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse } from "../_shared/cors.ts";
import { cloudinaryCredentialsFromEnv } from "../_shared/cloudinaryVideoFallback.ts";
import { loadOwnedVideo, storedVideoMetadata } from "../_shared/derivedVideoMedia.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { getOpeninaryConfig } from "../_shared/openinary.ts";
import {
  cloudinaryCompressTransformation,
  cloudinaryCropTransformation,
  type Dimensions,
  OpeninaryVideoError,
  parseDimensions,
  planCompress,
  planCrop,
} from "../_shared/openinaryVideoTransform.ts";
import { identifyVideoCaller } from "../_shared/videoCaller.ts";
import { deriveVideo, type DeriveResult } from "../_shared/videoDerivation.ts";
import { mapVideoFailure } from "../_shared/videoErrorMapping.ts";
import { parseProcessVideoRequest, type ProcessVideoInput } from "./request.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface ProcessVideoResponse {
  success: boolean;
  processed_url?: string;
  new_media_file_id?: string;
  warnings?: string[];
  error?: string;
  error_code?: string;
  debug?: {
    transformation?: string;
    provider?: string;
    video_metadata?: { width: number; height: number; duration?: number; format?: string };
    output_dimensions?: Dimensions | null;
  };
}

async function logToApiLogs(db: SupabaseClient, userId: string, requestData: unknown, responseData: unknown, statusCode: number) {
  try {
    await db.from("api_logs").insert({
      user_id: userId,
      endpoint: "process-video",
      method: "POST",
      request_data: requestData,
      response_data: responseData,
      status_code: statusCode,
    });
  } catch (err) {
    console.error("Failed to log to api_logs:", err);
  }
}

async function metadataReply(db: SupabaseClient, input: ProcessVideoInput, userId: string): Promise<ProcessVideoResponse> {
  const { row } = await loadOwnedVideo(db, input.media_file_id, userId);
  const metadata = storedVideoMetadata(row) ?? parseDimensions(input.source_dimensions);
  // Openinary has no probe endpoint: only what the library recorded (or the player reported) is known.
  if (!metadata) throw new OpeninaryVideoError("METADATA_UNAVAILABLE", "This video's size and duration are not recorded, and the storage provider cannot report them.");
  return { success: true, debug: { video_metadata: metadata } };
}

async function processReply(db: SupabaseClient, input: ProcessVideoInput, userId: string): Promise<{ response: ProcessVideoResponse; result: DeriveResult }> {
  const base = { mediaFileId: input.media_file_id, userId, claimedDimensions: input.source_dimensions ?? undefined };
  const common = { source: "processed", operation: input.operation, original_file_id: input.media_file_id };
  const deps = { adminDb: db, openinary: getOpeninaryConfig(), cloudinary: cloudinaryCredentialsFromEnv() };

  let result: DeriveResult;
  if (input.operation === "crop") {
    const crop = input.crop!;
    result = await deriveVideo(deps, {
      ...base,
      label: "crop",
      openinaryPlan: (dims) => planCrop(crop, dims),
      cloudinaryTransformation: (dims) => cloudinaryCropTransformation(crop, dims),
      metadata: { ...common, crop_settings: crop },
    });
  } else {
    const compress = input.compress!;
    result = await deriveVideo(deps, {
      ...base,
      label: "compress",
      openinaryPlan: (dims) => planCompress(compress, dims),
      cloudinaryTransformation: () => cloudinaryCompressTransformation(compress),
      metadata: { ...common, compress_settings: compress },
      maxSizeMB: compress.maxSizeMB,
      mustShrink: true,
    });
  }

  const response: ProcessVideoResponse = {
    success: true,
    processed_url: result.url,
    new_media_file_id: result.mediaFileId,
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
  };
  if (input.debug_mode) {
    response.debug = {
      transformation: result.transformation,
      provider: result.provider,
      output_dimensions: result.outputDimensions,
      ...(result.sourceDimensions ? { video_metadata: result.sourceDimensions } : {}),
    };
  }
  return { response, result };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let userId: string | undefined;
  let input: ProcessVideoInput | undefined;

  try {
    input = parseProcessVideoRequest(await req.json().catch(() => null));
    userId = await identifyVideoCaller(req, input.user_id);

    if (input.operation === "get_metadata") return jsonResponse(await metadataReply(db, input, userId));

    const { response } = await processReply(db, input, userId);
    if (input.debug_mode) await logToApiLogs(db, userId, input, response, 200);
    return jsonResponse(response);
  } catch (error) {
    const failure = mapVideoFailure(error);
    if (failure.logLevel === "error") console.error("[process-video] unexpected failure:", error);
    await logToDatabase(db, {
      level: failure.logLevel,
      category: "system",
      source: "process-video",
      message: `Video ${input?.operation ?? "request"} refused: ${failure.code}`,
      user_id: userId,
      metadata: { error_code: failure.code, operation: input?.operation, media_file_id: input?.media_file_id },
    });
    if (input?.debug_mode && userId) await logToApiLogs(db, userId, input, failure.body, failure.status);
    return jsonResponse(failure.body, failure.status);
  }
});
