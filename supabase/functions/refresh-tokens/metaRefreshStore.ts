/**
 * Strict runtime adapter for the accepted protected Meta refresh SQL.
 *
 * WHY THIS MODULE EXISTS
 *
 *   The accepted refresh migration (`20261027120000_meta_account_refresh_lifecycle.sql`)
 *   is the authority for ownership, eligibility, fencing, counters and events.
 *   The edge function may not re-derive any of that. It may only:
 *
 *     - call the accepted functions with their exact payload shape,
 *     - check that what came back agrees with the request that produced it,
 *     - refuse anything it cannot prove.
 *
 *   Every validation in this file therefore answers one question: "does this
 *   payload describe the capture, the account and the operation I asked for?".
 *   A mismatch is a refusal, never a best-effort repair.
 *
 * SECRETS
 *
 *   `begin_meta_account_refresh` returns the captured token material on the
 *   service boundary. It exists in this module's return value and nowhere
 *   else: it is never logged, never written to history and never returned to
 *   the browser. The parsed shapes below are the only place a captured token
 *   exists as a typed value.
 *
 * CANONICAL CONTRACT
 *
 *   The parsed shapes are the contract. The exported TypeScript types are
 *   derived from the runtime validators with `ReturnType<typeof parse…>`, so a
 *   second, unchecked copy of the wire shape cannot drift away from the one
 *   the code actually enforces.
 */

import type { ServiceRpcCaller } from "../_shared/facebookUserCredentialStore.ts";

export const META_REFRESH_RPC = {
  begin: "begin_meta_account_refresh",
  writeDirect: "write_direct_instagram_account",
  recordFailure: "record_meta_refresh_failure",
} as const;

/**
 * The closed error vocabulary of the accepted SQL. The database owns the
 * policy of every one of these categories; this module only refuses a
 * category that the database would not accept.
 */
export type MetaRefreshErrorCategory =
  | "provider_transient"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "local_internal_error"
  | "provider_auth_expired"
  | "provider_auth_revoked"
  | "provider_invalid_grant"
  | "local_no_refresh_material"
  | "provider_error"
  | "provider_permission_denied"
  | "provider_response_invalid";

export const META_REFRESH_ERROR_CATEGORIES: readonly MetaRefreshErrorCategory[] = [
  "provider_transient",
  "provider_rate_limited",
  "provider_unavailable",
  "local_internal_error",
  "provider_auth_expired",
  "provider_auth_revoked",
  "provider_invalid_grant",
  "local_no_refresh_material",
  "provider_error",
  "provider_permission_denied",
  "provider_response_invalid",
];

export type MetaRefreshStoreErrorCode =
  /** The accepted functions are not present in this deployment. */
  | "schema_unavailable"
  /** The database refused the payload shape (MAR01). */
  | "invalid_payload"
  /** The database refused the request for an ownership or eligibility reason. */
  | "refused"
  /** The captured authority is stale, closed or no longer matches (MAR04). */
  | "stale"
  /** Another transaction holds the capture, or the discovered set drifted (MAR05). */
  | "contended"
  /** The supplied token expiry has already passed (MAR07). */
  | "expired"
  /** The statement was cancelled. A cancellation is not contention. */
  | "cancelled"
  /** The call could not be read. The outcome is unknown. */
  | "read_failed"
  /** The returned JSON did not match the contract. The outcome is unknown. */
  | "invalid_contract";

export class MetaRefreshStoreError extends Error {
  readonly code: MetaRefreshStoreErrorCode;
  /** The SQLSTATE, when the database raised one. */
  readonly sqlstate: string | null;

  constructor(code: MetaRefreshStoreErrorCode, message: string, sqlstate: string | null = null) {
    super(message);
    this.name = "MetaRefreshStoreError";
    this.code = code;
    this.sqlstate = sqlstate;
  }
}

export function isMetaRefreshStoreError(value: unknown): value is MetaRefreshStoreError {
  return value instanceof MetaRefreshStoreError;
}

/**
 * Whether the outcome of the call is unknown.
 *
 * A refusal is definite: the database raised, so the transaction rolled back
 * and nothing was written. A transport failure or an unusable response is
 * not: the statement may have committed before the answer was lost. The two
 * must never be reported the same way, because only the second one forbids a
 * retry of the same capture.
 */
