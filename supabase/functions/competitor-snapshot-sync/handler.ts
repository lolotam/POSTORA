/**
 * The HTTP boundary of the competitor collector.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The request contract, the authorization matrix, the two server-controlled
 *   availability gates, the deadline, the response mapping and one bounded
 *   audit attempt per terminal path. It owns no SQL, no Supabase client and
 *   no provider call.
 *
 * THE WIRE CONTRACT
 *
 *   The request is a strict union on `mode`. Nothing else is accepted:
 *
 *     mode = "entry"          a user asks for one tracked competitor to be
 *                             collected now. It ENQUEUES and returns.
 *     mode = "force"          the same, with the force flag of the accepted
 *                             enqueue.
 *     mode = "status"         a user reads the collection status of one
 *                             tracked competitor.
 *     mode = "enqueue-daily"  the scheduler asks for the due entries to be
 *                             enqueued.
 *     mode = "all"            the scheduler asks for the due work to be
 *                             drained.
 *
 *   An unknown mode, an unknown key, a `user_id` in the body or a
 *   credential in the body is a malformed request, not a silently ignored
 *   field.
 *
 * THE AUTHORIZATION MATRIX
 *
 *   A USER mode needs a verified user session. A cron secret or the
 *   service-role key is REFUSED for a user mode: the service path never
 *   impersonates a user, and the owner RPCs derive the owner from
 *   `auth.uid()` precisely so that an impersonation is impossible.
 *
 *   A SERVICE mode needs the cron secret, the service-role key, or an
 *   admin session. A plain user session is REFUSED for a service mode.
 *
 *   A missing cron secret does not lock the admin out, but it does mean no
 *   cron caller can be authenticated at all.
 *
 * THE GATES
 *
 *   Collection is off by default and the protected credential mode is a
 *   server-controlled switch. Both are read BEFORE any job schema, RPC,
 *   credential or provider access. An absent or off collection setting is
 *   a refusal; a failed or malformed setting is UNAVAILABLE, never
 *   "absent" and never "off".
 *
 * WHY THE CREDENTIAL MODE IS NOT COLLECTION PERMISSION
 *
 *   The global credential mode says WHERE a Facebook User secret is read
 *   from. It does not say WHICH watchlist entries may be collected for and
 *   which viewer is approved for them: that is the rollout policy, and the
 *   accepted SQL decides it per target, per viewer and per request. So the
 *   mode is still READ and still VALIDATED here - a malformed or unreadable
 *   mode is still unavailable - but a readable `legacy` mode is no longer a
 *   refusal, and this endpoint never decides the admission itself.
 *
 * ONE DEADLINE
 *
 *   The request has forty-five seconds, counted from before the body is
 *   read, and one second of that is reserved for the audit record and the
 *   response. Every dependency is bounded by the REMAINING budget. The
 *   ceilings are not additive.
 *
 *   A timeout is never a rollback. When the caller stops waiting, the
 *   database statement may still have committed, and the endpoint says so
 *   instead of guessing. An enqueue is never replayed.
 */

import { isPlainRecord, readOwnData } from "./receipts.ts";
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

import type { CompetitorOwnerStore } from "./store.ts";
import {
  runCompetitorDrain,
  runCompetitorEnqueue,
  WORKER_TOTAL_BUDGET_MS,
  type CompetitorWorkerPorts,
} from "./syncWorker.ts";

/** The whole request, counted from before the body is read. */
export const COMPETITOR_SYNC_TOTAL_BUDGET_MS = 45_000;

/** The ceiling of a single dependency: the body, the claims, a read, a write. */
export const COMPETITOR_SYNC_DEPENDENCY_CEILING_MS = 5_000;

/** The reserve kept for the audit record and the response. */
export const COMPETITOR_SYNC_LOG_RESERVE_MS = 1_000;

/**
 * The ceiling of the DURABLE daily dispatch.
 *
 * It is a dependency ceiling, not a provider one: the dispatch is a single
 * bounded database statement, and it must not be able to spend the drain's
 * budget.
 */
export const COMPETITOR_DAILY_DISPATCH_CEILING_MS = 5_000;

