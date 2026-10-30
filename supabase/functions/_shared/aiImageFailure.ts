/**
 * Answering a failed or refused AI image request: one `system_logs` row (who, which tool, which
 * code) plus the JSON failure body. AGENTS.md requires every early return that refuses work to
 * leave a durable row; the console line alone disappears with the container.
 *
 * Never put URLs, image data, tokens or provider text in `reason`: it is a short identifier.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger } from "./logging.ts";
import { toolFailureResponse } from "./aiImageIo.ts";

export interface ToolFailureContext {
  db: SupabaseClient;
  /** The edge function, e.g. "remove-background". */
  source: string;
  operation: "upscale" | "background_removal";
  userId: string;
}

export interface ToolFailure {
  status: number;
  code: string;
  message: string;
  /** Short identifier for the log: "no_provider_usable", "rate_limited", "invalid_prediction", ... */
  reason: string;
  /** "warn" for a refusal the caller can fix or retry, "error" for an operator-side problem. */
  level?: "warn" | "error";
}

export async function failTool(ctx: ToolFailureContext, failure: ToolFailure): Promise<Response> {
  const log = createLogger(ctx.db, ctx.source, "edge");
  const record = failure.level === "error" ? log.error : log.warn;
  await record(
    `${ctx.operation}: ${failure.code}`,
    { operation: ctx.operation, code: failure.code, reason: failure.reason, status: failure.status },
    ctx.userId,
  );
  return toolFailureResponse(failure.status, failure.code, failure.message);
}
