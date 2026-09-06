import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { applySetup, readSetup, SetupError, setupRpc } from "./service.ts";

const platform = z.enum([
  "whatsapp",
  "facebook",
  "instagram",
  "threads",
  "youtube",
]);
const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    social_account_id: z.string().uuid(),
    platform,
  }).strict(),
  z.object({
    action: z.literal("request"),
    source_id: z.string().uuid(),
    social_account_id: z.string().uuid(),
    platform,
  }).strict(),
  z.object({ action: z.literal("retry"), job_id: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("apply"),
    job_id: z.string().uuid(),
    fields: z.array(z.string().max(80)).min(1).max(12),
    expected_config_updated_at: z.string().datetime({ offset: true })
      .nullable(),
  }).strict(),
]);

async function indexAppliedProfile(
  req: Request,
  target: { platform: string; social_account_id: string },
) {
  try {
    const response = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/ai-knowledge-ingest`,
      {
        method: "POST",
        headers: {
          Authorization: req.headers.get("Authorization")!,
          apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "ingest_profile_text", ...target }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (!response.ok) throw new Error("Profile indexing failed");
    const payload = await response.json();
    if (payload.ok !== true) throw new Error("Profile indexing failed");
    return { status: payload.queued === true ? "queued" : "ready" };
  } catch {
    console.warn(
      "[ai-website-setup] Applied profile needs indexing retry",
      target.social_account_id,
    );
    return {
      status: "failed",
      error:
        "Settings were saved. Use Save & index in the business profile to retry indexing.",
    };
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  const origin = req.headers.get("Origin");
  const allowed = origin === "https://postora.cloud" ||
    origin === "http://localhost:8080" || origin === "http://localhost:5173";
  const headers = {
    ...corsHeaders,
    "Access-Control-Allow-Origin": allowed && origin
      ? origin
      : "https://postora.cloud",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { headers });
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  let userId: string | undefined;
  try {
    if (req.method !== "POST") throw new SetupError("Method not allowed", 405);
    try {
      userId = (await authenticateCaller(req)).userId;
    } catch {
      throw new SetupError("Sign in to manage website setup.", 401);
    }
    const parsed = requestSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new SetupError("Invalid website setup request.", 400);
    }
    const input = parsed.data;
    if (input.action === "list") {
      return reply(await readSetup(admin, userId, input));
    }
    if (input.action === "request") {
      const caller = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        {
          global: {
            headers: { Authorization: req.headers.get("Authorization")! },
          },
        },
      );
      const job_id = await setupRpc(caller, "create_ai_website_setup_job", {
        p_source_id: input.source_id,
        p_social_account_id: input.social_account_id,
        p_platform: input.platform,
      });
      return reply({ job_id });
    }
    if (input.action === "retry") {
      const job_id = await setupRpc(admin, "retry_ai_website_setup", {
        p_user_id: userId,
        p_job_id: input.job_id,
      });
      return reply({ job_id });
    }
    const { config, job } = await applySetup(admin, userId, input);
    const profile_indexing = input.fields.some((field) =>
        field.startsWith("business_profile.")
      )
      ? await indexAppliedProfile(req, {
        platform: job.platform,
        social_account_id: job.social_account_id,
      })
      : { status: "unchanged" };
    return reply({ config, profile_indexing });
  } catch (error) {
    const status = error instanceof SetupError ? error.status : 500;
    const message = error instanceof SetupError
      ? error.message
      : sanitizeErrorMessage(error);
    const { error: logError } = await admin.from("system_logs").insert({
      source: "ai-website-setup",
      category: "ai",
      level: "warn",
      message: "Website setup request refused",
      user_id: userId,
      metadata: { status },
    });
    if (logError) console.error("[ai-website-setup] refusal log failed");
    return reply({ error: message }, status);
  }
}
if (import.meta.main) Deno.serve(handleRequest);