/** The request body limit, in bytes. */
export const COMPETITOR_SYNC_MAX_BODY_BYTES = 4_096;

/** The stable client-facing error codes. They are a closed set. */
export type CompetitorSyncErrorCode =
  | "method_not_allowed"
  | "invalid_request"
  | "payload_too_large"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "throttled"
  | "collection_disabled"
  /**
   * The rollout policy does not admit this target.
   *
   * It is a DEFINITE refusal of a target that IS owned by the caller: the
   * watchlist entry exists and belongs to the caller, and the collection
   * policy simply does not admit it yet.
   */
  | "collection_not_eligible"
  | "settings_unavailable"
  | "service_auth_unavailable"
  | "request_unavailable"
  | "enqueue_indeterminate"
  | "status_unavailable"
  | "work_indeterminate";

/** One audit record. It carries no token, no body and no driver text. */
export interface CompetitorSyncAuditEvent {
  readonly action: string;
  readonly outcome: string;
  readonly status: number;
  readonly userId?: string;
  readonly watchlistId?: string;
}

/** The bounded audit sink. It never throws and never blocks the response. */
export type CompetitorSyncAuditSink = (event: CompetitorSyncAuditEvent) => Promise<void>;

/** The server-verified claim reader. It resolves the raw envelope only. */
export type VerifiedClaimsReader = (token: string, signal: AbortSignal) => Promise<unknown>;

export interface CompetitorSyncDeps {
  /** Whether the server-controlled configuration is usable. */
  readonly configuration: () => "ready" | "unavailable";
  /** The server-verified claim reader. */
  readonly verifyClaims: VerifiedClaimsReader;
  /** The server-controlled settings reader. */
  readonly readSetting: (key: string) => Promise<unknown>;
  /** Builds the owner store for one verified token. */
  readonly createOwnerStore: (verifiedToken: string) => CompetitorOwnerStore;
  /** Builds the service worker ports. */
  readonly createServiceWorker: () => CompetitorWorkerPorts;
  /** The cron secret, or null when it is not configured. */
  readonly cronSecret: () => string | null;
  /** The service-role key, or null when it is not configured. */
  readonly serviceRoleKey: () => string | null;
  /** Whether an owner is an administrator. A failed lookup is false. */
  readonly isAdmin: (userId: string) => Promise<boolean>;
  /** The bounded audit sink. */
  readonly audit: CompetitorSyncAuditSink;
}

// ---------------------------------------------------------------------------
// The request contract
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const entryRequestSchema = z.object({
  mode: z.literal("entry"),
  watchlist_id: uuidSchema,
}).strict();

const forceRequestSchema = z.object({
  mode: z.literal("force"),
  watchlist_id: uuidSchema,
}).strict();

const statusRequestSchema = z.object({
  mode: z.literal("status"),
  watchlist_id: uuidSchema,
}).strict();

const cursorSchema = z.object({
  due_at: z.string().min(1).max(64),
  id: uuidSchema,
}).strict();

/**
 * The LEGACY scheduled enqueue.
 *
 * It keeps its cursor and its limit. The accepted cursor-based caller is
 * preserved exactly, so no consumer of it is broken by the durable branch
 * below.
 */
const enqueueDailyRequestSchema = z.object({
  mode: z.literal("enqueue-daily"),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: cursorSchema.optional(),
}).strict();

/**
 * The DURABLE scheduled enqueue.
 *
 * It is a DISTINCT schema branch: it carries the dispatch marker and NO
 * cursor and NO limit. The durable mechanism keeps its progress in the
 * database, so a caller-selected cursor has nothing to select and a
 * caller-selected limit has nothing to bound.
 *
 * A mixed body - the durable marker with a cursor, or with a limit - is
 * refused by the strict schemas on both sides.
 */
const enqueueDailyDurableRequestSchema = z.object({
  mode: z.literal("enqueue-daily"),
  dispatch: z.literal("durable"),
}).strict();

const drainRequestSchema = z.object({
  mode: z.literal("all"),
}).strict();

