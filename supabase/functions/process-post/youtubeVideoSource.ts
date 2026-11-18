/**
 * Reading the video's bytes a range at a time.
 *
 * WHY THIS EXISTS
 * ---------------
 * The YouTube upload is now written in chunks, so the bytes have to arrive a
 * chunk at a time too. The old path downloaded the whole file into memory and
 * then sent it as one request, which is what made a long video fail: the
 * worker held the whole file, and a single lost answer lost all of it.
 *
 * TWO WAYS TO READ
 * ----------------
 * Most hosts that serve Postora's media -- Supabase Storage, Cloudinary,
 * Openinary -- answer a `Range` request with the requested bytes, and a
 * range read is the cheap one: it seeks straight to the offset.
 * A host that ignores `Range` answers with the whole file. The bytes are
 * then read from a stream instead, and the prefix is skipped, so the memory
 * the worker holds stays one chunk whatever the file's size is. Resuming a
 * late upload from a host like that costs the skipped prefix in bandwidth,
 * which is a price worth paying for not holding the file in memory.
 *
 * WHAT IS REFUSED
 * ---------------
 * A range answer is checked against the range that was asked for: the status
 * must be `206 Partial Content`, the `Content-Range` must name exactly the
 * bytes that were requested, and the body must carry exactly that many
 * bytes. An answer that does not match is refused rather than used, because a
 * short or shifted read would upload the wrong bytes to the customer's
 * channel.
 */

import type { UploadByteSource } from "./youtubeResumableUpload.ts";

/** How long one media request may take. */
export const VIDEO_SOURCE_REQUEST_TIMEOUT_MS = 60_000;

/** The video's bytes, and what the host could tell us about them. */
export interface VideoByteSource extends UploadByteSource {
  /** The type the host answered with, without any parameters. */
  readonly mimeType: string;
  /** Whether the host serves byte ranges. */
  readonly ranged: boolean;
}

/** What the host said about the file. */
export interface VideoSourceProbe {
  size: number;
  mimeType: string;
  ranged: boolean;
}

/** How to read a video. */
export interface VideoByteSourceOptions {
  url: string;
  /** The type the caller already knows, used when the host does not say. */
  mimeType?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The size the caller already knows, used when the host cannot say. */
  declaredSize?: number | null;
}

function mimeTypeOf(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.split(";")[0].trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The total size a `Content-Range` header names.
 *
 * `Content-Range: bytes 0-0/12345` is the 206 answer to a one byte range
 * request, and its total is the size of the file.
 */
export function parseContentRangeTotal(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim());
  if (!match) return null;
  if (match[3] === "*") return null;
  const total = Number(match[3]);
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  return total;
}

/**
 * What the host answered to a range request, reduced to the size and the type.
 */
export function readProbeResponse(response: Response): VideoSourceProbe {
  const contentRange = response.headers.get("content-range");
  const mimeType = mimeTypeOf(response.headers.get("content-type"), "application/octet-stream");

  if (response.status === 206) {
    const total = parseContentRangeTotal(contentRange);
    if (total === null) {
      throw new Error("The media host answered a range request without naming the file size.");
    }
    return { size: total, mimeType, ranged: true };
  }

  if (response.status === 200) {
    const length = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error("The media host did not say how large the video is.");
    }
    return { size: length, mimeType, ranged: false };
  }

  throw new Error(`The media host answered ${response.status} instead of the video.`);
}

/** A source that reads a range with one request per range. */
class RangeByteSource implements VideoByteSource {
  readonly ranged = true;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
    readonly size: number,
    readonly mimeType: string,
  ) {}

  async read(start: number, end: number): Promise<ArrayBuffer> {
    const wanted = end - start + 1;
    const response = await this.fetchImpl(this.url, {
      method: "GET",
      headers: { Range: `bytes=${start}-${end}` },
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status !== 206) {
      throw new Error(`The media host answered ${response.status} instead of the requested bytes.`);
    }
    const contentRange = response.headers.get("content-range");
    const expected = /^bytes\s+(\d+)-(\d+)\//.exec(contentRange ?? "");
    if (!expected || Number(expected[1]) !== start || Number(expected[2]) !== end) {
      throw new Error("The media host answered with a different range than the one that was asked for.");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== wanted) {
      throw new Error(`The media host answered ${bytes.byteLength} bytes instead of ${wanted}.`);
    }
    return bytes;
  }
}

