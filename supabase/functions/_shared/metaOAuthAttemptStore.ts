/**
 * Canonical runtime contract for the accepted Meta OAuth attempt RPCs.
 *
 * WHAT THIS IS
 *
 *   One runtime contract for the five accepted service-only RPCs that make up
 *   the captured OAuth lifecycle:
 *
 *     begin_meta_oauth_attempt      capture the intent before authorization
 *     claim_meta_oauth_callback     claim the attempt before provider HTTP
 *     complete_meta_oauth_callback  persist the verified candidates once
 *     read_meta_oauth_attempt       safe picker projection
 *     commit_meta_oauth_selection   one atomic account transition + receipt
 *
 *   The mirrored SQL is the accepted lifecycle migration and the accepted
 *   identity-alias migration. `META_OAUTH_CONTRACT_VERSION` names both, and
 *   `metaOAuthAttemptStore.test.ts` asserts the RPC names, the argument names,
 *   the payload whitelists and the returned shapes against those two files. A
 *   drift in the database therefore fails a test instead of silently changing
 *   the wire.
 *
 * ONE CONTRACT PER RPC
 *
 *   There is exactly one set of types for these five functions in this
 *   repository. Nothing else re-declares them. The browser DTOs are built
 *   from the projections below, so a field that is not projected here cannot
 *   reach a browser by accident.
 *
 * STRICTNESS
 *
 *   The driver envelope is preserved exactly the way the accepted credential
 *   adapter preserves it: own `data` and `error` properties, an explicit
 *   `error: null`, and a context-consistent result type. A malformed, thrown
 *   or failed read is a typed failure. It is never an empty success and never
 *   a silent fallback to the legacy writer.
 *
 *   The error taxonomy is the accepted SQLSTATE contract, not raw driver
 *   text. `MOA01` is a malformed payload, `MOA02` an ownership refusal,
 *   `MOA03` a state conflict, `MOA04` a guard refusal, `MOA07` a stale
 *   capture, `MOA08` an expiry and `MOA09` a contention. The raw message is
 *   never copied onto the error, into a log line, or into a client response.
 *
 * SECRETS
 *
 *   The claim token and the provider tokens live inside the service payloads
 *   this module builds and returns. They are never projected into a browser
 *   DTO, never logged, and never placed in a redirect URL.
 */

import {
  createServiceRpcCaller,
  type RpcCapableClient,
  type ServiceRpcCaller,
} from "./facebookUserCredentialStore.ts";
import {
  assertBeginAgrees,
  assertClaimAgrees,
  assertCompleteAgrees,
  assertReceiptAgrees,
  BoundaryContractError,
  cleanProviderId,
} from "./metaOAuthProtectedBoundary.ts";

/**
 * The mirrored database contract this adapter was written against.
 *
 * Bump it whenever the accepted SQL signatures or payload whitelists change,
 * and update `metaOAuthAttemptStore.test.ts` in the same change. The test
 * reads the two migration files and fails when the code and the database
 * disagree.
 */
export const META_OAUTH_CONTRACT_VERSION = "2026-10-28/meta_oauth_attempt_lifecycle+identity_alias";

/** The accepted SQL flows. These are the only values `begin` accepts. */
export type MetaOAuthFlow = "facebook_page" | "instagram_page_linked" | "instagram_direct";

/** The accepted SQL intents. These are the only values `begin` accepts. */
export type MetaOAuthIntent =
  | "connect_new"
  | "reconnect"
  | "add_to_existing_grant"
  | "rebind";

/** The accepted candidate kinds. */
export type MetaOAuthCandidateKind = "page_only" | "page_plus_ig" | "ig_only";

export const META_OAUTH_FLOWS: readonly MetaOAuthFlow[] = [
  "facebook_page",
  "instagram_page_linked",
  "instagram_direct",
];

export const META_OAUTH_INTENTS: readonly MetaOAuthIntent[] = [
  "connect_new",
  "reconnect",
  "add_to_existing_grant",
  "rebind",
];

export const META_OAUTH_CANDIDATE_KINDS: readonly MetaOAuthCandidateKind[] = [
  "page_only",
  "page_plus_ig",
  "ig_only",
];

