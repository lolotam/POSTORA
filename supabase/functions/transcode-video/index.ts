/**
 * transcode-video: re-encode a stored video to a platform preset (TikTok, Instagram, YouTube)
 * and add the result to the library.
 *
 * The work is done by Openinary; Cloudinary is only a fallback for a video that exists nowhere
 * else. See docs/superpowers/specs/2026-10-30-openinary-video-processing-design.md.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse } from "../_shared/cors.ts";
import { cloudinaryCredentialsFromEnv } from "../_shared/cloudinaryVideoFallback.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { getOpeninaryConfig } from "../_shared/openinary.ts";
import { cloudinaryTranscodeTransformation, planTranscode } from "../_shared/openinaryVideoTransform.ts";
import { identifyVideoCaller } from "../_shared/videoCaller.ts";
import { deriveVideo } from "../_shared/videoDerivation.ts";
import { mapVideoFailure } from "../_shared/videoErrorMapping.ts";
import { parseTranscodeRequest, type TranscodeInput } from "./request.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface TranscodeResponse {
  success: boolean;
  transcoded_url?: string;
  new_media_file_id?: string;
  error?: string;
  error_code?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let userId: string | undefined;
  let input: TranscodeInput | undefined;

  try {
    input = parseTranscodeRequest(await req.json().catch(() => null));
    userId = await identifyVideoCaller(req, input.user_id);

    const plan = planTranscode(input.target_platform || undefined);
    const result = await deriveVideo(
      { adminDb: db, openinary: getOpeninaryConfig(), cloudinary: cloudinaryCredentialsFromEnv() },
      {
        mediaFileId: input.media_file_id,
        userId,
        label: plan.platform,
        openinaryPlan: () => plan,
        cloudinaryTransformation: () => cloudinaryTranscodeTransformation(plan.platform),
        metadata: { source: "processed", operation: "transcode", transcoded_from: input.media_file_id, target_platform: plan.platform },
      },
    );

    const response: TranscodeResponse = { success: true, transcoded_url: result.url, new_media_file_id: result.mediaFileId };
    return jsonResponse(response);
  } catch (error) {
    const failure = mapVideoFailure(error);
    if (failure.logLevel === "error") console.error("[transcode-video] unexpected failure:", error);
    await logToDatabase(db, {
      level: failure.logLevel,
      category: "system",
      source: "transcode-video",
      message: `Transcode refused: ${failure.code}`,
      user_id: userId,
      metadata: { error_code: failure.code, target_platform: input?.target_platform, media_file_id: input?.media_file_id },
    });
    return jsonResponse(failure.body, failure.status);
  }
});
