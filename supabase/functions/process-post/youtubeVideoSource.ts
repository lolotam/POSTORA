/**
 * Reading the video's bytes a range at a time.
 *
 * WHY THIS EXISTS
 * ---------------
 * The YouTube upload is written in chunks, so the bytes have to arrive a
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
 * THE SKIP IS EXACT
 * -----------------
 * A stream delivers the file in blocks whose sizes the host chooses, and a
 * block boundary almost never lands on the offset that was asked for. The
 * skip therefore keeps the part of the block that is still wanted instead of
 * dropping the whole block: the bytes that were read past the offset are the
 * first bytes of the next range.
 *
 * WHAT IS BOUNDED
 * ---------------
 * A media host is an untrusted party. The body it sends is read through a
 * bounded reader, so a host that announces a small file and then sends
 * gigabytes cannot make the worker allocate them. The stream buffer is
 * capped as well, so the worker never holds more than one chunk plus one
 * block.
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

import { parseContentRange, type UploadByteSource } from "./youtubeResumableUpload.ts";
import {
  isApprovedMediaUrl,
  redactProviderText,
  YOUTUBE_UPLOAD_REASON,
  type YoutubeUploadReason,
} from "./youtubeUploadPolicy.ts";

/**
 * A failure to read the video.
 *
 * It carries a STABLE reason code, and its message is stable too. That is the
 * point: a media read fails for a handful of reasons, and the reason a human
 * needs is never the reason the exception happened to carry.
 *
 * The exception a failed read throws is the dangerous one. A signed media URL
 * is a credential, and `fetch` puts the URL it was given into the message of
 * the error it raises. So the raw text goes into `detail`, which is redacted
 * and is for the log line, and never into `message`, which is what the public
 * result and the stored error column are built from.
 */
export class VideoSourceError extends Error {
  /** The stable reason code. */
  readonly reason: YoutubeUploadReason;
  /** A redacted detail. For a log line, never for the public result. */
  readonly detail: string;

  constructor(reason: YoutubeUploadReason, message: string, detail?: string) {
    super(message);
    this.name = "VideoSourceError";
    this.reason = reason;
    this.detail = detail ? redactProviderText(detail) : "";
  }
}

/** The message a media read failure carries. It names no host and no URL. */
const MEDIA_READ_FAILED = "The video could not be read from the media host.";
/** The message a media host that is not approved carries. */
const MEDIA_ORIGIN_NOT_APPROVED = "The video is stored on a host this upload may not read from.";

/** How long one media request may take. */
export const VIDEO_SOURCE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * How many bytes the stream buffer may hold.
 *
 * The worker asks for one chunk at a time, so this is a ceiling on the
 * worst case rather than the usual case. A host that tries to push more than
 * this through the reader is refused.
 */
export const VIDEO_SOURCE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * How many redirects a media read may follow.
 *
 * Every hop is checked against the approved hosts, so a redirect cannot move
 * the read to a host that was not reviewed.
 */
export const VIDEO_SOURCE_MAX_REDIRECTS = 3;

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
  /**
   * The hosts this read may go to.
   *
   * When it is given, the URL and every redirect hop are checked against it
   * BEFORE any request is made. An unapproved host never receives a request.
   */
  approvedHosts?: Set<string>;
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
  return parseContentRange(value)?.total ?? null;
}

/**
 * What the host answered to a range request, reduced to the size and the type.
 */
export function readProbeResponse(response: Response, declaredSize?: number | null): VideoSourceProbe {
  const contentRange = response.headers.get("content-range");
  const mimeType = mimeTypeOf(response.headers.get("content-type"), "application/octet-stream");

  if (response.status === 206) {
    const total = parseContentRangeTotal(contentRange);
    if (total === null) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The media host answered a range request without naming the file size.",
      );
    }
    return { size: total, mimeType, ranged: true };
  }

  if (response.status === 200) {
    const lengthHeader = response.headers.get("content-length");
    const length = lengthHeader === null ? declaredSize ?? 0 : Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The media host did not say how large the video is.",
      );
    }
    return { size: length, mimeType, ranged: false };
  }

  throw new VideoSourceError(
    YOUTUBE_UPLOAD_REASON.media_read_failed,
    MEDIA_READ_FAILED,
    `The media host answered ${response.status} instead of the video.`,
  );
}

