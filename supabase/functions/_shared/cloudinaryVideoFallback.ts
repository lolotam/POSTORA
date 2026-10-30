/**
 * Cloudinary fallback for video processing: only for media that exists nowhere but Cloudinary.
 * One signed upload with an `eager` transformation, the call process-video and
 * transcode-video each used to carry a copy of.
 */

import { cloudinarySignature } from "./cloudinarySignature.ts";
import { isDisabledCloudResponse } from "./mediaDeletePlan.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";

export interface CloudinaryCredentials { cloudName: string; apiKey: string; apiSecret: string }

export function cloudinaryCredentialsFromEnv(): CloudinaryCredentials | null {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}

const UNAVAILABLE = "This video is only stored in Cloudinary, which is no longer available, and it is not in the new media library. Upload it again to process it.";

/** `bytes` is Cloudinary's own count for the eager rendition, null when it did not report one. */
export interface CloudinaryDerived { publicId: string; url: string; bytes: number | null }

export async function deriveWithCloudinary(args: {
  credentials: CloudinaryCredentials | null;
  publicId: string;
  deliveryUrl: string | null;
  label: string;
  transformation: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudinaryDerived> {
  const { credentials, transformation } = args;
  if (!credentials) throw new OpeninaryVideoError("PROVIDER_UNAVAILABLE", UNAVAILABLE);
  const fetchImpl = args.fetchImpl ?? fetch;

  const sourceUrl = args.deliveryUrl ?? `https://res.cloudinary.com/${credentials.cloudName}/video/upload/${args.publicId}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `postora_${args.label}_${timestamp}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const params: Record<string, string | number> = { eager: transformation, eager_async: "false", public_id: publicId, timestamp };
  const signature = await cloudinarySignature(
    Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&") + credentials.apiSecret,
  );

  const form = new FormData();
  form.append("file", sourceUrl);
  form.append("public_id", publicId);
  form.append("timestamp", String(timestamp));
  form.append("eager", transformation);
  form.append("eager_async", "false");
  form.append("api_key", credentials.apiKey);
  form.append("signature", signature);

  let response: Response;
  try {
    response = await fetchImpl(`https://api.cloudinary.com/v1_1/${credentials.cloudName}/video/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(50_000),
    });
  } catch (error) {
    console.error("[cloudinary-video-fallback] request failed:", error instanceof Error ? error.name : "unknown");
    throw new OpeninaryVideoError("PROVIDER_UNAVAILABLE", UNAVAILABLE);
  }
  const result = await response.json().catch(() => ({})) as {
    error?: { message?: string };
    public_id?: string;
    eager?: { secure_url?: string; bytes?: unknown }[];
  };
  const message = result?.error?.message;
  if (isDisabledCloudResponse(response.status, message)) throw new OpeninaryVideoError("PROVIDER_UNAVAILABLE", UNAVAILABLE);
  if (!response.ok || result?.error) {
    console.error("[cloudinary-video-fallback] upload refused with HTTP", response.status, message ?? "");
    if (message && /file size too large/i.test(message)) {
      throw new OpeninaryVideoError("SOURCE_TOO_LARGE", "The video file is too large to process.");
    }
    throw new OpeninaryVideoError("TRANSFORM_FAILED", "The video could not be processed.");
  }
  const url = result.eager?.[0]?.secure_url
    ?? `https://res.cloudinary.com/${credentials.cloudName}/video/upload/${transformation}/${publicId}.mp4`;
  const bytes = result.eager?.[0]?.bytes;
  return { publicId: result.public_id ?? publicId, url, bytes: typeof bytes === "number" && bytes > 0 ? bytes : null };
}
