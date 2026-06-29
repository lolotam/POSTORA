/**
 * Shared structured response helpers for Edge Functions.
 *
 * Goal: every protected endpoint returns the same shape and status for the
 * same class of failure, so the frontend, n8n nodes, and tests can rely on
 * a single contract.
 *
 * Status rules (must be applied uniformly):
 *  - Missing/invalid/expired JWT             -> 401  unauthorized()
 *  - Valid user, not allowed on this route   -> 403  forbidden()
 *  - Server-side required env missing        -> 503  missingConfig(service)
 *  - Upstream provider unreachable/garbled   -> 503  providerUnavailable(service, code?)
 *  - Malformed request body / missing field  -> 400  invalidBody(details)
 *
 * Never return `200 { ok:false, message:"Unauthorized" }` for an auth failure.
 * Never include env values, raw provider errors, or tokens in `details`.
 *
 * All helpers attach the standard CORS headers from `./cors.ts`, so existing
 * preflight (OPTIONS) handlers are unaffected.
 */

import { corsHeaders } from "./cors.ts";

type JsonBody = Record<string, unknown>;

function json(body: JsonBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** 401 — caller did not present a valid identity. */
export function unauthorized(
  message = "Unauthorized",
  code = "UNAUTHORIZED",
): Response {
  return json({ error: message, code }, 401);
}

/** 403 — caller is authenticated but not allowed on this resource. */
export function forbidden(
  message = "Forbidden",
  code = "FORBIDDEN",
): Response {
  return json({ error: message, code }, 403);
}

/**
 * 503 — a required server-side env/secret is not configured.
 * Only the service NAME is returned. Never echo the env var value.
 */
export function missingConfig(service: string): Response {
  return json(
    { error: "Service not configured", code: "MISSING_CONFIG", service },
    503,
  );
}

/**
 * 503 — upstream provider returned an empty, malformed, or non-recoverable
 * response. `code` lets us distinguish e.g. PROVIDER_EMPTY_RESPONSE from
 * PROVIDER_TIMEOUT without leaking the upstream payload.
 */
export function providerUnavailable(
  service: string,
  code = "PROVIDER_UNAVAILABLE",
): Response {
  return json(
    { error: "Provider unavailable", code, service },
    503,
  );
}

/**
 * 400 — request body failed validation. `details` should be a safe summary
 * (e.g. Zod flatten()), never the raw body, never secrets, never tokens.
 */
export function invalidBody(details: unknown, code = "INVALID_BODY"): Response {
  return json({ error: "Invalid request body", code, details }, 400);
}
