/**
 * URL uploads larger than the in-memory cap, streamed to Openinary rather than buffered.
 *
 * Under MEDIA_DECODED_BYTE_CAP (10 MB) a URL is read into memory as before. Above it,
 * when the source declares its length, the body is streamed straight into Openinary up
 * to the admin's limit for its kind, so an API or MCP upload reaches the same limits as
 * the browser. Spec: docs/superpowers/specs/2026-10-29-hardening-followups-design.md, Part C.
 */

import { directUploadByteCap, MEDIA_DECODED_BYTE_CAP, type MediaKind, type UploadLimits } from "../_shared/mediaTypes.ts";

/**
 * The most one streamed upload may carry while Openinary is behind Cloudflare, which
 * refuses any request body over 100 MB; the margin covers the multipart framing.
 */
export const STREAM_INGEST_MAX_BYTES = 95 * 1024 * 1024;

/** Bytes kept from the start of the body to tell the file's type, as the buffered path does. */
export const SNIFF_BYTES = 4096;

/** The declared length of a source that goes the streamed way, or null when it is read into memory. */
export function streamedSourceLength(contentLength: string | null): number | null {
  const declared = Number(contentLength);
  return Number.isSafeInteger(declared) && declared > MEDIA_DECODED_BYTE_CAP ? declared : null;
}

/** The largest streamed upload of this kind, or null when the kind cannot be streamed. */
export function streamIngestCap(kind: MediaKind, limits: UploadLimits): number | null {
  const cap = directUploadByteCap(kind, limits);
  return cap === null ? null : Math.min(cap, STREAM_INGEST_MAX_BYTES);
}

/**
 * The providers a streamed upload may use: Openinary only. Only Openinary counts the bytes
 * against the declared length, and Cloudinary would import the URL itself with none of the
 * declared-length or admin-cap checks; the two legs in sequence (45 s and 60 s) would also
 * outlast the worker. So a stream that fails fails the upload, instead of being retried
 * through Cloudinary.
 */
export function streamProviders(providers: { attempted: string[]; required: string[] }): { attempted: string[]; required: string[] } {
  return {
    attempted: providers.attempted.filter((provider) => provider === "openinary"),
    required: providers.required.filter((provider) => provider === "openinary"),
  };
}

/** What the caller is told when a streamed upload did not reach storage. */
export function streamFailureMessage(errors: string[]): string {
  return `The file could not be streamed to storage (${errors.join("; ") || "unknown error"})`;
}

/** Reads at least `bytes` from the start of the stream (less only if it ends first). */
export async function readPrefix(reader: ReadableStreamDefaultReader<Uint8Array>, bytes = SNIFF_BYTES): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return prefix;
}

/** The whole body again: the prefix already read, then the rest of the reader. */
export function prefixedStream(prefix: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let prefixSent = prefix.byteLength === 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        controller.enqueue(prefix);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
