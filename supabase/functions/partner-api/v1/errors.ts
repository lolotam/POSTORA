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
  template_not_approved: {
    status: 422, retryable: false,
    message: "Template rejected by Meta",
  },
  temporarily_unavailable: {
    status: 503, retryable: false,
    message: "This action is temporarily suspended; see the Partner API changelog. " +
      "Retrying will not succeed until it is re-enabled",
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
    message: "That message type is not supported for this account",
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
