/**
 * Publishing an Instagram container (either login), with retries for Meta's transient errors.
 *
 * A publish request that goes unanswered proves nothing: Instagram keeps publishing after we
 * stop waiting. Treating a timeout as a failure recorded live reels as failed, and the retry
 * that followed posted them twice. So once any request has gone unanswered, the run never
 * ends in a plain failure without asking the container:
 *   - published: the post is live. A deferrable container goes to the reconciler, whose next
 *     check sees PUBLISHED and records it; any other is an error that says it may be live.
 *   - finished: the publish never landed, so it is sent again while time allows. Meta
 *     publishes a container at most once, so a second request cannot post twice.
 *   - failed: Meta's reason (only the container's own ERROR or EXPIRED, never a failed query).
 *   - unknown: a deferrable container goes to the reconciler; any other keeps its error.
 *
 * Every request is cut to the time left before `deadlineMs` (the worker's end, less what
 * recording the outcome needs), keeping room for the follow-up check, so the worker is never
 * stopped between a publish and its outcome being known.
 */

import { type ContainerState, containerFailureMessage } from "../_shared/metaContainerStatus.ts";
import { ContainerStillProcessing, type DeferredKind } from "./deferredPublish.ts";
import type { GraphError, GraphResponse } from "./graphResponse.ts";

export interface PublishPorts {
  /** POSTs media_publish with this timeout. Throws when the request goes unanswered. */
  publish(timeoutMs: number): Promise<GraphResponse>;
  /** The container's state, asked once with this timeout; a failed query is `waiting`. */
  containerState(timeoutMs: number): Promise<ContainerState>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface PublishOptions {
  creationId: string;
  /** For a container the reconciler can confirm later; without it, an unconfirmed publish is an error. */
  deferKind?: DeferredKind;
  /** The login's usual timeout for one publish request. */
  requestTimeoutMs: number;
  /** When the publish, and the check that settles it, must be over. Absent: no limit. */
  deadlineMs?: number;
  maxRetries?: number;
  initialDelayMs?: number;
}

/** The message for a publish that went unanswered while the container shows it published. */
export const PUBLISHED_UNCONFIRMED_MESSAGE =
  "Instagram did not confirm the publish in time, but the post appears to be live. Check the account before posting it again.";

/** The error for a non-deferrable publish that was never sent because the worker had no time left. */
export const NOT_SENT_MESSAGE =
  "There was not enough time left to publish safely, so nothing was posted to Instagram. Safe to retry.";

/** The follow-up container check's timeout, and the time kept back for it before each publish. */
export const CHECK_TIMEOUT_MS = 5_000;
/** Below this a request is not worth sending. */
export const MIN_REQUEST_MS = 3_000;

/** Meta's answers that mean "try again shortly". */
export function isRetryablePublishError(error: GraphError): boolean {
  const message = error.message ?? "";
  return error.code === 9007 || error.code === 2 || error.code === 4 ||
    message.includes("Media ID is not available") ||
    message.includes("not ready for publishing") ||
    message.includes("An unexpected error has occurred") ||
    message.includes("Please retry your request");
}

export async function publishContainer(ports: PublishPorts, options: PublishOptions): Promise<{ id: string }> {
  const maxRetries = options.maxRetries ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 2000;
  const now = ports.now ?? Date.now;
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const remaining = () => (options.deadlineMs ?? Number.POSITIVE_INFINITY) - now();
  const defer = () => new ContainerStillProcessing(options.deferKind!, options.creationId);

  const askContainer = (): Promise<ContainerState> => {
    const timeoutMs = Math.min(CHECK_TIMEOUT_MS, remaining());
    return timeoutMs >= MIN_REQUEST_MS ? ports.containerState(timeoutMs) : Promise.resolve({ state: "waiting" });
  };
  /** The outcome of a run in which some request went unanswered, from the container's state. */
  const unconfirmed = (container: ContainerState, error: Error): Error => {
    if (container.state === "failed") return new Error(containerFailureMessage("instagram", container.reason));
    if (options.deferKind) return defer();
    if (container.state === "published") return new Error(PUBLISHED_UNCONFIRMED_MESSAGE);
    return error;
  };

  let unanswered = false;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const timeoutMs = Math.min(options.requestTimeoutMs, remaining() - CHECK_TIMEOUT_MS);
    if (timeoutMs < MIN_REQUEST_MS) {
      // No time to publish and still learn the outcome. The container is ready, so a
      // deferrable one is published by the reconciler next minute instead.
      // Anything else is refused unsent: a request the worker cannot outlive may publish unrecorded.
      if (unanswered) throw unconfirmed(await askContainer(), lastError!);
      if (options.deferKind) throw defer();
      throw new Error(NOT_SENT_MESSAGE);
    }

    let reply: GraphResponse;
    try {
      reply = await ports.publish(timeoutMs);
    } catch (requestError) {
      unanswered = true;
      lastError = requestError instanceof Error ? requestError : new Error(String(requestError));
      const container = await askContainer();
      console.warn(`[instagram] publish attempt ${attempt + 1} went unanswered (${lastError.message}); container is ${container.state}`);
      if (container.state === "finished" && attempt < maxRetries - 1) continue;
      throw unconfirmed(container, lastError);
    }

    if (typeof reply.id === "string" && reply.id) return { id: reply.id };
    if (reply.error) {
      lastError = new Error(reply.error.message ?? "Instagram publish failed");
      const delayMs = initialDelayMs * Math.pow(2, attempt);
      const canRetry = isRetryablePublishError(reply.error) && attempt < maxRetries - 1 &&
        remaining() - delayMs - CHECK_TIMEOUT_MS >= MIN_REQUEST_MS;
      if (!canRetry) {
        // After an unanswered attempt, this error may be about a publish already landing.
        if (unanswered) throw unconfirmed(await askContainer(), lastError);
        if (isRetryablePublishError(reply.error) && options.deferKind) throw defer();
        throw lastError;
      }
      console.log(`[instagram] publish error (retryable), attempt ${attempt + 1}, retrying in ${delayMs}ms: ${reply.error.message}`);
      await sleep(delayMs);
    }
  }

  if (unanswered) throw unconfirmed(await askContainer(), lastError!);
  throw lastError ?? new Error("Failed to publish Instagram media after retries");
}

/** One of the account's media, as `/{ig-user-id}/media?fields=id,caption,timestamp,permalink` lists it. */
export interface MediaSummary {
  id: string;
  caption?: string;
  timestamp?: string;
  permalink?: string;
}

/**
 * The media a container became, found in the account's latest media: the only one with the
 * post's caption published since `notBeforeMs`. No caption, or more than one match (a
 * duplicate is exactly when this matters), is no answer: a wrong id would send the first
 * comment and the analytics to another post.
 */
export function matchPublishedMedia(media: MediaSummary[], caption: string | null | undefined, notBeforeMs: number): MediaSummary | null {
  const wanted = (caption ?? "").trim();
  if (!wanted) return null;
  const matches = media.filter((item) => (item.caption ?? "").trim() === wanted && Date.parse(item.timestamp ?? "") >= notBeforeMs);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * How far before its first deferral a deferred container's media may have been published. A
 * container is published only after it is created, and a first run defers within its poll
 * budget of creating it, so nothing older than this can be the container's media.
 */
export const PUBLISHED_LOOKBACK_MS = 2 * 60 * 1000;

/** How many of the account's latest media are searched for it. */
export const PUBLISHED_SEARCH_LIMIT = 25;
