/**
 * The rollout admission of the OWNER collection.
 *
 * WHAT THIS SUITE PROVES
 *
 *   1. THE ADMISSION. One allowlisted owner account progresses while the
 *      global credential mode stays `legacy`. A same-owner account, a
 *      shared-grant sibling and a foreign account never resolve a usable
 *      job and never issue a provider request. The proof covers a
 *      PRE-EXISTING pending job, a FRESH enqueue and a TARGETLESS drain,
 *      and it counts the calls by TARGET and by CREDENTIAL identity, not
 *      only in total.
 *
 *   2. THE CREDENTIAL PINNING. A direct-login account is collected through
 *      the Instagram-login adapter with the operational token of the fenced
 *      reader and with NO Facebook linkage at all. A page-linked account is
 *      collected through the Facebook adapter with the protected User
 *      credential and with NO metadata or Page-token fallback. An error or
 *      a missing authority never triggers an exploratory request, and
 *      READINESS INCLUDES THE TOKEN EXPIRY, not the presence of a token.
 *
 *   3. THE PER-REQUEST PERMIT. The permit is asked again immediately
 *      before every request: after the claim, between two retries, between
 *      two pages and between two media calls. A refused permit, a permit
 *      read that failed, a malformed envelope and a failed audit all stop
 *      the work: no later request is sent and no successful write is made.
 *
 *   4. THE ACTUAL COMPOSITION. The real `index.ts` is driven: the owner
 *      actions run as the verified caller, the drain needs a service
 *      credential, the off state never touches the new SQL, and the stored
 *      report stays readable through the existing report route.
 *
 * WHY THE STORE DOUBLE REPRODUCES THE ACCEPTED SQL
 *
 *   The accepted migration `20261031090000_instagram_collection_rollout_
 *   controls.sql` owns the admission: every claim pass filters the
 *   candidates, and the permit derives the scope from the live fenced job.
 *   This suite drives the PRODUCTION TypeScript against a double that
 *   reproduces those two decisions, so the TypeScript side is proved to
 *   consume the decisions and never to make its own.
 *
 * WHY NO PRODUCTION SECRET IS READ
 *
 *   Every provider call goes to a double, every database call goes to a
 *   double, and the only environment values are synthetic. The suite never
 *   reaches the network and never reads a credential from the repository.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { InstagramGraphProvider } from "./graphProvider.ts";
import { InstagramDirectGraphProvider } from "./directGraphProvider.ts";
import { runOwnerDrain, type OwnerWorkerPorts } from "./worker.ts";
import { createOwnerCollectionStore, type OwnerCollectionStore } from "./store.ts";
import type { OwnerCollectionServiceStore } from "./workerStore.ts";
import type { ClaimedOwnerJob } from "./receipts.ts";
import {
  accountDayAnswer,
  createClaimedJob,
  createFakeStore,
  fixedClock,
  mediaInsightAnswer,
  type FakeStoreOptions,
} from "./workerTestSupport.ts";

// ---------------------------------------------------------------------------
// The identities
// ---------------------------------------------------------------------------

const OWNER_ID = "0f200001-0000-4000-8000-000000000001";

/** The allowlisted owner account. */
const ACCOUNT_A = "0f200002-0000-4000-8000-000000000002";
/** Another account of the SAME owner. The policy does not admit it. */
const ACCOUNT_B = "0f200003-0000-4000-8000-000000000003";
/** A shared-grant sibling of the same owner. The policy does not admit it. */
const ACCOUNT_C = "0f200004-0000-4000-8000-000000000004";
/** An account of ANOTHER tenant. The policy does not admit it. */
const ACCOUNT_D = "0f200005-0000-4000-8000-000000000005";

const FOREIGN_OWNER_ID = "0f200006-0000-4000-8000-000000000006";

const IG_USER_A = "1784140001";
const IG_USER_B = "1784140002";
const IG_USER_C = "1784140003";
const IG_USER_D = "1784140004";

const JOB_A = "0f200011-0000-4000-8000-000000000011";
const JOB_B = "0f200012-0000-4000-8000-000000000012";
const JOB_C = "0f200013-0000-4000-8000-000000000013";
const JOB_D = "0f200014-0000-4000-8000-000000000014";

const TOKEN_A = "0f200021-0000-4000-8000-000000000021";
const TOKEN_B = "0f200022-0000-4000-8000-000000000022";
const TOKEN_C = "0f200023-0000-4000-8000-000000000023";
const TOKEN_D = "0f200024-0000-4000-8000-000000000024";

/** The protected credential id of every account. It is never a token. */
const CREDENTIAL_A = "0f200031-0000-4000-8000-000000000031";
const CREDENTIAL_B = "0f200032-0000-4000-8000-000000000032";
const CREDENTIAL_C = "0f200033-0000-4000-8000-000000000033";
const CREDENTIAL_D = "0f200034-0000-4000-8000-000000000034";

/** The operational token of the DIRECT credential of every account. */
const DIRECT_TOKEN_A = "direct-token-of-account-a";
const DIRECT_TOKEN_B = "direct-token-of-account-b";

const CAPTURED_ON = "2026-10-28";
const PRIMARY_DAY = "2026-10-27";

/** The instant the fixed clock reports. It is inside the capture window. */
const NOW = Date.parse("2026-10-28T12:00:00.000Z");

// ---------------------------------------------------------------------------
// The claimed jobs
// ---------------------------------------------------------------------------

/**
 * One claimed job.
 *
 * The fixture goes through the production parser, so a job the database
 * would not have returned never reaches the worker.
 */
function claimedJob(input: {
  readonly jobId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly claimToken: string;
  readonly loginKind?: "direct" | "page_linked";
}): ClaimedOwnerJob {
  return createClaimedJob({
    job_id: input.jobId,
    user_id: input.userId,
    target_id: input.accountId,
    social_account_id: input.accountId,
    claim_token: input.claimToken,
    captured_on: CAPTURED_ON,
    context: {
      viewer_social_account_id: input.accountId,
      credential_generation: 7,
      login_kind: input.loginKind ?? "page_linked",
      capability_present: true,
      permission_read_state: "ok",
      granted_scopes: ["instagram_basic", "instagram_manage_insights"],
    },
  });
}

