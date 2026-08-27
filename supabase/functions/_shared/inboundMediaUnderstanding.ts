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
  /** Language-detection probability, where the provider reports one. */
  confidence?: number;
  /** ISO-639-3 code the provider detected, e.g. "ara". */
  language_code?: string;
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

/** One rung of the admin-configured ladder. Resolved by the caller, never looked up here. */
export interface ProviderTier {
  provider: string;
  model: string;
  apiKey: string;
}

export interface UnderstandingModels {
  /** Multimodal model used for both audio and image. */
  gemini: string;
  /** Audio-only fallback when Gemini is unavailable or fails. */
  whisper: string;
}

export interface UnderstandingLimits {
  maxBytes: number;
  timeoutMs: number;
  /**
   * Documents get their own model deadline. 10s is tuned for a twenty-second voice note,
   * but a scanned PDF is a page-by-page read and routinely runs past it -- which surfaces
   * as a timeout rather than as the answer the model was seconds from returning.
   *
   * Bounded by the 60s edge-worker ceiling, not by generosity: the ladder budget is twice
   * this value, and the worker is killed without a log line if the whole request exceeds
   * 60s. 20s leaves room for the download plus two Gemini rungs.
   */
  documentTimeoutMs?: number;
}

/** The deadline for one kind. Only documents differ, and only because they are slower. */
export function timeoutFor(kind: MediaKind, limits: UnderstandingLimits): number {
  return kind === "document" ? limits.documentTimeoutMs ?? limits.timeoutMs : limits.timeoutMs;
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
  /**
   * Ordered provider ladder from the admin's Speech-to-Text settings. When present it
   * replaces the built-in gemini -> whisper pair entirely, so what an operator picks in
   * /admin/settings is what actually runs.
   */
  tiers?: ProviderTier[];
}

/**
 * Settings store a bare model_id today, but ai_agent_configs.model holds namespaced values
 * like "google/gemini-2.5-flash", so an operator can plausibly paste one into a tier. Every
 * provider here wants the bare name, and a namespaced id fails the whole ladder silently.
 */
export function bareModelId(provider: string, modelId: string): string {
  const prefix = `${provider.toLowerCase()}/`;
  const lower = modelId.toLowerCase();
  if (lower.startsWith(prefix)) return modelId.slice(prefix.length);
  // "google/" and "gemini/" are used interchangeably for the same provider.
  for (const alias of ["google/", "gemini/"]) {
    if ((provider === "gemini" || provider === "google") && lower.startsWith(alias)) {
      return modelId.slice(alias.length);
    }
  }
  return modelId;
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
  // 15MB base64-expands to roughly 20MB, which is Gemini's inline-request ceiling. The cap
  // is that ceiling rather than a policy choice, so it holds for documents too.
  maxBytes: 15 * 1024 * 1024,
  timeoutMs: 10_000,
  documentTimeoutMs: 20_000,
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
/**
 * ElevenLabs publishes regional bases for data residency: api.eu.residency,
 * api.in.residency, api.sg.residency, api.us. Configurable because where a customer's
 * voice note is processed can be a contractual question, not a performance one.
 *
 * Note the default is the global endpoint AND enable_logging defaults to true on
 * ElevenLabs' side, so audio and transcripts are retained by them unless the account is
 * enterprise. Documented in the spec rather than silently assumed.
 */
const ELEVENLABS_DEFAULT_BASE = "https://api.elevenlabs.io";

/** The only hosts ElevenLabs publishes. An env var must not be able to name another. */
const ELEVENLABS_HOSTS = new Set([
  "api.elevenlabs.io",
  "api.us.elevenlabs.io",
  "api.eu.residency.elevenlabs.io",
  "api.in.residency.elevenlabs.io",
  "api.sg.residency.elevenlabs.io",
]);

/**
 * A typo or a tampered deployment variable would otherwise send the API key AND the
 * customer's audio to whatever host the value named. The override exists for data
 * residency, so it only ever needs to reach an ElevenLabs origin.
 */
function elevenLabsEndpoint(): string {
  const configured = Deno.env.get("ELEVENLABS_API_BASE");
  if (!configured) return `${ELEVENLABS_DEFAULT_BASE}/v1/speech-to-text`;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || !ELEVENLABS_HOSTS.has(url.hostname) || url.username || url.password) {
      throw new Error("not an ElevenLabs origin");
    }
    return `https://${url.hostname}/v1/speech-to-text`;
  } catch {
    console.error("[media-understanding] ELEVENLABS_API_BASE is not a valid ElevenLabs origin; using the default");
    return `${ELEVENLABS_DEFAULT_BASE}/v1/speech-to-text`;
  }
}

