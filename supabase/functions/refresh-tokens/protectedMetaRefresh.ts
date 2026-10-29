/**
 * Protected Meta refresh gate.
 *
 * The gate decides one thing: does this Meta account refresh through the
 * protected lifecycle, through the legacy lifecycle, or not at all.
 *
 * WHAT CHANGED
 *
 *   The direct Instagram refresh is supported. The accepted SQL
 *   (`20261027120000_meta_account_refresh_lifecycle.sql`) captures the token
 *   and its authority in one transaction, consumes that capture on success
 *   and on failure, and owns the counters, the escalation, the alert marker
 *   and the partner event. The route no longer refuses that path.
 *
 *   The Facebook Page and the shared Facebook User grant used to be refused
 *   here, before the capture, before the provider and before any operational
 *   write. They are now handled by the Page reconciliation branch, which
 *   lives in `protectedPageReconciliation.ts` and is reached through the
 *   additive `supportedMeta` gate below. A shared-User grant is still never
 *   renewed here: the Page branch derives an operational Page token from the
 *   UNCHANGED captured grant, and the renewal of that grant stays the
 *   reconnect/OAuth path.
 *
 * THE ORDER OF THE PROTECTED PATH
 *
 *   The protected service is reached exactly once per target, before any
 *   legacy attempt marker, before any legacy cooldown handling, before the
 *   legacy no-token failure write, before the legacy platform switch and
 *   before the legacy catch. Once it is reached, the legacy path is not an
 *   option: the accepted SQL owns the attempt marker, the health columns and
 *   the failure policy, and a second, unfenced write would contradict it.
 *
 *   The order inside the protected path is a set of fences, cheapest first:
 *   the scheduled cooldown, the strict capability read, the conservative age
 *   admission, then the capture, then the provider, then the single atomic
 *   consume.
 */

import {
  type FacebookCredentialMode,
  type LifecycleRefusal,
  refuseProtectedLifecycle,
} from "../_shared/facebookCredentialMode.ts";
import type { InstagramAccountCapabilityPort } from "../_shared/facebookUserCredentialStore.ts";
import { ACCOUNT_WORST_CASE_MS } from "./sweepBudget.ts";
import {
  assertDirectCaptureAgrees,
  isIndeterminateStoreOutcome,
  isMetaRefreshStoreError,
  readFiniteTimestamp,
  type MetaRefreshCaptureTarget,
  type MetaRefreshDirectWriteResult,
  type MetaRefreshErrorCategory,
  type MetaRefreshFailureResult,
  type MetaRefreshStore,
  type MetaRefreshStoreError,
} from "./metaRefreshStore.ts";
import {
  createAccountRefreshBudget,
  type MetaRefreshTransport,
  type ProtectedAlertResult,
} from "./metaRefreshProvider.ts";

export interface MetaRefreshPorts {
  exchange: () => Promise<unknown>;
  markAttempt: () => Promise<unknown>;
  writeHealth: () => Promise<unknown>;
  sendAlert: () => Promise<unknown>;
  recordEvent: () => Promise<unknown>;
}

export function isProtectedMetaRefreshPlatform(platform: string): boolean {
  return platform === "facebook" || platform === "instagram";
}

function assertUncalledPorts(ports: MetaRefreshPorts): void {
  if (
    typeof ports.exchange !== "function" ||
    typeof ports.markAttempt !== "function" ||
    typeof ports.writeHealth !== "function" ||
    typeof ports.sendAlert !== "function" ||
    typeof ports.recordEvent !== "function"
  ) {
    throw new Error("Meta refresh ports are incomplete");
  }
}

/** Tripwire used by production. Protected refresh must not call these. */
export function refreshTripwirePorts(): MetaRefreshPorts {
  const forbid = (kind: string) => () =>
    Promise.reject(new Error(`protected refresh ${kind} invoked`));
  return {
    exchange: forbid("exchange"),
    markAttempt: forbid("markAttempt"),
    writeHealth: forbid("writeHealth"),
    sendAlert: forbid("sendAlert"),
    recordEvent: forbid("recordEvent"),
  };
}

