/**
 * The owner intake and status use case for the Instagram insights collector.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The HTTP boundary of `instagram-insights-sync`: the request contract, the
 *   verified identity, the two server-controlled availability gates, the one
 *   deadline, the response mapping and one bounded audit record per terminal
 *   path. It owns no SQL, no Supabase client and no provider call.
 *
 * WHY THE IDENTITY IS A VERIFIED CLAIM AND NOT THE SHARED HELPER
 *
 *   The accepted SQL derives the owner from `auth.uid()` and refuses every
 *   caller whose role is not `authenticated`, so the request has to run as
 *   the CALLER. The shared `_shared/auth-helper.ts` cannot be used here: it
 *   falls back to a body-supplied `user_id` when the bearer is the service
 *   key. This endpoint has no service-role caller and no body owner, and a
 *   body owner would be exactly the impersonation the accepted SQL is
 *   designed to prevent. The shared helper is immutable, so this module
 *   verifies the bearer itself, with the server-verified `auth.getClaims`
 *   envelope, and refuses everything that is not an authenticated user
 *   session.
 *
 * WHY THE CLAIM ENVELOPE IS VALIDATED BY DESCRIPTOR
 *
 *   A verified claim set may legitimately carry extra fields, so the claims
 *   object is not closed. What must never happen is an INHERITED or an
 *   ACCESSOR property becoming the authority: an inherited `role` would be
 *   attacker-controllable through a prototype, and an accessor `sub` would
 *   run code inside this process. Every required value is therefore read
 *   through its own data descriptor, and an accessor is refused WITHOUT
 *   being invoked.
 *
 * WHY NOTHING ELSE IS READ BEFORE THE GATES
 *
 *   Collection is off by default and the protected credential mode is a
 *   server-controlled switch. Both actions - enqueue and status - are gated:
 *   a valid absent or off collection setting is a refusal BEFORE any new
 *   job schema, RPC, credential or provider access, and a failed or
 *   malformed setting is UNAVAILABLE, never "absent" and never "off". The
 *   gates change no setting: disabling collection never moves an account
 *   back to legacy credentials.
 *
 * ONE DEADLINE
 *
 *   The whole operation has fifteen seconds, counted from before the body
 *   is read, and one second of that is reserved for the audit record and the
 *   response. Every dependency - the body stream, the claim verification,
 *   the settings reads, the RPC and the audit write - is bounded by the
 *   REMAINING budget and by a five second ceiling. The ceilings are not
 *   additive: a request never gets fifteen seconds per step.
 *
 *   A timeout is never a rollback. When the caller stops waiting, the
 *   database statement may still have committed, and the endpoint says so
 *   instead of guessing. An enqueue is never replayed and a status read is
 *   never used as a substitute receipt.
 */

import { z } from "npm:zod@3.23.8";

import {
  classifyAppSettingRow,
  CredentialConfigurationError,
  CredentialModeError,
  resolveFacebookCredentialMode,
  resolveInstagramCollectionEnabled,
  FACEBOOK_CREDENTIAL_MODE_SETTING_KEY,
  INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY,
} from "../_shared/facebookCredentialMode.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { validateRequestBody } from "../_shared/validate.ts";

import {
  canonicalUuid,
  isGregorianCalendarDate,
  isUuidText,
  type OwnerCollectionStore,
  type OwnerEnqueueOutcome,
  type OwnerStatusProjection,
} from "./store.ts";

/** The whole operation, counted from before the body is read. */
export const OWNER_INTAKE_TOTAL_BUDGET_MS = 15_000;

/** The ceiling of a single dependency: the body, the claims, a read, a write, the log. */
export const OWNER_INTAKE_DEPENDENCY_CEILING_MS = 5_000;

/** The reserve kept for the audit record and the response. */
export const OWNER_INTAKE_LOG_RESERVE_MS = 1_000;

