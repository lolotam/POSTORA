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
 * Every URL this module fetches passes through here. `allowedHostSuffixes` names the
 * origins this particular fetch may reach; null means "any public https host".
 *
 * It is never null when credentials are attached -- an unvalidated origin plus a bearer
 * token is how an access token leaks, and Postora's own resolution step is not a substitute
 * for checking. It is also non-null for uncredentialed fetches whose transport publishes a
 * known set of CDNs, because "which origins may this VPC be made to call" is a separate
 * question from "where may a token travel".
 */
/**
 * Where a fetch may go, and why it is bounded. The `carriesCredentials` half only shapes
 * the error, but the distinction is worth keeping: "a token would have leaked here" and
 * "this VPC was asked to call a stranger" are different incidents.
 */
interface HostPolicy {
  suffixes: string[];
  carriesCredentials: boolean;
}

const CREDENTIALED_POLICY: HostPolicy = {
  suffixes: CREDENTIALED_HOST_SUFFIXES,
  carriesCredentials: true,
};

function assertFetchableUrl(rawUrl: string, policy: HostPolicy | null): URL {
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
  if (policy && !hostIsAllowed(parsed.hostname, policy.suffixes)) {
    throw new MediaFetchError(
      policy.carriesCredentials
        ? `refusing to send credentials to ${parsed.hostname}`
        : `refusing to fetch media from ${parsed.hostname}`,
      "transport_failed",
    );
  }
  return parsed;
}

/**
 * Meta's messaging CDNs. Wider than CREDENTIALED_HOST_SUFFIXES on purpose: a Messenger
 * voice clip is served from `cdn.fbsbx.com`, which does NOT suffix-match the
 * `lookaside.fbsbx.com` entry that list carries, and photos come from `scontent.*.fbcdn.net`.
 *
 * No credentials are sent to these hosts -- the URL Meta puts in the webhook is already
 * signed -- so this list bounds *where the VPC will make a request*, not where a token may
 * travel. That is the guarantee the spec asks for and that a bare URL fetcher does not give.
 */
const META_MEDIA_POLICY = {
  suffixes: ["fbsbx.com", "fbcdn.net", "cdninstagram.com"],
  carriesCredentials: false,
};

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
  /**
   * What the transport itself called this media, when it knows better than any mime. A
   * transport fact like `connectionMode`, not a policy one -- the pipeline decides what to
   * do with it.
   */
  kindHint?: "audio" | "image" | "document" | null;
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
  fetchMediaBytes(
    ref: MediaRef,
    limits: FetchLimits,
    fetcher?: typeof fetch,
    signal?: AbortSignal,
  ): Promise<FetchedMedia>;
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

/** Rejects with AbortError when `signal` fires. Never resolves. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

async function readCapped(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // An exhausted budget means the deadline has PASSED, not that there is no deadline.
  // Reading it as "unlimited" is how a shared download clock turned into an unbounded body
  // read for exactly the slow download the clock exists to stop.
  if (timeoutMs <= 0) {
    throw new MediaFetchError("no time left to read the body", "timeout");
  }
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
  const budget = timeoutAfter(timeoutMs);
  const aborted = signal ? whenAborted(signal) : null;
  try {
    while (true) {
      const racers: Promise<unknown>[] = [reader.read(), budget.promise];
      if (aborted) racers.push(aborted);
      const { done, value } = await Promise.race(racers) as ReadableStreamReadResult<Uint8Array>;
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
    // Ours pass through; the runtime's do not. A body-read failure carries the request URL
    // in its message on some runtimes, and that message is logged verbatim upstream --
    // the same leak the request path already guards against.
    if (error instanceof MediaFetchError) throw error;
    if ((error as Error)?.name === "AbortError") throw error;
    throw new MediaFetchError(
      `body read failed (${(error as Error)?.name || "Error"})`,
      "transport_failed",
    );
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
  policy: HostPolicy | null = null,
  external?: AbortSignal,
): Promise<Response> {
  const target = assertFetchableUrl(url, policy);
  if (external?.aborted) {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) external.addEventListener("abort", onExternalAbort, { once: true });
  try {
    // manual: a 302 to an attacker-chosen host would otherwise carry the Authorization
    // header along with it. The caller re-validates each hop.
    return await fetcher(url, { ...init, signal: controller.signal, redirect: "manual" });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      // An external deadline must surface as AbortError so the caller can tell it
      // apart from this function's own timeout.
      if (external?.aborted) throw error;
      throw new MediaFetchError(`timed out after ${timeoutMs}ms`, "timeout");
    }
    // The runtime's own message is NOT propagated. A media URL is signed -- Meta's
    // attachment links carry the authorisation in the query string -- and Deno's network
    // and TLS errors quote the URL they were fetching. That message is logged verbatim
    // upstream, which would put a live credential in the log. Host and error class are
    // enough to diagnose a transport failure and carry no secret.
    throw new MediaFetchError(
      `network error contacting ${target.hostname} (${(error as Error)?.name || "Error"})`,
      "transport_failed",
    );
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * One shared clock for a whole download.
 *
 * `limits.timeoutMs` is a duration, not a budget. Restarted for the initial request, each
 * redirect and the body read, a two-hop download consumes four times what the operator
 * configured -- which is how a 10s download and a 40s provider ladder added up to 80s
 * against a 60s worker ceiling. Every step now draws from the same remaining time, so the
 * configured number is the total.
 */