const JOB_A_ROW = claimedJob({
  jobId: JOB_A,
  userId: OWNER_ID,
  accountId: ACCOUNT_A,
  claimToken: TOKEN_A,
});
const JOB_B_ROW = claimedJob({
  jobId: JOB_B,
  userId: OWNER_ID,
  accountId: ACCOUNT_B,
  claimToken: TOKEN_B,
});
const JOB_C_ROW = claimedJob({
  jobId: JOB_C,
  userId: OWNER_ID,
  accountId: ACCOUNT_C,
  claimToken: TOKEN_C,
});
const JOB_D_ROW = claimedJob({
  jobId: JOB_D,
  userId: FOREIGN_OWNER_ID,
  accountId: ACCOUNT_D,
  claimToken: TOKEN_D,
});

const JOB_A_DIRECT_ROW = claimedJob({
  jobId: JOB_A,
  userId: OWNER_ID,
  accountId: ACCOUNT_A,
  claimToken: TOKEN_A,
  loginKind: "direct",
});

// ---------------------------------------------------------------------------
// The provider double
// ---------------------------------------------------------------------------

/** One recorded provider request. */
interface RecordedProviderCall {
  readonly kind: "profile" | "accountDay" | "media" | "mediaInsight";
  /** The host the request went to. It names the login kind. */
  readonly host: string;
  /** The account or the media the request addressed. */
  readonly target: string;
  /** The credential identity the request carried. It is never a real token. */
  readonly token: string;
}

interface CountingGraphOptions {
  /** The media the media connection answers with. */
  readonly media?: unknown[];
  /** The pages the media connection answers with, one per page. */
  readonly mediaPages?: Record<string, unknown>[];
  /** The first N requests answer with a 500, so the retry policy runs. */
  readonly failFirst?: number;
}

/**
 * The provider double.
 *
 * It records the HOST, the TARGET and the CREDENTIAL of every request, so a
 * test can prove that a request was made FOR an account and WITH a
 * credential - not merely that some request was made.
 */
function createCountingGraph(options: CountingGraphOptions = {}) {
  const calls: RecordedProviderCall[] = [];
  const mediaPageIndex = new Map<string, number>();
  let index = 0;

  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const segments = url.pathname.split("/").filter((part) => part.length > 0);
    // The first segment is the version, the second one is the account or
    // the media the request addresses.
    const target = segments[1] ?? "";
    const token = url.searchParams.get("access_token") ?? "";

    const isInsights = url.pathname.includes("/insights");
    const isAccountDay = isInsights &&
      url.searchParams.get("metric_type") === "total_value";
    const kind = isAccountDay
      ? "accountDay"
      : isInsights
      ? "mediaInsight"
      : url.pathname.includes("/media")
      ? "media"
      : "profile";

    calls.push({ kind, host: url.host, target, token });

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

    if (kind === "profile") {
      return Promise.resolve(
        json({ followers_count: 3200, media_count: 42 }),
      );
    }
    if (kind === "accountDay") {
      return Promise.resolve(json(accountDayAnswer({ reach: 450, views: 890 })));
    }
    if (kind === "mediaInsight") {
      return Promise.resolve(json(mediaInsightAnswer({ reach: 100, views: 200 })));
    }

    const pages = options.mediaPages;
    if (pages !== undefined) {
      const seen = mediaPageIndex.get(target) ?? 0;
      mediaPageIndex.set(target, seen + 1);
      const page = pages[Math.min(seen, pages.length - 1)] ?? { data: [] };
      return Promise.resolve(json(page));
    }

    return Promise.resolve(json({ data: options.media ?? [] }));
  };

  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The media rows the media connection answers with. */
function mediaItem(id: string, publishedAt: string): Record<string, unknown> {
  return {
    id,
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: publishedAt,
    permalink: `https://instagram.com/p/${id}`,
    like_count: 55,
    comments_count: 3,
  };
}

// ---------------------------------------------------------------------------
// The store double of the ACCEPTED admission
// ---------------------------------------------------------------------------

/** The per-account options of the store double. */
type RolloutAccountOptions = Omit<FakeStoreOptions, "jobs" | "accounts">;

interface RolloutStoreOptions {
  /** The accounts the rollout policy admits. */
  readonly admitted: readonly string[];
  /** The jobs the claim hands out before the policy filters them. */
  readonly jobs?: readonly ClaimedOwnerJob[];
  /** The per-account options of the underlying store double. */
  readonly accounts?: Record<string, RolloutAccountOptions>;
  /** The store options of the underlying store double. */
  readonly store?: Omit<FakeStoreOptions, "jobs" | "accounts">;
}

/**
 * The store double of the ACCEPTED admission.
 *
 * It reproduces the two decisions the accepted migration owns:
 *
 *   - the claim hands out ONLY the jobs whose target is admitted, so an
 *     excluded target never resolves a usable job;
 *   - the permit grants a permit ONLY for an admitted job, and refuses
 *     every other one with `collection_not_eligible`.
 *
 * The TypeScript under test consumes those decisions and never makes its
 * own: it asks the store, and it acts on the answer.
 */
function createRolloutStore(options: RolloutStoreOptions) {
  const admitted = new Set(options.admitted.map((id) => id.toLowerCase()));
  const base = createFakeStore({
    ...(options.store ?? {}),
    jobs: [...(options.jobs ?? [])],
    accounts: options.accounts,
  });

  const jobTargets = new Map<string, string>();
  for (const job of options.jobs ?? []) {
    jobTargets.set(job.jobId, job.socialAccountId.toLowerCase());
  }

  const store: OwnerCollectionServiceStore = {
    ...base.store,

    async claimOwnerJobs(input) {
      // The accepted SQL applies the eligibility to EVERY candidate query,
      // so an excluded job is never handed out at all.
      const claimed = await base.store.claimOwnerJobs(input);
      return claimed.filter((job) =>
        admitted.has(job.socialAccountId.toLowerCase())
      );
    },

    async authorizeProviderCall(input) {
      const target = jobTargets.get(input.jobId);
      if (target === undefined || !admitted.has(target)) {
        base.calls.permits.push({
          jobId: input.jobId,
          jobGeneration: input.jobGeneration,
          outcome: "refused",
        });
        return { kind: "refused", reasonCode: "collection_not_eligible" };
      }
      return await base.store.authorizeProviderCall(input);
    },
  };

  return { store, calls: base.calls };
}

// ---------------------------------------------------------------------------
// The worker harness
// ---------------------------------------------------------------------------

interface WorkerHarness {
  readonly ports: OwnerWorkerPorts;
  readonly calls: ReturnType<typeof createFakeStore>["calls"];
  readonly providerCalls: RecordedProviderCall[];
  readonly logs: Array<Record<string, unknown>>;
}

