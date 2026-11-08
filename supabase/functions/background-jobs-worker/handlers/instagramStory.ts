import type { ClaimedJob, JobOutcome } from "../worker.ts";

export type StoryPhase = "queued" | "creating" | "processing" | "publishing" | "published" | "failed" | "uncertain";
export interface StoryWork {
  postId: string;
  accountId: string;
  resultId: string;
  generation: number;
  consentVersion: string;
  giveUpAt: number;
  phase: StoryPhase;
  containerId?: string;
  mediaId?: string;
}

export interface StoryContext {
  /** Derived from stored post/account ownership and persisted consent, never caller assertions. */
  authorized: boolean;
  primarySucceeded: boolean;
  eligible: boolean;
  mediaValid: boolean;
}

export interface InstagramStoryPorts {
  now(): number;
  load(job: ClaimedJob, deadlineMs: number): Promise<{ work: StoryWork; context: StoryContext }>;
  /** Atomic generation/token/unexpired-lease check plus checkpoint before any provider mutation. */
  checkpoint(job: ClaimedJob, work: StoryWork): Promise<boolean>;
  create(work: StoryWork, timeoutMs: number): Promise<{ id: string }>;
  status(work: StoryWork, timeoutMs: number): Promise<"waiting" | "finished" | "published" | "failed">;
  publish(work: StoryWork, timeoutMs: number): Promise<{ id: string }>;
  /** Idempotently settles only this job's owned Story row; never the primary Reel. */
  settle(job: ClaimedJob, work: StoryWork, result: { published: boolean; error?: string; uncertain?: boolean }): Promise<boolean>;
}

const PHASES: readonly string[] = ["queued", "creating", "processing", "publishing", "published", "failed", "uncertain"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readStoryWork(payload: Record<string, unknown>): StoryWork | null {
  if (![payload.postId, payload.accountId, payload.resultId].every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (!Number.isInteger(payload.generation) || Number(payload.generation) < 1 || typeof payload.consentVersion !== "string" || !payload.consentVersion) return null;
  if (typeof payload.giveUpAt !== "number" || !Number.isFinite(payload.giveUpAt) || !PHASES.includes(String(payload.phase))) return null;
  if (["processing", "publishing", "published"].includes(String(payload.phase)) && (typeof payload.containerId !== "string" || !payload.containerId)) return null;
  if (payload.mediaId != null && (typeof payload.mediaId !== "string" || !payload.mediaId)) return null;
  return {
    postId: payload.postId as string, accountId: payload.accountId as string,
    resultId: payload.resultId as string, generation: Number(payload.generation),
    consentVersion: payload.consentVersion, giveUpAt: payload.giveUpAt,
    phase: payload.phase as StoryPhase,
    ...(typeof payload.containerId === "string" ? { containerId: payload.containerId } : {}),
    ...(typeof payload.mediaId === "string" ? { mediaId: payload.mediaId } : {}),
  };
}

/** One bounded step. Unknown dispatch resumes inspection of the same container, never a fresh publish. */
export async function runInstagramStory(job: ClaimedJob, ports: InstagramStoryPorts, deadlineMs: number): Promise<JobOutcome> {
  // Reload on every claim: a crash can leave the generic payload older than the durable checkpoint.
  const loaded = await ports.load(job, deadlineMs);
  let work = loaded.work;
  const remaining = () => Math.min(15_000, deadlineMs - ports.now() - 5_000);
  const again = (): JobOutcome => ({ kind: "continue", payload: { ...work }, progress: { phase: work!.phase }, runAfterMs: 60_000 });
  const fail = async (error: string, uncertain = false): Promise<JobOutcome> => {
    if (!await ports.settle(job, work!, { published: false, error, uncertain })) throw new Error("story_settlement_unavailable");
    return { kind: "failed", error, retryable: false };
  };
  const context = loaded.context;
  if (work.phase === "failed" || work.phase === "uncertain") return { kind: "done", result: { state: work.phase } };
  if (work.phase === "published") {
    if (!await ports.settle(job, work, { published: true })) throw new Error("story_settlement_unavailable");
    return { kind: "done", result: { published: true, mediaId: work.mediaId ?? null } };
  }
  if (!context.authorized) return fail("story_consent_or_owner_changed", work.phase === "publishing");
  if (ports.now() >= work.giveUpAt) return fail(work.phase === "publishing" ? "story_publish_unconfirmed" : "story_processing_timeout", work.phase === "publishing");
  if (!context.primarySucceeded) return again();
  if (!context.eligible) return fail("story_account_not_eligible", work.phase === "publishing");
  if (!context.mediaValid) return fail("story_media_not_eligible", work.phase === "publishing");
  if (remaining() < 1000) return again();
  if (work.phase === "creating") return fail("story_creation_unconfirmed");

  if (work.phase === "queued") {
    work = { ...work, phase: "creating" };
    if (!await ports.checkpoint(job, work)) throw new Error("story_claim_lost");
    if (remaining() < 1000) return again();
    let created: { id: string };
    try { created = await ports.create(work, remaining()); } catch { return fail("story_creation_unconfirmed"); }
    if (!created.id) return fail("story_creation_unconfirmed");
    work = { ...work, phase: "processing", containerId: created.id };
    if (!await ports.checkpoint(job, work)) throw new Error("story_checkpoint_unavailable");
    return again();
  }

  let state: "waiting" | "finished" | "published" | "failed";
  try { state = await ports.status(work, remaining()); } catch { return again(); }
  if (state === "published") {
    work = { ...work, phase: "published" };
    if (!await ports.checkpoint(job, work)) throw new Error("story_checkpoint_unavailable");
    if (!await ports.settle(job, work, { published: true })) throw new Error("story_settlement_unavailable");
    return { kind: "done", result: { published: true, mediaId: work.mediaId ?? null, confirmedByContainer: true } };
  }
  if (state === "failed") return fail("story_provider_failed", work.phase === "publishing");
  // A FINISHED status after a lost publish reply is not permission to create or dispatch again.
  if (state !== "finished" || work.phase === "publishing" || remaining() < 3000) return again();
  work = { ...work, phase: "publishing" };
  if (!await ports.checkpoint(job, work)) throw new Error("story_claim_lost");
  if (remaining() < 1000) return again();
  let published: { id: string };
  try { published = await ports.publish(work, remaining()); } catch { return again(); }
  if (!published.id) return again();
  work = { ...work, phase: "published", mediaId: published.id };
  if (!await ports.checkpoint(job, work)) throw new Error("story_checkpoint_unavailable");
  if (!await ports.settle(job, work, { published: true })) throw new Error("story_settlement_unavailable");
  return { kind: "done", result: { published: true, mediaId: published.id } };
}
