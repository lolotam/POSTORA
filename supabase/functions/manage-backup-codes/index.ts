import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  hashBackupCode,
  isValidBackupCode,
  normalizeBackupCode,
} from "../_shared/backup-codes.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { checkUserRateLimit, rateLimitExceededResponse } from "../_shared/rate-limiter.ts";

const genericErrorMessage = "Request could not be completed";

function jsonResponse(
  req: Request,
  responseBody: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(responseBody), {
    status,
    headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function isJsonObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate);
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  return authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}

function createAdminClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("configuration error");

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function getPepper(): string {
  const pepper = Deno.env.get("BACKUP_CODE_PEPPER");
  if (!pepper?.trim()) throw new Error("configuration error");
  return pepper;
}

async function getAuthenticatedUserId(
  supabaseAdmin: SupabaseClient,
  token: string,
): Promise<string | null> {
  const { data: authResponse, error: authError } = await supabaseAdmin.auth
    .getUser(token);
  return authError ? null : authResponse.user?.id ?? null;
}

async function readActionBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const requestBody: unknown = await request.json();
    return isJsonObject(requestBody) ? requestBody : null;
  } catch {
    return null;
  }
}

function getNormalizedStoreCodes(
  requestBody: Record<string, unknown>,
): string[] | null {
  const codes = requestBody.codes;
  if (
    !Array.isArray(codes) ||
    codes.length !== 10 ||
    !codes.every((code): code is string =>
      typeof code === "string" && isValidBackupCode(code)
    )
  ) return null;

  const normalizedCodes = codes.map(normalizeBackupCode);
  return new Set(normalizedCodes).size === 10 ? normalizedCodes : null;
}

async function getUnusedCount(
  supabaseAdmin: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count, error: countError } = await supabaseAdmin
    .from("backup_codes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("used_at", null);
  if (countError) throw new Error("database error");
  return count ?? 0;
}

async function replaceStoredCodes(
  supabaseAdmin: SupabaseClient,
  userId: string,
  normalizedCodes: string[],
  pepper: string,
): Promise<void> {
  const hashes = await Promise.all(
    normalizedCodes.map((code) => hashBackupCode(code, pepper)),
  );
  const { error: deleteError } = await supabaseAdmin
    .from("backup_codes")
    .delete()
    .eq("user_id", userId);
  if (deleteError) throw new Error("database error");

  const backupCodeRows = hashes.map((codeHash) => ({
    user_id: userId,
    code_hash: codeHash,
  }));
  const { error: insertError } = await supabaseAdmin
    .from("backup_codes")
    .insert(backupCodeRows);
  if (insertError) throw new Error("database error");
}

async function consumeBackupCode(
  supabaseAdmin: SupabaseClient,
  userId: string,
  code: string,
  pepper: string,
): Promise<boolean> {
  const codeHash = await hashBackupCode(code, pepper);
  const { data: consumedCode, error: consumeError } = await supabaseAdmin
    .from("backup_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (consumeError) throw new Error("database error");
  return consumedCode !== null;
}

async function storeCodesResponse(
  supabaseAdmin: SupabaseClient,
  userId: string,
  requestBody: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  const pepper = getPepper();
  const normalizedCodes = getNormalizedStoreCodes(requestBody);
  if (!normalizedCodes) return jsonResponse(req,{ error: genericErrorMessage }, 400);

  await replaceStoredCodes(supabaseAdmin, userId, normalizedCodes, pepper);
  return jsonResponse(req,{ success: true, count: 10 });
}

async function verifyCodeResponse(
  supabaseAdmin: SupabaseClient,
  userId: string,
  requestBody: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  const pepper = getPepper();
  const code = requestBody.code;
  if (typeof code !== "string" || !isValidBackupCode(code)) {
    return jsonResponse(req,{ success: false });
  }

  const success = await consumeBackupCode(supabaseAdmin, userId, code, pepper);
  return jsonResponse(req,{ success });
}

async function executeAction(
  supabaseAdmin: SupabaseClient,
  userId: string,
  requestBody: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  if (requestBody.action === "status") {
    return jsonResponse(req,{ unusedCount: await getUnusedCount(supabaseAdmin, userId) });
  }
  if (requestBody.action === "store") {
    return storeCodesResponse(supabaseAdmin, userId, requestBody, req);
  }
  if (requestBody.action === "verify") {
    return verifyCodeResponse(supabaseAdmin, userId, requestBody, req);
  }
  return jsonResponse(req,{ error: genericErrorMessage }, 400);
}

async function servePostRequest(req: Request): Promise<Response> {
  const token = getBearerToken(req);
  if (!token) return jsonResponse(req, { error: "Unauthorized" }, 401);

  const supabaseAdmin = createAdminClient();
  const userId = await getAuthenticatedUserId(supabaseAdmin, token);
  if (!userId) return jsonResponse(req, { error: "Unauthorized" }, 401);

  // P2-4: user-based rate limit — prevents backup-code brute force.
  // 15 requests per 5 minutes covers status/store/verify combined.
  const rateLimit = await checkUserRateLimit(
    supabaseAdmin,
    "manage-backup-codes",
    userId,
    15,
    300,
  );
  if (!rateLimit.allowed) {
    return rateLimitExceededResponse(rateLimit, { ...restrictedCorsHeaders(req) });
  }

  const requestBody = await readActionBody(req);
  if (!requestBody || typeof requestBody.action !== "string") {
    return jsonResponse(req, { error: genericErrorMessage }, 400);
  }
  return executeAction(supabaseAdmin, userId, requestBody, req);
}
  return executeAction(supabaseAdmin, userId, requestBody);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: restrictedCorsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: genericErrorMessage }, 405);
  }

  try {
    return await servePostRequest(req);
  } catch {
    console.error("[manage-backup-codes] Request failed");
    return jsonResponse(req, { error: genericErrorMessage }, 500);
  }
});
