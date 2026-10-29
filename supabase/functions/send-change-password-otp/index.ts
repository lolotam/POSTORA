// send-change-password-otp
// ---------------------------------------------------------------------------
// Issues a 6-digit email OTP for the logged-in user when they need to change
// their password and DO NOT have a verified MFA factor. Users with MFA must
// use the AAL2 path on /functions/v1/change-password instead.
// ---------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import {
  checkUserRateLimit,
  rateLimitExceededResponse,
} from "../_shared/rate-limiter.ts";
import { describeResendFailure, resendFailureLog } from "../_shared/resendFailure.ts";

async function hashOTP(otp: string): Promise<string> {
  const data = new TextEncoder().encode(otp);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateOTP(): string {
  const RANGE = 900_000;
  const MAX = Math.floor(0xFFFFFFFF / RANGE) * RANGE;
  const buf = new Uint32Array(1);
  for (let i = 0; i < 16; i++) {
    crypto.getRandomValues(buf);
    if (buf[0] < MAX) return (100_000 + (buf[0] % RANGE)).toString();
  }
  crypto.getRandomValues(buf);
  return (100_000 + (buf[0] % RANGE)).toString();
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
      return jsonResponse({ error: "Unauthorized", code: "unauthorized" }, 401, corsHeaders);
    }
    const jwt = authHeader.slice(7).trim();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user?.email) {
      return jsonResponse({ error: "Unauthorized", code: "unauthorized" }, 401, corsHeaders);
    }
    const user = userData.user;

    // 3 sends per hour per user is plenty for legitimate flows and blocks abuse.
    const rl = await checkUserRateLimit(admin, "send-change-password-otp", user.id, 3, 3600);
    if (!rl.allowed) {
      return rateLimitExceededResponse(rl, corsHeaders);
    }

    const { data: factorList } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
    const hasVerifiedMfa = (factorList?.factors ?? []).some(
      (f: { factor_type: string; status: string }) =>
        f.factor_type === "totp" && f.status === "verified",
    );

    if (hasVerifiedMfa) {
      // Explicit machine code — the frontend should switch to the MFA branch.
      return jsonResponse(
        { error: "MFA is enabled — verify with your authenticator instead.", code: "mfa_required" },
        409,
        corsHeaders,
      );
    }

    if (!resendApiKey) {
      console.error("send-change-password-otp: RESEND_API_KEY missing");
      return jsonResponse({ error: "Email delivery is not configured" }, 503, corsHeaders);
    }

    const email = user.email.toLowerCase();
    const otp = generateOTP();
    const otpHash = await hashOTP(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Invalidate any prior change_password OTPs for this email first.
    await admin
      .from("password_reset_otps")
      .delete()
      .eq("email", email)
      .eq("purpose", "change_password");

    const { error: insertError } = await admin.from("password_reset_otps").insert({
      email,
      code_hash: otpHash,
      expires_at: expiresAt.toISOString(),
      attempts: 0,
      used: false,
      purpose: "change_password",
    });

    if (insertError) {
      console.error("send-change-password-otp: insert failed:", insertError.message);
      return jsonResponse({ error: "Could not issue verification code" }, 500, corsHeaders);
    }

    const resend = new Resend(resendApiKey);
    const subject = "Confirm your password change";
    const html = `
      <!DOCTYPE html>
      <html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;background:#f9fafb;">
        <div style="background:white;border-radius:16px;padding:40px;box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.1);">
          <h1 style="color:#111827;font-size:22px;margin:0 0 8px 0;">Confirm your password change</h1>
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px 0;">Use this one-time code to authorise the password change you requested in Postora.</p>
          <div style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:32px;text-align:center;border-radius:12px;margin:16px 0;">
            <p style="color:rgba(255,255,255,0.8);font-size:12px;text-transform:uppercase;letter-spacing:2px;margin:0 0 8px 0;">Your code</p>
            <div style="font-size:36px;letter-spacing:12px;font-weight:700;color:white;font-family:Monaco,Consolas,monospace;">${otp}</div>
          </div>
          <p style="color:#6b7280;font-size:13px;margin:16px 0 0 0;">This code expires in 10 minutes. If you didn't request a password change you can ignore this email.</p>
        </div>
        <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:24px;">© ${new Date().getFullYear()} Postora.</p>
      </body></html>`;

    const primaryFrom = Deno.env.get("EMAIL_FROM") ?? "Postora <noreply@postora.cloud>";
    const fallbackFrom = "Postora <onboarding@resend.dev>";

    const send = async (from: string) => {
      const res = await resend.emails.send({ from, to: [user.email!], subject, html });
      const any = res as unknown as { error?: { message?: string; statusCode?: number } };
      return any?.error ? { ok: false as const, error: any.error } : { ok: true as const };
    };

    let attempt = await send(primaryFrom);
    if (!attempt.ok) {
      const msg = String(attempt.error?.message ?? "");
      if (
        primaryFrom !== fallbackFrom &&
        Number(attempt.error?.statusCode) === 403 &&
        /domain (not verified|is not verified)/i.test(msg)
      ) {
        attempt = await send(fallbackFrom);
      }
    }
    if (!attempt.ok) {
      console.error(resendFailureLog("send-change-password-otp", describeResendFailure(attempt.error)));
      return jsonResponse({ error: "Could not send verification email" }, 502, corsHeaders);
    }

    return jsonResponse({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error("send-change-password-otp: unexpected error:", err);
    return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
  }
});
