/**
 * AtlasCloud image models (upscaler, background remover). A job is submitted once and then
 * checked, either in a short bounded loop inside the request that submitted it or by a later
 * request that holds the prediction id:
 *   POST  https://api.atlascloud.ai/api/v1/model/generateImage   -> data.id
 *   GET   https://api.atlascloud.ai/api/v1/model/prediction/{id} -> data.status, data.outputs[0]
 *
 * Failures are classified here, once, so the HTTP adapters answer consistently and never
 * relay provider text to the caller (`detail` is for the log only).
 */


const ATLAS_MODEL_API = "https://api.atlascloud.ai/api/v1/model";
/** Longest one provider request may take; callers budget their deadlines around it. */
export const ATLAS_REQUEST_TIMEOUT_MS = 10_000;

export type AtlasFailureKind =
  | "provider_rejected" // our key or balance was refused: an operator problem, not the caller's
  | "rate_limited"
  | "timeout"
  | "unreachable"
  | "failed"
  | "bad_response";

export interface AtlasFailure {
  ok: false;
  kind: AtlasFailureKind;
  /** What we answer our own caller. */
  httpStatus: number;
  detail: string;
}

export type AtlasSubmitResult = { ok: true; predictionId: string } | AtlasFailure;

export type AtlasCheckResult =
  | { ok: true; state: "pending" }
  | { ok: true; state: "done"; outputUrl: string }
  | AtlasFailure;

interface CallOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

const STATUS_FOR_KIND: Record<AtlasFailureKind, number> = {
  provider_rejected: 503,
  rate_limited: 429,
  timeout: 504,
  unreachable: 502,
  failed: 502,
  bad_response: 502,
};

function failure(kind: AtlasFailureKind, detail: string): AtlasFailure {
  return { ok: false, kind, httpStatus: STATUS_FOR_KIND[kind], detail };
}

const BALANCE_WORDS = /insufficient[_ ]balance|balance|credit/i;
const FAILED_STATES = new Set(["failed", "error", "canceled", "cancelled"]);
const DONE_STATES = new Set(["completed", "succeeded"]);

/** The abort `fetchBody` raises, or a platform timeout/abort error. */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError" || /timed out|aborted/i.test(error.message);
}

function networkFailure(step: string, error: unknown): AtlasFailure {
  const detail = `${step}: ${error instanceof Error ? error.message : String(error)}`;
  return failure(isTimeout(error) ? "timeout" : "unreachable", detail);
}

/**
 * An answer that means "stop now", as opposed to a transient server or network problem. Every
 * status >= 500 is transient here, whatever its body says (a gateway page about its "load
 * balancer" is not a balance problem); the balance words only count in a 4xx answer.
 */
function terminalHttpFailure(status: number, text: string): AtlasFailure | null {
  if (status < 400 || status >= 500) return null;
  const detail = `HTTP ${status}: ${text.slice(0, 300)}`;
  if (status === 401 || status === 402 || status === 403 || BALANCE_WORDS.test(text)) return failure("provider_rejected", detail);
  if (status === 429) return failure("rate_limited", detail);
  return failure("failed", detail);
}

/** https with a real host, or null. The URL is fetched by this runtime, so it must be well formed. */
function httpsOutputUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

