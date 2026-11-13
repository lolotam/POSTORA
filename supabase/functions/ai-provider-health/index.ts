import { createHealthHandlerPorts } from "./deps.ts";
import { serveHealthRequest } from "./serve.ts";

Deno.serve((req) => serveHealthRequest(req, createHealthHandlerPorts));
