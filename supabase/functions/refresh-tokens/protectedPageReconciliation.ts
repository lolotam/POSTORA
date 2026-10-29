/**
 * The protected Meta account entry: one classification, two branches.
 *
 * WHAT THIS MODULE OWNS
 *
 *   `refreshProtectedMetaAccount` is the one production entry of the protected
 *   Meta refresh. It decides, for ONE owned account, whether the account
 *   refreshes through the accepted direct Instagram branch, through the new
 *   Page reconciliation branch, or not at all.
 *
 *   The classification is strict and OWNED:
 *
 *     - Instagram: the owner-scoped capability read decides. `direct` enters
 *       the accepted direct branch unchanged. `page_linked` enters the Page
 *       reconciliation. An absent, unknown or inconsistent classification
 *       refuses.
 *     - Facebook: a Facebook Page enters the Page reconciliation. No
 *       Instagram capability is required for a Facebook Page.
 *
 *   Account metadata, the username and the `ig_auth_type` column are NOT
 *   authority. They never enter a classification.
 *
 * THE ORDER OF THE PROTECTED PATH
 *
 *   The protected path is reached exactly once per target, before any legacy
 *   attempt marker, before any legacy cooldown handling, before the legacy
 *   no-token failure write and before the legacy platform switch. A protected
 *   refusal never falls through to the legacy path.
 *
 * ONE DEADLINE
 *
 *   The Page account deadline starts BEFORE the capture, before the protected
 *   reads and before the provider, and it counts every elapsed millisecond.
 *   The accepted account ceiling (24s) and the accepted sweep ceiling (45s)
 *   stay in force. The provider stops while at least four seconds remain for
 *   the capture consume and the log line, and the combined ceilings are
 *   enforced together: six independent four-second requests would consume
 *   that reserve.
 *
 *   The classification read is part of that budget. When the account turns
 *   out to be direct, the direct branch receives the REMAINING budget, never
 *   a fresh full one, and the direct branch keeps its own capability, age and
 *   capture checks.
 *
 * SECRETS
 *
 *   The captured User secret exists only inside the capture. It is never
 *   logged, never written to history, never returned to the browser and never
 *   placed in a reason, a receipt or an error message.
 */

import {
  isWithinProtectedRefreshCooldown,
  PROTECTED_REFRESH_REASONS,
  refreshProtectedDirectAccount,
  type ProtectedDirectAccount,
  type ProtectedDirectDeps,
  type ProtectedRefreshOutcome,
} from "./protectedMetaRefresh.ts";
import type { InstagramAccountCapabilityPort } from "../_shared/facebookUserCredentialStore.ts";
import type { OperationBudget } from "../_shared/metaOAuthProtectedBoundary.ts";
import { ACCOUNT_WORST_CASE_MS } from "./sweepBudget.ts";
import {
  createPageReconciliationBudget,
  PAGE_PROVIDER_RESERVE_MS,
  PageBudgetExhausted,
  type MetaPageReconciliationProvider,
  type PageProviderProblem,
  type PageReconciliationBudget,
} from "./metaPageReconciliationProvider.ts";
import {
  isIndeterminatePageOutcome,
  isMetaPageReconciliationError,
  type MetaPageCapture,
  type MetaPageProtectedBinding,
  type MetaPageReconciliationStore,
  type MetaPageReconciliationWriteResult,
} from "./metaPageReconciliationStore.ts";
import {
  META_REFRESH_CAPTURE_CLOCK_SKEW_MS,
  type MetaRefreshErrorCategory,
  type MetaRefreshFailureResult,
} from "./metaRefreshStore.ts";
import type { MetaRefreshTransport, ProtectedAlertResult } from "./metaRefreshProvider.ts";

/**
 * The stable reasons of the Page branch.
 *
 * They are the whole error surface of the branch: no provider text, no
 * account data and no token ever reaches a log line, a history row or a
 * browser response.
 */
export const PROTECTED_PAGE_REFRESH_REASONS = {
  unsupportedOperation: "page_unsupported_operation",
  authorityUnknown: "page_authority_unknown",
  captureExpired: "page_capture_expired",
  captureIndeterminate: "page_capture_indeterminate",
  userMaterialMissing: "page_user_material_missing",
  userGrantExpired: "page_user_grant_expired",
  bindingReadFailed: "page_binding_read_failed",
  bindingMissing: "page_binding_missing",
  bindingDisagreement: "page_binding_disagreement",
  providerUnclassified: "provider_unclassified",
  providerIncomplete: "page_provider_incomplete",
  budgetExhausted: "page_budget_exhausted",
} as const;