interface BodyAnswer {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * One request whose timeout covers reading the body as well as the headers: a provider that
 * answers its headers and then stalls must not carry the request past the caller's budget.
 */
async function fetchBody(url: string, init: RequestInit, timeoutMs: number, fetcher: typeof fetch): Promise<BodyAnswer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Request timed out"));
    }, timeoutMs);
  });
  const answer = (async () => {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    return { ok: response.ok, status: response.status, text: await response.text() };
  })();
  try {
    return await Promise.race([answer, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function submitAtlasJob(opts: CallOptions & { body: Record<string, unknown> }): Promise<AtlasSubmitResult> {
  let submit: BodyAnswer;
  try {
    submit = await fetchBody(
      `${ATLAS_MODEL_API}/generateImage`,
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` }, body: JSON.stringify(opts.body) },
      opts.requestTimeoutMs ?? ATLAS_REQUEST_TIMEOUT_MS,
      opts.fetchFn ?? fetch,
    );
  } catch (error) {
    return networkFailure("submit", error);
  }

  if (!submit.ok) {
    return terminalHttpFailure(submit.status, submit.text) ?? failure("failed", `HTTP ${submit.status}: ${submit.text.slice(0, 300)}`);
  }

  const submitted = parseJson(submit.text) as
    | { code?: unknown; message?: unknown; data?: { id?: unknown } }
    | null;
  const predictionId = submitted?.data?.id;
  if (typeof predictionId !== "string" || !predictionId || (submitted?.code !== undefined && submitted.code !== 200)) {
    const message = typeof submitted?.message === "string" ? submitted.message : "no prediction id";
    return BALANCE_WORDS.test(message) ? failure("provider_rejected", `submit: ${message}`) : failure("bad_response", `submit: ${message}`);
  }
  return { ok: true, predictionId };
}

/**
 * One look at a prediction. A refused key or a missing prediction is final at once. Anything
 * transient reads as "still pending", so the caller's own deadline or retry decides when to
 * give up: a server error, a network failure, and a 429 (that only says this status query was
 * throttled; the paid job keeps running). A 200 that is not a prediction at all is a
 * `bad_response`; an unfamiliar status string is still pending.
 */
export async function checkAtlasJob(opts: CallOptions & { predictionId: string }): Promise<AtlasCheckResult> {
  let poll: BodyAnswer;
  try {
    poll = await fetchBody(
      `${ATLAS_MODEL_API}/prediction/${encodeURIComponent(opts.predictionId)}`,
      { headers: { Authorization: `Bearer ${opts.apiKey}` } },
      opts.requestTimeoutMs ?? ATLAS_REQUEST_TIMEOUT_MS,
      opts.fetchFn ?? fetch,
    );
  } catch {
    return { ok: true, state: "pending" };
  }
  if (!poll.ok) {
    if (poll.status === 429) return { ok: true, state: "pending" };
    return terminalHttpFailure(poll.status, poll.text) ?? { ok: true, state: "pending" };
  }

  const result = parseJson(poll.text) as { data?: { status?: unknown; outputs?: unknown; error?: unknown } } | null;
  const data = result?.data;
  if (!data || typeof data !== "object" || typeof data.status !== "string") {
    return failure("bad_response", `prediction ${opts.predictionId}: answer without a status`);
  }
  const status = data.status.toLowerCase();
  if (FAILED_STATES.has(status)) {
    const detail = typeof data.error === "string" ? data.error : status;
    return failure("failed", `prediction ${opts.predictionId}: ${detail}`);
  }
  if (DONE_STATES.has(status)) {
    const first = Array.isArray(data.outputs) ? data.outputs[0] : undefined;
    const outputUrl = httpsOutputUrl(first);
    return outputUrl ? { ok: true, state: "done", outputUrl } : failure("bad_response", `prediction ${opts.predictionId}: completed without a valid https output`);
  }
  return { ok: true, state: "pending" };
}

/**
 * Checks until the prediction ends or `deadline` (epoch ms) passes; then it is still "pending".
 * The deadline is checked before every provider request, so no request starts once it has
 * passed (a deadline that is already behind us makes no request at all).
 */
export async function pollAtlasJob(opts: CallOptions & {
  predictionId: string;
  deadline: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AtlasCheckResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = opts.intervalMs ?? 2000;
  let last: AtlasCheckResult = { ok: true, state: "pending" };
  for (;;) {
    if (opts.deadline - now() <= 0) return last;
    last = await checkAtlasJob(opts);
    if (!(last.ok && last.state === "pending")) return last;
    const wait = Math.min(intervalMs, opts.deadline - now());
    if (wait <= 0) return last;
    await sleep(wait);
  }
}
