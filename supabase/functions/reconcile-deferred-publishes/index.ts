import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { corsHeaders, handleCorsOptions } from "../_shared/cors.ts";
import { createReconcilePorts } from "./deps.ts";
import { runReconcile } from "./run.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();
  const auth = verifyCronAuth(req);
  if (!auth.ok) return auth.response;

  try {
    return json(200, { success: true, ...(await runReconcile(createReconcilePorts())) });
  } catch (error) {
    // A failed claim leaves every row as it was; the next minute tries again.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[reconcile-deferred-publishes] run failed:", message);
    try {
      await createReconcilePorts().log("error", "Deferred publish reconcile failed", { error: message.slice(0, 500) });
    } catch {
      console.error("[reconcile-deferred-publishes] failure log failed");
    }
    return json(500, { success: false, error: "Reconcile failed" });
  }
});
