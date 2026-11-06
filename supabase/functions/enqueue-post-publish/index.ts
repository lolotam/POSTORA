import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { runInBackground } from "../_shared/background.ts";
import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { type EnqueueDependencies, refusalRow, run } from "./run.ts";

// A missing stamp must never turn a guarded kick into process-post's legacy unconditional claim.
const RequestStampSchema = z.string().datetime({ offset: true });
const RetryResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"), requested_at: RequestStampSchema,
    account_ids: z.array(z.string().uuid()).min(1), platforms: z.array(z.string().min(1)).min(1),
  }),
  z.object({ status: z.literal("refused"), reason: z.enum(["not_found", "not_retryable", "no_targets"]) }),
]);

export interface HttpDependencies extends EnqueueDependencies {
  authenticate(req: Request): Promise<{ userId: string }>;
}

export function createDependencies(): HttpDependencies {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceRoleKey);
  const logRefusal: EnqueueDependencies["logRefusal"] = async (row) => {
    try {
      const { error } = await admin.from("system_logs").insert(row);
      if (error) console.error("[enqueue-post-publish] log write failed:", sanitizeErrorMessage(error));
    } catch (error) {
      console.error("[enqueue-post-publish] log write failed:", sanitizeErrorMessage(error));
    }
  };
  return {
    authenticate: (req) => authenticateCaller(req),
    logRefusal,
    requestImmediatePublish: async (postId, userId) => {
      const { data, error } = await admin.rpc("request_immediate_publish", { p_post_id: postId, p_user_id: userId });
      if (error) throw error;
      return RequestStampSchema.nullable().parse(data);
    },
    requestPostRetry: async (postId, userId, accountIds) => {
      const { data, error } = await admin.rpc("request_post_retry", {
        p_post_id: postId, p_user_id: userId, ...(accountIds ? { p_account_ids: accountIds } : {}),
      });
      if (error) throw error;
      return RetryResultSchema.parse(data);
    },
    readPostStatus: async (postId, userId) => {
      const { data, error } = await admin.from("posts").select("status")
        .eq("id", postId).eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return data?.status ?? null;
    },
    kick: async (payload) => {
      await runInBackground("kick process-post", async () => {
        let status: number | null = null;
        try {
          const response = await fetch(`${url}/functions/v1/process-post`, {
            method: "POST",
            headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(150_000),
          });
          status = response.status;
          await response.text();
          if (response.ok || status === 409 || status === 503) return;
        } catch {
          // No raw network error or response body enters logs: it can carry credentials.
        }
        await logRefusal(refusalRow("publish_kick_failed", null, { post_id: payload.post_id, status }));
      });
    },
  };
}

export async function handleRequest(req: Request, createDeps: () => HttpDependencies = createDependencies): Promise<Response> {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  const deps = createDeps();
  if (req.method !== "POST") {
    await deps.logRefusal(refusalRow("method_not_allowed", null));
    return restrictedJsonResponse(req, { error: sanitizeErrorMessage("Invalid request method") }, 405);
  }
  let callerId: string;
  try {
    ({ userId: callerId } = await deps.authenticate(req));
  } catch {
    await deps.logRefusal(refusalRow("unauthorized", null));
    return restrictedJsonResponse(req, { error: sanitizeErrorMessage("Unauthorized") }, 401);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    await deps.logRefusal(refusalRow("invalid_request", callerId));
    return restrictedJsonResponse(req, { error: sanitizeErrorMessage("Invalid request") }, 400);
  }
  const response = await run(deps, { callerId, body });
  return restrictedJsonResponse(req, response.body, response.status);
}

if (import.meta.main) Deno.serve((req) => handleRequest(req));
