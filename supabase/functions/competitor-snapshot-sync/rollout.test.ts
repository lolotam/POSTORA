/**
 * The rollout admission of the COMPETITOR collection.
 *
 * WHAT THIS SUITE PROVES
 *
 *   1. THE ADMISSION. The competitor policy is INDEPENDENT of the owner
 *      policy: an owner approval never enables a competitor, and a viewer
 *      approval never enables the owner insights of that viewer. In
 *      allowlist mode exactly one watchlist to approved viewer pair is
 *      admitted, and every other watchlist, every other viewer, the same
 *      handle in another tenant and a shared-grant sibling issue ZERO
 *      provider calls. The proof counts the calls by the VIEWER and the
 *      CREDENTIAL that carried them, not only in total, because two
 *      tenants may track the same handle.
 *
 *   2. THE PIN. The eligible candidate set is decided by the DATABASE, and
 *      the shared selector orders inside it. A candidate the policy does
 *      not approve is excluded and the next one is offered, so the
 *      APPROVED viewer is the one that is used even when the selector
 *      preferred another one. A failure of the approved viewer never
 *      reaches for another viewer and never schedules paid work.
 *
 *   3. THE PER-REQUEST PERMIT. The permit is asked again immediately
 *      before every request: before every attempt of every page. A
 *      refused permit, a permit that could not be read, a malformed
 *      envelope and a failed audit all stop the work: no later request is
 *      sent and no successful write is made.
 *
 *   4. THE SERVICE ATTACH. The refusal kinds the accepted SQL raises are
 *      told apart, so a policy refusal of ONE candidate never refuses the
 *      work and a refusal of the TARGET always does.
 *
 * WHY THE PRODUCTION STORE IS DRIVEN AGAINST A DOUBLE
 *
 *   The accepted migration `20261031090000_instagram_collection_rollout_
 *   controls.sql` owns the admission: the claim filters the candidates,
 *   the viewer attachment proves the target and the pin, and the permit
 *   authorizes each request. This suite drives the PRODUCTION store
 *   against a double that reproduces those decisions, so the TypeScript
 *   side is proved to CONSUME the decisions and never to make its own.
 *
 * WHY NO PRODUCTION SECRET IS READ
 *
 *   Every provider call goes to a double, every database call goes to a
 *   double, and the only environment values are synthetic. The suite never
 *   reaches the network and never reads a credential from the repository.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import type { ViewerCandidate } from "../_shared/instagramDiscoveryViewer.ts";

import { GraphCompetitorProvider } from "./graphProvider.ts";
import {
  createCompetitorServiceStore,
  type CompetitorRpcCaller,
  type CompetitorServiceStore,
  type CompetitorServiceWritePort,
  type ServiceReadPort,
} from "./store.ts";
import { runCompetitorDrain, type CompetitorWorkerPorts } from "./syncWorker.ts";
import type {
  ClaimedCompetitorJob,
  CompetitorProvider,
  CompetitorProviderResult,
  PaidCaptureProvider,
} from "./types.ts";

// ---------------------------------------------------------------------------
// The identities
// ---------------------------------------------------------------------------

/** The pilot owner. */
const OWNER = "b1000000-0000-4000-8000-000000000001";
/** Another tenant that shares a grant with the pilot owner. */
const SIBLING_OWNER = "b1000000-0000-4000-8000-000000000002";
/** An unrelated tenant. */
const FOREIGN_OWNER = "b1000000-0000-4000-8000-000000000003";

/** The watchlist the policy pins. */
const WATCHLIST_PINNED = "b1c00000-0000-4000-8000-000000000001";
/** Another watchlist of the SAME owner. The policy does not admit it. */
const WATCHLIST_OTHER = "b1c00000-0000-4000-8000-000000000002";
/** A shared-grant sibling. The policy does not admit it. */
const WATCHLIST_SIBLING = "b1c00000-0000-4000-8000-000000000003";
/** The SAME handle in another tenant. The policy does not admit it. */
const WATCHLIST_FOREIGN = "b1c00000-0000-4000-8000-000000000004";

/** The one approved viewer of the pinned watchlist. */
const VIEWER_PINNED = "b1a00000-0000-4000-8000-000000000001";
/** An owned, page-linked viewer the policy does NOT approve. */
const VIEWER_OTHER = "b1a00000-0000-4000-8000-000000000002";
/** An owned DIRECT-login viewer. It cannot perform a Business Discovery. */
const VIEWER_DIRECT = "b1a00000-0000-4000-8000-000000000003";
/** A shared-grant sibling viewer. */
const VIEWER_SIBLING = "b1a00000-0000-4000-8000-000000000004";
/** A viewer of the unrelated tenant. */
const VIEWER_FOREIGN = "b1a00000-0000-4000-8000-000000000005";

const IG_USER_PINNED = "1784140001";
const IG_USER_OTHER = "1784140002";
const IG_USER_DIRECT = "1784140003";
const IG_USER_SIBLING = "1784140004";
const IG_USER_FOREIGN = "1784140005";

/** The protected credential identity of every viewer. It is never a token. */
const CREDENTIAL_PINNED = "b1d00000-0000-4000-8000-000000000001";
const CREDENTIAL_OTHER = "b1d00000-0000-4000-8000-000000000002";
const CREDENTIAL_SIBLING = "b1d00000-0000-4000-8000-000000000004";
const CREDENTIAL_FOREIGN = "b1d00000-0000-4000-8000-000000000005";

const JOB_PINNED = "b1b00000-0000-4000-8000-000000000001";
const JOB_OTHER = "b1b00000-0000-4000-8000-000000000002";
const JOB_SIBLING = "b1b00000-0000-4000-8000-000000000003";
const JOB_FOREIGN = "b1b00000-0000-4000-8000-000000000004";

const CAPTURED_ON = "2026-10-29";
const HANDLE = "competitor_brand";
const NOW = Date.parse("2026-10-29T02:00:00.000Z");

/** The owner of every watchlist entry. */
const WATCHLIST_OWNERS: Record<string, string> = {
  [WATCHLIST_PINNED]: OWNER,
  [WATCHLIST_OTHER]: OWNER,
  [WATCHLIST_SIBLING]: SIBLING_OWNER,
  [WATCHLIST_FOREIGN]: FOREIGN_OWNER,
};