/**
 * Refuses the protected Facebook and shared-User paths, and runs the legacy
 * path for every other platform and for Meta while the mode is legacy. A
 * thrown legacy error is the caller's existing failure handler. A protected
 * refusal never reaches it.
 *
 * `supportedDirect` is the accepted direct Instagram branch. It is offered for
 * Instagram only, and only when the caller wired it. Without it the gate
 * refuses exactly as it did before, which is what the existing refusal
 * callers and their tests rely on.
 *
 * `supportedMeta` is the additive protected-Meta gate. It is checked BEFORE
 * `supportedDirect` and it covers BOTH protected platforms, so the caller can
 * decide, inside the branch, whether the account is a direct Instagram
 * account or a Page-linked one. A caller that does not wire it keeps the exact
 * previous behavior of this function.
 */
export async function settleMetaRefreshAttempt<T>(input: {
  mode: FacebookCredentialMode;
  platform: string;
  trigger: "scheduled" | "manual";
  ports: MetaRefreshPorts;
  legacy: () => Promise<T>;
  onLegacyFailure: (error: unknown) => Promise<T>;
  supportedDirect?: () => Promise<T>;
  supportedMeta?: () => Promise<T>;
}): Promise<LifecycleRefusal | T> {
  assertUncalledPorts(input.ports);
  if (input.mode === "protected" && isProtectedMetaRefreshPlatform(input.platform)) {
    // The protected-Meta gate comes first. It decides the branch itself, so
    // the accepted direct branch below is never reached for an account the
    // gate already handled.
    if (input.supportedMeta) {
      return input.supportedMeta();
    }
    if (input.platform === "instagram" && input.supportedDirect) {
      return input.supportedDirect();
    }
    return refuseProtectedLifecycle("meta_refresh", input.trigger);
  }
  try {
    return await input.legacy();
  } catch (error) {
    return input.onLegacyFailure(error);
  }
}

// ---------------------------------------------------------------------------
// The supported direct Instagram branch
// ---------------------------------------------------------------------------

/**
 * The conservative minimum age of the credential authority.
 *
 * This is NOT the age of the token. It is the time since the last authority
 * change of the account, and the only timestamp that can be trusted for that
 * is `credential_updated_at`.
 *
 * The official Meta reference requires an existing token to be at least 24
 * hours old. It documents no error for a younger token, so no provider
 * classification exists for it and none is invented here. Instead the
 * refresh waits until the account has been alone for 24 hours.
 *
 * The cost of that conservatism is real and must not be hidden: a health-only
 * change also advances this timestamp, so a failed attempt can delay the next
 * refresh by 24 hours, and an account without a valid authority timestamp is
 * not supported by this slice at all.
 */
export const PROTECTED_REFRESH_MIN_AUTHORITY_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The scheduled attempt cooldown. It is a genuine last-attempt guard: the
 * accepted SQL records the attempt marker inside the capture transaction, so
 * the next sweep sees it and waits. A manual force bypasses it, exactly like
 * the legacy route bypasses the window and the cooldown.
 */
export const PROTECTED_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Stable reasons. They are the whole error surface of this module: no
 * provider text, no account data and no token ever reaches a log, a history
 * row or a browser response.
 */
export const PROTECTED_REFRESH_REASONS = {
  unsupportedOperation: "protected_unsupported_operation",
  ownerUnknown: "protected_owner_unknown",
  capabilityReadFailed: "protected_capability_read_failed",
  tokenAgeUnproven: "token_age_unproven",
  authorityRecent: "authority_recent",
  refreshCooldown: "refresh_cooldown",
  captureContextMismatch: "capture_context_mismatch",
  captureFailed: "capture_failed",
  providerUnclassified: "provider_unclassified",
  providerTransportFailed: "provider_transport_failed",
  refreshCommittedFailure: "refresh_committed_failure",
  refreshCommitIndeterminate: "refresh_commit_indeterminate",
} as const;

