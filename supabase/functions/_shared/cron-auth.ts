// Shared authorization helper for cron-triggered edge functions.
// Verifies a shared CRON_SECRET passed as `Authorization: Bearer <secret>`
// or `x-cron-secret: <secret>`. Also allows callers presenting the Supabase
// service-role key (used by internal scheduler invocations) as a Bearer token.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

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

function bearerToken(req: Request): string {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  return authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
}

/**
 * `unconfigured` means CRON_SECRET is absent on the server, so no cron caller
 * can possibly be authenticated. Callers decide whether that is fatal.
 */
type CronCredentialCheck = "match" | "no-match" | "unconfigured";

function checkCronCredentials(req: Request): CronCredentialCheck {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) return "unconfigured";

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const bearer = bearerToken(req);
  const cronHeader = req.headers.get("x-cron-secret") || "";

  // Accept the CRON_SECRET via either header. The service-role key is only
  // accepted as a Bearer token for internal scheduler invocations from inside
  // the platform (e.g., a privileged in-cluster caller). Service role must
  // never be sent from a browser or untrusted network.
  const presented = cronHeader || bearer;

  const matchesCronSecret = timingSafeEqual(presented, cronSecret);
  const matchesServiceRole = !!serviceRoleKey && timingSafeEqual(bearer, serviceRoleKey);

  return matchesCronSecret || matchesServiceRole ? "match" : "no-match";
}

export function verifyCronAuth(req: Request): { ok: true } | { ok: false; response: Response } {
  const check = checkCronCredentials(req);

  // Fail closed if CRON_SECRET is not configured on the server.
  // Do NOT echo the secret name's value or any presented header back to clients.
  if (check === "unconfigured") {
    return { ok: false, response: jsonError("CRON_SECRET not configured", 503) };
  }

  if (check === "no-match") {
    return { ok: false, response: jsonError("Unauthorized", 401) };
  }

  return { ok: true };
}

/**
 * Resolves whether a bearer token belongs to a signed-in admin.
 *
 * Any failure to answer that question — an expired token, an unreachable auth
 * service, a failed role lookup — resolves to `false`, so an authorizer built on
 * this can only ever fail closed.
 */
async function isAdminToken(token: string): Promise<boolean> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return false;

  try {
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error: userError } = await authClient.auth.getUser(token);
    if (userError || !data.user) return false;

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: role, error: roleError } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", data.user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (roleError) {
      console.error("Admin role lookup failed:", roleError.message);
      return false;
    }
    return !!role;
  } catch (error) {
    console.error("Admin token verification failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Authorizes a function that is reachable both from the cron scheduler and from
 * the admin dashboard in a browser. A browser presents the signed-in user's JWT,
 * which can never match the cron secret, so it is checked against the `admin`
 * role instead.
 *
 * A missing CRON_SECRET only blocks the cron path here — an admin JWT is still
 * accepted, so a server-side misconfiguration cannot lock admins out of the UI.
 */
export async function verifyCronOrAdmin(
  req: Request,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const cronCheck = checkCronCredentials(req);
  if (cronCheck === "match") return { ok: true };

  const token = bearerToken(req);
  if (token && await isAdminToken(token)) return { ok: true };

  if (cronCheck === "unconfigured") {
    return { ok: false, response: jsonError("CRON_SECRET not configured", 503) };
  }
  return { ok: false, response: jsonError("Unauthorized", 401) };
}