function createWorkerHarness(options: {
  readonly store: ReturnType<typeof createFakeStore>;
  readonly graph?: CountingGraphOptions;
  readonly now?: () => number;
}) {
  const graph = createCountingGraph(options.graph ?? {});
  const logs: Array<Record<string, unknown>> = [];

  const ports: OwnerWorkerPorts = {
    store: options.store.store,
    provider: new InstagramGraphProvider({ fetchFn: graph.fetchFn }),
    directProvider: new InstagramDirectGraphProvider({ fetchFn: graph.fetchFn }),
    bucketKeyFor: async (credentialId) => await sha256Of(credentialId),
    now: options.now ?? fixedClock(NOW),
    log: (event) => logs.push({ ...event }),
  };

  return {
    ports,
    calls: options.store.calls,
    providerCalls: graph.calls,
    logs,
  };
}

async function sha256Of(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The per-account options of the store double.
 *
 * Every account gets its OWN target row, its OWN protected credential and
 * its OWN Instagram user id, so a request can be attributed to an account
 * and to a credential.
 */
function accountOptions(
  accountId: string,
  userId: string,
  igUserId: string,
  credentialId: string,
): RolloutAccountOptions {
  return {
    target: { socialAccountId: accountId, userId, platformUserId: igUserId },
    credential: { credentialId },
  };
}

/** The requests that were made for one account. */
function callsFor(
  calls: readonly RecordedProviderCall[],
  igUserId: string,
): RecordedProviderCall[] {
  return calls.filter((call) => call.target === igUserId);
}

/** The credential identities one set of requests carried. */
function credentialsOf(
  calls: readonly RecordedProviderCall[],
): string[] {
  return [...new Set(calls.map((call) => call.token))];
}

// ---------------------------------------------------------------------------
// 1. The admission
// ---------------------------------------------------------------------------

Deno.test("only the allowlisted owner account is collected, under a legacy credential mode", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW, JOB_B_ROW, JOB_C_ROW, JOB_D_ROW],
    accounts: {
      [ACCOUNT_A]: accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
      [ACCOUNT_B]: accountOptions(ACCOUNT_B, OWNER_ID, IG_USER_B, CREDENTIAL_B),
      [ACCOUNT_C]: accountOptions(ACCOUNT_C, OWNER_ID, IG_USER_C, CREDENTIAL_C),
      [ACCOUNT_D]: accountOptions(ACCOUNT_D, FOREIGN_OWNER_ID, IG_USER_D, CREDENTIAL_D),
    },
  });

  const harness = createWorkerHarness({ store });

  const summary = await runOwnerDrain(harness.ports);

  // The claim handed out ONLY the admitted job: the excluded targets never
  // resolved a usable job at all.
  assertEquals(summary.claimed, 1);
  assertEquals(summary.jobs.length, 1);
  assertEquals(summary.jobs[0]!.jobId, JOB_A);

  // The admitted account progressed.
  const forA = callsFor(harness.providerCalls, IG_USER_A);
  assert(forA.length > 0);
  assertEquals(forA.every((call) => call.host === "graph.facebook.com"), true);

  // Every excluded account issued NO request, under ANY credential.
  for (const igUserId of [IG_USER_B, IG_USER_C, IG_USER_D]) {
    assertEquals(callsFor(harness.providerCalls, igUserId).length, 0, igUserId);
  }
  assertEquals(
    harness.providerCalls.some((call) => call.target === IG_USER_B),
    false,
  );

  // The credential identity is accounted for: only the admitted account's
  // protected credential was spent.
  assertEquals(credentialsOf(harness.providerCalls).length, 1);
  assertEquals(
    harness.calls.credentialReads.every((read) =>
      read.socialAccountId.toLowerCase() === ACCOUNT_A.toLowerCase()
    ),
    true,
  );
});

Deno.test("the excluded accounts are never written to and never completed", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW, JOB_B_ROW, JOB_C_ROW, JOB_D_ROW],
    accounts: {
      [ACCOUNT_A]: accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
      [ACCOUNT_B]: accountOptions(ACCOUNT_B, OWNER_ID, IG_USER_B, CREDENTIAL_B),
      [ACCOUNT_C]: accountOptions(ACCOUNT_C, OWNER_ID, IG_USER_C, CREDENTIAL_C),
      [ACCOUNT_D]: accountOptions(ACCOUNT_D, FOREIGN_OWNER_ID, IG_USER_D, CREDENTIAL_D),
    },
  });

  const harness = createWorkerHarness({ store });
  await runOwnerDrain(harness.ports);

  // The excluded jobs produced no write at all: no snapshot, no progress and
  // no completion. Their attempts, generations and success times are
  // untouched because the claim never handed them out.
  assertEquals(store.calls.snapshots.length > 0, true);
  assertEquals(store.calls.completes.length, 1);
  assertEquals(store.calls.completes[0]!.outcome, "completed");
  assertEquals(store.calls.refusedWrites.length, 0);
});

Deno.test("a fresh enqueue of an excluded account is refused, and the admitted one is accepted", async () => {
  // The accepted SQL refuses an excluded target with the refusal union, and
  // the accepted enqueue of an admitted target with the accepted union.
  const refusals: Record<string, unknown> = {
    [ACCOUNT_B]: {
      accepted: false,
      refused: true,
      reason_code: "collection_not_eligible",
      captured_on: CAPTURED_ON,
    },
    [ACCOUNT_C]: {
      accepted: false,
      refused: true,
      reason_code: "collection_not_eligible",
      captured_on: CAPTURED_ON,
    },
    [ACCOUNT_D]: {
      accepted: false,
      refused: true,
      reason_code: "collection_not_eligible",
      captured_on: CAPTURED_ON,
    },
    [ACCOUNT_A]: {
      accepted: true,
      reason: "enqueued",
      job_id: JOB_A,
      job_generation: 1,
      status: "queued",
      captured_on: CAPTURED_ON,
      created: true,
      accepted_at: "2026-10-28T09:00:00+00:00",
    },
  };

  const store = createOwnerCollectionStore(async (_name, args) => {
    const targetId = String(args.p_target_id ?? "").toLowerCase();
    return { data: refusals[targetId] ?? null, error: null };
  });

  for (const accountId of [ACCOUNT_B, ACCOUNT_C, ACCOUNT_D]) {
    const outcome = await store.enqueueOwnerJob({
      socialAccountId: accountId,
      mode: "normal",
      signal: new AbortController().signal,
    });

    assertEquals(outcome.kind, "refused", accountId);
    if (outcome.kind === "refused") {
      assertEquals(outcome.projection.reason_code, "collection_not_eligible");
      assertEquals(outcome.projection.accepted, false);
    }
  }

  const accepted = await store.enqueueOwnerJob({
    socialAccountId: ACCOUNT_A,
    mode: "normal",
    signal: new AbortController().signal,
  });
  assertEquals(accepted.kind, "accepted");
});

