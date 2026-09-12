// The authenticated /v1 pipeline (deliverable 3.5).
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// ---------------------------------------------
// Phase 2 shipped /v1 with NO authentication: the router was handed a
// `refusingClient()` that throws if /v1 touches Supabase at all. That was not
// an omission, it was the non-enumerability property — an unmatched path 404s
// without a database call, so a probe learns nothing about what exists.
//
// **That property survives here.** Authentication attaches to a MATCHED
// ROUTE, never above routing. `handleV1Request` still resolves the path
// first; only then does a route's handler reach for a client. Moving auth
// above routing would make an unmatched path observably different for a
// valid key, which is exactly what v1/router.test.ts asserts against.
//
// This module composes the SAME shared modules the alias composes, in the
// SAME order, rather than re-deriving any of their logic:
//
//     scope -> suspension -> account -> idempotency -> quota
//
// The order is a contract, not an implementation detail. Scope precedes
// suspension so a key lacking the scope still gets `insufficient_scope`
// rather than `temporarily_unavailable`: a partner must be able to tell
// "you may never do this with this key" from "nobody may do this yet". The
// first needs a new grant; the second needs waiting. Collapse them and a
// partner debugging a 503 goes looking for an outage.
//
// The alias keeps its own composition, untouched. Convergence under D1 means
// a shared implementation UNDERNEATH — these modules — not a shared response
// shape: the alias answers `{success:false, error:{…}, request_id}` and /v1
// answers `{error:{…, request_id}}`, deliberately (D2).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  authenticatePartnerKey,
  assertActionAuthorized,
  PartnerAuthError,
  type PartnerKeyRecord,
} from "../../_shared/partnerApiKeys.ts";
import {
  checkRateLimit,
  RateLimitedError,
  recordUsage,
  type LimiterRiskClass,
  type UsageInput,
} from "../../_shared/partnerApiMetering.ts";
import { QUOTA_RESERVING_ACTIONS, satisfyingScopesFor } from "../router.ts";
import { v1ErrorResponse } from "./errors.ts";
import type { WhatsAppOpsContext } from "../../_shared/whatsappPartnerOps.ts";

/** Everything a /v1 route needs once the caller is known and allowed. */
export interface V1AuthedContext {
  // deno-lint-ignore no-explicit-any
  admin: any;
  record: PartnerKeyRecord;
  requestId: string;
  /** Rate-limit headers for the resolved budget; stamp them on the response. */
  rateHeaders: Record<string, string>;
}

export type V1AuthedHandler = (
  req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
) => Promise<Response>;

// deno-lint-ignore no-explicit-any
export type AdminFactory = () => any;

const defaultAdminFactory: AdminFactory = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

/**
 * Wrap a route handler with authentication, the action's scope check, and the
 * limiter.
 *
 * `action` is the ALIAS action name whose policy this route inherits, so the
 * two surfaces cannot drift into different scope or risk-class answers for the
 * same capability. That is D1 convergence in practice: one policy table
 * (`ACTION_SCOPES` / `ACTION_RISK_CLASSES` in router.ts), two doors.
 */
