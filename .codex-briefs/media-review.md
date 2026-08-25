You are an adversarial code reviewer. DO NOT EDIT CODE. DO NOT CALL TOOLS. DO NOT SEARCH.
Your shell is broken here and GitHub main does NOT have this branch. All code is inlined below.

## Context (verified facts, accept them)
- Feature: the WhatsApp AI agent could not read voice notes or images. whatsapp-webhook set
  messageText='[Audio message]' and passed THAT to the agent. Non-text is 21.8% of inbound.
- Runtime is Deno edge functions, self-hosted Supabase. Webhooks run SERVICE-ROLE (no user JWT).
- GOOGLE_AI_STUDIO_KEY and OPENAI_API_KEY are set in the edge runtime. DEEPGRAM_API_KEY is NOT.
- WhatsApp Cloud media URLs REQUIRE 'Authorization: Bearer <token>'; a bare fetch 401s.
- Two transports: CloudApiTransport (cloud_api + coexistence) and evolution_qr. 13 of 17
  accounts are evolution_qr (wired in phase 2, not this diff).
- Design rule: understanding must be transport/platform agnostic; only fetching differs.
- Feature is default-OFF per account via account_metadata.media_understanding.
- 39 Deno unit tests pass. tsc --noEmit passes. vitest 757 pass. build passes.

## Your task - find BUGS, not style
1. Correctness: any path that drops a message, double-replies, replies twice to one message,
   or hands the agent wrong/empty text? Trace the webhook wiring especially.
2. Security: SSRF, token leakage into logs or URLs, unbounded memory, base64/atob failure modes,
   the streaming size cap, prompt injection via transcribed content.
3. Concurrency/cost: the daily cap under concurrent inbound; can this spend unboundedly?
4. Deno/runtime correctness: does anything here actually work in Deno edge (FormData, Blob,
   ReadableStream, atob/btoa on large inputs, AbortController)?
5. Failure semantics: does every failure really degrade to the placeholder, or can one throw
   and lose the agent reply entirely?

Output numbered findings, most severe first:
**Finding N - [blocker|major|minor] - claim**
- Evidence: file + the specific code
- Failure: concrete scenario
- Fix: 1-2 sentences
End with the single most likely production bug, and what is genuinely well done.

=============== supabase/functions/_shared/inboundMediaUnderstanding.ts ===============
// Inbound media understanding — turns bytes into text the AI agent can reason about.
//
// This module is PURE with respect to the rest of the system: no Supabase client, no
// account, no connection_mode, no webhook. Audio bytes become a transcript the same way
// whether they arrived over WhatsApp Cloud API, Evolution QR, Instagram or Messenger, so
// nothing here may learn about transports. Fetching the bytes is the fetchers' job
// (inboundMediaFetchers.ts); deciding whether to fetch at all is the pipeline's.
//
// If a future change makes this file need to know where a message came from, the
// boundary is wrong -- add a fetcher instead.
//
// Spec: docs/specs/2026-08-25-inbound-media-understanding.md (D9, §6).

export type MediaKind = "audio" | "image" | "document";

export interface MediaUnderstandingResult {
  text: string;
  kind: MediaKind;
  provider: string;
  model: string;
  duration_seconds?: number;
  confidence?: number;
  /** OCR-style fields pulled out of a receipt/invoice image, when the model returns them. */
  extracted_data?: Record<string, unknown>;
}

export type UnderstandingFailure =
  | "unsupported_type"
  | "too_large"
  | "empty_media"
  | "no_provider"
  | "provider_failed"
  | "timeout";

/**
 * Never throws. A failure is an ordinary outcome the caller handles by keeping the
 * placeholder -- a media message must never be dropped because understanding failed.
 */
export type UnderstandingOutcome =
  | { ok: true; result: MediaUnderstandingResult }
  | { ok: false; reason: UnderstandingFailure; detail?: string };

export interface UnderstandingModels {
  /** Multimodal model used for both audio and image. */
  gemini: string;
  /** Audio-only fallback when Gemini is unavailable or fails. */
  whisper: string;
}

export interface UnderstandingLimits {
  maxBytes: number;
  timeoutMs: number;
}

/**
 * Everything beyond the media itself travels in one object. Passing options, limits,
 * models and dependencies as separate positional arguments pushed this past the
 * four-argument ceiling and made every call site read as a row of anonymous values.
 */