/** The closed set of audit actions. Anything else is audited as "unknown". */
const AUDIT_MODES = ["entry", "force", "status", "enqueue-daily", "all"] as const;

/**
 * The strict request union.
 *
 * It is a plain union rather than a discriminated one because the
 * `enqueue-daily` mode has TWO branches: the legacy cursor-based one and
 * the durable one. The strict schemas keep them apart - a body with the
 * durable marker and a cursor matches NEITHER, and is refused.
 */
const competitorSyncRequestSchema = z.union([
  entryRequestSchema,
  forceRequestSchema,
  statusRequestSchema,
  enqueueDailyDurableRequestSchema,
  drainRequestSchema,
  enqueueDailyRequestSchema,
]);

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

export interface CompetitorSyncDeadline {
  workMs(): number;
  totalMs(): number;
}

function createDeadline(startedAt: number): CompetitorSyncDeadline {
  return {
    workMs: () =>
      COMPETITOR_SYNC_TOTAL_BUDGET_MS - COMPETITOR_SYNC_LOG_RESERVE_MS -
      (Date.now() - startedAt),
    totalMs: () => COMPETITOR_SYNC_TOTAL_BUDGET_MS - (Date.now() - startedAt),
  };
}

type BoundedOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "timeout" | "failed"; readonly error?: unknown };

/**
 * Runs one dependency inside a ceiling that is drawn from the REMAINING
 * budget.
 *
 * The losing promise is always settled, so a dependency that fails after
 * the caller gave up can never become an unhandled rejection and can never
 * be mistaken for a result.
 */
async function runBounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ceilingMs: number,
): Promise<BoundedOutcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ readonly ok: false; readonly reason: "timeout" }>(
    (resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "timeout" });
      }, Math.max(0, ceilingMs));
    },
  );

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