/**
 * The RPC names, exactly as the accepted SQL declares them. The contract
 * test compares this record with the migration files.
 */
export const META_OAUTH_RPC = {
  begin: "begin_meta_oauth_attempt",
  claim: "claim_meta_oauth_callback",
  complete: "complete_meta_oauth_callback",
  read: "read_meta_oauth_attempt",
  commit: "commit_meta_oauth_selection",
} as const;

/**
 * The accepted `begin` payload whitelist. A key outside this list is a
 * refusal in SQL, so it must never leave this module.
 */
export const META_OAUTH_BEGIN_PAYLOAD_KEYS = [
  "flow",
  "intent",
  "target_social_account_id",
  "linked_target_social_account_id",
  "source_social_account_id",
  "intended_social_profile_id",
] as const;

/**
 * The accepted `stash` whitelist inside `complete`.
 */
export const META_OAUTH_STASH_KEYS = [
  "candidates",
  "user_token",
  "expires_in",
  "user_token_expires_at",
  "user_token_expires_in",
  "direct_token_expires_at",
  "direct_token_expires_in",
] as const;

/**
 * The accepted candidate whitelist inside `complete`. `ig_igid` is the
 * accepted identity-alias addition and is only legal on a direct candidate.
 */
export const META_OAUTH_CANDIDATE_KEYS = [
  "ig_user_id",
  "ig_username",
  "ig_profile_picture_url",
  "facebook_page_id",
  "facebook_page_name",
  "page_access_token",
  "facebook_user_id",
  "candidate_kind",
  "page_token_expires_at",
  "page_token_expires_in",
  "ig_igid",
] as const;

export type MetaOAuthStoreErrorCode =
  /** The accepted functions are not present in this deployment. */
  | "schema_unavailable"
  /** The payload was malformed (`MOA01`). */
  | "invalid_payload"
  /** The database refused the request for an ownership or guard reason. */
  | "refused"
  /** The attempt was already claimed, or the claim did not match (`MOA03`). */
  | "conflict"
  /** The captured attempt is stale (`MOA07`). */
  | "stale"
  /** The attempt or its picker window expired (`MOA08`). */
  | "expired"
  /** Another transaction holds the attempt (`MOA09`). */
  | "contended"
  /** The returned JSON did not match the contract. */
  | "invalid_contract"
  /** The read failed for a reason that is not a refusal. */
  | "read_failed";

export class MetaOAuthStoreError extends Error {
  readonly code: MetaOAuthStoreErrorCode;
  /** The SQLSTATE, when the database raised one. */
  readonly sqlstate: string | null;