export type ProtectedRefreshReason =
  (typeof PROTECTED_REFRESH_REASONS)[keyof typeof PROTECTED_REFRESH_REASONS];

export interface ProtectedDirectAccount {
  id: string;
  /** The owner of the validated account row. Never a request body value. */
  userId: string;
  platform: string;
  platformUsername?: string | null;
  platformUserId?: string | null;
  /** The last attempt marker of the account row, when it has one. */
  lastRefreshAttemptAt?: string | null;
}

export interface ProtectedDirectDeps {
  /** The accepted refresh SQL. */
  store: MetaRefreshStore;
  /** The strict owner-scoped capability read. */
  capabilities: InstagramAccountCapabilityPort;
  /** The bounded provider and alert transport. */
  transport: MetaRefreshTransport;
  /** The trusted service clock. */
  now?: () => Date;
  /** The combined per-account budget of the provider call and the alert. */
  accountBudgetMs?: number;
}

export type ProtectedRefreshOutcome =
  /** The token was written and the capture was consumed. */
  | { kind: "refreshed"; generation: number }
  /** The database recorded a classified provider failure. */
  | {
    kind: "committed_failure";
    category: MetaRefreshErrorCategory;
    failureCount: number;
    needsReauth: boolean;
    escalated: boolean;
    alert: ProtectedAlertResult | null;
  }
  /** The operation has no established transport. Refused before any work. */
  | { kind: "unsupported"; reason: ProtectedRefreshReason }
  /** Nothing was committed. The attempt may be retried later. */
  | { kind: "deferred"; reason: ProtectedRefreshReason }
  /** Nothing was committed and nothing was proven about the grant. */
  | { kind: "local_failure"; reason: string }
  /** A commit was attempted and its outcome is unknown. */
  | { kind: "indeterminate"; reason: string };

export type AuthorityAgeVerdict =
  | { kind: "eligible"; ageMs: number }
  | { kind: "unproven" }
  | { kind: "recent"; ageMs: number };

/**
 * The conservative age admission.
 *
 * A missing, malformed or future timestamp is unproven: there is no evidence
 * that the credential is old enough, and an unproven age is never treated as
 * an old one. A proven age below the threshold is recent.
 */
export function evaluateAuthorityAge(
  credentialUpdatedAt: string | null | undefined,
  now: Date,
): AuthorityAgeVerdict {
  const parsed = readFiniteTimestamp(credentialUpdatedAt);
  if (parsed === null) return { kind: "unproven" };
  const ageMs = now.getTime() - parsed;
  if (!Number.isFinite(ageMs) || ageMs < 0) return { kind: "unproven" };
  if (ageMs < PROTECTED_REFRESH_MIN_AUTHORITY_AGE_MS) return { kind: "recent", ageMs };
  return { kind: "eligible", ageMs };
}

/**
 * Whether the account was attempted recently.
 *
 * A marker that cannot be parsed does not block: it proves nothing about a
 * last attempt. A marker in the future blocks, exactly like the legacy
 * cooldown guard.
 */
export function isWithinProtectedRefreshCooldown(
  lastRefreshAttemptAt: string | null | undefined,
  now: Date,
): boolean {
  const parsed = readFiniteTimestamp(lastRefreshAttemptAt);
  if (parsed === null) return false;
  return now.getTime() - parsed < PROTECTED_REFRESH_COOLDOWN_MS;
}

/** The stable reason of a refused or failed database call. */
function storeFailureReason(error: MetaRefreshStoreError): string {
  switch (error.code) {
    case "schema_unavailable":
      return "refresh_schema_unavailable";
    case "invalid_payload":
      return "refresh_payload_invalid";
    case "refused":
      return "refresh_refused";
    case "stale":
      return "refresh_stale_capture";
    case "contended":
      return "refresh_contention";
    case "expired":
      return "refresh_supplied_expiry_passed";
    case "cancelled":
      return "refresh_cancelled";
    case "read_failed":
      return "refresh_store_unavailable";
    case "invalid_contract":
      return "refresh_contract_invalid";
  }
}