export interface UnderstandingConfig {
  languageHint?: string;
  /** Extra instruction appended to the image prompt, e.g. the account's business context. */
  promptContext?: string;
  limits?: UnderstandingLimits;
  models?: UnderstandingModels;
  fetcher?: typeof fetch;
  geminiKey?: string | null;
  openaiKey?: string | null;
}

interface ProviderCall {
  bytes: Uint8Array;
  mimeType: string;
  key: string;
  model: string;
  timeoutMs: number;
  fetcher: typeof fetch;
}

export const DEFAULT_MODELS: UnderstandingModels = {
  // Flash rather than Pro: this runs on every inbound media message, and the task
  // (transcribe / describe) does not need the stronger model.
  gemini: "gemini-2.5-flash",
  whisper: "whisper-1",
};

export const DEFAULT_LIMITS: UnderstandingLimits = {
  maxBytes: 15 * 1024 * 1024,
  timeoutMs: 10_000,
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

// Meta and Evolution both deliver voice notes as ogg/opus; the rest are here because
// customers forward files recorded elsewhere.
const AUDIO_MIME = /^audio\/(ogg|opus|mpeg|mp3|mp4|m4a|wav|x-wav|webm|aac|3gpp)/i;
const IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif|gif)/i;

export function classifyMime(mimeType: string | null | undefined): MediaKind | null {
  if (!mimeType) return null;
  const bare = mimeType.split(";")[0].trim().toLowerCase();
  if (AUDIO_MIME.test(bare)) return "audio";
  if (IMAGE_MIME.test(bare)) return "image";
  return null;
}

/**
 * Gemini rejects a mime type it does not know, and WhatsApp voice notes arrive as
 * "audio/ogg; codecs=opus". Send the bare type.
 */
function bareMime(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

function toBase64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...bytes) blows the call stack on a multi-megabyte
  // voice note, which is exactly the size this function is built for.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function normalizeBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

const AUDIO_PROMPT =
  "Transcribe this voice message verbatim. The speaker may use Gulf Arabic, Egyptian Arabic, " +
  "Modern Standard Arabic, English, or a mix. Preserve the original language -- do NOT translate. " +
  "Return only the transcript text, with no preamble, quotes, or commentary.";

const IMAGE_PROMPT =
  "Describe this image for a customer-service agent, then extract any text you can read.\n" +
  "If it is a payment receipt, bank transfer, KNET slip, or invoice, report the amount, currency, " +
  "date, reference number, and payer or payee when visible.\n" +
  "If it shows damage, a fault, or a maintenance issue, describe what is wrong and where.\n" +
  "Return JSON only, no code fence: " +
  '{"description": string, "text": string, "fields": object}. ' +
  "Use an empty object for fields when nothing structured is present.";

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(error: unknown): boolean {
  return (error as Error)?.name === "AbortError";
}

