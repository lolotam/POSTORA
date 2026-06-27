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
}

it("ResetPassword uses the OTP edge functions instead of resetPasswordForEmail", () => {
  const src = read("src/pages/ResetPassword.tsx");
  if (src.includes("resetPasswordForEmail")) {
    throw new Error("ResetPassword.tsx must not use supabase.auth.resetPasswordForEmail");
  }
  if (!src.includes('"send-reset-otp"') || !src.includes('"verify-reset-otp"')) {
    throw new Error("ResetPassword.tsx must invoke send-reset-otp and verify-reset-otp");
  }
});
