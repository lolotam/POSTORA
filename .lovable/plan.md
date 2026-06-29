## Scope

Close the four remaining gaps from the refined E2E plan. UI/frontend/test only. No SQL, no Edge Function changes, no n8n changes, no secrets.

---

### 1. Safe admin checkout — `src/components/pricing/PlanCard.tsx`

Replace the active "Preview checkout (admin)" CTA on paid plans with a non-clickable admin state:

- Disabled badge: **"Admin — full access"** in place of the upgrade button.
- Helper copy: *"To test checkout, sign in with a non-admin test account."*
- Small admin-only text link to `/admin/plans`.
- Free plan and non-admin users keep the existing CTA + `onSelect` flow unchanged — no behavioral change for real customers, and no path for an admin to trigger a real `stripe-checkout` invocation from the pricing card.

### 2. Instagram comments error regression — `src/hooks/useCommentInbox.ts` + new `src/hooks/__tests__/useCommentInbox.test.ts`

Update the object-shaped error extraction in `useCommentInbox.ts` to the order:
`error_user_msg → message → error.message → error_description → JSON.stringify` (currently `message → error_user_msg → error_user_title → JSON.stringify`).

Add a Vitest test file mocking `supabase.functions.invoke` with four payloads:

1. `{ error: { error_user_msg: "Reconnect required" } }` → thrown `.message === "Reconnect required"`.
2. `{ error: { message: "Token expired" } }` → `"Token expired"`.
3. `{ error: { error_description: "Bad scope" } }` → `"Bad scope"`.
4. `{ error: { weird: "shape" } }` → JSON string fallback, asserts not equal to `"[object Object]"`.

Test must not log or assert against tokens/auth headers.

### 3. 2FA add-authenticator clarity — `src/components/settings/SecuritySection.tsx`

- Change the enrollment dialog title from `Set Up Two-Factor Authentication` to a dynamic value: `Add another authenticator app` when at least one **verified** factor exists, otherwise keep `Set Up Two-Factor Authentication`.
- Add a small line under the dialog description showing the count of verified factors when ≥1 (e.g. *"You already have 1 verified authenticator."*).
- Keep existing QR + verify flow, backup-code behavior, unenroll guardrails, and the existing unverified-only cleanup in `handleStartMfaEnrollment` untouched.

### 4. Validation + final report

- Run `npm run build || true`, `npm run lint || true`, `npx vitest run || true`, `git diff --check || true`.
- Greps for `[object Object]` and for `access_token|refresh_token|service_role|SUPABASE_SERVICE_ROLE_KEY|Authorization` across `src` and `supabase/functions`.
- CleanCodeGuard pass on the three production files; TestGuard on the new test file.
- Produce the **E2E Findings Fix Report** with all 15 sections. Section 11 will be marked *not run — external runner unavailable* and list the 7 E2E test names exactly.
- Final status: **`e2e_findings_fixed_requires_frontend_deploy_and_env_update`**, and explicitly mention `facebook_analytics_requires_env_update` because `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` are still owner-action.

---

## Files changed

- `src/components/pricing/PlanCard.tsx`
- `src/hooks/useCommentInbox.ts`
- `src/hooks/__tests__/useCommentInbox.test.ts` (new)
- `src/components/settings/SecuritySection.tsx`

## SQL changes

None expected. If any surface, I stop and report before writing a migration.

## Security

No secrets, tokens, OTPs, service-role keys, passwords, or provider credentials read, printed, logged, or committed. Restricted CORS, redactor, rate limiting, MFA/backup-code logic untouched.

## Out of scope

Edge Function changes, n8n changes, real Stripe simulation, Facebook credentials provisioning, executing the external E2E runner.