/** The request body limit, in bytes. */
export const OWNER_INTAKE_MAX_BODY_BYTES = 4_096;

/**
 * The stable client-facing error codes. They are a closed set: a refusal
 * always says the same thing, and it never says why in driver or SQL text.
 */
export type OwnerIntakeErrorCode =
  | "method_not_allowed"
  | "invalid_request"
  | "payload_too_large"
  | "unauthorized"
  | "not_found"
  | "throttled"
  | "collection_disabled"
  | "protected_credentials_required"
  | "settings_unavailable"
  | "enqueue_indeterminate"
  | "status_unavailable"
  | "request_unavailable";

/** The server-verified claim reader. It resolves the raw envelope only. */
export type VerifiedClaimsReader = (token: string, signal: AbortSignal) => Promise<unknown>;

/**
 * The shape a completed settings read has after its own fields check out.
 * The reader port is `unknown`, so a driver result is not cast into this.
 */
export interface SettingReadEnvelope {
  readonly data: unknown;
  readonly error: { readonly code?: string | null } | null;
}

/** The server-controlled settings reader. It is the service client's only read. */
export type SettingReader = (key: string) => Promise<unknown>;

/** One audit record. It carries no token, no body and no driver text. */
export interface OwnerIntakeAuditEvent {
  readonly action: "enqueue" | "status" | "unknown";
  readonly outcome: string;
  readonly status: number;
  readonly userId?: string;
  readonly socialAccountId?: string;
}

/** The bounded audit sink. It never throws and never blocks the response. */
export type OwnerIntakeAuditSink = (event: OwnerIntakeAuditEvent) => Promise<void>;

export interface InstagramInsightsSyncDeps {
  /**
   * Whether the server-controlled configuration is usable. It is read per
   * request, because the configuration is server-controlled state and not a
   * module constant. A deployment without a URL or a key is refused before
   * anything is read, and the refusal never prints the configuration.
   */
  readonly configuration: () => "ready" | "unavailable";
  readonly verifyClaims: VerifiedClaimsReader;
  readonly readSetting: SettingReader;
  /**
   * Builds the owner store for one verified token. The token is the SAME
   * bearer that was verified, and it is used unchanged, so the database sees
   * the caller's own identity.
   */
  readonly createOwnerStore: (verifiedToken: string) => OwnerCollectionStore;
  readonly audit: OwnerIntakeAuditSink;
}

// ---------------------------------------------------------------------------
// The request contract
// ---------------------------------------------------------------------------

const socialAccountIdSchema = z
  .string()
  .refine((value) => isUuidText(value), "social_account_id must be a UUID");

const enqueueRequestSchema = z
  .object({
    action: z.literal("enqueue"),
    social_account_id: socialAccountIdSchema,
    mode: z.enum(["normal", "force"]).optional().default("normal"),
  })
  .strict();

const statusRequestSchema = z
  .object({
    action: z.literal("status"),
    social_account_id: socialAccountIdSchema,
    captured_on: z
      .string()
      .refine((value) => isGregorianCalendarDate(value), "captured_on must be a calendar date")
      .optional(),
  })
  .strict();

/**
 * The strict request union.
 *
 * Unknown keys are refused, so a service action, a target kind, a job id, an
 * owner id or a credential in the body is a malformed request rather than a
 * silently ignored field. An explicit null is not an omission: `mode: null`
 * and `captured_on: null` are both malformed.
 */
const ownerIntakeRequestSchema = z.discriminatedUnion("action", [
  enqueueRequestSchema,
  statusRequestSchema,
]);

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

export interface OwnerIntakeDeadline {
  /** The milliseconds left for body, authentication, settings and RPC work. */
  workMs(): number;
  /** The milliseconds left in the whole operation, including the reserve. */
  totalMs(): number;
}

