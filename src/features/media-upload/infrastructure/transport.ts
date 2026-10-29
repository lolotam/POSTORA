/**
 * Multipart POST with upload progress. fetch() cannot report how much of a
 * request body has been sent, and a 500 MB upload needs a progress bar, so this
 * one place uses XMLHttpRequest.
 */

export interface TransportResponse {
  status: number;
  body: unknown;
}

export type PostForm = (
  url: string,
  form: FormData,
  options: { headers?: Record<string, string>; onProgress?: (fraction: number) => void; signal?: AbortSignal },
) => Promise<TransportResponse>;

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export const xhrPostForm: PostForm = (url, form, { headers = {}, onProgress, signal } = {}) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = xhr.responseText;
      }
      resolve({ status: xhr.status, body });
    };
    // A CORS refusal, a dropped connection and a proxy that resets an oversized
    // body all surface here, with no status to tell them apart.
    xhr.onerror = () => reject(new TransportError("Network error while uploading"));
    xhr.onabort = () => reject(new TransportError("Upload cancelled"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
