/**
 * Protected Meta OAuth read and provider boundary.
 *
 * The accepted SQL remains the authority for ownership, identity and receipts.
 * This module is the narrow edge in front of that contract:
 *
 *   - a service read is a row, a genuine absence, or a failure;
 *   - an RPC result must agree with the request that produced it;
 *   - a protected provider call needs one deadline for headers and body,
 *     HTTP success, a clean payload, the token that was actually selected,
 *     and that token's real expiry;
 *   - failures are stable categories. Raw provider bodies, URLs and thrown
 *     errors are not logged and are not returned to the browser.
 *
 * Legacy helpers keep their existing behavior. Protected routes call this
 * wrapper instead of inheriting a silent fallback.
 */
export const PROTECTED_HTTP_TIMEOUT_MS = 8_000;
export const PROTECTED_OPERATION_BUDGET_MS = 25_000;
export const PROTECTED_SUBSCRIPTION_POLICY = "reassert_after_valid_receipt" as const;
const MAX_PAGE_LIST_REQUESTS = 4;
const GRAPH_HOST = "graph.facebook.com";

export type ProtectedFailureCategory =
  | "provider_http_failure"
  | "provider_malformed"
  | "provider_timeout"
  | "provider_identity_unverified"
  | "subscription_unconfirmed"
  | "unexpected";

export class ProtectedProviderFailure extends Error {
  readonly category: ProtectedFailureCategory;

  constructor(category: ProtectedFailureCategory) {
    super(category);
    this.name = "ProtectedProviderFailure";
    this.category = category;
  }
}

export class BoundaryContractError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "BoundaryContractError";
  }
}

export function protectedFailureCategory(error: unknown): ProtectedFailureCategory {
  if (error instanceof ProtectedProviderFailure) return error.category;
  return "unexpected";
}

/** Logs a stable category. The error object itself is never written. */
export function logProtectedFailure(source: string, error: unknown): void {
  console.error(`[${source}] protected oauth failed`, {
    event: "protected_oauth_failed",
    category: protectedFailureCategory(error),
  });
}

/** A browser-safe reason. It is the category, never the provider text. */
export function protectedProviderClientReason(error: ProtectedProviderFailure): string {
  switch (error.category) {
    case "provider_timeout":
      return "provider_timeout";
    case "provider_http_failure":
      return "code_exchange_failed";
    case "subscription_unconfirmed":
      return "subscription_unconfirmed";
    default:
      return "connect_failed";
  }
}

export interface OperationBudget {
  take(requestedMs: number): number;
}

export function createOperationBudget(
  totalMs: number,
  now: () => number = Date.now,
): OperationBudget {
  const deadline = now() + totalMs;
  return {
    take(requestedMs: number): number {
      const remaining = deadline - now();
      if (!Number.isFinite(requestedMs) || requestedMs <= 0 || remaining <= 0) {
        throw new ProtectedProviderFailure("provider_timeout");
      }
      return Math.min(requestedMs, remaining);
    },
  };
}

// ---------------------------------------------------------------------------
// Service reads
// ---------------------------------------------------------------------------

