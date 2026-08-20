import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getOpeninaryConfig, openinaryTarget, uploadToOpeninary } from "../_shared/openinary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};

interface UploadRequest {
  fileData?: string; // base64 encoded file (required if no externalUrl)
  externalUrl?: string; // External URL to upload (for stock media)
  fileName: string;
  fileType: "image" | "video" | "gif" | "raw"; // raw = documents (CSV/PDF/TXT/…)
  platforms?: string[]; // Platforms this media is being posted to
  socialAccountIds?: string[]; // Social account IDs involved
  subfolder?: string; // Override daily folder with a custom subfolder
  skipMediaFiles?: boolean; // Skip media_files DB insert (for non-media assets like avatars)
}

interface UploadResponse {
  success: boolean;
  url?: string;
  publicId?: string;
  cloudName?: string; // Cloudinary cloud name for building URLs
  mediaFileId?: string; // Database record ID
  width?: number;
  height?: number;
  format?: string;
  bytes?: number;
  duration?: number;
  error?: string;
  isDuplicate?: boolean; // Indicates if existing file was reused
  storedIn?: string[];
  partial?: boolean;
  errors?: string[];
}

type CdnPolicy = { providers: string[]; required: string[] };
async function getCdnPolicy(db: any): Promise<CdnPolicy> {
  const { data } = await db.from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
  const policy = data?.value?.write_policy;
  return { providers: Array.isArray(policy?.providers) && policy.providers.length ? policy.providers : ["cloudinary"], required: Array.isArray(policy?.required) && policy.required.length ? policy.required : ["cloudinary"] };
}

// Sanitize email for folder name (replace special chars)
function sanitizeEmailForFolder(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, "_at_")
    .replace(/\./g, "_")
    .replace(/[^a-z0-9_-]/g, "_");
}

