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
 *
 * WHY THE MEDIA READ-BACK ECHOES THE SWEEP
 *
 *   The media inventory the double reads back is the one the SWEEP wrote:
 *   the media type, the product type, the publication time, the public
 *   counts, the stored metrics and the status, for that account and that
 *   capture day. A default row would answer with a type the provider never
 *   said, and it would hide a worker that stores the wrong one.
 *
 *   The accepted upsert writes the EXCLUDED columns, so a media snapshot
 *   REPLACES the row: a column the payload does not carry is NULLed. The
 *   double mirrors that, so a read-back never reports a value that was not
 *   written.
 */

import type {
  OwnerCapability,
  OwnerCollectionServiceStore,
  OwnerMediaInventoryRow,
  OwnerProgressPayload,
  OwnerSnapshotPayload,
  OwnerStoreFailure,
  OwnerThrottleBucket,
  OwnerTarget,
  ProviderPermitDecision,
  ResolvedOwnerCredential,
} from "./workerStore.ts";
import { OwnerWorkerStoreError } from "./workerStore.ts";
import {
  parseClaimedOwnerJob,
  type ClaimedOwnerJob,
  type DirectOwnerCredential,
  type ProviderPermitRefusalReason,
} from "./receipts.ts";

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
  readonly directCredentialReads: Array<{
    jobId: string;
    expectedCredentialGeneration: number;
  }>;
  readonly mediaInventoryReads: Array<{ capturedOn: string; mediaIds: readonly string[] }>;
  /** The writes the database refused, and the job they refused. */
  readonly refusedWrites: Array<{ jobId: string; kind: string }>;
  /**
   * The admission permits the store was asked for.
   *
   * Every provider request asks for a FRESH permit, so this list grows with
   * the number of requests and not with the number of jobs.
   */
  readonly permits: Array<{
    readonly jobId: string;
    readonly jobGeneration: number;
    readonly outcome: "allowed" | "refused" | "unavailable";
  }>;
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
    | "directCredential"
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
    | "directCredential"
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
  /** The direct credential read refuses with this failure. */
  readonly directCredentialFailure?: "credential_missing" | "credential_changed";
  /**
   * The write the DATABASE refuses for one job.
   *
   * This is how the accepted fence is reproduced: the write is refused with
   * the failure the database raises, and the test watches what the worker
   * does with that refusal.
   */
  readonly writeFailure?: {
    readonly jobId: string;
    readonly failure: OwnerStoreFailure;
    readonly sqlstate?: string | null;
  };
  /** The operational token the direct reader answers with. */
  readonly directCredential?: Partial<DirectOwnerCredential>;
  /**
   * The admission gate of the account.
   *
   * `allowed` is the default: the permit is granted for every request. A
   * `refused` permit is a policy refusal and the accepted SQL audited it.
   * An `unavailable` permit is a gate that could not be read, and the
   * exception-path audit is attempted in a separate bounded call.
   */
  readonly permit?:
    | {
      readonly outcome: "allowed";
    }
    | {
      readonly outcome: "refused";
      readonly reasonCode?: ProviderPermitRefusalReason;
    }
    | {
      readonly outcome: "unavailable";
      readonly reasonCode?: string;
      readonly auditStored?: boolean;
    };
  /**
   * The permits that are refused, counted from the first one.
   *
   * It is how a test refuses a permit BETWEEN two requests: the first N
   * permits are granted and the next one is refused.
   */
  readonly refusePermitAfter?: number;
  /**
   * The media rows this capture day ALREADY stores, keyed by media id.
   *
   * They stand for the rows an EARLIER visit wrote: the read-back returns
   * them for a media the current sweep did not touch. A media the sweep
   * DID write is never answered from here - the read-back echoes the sweep
   * instead, so the type, the publication time, the public counts and the
   * stored metrics are the ones the sweep really wrote.
   */
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
 * The base row of a media the double holds without a sweep of its own.
 *
 * It is only the stand-in for a row an EARLIER visit stored; every row the
 * CURRENT sweep wrote is answered from the sweep itself.
 */
const BASE_MEDIA_ROW: Omit<OwnerMediaInventoryRow, "igMediaId"> = {
  mediaProductType: "FEED",
  mediaType: "IMAGE",
  publishedAt: "2026-10-20T12:00:00.000Z",
  likeCountPublic: null,
  commentsCountPublic: null,
  permalink: null,
  caption: null,
  thumbnailUrl: null,
  status: "ok",
  views: null,
  reach: null,
  likes: null,
  comments: null,
  saved: null,
  shares: null,
  totalInteractions: null,
  follows: null,
  profileVisits: null,
  replies: null,
  igReelsAvgWatchTimeMs: null,
};

