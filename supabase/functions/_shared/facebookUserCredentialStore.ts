/**
 * Typed adapter over the accepted service-only Facebook User credential RPCs.
 *
 * WHAT THIS IS
 *
 *   Migration 20261026140000 is the authority for a Facebook User token in
 *   protected mode. This module is the read seam only. OAuth and refresh
 *   writes stay refused until the lifecycle SQL contracts exist; this adapter
 *   does not call bind, write, reconnect, or capability-write functions.
 *
 *   It owns three things and nothing else:
 *
 *     1. the read wire contract (argument names and returned JSON),
 *     2. strict runtime validation of what the database actually returned,
 *     3. the mapping from a database refusal to a typed error with a stable
 *        message. Raw driver text is classified, then dropped.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *
 *   No provider call. No Meta knowledge. No policy about which account may use
 *   which credential. Those live with the caller, so a change in the Meta
 *   contract does not drag the credential contract with it.
 *
 * FAIL CLOSED
 *
 *   Every read is owner-scoped in SQL (`p_user_id` + `p_social_account_id`, both
 *   with composite foreign keys behind them). A missing binding is NOT an empty
 *   token: `read_facebook_user_account_credential` returns `found = false` and
 *   this module turns that into a typed "no protected credential" refusal, so
 *   no caller can accidentally treat it as a usable credential.
 *
 *   A missing schema (the migration has not been applied) surfaces as
 *   `schema_unavailable`. An unreadable return value surfaces as
 *   `invalid_contract`. Neither is ever read as success.
 *
 *   A successful read is a plain object with its own `data` and an explicit
 *   `error: null`. The production adapter returns the driver envelope
 *   unchanged; a missing, undefined, false, or inherited `error` is not
 *   rewritten into that success shape.
 *
 * SECRETS
 *
 *   The account-credential read is service-only and is the only function here
 *   that returns a token. Errors carry a stable code and a generic message.
 *   The driver message is never copied onto the error, into a log line, or
 *   into a client response.
 */

export type CredentialStoreErrorCode =
  /** The accepted functions are not present. The migration has not been applied. */
  | "schema_unavailable"
  /** The captured version no longer matches. The write did nothing. */
  | "stale_version"
  /** The database refused the payload (SQLSTATE FUC0x / ICG0x). */
  | "refused"
  /** The returned JSON did not match the contract. */
  | "invalid_contract"
  /** The account owns no protected credential. */
  | "not_found"
  /** The read failed for a reason that is not a refusal. */
  | "read_failed";

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;
  /** The SQLSTATE, when the database raised one. */
  readonly sqlstate: string | null;

  constructor(code: CredentialStoreErrorCode, message: string, sqlstate: string | null = null) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
    this.sqlstate = sqlstate;
  }
}

/**
 * Fields a driver envelope may carry. Possession of this type is not
 * validation: both properties are `unknown` until `callRpc` checks them.
 */
export interface ServiceRpcResponse {
  data: unknown;
  error: unknown;
}

export type ServiceRpcCaller = (
  functionName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * The smallest surface of a Supabase client this adapter needs. The Edge
 * Functions own the client; this module never constructs one, so it stays
 * testable without a database.
 */
export interface RpcCapableClient {
  rpc(
    functionName: string,
    args?: Record<string, unknown>,
  ): PromiseLike<unknown>;
}

export function createServiceRpcCaller(client: RpcCapableClient): ServiceRpcCaller {
  return async (functionName, args) => {
    // Preserve the raw envelope. Normalizing a missing error to null here
    // would make a malformed driver response look successful before validation.
    return await client.rpc(functionName, args);
  };
}

const RPC_FUNCTIONS = {
  readAccountCredential: "read_facebook_user_account_credential",
  readCapability: "read_instagram_account_capability",
} as const;

const STALE_SQLSTATES = new Set(["FUC01", "ICG01"]);

function isMissingFunction(error: { message: string; code?: string }): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return error.message.toLowerCase().includes("could not find the function");
}

/**
 * Classifies a driver error. The original message is not retained: it can
 * quote tokens, account ids, or SQL text.
 */
function mapRpcError(
  functionName: string,
  error: { message: string; code?: string },
): CredentialStoreError {
  const sqlstate = error.code ?? null;

  if (isMissingFunction(error)) {
    return new CredentialStoreError(
      "schema_unavailable",
      `${functionName} is not available in this deployment`,
      sqlstate,
    );
  }

  if (sqlstate && STALE_SQLSTATES.has(sqlstate)) {
    return new CredentialStoreError(
      "stale_version",
      `${functionName} refused a stale captured version`,
      sqlstate,
    );
  }

  if (sqlstate && (sqlstate.startsWith("FUC") || sqlstate.startsWith("ICG"))) {
    return new CredentialStoreError("refused", `${functionName} refused the request`, sqlstate);
  }

  if (sqlstate === "P0001") {
    // A plain RAISE carries no specific SQLSTATE. The accepted functions use
    // it for ownership refusals, which is a refusal and not a transport failure.
    return new CredentialStoreError("refused", `${functionName} refused the request`, sqlstate);
  }

  return new CredentialStoreError(
    "read_failed",
    `${functionName} could not be read`,
    sqlstate,
  );
}

