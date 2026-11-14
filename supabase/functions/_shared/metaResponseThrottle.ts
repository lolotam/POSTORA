import { awaitWithAbort } from "./abort.ts";
import { parseMetaUsagePercent } from "./metaUsage.ts";

/** Inspect only a bounded copy; the provider adapter still owns the original body. */
async function graphRateLimited(response: Response, signal: AbortSignal): Promise<boolean> {
  if (response.status === 429) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await awaitWithAbort(() => reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 65_536) {
        // Collection payloads may exceed the envelope bound; their adapter owns the body limit.
        if (response.ok) return false;
        throw new Error("Meta response unavailable");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return false; }
    if (!body || typeof body !== "object" || !("error" in body) || !body.error || typeof body.error !== "object"
      || !("code" in body.error)) return false;
    return [4, 17, 32, 613].includes(Number(body.error.code));
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** HTTP and Graph-code throttles share one pause/deadline contract. */
export async function metaResponseThrottle(response: Response, signal: AbortSignal): Promise<{
  usage: number; pause: boolean; retryAt: string | null;
}> {
  const usage = Math.ceil(parseMetaUsagePercent(response.headers));
  let pause: boolean;
  try { pause = response.status === 429 || usage >= 80 || await graphRateLimited(response, signal); }
  catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const retry = response.headers.get("retry-after");
  const instant = retry && /^\d{1,7}$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
  return { usage, pause, retryAt: pause
    ? new Date(Number.isFinite(instant) && instant > Date.now() ? instant : Date.now() + 15 * 60_000).toISOString() : null };
}