/**
 * The supported protected refresh of one direct Instagram account.
 *
 * Every refusal and every defer happens before the provider is contacted and
 * before any operational write. The provider is reached exactly once, with
 * the captured token, and the capture is consumed exactly once, by exactly
 * one of the two accepted writers.
 */
export async function refreshProtectedDirectAccount(input: {
  account: ProtectedDirectAccount;
  trigger: "scheduled" | "manual";
  /** A manual force bypasses the window and the cooldown, never the age. */
  bypassCooldown: boolean;
  deps: ProtectedDirectDeps;
}): Promise<ProtectedRefreshOutcome> {
  const clock = input.deps.now ?? (() => new Date());
  const now = clock();
  const account = input.account;
  const deps = input.deps;

  if (account.platform !== "instagram") {
    return { kind: "unsupported", reason: PROTECTED_REFRESH_REASONS.unsupportedOperation };
  }
  if (!account.userId) {
    return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.ownerUnknown };
  }

  // 1. The scheduled cooldown. The attempt marker of the accepted capture is
  //    the guard that makes this meaningful.
  if (!input.bypassCooldown && isWithinProtectedRefreshCooldown(account.lastRefreshAttemptAt, now)) {
    return { kind: "deferred", reason: PROTECTED_REFRESH_REASONS.refreshCooldown };
  }

  // 2. The strict owner-scoped capability read. A missing, failed or
  //    malformed read refuses. The account metadata and the `ig_auth_type`
  //    column are never protected authority.
  let capability;
  try {
    capability = await deps.capabilities.readCapability({
      userId: account.userId,
      socialAccountId: account.id,
    });
  } catch {
    return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.capabilityReadFailed };
  }
  if (capability.socialAccountId !== account.id) {
    return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.capabilityReadFailed };
  }
  if (!capability.capabilityPresent || capability.loginKind !== "direct") {
    // A page-linked account and every unknown classification stay refused,
    // before the capture, before the provider and before any write.
    return { kind: "unsupported", reason: PROTECTED_REFRESH_REASONS.unsupportedOperation };
  }

  // 3. The conservative age admission. A manual force does not bypass it.
  const age = evaluateAuthorityAge(capability.credentialUpdatedAt, now);
  if (age.kind === "unproven") {
    return { kind: "deferred", reason: PROTECTED_REFRESH_REASONS.tokenAgeUnproven };
  }
  if (age.kind === "recent") {
    return { kind: "deferred", reason: PROTECTED_REFRESH_REASONS.authorityRecent };
  }

  // 4. The capture. The database is the authority for eligibility and for
  //    the races; this route only checks that the capture describes the
  //    request that produced it.
  let begin;
  try {
    begin = await deps.store.beginDirect({
      userId: account.userId,
      socialAccountId: account.id,
    });
  } catch (error) {
    if (isMetaRefreshStoreError(error)) {
      return { kind: "local_failure", reason: storeFailureReason(error) };
    }
    return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.captureFailed };
  }

  try {
    // The clock is read again after the capture: the capture timestamp is
    // written by the database inside the capture transaction, so the reading
    // from before the call is always older than the capture itself.
    assertDirectCaptureAgrees(begin, {
      userId: account.userId,
      socialAccountId: account.id,
      platform: "instagram",
      platformUserId: account.platformUserId ?? null,
      expectedCapabilityGeneration: capability.credentialGeneration,
      now: clock(),
    });
  } catch {
    // The captured attempt is left for supersession or expiry. Nothing
    // failed against the grant, so there is no failure to record and no
    // second capture to take.
    return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.captureContextMismatch };
  }

  const captured = begin.capture.targets[0];
  const capturedToken = begin.tokens[0].token;

  // 5. The provider. One call, one deadline, no retry. Only the captured
  //    token is sent; the account row is never read for a token.
  const budget = createAccountRefreshBudget(
    deps.accountBudgetMs ?? ACCOUNT_WORST_CASE_MS,
    () => clock().getTime(),
  );

  let providerOutcome;
  try {
    providerOutcome = await deps.transport.refreshDirectToken({ capturedToken, budget });
  } catch {
    return { kind: "local_failure", reason: PROTECTED_REFRESH_REASONS.providerTransportFailed };
  }

  if (providerOutcome.kind === "unclassified_failure") {
    // The failure cannot be attributed to the provider or to the grant. The
    // capture is retained, no health column moves and no alert is sent.
    return { kind: "deferred", reason: PROTECTED_REFRESH_REASONS.providerUnclassified };
  }

  if (providerOutcome.kind === "classified_failure") {
    return commitProtectedFailure({
      deps,
      account,
      captured,
      captureId: begin.captureId,
      category: providerOutcome.category,
      budget,
    });
  }

  // 6. The success. The same capture, consumed by the direct writer. The
  //    shared-User writer is never used: it refuses a direct operation.
  let write;
  try {
    write = await deps.store.writeDirectSuccess({
      userId: account.userId,
      captureId: begin.captureId,
      accessToken: providerOutcome.accessToken,
      tokenExpiresAt: providerOutcome.tokenExpiresAt,
      ...(providerOutcome.refreshToken !== null
        ? { refreshToken: providerOutcome.refreshToken }
        : {}),
    });
  } catch (error) {
    if (isMetaRefreshStoreError(error) && !isIndeterminateStoreOutcome(error)) {
      // A definite refusal: the transaction rolled back, nothing was written.
      return { kind: "local_failure", reason: storeFailureReason(error) };
    }
    // The write may have committed before the answer was lost. This is not a
    // provider failure and it must never trigger a second consume.
    return {
      kind: "indeterminate",
      reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
    };
  }

  // The writer already committed. A receipt that does not describe this
  // direct success is indeterminate: it is not a rollback, it is not a
  // second failure consume, and it is not an alert.
  if (
    !directSuccessReceiptAgrees(
      write,
      captured,
      account,
      begin.captureId,
      providerOutcome.tokenExpiresAt,
    )
  ) {
    return {
      kind: "indeterminate",
      reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
    };
  }

  return { kind: "refreshed", generation: write.credentialGeneration };
}