/**
 * Pins an Evolution request to the instance the operator configured.
 *
 * An unparseable base is a configuration error, not a licence to fetch anywhere: it refuses
 * rather than falling back to an unbounded policy.
 */
function evolutionPolicy(baseUrl: string): HostPolicy {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new MediaFetchError("EVOLUTION_API_URL is not a valid url", "transport_failed");
  }
  return { suffixes: [host], carriesCredentials: true };
}

function remainingTimeFrom(totalMs: number): () => number {
  const endsAt = Date.now() + totalMs;
  return () => Math.max(0, endsAt - Date.now());
}

/** A redirect is another origin: validate it exactly as strictly as the first hop. */
function redirectTarget(response: Response, from: string): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, from).toString();
  } catch {
    // The raw TypeError quotes the Location it failed on, and `from` is a signed URL that
    // a relative resolution would have merged into it. That message is logged verbatim
    // upstream, so it never leaves this function.
    throw new MediaFetchError("redirect location is not a valid url", "transport_failed");
  }
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
    signal?: AbortSignal,
  ): Promise<FetchedMedia> {
    const token = ref.accessToken;
    if (!token) throw new MediaFetchError("no access token", "transport_failed");
    const auth = { Authorization: `Bearer ${token}` };
    // Lookup, redirects and body read share one budget -- see remainingTimeFrom.
    const remaining = remainingTimeFrom(limits.timeoutMs);

    let url = ref.mediaUrl ?? null;
    let mime = ref.mimeType ?? null;

    // Resolve the id to a short-lived URL when the webhook did not already do it.
    if (!url) {
      if (!ref.mediaId) throw new MediaFetchError("neither mediaUrl nor mediaId", "not_found");
      const meta = await timedFetch(
        fetcher,
        `${GRAPH_BASE}/${encodeURIComponent(ref.mediaId)}`,
        { headers: auth },
        remaining(),
        CREDENTIALED_POLICY,
        signal,
      );
      if (!meta.ok) {
        throw new MediaFetchError(`media lookup ${meta.status}`, meta.status === 404 ? "not_found" : "transport_failed");
      }
      // Under the shared clock and the size cap like any other body. `meta.json()` is a
      // body read too, and an unguarded one lets a stalled lookup hang the continuation
      // that the deadline exists to bound. 64KB is generous for {id, url, mime_type}.
      const LOOKUP_MAX_BYTES = 64 * 1024;
      const raw = await readCapped(meta, LOOKUP_MAX_BYTES, remaining(), signal);
      let data: { url?: string; mime_type?: string };
      try {
        data = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        throw new MediaFetchError("media lookup returned invalid json", "transport_failed");
      }
      url = data?.url ?? null;
      mime = mime ?? data?.mime_type ?? null;
      if (!url) throw new MediaFetchError("media lookup returned no url", "not_found");
    }

    // Follow at most two hops, validating each. `redirect: "manual"` means the token is
    // never replayed to a location we have not checked.
    let response = await timedFetch(fetcher, url, { headers: auth }, remaining(), CREDENTIALED_POLICY, signal);
    for (let hop = 0; hop < 2; hop += 1) {
      const next = redirectTarget(response, url);
      if (!next) break;
      url = next;
      response = await timedFetch(fetcher, url, { headers: auth }, remaining(), CREDENTIALED_POLICY, signal);
    }
    if (!response.ok) {
      throw new MediaFetchError(`media download ${response.status}`, "transport_failed");
    }

    const bytes = await readCapped(response, limits.maxBytes, remaining(), signal);
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
    signal?: AbortSignal,
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
      // The apikey header travels with this request, so the invariant above applies: a
      // credentialed call is never unbounded. The destination is built from the configured
      // base, and pinning it here is what stops a tampered EVOLUTION_API_URL from being the
      // one thing standing between the key and an arbitrary host.
      evolutionPolicy(this.baseUrl),
      signal,
    );
    if (!response.ok) {
      throw new MediaFetchError(`evolution media ${response.status}`, "transport_failed");
    }

    // Bounded like every other body. Evolution returns the media base64-encoded inside
    // JSON, so the envelope is about 4/3 of the bytes plus the wrapper -- twice the byte
    // ceiling is ample and still stops an unbounded read. decodeBase64Capped applies the
    // real limit to the payload itself.
    const raw = await readCapped(response, limits.maxBytes * 2, limits.timeoutMs, signal);
    let data: { base64?: string; media?: string; mimetype?: string };
    try {
      data = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new MediaFetchError("evolution returned invalid json", "transport_failed");
    }
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
    signal?: AbortSignal,
  ): Promise<FetchedMedia> {
    if (!ref.mediaUrl) throw new MediaFetchError("no mediaUrl", "not_found");
    // No credentials are attached here, so the allowlist does not apply -- but https-only
    // and the private-network block still do, since this runs service-role inside the VPC.
    const response = await timedFetch(fetcher, ref.mediaUrl, {}, limits.timeoutMs, null, signal);
    if (!response.ok) throw new MediaFetchError(`download ${response.status}`, "transport_failed");
    const bytes = await readCapped(response, limits.maxBytes, limits.timeoutMs, signal);
    return { bytes, mimeType: ref.mimeType ?? response.headers.get("content-type") ?? "application/octet-stream" };
  }
}

