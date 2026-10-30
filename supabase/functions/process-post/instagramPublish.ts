/**
 * Publishing an Instagram container (either login), with retries for Meta's transient errors.
 *
 * A publish request that goes unanswered proves nothing: Instagram keeps publishing after we
 * stop waiting. Treating a timeout as a failure recorded live reels as failed, and the retry
 * that followed posted them twice. The container says what happened instead, asked once:
 *   - published: the post is live. A deferrable container goes to the reconciler, whose next
 *     check sees PUBLISHED and records it; any other is an error that says it may be live.
 *   - finished: the publish never landed, so it is sent again. Meta publishes a container at
 *     most once, so a second request cannot post twice.
 *   - failed: Meta's reason.
 *   - unknown (the check went unanswered too): a deferrable container goes to the reconciler;
 *     any other keeps the original error.
 */

import { type ContainerState, containerFailureMessage } from "../_shared/metaContainerStatus.ts";
import { ContainerStillProcessing, type DeferredKind } from "./deferredPublish.ts";
import type { GraphError, GraphResponse } from "./graphResponse.ts";

export interface PublishPorts {
  /** POSTs media_publish. Throws when the request goes unanswered (timeout, network). */
  publish(): Promise<GraphResponse>;
  /** The container's state, asked once. */
  containerState(): Promise<ContainerState>;
  sleep?(ms: number): Promise<void>;
}

export interface PublishOptions {
  creationId: string;
  /** For a container the reconciler can confirm later; without it, an unconfirmed publish is an error. */
  deferKind?: DeferredKind;
  maxRetries?: number;
  initialDelayMs?: number;
}

/** The message for a publish that went unanswered while the container shows it published. */
export const PUBLISHED_UNCONFIRMED_MESSAGE =
  "Instagram did not confirm the publish in time, but the post appears to be live. Check the account before posting it again.";

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
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let reply: GraphResponse;
    try {
      reply = await ports.publish();
    } catch (requestError) {
      lastError = requestError instanceof Error ? requestError : new Error(String(requestError));
      const container = await ports.containerState();
      console.warn(`[instagram] publish attempt ${attempt + 1} went unanswered (${lastError.message}); container is ${container.state}`);
      if (container.state === "finished") continue;
      if (container.state === "failed") throw new Error(containerFailureMessage("instagram", container.reason));
      if (options.deferKind) throw new ContainerStillProcessing(options.deferKind, options.creationId);
      if (container.state === "published") throw new Error(PUBLISHED_UNCONFIRMED_MESSAGE);
      throw lastError;
    }

    if (typeof reply.id === "string" && reply.id) return { id: reply.id };
    if (reply.error) {
      lastError = new Error(reply.error.message ?? "Instagram publish failed");
      if (!isRetryablePublishError(reply.error)) throw lastError;
      const delayMs = initialDelayMs * Math.pow(2, attempt);
      console.log(`[instagram] publish error (retryable), attempt ${attempt + 1}, retrying in ${delayMs}ms: ${reply.error.message}`);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Failed to publish Instagram media after retries");
}