// Meta and Evolution both deliver voice notes as ogg/opus; the rest are here because
// customers forward files recorded elsewhere.
const AUDIO_MIME = /^audio\/(ogg|opus|mpeg|mp3|mp4|m4a|wav|x-wav|webm|aac|3gpp)/i;
const IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif|gif)/i;
/**
 * PDF only. Gemini reads one natively -- it rasterises the pages itself, so a scanned
 * contract and a text-layer invoice both work. Word and PowerPoint are deliberately absent:
 * they are ZIP containers Gemini does not open, and admitting them here would trade a clear
 * "unsupported" for a confidently wrong answer about a document nothing actually read.
 */
const DOCUMENT_MIME = /^application\/pdf/i;

const PDF_MAGIC = new TextEncoder().encode("%PDF-");

/**
 * Whether these bytes really are a PDF, decided by the bytes and nothing else.
 *
 * Every mime in this system is a *claim*: the webhook's metadata, the Graph lookup, the CDN
 * header. On WhatsApp Cloud the claim even round-trips -- the fetcher prefers the mime the
 * webhook declared -- so checking the resolved mime against the declared kind compares a
 * declaration with itself and confirms nothing. Magic bytes are the one piece of evidence
 * no sender or header controls.
 *
 * Scanned over the first kilobyte rather than at offset zero: readers tolerate junk before
 * the header, and real-world PDFs sometimes carry it.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 1024);
  for (let start = 0; start + PDF_MAGIC.length <= window.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < PDF_MAGIC.length; offset += 1) {
      if (window[start + offset] !== PDF_MAGIC[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

export function classifyMime(mimeType: string | null | undefined): MediaKind | null {
  if (!mimeType) return null;
  const bare = mimeType.split(";")[0].trim().toLowerCase();
  if (AUDIO_MIME.test(bare)) return "audio";
  if (IMAGE_MIME.test(bare)) return "image";
  if (DOCUMENT_MIME.test(bare)) return "document";
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

const DOCUMENT_PROMPT =
  "Read this document for a customer-service agent. Summarise what it is and what it says, " +
  "then extract the text that matters.\n" +
  "If it is an invoice, quotation, receipt, bank transfer, or contract, report the amount, " +
  "currency, dates, reference or invoice number, and the parties when visible.\n" +
  "Preserve the original language -- do NOT translate.\n" +
  "Return JSON only, no code fence: " +
  '{"description": string, "text": string, "fields": object}. ' +
  "Use an empty object for fields when nothing structured is present.";

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Races the work against a deadline. The signal is passed through for fetch, but body
 * reads do not honour it, so the race is what actually bounds them -- a server that
 * returns headers and then stalls the body would otherwise hang forever, and this runs
 * inside the continuation that owes the customer a reply.
 */
/**
 * One deadline for an entire provider attempt: the request AND the body parse.
 *
 * Two separate timers (one around fetch, one around .json()) let a slow provider consume
 * twice the configured budget, and left the response body undrained when the deadline
 * won -- which holds the connection open inside a continuation that is already late.
 */
class ProviderDeadline {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly expiry: Promise<never>;

  constructor(timeoutMs: number) {
    this.expiry = new Promise<never>((_resolve, reject) => {
      this.timer = setTimeout(() => {
        this.controller.abort();
        reject(abortError());
      }, timeoutMs);
    });
    // Nothing else observes this promise until race() does, and an unobserved rejection
    // is a crash in some runtimes.
    this.expiry.catch(() => {});
  }

  race<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.expiry]);
  }

  release(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}

/** Drains an unread body so the deadline does not leave the connection hanging. */
async function discardBody(response: Response | null): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // Already consumed or already errored; nothing to release.
  }
}

function isAbort(error: unknown): boolean {
  return (error as Error)?.name === "AbortError";
}