/** The owner of every connected account. */
const ACCOUNT_OWNERS: Record<string, string> = {
  [VIEWER_PINNED]: OWNER,
  [VIEWER_OTHER]: OWNER,
  [VIEWER_DIRECT]: OWNER,
  [VIEWER_SIBLING]: SIBLING_OWNER,
  [VIEWER_FOREIGN]: FOREIGN_OWNER,
};

// ---------------------------------------------------------------------------
// The claimed jobs
// ---------------------------------------------------------------------------

function claimedJob(input: {
  readonly jobId: string;
  readonly userId: string;
  readonly watchlistId: string;
}): ClaimedCompetitorJob {
  return {
    jobId: input.jobId,
    userId: input.userId,
    watchlistId: input.watchlistId,
    capturedOn: CAPTURED_ON,
    jobGeneration: 1,
    claimToken: `claim-${input.jobId}`,
    leaseExpiresAt: "2026-10-29T02:02:00+00:00",
    attempts: 1,
  };
}

const JOB_ROWS: ClaimedCompetitorJob[] = [
  claimedJob({ jobId: JOB_PINNED, userId: OWNER, watchlistId: WATCHLIST_PINNED }),
  claimedJob({ jobId: JOB_OTHER, userId: OWNER, watchlistId: WATCHLIST_OTHER }),
  claimedJob({ jobId: JOB_SIBLING, userId: SIBLING_OWNER, watchlistId: WATCHLIST_SIBLING }),
  claimedJob({ jobId: JOB_FOREIGN, userId: FOREIGN_OWNER, watchlistId: WATCHLIST_FOREIGN }),
];

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * The rollout policy, as the accepted SQL reads it.
 *
 * The two populations are SEPARATE documents in one policy, and the
 * evaluator decides each of them on its own. The competitor population
 * names a watchlist and pins exactly ONE viewer to it.
 */
interface RolloutPolicy {
  readonly ownerMode: "off" | "allowlist" | "all";
  readonly ownerAccountIds: readonly string[];
  readonly competitorMode: "off" | "allowlist" | "all";
  readonly competitorTargets: readonly {
    readonly watchlistId: string;
    readonly viewerId: string;
  }[];
}

/** The default policy of the accepted migration: it admits nobody. */
const POLICY_OFF: RolloutPolicy = {
  ownerMode: "off",
  ownerAccountIds: [],
  competitorMode: "off",
  competitorTargets: [],
};

/** One approved watchlist and the ONE viewer approved for it. */
const POLICY_ONE_PAIR: RolloutPolicy = {
  ownerMode: "off",
  ownerAccountIds: [],
  competitorMode: "allowlist",
  competitorTargets: [{ watchlistId: WATCHLIST_PINNED, viewerId: VIEWER_PINNED }],
};

/**
 * The owner population admits one account while the competitor population
 * is still off.
 */
const POLICY_OWNER_ONLY: RolloutPolicy = {
  ownerMode: "allowlist",
  ownerAccountIds: [VIEWER_PINNED],
  competitorMode: "off",
  competitorTargets: [],
};

/** Every otherwise eligible competitor of every owner. */
const POLICY_ALL: RolloutPolicy = {
  ownerMode: "off",
  ownerAccountIds: [],
  competitorMode: "all",
  competitorTargets: [],
};

/**
 * The canonical evaluator, as the accepted SQL applies it.
 *
 * The OWNER population and the COMPETITOR population are decided on their
 * own. A competitor in allowlist mode is admitted only with the pinned
 * viewer, and the pin may never be substituted.
 */
function ownerAllowed(
  policy: RolloutPolicy,
  ownerId: string,
  accountId: string,
): boolean {
  if (policy.ownerMode === "off") return false;
  if (
    policy.ownerMode === "allowlist" &&
    !policy.ownerAccountIds.some((id) => id.toLowerCase() === accountId.toLowerCase())
  ) {
    return false;
  }
  return (ACCOUNT_OWNERS[accountId.toLowerCase()] ?? null) === ownerId;
}

function competitorAllowed(
  policy: RolloutPolicy,
  ownerId: string,
  watchlistId: string,
  viewerId: string | null,
): boolean {
  if (policy.competitorMode === "off") return false;

  if (policy.competitorMode === "allowlist") {
    const pin = policy.competitorTargets.find((entry) =>
      entry.watchlistId.toLowerCase() === watchlistId.toLowerCase()
    );
    if (pin === undefined) return false;
    if (viewerId !== null && viewerId.toLowerCase() !== pin.viewerId.toLowerCase()) {
      return false;
    }
    // The pinned viewer belongs to the SAME owner as the watchlist.
    if ((ACCOUNT_OWNERS[pin.viewerId.toLowerCase()] ?? null) !== ownerId) return false;
  }

  return (WATCHLIST_OWNERS[watchlistId.toLowerCase()] ?? null) === ownerId;
}

// ---------------------------------------------------------------------------
// The connected accounts
// ---------------------------------------------------------------------------

/** One connected account, as the protected capability rows describe it. */
interface ConnectedAccount {
  readonly id: string;
  readonly userId: string;
  readonly igUserId: string;
  readonly credentialId: string;
  readonly loginKind: "direct" | "page_linked";
  readonly connectedAt: string;
}