Deno.test("a targetless drain collects the admitted account and nothing else", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW, JOB_B_ROW, JOB_C_ROW, JOB_D_ROW],
    accounts: {
      [ACCOUNT_A]: accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
      [ACCOUNT_B]: accountOptions(ACCOUNT_B, OWNER_ID, IG_USER_B, CREDENTIAL_B),
      [ACCOUNT_C]: accountOptions(ACCOUNT_C, OWNER_ID, IG_USER_C, CREDENTIAL_C),
      [ACCOUNT_D]: accountOptions(ACCOUNT_D, FOREIGN_OWNER_ID, IG_USER_D, CREDENTIAL_D),
    },
  });

  const harness = createWorkerHarness({ store });
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 1);
  assertEquals(summary.completed, 1);
  assertEquals(harness.providerCalls.length > 0, true);

  const targets = [...new Set(harness.providerCalls.map((call) => call.target))];
  assertEquals(targets, [IG_USER_A]);
});

Deno.test("an owner whose policy admits nobody collects nothing", async () => {
  const store = createRolloutStore({
    admitted: [],
    jobs: [JOB_A_ROW, JOB_B_ROW],
    accounts: {
      [ACCOUNT_A]: accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
      [ACCOUNT_B]: accountOptions(ACCOUNT_B, OWNER_ID, IG_USER_B, CREDENTIAL_B),
    },
  });

  const harness = createWorkerHarness({ store });
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 0);
  assertEquals(summary.processed, 0);
  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.calls.snapshots.length, 0);
  assertEquals(store.calls.completes.length, 0);
});

// ---------------------------------------------------------------------------
// 2. The credential pinning
// ---------------------------------------------------------------------------

Deno.test("a direct account is collected through the Instagram adapter with the fenced token", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_DIRECT_ROW],
    accounts: {
      [ACCOUNT_A]: {
        target: {
          socialAccountId: ACCOUNT_A,
          userId: OWNER_ID,
          platformUserId: IG_USER_A,
        },
        capability: {
          loginKind: "direct",
          credentialGeneration: 7,
          scopesAuthoritative: true,
          grantedScopes: [
            "instagram_business_basic",
            "instagram_business_manage_insights",
          ],
        },
        directCredential: { igUserId: IG_USER_A, accessToken: DIRECT_TOKEN_A },
      },
    },
  });

  const harness = createWorkerHarness({ store });
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.completed, 1);
  assert(harness.providerCalls.length > 0);

  // The Instagram-login host and the Instagram-login token. A host and a
  // token never come from different logins.
  assertEquals(
    harness.providerCalls.every((call) => call.host === "graph.instagram.com"),
    true,
  );
  assertEquals(credentialsOf(harness.providerCalls), [DIRECT_TOKEN_A]);

  // A direct account has NO protected Facebook binding, and the worker
  // never looks for one.
  assertEquals(store.calls.credentialReads.length, 0);
  assertEquals(store.calls.directCredentialReads.length > 0, true);
});

Deno.test("a direct account asks a permit for every request, media calls included", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_DIRECT_ROW],
    accounts: {
      [ACCOUNT_A]: {
        target: { socialAccountId: ACCOUNT_A, userId: OWNER_ID, platformUserId: IG_USER_A },
        capability: {
          loginKind: "direct",
          credentialGeneration: 7,
          scopesAuthoritative: true,
          grantedScopes: ["instagram_business_basic", "instagram_business_manage_insights"],
        },
        directCredential: { igUserId: IG_USER_A, accessToken: DIRECT_TOKEN_A },
      },
    },
  });

  const harness = createWorkerHarness({
    store,
    graph: { media: [mediaItem("media-1", "2026-10-20T12:00:00Z")] },
  });
  await runOwnerDrain(harness.ports);

  assert(harness.providerCalls.some((call) => call.kind === "mediaInsight"));
  assertEquals(store.calls.permits.length, harness.providerCalls.length);
});

Deno.test("a page-linked account is collected through the Facebook adapter with the protected credential", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        target: {
          socialAccountId: ACCOUNT_A,
          userId: OWNER_ID,
          platformUserId: IG_USER_A,
        },
        credential: { credentialId: CREDENTIAL_A },
      },
    },
  });

  const harness = createWorkerHarness({ store });
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.completed, 1);
  assert(harness.providerCalls.length > 0);

  // The Facebook-login host and the protected User credential. There is no
  // metadata or Page-token fallback: the account row's own token is never
  // read by this worker.
  assertEquals(
    harness.providerCalls.every((call) => call.host === "graph.facebook.com"),
    true,
  );
  assertEquals(store.calls.credentialReads.length, 1);
  assertEquals(store.calls.directCredentialReads.length, 0);
});

Deno.test("an account without a usable authority never triggers an exploratory request", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a missing capability", { capabilityFailure: "credential_missing" as const }],
    ["a missing protected credential", { credentialFailure: "credential_missing" as const }],
    [
      "a missing direct credential",
      {
        capability: {
          loginKind: "direct",
          credentialGeneration: 7,
          scopesAuthoritative: true,
          grantedScopes: ["instagram_business_manage_insights"],
        },
        directCredentialFailure: "credential_missing" as const,
      },
    ],
  ];

  for (const [label, account] of cases) {
    const store = createRolloutStore({
      admitted: [ACCOUNT_A],
      jobs: [JOB_A_ROW],
      accounts: {
        [ACCOUNT_A]: {
          target: {
            socialAccountId: ACCOUNT_A,
            userId: OWNER_ID,
            platformUserId: IG_USER_A,
          },
          ...account,
        },
      },
    });

    const harness = createWorkerHarness({ store });
    await runOwnerDrain(harness.ports);

    assertEquals(harness.providerCalls.length, 0, label);
    assertEquals(store.calls.snapshots.length, 0, label);
  }
});

