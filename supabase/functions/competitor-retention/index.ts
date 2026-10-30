/**
 * The composition root of `competitor-retention`.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The route, and nothing else. The handler owns the request contract and
 *   the authorization, the run owns the bounded orchestration, and the
 *   adapter owns the database. There is no SQL here, no business rule and
 *   no domain loop.
 */
import { handleCompetitorRetentionRequest } from "./handler.ts";

Deno.serve((req) => handleCompetitorRetentionRequest(req));