/**
 * Reads a body through a bounded reader.
 *
 * `maxBytes` is the number of bytes that are wanted. A body that announces a
 * different length is refused before it is read, and a body that sends more
 * than it announced is refused while it is read. Either way the worker never
 * allocates more than it asked for.
 */
export async function readBoundedBytes(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new VideoSourceError(
      YOUTUBE_UPLOAD_REASON.media_read_failed,
      MEDIA_READ_FAILED,
      `The media host announced ${declared} bytes instead of ${maxBytes}.`,
    );
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== maxBytes) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        `The media host answered ${buffer.byteLength} bytes instead of ${maxBytes}.`,
      );
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new VideoSourceError(
          YOUTUBE_UPLOAD_REASON.media_read_failed,
          MEDIA_READ_FAILED,
          `The media host sent more than ${maxBytes} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total !== maxBytes) {
    throw new VideoSourceError(
      YOUTUBE_UPLOAD_REASON.media_read_failed,
      MEDIA_READ_FAILED,
      `The media host answered ${total} bytes instead of ${maxBytes}.`,
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * Fetches a media URL, following only redirects that stay inside the
 * approved hosts.
 *
 * The host of the first URL is checked before the first request, and the host
 * of every hop is checked before that hop is made. A redirect to a host that
 * was not approved is refused rather than followed.
 *
 * It is exported because the rule is the rule for every file the worker
 * reads: the video and the thumbnail are read through the same door.
 */
export async function fetchApprovedMedia(
  url: string,
  init: RequestInit,
  approvedHosts: Set<string> | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let target = url;

  for (let hop = 0; hop <= VIDEO_SOURCE_MAX_REDIRECTS; hop += 1) {
    if (approvedHosts && !isApprovedMediaUrl(target, approvedHosts)) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_origin_not_approved,
        MEDIA_ORIGIN_NOT_APPROVED,
      );
    }

    const response = await fetchImpl(target, { ...init, redirect: "manual" });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    let next: string;
    try {
      next = new URL(location, target).toString();
    } catch {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The media host answered with a redirect this upload cannot follow.",
      );
    }

    if (approvedHosts && !isApprovedMediaUrl(next, approvedHosts)) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_origin_not_approved,
        MEDIA_ORIGIN_NOT_APPROVED,
      );
    }
    target = next;
  }

  throw new VideoSourceError(
    YOUTUBE_UPLOAD_REASON.media_read_failed,
    MEDIA_READ_FAILED,
    "The media host answered with too many redirects.",
  );
}

function mediaReadError(error: unknown): VideoSourceError {
  if (error instanceof VideoSourceError) return error;
  return new VideoSourceError(YOUTUBE_UPLOAD_REASON.media_read_failed, MEDIA_READ_FAILED, error instanceof Error ? error.message : String(error));
}

/** A source that reads a range with one request per range. */
class RangeByteSource implements VideoByteSource {
  readonly ranged = true;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
    private readonly approvedHosts: Set<string> | undefined,
    readonly size: number,
    readonly mimeType: string,
  ) {}

  async read(start: number, end: number, timeoutMs?: number): Promise<ArrayBuffer> {
    try {
      const wanted = end - start + 1;
      const budget = Math.max(1, Math.min(timeoutMs ?? this.timeoutMs, this.timeoutMs));
      const response = await fetchApprovedMedia(
        this.url,
        {
          method: "GET",
          headers: { Range: `bytes=${start}-${end}` },
          signal: AbortSignal.timeout(budget),
        },
        this.approvedHosts,
        this.fetchImpl,
      );
      if (response.status !== 206) {
        void response.body?.cancel().catch(() => {});
        throw new VideoSourceError(
          YOUTUBE_UPLOAD_REASON.media_read_failed,
          MEDIA_READ_FAILED,
          `The media host answered ${response.status} instead of the requested bytes.`,
        );
      }
      const contentRange = response.headers.get("content-range");
      const returned = parseContentRange(contentRange);
      if (!returned || returned.start !== start || returned.end !== end || returned.total !== this.size) {
        void response.body?.cancel().catch(() => {});
        throw new VideoSourceError(
          YOUTUBE_UPLOAD_REASON.media_read_failed,
          MEDIA_READ_FAILED,
          "The media host answered with a different range than the one that was asked for.",
        );
      }
      return await readBoundedBytes(response, wanted);
    } catch (error) {
      throw mediaReadError(error);
    }
  }
}

/**
 * A source that reads a stream from the start and skips to the offset.
 *
 * The stream is opened once and advanced forward. A range that starts before
 * the current position is served by opening a fresh stream and skipping
 * again, which happens only when a resumed upload is asked for bytes that
 * were already passed.
 *
 * THE SKIP IS EXACT
 * -----------------
 * `readOffset` is the file offset of the next byte this source hands out, and
 * `buffer` holds the bytes from that offset on. A block that reaches past the
 * offset that was asked for is not dropped: the part before the offset is
 * discarded and the part from the offset on stays in the buffer, so the next
 * range starts with exactly the byte it asked for.
 */
class StreamingByteSource implements VideoByteSource {
  readonly ranged = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private controller: AbortController | null = null;
  /** The file offset of the next byte handed out. */
  private readOffset = 0;
  /** How many bytes the stream has produced. */
  private streamOffset = 0;
  /** The bytes from `readOffset` on. */
  private buffer: Uint8Array = new Uint8Array(0);
  /** Where the wanted bytes start inside `buffer`. */
  private bufferStart = 0;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
    private readonly approvedHosts: Set<string> | undefined,
    readonly size: number,
    readonly mimeType: string,
  ) {}

  /** How many bytes are buffered and not handed out yet. */
  private get available(): number {
    return this.buffer.length - this.bufferStart;
  }

  private async open(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const response = await fetchApprovedMedia(
      this.url,
      { method: "GET", signal: controller.signal },
      this.approvedHosts,
      this.fetchImpl,
    );
    controller.signal.throwIfAborted();
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        `The media host answered ${response.status} instead of the video.`,
      );
    }
    this.reader = response.body.getReader();
    this.readOffset = 0;
    this.streamOffset = 0;
    this.buffer = new Uint8Array(0);
    this.bufferStart = 0;
  }

  /**
   * Reads one block from the stream into the buffer.
   *
   * The buffer is capped, so a host that sends an endless block is refused
   * instead of being allowed to grow the worker's memory. The stream is also
   * not allowed to produce more bytes than the file has, so a host that
   * announces one size and sends another is refused instead of quietly
   * changing the video.
   */
  private async pull(): Promise<void> {
    if (!this.reader) throw new VideoSourceError(YOUTUBE_UPLOAD_REASON.media_read_failed, MEDIA_READ_FAILED, "The media stream is closed.");
    const { done, value } = await this.reader.read();
    if (done) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The media stream ended before the video did.",
      );
    }
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (chunk.byteLength === 0) return;

    if (this.streamOffset + chunk.byteLength > this.size) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The media host sent more bytes than the video has.",
      );
    }
    this.streamOffset += chunk.byteLength;

    if (this.available + chunk.byteLength > VIDEO_SOURCE_MAX_BUFFER_BYTES) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The media host sent more than this upload is willing to hold.",
      );
    }

    this.buffer = chunk;
    this.bufferStart = 0;
  }

  /**
   * Moves the read position to `offset`.
   *
   * Bytes before the offset are discarded. Bytes at or after the offset are
   * kept, so a block boundary that lands past the offset does not throw away
   * the bytes the next range needs.
   */
  private async skipTo(offset: number): Promise<void> {
    if (this.readOffset > offset) {
      // The stream is past the offset. A fresh one is opened and the prefix
      // is skipped again.
      this.reset();
    }
    if (!this.reader) await this.open();

    while (this.readOffset < offset) {
      if (this.available === 0) {
        await this.pull();
        continue;
      }
      const drop = Math.min(offset - this.readOffset, this.available);
      this.bufferStart += drop;
      this.readOffset += drop;
    }
  }

  private reset(): void {
    this.controller?.abort();
    this.controller = null;
    void this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.buffer = new Uint8Array(0);
    this.bufferStart = 0;
    this.readOffset = 0;
    this.streamOffset = 0;
  }

  async read(start: number, end: number, timeoutMs?: number): Promise<ArrayBuffer> {
    const wanted = end - start + 1;
    if (start < 0 || end >= this.size || wanted <= 0 || wanted > VIDEO_SOURCE_MAX_BUFFER_BYTES) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The requested media range is outside the readable bounds.",
      );
    }

    const budget = Math.max(1, Math.min(timeoutMs ?? this.timeoutMs, this.timeoutMs));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.reset();
    }, budget);
    try {
      await this.skipTo(start);
      const bytes = new Uint8Array(wanted);
      let filled = 0;
      while (filled < wanted) {
        if (this.available === 0) {
          await this.pull();
          continue;
        }
        const take = Math.min(wanted - filled, this.available);
        bytes.set(this.buffer.subarray(this.bufferStart, this.bufferStart + take), filled);
        this.bufferStart += take;
        this.readOffset += take;
        filled += take;
      }
      return bytes.buffer;
    } catch (error) {
      this.reset();
      if (!timedOut) throw mediaReadError(error);
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The media read took longer than this upload is allowed.",
      );
    } finally {
      clearTimeout(timer);
    }
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

  // The host is checked before the first request, so an unapproved host never
  // receives one.
  if (options.approvedHosts && !isApprovedMediaUrl(options.url, options.approvedHosts)) {
    throw new VideoSourceError(
      YOUTUBE_UPLOAD_REASON.media_origin_not_approved,
      MEDIA_ORIGIN_NOT_APPROVED,
    );
  }

  let response: Response;
  try {
    response = await fetchApprovedMedia(
      options.url,
      {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal: AbortSignal.timeout(timeoutMs),
      },
      options.approvedHosts,
      fetchImpl,
    );
  } catch (error) {
    // The exception a failed media read throws carries the URL it was given,
    // and a signed media URL is a credential. The raw text is redacted into
    // the detail, which is for the log line; the message the caller sees is
    // the stable one, and the reason is the stable code.
    throw mediaReadError(error);
  }

  let probe: VideoSourceProbe;
  try {
    if (response.status === 416) {
      throw new VideoSourceError(
        YOUTUBE_UPLOAD_REASON.media_read_failed,
        MEDIA_READ_FAILED,
        "The video is empty.",
      );
    }
    probe = readProbeResponse(response, options.declaredSize);
  } finally {
    void response.body?.cancel().catch(() => {});
  }

  const size = probe.size;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new VideoSourceError(
      YOUTUBE_UPLOAD_REASON.media_read_failed,
      MEDIA_READ_FAILED,
      "The video host did not say how large the video is.",
    );
  }
  const mimeType = probe.mimeType === "application/octet-stream" ? fallbackMimeType : probe.mimeType;

  if (probe.ranged) {
    return new RangeByteSource(options.url, fetchImpl, timeoutMs, options.approvedHosts, size, mimeType);
  }
  return new StreamingByteSource(options.url, fetchImpl, timeoutMs, options.approvedHosts, size, mimeType);
}
