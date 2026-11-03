/**
 * Reads a JSON request body without buffering more than `maxBytes`.
 *
 * `req.json()` reads the whole body before any schema runs, so a caller could
 * send megabytes to an endpoint that expects a few hundred bytes. This stops
 * reading at the cap, whatever Content-Length claims.
 */
import { awaitWithAbort } from "./abort.ts";

export type CappedJsonBody =
  | { ok: true; value: unknown }
  | { ok: false; reason: "too_large" | "invalid_json" };

export async function readJsonBodyCapped(req: Request, maxBytes: number, signal?: AbortSignal): Promise<CappedJsonBody> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  if (!req.body) return { ok: false, reason: "invalid_json" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await (signal ? awaitWithAbort(() => reader.read(), signal) : reader.read());
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > maxBytes) {
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