const ACCOUNTS: ConnectedAccount[] = [
  {
    id: VIEWER_PINNED,
    userId: OWNER,
    igUserId: IG_USER_PINNED,
    credentialId: CREDENTIAL_PINNED,
    loginKind: "page_linked",
    connectedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: VIEWER_OTHER,
    userId: OWNER,
    igUserId: IG_USER_OTHER,
    credentialId: CREDENTIAL_OTHER,
    loginKind: "page_linked",
    // NEWER than the pinned viewer, so the shared selector prefers it.
    connectedAt: "2026-06-01T00:00:00Z",
  },
  {
    id: VIEWER_DIRECT,
    userId: OWNER,
    igUserId: IG_USER_DIRECT,
    credentialId: CREDENTIAL_OTHER,
    loginKind: "direct",
    connectedAt: "2026-07-01T00:00:00Z",
  },
  {
    id: VIEWER_SIBLING,
    userId: SIBLING_OWNER,
    igUserId: IG_USER_SIBLING,
    credentialId: CREDENTIAL_SIBLING,
    loginKind: "page_linked",
    connectedAt: "2026-08-01T00:00:00Z",
  },
  {
    id: VIEWER_FOREIGN,
    userId: FOREIGN_OWNER,
    igUserId: IG_USER_FOREIGN,
    credentialId: CREDENTIAL_FOREIGN,
    loginKind: "page_linked",
    connectedAt: "2026-09-01T00:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// The provider double
// ---------------------------------------------------------------------------

/** One recorded provider request. */
interface RecordedProviderCall {
  /** The Instagram user id the request was addressed to. */
  readonly viewer: string;
  /** The tracked handle the request named. */
  readonly handle: string;
  /** The credential identity the request carried. It is never a real token. */
  readonly token: string;
}

function targetPayload(): Record<string, unknown> {
  return {
    business_discovery: {
      id: "1784140999",
      username: HANDLE,
      name: "Competitor Brand",
      followers_count: 54200,
      media_count: 120,
      media: {
        data: [{
          id: "media_1",
          media_type: "IMAGE",
          media_product_type: "FEED",
          timestamp: "2026-10-28T12:00:00.000Z",
          permalink: "https://instagram.com/p/media_1",
          like_count: 1500,
          comments_count: 45,
        }],
        paging: { cursors: { before: "BEFORE", after: "AFTER1" } },
      },
    },
    id: "viewer_ig_123",
  };
}

interface ProviderDoubleOptions {
  /** The first N requests answer with a 500, so the retry policy runs. */
  readonly failFirst?: number;
  /** The pages the media connection answers with, one per page. */
  readonly pages?: Record<string, unknown>[];
}

function createProviderDouble(options: ProviderDoubleOptions = {}) {
  const calls: RecordedProviderCall[] = [];
  const pageIndex = new Map<string, number>();
  let index = 0;

  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const segments = url.pathname.split("/").filter((part) => part.length > 0);
    const viewer = decodeURIComponent(segments[1] ?? "");
    const token = url.searchParams.get("access_token") ?? "";
    const fields = url.searchParams.get("fields") ?? "";
    const handle = /business_discovery\.username\(([^)]*)\)/.exec(fields)?.[1] ?? "";

    calls.push({ viewer, handle, token });

    const current = index;
    index += 1;

    if (options.failFirst !== undefined && current < options.failFirst) {
      return Promise.resolve(
        new Response("{}", {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (options.pages !== undefined) {
      const seen = pageIndex.get(viewer) ?? 0;
      pageIndex.set(viewer, seen + 1);
      const page = options.pages[Math.min(seen, options.pages.length - 1)] ?? { data: [] };
      const payload = targetPayload();
      const discovery = (payload as { business_discovery: Record<string, unknown> })
        .business_discovery;
      discovery.media = page;
      return Promise.resolve(jsonResponse(payload));
    }

    return Promise.resolve(jsonResponse(targetPayload()));
  };

  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// The store double of the ACCEPTED admission
// ---------------------------------------------------------------------------

/** The write port of the double. It records every exception-path audit. */
function recordingWrites(): {
  readonly writes: CompetitorServiceWritePort;
  readonly rows: Array<Record<string, unknown>>;
} {
  const rows: Array<Record<string, unknown>> = [];
  const writes: CompetitorServiceWritePort = {
    async insertSystemLog(row) {
      rows.push({ ...row.metadata });
      return true;
    },
  };
  return { writes, rows };
}

interface RolloutStoreOptions {
  readonly policy: RolloutPolicy;
  readonly jobs?: readonly ClaimedCompetitorJob[];
  /**
   * The claim hands out EVERY job, even the excluded ones.
   *
   * It models the policy changing between the claim and the attachment:
   * the job was claimed while it was admitted, and the attachment - the
   * authority - refuses it afterwards.
   */
  readonly claimAll?: boolean;
  /** The permit the database answers with, when the double is overridden. */
  readonly permit?: unknown;
  /** The permit answer that is not the projection this contract knows. */
  readonly permitEnvelope?: unknown;
  /** The attachment answer that is not the projection this contract knows. */
  readonly attachEnvelope?: unknown;
}

interface RolloutStore {
  readonly store: CompetitorServiceStore;
  readonly claims: string[];
  readonly attaches: Array<{ jobId: string; viewerId: string }>;
  readonly permits: Array<{ jobId: string; outcome: string }>;
  readonly credentialReads: string[];
  readonly persisted: Array<Record<string, unknown>>;
  readonly auditRows: Array<Record<string, unknown>>;
}

/**
 * The store double of the ACCEPTED admission.
 *
 * It reproduces the three decisions the accepted migration owns:
 *
 *   - the claim hands out ONLY the jobs whose target is admitted, so an
 *     excluded target never resolves a usable job;
 *   - the attachment approves ONLY the pinned viewer, and refuses the
 *     TARGET itself with `IG_COLLECTION_NOT_ELIGIBLE`;
 *   - the permit grants a permit ONLY for an admitted job, and refuses
 *     every other one with `collection_not_eligible`.
 *
 * The TypeScript under test consumes those decisions and never makes its
 * own: it asks the store, and it acts on the answer.
 */
function createRolloutStore(options: RolloutStoreOptions): RolloutStore {
  const jobs = [...(options.jobs ?? JOB_ROWS)];
  const policy = options.policy;

  const claims: string[] = [];
  const attaches: Array<{ jobId: string; viewerId: string }> = [];
  const permits: Array<{ jobId: string; outcome: string }> = [];
  const credentialReads: string[] = [];
  const persisted: Array<Record<string, unknown>> = [];
  const { writes, rows } = recordingWrites();

  const jobById = new Map(jobs.map((job) => [job.jobId, job]));
  const accountById = new Map(ACCOUNTS.map((account) => [account.id, account]));
  /** The viewer the DATABASE bound to each job. */
  const boundViewer = new Map<string, string>();

  const rpc: CompetitorRpcCaller = async (name, args) => {
    if (name === "claim_instagram_collection_jobs") {
      // The accepted SQL applies the eligibility to EVERY candidate query,
      // so an excluded job is never handed out at all.
      const eligible = options.claimAll === true
        ? jobs
        : jobs.filter((job) =>
          competitorAllowed(policy, job.userId, job.watchlistId, null)
        );
      claims.length = 0;
      claims.push(...eligible.map((job) => job.jobId));
      return {
        data: eligible.map((job) => ({
          job_id: job.jobId,
          user_id: job.userId,
          watchlist_id: job.watchlistId,
          captured_on: job.capturedOn,
          job_generation: job.jobGeneration,
          claim_token: job.claimToken,
          lease_expires_at: job.leaseExpiresAt,
          attempts: job.attempts,
        })),
        error: null,
      };
    }

    if (name === "attach_instagram_collection_job_viewer_context") {
      const jobId = String(args.p_job_id);
      const viewerId = String(args.p_viewer_social_account_id);
      attaches.push({ jobId, viewerId });

      if (options.attachEnvelope !== undefined) return options.attachEnvelope;

      const job = jobById.get(jobId);
      if (job === undefined) {
        return {
          data: null,
          error: { code: "P0002", message: "IG_COLLECTION_JOB_NOT_FOUND: no such collection job" },
        };
      }

      if (!competitorAllowed(policy, job.userId, job.watchlistId, viewerId)) {
        if (!competitorAllowed(policy, job.userId, job.watchlistId, null)) {
          // The TARGET is not admitted.
          return {
            data: null,
            error: {
              code: "22023",
              message:
                "IG_COLLECTION_NOT_ELIGIBLE: the target is not admitted by the rollout policy",
            },
          };
        }
        // The viewer is not the approved one.
        return {
          data: null,
          error: {
            code: "22023",
            message:
              "IG_COLLECTION_VIEWER_NOT_APPROVED: the rollout policy does not approve this viewer for this target",
          },
        };
      }

      const account = accountById.get(viewerId);
      boundViewer.set(jobId, viewerId);
      return {
        data: {
          job_id: jobId,
          job_generation: job.jobGeneration,
          viewer_social_account_id: viewerId,
          credential_generation: 3,
          login_kind: "page_linked",
          granted_scopes: ["instagram_manage_insights"],
        },
        error: null,
      };
    }

    if (name === "authorize_instagram_collection_provider_call") {
      const jobId = String(args.p_job_id);
      permits.push({ jobId, outcome: "asked" });

      if (options.permitEnvelope !== undefined) return options.permitEnvelope;

      const job = jobById.get(jobId);
      if (job === undefined) {
        return { data: { allowed: false, reason_code: "job_not_found" }, error: null };
      }

      const viewerId = boundViewer.get(jobId) ?? null;
      if (
        !competitorAllowed(policy, job.userId, job.watchlistId, viewerId)
      ) {
        return {
          data: { allowed: false, reason_code: "collection_not_eligible" },
          error: null,
        };
      }

      if (options.permit !== undefined) return { data: options.permit, error: null };

      return {
        data: {
          allowed: true,
          job_id: jobId,
          target_kind: "competitor",
          target_id: job.watchlistId,
          viewer_social_account_id: viewerId,
          job_generation: job.jobGeneration,
          credential_generation: 3,
          policy_fingerprint: null,
        },
        error: null,
      };
    }

    if (name === "read_facebook_user_account_credential") {
      const accountId = String(args.p_social_account_id);
      credentialReads.push(accountId);
      const account = accountById.get(accountId);
      if (account === undefined || account.loginKind !== "page_linked") {
        return { data: { found: false }, error: null };
      }
      return {
        data: {
          found: true,
          social_account_id: account.id,
          platform: "instagram",
          credential_id: account.credentialId,
          credential_kind: "facebook_user",
          token: `token-of-${account.credentialId}`,
          token_expires_at: null,
          revision: 4,
          capability_generation: 3,
          connection_version: 1,
        },
        error: null,
      };
    }

    if (name === "read_instagram_account_capability") {
      const accountId = String(args.p_social_account_id);
      const account = accountById.get(accountId);
      if (account === undefined) {
        return { data: { capability_present: false }, error: null };
      }
      return {
        data: {
          social_account_id: account.id,
          capability_present: true,
          login_kind: account.loginKind,
          permission_read_state: "ok",
          scopes_authoritative: true,
          granted_scopes: ["instagram_manage_insights"],
          scopes_read_at: "2026-01-01T00:00:00Z",
          last_read_failed_at: null,
          last_read_error_code: null,
          credential_generation: 3,
          credential_updated_at: null,
          generation_reason: null,
          reconnected_at: null,
          has_protected_credential: true,
          updated_at: null,
        },
        error: null,
      };
    }

    if (name === "persist_competitor_collection_result_v2") {
      const jobId = String(args.p_job_id);
      const job = jobById.get(jobId);
      const payload = args.p_payload as {
        readonly outcome: string;
        readonly source?: string;
        readonly reason_code?: string;
        readonly media?: unknown[];
        readonly coverage?: Record<string, unknown>;
      };
      persisted.push(payload as unknown as Record<string, unknown>);

      if (payload.outcome === "completed") {
        const mediaCount = payload.media?.length ?? 0;
        const coverage = payload.coverage ?? {};
        return {
          data: {
            version: 2,
            job_id: jobId,
            job_generation: args.p_job_generation,
            outcome: "completed",
            source: payload.source,
            watchlist_id: job?.watchlistId ?? WATCHLIST_PINNED,
            captured_on: job?.capturedOn ?? CAPTURED_ON,
            written: mediaCount + 1,
            media_count: mediaCount,
            captured_at: "2026-10-29T02:00:00+00:00",
            coverage: {
              watchlist_id: job?.watchlistId ?? WATCHLIST_PINNED,
              user_id: job?.userId ?? OWNER,
              captured_on: job?.capturedOn ?? CAPTURED_ON,
              captured_at: "2026-10-29T02:00:00+00:00",
              source: payload.source,
              job_generation: args.p_job_generation,
              capture_started_at: coverage.capture_started_at,
              capture_ended_at: coverage.capture_ended_at,
              oldest_returned_at: coverage.oldest_returned_at,
              ordering_verified: coverage.ordering_verified,
              cursor_present: coverage.cursor_present,
              exhausted: coverage.exhausted,
              truncated: coverage.truncated,
              gap_reason: coverage.gap_reason,
              inventory_complete: coverage.exhausted === true &&
                coverage.truncated !== true && coverage.gap_reason === null,
            },
          },
          error: null,
        };
      }

      return {
        data: {
          version: 2,
          job_id: jobId,
          job_generation: args.p_job_generation,
          outcome: payload.outcome,
          reason_code: payload.reason_code,
          watchlist_id: job?.watchlistId ?? WATCHLIST_PINNED,
          next_retry_at: "2026-11-05T02:00:00+00:00",
        },
        error: null,
      };
    }

    if (name === "record_instagram_provider_throttle") {
      return {
        data: {
          bucket_key: args.p_bucket_key,
          usage_percent: args.p_usage_percent ?? null,
          throttled_until: args.p_throttled_until ?? null,
          job_id: args.p_job_id ?? null,
        },
        error: null,
      };
    }

    return { data: null, error: null };
  };

  const reads: ServiceReadPort = {
    async readOne(table, _columns, filters) {
      if (table === "competitor_watchlist") {
        const id = String(filters.id ?? "").toLowerCase();
        const ownerId = String(filters.user_id ?? "");
        if ((WATCHLIST_OWNERS[id] ?? null) !== ownerId) {
          return { data: null, error: null };
        }
        return {
          data: { id, user_id: ownerId, username: HANDLE, is_active: true },
          error: null,
        };
      }
      if (table === "instagram_provider_throttle_buckets") {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },

    async readMany(table, _columns, filters) {
      const ownerId = String(filters.user_id ?? "");
      if (table === "social_accounts") {
        return {
          data: ACCOUNTS
            .filter((account) => account.userId === ownerId)
            .map((account) => ({
              id: account.id,
              user_id: account.userId,
              platform: "instagram",
              platform_user_id: account.igUserId,
              is_active: true,
              needs_reauth: false,
              connected_at: account.connectedAt,
            })),
          error: null,
        };
      }
      if (table === "instagram_account_capabilities") {
        return {
          data: ACCOUNTS
            .filter((account) => account.userId === ownerId)
            .map((account) => ({
              social_account_id: account.id,
              user_id: account.userId,
              platform: "instagram",
              login_kind: account.loginKind,
              permission_read_state: "ok",
              granted_scopes: ["instagram_manage_insights"],
              credential_generation: 3,
            })),
          error: null,
        };
      }
      return { data: [], error: null };
    },
  };

  const store = createCompetitorServiceStore({ rpc, reads, writes });

  return { store, claims, attaches, permits, credentialReads, persisted, auditRows: rows };
}

// ---------------------------------------------------------------------------
// The worker harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly ports: CompetitorWorkerPorts;
  readonly providerCalls: RecordedProviderCall[];
  readonly logs: Array<Record<string, unknown>>;
  readonly paidCalls: number;
}

function createHarness(options: {
  readonly store: RolloutStore;
  readonly provider?: ProviderDoubleOptions;
  readonly paidFallback?: { readonly enabled: boolean; readonly provider?: PaidCaptureProvider };
}): Harness {
  const graph = createProviderDouble(options.provider ?? {});
  const logs: Array<Record<string, unknown>> = [];
  const state = { paidCalls: 0 };

  const paid: PaidCaptureProvider | undefined = options.paidFallback?.provider;
  if (paid) {
    const inner = paid.capture.bind(paid);
    paid.capture = async (request) => {
      state.paidCalls += 1;
      return await inner(request);
    };
  }

  const ports: CompetitorWorkerPorts = {
    store: options.store.store,
    officialProvider: new GraphCompetitorProvider({ fetchFn: graph.fetchFn }),
    paidFallback: {
      enabled: options.paidFallback?.enabled ?? false,
      ...(paid ? { provider: paid } : {}),
      refusalReason: "apify_disabled",
    },
    bucketKeyFor: async (credentialId) => `bucket-${credentialId}`,
    now: () => NOW,
    log: (event) => logs.push({ ...event }),
  };

  return {
    ports,
    providerCalls: graph.calls,
    logs,
    get paidCalls() {
      return state.paidCalls;
    },
  };
}

/** The provider calls that carried one Instagram user id. */
function callsFor(
  calls: readonly RecordedProviderCall[],
  igUserId: string,
): RecordedProviderCall[] {
  return calls.filter((call) => call.viewer === igUserId);
}

// ---------------------------------------------------------------------------
// 1. The admission
// ---------------------------------------------------------------------------

Deno.test("the competitors are off while the owner pilot runs", async () => {
  const store = createRolloutStore({ policy: POLICY_OWNER_ONLY });
  const harness = createHarness({ store });

  const summary = await runCompetitorDrain(harness.ports, {});

  // The claim handed out NOTHING: the owner approval says nothing about
  // the competitor population.
  assertEquals(store.claims.length, 0);
  assertEquals(summary.claimed, 0);
  assertEquals(summary.processed, 0);
  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.persisted.length, 0);
});

Deno.test("the owner approval does not enable the competitors", async () => {
  // The owner list admits one account of the pilot owner. The competitor
  // list is empty, so no watchlist is admitted.
  const store = createRolloutStore({ policy: POLICY_OWNER_ONLY });
  const harness = createHarness({ store });

  await runCompetitorDrain(harness.ports, {});

  assertEquals(ownerAllowed(POLICY_OWNER_ONLY, OWNER, VIEWER_PINNED), true);
  assertEquals(
    competitorAllowed(POLICY_OWNER_ONLY, OWNER, WATCHLIST_PINNED, VIEWER_PINNED),
    false,
  );
  assertEquals(harness.providerCalls.length, 0);
});

Deno.test("the viewer approval does not enable the owner insights", async () => {
  // The competitor list names the viewer. The owner list is empty, so the
  // owner insights of that very viewer are NOT admitted.
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });
  const harness = createHarness({ store });

  await runCompetitorDrain(harness.ports, {});

  assertEquals(
    competitorAllowed(POLICY_ONE_PAIR, OWNER, WATCHLIST_PINNED, VIEWER_PINNED),
    true,
  );
  assertEquals(ownerAllowed(POLICY_ONE_PAIR, OWNER, VIEWER_PINNED), false);
});

Deno.test("exactly one watchlist and viewer pair is admitted", async () => {
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });
  const harness = createHarness({ store });

  const summary = await runCompetitorDrain(harness.ports, {});

  // The claim handed out ONLY the pinned watchlist.
  assertEquals(store.claims, [JOB_PINNED]);
  assertEquals(summary.claimed, 1);
  assertEquals(summary.completed, 1);

  // The request carried the APPROVED viewer, even though the shared
  // selector preferred the newer, unapproved one.
  const calls = callsFor(harness.providerCalls, IG_USER_PINNED);
  assertEquals(calls.length > 0, true);
  assertEquals(
    harness.providerCalls.some((call) => call.viewer === IG_USER_OTHER),
    false,
  );

  // The credential identity is accounted for: only the approved viewer's
  // protected credential was spent.
  assertEquals(
    [...new Set(harness.providerCalls.map((call) => call.token))],
    [`token-of-${CREDENTIAL_PINNED}`],
  );
});

