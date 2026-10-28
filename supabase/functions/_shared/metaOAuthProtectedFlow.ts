/**
 * Protected Meta OAuth flow: pending-reference classification and the
 * shared orchestration around the accepted attempt lifecycle.
 *
 * WHAT THIS IS
 *
 *   The business orchestration that the three Meta OAuth entrypoints share:
 *
 *     1. classify any supplied pending reference, in every mode, before any
 *        provider call, mutation, secret read or deletion;
 *     2. capture the explicit intent before the provider is contacted;
 *     3. claim the exact attempt before the provider token exchange;
 *     4. complete the attempt once with the verified candidates;
 *     5. read the safe picker projection;
 *     6. commit one selection atomically and return its receipt;
 *     7. reassert the Page webhook subscription, bounded and best effort.
 *
 *   The provider-specific work stays in the entrypoints. This module owns the
 *   lifecycle, the ownership boundary and the error vocabulary.
 *
 * EVERY-MODE CLASSIFICATION
 *
 *   A pending reference is classified before anything else happens, in both
 *   modes. A protected row is routed to the protected adapter even when the
 *   server mode is legacy, because the row itself carries the attempt
 *   linkage. A missing or failed read is never permission to fall back to the
 *   legacy writer, and a browser-supplied provider token never bypasses the
 *   lookup.
 *
 *   Protected Facebook candidates live in the EXISTING Instagram stash. The
 *   classifier therefore resolves both stash tables and reports a conflict
 *   when a reference resolves to two different rows.
 *
 * SECRETS
 *
 *   The claim token and the provider tokens stay inside the service boundary.
 *   The projections below carry identifiers, names and opaque selection keys
 *   only. No driver text, claim token, provider token or credential is ever
 *   returned to a browser, logged, or placed in a redirect URL.
 */

import {
  MetaOAuthStoreError,
  type MetaOAuthAttemptStore,
  type MetaOAuthCandidate,
  type MetaOAuthClaimResult,
  type MetaOAuthCompleteResult,
  type MetaOAuthFlow,
  type MetaOAuthIntent,
  type MetaOAuthPickerResult,
  type MetaOAuthReceipt,
  type MetaOAuthStash,
} from "./metaOAuthAttemptStore.ts";
import {
  PROTECTED_SUBSCRIPTION_POLICY,
  readExplicitNullableString,
  readMaybeSingle,
} from "./metaOAuthProtectedBoundary.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProtectedOAuthErrorCode =
  /** The accepted attempt RPCs are not present in this deployment. */
  | "PROTECTED_OAUTH_UNAVAILABLE"
  /** The database refused the request. */
  | "PROTECTED_OAUTH_REFUSED"
  /** The attempt was already claimed or the request conflicted. */
  | "PROTECTED_OAUTH_CONFLICT"
  /** The attempt or its picker window expired. */
  | "PROTECTED_OAUTH_EXPIRED"
  /** The request was malformed. */
  | "PROTECTED_OAUTH_INVALID"
  /** A pending reference was combined with a browser-supplied provider token. */
  | "PROTECTED_OAUTH_AMBIGUOUS_REFERENCE"
  /** The referenced row does not exist. */
  | "PROTECTED_OAUTH_REFERENCE_MISSING"
  /** The referenced row belongs to another owner. */
  | "PROTECTED_OAUTH_REFERENCE_FOREIGN"
  /** The read failed. */
  | "PROTECTED_OAUTH_READ_FAILED"
  /** The server credential mode could not be resolved. */
  | "PROTECTED_OAUTH_MODE_UNAVAILABLE"
  /** A required direct identity was not verified. */
  | "PROTECTED_OAUTH_IDENTITY_UNVERIFIED";

export class ProtectedOAuthError extends Error {
  readonly code: ProtectedOAuthErrorCode;
  readonly status: number;

  constructor(code: ProtectedOAuthErrorCode, message: string, status: number) {
    super(message);
    this.name = "ProtectedOAuthError";
    this.code = code;
    this.status = status;
  }
}

export interface ProtectedOAuthClientError {
  status: number;
  error_code: ProtectedOAuthErrorCode;
  error: string;
}

