import { handleRestrictedCorsOptions } from "../_shared/cors.ts";
import { handleHealthRequest, type HealthHandlerPorts } from "./handler.ts";
import { createHealthHandlerPorts } from "./deps.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  const ports: HealthHandlerPorts = await createHealthHandlerPorts();
  return handleHealthRequest(req, ports);
});