export type ProtectedPageRefreshReason =
  (typeof PROTECTED_PAGE_REFRESH_REASONS)[keyof typeof PROTECTED_PAGE_REFRESH_REASONS];

/**
 * The outcome of one protected Meta account operation.
 *
 * `generation` is `number | null` because a FACEBOOK PAGE has no Instagram
 * capability generation: its authority is its connection fence, and the
 * accepted writer reports a null generation for it. The accepted DIRECT
 * outcome keeps its `generation: number` invariant; this union does not widen
 * it.
 */
export type ProtectedMetaAccountOutcome =
  | { kind: "refreshed"; generation: number | null }
  | {
    kind: "committed_failure";
    category: MetaRefreshErrorCategory;
    failureCount: number;
    needsReauth: boolean;
    escalated: boolean;
    alert: ProtectedAlertResult | null;
  }
  | { kind: "unsupported"; reason: string }
  | { kind: "deferred"; reason: string }
  | { kind: "local_failure"; reason: string }
  | { kind: "indeterminate"; reason: string };

export interface ProtectedMetaPageDeps {
  /** The accepted Page capture, the protected binding read and the writers. */
  store: MetaPageReconciliationStore;
  /** The bounded Graph provider. */
  provider: MetaPageReconciliationProvider;
  /** The accepted notification transport. Used for the committed failure only. */
  transport: MetaRefreshTransport;
  /**
   * How long one database call may keep the caller waiting.
   *
   * The caller stops waiting after this. It does NOT cancel the statement and
   * it is NOT proof that the transaction rolled back.
   */
  dbCallTimeoutMs?: number;
}

export interface ProtectedMetaAccountDeps {
  /** The accepted direct branch. Its behavior is unchanged. */
  direct: ProtectedDirectDeps;
  /** The Page reconciliation branch. */
  page: ProtectedMetaPageDeps;
  /** The trusted service clock. Shared by both branches. */
  now?: () => Date;
}

/**
 * The longest one database call may keep the caller waiting.
 *
 * The caller stops waiting after this. That does NOT cancel the statement and
 * it is NOT proof that the transaction rolled back: the outcome of a call
 * that timed out is unknown, and an unknown outcome is never a second
 * consume.
 */
export const PAGE_DB_CALL_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Bounded waiting
// ---------------------------------------------------------------------------

/**
 * Waits for one database call only until the deadline says so.
 *
 * A late rejection is attached so it can never surface as an unhandled
 * rejection. The statement itself is not cancelled.
 */
