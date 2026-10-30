/**
 * Deferred completion for Meta containers that outlast the edge worker.
 *
 * An Instagram reel or a Threads video can take Meta minutes to process, and the
 * worker lives 60 s. Waiting inline got the worker killed mid-wait with nothing
 * recorded, leaving the post `processing` forever. Now a handler waits only while
 * the worker has time; a container still processing is recorded as a `pending`
 * platform_posts row carrying `response_data.deferred`, and the
 * reconcile-deferred-publishes cron calls process-post again in resume mode, once
 * a minute, until Meta finishes, fails, or the deadline passes.
 *
 * Spec: docs/superpowers/specs/2026-10-29-hardening-followups-design.md, Part B2.
 */

import { z } from "npm:zod@3.23.8";
import { CHECK_ONCE_DEADLINE } from "../_shared/metaContainerStatus.ts";
import { type StoryRef, UNRECORDED_STORY_KEY } from "./instagramStory.ts";

export type DeferredKind = "ig_reel" | "ig_business_reel" | "threads";

/** How long a deferred container may keep processing before it is given up. */
export const DEFERRAL_GIVE_UP_MS = 30 * 60 * 1000;
/** Meta suggests checking a container about once a minute. */
export const DEFERRAL_RECHECK_MS = 60 * 1000;
/** Time a first run may spend waiting for containers; the rest is for publishing. */
export const FIRST_RUN_POLL_BUDGET_MS = 35 * 1000;

export const DeferralSchema = z.object({
  kind: z.enum(["ig_reel", "ig_business_reel", "threads"]),
  container_id: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  first_deferred_at: z.string(),
  give_up_at: z.string(),
  next_check_at: z.string(),
  claimed_until: z.string().nullish(),
});

export type Deferral = z.infer<typeof DeferralSchema>;

/** Thrown by a handler whose container is still processing when its time is up. */
export class ContainerStillProcessing extends Error {
  /**
   * A story that is live but whose row could not be written. It travels on the pending row so
   * the resumed (or abandoned) run can write it, instead of the story being lost with the throw.
   */
  unrecordedStory: StoryRef | null = null;

  constructor(readonly kind: DeferredKind, readonly containerId: string) {
    super(`Meta is still processing container ${containerId}`);
    this.name = "ContainerStillProcessing";
  }
}

/** What a resumed run needs: the pending row to settle and the container to finish. */
export interface ResumeContext {
  platformPostId: string;
  deferral: Deferral;
  /** A live story the first run could not record; the resumed run records it. */
  unrecordedStory?: StoryRef | null;
}

/**
 * What a handler needs to know about deferral: the run it is resuming, if any, and
 * when its waiting must stop. NO_DEFERRAL waits as long as the poller allows.
 */
export interface PublishTiming {
  resume: ResumeContext | null;
  deadlineMs: number;
  /** When this request began; bounds a container the run creates itself (see ownContainerDeadline). */
  startedAtMs?: number;
}

export const NO_DEFERRAL: PublishTiming = { resume: null, deadlineMs: Number.POSITIVE_INFINITY };

export function newDeferral(kind: DeferredKind, containerId: string, now: Date): Deferral {
  return {
    kind,
    container_id: containerId,
    attempts: 0,
    first_deferred_at: now.toISOString(),
    give_up_at: new Date(now.getTime() + DEFERRAL_GIVE_UP_MS).toISOString(),
    next_check_at: new Date(now.getTime() + DEFERRAL_RECHECK_MS).toISOString(),
  };
}

/** The deferral after one more check that found the container still processing. */
export function nextDeferral(deferral: Deferral, now: Date): Deferral {
  return {
    ...deferral,
    attempts: deferral.attempts + 1,
    next_check_at: new Date(now.getTime() + DEFERRAL_RECHECK_MS).toISOString(),
    claimed_until: null,
  };
}

export function isPastGiveUp(deferral: Deferral, now: Date): boolean {
  return now.getTime() >= Date.parse(deferral.give_up_at);
}

export function giveUpMessage(kind: DeferredKind): string {
  const platform = kind === "threads" ? "Threads" : "Instagram";
  return `${platform} did not finish processing the video within 30 minutes. Safe to retry.`;
}

/** Why a resumed run settles its row failed without asking Meta again, or null to go on. */
export function abandonReason(deferral: Deferral, postStatus: string | null, now: Date): string | null {
  if (isPastGiveUp(deferral, now)) return giveUpMessage(deferral.kind);
  if (postStatus !== "processing") return "The post was changed while the video was processing. Safe to retry.";
  return null;
}

/**
 * The deadline a poller checks against. A resumed run checks once and stops (Meta
 * is asked again next minute); a first run waits while the worker has time.
 */
export function pollDeadline(startedAtMs: number, resumed: boolean): number {
  return resumed ? CHECK_ONCE_DEADLINE : startedAtMs + FIRST_RUN_POLL_BUDGET_MS;
}

/**
 * The deadline for a container this run both creates and finishes (the "Also share to Story"
 * mirror). The run's own deadline is CHECK_ONCE_DEADLINE on a resumed run, which is right for
 * the deferred reel (Meta is asked again next minute) but would check a container created a
 * moment ago exactly once and drop it. Nothing re-checks that container later, so it gets the
 * deadline a first run would have: the poll budget counted from when THIS request began, not
 * from now, so the wait plus the publish after it still fit inside the worker.
 */
export function ownContainerDeadline(runDeadlineMs: number, requestStartedAtMs: number): number {
  return runDeadlineMs === CHECK_ONCE_DEADLINE ? requestStartedAtMs + FIRST_RUN_POLL_BUDGET_MS : runDeadlineMs;
}