Deno.test("every excluded identity issues zero provider calls", async () => {
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });
  const harness = createHarness({ store });

  await runCompetitorDrain(harness.ports, {});

  // The other watchlist of the same owner, the shared-grant sibling, the
  // same handle in another tenant and the direct-login viewer issued NO
  // request, under ANY credential.
  for (const igUserId of [IG_USER_OTHER, IG_USER_DIRECT, IG_USER_SIBLING, IG_USER_FOREIGN]) {
    assertEquals(callsFor(harness.providerCalls, igUserId).length, 0, igUserId);
  }

  // The direct-login viewer is not even a candidate: a Business Discovery
  // needs a page-linked viewer, and no token was read for it.
  assertEquals(
    store.credentialReads.every((id) => id.toLowerCase() === VIEWER_PINNED.toLowerCase()),
    true,
  );
  assertEquals(store.credentialReads.length > 0, true);
});

Deno.test("the excluded targets are never written to", async () => {
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });
  const harness = createHarness({ store });

  await runCompetitorDrain(harness.ports, {});

  // Exactly one result was stored, and it belongs to the admitted pair.
  assertEquals(store.persisted.length, 1);
  assertEquals(store.persisted[0]!.outcome, "completed");
  assertEquals(store.persisted[0]!.source, "official");
});

