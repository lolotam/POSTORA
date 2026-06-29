## Scope

Fix the 7 issues surfaced by the automated test run. Group by area, smallest-impact changes first, UI/presentation only where possible.

---

## 1. Instagram comments show `[object Object]`

**File:** `src/components/comments/CommentManagerPanel.tsx` (+ light touch in `src/hooks/useCommentInbox.ts`)

- The error render path stringifies `commentsError instanceof Error ? .message : "..."`, but `useCommentInbox` throws `new Error(String(data.error || ...))` where `data.error` can be an object → becomes `[object Object]`.
- Fix: in `useCommentInbox.ts`, serialize non-string errors with `JSON.stringify` (or extract `.message`/`.error_user_msg`) before constructing the `Error`.
- Add a friendly fallback in `CommentManagerPanel` for the most common Meta errors (missing permission, token expired) — reuse existing amber reconnect banner.

## 2. 2FA — no "Add authenticator" once one exists

**File:** `src/components/settings/SecuritySection.tsx`

- Always render an "Add authenticator" button (not hidden after first enrollment). Clicking it opens the existing enroll flow (QR + verify) and supports a friendly name so multiple TOTP factors can coexist.
- Keep existing list of factors with remove/verify actions.

## 3. Billing — admin sees no checkout CTA

**Files:** `src/pages/Pricing.tsx`, `src/components/settings/SubscriptionSection.tsx`

- Replace disabled "You have admin access" CTA with a clear admin badge + a secondary "Preview checkout as user" / "Simulate upgrade" link, so the flow is reachable.
- For non-admin users the standard checkout CTA stays unchanged.
- Make copy explicit: "Admins have full access — billing controls are hidden. Switch to a test account to run checkout."

## 4. Admin plan management not discoverable

**Files:** `src/components/settings/SubscriptionSection.tsx` (+ link to existing `/admin/plans` if present, otherwise expose it)

- When `useUserRole` returns `admin`, render an "Manage subscription plans" panel with a direct link/button to `/admin/plans` and inline Create/Edit shortcuts.
- No new backend; reuses existing `useSubscriptionPlans` CRUD hooks.

## 5. `/threads` returns 404

**Files:** `src/App.tsx` (route), possibly new `src/pages/ThreadsDiscovery.tsx`

- Option A (preferred, minimal): add a `/threads` route that renders the existing Threads discovery panel (the same one Analyze uses via `useThreadsLiveDiscovery`).
- Option B: remove the dead nav link if one exists. We'll do A so the feature is reachable.

## 6 & 7. Facebook analytics — credentials not configured

**Files:** analytics page(s) under `src/pages/analytics/` and the credential-check component

- This is environment, not code — `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET` aren't set in this env.
- UI change: replace the blunt "Contact support" text + disabled Analyze with a setup callout that explains the missing config and (for admins) links to `/admin/settings` or the App Credentials Manager so the keys can be added. Non-admins see a clearer "feature unavailable in this environment" message.
- No secrets are added by this plan — owner must set them in production `.env` per project rules.

---

## Out of scope

- Backend/edge-function changes (none required).
- Database migrations (none required).
- Actually provisioning Facebook credentials (owner action).

## Validation

After build, rerun the 7 named tests. Manually verify in preview: comment error renders readable text, Security shows "Add authenticator", Pricing/Subscription admin copy is clear, `/admin/plans` reachable from Subscription, `/threads` loads discovery, FB analytics shows setup callout instead of dead text.

## Final status

`completed` for items 1–6; item 7 will be `completed_requires_env_update` because the Facebook credentials must be added to the self-hosted `.env` by the owner.
