/**
 * Provider adapters for a browser-direct upload. `start` hands the browser a
 * signed target per provider; `complete` checks that each provider really holds
 * the object before a library row points at it.
 */

import { cloudinarySignature } from "../_shared/cloudinarySignature.ts";
import { listOpeninaryFolder, openinaryDeliveryUrl, type OpeninaryConfig, type OpeninaryFile } from "../_shared/openinary.ts";

/** Cloudinary takes chunks of at least 5 MB; 20 MB keeps a 500 MB video to 25 requests. */
export const CLOUDINARY_CHUNK_BYTES = 20 * 1024 * 1024;
/** Openinary checks expiry after the whole body arrives, so this must outlast a slow upload. Its maximum is one hour. */
export const OPENINARY_PRESIGN_SECONDS = 60 * 60;
const PROVIDER_TIMEOUT_MS = 15_000;

export interface OpeninaryUploadTarget {
  provider: "openinary";
  url: string;
  fileField: "files";
  fields: Record<string, string>;
}

export interface CloudinaryUploadTarget {
  provider: "cloudinary";
  url: string;
  fileField: "file";
  chunkSize: number;
  fields: Record<string, string>;
}

export type UploadTarget = OpeninaryUploadTarget | CloudinaryUploadTarget;

/**
 * The host the browser posts to. OPENINARY_UPLOAD_URL lets a large upload skip a
 * proxy that caps request bodies (Cloudflare refuses any proxied body over 100 MB)
 * while reads keep the server URL.
 */
export function openinaryUploadBaseUrl(config: OpeninaryConfig, override = Deno.env.get("OPENINARY_UPLOAD_URL")): string {
  return (override?.trim() || config.serverUrl).replace(/\/+$/, "");
}

