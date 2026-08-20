/**
 * Readers for Higgsfield MCP tool payloads.
 *
 * Split out from the MCP client so the parsing is pure, dependency-free, and
 * testable â€” the client itself needs OAuth and cannot run under vitest.
 *
 * These shapes are not documented and vary by tool, so every reader probes
 * rather than assumes. A real `job_status` result looks like:
 *
 *     { generation: { id, type, status: "completed", model,
 *                     results: { rawUrl: "â€¦.png", minUrl: "â€¦_min.webp" } } }
 *
 * and with `raw_data: true`:
 *
 *     { raw_data: { id, status: "completed", result_url: "â€¦.png",
 *                   min_result_url: "â€¦_min.webp", thumbnail_url: null } }
 *
 * Note the status is nested under `generation` / `raw_data`, not at the top
 * level, and the finished asset is under `results.rawUrl` â€” alongside a `minUrl`
 * thumbnail that must never be mistaken for it.
 *
 * Mirrored byte-identically by
 * `supabase/functions/_shared/higgsfield-job-payload.ts` (edge functions cannot
 * import from `src/`). Keep both in step.
 *
 * @module lib/higgsfieldJobPayload
 */

/** A plain object node in an untyped payload. */
type Node = Record<string, unknown>;

function isRecord(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize an MCP tool result into a plain object.
 *
 * Prefers structuredContent, then a JSON-parsable text block, then the raw
 * text. Shapes vary between tools, so callers should still probe defensively.
 */
export function extractToolPayload(result: unknown): unknown {
  if (!isRecord(result)) return result ?? null;
  if (result.structuredContent !== undefined) return result.structuredContent;

  const content = Array.isArray(result.content) ? result.content : null;
  if (!content) return result;

  const texts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") texts.push(item.text);
  }

  for (const text of texts) {
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON â€” keep looking.
    }
  }

  return texts.length ? texts.join("\n") : result;
}

/**
 * Find a generation job id in a tool payload.
 *
 * Higgsfield returns the id under different keys depending on the tool and
 * whether the result was wrapped, so search rather than assume.
 */
export function findJobId(payload: unknown): string | null {
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const keys = ["job_id", "jobId", "generation_id", "generationId", "id"];
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): string | null => {
    if (!isRecord(node) || depth > 6 || seen.has(node)) return null;
    seen.add(node);

    for (const key of keys) {
      const value = node[key];
      if (typeof value === "string" && uuid.test(value)) return value;
    }
    for (const value of Object.values(node)) {
      const found = Array.isArray(value)
        ? value.reduce<string | null>((hit, item) => hit ?? walk(item, depth + 1), null)
        : walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };

  return walk(payload, 0);
}

const TERMINAL_SUCCESS = new Set(["completed", "complete", "success", "succeeded", "done", "finished"]);
const TERMINAL_FAILURE = new Set(["failed", "error", "canceled", "cancelled", "rejected", "nsfw"]);

export type JobState = "running" | "succeeded" | "failed";

export interface JobSnapshot {
  state: JobState;
  status: string;
  outputUrl: string | null;
  error: string | null;
  pollAfterSeconds: number;
}

/**
 * Containers the job envelope may hide its fields behind.
 *
 * `job_status` nests everything under `generation`, and under `raw_data` when
 * asked for the unnormalized form. Reading only the top level made every job
 * look permanently unfinished.
 */
const ENVELOPES = ["generation", "raw_data", "job", "data", "result"];

/** Every level worth probing: the payload itself plus any known envelope. */
function levels(payload: unknown): Node[] {
  if (!isRecord(payload)) return [];
  const out: Node[] = [payload];
  for (const key of ENVELOPES) {
    const nested = payload[key];
    if (isRecord(nested)) out.push(nested);
  }
  return out;
}

function readStatus(payload: unknown): string {
  for (const level of levels(payload)) {
    for (const key of ["status", "state"]) {
      const value = level[key];
      if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
    }
  }
  return "";
}

