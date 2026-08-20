import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getOpeninaryConfig, openinaryTarget, openinaryDeliveryUrl, uploadBytesToOpeninary } from "../_shared/openinary.ts";

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

type CdnPolicy = { providers: string[]; required: string[]; readPreference: string; openinaryEnabled: boolean };
async function getCdnPolicy(db: any): Promise<CdnPolicy> {
  const { data } = await db.from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
  const value = data?.value || {};
  const policy = value?.write_policy;
  return {
    providers: Array.isArray(policy?.providers) && policy.providers.length ? policy.providers : ["cloudinary"],
    required: Array.isArray(policy?.required) && policy.required.length ? policy.required : ["cloudinary"],
    readPreference: typeof value?.read_preference === "string" ? value.read_preference : "cloudinary",
    openinaryEnabled: value?.openinary?.enabled === true,
  };
}

// Canonical MIME per extension — Openinary rejects application/octet-stream uploads.
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", heic: "image/heic", heif: "image/heif", psd: "image/vnd.adobe.photoshop",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
};

// SSRF hardening for externalUrl fetching (the Openinary path downloads bytes from
// the edge runtime, unlike the Cloudinary path where Cloudinary's servers fetch).
// Known limit (same as the n8n node): DNS is validated per hop, but a rebinding
// race between check and fetch is not eliminated.
const MAX_EXTERNAL_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToUint32(ip);
  if (value === null) return true;
  // Bitwise AND yields a signed int32, so compare unsigned — literals with the top
  // byte >= 128 (169.254/16, 172.16/12, 192.168/16) otherwise never match.
  const blocked: [number, number][] = [
    [0x0A000000, 0xFF000000], // 10.0.0.0/8 private
    [0xAC100000, 0xFFF00000], // 172.16.0.0/12 private
    [0xC0A80000, 0xFFFF0000], // 192.168.0.0/16 private
    [0x7F000000, 0xFF000000], // 127.0.0.0/8 loopback
    [0xA9FE0000, 0xFFFF0000], // 169.254.0.0/16 link-local
    [0x00000000, 0xFF000000], // 0.0.0.0/8
    [0x64400000, 0xFFC00000], // 100.64.0.0/10 CGNAT
  ];
  return blocked.some(([network, mask]) => ((value & mask) >>> 0) === ((network & mask) >>> 0));
}

/** Expand an IPv6 address (including :: compression) to 8 numeric groups, or null if unparseable. */
function expandIpv6Groups(bare: string): number[] | null {
  const segments = bare.split("::");
  if (segments.length > 2) return null;
  const hasCompression = segments.length === 2;
  const head = segments[0] ? segments[0].split(":") : [];
  const tail = segments.length === 2 ? (segments[1] ? segments[1].split(":") : []) : [];
  // Trailing embedded IPv4 (e.g. 64:ff9b::1.2.3.4) becomes two hex groups.
  const parts = [...head, ...tail];
  const last = parts[parts.length - 1];
  if (last && last.includes(".")) {
    const v4 = ipv4ToUint32(last);
    if (v4 === null) return null;
    parts.pop();
    parts.push(((v4 >>> 16) & 0xFFFF).toString(16), (v4 & 0xFFFF).toString(16));
  }
  const missing = 8 - parts.length;
  if (hasCompression) {
    if (missing < 1) return null;
    const insertAt = head.length;
    parts.splice(insertAt, 0, ...Array(missing).fill("0"));
  } else if (parts.length !== 8) {
    return null;
  }
  const groups = parts.map((g) => parseInt(g, 16));
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xFFFF)) return null;
  return groups;
}

function isBlockedIpv6(ip: string): boolean {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (bare === "::" || bare === "::1") return true;
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const groups = expandIpv6Groups(bare);
  if (!groups) return true; // unparseable/zone forms are rejected conservatively
  const first = groups[0];
  if ((first & 0xFE00) === 0xFC00) return true; // fc00::/7 ULA
  if ((first & 0xFFC0) === 0xFE80) return true; // fe80::/10 link-local
  if ((first & 0xFF00) === 0xFF00) return true; // multicast
  if (groups.every((g) => g === 0)) return true; // unspecified
  return false;
}

