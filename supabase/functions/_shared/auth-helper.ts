/**
 * Shared authentication helper for edge functions.
 * Extracts user_id from JWT token instead of trusting request body.
 * Falls back to request body user_id only for service-role (internal) calls.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import crypto from "node:crypto";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export interface AuthResult {
  userId: string;
  isServiceRole: boolean;
}

export function timingSafeTokenEqual(token: string, expectedToken: string): boolean {
  const actual = crypto.createHash('sha256').update(token).digest();
  const expected = crypto.createHash('sha256').update(expectedToken).digest();
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Validates the caller's identity from the Authorization header.
 * 
 * 1. If the Authorization header carries a valid user JWT → extracts user_id from claims.
 * 2. If the header carries the service-role key (internal call from n8n-api, process-post, etc.)
 *    → trusts the user_id in the request body.
 * 3. Otherwise → throws an error.
 * 
 * @param req The incoming request
 * @param bodyUserId The user_id from the request body (used as fallback for service-role calls)
 * @returns AuthResult with the validated userId
 */
export async function authenticateCaller(
  req: Request,
  bodyUserId?: string | null,
): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const token = authHeader.replace("Bearer ", "");

  // Check if this is a service-role call (internal system call)
  if (timingSafeTokenEqual(token, SUPABASE_SERVICE_ROLE_KEY)) {
    if (!bodyUserId) {
      throw new Error("Service-role call requires user_id in request body");
    }
    return { userId: bodyUserId, isServiceRole: true };
  }

  // Validate as a user JWT using getClaims (local validation, no network roundtrip)
  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: claimsData, error } = await supabaseAuth.auth.getClaims(token);

  if (error || !claimsData?.claims) {
    console.warn("JWT claims validation failed:", error?.message);
    throw new Error("Unauthorized: invalid or expired token");
  }

  const jwtUserId = claimsData.claims.sub as string;

  // If body has a different user_id, log a warning but use the JWT one
  if (bodyUserId && bodyUserId !== jwtUserId) {
    console.warn(
      `user_id mismatch: body=${bodyUserId}, jwt=${jwtUserId}. Using JWT user_id.`,
    );
  }

  return { userId: jwtUserId, isServiceRole: false };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * For functions that keep their own user-JWT check. Returns the user a
 * service-role call acts for (the `user_id` in its JSON body), or null when the
 * bearer token is not the service-role key; the caller then runs its existing
 * JWT path unchanged. The body is read from a clone, so the handler can still
 * call req.json() afterwards. Throws, like authenticateCaller, when a
 * service-role call carries no valid user_id.
 */
export async function serviceRoleCallerUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ") || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!timingSafeTokenEqual(authHeader.replace("Bearer ", ""), SUPABASE_SERVICE_ROLE_KEY)) return null;
  const body = await req.clone().json().catch(() => null);
  const bodyUserId = typeof body?.user_id === "string" && UUID_RE.test(body.user_id) ? body.user_id : null;
  return (await authenticateCaller(req, bodyUserId)).userId;
}
