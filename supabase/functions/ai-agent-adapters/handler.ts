import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  handleRestrictedCorsOptions,
  restrictedErrorResponse,
  restrictedJsonResponse,
} from "../_shared/cors.ts";
import { createAdapterDependencies } from "./dependencies.ts";
import { executeConnector } from "./dispatcher.ts";
import { CAPABILITIES, type ConnectorTool } from "./types.ts";

const RequestSchema = z.object({
  tool_id: z.string().uuid(),
  action: z.enum(["execute", "test_connection"]),
  capability: z.enum(CAPABILITIES).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  parameters: z.record(z.unknown()).default({}),
  user_id: z.string().uuid().optional(),
}).strict().superRefine((request, context) => {
  if (request.action === "execute" && !request.capability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["capability"],
      message: "capability is required for execute",
    });
  }
});

function boundaryLog(
  event: string,
  errorCode: string,
  metadata: Record<string, string | undefined> = {},
): void {
  console.warn(JSON.stringify({ event, error_code: errorCode, ...metadata }));
}

function untrustedBodyUserId(requestBody: unknown): string | undefined {
  if (requestBody === null || typeof requestBody !== "object") return undefined;
  const candidate = (requestBody as Record<string, unknown>).user_id;
  return typeof candidate === "string" ? candidate : undefined;
}

// The admin client is injectable so the refusal table above it can be tested
// without a database (ARCHITECTURE §12: construct dependencies, then invoke).
// Defaulted, so index.ts stays a one-liner and production behaviour is unchanged.
// The seam exists so the refusal table above the database can be tested without
// one (ARCHITECTURE §12: construct dependencies, then invoke). Typed loosely on
// purpose: a structural type narrow enough to be useful here would have to
// restate supabase-js's builder AND its rpc surface, and would then drift from
// it. The stub in the test is checked by the assertions it drives, not by this
// signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminClientFactory = (url: string, key: string) => any;

export async function handleAdapterRequest(
  req: Request,
  createAdminClient: AdminClientFactory = createClient,
): Promise<Response> {
  try {
    return await executeAdapterRequest(req, createAdminClient);
  } catch {
    // Transport/runtime stacks can capture credential-bearing request headers.
    boundaryLog("connector_failure", "unexpected_boundary_failure");
    return restrictedErrorResponse(req, "Connector request failed.", 500);
  }
}

async function executeAdapterRequest(
  req: Request,
  createAdminClient: AdminClientFactory,
): Promise<Response> {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  if (req.method !== "POST") {
    boundaryLog("connector_refused", "method_not_allowed");
    return restrictedErrorResponse(req, "Method not allowed.", 405);
  }

  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    boundaryLog("connector_refused", "invalid_json");
    return restrictedErrorResponse(req, "Invalid JSON body.", 400);
  }

  let userId: string;
  try {
    ({ userId } = await authenticateCaller(req, untrustedBodyUserId(requestBody)));
  } catch {
    boundaryLog("connector_refused", "unauthorized");
    return restrictedErrorResponse(req, "Unauthorized.", 401);
  }

  const parsedRequest = RequestSchema.safeParse(requestBody);
  if (!parsedRequest.success) {
    boundaryLog("connector_refused", "invalid_request", { user_id: userId });
    return restrictedErrorResponse(req, "Invalid connector request.", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    boundaryLog("connector_failure", "service_unavailable", { user_id: userId });
    return restrictedErrorResponse(req, "Connector service is unavailable.", 503);
  }

  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const toolId = parsedRequest.data.tool_id;
  const { data: toolRecord, error: toolError } = await admin
    .from("ai_agent_tools")
    .select("id, connector_type, settings, permissions, read_only_mode, is_enabled")
    .eq("id", toolId)
    .eq("user_id", userId)
    .maybeSingle();
  if (toolError) {
    boundaryLog("connector_failure", "tool_lookup_failed", { user_id: userId, tool_id: toolId });
    return restrictedErrorResponse(req, "Connector lookup failed.", 500);
  }
  if (!toolRecord) {
    boundaryLog("connector_refused", "connector_not_found", { user_id: userId, tool_id: toolId });
    return restrictedErrorResponse(req, "Connector not found.", 404);
  }
  // Codex P2. The agent prompt happens to exclude disabled tools, but this
  // endpoint is reachable on its own -- so without this check, turning a
  // connector off in the UI kept sending its credentials to the vendor. The
  // prompt's filter is a side effect, not a permission boundary.
  // `is_enabled` is nullable (20260712000000 gives it DEFAULT true and no
  // NOT NULL), so this tests for an explicit false rather than falsiness.
  if (toolRecord.is_enabled === false) {
    boundaryLog("connector_refused", "connector_disabled", { user_id: userId, tool_id: toolId });
    return restrictedErrorResponse(req, "Connector is disabled.", 409);
  }

  const { data: credentialBlob, error: credentialError } = await admin.rpc(
    "get_connector_credential",
    { p_user_id: userId, p_tool_id: toolId },
  );
  if (credentialError) {
    boundaryLog("connector_failure", "credential_lookup_failed", { user_id: userId, tool_id: toolId });
    return restrictedErrorResponse(req, "Connector credential lookup failed.", 500);
  }
  if (credentialBlob === null || typeof credentialBlob !== "object" || Array.isArray(credentialBlob)) {
    boundaryLog("connector_refused", "credentials_not_configured", { user_id: userId, tool_id: toolId });
    return restrictedErrorResponse(req, "Connector credentials are not configured.", 409);
  }

  const connectorOutcome = await executeConnector(
    {
      tool: toolRecord as ConnectorTool,
      credentials: credentialBlob as Record<string, unknown>,
      request: {
        action: parsedRequest.data.action,
        capability: parsedRequest.data.capability,
        method: parsedRequest.data.method,
        parameters: parsedRequest.data.parameters,
      },
    },
    createAdapterDependencies(),
  );
  return restrictedJsonResponse(req, connectorOutcome);
}

