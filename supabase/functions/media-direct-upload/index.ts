/**
 * Browser-direct media upload, for files too large for the base64 edge path.
 *
 *   start    → validates the file, picks providers from Settings → CDN storage,
 *              and returns one signed upload target per provider plus a session.
 *   (browser uploads the bytes straight to Openinary / Cloudinary)
 *   complete → confirms each provider holds the object, then records it in the library.
 *
 * No file bytes ever pass through this function: an edge worker has 150 MB of
 * memory and 60 seconds, which a 500 MB video cannot fit through.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { readJsonBodyCapped } from "../_shared/cappedJsonBody.ts";
import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { getOpeninaryConfig, openinaryTarget } from "../_shared/openinary.ts";
import { checkUserRateLimit } from "../_shared/rate-limiter.ts";
import { mediaQuotaBody, type QuotaRpc } from "../_shared/mediaQuotaError.ts";
import { mediaQuotaPreflight } from "../cloudinary-upload/mediaQuota.ts";
import { getCdnPolicy } from "../cloudinary-upload/providerPolicy.ts";
import { getTodayFolder, mediaPublicId, sanitizeEmailForFolder } from "../cloudinary-upload/objectNaming.ts";
import { cloudinaryPublicIdMatches, planDirectUpload } from "./plan.ts";
import {
  cloudinaryAssetMismatch,
  cloudinaryUploadTarget,
  confirmOpeninaryObject,
  fetchCloudinaryAsset,
  isGenuineCloudinaryResult,
  openinaryUploadBaseUrl,
  openinaryUploadTarget,
  presignOpeninary,
  type UploadTarget,
} from "./providers.ts";
import { readUploadLimits, refuse } from "./refusals.ts";
import { registerDirectUpload, type CloudinaryStored } from "./register.ts";
import { SESSION_TTL_SECONDS, signSession, verifySession, type DirectUploadSession } from "./session.ts";

/** A start or complete request is a few hundred bytes; the signed session dominates. */
const MAX_BODY_BYTES = 64 * 1024;
/** Each start hands out signed upload targets, so it is bounded per user (see the spec, A3). */
const START_LIMIT = { max: 30, windowSeconds: 3600 };

const StartSchema = z.object({
  action: z.literal("start"),
  fileName: z.string().min(1).max(255),
  size: z.number().int().positive(),
  mimeType: z.string().max(127).nullish(),
});

const CloudinaryResultSchema = z.object({
  public_id: z.string().min(1),
  version: z.union([z.number(), z.string()]),
  signature: z.string().min(1),
  // Only public_id and version are signed; the stored URL and size come from the Admin API.
  secure_url: z.string().url().optional(),
  bytes: z.number().int().nonnegative().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  format: z.string().optional(),
  duration: z.number().optional(),
});

const CompleteSchema = z.object({
  action: z.literal("complete"),
  session: z.string().min(1).max(8192),
  results: z.object({
    openinary: z.object({ path: z.string().min(1).max(1024) }).optional(),
    cloudinary: CloudinaryResultSchema.optional(),
  }),
  /** Why the browser could not upload to a provider; recorded on its failed row. */
  failures: z.record(z.enum(["openinary", "cloudinary"]), z.string().max(500)).optional(),
});

const RequestSchema = z.discriminatedUnion("action", [StartSchema, CompleteSchema]);

function cloudinaryCredentials() {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}