export type ServiceRead =
  | { status: "row"; row: Record<string, unknown> }
  | { status: "missing" }
  | { status: "failed"; reason: "thrown" | "malformed" | "driver" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownProperty(
  value: object,
  key: string,
): { owned: true; value: unknown } | { owned: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return { owned: false };
  return { owned: true, value: descriptor.value };
}

/**
 * Interprets one `maybeSingle` envelope.
 *
 * Success is an own `data` property and an own `error: null`. Null data is
 * genuine absence. A thrown call, a missing property, an undefined error, a
 * driver error and a non-object row are failures. They are not absence.
 */
export function readServiceEnvelope(response: unknown): ServiceRead {
  if (!isPlainRecord(response)) return { status: "failed", reason: "malformed" };
  const data = ownProperty(response, "data");
  const error = ownProperty(response, "error");
  if (!data.owned || !error.owned) return { status: "failed", reason: "malformed" };
  if (error.value !== null) {
    if (isPlainRecord(error.value) && typeof error.value.message === "string") {
      return { status: "failed", reason: "driver" };
    }
    return { status: "failed", reason: "malformed" };
  }
  if (data.value === null) return { status: "missing" };
  if (!isPlainRecord(data.value)) return { status: "failed", reason: "malformed" };
  return { status: "row", row: data.value };
}

export async function readMaybeSingle(
  read: () => PromiseLike<unknown>,
): Promise<ServiceRead> {
  try {
    return readServiceEnvelope(await read());
  } catch {
    return { status: "failed", reason: "thrown" };
  }
}

/**
 * An explicitly nullable column.
 *
 * The property must be present. `null` is a real null. A string is a value.
 * A missing property, a getter, or any other shape is malformed — it is not
 * a legacy null.
 */
export function readExplicitNullableString(
  row: object,
  key: string,
): { ok: true; value: string | null } | { ok: false } {
  const owned = ownProperty(row, key);
  if (!owned.owned) return { ok: false };
  if (owned.value === null) return { ok: true, value: null };
  if (typeof owned.value !== "string" || owned.value.length === 0) return { ok: false };
  return { ok: true, value: owned.value };
}

// ---------------------------------------------------------------------------
// RPC context agreement
// ---------------------------------------------------------------------------

function agreeNullable(
  actual: string | null,
  requested: string | undefined,
  field: string,
): void {
  const expected = requested === undefined ? null : requested;
  if (actual !== expected) {
    throw new BoundaryContractError(`${field} does not match the request`);
  }
}

export function assertBeginAgrees(
  result: {
    attemptId: string;
    flow: string;
    intent: string;
    userId: string;
    targetSocialAccountId: string | null;
    linkedTargetSocialAccountId: string | null;
    sourceSocialAccountId: string | null;
    intendedSocialProfileId: string | null;
    captureVersion: number;
    nonce: string;
    state: { attemptId: string; nonce: string; flow: string };
  },
  request: {
    userId: string;
    flow: string;
    intent: string;
    targetSocialAccountId?: string;
    linkedTargetSocialAccountId?: string;
    sourceSocialAccountId?: string;
    intendedSocialProfileId?: string;
  },
): void {
  if (!Number.isInteger(result.captureVersion) || result.captureVersion < 0) {
    throw new BoundaryContractError("capture_version is not an integer discriminant");
  }
  if (result.userId !== request.userId) {
    throw new BoundaryContractError("user_id does not match the request");
  }
  if (result.flow !== request.flow) {
    throw new BoundaryContractError("flow does not match the request");
  }
  if (result.intent !== request.intent) {
    throw new BoundaryContractError("intent does not match the request");
  }
  if (result.state.attemptId !== result.attemptId) {
    throw new BoundaryContractError("state.attempt_id does not match the attempt");
  }
  if (result.state.nonce !== result.nonce) {
    throw new BoundaryContractError("state.nonce does not match the attempt nonce");
  }
  if (result.state.flow !== result.flow) {
    throw new BoundaryContractError("state.flow does not match the attempt flow");
  }
  agreeNullable(result.targetSocialAccountId, request.targetSocialAccountId, "target_social_account_id");
  agreeNullable(
    result.linkedTargetSocialAccountId,
    request.linkedTargetSocialAccountId,
    "linked_target_social_account_id",
  );
  agreeNullable(result.sourceSocialAccountId, request.sourceSocialAccountId, "source_social_account_id");
  agreeNullable(
    result.intendedSocialProfileId,
    request.intendedSocialProfileId,
    "intended_social_profile_id",
  );
}

export function assertClaimAgrees(
  result: { attemptId: string; flow: string },
  request: { attemptId: string; flow: string },
): void {
  if (result.attemptId !== request.attemptId) {
    throw new BoundaryContractError("attempt_id does not match the claim request");
  }
  if (result.flow !== request.flow) {
    throw new BoundaryContractError("flow does not match the claim request");
  }
}

export function assertCompleteAgrees(
  result: { attemptId: string; flow: string },
  request: { attemptId: string; flow: string },
): void {
  if (result.attemptId !== request.attemptId) {
    throw new BoundaryContractError("attempt_id does not match the completion request");
  }
  if (result.flow !== request.flow) {
    throw new BoundaryContractError("flow does not match the completion request");
  }
}

export function assertReceiptAgrees(
  result: { attemptId: string; selectionKey: string; flow: string },
  request: { attemptId: string; selectionKey: string },
): void {
  if (result.attemptId !== request.attemptId) {
    throw new BoundaryContractError("attempt_id does not match the commit request");
  }
  if (result.selectionKey !== request.selectionKey) {
    throw new BoundaryContractError("selection_key does not match the commit request");
  }
}

// ---------------------------------------------------------------------------
// Provider HTTP
// ---------------------------------------------------------------------------

export interface ProtectedHttpResult {
  status: number;
  ok: boolean;
  body: unknown;
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message === "Request timed out";
}

/**
 * Reads a JSON body. A parse failure is an empty body, not a timeout.
 * Abort and the deadline stay failures so a hanging read cannot look done.
 */
async function readProtectedJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortLike(error) || error instanceof ProtectedProviderFailure) throw error;
    return null;
  }
}