async function callGemini(call: ProviderCall, prompt: string): Promise<string> {
  const { bytes, mimeType, key, model, timeoutMs, fetcher } = call;
  const deadline = new ProviderDeadline(timeoutMs);
  let response: Response | null = null;
  try {
    response = await deadline.race(
      fetcher(`${GEMINI_BASE}/${model}:generateContent`, {
        method: "POST",
        // Header, never ?key= -- query strings are retained in proxy logs, exception
        // tooling and provider access records, and this key bills real money.
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: deadline.controller.signal,
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
    );

    const settled = response;
    const data = await deadline.race((async () => {
      if (!settled.ok) {
        // Status only. A provider body can echo request content or diagnostics, and this
        // string ends up in durable application logs.
        await settled.body?.cancel().catch(() => {});
        throw new Error(`gemini ${settled.status}`);
      }
      return await settled.json();
    })());

    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part?.text ?? "")
      .join("")
      .trim();

    if (!text) throw new Error("gemini returned no text");
    return text;
  } catch (error) {
    await discardBody(response);
    throw error;
  } finally {
    deadline.release();
  }
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

  const deadline = new ProviderDeadline(timeoutMs);
  let response: Response | null = null;
  try {
    response = await deadline.race(
      fetcher(WHISPER_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        signal: deadline.controller.signal,
        body: form,
      }),
    );

    const settled = response;
    const data = await deadline.race((async () => {
      if (!settled.ok) {
        // Status only. A provider body can echo request content or diagnostics, and this
        // string ends up in durable application logs.
        await settled.body?.cancel().catch(() => {});
        throw new Error(`whisper ${settled.status}`);
      }
      return await settled.json();
    })());

    const text = String(data?.text ?? "").trim();
    if (!text) throw new Error("whisper returned no text");
    return text;
  } catch (error) {
    await discardBody(response);
    throw error;
  } finally {
    deadline.release();
  }
}

interface ElevenLabsTranscript {
  text: string;
  languageCode?: string;
  languageProbability?: number;
  durationSeconds?: number;
}

/**
 * ElevenLabs Scribe. Audio only -- it is a speech model and cannot look at an image.
 *
 * Parameters chosen against the published contract rather than defaults:
 *  - tag_audio_events=false: Scribe otherwise injects "(laughter)", "(footsteps)" into the
 *    text. That is noise to an agent that is about to answer a customer, and worse, it is
 *    indistinguishable from something the customer actually said.
 *  - timestamps_granularity=none: we use only the text, so per-word timings are payload we
 *    parse and discard.
 *  - diarize left off: a WhatsApp voice note is one speaker, and diarisation is billed.
 *  - entity_detection / redaction left off: both carry a 30% surcharge.
 *  - language_code only when the caller knows it; Scribe's auto-detection is strong
 *    (0.996 on a real Arabic note) and a wrong hint is worse than none.
 */
async function callElevenLabs(
  call: ProviderCall,
  languageHint?: string,
): Promise<ElevenLabsTranscript> {
  const { bytes, mimeType, key, model, timeoutMs, fetcher } = call;
  const form = new FormData();
  const ext = bareMime(mimeType).split("/")[1]?.replace("x-", "") || "ogg";
  form.append("file", new Blob([bytes.slice().buffer], { type: bareMime(mimeType) }), `audio.${ext}`);
  form.append("model_id", model);
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "none");
  if (languageHint) form.append("language_code", languageHint);

  const deadline = new ProviderDeadline(timeoutMs);
  let response: Response | null = null;
  try {
    response = await deadline.race(
      fetcher(elevenLabsEndpoint(), {
        method: "POST",
        headers: { "xi-api-key": key },
        signal: deadline.controller.signal,
        body: form,
      }),
    );

    const settled = response;
    const data = await deadline.race((async () => {
      if (!settled.ok) {
        // Status only. A provider body can echo request content or diagnostics, and this
        // string ends up in durable application logs.
        await settled.body?.cancel().catch(() => {});
        throw new Error(`elevenlabs ${settled.status}`);
      }
      return await settled.json();
    })());

    // Multi-channel returns `transcripts[]` instead of a bare `text`. We never enable it,
    // but reading the first channel costs nothing and avoids an empty-text failure if a
    // future caller does.
    const payload = Array.isArray(data?.transcripts) ? data.transcripts[0] : data;
    const text = String(payload?.text ?? "").trim();
    if (!text) throw new Error("elevenlabs returned no text");

    return {
      text,
      languageCode: payload?.language_code ?? undefined,
      languageProbability: typeof payload?.language_probability === "number"
        ? payload.language_probability
        : undefined,
      durationSeconds: typeof data?.audio_duration_secs === "number"
        ? data.audio_duration_secs
        : undefined,
    };
  } catch (error) {
    await discardBody(response);
    throw error;
  } finally {
    deadline.release();
  }
}

