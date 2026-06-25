// Shared authorization helper for cron-triggered edge functions.
// Verifies a shared CRON_SECRET passed as `Authorization: Bearer <secret>`
// or `x-cron-secret: <secret>`. Also allows callers presenting the Supabase
// service-role key (used by internal scheduler invocations) as a Bearer token.

export function verifyCronAuth(req: Request): { ok: true } | { ok: false; response: Response } {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  };

  // If no CRON_SECRET configured, refuse to run (fail closed).
  if (!cronSecret) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "CRON_SECRET not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const cronHeader = req.headers.get("x-cron-secret") || "";

  const presented = cronHeader || bearer;

  const matches =
    (presented && presented === cronSecret) ||
    (serviceRoleKey && bearer && bearer === serviceRoleKey);

  if (!matches) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  return { ok: true };
}
