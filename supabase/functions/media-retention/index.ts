import { handleMediaRetentionRequest } from "./handler.ts";

Deno.serve((req) => handleMediaRetentionRequest(req));
