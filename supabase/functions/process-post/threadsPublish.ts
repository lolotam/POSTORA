import { ContainerStillProcessing, type DeferredKind, type ResumeContext } from "./deferredPublish.ts";
import type { GraphResponse } from "./graphResponse.ts";

/** A pending checkpoint must survive an uncertain write; never settle it failed. */
export class ThreadsCheckpointUnavailable extends Error {}

/** A resumed child phase must record its parent before a caller can publish it. */
export async function threadsParentContainer(resume: ResumeContext | null, create: () => Promise<string>): Promise<string> {
  if (resume && !resume.deferral.carousel_children) return resume.deferral.container_id;
  const id = await create();
  if (resume) {
    const next = { ...resume.deferral, container_id: id };
    delete next.carousel_children;
    if (!resume.checkpointContainer) throw new ThreadsCheckpointUnavailable("Threads carousel checkpoint unavailable; nothing was published");
    try {
      await resume.checkpointContainer(next);
    } catch {
      throw new ThreadsCheckpointUnavailable("Threads carousel checkpoint could not be confirmed; nothing was published");
    }
  }
  return id;
}

/** Send once. An unanswered publish retains the same container for status reconciliation. */
export async function publishThreadsContainer(
  publish: (timeoutMs: number) => Promise<GraphResponse>,
  containerId: string,
  kind: DeferredKind,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<{ id: string }> {
  const timeoutMs = Math.min(20_000, deadlineMs - now());
  if (timeoutMs < 3000) throw new ContainerStillProcessing(kind, containerId);
  let response: GraphResponse;
  try {
    response = await publish(timeoutMs);
  } catch {
    throw new ContainerStillProcessing(kind, containerId);
  }
  if (typeof response.id === "string" && response.id) return { id: response.id };
  if (response.error) throw new Error(`Threads publish error: ${response.error.message ?? "Meta rejected the publish"}`);
  throw new ContainerStillProcessing(kind, containerId);
}
