import { awaitWithAbort } from "./abort.ts";
import { metaResponseThrottle } from "./metaResponseThrottle.ts";

export type MetaBudgetRpc = (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<unknown>;
type AppIdentity = { facebook?: string; instagram?: string; threads?: string };

async function budgetCall(rpc: MetaBudgetRpc, name: string, args: Record<string, unknown>, signal?: AbortSignal | null): Promise<unknown> {
  const bounded = AbortSignal.any([AbortSignal.timeout(4_000), ...(signal ? [signal] : [])]);
  const envelope = await awaitWithAbort(() => rpc(name, args, bounded), bounded);
  if (!envelope || typeof envelope !== "object" || !("data" in envelope) || !("error" in envelope) || envelope.error !== null) {
    throw new Error("Meta shared budget unavailable");
  }
  return envelope.data;
}

/** The existing app meter is shared by bootstrap, collection and official discovery. No token enters a bucket key. */
export function sharedMetaBudgetFetch(input: { rpc: MetaBudgetRpc; apps: AppIdentity; fetcher?: typeof fetch }): typeof fetch {
  return async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    const family = url.hostname === "graph.facebook.com" ? "facebook" : url.hostname === "graph.instagram.com" ? "instagram"
      : url.hostname === "graph.threads.net" ? "threads" : null;
    const appId = family ? input.apps[family] : null;
    if (!family || !appId) return await (input.fetcher ?? fetch)(request, init);
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`owned_analytics:app:${family}:${appId}`));
    const bucket = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const parent = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    const signal = AbortSignal.any([AbortSignal.timeout(8_000), ...(parent ? [parent] : [])]);
    const current = await budgetCall(input.rpc, "read_meta_analytics_provider_throttle", { p_bucket_key: bucket }, signal);
    if (current !== null && (typeof current !== "object" || !("throttled_until" in current))) throw new Error("Meta shared budget unavailable");
    const until = current && typeof current === "object" && "throttled_until" in current ? current.throttled_until : null;
    if (until !== null && (typeof until !== "string" || !Number.isFinite(Date.parse(until)))) throw new Error("Meta shared budget unavailable");
    if (typeof until === "string" && Date.parse(until) > Date.now()) {
      return Response.json({ error: { code: 4, is_transient: true } }, { status: 429,
        headers: { "retry-after": String(Math.ceil((Date.parse(until) - Date.now()) / 1000)) } });
    }
    const response = await awaitWithAbort(() => (input.fetcher ?? fetch)(request, { ...init, signal }), signal);
    const { usage, pause, retryAt } = await metaResponseThrottle(response, signal);
    if (usage || pause) {
      try {
        const saved = await budgetCall(input.rpc, "record_instagram_provider_throttle_http", { p_bucket_key: bucket, p_usage_percent: usage,
          p_throttled_until: retryAt, p_job_id: null, p_claim_token: null, p_job_generation: null }, signal);
        if (!saved || typeof saved !== "object" || !("bucket_key" in saved) || saved.bucket_key !== bucket
          || !("throttled_until" in saved) || saved.throttled_until !== null && (typeof saved.throttled_until !== "string"
            || !Number.isFinite(Date.parse(saved.throttled_until))) || retryAt !== null && (typeof saved.throttled_until !== "string"
            || Date.parse(saved.throttled_until) < Date.parse(retryAt))) throw new Error("Meta shared budget unavailable");
      } catch {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Meta shared budget unavailable");
      }
    }
    return response;
  };
}