async function withinDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ status: "completed"; value: T } | { status: "timeout" }> {
  const wrapped = Promise.resolve(work);
  wrapped.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      wrapped.then((value) => ({ status: "completed" as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The persistence view of the account budget.
 *
 * The accepted alert transport asks for time; this hands out what is left of
 * the account budget and never a fresh one.
 */
function persistenceBudget(budget: PageReconciliationBudget): OperationBudget {
  return {
    take: (requestedMs: number) => budget.takePersistenceMs(requestedMs),
  };
}

/**
 * Reserves the time one database call may take.
 *
 * An exhausted budget is not an error: the operation defers without touching
 * a health counter and without an alert.
 */
function reserveDbTime(
  budget: PageReconciliationBudget,
  timeoutMs: number,
): number | null {
  try {
    return budget.takePersistenceMs(timeoutMs);
  } catch (error) {
    if (error instanceof PageBudgetExhausted) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

/**
 * Widens the accepted direct outcome into the shared account outcome.
 *
 * The direct branch keeps its own `generation: number`. This mapping does not
 * change it; it only lets both branches share one result shape.
 */
function widenDirectOutcome(outcome: ProtectedRefreshOutcome): ProtectedMetaAccountOutcome {
  switch (outcome.kind) {
    case "refreshed":
      return { kind: "refreshed", generation: outcome.generation };
    case "committed_failure":
      return {
        kind: "committed_failure",
        category: outcome.category,
        failureCount: outcome.failureCount,
        needsReauth: outcome.needsReauth,
        escalated: outcome.escalated,
        alert: outcome.alert,
      };
    case "unsupported":
      return { kind: "unsupported", reason: outcome.reason };
    case "deferred":
      return { kind: "deferred", reason: outcome.reason };
    case "local_failure":
      return { kind: "local_failure", reason: outcome.reason };
    case "indeterminate":
      return { kind: "indeterminate", reason: outcome.reason };
  }
}

/** The stable reason of a refused or failed database call. */
function pageStoreFailureReason(error: unknown): string {
  if (isMetaPageReconciliationError(error)) {
    switch (error.code) {
      case "schema_unavailable":
        return "refresh_schema_unavailable";
      case "capture_refused":
      case "write_refused":
      case "failure_refused":
        return "refresh_refused";
      case "capture_stale":
        return "refresh_stale_capture";
      case "capture_contended":
        return "refresh_contention";
      case "capture_expired":
        return "refresh_supplied_expiry_passed";
      case "capture_cancelled":
        return "refresh_cancelled";
      case "capture_malformed":
      case "write_malformed":
      case "failure_malformed":
        return "refresh_contract_invalid";
      case "capture_transport":
      case "write_transport":
      case "failure_transport":
        return "refresh_store_unavailable";
      case "binding_missing":
        return PROTECTED_PAGE_REFRESH_REASONS.bindingMissing;
      case "binding_malformed":
        return PROTECTED_PAGE_REFRESH_REASONS.bindingReadFailed;
      case "binding_disagreement":
        return PROTECTED_PAGE_REFRESH_REASONS.bindingDisagreement;
    }
  }
  return "page_operation_failed";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

async function readCapabilityBounded(input: {
  capabilities: InstagramAccountCapabilityPort;
  userId: string;
  socialAccountId: string;
  budget: PageReconciliationBudget;
  timeoutMs: number;
}): Promise<
  | { status: "ok"; capabilityPresent: boolean; loginKind: string | null }
  | { status: "failed" }
> {
  const timeoutMs = reserveDbTime(input.budget, input.timeoutMs);
  if (timeoutMs === null) return { status: "failed" };

  let settled: { status: "completed"; value: Awaited<ReturnType<InstagramAccountCapabilityPort["readCapability"]>> } | { status: "timeout" };
  try {
    settled = await withinDeadline(
      input.capabilities.readCapability({
        userId: input.userId,
        socialAccountId: input.socialAccountId,
      }),
      timeoutMs,
    );
  } catch {
    return { status: "failed" };
  }
  if (settled.status === "timeout") return { status: "failed" };

  const capability = settled.value;
  if (capability.socialAccountId !== input.socialAccountId) return { status: "failed" };
  return {
    status: "ok",
    capabilityPresent: capability.capabilityPresent === true,
    loginKind: capability.loginKind,
  };
}

// ---------------------------------------------------------------------------
// The entry
// ---------------------------------------------------------------------------

/**
 * The one protected Meta account operation.
 *
 * It classifies the account, then it runs the accepted direct branch or the
 * Page reconciliation. It never falls through to the legacy refresh, and it
 * never grants a protected account a second chance.
 */
export async function refreshProtectedMetaAccount(input: {
  account: ProtectedDirectAccount;
  trigger: "scheduled" | "manual";
  /** A manual force bypasses the window and the cooldown, never the evidence. */
  bypassCooldown: boolean;
  deps: ProtectedMetaAccountDeps;
}): Promise<ProtectedMetaAccountOutcome> {
  const { account, deps } = input;
  const clock = deps.now ?? deps.direct.now ?? (() => new Date());

  if (account.platform !== "instagram" && account.platform !== "facebook") {
    return { kind: "unsupported", reason: PROTECTED_PAGE_REFRESH_REASONS.unsupportedOperation };
  }
  if (!account.userId) {
    return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.ownerUnknown };
  }

  // The ONE deadline of this account operation. It starts before the
  // classification read, before the capture, before the protected read and
  // before the provider.
  const budget = createPageReconciliationBudget(
    deps.direct.accountBudgetMs ?? ACCOUNT_WORST_CASE_MS,
    () => clock().getTime(),
  );

  if (account.platform === "instagram") {
    const classification = await readCapabilityBounded({
      capabilities: deps.direct.capabilities,
      userId: account.userId,
      socialAccountId: account.id,
      budget,
      timeoutMs: deps.page.dbCallTimeoutMs ?? PAGE_DB_CALL_TIMEOUT_MS,
    });
    if (classification.status === "failed") {
      return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.capabilityReadFailed };
    }

    if (classification.capabilityPresent && classification.loginKind === "direct") {
      // The accepted direct branch, unchanged. It still reads the capability
      // itself, still applies the conservative 24 hour age admission and
      // still refuses a non-direct account before the capture. The remaining
      // budget is handed over; a fresh full budget is not.
      const remaining = budget.remainingMs();
      if (remaining <= 0) {
        return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.budgetExhausted };
      }
      return widenDirectOutcome(
        await refreshProtectedDirectAccount({
          account,
          trigger: input.trigger,
          bypassCooldown: input.bypassCooldown,
          deps: { ...deps.direct, now: clock, accountBudgetMs: remaining },
        }),
      );
    }

    if (classification.capabilityPresent && classification.loginKind === "page_linked") {
      return refreshProtectedPageAccount({
        account,
        trigger: input.trigger,
        bypassCooldown: input.bypassCooldown,
        deps,
        budget,
        clock,
      });
    }

    // Absent, unknown or inconsistent authority refuses. It never enters the
    // direct branch and it never enters the Page branch.
    return { kind: "unsupported", reason: PROTECTED_PAGE_REFRESH_REASONS.authorityUnknown };
  }

  // A Facebook Page enters the Page reconciliation. No Instagram capability
  // is required for a Facebook Page.
  return refreshProtectedPageAccount({
    account,
    trigger: input.trigger,
    bypassCooldown: input.bypassCooldown,
    deps,
    budget,
    clock,
  });
}

// ---------------------------------------------------------------------------
// The Page branch
// ---------------------------------------------------------------------------

/**
 * Whether the captured authority is still usable at this service clock.
 *
 * A capture up to five seconds in the future is normal clock skew. A capture
 * further ahead is not this attempt. Expiry is exact: the tolerance is not
 * added to it. A known User-grant expiry that has passed is a local reconnect,
 * not provider evidence. An unknown grant expiry is not treated as forever.
 */
function pageAuthorityAdmission(
  capture: MetaPageCapture,
  nowMs: number,
): "live" | "capture" | "user_grant" {
  if (!Number.isFinite(nowMs)) return "capture";
  if (nowMs + META_REFRESH_CAPTURE_CLOCK_SKEW_MS < capture.capturedAt) return "capture";
  if (nowMs >= capture.expiresAt) return "capture";
  if (capture.userTokenExpiresAt !== null && capture.userTokenExpiresAt <= nowMs) {
    return "user_grant";
  }
  return "live";
}

function deferStaleAuthority(
  admission: "capture" | "user_grant",
): ProtectedMetaAccountOutcome {
  return {
    kind: "deferred",
    reason: admission === "user_grant"
      ? PROTECTED_PAGE_REFRESH_REASONS.userGrantExpired
      : PROTECTED_PAGE_REFRESH_REASONS.captureExpired,
  };
}

async function refreshProtectedPageAccount(input: {
  account: ProtectedDirectAccount;
  trigger: "scheduled" | "manual";
  bypassCooldown: boolean;
  deps: ProtectedMetaAccountDeps;
  budget: PageReconciliationBudget;
  clock: () => Date;
}): Promise<ProtectedMetaAccountOutcome> {
  const { account, deps, budget, clock } = input;
  const dbCallTimeoutMs = deps.page.dbCallTimeoutMs ?? PAGE_DB_CALL_TIMEOUT_MS;

  // 1. The scheduled cooldown. There is NO 24 hour age admission here: this
  //    procedure derives an operational Page token from an EXISTING grant. It
  //    does not replace a token the provider has just minted, so the direct
  //    token's minimum age is not inherited.
  if (!input.bypassCooldown && isWithinProtectedRefreshCooldown(account.lastRefreshAttemptAt, clock())) {
    return { kind: "deferred", reason: PROTECTED_REFRESH_REASONS.refreshCooldown };
  }

  // 2. The capture. It is the only authority for the token that reaches the
  //    provider, and it is taken with the accepted `facebook_user_token`
  //    operation and exactly one explicit target.
  let capture: MetaPageCapture;
  try {
    const timeoutMs = reserveDbTime(budget, dbCallTimeoutMs);
    if (timeoutMs === null) {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.budgetExhausted };
    }
    const settled = await withinDeadline(
      deps.page.store.begin({
        userId: account.userId,
        socialAccountId: account.id,
        platform: account.platform,
        platformUserId: account.platformUserId ?? null,
      }),
      timeoutMs,
    );
    if (settled.status === "timeout") {
      // A capture MAY have been created. There is no provider work and no
      // automatic begin retry.
      return {
        kind: "indeterminate",
        reason: PROTECTED_PAGE_REFRESH_REASONS.captureIndeterminate,
      };
    }
    capture = settled.value;
  } catch (error) {
    if (isMetaPageReconciliationError(error) && isIndeterminatePageOutcome(error)) {
      return {
        kind: "indeterminate",
        reason: PROTECTED_PAGE_REFRESH_REASONS.captureIndeterminate,
      };
    }
    return { kind: "local_failure", reason: pageStoreFailureReason(error) };
  }

  // 3. The capture must still be live, and the captured material must be
  //    usable. The five-second tolerance admits a capture the database clock
  //    wrote slightly ahead of this service. It does not extend the expiry.
  const admitted = pageAuthorityAdmission(capture, clock().getTime());
  if (admitted !== "live") return deferStaleAuthority(admitted);
  if (capture.userToken.length === 0) {
    return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.userMaterialMissing };
  }

  // 4. The protected binding read. It happens ONLY after a valid capture, and
  //    it is the ONLY source of the protected Page identity.
  const connectionVersion = capture.target.bindingConnectionVersion;
  const subject = capture.credential.providerUserId;
  if (connectionVersion === null || subject === null) {
    return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.captureContextMismatch };
  }

  let binding: MetaPageProtectedBinding;
  try {
    const timeoutMs = reserveDbTime(budget, dbCallTimeoutMs);
    if (timeoutMs === null) {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.budgetExhausted };
    }
    const settled = await withinDeadline(
      deps.page.store.readProtectedBinding({
        userId: capture.userId,
        socialAccountId: capture.target.socialAccountId,
        credentialId: capture.credential.credentialId,
        connectionVersion,
      }),
      timeoutMs,
    );
    if (settled.status === "timeout") {
      // No provider work on unknown data.
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.bindingReadFailed };
    }
    binding = settled.value;
  } catch (error) {
    const code = isMetaPageReconciliationError(error) ? error.code : null;
    if (code === "binding_missing") {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.bindingMissing };
    }
    if (code === "binding_disagreement") {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.bindingDisagreement };
    }
    return { kind: "local_failure", reason: pageStoreFailureReason(error) };
  }

  // 5. The protected identity agreement. The binding must prove the captured
  //    Facebook User identity on BOTH platforms.
  if (binding.platform !== capture.target.platform) {
    return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.bindingDisagreement };
  }
  if (binding.verifiedFacebookUserId === null || binding.verifiedFacebookUserId !== subject) {
    return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.bindingDisagreement };
  }

  let pageId: string;
  let instagramUserId: string | null;
  if (capture.target.platform === "instagram") {
    // Instagram needs the FULL protected relationship: a verified Page, a
    // verified Instagram identity, and the Instagram identity equal to the
    // captured canonical identity.
    if (
      binding.verifiedFacebookPageId === null ||
      binding.verifiedInstagramUserId === null ||
      capture.target.platformUserId === null
    ) {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.bindingDisagreement };
    }
    if (binding.verifiedInstagramUserId !== capture.target.platformUserId) {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.bindingDisagreement };
    }
    pageId = binding.verifiedFacebookPageId;
    instagramUserId = binding.verifiedInstagramUserId;
  } else {
    // A Facebook Page's Page identity is its captured canonical identity. The
    // binding's Page and Instagram columns are legitimately null here.
    if (capture.target.platformUserId === null) {
      return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.captureContextMismatch };
    }
    if (
      binding.verifiedFacebookPageId !== null &&
      binding.verifiedFacebookPageId !== capture.target.platformUserId
    ) {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.bindingDisagreement };
    }
    pageId = capture.target.platformUserId;
    instagramUserId = null;
  }

  // The binding read can outlive the authority that authorized it. Recheck
  // the capture deadline, the known User-grant expiry and the remaining
  // whole-operation budget before any provider call. A locally expired
  // authority is a deferral: it is not a counted failure and not an alert.
  const stillAdmitted = pageAuthorityAdmission(capture, clock().getTime());
  if (stillAdmitted !== "live") return deferStaleAuthority(stillAdmitted);
  const remainingBeforeProvider = budget.remainingMs();
  if (!Number.isFinite(remainingBeforeProvider) || remainingBeforeProvider <= PAGE_PROVIDER_RESERVE_MS) {
    return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.budgetExhausted };
  }

  // 6. The provider. Three bounded calls, sequential, no retry, one deadline.
  //    Only the CAPTURED User secret authorizes the first two.
  const identity = await deps.page.provider.verifyUserSubject({
    capturedToken: capture.userToken,
    subject,
    budget,
  });
  if (identity.kind !== "verified") {
    return await providerProblemOutcome(identity, {
      deps,
      account,
      capture,
      budget,
    });
  }

  const discovery = await deps.page.provider.findProtectedPage({
    capturedToken: capture.userToken,
    pageId,
    budget,
  });
  if (discovery.kind !== "found") {
    return await providerProblemOutcome(discovery, {
      deps,
      account,
      capture,
      budget,
    });
  }

  const proof = await deps.page.provider.verifyPageIdentity({
    pageToken: discovery.pageToken,
    pageId,
    instagramUserId,
    budget,
  });
  if (proof.kind !== "verified") {
    return await providerProblemOutcome(proof, {
      deps,
      account,
      capture,
      budget,
    });
  }

  // 7. The single atomic consume. The ORIGINAL capture, once, with an
  //    explicit unknown expiry.
  let write: MetaPageReconciliationWriteResult;
  try {
    const timeoutMs = reserveDbTime(budget, dbCallTimeoutMs);
    if (timeoutMs === null) {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.budgetExhausted };
    }
    const settled = await withinDeadline(
      deps.page.store.writeSuccess({
        userId: capture.userId,
        captureId: capture.captureId,
        accessToken: discovery.pageToken,
        facebookPageId: pageId,
        instagramUserId,
      }),
      timeoutMs,
    );
    if (settled.status === "timeout") {
      // The write may have committed before the answer was lost. It is not a
      // rollback, not a second consume and not an alert.
      return {
        kind: "indeterminate",
        reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
      };
    }
    write = settled.value;
  } catch (error) {
    if (isMetaPageReconciliationError(error) && isIndeterminatePageOutcome(error)) {
      return {
        kind: "indeterminate",
        reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
      };
    }
    return { kind: "local_failure", reason: pageStoreFailureReason(error) };
  }

  // A receipt that does not describe THIS reconciliation is indeterminate: it
  // is not a rollback, not a second consume and not an alert.
  if (!pageSuccessReceiptAgrees(write, capture, account)) {
    return {
      kind: "indeterminate",
      reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
    };
  }

  return { kind: "refreshed", generation: write.credentialGeneration };
}

