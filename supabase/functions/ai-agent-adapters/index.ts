import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleAdapterRequest } from "./handler.ts";

// Wrapped, not passed by reference: serve() calls the handler with (req, connInfo),
// and connInfo would land in the injectable admin-client slot.
serve((req) => handleAdapterRequest(req));
