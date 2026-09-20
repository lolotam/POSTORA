// /v1 error envelope — spec decision D2. THE single place every /v1 error
// response is built. A second construction site is how the alias envelope and
// the v1 envelope drift into each other, which D2 explicitly forbids:
//
//   alias (frozen): {success:false, error:{code,message,retryable,details?}, request_id}
//   v1 (this file): {error:{code,message,retryable,request_id,details?}}
//
// request_id sits at the TOP level on the alias and INSIDE error on v1. Do not
// unify them, and do not "fix" the alias.
//
// Every code's HTTP status and retryable verdict is pinned here in
// V1_ERROR_POLICY, agreed with the alias's behaviour for the same condition
// (index.ts, _shared/partnerApiKeys.ts, partnerApiMetering.ts,
// whatsappPartnerOps.ts): a condition that is retryable on one surface and not
// the other would tell partners two different things about the same failure.
// The typed flag — not the HTTP status family — is the retry verdict
// (temporarily_unavailable is 503 with retryable:false; limiter_unavailable is
// 503 with retryable:true).

interface V1ErrorPolicyEntry {
  /** Default HTTP status; overridable where the alias itself varies (e.g.
   *  account_needs_reauth is 401 from the preflight and 409 from Meta's
   *  two-step-registration subcode). */
  status: number;
  /** Whether the caller should retry with backoff. */
  retryable: boolean;
  /** Partner-safe default message: never a database error string, a stack, or
   *  an internal identifier. A call site may supply a richer message via
   *  options when the alias does the same. */
  message: string;
}