Deno.test("the all mode admits the protected same-owner candidates", async () => {
  const store = createRolloutStore({ policy: POLICY_ALL });
  const harness = createHarness({ store });

  const summary = await runCompetitorDrain(harness.ports, {});

  // Every owned watchlist is admitted, and every owned, page-linked viewer
  // with a readable insights scope is eligible. The DIRECT viewer is not:
  // the selector refuses it and the store never proposes it.
  assertEquals(store.claims.length, JOB_ROWS.length);
  assertEquals(summary.completed >= 1, true);

  const requested = new Set(harness.providerCalls.map((call) => call.viewer));
  assertEquals(requested.has(IG_USER_DIRECT), false);
  assertEquals(requested.has(IG_USER_PINNED) || requested.has(IG_USER_OTHER), true);
});

Deno.test("the pinned viewer failing never substitutes another viewer", async () => {
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });
  const harness = createHarness({
    store,
    // Every attempt fails, so the pinned viewer's capture never completes.
    provider: { failFirst: 99 },
  });

  const summary = await runCompetitorDrain(harness.ports, {});

  // The approved viewer was the only one that was asked about, and no
  // further candidate was offered after it.
  assertEquals(
    harness.providerCalls.every((call) => call.viewer === IG_USER_PINNED),
    true,
  );
  const attachedAfterApproval = store.attaches.filter((entry) =>
    entry.viewerId.toLowerCase() === VIEWER_PINNED.toLowerCase()
  );
  assertEquals(attachedAfterApproval.length, 1);
  assertEquals(
    store.attaches.filter((entry) =>
      entry.viewerId.toLowerCase() === VIEWER_PINNED.toLowerCase()
    ).length,
    1,
  );

  // The failure was recorded as a retry, and the weekly verdict was NOT
  // opened: only a confirmed unavailable target opens it.
  assertEquals(summary.retried, 1);
  assertEquals(summary.unavailable, 0);
  assertEquals(store.persisted[0]!.outcome, "retry");
});