export function isIndeterminateStoreOutcome(error: MetaRefreshStoreError): boolean {
  return error.code === "read_failed" || error.code === "invalid_contract";
}

// ---------------------------------------------------------------------------
// Strict runtime validation
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(value: object, key: string): { owned: true; value: unknown } | { owned: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return { owned: false };
  return { owned: true, value: descriptor.value };
}

function contractError(functionName: string, detail: string): MetaRefreshStoreError {
  return new MetaRefreshStoreError(
    "invalid_contract",
    `${functionName} returned an unusable payload (${detail})`,
  );
}

function requireRecord(functionName: string, value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw contractError(functionName, "not an object");
  return value;
}

function requireString(functionName: string, value: unknown, field: string): string {
  if (typeof value !== "string") throw contractError(functionName, `${field} is not a string`);
  return value;
}

function requireBoolean(functionName: string, value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw contractError(functionName, `${field} is not a boolean`);
  return value;
}

function requireInteger(functionName: string, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw contractError(functionName, `${field} is not an integer`);
  }
  return value;
}

function optionalInteger(
  functionName: string,
  value: unknown,
  field: string,
): number | null {
  // `undefined` is a missing property. The accepted SQL always emits the
  // key, so a missing key is not the null the column allows.
  if (value === undefined) throw contractError(functionName, `${field} is missing`);
  if (value === null) return null;
  return requireInteger(functionName, value, field);
}

/**
 * A nullable string column the accepted SQL always returns.
 *
 * `null` is a real null. A missing property arrives as `undefined` and is
 * malformed. Any other shape is malformed too. This does not turn a valid
 * null into a required string.
 */
function optionalString(
  functionName: string,
  value: unknown,
  field: string,
): string | null {
  if (value === undefined) throw contractError(functionName, `${field} is missing`);
  if (value === null) return null;
  if (typeof value !== "string") throw contractError(functionName, `${field} is not a string`);
  return value;
}

/**
 * A timestamp with an explicit zone.
 *
 * The database emits `2026-10-28T12:00:00.123456+00:00`. A naive local
 * time, an infinite timestamp and a non-string are all malformed: an
 * unproven timestamp must never be read as a recent one.
 */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

/**
 * The same rule, without an exception.
 *
 * `null` means the value is not a proven zoned timestamp. It is used where an
 * unproven value must be a verdict rather than a crash, for example the
 * conservative age admission.
 */