/** Stable client body for a protected OAuth failure. Never echoes driver text. */
export function protectedOAuthClientError(error: unknown): ProtectedOAuthClientError | null {
  if (error instanceof ProtectedOAuthError) {
    return { status: error.status, error_code: error.code, error: error.message };
  }
  if (error instanceof MetaOAuthStoreError) {
    switch (error.code) {
      case "schema_unavailable":
        return {
          status: 503,
          error_code: "PROTECTED_OAUTH_UNAVAILABLE",
          error: "Protected Meta OAuth is not available in this deployment.",
        };
      case "invalid_payload":
        return {
          status: 400,
          error_code: "PROTECTED_OAUTH_INVALID",
          error: "The protected OAuth request was not valid.",
        };
      case "refused":
        return {
          status: 403,
          error_code: "PROTECTED_OAUTH_REFUSED",
          error: "This protected Meta OAuth request was refused.",
        };
      case "conflict":
        return {
          status: 409,
          error_code: "PROTECTED_OAUTH_CONFLICT",
          error: "This protected Meta OAuth request was already handled.",
        };
      case "stale":
        return {
          status: 409,
          error_code: "PROTECTED_OAUTH_CONFLICT",
          error: "This protected Meta OAuth request is no longer current.",
        };
      case "expired":
        return {
          status: 410,
          error_code: "PROTECTED_OAUTH_EXPIRED",
          error: "This protected Meta OAuth attempt has expired.",
        };
      case "contended":
        return {
          status: 409,
          error_code: "PROTECTED_OAUTH_CONFLICT",
          error: "This protected Meta OAuth attempt is busy. Please retry.",
        };
      case "invalid_contract":
        return {
          status: 503,
          error_code: "PROTECTED_OAUTH_READ_FAILED",
          error: "The protected Meta OAuth read was unusable.",
        };
      default:
        return {
          status: 503,
          error_code: "PROTECTED_OAUTH_READ_FAILED",
          error: "The protected Meta OAuth request could not be completed.",
        };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signed-state context
// ---------------------------------------------------------------------------

/**
 * The nested, server-authored protected attempt context carried inside the
 * signed OAuth state.
 *
 * The outer provider flow names stay exactly as they were (`pages`, `direct`,
 * `facebook_business`). The SQL flow lives here, so the two mappings can
 * never be confused with one another.
 */
export interface ProtectedAttemptStateContext {
  attempt_id: string;
  nonce: string;
  flow: MetaOAuthFlow;
}

/** The reserved state key that carries the protected attempt context. */
export const PROTECTED_ATTEMPT_STATE_KEY = "meta_attempt";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const ACCEPTED_FLOWS: readonly MetaOAuthFlow[] = [
  "facebook_page",
  "instagram_page_linked",
  "instagram_direct",
];

/**
 * Reads the protected attempt context out of a verified signed state.
 *
 * A missing context is `null`: the state was minted before the protected
 * lifecycle existed, or by a provider that never had one. A present but
 * malformed context is a typed refusal, never a silently dropped attempt.
 */
export function readProtectedAttemptContext(
  state: unknown,
): ProtectedAttemptStateContext | null {
  if (!isPlainRecord(state)) return null;
  const raw = state[PROTECTED_ATTEMPT_STATE_KEY];
  if (raw === undefined || raw === null) return null;
  if (!isPlainRecord(raw)) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_INVALID",
      "The protected OAuth state was malformed.",
      400,
    );
  }
  const attemptId = raw.attempt_id;
  const nonce = raw.nonce;
  const flow = raw.flow;
  if (
    typeof attemptId !== "string" ||
    attemptId.length === 0 ||
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    typeof flow !== "string" ||
    !ACCEPTED_FLOWS.includes(flow as MetaOAuthFlow)
  ) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_INVALID",
      "The protected OAuth state was malformed.",
      400,
    );
  }
  return {
    attempt_id: attemptId,
    nonce,
    flow: flow as MetaOAuthFlow,
  };
}

// ---------------------------------------------------------------------------
// Explicit intent
// ---------------------------------------------------------------------------

export interface ProtectedIntentInput {
  intent?: unknown;
  targetSocialAccountId?: unknown;
  sourceSocialAccountId?: unknown;
  linkedTargetSocialAccountId?: unknown;
}

export interface ProtectedIntent {
  intent: MetaOAuthIntent;
  targetSocialAccountId?: string;
  sourceSocialAccountId?: string;
  linkedTargetSocialAccountId?: string;
}

const ACCEPTED_INTENTS: readonly MetaOAuthIntent[] = [
  "connect_new",
  "reconnect",
  "add_to_existing_grant",
  "rebind",
];

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_INVALID",
      `The protected OAuth ${field} was not a valid account id.`,
      400,
    );
  }
  return value;
}

/**
 * Resolves the explicit intent of a connection request.
 *
 * The intent is never inferred from the provider result. A request that names
 * a target is a reconnect of that target, a request that names a source
 * extends that source's grant, and a request that names neither creates a new
 * connection. An explicit intent always wins, and an explicit intent that
 * contradicts the named accounts is refused before the attempt is created.
 */
export function resolveProtectedIntent(input: ProtectedIntentInput): ProtectedIntent {
  const target = optionalUuid(input.targetSocialAccountId, "target account");
  const source = optionalUuid(input.sourceSocialAccountId, "source account");
  const linked = optionalUuid(input.linkedTargetSocialAccountId, "linked target account");

  let intent: MetaOAuthIntent;
  if (input.intent !== undefined && input.intent !== null) {
    if (typeof input.intent !== "string" || !ACCEPTED_INTENTS.includes(input.intent as MetaOAuthIntent)) {
      throw new ProtectedOAuthError(
        "PROTECTED_OAUTH_INVALID",
        "The protected OAuth intent was not accepted.",
        400,
      );
    }
    intent = input.intent as MetaOAuthIntent;
  } else if (target) {
    intent = "reconnect";
  } else if (source) {
    intent = "add_to_existing_grant";
  } else {
    intent = "connect_new";
  }

  if (intent === "reconnect" || intent === "rebind") {
    if (!target) {
      throw new ProtectedOAuthError(
        "PROTECTED_OAUTH_INVALID",
        "This protected OAuth request needs an explicit target account.",
        400,
      );
    }
    if (source) {
      throw new ProtectedOAuthError(
        "PROTECTED_OAUTH_INVALID",
        "This protected OAuth request must not name a source account.",
        400,
      );
    }
  } else if (intent === "add_to_existing_grant") {
    if (!source) {
      throw new ProtectedOAuthError(
        "PROTECTED_OAUTH_INVALID",
        "This protected OAuth request needs an explicit source account.",
        400,
      );
    }
    if (target) {
      throw new ProtectedOAuthError(
        "PROTECTED_OAUTH_INVALID",
        "This protected OAuth request must not name a target account.",
        400,
      );
    }
  } else if (target || source) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_INVALID",
      "This protected OAuth request must not name a target or a source account.",
      400,
    );
  }

  const resolved: ProtectedIntent = { intent };
  if (target) resolved.targetSocialAccountId = target;
  if (source) resolved.sourceSocialAccountId = source;
  if (linked) resolved.linkedTargetSocialAccountId = linked;
  return resolved;
}