export interface CredentialClientError {
  status: number;
  error_code: string;
  error: string;
}

/** Stable client body for a protected read failure. Never echoes driver text. */
export function credentialReadClientError(error: CredentialStoreError): CredentialClientError {
  switch (error.code) {
    case "not_found":
      return {
        status: 404,
        error_code: "PROTECTED_CREDENTIAL_UNAVAILABLE",
        error: "No protected Facebook User credential is available for this account.",
      };
    case "schema_unavailable":
      return {
        status: 503,
        error_code: "SCHEMA_UNAVAILABLE",
        error: "Protected credential storage is not available.",
      };
    case "refused":
      return {
        status: 403,
        error_code: "PROTECTED_CREDENTIAL_INELIGIBLE",
        error: "This account cannot use a protected Facebook User credential.",
      };
    case "invalid_contract":
      return {
        status: 503,
        error_code: "PROTECTED_CREDENTIAL_INVALID",
        error: "The protected credential read was unusable.",
      };
    default:
      return {
        status: 503,
        error_code: "PROTECTED_CREDENTIAL_READ_FAILED",
        error: "The protected Facebook User credential could not be read.",
      };
  }
}

// ---------------------------------------------------------------------------
// Read contracts
// ---------------------------------------------------------------------------

export interface FacebookUserAccountCredential {
  found: boolean;
  socialAccountId: string;
  platform: "facebook" | "instagram";
  credentialId: string | null;
  credentialKind: string | null;
  token: string | null;
  tokenExpiresAt: string | null;
  revision: number | null;
  capabilityGeneration: number | null;
  connectionVersion: number | null;
}

export type InstagramLoginKind = "direct" | "page_linked";
export type InstagramPermissionReadState = "unknown" | "ok" | "failed";