/**
 * Gemini is asked for JSON but is not guaranteed to comply, and a fenced block is the
 * common deviation. A parse failure is not an error -- the prose is still useful to the
 * agent, so it becomes the description.
 */
function parseVisualPayload(
  raw: string,
  kind: MediaKind,
): { text: string; extracted?: Record<string, unknown> } {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(unfenced);
    const description = String(parsed?.description ?? "").trim();
    const ocr = String(parsed?.text ?? "").trim();
    const fields = parsed?.fields && typeof parsed.fields === "object" ? parsed.fields : undefined;

    const label = kind === "document" ? "Document text" : "Text in image";
    const composed = [description, ocr && `${label}: ${ocr}`].filter(Boolean).join("\n");
    return {
      text: composed || unfenced,
      extracted: fields && Object.keys(fields).length > 0 ? fields : undefined,
    };
  } catch {
    return { text: unfenced };
  }
}

/** Boundary cases, enumerated before the code: zero bytes, over the ceiling. */
function rejectUnusableMedia(
  bytes: Uint8Array,
  maxBytes: number,
): UnderstandingOutcome | null {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty_media" };
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: "too_large", detail: `${bytes.byteLength} bytes exceeds ${maxBytes}` };
  }
  return null;
}

function geminiPrompt(kind: MediaKind, promptContext?: string): string {
  if (kind === "audio") return AUDIO_PROMPT;
  const base = kind === "document" ? DOCUMENT_PROMPT : IMAGE_PROMPT;
  return promptContext ? `${base}\nBusiness context: ${promptContext}` : base;
}

function geminiResult(raw: string, kind: MediaKind, model: string): MediaUnderstandingResult {
  if (kind === "audio") return { text: raw, kind, provider: "gemini", model };
  const { text, extracted } = parseVisualPayload(raw, kind);
  return {
    text,
    kind,
    provider: "gemini",
    model,
    ...(extracted ? { extracted_data: extracted } : {}),
  };
}

/**
 * A provider attempt either succeeded or did not. A timeout is NOT terminal: it is just
 * another failure, and the whole point of configuring a fallback is that it gets tried.
 * Returning the timeout as a final outcome silently disabled Whisper for exactly the slow
 * voice notes it exists to catch.
 */
type ProviderAttempt =
  | { ok: true; result: MediaUnderstandingResult }
  | { ok: false; failure: string; timedOut: boolean };

async function attemptGemini(
  call: ProviderCall,
  kind: MediaKind,
  promptContext?: string,
): Promise<ProviderAttempt> {
  try {
    const prompt = geminiPrompt(kind, promptContext);
    const raw = await callGemini(call, prompt);
    return { ok: true, result: geminiResult(raw, kind, call.model) };
  } catch (error) {
    const timedOut = isAbort(error);
    const why = timedOut ? `timed out after ${call.timeoutMs}ms` : (error as Error)?.message ?? "unknown";
    return { ok: false, failure: `gemini: ${why}`, timedOut };
  }
}

async function attemptWhisper(call: ProviderCall, languageHint?: string): Promise<ProviderAttempt> {
  try {
    const text = await callWhisper(call, languageHint);
    return { ok: true, result: { text, kind: "audio", provider: "openai", model: call.model } };
  } catch (error) {
    const timedOut = isAbort(error);
    const why = timedOut ? `timed out after ${call.timeoutMs}ms` : (error as Error)?.message ?? "unknown";
    return { ok: false, failure: `whisper: ${why}`, timedOut };
  }
}

/** Which providers can do which kind. A speech model cannot look at a receipt. */
function tierSupports(provider: string, kind: MediaKind): boolean {
  const isGemini = provider === "gemini" || provider === "google";
  // Images and documents are both "look at these bytes" tasks, and Gemini is the only
  // configured provider that can. ElevenLabs and Whisper are transcribers.
  if (kind === "image" || kind === "document") return isGemini;
  return provider === "elevenlabs" || isGemini || provider === "openai";
}