/**
 * The committed direct success has to be this account, still direct, still
 * active, with no binding, the exact next generation, the captured
 * needs_reauth retained, and the expiry the provider actually returned.
 */
function directSuccessReceiptAgrees(
  write: MetaRefreshDirectWriteResult,
  captured: MetaRefreshCaptureTarget,
  account: ProtectedDirectAccount,
  captureId: string,
  providerExpiry: string,
): boolean {
  if (!write.account.found) return false;
  const state = write.account;
  if (write.captureId !== captureId) return false;
  if (write.operation !== "direct_token" || write.applied !== true) return false;
  if (state.socialAccountId !== account.id) return false;
  if (state.socialAccountId !== captured.socialAccountId) return false;
  if (state.platform !== "instagram" || state.loginKind !== "direct") return false;
  if (state.isActive !== true) return false;
  if (state.bindingCredentialId !== null) return false;
  if (state.bindingConnectionVersion !== null) return false;
  if (state.credentialRevision !== null) return false;
  if (captured.capabilityGeneration === null) return false;
  if (write.credentialGeneration !== captured.capabilityGeneration + 1) return false;
  if (state.credentialGeneration !== write.credentialGeneration) return false;
  if (state.needsReauth !== captured.needsReauth) return false;
  if (state.platformUserId !== captured.platformUserId) return false;
  if (
    account.platformUserId !== undefined &&
    account.platformUserId !== null &&
    state.platformUserId !== account.platformUserId
  ) {
    return false;
  }
  const providerExpiryMs = Date.parse(providerExpiry);
  if (state.tokenExpiresAt === null || !Number.isFinite(providerExpiryMs)) return false;
  if (state.tokenExpiresAt !== providerExpiryMs) return false;
  return true;
}