async function handleStart(req: Request, input: z.infer<typeof StartSchema>, userId: string, userDb: SupabaseClient, adminDb: SupabaseClient, secret: string) {
  const fileFacts = { size: input.size, mime_type: input.mimeType ?? null };
  const rate = await checkUserRateLimit(adminDb, "media-direct-upload:start", userId, START_LIMIT.max, START_LIMIT.windowSeconds);
  if (!rate.allowed) {
    return refuse(req, adminDb, userId, {
      status: 429,
      reason: "rate_limited",
      body: { success: false, error: "Too many uploads started. Please wait and try again.", code: "rate_limited" },
      headers: { "Retry-After": String(rate.retryAfter) },
    });
  }

  const cloudinary = cloudinaryCredentials();
  const openinaryConfig = getOpeninaryConfig();
  const [policy, limits] = await Promise.all([getCdnPolicy(adminDb), readUploadLimits(adminDb)]);
  if (!limits) {
    return refuse(req, adminDb, userId, {
      status: 503,
      reason: "limits_unavailable",
      body: { success: false, error: "Uploads are temporarily unavailable. Please try again.", retryable: true },
    });
  }
  const plan = planDirectUpload(input, policy, { cloudinary: !!cloudinary, openinaryConfigured: !!openinaryConfig }, limits);
  if (!plan.ok) {
    return refuse(req, adminDb, userId, {
      status: plan.status,
      reason: plan.reason,
      body: { success: false, error: plan.error, retryable: plan.status === 503 },
      metadata: fileFacts,
    });
  }

  // The typed client answers rpc() with a thenable builder, which QuotaRpc models as a Promise.
  const blocked = await mediaQuotaPreflight(adminDb as unknown as QuotaRpc, userId);
  if (blocked) return refuse(req, adminDb, userId, { status: 429, reason: "quota_exceeded", body: mediaQuotaBody(blocked.limit), metadata: fileFacts });

  const { data: profile } = await adminDb.from("profiles").select("email").eq("id", userId).maybeSingle();
  const uploadDate = getTodayFolder();
  const folder = `media/${sanitizeEmailForFolder(profile?.email || userId)}/${uploadDate}`;
  const { data: seq, error: seqError } = await userDb.rpc("next_media_seq", { p_user_id: userId, p_upload_date: uploadDate });
  const publicId = mediaPublicId(uploadDate, userId, seqError || seq == null ? Date.now() : seq);

  const session: DirectUploadSession = {
    v: 1,
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    publicId,
    folder,
    uploadDate,
    ext: plan.ext,
    mime: plan.entry.mime,
    kind: plan.entry.kind,
    storedFileType: plan.entry.storedFileType,
    size: input.size,
    originalFilename: plan.originalFilename,
    providers: [],
    required: [],
    readPreference: policy.readPreference,
  };

  const targets: UploadTarget[] = [];
  const errors: string[] = [];
  for (const provider of plan.providers) {
    if (provider === "openinary" && openinaryConfig) {
      const place = openinaryTarget(`${folder}/${publicId}`, openinaryConfig.folderPrefix);
      const openinary = { folder: place.folder, fileName: `${place.baseName}.${plan.ext}` };
      const presign = await presignOpeninary(openinaryConfig, openinary.folder);
      if (!presign.ok) {
        errors.push(`openinary: ${presign.error}`);
        continue;
      }
      session.openinary = openinary;
      targets.push(openinaryUploadTarget(openinaryUploadBaseUrl(openinaryConfig), openinary, presign));
    } else if (provider === "cloudinary" && cloudinary) {
      targets.push(await cloudinaryUploadTarget({
        ...cloudinary,
        resourceType: plan.entry.kind === "video" ? "video" : "image",
        folder,
        publicId,
        timestamp: Math.floor(Date.now() / 1000),
      }));
    } else {
      continue;
    }
    session.providers.push(provider);
  }
  if (targets.length === 0) {
    return refuse(req, adminDb, userId, {
      status: 503,
      reason: "no_provider_available",
      body: { success: false, error: "Storage temporarily unavailable", retryable: true },
      metadata: { ...fileFacts, provider_errors: errors },
    });
  }
  // Kept from the policy even when a required provider could not be presigned, so
  // `complete` reports the upload as partial, as the edge-function path does.
  session.required = plan.required;

  return restrictedJsonResponse(req, {
    success: true,
    session: await signSession(session, secret),
    targets,
  });
}

