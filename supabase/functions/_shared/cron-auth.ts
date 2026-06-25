// Shared authorization helper for cron-triggered edge functions.
// Verifies a shared CRON_SECRET passed as `Authorization: Bearer <secret>`
// or `x-cron-secret: <secret>`. Also allows callers presenting the Supabase
// service-role key (used by internal scheduler invocations) as a Bearer token.

// Constant-time string comparison to mitigate timing-side-channel leaks on the
// shared cron secret. Returns false immediately on length mismatch, which is
// safe because the secret length is itself a low-value, non-distinguishing
// piece of metadata for an attacker (they would still need the secret value).
function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function verifyCronAuth(req: Request): { ok: true } | { ok: false; response: Response } {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  };

  // Fail closed if CRON_SECRET is not configured on the server.
  // Do NOT echo the secret name's value or any presented header back to clients.
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

  // Accept the CRON_SECRET via either header. The service-role key is only
  // accepted as a Bearer token for internal scheduler invocations from inside
  // the platform (e.g., a privileged in-cluster caller). Service role must
  // never be sent from a browser or untrusted network.
  const presented = cronHeader || bearer;

  const matchesCronSecret = timingSafeEqual(presented, cronSecret);
  const matchesServiceRole =
    !!serviceRoleKey && timingSafeEqual(bearer, serviceRoleKey);

  if (!matchesCronSecret && !matchesServiceRole) {
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
