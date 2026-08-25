// Inbound media fetchers — the ONLY place that knows how a given transport hands over
// bytes. Everything downstream (inboundMediaUnderstanding.ts) sees bytes and a mime type.
//
// Adding a platform means adding a fetcher here and nothing else. If a change to a
// transport forces an edit to the understanding module, the boundary is wrong.
//
// Spec: docs/specs/2026-08-25-inbound-media-understanding.md (D9).

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Hosts a credentialed download may target. Meta returns media on lookaside/fbcdn
 * domains, and the account's bearer token travels with the request -- so the token must
 * never reach an origin outside this list, no matter where the URL came from.
 *
 * Suffix-matched against the parsed hostname, never against the raw string: substring
 * matching would accept "graph.facebook.com.evil.test".
 */
const CREDENTIALED_HOST_SUFFIXES = [
  "graph.facebook.com",
  "lookaside.fbsbx.com",
  "fbcdn.net",
  "cdninstagram.com",
];

function hostIsAllowed(hostname: string, suffixes: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Blocks loopback, link-local, and RFC1918 targets reached by literal IP. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

/**
 * Every URL this module fetches passes through here. `requireAllowlist` is true whenever
 * credentials are attached: an unvalidated origin plus a bearer token is how an access
 * token leaks, and Postora's own resolution step is not a substitute for checking.
 */
function assertFetchableUrl(rawUrl: string, requireAllowlist: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MediaFetchError("media url is not parseable", "transport_failed");
  }
  if (parsed.protocol !== "https:") {
    throw new MediaFetchError(`refusing non-https media url (${parsed.protocol})`, "transport_failed");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new MediaFetchError("refusing private-network media url", "transport_failed");
  }
  if (requireAllowlist && !hostIsAllowed(parsed.hostname, CREDENTIALED_HOST_SUFFIXES)) {
    throw new MediaFetchError(
      `refusing to send credentials to ${parsed.hostname}`,
      "transport_failed",
    );
  }
  return parsed;
}

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
/** Rejects with a timeout MediaFetchError once `ms` elapses. Never resolves. */
function timeoutAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new MediaFetchError(`body read exceeded ${ms}ms`, "timeout")), ms);
  });
  return { promise, cancel: () => { if (timer !== undefined) clearTimeout(timer); } };
}

async function readCapped(response: Response, maxBytes: number, timeoutMs = 0): Promise<Uint8Array> {
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
  // One deadline for the WHOLE body, raced against every read. Checking the clock between
  // reads is not enough: a server can send headers, emit one chunk, and then leave the
  // next read pending forever, which would hang the continuation that owes the customer
  // a reply.
  const budget = timeoutMs > 0 ? timeoutAfter(timeoutMs) : null;
  try {
    while (true) {
      const { done, value } = budget
        ? await Promise.race([reader.read(), budget.promise])
        : await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new MediaFetchError(`stream exceeded ${maxBytes} bytes`, "too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    // Release the socket on the way out, whether we hit the cap or the deadline.
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    budget?.cancel();
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
  requireAllowlist = false,
): Promise<Response> {
  assertFetchableUrl(url, requireAllowlist);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // manual: a 302 to an attacker-chosen host would otherwise carry the Authorization
    // header along with it. The caller re-validates each hop.
    return await fetcher(url, { ...init, signal: controller.signal, redirect: "manual" });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new MediaFetchError(`timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new MediaFetchError((error as Error)?.message ?? "network error", "transport_failed");
  } finally {
    clearTimeout(timer);
  }
}

/** A redirect is another origin: validate it exactly as strictly as the first hop. */
function redirectTarget(response: Response, from: string): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  return new URL(location, from).toString();
}

/**
 * Decodes with the ceiling applied to the ENCODED string first.
 *
 * Checking only the decoded length is too late: atob() materialises a full binary string
 * and the Uint8Array is a second copy, so an oversized payload can exhaust the isolate
 * before any check runs -- and an OOM is not catchable by the pipeline's try/catch.
 * Base64 is 4 chars per 3 bytes, so encoded length bounds decoded length.
 */
function decodeBase64Capped(data: string, maxBytes: number): Uint8Array {
  const clean = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const approxDecoded = Math.floor((clean.length * 3) / 4);
  if (approxDecoded > maxBytes) {
    throw new MediaFetchError(`base64 payload ~${approxDecoded} bytes exceeds ${maxBytes}`, "too_large");
  }
  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    throw new MediaFetchError("media payload is not valid base64", "transport_failed");
  }
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
    const auth = { Authorization: `Bearer ${token}` };

    let url = ref.mediaUrl ?? null;
    let mime = ref.mimeType ?? null;

    // Resolve the id to a short-lived URL when the webhook did not already do it.
    if (!url) {
      if (!ref.mediaId) throw new MediaFetchError("neither mediaUrl nor mediaId", "not_found");
      const meta = await timedFetch(
        fetcher,
        `${GRAPH_BASE}/${encodeURIComponent(ref.mediaId)}`,
        { headers: auth },
        limits.timeoutMs,
        true,
      );
      if (!meta.ok) {
        throw new MediaFetchError(`media lookup ${meta.status}`, meta.status === 404 ? "not_found" : "transport_failed");
      }
      const data = await meta.json();
      url = data?.url ?? null;
      mime = mime ?? data?.mime_type ?? null;
      if (!url) throw new MediaFetchError("media lookup returned no url", "not_found");
    }

    // Follow at most two hops, validating each. `redirect: "manual"` means the token is
    // never replayed to a location we have not checked.
    let response = await timedFetch(fetcher, url, { headers: auth }, limits.timeoutMs, true);
    for (let hop = 0; hop < 2; hop += 1) {
      const next = redirectTarget(response, url);
      if (!next) break;
      url = next;
      response = await timedFetch(fetcher, url, { headers: auth }, limits.timeoutMs, true);
    }
    if (!response.ok) {
      throw new MediaFetchError(`media download ${response.status}`, "transport_failed");
    }

    const bytes = await readCapped(response, limits.maxBytes, limits.timeoutMs);
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
      const bytes = decodeBase64Capped(ref.rawBase64, limits.maxBytes);
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

    const bytes = decodeBase64Capped(String(base64), limits.maxBytes);
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
    // No credentials are attached here, so the allowlist does not apply -- but https-only
    // and the private-network block still do, since this runs service-role inside the VPC.
    const response = await timedFetch(fetcher, ref.mediaUrl, {}, limits.timeoutMs, false);
    if (!response.ok) throw new MediaFetchError(`download ${response.status}`, "transport_failed");
    const bytes = await readCapped(response, limits.maxBytes, limits.timeoutMs);
    return { bytes, mimeType: ref.mimeType ?? response.headers.get("content-type") ?? "application/octet-stream" };
  }
}

export function selectFetcher(
  ref: MediaRef,
  candidates: InboundMediaFetcher[],
): InboundMediaFetcher | null {
  return candidates.find((candidate) => candidate.canHandle(ref)) ?? null;
}
