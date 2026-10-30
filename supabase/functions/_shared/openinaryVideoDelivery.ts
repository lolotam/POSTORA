/**
 * Openinary video delivery I/O: request a transformed rendition (following the 202 /
 * `statusUrl` protocol) and stream it into a new stored object.
 *
 * Nothing here buffers a video. The rendition is read as a stream and written to
 * `POST /api/upload` as a hand-built multipart body: an edge worker has 150 MB of memory,
 * and Openinary accepts uploads of up to 50 MB by default.
 */

import {
  deleteFromOpeninary,
  encodeOpeninaryPath,
  openinaryDeliveryUrl,
  uploadBytesToOpeninary,
  type OpeninaryConfig,
} from "./openinary.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";

/** Openinary's default `MAX_FILE_SIZE_MB`; a larger rendition would be refused by its upload route. */
export const MAX_DERIVED_BYTES = 50 * 1024 * 1024;
/** Share of the 60 s edge budget spent waiting for the encode. */
export const TRANSFORM_DEADLINE_MS = 40_000;
/**
 * Renditions up to this size go through the production upload path (`uploadBytesToOpeninary`,
 * a plain FormData with a Content-Length). Larger ones are streamed, chunked.
 */
export const BUFFERED_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS = 30_000;
/** Below this much time left in the deadline, a new request is not worth starting. */
const MIN_REQUEST_MS = 500;
const MAX_REQUEST_ROUNDS = 4;

export interface DeliveryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  deadlineMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function variantUrl(config: OpeninaryConfig, segment: string, path: string): string {
  return `${config.serverUrl}/t/${segment}/${encodeOpeninaryPath(path)}`;
}