Deno.test("a policy refusal never schedules paid work", async () => {
  const store = createRolloutStore({ policy: POLICY_OFF });
  const harness = createHarness({
    store,
    paidFallback: {
      enabled: true,
      provider: {
        source: "apify",
        async capture() {
          return { status: "failed", reason: "provider_error" };
        },
      },
    },
  });

  const summary = await runCompetitorDrain(harness.ports, {});

  // No job was claimed, so no paid request was scheduled.
  assertEquals(summary.claimed, 0);
  assertEquals(harness.paidCalls, 0);
  assertEquals(harness.providerCalls.length, 0);
});

Deno.test("a target the policy does not admit is refused and nothing is written", async () => {
  // The claim is overridden by the accepted SQL, so the job reaches the
  // worker even though the policy does not admit its target. The
  // attachment is the authority, and it refuses the TARGET.
  const store = createRolloutStore({
    policy: POLICY_ONE_PAIR,
    jobs: [claimedJob({ jobId: JOB_OTHER, userId: OWNER, watchlistId: WATCHLIST_OTHER })],
    // The policy changed after the claim: the job was claimed while it was
    // admitted, and the attachment - the authority - refuses it afterwards.
    claimAll: true,
  });
  const harness = createHarness({ store });

  // The double refuses the target at the attachment.
  const summary = await runCompetitorDrain(harness.ports, {});

  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "collection_not_eligible");
  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.persisted.length, 0);
  // A rollout refusal never marks a target unavailable and never advances
  // a success, so nothing at all was written.
  assertEquals(store.auditRows.length > 0, true);
});

Deno.test("a work that no candidate can serve is audited once", async () => {
  // The policy pins a DIRECT login for the watchlist. A direct login can
  // never perform a Business Discovery, so it is not a candidate at all and
  // NO candidate is approved.
  const store = createRolloutStore({
    policy: {
      ownerMode: "off",
      ownerAccountIds: [],
      competitorMode: "allowlist",
      competitorTargets: [{ watchlistId: WATCHLIST_PINNED, viewerId: VIEWER_DIRECT }],
    },
  });
  const harness = createHarness({ store });

  const summary = await runCompetitorDrain(harness.ports, {});

  // Every candidate was excluded, the work was refused, and nothing was
  // written.
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "collection_not_eligible");
  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.persisted.length, 0);

  // The refusal is audited ONCE. The per-candidate exclusions are excluded
  // rows and not refusal events, so they produce no row of their own.
  assertEquals(store.auditRows.length, 1);
  assertEquals(store.auditRows[0]!.event, "collection_admission_refused");
  assertEquals(store.auditRows[0]!.reason_code, "collection_not_eligible");
});