/**
 * A source that reads a stream from the start and skips to the offset.
 *
 * The stream is opened once and advanced forward. A range that starts before
 * the current position is served by opening a fresh stream and skipping
 * again, which happens only when a resumed upload is asked for bytes that
 * were already passed.
 */
class StreamingByteSource implements VideoByteSource {
  readonly ranged = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private position = 0;
  private pending: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
    readonly size: number,
    readonly mimeType: string,
  ) {}

  private async open(): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok || !response.body) {
      throw new Error(`The media host answered ${response.status} instead of the video.`);
    }
    this.reader = response.body.getReader();
    this.position = 0;
    this.pending = new Uint8Array(0);
  }

  private async fill(wanted: number): Promise<void> {
    while (this.pending.length < wanted) {
      if (!this.reader) throw new Error("The media stream is closed.");
      const { done, value } = await this.reader.read();
      if (done) throw new Error("The media stream ended before the video did.");
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const merged = new Uint8Array(this.pending.length + chunk.length);
      merged.set(this.pending, 0);
      merged.set(chunk, this.pending.length);
      this.pending = merged;
    }
  }

  private async skipTo(offset: number): Promise<void> {
    if (this.position > offset) {
      // The stream is past the offset. A fresh one is opened and the prefix
      // is skipped again.
      await this.reset();
    }
    if (!this.reader) await this.open();
    while (this.position < offset) {
      if (!this.reader) throw new Error("The media stream is closed.");
      const { done, value } = await this.reader.read();
      if (done) throw new Error("The media stream ended before the video did.");
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      this.position += chunk.length;
    }
  }

  private async reset(): Promise<void> {
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // The stream is already gone; a fresh one is opened either way.
      }
      this.reader = null;
    }
    this.pending = new Uint8Array(0);
  }

  async read(start: number, end: number): Promise<ArrayBuffer> {
    const wanted = end - start + 1;
    await this.skipTo(start);
    await this.fill(wanted);
    const bytes = this.pending.slice(0, wanted);
    this.pending = this.pending.slice(wanted);
    this.position += wanted;
    return bytes.buffer as ArrayBuffer;
  }
}

/**
 * Asks the host about the video and returns a source for its bytes.
 *
 * The probe is one byte, so a host that ignores `Range` is discovered before
 * the whole file is downloaded. The body of that probe is cancelled when the
 * host answered with the whole file.
 */
export async function createVideoByteSource(options: VideoByteSourceOptions): Promise<VideoByteSource> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? VIDEO_SOURCE_REQUEST_TIMEOUT_MS;
  const fallbackMimeType = mimeTypeOf(options.mimeType, "application/octet-stream");

  let response: Response;
  try {
    response = await fetchImpl(options.url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The video could not be read: ${reason}`);
  }

  if (response.status === 416) {
    throw new Error("The video is empty.");
  }

  const probe = readProbeResponse(response);

  // The probe answered with the whole file. It is not read: the source below
  // opens its own stream.
  if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // The body was already consumed or closed; nothing to release.
    }
  }

  const size = probe.size || options.declaredSize || 0;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("The video host did not say how large the video is.");
  }
  const mimeType = probe.mimeType === "application/octet-stream" ? fallbackMimeType : probe.mimeType;

  if (probe.ranged) {
    return new RangeByteSource(options.url, fetchImpl, timeoutMs, size, mimeType);
  }
  return new StreamingByteSource(options.url, fetchImpl, timeoutMs, size, mimeType);
}