export interface InstagramAccountCapability {
  socialAccountId: string;
  capabilityPresent: boolean;
  loginKind: InstagramLoginKind | null;
  permissionReadState: InstagramPermissionReadState;
  scopesAuthoritative: boolean;
  grantedScopes: string[];
  scopesReadAt: string | null;
  lastReadFailedAt: string | null;
  lastReadErrorCode: string | null;
  credentialGeneration: number;
  credentialUpdatedAt: string | null;
  generationReason: string | null;
  reconnectedAt: string | null;
  hasProtectedCredential: boolean;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Strict runtime validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractError(functionName: string, detail: string): CredentialStoreError {
  return new CredentialStoreError(
    "invalid_contract",
    `${functionName} returned an unusable payload (${detail})`,
  );
}

function requireRecord(functionName: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw contractError(functionName, "not an object");
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

function optionalNumber(
  functionName: string,
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  return requireNumber(functionName, value, field);
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

export function parseFacebookUserAccountCredential(
  functionName: string,
  raw: unknown,
): FacebookUserAccountCredential {
  const row = requireRecord(functionName, raw);
  const platform = requireString(functionName, row.platform, "platform");
  if (platform !== "facebook" && platform !== "instagram") {
    throw contractError(functionName, "platform is not an eligible platform");
  }
  return {
    found: requireBoolean(functionName, row.found, "found"),
    socialAccountId: requireString(functionName, row.social_account_id, "social_account_id"),
    platform,
    credentialId: optionalString(functionName, row.credential_id, "credential_id"),
    credentialKind: optionalString(functionName, row.credential_kind, "credential_kind"),
    token: optionalString(functionName, row.token, "token"),
    tokenExpiresAt: optionalString(functionName, row.token_expires_at, "token_expires_at"),
    revision: optionalNumber(functionName, row.revision, "revision"),
    capabilityGeneration: optionalNumber(
      functionName,
      row.capability_generation,
      "capability_generation",
    ),
    connectionVersion: optionalNumber(
      functionName,
      row.connection_version,
      "connection_version",
    ),
  };
}

export function parseInstagramAccountCapability(
  functionName: string,
  raw: unknown,
): InstagramAccountCapability {
  const row = requireRecord(functionName, raw);
  const loginKindRaw = optionalString(functionName, row.login_kind, "login_kind");
  if (loginKindRaw !== null && loginKindRaw !== "direct" && loginKindRaw !== "page_linked") {
    throw contractError(functionName, "login_kind is not a known login kind");
  }
  const readState = requireString(functionName, row.permission_read_state, "permission_read_state");
  if (readState !== "unknown" && readState !== "ok" && readState !== "failed") {
    throw contractError(functionName, "permission_read_state is not a known state");
  }
  return {
    socialAccountId: requireString(functionName, row.social_account_id, "social_account_id"),
    capabilityPresent: requireBoolean(functionName, row.capability_present, "capability_present"),
    loginKind: loginKindRaw,
    permissionReadState: readState,
    scopesAuthoritative: requireBoolean(functionName, row.scopes_authoritative, "scopes_authoritative"),
    grantedScopes: requireStringArray(functionName, row.granted_scopes, "granted_scopes"),
    scopesReadAt: optionalString(functionName, row.scopes_read_at, "scopes_read_at"),
    lastReadFailedAt: optionalString(functionName, row.last_read_failed_at, "last_read_failed_at"),
    lastReadErrorCode: optionalString(
      functionName,
      row.last_read_error_code,
      "last_read_error_code",
    ),
    credentialGeneration: requireNumber(
      functionName,
      row.credential_generation,
      "credential_generation",
    ),
    credentialUpdatedAt: optionalString(
      functionName,
      row.credential_updated_at,
      "credential_updated_at",
    ),
    generationReason: optionalString(functionName, row.generation_reason, "generation_reason"),
    reconnectedAt: optionalString(functionName, row.reconnected_at, "reconnected_at"),
    hasProtectedCredential: requireBoolean(
      functionName,
      row.has_protected_credential,
      "has_protected_credential",
    ),
    updatedAt: optionalString(functionName, row.updated_at, "updated_at"),
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface FacebookUserCredentialPort {
  /**
   * Reads the protected credential bound to one owned account. A missing
   * binding is `found = false`, never an empty token. The returned account id
   * must be the account that was requested.
   */
  readAccountCredential(input: {
    userId: string;
    socialAccountId: string;
  }): Promise<FacebookUserAccountCredential>;
}

export interface InstagramAccountCapabilityPort {
  readCapability(input: {
    userId: string;
    socialAccountId: string;
  }): Promise<InstagramAccountCapability>;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function isPlainDriverEnvelope(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function ownPropertyValue(value: object, key: string): { owned: true; value: unknown } | { owned: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return { owned: false };
  const propertyValue: unknown = descriptor.value;
  return { owned: true, value: propertyValue };
}

/**
 * A driver error has its own string message and, when present, its own string
 * code. Class instances used by the Supabase client qualify. A boolean, a
 * missing message, or a message inherited from the prototype does not.
 */
function readDriverError(value: unknown): { message: string; code?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = ownPropertyValue(value, "message");
  if (!message.owned || typeof message.value !== "string") return null;
  const code = ownPropertyValue(value, "code");
  if (!code.owned || code.value === undefined) return { message: message.value };
  if (typeof code.value !== "string") return null;
  return { message: message.value, code: code.value };
}

function readRpcData(functionName: string, response: unknown): unknown {
  if (!isPlainDriverEnvelope(response)) {
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
    console.error("[credential-store] protected read failed", {
      event: "read_failed",
      function_name: functionName,
    });
    throw new CredentialStoreError("read_failed", `${functionName} could not be read`);
  }

  return readRpcData(functionName, response);
}

function assertSameAccount(functionName: string, requestedAccountId: string, returnedAccountId: string): void {
  if (returnedAccountId !== requestedAccountId) {
    throw new CredentialStoreError(
      "invalid_contract",
      `${functionName} returned an unusable payload (account scope)`,
    );
  }
}

export function createFacebookUserCredentialStore(
  rpc: ServiceRpcCaller,
): FacebookUserCredentialPort {
  return {
    async readAccountCredential(input) {
      const data = await callRpc(rpc, RPC_FUNCTIONS.readAccountCredential, {
        p_user_id: input.userId,
        p_social_account_id: input.socialAccountId,
      });
      const parsed = parseFacebookUserAccountCredential(RPC_FUNCTIONS.readAccountCredential, data);
      assertSameAccount(
        RPC_FUNCTIONS.readAccountCredential,
        input.socialAccountId,
        parsed.socialAccountId,
      );
      return parsed;
    },
  };
}

export function createInstagramAccountCapabilityStore(
  rpc: ServiceRpcCaller,
): InstagramAccountCapabilityPort {
  return {
    async readCapability(input) {
      const data = await callRpc(rpc, RPC_FUNCTIONS.readCapability, {
        p_user_id: input.userId,
        p_social_account_id: input.socialAccountId,
      });
      const parsed = parseInstagramAccountCapability(RPC_FUNCTIONS.readCapability, data);
      assertSameAccount(
        RPC_FUNCTIONS.readCapability,
        input.socialAccountId,
        parsed.socialAccountId,
      );
      return parsed;
    },
  };
}
