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

export interface PollContainerOptions {
  maxAttempts: number;
  intervalMs: number;
  fetcher?: (url: string) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Checks a container until it settles or the attempts run out, waiting before each check.
 * Only a failed request or an unreadable answer is retried; Meta's ERROR ends the wait.
 * Returns `waiting` when the attempts run out, so the caller decides, and never publishes blindly.
 */
export async function pollContainer(api: MetaContainerApi, statusUrl: string, options: PollContainerOptions): Promise<ContainerState> {
  const fetcher = options.fetcher ?? ((url: string) => fetchWithTimeout(url, {}, 15_000));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    await sleep(options.intervalMs);
    let data: Record<string, unknown> | null;
    try {
      data = await (await fetcher(statusUrl)).json();
    } catch (error) {
      // Only the error's name: a fetch error message can echo the URL, which carries the access token.
      console.warn(`[${api}] container status check ${attempt} failed: ${error instanceof Error ? error.name : "unknown error"}`);
      continue;
    }
    const container = classifyContainerStatus(api, data);
    console.log(`[${api}] container status check ${attempt}/${options.maxAttempts}: ${container.state}`);
    if (container.state !== "waiting") return container;
  }
  return { state: "waiting" };
}
