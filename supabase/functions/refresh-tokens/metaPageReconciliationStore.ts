/**
 * Strict runtime adapter for the captured Page-token reconciliation SQL.
 *
 * WHY THIS MODULE EXISTS
 *
 *   P1 (`20261028110000_meta_page_token_reconciliation.sql`) accepted one new
 *   service-only writer:
 *
 *     write_meta_page_reconciliation_success(p_user_id uuid, p_payload jsonb)
 *
 *   That writer consumes an OPEN `facebook_user_token` capture of the same
 *   owner and applies a Page token the service derived from THAT capture's
 *   unchanged User grant. It never rotates the User secret, never touches a
 *   sibling and never invents an expiry.
 *
 *   The accepted direct store (`metaRefreshStore.ts`) cannot carry that
 *   contract. Its `beginDirect` asks for a `direct_token` capture, its
 *   `writeDirectSuccess` writes the accepted direct writer, and its parsers
 *   treat the capture credential as an unvalidated `Record` with an unknown
 *   `members[]`. A Page capture carries exactly one credential-scoped token
 *   entry, a validated credential object and a validated membership array, and
 *   a Page receipt has a different key set than a direct receipt.
 *
 *   So this module owns the Page wire contracts and validates them. It never
 *   casts, repairs or guesses.
 *
 * WHAT IS REUSED AND WHAT IS NOT
 *
 *   Reused, because the complete contract fits:
 *     - `parseMetaRefreshAccountState` — the accepted account-state projection
 *       is the same projection in both receipts.
 *     - `parseMetaRefreshFailureResult` — `record_meta_refresh_failure` is the
 *       accepted failure writer for both operations and returns the same
 *       result shape. The Page-specific AGREEMENT check is NOT here; it lives
 *       with the Page orchestration, because a direct-only assumption about a
 *       missing binding, a missing generation or a missing platform must never
 *     leak into Page failure handling.
 *
 *   Not reused, because the contract does not fit:
 *     - the direct store's private envelope helpers, its private error mapper
 *       and its direct-specific capture agreement. They stay private and
 *       unchanged. This module has its own envelope, its own error taxonomy
 *       and its own capture agreement.
 *
 * SECRETS
 *
 *   The captured User secret exists only as the `userToken` field of the
 *   parsed capture. It is never logged, never written to history, never
 *   returned to the browser and never placed in an error message. Driver text
 *   is classified and dropped: a driver error can quote a token, an account
 *   id or SQL text.
 *
 * ERROR TAXONOMY
 *
 *   The distinction that matters is between a DEFINITE refusal and an
 *   INDETERMINATE outcome:
 *
 *     - definite: the database raised, so the transaction rolled back and
 *       nothing was written. A retry of the same capture is possible.
 *     - indeterminate: the transport failed or the answer was unusable, so the
 *       statement MAY have committed. A second consume is forbidden.
 *
 *   `isIndeterminatePageOutcome` is the only place that distinction is
 *   expressed, and the orchestration consults it before it decides between a
 *   refusal and an uncertainty.
 */

import type { ServiceRpcCaller } from "../_shared/facebookUserCredentialStore.ts";
import { readServiceEnvelope } from "../_shared/metaOAuthProtectedBoundary.ts";
import {
  parseMetaRefreshAccountState,
  parseMetaRefreshFailureResult,
  type MetaRefreshAccountState,
  type MetaRefreshErrorCategory,
  type MetaRefreshFailureResult,
} from "./metaRefreshStore.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MetaPageReconciliationErrorCode =
  /** The accepted functions are not present in this deployment. */
  | "schema_unavailable"
  /** The database refused the request. Nothing was written. */
  | "capture_refused"
  /** The captured authority is stale, closed or does not agree (MAR04). */
  | "capture_stale"
  /** Another transaction holds the capture (MAR05). */
  | "capture_contended"
  /** A known expiry in scope has already passed (MAR07). */
  | "capture_expired"
  /** The statement was cancelled (57014). A cancellation is not contention. */
  | "capture_cancelled"
  /** The returned JSON did not match the contract. The outcome is unknown. */
  | "capture_malformed"
  /** The call could not be read. The outcome is unknown. */
  | "capture_transport"
  /** The protected binding row does not exist for the captured context. */
  | "binding_missing"
  /** The protected binding row is not usable, or the read failed. */
  | "binding_malformed"
  /** The protected binding row does not agree with the capture. */
  | "binding_disagreement"
  /** The success writer refused. Nothing was written. */
  | "write_refused"
  /** The success writer answered with something unusable. The outcome is unknown. */
  | "write_malformed"
  /** The success writer could not be read. The outcome is unknown. */
  | "write_transport"
  /** The failure writer refused. Nothing was written. */
  | "failure_refused"
  /** The failure writer answered with something unusable. The outcome is unknown. */
  | "failure_malformed"
  /** The failure writer could not be read. The outcome is unknown. */
  | "failure_transport";

export class MetaPageReconciliationError extends Error {
  readonly code: MetaPageReconciliationErrorCode;
  /** The SQLSTATE, when the database raised one. */
  readonly sqlstate: string | null;

  constructor(
    code: MetaPageReconciliationErrorCode,
    message: string,
    sqlstate: string | null = null,
  ) {
    super(message);
    this.name = "MetaPageReconciliationError";
    this.code = code;
    this.sqlstate = sqlstate;
  }
}

export function isMetaPageReconciliationError(
  value: unknown,
): value is MetaPageReconciliationError {
  return value instanceof MetaPageReconciliationError;
}

/**
 * Whether the outcome of the call is unknown.
 *
 * A malformed or unreadable answer is not proof of a rollback: the statement
 * may have committed before the answer was lost. The capture must not be
 * consumed a second time and no alert may be sent on such an outcome.
 */
export function isIndeterminatePageOutcome(error: MetaPageReconciliationError): boolean {
  return (
    error.code === "capture_malformed" ||
    error.code === "capture_transport" ||
    error.code === "write_malformed" ||
    error.code === "write_transport" ||
    error.code === "failure_malformed" ||
    error.code === "failure_transport"
  );
}