// ---------------------------------------------------------------------------
// Pending-reference classification
// ---------------------------------------------------------------------------

export type PendingReferenceOutcome =
  /** No pending reference was supplied. */
  | { kind: "none" }
  /** A pending reference was combined with a browser-supplied provider token. */
  | { kind: "ambiguous" }
  /** The linkage row could not be read. */
  | { kind: "read_failed" }
  /** No row matched the reference. */
  | { kind: "missing" }
  /** The row belongs to another owner. */
  | { kind: "foreign" }
  /** The row belongs to the owner and carries an attempt linkage. */
  | { kind: "protected"; attemptId: string; expired: boolean; expiresAt: string | null }
  /** The row belongs to the owner and carries no attempt linkage. */
  | { kind: "legacy"; expired: boolean; expiresAt: string | null }
  /** The reference resolved to two different rows. */
  | { kind: "conflicting" };

/**
 * The narrow row projection the classifier needs. It deliberately excludes
 * every secret column: the classifier never reads a provider token.
 */
export interface PendingLinkageRow {
  id: string;
  userId: string;
  attemptId: string | null;
  expiresAt: string | null;
}

/**
 * The smallest client surface the classifier needs. Two reads, one per stash
 * table, each owner-checked in this module rather than in the query.
 */
export interface PendingLinkageReader {
  readInstagramStash(id: string): Promise<PendingLinkageRow | null>;
  readFacebookStash(id: string): Promise<PendingLinkageRow | null>;
}