async function handleComplete(req: Request, input: z.infer<typeof CompleteSchema>, userId: string, userDb: SupabaseClient, adminDb: SupabaseClient, secret: string) {
  const checked = await verifySession(input.session, secret, userId);
  if (!checked.ok) {
    const expired = checked.reason === "expired";
    return refuse(req, adminDb, userId, {
      status: expired ? 410 : 400,
      reason: `session_${checked.reason}`,
      body: { success: false, error: expired ? "The upload took too long. Please try again." : "Invalid upload session" },
    });
  }
  const { session } = checked;
  const errors: string[] = [];
  const failureFor = (provider: "openinary" | "cloudinary") =>
    `${provider}: ${input.failures?.[provider] || "the browser upload did not finish"}`;

  let openinary: { path: string; url: string } | null = null;
  if (session.providers.includes("openinary") && session.openinary) {
    const config = getOpeninaryConfig();
    if (input.results.openinary && config) {
      const confirmed = await confirmOpeninaryObject(config, session.openinary, input.results.openinary.path, session.size);
      if (confirmed.ok) openinary = { path: confirmed.path, url: confirmed.url };
      else errors.push(confirmed.error);
    } else {
      errors.push(failureFor("openinary"));
    }
  }

  let cloudinary: CloudinaryStored | null = null;
  const credentials = cloudinaryCredentials();
  if (session.providers.includes("cloudinary")) {
    const result = input.results.cloudinary;
    if (result && credentials) {
      const genuine = await isGenuineCloudinaryResult(result, credentials.apiSecret);
      const ours = cloudinaryPublicIdMatches(result.public_id, session.publicId);
      if (!genuine || !ours) {
        errors.push(`cloudinary: ${genuine ? "result is for another object" : "result signature does not match"}`);
      } else {
        const confirmed = await fetchCloudinaryAsset(credentials, session.kind === "video" ? "video" : "image", result.public_id);
        const mismatch = confirmed.ok ? cloudinaryAssetMismatch(confirmed.asset, result.version, session.size) : confirmed.error;
        if (confirmed.ok && !mismatch) cloudinary = confirmed.asset;
        else errors.push(mismatch!);
      }
    } else {
      errors.push(failureFor("cloudinary"));
    }
  }

  const outcome = await registerDirectUpload(userDb, adminDb, {
    session,
    cloudinary,
    openinary,
    errors,
    cloudName: credentials?.cloudName,
  });
  if (outcome.refusal) {
    return refuse(req, adminDb, userId, {
      status: outcome.status,
      reason: outcome.refusal,
      body: outcome.body,
      metadata: { public_id: session.publicId, provider_errors: errors },
    });
  }
  return restrictedJsonResponse(req, outcome.body, outcome.status);
}

export async function handleMediaDirectUpload(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  if (req.method !== "POST") return restrictedJsonResponse(req, { success: false, error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // cdn_storage, the quota RPC, media_file_providers and system_logs are admin-only under RLS.
  const adminDb = createClient(supabaseUrl, serviceRoleKey);

  let userId: string;
  try {
    // No body user id is passed, so a service-role bearer is refused: this path is for browsers only.
    ({ userId } = await authenticateCaller(req, null));
  } catch {
    // Console only: a log row here would let anyone without a session write to system_logs.
    return refuse(req, null, null, {
      status: 401,
      reason: "unauthenticated",
      body: { success: false, error: "Authentication failed. Please refresh the page and try again." },
    });
  }

  const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
  if (!body.ok && body.reason === "too_large") {
    return refuse(req, adminDb, userId, { status: 413, reason: "body_too_large", body: { success: false, error: "Request too large" } });
  }
  const parsed = RequestSchema.safeParse(body.ok ? body.value : null);
  if (!parsed.success) return refuse(req, adminDb, userId, { status: 400, reason: "invalid_request", body: { success: false, error: "Invalid request" } });

  const userDb = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization")! } },
  });

  try {
    return parsed.data.action === "start"
      ? await handleStart(req, parsed.data, userId, userDb, adminDb, serviceRoleKey)
      : await handleComplete(req, parsed.data, userId, userDb, adminDb, serviceRoleKey);
  } catch (error) {
    console.error("[media-direct-upload] unexpected failure:", error instanceof Error ? error.message : String(error));
    return restrictedJsonResponse(req, { success: false, error: "Upload failed. Please try again." }, 500);
  }
}

Deno.serve(handleMediaDirectUpload);