/**
 * Facebook and Instagram messaging attachments.
 *
 * Meta puts a signed, already-authorised CDN URL straight in the webhook, so nothing is
 * resolved and no credential is attached -- sending the page token to a CDN would leak it
 * to a host that never asked. What this fetcher adds over a bare URL download is the
 * origin bound: the request may only reach a Meta media host, which is the guarantee the
 * spec makes about inbound media and which DirectUrlFetcher, by design, does not.
 *
 * It also owns the one container quirk of this transport, so no platform knowledge leaks
 * into the shared pipeline: a Messenger voice clip is an `audioclip-....mp4` served as
 * `video/mp4`. The bytes really are an MP4; only Meta's own `type: "audio"` tells us there
 * is no picture track. That is the sole condition under which the type is rewritten.
 */
export class MetaMessagingFetcher implements InboundMediaFetcher {
  readonly name = "meta_messaging";

  canHandle(ref: MediaRef): boolean {
    return Boolean(ref.mediaUrl) && (ref.platform === "facebook" || ref.platform === "instagram");
  }

  async fetchMediaBytes(
    ref: MediaRef,
    limits: FetchLimits,
    fetcher: typeof fetch = fetch,
    signal?: AbortSignal,
  ): Promise<FetchedMedia> {
    if (!ref.mediaUrl) throw new MediaFetchError("no mediaUrl", "not_found");

    // Meta's CDNs redirect between scontent hosts. `redirect: "manual"` means each hop is
    // re-validated against the allowlist rather than followed blind.
    const remaining = remainingTimeFrom(limits.timeoutMs);
    let url = ref.mediaUrl;
    let response = await timedFetch(fetcher, url, {}, remaining(), META_MEDIA_POLICY, signal);
    for (let hop = 0; hop < 2; hop += 1) {
      const next = redirectTarget(response, url);
      if (!next) break;
      url = next;
      response = await timedFetch(fetcher, url, {}, remaining(), META_MEDIA_POLICY, signal);
    }
    if (!response.ok) throw new MediaFetchError(`download ${response.status}`, "transport_failed");

    const bytes = await readCapped(response, limits.maxBytes, remaining(), signal);
    const served = response.headers.get("content-type") ?? ref.mimeType ?? "application/octet-stream";
    return { bytes, mimeType: normaliseMetaMime(ref.kindHint, served) };
  }
}

function normaliseMetaMime(kindHint: MediaRef["kindHint"], served: string): string {
  const bare = served.split(";")[0].trim().toLowerCase();
  return kindHint === "audio" && bare === "video/mp4" ? "audio/mp4" : served;
}

export function selectFetcher(
  ref: MediaRef,
  candidates: InboundMediaFetcher[],
): InboundMediaFetcher | null {
  return candidates.find((candidate) => candidate.canHandle(ref)) ?? null;
}
