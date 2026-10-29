/**
 * The hermetic test support of the OWNER collection worker.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The synthetic infrastructure the worker's tests drive: the claimed job
 *   projection, the service store double, the Graph transport double and
 *   the clocks. It contains no production logic and no assertion.
 *
 * WHY THE CLAIM ROW IS A CLOSED PROJECTION
 *
 *   The accepted SQL builds the claim row with `jsonb_build_object`, so its
 *   key set is part of the contract. The double therefore produces exactly
 *   that shape, and a test that needs a malformed row removes or changes a
 *   key on purpose.
 *
 * WHY THE TRANSPORT IS A DOUBLE AND NOT A NETWORK
 *
 *   Every test is hermetic. The double answers by URL shape: the account
 *   profile, the account day, the media insights of one media and the media
 *   connection each have their own canned answer, and a call that is not
 *   expected is a failure.
 *
 *   The account day and the media insights both live under `/insights`, and
 *   they are told apart by the request: the account day carries
 *   `metric_type=total_value`, the media insights does not.
 */

import type {
  OwnerCapability,
  OwnerCollectionServiceStore,
  OwnerMediaInventoryRow,
  OwnerProgressPayload,
  OwnerSnapshotPayload,
  OwnerThrottleBucket,
  OwnerTarget,
  ResolvedOwnerCredential,
} from "./workerStore.ts";
import { OwnerWorkerStoreError } from "./workerStore.ts";
import { parseClaimedOwnerJob, type ClaimedOwnerJob } from "./receipts.ts";

/** The identifiers the doubles use. */
export const TEST_JOB_ID = "01810001-0000-4000-8000-000000000001";
export const TEST_USER_ID = "01810002-0000-4000-8000-000000000002";
export const TEST_ACCOUNT_ID = "01810003-0000-4000-8000-000000000003";
export const TEST_CLAIM_TOKEN = "01810004-0000-4000-8000-000000000004";
export const TEST_CAPTURED_ON = "2026-10-28";
export const TEST_IG_USER_ID = "1784140001";
export const TEST_CREDENTIAL_ID = "01810005-0000-4000-8000-000000000005";

/** The last completed Kuwait day of the fixture capture day. */
export const TEST_PRIMARY_DAY = "2026-10-27";

/** The correction day of the fixture capture day. */
export const TEST_CORRECTION_DAY = "2026-10-26";

/** The raw claim row the accepted SQL returns. */
export function createClaimRow(overrides: Record<string, unknown> = {}) {
  return {
    job_id: TEST_JOB_ID,
    user_id: TEST_USER_ID,
    target_kind: "owner",
    target_id: TEST_ACCOUNT_ID,
    social_account_id: TEST_ACCOUNT_ID,
    watchlist_id: null,
    captured_on: TEST_CAPTURED_ON,
    job_generation: 1,
    claim_token: TEST_CLAIM_TOKEN,
    lease_expires_at: "2026-10-28T12:02:00.000000+00:00",
    attempts: 1,
    context: {
      viewer_social_account_id: TEST_ACCOUNT_ID,
      credential_generation: 7,
      login_kind: "page_linked",
      capability_present: true,
      permission_read_state: "ok",
      granted_scopes: ["instagram_basic", "instagram_manage_insights"],
    },
    checkpoint: {},
    pending_operations: [],
    claimed_at: "2026-10-28T12:00:00.000000+00:00",
    ...overrides,
  };
}

/**
 * The parsed claimed job.
 *
 * The fixture goes through the production parser, so a test never hand
 * builds a job the database would not have returned.
 */
export function createClaimedJob(overrides: Record<string, unknown> = {}): ClaimedOwnerJob {
  const parsed = parseClaimedOwnerJob(createClaimRow(overrides));
  if (parsed === null) throw new Error("the claim fixture does not match the projection");
  return parsed;
}

