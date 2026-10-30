/**
 * One AtlasCloud image job, shared by upscale-image and remove-background, built so that no
 * request outlives the platform's ~60 s worker and gateway limit:
 *
 *   start   stage an uploaded input in Openinary, submit the job, poll until `POLL_BUDGET_MS`.
 *           Done in time: finish. Not done: answer "processing" with a signed token and keep the
 *           staged input, which the result still needs. A paid job is never submitted unless its
 *           request can still finish inside `FINISH_BUDGET_MS`: staging and submitting check the
 *           time left first and refuse (504, logged) when there is not enough, and a submit that
 *           leaves no polling time answers "processing" at once.
 *   resume  (a later request with that token) check once. Still running: "processing" again.
 *           Done: finish. Failed: clean up.
 *   finish  remove the staged input, copy the result into Openinary (provider URL as the
 *           fallback), all inside `FINISH_BUDGET_MS`.
 *
 * Every failure maps to the status, stable code and caller-safe message the adapters return;
 * provider detail goes to the console log only.
 */

import { PROVIDER_UNAVAILABLE_CODE } from "./aiImageProviders.ts";
import { runInBackground } from "./background.ts";
import {
  ATLAS_REQUEST_TIMEOUT_MS,
  checkAtlasJob,
  pollAtlasJob,
  submitAtlasJob,
  type AtlasCheckResult,
  type AtlasFailure,
} from "./atlasCloudImage.ts";
import {
  discardStaged,
  fetchOutputImage,
  logImageTool,
  resultNameFor,
  stageInput,
  storeResult,
  type FetchedImage,
  type ImageInput,
} from "./aiImageIo.ts";
import { tokenMeta, type JobTokenPayload } from "./aiImageToken.ts";
import type { OpeninaryConfig } from "./openinary.ts";

/** Submit and polling stop here, measured from the start of the request. */
export const POLL_BUDGET_MS = 32_000;
/** Everything, including copying the result and cleanup, stops here. */
export const FINISH_BUDGET_MS = 44_000;
/** How long a follow-up token stays redeemable. */
export const TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
export const RETRY_AFTER_SECONDS = 3;

const MIN_DOWNLOAD_WINDOW_MS = 4_000;
/** The submit request may use its whole timeout, so it only starts with that much time left. */
const SUBMIT_WINDOW_MS = ATLAS_REQUEST_TIMEOUT_MS;
/** Staging an upload is only worth starting when it gets at least this long (after the submit window). */
const MIN_STAGE_WINDOW_MS = 3_000;
const OUTPUT_DOWNLOAD_MAX_MS = 20_000;
const STAGED_CLEANUP_MAX_MS = 3_000;

export interface AtlasJobBase {
  operation: "upscale" | "background_removal";
  userId: string;
  /** Null when Openinary is not configured: URL inputs still work, uploaded ones cannot be staged. */
  openinary: OpeninaryConfig | null;
  atlasApiKey: string;
  area: "upscaled" | "processed";
  /** Epoch ms when the request began; every budget is measured from it. */
  startedAt: number;
  /** Signs the follow-up token. */
  sign: (payload: JobTokenPayload) => Promise<string>;
  /** Download the output even without Openinary, because the caller reports its size and type. */
  wantOutputDetails?: boolean;
  /** `unavailable` is also what an operator-side failure (key, balance, storage) says. */
  messages: { unavailable: string; busy: string; timeout: string; failed: string };
  failureCode: string;
  /** What the final response reports. Inside the token, long strings (a signed URL) are dropped to null. */
  meta: Record<string, string | number | null>;
}

export interface StartSpec extends AtlasJobBase {
  input: ImageInput;
  /** Builds the provider request body for the URL the model should read. */
  buildBody: (sourceUrl: string) => Record<string, unknown>;
}

export interface ResumeSpec extends AtlasJobBase {
  token: string;
  payload: JobTokenPayload;
}

export type AtlasJobOutcome =
  | {
    ok: true;
    status: "completed";
    resultUrl: string;
    storedIn: "openinary" | "provider";
    storedPath: string | null;
    predictionId: string;
    /** Present when the output was downloaded (always when stored in Openinary). */
    output: Extract<FetchedImage, { ok: true }> | null;
    meta: Record<string, string | number | null>;
  }
  | { ok: true; status: "processing"; token: string; retryAfterSeconds: number; meta: Record<string, string | number | null> }
  | { ok: false; status: number; code: string; message: string; reason: string; level: "warn" | "error" };

