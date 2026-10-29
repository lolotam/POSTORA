/**
 * Sends a file to one provider using the signed target media-direct-upload issued.
 * Each returns what `complete` needs to confirm the object, or throws with a
 * reason short enough to record on the provider's failed row.
 */

import { chunkRanges, contentRangeHeader } from "../domain/chunks";
import type { PostForm } from "./transport";

export interface OpeninaryTarget {
  provider: "openinary";
  url: string;
  fileField: "files";
  fields: Record<string, string>;
}

export interface CloudinaryTarget {
  provider: "cloudinary";
  url: string;
  fileField: "file";
  chunkSize: number;
  fields: Record<string, string>;
}

export type UploadTarget = OpeninaryTarget | CloudinaryTarget;

export interface CloudinaryResult {
  public_id: string;
  version: number | string;
  signature: string;
  secure_url: string;
  bytes?: number;
  width?: number;
  height?: number;
  format?: string;
  duration?: number;
}

/** A chunk is retried this many times: the same range under the same upload id is safe to resend. */
const CHUNK_ATTEMPTS = 3;

function formWith(fields: Record<string, string>, fileField: string, blob: Blob, fileName: string): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append(fileField, blob, fileName);
  return form;
}

function providerError(provider: string, status: number, body: unknown): Error {
  const payload = body as { error?: unknown; errors?: { error?: unknown }[] } | null;
  const nested = payload?.error as { message?: unknown } | string | undefined;
  const detail = typeof nested === "string"
    ? nested
    : typeof nested?.message === "string"
      ? nested.message
      : typeof payload?.errors?.[0]?.error === "string"
        ? payload.errors[0].error
        : `HTTP ${status}`;
  return new Error(`${provider} refused the upload: ${detail}`);
}

export async function uploadToOpeninary(
  target: OpeninaryTarget,
  file: File,
  postForm: PostForm,
  onProgress: (fraction: number) => void,
): Promise<{ path: string }> {
  const { status, body } = await postForm(target.url, formWith(target.fields, target.fileField, file, file.name), { onProgress });
  const result = body as { success?: boolean; files?: { path?: unknown }[] } | null;
  const path = result?.files?.[0]?.path;
  if (status < 200 || status >= 300 || !result?.success || typeof path !== "string") {
    if (status === 413) throw new Error("openinary refused the upload: the file is larger than the server accepts");
    throw providerError("openinary", status, body);
  }
  return { path };
}

export async function uploadToCloudinary(
  target: CloudinaryTarget,
  file: File,
  postForm: PostForm,
  onProgress: (fraction: number) => void,
  uploadId: string = crypto.randomUUID(),
): Promise<CloudinaryResult> {
  const ranges = chunkRanges(file.size, target.chunkSize);
  const chunked = ranges.length > 1;
  let last: unknown = null;
  for (const range of ranges) {
    const headers = chunked
      ? { "X-Unique-Upload-Id": uploadId, "Content-Range": contentRangeHeader(range, file.size) }
      : undefined;
    const form = formWith(target.fields, target.fileField, file.slice(range.start, range.end), file.name);
    let response: { status: number; body: unknown } | null = null;
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      try {
        response = await postForm(target.url, form, {
          headers,
          onProgress: (fraction) => onProgress((range.start + fraction * (range.end - range.start)) / file.size),
        });
      } catch (error) {
        if (attempt === CHUNK_ATTEMPTS) throw error;
        continue;
      }
      if (response.status < 500 || attempt === CHUNK_ATTEMPTS) break;
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw providerError("cloudinary", response?.status ?? 0, response?.body);
    }
    last = response.body;
  }
  const result = last as Partial<CloudinaryResult> | null;
  if (!result?.public_id || !result.secure_url || !result.signature || result.version === undefined) {
    throw new Error("cloudinary returned no finished upload");
  }
  onProgress(1);
  return result as CloudinaryResult;
}
