import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";

// Regression guard: the logged-in password change flow MUST go through the
// `change-password` edge function (which enforces MFA AAL2 or email OTP) and
// MUST NOT call `supabase.auth.updateUser({ password })` directly from the
// frontend — that path fails with "AAL2 session is required..." for any user
// with MFA enabled.

const watchedFiles = [
  "src/components/settings/SecuritySection.tsx",
  "src/components/profile/PasswordSection.tsx",
];

function read(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

for (const file of watchedFiles) {
  it(`${file} does not call supabase.auth.updateUser({ password })`, () => {
    const source = read(file).replace(/\s+/g, " ");
    if (/supabase\.auth\.updateUser\(\s*\{\s*password\s*:/.test(source)) {
      throw new Error(`${file} must not call supabase.auth.updateUser({ password: ... }) directly`);
    }
  });

  it(`${file} invokes the change-password edge function`, () => {
    const source = read(file);
    if (!source.includes('"change-password"')) {
      throw new Error(`${file} must invoke the change-password edge function`);
    }
  });

  it(`${file} invokes password edge functions with an explicit refreshed user token`, () => {
    const source = read(file);
    if (!source.includes("getAuthenticatedFunctionHeaders")) {
      throw new Error(`${file} must use getAuthenticatedFunctionHeaders before password edge calls`);
    }
    if (!source.includes('"send-change-password-otp"')) {
      throw new Error(`${file} must invoke send-change-password-otp for non-MFA users`);
    }
    if (!source.includes("explicitToken?: string")) {
      throw new Error(`${file} callChangePassword must accept an optional explicit token`);
    }
    if (!/explicitToken\s*\?\s*\{\s*Authorization:\s*`Bearer \$\{explicitToken\}`\s*\}\s*:\s*await getAuthenticatedFunctionHeaders\(\)/s.test(source)) {
      throw new Error(`${file} must prefer the explicit token and retain the authenticated-header fallback`);
    }
    if ((source.match(/supabase\.auth\.getSession\(\)/g) ?? []).length < 4) {
      throw new Error(`${file} must read the latest session before each password auth step`);
    }
    if (!/callChangePassword\(\{\s*newPassword\s*\},\s*userToken\)/s.test(source)) {
      throw new Error(`${file} must pass the current user token to the initial password request`);
    }
    if (!/mfa\.verify\([\s\S]*?getSession\(\)[\s\S]*?callChangePassword\(\{\s*newPassword\s*\},\s*aal2Token\)/s.test(source)) {
      throw new Error(`${file} must pass the refreshed AAL2 token after MFA verification`);
    }
    if (!/callChangePassword\(\{\s*newPassword,\s*otp:[^}]+\},\s*userToken\)/s.test(source)) {
      throw new Error(`${file} must pass the current user token when confirming an email OTP`);
    }
    if (!/"send-change-password-otp"[\s\S]*?Authorization:\s*`Bearer \$\{userToken\}`/s.test(source)) {
      throw new Error(`${file} must pass the current user token when sending an email OTP`);
    }
    if (!source.includes("PASSWORD_SIGN_IN_MESSAGE")) {
      throw new Error(`${file} must use the friendly sign-in error when the session token is missing`);
    }
  });
}

it("authenticated function helper refreshes sessions before returning Authorization", () => {
  const src = read("src/lib/authenticatedFunction.ts");
  if (!src.includes("refreshSession")) {
    throw new Error("authenticatedFunction helper must refresh stale or missing sessions");
  }
  if (!src.includes("Authorization: `Bearer ${session.access_token}`")) {
    throw new Error("authenticatedFunction helper must return the user JWT Authorization header");
  }
  if (!src.includes("Please sign in again before changing your password.")) {
    throw new Error("authenticatedFunction helper must expose the password-flow sign-in message");
  }
});

it("password edge functions return structured auth and verification codes", () => {
  const changePassword = read("supabase/functions/change-password/index.ts");
  const sendOtp = read("supabase/functions/send-change-password-otp/index.ts");
  const rateLimiter = read("supabase/functions/_shared/rate-limiter.ts");

  for (const code of ["unauthorized", "mfa_required", "otp_required", "invalid_otp"]) {
    if (!changePassword.includes(`code: "${code}"`)) {
      throw new Error(`change-password must return code: ${code}`);
    }
  }
  if (!sendOtp.includes('code: "unauthorized"') || !sendOtp.includes('code: "mfa_required"')) {
    throw new Error("send-change-password-otp must return structured unauthorized and mfa_required codes");
  }
  if (!rateLimiter.includes('code: "rate_limited"')) {
    throw new Error("rateLimitExceededResponse must return code: rate_limited");
  }
});

it("change-password logs sanitized 401 reasons without credential data", () => {
  const source = read("supabase/functions/change-password/index.ts");
  for (const reason of [
    "change-password: 401 unauthorized - missing_authorization",
    "change-password: 401 unauthorized - invalid_user_jwt",
    "change-password: 401 unauthorized - session_not_found",
  ]) {
    if (!source.includes(`console.warn("${reason}")`)) {
      throw new Error(`change-password must log sanitized reason: ${reason}`);
    }
  }
});

it("ResetPassword uses the OTP edge functions instead of resetPasswordForEmail", () => {
  const src = read("src/pages/ResetPassword.tsx");
  if (src.includes("resetPasswordForEmail")) {
    throw new Error("ResetPassword.tsx must not use supabase.auth.resetPasswordForEmail");
  }
  if (!src.includes('"send-reset-otp"') || !src.includes('"verify-reset-otp"')) {
    throw new Error("ResetPassword.tsx must invoke send-reset-otp and verify-reset-otp");
  }
});

it("Auth page does not use the broken GoTrue resetPasswordForEmail path", () => {
  const src = read("src/pages/Auth.tsx");
  if (src.includes("resetPasswordForEmail")) {
    throw new Error("Auth.tsx must not use supabase.auth.resetPasswordForEmail; the forgot-password flow must use the OTP edge functions via PasswordResetOptions");
  }
  if (src.includes("handleForgotPassword")) {
    throw new Error("Auth.tsx must not define the dead handleForgotPassword handler");
  }
});