/**
 * A provider problem becomes an outcome.
 *
 * Only a RECOGNIZED structured provider error, attributable to this captured
 * grant or to this exact selected Page, becomes a counted failure. Everything
 * else defers without touching a health counter and without an alert.
 */
async function providerProblemOutcome(
  problem: PageProviderProblem,
  context: {
    deps: ProtectedMetaAccountDeps;
    account: ProtectedDirectAccount;
    capture: MetaPageCapture;
    budget: PageReconciliationBudget;
  },
): Promise<ProtectedMetaAccountOutcome> {
  if (problem.kind === "classified_failure") {
    return await commitProtectedPageFailure({
      deps: context.deps,
      account: context.account,
      capture: context.capture,
      category: problem.category,
      budget: context.budget,
    });
  }
  if (problem.kind === "unclassified_failure") {
    return { kind: "deferred", reason: PROTECTED_REFRESH_REASONS.providerUnclassified };
  }
  return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.providerIncomplete };
}

// ---------------------------------------------------------------------------
// Receipt agreement
// ---------------------------------------------------------------------------

/**
 * The committed Page success must be THIS account, still Page-linked, still
 * active, with the SAME User grant revision, an unknown expiry, a reset
 * failure evidence, the original canonical identity and the platform's own
 * fence progression.
 */
