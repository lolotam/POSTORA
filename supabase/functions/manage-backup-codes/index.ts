// manage-backup-codes
// Server-authoritative generation + storage of 2FA backup codes.
//
// Actions:
//   POST { action: "status" }   -> { count: <unused codes> }
//   POST { action: "generate" } -> { codes: string[10] }  (plaintext, shown ONCE)
//   POST { action: "verify", code: "XXXXXXXX" } -> { ok: boolean }
//      (consumes the code by stamping used_at; intended for future MFA reset flow)
//
// Storage:
//   public.backup_codes (id, user_id, code_hash, used_at, created_at)
//   code_hash = SHA-256(uppercased code). Plaintext is NEVER persisted or logged.
//
// Auth: requires a valid user JWT (Supabase default verify_jwt = true). We
// always trust auth.uid() from the JWT, never a body-supplied user_id.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { corsHeaders, handleCorsOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, power-of-two -> no modulo bias
const CODE_LENGTH = 8;
const CODE_COUNT = 10;

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CHARSET.charAt(bytes[i] & 0x1f);
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let userId: string;
  try {
    const auth = await authenticateCaller(req);
    userId = auth.userId;
  } catch {
    return errorResponse("Unauthorized", 401);
  }

  let body: { action?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (body.action === "status") {
      const { count, error } = await admin
        .from("backup_codes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("used_at", null);
      if (error) throw error;
      return jsonResponse({ count: count ?? 0 });
    }

    if (body.action === "generate") {
      // Replace any existing codes for this user.
      const { error: delErr } = await admin
        .from("backup_codes")
        .delete()
        .eq("user_id", userId);
      if (delErr) throw delErr;

      const codes: string[] = [];
      const rows: { user_id: string; code_hash: string }[] = [];
      const seen = new Set<string>();
      while (codes.length < CODE_COUNT) {
        const c = generateCode();
        if (seen.has(c)) continue;
        seen.add(c);
        codes.push(c);
        rows.push({ user_id: userId, code_hash: await sha256Hex(c) });
      }

      const { error: insErr } = await admin.from("backup_codes").insert(rows);
      if (insErr) throw insErr;

      return jsonResponse({ codes });
    }

    if (body.action === "verify") {
      const raw = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      if (raw.length !== CODE_LENGTH) return jsonResponse({ ok: false });
      const hash = await sha256Hex(raw);

      const { data: rows, error: selErr } = await admin
        .from("backup_codes")
        .select("id")
        .eq("user_id", userId)
        .eq("code_hash", hash)
        .is("used_at", null)
        .limit(1);
      if (selErr) throw selErr;
      if (!rows || rows.length === 0) return jsonResponse({ ok: false });

      const { error: updErr } = await admin
        .from("backup_codes")
        .update({ used_at: new Date().toISOString() })
        .eq("id", rows[0].id);
      if (updErr) throw updErr;

      return jsonResponse({ ok: true });
    }

    return errorResponse("Unknown action", 400);
  } catch (e) {
    // Do not leak DB error details to client.
    console.error("manage-backup-codes failed:", (e as Error)?.message);
    return errorResponse("Internal error", 500);
  }
});
