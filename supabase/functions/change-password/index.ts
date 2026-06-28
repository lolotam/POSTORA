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

function decodeJwtClaims(token: string): Record<string, unknown> | null {
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // Validate token server-side. getUser also rejects expired/forged tokens.
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError) {
      console.warn("change-password: 401 unauthorized - invalid_user_jwt");
      return jsonResponse({ error: "Unauthorized", code: "unauthorized" }, 401, corsHeaders);
    }
    if (!userData?.user) {
      console.warn("change-password: 401 unauthorized - session_not_found");
      return jsonResponse({ error: "Unauthorized", code: "unauthorized" }, 401, corsHeaders);
    }
    const user = userData.user;

    // User-scoped rate limit (defence-in-depth against brute forcing OTPs).
    const rl = await checkUserRateLimit(admin, "change-password", user.id, 10, 3600);
    if (!rl.allowed) {
      return rateLimitExceededResponse(rl, corsHeaders);
    }

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

    // Inspect MFA enrollment on the user.
    const { data: factorList } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
    const hasVerifiedMfa = (factorList?.factors ?? []).some(
      (f: { factor_type: string; status: string }) =>
        f.factor_type === "totp" && f.status === "verified",
    );

    // Two acceptable proofs of identity:
    //  A) Caller's JWT is AAL2 (means they just completed MFA challenge).
    //  B) Caller has NO verified MFA factor AND presents a valid email OTP.
    const claims = decodeJwtClaims(jwt);
    const isAal2 = claims?.aal === "aal2";

    if (hasVerifiedMfa) {
      if (!isAal2) {
        // Refuse silently with a specific machine code so the frontend can
        // prompt for the authenticator code. We do NOT accept OTP fallback
        // here — that would let a forgot-password OTP bypass MFA.
        return jsonResponse(
          {
            error: "MFA verification required",
            code: "mfa_required",
          },
          401,
          corsHeaders,
        );
      }
      // AAL2 path — proceed.
    } else {
      // Non-MFA path: require a valid OTP for this user's email.
      const otp = typeof body.otp === "string" ? body.otp.trim() : "";
      if (!/^\d{6}$/.test(otp)) {
        return jsonResponse(
          { error: "Verification code required", code: "otp_required" },
          401,
          corsHeaders,
        );
      }

      const email = (user.email ?? "").toLowerCase();
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

      // Mark this OTP used and invalidate sibling change-password OTPs for
      // this email so the code is strictly single-use.
      await admin.from("password_reset_otps").update({ used: true }).eq("id", otpRecord.id);
      await admin
        .from("password_reset_otps")
        .delete()
        .eq("email", email)
        .eq("purpose", "change_password")
        .eq("used", false);
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });

    if (updateError) {
      // Don't leak Auth provider messages verbatim.
      console.error("change-password: updateUserById failed:", updateError.message);
      return jsonResponse(
        { error: "Failed to update password" },
        500,
        corsHeaders,
      );
    }

    return jsonResponse({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error("change-password: unexpected error:", err);
    return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
  }
});