Deno.test("readiness includes the token expiry, not the presence of a token", async () => {
  const expired = "2026-10-20T12:00:00.000Z";

  // The DIRECT credential reports an expiry that has passed.
  const directStore = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_DIRECT_ROW],
    accounts: {
      [ACCOUNT_A]: {
        target: {
          socialAccountId: ACCOUNT_A,
          userId: OWNER_ID,
          platformUserId: IG_USER_A,
        },
        capability: {
          loginKind: "direct",
          credentialGeneration: 7,
          scopesAuthoritative: true,
          grantedScopes: ["instagram_business_manage_insights"],
        },
        directCredential: {
          igUserId: IG_USER_A,
          accessToken: DIRECT_TOKEN_A,
          tokenExpiresAt: expired,
        },
      },
    },
  });

  const directHarness = createWorkerHarness({ store: directStore });
  await runOwnerDrain(directHarness.ports);

  assertEquals(directHarness.providerCalls.length, 0);
  assertEquals(directStore.calls.snapshots.length, 0);
  assertEquals(directStore.calls.completes[0]?.reasonCode, "credential_unavailable");

  // The PROTECTED credential reports an expiry that has passed.
  const protectedStore = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        target: {
          socialAccountId: ACCOUNT_A,
          userId: OWNER_ID,
          platformUserId: IG_USER_A,
        },
        credential: { credentialId: CREDENTIAL_A, tokenExpiresAt: expired },
      },
    },
  });

  const protectedHarness = createWorkerHarness({ store: protectedStore });
  await runOwnerDrain(protectedHarness.ports);

  assertEquals(protectedHarness.providerCalls.length, 0);
  assertEquals(protectedStore.calls.snapshots.length, 0);
  assertEquals(protectedStore.calls.completes[0]?.reasonCode, "credential_unavailable");
});

Deno.test("the account row's own token is never read, so there is no metadata fallback", async () => {
  // The REAL service store, with a recording read port. The column list of
  // the account read is the evidence: the browser-readable `access_token`
  // column is not part of it, so a page-linked account can only be
  // collected through the protected authority.
  const { createOwnerCollectionServiceStore } = await import("./workerStore.ts");
  const columns: string[] = [];

  const store = createOwnerCollectionServiceStore({
    rpc: async () => ({ data: null, error: null }),
    reads: {
      async readOne(table, selected) {
        columns.push(`${table}:${selected}`);
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

  await store.readOwnerTarget({
    socialAccountId: ACCOUNT_A,
    userId: OWNER_ID,
  });

  assertEquals(columns.length, 1);
  assertEquals(columns[0]!.includes("access_token"), false);
  assertEquals(columns[0]!.includes("user_token"), false);
  assertEquals(columns[0]!.includes("account_metadata"), false);
});

// ---------------------------------------------------------------------------
// 3. The per-request permit
// ---------------------------------------------------------------------------

Deno.test("a permit refused after the claim stops every request and writes nothing", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        permit: { outcome: "refused", reasonCode: "collection_not_eligible" },
      },
    },
  });

  const harness = createWorkerHarness({ store });
  const summary = await runOwnerDrain(harness.ports);

  // The first excluded request is never sent.
  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.calls.snapshots.length, 0);
  assertEquals(store.calls.completes.length, 0);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "collection_not_eligible");
  assertEquals(summary.stoppedEarly, false);
});

Deno.test("a permit refused between two retries stops the second request", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        // The profile request is the FIRST permit, and it is granted. The
        // retry of the 500 is the SECOND permit, and it is refused.
        refusePermitAfter: 1,
      },
    },
  });

  const harness = createWorkerHarness({
    store,
    graph: { failFirst: 1 },
  });
  await runOwnerDrain(harness.ports);

  // Exactly one request left the process: the first attempt. The retry was
  // never sent, because the permit refused it first.
  assertEquals(harness.providerCalls.length, 1);
  assertEquals(harness.providerCalls[0]!.kind, "profile");
  assertEquals(store.calls.snapshots.length, 0);
});

Deno.test("a permit refused between two pages stops the second page", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        // The profile, the two daily observations and the FIRST page are
        // granted. The SECOND page is refused.
        refusePermitAfter: 4,
      },
    },
  });

  const harness = createWorkerHarness({
    store,
    graph: {
      mediaPages: [
        {
          data: [mediaItem("media-1", "2026-10-20T12:00:00Z")],
          paging: {
            next: "https://graph.facebook.com/v22.0/me/media?after=CURSOR2",
            cursors: { after: "CURSOR2" },
          },
        },
        { data: [] },
      ],
    },
  });
  await runOwnerDrain(harness.ports);

  const mediaCalls = harness.providerCalls.filter((call) => call.kind === "media");
  assertEquals(mediaCalls.length, 1);
  // The sweep never completed, so no media row was stored.
  assertEquals(
    store.calls.snapshots.filter((entry) => entry.kind === "owner_media").length,
    0,
  );
  // The work that was ALREADY authorized and already stored is not erased:
  // the profile observation of the first request is still on the record.
  assertEquals(
    store.calls.snapshots.filter((entry) => entry.kind === "owner_profile_observation").length,
    1,
  );
  assertEquals(
    harness.providerCalls.some((call) => call.kind === "profile"),
    true,
  );
});

Deno.test("a permit refused between two media calls stops the second media call", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        // The profile, the two daily observations, the sweep and the FIRST
        // media call are granted. The SECOND media call is refused.
        refusePermitAfter: 5,
      },
    },
  });

  const harness = createWorkerHarness({
    store,
    graph: { media: [mediaItem("media-1", "2026-10-20T12:00:00Z"), mediaItem("media-2", "2026-10-21T12:00:00Z")] },
  });
  await runOwnerDrain(harness.ports);

  const mediaCalls = harness.providerCalls.filter((call) => call.kind === "mediaInsight");
  assertEquals(mediaCalls.length, 1);
  // Exactly one media was asked about. The other one was never requested.
  assertEquals(harness.providerCalls.filter((call) => call.kind === "mediaInsight").length, 1);
  const asked = new Set(harness.providerCalls.map((call) => call.target));
  assertEquals(asked.has("media-1") !== asked.has("media-2"), true);
});

Deno.test("a permit that cannot be read stops every request and writes nothing", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        permit: { outcome: "unavailable", reasonCode: "permit_read_failed" },
      },
    },
  });

  const harness = createWorkerHarness({ store });
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.calls.snapshots.length, 0);
  assertEquals(store.calls.completes.length, 0);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "collection_unavailable");
  // The outcome is UNKNOWN, so the run stops.
  assertEquals(summary.stoppedEarly, true);
});

Deno.test("a malformed permit envelope is unavailable, never permission", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        permit: { outcome: "unavailable", reasonCode: "malformed_envelope" },
      },
    },
  });

  const harness = createWorkerHarness({ store });
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.calls.snapshots.length, 0);
  assertEquals(store.calls.completes.length, 0);
  assertEquals(summary.jobs[0]!.reasonCode, "collection_unavailable");
});

