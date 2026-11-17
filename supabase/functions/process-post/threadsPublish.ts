import { ContainerStillProcessing, type Deferral, type DeferredKind, type ResumeContext } from "./deferredPublish.ts";
import type { GraphResponse } from "./graphResponse.ts";

/** A pending checkpoint must survive an uncertain write; never settle it failed. */
export class ThreadsCheckpointUnavailable extends Error {}
export class ThreadsCheckpointCanceled extends ThreadsCheckpointUnavailable {}

export type ThreadsImageCheckpoint = (deferral: Deferral) => Promise<{
  platformPostId: string;
  responseData: Record<string, unknown>;
  execution?: ResumeContext | null;
}>;

/** Persist a new image before its first status read; an uncertain acknowledgement is not retryable creation. */
export async function checkpointThreadsImage(
  checkpoint: ThreadsImageCheckpoint | undefined,
  deferral: Deferral,
): Promise<{ platformPostId: string; responseData: Record<string, unknown>; execution?: ResumeContext | null }> {
  if (!checkpoint || deferral.media_type !== "IMAGE" || !deferral.container_id) {
    throw new ThreadsCheckpointUnavailable("Threads image checkpoint unavailable; nothing was published");
  }
  try {
    const result = await checkpoint(deferral);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.platformPostId)) {
      throw new Error("missing checkpoint row id");
    }
    return result;
  } catch (error) {
    if (error instanceof ThreadsCheckpointUnavailable) throw error;
    throw new ThreadsCheckpointUnavailable("Threads image checkpoint could not be confirmed; nothing was published");
  }
}

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

export interface ThreadsPublishGuards {
  /** The image path durably claims its one send here, before the provider request. */
  beforeSend?: () => Promise<void>;
  /** A proven pre-send deadline may remove only the matching durable marker; false stays fail-closed. */
  onDefinitelyUnsent?: () => Promise<boolean>;
  /** A timeout, transport loss or malformed success answer leaves an explicit uncertain outcome. */
  onUnknown?: () => void;
}

/** Send once. An unanswered publish retains the same container for status reconciliation. */
export async function publishThreadsContainer(
  publish: (timeoutMs: number) => Promise<unknown>,
  containerId: string,
  kind: DeferredKind,
  deadlineMs: number,
  now: () => number = Date.now,
  guards: ThreadsPublishGuards = {},
): Promise<{ id: string }> {
  let timeoutMs = Math.min(20_000, deadlineMs - now());
  if (timeoutMs < 3000) throw new ContainerStillProcessing(kind, containerId);
  await guards.beforeSend?.();
  timeoutMs = Math.min(20_000, deadlineMs - now());
  if (timeoutMs < 3000) {
    if (guards.onDefinitelyUnsent) {
      let released = false;
      try {
        released = await guards.onDefinitelyUnsent();
      } catch (error) {
        if (error instanceof ThreadsCheckpointUnavailable) throw error;
        throw new ThreadsCheckpointUnavailable("Threads image unsent-marker release could not be confirmed; nothing was sent");
      }
      if (!released) {
        throw new ThreadsCheckpointUnavailable("Threads image unsent-marker release was refused; nothing was sent");
      }
    }
    throw new ContainerStillProcessing(kind, containerId);
  }
  let payload: unknown;
  try {
    payload = await publish(timeoutMs);
  } catch {
    guards.onUnknown?.();
    throw new ContainerStillProcessing(kind, containerId);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    guards.onUnknown?.();
    throw new ContainerStillProcessing(kind, containerId);
  }
  const response = payload as GraphResponse;
  if (typeof response.id === "string" && response.id) return { id: response.id };
  const errorObj = response.error;
  if (
    errorObj &&
    typeof errorObj === "object" &&
    !Array.isArray(errorObj) &&
    ((typeof (errorObj as { message?: unknown }).message === "string" &&
      (errorObj as { message: string }).message.trim().length > 0) ||
      typeof (errorObj as { code?: unknown }).code === "number")
  ) {
    throw new Error(`Threads publish error: ${(errorObj as { message?: string }).message ?? "Meta rejected the publish"}`);
  }
  guards.onUnknown?.();
  throw new ContainerStillProcessing(kind, containerId);
}

