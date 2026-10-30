/**
 * AtlasCloud image models (upscaler, background remover): submit one prediction and
 * poll it to a result. The contract is the one `upscale-image` already used:
 *   POST  https://api.atlascloud.ai/api/v1/model/generateImage   -> data.id
 *   GET   https://api.atlascloud.ai/api/v1/model/prediction/{id} -> data.status, data.outputs[0]
 *
 * Failures are classified here, once, so the HTTP adapters answer consistently and never
 * relay provider text to the caller (`detail` is for the log only).
 */

import { fetchWithTimeout } from "./request-timeout.ts";

const ATLAS_MODEL_API = "https://api.atlascloud.ai/api/v1/model";

export type AtlasFailureKind =
  | "provider_rejected" // our key or balance was refused: an operator problem, not the caller's
  | "rate_limited"
  | "timeout"
  | "unreachable"
  | "failed"
  | "bad_response";

export type AtlasResult =
  | { ok: true; outputUrl: string; predictionId: string }
  | { ok: false; kind: AtlasFailureKind; httpStatus: number; detail: string };

export interface AtlasRunOptions {
  apiKey: string;
  /** Full submit body, including `model`. */
  body: Record<string, unknown>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  requestTimeoutMs?: number;
}

/** What we answer our own caller for each failure kind. */
const STATUS_FOR_KIND: Record<AtlasFailureKind, number> = {
  provider_rejected: 503,
  rate_limited: 429,
  timeout: 504,
  unreachable: 502,
  failed: 502,
  bad_response: 502,
};

function failure(kind: AtlasFailureKind, detail: string): AtlasResult {
  return { ok: false, kind, httpStatus: STATUS_FOR_KIND[kind], detail };
}

const BALANCE_WORDS = /insufficient[_ ]balance|balance|credit/i;
const FAILED_STATES = new Set(["failed", "error", "canceled", "cancelled"]);
const DONE_STATES = new Set(["completed", "succeeded"]);

function classifyHttpFailure(status: number, text: string): AtlasResult {
  const detail = `HTTP ${status}: ${text.slice(0, 300)}`;
  if (status === 401 || status === 402 || status === 403 || BALANCE_WORDS.test(text)) return failure("provider_rejected", detail);
  if (status === 429) return failure("rate_limited", detail);
  return failure("failed", detail);
}

export async function runAtlasImageModel(opts: AtlasRunOptions): Promise<AtlasResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const maxPolls = opts.maxPolls ?? 60;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const auth = { Authorization: `Bearer ${opts.apiKey}` };

  let submit: Response;
  try {
    submit = await fetchWithTimeout(
      `${ATLAS_MODEL_API}/generateImage`,
      { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(opts.body) },
      requestTimeoutMs,
      fetchFn,
    );
  } catch (error) {
    return failure("unreachable", `submit: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!submit.ok) return classifyHttpFailure(submit.status, await submit.text().catch(() => ""));

  const submitted = await submit.json().catch(() => null) as
    | { code?: unknown; message?: unknown; data?: { id?: unknown } }
    | null;
  const predictionId = submitted?.data?.id;
  if (typeof predictionId !== "string" || !predictionId || (submitted?.code !== undefined && submitted.code !== 200)) {
    const message = typeof submitted?.message === "string" ? submitted.message : "no prediction id";
    return BALANCE_WORDS.test(message) ? failure("provider_rejected", `submit: ${message}`) : failure("bad_response", `submit: ${message}`);
  }

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    await sleep(pollIntervalMs);
    let poll: Response;
    try {
      poll = await fetchWithTimeout(`${ATLAS_MODEL_API}/prediction/${encodeURIComponent(predictionId)}`, { headers: auth }, requestTimeoutMs, fetchFn);
    } catch {
      continue; // a flaky poll is retried until the poll budget is spent
    }
    if (!poll.ok) continue;
    const result = await poll.json().catch(() => null) as { data?: { status?: unknown; outputs?: unknown; error?: unknown } } | null;
    const status = typeof result?.data?.status === "string" ? result.data.status.toLowerCase() : "";
    if (FAILED_STATES.has(status)) {
      const detail = typeof result?.data?.error === "string" ? result.data.error : status;
      return failure("failed", `prediction ${predictionId}: ${detail}`);
    }
    if (DONE_STATES.has(status)) {
      const first = Array.isArray(result?.data?.outputs) ? result.data.outputs[0] : undefined;
      if (typeof first === "string" && first.startsWith("https://")) return { ok: true, outputUrl: first, predictionId };
      return failure("bad_response", `prediction ${predictionId}: completed without an https output`);
    }
  }
  return failure("timeout", `prediction ${predictionId}: not finished after ${maxPolls} polls`);
}