function createDeadline(startedAt: number): OwnerIntakeDeadline {
  return {
    workMs: () =>
      OWNER_INTAKE_TOTAL_BUDGET_MS - OWNER_INTAKE_LOG_RESERVE_MS - (Date.now() - startedAt),
    totalMs: () => OWNER_INTAKE_TOTAL_BUDGET_MS - (Date.now() - startedAt),
  };
}

type BoundedOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: "timeout" | "failed";
      readonly error?: unknown;
    };

/**
 * Runs one dependency inside a ceiling that is drawn from the REMAINING
 * budget.
 *
 * The losing promise is always settled: a late rejection is consumed here,
 * so a dependency that fails after the caller gave up can never become an
 * unhandled rejection, and it can never be mistaken for a result.
 */
async function runBounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ceilingMs: number,
): Promise<BoundedOutcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{
    readonly ok: false;
    readonly reason: "timeout";
  }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: "timeout" });
    }, Math.max(0, ceilingMs));
  });

  const settled = Promise.resolve()
    .then(() => work(controller.signal))
    .then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, reason: "failed", error }) as const,
    );

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function dependencyCeiling(deadline: OwnerIntakeDeadline): number {
  return Math.min(OWNER_INTAKE_DEPENDENCY_CEILING_MS, deadline.workMs());
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

type BodyOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too_large" | "aborted" | "failed" };

/**
 * Reads at most `maxBytes` bytes from the request stream.
 *
 * The limit is enforced while the bytes arrive, so a body that never ends is
 * refused at the limit instead of being buffered. A `Content-Length` header
 * is deliberately NOT trusted: it may be absent and it may lie, and the
 * authoritative count is the one the reader produced.
 */
/**
 * Best-effort cancellation. `cancel()` is allowed to never settle, and a
 * later rejection must not become an unhandled rejection or a different
 * status. The caller already knows the body's outcome.
 */
function abandonReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // A synchronous cancel failure is not the body's outcome.
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BodyOutcome> {
  const body = request.body;
  if (!body) return { ok: false, reason: "failed" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const onAbort = () => {
    abandonReader(reader);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  // The caller's own cancellation stops the read as well. A caller that
  // goes away must not keep the connection open.
  const onCallerAbort = () => {
    abandonReader(reader);
  };
  request.signal.addEventListener("abort", onCallerAbort, { once: true });

  try {
    for (;;) {
      if (signal.aborted || request.signal.aborted) {
        abandonReader(reader);
        return { ok: false, reason: "aborted" };
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        // The limit is already proved. cancel() may never settle, and waiting
        // for it would spend the dependency budget and hide the 413.
        abandonReader(reader);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }

    if (signal.aborted || request.signal.aborted) {
      // The read was cut short by a cancellation, not by the end of the
      // body. What arrived is not a request.
      return { ok: false, reason: "aborted" };
    }
  } catch {
    abandonReader(reader);
    return {
      ok: false,
      reason: signal.aborted || request.signal.aborted ? "aborted" : "failed",
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
    request.signal.removeEventListener("abort", onCallerAbort);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(merged) };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads an OWN DATA property without invoking an accessor. An inherited or
 * accessor property is reported as absent, so it can never become the
 * authority and never runs code inside this process.
 */
function readOwnData(
  record: object,
  key: string,
): { readonly present: boolean; readonly value: unknown } {
  if (!Object.hasOwn(record, key)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) return { present: false, value: undefined };
  return { present: true, value: descriptor.value };
}

interface VerifiedOwner {
  readonly userId: string;
}

/**
 * Validates the server-verified claim envelope.
 *
 * The envelope must be a plain record with an own `error` that is exactly
 * null, an own `data` with an own `claims`, and a `claims` object with an
 * own `sub` that is a usable UUID and an own `role`. The role must be
 * `authenticated`: a verified administrator is an ordinary owner here and
 * still carries that role, while a service identity is refused outright.
 */
function parseVerifiedOwner(envelope: unknown): VerifiedOwner | null {
  if (!isPlainRecord(envelope)) return null;

  const error = readOwnData(envelope, "error");
  if (!error.present || error.value !== null) return null;

  const data = readOwnData(envelope, "data");
  if (!data.present || !isPlainRecord(data.value)) return null;

  const claims = readOwnData(data.value, "claims");
  if (!claims.present || !isPlainRecord(claims.value)) return null;

  const role = readOwnData(claims.value, "role");
  if (!role.present || role.value !== "authenticated") return null;

  const sub = readOwnData(claims.value, "sub");
  if (!sub.present || !isUuidText(sub.value)) return null;

  return { userId: canonicalUuid(sub.value) };
}

/** Extracts the bearer token, unchanged. A missing or malformed header is a refusal. */
function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = BEARER_PATTERN.exec(header);
  if (!match) return null;
  const token = match[1]!;
  return token.length > 0 ? token : null;
}

// ---------------------------------------------------------------------------
// The settings gates
// ---------------------------------------------------------------------------

/**
 * Refuses a settings envelope whose required values are not own data
 * properties.
 *
 * This runs BEFORE the shared lookup reads the envelope, because the shared
 * lookup reads `data`, `error` and `value` directly and a getter on any of
 * them would be executed there. The shared helper is immutable, so the
 * descriptor check happens here, in front of it.
 */
function assertSettingEnvelopeIsSafe(
  envelope: unknown,
): asserts envelope is Record<string, unknown> {
  if (!isPlainRecord(envelope)) throw new CredentialConfigurationError();

  const error = readOwnData(envelope, "error");
  if (!error.present || error.value !== null) throw new CredentialConfigurationError();

  const data = readOwnData(envelope, "data");
  if (!data.present) throw new CredentialConfigurationError();
  if (data.value === null) return;

  if (!isPlainRecord(data.value)) throw new CredentialConfigurationError();

  const value = readOwnData(data.value, "value");
  if (!value.present) throw new CredentialConfigurationError();
}

// ---------------------------------------------------------------------------
// The responses
// ---------------------------------------------------------------------------

function jsonResponse(
  request: Request,
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...restrictedCorsHeaders(request),
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    },
  });
}

function errorResponse(
  request: Request,
  code: OwnerIntakeErrorCode,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonResponse(request, { error: code }, status, extraHeaders);
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export function createInstagramInsightsSyncHandler(
  deps: InstagramInsightsSyncDeps,
): (request: Request) => Promise<Response> {
  /**
   * One bounded audit attempt per terminal path.
   *
   * The attempt is bounded by the reserve that was kept for it. A failed
   * audit write is never reported as a stored row, and it never repeats the
   * work that produced the terminal outcome.
   */
  async function audit(
    deadline: OwnerIntakeDeadline,
    event: OwnerIntakeAuditEvent,
  ): Promise<void> {
    const budget = Math.min(OWNER_INTAKE_LOG_RESERVE_MS, deadline.totalMs());
    if (budget <= 0) return;
    await runBounded(() => deps.audit(event), budget);
  }

  return async function handleOwnerIntake(request: Request): Promise<Response> {
    // The deadline starts BEFORE the body is read.
    const deadline = createDeadline(Date.now());

    // What is known about the caller so far. It grows as the request is
    // understood, and it is the only thing the audit record carries.
    const context: {
      action: "enqueue" | "status" | "unknown";
      userId?: string;
      socialAccountId?: string;
    } = { action: "unknown" };

    const auditEvent = (outcome: string, status: number): OwnerIntakeAuditEvent => ({
      action: context.action,
      outcome,
      status,
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.socialAccountId ? { socialAccountId: context.socialAccountId } : {}),
    });

    const finish = async (
      status: number,
      body: unknown,
      outcome: string,
      extraHeaders?: Record<string, string>,
    ): Promise<Response> => {
      await audit(deadline, auditEvent(outcome, status));
      return jsonResponse(request, body, status, extraHeaders);
    };

    const refuse = async (
      status: number,
      code: OwnerIntakeErrorCode,
      extraHeaders?: Record<string, string>,
    ): Promise<Response> => {
      await audit(deadline, auditEvent(code, status));
      return errorResponse(request, code, status, extraHeaders);
    };

    if (request.method === "OPTIONS") {
      // The preflight is not a request outcome: it carries no body, no
      // identity and no work, so it is not audited.
      return new Response(null, { status: 204, headers: restrictedCorsHeaders(request) });
    }

    if (request.method !== "POST") {
      return await refuse(405, "method_not_allowed", { Allow: "POST, OPTIONS" });
    }

    if (deps.configuration() !== "ready") {
      return await refuse(503, "request_unavailable");
    }

    // --- The body -------------------------------------------------------
    const bodyRead = await runBounded(
      (signal) => readBoundedBody(request, OWNER_INTAKE_MAX_BODY_BYTES, signal),
      dependencyCeiling(deadline),
    );

    if (!bodyRead.ok) {
      // The body could not be read in time, or the reader failed. The
      // request never became a valid request, and the service cannot answer
      // it inside the budget.
      return await refuse(503, "request_unavailable");
    }

    const body = bodyRead.value;
    if (!body.ok) {
      if (body.reason === "too_large") {
        return await refuse(413, "payload_too_large");
      }
      if (body.reason === "aborted") {
        return await refuse(503, "request_unavailable");
      }
      return await refuse(400, "invalid_request");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body.text);
    } catch {
      return await refuse(400, "invalid_request");
    }

    // The action is peeked before validation so a malformed request is still
    // attributed to the right action. It is never trusted for routing.
    const peekedAction = readOwnData(
      isPlainRecord(parsedJson) ? parsedJson : {},
      "action",
    );
    if (
      peekedAction.present &&
      (peekedAction.value === "enqueue" || peekedAction.value === "status")
    ) {
      context.action = peekedAction.value;
    }

    const validated = validateRequestBody(ownerIntakeRequestSchema, parsedJson);
    if (!validated.success) {
      return await refuse(400, "invalid_request");
    }

    const intake = validated.data;
    const canonicalAccountId = canonicalUuid(intake.social_account_id);
    context.socialAccountId = canonicalAccountId;

    // --- The verified identity -----------------------------------------
    const token = readBearerToken(request);
    if (!token) {
      return await refuse(401, "unauthorized");
    }

    const claimsOutcome = await runBounded(
      (signal) => deps.verifyClaims(token, signal),
      dependencyCeiling(deadline),
    );
    if (!claimsOutcome.ok) {
      // The verifier could not be reached or did not answer in time. That is
      // an unavailable dependency, not a refusal of the caller.
      return await refuse(503, "request_unavailable");
    }

    const owner = parseVerifiedOwner(claimsOutcome.value);
    if (!owner) {
      return await refuse(401, "unauthorized");
    }
    context.userId = owner.userId;
    // --- The availability gates ----------------------------------------
    //
    // The shared classifier and the shared resolvers own the setting
    // semantics. The descriptor check in front of them is what makes reading
    // those envelopes safe, and the bounded read is what keeps a hanging
    // settings query inside the budget.
    const readRequiredSetting = async (key: string): Promise<unknown> => {
      const outcome = await runBounded(
        () => deps.readSetting(key),
        dependencyCeiling(deadline),
      );
      if (!outcome.ok) throw new CredentialConfigurationError();

      assertSettingEnvelopeIsSafe(outcome.value);

      // `data` was proved to be an own data property. Read it the same way
      // so the shared classifier, which uses ordinary property access, never
      // receives a getter.
      const classified = classifyAppSettingRow(readOwnData(outcome.value, "data").value);
      if (classified.shape === "malformed") throw new CredentialConfigurationError();
      if (classified.shape === "absent") return null;
      return classified.value;
    };

    let collectionEnabled: boolean;
    try {
      collectionEnabled = resolveInstagramCollectionEnabled(
        await readRequiredSetting(INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY),
      );
    } catch {
      // A failed, malformed or unreadable required setting is unavailable.
      // It is never read as absent and never read as off.
      return await refuse(503, "settings_unavailable");
    }

    if (!collectionEnabled) {
      // Nothing else is read: no job schema, no RPC, no credential, no
      // provider. The stored history stays in the database and this
      // endpoint does not expose it while collection is off.
      return await refuse(503, "collection_disabled");
    }

    let credentialMode: string;
    try {
      credentialMode = resolveFacebookCredentialMode(
        await readRequiredSetting(FACEBOOK_CREDENTIAL_MODE_SETTING_KEY),
      );
    } catch {
      return await refuse(503, "settings_unavailable");
    }

    if (credentialMode !== "protected") {
      return await refuse(503, "protected_credentials_required");
    }

    // --- The owner RPC --------------------------------------------------
    if (deadline.workMs() <= 0) {
      // The budget is spent before the statement is sent. Nothing was
      // written, so this is not an indeterminate outcome.
      return await refuse(503, "request_unavailable");
    }

    let store: OwnerCollectionStore;
    try {
      store = deps.createOwnerStore(token);
    } catch {
      return await refuse(503, "request_unavailable");
    }

    /**
     * Maps a store failure onto the client contract.
     *
     * A missing target and a target owned by somebody else are the same
     * answer. A definitive refusal keeps its own status. Everything else is
     * indeterminate, and it is never reported as a success.
     */
    const mapStoreFailure = (
      failure: string | null,
      indeterminate: OwnerIntakeErrorCode,
    ): Promise<Response> => {
      if (failure === "target_not_found") return refuse(404, "not_found");
      if (failure === "request_refused") return refuse(400, "invalid_request");
      if (failure === "unauthorized") return refuse(401, "unauthorized");
      return refuse(503, indeterminate);
    };

    if (intake.action === "enqueue") {
      const outcome = await runBounded(
        (signal) =>
          store.enqueueOwnerJob({
            socialAccountId: canonicalAccountId,
            mode: intake.mode ?? "normal",
            signal,
          }),
        dependencyCeiling(deadline),
      );

      if (!outcome.ok) {
        if (outcome.reason === "failed") {
          return await mapStoreFailure(readStoreFailure(outcome.error), "enqueue_indeterminate");
        }
        // The statement may have committed. The outcome is indeterminate and
        // the enqueue is never replayed.
        return await refuse(503, "enqueue_indeterminate");
      }

      const accepted: OwnerEnqueueOutcome = outcome.value;
      if (accepted.kind === "throttled") {
        const retryAfter = accepted.projection.retry_after_seconds;
        return await finish(429, accepted.projection, "throttled", {
          "Retry-After": String(retryAfter),
        });
      }

      return await finish(202, accepted.projection, "enqueued");
    }

    const statusOutcome = await runBounded(
      (signal) =>
        store.readOwnerStatus({
          socialAccountId: canonicalAccountId,
          capturedOn: intake.captured_on ?? null,
          signal,
        }),
      dependencyCeiling(deadline),
    );

    if (!statusOutcome.ok) {
      if (statusOutcome.reason === "failed") {
        return await mapStoreFailure(readStoreFailure(statusOutcome.error), "status_unavailable");
      }
      // A failed or timed-out read is unavailable. It is never an empty
      // history and never a `none`.
      return await refuse(503, "status_unavailable");
    }

    const projection: OwnerStatusProjection = statusOutcome.value;
    return await finish(200, projection, "status_read");
  };
}

/**
 * Reads the store's failure kind without importing its class, so the
 * handler stays independent of the store's error identity.
 */
function readStoreFailure(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const failure = readOwnData(error, "failure");
  if (!failure.present || typeof failure.value !== "string") return null;
  return failure.value;
}