Deno.test("a failed audit stops the work and reports the audit failure", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        permit: {
          outcome: "unavailable",
          reasonCode: "permit_read_failed",
          auditStored: false,
        },
      },
    },
  });

  const harness = createWorkerHarness({ store });
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(harness.providerCalls.length, 0);
  assertEquals(store.calls.snapshots.length, 0);
  assertEquals(store.calls.completes.length, 0);
  assertEquals(summary.stoppedEarly, true);

  // The audit failure is reported and never claimed as a stored row.
  const auditFailure = harness.logs.find((entry) =>
    entry.event === "owner_provider_call_audit_failed"
  );
  assert(auditFailure !== undefined);
  assertEquals(auditFailure!.reasonCode, "collection_unavailable");
});

Deno.test("the permit is asked again for every request and is never cached", async () => {
  const store = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
    },
  });

  const harness = createWorkerHarness({
    store,
    graph: { media: [mediaItem("media-1", "2026-10-20T12:00:00Z")] },
  });
  await runOwnerDrain(harness.ports);

  // Every request that left the process asked for its own permit.
  assert(harness.providerCalls.length > 1);
  assertEquals(store.calls.permits.length, harness.providerCalls.length);
  assertEquals(
    store.calls.permits.every((permit) => permit.outcome === "allowed"),
    true,
  );
  assertEquals(
    store.calls.permits.every((permit) => permit.jobId === JOB_A),
    true,
  );
});

Deno.test("a refusal of the configuration stops the run, and a refusal of one target does not", async () => {
  // The configuration refusal is a condition of EVERYONE.
  const configurationStore = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        permit: { outcome: "refused", reasonCode: "settings_unavailable" },
      },
    },
  });

  const configurationHarness = createWorkerHarness({ store: configurationStore });
  const configurationSummary = await runOwnerDrain(configurationHarness.ports);

  assertEquals(configurationHarness.providerCalls.length, 0);
  assertEquals(configurationSummary.stoppedEarly, true);
  assertEquals(configurationSummary.jobs[0]!.reasonCode, "collection_unavailable");

  // The refusal of ONE target belongs to that target alone: the run
  // continues with the next claimed owner.
  const perJobStore = createRolloutStore({
    admitted: [ACCOUNT_A],
    jobs: [JOB_A_ROW],
    accounts: {
      [ACCOUNT_A]: {
        ...accountOptions(ACCOUNT_A, OWNER_ID, IG_USER_A, CREDENTIAL_A),
        permit: { outcome: "refused", reasonCode: "collection_not_eligible" },
      },
    },
  });

  const perJobHarness = createWorkerHarness({ store: perJobStore });
  const perJobSummary = await runOwnerDrain(perJobHarness.ports);

  assertEquals(perJobHarness.providerCalls.length, 0);
  assertEquals(perJobSummary.stoppedEarly, false);
  assertEquals(perJobSummary.jobs[0]!.reasonCode, "collection_not_eligible");
});

// ---------------------------------------------------------------------------
// 4. The actual composition
// ---------------------------------------------------------------------------

const testFilePath = fileURLToPath(import.meta.url);
const FUNCTIONS_ROOT = dirname(dirname(testFilePath));
const REPO_ROOT = dirname(dirname(FUNCTIONS_ROOT));
const require = createRequire(join(REPO_ROOT, "package.json"));
const { build } = require("esbuild") as {
  build: (options: Record<string, unknown>) => Promise<unknown>;
};

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-rollout-controls-" });

const SUPABASE_URL = "https://api.postora.invalid";
const ANON_KEY = "synthetic-anon-key";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const BEARER = "synthetic.owner.bearer";
const CRON_SECRET = "synthetic-cron-secret";

interface Probe {
  readonly clients: Array<{ url: string; key: string; authorization: string | null }>;
  readonly claimTokens: string[];
  readonly rpcCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    key: string;
    authorization: string | null;
  }>;
  readonly reads: Array<{ table: string; filters: Record<string, unknown> }>;
  readonly inserts: Array<{ table: string; row: Record<string, unknown>; clientKey: string }>;
  readonly claims: unknown;
  readonly rpc: Record<string, unknown>;
  appSettings: Record<string, unknown>;
  socialAccounts: Record<string, unknown>;
  tables: Record<string, unknown[]>;
  /** True when the rollout migration is NOT deployed on this database. */
  newSqlUnavailable: boolean;
}

function newProbe(): Probe {
  return {
    clients: [],
    claimTokens: [],
    rpcCalls: [],
    reads: [],
    inserts: [],
    claims: { data: { claims: { sub: OWNER_ID, role: "authenticated" } }, error: null },
    rpc: {},
    appSettings: {
      collection_instagram_insights_enabled: { data: { value: true }, error: null },
      credential_facebook_user_mode: { data: { value: "legacy" }, error: null },
    },
    socialAccounts: {},
    tables: {},
    newSqlUnavailable: false,
  };
}

/**
 * The Supabase client stub.
 *
 * It is a behavioural composition control, not a database: it answers by
 * table and by function name, and it records what was asked and with which
 * credential. The owner enqueue is refused for any caller that is not the
 * verified bearer, which is the impersonation the accepted SQL refuses.
 */
const STUB_SOURCE = `
export function createClient(url, key, options) {
  const probe = globalThis.__postoraRolloutProbe;
  const headers = options && options.global && options.global.headers ? options.global.headers : {};
  const authorization = headers.Authorization ? headers.Authorization : null;
  probe.clients.push({ url, key, authorization });

  const rows = (table, filters) => {
    if (table === "app_settings") {
      // The stored entry IS the driver envelope of an app_settings row.
      const row = probe.appSettings[filters.key];
      return row ? row : { data: null, error: null };
    }
    if (table === "social_accounts") {
      // The stored entry is the ROW, and the envelope is built here.
      const row = probe.socialAccounts[filters.id];
      return { data: row ? row : null, error: null };
    }
    const list = probe.tables[table];
    return { data: list ? list : [], count: list ? list.length : 0, error: null };
  };

  const from = (table) => {
    const filters = {};
    const builder = {
      select() { return builder; },
      eq(column, value) { filters[column] = value; return builder; },
      gt() { return builder; },
      lte() { return builder; },
      abortSignal() { return builder; },
      in() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      range() { return builder; },
      async maybeSingle() {
        probe.reads.push({ table, filters });
        const answer = rows(table, filters);
        return Array.isArray(answer.data) ? { ...answer, data: answer.data[0] ?? null } : answer;
      },
      async insert(row) {
        probe.inserts.push({ table, row, clientKey: key });
        return { data: null, error: null };
      },
      then(resolve, reject) {
        probe.reads.push({ table, filters });
        return Promise.resolve(rows(table, filters)).then(resolve, reject);
      },
    };
    return builder;
  };

  return {
    auth: {
      async getClaims(token) {
        probe.claimTokens.push(token);
        return probe.claims;
      },
    },
    rpc(name, args) {
      const rpcResult = (answer) => {
        const pending = Promise.resolve(answer);
        pending.abortSignal = () => pending;
        return pending;
      };
      probe.rpcCalls.push({ name, args, key, authorization });
      if (name === "enqueue_instagram_collection_job" && authorization !== ${JSON.stringify(`Bearer ${BEARER}`)}) {
        return rpcResult({ data: null, error: { code: "42501" } });
      }
      // The rollout schema is NOT deployed: the new functions answer the
      // way PostgREST answers a function that does not exist.
      if (probe.newSqlUnavailable && (name === "authorize_instagram_collection_provider_call" || name === "claim_instagram_collection_jobs")) {
        return rpcResult({ data: null, error: { code: "PGRST202" } });
      }
      const answer = probe.rpc[name];
      if (answer === undefined) return rpcResult({ data: null, error: null });
      if (typeof answer === "function") return rpcResult(answer(args));
      return rpcResult(answer);
    },
    from,
  };
}
`;

