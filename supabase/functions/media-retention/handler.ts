import { z } from "https://esm.sh/zod@3.23.8";
import { verifyCronOrAdmin } from "../_shared/cron-auth.ts";
import { handleCorsOptions, corsHeaders } from "../_shared/cors.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
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

export async function handleMediaRetentionRequest(
  req: Request,
  deps?: { ports: RetentionPorts },
): Promise<Response> {
  if (req.method === "OPTIONS") return handleCorsOptions();

  const auth = await verifyCronOrAdmin(req);
  if (!auth.ok) return auth.response;

  let dryRun = false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.text();
    if (text.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json(400, { success: false, error: "Invalid request" });
      }
      const body = BodySchema.safeParse(parsed);
      if (!body.success) return json(400, { success: false, error: "Invalid request" });
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