/**
 * One provider call whose deadline covers the headers and the body.
 *
 * The transport signal is aborted when the deadline or the caller fires.
 * The race still rejects when a synthetic fetcher or body ignores that
 * signal. Timers and the caller listener are cleared on every outcome.
 * Legacy `fetchWithTimeout` is unchanged and is not used here.
 */
export async function protectedFetchJson(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; fetcher?: typeof fetch; signal?: AbortSignal },
): Promise<ProtectedHttpResult> {
  if (options.signal?.aborted || options.timeoutMs <= 0) {
    throw new ProtectedProviderFailure("provider_timeout");
  }

  const transport = new AbortController();
  const fetcher = options.fetcher ?? fetch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | null = null;
  let rejectDeadline: (error: ProtectedProviderFailure) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  let rejectCaller: (error: ProtectedProviderFailure) => void = () => {};
  const callerStop = new Promise<never>((_, reject) => {
    rejectCaller = reject;
  });
  // Attach a handler now so a late rejection is never unhandled.
  deadline.catch(() => undefined);
  callerStop.catch(() => undefined);

  const onCallerAbort = () => {
    transport.abort();
    rejectCaller(new ProtectedProviderFailure("provider_timeout"));
  };
  options.signal?.addEventListener("abort", onCallerAbort);

  const stopWaiting = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    options.signal?.removeEventListener("abort", onCallerAbort);
  };
  const releaseUnreadBody = () => {
    const body = response?.body;
    if (!body) return;
    // Leave the current turn so a caller that still owns the stream can
    // release it, then cancel anything that is still open.
    setTimeout(() => {
      body.cancel().catch(() => undefined);
    }, 0);
  };

  try {
    if (options.signal?.aborted) {
      transport.abort();
      throw new ProtectedProviderFailure("provider_timeout");
    }
    timer = setTimeout(() => {
      transport.abort();
      rejectDeadline(new ProtectedProviderFailure("provider_timeout"));
    }, options.timeoutMs);

    response = await Promise.race([
      fetcher(url, { ...init, signal: transport.signal }),
      deadline,
      callerStop,
    ]);
    const body = await Promise.race([
      readProtectedJson(response),
      deadline,
      callerStop,
    ]);
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    transport.abort();
    releaseUnreadBody();
    if (error instanceof ProtectedProviderFailure) throw error;
    if (isAbortLike(error)) throw new ProtectedProviderFailure("provider_timeout");
    throw new ProtectedProviderFailure("provider_http_failure");
  } finally {
    stopWaiting();
  }
}

/** A non-empty string id. Numbers and objects are not coerced. */
export function cleanProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 128) return null;
  if (value.trim() !== value) return null;
  // ASCII controls, including DEL. This matches the accepted SQL identifier
  // class and does not require a numeric-only id.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return value;
}