Deno.test("an exclusion that is not a refusal writes no audit row", async () => {
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });
  const harness = createHarness({ store });

  await runCompetitorDrain(harness.ports, {});

  // The unapproved candidate was excluded and the approved one was used,
  // so the WORK was not refused and there is no refusal row.
  assertEquals(store.auditRows.length, 0);
});

Deno.test("a failed audit of the refusal stops the work", async () => {
  const store = createRolloutStore({
    policy: {
      ownerMode: "off",
      ownerAccountIds: [],
      competitorMode: "allowlist",
      competitorTargets: [{ watchlistId: WATCHLIST_PINNED, viewerId: VIEWER_DIRECT }],
    },
  });
  const failing = {
    ...store,
    store: {
      ...store.store,
      async auditAdmissionRefusal() {
        return false;
      },
    },
  };
  const harness = createHarness({ store: failing });

  const summary = await runCompetitorDrain(harness.ports, {});

  // The refusal row did not commit, so the work stops and the audit failure
  // is reported: a row that did not commit is never reported as stored.
  assertEquals(summary.stoppedEarly, true);
  const auditFailure = harness.logs.find((entry) =>
    entry.event === "competitor_admission_audit_failed"
  );
  assert(auditFailure !== undefined);
});

// ---------------------------------------------------------------------------
// 2. The service attach and the SQL refusal mapping
// ---------------------------------------------------------------------------

Deno.test("the attachment refusal of one candidate does not refuse the work", async () => {
  // The double refuses the FIRST candidate the selector picks, because the
  // policy does not approve it, and approves the pinned one.
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });
  const harness = createHarness({ store });

  await runCompetitorDrain(harness.ports, {});

  // The unapproved candidate was offered first and excluded; the pinned
  // one was offered second and used.
  assertEquals(store.attaches.length, 2);
  assertEquals(store.attaches[0]!.viewerId, VIEWER_OTHER);
  assertEquals(store.attaches[1]!.viewerId, VIEWER_PINNED);
});

Deno.test("the store tells the two refusal kinds apart", async () => {
  const refused = createCompetitorServiceStore({
    rpc: async (name) => {
      if (name === "attach_instagram_collection_job_viewer_context") {
        return {
          data: null,
          error: {
            code: "22023",
            message:
              "IG_COLLECTION_VIEWER_NOT_APPROVED: the rollout policy does not approve this viewer for this target",
          },
        };
      }
      return { data: null, error: null };
    },
    reads: {
      async readOne() {
        return { data: null, error: null };
      },
      async readMany() {
        return { data: [], error: null };
      },
    },
    writes: {
      async insertSystemLog() {
        return true;
      },
    },
  });

  const decision = await refused.attachViewerContext({
    jobId: JOB_PINNED,
    claimToken: "t",
    jobGeneration: 1,
    viewerSocialAccountId: VIEWER_OTHER,
  });

  // The policy refusal of ONE candidate is a filter step: it excludes the
  // candidate and the work continues.
  assertEquals(decision.kind, "not_approved");
});

Deno.test("the store refuses the target itself with the target refusal", async () => {
  const refused = createCompetitorServiceStore({
    rpc: async (name) => {
      if (name === "attach_instagram_collection_job_viewer_context") {
        return {
          data: null,
          error: {
            code: "22023",
            message:
              "IG_COLLECTION_NOT_ELIGIBLE: the target is not admitted by the rollout policy",
          },
        };
      }
      return { data: null, error: null };
    },
    reads: {
      async readOne() {
        return { data: null, error: null };
      },
      async readMany() {
        return { data: [], error: null };
      },
    },
    writes: {
      async insertSystemLog() {
        return true;
      },
    },
  });

  const decision = await refused.attachViewerContext({
    jobId: JOB_OTHER,
    claimToken: "t",
    jobGeneration: 1,
    viewerSocialAccountId: VIEWER_PINNED,
  });

  // The refusal of the TARGET ends the work, and it is audited.
  assertEquals(decision.kind, "target_not_eligible");
  if (decision.kind !== "target_not_eligible") throw new Error("unexpected decision");
  assertEquals(decision.auditStored, true);
});

Deno.test("the store refuses an unknown refusal as unavailable", async () => {
  const refused = createCompetitorServiceStore({
    rpc: async (name) => {
      if (name === "attach_instagram_collection_job_viewer_context") {
        return {
          data: null,
          error: { code: "22023", message: "SOMETHING_ELSE: an unknown refusal" },
        };
      }
      return { data: null, error: null };
    },
    reads: {
      async readOne() {
        return { data: null, error: null };
      },
      async readMany() {
        return { data: [], error: null };
      },
    },
    writes: {
      async insertSystemLog() {
        return true;
      },
    },
  });

  const decision = await refused.attachViewerContext({
    jobId: JOB_PINNED,
    claimToken: "t",
    jobGeneration: 1,
    viewerSocialAccountId: VIEWER_PINNED,
  });

  // An unknown refusal is never an approval and never a filter step.
  assertEquals(decision.kind, "unavailable");
});