async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid external URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) external URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("Credentials in external URLs are not allowed");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("Internal hostnames are not allowed for external uploads");
  }
  if (host.includes(":")) {
    if (isBlockedIpv6(host)) throw new Error("Private/reserved addresses are not allowed for external uploads");
    return url;
  }
  if (ipv4ToUint32(host) !== null) {
    if (isBlockedIpv4(host)) throw new Error("Private/reserved addresses are not allowed for external uploads");
    return url;
  }
  const [aRecords, aaaaRecords] = await Promise.all([
    Deno.resolveDns(host, "A").catch(() => [] as string[]),
    Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
  ]);
  const addresses = [...aRecords, ...aaaaRecords];
  if (addresses.length === 0) throw new Error(`Cannot resolve external host: ${host}`);
  for (const address of addresses) {
    const blocked = address.includes(":") ? isBlockedIpv6(address) : isBlockedIpv4(address);
    if (blocked) throw new Error(`External host ${host} resolves to a private address`);
  }
  return url;
}

/** Follow redirects manually, validating every hop's URL + DNS before fetching it. */
async function safeFetchExternal(rawUrl: string, timeoutMs = 30_000): Promise<Response> {
  let current = await assertSafeExternalUrl(rawUrl);
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, { method: "GET", redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      current = await assertSafeExternalUrl(new URL(location, current).toString());
      continue;
    }
    return response;
  }
  throw new Error("Too many redirects fetching external URL");
}

