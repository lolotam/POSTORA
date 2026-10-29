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
import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { getOpeninaryConfig, openinaryTarget } from "../_shared/openinary.ts";
import { mediaQuotaBody, type QuotaRpc } from "../_shared/mediaQuotaError.ts";
import { mediaQuotaPreflight } from "../cloudinary-upload/mediaQuota.ts";
import { getCdnPolicy } from "../cloudinary-upload/providerPolicy.ts";
import { getTodayFolder, mediaPublicId, sanitizeEmailForFolder } from "../cloudinary-upload/objectNaming.ts";
import { cloudinaryPublicIdMatches, planDirectUpload } from "./plan.ts";
import {
  cloudinaryUploadTarget,
  confirmOpeninaryObject,
  isGenuineCloudinaryResult,
  openinaryUploadBaseUrl,
  openinaryUploadTarget,
  presignOpeninary,
  type UploadTarget,
} from "./providers.ts";
import { registerDirectUpload, type CloudinaryStored } from "./register.ts";
import { SESSION_TTL_SECONDS, signSession, verifySession, type DirectUploadSession } from "./session.ts";

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
  secure_url: z.string().url(),
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
  const cloudinary = cloudinaryCredentials();
  const openinaryConfig = getOpeninaryConfig();
  const policy = await getCdnPolicy(adminDb);
  const plan = planDirectUpload(input, policy, { cloudinary: !!cloudinary, openinaryConfigured: !!openinaryConfig });
  if (!plan.ok) {
    console.warn(`[media-direct-upload] start refused: ${plan.reason}`);
    return restrictedJsonResponse(req, { success: false, error: plan.error, retryable: plan.status === 503 }, plan.status);
  }

  // The typed client answers rpc() with a thenable builder, which QuotaRpc models as a Promise.
  const blocked = await mediaQuotaPreflight(adminDb as unknown as QuotaRpc, userId);
  if (blocked) return restrictedJsonResponse(req, mediaQuotaBody(blocked.limit), 429);

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
    console.error(`[media-direct-upload] no provider could take the upload: ${errors.join("; ")}`);
    return restrictedJsonResponse(req, { success: false, error: "Storage temporarily unavailable", retryable: true }, 503);
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
    console.warn(`[media-direct-upload] complete refused: session ${checked.reason}`);
    const expired = checked.reason === "expired";
    return restrictedJsonResponse(req, { success: false, error: expired ? "The upload took too long. Please try again." : "Invalid upload session" }, expired ? 410 : 400);
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
      if (genuine && ours) cloudinary = result;
      else errors.push(`cloudinary: ${genuine ? "result is for another object" : "result signature does not match"}`);
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
  if (outcome.status !== 200) console.error(`[media-direct-upload] complete failed with ${outcome.status}: ${errors.join("; ")}`);
  return restrictedJsonResponse(req, outcome.body, outcome.status);
}

export async function handleMediaDirectUpload(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  if (req.method !== "POST") return restrictedJsonResponse(req, { success: false, error: "Method not allowed" }, 405);

  let userId: string;
  try {
    // No body user id is passed, so a service-role bearer is refused: this path is for browsers only.
    ({ userId } = await authenticateCaller(req, null));
  } catch {
    return restrictedJsonResponse(req, { success: false, error: "Authentication failed. Please refresh the page and try again." }, 401);
  }

  const parsed = RequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return restrictedJsonResponse(req, { success: false, error: "Invalid request" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userDb = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization")! } },
  });
  // cdn_storage, the quota RPC and media_file_providers are admin-only under RLS.
  const adminDb = createClient(supabaseUrl, serviceRoleKey);

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