export interface AtlasJobDeps {
  submit: typeof submitAtlasJob;
  poll: typeof pollAtlasJob;
  check: typeof checkAtlasJob;
  fetchOutput: typeof fetchOutputImage;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realDeps: AtlasJobDeps = {
  submit: submitAtlasJob,
  poll: pollAtlasJob,
  check: checkAtlasJob,
  fetchOutput: fetchOutputImage,
  now: Date.now,
};

/** Resolves to `fallback` if `work` has not finished in `ms` (the work itself is not cancelled). */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(ms, 0));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

function logOf(spec: AtlasJobBase) {
  return { operation: spec.operation, provider: "atlascloud", user_id: spec.userId };
}

function unavailable(spec: AtlasJobBase, reason: string): AtlasJobOutcome {
  logImageTool("error", "ai_image_provider_unavailable", { ...logOf(spec), reason });
  return { ok: false, status: 503, code: PROVIDER_UNAVAILABLE_CODE, message: spec.messages.unavailable, reason, level: "error" };
}

function failed(spec: AtlasJobBase, atlas: AtlasFailure): AtlasJobOutcome {
  logImageTool("error", "ai_image_job_failed", { ...logOf(spec), kind: atlas.kind, detail: atlas.detail });
  if (atlas.kind === "provider_rejected") {
    return { ok: false, status: 503, code: PROVIDER_UNAVAILABLE_CODE, message: spec.messages.unavailable, reason: atlas.kind, level: "error" };
  }
  const message = atlas.kind === "rate_limited" ? spec.messages.busy : atlas.kind === "timeout" ? spec.messages.timeout : spec.messages.failed;
  return { ok: false, status: atlas.httpStatus, code: spec.failureCode, message, reason: atlas.kind, level: "error" };
}

/** The request ran out of time before a paid job could be submitted safely. */
function tooLate(spec: AtlasJobBase, stage: "stage" | "submit"): AtlasJobOutcome {
  logImageTool("warn", "ai_image_deadline_refused", { ...logOf(spec), stage });
  return { ok: false, status: 504, code: spec.failureCode, message: spec.messages.timeout, reason: `deadline_before_${stage}`, level: "warn" };
}

/** Time left before the request must have answered, whatever else is going on. */
function untilFinishBudget(spec: AtlasJobBase, deps: AtlasJobDeps): number {
  return spec.startedAt + FINISH_BUDGET_MS - deps.now();
}

async function cleanStaged(spec: AtlasJobBase, deps: AtlasJobDeps, stagedPath: string | null): Promise<void> {
  if (!spec.openinary || !stagedPath) return;
  const left = spec.startedAt + FINISH_BUDGET_MS - deps.now();
  await within(discardStaged(spec.openinary, stagedPath, STAGED_CLEANUP_MAX_MS), Math.min(STAGED_CLEANUP_MAX_MS, left), undefined);
}

async function finish(
  spec: AtlasJobBase,
  deps: AtlasJobDeps,
  done: { outputUrl: string; predictionId: string; stagedPath: string | null },
): Promise<AtlasJobOutcome> {
  await cleanStaged(spec, deps, done.stagedPath);
  const remaining = () => spec.startedAt + FINISH_BUDGET_MS - deps.now();

  // The job is paid for: a result that cannot be copied in time is returned from the
  // provider's own URL instead of being thrown away.
  const wantDownload = (spec.openinary || spec.wantOutputDetails) && remaining() > MIN_DOWNLOAD_WINDOW_MS;
  const downloaded = wantDownload
    ? await deps.fetchOutput(done.outputUrl, { timeoutMs: Math.min(OUTPUT_DOWNLOAD_MAX_MS, Math.floor(remaining() / 2)) })
    : null;
  const output = downloaded?.ok ? downloaded : null;

  let resultUrl = done.outputUrl;
  let storedIn: "openinary" | "provider" = "provider";
  let storedPath: string | null = null;
  if (spec.openinary) {
    const stored = output
      ? await within(
        resultNameFor(done.predictionId).then((name) => storeResult(spec.openinary!, spec.userId, spec.area, output, name)),
        remaining(),
        { ok: false as const, error: "storing the result took too long" },
      )
      : null;
    if (stored?.ok) {
      resultUrl = stored.url;
      storedPath = stored.path;
      storedIn = "openinary";
    } else {
      const error = stored ? stored.error : downloaded && !downloaded.ok ? downloaded.error : "output not downloaded in time";
      logImageTool("warn", "ai_image_store_failed", { ...logOf(spec), error });
    }
  }
  logImageTool("info", "ai_image_job", { ...logOf(spec), stored_in: storedIn });
  return { ok: true, status: "completed", resultUrl, storedIn, storedPath, predictionId: done.predictionId, output, meta: spec.meta };
}

