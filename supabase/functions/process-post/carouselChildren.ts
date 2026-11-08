/**
 * Carousel children for Instagram and Threads. Meta rejects a CAROUSEL container whose
 * children are still processing, so every child is waited for before the carousel is built.
 * Instagram children are created at once: created one by one and each waited for, several
 * images alone used up a first run's wait budget (the 2026-11-05 pilot failures).
 *
 * Spec: docs/superpowers/specs/2026-11-05-carousel-publish-children-design.md
 */

import { type ContainerState, type MetaContainerApi, pollContainer, type PollContainerOptions } from "../_shared/metaContainerStatus.ts";
import { ContainerStillProcessing, unfinishedError } from "./deferredPublish.ts";

export interface CarouselChildCreate {
  /** POSTs one child container; resolves with Meta's JSON reply. */
  (body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Creates every child container at once. The first Meta error fails the whole carousel. */
export async function createCarouselChildren(
  urls: string[],
  childBody: (url: string) => Record<string, unknown>,
  create: CarouselChildCreate,
): Promise<string[]> {
  const replies = await Promise.all(urls.map((url) => create(childBody(url))));
  return replies.map((reply) => {
    const error = reply.error as { message?: string } | undefined;
    if (error) throw new Error(error.message ?? "Instagram rejected a carousel item");
    const id = reply.id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    if (typeof id === "string" && id) return id;
    // A reply with no id would publish a carousel with an "undefined" child.
    throw new Error("Instagram returned no container id for a carousel item");
  });
}

export interface ChildWait {
  deadlineMs: number;
  maxAttempts: number;
  intervalMs: number;
  /** Threads can retain the original child IDs and finish them on a later worker. */
  deferThreads?: boolean;
}

export interface ChildWaitOutcome {
  finished: string[];
  dropped: { id: string; reason: string }[];
}

type Poll = (api: MetaContainerApi, statusUrl: string, options: PollContainerOptions) => Promise<ContainerState>;

/**
 * Waits for each child in order, checking first (a child created a moment ago is often ready).
 * A child Meta marks ERROR or EXPIRED is dropped with Meta's reason, for the caller to decide
 * on; a child still processing at the deadline fails retryably: no carousel container exists
 * yet, so nothing could finish it later.
 */
export async function waitForCarouselChildren(
  api: MetaContainerApi,
  ids: string[],
  statusUrl: (id: string) => string,
  wait: ChildWait,
  poll: Poll = pollContainer,
): Promise<ChildWaitOutcome> {
  const outcome: ChildWaitOutcome = { finished: [], dropped: [] };
  for (const id of ids) {
    const container = await poll(api, statusUrl(id), {
      maxAttempts: wait.maxAttempts,
      intervalMs: wait.intervalMs,
      checkFirst: true,
      deadlineMs: wait.deadlineMs,
    });
    if (container.state === "failed") {
      outcome.dropped.push({ id, reason: container.reason });
      continue;
    }
    if (container.state === "waiting") {
      if (api === "threads" && wait.deferThreads && Number.isFinite(wait.deadlineMs)) {
        const pending = new ContainerStillProcessing("threads_carousel", ids[0]);
        pending.carouselChildren = ids;
        throw pending;
      }
      throw unfinishedError({ deadlineMs: wait.deadlineMs }, id, api === "threads" ? "Threads" : "Instagram");
    }
    outcome.finished.push(id);
  }
  return outcome;
}
