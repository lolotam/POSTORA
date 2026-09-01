// Partner API — machine-authenticated door into WhatsApp sending.
//
// This function authenticates and authorizes; all WhatsApp behaviour lives in
// _shared/whatsappPartnerOps.ts, which the JWT door also calls.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertActionAuthorized,
  authenticatePartnerKey,
  PartnerAuthError,
  type PartnerKeyRecord,
} from "../_shared/partnerApiKeys.ts";
import {
  checkRateLimit,
  RateLimitedError,
  recordUsage,
  releaseQuota,
  reserveQuota,
  touchKey,
  type RateLimitBudget,
} from "../_shared/partnerApiMetering.ts";
import {
  claimIdempotency,
  completeIdempotency,
  hashRequest,
  markIndeterminate,
} from "../_shared/partnerApiIdempotency.ts";
import {
  listTemplates,
  sendTemplate,
  WhatsAppOpError,
} from "../_shared/whatsappPartnerOps.ts";
import { isActionSuspended, isSendAction, limiterRiskClassFor, satisfyingScopesFor } from "./router.ts";
import { handleV1Request, v1SubpathOf } from "./v1/router.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-postora-key, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Without this a browser caller cannot read the correlation handle the API
  // documents, nor tell a replay from a fresh send, nor see the rate budget
  // the limiter resolved for the key.
  "Access-Control-Expose-Headers": "x-postora-request-id, idempotency-replayed, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

function errorBody(code: string, message: string, retryable: boolean, details?: unknown) {
  return { success: false, error: { code, message, retryable, ...(details ? { details } : {}) } };
}

/**
 * Every response carries a request id, success or failure.
 *
 * Without one a partner reporting "the 09:14 send failed" gives us nothing to
 * grep for: the partner key is hashed, message bodies are never logged, and a
 * failed send has no Meta message id. This is the only correlation handle
 * between their logs and ours, and the spec requires it in the normalized
 * response.
 */
function withRequestId<T extends Record<string, unknown>>(
  body: T,
  requestId: string,
): T & { request_id: string } {
  return { ...body, request_id: requestId };
}

/**
 * X-RateLimit-* headers for responses whose rate budget the limiter actually
 * resolved. Emitted ONLY there: fabricating budget numbers for a response
 * where no limit was resolved would leak whether a key exists.
 *
 * Every number comes from consume_partner_rate_v2: Remaining is the count the
 * bucket reported after this request, and Reset is the seconds-until-window-
 * end Postgres computed from the same date_trunc('minute', now()) bucket it
 * incremented — never a local clock, which can disagree with the clock that
 * picked the bucket. The values describe the window that was consumed; by the
 * time the client reads them that window may already have rolled over, which
 * is inherent to any per-minute budget header.
 */
function rateLimitHeadersFor(budget: RateLimitBudget): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(budget.limit),
    "X-RateLimit-Remaining": String(budget.remaining),
    "X-RateLimit-Reset": String(budget.resetSeconds),
  };
}

/**
 * Headers for the 429 the limiter itself issued. Remaining 0 needs no RPC
 * number: the refusal proves no requests are left in the window. Reset and
 * Retry-After both carry the same database-provided seconds-until-window-end
 * — one derived value, not a second computation — and are omitted, never
 * guessed, if the limiter's answer drifted and brought no number.
 */
function rateLimitedHeadersFor(
  record: PartnerKeyRecord,
  resetSeconds: number | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(record.rateLimitPerMin),
    "X-RateLimit-Remaining": "0",
  };
  if (resetSeconds !== null) {
    headers["X-RateLimit-Reset"] = String(resetSeconds);
    headers["Retry-After"] = String(resetSeconds);
  }
  return headers;
}

/**
 * How long a class-B/C caller is told to wait out a limiter outage.
 *
 * Not 1 second. A limiter outage means the database backing the bucket is
 * already struggling, and every refused partner is a client in a retry loop:
 * telling all of them to come back in one second turns one outage into a
 * thundering herd against the thing that is down. This codebase has already
 * paid for that lesson once, when a mark-read loop reached ~100 req/s per open
 * tab. Long enough to let the limiter recover, short enough that a healthy
 * partner barely notices.
 */
const LIMITER_OUTAGE_RETRY_AFTER_SECONDS = "5";

