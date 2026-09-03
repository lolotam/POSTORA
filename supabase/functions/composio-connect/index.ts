import {
  handleRestrictedCorsOptions,
  restrictedCorsHeaders,
  restrictedJsonResponse,
} from "../_shared/cors.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { composioCallbackResponse } from "./callback.ts";
import { createDependencies, createUserClient } from "./dependencies.ts";
import {
  ConnectError,
  initiateConnection,
  refreshConnectionSchema,
} from "./handler.ts";
import { revokeConnection } from "./revoke.ts";

function stringField(
  body: Record<string, unknown>,
  name: string,
): string | null {
  const value = body[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ConnectError("invalid_request", 400);
  }
  return body as Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  const url = new URL(req.url);
  const deps = createDependencies();

  try {
    if (req.method === "GET" && url.pathname.endsWith("/callback")) {
      const response = await composioCallbackResponse(deps, url);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(restrictedCorsHeaders(req))) {
        headers.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers });
    }

    if (req.method !== "POST") {
      return restrictedJsonResponse(req, { error: "method_not_allowed" }, 405);
    }
    const authorization = req.headers.get("Authorization");
    if (!authorization) {
      return restrictedJsonResponse(req, { error: "unauthorized" }, 401);
    }
    const { userId } = await authenticateCaller(req);
    const body = await jsonBody(req);

    if (url.pathname.endsWith("/initiate")) {
      const workspaceId = stringField(body, "workspace_id");
      const connectorType = stringField(body, "connector_type");
      if (!workspaceId || !connectorType) {
        throw new ConnectError("invalid_request", 400);
      }
      return restrictedJsonResponse(
        req,
        await initiateConnection(deps, {
          userId,
          workspaceId,
          connectorType,
        }),
      );
    }

    const connectionId = stringField(body, "connection_id");
    if (!connectionId) throw new ConnectError("invalid_request", 400);

    if (url.pathname.endsWith("/revoke")) {
      return restrictedJsonResponse(
        req,
        await revokeConnection(deps, {
          userId,
          userClient: createUserClient(authorization),
          connectionId,
        }),
      );
    }
    if (url.pathname.endsWith("/refresh-schema")) {
      return restrictedJsonResponse(
        req,
        await refreshConnectionSchema(deps, { userId, connectionId }),
      );
    }
    return restrictedJsonResponse(req, { error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof ConnectError) {
      return restrictedJsonResponse(req, { error: error.code }, error.status);
    }
    console.error("[composio-connect] request failed");
    return restrictedJsonResponse(req, { error: "internal_error" }, 500);
  }
});
