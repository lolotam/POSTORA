import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  handleRestrictedCorsOptions,
  restrictedErrorResponse,
  restrictedJsonResponse,
} from "../_shared/cors.ts";
import { handleInit, handleCallback, handleRefresh } from "./handler.ts";
import { defaultVendorDependencies } from "./vendor.ts";

function untrustedBodyUserId(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>).user_id;
  return typeof v === "string" ? v : undefined;
}

const RouteSchema = z.object({
  action: z.enum(["init", "callback", "refresh"]),
}).passthrough();

function boundaryLog(event: string, errorCode: string): void {
  // Token/code/state/secret never placed here
  console.warn(JSON.stringify({ event, error_code: errorCode }));
}

export async function handleConnectorOAuthRequest(
  req: Request,
  createAdminClient: (url: string, key: string) => unknown = createClient as unknown as (url: string, key: string) => unknown,
): Promise<Response> {
  try {
    return await executeConnectorOAuthRequest(req, createAdminClient);
  } catch {
    boundaryLog("oauth_failure", "unexpected_boundary_failure");
    return restrictedErrorResponse(req, "OAuth request failed.", 500);
  }
}

async function executeConnectorOAuthRequest(
  req: Request,
  createAdminClient: (url: string, key: string) => unknown,
): Promise<Response> {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  if (req.method !== "POST") {
    boundaryLog("oauth_refused", "method_not_allowed");
    return restrictedErrorResponse(req, "Method not allowed.", 405);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    boundaryLog("oauth_refused", "invalid_json");
    return restrictedErrorResponse(req, "Invalid JSON body.", 400);
  }

  let userId: string;
  try {
    ({ userId } = await authenticateCaller(req, untrustedBodyUserId(body)));
  } catch {
    boundaryLog("oauth_refused", "unauthorized");
    return restrictedErrorResponse(req, "Unauthorized.", 401);
  }

  const route = RouteSchema.safeParse(body);
  if (!route.success) {
    boundaryLog("oauth_refused", "invalid_request");
    return restrictedErrorResponse(req, "Invalid OAuth request.", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    boundaryLog("oauth_failure", "service_unavailable");
    return restrictedErrorResponse(req, "OAuth service is unavailable.", 503);
  }

  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const deps = {
    admin,
    vendorDeps: defaultVendorDependencies(),
  };

  let result: { status: number; body: Record<string, unknown> };
  switch (route.data.action) {
    case "init":
      result = await handleInit(userId, body, deps);
      break;
    case "callback":
      result = await handleCallback(userId, body, deps);
      break;
    case "refresh":
      result = await handleRefresh(userId, body, deps);
      break;
    default:
      boundaryLog("oauth_refused", "invalid_request");
      return restrictedErrorResponse(req, "Invalid OAuth request.", 400);
  }

  if (result.status >= 400) {
    return restrictedJsonResponse(req, result.body, result.status);
  }
  return restrictedJsonResponse(req, result.body, result.status);
}

// Wrapped so the injected admin factory does not receive Deno's cors connInfo as second arg
serve((req) => handleConnectorOAuthRequest(req));