/** `statusUrl` is root-relative on Openinary; refuse anything that leaves the configured server. */
function statusEndpoint(config: OpeninaryConfig, statusUrl: unknown, segment: string, path: string): string {
  const fallback = `${config.serverUrl}/video-status/${segment}/${encodeOpeninaryPath(path)}`;
  if (typeof statusUrl !== "string") return fallback;
  try {
    const resolved = new URL(statusUrl, `${config.serverUrl}/`);
    return resolved.origin === new URL(config.serverUrl).origin ? resolved.toString() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Time out waiting for the reply's headers only. An AbortSignal.timeout would also cut the
 * body read, and the rendition's body is streamed into storage well after the headers arrive.
 */
async function fetchWithHeaderTimeout(fetchImpl: typeof fetch, url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stillProcessing(): OpeninaryVideoError {
  return new OpeninaryVideoError(
    "TRANSFORM_STILL_PROCESSING",
    "The video is still being processed. Try again in a minute; the work already done is kept.",
  );
}

type RequestDeps = Required<Pick<DeliveryDeps, "fetchImpl" | "sleep" | "now">>;

/**
 * One request that can never outlast the transform deadline. A timeout means the encode is still
 * running (retryable); any other failure to reach Openinary is a provider problem. Neither is an
 * unexpected error, so neither may escape as a 500.
 */
async function requestWithinDeadline(deps: RequestDeps, url: string, deadlineAt: number): Promise<Response> {
  const left = deadlineAt - deps.now();
  if (left < MIN_REQUEST_MS) throw stillProcessing();
  try {
    return await fetchWithHeaderTimeout(deps.fetchImpl, url, Math.min(REQUEST_TIMEOUT_MS, left));
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") throw stillProcessing();
    console.error("[openinary-video] request failed:", error instanceof Error ? error.message : String(error));
    throw new OpeninaryVideoError("PROVIDER_UNAVAILABLE", "The video service is temporarily unavailable. Try again shortly.");
  }
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* nothing left to release */ }
}

async function waitForCompletion(
  config: OpeninaryConfig,
  statusUrl: string,
  deps: RequestDeps,
  deadlineAt: number,
): Promise<void> {
  while (deps.now() < deadlineAt) {
    const response = await requestWithinDeadline(deps, statusUrl, deadlineAt);
    const body = await response.json().catch(() => null) as { status?: string; error?: string } | null;
    const status = body?.status;
    if (response.ok && status === "completed") return;
    if (status === "error" || status === "cancelled") {
      console.error("[openinary-video] encode reported", status, typeof body?.error === "string" ? body.error.slice(0, 200) : "");
      throw new OpeninaryVideoError("TRANSFORM_FAILED", "Openinary could not process this video. Try a shorter or smaller file.");
    }
    // `not_found` means no job and no cached variant: ask for the rendition again to queue it.
    if (status === "not_found" || !response.ok) return;
    await deps.sleep(Math.max(0, Math.min(POLL_INTERVAL_MS, deadlineAt - deps.now())));
  }
  throw stillProcessing();
}

/**
 * The rendition's 200 response, unread, once Openinary has produced it. A first request for an
 * uncached variant answers 202; poll the status, then request it again.
 */
export async function fetchVideoVariant(
  config: OpeninaryConfig,
  segment: string,
  path: string,
  options: DeliveryDeps = {},
): Promise<Response> {
  const deps = {
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? Date.now,
  };
  const deadlineAt = deps.now() + (options.deadlineMs ?? TRANSFORM_DEADLINE_MS);
  const url = variantUrl(config, segment, path);

  for (let round = 0; round < MAX_REQUEST_ROUNDS; round++) {
    if (deps.now() >= deadlineAt) break;
    const response = await requestWithinDeadline(deps, url, deadlineAt);
    if (response.status === 200) {
      // Openinary types the reply by extension; anything but video is not a rendition to store.
      const type = response.headers.get("content-type");
      if (type && !type.toLowerCase().startsWith("video/")) {
        await discard(response);
        console.error("[openinary-video] rendition answered with content type", type);
        throw new OpeninaryVideoError("TRANSFORM_FAILED", "Openinary could not process this video. Try a shorter or smaller file.");
      }
      return response;
    }
    if (response.status === 202) {
      const body = await response.json().catch(() => null) as { statusUrl?: unknown } | null;
      // "completed" and "retry" both mean: request the rendition again.
      await waitForCompletion(config, statusEndpoint(config, body?.statusUrl, segment, path), deps, deadlineAt);
      continue;
    }
    await discard(response);
    if (response.status === 404) {
      throw new OpeninaryVideoError("SOURCE_NOT_AVAILABLE", "The original video is no longer in storage.");
    }
    console.error("[openinary-video] rendition request failed with HTTP", response.status);
    throw new OpeninaryVideoError(
      "TRANSFORM_FAILED",
      response.status === 400
        ? "Openinary rejected these video settings."
        : "Openinary could not process this video. Try a shorter or smaller file.",
    );
  }
  throw stillProcessing();
}

/** Size the response announces, or null when it streams without a length. */
export function declaredBytes(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export interface IngestedVideo { path: string; url: string; bytes: number }

const FIELD_FORBIDDEN = /["\r\n\\]/;
const STORE_FAILED_MESSAGE = "Could not store the processed video.";

function storeFailed(): OpeninaryVideoError {
  return new OpeninaryVideoError("STORE_FAILED", STORE_FAILED_MESSAGE);
}

/**
 * Store a rendition as `folder/fileName`. A name Openinary renamed to avoid a collision is a
 * failure (the deterministic read URL would not find it), and the renamed object is removed.
 */
export async function ingestVariant(
  config: OpeninaryConfig,
  response: Response,
  folder: string,
  fileName: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<IngestedVideo> {
  if (FIELD_FORBIDDEN.test(folder) || FIELD_FORBIDDEN.test(fileName)) {
    await discard(response);
    throw storeFailed();
  }
  if (!response.body) throw new OpeninaryVideoError("STORE_FAILED", "Openinary returned an empty video.");
  const length = declaredBytes(response);
  if (length !== null && length > MAX_DERIVED_BYTES) {
    await discard(response);
    throw new OpeninaryVideoError("RESULT_TOO_LARGE", `The processed video is larger than the ${MAX_DERIVED_BYTES / 1024 / 1024} MB storage limit. Use a lower quality or a shorter clip.`);
  }
  return length !== null && length <= BUFFERED_UPLOAD_MAX_BYTES
    ? await ingestBuffered(config, response, length, folder, fileName)
    : await ingestStreamed(config, response, length, folder, fileName, options);
}

async function ingestBuffered(config: OpeninaryConfig, response: Response, length: number, folder: string, fileName: string): Promise<IngestedVideo> {
  const blob = await response.blob();
  if (blob.size !== length) {
    console.error("[openinary-video] rendition ended before its declared length");
    throw storeFailed();
  }
  const dot = fileName.lastIndexOf(".");
  const result = await uploadBytesToOpeninary(config, blob, folder, fileName.slice(0, dot), fileName.slice(dot + 1), "video/mp4", blob.size);
  if (result.success && result.path) return { path: result.path, url: result.url ?? openinaryDeliveryUrl(config, result.path), bytes: blob.size };
  console.error("[openinary-video] buffered upload failed:", result.error);
  // A collision rename stores the object under another path; do not leave it behind.
  if (result.path && result.path !== `${folder}/${fileName}`) await deleteFromOpeninary(config, result.path);
  throw storeFailed();
}

async function ingestStreamed(
  config: OpeninaryConfig,
  response: Response,
  length: number | null,
  folder: string,
  fileName: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<IngestedVideo> {
  const encoder = new TextEncoder();
  const boundary = `----postora${crypto.randomUUID().replaceAll("-", "")}`;
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="folder"\r\n\r\n${folder}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: video/mp4\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const reader = response.body!.getReader();
  let sent = 0;
  let overLimit = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(head); },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(tail);
        controller.close();
        return;
      }
      sent += value.byteLength;
      if (sent > MAX_DERIVED_BYTES) {
        overLimit = true;
        await reader.cancel();
        controller.error(new Error("rendition exceeds the storage limit"));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });

  const fetchImpl = options.fetchImpl ?? fetch;
  let upload: Response;
  try {
    upload = await fetchImpl(`${config.serverUrl}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: "half",
      signal: AbortSignal.timeout(options.timeoutMs ?? 55_000),
    } as RequestInit);
  } catch (error) {
    if (overLimit) {
      throw new OpeninaryVideoError("RESULT_TOO_LARGE", "The processed video is larger than the storage limit. Use a lower quality or a shorter clip.");
    }
    console.error("[openinary-video] streamed upload failed:", error instanceof Error ? error.message : String(error));
    throw storeFailed();
  }

  const result = await upload.json().catch(() => null) as { success?: boolean; files?: { path?: unknown; size?: unknown }[] } | null;
  const stored = result?.files?.[0]?.path;
  if (!upload.ok || !result?.success || typeof stored !== "string") {
    console.error("[openinary-video] streamed upload refused with HTTP", upload.status);
    throw storeFailed();
  }
  const reportedSize = result.files?.[0]?.size;
  // The declared length is checked on its own: a stream that ended early must not pass just
  // because Openinary left `size` out of its reply.
  const sizeMatches = (length === null || length === sent) && (typeof reportedSize !== "number" || reportedSize === sent);
  if (stored !== `${folder}/${fileName}` || !sizeMatches) {
    console.error("[openinary-video] streamed upload stored a different object than requested");
    await deleteFromOpeninary(config, stored);
    throw storeFailed();
  }
  return { path: stored, url: openinaryDeliveryUrl(config, stored), bytes: sent };
}