// ---------------------------------------------------------------------------
// Strict runtime validation primitives
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads one OWN data property.
 *
 * An inherited property, a getter and a missing property are all "not owned".
 * A getter is not a value: reading it would execute caller code and could
 * return something different every time.
 */
function ownValue(value: object, key: string): { owned: true; value: unknown } | { owned: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return { owned: false };
  return { owned: true, value: descriptor.value };
}

/**
 * The accepted SQL objects have closed key sets.
 *
 * `getOwnPropertyNames` sees a non-enumerable extra key, and a descriptor
 * without `value` is an accessor. Neither is read: a getter is caller code,
 * and a future wire field has to be an explicit version, not a silent extra.
 */
function requireExactOwnKeys(
  row: object,
  expectedSorted: readonly string[],
  detail: string,
): void {
  const names = Object.getOwnPropertyNames(row);
  if (names.length !== expectedSorted.length) throw malformed(detail);
  const sorted = names.slice().sort();
  for (let index = 0; index < expectedSorted.length; index += 1) {
    if (sorted[index] !== expectedSorted[index]) throw malformed(detail);
    const descriptor = Object.getOwnPropertyDescriptor(row, sorted[index]);
    if (descriptor === undefined || !("value" in descriptor)) throw malformed(detail);
  }
}

/**
 * Every own property of a nested receipt object is a data property.
 *
 * This runs BEFORE a shared parser reads the object. The shared parser is
 * unchanged and reads fields by name, which would invoke a getter.
 */
function assertOwnDataFields(value: unknown, detail: string): void {
  if (!isPlainRecord(value)) throw malformed(detail);
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor)) throw malformed(detail);
  }
}

function malformed(detail: string): MetaPageReconciliationError {
  return new MetaPageReconciliationError("capture_malformed", `unusable payload (${detail})`);
}

function requireRecord(value: unknown, detail: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw malformed(detail);
  return value;
}

function requireOwnString(
  row: Record<string, unknown>,
  key: string,
  detail: string,
): string {
  const owned = ownValue(row, key);
  if (!owned.owned) throw malformed(detail);
  if (typeof owned.value !== "string") throw malformed(detail);
  return owned.value;
}

function requireOwnBoolean(
  row: Record<string, unknown>,
  key: string,
  detail: string,
): boolean {
  const owned = ownValue(row, key);
  if (!owned.owned) throw malformed(detail);
  if (typeof owned.value !== "boolean") throw malformed(detail);
  return owned.value;
}

function requireOwnInteger(
  row: Record<string, unknown>,
  key: string,
  detail: string,
): number {
  const owned = ownValue(row, key);
  if (!owned.owned) throw malformed(detail);
  if (typeof owned.value !== "number" || !Number.isSafeInteger(owned.value)) {
    throw malformed(detail);
  }
  return owned.value;
}

function requireOwnPositiveInteger(
  row: Record<string, unknown>,
  key: string,
  detail: string,
): number {
  const value = requireOwnInteger(row, key, detail);
  if (value < 1) throw malformed(detail);
  return value;
}

/**
 * A nullable own integer.
 *
 * `undefined` is a MISSING property, not the null the column allows: the
 * accepted SQL always emits the key, so a missing key is malformed.
 */
function requireOwnNullableInteger(
  row: Record<string, unknown>,
  key: string,
  detail: string,
): number | null {
  const owned = ownValue(row, key);
  if (!owned.owned) throw malformed(detail);
  if (owned.value === null) return null;
  if (typeof owned.value !== "number" || !Number.isSafeInteger(owned.value)) {
    throw malformed(detail);
  }
  return owned.value;
}

/**
 * A nullable own string.
 *
 * `undefined` is a MISSING property, not the null the column allows: the
 * accepted SQL always emits the key, so a missing key is malformed.
 */
function requireOwnNullableString(
  row: Record<string, unknown>,
  key: string,
  detail: string,
): string | null {
  const owned = ownValue(row, key);
  if (!owned.owned) throw malformed(detail);
  if (owned.value === null) return null;
  if (typeof owned.value !== "string") throw malformed(detail);
  return owned.value;
}

/**
 * The zoned timestamp shape the accepted SQL emits.
 *
 * `2026-10-28T12:00:00.123456+00:00`. A naive local time, an infinite value
 * and a non-string are malformed: an unproven timestamp must never be read as
 * a recent one, and a missing one must never be read as an unknown one.
 */
const ZONED_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

function requireOwnNullableTimestamp(
  row: Record<string, unknown>,
  key: string,
  detail: string,
): number | null {
  const owned = ownValue(row, key);
  if (!owned.owned) throw malformed(detail);
  if (owned.value === null) return null;
  if (typeof owned.value !== "string" || !ZONED_TIMESTAMP_PATTERN.test(owned.value)) {
    throw malformed(detail);
  }
  const parsed = Date.parse(owned.value);
  if (!Number.isFinite(parsed)) throw malformed(detail);
  return parsed;
}

function requireOwnTimestamp(
  row: Record<string, unknown>,
  key: string,
  detail: string,
): number {
  const value = requireOwnNullableTimestamp(row, key, detail);
  if (value === null) throw malformed(detail);
  return value;
}

/**
 * A clean provider identifier.
 *
 * The accepted SQL identifier policy: one to 128 characters, no surrounding
 * whitespace, no ASCII control character and no DEL. "Surrounding whitespace"
 * is the ECMAScript `String.prototype.trim` set, exactly like the accepted
 * SQL helper, so a NBSP or a BOM at the boundary is refused too.
 *
 * It is deliberately NOT a numeric-only rule. A provider identifier is an
 * opaque string and a legal literal stays legal.
 */
export function cleanPageIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 128) return null;
  if (value.trim() !== value) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return value;
}

/**
 * A clean operational token literal.
 *
 * The accepted SQL token policy: non-empty, at most 4096 characters, no
 * surrounding whitespace, no ASCII control character and no DEL. The literal
 * is preserved exactly and is never trimmed or rewritten.
 */
export function cleanPageToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 4096) return null;
  if (value.trim() !== value) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Driver envelope