export const V1_ERROR_POLICY = {
  account_needs_reauth: {
    status: 401, retryable: false,
    message: "The WhatsApp connection needs to be re-authorized in Postora",
  },
  account_not_connected: {
    status: 409, retryable: false,
    message: "The WhatsApp account is not connected",
  },
  // --- Hybrid connectors (spec §8.3). Every message below names the
  // condition in Postora's own vocabulary: no vendor name, no vendor status,
  // no connection id — spec §11 forbids all three on a partner-facing reply,
  // and a partner branches on the `code` anyway.
  //
  // The connection exists but cannot serve a call right now (revoked,
  // initiated-but-never-completed, failed). 409 rather than 503: nothing will
  // change on its own, a human reconnects it in Postora — so never retryable.
  connection_inactive: {
    status: 409, retryable: false,
    message: "The connector connection is not active; reconnect it in Postora",
  },
  // The capability is outside the connector's curated allow-list (spec D4).
  // A permanent fact about this connector type, not about this key.
  connector_tool_not_allowed: {
    status: 403, retryable: false,
    message: "This connector is not allowed to run that capability",
  },
  // 400, not 404: the type is a well-formed part of the request that names
  // something real (a native connector type) which simply cannot be connected
  // this way. A 404 would say the path does not exist, which is a different
  // and misleading fact.
  connector_type_not_connectable: {
    status: 400, retryable: false,
    message: "That connector type cannot be connected through this endpoint",
  },
  // Spec D11: the connector service is disabled (no API key configured) or
  // unreachable. Retryable because "unreachable" is the case a partner can
  // usefully wait out, and a disabled deployment is indistinguishable from it
  // on the wire by design — saying which would describe Postora's config.
  connector_unavailable: {
    status: 503, retryable: true,
    message: "The connector service is unavailable; retry shortly",
  },
  // A data-changing capability the tool's owner has not enabled. A partner key
  // can never widen what the owner allowed, so this is not a scope problem the
  // caller can fix by asking for a bigger key.
  connector_write_not_allowed: {
    status: 403, retryable: false,
    message: "This connector is not allowed to change data in the connected account",
  },
  // Entitlement is distinct from key scope; both refusals use 403 and the
  // partner discriminates on the code. This does not imply a payment flow.
  feature_not_entitled: {
    status: 403, retryable: false,
    message: "This workspace is not entitled to that feature",
  },
  idempotency_conflict: {
    status: 409, retryable: false,
    message: "This Idempotency-Key was used with a different body",
  },
  idempotency_in_progress: {
    status: 409, retryable: true,
    message: "An identical request is still processing",
  },
  idempotency_indeterminate: {
    status: 409, retryable: false,
    message: "A previous attempt may have been delivered; resolve it before retrying",
  },
  insufficient_scope: {
    status: 403, retryable: false,
    message: "This key is not authorized for this operation",
  },
  // The alias marks its inline internal_error paths retryable:true (index.ts
  // "Could not resolve the account" / "Unexpected error"). Its key-lookup
  // PartnerAuthError path computes retryable:false — an alias inconsistency
  // recorded in the task report, not replicated as a second verdict here.
  internal_error: {
    status: 500, retryable: true,
    message: "Unexpected error",
  },
  invalid_key: {
    status: 401, retryable: false,
    message: "Invalid API key",
  },
  invalid_recipient: {
    status: 422, retryable: false,
    message: "Recipient is not reachable on WhatsApp.",
  },
  invalid_request: {
    status: 400, retryable: false,
    message: "The request body is invalid",
  },
  key_expired: {
    status: 401, retryable: false,
    message: "API key expired",
  },
  key_revoked: {
    status: 401, retryable: false,
    message: "API key revoked",
  },
  limiter_unavailable: {
    status: 503, retryable: true,
    message: "Rate limiter is unavailable; retry shortly",
  },
  // 9.3: the scan-state substrate. 409 + retryable because `pending` is the
  // one scan state expected to change on its own — the worker (when one
  // exists) flips it to available or rejected, and the partner's correct
  // move is to retry the SAME request shortly. Re-uploading would mint a
  // new media_id that is pending again, which is the opposite of progress.
  media_pending: {
    status: 409, retryable: true,
    message: "The media file is pending a security scan; retry shortly",
  },
  // `rejected` is a permanent fact about these bytes. Retrying the same
  // media_id can never succeed, and re-uploading the same bytes should meet
  // the same verdict — so never retryable, like every other 422 here.
  media_rejected: {
    status: 422, retryable: false,
    message: "The media file was rejected and cannot be sent",
  },
  // The alias emits meta_error as 502/retryable:true when the outcome is
  // indeterminate and 422/retryable:false on a definite rejection
  // (whatsappPartnerOps.translateMetaError) — both reachable, hence the
  // per-call override and the indeterminate-leaning default here.
  meta_error: {
    status: 502, retryable: true,
    message: "The provider request could not be completed",
  },
  method_not_allowed: {
    status: 405, retryable: false,
    message: "Method not allowed; see the Allow header",
  },
  missing_idempotency_key: {
    status: 400, retryable: false,
    message: "Idempotency-Key header is required for this request",
  },
  outside_session_window: {
    status: 422, retryable: false,
    message: "Recipient has not messaged in the last 24h — send an approved template.",
  },
  // 413, and deliberately not 422. The request SHAPE is fine -- it is the
  // number of bytes that is not, which is what 413 means and what a partner's
  // client library will already have a branch for. Never retryable: the same
  // file will be the same size next time.
  payload_too_large: {
    status: 413, retryable: false,
    message: "The uploaded file is larger than the limit for its media type",
  },
  quota_exceeded: {
    status: 429, retryable: false,
    message: "Monthly quota exhausted for this key",
  },
  rate_limited: {
    status: 429, retryable: true,
    message: "Rate limit exceeded",
  },
  // Reachable since the /v1 router landed: the router's unmatched-path 404 and,
  // from deliverable 2.5 on, D11's answer for a resource outside the key's
  // binding. Non-enumerable by design — the message must not reveal whether
  // the path exists, exists-but-is-unbound, or never existed.
  resource_not_found: {
    status: 404, retryable: false,
    message: "Resource not found",
  },
  // A domain lease can be held by the webhook or poller without any partner
  // idempotency key. Wait for that sweep before starting a new request.
  sync_already_running: {
    status: 409, retryable: true,
    message: "History sync is already running; poll history-sync for progress",
  },
  template_not_approved: {
    status: 422, retryable: false,
    message: "Template rejected by Meta",
  },
  // Media resolution failed for a reason a retry can clear: the provider fetch,
  // the byte-budget admission, the storage upload or the signature. Distinct
  // from temporarily_unavailable, which is a deliberate suspension and says
  // retrying will NOT succeed -- telling a caller to abandon a download that
  // would have worked on the next attempt.
  media_unavailable: {
    status: 503, retryable: true,
    message: "The media could not be retrieved right now; retry shortly",
  },
  temporarily_unavailable: {
    status: 503, retryable: false,
    message: "This action is temporarily suspended; see the Partner API changelog. " +
      "Retrying will not succeed until it is re-enabled",
  },
  // The downstream call ran and reported failure. 502 with the code only: the
  // vendor's body never passes through (spec §11), so a partner sees that the
  // call failed, not why the third party said it did. Retryable because a
  // downstream failure is the class of thing that clears on its own; a caller
  // that must not repeat a side effect replays the same Idempotency-Key.
  tool_execution_failed: {
    status: 502, retryable: true,
    message: "The connector request could not be completed",
  },
  // The 20 s partner budget expired. 504 and retryable for the same reason,
  // with the same idempotency caveat: the side effect may or may not have
  // happened, so the safe retry is the SAME key.
  tool_execution_timeout: {
    status: 504, retryable: true,
    message: "The connector request timed out",
  },
  // Non-enumerable, exactly like resource_not_found: a tool that does not
  // exist, a tool that is not resolvable for the named account, and an account
  // this key is not bound to are all one answer, so a probe learns nothing.
  tool_not_found: {
    status: 404, retryable: false,
    message: "Tool not found",
  },
  // Alias vocabulary: /v1 routes never emit it (there is no action protocol),
  // but it stays expressible so the two surfaces share one code list.
  unknown_action: {
    status: 400, retryable: false,
    message: "Unknown action",
  },
  // A platform/type combination that does not exist -- not a permission
  // problem and not a temporary one, so 422 rather than 403 or 503, and
  // never retryable: the same request will never become valid. Distinct
  // from unsupported_direct_qr, which is about the ACCOUNT's connection
  // mode rather than the request's shape (PRD 15.4).
  unsupported_capability: {
    status: 422, retryable: false,
    message: "That capability is not supported for this account",
  },
  unsupported_direct_qr: {
    status: 400, retryable: false,
    message: "Template messages are not supported in Direct QR mode",
  },
} as const satisfies Record<string, V1ErrorPolicyEntry>;