function pageSuccessReceiptAgrees(
  write: MetaPageReconciliationWriteResult,
  capture: MetaPageCapture,
  account: ProtectedDirectAccount,
): boolean {
  if (write.captureId !== capture.captureId) return false;
  if (write.operation !== "page_reconciliation") return false;
  if (write.applied !== true) return false;
  if (write.expiryState !== "unknown") return false;
  if (write.credentialId !== capture.credential.credentialId) return false;
  // The User grant revision is UNCHANGED: this writer never rotates the User
  // secret.
  if (write.credentialRevision !== capture.credential.revision) return false;

  const state = write.account;
  if (!state.found) return false;
  if (state.socialAccountId !== account.id) return false;
  if (state.socialAccountId !== capture.target.socialAccountId) return false;
  if (state.platform !== capture.target.platform) return false;
  if (state.isActive !== true) return false;
  // The canonical identity is unchanged.
  if (state.platformUserId !== capture.target.platformUserId) return false;
  // The User grant is untouched.
  if (state.credentialRevision !== capture.credential.revision) return false;
  // The protected binding is retained.
  if (state.bindingCredentialId !== capture.target.bindingCredentialId) return false;
  // The refresh-token presence is retained.
  if (state.refreshTokenPresent !== capture.target.refreshTokenPresent) return false;
  // Success preserves needs_reauth in both directions. Only the OAuth
  // lifecycle may clear it, and this writer must not latch it either.
  if (state.needsReauth !== capture.target.needsReauth) return false;
  // The accepted failure-evidence reset happened on this account.
  if (state.failureCount !== 0) return false;
  // The derived Page token has an EXPLICIT unknown expiry.
  if (state.tokenExpiresAt !== null) return false;

  if (capture.target.platform === "instagram") {
    if (state.loginKind !== "page_linked") return false;
    if (capture.target.capabilityGeneration === null) return false;
    if (write.credentialGeneration !== capture.target.capabilityGeneration + 1) return false;
    if (state.credentialGeneration !== write.credentialGeneration) return false;
    // The Instagram binding connection is unchanged.
    if (state.bindingConnectionVersion !== capture.target.bindingConnectionVersion) return false;
  } else {
    // A Facebook Page has no Instagram capability generation, and its
    // connection fence advances exactly once.
    if (write.credentialGeneration !== null) return false;
    if (state.credentialGeneration !== null) return false;
    if (capture.target.bindingConnectionVersion === null) return false;
    if (state.bindingConnectionVersion !== capture.target.bindingConnectionVersion + 1) {
      return false;
    }
  }

  return true;
}