  constructor(code: MetaOAuthStoreErrorCode, message: string, sqlstate: string | null = null) {
    super(message);
    this.name = "MetaOAuthStoreError";
    this.code = code;
    this.sqlstate = sqlstate;
  }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface MetaOAuthBeginPayload {
  flow: MetaOAuthFlow;
  intent: MetaOAuthIntent;
  target_social_account_id?: string;
  linked_target_social_account_id?: string;
  source_social_account_id?: string;
  intended_social_profile_id?: string;
}

export interface MetaOAuthBeginResult {
  attemptId: string;
  flow: MetaOAuthFlow;
  intent: MetaOAuthIntent;
  userId: string;
  targetSocialAccountId: string | null;
  linkedTargetSocialAccountId: string | null;
  sourceSocialAccountId: string | null;
  intendedSocialProfileId: string | null;
  captureVersion: number;
  capturedAt: string | null;
  /** The one-time nonce. The database keeps only its digest. */
  nonce: string;
  /** The server-signed-state material the SQL returned. */
  state: { attemptId: string; nonce: string; flow: MetaOAuthFlow };
  callbackDeadline: string | null;
  pickerDeadline: string | null;
}

export interface MetaOAuthClaimResult {
  attemptId: string;
  flow: MetaOAuthFlow;
  /** Service-bound only. Never leaves the service boundary. */
  claimToken: string;
  claimedAt: string | null;
  callbackDeadline: string | null;
  pickerDeadline: string | null;
}

/** One verified candidate handed to `complete`. */
export interface MetaOAuthCandidate {
  ig_user_id?: string;
  ig_username?: string;
  ig_profile_picture_url?: string | null;
  facebook_page_id?: string;
  facebook_page_name?: string;
  page_access_token?: string;
  facebook_user_id?: string;
  candidate_kind?: MetaOAuthCandidateKind;
  page_token_expires_at?: string;
  page_token_expires_in?: number;
  /** The messaging-scoped Instagram id. Legal on a direct candidate only. */
  ig_igid?: string;
}

/** The stash handed to `complete`. */
export interface MetaOAuthStash {
  candidates: MetaOAuthCandidate[];
  /** The Facebook User grant token, or the direct account's own token. */
  user_token: string;
  expires_in?: number;
  user_token_expires_at?: string;
  user_token_expires_in?: number;
  direct_token_expires_at?: string;
  direct_token_expires_in?: number;
}

/** The safe, nonsecret projection of one candidate. */
export interface MetaOAuthCandidateProjection {
  selectionKey: string;
  igUserId: string | null;
  igUsername: string | null;
  igProfilePictureUrl: string | null;
  facebookPageId: string | null;
  facebookPageName: string | null;
}

export interface MetaOAuthCompleteResult {
  attemptId: string;
  flow: MetaOAuthFlow;
  pendingSelectionId: string;
  loginKind: "direct" | "page_linked" | null;
  pickerDeadline: string | null;
  candidates: MetaOAuthCandidateProjection[];
}

/** The safe picker projection returned by `read_meta_oauth_attempt`. */
export interface MetaOAuthPickerResult {
  attemptId: string;
  flow: MetaOAuthFlow;
  intent: MetaOAuthIntent;
  socialProfileId: string | null;
  pickerDeadline: string | null;
  expiresAt: string | null;
  /** The normal result has no `expired` key. The expired result sets it. */
  expired: boolean;
  status: "expired" | null;
  committedSelectionKeys: string[];
  candidates: MetaOAuthCandidateProjection[];
}

/** The nonsecret commit receipt. It never carries a token. */
export interface MetaOAuthReceipt {
  attemptId: string;
  selectionKey: string;
  flow: MetaOAuthFlow;
  intent: MetaOAuthIntent;
  platform: "facebook" | "instagram";
  platformUserId: string | null;
  instagramUserId: string | null;
  facebookPageId: string | null;
  facebookUserId: string | null;
  socialAccountId: string | null;
  companionSocialAccountId: string | null;
  username: string | null;
  operation: string | null;
  loginKind: string | null;
  credentialId: string | null;
  credentialRevision: number | null;
  connectionVersion: number | null;
  capabilityGeneration: number | null;
  committedAt: string | null;
}

// ---------------------------------------------------------------------------
// Strict runtime validation
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownPropertyValue(value: object, key: string): { owned: true; value: unknown } | { owned: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return { owned: false };
  const propertyValue: unknown = descriptor.value;
  return { owned: true, value: propertyValue };
}

function contractError(functionName: string, detail: string): MetaOAuthStoreError {
  return new MetaOAuthStoreError(
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

function optionalString(
  functionName: string,
  value: unknown,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw contractError(functionName, `${field} is not a string`);
  return value;
}

function requireNumber(functionName: string, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw contractError(functionName, `${field} is not a number`);
  }
  return value;
}

function requireInteger(functionName: string, value: unknown, field: string): number {
  const parsed = requireNumber(functionName, value, field);
  if (!Number.isInteger(parsed)) {
    throw contractError(functionName, `${field} is not an integer`);
  }
  return parsed;
}

function optionalInteger(
  functionName: string,
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  return requireInteger(functionName, value, field);
}

function agreeWithRequest(functionName: string, check: () => void): void {
  try {
    check();
  } catch (error) {
    if (error instanceof BoundaryContractError) {
      throw contractError(functionName, error.message);
    }
    throw error;
  }
}

function requireBoolean(functionName: string, value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw contractError(functionName, `${field} is not a boolean`);
  return value;
}

function requireStringArray(
  functionName: string,
  value: unknown,
  field: string,
): string[] {
  if (!Array.isArray(value)) throw contractError(functionName, `${field} is not an array`);
  return value.map((entry, index) => requireString(functionName, entry, `${field}[${index}]`));
}

function requireFlow(functionName: string, value: unknown): MetaOAuthFlow {
  const flow = requireString(functionName, value, "flow");
  if (!META_OAUTH_FLOWS.includes(flow as MetaOAuthFlow)) {
    throw contractError(functionName, "flow is not an accepted flow");
  }
  return flow as MetaOAuthFlow;
}

function requireIntent(functionName: string, value: unknown): MetaOAuthIntent {
  const intent = requireString(functionName, value, "intent");
  if (!META_OAUTH_INTENTS.includes(intent as MetaOAuthIntent)) {
    throw contractError(functionName, "intent is not an accepted intent");
  }
  return intent as MetaOAuthIntent;
}

function parseCandidateProjection(
  functionName: string,
  raw: unknown,
): MetaOAuthCandidateProjection {
  const row = requireRecord(functionName, raw);
  return {
    selectionKey: requireString(functionName, row.selection_key, "selection_key"),
    igUserId: optionalString(functionName, row.ig_user_id, "ig_user_id"),
    igUsername: optionalString(functionName, row.ig_username, "ig_username"),
    igProfilePictureUrl: optionalString(
      functionName,
      row.ig_profile_picture_url,
      "ig_profile_picture_url",
    ),
    facebookPageId: optionalString(functionName, row.facebook_page_id, "facebook_page_id"),
    facebookPageName: optionalString(functionName, row.facebook_page_name, "facebook_page_name"),
  };
}

function parseCandidateProjections(
  functionName: string,
  raw: unknown,
): MetaOAuthCandidateProjection[] {
  if (!Array.isArray(raw)) throw contractError(functionName, "candidates is not an array");
  return raw.map((entry) => parseCandidateProjection(functionName, entry));
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
 * is not retained: it can quote tokens, account ids, or SQL text.
 */
function mapRpcError(
  functionName: string,
  error: { message: string; code?: string },
): MetaOAuthStoreError {
  const sqlstate = error.code ?? null;

  if (isMissingFunction(error)) {
    return new MetaOAuthStoreError(
      "schema_unavailable",
      `${functionName} is not available in this deployment`,
      sqlstate,
    );
  }

  if (sqlstate === "MOA01") {
    return new MetaOAuthStoreError("invalid_payload", `${functionName} refused the payload`, sqlstate);
  }
  if (sqlstate === "MOA02" || sqlstate === "MOA04" || sqlstate === "MOA10" || sqlstate === "MOA11") {
    return new MetaOAuthStoreError("refused", `${functionName} refused the request`, sqlstate);
  }
  if (sqlstate === "MOA03") {
    return new MetaOAuthStoreError("conflict", `${functionName} refused a conflicting request`, sqlstate);
  }
  if (sqlstate === "MOA05" || sqlstate === "MOA06" || sqlstate === "MOA07") {
    return new MetaOAuthStoreError("stale", `${functionName} refused a stale capture`, sqlstate);
  }
  if (sqlstate === "MOA08") {
    return new MetaOAuthStoreError("expired", `${functionName} refused an expired attempt`, sqlstate);
  }
  if (sqlstate === "MOA09") {
    return new MetaOAuthStoreError("contended", `${functionName} is busy`, sqlstate);
  }
  if (sqlstate === "P0001") {
    // A plain RAISE carries no specific SQLSTATE. The accepted functions use
    // it for ownership refusals, which are a refusal and not a transport error.
    return new MetaOAuthStoreError("refused", `${functionName} refused the request`, sqlstate);
  }

  return new MetaOAuthStoreError(
    "read_failed",
    `${functionName} could not be read`,
    sqlstate,
  );
}

function readDriverError(value: unknown): { message: string; code?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = ownPropertyValue(value, "message");
  if (!message.owned || typeof message.value !== "string") return null;
  const code = ownPropertyValue(value, "code");
  if (!code.owned || code.value === undefined) return { message: message.value };
  if (typeof code.value !== "string") return null;
  return { message: message.value, code: code.value };
}

/**
 * Unwraps the raw driver envelope. A missing, inherited or non-null `error`,
 * a missing `data` property and a null or undefined `data` are all failures.
 */
function readRpcData(functionName: string, response: unknown): unknown {
  if (!isPlainRecord(response)) {
    throw contractError(functionName, "malformed response");
  }
  const data = ownPropertyValue(response, "data");
  const error = ownPropertyValue(response, "error");
  if (!data.owned || !error.owned) {
    throw contractError(functionName, "malformed response");
  }
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
    console.error("[meta-oauth-store] rpc call failed", {
      event: "read_failed",
      function_name: functionName,
    });
    throw new MetaOAuthStoreError("read_failed", `${functionName} could not be read`);
  }

  return readRpcData(functionName, response);
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/**
 * Builds the `begin` payload. A key whose value is absent is omitted
 * entirely: the accepted SQL rejects a key that is present with a JSON null.
 */
export function buildBeginPayload(payload: MetaOAuthBeginPayload): Record<string, unknown> {
  const result: Record<string, unknown> = {
    flow: payload.flow,
    intent: payload.intent,
  };
  if (payload.target_social_account_id !== undefined) {
    result.target_social_account_id = payload.target_social_account_id;
  }
  if (payload.linked_target_social_account_id !== undefined) {
    result.linked_target_social_account_id = payload.linked_target_social_account_id;
  }
  if (payload.source_social_account_id !== undefined) {
    result.source_social_account_id = payload.source_social_account_id;
  }
  if (payload.intended_social_profile_id !== undefined) {
    result.intended_social_profile_id = payload.intended_social_profile_id;
  }
  return result;
}

/**
 * Builds the `complete` stash. Absent keys are omitted; a key that is present
 * with a JSON null is a refusal in the accepted SQL.
 */
export function buildStash(stash: MetaOAuthStash): Record<string, unknown> {
  const result: Record<string, unknown> = {
    candidates: stash.candidates.map((candidate) => {
      const built: Record<string, unknown> = {};
      for (const key of META_OAUTH_CANDIDATE_KEYS) {
        const value = (candidate as Record<string, unknown>)[key];
        if (value === undefined) continue;
        built[key] = value;
      }
      return built;
    }),
    user_token: stash.user_token,
  };
  if (stash.expires_in !== undefined) result.expires_in = stash.expires_in;
  if (stash.user_token_expires_at !== undefined) {
    result.user_token_expires_at = stash.user_token_expires_at;
  }
  if (stash.user_token_expires_in !== undefined) {
    result.user_token_expires_in = stash.user_token_expires_in;
  }
  if (stash.direct_token_expires_at !== undefined) {
    result.direct_token_expires_at = stash.direct_token_expires_at;
  }
  if (stash.direct_token_expires_in !== undefined) {
    result.direct_token_expires_in = stash.direct_token_expires_in;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseBeginResult(functionName: string, raw: unknown): MetaOAuthBeginResult {
  const row = requireRecord(functionName, raw);
  const state = requireRecord(functionName, row.state);
  return {
    attemptId: requireString(functionName, row.attempt_id, "attempt_id"),
    flow: requireFlow(functionName, row.flow),
    intent: requireIntent(functionName, row.intent),
    userId: requireString(functionName, row.user_id, "user_id"),
    targetSocialAccountId: optionalString(
      functionName,
      row.target_social_account_id,
      "target_social_account_id",
    ),
    linkedTargetSocialAccountId: optionalString(
      functionName,
      row.linked_target_social_account_id,
      "linked_target_social_account_id",
    ),
    sourceSocialAccountId: optionalString(
      functionName,
      row.source_social_account_id,
      "source_social_account_id",
    ),
    intendedSocialProfileId: optionalString(
      functionName,
      row.intended_social_profile_id,
      "intended_social_profile_id",
    ),
    captureVersion: requireInteger(functionName, row.capture_version, "capture_version"),
    capturedAt: optionalString(functionName, row.captured_at, "captured_at"),
    nonce: requireString(functionName, row.nonce, "nonce"),
    state: {
      attemptId: requireString(functionName, state.attempt_id, "state.attempt_id"),
      nonce: requireString(functionName, state.nonce, "state.nonce"),
      flow: requireFlow(functionName, state.flow),
    },
    callbackDeadline: optionalString(functionName, row.callback_deadline, "callback_deadline"),
    pickerDeadline: optionalString(functionName, row.picker_deadline, "picker_deadline"),
  };
}

export function parseClaimResult(functionName: string, raw: unknown): MetaOAuthClaimResult {
  const row = requireRecord(functionName, raw);
  return {
    attemptId: requireString(functionName, row.attempt_id, "attempt_id"),
    flow: requireFlow(functionName, row.flow),
    claimToken: requireString(functionName, row.claim_token, "claim_token"),
    claimedAt: optionalString(functionName, row.claimed_at, "claimed_at"),
    callbackDeadline: optionalString(functionName, row.callback_deadline, "callback_deadline"),
    pickerDeadline: optionalString(functionName, row.picker_deadline, "picker_deadline"),
  };
}

export function parseCompleteResult(functionName: string, raw: unknown): MetaOAuthCompleteResult {
  const row = requireRecord(functionName, raw);
  const loginKindRaw = optionalString(functionName, row.login_kind, "login_kind");
  if (loginKindRaw !== null && loginKindRaw !== "direct" && loginKindRaw !== "page_linked") {
    throw contractError(functionName, "login_kind is not a known login kind");
  }
  return {
    attemptId: requireString(functionName, row.attempt_id, "attempt_id"),
    flow: requireFlow(functionName, row.flow),
    pendingSelectionId: requireString(functionName, row.pending_selection_id, "pending_selection_id"),
    loginKind: loginKindRaw,
    pickerDeadline: optionalString(functionName, row.picker_deadline, "picker_deadline"),
    candidates: parseCandidateProjections(functionName, row.candidates),
  };
}

export function parsePickerResult(functionName: string, raw: unknown): MetaOAuthPickerResult {
  const row = requireRecord(functionName, raw);
  const statusRaw = optionalString(functionName, row.status, "status");
  if (statusRaw !== null && statusRaw !== "expired") {
    throw contractError(functionName, "status is not a known status");
  }
  // The normal picker result does not carry `expired` at all. Only the
  // expired result sets it, and it sets it to true.
  const expiredRaw = row.expired;
  let expired = false;
  if (expiredRaw !== undefined && expiredRaw !== null) {
    expired = requireBoolean(functionName, expiredRaw, "expired");
    if (expired && statusRaw !== "expired") {
      throw contractError(functionName, "expired result without an expired status");
    }
  }
  return {
    attemptId: requireString(functionName, row.attempt_id, "attempt_id"),
    flow: requireFlow(functionName, row.flow),
    intent: requireIntent(functionName, row.intent),
    socialProfileId: optionalString(functionName, row.social_profile_id, "social_profile_id"),
    pickerDeadline: optionalString(functionName, row.picker_deadline, "picker_deadline"),
    expiresAt: optionalString(functionName, row.expires_at, "expires_at"),
    expired,
    status: statusRaw,
    committedSelectionKeys: requireStringArray(
      functionName,
      row.committed_selection_keys,
      "committed_selection_keys",
    ),
    candidates: parseCandidateProjections(functionName, row.candidates),
  };
}

function usableId(value: string | null): value is string {
  return cleanProviderId(value) !== null;
}

/**
 * The commit receipt the accepted SQL function actually returns.
 *
 * A selected account id and the canonical provider id are present. The
 * platform agrees with the flow. A Page, direct, or linked identity is
 * internally consistent. Companion and grant fields stay optional where
 * that function leaves them null. A malformed receipt throws here, after
 * the RPC has returned: this check does not roll the transaction back and
 * does not write an account.
 */
function assertCommittedReceipt(functionName: string, receipt: MetaOAuthReceipt): void {
  if (!usableId(receipt.socialAccountId)) {
    throw contractError(functionName, "social_account_id is not a usable account id");
  }
  if (!usableId(receipt.platformUserId)) {
    throw contractError(functionName, "platform_user_id is not a usable provider id");
  }
  if (receipt.companionSocialAccountId !== null) {
    if (!usableId(receipt.companionSocialAccountId)) {
      throw contractError(functionName, "companion_social_account_id is not a usable account id");
    }
    if (receipt.companionSocialAccountId === receipt.socialAccountId) {
      throw contractError(functionName, "companion_social_account_id repeats the selected account");
    }
  }

  if (receipt.flow === "facebook_page") {
    if (receipt.platform !== "facebook") {
      throw contractError(functionName, "platform does not agree with the flow");
    }
    if (receipt.facebookPageId !== receipt.platformUserId) {
      throw contractError(functionName, "facebook_page_id does not agree with the canonical page identity");
    }
    if (!usableId(receipt.facebookUserId)) {
      throw contractError(functionName, "facebook_user_id is not a usable provider id");
    }
    if (receipt.loginKind !== null && receipt.loginKind !== "page_linked") {
      throw contractError(functionName, "login_kind does not agree with the flow");
    }
    const linksInstagram = receipt.companionSocialAccountId !== null
      || receipt.instagramUserId !== null
      || receipt.loginKind === "page_linked";
    if (linksInstagram) {
      if (
        receipt.companionSocialAccountId === null
        || !usableId(receipt.instagramUserId)
        || receipt.loginKind !== "page_linked"
      ) {
        throw contractError(functionName, "page-plus-instagram identity is incomplete");
      }
    }
    return;
  }

  if (receipt.platform !== "instagram") {
    throw contractError(functionName, "platform does not agree with the flow");
  }
  if (receipt.instagramUserId !== receipt.platformUserId) {
    throw contractError(functionName, "instagram_user_id does not agree with the canonical identity");
  }
  if (receipt.companionSocialAccountId !== null) {
    throw contractError(functionName, "companion_social_account_id does not belong to this flow");
  }
  if (receipt.flow === "instagram_direct") {
    if (receipt.loginKind !== "direct") {
      throw contractError(functionName, "login_kind does not agree with the flow");
    }
    if (receipt.facebookPageId !== null || receipt.facebookUserId !== null) {
      throw contractError(functionName, "a direct receipt must not carry a facebook page or grant identity");
    }
    return;
  }
  if (receipt.loginKind !== "page_linked") {
    throw contractError(functionName, "login_kind does not agree with the flow");
  }
  if (!usableId(receipt.facebookPageId) || !usableId(receipt.facebookUserId)) {
    throw contractError(functionName, "a page-linked receipt is missing its page identity");
  }
}

export function parseReceipt(functionName: string, raw: unknown): MetaOAuthReceipt {
  const row = requireRecord(functionName, raw);
  const platform = requireString(functionName, row.platform, "platform");
  if (platform !== "facebook" && platform !== "instagram") {
    throw contractError(functionName, "platform is not an eligible platform");
  }
  const receipt: MetaOAuthReceipt = {
    attemptId: requireString(functionName, row.attempt_id, "attempt_id"),
    selectionKey: requireString(functionName, row.selection_key, "selection_key"),
    flow: requireFlow(functionName, row.flow),
    intent: requireIntent(functionName, row.intent),
    platform,
    platformUserId: optionalString(functionName, row.platform_user_id, "platform_user_id"),
    instagramUserId: optionalString(functionName, row.instagram_user_id, "instagram_user_id"),
    facebookPageId: optionalString(functionName, row.facebook_page_id, "facebook_page_id"),
    facebookUserId: optionalString(functionName, row.facebook_user_id, "facebook_user_id"),
    socialAccountId: optionalString(functionName, row.social_account_id, "social_account_id"),
    companionSocialAccountId: optionalString(
      functionName,
      row.companion_social_account_id,
      "companion_social_account_id",
    ),
    username: optionalString(functionName, row.username, "username"),
    operation: optionalString(functionName, row.operation, "operation"),
    loginKind: optionalString(functionName, row.login_kind, "login_kind"),
    credentialId: optionalString(functionName, row.credential_id, "credential_id"),
    credentialRevision: optionalInteger(functionName, row.credential_revision, "credential_revision"),
    connectionVersion: optionalInteger(functionName, row.connection_version, "connection_version"),
    capabilityGeneration: optionalInteger(
      functionName,
      row.capability_generation,
      "capability_generation",
    ),
    committedAt: optionalString(functionName, row.committed_at, "committed_at"),
  };
  assertCommittedReceipt(functionName, receipt);
  return receipt;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface MetaOAuthAttemptStore {
  /** Captures the explicit intent before the provider is contacted. */
  begin(input: {
    userId: string;
    payload: MetaOAuthBeginPayload;
  }): Promise<MetaOAuthBeginResult>;
  /** Claims the exact attempt before the provider token exchange. */
  claim(input: {
    userId: string;
    attemptId: string;
    nonce: string;
    flow: MetaOAuthFlow;
  }): Promise<MetaOAuthClaimResult>;
  /** Persists the verified candidates once and moves the attempt to ready. */
  complete(input: {
    userId: string;
    attemptId: string;
    flow: MetaOAuthFlow;
    claimToken: string;
    stash: MetaOAuthStash;
  }): Promise<MetaOAuthCompleteResult>;
  /** The safe, nonsecret picker projection. */
  read(input: { userId: string; pendingSelectionId: string }): Promise<MetaOAuthPickerResult>;
  /** Applies one account transition and returns its receipt. */
  commit(input: {
    userId: string;
    attemptId: string;
    selectionKey: string;
  }): Promise<MetaOAuthReceipt>;
}

export function createMetaOAuthAttemptStore(rpc: ServiceRpcCaller): MetaOAuthAttemptStore {
  return {
    async begin(input) {
      const data = await callRpc(rpc, META_OAUTH_RPC.begin, {
        p_user_id: input.userId,
        p_payload: buildBeginPayload(input.payload),
      });
      const parsed = parseBeginResult(META_OAUTH_RPC.begin, data);
      agreeWithRequest(META_OAUTH_RPC.begin, () => {
        assertBeginAgrees(parsed, {
          userId: input.userId,
          flow: input.payload.flow,
          intent: input.payload.intent,
          targetSocialAccountId: input.payload.target_social_account_id,
          linkedTargetSocialAccountId: input.payload.linked_target_social_account_id,
          sourceSocialAccountId: input.payload.source_social_account_id,
          intendedSocialProfileId: input.payload.intended_social_profile_id,
        });
      });
      return parsed;
    },

    async claim(input) {
      const data = await callRpc(rpc, META_OAUTH_RPC.claim, {
        p_user_id: input.userId,
        p_payload: {
          attempt_id: input.attemptId,
          nonce: input.nonce,
          flow: input.flow,
        },
      });
      const parsed = parseClaimResult(META_OAUTH_RPC.claim, data);
      agreeWithRequest(META_OAUTH_RPC.claim, () => {
        assertClaimAgrees(parsed, { attemptId: input.attemptId, flow: input.flow });
      });
      return parsed;
    },

    async complete(input) {
      const data = await callRpc(rpc, META_OAUTH_RPC.complete, {
        p_user_id: input.userId,
        p_payload: {
          attempt_id: input.attemptId,
          claim_token: input.claimToken,
          stash: buildStash(input.stash),
        },
      });
      const parsed = parseCompleteResult(META_OAUTH_RPC.complete, data);
      agreeWithRequest(META_OAUTH_RPC.complete, () => {
        assertCompleteAgrees(parsed, { attemptId: input.attemptId, flow: input.flow });
      });
      return parsed;
    },

    async read(input) {
      const data = await callRpc(rpc, META_OAUTH_RPC.read, {
        p_user_id: input.userId,
        p_pending_selection_id: input.pendingSelectionId,
      });
      return parsePickerResult(META_OAUTH_RPC.read, data);
    },

    async commit(input) {
      const data = await callRpc(rpc, META_OAUTH_RPC.commit, {
        p_user_id: input.userId,
        p_payload: {
          attempt_id: input.attemptId,
          selection_key: input.selectionKey,
        },
      });
      const parsed = parseReceipt(META_OAUTH_RPC.commit, data);
      agreeWithRequest(META_OAUTH_RPC.commit, () => {
        assertReceiptAgrees(parsed, {
          attemptId: input.attemptId,
          selectionKey: input.selectionKey,
        });
      });
      return parsed;
    },
  };
}

/**
 * Builds a store over a Supabase client. The client is never constructed
 * here, so the adapter stays testable without a database.
 */
export function createMetaOAuthAttemptStoreFromClient(client: RpcCapableClient): MetaOAuthAttemptStore {
  return createMetaOAuthAttemptStore(createServiceRpcCaller(client));
}