/**
 * The request handler, exported so tests exercise the real production path
 * (index.ts binds its port via Deno.serve only when run as the main module,
 * keeping this import side-effect free — the n8n-api pattern).
 *
 * The admin client is a parameter so tests can stub the Supabase boundary —
 * the only thing stubbed — without env vars or a live database.
 */
export async function handleRequest(
  req: Request,
  // deno-lint-ignore no-explicit-any
  createAdminClient: () => any = () =>
    createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    ),
): Promise<Response> {
  // Declared first: every exit path below stamps it, including the ones that
  // run before a key is authenticated. `const` is not hoisted, so declaring it
  // later would make the method-not-allowed branch a ReferenceError.
  const requestId = crypto.randomUUID();

  // The /v1 door (deliverable 2.1). A request whose path is under /v1 —
  // relative to this function's mount — is served by the v1 router; everything
  // else keeps the alias behaviour below, unchanged. Checked BEFORE the
  // OPTIONS preflight so a /v1 preflight is not answered with the alias's
  // CORS headers: the recorded CORS decision
  // (docs/decisions/2026-08-30-partner-api-cors.md, 2026-08-31 correction 2)
  // covers the alias only, and /v1 makes no Access-Control-* claims until its
  // own decision is recorded.
  const v1Path = v1SubpathOf(req.url);
  if (v1Path !== null) return handleV1Request(req, v1Path, requestId);

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") {
    // Before authentication, so there is no key to bill and no ledger row -
    // but the caller still gets a correlatable id.
    return json(withRequestId(errorBody("method_not_allowed", "Use POST", false), requestId),
                405, { "X-Postora-Request-Id": requestId });
  }

  const admin = createAdminClient();

  let record: PartnerKeyRecord | null = null;
  let action = "unknown";
  let idempotencyKey: string | null = null;
  // Empty until the limiter resolves this key's budget; finish() stamps it on
  // every response after that point. Responses before the limiter ran, and
  // responses where the limiter was unavailable, must carry no budget numbers.
  let rateHeaders: Record<string, string> = {};

  // Bound once so every exit path stamps the request id automatically. The
  // alternative - adding a trailing argument at each call site - is how
  // touchKey ended up implemented but never called.
  const finish = (
    status: number,
    billable: boolean,
    body: unknown,
    extraHeaders: Record<string, string> = {},
    errorCode?: string,
  ) => respond(admin, record!, action, status, billable, body,
               { ...extraHeaders, ...rateHeaders }, errorCode, requestId);

  try {
    record = await authenticatePartnerKey(admin, req.headers.get("x-postora-key") ?? "");

    const body = await req.json().catch(() => ({}));
    action = String(body.action ?? "");

    const satisfying = satisfyingScopesFor(action);
    if (satisfying === undefined) {
      return await finish(400, false,
        errorBody("unknown_action", `Unknown action: ${action}`, false), {}, "unknown_action");
    }
    if (satisfying !== null) assertActionAuthorized(record, action, satisfying);

    // ---- 0A safety suspension (send_template) ----
    // Deliberately AFTER the scope check: a key lacking whatsapp:template.send
    // must still get insufficient_scope — the suspension withdraws a
    // capability, it is not an authorization bypass. And deliberately BEFORE
    // the rate limiter, the account lookup, the idempotency claim, the quota
    // reservation, and any provider work: an action that can never succeed
    // must consume no rate budget, no monthly quota, no idempotency key, and
    // must poison nothing. Restoration gate: see SEND_TEMPLATE_SUSPENDED in
    // router.ts.
    //
    // Status 503, chosen deliberately: this is a temporarily withdrawn
    // server-side capability — not the caller's fault (so not a 4xx), not a
    // missing route (404 would claim the action does not exist — a contract
    // break), and not a bug (a bare 500 would invite blind retries). 503
    // normally implies "retry later", so the body's retryable:false carries
    // the binding verdict — same pairing as quota_exceeded (429,
    // retryable:false): the typed flag, not the status family, is what a
    // partner's retry logic must obey. No Retry-After is sent because
    // restoration is gated on an engineering milestone (the Phase 3 D13 gate),
    // not on a duration — any number here would promise a schedule nobody
    // can state.
    if (isActionSuspended(action)) {
      return await finish(
        503, false,
        errorBody("temporarily_unavailable",
          "This action is temporarily suspended; see the Partner API changelog. Retrying will not succeed until it is re-enabled",
          false),
        {}, "temporarily_unavailable",
      );
    }

    // An action missing from ACTION_RISK_CLASSES resolves undefined here and
    // fails CLOSED on limiter failure — never fail-open by omission (D7).
    const limiter = await checkRateLimit(admin, record, limiterRiskClassFor(action));
    // X-RateLimit-* only when the limiter actually resolved this key's
    // budget, with the numbers it reported: a class-A request that proceeded
    // through a limiter outage resolved nothing, so it must report no budget
    // rather than an invented one. Fail-closed requests threw above and never
    // reach here.
    if (limiter.status === "resolved") rateHeaders = rateLimitHeadersFor(limiter);

    // Resolve the key's pinned account. The composite FK already guarantees it
    // belongs to this workspace, so this read cannot cross a tenant boundary.
    const { data: account, error: accountError } = await admin
      .from("social_accounts")
      // One string literal, not a concatenation: supabase-js resolves the
      // column list at the TYPE level, and a non-literal collapses the row
      // type to GenericStringError.
      .select("id, user_id, workspace_id, platform, platform_user_id, access_token, connection_mode, is_active, needs_reauth, token_expires_at, account_metadata")
      .eq("id", record.socialAccountId)
      .maybeSingle();

    // A database error is not "not connected" — do not disguise one as the other.
    if (accountError) {
      return await finish(
        500, false,
        errorBody("internal_error", "Could not resolve the account", true),
        {}, "internal_error",
      );
    }

    // The composite FK proves the account is in this workspace. It does NOT
    // prove the account is WhatsApp — a mis-created key could pin a Facebook
    // page, so check platform explicitly, as the human resolver does
    // (_shared/whatsappWorkspaceAccess.ts:124-136).
    if (!account || account.platform !== "whatsapp" || !account.is_active) {
      return await finish(
        409, false,
        errorBody("account_not_connected", "The WhatsApp account is not connected", false),
        {}, "account_not_connected",
      );
    }

    // Spec §9: preflight health, so a partner gets a typed, actionable error
    // instead of a raw Meta rejection. refresh-tokens has no WhatsApp path,
    // so an expired token stays expired until someone reconnects.
    const tokenExpired = account.token_expires_at &&
      new Date(account.token_expires_at) <= new Date();
    if (account.needs_reauth || tokenExpired) {
      return await finish(
        401, false,
        errorBody("account_needs_reauth",
          "The WhatsApp connection needs to be re-authorized in Postora", false),
        {}, "account_needs_reauth",
      );
    }

    const ctx = {
      admin,
      accountId: account.id,
      ownerId: account.user_id,
      workspaceId: account.workspace_id,
      phoneNumberId: account.platform_user_id,
      accessToken: account.access_token,
      connectionMode: account.connection_mode,
    };

    if (action === "get_status") {
      await touchKey(admin, record);
      return await finish(200, false, {
        success: true,
        whatsapp_connected: true,
        phone_number_id: account.platform_user_id,
        workspace_id: account.workspace_id,
      });
    }

    if (action === "list_templates") {
      const wabaId = (account.account_metadata as Record<string, unknown> | null)?.waba_id;
      if (!wabaId) {
        return await finish(
          409, false,
          errorBody("account_not_connected", "No WABA id recorded for this account", false),
        );
      }
      const templates = await listTemplates(ctx, String(wabaId));
      await touchKey(admin, record);
      return await finish(200, false, { success: true, templates });
    }

    // ---- send_template ----
    idempotencyKey = req.headers.get("idempotency-key");
    if (isSendAction(action) && !idempotencyKey) {
      return await finish(
        400, false,
        errorBody("missing_idempotency_key", "Idempotency-Key header is required for sends", false),
      );
    }

    // Validate BEFORE claiming. Claiming first would leave an invalid request
    // stuck in `processing` forever, poisoning that idempotency key.
    if (!body.recipient_phone || !body.template_name) {
      return await finish(
        400, false,
        errorBody("invalid_request", "recipient_phone and template_name are required", false),
      );
    }

    const requestHash = await hashRequest({
      action,
      recipient_phone: body.recipient_phone,
      template_name: body.template_name,
      template_language: body.template_language,
      template_components: body.template_components ?? null,
    });

    const claim = await claimIdempotency(admin, record.id, idempotencyKey!, requestHash);
    // Held for the rest of the request; every settle is fenced on it.
    const attemptToken = claim.outcome === "claimed" ? claim.attemptToken : "";

    if (claim.outcome === "replay") {
      // A replay must not consume quota, but it IS still a request the partner
      // made: recording it non-billable keeps the ledger able to reconstruct
      // retry activity. Not consuming quota and not being recorded are two
      // different things.
      return await finish(
        claim.httpStatus, false, claim.body,
        { "Idempotency-Replayed": "true" },
      );
    }
    if (claim.outcome === "conflict") {
      return await finish(
        409, false,
        errorBody("idempotency_conflict", "This Idempotency-Key was used with a different body", false),
      );
    }
    if (claim.outcome === "in_progress") {
      return await finish(
        409, false,
        errorBody("idempotency_in_progress", "An identical request is still processing", true),
        { "Retry-After": "2" },
      );
    }
    if (claim.outcome === "indeterminate") {
      return await finish(
        409, false,
        errorBody("idempotency_indeterminate",
          "A previous attempt may have been delivered; resolve it before retrying", false),
      );
    }

    // Reserve quota only once we are actually about to send. On any definite
    // rejection below we release it, so a partner is charged only for messages
    // Meta accepted. On an indeterminate outcome we deliberately do NOT
    // release: the message may have been delivered.
    const reserved = await reserveQuota(admin, record);
    if (!reserved) {
      // reserve_partner_quota increments before it reports, so a refused
      // attempt must give its unit back. Otherwise every rejected call pushes
      // current_usage_count further past the quota and the number stops
      // meaning anything for reporting.
      await releaseQuota(admin, record);
      // Settle the idempotency claim before returning, or a retry of this same
      // request would see `processing` forever instead of a clear quota error.
      const body = errorBody("quota_exceeded", "Monthly quota exhausted for this key", false);
      await completeIdempotency(admin, record.id, idempotencyKey!, attemptToken, 429, body)
        .catch((e) => console.error("[partner-api] settle after quota refusal failed:", e));
      return await finish(429, false, body, {}, "quota_exceeded");
    }

    try {
      const result = await sendTemplate(ctx, {
        recipientPhone: String(body.recipient_phone),
        templateName: String(body.template_name),
        templateLanguage: String(body.template_language ?? "en_US"),
        components: body.template_components,
      });

      const success = {
        success: true,
        message_id: result.messageId,
        state: "accepted_by_meta",
        recorded_in_inbox: result.persisted,
      };

      // Meta has ACCEPTED the message at this point — the customer may already
      // have it. A bookkeeping failure here must never be reported as a failed
      // or indeterminate send, or the partner will show a delivered message as
      // undelivered. But the claim still has to be settled somehow: if the row
      // stays `processing`, its lease expires, and the partner's retry would
      // take it over and send a SECOND message to a real customer.
      try {
        await completeIdempotency(admin, record.id, idempotencyKey!, attemptToken, 200, success);
      } catch (settleError) {
        console.error("[partner-api] settle failed after a successful send:", settleError);
        // Best effort, and deliberately not awaited into the failure path:
        // `indeterminate` is the one state no retry will ever re-send from,
        // which is exactly the protection needed here.
        await markIndeterminate(admin, record.id, idempotencyKey!, attemptToken).catch(() => {});
      }

      return await finish(200, true, success);
    } catch (err) {
      // A network failure after the request left leaves us unable to know
      // whether Meta delivered it. Never auto-retry, and never release the
      // quota reservation — the message may well have been sent.
      if (!(err instanceof WhatsAppOpError)) {
        await markIndeterminate(admin, record.id, idempotencyKey!, attemptToken);
        const body = errorBody("idempotency_indeterminate",
          "The send may have been delivered; resolve it before retrying", false);
        return await finish(409, false, body, {},
          "idempotency_indeterminate");
      }
      // Only a DEFINITE rejection may be refunded and settled as a failure.
      // An indeterminate one (5xx, missing message id) may already have
      // reached the customer, so it keeps its quota unit and becomes
      // non-resendable — the same treatment as a transport failure.
      if (err.indeterminate) {
        await markIndeterminate(admin, record.id, idempotencyKey!, attemptToken)
          .catch((e) => console.error("[partner-api] indeterminate mark failed:", e));
        const body = errorBody("idempotency_indeterminate",
          "The send may have been delivered; resolve it before retrying", false,
          err.metaCode ? { meta_code: err.metaCode } : undefined);
        return await finish(409, false, body, {},
          "idempotency_indeterminate");
      }
      await releaseQuota(admin, record);
      const failure = errorBody(err.code, err.message, false,
        err.metaCode ? { meta_code: err.metaCode } : undefined);
      // Settling must not turn a clean rejection into a generic 500.
      await completeIdempotency(admin, record.id, idempotencyKey!, attemptToken, err.status, failure)
        .catch((e) => console.error("[partner-api] settle after rejection failed:", e));
      return await finish(err.status, false, failure, {}, err.code);
    }
  } catch (err) {
    // listTemplates and the account lookups can also throw WhatsAppOpError.
    // Without this branch a token failure while listing templates would be
    // reported as a generic internal_error instead of account_needs_reauth.
    if (err instanceof WhatsAppOpError) {
      const body = errorBody(err.code, err.message, err.status >= 500,
        err.metaCode ? { meta_code: err.metaCode } : undefined);
      if (record) return await finish(err.status, false, body, {}, err.code);
      return json(withRequestId(body, requestId), err.status,
                  { "X-Postora-Request-Id": requestId });
    }
    if (err instanceof PartnerAuthError) {
      // The two limiter verdicts are the only retryable auth-path errors.
      const retryable = err.code === "rate_limited" || err.code === "limiter_unavailable";
      const body = errorBody(err.code, err.message, retryable);
      if (record) {
        // rate_limited: the limiter DID run and refused, so the budget is
        // real — Remaining 0 is proven by the refusal itself, and Reset and
        // Retry-After carry the database-provided seconds until the window
        // that refused this call ends (omitted, not invented, if the RPC
        // drifted and brought no number). limiter_unavailable: no budget was
        // resolved, so all three are omitted and Retry-After points at the
        // retry instead.
        const headers = err.code === "rate_limited"
          ? rateLimitedHeadersFor(
              record,
              err instanceof RateLimitedError ? err.resetSeconds : null,
            )
          : err.code === "limiter_unavailable"
          ? { "Retry-After": LIMITER_OUTAGE_RETRY_AFTER_SECONDS }
          : {};
        return await finish(err.status, false, body, headers, err.code);
      }
      // No key resolved yet, so there is no ledger row to write - but the
      // caller still gets a correlatable id.
      return json(withRequestId(body, requestId), err.status,
                  { "X-Postora-Request-Id": requestId });
    }
    console.error(`[partner-api] unhandled (request ${requestId}, key ${record?.keyPrefix ?? "none"}):`, err);
    const body = errorBody("internal_error", "Unexpected error", true);
    if (record) return await finish(500, false, body, {}, "internal_error");
    return json(withRequestId(body, requestId), 500,
                { "X-Postora-Request-Id": requestId });
  }
}

if (import.meta.main) {
  // Wrapped so Deno.serve's connection-info second argument can never be
  // mistaken for handleRequest's client-factory parameter.
  Deno.serve((req) => handleRequest(req));
}

/** Emit the response, stamp it with the request id, and append exactly one
 *  usage-ledger row for it. */
async function respond(
  // deno-lint-ignore no-explicit-any
  admin: any,
  record: PartnerKeyRecord,
  action: string,
  status: number,
  billable: boolean,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  errorCode?: string,
  requestId?: string,
) {
  await recordUsage(admin, {
    keyId: record.id,
    workspaceId: record.workspaceId,
    action,
    billable,
    httpStatus: status,
    errorCode,
  });
  const stamped = requestId && body && typeof body === "object"
    ? withRequestId(body as Record<string, unknown>, requestId)
    : body;
  // Also a header, so a partner can correlate without parsing the body -
  // which matters for the 5xx paths where the body may not be ours.
  return json(stamped, status, {
    ...extraHeaders,
    ...(requestId ? { "X-Postora-Request-Id": requestId } : {}),
  });
}