/**
 * The accepted `meta_account_refresh_error_policy` decision for one captured
 * count. The runtime does not recompute health: it only recognises the
 * decision the SQL function is allowed to return.
 *
 * Transient holds the count and never escalates. Permanent counts once and
 * escalates. Counted counts once and escalates only at the ceiling of three.
 * An unknown category is not a decision.
 */
export function pageRefreshFailureDecision(
  category: MetaRefreshErrorCategory,
  capturedFailureCount: number,
): { failureCount: number; escalated: boolean } | null {
  if (!Number.isSafeInteger(capturedFailureCount) || capturedFailureCount < 0) return null;
  if (
    category === "provider_transient" ||
    category === "provider_rate_limited" ||
    category === "provider_unavailable" ||
    category === "local_internal_error"
  ) {
    return { failureCount: capturedFailureCount, escalated: false };
  }
  const next = capturedFailureCount + 1;
  if (!Number.isSafeInteger(next)) return null;
  if (
    category === "provider_auth_expired" ||
    category === "provider_auth_revoked" ||
    category === "provider_invalid_grant" ||
    category === "local_no_refresh_material"
  ) {
    return { failureCount: next, escalated: true };
  }
  if (
    category === "provider_error" ||
    category === "provider_permission_denied" ||
    category === "provider_response_invalid"
  ) {
    return { failureCount: next, escalated: next >= 3 };
  }
  return null;
}