export function withPartnerAuth(
  action: string,
  riskClass: LimiterRiskClass,
  handler: V1AuthedHandler,
  adminFactory: AdminFactory = defaultAdminFactory,
) {
  return async (
    req: Request,
    requestId: string,
    params: Record<string, string>,
    // deno-lint-ignore no-explicit-any
    doorFactory?: () => any,
  ): Promise<Response> => {
    const startedAt = performance.now();
    // The door's factory wins when it supplies one: /v1 and the alias then
    // share a client, and a test can stub the Supabase boundary for both.
    const admin = (doorFactory ?? adminFactory)();
    let record: PartnerKeyRecord | undefined;

    // Every response produced once the key is known leaves one usage row
    // behind it (10.1). Written AFTER the response exists and never able to
    // alter it: recordUsage swallows its own errors, and the edge runtime
    // offers no background task to defer this to, so it is awaited on the
    // way out. A failure before the key resolved has nothing to attribute
    // and writes nothing — that is the non-enumerability rule, not a gap.
    const ledgered = async (res: Response): Promise<Response> => {
      if (record) {
        await recordUsage(admin, await usageRowFor(record, action, res, { requestId, startedAt }));
      }
      return res;
    };

    try {
      // x-postora-key ONLY. The published contract states it outright:
      // "NOT `Authorization: Bearer` -- that header is never read by the
      // alias and does not exist as a key transport", and adding it requires
      // updating Access-Control-Allow-Headers and re-checking
      // docs/decisions/2026-08-30-partner-api-cors.md.
      //
      // Reading Authorization here would also be actively unsafe: this
      // function runs behind a gateway that can attach its own Authorization
      // header, so preferring it would make every existing workspace call
      // authenticate against the wrong value.
      const presented = req.headers.get("x-postora-key") ?? "";

      // Wrong tier: a platform credential must not learn that the workspace
      // door rejected it as a KEY -- it learns nothing at all. A platform key
      // sent as Bearer simply presents no credential here and gets the
      // ordinary 401, which leaks nothing either.
      if (presented.startsWith("pl_")) {
        console.warn(`[partner-api] wrong-tier credential at workspace door (request ${requestId})`);
        return ledgered(v1ErrorResponse("resource_not_found", requestId));
      }

      record = await authenticatePartnerKey(admin, presented);

      const satisfying = satisfyingScopesFor(action);
      if (satisfying === undefined) {
        // An action this door offers but the policy table does not know is a
        // programming error, not a partner error — fail closed and loudly.
        console.error(`[partner-api] v1 route declares unknown action "${action}"`);
        return ledgered(v1ErrorResponse("internal_error", requestId));
      }
      if (satisfying !== null) assertActionAuthorized(record, action, satisfying);
    } catch (err) {
      return ledgered(authErrorToResponse(err, requestId));
    }

    // The limiter runs AFTER authorization: an unauthorized caller must not
    // learn a key's budget, and must not consume one.
    let rateHeaders: Record<string, string> = {};
    try {
      const decision = await checkRateLimit(admin, record, riskClass);
      if (decision.status === "resolved") {
        rateHeaders = {
          "X-RateLimit-Limit": String(record.rateLimitPerMin),
          "X-RateLimit-Remaining": String(decision.remaining),
          "X-RateLimit-Reset": String(decision.resetSeconds),
        };
      }
    } catch (err) {
      if (err instanceof RateLimitedError) {
        // The refusal itself proves nothing remains in the window, so
        // Remaining is 0 without an RPC number; Reset and Retry-After only
        // when the limiter computed one — the same rule the alias applies.
        return ledgered(v1ErrorResponse("rate_limited", requestId, {
          headers: {
            "X-RateLimit-Limit": String(record.rateLimitPerMin),
            "X-RateLimit-Remaining": "0",
            ...(err.resetSeconds !== null
              ? { "X-RateLimit-Reset": String(err.resetSeconds), "Retry-After": String(err.resetSeconds) }
              : {}),
          },
        }));
      }
      return ledgered(authErrorToResponse(err, requestId));
    }

    let res: Response;
    try {
      res = await handler(req, { admin, record, requestId, rateHeaders }, params);
    } catch (err) {
      // Caught here rather than left to the /v1 dispatcher's catch so the
      // 500 is attributed to the key in the ledger like every other outcome.
      console.error(`[partner-api] v1 handler error (request ${requestId}, ${action}):`, err);
      res = v1ErrorResponse("internal_error", requestId);
    }
    // A handler that built its own response still gets the budget headers,
    // so every post-limiter /v1 response carries them exactly once.
    for (const [k, v] of Object.entries(rateHeaders)) {
      if (!res.headers.has(k)) res.headers.set(k, v);
    }
    return ledgered(res);
  };
}

/** What the ledger needs about the request itself, as opposed to the key or
 *  the response: the id the response carried and when the handler was entered. */
interface RequestTiming {
  requestId: string;
  startedAt: number;
}

