/**
 * Image bytes in and out of the AI image tools: reading the request, staging an input
 * for a provider that needs a URL, and keeping the result in Openinary (the main asset
 * store). `_shared/openinary.ts` owns how bytes are written; this module only chooses
 * what to write and where.
 */

import { jsonResponse } from "./cors.ts";
import { fetchWithTimeout } from "./request-timeout.ts";
import {
  deleteFromOpeninary,
  extensionForBytes,
  openinaryTarget,
  uploadBytesToOpeninary,
  type OpeninaryConfig,
} from "./openinary.ts";

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;
const OUTPUT_FETCH_TIMEOUT_MS = 30_000;

const MIME_FOR_EXTENSION: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const UNSUPPORTED_FORMAT = "Unsupported image format. Use JPEG, PNG, WebP or GIF.";

export type ImageInput =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Uint8Array; extension: string; mime: string };

export type ReadInputResult =
  | { ok: true; input: ImageInput; fields: Record<string, unknown> }
  | { ok: false; status: number; message: string };

const DATA_URI = /^data:([^;,]+);base64,/i;

function bytesInput(bytes: Uint8Array): { input: ImageInput } | { status: number; message: string } {
  const extension = extensionForBytes(bytes);
  if (!extension) return { status: 400, message: UNSUPPORTED_FORMAT };
  return { input: { kind: "bytes", bytes, extension, mime: MIME_FOR_EXTENSION[extension] } };
}

function decodeBase64(raw: string, maxBytes: number): { bytes: Uint8Array } | { status: number; message: string } {
  const payload = raw.replace(DATA_URI, "").replace(/\s+/g, "");
  if (!payload) return { status: 400, message: "image_base64 is empty" };
  if (payload.length > Math.ceil((maxBytes * 4) / 3) + 8) return { status: 413, message: `Image is larger than ${maxBytes / (1024 * 1024)} MB` };
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length > maxBytes) return { status: 413, message: `Image is larger than ${maxBytes / (1024 * 1024)} MB` };
    return { bytes };
  } catch {
    return { status: 400, message: "image_base64 is not valid base64" };
  }
}

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * JSON `{ image_url | image_base64, ...fields }` or multipart `file | image_url` plus
 * string fields. The URL wins when both are sent (the order every caller already relied on).
 * `image_base64` may be a data URI or raw base64; the type comes from the bytes, not the label.
 */
export async function readImageInput(req: Request, maxBytes = MAX_INPUT_BYTES): Promise<ReadInputResult> {
  const fields: Record<string, unknown> = {};
  let urlValue: string | null = null;
  let base64Value: string | null = null;
  let file: File | null = null;

  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return { ok: false, status: 400, message: "Invalid multipart body" };
    }
    for (const [key, value] of form.entries()) {
      if (key === "file" && value instanceof File) file = value;
      else if (typeof value === "string") fields[key] = value;
    }
    urlValue = typeof fields.image_url === "string" ? fields.image_url : null;
  } else {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return { ok: false, status: 400, message: "Request body must be JSON" };
    Object.assign(fields, body);
    urlValue = typeof body.image_url === "string" && body.image_url ? body.image_url : null;
    base64Value = typeof body.image_base64 === "string" && body.image_base64 ? body.image_base64 : null;
  }

  if (urlValue) {
    const url = parseHttpUrl(urlValue);
    return url ? { ok: true, input: { kind: "url", url }, fields } : { ok: false, status: 400, message: "image_url must be an http(s) URL" };
  }
  if (file) {
    if (file.size > maxBytes) return { ok: false, status: 413, message: `Image is larger than ${maxBytes / (1024 * 1024)} MB` };
    const made = bytesInput(new Uint8Array(await file.arrayBuffer()));
    return "message" in made ? { ok: false, ...made } : { ok: true, input: made.input, fields };
  }
  if (base64Value) {
    const decoded = decodeBase64(base64Value, maxBytes);
    if ("message" in decoded) return { ok: false, status: decoded.status, message: decoded.message };
    const made = bytesInput(decoded.bytes);
    return "message" in made ? { ok: false, ...made } : { ok: true, input: made.input, fields };
  }
  return { ok: false, status: 400, message: "Please provide image_url, image_base64, or file in form-data" };
}

