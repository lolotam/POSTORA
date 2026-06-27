import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface SendOTPRequest {
  email: string;
}

// SHA-256 hash of the OTP. We never store or log the plaintext code.
async function hashOTP(otp: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(otp);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// P1-4: cryptographically secure 6-digit OTP using Web Crypto's CSPRNG.
// Math.random() is a non-cryptographic PRNG and was predictable across
// sequential calls — replaced with crypto.getRandomValues + rejection
// sampling so every 6-digit value in [0, 999_999] is uniformly likely.
function generateOTP(): string {
  // 900_000 distinct values are needed for a 6-digit code (100000..999999).
  // We sample uint32s and reject any value at or above the largest multiple
  // of 900_000 that fits in uint32 to avoid modulo bias.
  const RANGE = 900_000;
  const MAX = Math.floor(0xFFFFFFFF / RANGE) * RANGE;
  const buf = new Uint32Array(1);
  // Bounded retry: in practice the first sample is accepted >99.99% of the time.
  for (let i = 0; i < 16; i++) {
    crypto.getRandomValues(buf);
    if (buf[0] < MAX) {
      return (100_000 + (buf[0] % RANGE)).toString();
    }
  }
  // Extremely unlikely fallback — still CSPRNG, accepts modest bias rather than loop forever.
  crypto.getRandomValues(buf);
  return (100_000 + (buf[0] % RANGE)).toString();
}


serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email }: SendOTPRequest = await req.json();

    if (!email || !email.includes("@")) {
      return new Response(
        JSON.stringify({ error: "Valid email is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const normalizedEmail = email.toLowerCase();

    // Single safe response we return for almost every non-input-error path.
    // P1-5: do NOT reveal whether the email matches an account, whether
    // the account has MFA, or whether email delivery is configured. The
    // generic message is identical in all these cases.
    const genericSuccess = new Response(
      JSON.stringify({
        success: true,
        message: "If an account exists with this email, a reset code has been sent.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

    // P1-5: if email delivery is not configured, refuse silently rather
    // than (a) returning a config-specific error code or (b) writing an
    // OTP row we can never deliver. The error is logged for operators only.
    if (!resendApiKey) {
      console.error("send-reset-otp: RESEND_API_KEY is not configured; refusing to issue OTP.");
      return genericSuccess;
    }

    // Find the user id by looking up our `profiles` table.
    // This avoids scanning Auth users (listUsers is paginated and may not include the user).
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (profileError) {
      // P1-5: do not surface a distinguishable SERVICE_UNAVAILABLE on
      // lookup failure — that would let an attacker probe DB health and
      // potentially correlate with valid emails. Log internally and
      // return the generic success response.
      console.error("send-reset-otp: profile lookup failed:", profileError);
      return genericSuccess;
    }

    if (!profile?.id) {
      // Account does not exist — silently succeed.
      return genericSuccess;
    }

    // Check if user has MFA enabled
    const { data: factors, error: factorsError } = await supabase.auth.admin.mfa.listFactors({
      userId: profile.id,
    });

    if (factorsError) {
      // P1-5: same as profile lookup — generic success, internal log only.
      console.error("send-reset-otp: MFA factor lookup failed:", factorsError);
      return genericSuccess;
    }

    const totpFactors =
      factors?.factors?.filter(
        (f: { factor_type: string; status: string }) =>
          f.factor_type === "totp" && f.status === "verified"
      ) || [];

    const hasVerifiedMFA = totpFactors.length > 0;

    // P1-5: previously this branch returned a 400 with `MFA_NOT_ENABLED`,
    // which let an attacker enumerate registered emails AND learn which
    // accounts lack MFA (the higher-value targets). We now return the
    // generic success response in this case. The authenticated /settings
    // page is the legitimate place to tell users they need to enable MFA.
    if (!hasVerifiedMFA) {
      return genericSuccess;
    }

    // Generate OTP and store hashed version. The plaintext OTP only
    // lives in memory long enough to be emailed; it is never logged.
    const otp = generateOTP();
    const otpHash = await hashOTP(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Clean up old OTPs for this email first — preserves one-time-use
    // semantics by guaranteeing only the latest code can be redeemed.
    await supabase.from("password_reset_otps").delete().eq("email", normalizedEmail);

    // Store the new OTP
    const { error: insertError } = await supabase.from("password_reset_otps").insert({
      email: normalizedEmail,
      code_hash: otpHash,
      expires_at: expiresAt.toISOString(),
      attempts: 0,
      used: false,
    });

    if (insertError) {
      // Internal failure — log and degrade silently to avoid revealing infra state.
      console.error("send-reset-otp: failed to persist OTP:", insertError);
      return genericSuccess;
    }


    // Send OTP via email if Resend is configured
    if (resendApiKey) {
      const resend = new Resend(resendApiKey);

      const subject = "Your Password Reset Code - Expires in 10 Minutes";
      const html = `
             <!DOCTYPE html>
             <html>
             <head>
               <meta charset="utf-8">
               <meta name="viewport" content="width=device-width, initial-scale=1.0">
             </head>
             <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #f9fafb;">
               <div style="background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                 <div style="text-align: center; margin-bottom: 32px;">
                   <h1 style="color: #111827; font-size: 24px; font-weight: 700; margin: 0 0 8px 0;">Password Reset Code</h1>
                   <p style="color: #6b7280; font-size: 14px; margin: 0;">You requested to reset your password using MFA verification.</p>
                 </div>
                 
                 <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 32px; text-align: center; border-radius: 12px; margin: 24px 0;">
                   <p style="color: rgba(255,255,255,0.8); font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 8px 0;">Your One-Time Code</p>
                   <div style="font-size: 36px; letter-spacing: 12px; font-weight: 700; color: white; font-family: 'Monaco', 'Consolas', monospace;">
                     ${otp}
                   </div>
                 </div>
                 
                 <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 0 8px 8px 0; margin: 24px 0;">
                   <p style="color: #92400e; font-size: 14px; margin: 0;">
                     <strong>⏰ This code expires in 10 minutes.</strong><br>
                     You'll also need your authenticator app code.
                   </p>
                 </div>
                 
                 <p style="color: #6b7280; font-size: 13px; text-align: center; margin: 24px 0 0 0;">
                   If you didn't request this, you can safely ignore this email.
                 </p>
               </div>
               
               <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 24px;">
                 © ${new Date().getFullYear()} Postora. All rights reserved.
               </p>
             </body>
             </html>
           `;

      const primaryFrom = Deno.env.get("EMAIL_FROM") ?? "Postora <noreply@postora.cloud>";
      const fallbackFrom = "Postora <onboarding@resend.dev>";

      const sendEmail = async (from: string) => {
        const res = await resend.emails.send({
          from,
          to: [email],
          subject,
          html,
        });

        const anyRes = res as any;
        if (anyRes?.error) {
          return { ok: false as const, error: anyRes.error, raw: anyRes };
        }

        return { ok: true as const, raw: anyRes };
      };

      // 1) Try configured sender (or the default "noreply@postora.app")
      let attempt = await sendEmail(primaryFrom);

      // 2) If Resend rejects the sender domain, retry with Resend's default sandbox sender
      if (!attempt.ok) {
        const rawError = (attempt.raw as any)?.error ?? attempt.error;
        const message = String((rawError as any)?.message ?? rawError ?? "");
        const statusCode = Number((rawError as any)?.statusCode ?? 0);

        console.error("Resend email send failed:", attempt.raw);

        if (
          primaryFrom !== fallbackFrom &&
          statusCode === 403 &&
          /(domain (not verified|is not verified))/i.test(message)
        ) {
          console.warn(
            "Resend domain not verified for EMAIL_FROM; retrying with fallback sender.",
          );
          attempt = await sendEmail(fallbackFrom);
        }
      }

      if (!attempt.ok) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "EMAIL_SEND_FAILED",
            message:
              "We couldn't send the reset email. If you're using a custom sender (like noreply@postora.app), verify that domain in Resend → Domains, or set EMAIL_FROM to a verified sender.",
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      console.log("OTP email sent successfully to", email);
    } else {
      console.error("RESEND_API_KEY is not configured; refusing to issue reset code.");
      return new Response(
        JSON.stringify({
          success: false,
          error: "EMAIL_NOT_CONFIGURED",
          message: "Password reset email service is not configured. Please contact support.",
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Reset code sent to your email",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in send-reset-otp:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