export interface PendingLinkageFilter {
  eq(column: string, value: unknown): PendingLinkageFilter;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface PendingLinkageBuilder {
  select(columns: string): PendingLinkageFilter;
}

export interface PendingLinkageClient {
  from(table: string): PendingLinkageBuilder;
}

/**
 * The client seam.
 *
 * The Supabase client's fluent builder has generics deep enough that a
 * structural match against a narrow reader interface is not expressible.
 * The readers therefore accept the client as an infrastructure seam and
 * narrow it once, here. Every read below still validates the shape of what
 * came back, so a client that does not behave is a typed failure rather than
 * a silent success.
 */
export type MetaOAuthClient = unknown;

async function readLinkageRow(
  client: PendingLinkageClient,
  table: string,
  id: string,
): Promise<PendingLinkageRow | null> {
  const read = await readMaybeSingle(() =>
    client
      .from(table)
      .select("id, user_id, meta_oauth_attempt_id, expires_at")
      .eq("id", id)
      .maybeSingle()
  );
  if (read.status === "failed") throw new Error("pending linkage read failed");
  if (read.status === "missing") return null;
  const rowId = readExplicitNullableString(read.row, "id");
  const userId = readExplicitNullableString(read.row, "user_id");
  const attemptId = readExplicitNullableString(read.row, "meta_oauth_attempt_id");
  const expiresAt = readExplicitNullableString(read.row, "expires_at");
  if (!rowId.ok || rowId.value === null || !userId.ok || userId.value === null) {
    throw new Error("pending linkage read failed");
  }
  if (!attemptId.ok || !expiresAt.ok) throw new Error("pending linkage read failed");
  return {
    id: rowId.value,
    userId: userId.value,
    attemptId: attemptId.value,
    expiresAt: expiresAt.value,
  };
}

export function createPendingLinkageReader(client: MetaOAuthClient): PendingLinkageReader {
  const narrow = client as PendingLinkageClient;
  return {
    async readInstagramStash(id) {
      return await readLinkageRow(narrow, "oauth_pending_instagram_selections", id);
    },
    async readFacebookStash(id) {
      return await readLinkageRow(narrow, "oauth_pending_facebook_selections", id);
    },
  };
}

export interface PendingReferenceInput {
  userId: string;
  selectionId?: string | null;
  attemptId?: string | null;
  /** True when the request carries a browser-supplied provider token. */
  providerTokenPresent: boolean;
}

function isExpired(expiresAt: string | null, now: number): boolean {
  if (expiresAt === null) return false;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return false;
  return parsed <= now;
}

/**
 * Classifies a supplied pending reference.
 *
 * The order matters: ambiguity is refused before any read, a failed read is
 * never a missing row, a foreign row is never a missing row, and a row that
 * carries an attempt linkage is protected regardless of the server mode.
 */
export async function classifyPendingReference(
  reader: PendingLinkageReader,
  input: PendingReferenceInput,
  now: number = Date.now(),
): Promise<PendingReferenceOutcome> {
  const hasSelection = typeof input.selectionId === "string" && input.selectionId.length > 0;
  const hasAttempt = typeof input.attemptId === "string" && input.attemptId.length > 0;

  // A provider token must never be a substitute for a lookup.
  if (input.providerTokenPresent && (hasSelection || hasAttempt)) {
    return { kind: "ambiguous" };
  }

  if (!hasSelection) {
    if (hasAttempt) {
      // An attempt-scoped reference needs no stash row. The attempt id is the
      // authority and the SQL scopes it to the owner.
      return {
        kind: "protected",
        attemptId: input.attemptId as string,
        expired: false,
        expiresAt: null,
      };
    }
    return { kind: "none" };
  }

  const selectionId = input.selectionId as string;

  let instagram: PendingLinkageRow | null = null;
  let facebook: PendingLinkageRow | null = null;
  try {
    instagram = await reader.readInstagramStash(selectionId);
    facebook = await reader.readFacebookStash(selectionId);
  } catch {
    return { kind: "read_failed" };
  }

  if (instagram && facebook) {
    // The same reference in both stashes is not a row we can reason about.
    return { kind: "conflicting" };
  }

  const row = instagram ?? facebook;
  if (!row) {
    if (hasAttempt) {
      // The stash was consumed. The attempt id remains the authority; a
      // missing pending row is not a missing account and not a missing receipt.
      return {
        kind: "protected",
        attemptId: input.attemptId as string,
        expired: false,
        expiresAt: null,
      };
    }
    return { kind: "missing" };
  }
  if (row.userId !== input.userId) return { kind: "foreign" };

  const expired = isExpired(row.expiresAt, now);

  if (row.attemptId !== null) {
    if (hasAttempt && row.attemptId !== input.attemptId) {
      // The reference and the attempt disagree. Never guess which one wins.
      return { kind: "conflicting" };
    }
    return {
      kind: "protected",
      attemptId: row.attemptId,
      expired,
      expiresAt: row.expiresAt,
    };
  }

  if (hasAttempt) {
    // A legacy row cannot carry an attempt id. The two disagree.
    return { kind: "conflicting" };
  }

  return { kind: "legacy", expired, expiresAt: row.expiresAt };
}

// ---------------------------------------------------------------------------
// Protected lifecycle
// ---------------------------------------------------------------------------

export interface ProtectedAuthorizeInput {
  userId: string;
  flow: MetaOAuthFlow;
  intent: MetaOAuthIntent;
  targetSocialAccountId?: string;
  linkedTargetSocialAccountId?: string;
  sourceSocialAccountId?: string;
  intendedSocialProfileId?: string;
}

export interface ProtectedAuthorizeResult {
  attemptId: string;
  flow: MetaOAuthFlow;
  intent: MetaOAuthIntent;
  /**
   * The signed-state context. HMAC authenticates this payload; it does not
   * encrypt it. The nonce is inside the state the browser carries and is not
   * a provider token.
   */
  stateContext: ProtectedAttemptStateContext;
}

export async function beginProtectedAttempt(
  store: MetaOAuthAttemptStore,
  input: ProtectedAuthorizeInput,
): Promise<ProtectedAuthorizeResult> {
  const begun = await store.begin({
    userId: input.userId,
    payload: {
      flow: input.flow,
      intent: input.intent,
      ...(input.targetSocialAccountId !== undefined
        ? { target_social_account_id: input.targetSocialAccountId }
        : {}),
      ...(input.linkedTargetSocialAccountId !== undefined
        ? { linked_target_social_account_id: input.linkedTargetSocialAccountId }
        : {}),
      ...(input.sourceSocialAccountId !== undefined
        ? { source_social_account_id: input.sourceSocialAccountId }
        : {}),
      ...(input.intendedSocialProfileId !== undefined
        ? { intended_social_profile_id: input.intendedSocialProfileId }
        : {}),
    },
  });

  return {
    attemptId: begun.attemptId,
    flow: begun.flow,
    intent: begun.intent,
    stateContext: {
      attempt_id: begun.state.attemptId,
      nonce: begun.state.nonce,
      flow: begun.state.flow,
    },
  };
}

export interface ProtectedCallbackInput {
  userId: string;
  context: ProtectedAttemptStateContext;
  /**
   * Exchanges the provider code and returns the verified candidates and the
   * service stash. It runs only after the attempt has been claimed.
   */
  resolveCandidates: () => Promise<{
    candidates: MetaOAuthCandidate[];
    stash: Omit<MetaOAuthStash, "candidates">;
  }>;
}

/**
 * Claims the exact attempt, resolves the provider identity, and completes the
 * attempt once.
 *
 * The order is load-bearing: a duplicate claim refuses before the provider is
 * contacted, and only claimed service data builds the candidate set.
 */
export async function completeProtectedCallback(
  store: MetaOAuthAttemptStore,
  input: ProtectedCallbackInput,
): Promise<MetaOAuthCompleteResult> {
  const claim: MetaOAuthClaimResult = await store.claim({
    userId: input.userId,
    attemptId: input.context.attempt_id,
    nonce: input.context.nonce,
    flow: input.context.flow,
  });

  const resolved = await input.resolveCandidates();

  return await store.complete({
    userId: input.userId,
    attemptId: input.context.attempt_id,
    flow: input.context.flow,
    claimToken: claim.claimToken,
    stash: {
      ...resolved.stash,
      candidates: resolved.candidates,
    },
  });
}

// ---------------------------------------------------------------------------
// Direct identity compatibility
// ---------------------------------------------------------------------------

export interface DirectIdentityEvidence {
  /** The app-scoped id. It stays the canonical `platform_user_id`. */
  canonicalId: string;
  /** The messaging-scoped Instagram id. */
  igid: string;
}

/**
 * Requires both direct identities from the SAME verified provider response.
 *
 * The app-scoped id is what publishing and conversation endpoints address.
 * The messaging-scoped id is what the inbound webhook and the self-comment
 * check resolve. A new protected direct connection needs both, and neither
 * may come from a browser field, a username match or an id substitution.
 */
export function assertDirectIdentityEvidence(candidate: MetaOAuthCandidate): DirectIdentityEvidence {
  const canonicalId = candidate.ig_user_id;
  const igid = candidate.ig_igid;
  if (
    typeof canonicalId !== "string" ||
    canonicalId.trim().length === 0 ||
    typeof igid !== "string" ||
    igid.trim().length === 0
  ) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_IDENTITY_UNVERIFIED",
      "Instagram did not return both identities for this account. Please reconnect.",
      409,
    );
  }
  return { canonicalId, igid };
}

