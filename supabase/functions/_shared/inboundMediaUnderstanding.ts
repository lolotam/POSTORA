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
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(abortError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isAbort(error: unknown): boolean {
  return (error as Error)?.name === "AbortError";
}

async function callGemini(call: ProviderCall, prompt: string): Promise<string> {
  const { bytes, mimeType, key, model, timeoutMs, fetcher } = call;
  const response = await withTimeout(
    (signal) =>
      fetcher(`${GEMINI_BASE}/${model}:generateContent`, {
        method: "POST",
        // Header, never ?key= -- query strings are retained in proxy logs, exception
        // tooling and provider access records, and this key bills real money.
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
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

  const data = await withTimeout(async () => {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`gemini ${response.status}: ${body.slice(0, 200)}`);
    }
    return await response.json();
  }, timeoutMs);

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

  const data = await withTimeout(async () => {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`whisper ${response.status}: ${body.slice(0, 200)}`);
    }
    return await response.json();
  }, timeoutMs);

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
    const prompt = kind === "audio" ? AUDIO_PROMPT : imagePrompt(promptContext);
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

  let everyFailureWasTimeout = true;

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