/** The recorded calls of the store double. */
export interface RecordedStoreCalls {
  readonly claims: Array<{ limit: number }>;
  readonly snapshots: Array<{ kind: string; items: readonly Record<string, unknown>[] }>;
  readonly progresses: OwnerProgressPayload[];
  readonly completes: Array<{ outcome: string; reasonCode: string | null }>;
  readonly throttles: Array<{
    bucketKey: string;
    usagePercent: number | null;
    throttledUntil: string | null;
    jobId: string | null;
  }>;
  readonly credentialReads: Array<{ userId: string; socialAccountId: string }>;
  readonly capabilityReads: Array<{ userId: string; socialAccountId: string }>;
  readonly mediaInventoryReads: Array<{ capturedOn: string; mediaIds: readonly string[] }>;
}

/** The knobs of the store double. */
export interface FakeStoreOptions {
  /** The rows the claim returns. */
  readonly jobs?: ClaimedOwnerJob[];
  /** The credential the account resolves to. */
  readonly credential?: Partial<ResolvedOwnerCredential>;
  /** The trusted capability of the account. */
  readonly capability?: Partial<OwnerCapability>;
  /** The target row, or null when the account is gone. */
  readonly target?: OwnerTarget | null;
  /** The shared throttle bucket. */
  readonly bucket?: OwnerThrottleBucket | null;
  /** The shared throttle buckets, by the bucket key. */
  readonly bucketByKey?: Record<string, OwnerThrottleBucket | null>;
  /** The store call that never answers. */
  readonly hangOn?:
    | "claim"
    | "target"
    | "capability"
    | "credential"
    | "bucket"
    | "snapshot"
    | "progress"
    | "complete"
    | "throttle"
    | "mediaInventory";
  /** The store call that fails. */
  readonly failOn?:
    | "claim"
    | "target"
    | "capability"
    | "credential"
    | "bucket"
    | "snapshot"
    | "progress"
    | "complete"
    | "throttle"
    | "mediaInventory";
  /** The credential read refuses with this failure. */
  readonly credentialFailure?: "credential_missing" | "credential_changed";
  /** The capability read refuses with this failure. */
  readonly capabilityFailure?: "credential_missing" | "credential_changed";
  /** The inventory rows the media read answers with. */
  readonly mediaInventory?: Record<string, Partial<OwnerMediaInventoryRow>>;
}

/**
 * The behaviour of ONE account.
 *
 * The double answers per account, so a test can give two claimed jobs two
 * different realities: one owner whose credential is throttled and one
 * owner that is collected.
 */
export type FakeStoreAccountOptions = Omit<FakeStoreOptions, "jobs" | "accounts">;

/**
 * The store double.
 *
 * Every call is recorded, so a test can assert what was written and, more
 * importantly, what was NOT written.
 */