async function processing(spec: AtlasJobBase, predictionId: string, stagedPath: string | null, token?: string): Promise<AtlasJobOutcome> {
  const signed = token ?? await spec.sign({
    prediction: predictionId,
    staged: stagedPath,
    operation: spec.operation,
    area: spec.area,
    issuedAt: spec.startedAt,
    meta: tokenMeta(spec.meta),
  });
  logImageTool("info", "ai_image_job_processing", logOf(spec));
  return { ok: true, status: "processing", token: signed, retryAfterSeconds: RETRY_AFTER_SECONDS, meta: spec.meta };
}

async function settle(
  spec: AtlasJobBase,
  deps: AtlasJobDeps,
  result: AtlasCheckResult,
  predictionId: string,
  stagedPath: string | null,
  token?: string,
): Promise<AtlasJobOutcome> {
  if (!result.ok) {
    await cleanStaged(spec, deps, stagedPath);
    return failed(spec, result);
  }
  if (result.state === "pending") return processing(spec, predictionId, stagedPath, token);
  return finish(spec, deps, { outputUrl: result.outputUrl, predictionId, stagedPath });
}

/**
 * Stages an upload, giving up after `ms`. A copy that lands after the give-up is removed again,
 * since nothing will ever reference it.
 */
async function stageWithin(
  openinary: OpeninaryConfig,
  spec: AtlasJobBase,
  input: Extract<ImageInput, { kind: "bytes" }>,
  ms: number,
): Promise<Awaited<ReturnType<typeof stageInput>> | null> {
  const work = stageInput(openinary, spec.userId, input);
  const staged = await within<Awaited<typeof work> | null>(work, ms, null);
  if (staged === null) {
    // Registered with the runtime so the cleanup outlives this request's response.
    await runInBackground("ai-image late staging cleanup", () =>
      work.then((late) => (late.ok ? discardStaged(openinary, late.path, STAGED_CLEANUP_MAX_MS) : undefined)));
  }
  return staged;
}

export async function startAtlasImageJob(spec: StartSpec, deps: AtlasJobDeps = realDeps): Promise<AtlasJobOutcome> {
  let sourceUrl: string;
  let stagedPath: string | null = null;
  if (spec.input.kind === "url") {
    sourceUrl = spec.input.url;
  } else {
    // AtlasCloud reads the image by URL, so an uploaded image is staged in Openinary first.
    if (!spec.openinary) return unavailable(spec, "openinary_not_configured");
    const stageWindow = untilFinishBudget(spec, deps) - SUBMIT_WINDOW_MS;
    if (stageWindow < MIN_STAGE_WINDOW_MS) return tooLate(spec, "stage");
    const staged = await stageWithin(spec.openinary, spec, spec.input, stageWindow);
    if (staged === null) return tooLate(spec, "stage");
    if (!staged.ok) {
      logImageTool("error", "ai_image_stage_failed", { ...logOf(spec), error: staged.error });
      return unavailable(spec, "stage_failed");
    }
    sourceUrl = staged.url;
    stagedPath = staged.path;
  }

  // Past this point the job costs money: submit only if the request can still wait out the
  // submit call itself and answer before the gateway gives up.
  if (untilFinishBudget(spec, deps) < SUBMIT_WINDOW_MS) {
    await cleanStaged(spec, deps, stagedPath);
    return tooLate(spec, "submit");
  }
  const submitted = await deps.submit({ apiKey: spec.atlasApiKey, body: spec.buildBody(sourceUrl), requestTimeoutMs: SUBMIT_WINDOW_MS });
  if (!submitted.ok) {
    await cleanStaged(spec, deps, stagedPath);
    return failed(spec, submitted);
  }

  // The job is running and paid for. If the submit used up the polling time, hand back the
  // token now rather than risk the answer arriving after the gateway has closed the request.
  const deadline = spec.startedAt + POLL_BUDGET_MS;
  if (deadline - deps.now() <= 0) return processing(spec, submitted.predictionId, stagedPath);
  const result = await deps.poll({
    apiKey: spec.atlasApiKey,
    predictionId: submitted.predictionId,
    deadline,
    now: deps.now,
    sleep: deps.sleep,
  });
  return settle(spec, deps, result, submitted.predictionId, stagedPath);
}

export async function resumeAtlasImageJob(spec: ResumeSpec, deps: AtlasJobDeps = realDeps): Promise<AtlasJobOutcome> {
  const { prediction, staged } = spec.payload;
  const result = await deps.check({ apiKey: spec.atlasApiKey, predictionId: prediction });
  return settle(spec, deps, result, prediction, staged, spec.token);
}

/** A follow-up token that is no longer valid for resuming: its staged input is still removed. */
export async function abandonAtlasImageJob(spec: AtlasJobBase, payload: JobTokenPayload, deps: AtlasJobDeps = realDeps): Promise<void> {
  await cleanStaged(spec, deps, payload.staged);
}
