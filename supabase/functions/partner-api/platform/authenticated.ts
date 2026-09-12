import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { PartnerAuthError } from "../../_shared/partnerApiKeys.ts";
import {
  authenticatePlatformKey,
  type PlatformKeyRecord,
} from "../../_shared/partnerPlatformKeys.ts";
import {
  checkRateLimitWithRpc,
  RateLimitedError,
  type LimiterRiskClass,
} from "../../_shared/partnerApiMetering.ts";
import { v1ErrorResponse, type V1ErrorCode, type V1ErrorOptions } from "../v1/errors.ts";
import { PLATFORM_ACTION_SCOPES } from "./policy.ts";

export interface PlatformAuthedContext {
  // deno-lint-ignore no-explicit-any
  admin: any;
  record: PlatformKeyRecord;
  requestId: string;
  rateHeaders: Record<string, string>;
}

export type PlatformAuthedHandler = (
  req: Request,
  authed: PlatformAuthedContext,
  params: Record<string, string>,
) => Promise<Response>;

// deno-lint-ignore no-explicit-any
type AdminFactory = () => any;

const defaultAdminFactory: AdminFactory = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

/** Authentication -> scope -> limiter -> handler, matching the workspace door.
 *  Resource ownership remains the handlers' structural principal-bound check. */
export function withPlatformAuth(
  action: string,
  riskClass: LimiterRiskClass,
  handler: PlatformAuthedHandler,
  adminFactory: AdminFactory = defaultAdminFactory,
) {
  return async (
    req: Request,
    requestId: string,
    params: Record<string, string>,
    doorFactory?: AdminFactory,
  ): Promise<Response> => {
    // Platform ids cannot enter the workspace usage ledger's key foreign key.
    // Log every refusal without credential material, including unresolved keys.
    const refuse = (code: V1ErrorCode, options?: V1ErrorOptions): Response => {
      console.warn(`[partner-api] platform request refused (request ${requestId}, ${action}): ${code}`);
      return v1ErrorResponse(code, requestId, options);
    };

    const rateHeaders: Record<string, string> = {};
    try {
      const bearer = req.headers.get("authorization") ?? "";
      const presented = bearer.startsWith("Bearer ")
        ? bearer.slice(7)
        : (req.headers.get("x-postora-key") ?? "");
      if (presented && !presented.startsWith("pl_")) return refuse("resource_not_found");
      if (!presented) return refuse("invalid_key");

      // The dispatcher's factory takes precedence, as it does for /v1.
      const admin = (doorFactory ?? adminFactory)();
      const record = await authenticatePlatformKey(admin, presented);
      if (!record) return refuse("invalid_key");

      const required = PLATFORM_ACTION_SCOPES[action];
      if (!required) return refuse("internal_error");
      if (!required.some((scope) => record.scopes.includes(scope))) {
        return refuse("insufficient_scope");
      }

      // Unauthorized requests neither consume nor learn a key's budget.
      try {
        const decision = await checkRateLimitWithRpc(admin, record, riskClass, "consume_partner_platform_rate");
        if (decision.status === "resolved") {
          Object.assign(rateHeaders, {
            "X-RateLimit-Limit": String(record.rateLimitPerMin),
            "X-RateLimit-Remaining": String(decision.remaining),
            "X-RateLimit-Reset": String(decision.resetSeconds),
          });
        }
      } catch (err) {
        if (err instanceof RateLimitedError) {
          return refuse("rate_limited", {
            headers: {
              "X-RateLimit-Limit": String(record.rateLimitPerMin),
              "X-RateLimit-Remaining": "0",
              ...(err.resetSeconds !== null
                ? { "X-RateLimit-Reset": String(err.resetSeconds), "Retry-After": String(err.resetSeconds) }
                : {}),
            },
          });
        }
        throw err;
      }

      const res = await handler(req, { admin, record, requestId, rateHeaders }, params);
      for (const [k, v] of Object.entries(rateHeaders)) {
        if (!res.headers.has(k)) res.headers.set(k, v);
      }
      if (res.status >= 400) {
        console.warn(`[partner-api] platform handler refused (request ${requestId}, ${action}): HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      // Never expose or log raw database/handler errors: they may carry keys.
      const code = err instanceof PartnerAuthError ? err.code as V1ErrorCode : "internal_error";
      return refuse(code, { headers: rateHeaders });
    }
  };
}