// ---------------------------------------------------------------------------

/**
 * Which accepted function the call belongs to.
 *
 * The three calls share one envelope contract but not one error vocabulary: a
 * capture refusal, a writer refusal and an unusable answer mean different
 * things to the caller, and only the two writers can commit.
 */
type RpcFlavor = "begin" | "write" | "failure";

interface FlavorCodes {
  refused: "capture_refused" | "write_refused" | "failure_refused";
  malformed: "capture_malformed" | "write_malformed" | "failure_malformed";
  transport: "capture_transport" | "write_transport" | "failure_transport";
}

const FLAVOR_CODES: Record<RpcFlavor, FlavorCodes> = {
  begin: {
    refused: "capture_refused",
    malformed: "capture_malformed",
    transport: "capture_transport",
  },
  write: {
    refused: "write_refused",
    malformed: "write_malformed",
    transport: "write_transport",
  },
  failure: {
    refused: "failure_refused",
    malformed: "failure_malformed",
    transport: "failure_transport",
  },
};

function isMissingFunction(error: { message: string; code?: string }): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return error.message.toLowerCase().includes("could not find the function");
}

function readDriverError(value: unknown): { message: string; code?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = ownValue(value, "message");
  if (!message.owned || typeof message.value !== "string") return null;
  const code = ownValue(value, "code");
  if (!code.owned) return { message: message.value };
  if (code.value === undefined) return { message: message.value };
  if (typeof code.value !== "string") return null;
  return { message: message.value, code: code.value };
}

/**
 * Classifies a driver error into the Page taxonomy.
 *
 * The original message is never retained: it can quote a token, an account id
 * or SQL text. Only the SQLSTATE and a stable code survive.
 */
