// Inbound media fetchers — the ONLY place that knows how a given transport hands over
// bytes. Everything downstream (inboundMediaUnderstanding.ts) sees bytes and a mime type.
//
// Adding a platform means adding a fetcher here and nothing else. If a change to a
// transport forces an edit to the understanding module, the boundary is wrong.
//
// Spec: docs/specs/2026-08-25-inbound-media-understanding.md (D9).

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface MediaRef {
  platform: "whatsapp" | "instagram" | "facebook";
  /** Absent for Cloud API, which resolves a URL from the id first. */
  connectionMode?: string | null;
  mediaId?: string | null;
  mediaUrl?: string | null;
  /** Evolution can hand the payload straight back as base64. */
  rawBase64?: string | null;
  accessToken?: string | null;
  mimeType?: string | null;
}

export interface FetchedMedia {
  bytes: Uint8Array;
  mimeType: string;
}

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
}

export class MediaFetchError extends Error {
  constructor(message: string, readonly reason: "too_large" | "not_found" | "transport_failed" | "timeout") {
    super(message);
    this.name = "MediaFetchError";
  }
}

export interface InboundMediaFetcher {
  readonly name: string;
  canHandle(ref: MediaRef): boolean;
  fetchMediaBytes(ref: MediaRef, limits: FetchLimits, fetcher?: typeof fetch): Promise<FetchedMedia>;
}

/**
 * Reads the body with a hard ceiling instead of trusting Content-Length.
 *
 * Content-Length is supplied by the remote host, so checking it alone would let an
 * oversized or lying response through and buffer it anyway. Streaming lets us abandon
 * the read the moment the ceiling is crossed, which is the point of having a limit.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaFetchError(`declared ${declared} bytes exceeds ${maxBytes}`, "too_large");
  }

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new MediaFetchError(`${buffer.byteLength} bytes exceeds ${maxBytes}`, "too_large");
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new MediaFetchError(`stream exceeded ${maxBytes} bytes`, "too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function timedFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new MediaFetchError(`timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new MediaFetchError((error as Error)?.message ?? "network error", "transport_failed");
  } finally {
    clearTimeout(timer);
  }
}

function decodeBase64(data: string): Uint8Array {
  const clean = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * WhatsApp Cloud API, coexistence, Instagram and Messenger.
 *
 * Covers cloud_api AND coexistence deliberately: _shared/whatsappTransport.ts:106 already
 * routes everything that is not evolution_qr to one Cloud transport for sending, and a
 * second, differently-drawn split for receiving would drift from it.
 *
 * A Graph media URL is NOT public -- it 401s without the Bearer token. That is the bug
 * that makes transcribe-media's bare fetch unusable here.
 */
export class CloudGraphFetcher implements InboundMediaFetcher {
  readonly name = "cloud_graph";

  canHandle(ref: MediaRef): boolean {
    if (!ref.accessToken) return false;
    if (ref.platform === "whatsapp") return ref.connectionMode !== "evolution_qr";
    return ref.platform === "instagram" || ref.platform === "facebook";
  }