/** Stream-read a body, aborting as soon as the byte cap is exceeded. */
async function readCappedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) throw new Error(`External file exceeds the ${maxBytes} byte limit`);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
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
    // Provider-state writes (media_file_providers) always go through the admin client:
    // RLS on that table must never be able to fail an upload after bytes are stored.
    const dbAdmin = (req as any)._supabaseAdmin || createClient(supabaseUrl, serviceRoleKey);
    const userFolder = sanitizeEmailForFolder(userEmail);
    const dailyFolder = getTodayFolder();
    const todayDate = dailyFolder; // For database
    
    console.log(`User ${userId} (${userEmail}) requesting Cloudinary upload to folder: ${userFolder}/${dailyFolder}`);

    // Get Cloudinary credentials (optional when Openinary can serve the upload)
    const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
    const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
    const cloudinaryUsable = !!(cloudName && apiKey && apiSecret);
    const openinaryReadyForGate = !!getOpeninaryConfig();

    if (!cloudinaryUsable && !openinaryReadyForGate) {
      console.error("No storage provider available: missing Cloudinary credentials and Openinary config");
      return new Response(
        JSON.stringify({ success: false, error: "Storage temporarily unavailable", retryable: true }),
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

    // SSRF gate: validate the external URL (scheme, host, DNS targets) before any
    // provider touches it — the Openinary path downloads it from this runtime.
    if (externalUrl) {
      try {
        await assertSafeExternalUrl(externalUrl);
      } catch (e) {
        const reason = e instanceof Error ? e.message : "URL validation failed";
        return new Response(
          JSON.stringify({ success: false, error: `External URL rejected: ${reason}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

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

    const cdnPolicy = await getCdnPolicy(dbClient);
    const openinaryConfig = getOpeninaryConfig();
    const openinaryUsable = cdnPolicy.openinaryEnabled && !!openinaryConfig;
    // Openinary-first ordering (priority provider), dropping providers that cannot run.
    const orderedProviders: string[] = [];
    if (cdnPolicy.providers.includes("openinary") && openinaryUsable) orderedProviders.push("openinary");
    for (const p of cdnPolicy.providers) {
      if (p === "openinary") { if (!openinaryUsable) continue; }
      if (p === "cloudinary" && !cloudinaryUsable) continue;
      orderedProviders.push(p);
    }
    const effectiveProviders = [...new Set(orderedProviders.length ? orderedProviders : (cloudinaryUsable ? ["cloudinary"] : openinaryUsable ? ["openinary"] : []))];

    console.log(`Uploading ${fileType}: ${fileName} to folder: ${folder}/${uniquePublicId} via providers: [${effectiveProviders.join(", ")}]`);

    // Materialise payload bytes once so every provider stores identical content.
    let uploadSource = externalUrl || ""; // Cloudinary accepts remote URLs or base64 data URIs
    let payloadBytes: Uint8Array | null = null;
    if (fileData) {
      const b64Part = fileData.includes(",") ? fileData.split(",")[1] : fileData;
      uploadSource = fileData.startsWith("data:") ? fileData : `data:application/octet-stream;base64,${b64Part}`;
      if (effectiveProviders.includes("openinary")) {
        payloadBytes = Uint8Array.from(atob(b64Part), (c) => c.charCodeAt(0));
      }
    } else if (externalUrl && effectiveProviders.includes("openinary")) {
      try {
        const res = await safeFetchExternal(externalUrl);
        if (res.ok) {
          payloadBytes = await readCappedBytes(res, MAX_EXTERNAL_BYTES);
          if (!incomingFileSize) incomingFileSize = payloadBytes.length;
        } else {
          console.warn(`[cloudinary-upload] externalUrl fetch for Openinary failed: HTTP ${res.status}`);
        }
      } catch (e) {
        console.warn(`[cloudinary-upload] externalUrl fetch for Openinary failed:`, e);
      }
    }

    const objectExt = fileExtension || (fileType === "video" ? "mp4" : fileType === "gif" ? "gif" : "jpg");
    const openinaryBaseName = fileType === "raw" && fileExtension ? uniquePublicId.slice(0, -(fileExtension.length + 1)) : uniquePublicId;
    const openinaryFallbackKey = `${openinaryConfig?.folderPrefix || "postora.cloud"}/${folder}/${uniquePublicId}.${objectExt}`;

    const storedIn: string[] = [];
    const errors: string[] = [];
    let cloudinaryResult: any = null;
    let openinaryPath: string | null = null;
    let openinaryUrl: string | null = null;

    for (const provider of effectiveProviders) {
      try {
        if (provider === "openinary" && openinaryConfig && payloadBytes) {
          const target = openinaryTarget(`${folder}/${uniquePublicId}`, openinaryConfig.folderPrefix);
          const uploadMime = MIME_BY_EXT[objectExt] || (fileType === "video" ? "video/mp4" : `image/${objectExt}`);
          const openResult = await uploadBytesToOpeninary(openinaryConfig, payloadBytes, target.folder, openinaryBaseName, objectExt, uploadMime, payloadBytes.length);
          if (openResult.success && openResult.path) {
            openinaryPath = openResult.path;
            openinaryUrl = openResult.url || openinaryDeliveryUrl(openinaryConfig, openResult.path);
            storedIn.push("openinary");
            console.log(`Openinary upload successful: ${openinaryPath}`);
          } else {
            errors.push(`openinary: ${openResult.error || "unknown error"}`);
            console.error("Openinary upload failed:", openResult.error);
          }
        } else if (provider === "cloudinary") {
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

          // Determine upload endpoint
          const resourceType = fileType === "video" ? "video" : fileType === "raw" ? "raw" : "image";
          const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;

          // Prepare form data - Cloudinary accepts both base64 and URLs
          const formData = new FormData();
          formData.append("file", uploadSource!);
          // Non-null: the cloudinary branch is only reached when cloudinaryUsable was true.
          formData.append("api_key", apiKey!);
          formData.append("timestamp", timestamp.toString());
          formData.append("signature", signature);
          formData.append("folder", folder);
          formData.append("public_id", uniquePublicId);
          formData.append("overwrite", "true");

          console.log(`Uploading to Cloudinary: ${uploadUrl}`);
          const uploadResponse = await fetch(uploadUrl, { method: "POST", body: formData });
          if (uploadResponse.ok) {
            cloudinaryResult = await uploadResponse.json();
            storedIn.push("cloudinary");
            console.log(`Cloudinary upload successful: ${cloudinaryResult.secure_url}`);
          } else {
            const errorText = await uploadResponse.text();
            errors.push(`cloudinary: HTTP ${uploadResponse.status} ${errorText.slice(0, 200)}`);
            console.error("Cloudinary upload failed:", errorText);
          }
        }
      } catch (e: any) {
        errors.push(`${provider}: ${e?.message || String(e)}`);
        console.error(`${provider} upload error:`, e);
      }
    }

    // Resilient contract: success when at least one provider stored the bytes.
    if (storedIn.length === 0) {
      return new Response(JSON.stringify({ success: false, partial: false, storedIn, errors }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const preferOpeninaryRead = cdnPolicy.readPreference === "openinary";
    const primaryUrl = preferOpeninaryRead
      ? (openinaryUrl || cloudinaryResult?.secure_url)
      : (cloudinaryResult?.secure_url || openinaryUrl);
    const primaryPublicId: string | undefined = cloudinaryResult?.public_id ?? undefined;
    const bytesOut: number | undefined = cloudinaryResult?.bytes ?? payloadBytes?.length ?? incomingFileSize ?? undefined;

    // Store reference in database with platform/account tracking
    let mediaFileId: string | null = null;
    if (!skipMediaFiles) {
      const { data: mediaRecord, error: dbError } = await dbClient
        .from("media_files")
        .insert({
          user_id: userId,
          file_path: primaryUrl,
          file_type: fileType,
          file_size: bytesOut ?? null,
          mime_type:
            fileType === "video"
              ? "video/mp4"
              : fileType === "gif"
                ? "image/gif"
                : fileType === "raw"
                  ? "application/octet-stream"
                  : `image/${cloudinaryResult?.format || objectExt}`,
          storage_bucket: cloudinaryResult ? "cloudinary" : "openinary",
          cloudinary_public_id: primaryPublicId ?? null,
          platforms: platforms,
          social_account_ids: socialAccountIds,
          upload_date: todayDate,
          metadata: {
            width: cloudinaryResult?.width || null,
            height: cloudinaryResult?.height || null,
            format: cloudinaryResult?.format || objectExt,
            duration: cloudinaryResult?.duration || null,
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
      const providerRows = effectiveProviders.map((provider) => ({
        media_file_id: mediaFileId,
        provider,
        object_version: objectVersion,
        object_key: provider === "cloudinary"
          ? (cloudinaryResult?.public_id ?? `${folder}/${uniquePublicId}`)
          : (openinaryPath ?? openinaryFallbackKey),
        status: "pending",
        bytes: bytesOut ?? null,
        mime_type: fileType === "video" ? "video/mp4" : fileType === "gif" ? "image/gif" : `image/${cloudinaryResult?.format || objectExt}`,
      }));
      const { error: providerInsertError } = await dbAdmin.from("media_file_providers").insert(providerRows);
      if (providerInsertError) return new Response(JSON.stringify({ success: false, error: `Provider state error: ${providerInsertError.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      if (cloudinaryResult) {
        const { error: cloudinaryStatusError } = await dbAdmin.from("media_file_providers").update({ status: "ready", delivery_url: cloudinaryResult.secure_url }).eq("media_file_id", mediaFileId).eq("provider", "cloudinary").eq("object_version", objectVersion);
        if (cloudinaryStatusError) errors.push(`cloudinary status update: ${cloudinaryStatusError.message}`);
      }
      if (openinaryPath && openinaryUrl) {
        const { error: openinaryStatusError } = await dbAdmin.from("media_file_providers").update({ status: "ready", object_key: openinaryPath, delivery_url: openinaryUrl }).eq("media_file_id", mediaFileId).eq("provider", "openinary").eq("object_version", objectVersion);
        if (openinaryStatusError) errors.push(`openinary status update: ${openinaryStatusError.message}`);
      }
      // Durable retry record for any attempted-but-failed provider.
      for (const provider of effectiveProviders) {
        if (storedIn.includes(provider)) continue;
        const providerError = errors.find((e) => e.startsWith(`${provider}:`)) || "upload failed";
        await dbAdmin.from("media_file_providers").update({ status: "failed", error: providerError }).eq("media_file_id", mediaFileId).eq("provider", provider).eq("object_version", objectVersion);
      }
    }

    const requiredSatisfied = cdnPolicy.required.every((provider) => storedIn.includes(provider));
    const response: UploadResponse = {
      success: true,
      url: primaryUrl,
      publicId: primaryPublicId,
      cloudName: cloudName,
      mediaFileId: mediaFileId ?? undefined, // Database UUID (omitted if skipped)
      width: cloudinaryResult?.width,
      height: cloudinaryResult?.height,
      format: cloudinaryResult?.format || objectExt,
      bytes: bytesOut,
      duration: cloudinaryResult?.duration, // For videos
      isDuplicate: false,
      storedIn,
      partial: !requiredSatisfied || errors.length > 0,
      errors: errors.length ? errors : undefined,
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