// Get today's date in YYYY-MM-DD format
function getTodayFolder(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.error("Auth failed: missing or malformed Authorization header");
      return new Response(
        JSON.stringify({ success: false, error: "Missing or invalid authorization header. Please refresh the page and try again." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    let userId: string;
    let userEmail: string;

    // Try JWT claims validation first (no session lookup needed)
    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    
    if (claimsData?.claims?.sub) {
      // Normal frontend flow — JWT is valid
      userId = claimsData.claims.sub as string;
      userEmail = (claimsData.claims.email as string) || userId;
    } else if (claimsError && ['bad_jwt', 'invalid_jwt'].includes((claimsError as any).code)) {
      // Service-role caller (e.g. n8n-api) — accept userId from body
      console.log("JWT auth failed with bad_jwt, checking for service-role caller...");
      
      const bodyText = await req.text();
      const bodyJson = JSON.parse(bodyText);
      
      if (!bodyJson.userId) {
        console.error("Service-role caller did not provide userId in body");
        return new Response(
          JSON.stringify({ success: false, error: "Unauthorized: missing userId for service-role call" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      // Verify userId exists using admin client
      const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
      const { data: profile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("id, email")
        .eq("id", bodyJson.userId)
        .single();
      
      if (profileError || !profile) {
        console.error("Service-role caller provided invalid userId:", bodyJson.userId);
        return new Response(
          JSON.stringify({ success: false, error: "Unauthorized: invalid userId" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      userId = profile.id;
      userEmail = profile.email || profile.id;
      
      (req as any)._parsedBody = bodyJson;
      (req as any)._supabaseAdmin = supabaseAdmin;
      
      console.log(`Service-role auth successful for user ${userId} (${userEmail})`);
    } else {
      const errorCode = (claimsError as any)?.code || 'unknown';
      const errorMsg = claimsError?.message || 'Unknown auth error';
      console.error(`Auth error [code=${errorCode}]: ${errorMsg}`);
      
      return new Response(
        JSON.stringify({ success: false, error: "Authentication failed. Please refresh the page and try again." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use admin client for DB ops if service-role caller, otherwise normal client
    const dbClient = (req as any)._supabaseAdmin || supabase;
    const userFolder = sanitizeEmailForFolder(userEmail);
    const dailyFolder = getTodayFolder();
    const todayDate = dailyFolder; // For database
    
    console.log(`User ${userId} (${userEmail}) requesting Cloudinary upload to folder: ${userFolder}/${dailyFolder}`);

    // Get Cloudinary credentials
    const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
    const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");

    if (!cloudName || !apiKey || !apiSecret) {
      console.error("Missing Cloudinary credentials");
      return new Response(
        JSON.stringify({ success: false, error: "Cloudinary temporarily unavailable", retryable: true }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use pre-parsed body if available (service-role path already consumed req.text())
    const parsedBody = (req as any)._parsedBody || await req.json();
    const { fileData, externalUrl, fileName, fileType, platforms = [], socialAccountIds = [], subfolder, skipMediaFiles = false }: UploadRequest = parsedBody;

    // Require either fileData OR externalUrl
    if ((!fileData && !externalUrl) || !fileName || !fileType) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields: (fileData or externalUrl), fileName, fileType" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Determine the upload source - Cloudinary accepts URLs directly
    const uploadSource = externalUrl || fileData;

    // Folder structure: media/{user_email_sanitized}/{YYYY-MM-DD}/
    const folder = subfolder
      ? `media/${userFolder}/${subfolder}`
      : `media/${userFolder}/${dailyFolder}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const cleanFileName = fileName.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    
    // Compute incoming file size for collision-proof dedupe
    let incomingFileSize: number | null = null;
    try {
      if (fileData) {
        // base64 → bytes: roughly len * 0.75, minus padding
        const b64 = fileData.includes(",") ? fileData.split(",")[1] : fileData;
        const padding = (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
        incomingFileSize = Math.floor((b64.length * 3) / 4) - padding;
      } else if (externalUrl) {
        try {
          const headRes = await fetch(externalUrl, { method: "HEAD" });
          const len = headRes.headers.get("content-length");
          if (len) incomingFileSize = parseInt(len, 10);
        } catch (e) {
          console.warn(`[cloudinary-upload] HEAD failed for externalUrl, skipping size check:`, e);
        }
      }
    } catch (e) {
      console.warn(`[cloudinary-upload] Could not compute incoming file size:`, e);
    }

    console.log(`Checking for recent duplicate of original filename: ${cleanFileName} (size=${incomingFileSize ?? "unknown"})`);

    // Dedupe window: last 5 minutes only (catches accidental double-clicks, not yesterday's file)
    const dedupeWindowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Find ANY recent uploads with the same original filename, then match on size in code
    // (files are stored under generated postora_* names, so the original name lives in metadata)
    const { data: recentCandidates } = await dbClient
      .from("media_files")
      .select("id, file_path, cloudinary_public_id, file_size, platforms, social_account_ids")
      .eq("user_id", userId)
      .eq("metadata->>original_filename", cleanFileName)
      .gt("created_at", dedupeWindowStart)
      .order("created_at", { ascending: false })
      .limit(5);

    let existingFile: any = null;
    if (recentCandidates && recentCandidates.length > 0) {
      if (incomingFileSize !== null) {
        existingFile = recentCandidates.find((c: any) => c.file_size === incomingFileSize) || null;
        if (!existingFile) {
          const oldSizes = recentCandidates.map((c: any) => c.file_size).join(", ");
          console.log(
            `[cloudinary-upload] Skipping dedupe — same name '${cleanFileName}' but different size (old=[${oldSizes}] vs new=${incomingFileSize}). Uploading as new file.`
          );
        }
      } else {
        // Size unknown — be conservative and DO NOT dedupe to avoid serving wrong content
        console.log(
          `[cloudinary-upload] Skipping dedupe — could not determine incoming size for '${cleanFileName}'. Uploading as new file.`
        );
      }
    }

    if (existingFile) {
      console.log(`Found matching recent file for ${cleanFileName} (size=${incomingFileSize}), reusing: ${existingFile.id}`);
      
      // Update platforms and social_account_ids if new ones provided
      const existingPlatforms = (existingFile.platforms as string[]) || [];
      const existingSocialAccountIds = (existingFile.social_account_ids as string[]) || [];
      
      const mergedPlatforms = [...new Set([...existingPlatforms, ...platforms])];
      const mergedSocialAccountIds = [...new Set([...existingSocialAccountIds, ...socialAccountIds])];
      
      // Update the record with merged data
      await dbClient
        .from("media_files")
        .update({
          platforms: mergedPlatforms,
          social_account_ids: mergedSocialAccountIds,
        })
        .eq("id", existingFile.id);

      const response: UploadResponse = {
        success: true,
        url: existingFile.file_path,
        publicId: existingFile.cloudinary_public_id,
        cloudName: cloudName,
        mediaFileId: existingFile.id,
        isDuplicate: true,
      };

      return new Response(JSON.stringify(response), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    
    // Postora naming convention: postora_<date>_<userId>_<seq>
    // Sequence numbers are allocated atomically per user per day, so concurrent
    // uploads never collide (Cloudinary uploads run with overwrite=true).
    const { data: seq, error: seqError } = await dbClient.rpc("next_media_seq", {
      p_user_id: userId,
      p_upload_date: todayDate,
    });
    if (seqError || seq == null) {
      console.warn(`[cloudinary-upload] next_media_seq failed (${seqError?.message}); falling back to timestamp suffix`);
    }
    const sequencePart = seqError || seq == null ? Date.now() : seq;
    // Raw files are delivered by exact public_id, so it must keep the file
    // extension (image/video public_ids must NOT have one).
    const fileExtension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
    const rawSuffix = fileType === "raw" && fileExtension ? `.${fileExtension}` : "";
    const uniquePublicId = `postora_${dailyFolder}_${userId}_${sequencePart}${rawSuffix}`;
    
    console.log(`Uploading ${fileType}: ${fileName} to folder: ${folder}/${uniquePublicId}`);

    // Build signature string - use overwrite to allow replacing duplicates
    const signatureParams = [
      `folder=${folder}`,
      `overwrite=true`,
      `public_id=${uniquePublicId}`,
      `timestamp=${timestamp}`,
    ].sort().join("&");

    // Create SHA-1 signature
    const encoder = new TextEncoder();
    const data = encoder.encode(signatureParams + apiSecret);
    const hashBuffer = await crypto.subtle.digest("SHA-1", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    console.log(`Generated signature for public_id: ${folder}/${uniquePublicId}`);

    // Determine upload endpoint
    const resourceType = fileType === "video" ? "video" : fileType === "raw" ? "raw" : "image";
    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;

    // Prepare form data - Cloudinary accepts both base64 and URLs
    const formData = new FormData();
    formData.append("file", uploadSource!);
    formData.append("api_key", apiKey);
    formData.append("timestamp", timestamp.toString());
    formData.append("signature", signature);
    formData.append("folder", folder);
    formData.append("public_id", uniquePublicId);
    formData.append("overwrite", "true");

    // Upload to Cloudinary
    console.log(`Uploading to Cloudinary: ${uploadUrl}`);
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      body: formData,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error("Cloudinary upload failed:", errorText);
      return new Response(
        JSON.stringify({ success: false, error: `Upload failed: ${errorText}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await uploadResponse.json();
    console.log(`Cloudinary upload successful: ${result.secure_url}`);

    const cdnPolicy = await getCdnPolicy(dbClient);
    // Store reference in database with platform/account tracking
    let mediaFileId: string | null = null;
    if (!skipMediaFiles) {
      const { data: mediaRecord, error: dbError } = await dbClient
        .from("media_files")
        .insert({
          user_id: userId,
          file_path: result.secure_url,
          file_type: fileType,
          file_size: result.bytes,
          mime_type:
            fileType === "video"
              ? "video/mp4"
              : fileType === "gif"
                ? "image/gif"
                : `image/${result.format}`,
          storage_bucket: "cloudinary",
          cloudinary_public_id: result.public_id,
          platforms: platforms,
          social_account_ids: socialAccountIds,
          upload_date: todayDate,
          metadata: {
            width: result.width || null,
            height: result.height || null,
            format: result.format || null,
            duration: result.duration || null,
            original_filename: cleanFileName,
          },
        })
        .select("id")
        .single();

      if (dbError) {
        console.error("Database insert error:", dbError);
        return new Response(
          JSON.stringify({ success: false, error: `Database error: ${dbError.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      mediaFileId = mediaRecord.id;
      console.log(`Media file record created with ID: ${mediaFileId}`);

      const objectVersion = 1;
      const cloudinaryKey = result.public_id as string;
      const providerRows = cdnPolicy.providers.map((provider) => ({ media_file_id: mediaFileId, provider, object_version: objectVersion, object_key: provider === "cloudinary" ? cloudinaryKey : `${getOpeninaryConfig()?.folderPrefix || "postora.cloud"}/${cloudinaryKey}.${fileExtension || result.format}`, status: "pending", bytes: result.bytes, mime_type: result.resource_type === "video" ? `video/${result.format}` : `image/${result.format}` }));
      const { error: providerInsertError } = await dbClient.from("media_file_providers").insert(providerRows);
      if (providerInsertError) return new Response(JSON.stringify({ success: false, error: `Provider state error: ${providerInsertError.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const storedIn: string[] = ["cloudinary"];
      const errors: string[] = [];
      const { error: cloudinaryStatusError } = await dbClient.from("media_file_providers").update({ status: "ready", delivery_url: result.secure_url }).eq("media_file_id", mediaFileId).eq("provider", "cloudinary").eq("object_version", objectVersion);
      if (cloudinaryStatusError) throw new Error(`Cloudinary provider status update failed: ${cloudinaryStatusError.message}`);
      if (cdnPolicy.providers.includes("openinary")) {
        const config = getOpeninaryConfig();
        if (!config) errors.push("openinary: unavailable");
        else {
          const target = openinaryTarget(cloudinaryKey, config.folderPrefix);
          const openResult = await uploadToOpeninary(config, result.secure_url, target.folder, target.baseName, fileExtension || result.format, result.bytes);
          if (openResult.success && openResult.path === `${target.folder}/${target.baseName}.${fileExtension || result.format}`) {
            storedIn.push("openinary");
            const { error: openinaryStatusError } = await dbClient.from("media_file_providers").update({ status: "ready", object_key: openResult.path, delivery_url: openResult.url }).eq("media_file_id", mediaFileId).eq("provider", "openinary").eq("object_version", objectVersion);
            if (openinaryStatusError) errors.push(`openinary status update: ${openinaryStatusError.message}`);
          } else {
            const error = openResult.error || "object key mismatch"; errors.push(`openinary: ${error}`);
            await dbClient.from("media_file_providers").update({ status: "failed", error }).eq("media_file_id", mediaFileId).eq("provider", "openinary").eq("object_version", objectVersion);
          }
        }
      }
      const requiredReady = cdnPolicy.required.every((provider) => storedIn.includes(provider));
      // Contract: a required provider success with a non-required provider failure is a successful partial upload; the failed provider row is the durable retry record. Return 500 only when nothing was stored.
      if (!requiredReady || storedIn.length === 0) return new Response(JSON.stringify({ success: false, partial: false, storedIn, errors }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      (result as any)._storedIn = storedIn; (result as any)._errors = errors;
    }

    const response: UploadResponse = {
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
      cloudName: cloudName,
      mediaFileId: mediaFileId ?? undefined, // Database UUID (omitted if skipped)
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
      duration: result.duration, // For videos
      isDuplicate: false,
      storedIn: (result as any)._storedIn || ["cloudinary"],
      partial: !!(result as any)._errors?.length && ((result as any)._storedIn || []).includes("cloudinary"),
      errors: (result as any)._errors,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Cloudinary upload error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