function readPollAfterSeconds(payload: unknown): number {
  for (const level of levels(payload)) {
    for (const key of ["poll_after_seconds", "pollAfterSeconds"]) {
      const value = Number(level[key]);
      if (Number.isFinite(value) && value > 0) return Math.min(value, 30);
    }
  }
  return 5;
}

function readError(payload: unknown): string | null {
  for (const level of levels(payload)) {
    const value = level.error;
    if (typeof value === "string" && value.trim()) return value;
    if (isRecord(value) && typeof value.message === "string") return value.message;
    if (typeof level.message === "string" && level.message.trim()) return level.message;
  }
  return null;
}

/** Interpret a `job_status` payload without depending on one exact shape. */
export function readJobSnapshot(payload: unknown): JobSnapshot {
  const status = readStatus(payload);
  const pollAfterSeconds = readPollAfterSeconds(payload);

  if (TERMINAL_FAILURE.has(status)) {
    return {
      state: "failed",
      status,
      outputUrl: null,
      error: readError(payload) ?? "Higgsfield reported the generation failed",
      pollAfterSeconds,
    };
  }

  // Require an explicit terminal status. Treating "no status but some URL
  // present" as success would archive a thumbnail or an unrelated link from a
  // job that is still rendering.
  if (TERMINAL_SUCCESS.has(status)) {
    const outputUrl = findOutputUrl(payload);
    if (!outputUrl) {
      return {
        state: "failed",
        status,
        outputUrl: null,
        error: "Higgsfield reported success but returned no output URL",
        pollAfterSeconds,
      };
    }
    return { state: "succeeded", status, outputUrl, error: null, pollAfterSeconds };
  }

  return { state: "running", status: status || "running", outputUrl: null, error: null, pollAfterSeconds };
}

/** File extensions we are willing to treat as a generated asset. */
const MEDIA_PATH = /\.(mp4|webm|mov|png|jpe?g|webp)(\?|#|$)/i;

/**
 * Keys that carry the full-size asset, in priority order.
 *
 * `rawUrl` / `result_url` sit beside `minUrl` / `min_result_url`, which are
 * downscaled previews â€” so the full-size keys are matched explicitly rather
 * than left to whichever the generic walk happens to reach first.
 */
const OUTPUT_URL_KEYS = [
  "rawUrl",
  "raw_url",
  "result_url",
  "resultUrl",
  "url",
  "video_url",
  "videoUrl",
  "image_url",
  "imageUrl",
  "output_url",
  "outputUrl",
];

/**
 * Keys holding a preview rather than the asset.
 *
 * Archiving one of these would silently attach a downscaled webp to a product
 * in place of the generated image, so they are never followed.
 */
const PREVIEW_KEY = /(^|_)min(_|$)|^min[A-Z]|thumb|preview|watermark/i;

/**
 * Recursively locate the generated media URL in a payload.
 *
 * A URL reached through one of the known output keys is trusted as-is. Anything
 * found elsewhere in the payload must *look* like media, because status
 * responses routinely carry unrelated links â€” docs, terms, account pages,
 * thumbnails â€” and picking one of those up would archive the wrong file and
 * attach it to a product.
 */
export function findOutputUrl(payload: unknown): string | null {
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number, viaNamedKey: boolean): string | null => {
    if (node === null || node === undefined || depth > 6) return null;

    if (typeof node === "string") {
      if (!node.startsWith("https://")) return null;
      return viaNamedKey || MEDIA_PATH.test(node) ? node : null;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1, viaNamedKey);
        if (found) return found;
      }
      return null;
    }
    if (!isRecord(node) || seen.has(node)) return null;
    seen.add(node);

    for (const key of OUTPUT_URL_KEYS) {
      const found = walk(node[key], depth + 1, true);
      if (found) return found;
    }
    for (const [key, value] of Object.entries(node)) {
      if (OUTPUT_URL_KEYS.includes(key) || PREVIEW_KEY.test(key)) continue;
      const found = walk(value, depth + 1, false);
      if (found) return found;
    }
    return null;
  };

  return walk(payload, 0, false);
}