const bundles = new Map<string, string>();
let importSeq = 0;

async function bundle(entry: string): Promise<string> {
  const cached = bundles.get(entry);
  if (cached) return cached;

  await Deno.mkdir(BUNDLE_DIR, { recursive: true });
  const outfile = `${BUNDLE_DIR}/${entry.replaceAll(/[\\/]/g, "-")}-${++importSeq}.mjs`;

  await build({
    entryPoints: [join(FUNCTIONS_ROOT, entry)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile,
    plugins: [{
      name: "infrastructure-ports",
      setup(esbuild: {
        onResolve: (
          options: { filter: RegExp },
          callback: (args: { path: string }) => unknown,
        ) => void;
        onLoad: (
          options: { filter: RegExp; namespace: string },
          callback: () => unknown,
        ) => void;
      }) {
        esbuild.onResolve({ filter: /.*/ }, (args) => {
          const path = args.path;
          if (path.includes("@supabase/supabase-js") || path.includes("esm.sh/@supabase")) {
            return { path: "port", namespace: "stub" };
          }
          // The Node builtins the shared auth helper uses are external: the
          // Deno runtime provides them.
          if (path.startsWith("node:")) {
            return { path, external: true };
          }
          if (path.startsWith("npm:")) {
            return { path, external: true };
          }
          return undefined;
        });
        esbuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: STUB_SOURCE,
          loader: "js",
        }));
      },
    }],
  });

  bundles.set(entry, outfile);
  return outfile;
}

const originalServe = Deno.serve;
const originalEnv = {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  CRON_SECRET: Deno.env.get("CRON_SECRET"),
};

globalThis.addEventListener("unload", () => {
  Deno.serve = originalServe;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    Deno.removeSync(BUNDLE_DIR, { recursive: true });
  } catch (_error) {
    // A failed temp cleanup must not hide the test result.
  }
});

type RouteHandler = (request: Request) => Response | Promise<Response>;

async function loadRoute(probe: Probe): Promise<RouteHandler> {
  const globals = globalThis as { __postoraRolloutProbe?: Probe };
  globals.__postoraRolloutProbe = probe;

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("CRON_SECRET", CRON_SECRET);

  let handler: RouteHandler | null = null;
  const previousServe = Deno.serve;
  Deno.serve = ((registered: RouteHandler) => {
    handler = registered;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  }) as typeof Deno.serve;

  try {
    const outfile = await bundle("instagram-insights-sync/index.ts");
    await import(`${pathToFileURL(outfile).href}?case=${++importSeq}`);
  } finally {
    Deno.serve = previousServe;
  }

  if (!handler) throw new Error("instagram-insights-sync did not register a request handler");
  return handler as RouteHandler;
}

/** The ACTUAL registered report route. */
async function loadReportRoute(probe: Probe): Promise<RouteHandler> {
  const globals = globalThis as { __postoraRolloutProbe?: Probe };
  globals.__postoraRolloutProbe = probe;

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);

  const outfile = await bundle("instagram-insights-report/index.ts");
  const module = await import(`${pathToFileURL(outfile).href}?case=${++importSeq}`);
  const handler = (module as { handler?: RouteHandler }).handler;
  if (!handler) throw new Error("instagram-insights-report did not export a handler");
  return handler;
}