async function usageRowFor(
  record: PartnerKeyRecord,
  action: string,
  res: Response,
  timing: RequestTiming,
): Promise<UsageInput> {
  // A replay is the stored verdict handed back: no reservation, no provider
  // call, nothing to bill again. The handler already says so on the wire
  // (Idempotency-Replayed), and that header is the signal here — one fact,
  // read where it is emitted, rather than a second flag to keep in step.
  const replayed = res.headers.get("Idempotency-Replayed") === "true";
  return {
    keyId: record.id,
    workspaceId: record.workspaceId,
    action,
    billable: QUOTA_RESERVING_ACTIONS.has(action) && res.status < 300 && !replayed,
    httpStatus: res.status,
    errorCode: res.status >= 400 ? await errorCodeOf(res) : undefined,
    requestId: timing.requestId,
    latencyMs: performance.now() - timing.startedAt,
  };
}

/** The typed code from a v1 error envelope; undefined for a body that is not one. */
async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    const body = await res.clone().json() as { error?: { code?: unknown } };
    return typeof body?.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Translate the shared modules' typed errors into the /v1 envelope.
 *
 * `RateLimitedError` is checked FIRST because it extends `PartnerAuthError`;
 * an `instanceof` ladder in the other order would answer every 429 as a
 * generic auth failure.
 */
function authErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof RateLimitedError) {
    return v1ErrorResponse("rate_limited", requestId, {
      headers: err.resetSeconds !== null
        ? { "Retry-After": String(err.resetSeconds) }
        : {},
    });
  }
  if (err instanceof PartnerAuthError) {
    // The code is already the typed, partner-safe one the alias emits; the
    // policy table owns its status and retry verdict so the two surfaces
    // cannot disagree about the same condition.
    return v1ErrorResponse(err.code as never, requestId);
  }
  console.error(`[partner-api] v1 auth pipeline error (request ${requestId}):`, err);
  return v1ErrorResponse("internal_error", requestId);
}

/**
 * Resolve the WhatsApp account a key is pinned to, with the same preflight the
 * alias applies: the composite FK proves the account is in the workspace, it
 * does NOT prove the account is WhatsApp or healthy.
 */
export async function resolveWhatsAppAccount(
  authed: V1AuthedContext,
  accountId?: string,
): Promise<
  | { ok: true; ctx: WhatsAppOpsContext; wabaId: string | null }
  | { ok: false; res: Response }
> {
  const { admin, record, requestId } = authed;
  // Explicit targets must be bound BEFORE querying the account. Composite FKs
  // prove workspace ownership; legacy callers keep their pinned-account path.
  if (accountId !== undefined) {
    const { data: binding, error } = await admin.from("partner_api_key_accounts")
      .select("social_account_id").eq("key_id", record.id)
      .eq("workspace_id", record.workspaceId).eq("social_account_id", accountId).maybeSingle();
    if (error) return { ok: false, res: v1ErrorResponse("internal_error", requestId) };
    if (!binding) return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }
  const { data: account, error } = await admin
    .from("social_accounts")
    .select(
      "id, user_id, workspace_id, platform, platform_user_id, access_token, " +
        "connection_mode, is_active, needs_reauth, token_expires_at, account_metadata",
    )
    .eq("id", accountId ?? record.socialAccountId)
    .eq("workspace_id", record.workspaceId)
    .maybeSingle();

  if (error) return { ok: false, res: v1ErrorResponse("internal_error", requestId) };

  if (!account || account.platform !== "whatsapp" || !account.is_active) {
    return { ok: false, res: v1ErrorResponse("account_not_connected", requestId) };
  }

  const tokenExpired = account.token_expires_at &&
    new Date(account.token_expires_at) <= new Date();
  if (account.needs_reauth || tokenExpired) {
    return { ok: false, res: v1ErrorResponse("account_needs_reauth", requestId) };
  }

  // Recorded at connection time, not derivable from the account row. Routes
  // that need it check for null themselves -- the ALIAS answers
  // `account_not_connected` when it is missing, and /v1 must agree.
  const wabaId = (account.account_metadata as Record<string, unknown> | null)?.waba_id;

  return {
    ok: true,
    wabaId: wabaId ? String(wabaId) : null,
    ctx: {
      admin,
      accountId: account.id,
      ownerId: account.user_id,
      workspaceId: account.workspace_id,
      phoneNumberId: account.platform_user_id,
      accessToken: account.access_token,
      connectionMode: account.connection_mode,
    },
  };
}
