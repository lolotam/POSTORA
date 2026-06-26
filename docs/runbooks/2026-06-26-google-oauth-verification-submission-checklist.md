# Runbook — Google OAuth Verification Submission Checklist (YouTube scopes)

**Date:** 2026-06-26
**Scope:** Documentation only. No code, no SQL, no env, no Edge Function redeploy, no SSH, no n8n changes.
**Audience:** Project owner / operator with access to **Google Cloud Console → POSTORA**, DNS for `postora.cloud`, and a Google account that can record an unlisted YouTube demo video.

---

## 0. Important — what Lovable cannot do

Lovable cannot perform any Google Cloud Console action. The owner must manually:

- Add / remove Test Users.
- Publish the app (Testing → In production).
- Submit for verification.
- Upload the demo video and paste its URL into the form.
- Fill in scope justifications.
- Verify domain ownership in Search Console.
- Respond to Google reviewer emails — **within 7 days** of each message, or the request is closed and must be restarted.

This document is the checklist the owner follows; Lovable will not execute any of it.

---

## 1. Pre-flight (must all be true before submitting)

- [ ] Publishing status: **In production** (after clicking PUBLISH APP).
- [ ] App name: `POSTORA`.
- [ ] User support email + Developer contact email set.
- [ ] App logo: 120×120 PNG, no copyrighted marks.
- [ ] App homepage: `https://postora.cloud` — must be reachable and on the verified domain.
- [ ] Privacy policy URL: `https://postora.cloud/privacy` — must explicitly mention YouTube / Google user data, the Limited Use disclosure, and the data-deletion path.
- [ ] Terms of service URL: `https://postora.cloud/terms`.
- [ ] Authorized domain: `postora.cloud` — verified in Google Search Console under the **same Google account that owns the Cloud project**.

> Reminder: "Branding verified" alone is **not** enough. The YouTube sensitive-scope verification is a separate review and must be completed before the unverified-app warning disappears for all users.

---

## 2. Confirm actual requested scopes from code

Before filling the verification form, open `supabase/functions/youtube-oauth/index.ts` and confirm the OAuth authorize URL requests **only**:

- `https://www.googleapis.com/auth/youtube.readonly`
- `https://www.googleapis.com/auth/youtube.upload`
- `openid email profile` — **only if actually needed** to identify the connecting Google account

It MUST NOT request the broad scope:

- `https://www.googleapis.com/auth/youtube` ❌ (do not request)

If the broad `youtube` scope is present, narrow it before submitting — Google will reject or down-scope the verification otherwise.

---

## 3. Scope justifications (drop-in copy)

Paste one paragraph per sensitive scope into the verification form.

**`youtube.readonly`** — Used at OAuth connect time to list the user's YouTube channels so the user can pick which channel to link to Postora, and to display channel name / avatar in the dashboard. Read-only. Called from `supabase/functions/youtube-oauth/index.ts`.

**`youtube.upload`** — Used to upload scheduled videos and Shorts to the user's chosen channel on their behalf, with metadata (title, description, privacy) the user entered in Postora. Called from the publishing pipeline. Tokens are stored encrypted in the `social_accounts` table, row-level-secured by `auth.uid()`.

---

## 4. Demo video requirements

Google rejects submissions without a compliant demo. Record an **unlisted YouTube video, under 5 minutes**, showing:

1. Postora dashboard → "Connect YouTube" button.
2. Google consent screen with **all requested scopes visible** on screen.
3. User grants consent.
4. Redirect back to Postora; new channel appears in the UI.
5. Each sensitive scope exercised:
   - `youtube.readonly` — channel list / channel info displayed.
   - `youtube.upload` — a real test video upload completing.
6. Revoke access from <https://myaccount.google.com/permissions> and show the account disappears / is marked needs-reauth in Postora.

Paste the unlisted video URL into the verification form.

---

## 5. YouTube API Services compliance (separate from OAuth review)

Postora is also subject to the YouTube API Services Terms. The YouTube reviewer typically asks for:

- Link to the **YouTube API Services Terms** in the privacy policy.
- A clear **data retention statement** for YouTube-derived data.
- A **user-data-deletion path** (e.g. "Disconnect YouTube" button + contact email).
- Completion of the YouTube **API audit form** when requested.

---

## 6. Submission form

In Google Cloud Console:

1. **APIs & Services → OAuth consent screen**.
2. **PUBLISH APP** → confirm.
3. **PREPARE FOR VERIFICATION** → fill every field.
4. **SUBMIT FOR VERIFICATION**.

Expect:
- Automated confirmation email within hours.
- Human reviewer email within ~4–6 weeks, often with clarification questions.
- **Respond within 7 days** of each reviewer email or the request is closed.

---

## 7. What changes after approval

- "Google hasn't verified this app" warning disappears for all users.
- 7-day refresh-token expiry for External-Testing apps no longer applies.
- 100 test-user cap removed.
- Branding fields lock — changing them later re-triggers review.

---

## 8. Rejection recovery (common reasons + one-line fix)

- **Homepage not reachable** — confirm `https://postora.cloud` returns 200 from a clean browser.
- **Demo video missing a scope** — re-record showing every requested scope being exercised.
- **Privacy policy doesn't mention YouTube data** — add the YouTube / Limited Use section, redeploy `/privacy`.
- **Domain not verified** — re-verify `postora.cloud` in Search Console under the Cloud-project-owner Google account.
- **Broad `youtube` scope present** — narrow to `youtube.readonly` + `youtube.upload` (see §2) and resubmit.

---

## 9. Manual actions Lovable cannot perform

All actions in §1, §4, §5, §6, §8 are manual Google Cloud Console / DNS / video-recording tasks for the owner.

## Final status

`ready_for_provider_console_update`
