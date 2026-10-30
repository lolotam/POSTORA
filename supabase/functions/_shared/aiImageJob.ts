/**
 * One AtlasCloud image job end to end, shared by upscale-image and remove-background:
 * stage an uploaded input in Openinary, run the model, remove the staged copy, keep the
 * result in Openinary. Each failure maps to the status, stable code and caller-safe
 * message the adapters return; provider detail goes to the log only.
 */

import { PROVIDER_UNAVAILABLE_CODE } from "./aiImageProviders.ts";
import { runAtlasImageModel, type AtlasResult } from "./atlasCloudImage.ts";
import {
  discardStaged,
  fetchOutputImage,
  logImageTool,
  stageInput,
  storeResult,
  type FetchedImage,
  type ImageInput,
} from "./aiImageIo.ts";
import type { OpeninaryConfig } from "./openinary.ts";

export interface AtlasJobSpec {
  operation: "upscale" | "background_removal";
  userId: string;
  input: ImageInput;
  /** Null when Openinary is not configured: URL inputs still work, uploaded ones cannot be staged. */
  openinary: OpeninaryConfig | null;
  atlasApiKey: string;
  /** Builds the provider request body for the URL the model should read. */
  buildBody: (sourceUrl: string) => Record<string, unknown>;
  area: "upscaled" | "processed";
  maxPolls?: number;
  /** Download the output even without Openinary, because the caller reports its size and type. */
  wantOutputDetails?: boolean;
  /** `unavailable` is also what an operator-side failure (key, balance, storage) says. */
  messages: { unavailable: string; busy: string; timeout: string; failed: string };
  failureCode: string;
}

export type AtlasJobResult =
  | {
    ok: true;
    resultUrl: string;
    storedIn: "openinary" | "provider";
    storedPath: string | null;
    predictionId: string;
    /** Present when the output was downloaded (always when stored in Openinary). */
    output: Extract<FetchedImage, { ok: true }> | null;
  }
  | { ok: false; status: number; code: string; message: string };

export interface AtlasJobDeps {
  runAtlas: typeof runAtlasImageModel;
  fetchOutput: typeof fetchOutputImage;
}

export async function runAtlasImageJob(
  spec: AtlasJobSpec,
  deps: AtlasJobDeps = { runAtlas: runAtlasImageModel, fetchOutput: fetchOutputImage },
): Promise<AtlasJobResult> {
  const log = { operation: spec.operation, provider: "atlascloud", user_id: spec.userId };
  const unavailable = (reason: string): AtlasJobResult => {
    logImageTool("error", "ai_image_provider_unavailable", { ...log, reason });
    return { ok: false, status: 503, code: PROVIDER_UNAVAILABLE_CODE, message: spec.messages.unavailable };
  };

  let sourceUrl: string;
  let stagedPath: string | null = null;
  if (spec.input.kind === "url") {
    sourceUrl = spec.input.url;
  } else {
    // AtlasCloud reads the image by URL, so an uploaded image is staged in Openinary first.
    if (!spec.openinary) return unavailable("openinary_not_configured");
    const staged = await stageInput(spec.openinary, spec.userId, spec.input);
    if (!staged.ok) {
      logImageTool("error", "ai_image_stage_failed", { ...log, error: staged.error });
      return unavailable("stage_failed");
    }
    sourceUrl = staged.url;
    stagedPath = staged.path;
  }

  let atlas: AtlasResult;
  try {
    atlas = await deps.runAtlas({ apiKey: spec.atlasApiKey, body: spec.buildBody(sourceUrl), maxPolls: spec.maxPolls });
  } finally {
    if (spec.openinary && stagedPath) await discardStaged(spec.openinary, stagedPath);
  }

  if (!atlas.ok) {
    logImageTool("error", "ai_image_job_failed", { ...log, kind: atlas.kind, detail: atlas.detail });
    if (atlas.kind === "provider_rejected") return { ok: false, status: 503, code: PROVIDER_UNAVAILABLE_CODE, message: spec.messages.unavailable };
    const message = atlas.kind === "rate_limited" ? spec.messages.busy : atlas.kind === "timeout" ? spec.messages.timeout : spec.messages.failed;
    return { ok: false, status: atlas.httpStatus, code: spec.failureCode, message };
  }

  // The job is paid for: a result that cannot be copied into Openinary is returned from the
  // provider's own URL instead of being thrown away.
  const downloaded = spec.openinary || spec.wantOutputDetails ? await deps.fetchOutput(atlas.outputUrl) : null;
  const output = downloaded?.ok ? downloaded : null;
  let resultUrl = atlas.outputUrl;
  let storedIn: "openinary" | "provider" = "provider";
  let storedPath: string | null = null;
  if (spec.openinary) {
    const stored = output ? await storeResult(spec.openinary, spec.userId, spec.area, output) : null;
    if (stored?.ok) {
      resultUrl = stored.url;
      storedPath = stored.path;
      storedIn = "openinary";
    } else {
      const error = stored ? stored.error : downloaded && !downloaded.ok ? downloaded.error : "output not downloaded";
      logImageTool("warn", "ai_image_store_failed", { ...log, error });
    }
  }
  logImageTool("info", "ai_image_job", { ...log, stored_in: storedIn });
  return { ok: true, resultUrl, storedIn, storedPath, predictionId: atlas.predictionId, output };
}