function mapDriverError(
  functionName: string,
  error: { message: string; code?: string },
  flavor: RpcFlavor,
): MetaPageReconciliationError {
  const codes = FLAVOR_CODES[flavor];
  const sqlstate = error.code ?? null;

  if (isMissingFunction(error)) {
    return new MetaPageReconciliationError(
      "schema_unavailable",
      `${functionName} is not available in this deployment`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR01") {
    return new MetaPageReconciliationError(
      codes.refused,
      `${functionName} refused the payload`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR02" || sqlstate === "MAR03" || sqlstate === "MAR06") {
    return new MetaPageReconciliationError(
      codes.refused,
      `${functionName} refused the request`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR04") {
    return new MetaPageReconciliationError(
      codes.refused,
      `${functionName} refused a stale capture`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR05") {
    return new MetaPageReconciliationError(
      "capture_contended",
      `${functionName} is busy`,
      sqlstate,
    );
  }
  if (sqlstate === "MAR07") {
    return new MetaPageReconciliationError(
      codes.refused,
      `${functionName} refused an expired expiry`,
      sqlstate,
    );
  }
  if (sqlstate === "57014") {
    // A cancelled statement is not contention. Retrying it is the caller's
    // decision, never an automatic one.
    return new MetaPageReconciliationError(
      "capture_cancelled",
      `${functionName} was cancelled`,
      sqlstate,
    );
  }
  if (sqlstate === "P0001") {
    return new MetaPageReconciliationError(
      codes.refused,
      `${functionName} refused the request`,
      sqlstate,
    );
  }
  return new MetaPageReconciliationError(
    codes.transport,
    `${functionName} could not be read`,
    sqlstate,
  );
}

/**
 * Unwraps the raw driver envelope.
 *
 * Success is an OWN `data` property and an OWN `error: null`. A missing,
 * undefined, false, inherited or getter `error` is not a success. A missing or
 * undefined `data` is not a success. A null `data` is an empty answer and is
 * NOT a success either.
 */
function readRpcData(
  functionName: string,
  response: unknown,
  flavor: RpcFlavor,
): unknown {
  const codes = FLAVOR_CODES[flavor];
  if (!isPlainRecord(response)) {
    throw new MetaPageReconciliationError(codes.malformed, "unusable payload (malformed response)");
  }
  const data = ownValue(response, "data");
  const error = ownValue(response, "error");
  if (!data.owned || !error.owned) {
    throw new MetaPageReconciliationError(codes.malformed, "unusable payload (malformed response)");
  }
  if (error.value !== null) {
    const driverError = readDriverError(error.value);
    if (!driverError) {
      throw new MetaPageReconciliationError(
        codes.malformed,
        "unusable payload (malformed response)",
      );
    }
    throw mapDriverError(functionName, driverError, flavor);
  }
  if (data.value === null || data.value === undefined) {
    throw new MetaPageReconciliationError(codes.malformed, "unusable payload (empty response)");
  }
  return data.value;
}

async function callRpc(
  rpc: ServiceRpcCaller,
  functionName: string,
  args: Record<string, unknown>,
  flavor: RpcFlavor,
): Promise<unknown> {
  let response: unknown;
  try {
    response = await rpc(functionName, args);
  } catch {
    console.error("[meta-page-reconciliation-store] rpc call failed", {
      event: "read_failed",
      function_name: functionName,
    });
    throw new MetaPageReconciliationError(
      FLAVOR_CODES[flavor].transport,
      `${functionName} could not be read`,
    );
  }
  return readRpcData(functionName, response, flavor);
}

// ---------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------

export interface MetaPageCaptureCredential {
  credentialId: string;
  revision: number;
  /** The Facebook User identity of the shared grant. Null is missing evidence. */
  providerUserId: string | null;
  /** The known grant expiry. Null is UNKNOWN, not "valid forever". */
  tokenExpiresAt: number | null;
}

export interface MetaPageCaptureTarget {
  socialAccountId: string;
  platform: string;
  /** The canonical provider identity of the account. */
  platformUserId: string | null;
  bindingPresent: boolean;
  bindingCredentialId: string | null;
  bindingConnectionVersion: number | null;
  fenceState: "present" | "never_created";
  fenceConnectionVersion: number;
  credentialRevision: number | null;
  providerUserId: string | null;
  capabilityPresent: boolean;
  capabilityGeneration: number | null;
  capabilityLoginKind: "direct" | "page_linked" | null;
  capabilityPermissionReadState: string | null;
  tokenExpiresAt: number | null;
  refreshTokenPresent: boolean;
  failureCount: number;
  needsReauth: boolean;
  lastRefreshAttemptAt: number;
}

export interface MetaPageCaptureMember {
  socialAccountId: string;
  platform: string;
  connectionVersion: number;
  /** Null when the member has no Instagram capability row. */
  capabilityGeneration: number | null;
  /** Null when the member has no connection fence row yet. */
  fenceConnectionVersion: number | null;
}

export interface MetaPageCapture {
  captureId: string;
  capturedAt: number;
  expiresAt: number;
  attemptMarker: number;
  operation: "facebook_user_token";
  userId: string;
  target: MetaPageCaptureTarget;
  credential: MetaPageCaptureCredential;
  members: MetaPageCaptureMember[];
  /**
   * The captured Facebook User secret. The ONLY authority for the provider
   * calls of this operation.
   */
  userToken: string;
  userTokenExpiresAt: number | null;
}

export interface MetaPageProtectedBinding {
  socialAccountId: string;
  userId: string;
  platform: string;
  credentialId: string;
  connectionVersion: number;
  verifiedFacebookUserId: string | null;
  verifiedFacebookPageId: string | null;
  verifiedInstagramUserId: string | null;
}

export interface MetaPageReconciliationWriteResult {
  captureId: string;
  operation: "page_reconciliation";
  applied: true;
  credentialId: string;
  /** UNCHANGED. This writer never rotates the User secret. */
  credentialRevision: number;
  /** The next Instagram capability generation, or null for a Facebook Page. */
  credentialGeneration: number | null;
  expiryState: "unknown";
  account: MetaRefreshAccountState;
}

// ---------------------------------------------------------------------------
// Capture parsing
// ---------------------------------------------------------------------------

const CREDENTIAL_KEYS = [
  "credential_id",
  "provider_user_id",
  "revision",
  "token_expires_at",
] as const;

const MEMBER_KEYS = [
  "capability_generation",
  "connection_version",
  "fence_connection_version",
  "platform",
  "social_account_id",
] as const;

const CREDENTIAL_TOKEN_KEYS = [
  "credential_id",
  "credential_revision",
  "refresh_token",
  "scope",
  "social_account_id",
  "token",
  "token_expires_at",
] as const;

function parseCredential(value: unknown): MetaPageCaptureCredential {
  const row = requireRecord(value, "credential is not an object");
  requireExactOwnKeys(row, CREDENTIAL_KEYS, "credential does not hold exactly its contract keys");
  const credentialId = cleanPageIdentifier(
    requireOwnString(row, "credential_id", "credential_id is not a string"),
  );
  if (credentialId === null) throw malformed("credential_id is not a clean identifier");
  const revision = requireOwnInteger(row, "revision", "revision is not an integer");
  if (revision < 1) throw malformed("revision is not positive");
  const providerUserId = requireOwnNullableString(
    row,
    "provider_user_id",
    "provider_user_id is not a string",
  );
  if (providerUserId !== null && cleanPageIdentifier(providerUserId) === null) {
    throw malformed("provider_user_id is not a clean identifier");
  }
  const tokenExpiresAt = requireOwnNullableTimestamp(
    row,
    "token_expires_at",
    "token_expires_at is not a zoned timestamp",
  );
  return { credentialId, revision, providerUserId, tokenExpiresAt };
}

function parseTarget(value: unknown): MetaPageCaptureTarget {
  const row = requireRecord(value, "target is not an object");
  const fenceState = requireOwnString(row, "fence_state", "fence_state is not a string");
  if (fenceState !== "present" && fenceState !== "never_created") {
    throw malformed("fence_state is not a known state");
  }
  const loginKind = requireOwnNullableString(
    row,
    "capability_login_kind",
    "capability_login_kind is not a string",
  );
  if (loginKind !== null && loginKind !== "direct" && loginKind !== "page_linked") {
    throw malformed("capability_login_kind is not a known login kind");
  }
  const failureCount = requireOwnInteger(row, "failure_count", "failure_count is not an integer");
  if (failureCount < 0) throw malformed("failure_count is negative");

  const socialAccountId = requireOwnString(
    row,
    "social_account_id",
    "social_account_id is not a string",
  );
  if (cleanPageIdentifier(socialAccountId) === null) {
    throw malformed("social_account_id is not a clean identifier");
  }
  const platform = requireOwnString(row, "platform", "platform is not a string");
  const platformUserId = requireOwnNullableString(
    row,
    "platform_user_id",
    "platform_user_id is not a string",
  );
  if (platformUserId !== null && cleanPageIdentifier(platformUserId) === null) {
    throw malformed("platform_user_id is not a clean identifier");
  }
  const bindingCredentialId = requireOwnNullableString(
    row,
    "binding_credential_id",
    "binding_credential_id is not a string",
  );
  if (bindingCredentialId !== null && cleanPageIdentifier(bindingCredentialId) === null) {
    throw malformed("binding_credential_id is not a clean identifier");
  }
  const providerUserId = requireOwnNullableString(
    row,
    "provider_user_id",
    "provider_user_id is not a string",
  );
  if (providerUserId !== null && cleanPageIdentifier(providerUserId) === null) {
    throw malformed("provider_user_id is not a clean identifier");
  }

  return {
    socialAccountId,
    platform,
    platformUserId,
    bindingPresent: requireOwnBoolean(row, "binding_present", "binding_present is not a boolean"),
    bindingCredentialId,
    bindingConnectionVersion: requireOwnNullableInteger(
      row,
      "binding_connection_version",
      "binding_connection_version is not an integer",
    ),
    fenceState,
    fenceConnectionVersion: requireOwnInteger(
      row,
      "fence_connection_version",
      "fence_connection_version is not an integer",
    ),
    credentialRevision: requireOwnNullableInteger(
      row,
      "credential_revision",
      "credential_revision is not an integer",
    ),
    providerUserId,
    capabilityPresent: requireOwnBoolean(
      row,
      "capability_present",
      "capability_present is not a boolean",
    ),
    capabilityGeneration: requireOwnNullableInteger(
      row,
      "capability_generation",
      "capability_generation is not an integer",
    ),
    capabilityLoginKind: loginKind,
    capabilityPermissionReadState: requireOwnNullableString(
      row,
      "capability_permission_read_state",
      "capability_permission_read_state is not a string",
    ),
    tokenExpiresAt: requireOwnNullableTimestamp(
      row,
      "token_expires_at",
      "token_expires_at is not a zoned timestamp",
    ),
    refreshTokenPresent: requireOwnBoolean(
      row,
      "refresh_token_present",
      "refresh_token_present is not a boolean",
    ),
    failureCount,
    needsReauth: requireOwnBoolean(row, "needs_reauth", "needs_reauth is not a boolean"),
    lastRefreshAttemptAt: requireOwnTimestamp(
      row,
      "last_refresh_attempt_at",
      "last_refresh_attempt_at is not a zoned timestamp",
    ),
  };
}

function parseMember(value: unknown): MetaPageCaptureMember {
  const row = requireRecord(value, "member is not an object");
  requireExactOwnKeys(row, MEMBER_KEYS, "member does not hold exactly its contract keys");
  const socialAccountId = requireOwnString(
    row,
    "social_account_id",
    "member social_account_id is not a string",
  );
  if (cleanPageIdentifier(socialAccountId) === null) {
    throw malformed("member social_account_id is not a clean identifier");
  }
  const platform = requireOwnString(row, "platform", "member platform is not a string");
  // Bindings are facebook or instagram. An unsupported string is not a member
  // the provider may be shown, even when it is not the selected target.
  if (platform !== "facebook" && platform !== "instagram") {
    throw malformed("member platform is not an accepted platform");
  }
  const connectionVersion = requireOwnPositiveInteger(
    row,
    "connection_version",
    "member connection_version is not a positive integer",
  );
  const capabilityGeneration = requireOwnNullableInteger(
    row,
    "capability_generation",
    "member capability_generation is not an integer",
  );
  const fenceConnectionVersion = requireOwnNullableInteger(
    row,
    "fence_connection_version",
    "member fence_connection_version is not an integer",
  );
  if (capabilityGeneration !== null && capabilityGeneration < 0) {
    throw malformed("member capability_generation is negative");
  }
  if (fenceConnectionVersion !== null && fenceConnectionVersion < 0) {
    throw malformed("member fence_connection_version is negative");
  }
  return { socialAccountId, platform, connectionVersion, capabilityGeneration, fenceConnectionVersion };
}

/**
 * The ONE credential-scoped token entry of a Page capture.
 *
 * The accepted begin SQL REPLACES the account-token placeholders with exactly
 * one credential entry. It is the only token that may authorize a provider
 * call. Every key must be present, the two nulls must be explicit nulls, and
 * the credential id, the revision and the expiry must agree with the captured
 * credential object.
 */
function parseUserTokenEntry(
  value: unknown,
  credential: MetaPageCaptureCredential,
): { token: string; tokenExpiresAt: number | null } {
  const row = requireRecord(value, "token is not an object");
  requireExactOwnKeys(
    row,
    CREDENTIAL_TOKEN_KEYS,
    "credential token does not hold exactly its contract keys",
  );
  const scope = requireOwnString(row, "scope", "scope is not a string");
  if (scope !== "credential") throw malformed("the captured token is not a credential token");

  const socialAccountId = ownValue(row, "social_account_id");
  if (!socialAccountId.owned) throw malformed("token social_account_id is missing");
  if (socialAccountId.value !== null) {
    throw malformed("a credential token must not carry an account id");
  }

  const credentialId = requireOwnString(row, "credential_id", "credential_id is not a string");
  if (credentialId !== credential.credentialId) {
    throw malformed("the captured token does not carry the captured credential");
  }

  const credentialRevision = requireOwnInteger(
    row,
    "credential_revision",
    "credential_revision is not an integer",
  );
  if (credentialRevision !== credential.revision) {
    throw malformed("the captured token revision does not match the captured credential");
  }

  const refreshToken = ownValue(row, "refresh_token");
  if (!refreshToken.owned) throw malformed("token refresh_token is missing");
  if (refreshToken.value !== null) {
    throw malformed("a credential token must not carry a refresh token");
  }

  const token = cleanPageToken(requireOwnString(row, "token", "token is not a string"));
  if (token === null) throw malformed("the captured token is not a clean literal");

  const tokenExpiresAt = requireOwnNullableTimestamp(
    row,
    "token_expires_at",
    "token token_expires_at is not a zoned timestamp",
  );
  if (tokenExpiresAt !== credential.tokenExpiresAt) {
    throw malformed("the captured token expiry does not match the captured grant expiry");
  }

  return { token, tokenExpiresAt };
}

/**
 * Parses the raw begin answer of a Page capture.
 *
 * The shape is strict: the operation, the window, the owner, the single
 * target, the credential object, the membership array and the single
 * credential token entry. Anything else is malformed, not a repairable
 * near-miss.
 */
export function parseMetaPageBeginResult(raw: unknown): MetaPageCapture {
  const row = requireRecord(raw, "begin result is not an object");
  const captureVersion = requireOwnInteger(row, "capture_version", "capture_version is not an integer");
  if (captureVersion !== 1) throw malformed("capture_version is not 1");
  const operation = requireOwnString(row, "operation", "operation is not a string");
  if (operation !== "facebook_user_token") {
    throw malformed("operation is not facebook_user_token");
  }
  const captureId = requireOwnString(row, "capture_id", "capture_id is not a string");
  if (cleanPageIdentifier(captureId) === null) throw malformed("capture_id is not a clean identifier");
  const capturedAt = requireOwnTimestamp(row, "captured_at", "captured_at is not a zoned timestamp");
  const expiresAt = requireOwnTimestamp(row, "expires_at", "expires_at is not a zoned timestamp");
  const attemptMarker = requireOwnTimestamp(
    row,
    "attempt_marker",
    "attempt_marker is not a zoned timestamp",
  );

  const captureOwned = ownValue(row, "capture");
  if (!captureOwned.owned) throw malformed("capture is missing");
  const capture = requireRecord(captureOwned.value, "capture is not an object");
  const innerVersion = requireOwnInteger(
    capture,
    "capture_version",
    "inner capture_version is not an integer",
  );
  if (innerVersion !== 1) throw malformed("inner capture_version is not 1");
  const innerOperation = requireOwnString(capture, "operation", "inner operation is not a string");
  if (innerOperation !== "facebook_user_token") {
    throw malformed("inner operation is not facebook_user_token");
  }
  const innerCapturedAt = requireOwnTimestamp(
    capture,
    "captured_at",
    "inner captured_at is not a zoned timestamp",
  );
  const innerExpiresAt = requireOwnTimestamp(
    capture,
    "expires_at",
    "inner expires_at is not a zoned timestamp",
  );
  const userId = requireOwnString(capture, "user_id", "user_id is not a string");
  if (cleanPageIdentifier(userId) === null) throw malformed("user_id is not a clean identifier");

  const targets = ownValue(capture, "targets");
  if (!targets.owned || !Array.isArray(targets.value)) throw malformed("targets is not an array");
  if (targets.value.length !== 1) {
    throw malformed("the capture does not hold exactly one selected target");
  }
  const target = parseTarget(targets.value[0]);

  const credentialOwned = ownValue(capture, "credential");
  if (!credentialOwned.owned) throw malformed("credential is missing");
  if (credentialOwned.value === null) throw malformed("the captured shared grant is missing");
  const credential = parseCredential(credentialOwned.value);

  const membersOwned = ownValue(capture, "members");
  if (!membersOwned.owned) throw malformed("members is missing");
  if (!Array.isArray(membersOwned.value)) throw malformed("members is not an array");
  const members = membersOwned.value.map((entry) => parseMember(entry));
  const memberIds = new Set<string>();
  for (const member of members) {
    if (memberIds.has(member.socialAccountId)) {
      throw malformed("the captured membership holds a duplicate account");
    }
    memberIds.add(member.socialAccountId);
  }

  const tokens = ownValue(row, "tokens");
  if (!tokens.owned || !Array.isArray(tokens.value)) throw malformed("tokens is not an array");
  if (tokens.value.length !== 1) {
    throw malformed("the capture does not hold exactly one credential token");
  }
  const userTokenEntry = parseUserTokenEntry(tokens.value[0], credential);

  // Window coherence. The outer answer and the inner capture describe the same
  // transaction, so their timestamps are the same values.
  if (innerCapturedAt !== capturedAt) throw malformed("the inner capture timestamp does not match");
  if (innerExpiresAt !== expiresAt) throw malformed("the inner capture expiry does not match");
  if (expiresAt <= capturedAt) throw malformed("the capture window is not coherent");
  if (attemptMarker !== capturedAt) throw malformed("the attempt marker does not match the capture");
  if (target.lastRefreshAttemptAt !== capturedAt) {
    throw malformed("the captured attempt marker does not match the capture");
  }

  return {
    captureId,
    capturedAt,
    expiresAt,
    attemptMarker,
    operation: "facebook_user_token",
    userId,
    target,
    credential,
    members,
    userToken: userTokenEntry.token,
    userTokenExpiresAt: userTokenEntry.tokenExpiresAt,
  };
}

/**
 * Parses the raw answer of the Page reconciliation writer.
 *
 * The receipt has EXACTLY eight keys. A receipt with an extra key, a missing
 * key or a wrong type is unusable, and an unusable receipt is indeterminate:
 * it is not a success, not a rollback and not a second consume.
 */
export function parseMetaPageWriteResult(raw: unknown): MetaPageReconciliationWriteResult {
  const row = requireRecord(raw, "write result is not an object");
  const keys = Object.keys(row).sort();
  const expected = [
    "account",
    "applied",
    "capture_id",
    "credential_generation",
    "credential_id",
    "credential_revision",
    "expiry_state",
    "operation",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw malformed("the receipt does not hold exactly the eight contract keys");
  }

  const applied = requireOwnBoolean(row, "applied", "applied is not a boolean");
  if (!applied) throw malformed("applied is not true");
  const operation = requireOwnString(row, "operation", "operation is not a string");
  if (operation !== "page_reconciliation") throw malformed("operation is not page_reconciliation");
  const expiryState = requireOwnString(row, "expiry_state", "expiry_state is not a string");
  if (expiryState !== "unknown") throw malformed("expiry_state is not unknown");

  const captureId = requireOwnString(row, "capture_id", "capture_id is not a string");
  const credentialId = requireOwnString(row, "credential_id", "credential_id is not a string");
  const credentialRevision = requireOwnInteger(
    row,
    "credential_revision",
    "credential_revision is not an integer",
  );
  const credentialGeneration = requireOwnNullableInteger(
    row,
    "credential_generation",
    "credential_generation is not an integer",
  );

  // The account projection is delegated to the accepted shared parser only
  // after its own properties are data. `row.account` is not read: that read
  // would invoke a getter.
  const accountOwned = ownValue(row, "account");
  if (!accountOwned.owned) throw malformed("account is not an own data field");
  assertOwnDataFields(accountOwned.value, "account carries an accessor");

  return {
    captureId,
    operation: "page_reconciliation",
    applied: true,
    credentialId,
    credentialRevision,
    credentialGeneration,
    expiryState: "unknown",
    account: parseMetaRefreshAccountState(
      "write_meta_page_reconciliation_success",
      accountOwned.value,
    ),
  };
}

/**
 * The accepted failure receipt, after its own accessors are rejected.
 *
 * `parseMetaRefreshFailureResult` stays the direct contract. This wrapper
 * only establishes that the Page receipt and its account object are own
 * data before that parser reads them.
 */
function parseMetaPageFailureResult(raw: unknown): ReturnType<typeof parseMetaRefreshFailureResult> {
  const row = requireRecord(raw, "failure result is not an object");
  assertOwnDataFields(row, "failure result carries an accessor");
  const accountOwned = ownValue(row, "account");
  if (!accountOwned.owned) throw malformed("account is not an own data field");
  assertOwnDataFields(accountOwned.value, "account carries an accessor");
  return parseMetaRefreshFailureResult(META_PAGE_RECONCILIATION_RPC.recordFailure, raw);
}

// ---------------------------------------------------------------------------
// The protected binding read
// ---------------------------------------------------------------------------

/**
 * The narrow protected-binding read.
 *
 * The composition root owns the client and the query. The reader returns the
 * RAW driver envelope, unchanged: normalizing a missing error here would make
 * a malformed envelope look successful before validation.
 */
export interface ProtectedBindingReadRequest {
  /** The owner of the validated account row. */
  userId: string;
  /** The selected account. */
  socialAccountId: string;
  /** The credential the capture named. */
  credentialId: string;
  /** The connection version the capture named. */
  connectionVersion: number;
}

export type ProtectedBindingReader = (
  request: ProtectedBindingReadRequest,
) => PromiseLike<unknown>;

/**
 * Validates one projected binding row.
 *
 * Every projected field must be an OWN property, and every identifier must be
 * clean. A missing field is malformed, not a null the column allows.
 */
export function parseMetaPageProtectedBinding(raw: unknown): MetaPageProtectedBinding {
  const row = requireRecord(raw, "binding row is not an object");

  const socialAccountId = cleanPageIdentifier(
    requireOwnString(row, "social_account_id", "social_account_id is not a string"),
  );
  if (socialAccountId === null) throw malformed("social_account_id is not a clean identifier");
  const userId = cleanPageIdentifier(requireOwnString(row, "user_id", "user_id is not a string"));
  if (userId === null) throw malformed("user_id is not a clean identifier");
  const platform = requireOwnString(row, "platform", "platform is not a string");
  if (platform !== "facebook" && platform !== "instagram") {
    throw malformed("platform is not an eligible platform");
  }
  const credentialId = cleanPageIdentifier(
    requireOwnString(row, "credential_id", "credential_id is not a string"),
  );
  if (credentialId === null) throw malformed("credential_id is not a clean identifier");
  const connectionVersion = requireOwnPositiveInteger(
    row,
    "connection_version",
    "connection_version is not a positive integer",
  );

  const verifiedFacebookUserId = requireOwnNullableString(
    row,
    "verified_facebook_user_id",
    "verified_facebook_user_id is not a string",
  );
  if (verifiedFacebookUserId !== null && cleanPageIdentifier(verifiedFacebookUserId) === null) {
    throw malformed("verified_facebook_user_id is not a clean identifier");
  }
  const verifiedFacebookPageId = requireOwnNullableString(
    row,
    "verified_facebook_page_id",
    "verified_facebook_page_id is not a string",
  );
  if (verifiedFacebookPageId !== null && cleanPageIdentifier(verifiedFacebookPageId) === null) {
    throw malformed("verified_facebook_page_id is not a clean identifier");
  }
  const verifiedInstagramUserId = requireOwnNullableString(
    row,
    "verified_instagram_user_id",
    "verified_instagram_user_id is not a string",
  );
  if (verifiedInstagramUserId !== null && cleanPageIdentifier(verifiedInstagramUserId) === null) {
    throw malformed("verified_instagram_user_id is not a clean identifier");
  }

  return {
    socialAccountId,
    userId,
    platform,
    credentialId,
    connectionVersion,
    verifiedFacebookUserId,
    verifiedFacebookPageId,
    verifiedInstagramUserId,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const META_PAGE_RECONCILIATION_RPC = {
  begin: "begin_meta_account_refresh",
  writeSuccess: "write_meta_page_reconciliation_success",
  recordFailure: "record_meta_refresh_failure",
} as const;

export interface MetaPageCaptureRequest {
  /** The owner of the validated account row. Never a request body value. */
  userId: string;
  /** The one selected account. */
  socialAccountId: string;
  /** The platform the account row carries. */
  platform: string;
  /** The canonical provider identity of the account row, when the route has one. */
  platformUserId?: string | null;
}

export interface MetaPageReconciliationStore {
  /**
   * Captures the shared Facebook User grant and the matching authority of one
   * owned Page-linked account, and records the attempt marker in the same
   * transaction.
   */
  begin(request: MetaPageCaptureRequest): Promise<MetaPageCapture>;
  /**
   * Reads the protected binding of the captured context. It is the ONLY place
   * the protected Page identity comes from; account metadata, a username and
   * `ig_auth_type` are never evidence.
   */
  readProtectedBinding(request: ProtectedBindingReadRequest): Promise<MetaPageProtectedBinding>;
  /**
   * Writes the derived Page token and consumes the capture, exactly once.
   */
  writeSuccess(input: {
    userId: string;
    captureId: string;
    accessToken: string;
    facebookPageId: string;
    /** The captured Instagram identity, or an explicit null for a Facebook Page. */
    instagramUserId: string | null;
  }): Promise<MetaPageReconciliationWriteResult>;
  /**
   * Records the classified failure and consumes the capture, exactly once.
   */
  recordFailure(input: {
    userId: string;
    captureId: string;
    socialAccountId: string;
    errorCategory: MetaRefreshErrorCategory;
  }): Promise<MetaRefreshFailureResult>;
}

/**
 * The store is built over a caller and over a narrow reader, never over a
 * client. The Edge Function owns the client; this module never constructs
 * one, so the adapter stays testable without a database.
 */
export function createMetaPageReconciliationStore(
  rpc: ServiceRpcCaller,
  bindings: ProtectedBindingReader,
): MetaPageReconciliationStore {
  return {
    async begin(request) {
      const data = await callRpc(
        rpc,
        META_PAGE_RECONCILIATION_RPC.begin,
        {
          p_user_id: request.userId,
          p_payload: {
            accounts: [
              {
                social_account_id: request.socialAccountId,
                operation: "facebook_user_token",
              },
            ],
          },
        },
        "begin",
      );

      const capture = parseMetaPageBeginResult(data);

      // The capture must describe the request that produced it. The capture is
      // the only authority for the token that reaches the provider, so a
      // capture that describes another account, another owner, another
      // operation or a moved fence must never reach the provider.
      if (capture.userId !== request.userId) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured owner does not match the request",
        );
      }
      if (capture.target.socialAccountId !== request.socialAccountId) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured account does not match the request",
        );
      }
      if (capture.target.platform !== request.platform) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured platform does not match the request",
        );
      }
      if (
        request.platformUserId !== undefined &&
        request.platformUserId !== null &&
        capture.target.platformUserId !== request.platformUserId
      ) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured identity does not match the request",
        );
      }
      if (!capture.target.bindingPresent) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured target carries no protected binding",
        );
      }
      if (
        capture.target.bindingCredentialId === null ||
        capture.target.bindingConnectionVersion === null ||
        capture.target.credentialRevision === null ||
        capture.target.providerUserId === null
      ) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured target carries no complete protected context",
        );
      }
      if (capture.target.bindingCredentialId !== capture.credential.credentialId) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured binding does not carry the captured credential",
        );
      }
      if (capture.target.credentialRevision !== capture.credential.revision) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured revision does not match the captured credential",
        );
      }
      if (capture.target.providerUserId !== capture.credential.providerUserId) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured subject does not match the captured credential",
        );
      }
      if (capture.target.platform === "instagram") {
        if (!capture.target.capabilityPresent) {
          throw new MetaPageReconciliationError(
            "capture_refused",
            "the captured Instagram target carries no capability",
          );
        }
        if (capture.target.capabilityLoginKind !== "page_linked") {
          throw new MetaPageReconciliationError(
            "capture_refused",
            "the captured Instagram target is not page linked",
          );
        }
        if (capture.target.capabilityGeneration === null) {
          throw new MetaPageReconciliationError(
            "capture_refused",
            "the captured Instagram target carries no capability generation",
          );
        }
      }

      // The captured membership must contain the selected target, and the
      // selected target's membership entry must agree with the captured
      // authority. A live member substitution is never adopted here.
      const selected = capture.members.find(
        (member) => member.socialAccountId === capture.target.socialAccountId,
      );
      if (selected === undefined) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured membership does not contain the selected target",
        );
      }
      if (selected.platform !== capture.target.platform) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured membership platform does not match the selected target",
        );
      }
      if (selected.connectionVersion !== capture.target.bindingConnectionVersion) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured membership connection version does not match",
        );
      }
      if (selected.capabilityGeneration !== capture.target.capabilityGeneration) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured membership capability generation does not match",
        );
      }
      if (selected.fenceConnectionVersion !== capture.target.fenceConnectionVersion) {
        throw new MetaPageReconciliationError(
          "capture_refused",
          "the captured membership fence does not match",
        );
      }

      return capture;
    },

    async readProtectedBinding(request) {
      let envelope: unknown;
      try {
        envelope = await bindings(request);
      } catch {
        console.error("[meta-page-reconciliation-store] protected binding read failed", {
          event: "binding_read_failed",
        });
        throw new MetaPageReconciliationError(
          "binding_malformed",
          "the protected binding could not be read",
        );
      }

      // The raw envelope decides between a row, a genuine absence and a
      // failure. A driver error is NOT an absence.
      const read = readServiceEnvelope(envelope);
      if (read.status === "failed") {
        throw new MetaPageReconciliationError(
          "binding_malformed",
          "the protected binding read failed",
        );
      }
      if (read.status === "missing") {
        throw new MetaPageReconciliationError(
          "binding_missing",
          "the protected binding does not exist for the captured context",
        );
      }

      let binding: MetaPageProtectedBinding;
      try {
        binding = parseMetaPageProtectedBinding(read.row);
      } catch {
        throw new MetaPageReconciliationError(
          "binding_malformed",
          "the protected binding row is not usable",
        );
      }

      // The read does not adopt a new expected version. It must still be the
      // captured credential, the captured account, the captured owner and the
      // captured connection version.
      if (binding.socialAccountId !== request.socialAccountId) {
        throw new MetaPageReconciliationError(
          "binding_disagreement",
          "the protected binding describes another account",
        );
      }
      if (binding.userId !== request.userId) {
        throw new MetaPageReconciliationError(
          "binding_disagreement",
          "the protected binding describes another owner",
        );
      }
      if (binding.credentialId !== request.credentialId) {
        throw new MetaPageReconciliationError(
          "binding_disagreement",
          "the protected binding carries another credential",
        );
      }
      if (binding.connectionVersion !== request.connectionVersion) {
        throw new MetaPageReconciliationError(
          "binding_disagreement",
          "the protected binding carries another connection version",
        );
      }

      return binding;
    },

    async writeSuccess(input) {
      const data = await callRpc(
        rpc,
        META_PAGE_RECONCILIATION_RPC.writeSuccess,
        {
          p_user_id: input.userId,
          p_payload: {
            capture_id: input.captureId,
            operation: "page_reconciliation",
            fields: {
              access_token: input.accessToken,
              facebook_page_id: input.facebookPageId,
              instagram_user_id: input.instagramUserId,
              // The derived Page token has NO established expiry. An explicit
              // JSON null says so; an omitted property is not a null.
              token_expires_at: null,
            },
          },
        },
        "write",
      );

      try {
        return parseMetaPageWriteResult(data);
      } catch {
        throw new MetaPageReconciliationError(
          "write_malformed",
          "the page reconciliation receipt is unusable",
        );
      }
    },

    async recordFailure(input) {
      const data = await callRpc(
        rpc,
        META_PAGE_RECONCILIATION_RPC.recordFailure,
        {
          p_user_id: input.userId,
          p_payload: {
            capture_id: input.captureId,
            social_account_id: input.socialAccountId,
            error_category: input.errorCategory,
          },
        },
        "failure",
      );

      try {
        return parseMetaPageFailureResult(data);
      } catch {
        throw new MetaPageReconciliationError(
          "failure_malformed",
          "the failure receipt is unusable",
        );
      }
    },
  };
}