async function attemptTier(
  tier: ProviderTier,
  call: Omit<ProviderCall, "key" | "model">,
  kind: MediaKind,
  config: UnderstandingConfig,
): Promise<ProviderAttempt> {
  const providerCall: ProviderCall = {
    ...call,
    key: tier.apiKey,
    model: bareModelId(tier.provider, tier.model),
  };
  try {
    if (tier.provider === "elevenlabs") {
      const t = await callElevenLabs(providerCall, config.languageHint);
      return {
        ok: true,
        result: {
          text: t.text,
          kind,
          provider: "elevenlabs",
          model: tier.model,
          ...(t.durationSeconds !== undefined ? { duration_seconds: t.durationSeconds } : {}),
          ...(t.languageProbability !== undefined ? { confidence: t.languageProbability } : {}),
          ...(t.languageCode ? { language_code: t.languageCode } : {}),
        },
      };
    }
    if (tier.provider === "openai") {
      const text = await callWhisper(providerCall, config.languageHint);
      return { ok: true, result: { text, kind, provider: "openai", model: tier.model } };
    }
    // gemini / google
    const prompt = geminiPrompt(kind, config.promptContext);
    const raw = await callGemini(providerCall, prompt);
    return { ok: true, result: geminiResult(raw, kind, tier.model) };
  } catch (error) {
    const timedOut = isAbort(error);
    const why = timedOut ? `timed out after ${call.timeoutMs}ms` : (error as Error)?.message ?? "unknown";
    return { ok: false, failure: `${tier.provider}/${tier.model}: ${why}`, timedOut };
  }
}

/**
 * Bytes in, text out. Audio uses Gemini with a Whisper fallback; images and PDFs use
 * Gemini only, since Whisper cannot see.
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

  const rejected = rejectUnusableMedia(bytes, limits.maxBytes);
  if (rejected) return rejected;

  const failures: string[] = [];
  const kindTimeoutMs = timeoutFor(kind, limits);
  const base = { bytes, mimeType, timeoutMs: kindTimeoutMs, fetcher };

  let everyFailureWasTimeout = true;

  // Admin-configured ladder wins. Tiers that cannot handle this kind, or have no key, are
  // skipped rather than counted as failures -- an operator picking a speech model as the
  // primary should not stop images from reaching Gemini further down the ladder.
  const tiers = (config.tiers ?? []).filter((t) => t.apiKey && tierSupports(t.provider, kind));
  if (tiers.length > 0) {
    // ONE budget across the whole ladder, not timeoutMs per rung. Three tiers each given a
    // fresh 10s meant a message could sit ~30s in providers on top of the download before
    // degrading -- and the customer is waiting for a reply the entire time.
    const ladderDeadline = Date.now() + kindTimeoutMs * 2;
    for (const tier of tiers) {
      const remaining = ladderDeadline - Date.now();
      // Only skip when there is genuinely nothing left. An absolute floor here would be a
      // magic number that silently swallows the first tier whenever the configured
      // timeout is small.
      if (remaining <= 0) {
        failures.push(`${tier.provider}/${tier.model}: skipped, ladder budget exhausted`);
        break;
      }
      const base = {
        bytes,
        mimeType,
        // Never more than one tier's worth, never more than what is left.
        timeoutMs: Math.min(kindTimeoutMs, remaining),
        fetcher,
      };
      const attempt = await attemptTier(tier, base, kind, config);
      if (attempt.ok) return { ok: true, result: attempt.result };
      failures.push(attempt.failure);
      everyFailureWasTimeout &&= attempt.timedOut;
    }
    return {
      ok: false,
      reason: everyFailureWasTimeout ? "timeout" : "provider_failed",
      detail: failures.join("; "),
    };
  }

  if (config.geminiKey) {
    const attempt = await attemptGemini(
      { ...base, key: config.geminiKey, model: models.gemini },
      kind,
      config.promptContext,
    );
    if (attempt.ok) return { ok: true, result: attempt.result };
    failures.push(attempt.failure);
    everyFailureWasTimeout &&= attempt.timedOut;
  }

  // Whisper transcribes; it cannot describe an image, so there is no image fallback.
  if (kind === "audio" && config.openaiKey) {
    const attempt = await attemptWhisper(
      { ...base, key: config.openaiKey, model: models.whisper },
      config.languageHint,
    );
    if (attempt.ok) return { ok: true, result: attempt.result };
    failures.push(attempt.failure);
    everyFailureWasTimeout &&= attempt.timedOut;
  }

  if (failures.length === 0) {
    return { ok: false, reason: "no_provider", detail: "no usable API key for this media kind" };
  }
  // "timeout" is reported only when nothing but timeouts happened, so the reason stays
  // diagnostic without ever short-circuiting a fallback.
  return {
    ok: false,
    reason: everyFailureWasTimeout ? "timeout" : "provider_failed",
    detail: failures.join("; "),
  };
}