/** How long past `give_up_at` an abandon may keep retrying a story it could not record. */
export const STORY_RECOVERY_GRACE_MS = 10 * 60 * 1000;

/**
 * Whether an abandon that keeps failing to record its carried story must give up on that too.
 * Until then it answers 503 and the reconciler retries; after it the reel is settled anyway, so
 * a story write that never succeeds cannot hold the post in `processing` forever.
 */
export function storyRecoveryExhausted(deferral: Deferral, now: Date): boolean {
  return now.getTime() >= Date.parse(deferral.give_up_at) + STORY_RECOVERY_GRACE_MS;
}

/**
 * What one container wait may do. EVERY wait has a deadline (`PublishTiming.deadlineMs`), so
 * no poll can outlast the worker; `deferKind` says whether the container can be finished
 * later. A deferrable one that runs out of time is handed to the reconciler; any other one
 * ends in a plain "safe to retry" error.
 */
export interface ContainerWait {
  deadlineMs: number;
  deferKind?: DeferredKind;
}

/** What a wait throws when time or attempts ran out with the container still processing. */
export function unfinishedError(wait: ContainerWait, containerId: string, platform: "Instagram" | "Threads"): Error {
  // An infinite deadline (NO_DEFERRAL) has nobody to finish the container later.
  if (wait.deferKind && Number.isFinite(wait.deadlineMs)) return new ContainerStillProcessing(wait.deferKind, containerId);
  return new Error(`${platform} did not finish processing the media in time. Safe to retry.`);
}

const FINISHED_BUFFER_MS = 3000;

/**
 * Instagram's backend needs a moment after FINISHED before media_publish works. The pause
 * counts against the deadline like any other time: it is cut to what is left, and is nothing
 * once the deadline has passed (publishing retries cover a container that is not quite ready).
 * A resumed run has a worker of its own, so it keeps the whole pause.
 */
export function bufferAfterFinishedMs(deadlineMs: number, nowMs: number): number {
  if (deadlineMs === CHECK_ONCE_DEADLINE || !Number.isFinite(deadlineMs)) return FINISHED_BUFFER_MS;
  return Math.max(0, Math.min(FINISHED_BUFFER_MS, deadlineMs - nowMs));
}

/** Reads the deferral off a pending row, or null if the row carries none. */
export function readDeferral(responseData: unknown): Deferral | null {
  const parsed = DeferralSchema.safeParse((responseData as { deferred?: unknown } | null)?.deferred);
  return parsed.success ? parsed.data : null;
}

type WriteResult = PromiseLike<{ error: { message: string } | null }>;

/** The two platform_posts writes recordStillProcessing makes, and nothing more. */
interface PlatformPostsWriter {
  /** record_deferred_platform_post: inserts the pending row only for an account of the post's owner. */
  rpc(
    fn: "record_deferred_platform_post",
    args: { p_post_id: string; p_social_account_id: string; p_response_data: Record<string, unknown> },
  ): WriteResult;
  from(table: "platform_posts"): {
    update(values: Record<string, unknown>): { eq(column: string, value: string): { eq(column: string, value: string): WriteResult } };
  };
}

type Settle = (supabase: unknown, args: {
  platformPostId: string | null;
  postId: string;
  socialAccountId: string | null;
  platform: string | null;
  status: "success" | "failed";
  errorMessage?: string | null;
}) => Promise<{ id: string | null; error: string | null }>;

/**
 * A container Meta is still processing when the handler's time is up. A first run
 * records a pending row for reconcile-deferred-publishes; a resumed run moves the
 * next check out a minute, or gives the account up once the deadline has passed.
 */
export async function recordStillProcessing(
  supabase: unknown,
  settle: Settle,
  args: {
    postId: string;
    account: { id: string; platform: string; platform_username?: string | null; account_metadata?: unknown };
    signal: ContainerStillProcessing;
    resume: ResumeContext | null;
    resumeResponseData: Record<string, unknown> | null;
  },
  now = new Date(),
): Promise<{ gaveUp: boolean; error: string | null }> {
  const db = supabase as PlatformPostsWriter;
  if (!args.resume) {
    // Through SQL, not a bare insert: the function refuses an account that does not belong
    // to the post's owner, so the pairing never depends on this caller having checked it.
    // The platform is taken from the account row there.
    const { error } = await db.rpc("record_deferred_platform_post", {
      p_post_id: args.postId,
      p_social_account_id: args.account.id,
      p_response_data: {
        deferred: newDeferral(args.signal.kind, args.signal.containerId, now),
        account_username: args.account.platform_username,
        account_metadata: args.account.account_metadata,
        ...(args.signal.unrecordedStory ? { [UNRECORDED_STORY_KEY]: args.signal.unrecordedStory } : {}),
      },
    });
    return { gaveUp: false, error: error?.message ?? null };
  }

  if (isPastGiveUp(args.resume.deferral, now)) {
    const settled = await settle(supabase, {
      platformPostId: args.resume.platformPostId,
      postId: args.postId,
      socialAccountId: args.account.id,
      platform: args.account.platform,
      status: "failed",
      errorMessage: giveUpMessage(args.resume.deferral.kind),
    });
    return { gaveUp: true, error: settled.error };
  }

  const { error } = await db
    .from("platform_posts")
    .update({ response_data: { ...(args.resumeResponseData ?? {}), deferred: nextDeferral(args.resume.deferral, now) } })
    .eq("id", args.resume.platformPostId)
    .eq("status", "pending");
  return { gaveUp: false, error: error?.message ?? null };
}