export function createFakeStore(options: FakeStoreOptions & {
  readonly accounts?: Record<string, FakeStoreAccountOptions>;
} = {}) {
  const calls: RecordedStoreCalls = {
    claims: [],
    snapshots: [],
    progresses: [],
    completes: [],
    throttles: [],
    credentialReads: [],
    capabilityReads: [],
    mediaInventoryReads: [],
  };

  const hang = async (): Promise<never> => {
    await new Promise(() => undefined);
    throw new Error("unreachable");
  };

  /** The options of ONE account: the shared ones, then the account's own. */
  const accountOf = (socialAccountId: string): FakeStoreOptions => {
    const specific = options.accounts?.[socialAccountId];
    if (specific === undefined) return options;
    return { ...options, ...specific };
  };

  const store: OwnerCollectionServiceStore = {
    async claimOwnerJobs(input) {
      calls.claims.push({ limit: input.limit });
      if (options.hangOn === "claim") return await hang();
      if (options.failOn === "claim") {
        throw new Error("the claim failed");
      }
      return options.jobs ?? [];
    },

    async readOwnerTarget(input) {
      const account = accountOf(input.socialAccountId);
      if (account.hangOn === "target") return await hang();
      if (account.failOn === "target") throw new Error("the target read failed");
      return account.target === undefined
        ? {
          socialAccountId: input.socialAccountId,
          userId: input.userId,
          platformUserId: TEST_IG_USER_ID,
        }
        : account.target;
    },

    async readOwnerCapability(input) {
      calls.capabilityReads.push({
        userId: input.userId,
        socialAccountId: input.socialAccountId,
      });
      const account = accountOf(input.socialAccountId);
      if (account.hangOn === "capability") return await hang();
      if (account.failOn === "capability") throw new Error("the capability read failed");
      if (account.capabilityFailure) {
        throw new OwnerWorkerStoreError(account.capabilityFailure);
      }
      return {
        loginKind: "page_linked",
        credentialGeneration: 7,
        ...(account.capability ?? {}),
      };
    },

    async resolveOwnerCredential(input) {
      calls.credentialReads.push({
        userId: input.userId,
        socialAccountId: input.socialAccountId,
      });
      const account = accountOf(input.socialAccountId);
      if (account.hangOn === "credential") return await hang();
      if (account.failOn === "credential") throw new Error("the credential read failed");
      if (account.credentialFailure) {
        throw new OwnerWorkerStoreError(account.credentialFailure);
      }
      return {
        token: "the-secret-token",
        credentialId: TEST_CREDENTIAL_ID,
        capabilityGeneration: 7,
        ...(account.credential ?? {}),
      };
    },

    async readOwnerMediaInventory(input) {
      calls.mediaInventoryReads.push({
        capturedOn: input.capturedOn,
        mediaIds: [...input.mediaIds],
      });
      const account = accountOf(input.socialAccountId);
      if (account.hangOn === "mediaInventory") return await hang();
      if (account.failOn === "mediaInventory") {
        throw new Error("the media inventory read failed");
      }

      const rows: OwnerMediaInventoryRow[] = [];
      for (const mediaId of input.mediaIds) {
        const override = account.mediaInventory?.[mediaId];
        if (override === undefined && account.mediaInventory !== undefined) continue;
        rows.push({
          igMediaId: mediaId,
          mediaProductType: "FEED",
          mediaType: "IMAGE",
          publishedAt: "2026-10-20T12:00:00.000Z",
          likeCountPublic: null,
          commentsCountPublic: null,
          permalink: null,
          caption: null,
          thumbnailUrl: null,
          ...(override ?? {}),
        });
      }
      return rows;
    },

    async readThrottleBucket(input) {
      if (options.hangOn === "bucket") return await hang();
      if (options.failOn === "bucket") throw new Error("the bucket read failed");
      const byKey = options.bucketByKey?.[input.bucketKey];
      if (byKey !== undefined) return byKey;
      return options.bucket === undefined ? null : options.bucket;
    },

    async persistSnapshot(input) {
      if (options.hangOn === "snapshot") return await hang();
      if (options.failOn === "snapshot") throw new Error("the snapshot write failed");
      calls.snapshots.push({ kind: input.payload.kind, items: input.payload.items });
      return {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        written: input.payload.items.length,
      };
    },

    async recordProgress(input) {
      if (options.hangOn === "progress") return await hang();
      if (options.failOn === "progress") throw new Error("the progress write failed");
      calls.progresses.push(input.payload);
      return {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        recorded: input.payload.kind === "operations" ? input.payload.items.length : null,
        inventory: input.payload.kind === "inventory",
      };
    },

    async completeJob(input) {
      if (options.hangOn === "complete") return await hang();
      if (options.failOn === "complete") throw new Error("the completion write failed");
      calls.completes.push({ outcome: input.outcome, reasonCode: input.reasonCode });
      return {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        status: input.outcome,
        outcome: input.outcome,
        reasonCode: input.reasonCode,
      };
    },

    async recordThrottle(input) {
      if (options.hangOn === "throttle") return await hang();
      if (options.failOn === "throttle") throw new Error("the throttle write failed");
      calls.throttles.push({
        bucketKey: input.bucketKey,
        usagePercent: input.usagePercent,
        throttledUntil: input.throttledUntil,
        jobId: input.jobId ?? null,
      });
    },
  };

  return { store, calls };
}

