import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  handleRestrictedCorsOptions,
  restrictedErrorResponse,
  restrictedJsonResponse,
} from "../_shared/cors.ts";
import { persistConnectionTestOutcome } from "./connectionTestOutcome.ts";
import { tableCache } from "./cache.ts";
import { createAdapterDependencies } from "./dependencies.ts";
import { executeConnector } from "./dispatcher.ts";
import { CAPABILITIES, type ConnectorResult, type ConnectorTool } from "./types.ts";
import { recordConnectorCall, resolveWorkspaceForCall } from "../_shared/connectorTelemetry.ts";

export interface TestConnectionProbeInput {
  userId: string;
  toolId: string;
  connectorType: string;
  socialAccountId: string | null;
}

/**
 * Spec §7.2: the adapter meters ONLY the test_connection probe (source
 * 'test'); execute calls are metered by the reply's executeRoutedCustomTool,
 * never twice. The probe's own outcome is the answer the user sees, so a
 * failing ledger insert or an unresolvable workspace never repaints it.
 */
export async function meterTestConnectionProbe(
  // deno-lint-ignore no-explicit-any
  admin: any,
  input: TestConnectionProbeInput,
  run: () => Promise<ConnectorResult>,
): Promise<ConnectorResult> {
  const startedAt = performance.now();
  const outcome = await run();
  let workspaceId: string;
  try {
    workspaceId = await resolveWorkspaceForCall(admin, {
      socialAccountId: input.socialAccountId,
      userId: input.userId,
    });
  } catch {
    boundaryLog("connector_failure", "probe_unmetered", { user_id: input.userId, tool_id: input.toolId });
    return outcome;
  }
  await recordConnectorCall(admin, {
    workspaceId,
    toolId: input.toolId,
    connectionId: null,
    socialAccountId: input.socialAccountId,
    partnerKeyId: null,
    connectorType: input.connectorType,
    authStrategy: "manual_credentials",
    actionName: "test_connection",
    source: "test",
    requestId: null,
  }, {
    status: outcome.ok ? "success" : "failed",
    errorCode: outcome.ok ? null : outcome.error.code,
    latencyMs: performance.now() - startedAt,
  });
  return outcome;
}

/** User JWTs never open procedure writes, even when the body asks for them. */
export function internalProcedureAllowed(
  isServiceRole: boolean,
  body: { internal_procedure?: boolean },
): boolean {
  return isServiceRole === true && body.internal_procedure === true;
}

export const RequestSchema = z.object({
  tool_id: z.string().uuid(),
  action: z.enum(["execute", "test_connection"]),
  capability: z.enum(CAPABILITIES).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  /** Procedure runtime only. The model tool path never sets this. */
  internal_procedure: z.boolean().optional(),
  parameters: z.record(z.unknown()).default({}),
  user_id: z.string().uuid().optional(),
  // The caller's REMAINING wall-clock budget for this whole adapter call. The
  // Supabase page loop derives its deadline from it, so a call made late in a
  // conversation shortens its loop instead of being aborted mid-flight with
  // every page it already fetched thrown away.
  call_budget_ms: z.number().int().positive().optional(),
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
  let isServiceRole = false;
  try {
    ({ userId, isServiceRole } = await authenticateCaller(req, untrustedBodyUserId(requestBody)));
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
    .select("id, connector_type, settings, permissions, read_only_mode, is_enabled, social_account_id")
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

  const runConnector = () =>
    executeConnector(
      {
        tool: toolRecord as ConnectorTool,
        credentials: credentialBlob as Record<string, unknown>,
        request: {
          action: parsedRequest.data.action,
          capability: parsedRequest.data.capability,
          method: parsedRequest.data.method,
          internalProcedure: internalProcedureAllowed(isServiceRole, parsedRequest.data),
          parameters: parsedRequest.data.parameters,
        },
      },
      createAdapterDependencies(parsedRequest.data.call_budget_ms, tableCache(admin)),
    );
  const connectorOutcome = parsedRequest.data.action === "test_connection"
    ? await meterTestConnectionProbe(admin, {
      userId,
      toolId,
      connectorType: String(toolRecord.connector_type),
      socialAccountId: typeof toolRecord.social_account_id === "string" ? toolRecord.social_account_id : null,
    }, runConnector)
    : await runConnector();

  // The adapter — not the browser — records the probe on the row (see
  // connectionTestOutcome.ts). Deliberately after the outcome exists and
  // before the response, and deliberately non-fatal: the probe's own result
  // is the answer, bookkeeping is not allowed to change it. Early refusals
  // above (not found / disabled / unconfigured) never made a probe, so they
  // leave any previous last_test_* state untouched.
  if (parsedRequest.data.action === "test_connection") {
    await persistConnectionTestOutcome(admin, toolId, connectorOutcome);
  }

  return restrictedJsonResponse(req, connectorOutcome);
}

