import { handleRestrictedCorsOptions } from "../_shared/cors.ts";
import { handleHealthRequest, type HealthHandlerPorts } from "./handler.ts";
import { createHealthHandlerPorts } from "./deps.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  try {
    const ports: HealthHandlerPorts = await createHealthHandlerPorts();
    return await handleHealthRequest(req, ports);
  } catch (error) {
    // The edge function must answer with a status, not with a stack trace. The
    // reason never leaves the server: only the name of the failure is logged.
    console.error("event: 'ai_provider_health_serve_failed'", error instanceof Error ? error.name : "error");
    return new Response(
      JSON.stringify({ error: "The provider health check failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