export async function presignOpeninary(
  config: OpeninaryConfig,
  folder: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; signature: string; expires: number } | { ok: false; error: string }> {
  try {
    const response = await fetcher(`${config.serverUrl}/api/upload/sign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ folder, expiresIn: OPENINARY_PRESIGN_SECONDS }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success || typeof body.signature !== "string" || !Number.isFinite(body.expires)) {
      return { ok: false, error: `Openinary presign failed: ${body?.error || response.status}` };
    }
    return { ok: true, signature: body.signature, expires: body.expires };
  } catch (error) {
    return { ok: false, error: `Openinary presign failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function openinaryUploadTarget(
  uploadBaseUrl: string,
  target: { folder: string; fileName: string },
  presign: { signature: string; expires: number },
): OpeninaryUploadTarget {
  return {
    provider: "openinary",
    url: `${uploadBaseUrl}/api/upload`,
    fileField: "files",
    fields: {
      folder: target.folder,
      signature: presign.signature,
      expires: String(presign.expires),
      // Openinary names the stored object after `names`, so the browser's own file name never decides the path.
      names: target.fileName,
    },
  };
}

export async function cloudinaryUploadTarget(input: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  resourceType: "image" | "video";
  folder: string;
  publicId: string;
  timestamp: number;
}): Promise<CloudinaryUploadTarget> {
  // Same signed parameters as the edge-function upload, so both paths name objects identically.
  const signed = [
    `folder=${input.folder}`,
    // false: once `complete` has verified an object, a replayed signed target cannot replace it.
    "overwrite=false",
    `public_id=${input.publicId}`,
    `timestamp=${input.timestamp}`,
  ].sort().join("&");
  return {
    provider: "cloudinary",
    url: `https://api.cloudinary.com/v1_1/${input.cloudName}/${input.resourceType}/upload`,
    fileField: "file",
    chunkSize: CLOUDINARY_CHUNK_BYTES,
    fields: {
      api_key: input.apiKey,
      timestamp: String(input.timestamp),
      signature: await cloudinarySignature(signed + input.apiSecret),
      folder: input.folder,
      public_id: input.publicId,
      overwrite: "false",
    },
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Cloudinary signs every upload response over public_id and version with the
 * account secret. A match proves Cloudinary produced these values, not the browser.
 */
export async function isGenuineCloudinaryResult(
  result: { public_id: string; version: number | string; signature: string },
  apiSecret: string,
): Promise<boolean> {
  const expected = await cloudinarySignature(`public_id=${result.public_id}&version=${result.version}${apiSecret}`);
  return constantTimeEqual(expected, result.signature.toLowerCase());
}

export interface CloudinaryAsset {
  public_id: string;
  version: number;
  secure_url: string;
  bytes: number;
  width?: number;
  height?: number;
  format?: string;
  duration?: number;
}

/**
 * The asset as Cloudinary's Admin API describes it. The browser's upload response is
 * signed only over public_id and version, so its URL and size are never stored as given.
 */
export async function fetchCloudinaryAsset(
  credentials: { cloudName: string; apiKey: string; apiSecret: string },
  resourceType: "image" | "video",
  publicId: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; asset: CloudinaryAsset } | { ok: false; error: string }> {
  const url = `https://api.cloudinary.com/v1_1/${credentials.cloudName}/resources/${resourceType}/upload/${publicId.split("/").map(encodeURIComponent).join("/")}`;
  try {
    const response = await fetcher(url, {
      headers: { Authorization: `Basic ${btoa(`${credentials.apiKey}:${credentials.apiSecret}`)}` },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (response.status === 404) return { ok: false, error: "cloudinary: object not found after upload" };
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) return { ok: false, error: `cloudinary: could not confirm the upload (HTTP ${response.status})` };
    if (typeof body.secure_url !== "string" || !Number.isFinite(body.bytes) || !Number.isFinite(Number(body.version))) {
      return { ok: false, error: "cloudinary: could not confirm the upload (incomplete asset details)" };
    }
    return {
      ok: true,
      asset: {
        public_id: String(body.public_id ?? publicId),
        version: Number(body.version),
        secure_url: body.secure_url,
        bytes: body.bytes,
        width: Number.isFinite(body.width) ? body.width : undefined,
        height: Number.isFinite(body.height) ? body.height : undefined,
        format: typeof body.format === "string" ? body.format : undefined,
        duration: Number.isFinite(body.duration) ? body.duration : undefined,
      },
    };
  } catch (error) {
    return { ok: false, error: `cloudinary: could not confirm the upload (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Whether Cloudinary's own description matches what this session signed for: the same
 * version the signed response named, and no more bytes than the size checked at `start`.
 */
export function cloudinaryAssetMismatch(asset: CloudinaryAsset, signedVersion: number | string, declaredSize: number): string | null {
  if (String(asset.version) !== String(signedVersion)) return "cloudinary: the stored object changed after upload";
  if (asset.bytes > declaredSize) return `cloudinary: stored ${asset.bytes} bytes, more than the ${declaredSize} declared`;
  return null;
}

/** The object Openinary holds at exactly this path and size, or why it does not count. */
export async function confirmOpeninaryObject(
  config: OpeninaryConfig,
  target: { folder: string; fileName: string },
  reportedPath: string,
  expectedSize: number,
  lister: (config: OpeninaryConfig, folder: string) => Promise<OpeninaryFile[]> = listOpeninaryFolder,
): Promise<{ ok: true; path: string; url: string } | { ok: false; error: string }> {
  const expectedPath = `${target.folder}/${target.fileName}`;
  // A suffixed path means Openinary renamed a collision; the deterministic read URL would miss it.
  if (reportedPath !== expectedPath) return { ok: false, error: `openinary: stored "${reportedPath}" instead of "${expectedPath}"` };
  let files: OpeninaryFile[];
  try {
    files = await lister(config, target.folder);
  } catch (error) {
    return { ok: false, error: `openinary: listing failed (${error instanceof Error ? error.message : String(error)})` };
  }
  const match = files.find((file) => file.path === expectedPath);
  if (!match) return { ok: false, error: "openinary: object not found after upload" };
  if (match.size !== expectedSize) return { ok: false, error: `openinary: stored ${match.size} bytes, expected ${expectedSize}` };
  return { ok: true, path: match.path, url: openinaryDeliveryUrl(config, match.path) };
}