/** A provider-supplied lifetime in seconds. Missing or non-integer is unknown. */
export function cleanExpirySeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > 315_360_000) return null;
  return value;
}

export interface SelectedProviderToken {
  token: string;
  /** Null is the accepted unknown expiry. It is never a fabricated lifetime. */
  expiresIn: number | null;
}

/**
 * Keeps the token that the provider actually returned.
 *
 * A successful long-lived response uses that response's token and, when the
 * body carries an integer lifetime, that lifetime. A missing lifetime stays
 * unknown. A failed long-lived response falls back to the short token and
 * only the short token's own lifetime.
 */
export function selectProviderToken(input: {
  shortToken: string;
  shortExpiresIn: number | null;
  longLivedOk: boolean;
  longLivedToken: unknown;
  longLivedExpiresIn: unknown;
}): SelectedProviderToken {
  // Provider tokens are secrets, not ids. Accept a non-empty string and nothing else.
  const longLivedToken = typeof input.longLivedToken === "string" && input.longLivedToken.length > 0
    ? input.longLivedToken
    : null;
  if (input.longLivedOk && longLivedToken !== null) {
    return {
      token: longLivedToken,
      expiresIn: cleanExpirySeconds(input.longLivedExpiresIn),
    };
  }
  return { token: input.shortToken, expiresIn: input.shortExpiresIn };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function readTokenResponse(
  url: string,
  init: RequestInit,
  budget: OperationBudget,
  fetcher: typeof fetch | undefined,
): Promise<{ token: string; expiresIn: number | null }> {
  const response = await protectedFetchJson(url, init, {
    timeoutMs: budget.take(PROTECTED_HTTP_TIMEOUT_MS),
    fetcher,
  });
  if (!response.ok || !isPlainRecord(response.body)) {
    throw new ProtectedProviderFailure("provider_http_failure");
  }
  if (response.body.error || response.body.error_message) {
    throw new ProtectedProviderFailure("provider_http_failure");
  }
  const token = stringField(response.body.access_token);
  if (token === null) throw new ProtectedProviderFailure("provider_malformed");
  return { token, expiresIn: cleanExpirySeconds(response.body.expires_in) };
}

export interface ProtectedFacebookGrant {
  token: string;
  expiresIn: number | null;
  facebookUserId: string;
}

export async function exchangeProtectedFacebookCode(input: {
  graphVersion: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
  fetcher?: typeof fetch;
  budget?: OperationBudget;
}): Promise<ProtectedFacebookGrant> {
  const budget = input.budget ?? createOperationBudget(PROTECTED_OPERATION_BUDGET_MS);
  const tokenUrl = new URL(`https://${GRAPH_HOST}/${input.graphVersion}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", input.appId);
  tokenUrl.searchParams.set("client_secret", input.appSecret);
  tokenUrl.searchParams.set("redirect_uri", input.redirectUri);
  tokenUrl.searchParams.set("code", input.code);
  const shortLived = await readTokenResponse(tokenUrl.toString(), { method: "GET" }, budget, input.fetcher);

  const longUrl = new URL(`https://${GRAPH_HOST}/${input.graphVersion}/oauth/access_token`);
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", input.appId);
  longUrl.searchParams.set("client_secret", input.appSecret);
  longUrl.searchParams.set("fb_exchange_token", shortLived.token);
  let selected: SelectedProviderToken;
  try {
    const response = await protectedFetchJson(longUrl.toString(), { method: "GET" }, {
      timeoutMs: budget.take(PROTECTED_HTTP_TIMEOUT_MS),
      fetcher: input.fetcher,
    });
    selected = selectProviderToken({
      shortToken: shortLived.token,
      shortExpiresIn: shortLived.expiresIn,
      longLivedOk: response.ok && isPlainRecord(response.body) && !response.body.error,
      longLivedToken: isPlainRecord(response.body) ? response.body.access_token : null,
      longLivedExpiresIn: isPlainRecord(response.body) ? response.body.expires_in : null,
    });
  } catch (error) {
    if (error instanceof ProtectedProviderFailure && error.category === "provider_timeout") throw error;
    selected = { token: shortLived.token, expiresIn: shortLived.expiresIn };
  }

  const meUrl = new URL(`https://${GRAPH_HOST}/${input.graphVersion}/me`);
  meUrl.searchParams.set("fields", "id");
  meUrl.searchParams.set("access_token", selected.token);
  const me = await protectedFetchJson(meUrl.toString(), { method: "GET" }, {
    timeoutMs: budget.take(PROTECTED_HTTP_TIMEOUT_MS),
    fetcher: input.fetcher,
  });
  const facebookUserId = me.ok && isPlainRecord(me.body) ? cleanProviderId(me.body.id) : null;
  if (facebookUserId === null) {
    throw new ProtectedProviderFailure("provider_identity_unverified");
  }
  return { token: selected.token, expiresIn: selected.expiresIn, facebookUserId };
}

export interface ProtectedManagedPage {
  id: string;
  name: string;
  accessToken: string;
  instagram: {
    id: string;
    username: string | null;
    profilePictureUrl: string | null;
  } | null;
}

export async function listProtectedManagedPages(input: {
  graphVersion: string;
  accessToken: string;
  fetcher?: typeof fetch;
  budget?: OperationBudget;
}): Promise<ProtectedManagedPage[]> {
  const budget = input.budget ?? createOperationBudget(PROTECTED_OPERATION_BUDGET_MS);
  const first = new URL(`https://${GRAPH_HOST}/${input.graphVersion}/me/accounts`);
  first.searchParams.set(
    "fields",
    "id,name,access_token,instagram_business_account{id,username,profile_picture_url}",
  );
  first.searchParams.set("limit", "100");
  first.searchParams.set("access_token", input.accessToken);

  const pages: ProtectedManagedPage[] = [];
  let next: string | null = first.toString();
  let hops = 0;
  while (next !== null) {
    if (hops >= MAX_PAGE_LIST_REQUESTS) throw new ProtectedProviderFailure("provider_timeout");
    hops += 1;
    const response = await protectedFetchJson(next, { method: "GET" }, {
      timeoutMs: budget.take(PROTECTED_HTTP_TIMEOUT_MS),
      fetcher: input.fetcher,
    });
    if (!response.ok || !isPlainRecord(response.body) || response.body.error) {
      throw new ProtectedProviderFailure("provider_http_failure");
    }
    if (Array.isArray(response.body.data)) {
      for (const entry of response.body.data) {
        const page = readManagedPage(entry);
        if (page) pages.push(page);
      }
    }
    next = nextGraphPage(response.body.paging);
  }
  return pages;
}

function readManagedPage(value: unknown): ProtectedManagedPage | null {
  if (!isPlainRecord(value)) return null;
  const id = cleanProviderId(value.id);
  const name = typeof value.name === "string" ? value.name : null;
  const accessToken = typeof value.access_token === "string" && value.access_token.length > 0
    ? value.access_token
    : null;
  if (id === null || name === null || accessToken === null) return null;
  let instagram: ProtectedManagedPage["instagram"] = null;
  if (isPlainRecord(value.instagram_business_account)) {
    const igId = cleanProviderId(value.instagram_business_account.id);
    if (igId !== null) {
      const username = value.instagram_business_account.username;
      const picture = value.instagram_business_account.profile_picture_url;
      instagram = {
        id: igId,
        username: typeof username === "string" ? username : null,
        profilePictureUrl: typeof picture === "string" ? picture : null,
      };
    }
  }
  return { id, name, accessToken, instagram };
}

function nextGraphPage(paging: unknown): string | null {
  if (!isPlainRecord(paging) || typeof paging.next !== "string") return null;
  try {
    const url = new URL(paging.next);
    if (url.protocol !== "https:" || url.hostname !== GRAPH_HOST) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type ProtectedDirectLogin =
  | {
    kind: "ok";
    canonicalId: string;
    igid: string;
    username: string | null;
    profilePictureUrl: string | null;
    token: string;
    expiresIn: number | null;
  }
  | { kind: "personal" };

/**
 * Exchanges a direct Instagram code and reads both identities from the same
 * successful profile response. A non-success profile is not an identity,
 * even when its body is shaped like one.
 */
export async function exchangeProtectedDirectLogin(input: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
  fetcher?: typeof fetch;
  budget?: OperationBudget;
}): Promise<ProtectedDirectLogin> {
  const budget = input.budget ?? createOperationBudget(PROTECTED_OPERATION_BUDGET_MS);
  const shortLived = await readTokenResponse(
    "https://api.instagram.com/oauth/access_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.appId,
        client_secret: input.appSecret,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
        code: input.code,
      }),
    },
    budget,
    input.fetcher,
  );

  const longUrl = new URL("https://graph.instagram.com/v22.0/access_token");
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", input.appSecret);
  longUrl.searchParams.set("access_token", shortLived.token);
  let selected: SelectedProviderToken;
  try {
    const response = await protectedFetchJson(longUrl.toString(), { method: "GET" }, {
      timeoutMs: budget.take(PROTECTED_HTTP_TIMEOUT_MS),
      fetcher: input.fetcher,
    });
    selected = selectProviderToken({
      shortToken: shortLived.token,
      shortExpiresIn: shortLived.expiresIn,
      longLivedOk: response.ok && isPlainRecord(response.body) && !response.body.error,
      longLivedToken: isPlainRecord(response.body) ? response.body.access_token : null,
      longLivedExpiresIn: isPlainRecord(response.body) ? response.body.expires_in : null,
    });
  } catch (error) {
    if (error instanceof ProtectedProviderFailure && error.category === "provider_timeout") throw error;
    selected = { token: shortLived.token, expiresIn: shortLived.expiresIn };
  }

  const profileUrl = new URL("https://graph.instagram.com/v22.0/me");
  profileUrl.searchParams.set("fields", "id,user_id,username,account_type,profile_picture_url");
  profileUrl.searchParams.set("access_token", selected.token);
  const profile = await protectedFetchJson(profileUrl.toString(), { method: "GET" }, {
    timeoutMs: budget.take(PROTECTED_HTTP_TIMEOUT_MS),
    fetcher: input.fetcher,
  });
  if (!profile.ok || !isPlainRecord(profile.body) || profile.body.error) {
    throw new ProtectedProviderFailure("provider_http_failure");
  }
  if (profile.body.account_type === "PERSONAL") return { kind: "personal" };
  const canonicalId = cleanProviderId(profile.body.id);
  const igid = cleanProviderId(profile.body.user_id);
  if (canonicalId === null || igid === null) {
    throw new ProtectedProviderFailure("provider_identity_unverified");
  }
  const username = profile.body.username;
  const picture = profile.body.profile_picture_url;
  return {
    kind: "ok",
    canonicalId,
    igid,
    username: typeof username === "string" ? username : null,
    profilePictureUrl: typeof picture === "string" ? picture : null,
    token: selected.token,
    expiresIn: selected.expiresIn,
  };
}

/**
 * Meta confirms a webhook subscription with HTTP success and `{success:true}`.
 * An explicit false, a missing or malformed result, or an error body is
 * unconfirmed. The provider text is not retained.
 */
function subscriptionBodyConfirmed(body: unknown): boolean {
  if (!isPlainRecord(body)) return false;
  if (body.error || body.error_message) return false;
  return body.success === true;
}

/** One bounded subscription call. A non-success throws a stable category. */
export async function protectedWebhookSubscribe(input: {
  url: string;
  fetcher?: typeof fetch;
  budget?: OperationBudget;
}): Promise<void> {
  const budget = input.budget ?? createOperationBudget(PROTECTED_HTTP_TIMEOUT_MS);
  const response = await protectedFetchJson(input.url, { method: "POST" }, {
    timeoutMs: budget.take(PROTECTED_HTTP_TIMEOUT_MS),
    fetcher: input.fetcher,
  });
  if (!response.ok || !subscriptionBodyConfirmed(response.body)) {
    throw new ProtectedProviderFailure("subscription_unconfirmed");
  }
}
