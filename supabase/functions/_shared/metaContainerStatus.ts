/**
 * What a Meta media container's status means for publishing, for Instagram and Threads.
 *
 * Instagram reports the state in `status_code` and, on ERROR, its reason in `status`
 * (an error subcode). Threads reports the state in `status` and the reason in
 * `error_message`. Request both fields, or a failure is recorded with no reason.
 */

import { fetchWithTimeout } from "./request-timeout.ts";

export type MetaContainerApi = "instagram" | "threads";

export type ContainerState =
  | { state: "finished" }
  | { state: "published" }
  | { state: "failed"; reason: string }
  | { state: "waiting" };

/** The `fields=` value each API needs for classifyContainerStatus. */
export const CONTAINER_STATUS_FIELDS: Record<MetaContainerApi, string> = {
  instagram: "status_code,status",
  threads: "status,error_message",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function classifyContainerStatus(api: MetaContainerApi, data: Record<string, unknown> | null | undefined): ContainerState {
  const code = text(api === "instagram" ? data?.status_code : data?.status)?.toUpperCase() ?? null;
  const detail = text(api === "instagram" ? data?.status : data?.error_message);
  switch (code) {
    case "FINISHED":
      return { state: "finished" };
    case "PUBLISHED":
      return { state: "published" };
    case "ERROR":
    case "EXPIRED":
      return { state: "failed", reason: detail && detail.toUpperCase() !== code ? `${code}: ${detail}` : code };
    default:
      return { state: "waiting" };
  }
}

/** The message recorded on the platform_posts row when Meta rejects a container. */
export function containerFailureMessage(api: MetaContainerApi, reason: string): string {
  return `${api === "instagram" ? "Instagram" : "Threads"} could not process the media (${reason})`;
}

/**
 * A deadline of 0 is the resumed run's: it has a fresh worker of its own, so it checks the
 * container exactly once, with the full timeout and no sleep, and leaves the rest to the
 * next scheduled check.
 */
export const CHECK_ONCE_DEADLINE = 0;

/** Not worth starting a request with less than this left: it would be cut off at once. */
export const MIN_CHECK_MS = 1_000;

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Meta's own codes for "try again": unexpected error, temporary, rate limits. */
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 613]);

export interface PollContainerOptions {
  maxAttempts: number;
  intervalMs: number;
  /**
   * The absolute time (epoch ms) the whole wait must end by, so a slow Meta cannot run the
   * worker out of time. It is checked before every sleep and every request, and each request's
   * timeout is cut to what is left. With no time left the poll returns `waiting` without
   * another request. Absent or infinite, only the attempts bound the wait.
   * CHECK_ONCE_DEADLINE (0) checks once, with no wait.
   */
  deadlineMs?: number;
  /** Check straight away instead of sleeping first (Instagram containers are often ready). */
  checkFirst?: boolean;
  fetchTimeoutMs?: number;
  fetcher?: (url: string, timeoutMs: number) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface ApiFailure {
  retryable: boolean;
  reason: string;
}

/**
 * A request Meta answered with an error. Meta's reason is kept so it reaches the row, but a
 * server error, a timeout answer, a rate limit or Meta's own transient flag is retried like
 * a network failure: only an answer that will not change (bad token, bad id) fails.
 */
function apiFailure(response: Response, data: Record<string, unknown> | null): ApiFailure | null {
  const error = data?.error && typeof data.error === "object" ? data.error as Record<string, unknown> : null;
  if (response.ok && !error) return null;
  const code = typeof error?.code === "number" ? error.code : null;
  const message = text(error?.message);
  const retryable = response.status >= 500 || response.status === 408 || response.status === 429 ||
    error?.is_transient === true || (code !== null && TRANSIENT_META_CODES.has(code));
  const label = code !== null ? `code ${code}` : `HTTP ${response.status}`;
  return { retryable, reason: `Meta API error (${label})${message ? `: ${message}` : ""}` };
}

/**
 * Checks a container until it settles, the attempts run out or the deadline arrives.
 * A failed request or an unreadable answer is retried; Meta's ERROR, or an API error that
 * will not change, ends the wait as `failed` with Meta's reason. Returns `waiting` when time
 * or attempts run out, so the caller decides, and never publishes blindly.
 */
export async function pollContainer(api: MetaContainerApi, statusUrl: string, options: PollContainerOptions): Promise<ContainerState> {
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const fetcher = options.fetcher ?? ((url: string, timeoutMs: number) => fetchWithTimeout(url, {}, timeoutMs));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const checkOnce = options.deadlineMs === CHECK_ONCE_DEADLINE;
  const deadlineMs = options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs) && !checkOnce ? options.deadlineMs : null;
  const attempts = checkOnce ? 1 : options.maxAttempts;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const waitMs = checkOnce || (attempt === 1 && options.checkFirst) ? 0 : options.intervalMs;
    // The sleep and a worthwhile request must both fit before the deadline.
    if (deadlineMs !== null && now() + waitMs + MIN_CHECK_MS > deadlineMs) return { state: "waiting" };
    if (waitMs > 0) await sleep(waitMs);
    const timeoutMs = deadlineMs === null ? fetchTimeoutMs : Math.min(fetchTimeoutMs, deadlineMs - now());
    if (timeoutMs < MIN_CHECK_MS) return { state: "waiting" };

    let response: Response;
    try {
      response = await fetcher(statusUrl, timeoutMs);
    } catch (error) {
      // Only the error's name: a fetch error message can echo the URL, which carries the access token.
      console.warn(`[${api}] container status check ${attempt} failed: ${error instanceof Error ? error.name : "unknown error"}`);
      continue;
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = await response.json();
    } catch {
      // An unreadable body is judged by its status below, or waited on if the status was fine.
    }

    const failure = apiFailure(response, data);
    if (failure) {
      console.warn(`[${api}] container status check ${attempt}: ${failure.reason}${failure.retryable ? " (will retry)" : ""}`);
      if (failure.retryable) continue;
      return { state: "failed", reason: failure.reason };
    }
    const container = classifyContainerStatus(api, data);
    console.log(`[${api}] container status check ${attempt}/${attempts}: ${container.state}`);
    if (container.state !== "waiting") return container;
  }
  return { state: "waiting" };
}
