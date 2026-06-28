// change-password
// ---------------------------------------------------------------------------
// Authenticated server-side password update. Replaces the previous frontend
// `supabase.auth.updateUser({ password })` call so:
//   * Users with a verified MFA factor MUST upgrade to an AAL2 session first
//     (frontend does `mfa.challenge` + `mfa.verify`), and the new aal=aal2
//     access token is required here. This avoids the
//     "AAL2 session is required..." failure.
//   * Users without MFA must instead present a one-time email OTP issued by
//     `send-change-password-otp` (scoped purpose='change_password').
// Only the service role updates auth.users; the service key never leaves the
// edge runtime.
//
// Perf: JWT is verified locally via HMAC (no Kong/GoTrue round-trip for token
// validation). MFA factor check uses a direct DB query via service role client.
// This eliminates the 2–3 sequential HTTP calls that previously caused the
// wall-clock timeout returning a spurious 401.
// ---------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import {
  checkUserRateLimit,
  rateLimitExceededResponse,
} from "../_shared/rate-limiter.ts";

interface ChangePasswordRequest {
  newPassword?: unknown;
  otp?: unknown;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Decode JWT payload without verifying signature (used after verify). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 ? padded + "=".repeat(4 - (padded.length % 4)) : padded;
    return JSON.parse(atob(pad));
  } catch {
    return null;
  }
}

/**
 * Verify a Supabase JWT locally using HMAC-SHA256.
 * Returns decoded claims on success, null on failure or expiry.
 * This replaces admin.auth.getUser(jwt) — no HTTP call needed.
 */
async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const dataToVerify = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sigBuf = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );

    const valid = await crypto.subtle.verify("HMAC", key, sigBuf, dataToVerify);
    if (!valid) return null;

    const claims = decodeJwtPayload(token);
    if (!claims) return null;

    // Reject expired tokens.
    const exp = typeof claims.exp === "number" ? claims.exp : 0;
    if (exp && exp < Math.floor(Date.now() / 1000)) return null;

    return claims;
  } catch {
    return null;
  }
}

async function hashOTP(otp: string): Promise<string> {
  const data = new TextEncoder().encode(otp);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      console.warn("change-password: 401 unauthorized - missing_authorization");
      return jsonResponse({ error: "Unauthorized", code: "unauthorized" }, 401, corsHeaders);
    }
    const jwt = authHeader.slice(7).trim();

    // ── 1. Validate JWT locally — zero HTTP round-trips ───────────────────────
    const jwtSecret = Deno.env.get("JWT_SECRET")!;
    const claims = await verifyJwt(jwt, jwtSecret);
    if (!claims) {
      console.warn("change-password: 401 unauthorized - invalid_user_jwt");
      return jsonResponse({ error: "Unauthorized", code: "unauthorized" }, 401, corsHeaders);
    }

    const userId = typeof claims.sub === "string" ? claims.sub : null;
    if (!userId) {
      console.warn("change-password: 401 unauthorized - session_not_found");
      return jsonResponse({ error: "Unauthorized", code: "unauthorized" }, 401, corsHeaders);
    }

    // ── 2. Admin client (for rate-limit RPC, MFA lookup, updateUserById) ─────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // ── 3. Parse body early (no I/O) ──────────────────────────────────────────
    let body: ChangePasswordRequest;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid request body" }, 400, corsHeaders);
    }

    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (newPassword.length < 8) {
      return jsonResponse(
        { error: "Password must be at least 8 characters" },
        400,
        corsHeaders,
      );
    }

    // ── 4. Parallelise: rate-limit + MFA factor check at the same time ────────
    const isAal2 = claims.aal === "aal2";

    const [rl, factorList] = await Promise.all([
      checkUserRateLimit(admin, "change-password", userId, 10, 3600),
      admin.auth.admin.mfa.listFactors({ userId }),
    ]);

    if (!rl.allowed) {
      return rateLimitExceededResponse(rl, corsHeaders);
    }

    const hasVerifiedMfa = (factorList.data?.factors ?? []).some(
      (f: { factor_type: string; status: string }) =>
        f.factor_type === "totp" && f.status === "verified",
    );

    // ── 5. Identity proof ─────────────────────────────────────────────────────
    if (hasVerifiedMfa) {
      if (!isAal2) {
        // Frontend should re-prompt for authenticator code and retry with
        // an AAL2 token. We never accept OTP as MFA bypass.
        return jsonResponse(
          { error: "MFA verification required", code: "mfa_required" },
          401,
          corsHeaders,
        );
      }
      // AAL2 confirmed — fall through to update.
    } else {
      // Non-MFA path: require a valid 6-digit email OTP.
      const otp = typeof body.otp === "string" ? body.otp.trim() : "";
      if (!/^\d{6}$/.test(otp)) {
        return jsonResponse(
          { error: "Verification code required", code: "otp_required" },
          401,
          corsHeaders,
        );
      }

      // Resolve user email (needed to look up the OTP row).
      // claims.email is present in Supabase JWTs; use it to avoid an extra API call.
      const email = (typeof claims.email === "string" ? claims.email : "").toLowerCase();
      if (!email) {
        return jsonResponse({ error: "Account has no email on file" }, 400, corsHeaders);
      }

      const otpHash = await hashOTP(otp);
      const { data: otpRecord } = await admin
        .from("password_reset_otps")
        .select("id, expires_at, attempts, used, purpose")
        .eq("email", email)
        .eq("purpose", "change_password")
        .eq("code_hash", otpHash)
        .eq("used", false)
        .maybeSingle();

      if (!otpRecord) {
        return jsonResponse(
          { error: "Invalid or expired verification code", code: "invalid_otp" },
          400,
          corsHeaders,
        );
      }

      if (new Date(otpRecord.expires_at as string) < new Date()) {
        await admin.from("password_reset_otps").delete().eq("id", otpRecord.id);
        return jsonResponse(
          { error: "Verification code has expired. Request a new one.", code: "invalid_otp" },
          400,
          corsHeaders,
        );
      }

      if ((otpRecord.attempts ?? 0) >= 5) {
        await admin.from("password_reset_otps").delete().eq("id", otpRecord.id);
        return jsonResponse(
          { error: "Too many failed attempts. Request a new code.", code: "invalid_otp" },
          400,
          corsHeaders,
        );
      }

      // Mark OTP used and clear sibling codes.
      await admin.from("password_reset_otps").update({ used: true }).eq("id", otpRecord.id);
      await admin
        .from("password_reset_otps")
        .delete()
        .eq("email", email)
        .eq("purpose", "change_password")
        .eq("used", false);
    }

    // ── 6. Update password via service role ───────────────────────────────────
    const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (updateError) {
      console.error("change-password: updateUserById failed:", updateError.message);
      return jsonResponse({ error: "Failed to update password" }, 500, corsHeaders);
    }

    return jsonResponse({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error("change-password: unexpected error:", err);
    return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
  }
});