export type V1ErrorCode = keyof typeof V1_ERROR_POLICY;

export interface V1ErrorOptions {
  status?: number;
  retryable?: boolean;
  message?: string;
  /** Machine-readable context (e.g. meta_code). Omitted entirely — never
   *  null, never {} — when there is nothing to say. */
  details?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface V1ErrorEnvelopeBody {
  error: {
    code: V1ErrorCode;
    message: string;
    retryable: boolean;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

/** The one builder of a /v1 error BODY. Kept separate from the Response
 *  builder so the shape itself is assertable in tests without HTTP. */
export function v1ErrorBody(
  code: V1ErrorCode,
  requestId: string,
  options: V1ErrorOptions = {},
): V1ErrorEnvelopeBody {
  const policy = V1_ERROR_POLICY[code];
  return {
    error: {
      code,
      message: options.message ?? policy.message,
      retryable: options.retryable ?? policy.retryable,
      request_id: requestId,
      ...(options.details !== undefined ? { details: options.details } : {}),
    },
  };
}

/** The one builder of a /v1 error RESPONSE. Every /v1 failure — router 404,
 *  router 405, future auth/limiter/handler failures — comes through here, so
 *  X-Postora-Request-Id and the envelope can never drift apart. No
 *  Access-Control-* headers: the recorded CORS decision
 *  (docs/decisions/2026-08-30-partner-api-cors.md, 2026-08-31 correction 2)
 *  covers the alias only and forbids pre-adopting it for /v1. */
export function v1ErrorResponse(
  code: V1ErrorCode,
  requestId: string,
  options: V1ErrorOptions = {},
): Response {
  return new Response(JSON.stringify(v1ErrorBody(code, requestId, options)), {
    status: options.status ?? V1_ERROR_POLICY[code].status,
    headers: {
      "Content-Type": "application/json",
      "X-Postora-Request-Id": requestId,
      ...options.headers,
    },
  });
}