  async fetchMediaBytes(
    ref: MediaRef,
    limits: FetchLimits,
    fetcher: typeof fetch = fetch,
  ): Promise<FetchedMedia> {
    const token = ref.accessToken;
    if (!token) throw new MediaFetchError("no access token", "transport_failed");

    let url = ref.mediaUrl ?? null;
    let mime = ref.mimeType ?? null;

    // Resolve the id to a short-lived URL when the webhook did not already do it.
    if (!url) {
      if (!ref.mediaId) throw new MediaFetchError("neither mediaUrl nor mediaId", "not_found");
      const meta = await timedFetch(
        fetcher,
        `${GRAPH_BASE}/${encodeURIComponent(ref.mediaId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
        limits.timeoutMs,
      );
      if (!meta.ok) {
        throw new MediaFetchError(`media lookup ${meta.status}`, meta.status === 404 ? "not_found" : "transport_failed");
      }
      const data = await meta.json();
      url = data?.url ?? null;
      mime = mime ?? data?.mime_type ?? null;
      if (!url) throw new MediaFetchError("media lookup returned no url", "not_found");
    }

    const response = await timedFetch(
      fetcher,
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      limits.timeoutMs,
    );
    if (!response.ok) {
      throw new MediaFetchError(`media download ${response.status}`, "transport_failed");
    }

    const bytes = await readCapped(response, limits.maxBytes);
    return { bytes, mimeType: mime ?? response.headers.get("content-type") ?? "application/octet-stream" };
  }
}

/**
 * Evolution QR (Baileys). Prefers the base64 the webhook already carried; otherwise asks
 * the Evolution instance for it.
 *
 * Wired in phase 2 -- see the plan. The class exists now so the port has more than one
 * implementation from the start, which is what keeps the abstraction honest.
 */
export class EvolutionFetcher implements InboundMediaFetcher {
  readonly name = "evolution";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly instance: string,
  ) {}

  canHandle(ref: MediaRef): boolean {
    return ref.platform === "whatsapp" && ref.connectionMode === "evolution_qr";
  }

  async fetchMediaBytes(
    ref: MediaRef,
    limits: FetchLimits,
    fetcher: typeof fetch = fetch,
  ): Promise<FetchedMedia> {
    if (ref.rawBase64) {
      const bytes = decodeBase64(ref.rawBase64);
      if (bytes.byteLength > limits.maxBytes) {
        throw new MediaFetchError(`${bytes.byteLength} bytes exceeds ${limits.maxBytes}`, "too_large");
      }
      return { bytes, mimeType: ref.mimeType ?? "application/octet-stream" };
    }

    if (!ref.mediaId) throw new MediaFetchError("no rawBase64 and no mediaId", "not_found");

    const response = await timedFetch(
      fetcher,
      `${this.baseUrl.replace(/\/+$/, "")}/chat/getBase64FromMediaMessage/${encodeURIComponent(this.instance)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: this.apiKey },
        body: JSON.stringify({ message: { key: { id: ref.mediaId } }, convertToMp4: false }),
      },
      limits.timeoutMs,
    );
    if (!response.ok) {
      throw new MediaFetchError(`evolution media ${response.status}`, "transport_failed");
    }

    const data = await response.json();
    const base64 = data?.base64 ?? data?.media ?? null;
    if (!base64) throw new MediaFetchError("evolution returned no base64", "not_found");

    const bytes = decodeBase64(String(base64));
    if (bytes.byteLength > limits.maxBytes) {
      throw new MediaFetchError(`${bytes.byteLength} bytes exceeds ${limits.maxBytes}`, "too_large");
    }
    return { bytes, mimeType: data?.mimetype ?? ref.mimeType ?? "application/octet-stream" };
  }
}

/** Plain public URL, no credentials. Last resort. */
export class DirectUrlFetcher implements InboundMediaFetcher {
  readonly name = "direct_url";

  canHandle(ref: MediaRef): boolean {
    return Boolean(ref.mediaUrl && !ref.accessToken);
  }

  async fetchMediaBytes(
    ref: MediaRef,
    limits: FetchLimits,
    fetcher: typeof fetch = fetch,
  ): Promise<FetchedMedia> {
    if (!ref.mediaUrl) throw new MediaFetchError("no mediaUrl", "not_found");
    // Only ever a URL Postora itself resolved from a provider -- never one taken from a
    // webhook body, which would make this an SSRF surface.
    const response = await timedFetch(fetcher, ref.mediaUrl, {}, limits.timeoutMs);
    if (!response.ok) throw new MediaFetchError(`download ${response.status}`, "transport_failed");
    const bytes = await readCapped(response, limits.maxBytes);
    return { bytes, mimeType: ref.mimeType ?? response.headers.get("content-type") ?? "application/octet-stream" };
  }
}

export function selectFetcher(
  ref: MediaRef,
  candidates: InboundMediaFetcher[],
): InboundMediaFetcher | null {
  return candidates.find((candidate) => candidate.canHandle(ref)) ?? null;
}