/** The key of one stored media row: the account, the capture day, the media. */
function mediaKey(
  socialAccountId: string,
  capturedOn: string,
  igMediaId: string,
): string {
  return `${socialAccountId}|${capturedOn}|${igMediaId}`;
}

/**
 * The stored row of ONE media snapshot.
 *
 * The accepted upsert writes the EXCLUDED columns, so a column the payload
 * does not carry is NULLed. The double mirrors that exactly: a media
 * snapshot REPLACES the row and never merges into it, so a read-back never
 * reports a value the write did not carry.
 */
function mediaRowFromSnapshot(
  igMediaId: string,
  item: Record<string, unknown>,
): OwnerMediaInventoryRow {
  const rawMetrics = item.metrics;
  const metrics: Record<string, unknown> =
    typeof rawMetrics === "object" && rawMetrics !== null && !Array.isArray(rawMetrics)
      ? rawMetrics as Record<string, unknown>
      : {};

  const metric = (name: string): number | null => {
    const value = metrics[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const text = (name: string): string | null => {
    const value = item[name];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  return {
    igMediaId,
    mediaProductType: text("media_product_type"),
    mediaType: text("media_type"),
    publishedAt: typeof item.published_at === "string"
      ? item.published_at
      : BASE_MEDIA_ROW.publishedAt,
    likeCountPublic: metric("like_count_public"),
    commentsCountPublic: metric("comments_count_public"),
    permalink: text("permalink"),
    caption: text("caption"),
    thumbnailUrl: text("thumbnail_url"),
    status: item.status === "unavailable" ? "unavailable" : "ok",
    views: metric("views"),
    reach: metric("reach"),
    likes: metric("likes"),
    comments: metric("comments"),
    saved: metric("saved"),
    shares: metric("shares"),
    totalInteractions: metric("total_interactions"),
    follows: metric("follows"),
    profileVisits: metric("profile_visits"),
    replies: metric("replies"),
    igReelsAvgWatchTimeMs: metric("ig_reels_avg_watch_time_ms"),
  };
}

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
    directCredentialReads: [],
    mediaInventoryReads: [],
    refusedWrites: [],
    permits: [],
  };

  /**
   * The account and the capture day of every claimed job.
   *
   * A media snapshot belongs to the job that wrote it, so the double reads
   * the scope of the job and stores the row under it.
   */
  const jobScopes = new Map<string, { socialAccountId: string; capturedOn: string }>();

  /** The media rows the double holds, by account, capture day and media. */
  const mediaRows = new Map<string, OwnerMediaInventoryRow>();

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

  /**
   * The refusal the database raises for a write of one job.
   *
   * It is null for every other job, so a test can refuse the write of ONE
   * job and watch the others. The refusal is recorded, so a test can prove
   * WHICH write the database refused.
   */
  const refusalOf = (
    jobId: string | null | undefined,
    kind: string,
  ): OwnerWorkerStoreError | null => {
    if (options.writeFailure === undefined) return null;
    if (options.writeFailure.jobId !== jobId) return null;
    calls.refusedWrites.push({ jobId: jobId ?? "", kind });
    return new OwnerWorkerStoreError(
      options.writeFailure.failure,
      options.writeFailure.sqlstate ?? null,
    );
  };

  const store: OwnerCollectionServiceStore = {
    async claimOwnerJobs(input) {
      calls.claims.push({ limit: input.limit });
      if (options.hangOn === "claim") return await hang();
      if (options.failOn === "claim") {
        throw new Error("the claim failed");
      }
      const jobs = options.jobs ?? [];
      for (const job of jobs) {
        jobScopes.set(job.jobId, {
          socialAccountId: job.socialAccountId,
          capturedOn: job.capturedOn,
        });
      }
      return jobs;
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
        scopesAuthoritative: true,
        grantedScopes: ["instagram_basic", "instagram_manage_insights"],
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
        tokenExpiresAt: null,
        ...(account.credential ?? {}),
      };
    },

    async resolveDirectOwnerCredential(input) {
      calls.directCredentialReads.push({
        jobId: input.jobId,
        expectedCredentialGeneration: input.expectedCredentialGeneration,
      });
      const account = accountOf(input.socialAccountId);
      if (account.hangOn === "directCredential") return await hang();
      if (account.failOn === "directCredential") {
        throw new Error("the direct credential read failed");
      }
      if (account.directCredentialFailure) {
        throw new OwnerWorkerStoreError(account.directCredentialFailure);
      }
      return {
        jobId: input.jobId,
        userId: TEST_USER_ID,
        socialAccountId: input.socialAccountId,
        igUserId: TEST_IG_USER_ID,
        loginKind: "direct",
        credentialGeneration: input.expectedCredentialGeneration,
        accessToken: "the-direct-token",
        tokenExpiresAt: null,
        ...(account.directCredential ?? {}),
      };
    },

    async authorizeProviderCall(input): Promise<ProviderPermitDecision> {
      // The permit belongs to the JOB, so the account it belongs to is the
      // account the claim handed it out for.
      const scope = jobScopes.get(input.jobId);
      const account = scope === undefined ? options : accountOf(scope.socialAccountId);
      const permit = account.permit ?? { outcome: "allowed" as const };

      // The refusal counter is per JOB, so a test can refuse the permit
      // between two requests of one job without touching another job.
      const seen = calls.permits.filter((entry) => entry.jobId === input.jobId).length;
      const refuseAfter = account.refusePermitAfter;

      if (
        permit.outcome === "allowed" &&
        refuseAfter !== undefined &&
        seen >= refuseAfter
      ) {
        calls.permits.push({
          jobId: input.jobId,
          jobGeneration: input.jobGeneration,
          outcome: "refused",
        });
        return { kind: "refused", reasonCode: "collection_not_eligible" };
      }

      if (permit.outcome === "refused") {
        calls.permits.push({
          jobId: input.jobId,
          jobGeneration: input.jobGeneration,
          outcome: "refused",
        });
        return {
          kind: "refused",
          reasonCode: permit.reasonCode ?? "collection_not_eligible",
        };
      }

      if (permit.outcome === "unavailable") {
        calls.permits.push({
          jobId: input.jobId,
          jobGeneration: input.jobGeneration,
          outcome: "unavailable",
        });
        return {
          kind: "unavailable",
          reasonCode: permit.reasonCode ?? "permit_read_failed",
          auditStored: permit.auditStored ?? true,
        };
      }

      calls.permits.push({
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        outcome: "allowed",
      });
      return {
        kind: "allowed",
        permit: {
          allowed: true,
          jobId: input.jobId,
          targetKind: "owner",
          targetId: input.jobId,
          viewerSocialAccountId: input.jobId,
          jobGeneration: input.jobGeneration,
          credentialGeneration: 7,
          policyFingerprint: null,
        },
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
        // The row the SWEEP wrote wins: the read-back reports the media
        // type, the product type, the publication time, the public counts,
        // the stored metrics and the status that were really written for
        // this account and capture day.
        const written = mediaRows.get(
          mediaKey(input.socialAccountId, input.capturedOn, mediaId),
        );
        if (written !== undefined) {
          rows.push(written);
          continue;
        }

        // A media the sweep did not touch is answered from the rows an
        // EARLIER visit stored. A media nobody stored has no row at all:
        // the worker treats it as gone, and it is not owed any more.
        const stored = account.mediaInventory?.[mediaId];
        if (stored === undefined) continue;
        rows.push({ ...BASE_MEDIA_ROW, igMediaId: mediaId, ...stored });
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
      const refused = refusalOf(input.jobId, "snapshot");
      if (refused !== null) throw refused;
      calls.snapshots.push({ kind: input.payload.kind, items: input.payload.items });

      // A media snapshot IS the stored row: the read-back answers from it.
      if (input.payload.kind === "owner_media") {
        const scope = jobScopes.get(input.jobId);
        if (scope !== undefined) {
          for (const item of input.payload.items) {
            const mediaId = item.ig_media_id;
            if (typeof mediaId !== "string" || mediaId.length === 0) continue;
            mediaRows.set(
              mediaKey(scope.socialAccountId, scope.capturedOn, mediaId),
              mediaRowFromSnapshot(mediaId, item),
            );
          }
        }
      }

      return {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        written: input.payload.items.length,
      };
    },

    async recordProgress(input) {
      if (options.hangOn === "progress") return await hang();
      if (options.failOn === "progress") throw new Error("the progress write failed");
      const refused = refusalOf(input.jobId, "progress");
      if (refused !== null) throw refused;
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
      const refused = refusalOf(input.jobId, "complete");
      if (refused !== null) throw refused;
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

// ---------------------------------------------------------------------------
// The persisting store: ONE job across MANY visits
// ---------------------------------------------------------------------------

/**
 * WHY THE PERSISTING STORE EXISTS
 *
 *   The plain store double answers every call from the fixture, so a job
 *   never carries anything from one visit to the next. The accepted SQL
 *   does: the checkpoint, the open operations, the stored media and the
 *   status of the job survive the visit that wrote them, and the claim
 *   hands the job out again only while it is DUE.
 *
 *   This store keeps that state, so the SAME job can be driven through
 *   repeated `runOwnerDrain` visits:
 *
 *   - a `partial` job is due again after the continuation the accepted SQL
 *     gives it, so the next visit claims it and resumes the queue;
 *   - a `retry` job is due again after its backoff;
 *   - a `completed` and an `unavailable` job are TERMINAL: the claim never
 *     hands them out again.
 */

/** The status the accepted SQL holds for a collection job. */
export type PersistedJobStatus =
  | "queued"
  | "leased"
  | "partial"
  | "retry"
  | "completed"
  | "unavailable"
  | "error";

/**
 * The checkpoint of a persisted job, in the claim row's own key set.
 *
 * The claim row carries the checkpoint as it is, so the persisted state and
 * the claimed state are the same shape and no translation can hide a field.
 */
export interface PersistedCheckpoint {
  inventory_cursor: string | null;
  inventory_remaining_ids: string[];
  inventory_pages_fetched: number;
  inventory_partial: boolean;
  inventory_truncated: boolean;
  inventory_oldest_returned_at: string | null;
  inventory_window_start: string | null;
  inventory_window_end: string | null;
  inventory_window_covered: boolean;
  inventory_gap_reason: string | null;
}

/** The knobs of the persisting store. */
export interface PersistingStoreOptions {
  /** The clock. The claim and the due times are read from it. */
  readonly now: () => number;
  /** The lease the accepted SQL gives a claimed job. */
  readonly leaseMs?: number;
  /** The continuation the accepted SQL gives a partial job. */
  readonly continuationMs?: number;
  /** The backoff the accepted SQL gives a retryable job. */
  readonly retryDelayMs?: number;
  /** The credential generation the captured context carries. */
  readonly credentialGeneration?: number;
}

/** What the persisting store holds, as the accepted SQL holds it. */
export interface PersistingStoreState {
  /** The status of the job. */
  readonly status: () => PersistedJobStatus;
  /** The instant the job becomes due again. */
  readonly dueAt: () => number;
  /** The checkpoint of the job. */
  readonly checkpoint: () => PersistedCheckpoint;
  /** The operation keys that are still open. */
  readonly openOperations: () => readonly string[];
  /** How many times the job was claimed. */
  readonly claims: () => number;
  /** The completions the worker wrote, in order. */
  readonly completions: () => readonly { outcome: string; reasonCode: string | null }[];
  /** The media rows this capture day stores. */
  readonly media: () => readonly OwnerMediaInventoryRow[];
  /** The shared throttle bucket. */
  readonly bucket: () => OwnerThrottleBucket | null;
  /** The snapshots the worker wrote, in order. */
  readonly snapshots: () => readonly { kind: string; items: readonly Record<string, unknown>[] }[];
}

/**
 * The store that keeps a job across visits.
 *
 * It is the accepted SQL's job lifecycle and nothing else: the claim, the
 * checkpoint, the operations, the media rows, the completion and the
 * throttle.
 */
export function createPersistingStore(options: PersistingStoreOptions): {
  readonly store: OwnerCollectionServiceStore;
  readonly state: PersistingStoreState;
} {
  const leaseMs = options.leaseMs ?? 120_000;
  const continuationMs = options.continuationMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  const credentialGeneration = options.credentialGeneration ?? 7;

  let status: PersistedJobStatus = "queued";
  let dueAt = 0;
  let leaseExpiresAt = 0;
  let attempts = 0;
  let claimToken = TEST_CLAIM_TOKEN;
  let claimCount = 0;

  const checkpoint: PersistedCheckpoint = {
    inventory_cursor: null,
    inventory_remaining_ids: [],
    inventory_pages_fetched: 0,
    inventory_partial: false,
    inventory_truncated: false,
    inventory_oldest_returned_at: null,
    inventory_window_start: null,
    inventory_window_end: null,
    inventory_window_covered: false,
    inventory_gap_reason: null,
  };

  /** The operations of the job. Only a pending one keeps the job claimable. */
  const operations = new Map<string, string>();

  /** The media rows this capture day stores. */
  const media = new Map<string, OwnerMediaInventoryRow>();

  /** The shared throttle bucket. */
  let bucket: OwnerThrottleBucket | null = null;

  const completions: Array<{ outcome: string; reasonCode: string | null }> = [];
  const snapshots: Array<{ kind: string; items: readonly Record<string, unknown>[] }> = [];

  /** The operation keys that are still open. */
  const openOperations = (): string[] =>
    [...operations.entries()]
      .filter(([, state]) => state === "pending" || state === "failed")
      .map(([key]) => key);

  /** The claim row of the job, as the accepted SQL builds it. */
  const claimRow = () => ({
    job_id: TEST_JOB_ID,
    user_id: TEST_USER_ID,
    target_kind: "owner",
    target_id: TEST_ACCOUNT_ID,
    social_account_id: TEST_ACCOUNT_ID,
    watchlist_id: null,
    captured_on: TEST_CAPTURED_ON,
    job_generation: 1,
    claim_token: claimToken,
    lease_expires_at: new Date(leaseExpiresAt).toISOString(),
    attempts,
    context: {
      viewer_social_account_id: TEST_ACCOUNT_ID,
      credential_generation: credentialGeneration,
      login_kind: "page_linked",
      capability_present: true,
      permission_read_state: "ok",
      granted_scopes: ["instagram_basic", "instagram_manage_insights"],
    },
    checkpoint: { ...checkpoint },
    pending_operations: openOperations().map((operation_key) => ({ operation_key })),
    claimed_at: new Date(options.now()).toISOString(),
  });

  const store: OwnerCollectionServiceStore = {
    async claimOwnerJobs(input) {
      void input;
      const now = options.now();

      // The accepted claim predicate: the status must be one the claim
      // selects, the job must be due, and its lease must be free.
      if (status === "completed" || status === "unavailable" || status === "error") {
        return [];
      }
      if (status === "leased" && leaseExpiresAt > now) return [];
      if (dueAt > now) return [];

      status = "leased";
      attempts += 1;
      claimCount += 1;
      leaseExpiresAt = now + leaseMs;
      claimToken = claimTokenFor(claimCount);

      // The row goes through the production parser, so a claim the
      // database would not have returned never reaches the worker.
      const parsed = parseClaimedOwnerJob(claimRow());
      if (parsed === null) {
        throw new Error("the persisted claim row does not match the projection");
      }
      return [parsed];
    },

    async readOwnerTarget(input) {
      return {
        socialAccountId: input.socialAccountId,
        userId: input.userId,
        platformUserId: TEST_IG_USER_ID,
      };
    },

    async readOwnerCapability() {
      return {
        loginKind: "page_linked",
        credentialGeneration,
        scopesAuthoritative: true,
        grantedScopes: ["instagram_basic", "instagram_manage_insights"],
      };
    },

    async resolveOwnerCredential() {
      return {
        token: "the-secret-token",
        credentialId: TEST_CREDENTIAL_ID,
        capabilityGeneration: credentialGeneration,
        tokenExpiresAt: null,
      };
    },

    async authorizeProviderCall(input): Promise<ProviderPermitDecision> {
      return {
        kind: "allowed",
        permit: {
          allowed: true,
          jobId: input.jobId,
          targetKind: "owner",
          targetId: TEST_ACCOUNT_ID,
          viewerSocialAccountId: TEST_ACCOUNT_ID,
          jobGeneration: input.jobGeneration,
          credentialGeneration,
          policyFingerprint: null,
        },
      };
    },

    async resolveDirectOwnerCredential(input) {
      return {
        jobId: input.jobId,
        userId: TEST_USER_ID,
        socialAccountId: input.socialAccountId,
        igUserId: TEST_IG_USER_ID,
        loginKind: "direct",
        credentialGeneration: input.expectedCredentialGeneration,
        accessToken: "the-direct-token",
        tokenExpiresAt: null,
      };
    },

    async readOwnerMediaInventory(input) {
      const rows: OwnerMediaInventoryRow[] = [];
      for (const mediaId of input.mediaIds) {
        const row = media.get(mediaId);
        if (row === undefined) continue;
        rows.push(row);
      }
      return rows;
    },

    async readThrottleBucket() {
      return bucket;
    },

    async persistSnapshot(input) {
      snapshots.push({ kind: input.payload.kind, items: input.payload.items });

      if (input.payload.kind === "owner_media") {
        for (const item of input.payload.items) {
          const mediaId = item.ig_media_id;
          if (typeof mediaId !== "string" || mediaId.length === 0) continue;
          media.set(mediaId, mediaRowFromSnapshot(mediaId, item));
          // The accepted SQL closes the media operation with the snapshot.
          operations.set(`media:${mediaId}`, "success");
        }
      }

      if (input.payload.kind === "owner_account_day") {
        for (const item of input.payload.items) {
          const providerDate = item.provider_date;
          const queryKind = item.query_kind;
          if (typeof providerDate !== "string" || typeof queryKind !== "string") continue;
          operations.set(`account_day:${providerDate}:${queryKind}`, "success");
        }
      }

      return {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        written: input.payload.items.length,
      };
    },

    async recordProgress(input) {
      if (input.payload.kind === "operations") {
        for (const item of input.payload.items) {
          operations.set(item.operation_key, item.state);
        }
        return {
          jobId: input.jobId,
          jobGeneration: input.jobGeneration,
          recorded: input.payload.items.length,
          inventory: false,
        };
      }

      checkpoint.inventory_cursor = input.payload.cursor;
      checkpoint.inventory_remaining_ids = [...input.payload.remaining_ids];
      checkpoint.inventory_pages_fetched = input.payload.pages_fetched;
      checkpoint.inventory_oldest_returned_at = input.payload.oldest_returned_at;
      checkpoint.inventory_window_start = input.payload.window_start;
      checkpoint.inventory_window_end = input.payload.window_end;
      checkpoint.inventory_partial = input.payload.partial;
      checkpoint.inventory_truncated = input.payload.truncated;
      checkpoint.inventory_window_covered = input.payload.window_covered;
      checkpoint.inventory_gap_reason = input.payload.gap_reason;

      return {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        recorded: null,
        inventory: true,
      };
    },

    async completeJob(input) {
      completions.push({ outcome: input.outcome, reasonCode: input.reasonCode });

      const now = options.now();
      if (input.outcome === "completed") {
        status = "completed";
      } else if (input.outcome === "partial") {
        // The accepted SQL queues the job again one minute later.
        status = "partial";
        dueAt = now + continuationMs;
      } else if (input.outcome === "retry") {
        status = "retry";
        dueAt = now + retryDelayMs;
      } else if (input.outcome === "unavailable") {
        // A terminal, classified outcome: the job is never claimed again.
        status = "unavailable";
      } else {
        status = "error";
      }

      leaseExpiresAt = 0;

      return {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        status,
        outcome: input.outcome,
        reasonCode: input.reasonCode,
      };
    },

    async recordThrottle(input) {
      const existing = bucket?.throttledUntil ?? null;
      const incoming = input.throttledUntil ?? null;
      const throttledUntil = existing === null
        ? incoming
        : incoming === null
        ? existing
        : Date.parse(incoming) > Date.parse(existing)
        ? incoming
        : existing;

      bucket = {
        usagePercent: input.usagePercent ?? bucket?.usagePercent ?? null,
        throttledUntil,
      };

      // A named job is parked: the accepted SQL releases the lease and puts
      // the job into a retry that is due when the window ends.
      if (input.jobId !== null && input.jobId !== undefined) {
        status = "retry";
        dueAt = throttledUntil === null ? options.now() + retryDelayMs : Date.parse(throttledUntil);
        leaseExpiresAt = 0;
      }
    },
  };

  const state: PersistingStoreState = {
    status: () => status,
    dueAt: () => dueAt,
    checkpoint: () => ({ ...checkpoint, inventory_remaining_ids: [...checkpoint.inventory_remaining_ids] }),
    openOperations: () => openOperations(),
    claims: () => claimCount,
    completions: () => completions.map((entry) => ({ ...entry })),
    media: () => [...media.values()],
    bucket: () => bucket,
    snapshots: () => snapshots.map((entry) => ({ ...entry })),
  };

  return { store, state };
}

/**
 * The claim token of the nth claim.
 *
 * Every claim carries its own token, so a write of an earlier visit is
 * never mistaken for a write of this one.
 */
function claimTokenFor(claims: number): string {
  return `01810004-0000-4000-8000-${String(claims).padStart(12, "0")}`;
}