/**
 * A committed Page failure keeps the account context and advances the
 * platform's own fence by one. The health columns must be the decision the
 * accepted policy makes from the captured count. A contradictory receipt is
 * not a second failure and not an alert.
 */
function pageFailureReceiptAgrees(
  failure: MetaRefreshFailureResult,
  capture: MetaPageCapture,
  account: ProtectedDirectAccount,
  captureId: string,
  category: MetaRefreshErrorCategory,
): boolean {
  if (failure.captureId !== captureId) return false;
  if (failure.applied !== true) return false;
  if (failure.errorCategory !== category) return false;
  if (failure.accountFound !== true) return false;

  const decision = pageRefreshFailureDecision(category, capture.target.failureCount);
  if (decision === null) return false;

  const state = failure.account;
  if (!state.found) return false;
  if (state.socialAccountId !== account.id) return false;
  if (state.socialAccountId !== capture.target.socialAccountId) return false;
  if (state.platform !== capture.target.platform) return false;
  if (state.isActive !== true) return false;
  if (state.platformUserId !== capture.target.platformUserId) return false;
  if (state.bindingCredentialId !== capture.target.bindingCredentialId) return false;
  if (state.credentialRevision !== capture.credential.revision) return false;
  if (state.refreshTokenPresent !== capture.target.refreshTokenPresent) return false;
  // Failure preserves the captured Page-token expiry. This writer does not
  // clear it; success is the path that stores an explicit unknown expiry.
  if (state.tokenExpiresAt !== capture.target.tokenExpiresAt) return false;
  if (failure.failureCount !== decision.failureCount) return false;
  if (state.failureCount !== decision.failureCount) return false;
  if (failure.escalated !== decision.escalated) return false;
  // needs_reauth is only ever set, never cleared. A transient failure may
  // therefore retain an already-true flag, and a latch cannot leave it false.
  if (state.needsReauth !== (capture.target.needsReauth || decision.escalated)) return false;
  // The alert marker requires escalation. A false marker stays legitimate
  // when escalation is true: the SQL snooze and the 24h cooldown are private
  // and are not in the capture, so this check must not predict marker true.
  if (failure.alertMarkerWritten && !failure.escalated) return false;
  // A transition is the false → true edge, and only when the policy latches.
  // Workspace inventory is not in the capture, so transitioned false is
  // always legitimate. When there was no transition the enqueue is zero.
  // A transition's enqueue count is not predicted from absent subscriptions.
  if (failure.transitioned && !(decision.escalated && !capture.target.needsReauth)) return false;
  if (!Number.isSafeInteger(failure.enqueued) || failure.enqueued < 0) return false;
  if (!failure.transitioned && failure.enqueued !== 0) return false;

  if (capture.target.platform === "instagram") {
    if (state.loginKind !== "page_linked") return false;
    if (capture.target.capabilityGeneration === null) return false;
    if (state.credentialGeneration !== capture.target.capabilityGeneration + 1) return false;
    if (state.bindingConnectionVersion !== capture.target.bindingConnectionVersion) return false;
  } else {
    if (state.credentialGeneration !== null) return false;
    if (capture.target.bindingConnectionVersion === null) return false;
    if (state.bindingConnectionVersion !== capture.target.bindingConnectionVersion + 1) {
      return false;
    }
  }

  return true;
}