/**
 * The service-only readiness inspection of an existing protected stash.
 *
 * The safe picker projection intentionally omits the messaging alias, so a
 * candidate that was stashed without it cannot be detected from the browser
 * DTO. The check therefore reads the stash with an owner- and attempt-scoped
 * service read and never returns the stored values.
 */
export interface DirectCandidateReadiness {
  /**
   * "verified" — the stashed candidate carries the messaging alias.
   * "unverified" — the candidate exists without the alias.
   * "absent" — the stash row or that candidate is genuinely gone.
   *
   * A fresh callback is not a receipt replay. Only "verified" may commit.
   * A failed read throws instead of being reported as absence.
   */
  state: "verified" | "unverified" | "absent";
}

export type StashCandidateRead =
  | { status: "present"; candidates: unknown[] }
  | { status: "missing" }
  | { status: "failed"; reason: "thrown" | "malformed" | "driver" };

export interface ProtectedStashReader {
  /** Reads the stashed candidates for one owner-scoped, attempt-scoped row. */
  readCandidates(input: {
    userId: string;
    pendingSelectionId: string;
    attemptId: string;
  }): Promise<StashCandidateRead>;
}

export interface ProtectedStashFilter {
  eq(column: string, value: unknown): ProtectedStashFilter;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface ProtectedStashBuilder {
  select(columns: string): ProtectedStashFilter;
}

export interface ProtectedStashClient {
  from(table: string): ProtectedStashBuilder;
}
/**
 * Builds a reader that is structurally scoped to one owner and one attempt.
 * A row that belongs to another owner, or to another attempt, reads as null.
 */
export function createProtectedStashReader(client: MetaOAuthClient): ProtectedStashReader {
  const narrow = client as ProtectedStashClient;
  return {
    async readCandidates(input) {
      const read = await readMaybeSingle(() =>
        narrow
          .from("oauth_pending_instagram_selections")
          .select("id, user_id, meta_oauth_attempt_id, ig_candidates_json")
          .eq("id", input.pendingSelectionId)
          .eq("user_id", input.userId)
          .eq("meta_oauth_attempt_id", input.attemptId)
          .maybeSingle()
      );
      if (read.status === "failed") return { status: "failed", reason: read.reason };
      if (read.status === "missing") return { status: "missing" };
      const id = readExplicitNullableString(read.row, "id");
      const userId = readExplicitNullableString(read.row, "user_id");
      const attemptId = readExplicitNullableString(read.row, "meta_oauth_attempt_id");
      if (
        !id.ok || id.value !== input.pendingSelectionId ||
        !userId.ok || userId.value !== input.userId ||
        !attemptId.ok || attemptId.value !== input.attemptId
      ) {
        return { status: "failed", reason: "malformed" };
      }
      const candidatesDescriptor = Object.getOwnPropertyDescriptor(read.row, "ig_candidates_json");
      const candidates = candidatesDescriptor !== undefined && "value" in candidatesDescriptor
        ? candidatesDescriptor.value
        : undefined;
      if (!Array.isArray(candidates)) return { status: "failed", reason: "malformed" };
      return { status: "present", candidates };
    },
  };
}

function candidateHasAlias(candidate: unknown): boolean {
  if (!isPlainRecord(candidate)) return false;
  const alias = candidate.ig_igid;
  return typeof alias === "string" && alias.trim().length > 0;
}

/**
 * Reports whether the stashed direct candidate carries the messaging alias.
 *
 * The stored values are never returned. The caller either proceeds with the
 * selection or refuses and asks for a restart.
 */
export async function inspectDirectCandidateReadiness(
  reader: ProtectedStashReader,
  input: {
    userId: string;
    pendingSelectionId: string;
    attemptId: string;
    selectionKey: string;
  },
): Promise<DirectCandidateReadiness> {
  const read = await reader.readCandidates(input);
  if (read.status === "failed") {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_READ_FAILED",
      "The protected candidate could not be read.",
      503,
    );
  }
  if (read.status === "missing") return { state: "absent" };
  const candidates = read.candidates;
  const candidate = candidates.find((entry) => {
    if (!isPlainRecord(entry)) return false;
    const igUserId = entry.ig_user_id;
    if (typeof igUserId !== "string") return false;
    return `instagram_direct:ig:${igUserId}` === input.selectionKey;
  });
  if (candidate === undefined) return { state: "absent" };
  return { state: candidateHasAlias(candidate) ? "verified" : "unverified" };
}

// ---------------------------------------------------------------------------
// Picker projection
// ---------------------------------------------------------------------------

export interface ProtectedPickerCandidate {
  selection_key: string;
  ig_user_id: string | null;
  ig_username: string | null;
  ig_profile_picture_url: string | null;
  facebook_page_id: string | null;
  facebook_page_name: string | null;
}

