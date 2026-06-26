# Runbook — Google OAuth "Unverified app" warning (Test-mode bypass)

**Date:** 2026-06-26
**Scope:** Documentation only. No code, no SQL, no env, no Edge Function redeploy, no SSH, no n8n changes.
**Audience:** Project owner / operator with access to the **Google Cloud Console → POSTORA** project.

---

## 1. What this screen means

When connecting YouTube, users see:

> "Google hasn't verified this app"

This is **not a Postora bug**. The YouTube OAuth redirect, token exchange, and callback are all working correctly (confirmed in the prior `kong:8000` redirect-leak fix).

> The warning can appear when the app is still in Testing or when the app requests sensitive/restricted scopes before the relevant OAuth verification is fully completed.

In other words:

- "Branding verified" in Google Cloud Console is **not necessarily the same** as "sensitive-scope verification completed."
- Postora's branding may already be verified while the **YouTube sensitive-scope verification** still needs to be submitted or finished.
- Either condition alone is enough for Google to keep showing the warning.

## 2. Who is affected

- Any Google account that is **not on the Test Users list** while the project is in Testing publishing status.
- This includes `dr.vet.waleedtam@gmail.com` if it has not been explicitly added as a Test User.

## 3. Add yourself and teammates as Test Users (Google Cloud Console)

> Lovable cannot perform these actions. The owner must do them manually in Google Cloud Console.

1. Open <https://console.cloud.google.com/> → select the **POSTORA** project.
2. **APIs & Services → OAuth consent screen**.
3. Confirm **Publishing status = Testing**.
4. Scroll to **Test users** → click **+ ADD USERS**.
5. Add every Gmail address that needs to connect YouTube before verification is complete (yourself, team, QA accounts). Up to 100 users allowed.
6. Click **Save**.

## 4. Bypass path for added Test Users

On the "Google hasn't verified this app" screen:

1. Click **Advanced** (bottom-left).
2. Click **Go to POSTORA (unsafe)**.
3. Complete the normal consent flow.
4. Tokens land in Postora correctly; the new YouTube account row is created in `social_accounts`.

## 5. Limits of Testing mode

- Maximum **100 test users**.
- Refresh-token expiry:
  > "For External apps in Testing, refresh tokens can expire after 7 days when requested scopes are broader than only openid/email/profile."
  Affected users may need to reconnect roughly weekly until verification is complete.
- This is why the parallel verification submission runbook (`2026-06-26-google-oauth-verification-submission-checklist.md`) should be executed in parallel.

## 6. Validation

- One real connect by a test-user Gmail.
- Confirm a new row appears in `social_accounts` with `platform = 'youtube'` and `needs_reauth = false`.
- Confirm a test video upload succeeds end-to-end.

## 7. Manual actions Lovable cannot perform

The owner must manually:

- Add Test Users in Google Cloud Console.
- Click **Advanced → Go to POSTORA (unsafe)** the first time each test user connects.

## Final status

`ready_for_real_oauth_test`
