/**
 * Image bytes in and out of the AI image tools: reading the request, staging an input
 * for a provider that needs a URL, and keeping the result in Openinary (the main asset
 * store). `_shared/openinary.ts` owns how bytes are written; this module only chooses
 * what to write and where.
 */

import { jsonResponse } from "./cors.ts";
import { readJsonBodyCapped } from "./cappedJsonBody.ts";
import {
  deleteFromOpeninary,
  extensionForBytes,
  openinaryTarget,
  uploadBytesToOpeninary,
  type OpeninaryConfig,
} from "./openinary.ts";

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;
const DEFAULT_OUTPUT_TIMEOUT_MS = 30_000;

const MIME_FOR_EXTENSION: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const UNSUPPORTED_FORMAT = "Unsupported image format. Use JPEG, PNG, WebP or GIF.";

export type ImageInput =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Uint8Array; extension: string; mime: string };

export type ReadInputResult =
  | { ok: true; input: ImageInput; fields: Record<string, unknown> }
  | { ok: false; status: number; message: string };

/** A request body split into its plain fields and, for multipart, the uploaded file. */
export type ToolRequestBody =
  | { ok: true; fields: Record<string, unknown>; file: File | null }
  | { ok: false; status: number; message: string };

const DATA_URI = /^data:([^;,]+);base64,/i;

function tooLarge(maxBytes: number) {
  return { status: 413, message: `Image is larger than ${maxBytes / (1024 * 1024)} MB` };
}

function bytesInput(bytes: Uint8Array): { input: ImageInput } | { status: number; message: string } {
  const extension = extensionForBytes(bytes);
  if (!extension) return { status: 400, message: UNSUPPORTED_FORMAT };
  return { input: { kind: "bytes", bytes, extension, mime: MIME_FOR_EXTENSION[extension] } };
}

function decodeBase64(raw: string, maxBytes: number): { bytes: Uint8Array } | { status: number; message: string } {
  const payload = raw.replace(DATA_URI, "").replace(/\s+/g, "");
  if (!payload) return { status: 400, message: "image_base64 is empty" };
  if (payload.length > Math.ceil((maxBytes * 4) / 3) + 8) return tooLarge(maxBytes);
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length > maxBytes) return tooLarge(maxBytes);
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

/** Reads the request once: JSON (read under a size cap) or multipart. */
export async function parseToolRequest(req: Request, maxBytes = MAX_INPUT_BYTES): Promise<ToolRequestBody> {
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return { ok: false, status: 400, message: "Invalid multipart body" };
    }
    const fields: Record<string, unknown> = {};
    let file: File | null = null;
    for (const [key, value] of form.entries()) {
      if (key === "file" && value instanceof File) file = value;
      else if (typeof value === "string") fields[key] = value;
    }
    return { ok: true, fields, file };
  }

  // image_base64 is the one large field: 4/3 of the image plus room for the other fields.
  const body = await readJsonBodyCapped(req, Math.ceil((maxBytes * 4) / 3) + 64 * 1024);
  if (!body.ok) return body.reason === "too_large" ? { ok: false, ...tooLarge(maxBytes) } : { ok: false, status: 400, message: "Request body must be JSON" };
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) return { ok: false, status: 400, message: "Request body must be JSON" };
  return { ok: true, fields: body.value as Record<string, unknown>, file: null };
}

/** The follow-up token of a still-running job, when the request carries one. */
export function resumeTokenOf(fields: Record<string, unknown>): string | null {
  return typeof fields.prediction_id === "string" && fields.prediction_id ? fields.prediction_id : null;
}

/**
 * Picks the image out of a parsed request. A multipart `file` wins over `image_url` (the
 * order the old handlers had); for JSON the URL wins over `image_base64`. `image_base64`
 * may be a data URI or raw base64; the type comes from the bytes, not the label.
 */
export async function imageInputFrom(body: Extract<ToolRequestBody, { ok: true }>, maxBytes = MAX_INPUT_BYTES): Promise<ReadInputResult> {
  const { fields, file } = body;
  if (file) {
    if (file.size > maxBytes) return { ok: false, ...tooLarge(maxBytes) };
    const made = bytesInput(new Uint8Array(await file.arrayBuffer()));
    return "message" in made ? { ok: false, ...made } : { ok: true, input: made.input, fields };
  }
  if (typeof fields.image_url === "string" && fields.image_url) {
    const url = parseHttpUrl(fields.image_url);
    return url ? { ok: true, input: { kind: "url", url }, fields } : { ok: false, status: 400, message: "image_url must be an http(s) URL" };
  }
  if (typeof fields.image_base64 === "string" && fields.image_base64) {
    const decoded = decodeBase64(fields.image_base64, maxBytes);
    if ("message" in decoded) return { ok: false, status: decoded.status, message: decoded.message };
    const made = bytesInput(decoded.bytes);
    return "message" in made ? { ok: false, ...made } : { ok: true, input: made.input, fields };
  }
  return { ok: false, status: 400, message: "Please provide image_url, image_base64, or file in form-data" };
}

