import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { restrictedCorsHeaders } from "../_shared/cors.ts";

// verify-reset-otp
// ---------------------------------------------------------------------------
// Verifies a forgot-password OTP issued by send-reset-otp and updates the
// account password server-side using the service role. MFA code is REQUIRED
// only when the account has a verified TOTP factor; otherwise the OTP alone
// proves email control and is accepted.
//
// Response is generic ("Invalid or expired reset code") whenever lookup fails
// to avoid email or MFA-enrollment enumeration.
// ---------------------------------------------------------------------------

interface VerifyOTPRequest {
  email?: unknown;
  otp?: unknown;
  mfaCode?: unknown;
  newPassword?: unknown;
}

async function hashOTP(otp: string): Promise<string> {
  const data = new TextEncoder().encode(otp);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

const GENERIC_INVALID = "Invalid or expired reset code";

serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as VerifyOTPRequest;

    const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";
    const mfaCodeRaw = typeof body.mfaCode === "string" ? body.mfaCode.trim() : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    if (!email || !email.includes("@") || !/^\d{6}$/.test(otp) || newPassword.length < 8) {
      return jsonResponse(
        { error: "Email, 6-digit code and new password (min 8 chars) are required" },
        400,
        corsHeaders,
      );
    }

    if (mfaCodeRaw && !/^\d{6}$/.test(mfaCodeRaw)) {
      return jsonResponse({ error: "MFA code must be 6 digits" }, 400, corsHeaders);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    const otpHash = await hashOTP(otp);
    const { data: otpRecord, error: otpError } = await admin
      .from("password_reset_otps")
      .select("id, expires_at, attempts, used, purpose")
      .eq("email", email)
      .eq("purpose", "reset")
      .eq("code_hash", otpHash)
      .eq("used", false)
      .maybeSingle();

    if (otpError || !otpRecord) {
      return jsonResponse({ error: GENERIC_INVALID }, 400, corsHeaders);
    }

    if (new Date(otpRecord.expires_at as string) < new Date()) {
      await admin.from("password_reset_otps").delete().eq("id", otpRecord.id);
      return jsonResponse({ error: GENERIC_INVALID }, 400, corsHeaders);
    }

    if ((otpRecord.attempts ?? 0) >= 5) {
      await admin.from("password_reset_otps").delete().eq("id", otpRecord.id);
      return jsonResponse(
        { error: "Too many failed attempts. Request a new code." },
        400,
        corsHeaders,
      );
    }

    await admin
      .from("password_reset_otps")
      .update({ attempts: (otpRecord.attempts ?? 0) + 1 })
      .eq("id", otpRecord.id);

    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (!profile?.id) {
      // OTP was valid but account vanished — still keep generic message.
      return jsonResponse({ error: GENERIC_INVALID }, 400, corsHeaders);
    }
    const userId = profile.id;

    const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId });
    const verifiedFactor = factors?.factors?.find(
      (f: { factor_type: string; status: string }) =>
        f.factor_type === "totp" && f.status === "verified",
    );

    if (verifiedFactor) {
      if (!mfaCodeRaw) {
        // Tell the frontend to show the authenticator field — but only after a
        // valid email OTP has been presented, so this does not leak MFA status
        // to attackers spraying OTPs.
        return jsonResponse(
          { error: "MFA code required", code: "mfa_required" },
          401,
          corsHeaders,
        );
      }

      const challengeResponse = await fetch(
        `${supabaseUrl}/auth/v1/factors/${verifiedFactor.id}/challenge`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({}),
        },
      );
      if (!challengeResponse.ok) {
        await challengeResponse.text();
        console.error("verify-reset-otp: MFA challenge failed", challengeResponse.status);
        return jsonResponse(
          { error: "MFA verification is temporarily unavailable" },
          502,
          corsHeaders,
        );
      }
      const challengeData = await challengeResponse.json();
      const verifyResponse = await fetch(
        `${supabaseUrl}/auth/v1/factors/${verifiedFactor.id}/verify`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ challenge_id: challengeData.id, code: mfaCodeRaw }),
        },
      );
      if (!verifyResponse.ok) {
        await verifyResponse.text();
        return jsonResponse(
          { error: "Invalid MFA code. Check your authenticator app." },
          400,
          corsHeaders,
        );
      }
    }

    await admin.from("password_reset_otps").update({ used: true }).eq("id", otpRecord.id);
    await admin
      .from("password_reset_otps")
      .delete()
      .eq("email", email)
      .eq("purpose", "reset")
      .eq("used", false);

    const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (updateError) {
      console.error("verify-reset-otp: updateUserById failed:", updateError.message);
      return jsonResponse({ error: "Failed to update password" }, 500, corsHeaders);
    }

    // Best-effort housekeeping. This runs AFTER the password is already
    // changed, so it must never be able to fail the request: `rpc()` returns a
    // PostgrestBuilder (a `PromiseLike` with `then` only, no `catch`), so the
    // former `.catch(...)` threw a synchronous TypeError and turned every
    // successful reset into a 500.
    try {
      // PostgREST resolves with `{ data, error }` rather than rejecting, so a
      // SQL-level failure only shows up in `error`; the catch covers transport
      // failures. Either way the reset itself already succeeded.
      const { error: cleanupError } = await admin.rpc("cleanup_expired_otps");
      if (cleanupError) {
        console.error("verify-reset-otp: cleanup_expired_otps failed (ignored):", cleanupError.message);
      }
    } catch (cleanupThrow) {
      console.error("verify-reset-otp: cleanup_expired_otps threw (ignored):", cleanupThrow);
    }

    return jsonResponse(
      { success: true, message: "Password reset successfully." },
      200,
      corsHeaders,
    );
  } catch (err) {
    console.error("verify-reset-otp: unexpected error:", err);
    return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
  }
});