/**
 * Consumes the capture with the accepted failure writer and, only when the
 * committed result carries the alert marker, sends the bounded notification.
 */
async function commitProtectedPageFailure(input: {
  deps: ProtectedMetaAccountDeps;
  account: ProtectedDirectAccount;
  capture: MetaPageCapture;
  category: MetaRefreshErrorCategory;
  budget: PageReconciliationBudget;
}): Promise<ProtectedMetaAccountOutcome> {
  const { deps, account, capture, category, budget } = input;

  let failure: MetaRefreshFailureResult;
  try {
    const timeoutMs = reserveDbTime(
      budget,
      deps.page.dbCallTimeoutMs ?? PAGE_DB_CALL_TIMEOUT_MS,
    );
    if (timeoutMs === null) {
      return { kind: "deferred", reason: PROTECTED_PAGE_REFRESH_REASONS.budgetExhausted };
    }
    const settled = await withinDeadline(
      deps.page.store.recordFailure({
        userId: capture.userId,
        captureId: capture.captureId,
        socialAccountId: capture.target.socialAccountId,
        errorCategory: category,
      }),
      timeoutMs,
    );
    if (settled.status === "timeout") {
      // The failure may have been committed before the answer was lost. It is
      // not a second provider failure and it must not be consumed twice.
      return {
        kind: "indeterminate",
        reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
      };
    }
    failure = settled.value;
  } catch (error) {
    if (isMetaPageReconciliationError(error) && isIndeterminatePageOutcome(error)) {
      return {
        kind: "indeterminate",
        reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
      };
    }
    return { kind: "local_failure", reason: pageStoreFailureReason(error) };
  }

  if (!pageFailureReceiptAgrees(failure, capture, account, capture.captureId, category)) {
    return {
      kind: "indeterminate",
      reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
    };
  }

  // The alert comes from the committed marker and the committed state, never
  // from a prediction. The database already counted the failure and already
  // decided whether this account may be told about it.
  const committedState = failure.account;
  const needsReauth = committedState.found ? committedState.needsReauth : false;
  let alert: ProtectedAlertResult | null = null;
  if (failure.alertMarkerWritten) {
    try {
      alert = await deps.page.transport.sendFailureAlert({
        accountId: account.id,
        platform: account.platform,
        username: account.platformUsername ?? null,
        userId: account.userId,
        errorCategory: failure.errorCategory,
        failureCount: failure.failureCount,
        needsReauth,
        budget: persistenceBudget(budget),
      });
    } catch {
      // A delivery failure is not a refresh failure. The committed failure,
      // its counter and its marker stay exactly as the database wrote them.
      alert = { outcome: "not_attempted", reason: "alert_delivery_failed" };
    }
  }

  return {
    kind: "committed_failure",
    category: failure.errorCategory,
    failureCount: failure.failureCount,
    needsReauth,
    escalated: failure.escalated,
    alert,
  };
}