export function readFiniteTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFiniteTimestamp(functionName: string, value: unknown, field: string): number {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw contractError(functionName, `${field} is not a zoned timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw contractError(functionName, `${field} is not a finite timestamp`);
  return parsed;
}

function optionalTimestamp(
  functionName: string,
  value: unknown,
  field: string,
): number | null {
  if (value === undefined) throw contractError(functionName, `${field} is missing`);
  if (value === null) return null;
  return parseFiniteTimestamp(functionName, value, field);
}

// ---------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------

export function parseMetaRefreshAccountState(
  functionName: string,
  raw: unknown,
) {
  const row = requireRecord(functionName, raw);
  const found = requireBoolean(functionName, row.found, "found");
  if (!found) return { found: false as const };

  return {
    found: true as const,
    socialAccountId: requireString(functionName, row.social_account_id, "social_account_id"),
    platform: requireString(functionName, row.platform, "platform"),
    platformUserId: optionalString(functionName, row.platform_user_id, "platform_user_id"),
    loginKind: optionalString(functionName, row.login_kind, "login_kind"),
    credentialGeneration: optionalInteger(
      functionName,
      row.credential_generation,
      "credential_generation",
    ),
    bindingCredentialId: optionalString(
      functionName,
      row.binding_credential_id,
      "binding_credential_id",
    ),
    bindingConnectionVersion: optionalInteger(
      functionName,
      row.binding_connection_version,
      "binding_connection_version",
    ),
    credentialRevision: optionalInteger(
      functionName,
      row.credential_revision,
      "credential_revision",
    ),
    tokenExpiresAt: optionalTimestamp(functionName, row.token_expires_at, "token_expires_at"),
    refreshTokenPresent: requireBoolean(
      functionName,
      row.refresh_token_present,
      "refresh_token_present",
    ),
    failureCount: requireInteger(functionName, row.failure_count, "failure_count"),
    needsReauth: requireBoolean(functionName, row.needs_reauth, "needs_reauth"),
    isActive: requireBoolean(functionName, row.is_active, "is_active"),
  };
}

export type MetaRefreshAccountState = ReturnType<typeof parseMetaRefreshAccountState>;

export function parseMetaRefreshCaptureTarget(
  functionName: string,
  raw: unknown,
) {
  const row = requireRecord(functionName, raw);
  const fenceState = requireString(functionName, row.fence_state, "fence_state");
  if (fenceState !== "present" && fenceState !== "never_created") {
    throw contractError(functionName, "fence_state is not a known state");
  }
  const loginKind = optionalString(functionName, row.capability_login_kind, "capability_login_kind");
  if (loginKind !== null && loginKind !== "direct" && loginKind !== "page_linked") {
    throw contractError(functionName, "capability_login_kind is not a known login kind");
  }
  const failureCount = requireInteger(functionName, row.failure_count, "failure_count");
  if (failureCount < 0) throw contractError(functionName, "failure_count is negative");

  return {
    socialAccountId: requireString(functionName, row.social_account_id, "social_account_id"),
    platform: requireString(functionName, row.platform, "platform"),
    platformUserId: optionalString(functionName, row.platform_user_id, "platform_user_id"),
    bindingPresent: requireBoolean(functionName, row.binding_present, "binding_present"),
    bindingCredentialId: optionalString(
      functionName,
      row.binding_credential_id,
      "binding_credential_id",
    ),
    bindingConnectionVersion: optionalInteger(
      functionName,
      row.binding_connection_version,
      "binding_connection_version",
    ),
    fenceState: fenceState as "present" | "never_created",
    fenceConnectionVersion: requireInteger(
      functionName,
      row.fence_connection_version,
      "fence_connection_version",
    ),
    credentialRevision: optionalInteger(
      functionName,
      row.credential_revision,
      "credential_revision",
    ),
    providerUserId: optionalString(functionName, row.provider_user_id, "provider_user_id"),
    capabilityPresent: requireBoolean(functionName, row.capability_present, "capability_present"),
    capabilityGeneration: optionalInteger(
      functionName,
      row.capability_generation,
      "capability_generation",
    ),
    capabilityLoginKind: loginKind as "direct" | "page_linked" | null,
    capabilityPermissionReadState: optionalString(
      functionName,
      row.capability_permission_read_state,
      "capability_permission_read_state",
    ),
    tokenExpiresAt: optionalTimestamp(functionName, row.token_expires_at, "token_expires_at"),
    refreshTokenPresent: requireBoolean(
      functionName,
      row.refresh_token_present,
      "refresh_token_present",
    ),
    failureCount,
    needsReauth: requireBoolean(functionName, row.needs_reauth, "needs_reauth"),
    lastRefreshAttemptAt: parseFiniteTimestamp(
      functionName,
      row.last_refresh_attempt_at,
      "last_refresh_attempt_at",
    ),
  };
}

export type MetaRefreshCaptureTarget = ReturnType<typeof parseMetaRefreshCaptureTarget>;

export function parseMetaRefreshCapture(functionName: string, raw: unknown) {
  const row = requireRecord(functionName, raw);
  const captureVersion = requireInteger(functionName, row.capture_version, "capture_version");
  if (captureVersion !== 1) throw contractError(functionName, "capture_version is not 1");
  const operation = requireString(functionName, row.operation, "operation");
  if (
    operation !== "direct_token" &&
    operation !== "page_token" &&
    operation !== "facebook_user_token"
  ) {
    throw contractError(functionName, "operation is not an accepted operation");
  }
  const targets = row.targets;
  if (!Array.isArray(targets)) throw contractError(functionName, "targets is not an array");
  if (!Object.hasOwn(row, "members")) throw contractError(functionName, "members is missing");
  const members = row.members;
  if (members !== null && !Array.isArray(members)) {
    throw contractError(functionName, "members is not an array");
  }
  if (!Object.hasOwn(row, "credential")) {
    throw contractError(functionName, "credential is missing");
  }

  return {
    captureVersion: 1 as const,
    capturedAt: parseFiniteTimestamp(functionName, row.captured_at, "captured_at"),
    expiresAt: parseFiniteTimestamp(functionName, row.expires_at, "expires_at"),
    userId: requireString(functionName, row.user_id, "user_id"),
    operation: operation as "direct_token" | "page_token" | "facebook_user_token",
    targets: targets.map((entry) => parseMetaRefreshCaptureTarget(functionName, entry)),
    credential: row.credential === null
      ? null
      : requireRecord(functionName, row.credential),
    members: Array.isArray(members) ? members : null,
  };
}

export type MetaRefreshCapture = ReturnType<typeof parseMetaRefreshCapture>;

export function parseMetaRefreshCapturedToken(functionName: string, raw: unknown) {
  const row = requireRecord(functionName, raw);
  const scope = requireString(functionName, row.scope, "scope");
  if (scope !== "account" && scope !== "credential") {
    throw contractError(functionName, "scope is not a known scope");
  }
  const token = requireString(functionName, row.token, "token");
  if (token.length === 0) throw contractError(functionName, "token is empty");
  if (token.length > 4096) throw contractError(functionName, "token is too long");

  return {
    scope: scope as "account" | "credential",
    socialAccountId: optionalString(functionName, row.social_account_id, "social_account_id"),
    credentialId: optionalString(functionName, row.credential_id, "credential_id"),
    credentialRevision: optionalInteger(
      functionName,
      row.credential_revision,
      "credential_revision",
    ),
    token,
    tokenExpiresAt: optionalTimestamp(functionName, row.token_expires_at, "token_expires_at"),
    refreshToken: optionalString(functionName, row.refresh_token, "refresh_token"),
  };
}

export type MetaRefreshCapturedToken = ReturnType<typeof parseMetaRefreshCapturedToken>;

export function parseMetaRefreshBeginResult(functionName: string, raw: unknown) {
  const row = requireRecord(functionName, raw);
  const captureVersion = requireInteger(functionName, row.capture_version, "capture_version");
  if (captureVersion !== 1) throw contractError(functionName, "capture_version is not 1");
  const tokens = row.tokens;
  if (!Array.isArray(tokens)) throw contractError(functionName, "tokens is not an array");

  return {
    captureId: requireString(functionName, row.capture_id, "capture_id"),
    captureVersion: 1 as const,
    capturedAt: parseFiniteTimestamp(functionName, row.captured_at, "captured_at"),
    expiresAt: parseFiniteTimestamp(functionName, row.expires_at, "expires_at"),
    operation: requireString(functionName, row.operation, "operation"),
    attemptMarker: parseFiniteTimestamp(functionName, row.attempt_marker, "attempt_marker"),
    capture: parseMetaRefreshCapture(functionName, row.capture),
    tokens: tokens.map((entry) => parseMetaRefreshCapturedToken(functionName, entry)),
  };
}

export type MetaRefreshBeginResult = ReturnType<typeof parseMetaRefreshBeginResult>;

export function parseMetaRefreshDirectWriteResult(functionName: string, raw: unknown) {
  const row = requireRecord(functionName, raw);
  const applied = requireBoolean(functionName, row.applied, "applied");
  if (!applied) throw contractError(functionName, "applied is not true");
  const operation = requireString(functionName, row.operation, "operation");
  if (operation !== "direct_token") throw contractError(functionName, "operation is not direct_token");

  return {
    captureId: requireString(functionName, row.capture_id, "capture_id"),
    operation: "direct_token" as const,
    applied: true as const,
    credentialGeneration: requireInteger(
      functionName,
      row.credential_generation,
      "credential_generation",
    ),
    account: parseMetaRefreshAccountState(functionName, row.account),
  };
}

export type MetaRefreshDirectWriteResult = ReturnType<typeof parseMetaRefreshDirectWriteResult>;

export function parseMetaRefreshFailureResult(functionName: string, raw: unknown) {
  const row = requireRecord(functionName, raw);
  const applied = requireBoolean(functionName, row.applied, "applied");
  if (!applied) throw contractError(functionName, "applied is not true");
  const errorCategory = requireString(functionName, row.error_category, "error_category");
  if (!META_REFRESH_ERROR_CATEGORIES.includes(errorCategory as MetaRefreshErrorCategory)) {
    throw contractError(functionName, "error_category is not an accepted category");
  }
  const escalated = requireBoolean(functionName, row.escalated, "escalated");
  const alertMarkerWritten = requireBoolean(
    functionName,
    row.alert_marker_written,
    "alert_marker_written",
  );
  const failureCount = requireInteger(functionName, row.failure_count, "failure_count");
  if (failureCount < 0) throw contractError(functionName, "failure_count is negative");

  return {
    captureId: requireString(functionName, row.capture_id, "capture_id"),
    applied: true as const,
    errorCategory: errorCategory as MetaRefreshErrorCategory,
    failureCount,
    escalated,
    alertMarkerWritten,
    transitioned: requireBoolean(functionName, row.transitioned, "transitioned"),
    enqueued: requireInteger(functionName, row.enqueued, "enqueued"),
    accountFound: requireBoolean(functionName, row.account_found, "account_found"),
    account: parseMetaRefreshAccountState(functionName, row.account),
  };
}

export type MetaRefreshFailureResult = ReturnType<typeof parseMetaRefreshFailureResult>;

// ---------------------------------------------------------------------------
// Capture agreement
// ---------------------------------------------------------------------------

/**
 * The tolerance of the capture window against the service clock.
 *
 * The capture timestamp is written by the database clock inside the capture
 * transaction, and the service clock is read again after the call returns. A
 * small difference between the two clocks is normal; a large one means the
 * capture does not describe this attempt.
 */
export const META_REFRESH_CAPTURE_CLOCK_SKEW_MS = 5_000;

export interface DirectCaptureExpectation {
  /** The owner the capture was requested for. */
  userId: string;
  /** The one account the capture was requested for. */
  socialAccountId: string;
  /** The platform the capture must describe. */
  platform: string;
  /** The platform identity of the validated account row, when the route has one. */
  platformUserId?: string | null;
  /** The capability generation the preflight read observed. */
  expectedCapabilityGeneration: number;
  /** The trusted service clock. */
  now: Date;
}

/**
 * The capture must describe the request that produced it.
 *
 * Every check here is a fence: the capture is the only authority for the
 * token that reaches the provider, so a capture that describes another
 * account, another owner, another operation, a moved generation or an
 * expired window must never reach the provider.
 */
export function assertDirectCaptureAgrees(
  begin: MetaRefreshBeginResult,
  expectation: DirectCaptureExpectation,
): void {
  const fail = (detail: string): never => {
    throw contractError(META_REFRESH_RPC.begin, detail);
  };

  if (begin.operation !== "direct_token") fail("operation is not direct_token");
  if (begin.capture.operation !== "direct_token") fail("captured operation is not direct_token");
  if (begin.capture.userId !== expectation.userId) fail("captured owner does not match");
  if (begin.capture.targets.length !== 1) fail("the capture does not hold exactly one target");
  if (begin.tokens.length !== 1) fail("the capture does not hold exactly one token");

  const target = begin.capture.targets[0];
  const token = begin.tokens[0];

  if (target.socialAccountId !== expectation.socialAccountId) fail("captured account does not match");
  if (token.socialAccountId !== expectation.socialAccountId) fail("captured token account does not match");
  if (target.platform !== expectation.platform) fail("captured platform does not match");
  if (
    expectation.platformUserId !== undefined &&
    expectation.platformUserId !== null &&
    target.platformUserId !== expectation.platformUserId
  ) {
    fail("captured platform identity does not match");
  }

  if (begin.capture.credential !== null) {
    fail("a direct capture carries credential material");
  }
  if (begin.capture.members !== null) {
    fail("a direct capture carries member material");
  }

  if (!target.capabilityPresent) fail("the capture carries no capability");
  if (target.capabilityLoginKind !== "direct") fail("the capture is not a direct capability");
  if (target.bindingPresent) fail("the capture carries a Facebook user binding");
  // A direct row can still arrive with binding or credential fields filled in.
  // That receipt contradicts itself. Refusal here is about the receipt, not a
  // claim that the accepted SQL is wrong.
  if (target.bindingCredentialId !== null) {
    fail("a direct capture carries a binding credential");
  }
  if (target.bindingConnectionVersion !== null) {
    fail("a direct capture carries a binding connection");
  }
  if (target.credentialRevision !== null) {
    fail("a direct capture carries a credential revision");
  }
  if (target.providerUserId !== null) {
    fail("a direct capture carries a credential subject");
  }
  if (
    target.capabilityGeneration === null ||
    target.capabilityGeneration !== expectation.expectedCapabilityGeneration
  ) {
    fail("the captured generation does not match the preflight generation");
  }

  if (token.scope !== "account") fail("the captured token is not an account token");
  if (token.credentialId !== null) fail("the captured token carries a credential id");
  if (token.credentialRevision !== null) fail("the captured token carries a credential revision");
  if (token.token.length === 0) fail("the captured token is empty");

  // The captured expiry and the target expiry are the same column of the same
  // row. A difference means the capture does not describe this account.
  if (target.tokenExpiresAt !== token.tokenExpiresAt) {
    fail("the captured token expiry does not match the captured target");
  }

  // Coherent and live window.
  if (begin.expiresAt <= begin.capturedAt) fail("the capture window is not coherent");
  if (begin.capture.expiresAt !== begin.expiresAt) fail("the inner capture expiry does not match");
  if (begin.capture.capturedAt !== begin.capturedAt) fail("the inner capture timestamp does not match");
  if (begin.attemptMarker !== begin.capturedAt) fail("the attempt marker does not match the capture");
  if (target.lastRefreshAttemptAt !== begin.capturedAt) {
    fail("the captured attempt marker does not match the capture");
  }

  const now = expectation.now.getTime();
  if (!Number.isFinite(now)) fail("the service clock is not finite");
  if (now + META_REFRESH_CAPTURE_CLOCK_SKEW_MS < begin.capturedAt) fail("the capture is not live yet");
  if (now >= begin.expiresAt) fail("the capture has expired");
}

// ---------------------------------------------------------------------------
// Driver envelope
// ---------------------------------------------------------------------------

function isMissingFunction(error: { message: string; code?: string }): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return error.message.toLowerCase().includes("could not find the function");
}

/**
 * Classifies a driver error into the accepted taxonomy. The original message
 * is not retained: it can quote tokens, account ids or SQL text.
 */
function mapRpcError(
  functionName: string,
  error: { message: string; code?: string },
): MetaRefreshStoreError {
  const sqlstate = error.code ?? null;

  if (isMissingFunction(error)) {
    return new MetaRefreshStoreError(
      "schema_unavailable",
      `${functionName} is not available in this deployment`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR01") {
    return new MetaRefreshStoreError(
      "invalid_payload",
      `${functionName} refused the payload`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR02" || sqlstate === "MAR03" || sqlstate === "MAR06") {
    return new MetaRefreshStoreError(
      "refused",
      `${functionName} refused the request`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR04") {
    return new MetaRefreshStoreError(
      "stale",
      `${functionName} refused a stale capture`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR05") {
    return new MetaRefreshStoreError(
      "contended",
      `${functionName} is busy`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR07") {
    return new MetaRefreshStoreError(
      "expired",
      `${functionName} refused an expired expiry`,
      sqlstate,
    );
  }
  if (sqlstate === "57014") {
    // A cancelled statement is not contention. Retrying it is the caller's
    // decision, never an automatic one.
    return new MetaRefreshStoreError(
      "cancelled",
      `${functionName} was cancelled`,
      sqlstate,
    );
  }
  if (sqlstate === "P0001") {
    return new MetaRefreshStoreError(
      "refused",
      `${functionName} refused the request`,
      sqlstate,
    );
  }
  return new MetaRefreshStoreError(
    "read_failed",
    `${functionName} could not be read`,
    sqlstate,
  );
}

function readDriverError(value: unknown): { message: string; code?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = ownValue(value, "message");
  if (!message.owned || typeof message.value !== "string") return null;
  const code = ownValue(value, "code");
  if (!code.owned || code.value === undefined) return { message: message.value };
  if (typeof code.value !== "string") return null;
  return { message: message.value, code: code.value };
}

/**
 * Unwraps the raw driver envelope.
 *
 * A missing, inherited or non-null `error`, a missing `data` property and a
 * null or undefined `data` are all failures. A PostgREST envelope that
 * carries an inherited error is not a success.
 */
function readRpcData(functionName: string, response: unknown): unknown {
  if (!isPlainRecord(response)) throw contractError(functionName, "malformed response");
  const data = ownValue(response, "data");
  const error = ownValue(response, "error");
  if (!data.owned || !error.owned) throw contractError(functionName, "malformed response");
  if (error.value !== null) {
    const driverError = readDriverError(error.value);
    if (!driverError) throw contractError(functionName, "malformed response");
    throw mapRpcError(functionName, driverError);
  }
  if (data.value === null || data.value === undefined) {
    throw contractError(functionName, "empty response");
  }
  return data.value;
}

async function callRpc(
  rpc: ServiceRpcCaller,
  functionName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let response: unknown;
  try {
    response = await rpc(functionName, args);
  } catch {
    console.error("[meta-refresh-store] rpc call failed", {
      event: "read_failed",
      function_name: functionName,
    });
    throw new MetaRefreshStoreError("read_failed", `${functionName} could not be read`);
  }
  return readRpcData(functionName, response);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface MetaRefreshStore {
  /**
   * Captures the token material and the matching authority of one owned
   * direct Instagram account, and records the attempt marker in the same
   * transaction.
   */
  beginDirect(input: {
    userId: string;
    socialAccountId: string;
  }): Promise<MetaRefreshBeginResult>;
  /** Writes the refreshed direct token and consumes the capture. */
  writeDirectSuccess(input: {
    userId: string;
    captureId: string;
    accessToken: string;
    tokenExpiresAt: string;
    /** Only a refresh token the provider actually returned. */
    refreshToken?: string;
  }): Promise<MetaRefreshDirectWriteResult>;
  /** Records the classified failure and consumes the capture. */
  recordFailure(input: {
    userId: string;
    captureId: string;
    socialAccountId: string;
    errorCategory: MetaRefreshErrorCategory;
  }): Promise<MetaRefreshFailureResult>;
}

/**
 * The store is built over a caller, not over a client. The Edge Function
 * owns the client; this module never constructs one, so the adapter stays
 * testable without a database.
 */
export function createMetaRefreshStore(rpc: ServiceRpcCaller): MetaRefreshStore {
  return {
    async beginDirect(input) {
      const data = await callRpc(rpc, META_REFRESH_RPC.begin, {
        p_user_id: input.userId,
        p_payload: {
          accounts: [
            {
              social_account_id: input.socialAccountId,
              operation: "direct_token",
            },
          ],
        },
      });
      return parseMetaRefreshBeginResult(META_REFRESH_RPC.begin, data);
    },

    async writeDirectSuccess(input) {
      const fields: Record<string, unknown> = {
        access_token: input.accessToken,
        token_expires_at: input.tokenExpiresAt,
      };
      // An omitted refresh token preserves the stored one. An explicit null
      // would clear it, and the provider did not ask for that.
      if (input.refreshToken !== undefined) fields.refresh_token = input.refreshToken;

      const data = await callRpc(rpc, META_REFRESH_RPC.writeDirect, {
        p_user_id: input.userId,
        p_payload: {
          capture_id: input.captureId,
          operation: "direct_token",
          fields,
        },
      });
      return parseMetaRefreshDirectWriteResult(META_REFRESH_RPC.writeDirect, data);
    },

    async recordFailure(input) {
      const data = await callRpc(rpc, META_REFRESH_RPC.recordFailure, {
        p_user_id: input.userId,
        p_payload: {
          capture_id: input.captureId,
          social_account_id: input.socialAccountId,
          error_category: input.errorCategory,
        },
      });
      return parseMetaRefreshFailureResult(META_REFRESH_RPC.recordFailure, data);
    },
  };
}
