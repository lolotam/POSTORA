import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { corsHeaders, handleCorsOptions } from "../_shared/cors.ts";
import { createSweepLogger, createSweepPorts } from "./deps.ts";
import { runSweep } from "./run.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();
  const auth = verifyCronAuth(req);
  if (!auth.ok) return auth.response;

  try {
    return json(200, { success: true, ...(await runSweep(createSweepPorts())) });
  } catch (error) {
    // The user-folder listing failed (or Openinary is not configured): nothing was deleted.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[sweep-ai-image-staging] run failed:", message);
    try {
      await createSweepLogger()("error", "AI image staging sweep failed", { error: message.slice(0, 500) });
    } catch {
      console.error("[sweep-ai-image-staging] failure log failed");
    }
    return json(500, { success: false, error: "Sweep failed" });
  }
});
