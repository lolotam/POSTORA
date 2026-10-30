import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRoleBearer } from "./serviceCaller.ts";
import { getOpeninaryConfig, openinaryTarget, openinaryDeliveryUrl, uploadBytesToOpeninary, uploadStreamToOpeninary } from "../_shared/openinary.ts";
import { mediaQuotaBody } from "../_shared/mediaQuotaError.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { MEDIA_DECODED_BYTE_CAP, dedupeEligible, formatUploadLimit, type UploadLimits } from "../_shared/mediaTypes.ts";
import { readUploadLimits } from "../_shared/uploadLimitsSetting.ts";
import {
  BodyTooLargeError,
  estimateBase64DecodedBytes,
  isAcceptedFileType,
  isAdvertisedBodyTooLarge,
  limitProvidersForKind,
  matchingDuplicateId,
  readJsonBodyCapped,
  resolveUpload,
} from "./uploadPolicy.ts";
import { getCdnPolicy, orderWriteProviders } from "./providerPolicy.ts";
import { getTodayFolder, mediaPublicId, sanitizeEmailForFolder } from "./objectNaming.ts";
import { commitMediaReplace, parseReplaceMediaFileId, prepareMediaReplace, type ReplaceTargetRow, type ReplaceUploadFacts } from "./replace.ts";
import { deleteJustUploaded, mediaQuotaPreflight, quotaInsertRefusal } from "./mediaQuota.ts";
import { prefixedStream, readPrefix, streamedSourceLength, streamFailureMessage, streamIngestCap, streamProviders } from "./urlIngest.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};

interface UploadRequest {
  fileData?: string; // base64 encoded file (required if no externalUrl)
  externalUrl?: string; // External URL to upload (for stock media)
  fileName: string;
  fileType: "image" | "video" | "gif" | "raw" | "document" | "audio";
  platforms?: string[]; // Platforms this media is being posted to
  socialAccountIds?: string[]; // Social account IDs involved
  subfolder?: string; // Override daily folder with a custom subfolder
  skipMediaFiles?: boolean; // Skip media_files DB insert (for non-media assets like avatars)
  replaceMediaFileId?: string; // Swap this owned media_files row instead of inserting one
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

async function logUploadRefusal(userId: string | undefined, message: string, metadata: Record<string, unknown>) {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return;
    const admin = createClient(supabaseUrl, serviceRoleKey);
    await logToDatabase(admin, {
      level: "warn",
      category: "system",
      source: "cloudinary-upload",
      message,
      user_id: userId,
      metadata,
    });
  } catch {
    console.error("[cloudinary-upload] refusal log failed");
  }
}

// SSRF hardening for externalUrl fetching (the Openinary path downloads bytes from
// the edge runtime, unlike the Cloudinary path where Cloudinary's servers fetch).
// Known limit (same as the n8n node): DNS is validated per hop, but a rebinding
// race between check and fetch is not eliminated.
const MAX_EXTERNAL_BYTES = MEDIA_DECODED_BYTE_CAP;
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