/** The canned answers of the Graph transport double. */
export interface FakeGraphOptions {
  readonly profile?: unknown;
  readonly profileHeaders?: Record<string, string>;
  /** The account day answers, keyed by the Kuwait date. */
  readonly accountDays?: Record<string, unknown>;
  readonly accountDayHeaders?: Record<string, string>;
  /** The media insights answers, keyed by the media id. */
  readonly mediaInsights?: Record<string, unknown>;
  readonly mediaInsightHeaders?: Record<string, string>;
  readonly media?: unknown[];
  readonly mediaHeaders?: Record<string, string>;
  /** The transport call that never answers. */
  readonly hangOn?: "profile" | "accountDay" | "media" | "mediaInsight";
}

/**
 * The Kuwait date of a `since` unix timestamp.
 *
 * The account day request carries the day it wants as a range, so the
 * double answers the day that was asked for.
 */
function kuwaitDateOf(since: string | null): string {
  if (since === null) return TEST_PRIMARY_DAY;
  const seconds = Number(since);
  if (!Number.isFinite(seconds)) return TEST_PRIMARY_DAY;
  const shifted = new Date(seconds * 1000 + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The Graph transport double.
 *
 * It answers by URL shape and counts the calls, so a test can prove that no
 * provider call was spent.
 */
export function createFakeGraph(options: FakeGraphOptions = {}) {
  const calls: string[] = [];
  const urls: string[] = [];

  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const isInsights = url.includes("/insights");
    const isAccountDay = isInsights && url.includes("metric_type=total_value");
    const kind = isAccountDay
      ? "accountDay"
      : isInsights
      ? "mediaInsight"
      : url.includes("/media")
      ? "media"
      : "profile";
    calls.push(kind);

    if (options.hangOn === kind) {
      return new Promise<Response>(() => undefined);
    }

    if (kind === "accountDay") {
      const since = /[?&]since=(\d+)/.exec(url)?.[1] ?? null;
      const day = kuwaitDateOf(since);
      const answer = options.accountDays === undefined
        ? accountDayAnswer({ reach: 450, views: 890 })
        : options.accountDays[day] ?? { data: [] };
      return Promise.resolve(
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "Content-Type": "application/json", ...(options.accountDayHeaders ?? {}) },
        }),
      );
    }

    if (kind === "mediaInsight") {
      const mediaId = /\/v\d+\.\d+\/([^/?]+)\/insights/.exec(url)?.[1] ?? "";
      const answer = options.mediaInsights?.[mediaId] ?? { data: [] };
      return Promise.resolve(
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...(options.mediaInsightHeaders ?? {}),
          },
        }),
      );
    }

    if (kind === "media") {
      return Promise.resolve(
        new Response(JSON.stringify({ data: options.media ?? [] }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...(options.mediaHeaders ?? {}) },
        }),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify(options.profile ?? {}), {
        status: 200,
        headers: { "Content-Type": "application/json", ...(options.profileHeaders ?? {}) },
      }),
    );
  };

  return { fetchFn: fetchFn as unknown as typeof fetch, calls, urls };
}

/**
 * A clock that reads a fixed schedule.
 *
 * The schedule lists the ELAPSED time of each clock read, in order. The
 * worker reads the clock in a fixed order, so a schedule can put a specific
 * step just before its deadline while leaving the earlier steps - and the
 * provider-call precondition - comfortable.
 */
export function scheduledClock(schedule: readonly number[]): () => number {
  let calls = 0;
  return () => {
    const index = Math.min(calls, schedule.length - 1);
    calls += 1;
    return schedule[index] ?? 0;
  };
}

/** A clock that does not move. */
export function fixedClock(value = 1_767_225_600_000): () => number {
  return () => value;
}

/** The documented account day answer, in the documented `total_value` shape. */
export function accountDayAnswer(
  metrics: Readonly<Record<string, number>>,
): Record<string, unknown> {
  return {
    data: Object.entries(metrics).map(([name, value]) => ({
      name,
      period: "day",
      total_value: { value },
    })),
  };
}

/** The documented media insights answer, in the documented `values` shape. */
export function mediaInsightAnswer(
  metrics: Readonly<Record<string, number>>,
): Record<string, unknown> {
  return {
    data: Object.entries(metrics).map(([name, value]) => ({
      name,
      period: "lifetime",
      values: [{ value }],
    })),
  };
}