/**
 * A committed direct failure keeps the account context and advances the
 * fence by one. Health may change, including a new needs_reauth. The
 * returned counter has to be the account counter. A cleared needs_reauth
 * is not a trustworthy failure receipt.
 */
function directFailureReceiptAgrees(
  failure: MetaRefreshFailureResult,
  captured: MetaRefreshCaptureTarget,
  account: ProtectedDirectAccount,
  captureId: string,
  category: MetaRefreshErrorCategory,
): boolean {
  if (!failure.account.found) return false;
  const state = failure.account;
  if (failure.captureId !== captureId) return false;
  if (failure.applied !== true) return false;
  if (failure.errorCategory !== category) return false;
  if (failure.accountFound !== true) return false;
  if (state.socialAccountId !== account.id) return false;
  if (state.socialAccountId !== captured.socialAccountId) return false;
  if (state.platform !== "instagram" || state.loginKind !== "direct") return false;
  if (state.platformUserId !== captured.platformUserId) return false;
  if (
    account.platformUserId !== undefined &&
    account.platformUserId !== null &&
    state.platformUserId !== account.platformUserId
  ) {
    return false;
  }
  if (state.bindingCredentialId !== null) return false;
  if (state.bindingConnectionVersion !== null) return false;
  if (state.credentialRevision !== null) return false;
  if (captured.capabilityGeneration === null) return false;
  if (state.credentialGeneration !== captured.capabilityGeneration + 1) return false;
  if (failure.failureCount !== state.failureCount) return false;
  if (captured.needsReauth && !state.needsReauth) return false;
  return true;
}

/**
 * Consumes the capture with the accepted failure writer and, only when the
 * committed result carries the alert marker, sends the bounded notification.
 */
async function commitProtectedFailure(input: {
  deps: ProtectedDirectDeps;
  account: ProtectedDirectAccount;
  captured: MetaRefreshCaptureTarget;
  captureId: string;
  category: MetaRefreshErrorCategory;
  budget: ReturnType<typeof createAccountRefreshBudget>;
}): Promise<ProtectedRefreshOutcome> {
  const { deps, account, captured, captureId, category, budget } = input;

  let failure;
  try {
    failure = await deps.store.recordFailure({
      userId: account.userId,
      captureId,
      socialAccountId: account.id,
      errorCategory: category,
    });
  } catch (error) {
    if (isMetaRefreshStoreError(error) && !isIndeterminateStoreOutcome(error)) {
      return { kind: "local_failure", reason: storeFailureReason(error) };
    }
    // The failure may have been committed before the answer was lost. It is
    // not a second provider failure and it must not be consumed twice.
    return {
      kind: "indeterminate",
      reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
    };
  }

  // A new needs_reauth is a legitimate health change. Clearing a captured
  // needs_reauth is not. A receipt that disagrees is indeterminate: the
  // failure may already be committed, so it is not consumed again and it
  // does not send an alert.
  if (
    !failure.account.found ||
    !directFailureReceiptAgrees(failure, captured, account, captureId, category)
  ) {
    return {
      kind: "indeterminate",
      reason: PROTECTED_REFRESH_REASONS.refreshCommitIndeterminate,
    };
  }

  // The alert comes from the committed marker and the committed state, never
  // from a prediction. The database already counted the failure and already
  // decided whether this account may be told about it.
  let alert: ProtectedAlertResult | null = null;
  if (failure.alertMarkerWritten) {
    try {
      alert = await deps.transport.sendFailureAlert({
        accountId: account.id,
        platform: account.platform,
        username: account.platformUsername ?? null,
        userId: account.userId,
        errorCategory: failure.errorCategory,
        failureCount: failure.failureCount,
        needsReauth: failure.account.needsReauth,
        budget,
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
    needsReauth: failure.account.needsReauth,
    escalated: failure.escalated,
    alert,
  };
}