export async function handleCloudinaryUpload(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (isAdvertisedBodyTooLarge(req.headers.get("content-length"))) {
    await logUploadRefusal(undefined, "Rejected oversized upload body", { reason: "content_length" });
    return new Response(
      JSON.stringify({ success: false, error: "Upload body exceeds the 14 MB limit" }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
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
      // Service-role caller (e.g. n8n-api) — accept userId from body, but only for the service key.
      if (!isServiceRoleBearer(token, serviceRoleKey)) {
        console.error("Rejected unparseable bearer that is not the service-role key");
        try {
          const { error: logError } = await createClient(supabaseUrl, serviceRoleKey).from("system_logs").insert({
            source: "cloudinary-upload",
            category: "auth",
            level: "warn",
            message: "Upload refused: unparseable bearer is not the service-role key",
            metadata: { reason: "non_service_bearer", claims_error: (claimsError as any).code ?? null },
          });
          if (logError) console.error("Auth refusal log insert failed");
        } catch {
          console.error("Auth refusal log insert failed");
        }
        return new Response(
          JSON.stringify({ success: false, error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log("Service-role caller, reading userId from body...");

      // Same byte cap as the user path: a service caller must not be able to exhaust the isolate.
      let bodyJson: any;
      try {
        bodyJson = await readJsonBodyCapped(req);
      } catch (parseError) {
        const tooLarge = parseError instanceof BodyTooLargeError;
        await logUploadRefusal(undefined, tooLarge ? "Rejected oversized upload body" : "Rejected malformed upload body", { reason: tooLarge ? "body_cap" : "invalid_json", caller: "service_role" });
        return new Response(
          JSON.stringify({ success: false, error: tooLarge ? (parseError as Error).message : "Invalid JSON body" }),
          { status: tooLarge ? 413 : 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      
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

    // The service-role branch parses its own body with the same cap. This read is the user path:
    // cap the bytes while reading, before JSON.parse.
    let parsedBody: UploadRequest;
    if ((req as any)._parsedBody) {
      parsedBody = (req as any)._parsedBody;
    } else {
      try {
        parsedBody = await readJsonBodyCapped(req) as UploadRequest;
      } catch (parseError) {
        if (parseError instanceof BodyTooLargeError) {
          await logUploadRefusal(userId, "Rejected oversized upload body", { reason: "body_cap" });
          return new Response(
            JSON.stringify({ success: false, error: parseError.message }),
            { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        await logUploadRefusal(userId, "Rejected malformed upload body", { reason: "invalid_json" });
        return new Response(
          JSON.stringify({ success: false, error: "Invalid JSON body" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }
    const { fileData, externalUrl, fileName, fileType, platforms = [], socialAccountIds = [], subfolder, skipMediaFiles = false }: UploadRequest = parsedBody;
    const replaceRequest = parseReplaceMediaFileId(parsedBody);
    if (replaceRequest.error) {
      await logUploadRefusal(userId, "Rejected replace", { reason: "replace_invalid_id" });
      return new Response(JSON.stringify({ success: false, error: replaceRequest.error }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if ((!fileData && !externalUrl) || !fileName || !fileType) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields: (fileData or externalUrl), fileName, fileType" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!isAcceptedFileType(fileType)) {
      await logUploadRefusal(userId, "Rejected upload file type", { fileType });
      return new Response(
        JSON.stringify({ success: false, error: "Unsupported fileType" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
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

    const folder = subfolder
      ? `media/${userFolder}/${subfolder}`
      : `media/${userFolder}/${dailyFolder}`;
    const timestamp = Math.floor(Date.now() / 1000);

    let payloadBytes: Uint8Array | null = null;
    // A URL over the in-memory cap: only its first bytes are held; the rest streams to Openinary.
    let externalStream: {
      prefix: Uint8Array;
      reader: ReadableStreamDefaultReader<Uint8Array>;
      byteCount: number;
      limits: UploadLimits;
    } | null = null;
    let externalContentType: string | null = null;
    let uploadSource = externalUrl || "";
    let incomingFileSize: number | null = null;

    if (fileData) {
      if (estimateBase64DecodedBytes(fileData) > MEDIA_DECODED_BYTE_CAP) {
        await logUploadRefusal(userId, "Rejected oversized upload", { reason: "encoded_length" });
        return new Response(
          JSON.stringify({ success: false, error: "File exceeds the 10 MB limit" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const b64Part = fileData.includes(",") ? fileData.split(",")[1] : fileData;
      uploadSource = fileData.startsWith("data:") ? fileData : `data:application/octet-stream;base64,${b64Part}`;
      try {
        payloadBytes = Uint8Array.from(atob(b64Part), (c) => c.charCodeAt(0));
      } catch {
        await logUploadRefusal(userId, "Rejected upload payload", { reason: "invalid_base64" });
        return new Response(
          JSON.stringify({ success: false, error: "Invalid file data" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      incomingFileSize = payloadBytes.length;
      if (incomingFileSize > MEDIA_DECODED_BYTE_CAP) {
        await logUploadRefusal(userId, "Rejected oversized upload", { reason: "decoded_length" });
        return new Response(
          JSON.stringify({ success: false, error: "File exceeds the 10 MB limit" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    } else if (externalUrl) {
      try {
        const res = await safeFetchExternal(externalUrl);
        if (!res.ok) {
          await logUploadRefusal(userId, "Rejected external upload", { reason: "external_fetch", status: res.status });
          return new Response(
            JSON.stringify({ success: false, error: "Could not fetch the external file" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        externalContentType = res.headers.get("content-type");
        const streamedLength = streamedSourceLength(res.headers.get("content-length"));
        if (streamedLength !== null && res.body) {
          const limits = await readUploadLimits(dbAdmin);
          if (!limits) {
            await res.body.cancel().catch(() => {});
            await logUploadRefusal(userId, "Rejected external upload", { reason: "limits_unavailable" });
            return new Response(
              JSON.stringify({ success: false, error: "Uploads are temporarily unavailable. Please try again.", retryable: true }),
              { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          const reader = res.body.getReader();
          externalStream = { prefix: await readPrefix(reader), reader, byteCount: streamedLength, limits };
          incomingFileSize = streamedLength;
        } else {
          payloadBytes = await readCappedBytes(res, MAX_EXTERNAL_BYTES);
          incomingFileSize = payloadBytes.length;
        }
      } catch (fetchError) {
        const tooLarge = fetchError instanceof Error && fetchError.message.includes("byte limit");
        await logUploadRefusal(userId, tooLarge ? "Rejected oversized external upload" : "Rejected external upload", { reason: tooLarge ? "external_length" : "external_fetch" });
        return new Response(
          JSON.stringify({ success: false, error: tooLarge ? "File exceeds the 10 MB limit" : "Could not fetch the external file" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const resolved = resolveUpload({ fileName, fileType, bytes: payloadBytes ?? externalStream?.prefix, contentType: externalContentType });
    if (!resolved.ok) {
      await logUploadRefusal(userId, "Rejected upload type", { extension: resolved.extension, fileType });
      return new Response(
        JSON.stringify({ success: false, error: resolved.error }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if ((payloadBytes?.byteLength ?? 0) > resolved.upload.entry.maxBytes) {
      await logUploadRefusal(userId, "Rejected oversized upload", { reason: "kind_cap", extension: resolved.upload.ext });
      return new Response(
        JSON.stringify({ success: false, error: "File exceeds the 10 MB limit" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (externalStream) {
      const cap = streamIngestCap(resolved.upload.entry.kind, externalStream.limits);
      // Only Openinary takes a stream, and a streamed upload uses nothing else (streamProviders).
      const openinaryWrites = orderWriteProviders(await getCdnPolicy(dbAdmin), {
        cloudinary: cloudinaryUsable,
        openinaryConfigured: !!getOpeninaryConfig(),
      }).includes("openinary");
      const refusal = cap === null
        ? { reason: "kind_cap", error: "Only images and videos can be uploaded over 10 MB" }
        : externalStream.byteCount > cap
          ? { reason: "external_length", error: `File exceeds the ${formatUploadLimit(cap)} limit` }
          : !openinaryWrites
            ? { reason: "no_stream_provider", error: "Files over 10 MB need Openinary storage, which is not enabled" }
            : null;
      if (refusal) {
        await externalStream.reader.cancel().catch(() => {});
        await logUploadRefusal(userId, "Rejected oversized external upload", { reason: refusal.reason, bytes: externalStream.byteCount, extension: resolved.upload.ext });
        return new Response(
          JSON.stringify({ success: false, error: refusal.error }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const originalFilename = resolved.upload.originalFilename;
    let replaceRow: ReplaceTargetRow | null = null;
    if (replaceRequest.id) {
      const prepared = await prepareMediaReplace(dbAdmin, replaceRequest.id, userId, resolved.upload.entry.kind);
      if (!prepared.ok) {
        if (prepared.refusal) await logUploadRefusal(userId, prepared.refusal.message, prepared.refusal.metadata);
        return new Response(JSON.stringify(prepared.body), { status: prepared.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      replaceRow = prepared.row;
    }
    let existingFile: any = null;
    if (!replaceRow && dedupeEligible(resolved.upload.entry.kind) && incomingFileSize !== null) {
      const dedupeWindowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: recentCandidates, error: dedupeError } = await dbClient
        .from("media_files")
        .select("id, file_path, cloudinary_public_id, file_size, platforms, social_account_ids")
        .eq("user_id", userId)
        .eq("metadata->>original_filename", originalFilename)
        .gt("created_at", dedupeWindowStart)
        .order("created_at", { ascending: false })
        .limit(5);
      if (dedupeError) {
        console.error("[cloudinary-upload] dedupe lookup failed");
      } else {
        const duplicateId = matchingDuplicateId(resolved.upload.entry.kind, incomingFileSize, recentCandidates || []);
        existingFile = (recentCandidates || []).find((candidate: { id: string }) => candidate.id === duplicateId) || null;
      }
    }

    if (existingFile) {
      console.log(`Found matching recent file (size=${incomingFileSize}), reusing: ${existingFile.id}`);
      
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

    // A new library row is the only upload that counts. Replace updates the
    // existing row, and skipMediaFiles (avatars, contacts) never inserts one.
    // Checked before any provider so a full quota does not store bytes.
    if (!replaceRow && !skipMediaFiles) {
      const blocked = await mediaQuotaPreflight(dbAdmin, userId);
      if (blocked) {
        await logUploadRefusal(userId, "Daily upload limit reached", { reason: "media_quota" });
        return new Response(JSON.stringify(mediaQuotaBody(blocked.limit)), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Postora naming convention: postora_<date>_<userId>_<seq>
    // Sequence numbers are allocated atomically per user per day, so concurrent
    // uploads never collide (and Cloudinary runs with overwrite=false, so one never replaces another).
    const { data: seq, error: seqError } = await dbClient.rpc("next_media_seq", {
      p_user_id: userId,
      p_upload_date: todayDate,
    });
    if (seqError || seq == null) {
      console.warn(`[cloudinary-upload] next_media_seq failed (${seqError?.message}); falling back to timestamp suffix`);
    }
    const sequencePart = seqError || seq == null ? Date.now() : seq;
    const uniquePublicId = mediaPublicId(dailyFolder, userId, sequencePart);
    const objectExt = resolved.upload.ext;
    const uploadMime = resolved.upload.entry.mime;

    // cdn_storage is admin-only under RLS. Read through the user client, a non-admin got an
    // empty policy, Openinary counted as disabled, and every upload fell back to Cloudinary.
    const cdnPolicy = await getCdnPolicy(dbAdmin);
    const openinaryConfig = getOpeninaryConfig();
    const orderedUnique = orderWriteProviders(cdnPolicy, { cloudinary: cloudinaryUsable, openinaryConfigured: !!openinaryConfig });
    const kindProviders = limitProvidersForKind(resolved.upload.entry.kind, orderedUnique, cdnPolicy.required);
    // A streamed URL goes to Openinary alone (see streamProviders): its failure fails the upload.
    const limitedProviders = externalStream ? streamProviders(kindProviders) : kindProviders;
    const effectiveProviders = limitedProviders.attempted;
    const requiredProviders = limitedProviders.required;
    if (effectiveProviders.length === 0) {
      await logUploadRefusal(userId, "No provider for this file type", { extension: objectExt });
      return new Response(
        JSON.stringify({ success: false, error: "Storage temporarily unavailable", retryable: true }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`Uploading ${resolved.upload.entry.storedFileType}: .${objectExt} to folder: ${folder}/${uniquePublicId} via providers: [${effectiveProviders.join(", ")}]`);

    const openinaryBaseName = uniquePublicId;
    const openinaryFallbackKey = `${openinaryConfig?.folderPrefix || "postora.cloud"}/${folder}/${uniquePublicId}.${objectExt}`;

    const storedIn: string[] = [];
    const errors: string[] = [];
    let cloudinaryResult: any = null;
    let openinaryPath: string | null = null;
    let openinaryUrl: string | null = null;

    for (const provider of effectiveProviders) {
      try {
        if (provider === "openinary" && openinaryConfig && (payloadBytes || externalStream)) {
          const target = openinaryTarget(`${folder}/${uniquePublicId}`, openinaryConfig.folderPrefix);
          const openResult = payloadBytes
            ? await uploadBytesToOpeninary(openinaryConfig, payloadBytes, target.folder, openinaryBaseName, objectExt, uploadMime, payloadBytes.length)
            : await uploadStreamToOpeninary(openinaryConfig, prefixedStream(externalStream!.prefix, externalStream!.reader), {
              folder: target.folder,
              baseName: openinaryBaseName,
              extension: objectExt,
              mimeType: uploadMime,
              byteCount: externalStream!.byteCount,
            });
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
          // Signed with overwrite=false, as the browser-direct path is: an object already
          // stored under this public id is kept, never replaced.
          const signatureParams = [
            `folder=${folder}`,
            `overwrite=false`,
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
          const resourceType = resolved.upload.entry.kind === "video" ? "video" : "image";
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
          formData.append("overwrite", "false");

          console.log(`Uploading to Cloudinary: ${uploadUrl}`);
          // Bounded: Cloudinary fetches a URL source itself, and a stalled one must not
          // run the worker out of time.
          const uploadResponse = await fetch(uploadUrl, { method: "POST", body: formData, signal: AbortSignal.timeout(60_000) });
          if (uploadResponse.ok) {
            const uploaded = await uploadResponse.json();
            // Every call allocates a fresh public id, so an existing object is a collision,
            // not this upload: report it rather than register someone else's bytes.
            if (uploaded?.existing === true) {
              errors.push("cloudinary: an object with this name already exists");
              console.error(`Cloudinary refused to overwrite ${uniquePublicId}`);
              continue;
            }
            cloudinaryResult = uploaded;
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
      if (externalStream) {
        await logUploadRefusal(userId, "Streamed upload failed", { reason: "stream_failed", bytes: externalStream.byteCount, errors: errors.map((e) => e.slice(0, 200)) });
      }
      return new Response(JSON.stringify({ success: false, partial: false, storedIn, errors, error: externalStream ? streamFailureMessage(errors) : errors.join("; ") }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const preferOpeninaryRead = cdnPolicy.readPreference === "openinary";
    const primaryUrl = preferOpeninaryRead
      ? (openinaryUrl || cloudinaryResult?.secure_url)
      : (cloudinaryResult?.secure_url || openinaryUrl);
    const primaryPublicId: string | undefined = cloudinaryResult?.public_id ?? undefined;
    const bytesOut: number | undefined = cloudinaryResult?.bytes ?? payloadBytes?.length ?? incomingFileSize ?? undefined;

    // Store reference in database with platform/account tracking.
    // A replace swaps the loaded row instead of inserting, and ignores skipMediaFiles.
    let mediaFileId: string | null = null;
    if (replaceRow) {
      const facts: ReplaceUploadFacts = {
        userId, primaryUrl: primaryUrl ?? null, bytes: bytesOut ?? null, mimeType: uploadMime,
        storedFileType: resolved.upload.entry.storedFileType, kind: resolved.upload.entry.kind,
        width: cloudinaryResult?.width ?? null, height: cloudinaryResult?.height ?? null,
        format: cloudinaryResult?.format || objectExt, duration: cloudinaryResult?.duration ?? null,
        storageBucket: cloudinaryResult ? "cloudinary" : "openinary", storedIn, errors,
        providersAttempted: effectiveProviders, cloudinaryPublicId: cloudinaryResult?.public_id ?? null,
        cloudinaryDeliveryUrl: cloudinaryResult?.secure_url ?? null, cloudinaryFallbackKey: `${folder}/${uniquePublicId}`,
        openinaryPath, openinaryUrl, openinaryFallbackKey,
      };
      const outcome = await commitMediaReplace(dbAdmin, replaceRow, facts);
      return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!skipMediaFiles) {
      const { data: mediaRecord, error: dbError } = await dbClient
        .from("media_files")
        .insert({
          user_id: userId,
          file_path: primaryUrl,
          file_type: resolved.upload.entry.storedFileType,
          file_size: bytesOut ?? null,
          mime_type: uploadMime,
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
            original_filename: originalFilename,
            kind: resolved.upload.entry.kind,
          },
        })
        .select("id")
        .single();

      if (dbError) {
        const quotaRace = await quotaInsertRefusal(dbError.message ?? "", () => deleteJustUploaded({
          storedIn,
          openinaryPath,
          cloudinaryPublicId: cloudinaryResult?.public_id ?? null,
          kind: resolved.upload.entry.kind,
        }));
        if (quotaRace) {
          await logUploadRefusal(userId, "Daily upload limit reached", { reason: "media_quota" });
          return new Response(JSON.stringify(quotaRace.body), {
            status: quotaRace.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
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
        mime_type: uploadMime,
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

    const requiredSatisfied = requiredProviders.every((provider) => storedIn.includes(provider));
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
}

Deno.serve(handleCloudinaryUpload);
