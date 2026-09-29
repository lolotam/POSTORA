import { z } from "https://esm.sh/zod@3.23.8";
import { verifyCronOrAdmin } from "../_shared/cron-auth.ts";
import { handleCorsOptions, corsHeaders } from "../_shared/cors.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { createRetentionPorts, createServiceClient } from "./deps.ts";
import { runMediaRetention, type RetentionPorts } from "./run.ts";

const BodySchema = z.object({
  dryRun: z.boolean().optional(),
}).passthrough();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Best effort: a failed audit-log write must never change the auth response. */
// deno-lint-ignore no-explicit-any
async function logAuthRefusal(adminClient?: any): Promise<void> {
  try {
    const admin = adminClient ?? createServiceClient();
    await logToDatabase(admin, {
      level: "warn",
      category: "auth",
      source: "media-retention",
      message: "Retention request refused",
      metadata: { reason: "unauthorized" },
    });
  } catch {
    console.error("[media-retention] auth-refusal log failed");
  }
}

/** Best effort: a failed insert only console.errors, and never changes the 400. */
// deno-lint-ignore no-explicit-any
async function logRejectedRequest(adminClient: any, reason: "invalid_json" | "invalid_dry_run"): Promise<void> {
  try {
    const admin = adminClient ?? createServiceClient();
    await logToDatabase(admin, {
      level: "warn",
      category: "system",
      source: "media-retention",
      message: "Retention request rejected",
      metadata: { reason },
    });
  } catch {
    console.error("[media-retention] rejection log failed");
  }
}

export async function handleMediaRetentionRequest(
  req: Request,
  // deno-lint-ignore no-explicit-any
  deps?: { ports?: RetentionPorts; adminClient?: any },
): Promise<Response> {
  if (req.method === "OPTIONS") return handleCorsOptions();

  const auth = await verifyCronOrAdmin(req);
  if (!auth.ok) {
    await logAuthRefusal(deps?.adminClient);
    return auth.response;
  }

  let dryRun = false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.text();
    if (text.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        await logRejectedRequest(deps?.adminClient, "invalid_json");
        return json(400, { success: false, error: "Invalid request" });
      }
      const body = BodySchema.safeParse(parsed);
      if (!body.success) {
        await logRejectedRequest(deps?.adminClient, "invalid_dry_run");
        return json(400, { success: false, error: "Invalid request" });
      }
      dryRun = body.data.dryRun === true;
    }
  }

  try {
    const ports = deps?.ports ?? createRetentionPorts(createServiceClient());
    const report = await runMediaRetention({ dryRun, ports });
    return json(200, { success: true, ...report });
  } catch (error) {
    console.error("[media-retention] run failed");
    return json(500, { success: false, error: sanitizeErrorMessage(error) });
  }
}