function post(body: unknown, bearer: string = BEARER): Request {
  return new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

const ENQUEUE_ACCEPTED = {
  data: {
    accepted: true,
    reason: "enqueued",
    job_id: JOB_A,
    job_generation: 1,
    status: "queued",
    captured_on: CAPTURED_ON,
    created: true,
    accepted_at: "2026-10-28T09:00:00+00:00",
  },
  error: null,
};

const STATUS_PROJECTION = {
  data: {
    target_kind: "owner",
    target_id: ACCOUNT_B,
    captured_on: CAPTURED_ON,
    status: "partial",
    job_generation: 3,
    attempts: 2,
    due_at: "2026-10-28T07:00:00+00:00",
    next_retry_at: null,
    last_attempt_at: "2026-10-28T07:00:00+00:00",
    last_partial_at: "2026-10-28T07:00:00+00:00",
    last_success_at: null,
    reason_code: "provider_throttled",
    inventory: {
      truncated: false,
      partial: false,
      window_covered: true,
      oldest_returned_at: "2026-10-28T07:00:00+00:00",
      gap_reason: null,
      pages_fetched: 4,
    },
    pending_operations: 7,
  },
  error: null,
};

Deno.test("the actual route runs the owner actions as the verified caller", async () => {
  const probe = newProbe();
  probe.rpc["enqueue_instagram_collection_job"] = ENQUEUE_ACCEPTED;
  probe.rpc["read_instagram_collection_job_status"] = STATUS_PROJECTION;

  const handler = await loadRoute(probe);

  const enqueue = await handler(post({ action: "enqueue", social_account_id: ACCOUNT_A }));
  assertEquals(enqueue.status, 202);

  const status = await handler(post({ action: "status", social_account_id: ACCOUNT_B }));
  assertEquals(status.status, 200);

  // Both owner RPCs ran on the PUBLIC key with the caller's OWN bearer.
  const ownerCalls = probe.rpcCalls.filter((call) =>
    call.name === "enqueue_instagram_collection_job" ||
    call.name === "read_instagram_collection_job_status"
  );
  assertEquals(ownerCalls.length, 2);
  for (const call of ownerCalls) {
    assertEquals(call.key, ANON_KEY);
    assertEquals(call.authorization, `Bearer ${BEARER}`);
  }

  // The service client read the two settings and wrote the audit row. It
  // never ran an owner RPC.
  assertEquals(probe.rpcCalls.filter((call) => call.key === SERVICE_ROLE_KEY).length, 0);
});

Deno.test("the actual route refuses a service identity on the owner actions", async () => {
  const probe = newProbe();
  probe.rpc["enqueue_instagram_collection_job"] = ENQUEUE_ACCEPTED;

  const handler = await loadRoute(probe);
  const response = await handler(post({ action: "enqueue", social_account_id: ACCOUNT_A }, SERVICE_ROLE_KEY));

  // The service key is not an owner session. The enqueue ran with the
  // SERVICE credential, the accepted SQL refused it, and the endpoint
  // answered with the one 401 - it never reported an enqueue.
  assertEquals(response.status, 401);
  assertEquals((await body(response)).error, "unauthorized");

  const enqueueCalls = probe.rpcCalls.filter((call) =>
    call.name === "enqueue_instagram_collection_job"
  );
  assertEquals(enqueueCalls.length, 1);
  // The request ran as the CALLER: the public key with the service key as
  // the bearer. PostgreSQL therefore derives the owner from the service
  // identity, and the accepted SQL refuses it.
  assertEquals(enqueueCalls[0]!.key, ANON_KEY);
  assertEquals(enqueueCalls[0]!.authorization, `Bearer ${SERVICE_ROLE_KEY}`);
});

Deno.test("the actual route maps a rollout refusal to one 403 and creates nothing", async () => {
  const probe = newProbe();
  probe.rpc["enqueue_instagram_collection_job"] = {
    data: {
      accepted: false,
      refused: true,
      reason_code: "collection_not_eligible",
      captured_on: CAPTURED_ON,
    },
    error: null,
  };

  const handler = await loadRoute(probe);
  const response = await handler(post({ action: "enqueue", social_account_id: ACCOUNT_B }));

  assertEquals(response.status, 403);
  assertEquals((await body(response)).error, "collection_not_eligible");

  // The refusal created nothing and mutated nothing: the only write is the
  // audit row of the request itself. No scope, no health and no credential
  // row was touched.
  assertEquals(probe.inserts.length, 1);
  assertEquals(probe.inserts[0]!.table, "system_logs");
  assertEquals(
    probe.inserts.every((entry) => entry.table === "system_logs"),
    true,
  );
  assertEquals(
    probe.rpcCalls.some((call) =>
      call.name === "complete_instagram_collection_job" ||
      call.name === "persist_instagram_collection_snapshot" ||
      call.name === "record_instagram_collection_job_progress"
    ),
    false,
  );
});

Deno.test("the actual route keeps a drain behind a service credential", async () => {
  const probe = newProbe();
  probe.rpc["claim_instagram_collection_jobs"] = { data: [], error: null };

  const handler = await loadRoute(probe);

  const privileged = await handler(post({ action: "drain" }, CRON_SECRET));
  assertEquals(privileged.status, 200);

  const plainUser = await handler(post({ action: "drain" }));
  assertEquals(plainUser.status, 403);
  assertEquals((await body(plainUser)).error, "forbidden");
});

Deno.test("the actual route refuses the off state before the new SQL is touched", async () => {
  const probe = newProbe();
  // The rollout migration is NOT deployed on this database.
  probe.newSqlUnavailable = true;
  probe.appSettings = {
    collection_instagram_insights_enabled: { data: null, error: null },
    credential_facebook_user_mode: { data: { value: "legacy" }, error: null },
  };

  const handler = await loadRoute(probe);
  const response = await handler(post({ action: "drain" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await body(response)).error, "collection_disabled");

  // The master switch is the FIRST gate: the new rollout SQL is never
  // called, and no worker is built.
  assertEquals(
    probe.rpcCalls.some((call) =>
      call.name === "authorize_instagram_collection_provider_call" ||
      call.name === "claim_instagram_collection_jobs"
    ),
    false,
  );
  assertEquals(
    probe.reads.filter((read) => read.table === "app_settings").length,
    1,
  );
});

Deno.test("the stored report stays readable through the existing report route", async () => {
  const probe = newProbe();
  // The excluded account B still owns its history.
  probe.socialAccounts[ACCOUNT_B] = {
    id: ACCOUNT_B,
    user_id: OWNER_ID,
    platform: "instagram",
  };
  probe.tables["ig_media_insight_snapshots"] = [
    {
      id: "snapshot-1",
      user_id: OWNER_ID,
      social_account_id: ACCOUNT_B,
      ig_media_id: "media-1",
      published_at: "2026-10-20T12:00:00+00:00",
      captured_at: "2026-10-20T13:00:00+00:00",
      captured_on: CAPTURED_ON,
      capture_timezone: "Asia/Kuwait",
      status: "ok",
      views: 200,
      reach: 100,
    },
  ];
  probe.tables["ig_account_insight_daily"] = [
    {
      id: "daily-1",
      user_id: OWNER_ID,
      social_account_id: ACCOUNT_B,
      metric_date: PRIMARY_DAY,
      provider_date: PRIMARY_DAY,
      period_start: `${PRIMARY_DAY}T00:00:00+00:00`,
      period_end: `${PRIMARY_DAY}T23:59:59+00:00`,
      provider_timezone: "Asia/Kuwait",
      status: "ok",
      captured_at: "2026-10-28T06:00:00+00:00",
      reach: 450,
    },
  ];
  probe.tables["ig_account_profile_observations"] = [
    {
      id: "profile-1",
      user_id: OWNER_ID,
      social_account_id: ACCOUNT_B,
      observed_at: "2026-10-28T06:00:00+00:00",
      observed_on: CAPTURED_ON,
      capture_timezone: "Asia/Kuwait",
      status: "ok",
      followers_count: 3200,
      media_count: 42,
    },
  ];
  probe.rpc["read_instagram_collection_job_status"] = {
    ...STATUS_PROJECTION,
    data: { ...STATUS_PROJECTION.data, reason_code: "throttled" },
  };

  const handler = await loadReportRoute(probe);
  const response = await handler(
    new Request(
      `https://api.postora.invalid/functions/v1/instagram-insights-report?social_account_id=${ACCOUNT_B}`,
      { method: "GET", headers: { Authorization: `Bearer ${BEARER}` } },
    ),
  );

  // The report of an EXCLUDED account is still readable: the rollout policy
  // decides what may be COLLECTED, not what may be READ.
  assertEquals(response.status, 200);
  const payload = await body(response);
  assertEquals(payload.scope === undefined, false);
});