function dependencyCeiling(deadline: CompetitorSyncDeadline): number {
  return Math.min(COMPETITOR_SYNC_DEPENDENCY_CEILING_MS, deadline.workMs());
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

type BodyOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too_large" | "aborted" | "failed" };

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

  const onAbort = () => abandonReader(reader);
  signal.addEventListener("abort", onAbort, { once: true });
  const onCallerAbort = () => abandonReader(reader);
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
        abandonReader(reader);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }

    if (signal.aborted || request.signal.aborted) {
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
    signal.removeEventListener("abort", onCallerAbort);
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
// The identity
// ---------------------------------------------------------------------------

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

interface VerifiedOwner {
  readonly userId: string;
  readonly role: string;
}

/**
 * Validates the server-verified claim envelope.
 *
 * The envelope must be a plain record with an own `error` that is exactly
 * null, an own `data` with an own `claims`, and a `claims` object with an
 * own `sub` and an own `role`.
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
  if (!role.present || typeof role.value !== "string") return null;

  const sub = readOwnData(claims.value, "sub");
  if (!sub.present || typeof sub.value !== "string") return null;

  return { userId: sub.value, role: role.value };
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = BEARER_PATTERN.exec(header);
  if (!match) return null;
  const token = match[1]!;
  return token.length > 0 ? token : null;
}

/**
 * A constant-time comparison.
 *
 * The length is not secret and is compared first, which is the same
 * posture the shared cron helper uses.
 */
function timingSafeEqual(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The settings gates
// ---------------------------------------------------------------------------

/**
 * Refuses a settings envelope whose required values are not own data
 * properties.
 *
 * This runs BEFORE the shared lookup reads the envelope, because the shared
 * lookup uses ordinary property access and a getter on any of them would
 * be executed there.
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
  code: CompetitorSyncErrorCode,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonResponse(request, { error: code }, status, extraHeaders);
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export function createCompetitorSyncHandler(
  deps: CompetitorSyncDeps,
): (request: Request) => Promise<Response> {
  async function audit(
    deadline: CompetitorSyncDeadline,
    event: CompetitorSyncAuditEvent,
  ): Promise<void> {
    const budget = Math.min(COMPETITOR_SYNC_LOG_RESERVE_MS, deadline.totalMs());
    if (budget <= 0) return;
    await runBounded(() => deps.audit(event), budget);
  }

  return async function handleCompetitorSync(request: Request): Promise<Response> {
    const deadline = createDeadline(Date.now());

    const context: { action: string; userId?: string; watchlistId?: string } = {
      action: "unknown",
    };

    const auditEvent = (outcome: string, status: number): CompetitorSyncAuditEvent => ({
      action: context.action,
      outcome,
      status,
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.watchlistId ? { watchlistId: context.watchlistId } : {}),
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
      code: CompetitorSyncErrorCode,
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
      (signal) => readBoundedBody(request, COMPETITOR_SYNC_MAX_BODY_BYTES, signal),
      dependencyCeiling(deadline),
    );

    if (!bodyRead.ok) {
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

    // The mode is peeked before validation so a malformed request is still
    // attributed to the right action. It is never trusted for routing.
    const peeked = readOwnData(
      isPlainRecord(parsedJson) ? parsedJson : {},
      "mode",
    );
    // The audit action is a CLOSED literal: untrusted request text never
    // reaches the audit row.
    if (peeked.present && typeof peeked.value === "string" &&
      (AUDIT_MODES as readonly string[]).includes(peeked.value)) {
      context.action = peeked.value;
    }

    const validated = validateRequestBody(competitorSyncRequestSchema, parsedJson);
    if (!validated.success) {
      return await refuse(400, "invalid_request");
    }

    const input = validated.data;
    const isUserMode = input.mode === "entry" || input.mode === "force" ||
      input.mode === "status";
    context.action = input.mode;
    if (input.mode === "entry" || input.mode === "force" || input.mode === "status") {
      context.watchlistId = input.watchlist_id;
    }

    // --- The verified identity -----------------------------------------
    const token = readBearerToken(request);
    if (!token) {
      return await refuse(401, "unauthorized");
    }

    const cronSecret = deps.cronSecret();
    const serviceRoleKey = deps.serviceRoleKey();
    const isServiceCredential =
      (cronSecret !== null && timingSafeEqual(token, cronSecret)) ||
      (serviceRoleKey !== null && timingSafeEqual(token, serviceRoleKey));

    if (isUserMode && isServiceCredential) {
      // The service path never impersonates a user. The owner RPCs derive
      // the owner from auth.uid(), so an impersonation would have to be a
      // different, unsound contract.
      return await refuse(403, "forbidden");
    }

    if (!isUserMode && cronSecret === null && serviceRoleKey === null) {
      // Neither service credential is configured, so no service caller can
      // be authenticated at all. The deployment is misconfigured, and the
      // refusal says so instead of pretending the caller was merely
      // unauthorised.
      return await refuse(503, "service_auth_unavailable");
    }

    let owner: VerifiedOwner | null = null;

    if (!isServiceCredential) {
      const claimsOutcome = await runBounded(
        (signal) => deps.verifyClaims(token, signal),
        dependencyCeiling(deadline),
      );
      if (!claimsOutcome.ok) {
        // The verifier could not be reached or did not answer in time.
        return await refuse(503, "request_unavailable");
      }

      owner = parseVerifiedOwner(claimsOutcome.value);
      if (!owner) {
        return await refuse(401, "unauthorized");
      }

      if (isUserMode) {
        if (owner.role !== "authenticated") {
          return await refuse(403, "forbidden");
        }
        context.userId = owner.userId;
      } else {
        // A service mode needs an administrator, and an administrator is a
        // verified USER session. A claims object that says `service_role` is
        // not a user and is never upgraded into one; the direct service
        // credential is the separate branch above.
        if (owner.role !== "authenticated") {
          return await refuse(403, "forbidden");
        }
        const adminOutcome = await runBounded(
          () => deps.isAdmin(owner!.userId),
          dependencyCeiling(deadline),
        );
        // A failed, late or non-boolean answer is not an administrator.
        const admin = adminOutcome.ok && adminOutcome.value === true;
        if (!admin) {
          return await refuse(403, "forbidden");
        }
        context.userId = owner.userId;
      }
    }

    // --- The availability gates -----------------------------------------
    const readRequiredSetting = async (key: string): Promise<unknown> => {
      const outcome = await runBounded(
        () => deps.readSetting(key),
        dependencyCeiling(deadline),
      );
      if (!outcome.ok) throw new CredentialConfigurationError();

      assertSettingEnvelopeIsSafe(outcome.value);

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
      // provider.
      return await refuse(503, "collection_disabled");
    }

    try {
      // The mode is read for its validity, NOT as collection permission.
      // `legacy` and `protected` are both usable; the resolver has already
      // refused anything else as a malformed setting. The mode says WHERE a
      // Facebook User secret is read from; it does not say WHICH targets may
      // be collected for. That is the rollout policy, and the accepted SQL
      // decides it - per watchlist, per viewer and per request.
      resolveFacebookCredentialMode(
        await readRequiredSetting(FACEBOOK_CREDENTIAL_MODE_SETTING_KEY),
      );
    } catch {
      return await refuse(503, "settings_unavailable");
    }

    // --- The work -------------------------------------------------------
    if (isUserMode) {
      if (deadline.workMs() <= 0) {
        return await refuse(503, "request_unavailable");
      }

      let store: CompetitorOwnerStore;
      try {
        store = deps.createOwnerStore(token!);
      } catch {
        return await refuse(503, "request_unavailable");
      }

      if (input.mode === "status") {
        const outcome = await runBounded(
          (signal) =>
            store.readCompetitorStatus({
              watchlistId: input.watchlist_id,
              capturedOn: null,
              signal,
            }),
          dependencyCeiling(deadline),
        );

        if (!outcome.ok) {
          const failure = readStoreFailure(outcome.error);
          if (failure === "not_found") return await refuse(404, "not_found");
          if (failure === "forbidden") return await refuse(403, "forbidden");
          return await refuse(503, "status_unavailable");
        }

        // The client contract is the accepted RPC's own shape, so a client
        // that already reads the owner status needs no translation.
        const projection = outcome.value;
        return await finish(
          200,
          {
            target_kind: projection.targetKind,
            target_id: projection.targetId,
            captured_on: projection.capturedOn,
            status: projection.status,
            job_generation: projection.jobGeneration,
            attempts: projection.attempts,
            due_at: projection.dueAt,
            next_retry_at: projection.nextRetryAt,
            last_attempt_at: projection.lastAttemptAt,
            last_success_at: projection.lastSuccessAt,
            reason_code: projection.reasonCode,
            pending_operations: projection.pendingOperations,
          },
          "status_read",
        );
      }

      if (input.mode === "entry" || input.mode === "force") {
        const outcome = await runBounded(
          (signal) =>
            store.enqueueCompetitorJob({
              watchlistId: input.watchlist_id,
              mode: input.mode === "force" ? "force" : "normal",
              signal,
            }),
          dependencyCeiling(deadline),
        );

        if (!outcome.ok) {
          const failure = readStoreFailure(outcome.error);
          if (failure === "not_found") return await refuse(404, "not_found");
          if (failure === "forbidden") return await refuse(403, "forbidden");
          if (failure === "invalid") return await refuse(400, "invalid_request");
          // The statement may have committed. The outcome is indeterminate
          // and the enqueue is never replayed.
          return await refuse(503, "enqueue_indeterminate");
        }

        const receipt = outcome.value;
        if (receipt.kind === "refused") {
          // A DEFINITE rollout refusal. The watchlist entry IS owned by the
          // caller, and the policy simply does not admit it yet: 403. An
          // unavailable or disabled configuration is 503, and it is never
          // reported as a refusal of the caller's own entry.
          const reason = receipt.projection.reason_code;
          if (reason === "collection_not_eligible") {
            return await refuse(403, "collection_not_eligible");
          }
          if (reason === "collection_disabled") {
            return await refuse(503, "collection_disabled");
          }
          return await refuse(503, "settings_unavailable");
        }

        if (receipt.kind === "throttled") {
          const retryAfter = Math.max(
            1,
            Math.trunc(receipt.projection.retryAfterSeconds ?? 60),
          );
          return await finish(
            429,
            {
              accepted: false,
              reason: receipt.projection.reason,
              retry_after_seconds: retryAfter,
              captured_on: receipt.projection.capturedOn,
            },
            "throttled",
            { "Retry-After": String(retryAfter) },
          );
        }

        return await finish(
          202,
          {
            accepted: true,
            reason: receipt.projection.reason,
            job_id: receipt.projection.jobId,
            job_generation: receipt.projection.jobGeneration,
            status: receipt.projection.status,
            captured_on: receipt.projection.capturedOn,
          },
          "enqueued",
        );
      }

      return await refuse(503, "request_unavailable");
    }

    // --- The service modes ----------------------------------------------
    let worker: CompetitorWorkerPorts;
    try {
      worker = deps.createServiceWorker();
    } catch {
      return await refuse(503, "request_unavailable");
    }

    // The service work is NOT one dependency call: it is the bounded worker
    // run, which has its own per-step budget. It is given the remaining work
    // budget of this request (never more than the worker's own forty
    // seconds), so the five second dependency ceiling cannot cut every drain
    // off before its first provider call.
    const workBudgetMs = Math.min(WORKER_TOTAL_BUDGET_MS, deadline.workMs());
    const boundedWorker: CompetitorWorkerPorts = { ...worker, budgetMs: workBudgetMs };

    if (input.mode === "enqueue-daily") {
      // The DURABLE branch. It is a distinct schema branch and it never
      // falls back to the legacy cursor walk: the durable mechanism keeps
      // its progress in the database, and no cron depends on reading a
      // response cursor.
      if ("dispatch" in input) {
        const outcome = await runBounded(
          (signal) =>
            worker.store.enqueueDailyPage({ start: true, signal }),
          COMPETITOR_DAILY_DISPATCH_CEILING_MS,
        );

        if (!outcome.ok) {
          // The statement may have committed. The outcome is indeterminate
          // and the dispatch is never replayed in the same invocation.
          return await refuse(503, "work_indeterminate");
        }

        const page = outcome.value;

        if (page.kind === "refused") {
          if (page.reason === "collection_disabled") {
            return await refuse(503, "collection_disabled");
          }
          return await refuse(503, "settings_unavailable");
        }

        const receipt = page.receipt;

        // The closed set of the published response.
        if (receipt.sweepStatus !== "pending" && receipt.sweepStatus !== "completed") {
          return await refuse(503, "work_indeterminate");
        }

        const body = {
          mode: "enqueue-daily",
          dispatch: "durable",
          captured_on: receipt.capturedOn,
          sweep_status: receipt.sweepStatus,
          enqueued: receipt.enqueued,
          has_more: receipt.hasMore,
        };

        if (receipt.hasMore) {
          return await finish(202, body, "enqueued_daily");
        }

        return await finish(200, body, "enqueued_daily_completed");
      }

      // The LEGACY branch. Its cursor and its limit keep working exactly
      // as they did.
      const outcome = await runBounded(
        (signal) =>
          runEnqueue(boundedWorker, input.limit ?? 50, input.cursor ?? null, signal),
        workBudgetMs,
      );

      if (!outcome.ok) {
        return await refuse(503, "work_indeterminate");
      }

      return await finish(200, outcome.value, "enqueued_daily");
    }

    const outcome = await runBounded(
      (signal) => runDrain(boundedWorker, signal),
      workBudgetMs,
    );

    if (!outcome.ok) {
      return await refuse(503, "work_indeterminate");
    }

    return await finish(200, outcome.value, "drained");
  };
}

/** Runs the scheduled enqueue through the worker module. */
async function runEnqueue(
  worker: CompetitorWorkerPorts,
  limit: number,
  cursor: { readonly due_at: string; readonly id: string } | null,
  signal: AbortSignal,
): Promise<unknown> {
  return await runCompetitorEnqueue(worker, {
    limit,
    cursor: cursor ? { dueAt: cursor.due_at, id: cursor.id } : null,
    signal,
  });
}

/** Runs the bounded drain through the worker module. */
async function runDrain(worker: CompetitorWorkerPorts, signal: AbortSignal): Promise<unknown> {
  return await runCompetitorDrain(worker, { signal });
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