/** Data URI for providers that take the image inline (the Cloudinary upload). */
export function toDataUri(input: Extract<ImageInput, { kind: "bytes" }>): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < input.bytes.length; i += chunk) binary += String.fromCharCode(...input.bytes.subarray(i, i + chunk));
  return `data:${input.mime};base64,${btoa(binary)}`;
}

export type StoredImage = { ok: true; url: string; path: string } | { ok: false; error: string };

async function putInOpeninary(
  config: OpeninaryConfig,
  userId: string,
  area: string,
  bytes: Uint8Array,
  extension: string,
  mime: string,
): Promise<StoredImage> {
  const { folder, baseName } = openinaryTarget(`postora/${userId}/${area}/${crypto.randomUUID()}`, config.folderPrefix);
  const stored = await uploadBytesToOpeninary(config, bytes, folder, baseName, extension, mime);
  return stored.success && stored.url && stored.path ? { ok: true, url: stored.url, path: stored.path } : { ok: false, error: stored.error || "Openinary upload failed" };
}

/** A temporary, publicly fetchable copy so a provider that takes a URL can read an uploaded image. */
export function stageInput(config: OpeninaryConfig, userId: string, input: Extract<ImageInput, { kind: "bytes" }>): Promise<StoredImage> {
  return putInOpeninary(config, userId, "ai-tmp", input.bytes, input.extension, input.mime);
}

/** The durable copy of a provider result. */
export function storeResult(
  config: OpeninaryConfig,
  userId: string,
  area: "upscaled" | "processed",
  image: { bytes: Uint8Array; extension: string; mime: string },
): Promise<StoredImage> {
  return putInOpeninary(config, userId, area, image.bytes, image.extension, image.mime);
}

/** Removes a staged copy. Cleanup only: it never throws and never fails the request. */
export async function discardStaged(config: OpeninaryConfig, path: string): Promise<void> {
  const removed = await deleteFromOpeninary(config, path);
  if (!removed.success) console.warn(JSON.stringify({ event: "ai_image_stage_cleanup_failed", path, error: removed.error }));
}

export type FetchedImage =
  | { ok: true; bytes: Uint8Array; extension: string; mime: string }
  | { ok: false; error: string };

/** Downloads a provider's output with a size and time bound; the type is read from the bytes. */
export async function fetchOutputImage(url: string, fetchFn: typeof fetch = fetch, maxBytes = MAX_OUTPUT_BYTES): Promise<FetchedImage> {
  try {
    const response = await fetchWithTimeout(url, {}, OUTPUT_FETCH_TIMEOUT_MS, fetchFn);
    if (!response.ok) return { ok: false, error: `output fetch failed: HTTP ${response.status}` };
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, error: "output larger than the size limit" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) return { ok: false, error: "output was empty" };
    if (bytes.length > maxBytes) return { ok: false, error: "output larger than the size limit" };
    const extension = extensionForBytes(bytes);
    if (!extension) return { ok: false, error: "output is not a supported image type" };
    return { ok: true, bytes, extension, mime: MIME_FOR_EXTENSION[extension] };
  } catch (error) {
    return { ok: false, error: `output fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Width and height from a PNG header, or null for anything else. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || extensionForBytes(bytes) !== "png") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function toolFailureResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ success: false, error: message, code }, status);
}

/** One structured line per job outcome; never carries keys, tokens or provider text. */
export function logImageTool(
  level: "info" | "warn" | "error",
  event: string,
  fields: { operation: string; provider?: string; user_id?: string; [key: string]: unknown },
): void {
  console[level](JSON.stringify({ event, ...fields }));
}
