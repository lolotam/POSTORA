import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { handleHealthRequest, type HealthHandlerPorts } from "./handler.ts";

/** Keep initialization failures inside the same HTTP/CORS boundary as run failures. */
export async function serveHealthRequest(req: Request, createPorts: () => Promise<HealthHandlerPorts>): Promise<Response> {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  try {
    return await handleHealthRequest(req, await createPorts());
  } catch (error) {
    // The edge function must answer with a status, not with a stack trace. The
    // reason never leaves the server: only the name of the failure is logged.
    console.error("event: 'ai_provider_health_serve_failed'", error instanceof Error ? error.name : "error");
    return restrictedJsonResponse(req, { error: "The provider health check failed" }, 500);
  }
}