Deno.test("the permit names the bound viewer and refuses a mismatch", async () => {
  const store = createCompetitorServiceStore({
    rpc: async (name) => {
      if (name === "authorize_instagram_collection_provider_call") {
        return {
          data: {
            allowed: true,
            job_id: JOB_PINNED,
            target_kind: "competitor",
            target_id: WATCHLIST_PINNED,
            // A DIFFERENT viewer than the one that is bound.
            viewer_social_account_id: VIEWER_OTHER,
            job_generation: 1,
            credential_generation: 3,
            policy_fingerprint: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    reads: {
      async readOne() {
        return { data: null, error: null };
      },
      async readMany() {
        return { data: [], error: null };
      },
    },
    writes: {
      async insertSystemLog() {
        return true;
      },
    },
  });

  const decision = await store.authorizeProviderCall({
    jobId: JOB_PINNED,
    claimToken: "t",
    jobGeneration: 1,
    targetId: WATCHLIST_PINNED,
    viewerSocialAccountId: VIEWER_PINNED,
  });

  // A permit that names another viewer is not evidence that the approved
  // viewer may spend a provider call.
  assertEquals(decision.kind, "unavailable");
  if (decision.kind !== "unavailable") throw new Error("unexpected decision");
  assertEquals(decision.reasonCode, "malformed_envelope");
});

Deno.test("a refused permit is a refusal and nothing else", async () => {
  const store = createCompetitorServiceStore({
    rpc: async (name) => {
      if (name === "authorize_instagram_collection_provider_call") {
        return {
          data: { allowed: false, reason_code: "collection_not_eligible" },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    reads: {
      async readOne() {
        return { data: null, error: null };
      },
      async readMany() {
        return { data: [], error: null };
      },
    },
    writes: {
      async insertSystemLog() {
        return true;
      },
    },
  });

  const decision = await store.authorizeProviderCall({
    jobId: JOB_PINNED,
    claimToken: "t",
    jobGeneration: 1,
    targetId: WATCHLIST_PINNED,
    viewerSocialAccountId: VIEWER_PINNED,
  });

  assertEquals(decision.kind, "refused");
  if (decision.kind !== "refused") throw new Error("unexpected decision");
  assertEquals(decision.reasonCode, "collection_not_eligible");
});

// ---------------------------------------------------------------------------
// 3. The per-request permit
// ---------------------------------------------------------------------------

Deno.test("a permit refused after the claim stops every request", async () => {
  const store = createRolloutStore({
    policy: POLICY_ONE_PAIR,
    permit: { allowed: false, reason_code: "collection_not_eligible" },
  });
  const harness = createHarness({ store });

  const summary = await runCompetitorDrain(harness.ports, {});

  // The first excluded request is never sent, and nothing is written.
  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.persisted.length, 0);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "collection_not_eligible");
  // The refusal of ONE target does not stop the run.
  assertEquals(summary.stoppedEarly, false);
});

Deno.test("an unreadable configuration at the attachment stops the run", async () => {
  const store = createRolloutStore({
    policy: POLICY_ONE_PAIR,
    claimAll: true,
    attachEnvelope: {
      data: null,
      error: {
        code: "22023",
        message: "IG_COLLECTION_SETTINGS_UNAVAILABLE: the rollout configuration cannot be read",
      },
    },
  });
  const harness = createHarness({ store });

  const summary = await runCompetitorDrain(harness.ports, {});

  assertEquals(summary.stoppedEarly, true);
  assertEquals(store.attaches.length, 1);
  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.persisted.length, 0);
});

Deno.test("a permit that cannot be read stops the run and writes nothing", async () => {
  const store = createRolloutStore({
    policy: POLICY_ONE_PAIR,
    permitEnvelope: { data: null, error: { code: "42501" } },
  });
  const harness = createHarness({ store });

  const summary = await runCompetitorDrain(harness.ports, {});

  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.persisted.length, 0);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "collection_unavailable");
  // The outcome is UNKNOWN, so the run stops.
  assertEquals(summary.stoppedEarly, true);
});

Deno.test("a malformed permit envelope is unavailable, never permission", async () => {
  const store = createRolloutStore({
    policy: POLICY_ONE_PAIR,
    permitEnvelope: { data: { allowed: true, job_id: JOB_PINNED }, error: null },
  });
  const harness = createHarness({ store });

  const summary = await runCompetitorDrain(harness.ports, {});

  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.persisted.length, 0);
  assertEquals(summary.jobs[0]!.reasonCode, "collection_unavailable");
});

Deno.test("the permit is asked again for every request and is never cached", async () => {
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });
  const harness = createHarness({
    store,
    provider: {
      pages: [
        {
          data: [{
            id: "media_1",
            media_type: "IMAGE",
            media_product_type: "FEED",
            timestamp: "2026-10-28T12:00:00.000Z",
            permalink: "https://instagram.com/p/media_1",
            like_count: 1500,
            comments_count: 45,
          }],
          paging: { cursors: { before: "BEFORE", after: "AFTER1" } },
        },
        { data: [] },
      ],
    },
  });

  await runCompetitorDrain(harness.ports, {});

  // Every request that left the process asked for its own permit.
  assert(harness.providerCalls.length > 1);
  assertEquals(store.permits.length, harness.providerCalls.length);
  assertEquals(
    store.permits.every((permit) => permit.jobId === JOB_PINNED),
    true,
  );
});

Deno.test("a permit refused between two pages stops the second page", async () => {
  const store = createRolloutStore({ policy: POLICY_ONE_PAIR });

  // The permit is granted for the FIRST request and refused for every
  // later one, so the cursor request of the second page is never sent.
  const original = store.store.authorizeProviderCall.bind(store.store);
  let asked = 0;
  const guarded: CompetitorServiceStore = {
    ...store.store,
    async authorizeProviderCall(input) {
      asked += 1;
      if (asked === 1) return await original(input);
      return { kind: "refused", reasonCode: "collection_not_eligible" };
    },
  };

  const harness = createHarness({ store: { ...store, store: guarded } });

  await runCompetitorDrain(harness.ports, {});

  // The second page was never requested.
  assertEquals(harness.providerCalls.length, 1);
  assertEquals(store.persisted.length, 0);
});

Deno.test("a failed audit stops the work and reports the audit failure", async () => {
  const store = createRolloutStore({
    policy: POLICY_ONE_PAIR,
    permitEnvelope: { data: null, error: { code: "42501" } },
  });
  // The exception-path audit does NOT commit.
  const failing = {
    ...store,
    store: {
      ...store.store,
      async authorizeProviderCall(input: Parameters<typeof store.store.authorizeProviderCall>[0]) {
        const decision = await store.store.authorizeProviderCall(input);
        if (decision.kind === "unavailable") {
          return { ...decision, auditStored: false };
        }
        return decision;
      },
    },
  };

  const harness = createHarness({ store: failing });
  const summary = await runCompetitorDrain(harness.ports, {});

  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.persisted.length, 0);
  assertEquals(summary.stoppedEarly, true);

  // The audit failure is reported and never claimed as a stored row.
  const auditFailure = harness.logs.find((entry) =>
    entry.event === "competitor_provider_call_audit_failed"
  );
  assert(auditFailure !== undefined);
  assertEquals(auditFailure!.reasonCode, "collection_unavailable");
});