export async function readImageInput(req: Request, maxBytes = MAX_INPUT_BYTES): Promise<ReadInputResult> {
  const body = await parseToolRequest(req, maxBytes);
  return body.ok ? imageInputFrom(body, maxBytes) : body;
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
  name: string,
  bytes: Uint8Array,
  extension: string,
  mime: string,
): Promise<StoredImage> {
  const { folder, baseName } = openinaryTarget(`postora/${userId}/${area}/${name}`, config.folderPrefix);
  const stored = await uploadBytesToOpeninary(config, bytes, folder, baseName, extension, mime);
  return stored.success && stored.url && stored.path ? { ok: true, url: stored.url, path: stored.path } : { ok: false, error: stored.error || "Openinary upload failed" };
}

/** A temporary, publicly fetchable copy so a provider that takes a URL can read an uploaded image. */
export function stageInput(config: OpeninaryConfig, userId: string, input: Extract<ImageInput, { kind: "bytes" }>): Promise<StoredImage> {
  return putInOpeninary(config, userId, "ai-tmp", crypto.randomUUID(), input.bytes, input.extension, input.mime);
}

/**
 * The durable copy of a provider result. `name` makes the path deterministic, so storing the
 * same result twice (a repeated follow-up request) adopts the first copy instead of adding another.
 */
export function storeResult(
  config: OpeninaryConfig,
  userId: string,
  area: "upscaled" | "processed",
  image: { bytes: Uint8Array; extension: string; mime: string },
  name: string = crypto.randomUUID(),
): Promise<StoredImage> {
  return putInOpeninary(config, userId, area, name, image.bytes, image.extension, image.mime);
}

/** A stable, path-safe name for the result of one provider job. */
export async function resultNameFor(predictionId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(predictionId)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Removes a staged copy. Cleanup only: it never throws and never fails the request. */
export async function discardStaged(config: OpeninaryConfig, path: string, timeoutMs = 5_000): Promise<void> {
  const removed = await deleteFromOpeninary(config, path, timeoutMs);
  if (!removed.success) console.warn(JSON.stringify({ event: "ai_image_stage_cleanup_failed", path, error: removed.error }));
}

export type FetchedImage =
  | { ok: true; bytes: Uint8Array; extension: string; mime: string }
  | { ok: false; error: string };

/**
 * Downloads a provider's output. One deadline covers the headers *and* the body, and the body is
 * read as a stream that is abandoned the moment it passes `maxBytes`, so neither a slow nor an
 * oversized answer is ever fully held. The type is read from the bytes.
 */
export async function fetchOutputImage(
  url: string,
  options: { fetchFn?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchedImage> {
  const { fetchFn = fetch, maxBytes = MAX_OUTPUT_BYTES, timeoutMs = DEFAULT_OUTPUT_TIMEOUT_MS } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, timeoutMs);
  });

  const download = async (): Promise<FetchedImage> => {
    const response = await fetchFn(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `output fetch failed: HTTP ${response.status}` };
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, error: "output larger than the size limit" };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, error: "output was empty" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: "output larger than the size limit" };
      }
      chunks.push(value);
    }
    if (!total) return { ok: false, error: "output was empty" };
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const extension = extensionForBytes(bytes);
    if (!extension) return { ok: false, error: "output is not a supported image type" };
    return { ok: true, bytes, extension, mime: MIME_FOR_EXTENSION[extension] };
  };

  try {
    return await Promise.race([download(), deadline]);
  } catch (error) {
    return { ok: false, error: `output fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Width and height from a PNG header, or null for anything else. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || extensionForBytes(bytes) !== "png") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The upscaler's output format: "png" or "jpeg" when the caller asks (anything else is null,
 * for the caller to refuse). Otherwise the default never throws transparency away: only an
 * input known to be JPEG (bytes sniffed as jpg, or a URL path ending in .jpg/.jpeg) gets JPEG;
 * everything else, including an extensionless URL, gets PNG.
 */
export function chooseUpscaleOutputFormat(requested: unknown, input: ImageInput): "png" | "jpeg" | null {
  if (requested !== undefined && requested !== null && requested !== "") {
    return requested === "png" || requested === "jpeg" ? requested : null;
  }
  const isJpeg = input.kind === "bytes" ? input.extension === "jpg" : /\.jpe?g$/i.test(new URL(input.url).pathname);
  return isJpeg ? "jpeg" : "png";
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
