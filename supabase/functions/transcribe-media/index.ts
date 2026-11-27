// deno-lint-ignore-file no-import-prefix
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { handleTranscribeMediaRequest } from "./handler.ts";

serve((req) => handleTranscribeMediaRequest(req));