export interface ProtectedPickerProjection {
  attempt_id: string;
  flow: MetaOAuthFlow;
  intent: MetaOAuthIntent;
  social_profile_id: string | null;
  expired: boolean;
  committed_selection_keys: string[];
  candidates: ProtectedPickerCandidate[];
}

/**
 * Projects the safe picker result for the browser.
 *
 * The projection carries identifiers, names, avatars and the opaque selection
 * keys. It never carries a token, a claim, a code or a raw provider response.
 */
export function projectProtectedPicker(result: MetaOAuthPickerResult): ProtectedPickerProjection {
  return {
    attempt_id: result.attemptId,
    flow: result.flow,
    intent: result.intent,
    social_profile_id: result.socialProfileId,
    expired: result.expired,
    committed_selection_keys: [...result.committedSelectionKeys],
    candidates: result.candidates.map((candidate) => ({
      selection_key: candidate.selectionKey,
      ig_user_id: candidate.igUserId,
      ig_username: candidate.igUsername,
      ig_profile_picture_url: candidate.igProfilePictureUrl,
      facebook_page_id: candidate.facebookPageId,
      facebook_page_name: candidate.facebookPageName,
    })),
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface ProtectedCommitResult {
  receipt: MetaOAuthReceipt;
}

/**
 * Commits one selection.
 *
 * The authority is the attempt id plus the opaque selection key. Neither is
 * derived from a page name, a username or any other browser-supplied field.
 */
export async function commitProtectedSelection(
  store: MetaOAuthAttemptStore,
  input: { userId: string; attemptId: string; selectionKey: string },
): Promise<MetaOAuthReceipt> {
  return await store.commit({
    userId: input.userId,
    attemptId: input.attemptId,
    selectionKey: input.selectionKey,
  });
}

// ---------------------------------------------------------------------------
// Post-commit webhook subscription
// ---------------------------------------------------------------------------

export interface OperationalTokenLookup {
  /**
   * Reads the operational token for one owned account, scoped by platform and
   * provider id. The token never leaves the service boundary.
   */
  readOperationalToken(input: {
    userId: string;
    socialAccountId: string;
    platform: "facebook" | "instagram";
    platformUserId: string;
  }): Promise<string | null>;
}

export interface SubscriptionOutcome {
  status: "asserted" | "failed" | "skipped";
  /**
   * The receipt cannot prove a first execution apart from a concurrent
   * replay. Every valid receipt reasserts the subscription. This is not an
   * exactly-once claim and not a live provider-idempotency claim.
   */
  policy: typeof PROTECTED_SUBSCRIPTION_POLICY;
  /** A sanitized, nonsecret warning. Never provider text. */
  warning?: string;
}

export interface WebhookSubscriptionPort {
  /** Subscribes one account to the webhook fields. Throws on failure. */
  subscribe(input: {
    platform: "facebook" | "instagram";
    providerId: string;
    token: string;
  }): Promise<void>;
}

/**
 * Reasserts the webhook subscription after every valid receipt.
 *
 * This is bounded, best-effort work. It never mutates a binding, a receipt or
 * an account, and a failure yields a sanitized warning instead of claiming a
 * rollback of a committed connection. A precommit receipt peek is not used:
 * identical receipt SQL cannot tell a first execution from a concurrent replay.
 */
export async function assertWebhookSubscription(input: {
  receipt: MetaOAuthReceipt;
  userId: string;
  tokens: OperationalTokenLookup;
  subscription: WebhookSubscriptionPort;
}): Promise<SubscriptionOutcome> {
  const receipt = input.receipt;
  const accountId = receipt.socialAccountId;

  let platform: "facebook" | "instagram";
  let providerId: string | null;

  if (receipt.flow === "facebook_page") {
    platform = "facebook";
    providerId = receipt.facebookPageId;
  } else if (receipt.flow === "instagram_direct") {
    platform = "instagram";
    providerId = receipt.platformUserId;
  } else {
    // The Page-linked flow never subscribed in the legacy writer either.
    return { status: "skipped", policy: PROTECTED_SUBSCRIPTION_POLICY };
  }

  if (!providerId || !accountId) {
    return { status: "skipped", policy: PROTECTED_SUBSCRIPTION_POLICY };
  }

  let token: string | null = null;
  try {
    token = await input.tokens.readOperationalToken({
      userId: input.userId,
      socialAccountId: accountId,
      platform,
      platformUserId: providerId,
    });
  } catch {
    token = null;
  }

  if (!token) {
    return {
      status: "failed",
      policy: PROTECTED_SUBSCRIPTION_POLICY,
      warning: "The webhook subscription could not be confirmed.",
    };
  }

  try {
    await input.subscription.subscribe({ platform, providerId, token });
  } catch {
    // The provider text is deliberately dropped. The committed connection
    // stays committed; only the webhook subscription is unconfirmed.
    return {
      status: "failed",
      policy: PROTECTED_SUBSCRIPTION_POLICY,
      warning: "The webhook subscription could not be confirmed.",
    };
  }

  return { status: "asserted", policy: PROTECTED_SUBSCRIPTION_POLICY };
}

// ---------------------------------------------------------------------------
// Owner-scoped attempt and receipt readers
// ---------------------------------------------------------------------------

/**
 * The narrow row projection of one captured attempt. The reader is scoped by
 * owner in the query itself, so a foreign attempt reads as absent.
 */
export interface ProtectedAttemptRow {
  id: string;
  userId: string;
  flow: MetaOAuthFlow;
}

export interface ProtectedAttemptReader {
  readAttempt(input: { userId: string; attemptId: string }): Promise<ProtectedAttemptRow | null>;
}

export interface ProtectedReceiptReader {
  /** True when this attempt already holds a receipt for the selection key. */
  hasReceipt(input: {
    userId: string;
    attemptId: string;
    selectionKey: string;
  }): Promise<boolean>;
}

export function createProtectedAttemptReader(
  client: MetaOAuthClient,
): ProtectedAttemptReader {
  const narrow = client as PendingLinkageClient;
  return {
    async readAttempt(input) {
      const read = await readMaybeSingle(() =>
        narrow
          .from("meta_oauth_attempts")
          .select("id, user_id, flow")
          .eq("id", input.attemptId)
          .eq("user_id", input.userId)
          .maybeSingle()
      );
      if (read.status === "failed") {
        throw new ProtectedOAuthError(
          "PROTECTED_OAUTH_READ_FAILED",
          "The OAuth attempt could not be read.",
          503,
        );
      }
      if (read.status === "missing") return null;
      const id = readExplicitNullableString(read.row, "id");
      const userId = readExplicitNullableString(read.row, "user_id");
      const flow = readExplicitNullableString(read.row, "flow");
      if (
        !id.ok || id.value !== input.attemptId ||
        !userId.ok || userId.value !== input.userId ||
        !flow.ok || flow.value === null ||
        !ACCEPTED_FLOWS.includes(flow.value as MetaOAuthFlow)
      ) {
        throw new ProtectedOAuthError(
          "PROTECTED_OAUTH_READ_FAILED",
          "The OAuth attempt could not be read.",
          503,
        );
      }
      return { id: id.value, userId: userId.value, flow: flow.value as MetaOAuthFlow };
    },
  };
}

export function createProtectedReceiptReader(
  client: MetaOAuthClient,
): ProtectedReceiptReader {
  const narrow = client as PendingLinkageClient;
  return {
    async hasReceipt(input) {
      const read = await readMaybeSingle(() =>
        narrow
          .from("meta_oauth_attempt_receipts")
          .select("attempt_id, user_id, selection_key")
          .eq("attempt_id", input.attemptId)
          .eq("user_id", input.userId)
          .eq("selection_key", input.selectionKey)
          .maybeSingle()
      );
      if (read.status === "failed") {
        throw new ProtectedOAuthError(
          "PROTECTED_OAUTH_READ_FAILED",
          "The OAuth receipt could not be read.",
          503,
        );
      }
      if (read.status === "missing") return false;
      const attemptId = readExplicitNullableString(read.row, "attempt_id");
      const userId = readExplicitNullableString(read.row, "user_id");
      const selectionKey = readExplicitNullableString(read.row, "selection_key");
      if (
        !attemptId.ok || attemptId.value !== input.attemptId ||
        !userId.ok || userId.value !== input.userId ||
        !selectionKey.ok || selectionKey.value !== input.selectionKey
      ) {
        throw new ProtectedOAuthError(
          "PROTECTED_OAUTH_READ_FAILED",
          "The OAuth receipt could not be read.",
          503,
        );
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

/**
 * The shared dependencies of one protected route.
 *
 * `expectedFlows` are the SQL flows the route is allowed to act on. A
 * captured attempt of another flow is refused, so a Facebook route can never
 * commit a direct Instagram attempt and the other way round.
 */
export interface ProtectedRouteContext {
  store: MetaOAuthAttemptStore;
  linkage: PendingLinkageReader;
  attempts: ProtectedAttemptReader;
  receipts: ProtectedReceiptReader;
  userId: string;
  expectedFlows: MetaOAuthFlow[];
}

export interface ProtectedStoreInput {
  selectionId?: string | null;
  attemptId?: string | null;
  selectionKey?: string | null;
  /** True when the request carries a browser-supplied provider token. */
  providerTokenPresent: boolean;
}

export interface ProtectedStoreOutcome {
  receipt: MetaOAuthReceipt;
}

/**
 * The refusal a classification produces when protected mode meets a request
 * that no captured attempt owns.
 *
 * A missing selection is a not-found. A selection that was created before the
 * protected lifecycle cannot be committed by it, and the user has to
 * reconnect.
 */
export function protectedSelectionRefusal(
  outcome: PendingReferenceOutcome,
): ProtectedOAuthError | null {
  if (outcome.kind === "missing") {
    return new ProtectedOAuthError(
      "PROTECTED_OAUTH_REFERENCE_MISSING",
      "This pending selection does not exist.",
      404,
    );
  }
  if (outcome.kind === "none" || outcome.kind === "legacy") {
    // No captured attempt owns this request. The JavaScript-SDK and
    // provider-token-only shapes cannot substitute for a captured
    // preauthorization, and a selection from before the protected lifecycle
    // cannot be committed by it. The user has to reconnect.
    return new ProtectedOAuthError(
      "PROTECTED_OAUTH_REFUSED",
      "This connection cannot be completed by the protected lifecycle. Please reconnect.",
      403,
    );
  }
  return null;
}

/**
 * Classifies the supplied reference and refuses the shapes that must never
 * reach a provider call, a mutation, a secret read or a deletion.
 */
export function pendingReferenceRefusal(
  outcome: PendingReferenceOutcome,
): ProtectedOAuthError | null {
  switch (outcome.kind) {
    case "ambiguous":
      return new ProtectedOAuthError(
        "PROTECTED_OAUTH_AMBIGUOUS_REFERENCE",
        "This request combines a pending reference with a provider token.",
        400,
      );
    case "read_failed":
      return new ProtectedOAuthError(
        "PROTECTED_OAUTH_READ_FAILED",
        "The pending selection could not be read.",
        503,
      );
    case "foreign":
      return new ProtectedOAuthError(
        "PROTECTED_OAUTH_REFERENCE_FOREIGN",
        "This pending selection does not belong to this account.",
        403,
      );
    case "conflicting":
      return new ProtectedOAuthError(
        "PROTECTED_OAUTH_CONFLICT",
        "This pending selection conflicts with the supplied attempt.",
        409,
      );
    default:
      return null;
  }
}

/**
 * Reads the protected picker projection for one owned pending selection.
 *
 * The attempt is read back so a route can refuse a selection that belongs to
 * another flow. The projection itself never carries a token.
 */
export async function protectedPickerRead(
  context: ProtectedRouteContext,
  input: { pendingSelectionId: string },
): Promise<ProtectedPickerProjection> {
  const result = await context.store.read({
    userId: context.userId,
    pendingSelectionId: input.pendingSelectionId,
  });
  if (!context.expectedFlows.includes(result.flow)) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_CONFLICT",
      "This pending selection belongs to a different connection flow.",
      409,
    );
  }
  return projectProtectedPicker(result);
}

/**
 * Commits one protected selection.
 *
 * The authority is the attempt id plus the opaque selection key. A selection
 * that has already been committed replays its receipt and changes nothing.
 */
export async function protectedCommit(
  context: ProtectedRouteContext,
  input: ProtectedStoreInput,
): Promise<ProtectedStoreOutcome> {
  const outcome = await classifyPendingReference(context.linkage, {
    userId: context.userId,
    selectionId: input.selectionId ?? null,
    attemptId: input.attemptId ?? null,
    providerTokenPresent: input.providerTokenPresent,
  });

  const refusal = pendingReferenceRefusal(outcome);
  if (refusal) throw refusal;

  let resolvedAttemptId: string | null = null;
  if (outcome.kind === "protected") {
    resolvedAttemptId = outcome.attemptId;
  } else if (outcome.kind === "missing" || outcome.kind === "none") {
    // Classification already treats a consumed stash plus an attempt id as
    // protected. Reaching here means there is no attempt authority.
    resolvedAttemptId = input.attemptId ?? null;
    if (!resolvedAttemptId) {
      throw new ProtectedOAuthError(
        "PROTECTED_OAUTH_REFERENCE_MISSING",
        "This pending selection does not exist.",
        404,
      );
    }
  } else if (outcome.kind === "legacy") {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_REFERENCE_MISSING",
      "This pending selection does not exist.",
      404,
    );
  }
  if (resolvedAttemptId === null) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_REFERENCE_MISSING",
      "This pending selection does not exist.",
      404,
    );
  }
  const attemptId = resolvedAttemptId;

  const selectionKey = input.selectionKey;
  if (typeof selectionKey !== "string" || selectionKey.length === 0) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_INVALID",
      "The protected OAuth selection key is required.",
      400,
    );
  }

  const attempt = await context.attempts.readAttempt({
    userId: context.userId,
    attemptId,
  });
  if (!attempt) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_REFERENCE_MISSING",
      "This OAuth attempt does not exist.",
      404,
    );
  }
  if (!context.expectedFlows.includes(attempt.flow)) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_CONFLICT",
      "This OAuth attempt belongs to a different connection flow.",
      409,
    );
  }

  const receipt = await commitProtectedSelection(context.store, {
    userId: context.userId,
    attemptId,
    selectionKey,
  });
  if (receipt.attemptId !== attemptId || receipt.selectionKey !== selectionKey) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_READ_FAILED",
      "The protected OAuth receipt did not match the selection.",
      503,
    );
  }
  if (!context.expectedFlows.includes(receipt.flow)) {
    throw new ProtectedOAuthError(
      "PROTECTED_OAUTH_CONFLICT",
      "This OAuth receipt belongs to a different connection flow.",
      409,
    );
  }

  return { receipt };
}

export interface ProtectedCloseOutcome {
  success: true;
  /** True only when the server really removed the row. */
  removed: boolean;
  /** True when the server keeps the selection until it expires. */
  retained_until_expiry: boolean;
  expired: boolean;
  expires_at: string | null;
}

/**
 * The truthful result of closing a protected picker.
 *
 * There is no cancellation RPC. An unexpired protected selection stays on the
 * server until it expires, and this result says exactly that. It never claims
 * a deletion and never routes through the guarded legacy delete.
 */
export function protectedCloseOutcome(outcome: PendingReferenceOutcome): ProtectedCloseOutcome {
  if (outcome.kind === "protected") {
    return {
      success: true,
      removed: false,
      retained_until_expiry: !outcome.expired,
      expired: outcome.expired,
      expires_at: outcome.expiresAt,
    };
  }
  if (outcome.kind === "legacy") {
    return {
      success: true,
      removed: false,
      retained_until_expiry: false,
      expired: outcome.expired,
      expires_at: outcome.expiresAt,
    };
  }
  throw new ProtectedOAuthError(
    "PROTECTED_OAUTH_REFERENCE_MISSING",
    "This pending selection does not exist.",
    404,
  );
}