async function callGemini(call: ProviderCall, prompt: string): Promise<string> {
  const { bytes, mimeType, key, model, timeoutMs, fetcher } = call;
  const response = await withTimeout(
    (signal) =>
      fetcher(`${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: bareMime(mimeType), data: toBase64(bytes) } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 },
        }),
      }),
    timeoutMs,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`gemini ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part?.text ?? "")
    .join("")
    .trim();

  if (!text) throw new Error("gemini returned no text");
  return text;
}

async function callWhisper(call: ProviderCall, languageHint?: string): Promise<string> {
  const { bytes, mimeType, key, model, timeoutMs, fetcher } = call;
  const form = new FormData();
  // The extension matters to Whisper's format detection more than the blob type does.
  const ext = bareMime(mimeType).split("/")[1]?.replace("x-", "") || "ogg";
  // `bytes.slice()` yields a Uint8Array over a plain ArrayBuffer. Passing the original
  // directly fails type-checking because its buffer is ArrayBufferLike, which admits
  // SharedArrayBuffer and so is not a valid BlobPart.
  form.append("file", new Blob([bytes.slice().buffer], { type: bareMime(mimeType) }), `audio.${ext}`);
  form.append("model", model);
  if (languageHint) form.append("language", languageHint);

  const response = await withTimeout(
    (signal) =>
      fetcher(WHISPER_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        signal,
        body: form,
      }),
    timeoutMs,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`whisper ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = String(data?.text ?? "").trim();
  if (!text) throw new Error("whisper returned no text");
  return text;
}

/**
 * Gemini is asked for JSON but is not guaranteed to comply, and a fenced block is the
 * common deviation. A parse failure is not an error -- the prose is still useful to the
 * agent, so it becomes the description.
 */
function parseImagePayload(raw: string): { text: string; extracted?: Record<string, unknown> } {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(unfenced);
    const description = String(parsed?.description ?? "").trim();
    const ocr = String(parsed?.text ?? "").trim();
    const fields = parsed?.fields && typeof parsed.fields === "object" ? parsed.fields : undefined;

    const composed = [description, ocr && `Text in image: ${ocr}`].filter(Boolean).join("\n");
    return {
      text: composed || unfenced,
      extracted: fields && Object.keys(fields).length > 0 ? fields : undefined,
    };
  } catch {
    return { text: unfenced };
  }
}

/** Boundary cases, enumerated before the code: document kind, zero bytes, over the ceiling. */
function rejectUnusableMedia(
  bytes: Uint8Array,
  kind: MediaKind,
  maxBytes: number,
): UnderstandingOutcome | null {
  if (kind === "document") {
    return { ok: false, reason: "unsupported_type", detail: "documents are not supported yet" };
  }
  if (bytes.byteLength === 0) return { ok: false, reason: "empty_media" };
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: "too_large", detail: `${bytes.byteLength} bytes exceeds ${maxBytes}` };
  }
  return null;
}

function imagePrompt(promptContext?: string): string {
  return promptContext ? `${IMAGE_PROMPT}\nBusiness context: ${promptContext}` : IMAGE_PROMPT;
}

function geminiResult(raw: string, kind: MediaKind, model: string): MediaUnderstandingResult {
  if (kind === "audio") return { text: raw, kind, provider: "gemini", model };
  const { text, extracted } = parseImagePayload(raw);
  return {
    text,
    kind,
    provider: "gemini",
    model,
    ...(extracted ? { extracted_data: extracted } : {}),
  };
}

/** `null` means "try the next provider"; a timeout is terminal and returns an outcome. */
type ProviderAttempt = { outcome: UnderstandingOutcome } | { failure: string } | null;

async function attemptGemini(
  call: ProviderCall,
  kind: MediaKind,
  promptContext?: string,
): Promise<ProviderAttempt> {
  try {
    const prompt = kind === "audio" ? AUDIO_PROMPT : imagePrompt(promptContext);
    const raw = await callGemini(call, prompt);
    return { outcome: { ok: true, result: geminiResult(raw, kind, call.model) } };
  } catch (error) {
    if (isAbort(error)) {
      return { outcome: { ok: false, reason: "timeout", detail: `gemini/${call.model}` } };
    }
    return { failure: `gemini: ${(error as Error)?.message ?? "unknown"}` };
  }
}

async function attemptWhisper(call: ProviderCall, languageHint?: string): Promise<ProviderAttempt> {
  try {
    const text = await callWhisper(call, languageHint);
    return {
      outcome: { ok: true, result: { text, kind: "audio", provider: "openai", model: call.model } },
    };
  } catch (error) {
    if (isAbort(error)) {
      return { outcome: { ok: false, reason: "timeout", detail: `whisper/${call.model}` } };
    }
    return { failure: `whisper: ${(error as Error)?.message ?? "unknown"}` };
  }
}

/**
 * Bytes in, text out. Audio uses Gemini with a Whisper fallback; images use Gemini only,
 * since Whisper cannot see. Documents are declined rather than mishandled.
 */
export async function understandInboundMedia(
  input: Uint8Array | ArrayBuffer,
  kind: MediaKind,
  mimeType: string,
  config: UnderstandingConfig = {},
): Promise<UnderstandingOutcome> {
  const bytes = normalizeBytes(input);
  const limits = config.limits ?? DEFAULT_LIMITS;
  const models = config.models ?? DEFAULT_MODELS;
  const fetcher = config.fetcher ?? fetch;

  const rejected = rejectUnusableMedia(bytes, kind, limits.maxBytes);
  if (rejected) return rejected;

  const failures: string[] = [];
  const base = { bytes, mimeType, timeoutMs: limits.timeoutMs, fetcher };

  if (config.geminiKey) {
    const attempt = await attemptGemini(
      { ...base, key: config.geminiKey, model: models.gemini },
      kind,
      config.promptContext,
    );
    if (attempt && "outcome" in attempt) return attempt.outcome;
    if (attempt) failures.push(attempt.failure);
  }

  // Whisper transcribes; it cannot describe an image, so there is no image fallback.
  if (kind === "audio" && config.openaiKey) {
    const attempt = await attemptWhisper(
      { ...base, key: config.openaiKey, model: models.whisper },
      config.languageHint,
    );
    if (attempt && "outcome" in attempt) return attempt.outcome;
    if (attempt) failures.push(attempt.failure);
  }

  if (failures.length === 0) {
    return { ok: false, reason: "no_provider", detail: "no usable API key for this media kind" };
  }
  return { ok: false, reason: "provider_failed", detail: failures.join("; ") };
}

=============== supabase/functions/_shared/inboundMediaFetchers.ts ===============
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

=============== supabase/functions/_shared/inboundMediaPipeline.ts ===============
// Orchestrates inbound media understanding: resolve the per-account setting, enforce the
// daily cap, pick a fetcher, understand the bytes, persist the result.
//
// This is the only piece of the feature that touches the database. The understanding
// itself (inboundMediaUnderstanding.ts) and the byte-fetching (inboundMediaFetchers.ts)
// stay independent of it, so a new platform is a fetcher and a new model is a config
// change -- neither is a change here.
//
// Spec: docs/specs/2026-08-25-inbound-media-understanding.md (D4, D6, D7, D9).

import {
  classifyMime,
  DEFAULT_LIMITS,
  understandInboundMedia,
  type MediaKind,
  type UnderstandingLimits,
} from "./inboundMediaUnderstanding.ts";
import {
  CloudGraphFetcher,
  DirectUrlFetcher,
  MediaFetchError,
  selectFetcher,
  type InboundMediaFetcher,
  type MediaRef,
} from "./inboundMediaFetchers.ts";

export const MEDIA_UNDERSTANDING_MODES = ["off", "audio", "audio+image"] as const;
export type MediaUnderstandingMode = (typeof MEDIA_UNDERSTANDING_MODES)[number];

/**
 * Default "off", matching resolveCommentAutomationHandler: this spends money per inbound
 * message and reaches customers, so it is opted into deliberately rather than inherited.
 */
export function resolveMediaUnderstandingMode(metadata: unknown): MediaUnderstandingMode {
  if (!metadata || typeof metadata !== "object") return "off";
  const value = (metadata as Record<string, unknown>).media_understanding;
  return (MEDIA_UNDERSTANDING_MODES as readonly unknown[]).includes(value)
    ? value as MediaUnderstandingMode
    : "off";
}

export function modeAllows(mode: MediaUnderstandingMode, kind: MediaKind): boolean {
  if (mode === "off") return false;
  if (kind === "audio") return true;
  if (kind === "image") return mode === "audio+image";
  return false;
}

export const DEFAULT_DAILY_CAP = 100;

export interface PipelineAccount {
  id: string;
  user_id: string;
  platform_user_id?: string | null;
  connection_mode?: string | null;
  access_token?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface PipelineInput {
  account: PipelineAccount;
  /** Row id in whatsapp_messages, so the result can be written back. */
  messageRowId: string | null;
  mediaId?: string | null;
  mediaUrl?: string | null;
  rawBase64?: string | null;
  mimeType?: string | null;
  /** Any caption the customer typed alongside the media. */
  caption?: string | null;
  platform?: "whatsapp" | "instagram" | "facebook";
}

export type PipelineOutcome =
  | { understood: true; text: string; agentText: string }
  | { understood: false; reason: string };

export interface PipelineDeps {
  fetchers?: InboundMediaFetcher[];
  fetcher?: typeof fetch;
  limits?: UnderstandingLimits;
  dailyCap?: number;
  geminiKey?: string | null;
  openaiKey?: string | null;
  promptContext?: string | null;
}

/**
 * Counts today's understandings for this account. Cheap because the supporting index is
 * partial on media_understanding IS NOT NULL -- almost every row is text and is excluded.
 */
async function dailyCountReached(
  // deno-lint-ignore no-explicit-any
  admin: any,
  accountId: string,
  cap: number,
): Promise<boolean> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await admin
    .from("whatsapp_messages")
    .select("id", { count: "exact", head: true })
    .eq("social_account_id", accountId)
    .not("media_understanding", "is", null)
    .gte("timestamp", since.toISOString());
  // Fail open on a counting error: refusing to understand because a COUNT failed would
  // degrade the customer experience for an internal fault. The per-message size and
  // timeout limits still bound the damage.
  if (error) return false;
  return (count ?? 0) >= cap;
}

/**
 * What the agent actually reads. The label matters: without it the model cannot tell a
 * transcript from something the customer typed, and a mis-transcription then reads as a
 * confident statement of fact.
 */
export function composeAgentText(kind: MediaKind, understood: string, caption?: string | null): string {
  const label = kind === "audio" ? "Voice note transcription" : "Image description & OCR";
  const head = `[${label}: "${understood}"]`;
  const tail = caption?.trim();
  return tail ? `${head}\n${tail}` : head;
}

/**
 * Never throws. Every failure path returns `understood: false` and the caller keeps the
 * placeholder, so a media message is never dropped because understanding failed (D7).
 */
export async function runInboundMediaUnderstanding(
  // deno-lint-ignore no-explicit-any
  admin: any,
  input: PipelineInput,
  deps: PipelineDeps = {},
): Promise<PipelineOutcome> {
  try {
    const mode = resolveMediaUnderstandingMode(input.account.account_metadata);
    if (mode === "off") return { understood: false, reason: "disabled" };

    const kind = classifyMime(input.mimeType);
    if (!kind) return { understood: false, reason: "unsupported_type" };
    if (!modeAllows(mode, kind)) return { understood: false, reason: "kind_not_enabled" };

    const cap = deps.dailyCap ?? DEFAULT_DAILY_CAP;
    if (await dailyCountReached(admin, input.account.id, cap)) {
      return { understood: false, reason: "daily_cap_reached" };
    }

    const limits = deps.limits ?? DEFAULT_LIMITS;
    const ref: MediaRef = {
      platform: input.platform ?? "whatsapp",
      connectionMode: input.account.connection_mode ?? null,
      mediaId: input.mediaId ?? null,
      mediaUrl: input.mediaUrl ?? null,
      rawBase64: input.rawBase64 ?? null,
      accessToken: input.account.access_token ?? null,
      mimeType: input.mimeType ?? null,
    };

    const fetchers = deps.fetchers ?? [new CloudGraphFetcher(), new DirectUrlFetcher()];
    const chosen = selectFetcher(ref, fetchers);
    if (!chosen) return { understood: false, reason: "no_fetcher" };

    let bytes: Uint8Array;
    let resolvedMime: string;
    try {
      const fetched = await chosen.fetchMediaBytes(
        ref,
        { maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs },
        deps.fetcher,
      );
      bytes = fetched.bytes;
      resolvedMime = fetched.mimeType;
    } catch (error) {
      const reason = error instanceof MediaFetchError ? error.reason : "download_failed";
      console.error(`[media-understanding] fetch failed (${chosen.name}/${reason}):`, (error as Error)?.message);
      return { understood: false, reason };
    }

    const outcome = await understandInboundMedia(
      bytes,
      kind,
      resolvedMime || input.mimeType || "application/octet-stream",
      {
        promptContext: deps.promptContext ?? undefined,
        limits,
        fetcher: deps.fetcher,
        geminiKey: deps.geminiKey ?? Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? null,
        openaiKey: deps.openaiKey ?? Deno.env.get("OPENAI_API_KEY") ?? null,
      },
    );

    if (!outcome.ok) {
      console.error(`[media-understanding] ${outcome.reason}: ${outcome.detail ?? ""}`);
      return { understood: false, reason: outcome.reason };
    }

    const { result } = outcome;
    const agentText = composeAgentText(kind, result.text, input.caption);

    if (input.messageRowId) {
      // A persistence failure must not discard a transcript we already paid for, so the
      // agent still gets the text -- only the audit record is lost, and it is logged.
      const { error } = await admin
        .from("whatsapp_messages")
        .update({
          media_understanding: result.text,
          media_understanding_meta: {
            provider: result.provider,
            model: result.model,
            kind: result.kind,
            duration_seconds: result.duration_seconds ?? null,
            confidence: result.confidence ?? null,
            extracted_data: result.extracted_data ?? null,
            bytes: bytes.byteLength,
            attempted_at: new Date().toISOString(),
          },
        })
        .eq("id", input.messageRowId);
      if (error) {
        console.error("[media-understanding] persist failed:", error.message);
      }
    }

    return { understood: true, text: result.text, agentText };
  } catch (error) {
    console.error("[media-understanding] unexpected:", (error as Error)?.message ?? error);
    return { understood: false, reason: "unexpected" };
  }
}

=============== whatsapp-webhook wiring (the changed block) ===============
          message: {
            id: messageId,
            text: messageText,
            type: msgType,
            attachments: mediaUrl ? [{ url: mediaUrl, type: mediaType, metadata: mediaMetadata }] : [],
          },
          timestamp: msgTimestamp,
        }),
      ));
    }

    const ruleReplied = automationHandler === "internal"
      ? await processAutoReplies(adminClient, account, conversationId, phoneNumberId, from, messageText, accessToken)
      : false;

    // Deterministic keyword/away rules outrank the AI; only unanswered
    // messages reach the agent. Imported/history/echo messages never get
    // here (see handleHistorySync guard), so the AI cannot reply to them.
    if (automationHandler === "internal" && !ruleReplied) {
      // Media the agent could read: understand it FIRST, then hand the agent the
      // transcript instead of "[Audio message]". The understanding involves a download
      // and a model call, so it runs in the background to keep Meta's webhook fast --
      // and the agent trigger moves inside that continuation, because firing the agent
      // before the transcript exists is the bug this feature fixes.
      const understandableKind = mediaType === "audio" || mediaType === "image";
      const mediaMime = (mediaMetadata as { mime_type?: string } | null)?.mime_type ?? null;

      if (understandableKind && mediaMime) {
        const mediaRowId = insertedRows[0]?.id ?? null;
        await runInBackground("whatsapp inbound media understanding", async () => {
          const outcome = await runInboundMediaUnderstanding(adminClient, {
            account: {
              id: account.id,
              user_id: account.user_id,
              platform_user_id: account.platform_user_id,
              connection_mode: account.connection_mode,
              access_token: accessToken,
              account_metadata: account.account_metadata,
            },
            messageRowId: mediaRowId,
            mediaId: (mediaMetadata as { media_id?: string } | null)?.media_id ?? null,
            mediaUrl,
            mimeType: mediaMime,
            // WhatsApp puts any typed caption in messageText; the placeholder is not one.
            caption: messageText.startsWith("[") ? null : messageText,
            platform: "whatsapp",
          });

          // Understood or not, the agent still replies -- it just falls back to the
          // placeholder, which is exactly today's behaviour.
          const agentInput = outcome.understood ? outcome.agentText : messageText;
          await triggerAiAgentReply(account, conversationId, phoneNumberId, from, agentInput);
        });
      } else {
        triggerAiAgentReply(account, conversationId, phoneNumberId, from, messageText)
          .catch((e) => console.error("[whatsapp-webhook] AI agent dispatch failed:", e?.message || e));
      }
    }
  }

  // Process status updates — write back to whatsapp_messages and surface failures
  const statuses = value?.statuses || [];
  for (const status of statuses) {
    const wamid: string | undefined = status.id;
    const newStatus: string = status.status; // sent | delivered | read | failed
    const errObj = Array.isArray(status.errors) && status.errors.length ? status.errors[0] : null;

=============== migration ===============
-- Inbound media understanding: the text the AI agent reads in place of a
-- "[Audio message]" / "[Image]" placeholder.
--
-- Deliberately additive and separate from `message_text`. Everything that
-- reads `message_text` today -- the inbox, the n8n payload, the auto-reply
-- rules -- keeps seeing the placeholder, so enabling this cannot regress them.
-- Spec: docs/specs/2026-08-25-inbound-media-understanding.md (D5).

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_understanding      TEXT,
  ADD COLUMN IF NOT EXISTS media_understanding_meta JSONB;

COMMENT ON COLUMN public.whatsapp_messages.media_understanding IS
  'Transcript (audio) or description+OCR (image) handed to the AI agent in place of the placeholder. NULL when the feature is off or understanding failed.';

COMMENT ON COLUMN public.whatsapp_messages.media_understanding_meta IS
  'provider, model, kind, duration_seconds, confidence, extracted_data, attempted_at. Used for cost attribution and for judging transcription quality after the fact.';

-- Partial: the overwhelming majority of rows are text and will never carry a
-- value here, so indexing only the populated rows keeps this small. Supports
-- the daily per-account cap count and the admin usage view.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_media_understanding
  ON public.whatsapp_messages (social_account_id, timestamp DESC)
  WHERE media_understanding IS NOT NULL;
=============== END. Findings only. ===============
