# Brandora-style review shell for non-admin users (branch `ccr-f0848f64-lbmmrr`)

Reference: `docs/brandora-clone-spec.md` (UI captured from app.brandora.ai, 2026-10-14).
Branch rule: this branch is never merged into `main`; push only to `origin/ccr-f0848f64-lbmmrr`.

## Decisions (owner, 2026-10-14)
- Non-admin users get a new shell: Approvals, Calendar, Activity, Integrations, Workspace. No AI-agent pages.
- Admins keep the current UI exactly as it is today (top nav, current theme, all pages).
- Visual language matches Brandora: Nunito Sans, paper/ink/tomato/mint palette, black active sidebar pill. Name and logo stay Postora. UI copy follows Brandora's wording where it applies.
- "Approve" without a time parks the post in **Needs scheduling** (new backend state), as in Brandora.
- Approvals items are created by the user ("New post": video + caption).

## Phase 1 — Shell and theme
- `ReviewShell` layout: 256px sidebar (paper-warm), content on paper. Sidebar: Postora logo tile + wordmark, collapse button, groups `PIPELINE` (Activity, Calendar + badge, Approvals + badge) and `SETTINGS` (Workspace, Integrations), footer user menu (Switch workspace omitted; Account settings, Log out).
- Theme tokens scoped by `data-shell="review"` on `<html>` (set by the layout once the role is known), not a wrapper div — Radix popovers/selects/dialogs portal to `body` and must pick up the review tokens too. Admin screens keep the current theme. Nunito Sans loaded from Google Fonts.
- Render a neutral loading state until `useUserRole` resolves, so the shell never flashes between admin and review.
- Sidebar footer keeps a Pricing entry point (Brandora's trial card → "Upgrade" → `/pricing`). History is dropped for non-admins (Activity replaces it).
- Shared pipeline header: eyebrow `PIPELINE`, H1, subtitle, tabs ACTIVITY / CALENDAR (count) / APPROVALS (count).
- Routing: non-admin signed-in home → `/approvals`. Non-admins hitting admin-only routes (dashboard, create post, etc.) redirect to `/approvals`. Admin routing unchanged.

## Phase 2 — DROPPED (owner, 2026-10-14: frontend only, no backend deploy)
Dokploy serves this branch's frontend only. Approve = submit `mode:"now"`; Schedule = submit `mode:"scheduled"`. Approvals "Approved" filter = drafts in `submitted`. No "Needs scheduling" panel/state; Calendar shows scheduled / published / failed submissions. The original design below is kept for reference only.

### (reference) Backend: `approved` state
- Migration: add `approved` to `tiktok_review_drafts.state`; `tiktok_review_transition` gains `approve` (pending_review → approved; requires account, saved settings, media, consent) and `unapprove` (approved → pending_review, "Undo — return to pending").
- Consent lives on the draft: `approve` records `approved_account_id`, `approved_at`, `consented_at` (new nullable columns). `unapprove` and any `save` clear them.
- `tiktok_review_submit` accepts drafts in `pending_review` (consent in the request, as today) or `approved` (stored consent is reused). The Calendar "Schedule…" popover still shows the Music Usage Confirmation line next to its Schedule button.
- Verified 2026-10-14: the current `tiktok-review` function and `tiktok_review_*` tables are already live on the self-hosted stack (files match `HEAD`), so the UI can be exercised locally before Phase 2 lands.
- Edge function `tiktok-review`: new actions `approve`, `unapprove`; `list` accepts `approved`. Tests extended (handler + SQL lifecycle tests).
- Deploy: migration applied and function redeployed to the self-hosted stack per `docs/runbooks/deploy-edge-function.md`, only when the owner says so.

## Phase 3 — Approvals (primary)
Two columns: list (360px) + detail card. Mirrors spec §3:
- Filters STATUS (Pending / Approved / Rejected / All) via `?tab=`, `?item=` deep link, × CLEAR. No AGENT filter (no agents).
- List rows: checkbox (Pending only), TikTok tile, title (first caption line), meta (`TIKTOK` · scheduled time), status pill. Bulk bar: Approve, Archive, × Clear.
- Detail: header tag (Awaiting review / Needs scheduling / Scheduled / Published / Publish failed), Post preview card (account avatar + name, caption, video, Download, Remove video, Change), Edit caption editor (POST TEXT counter, HASHTAGS, VIDEO, Cancel / Save changes), facts row (Scheduled, Type, Length, TikTok summary).
- Publish panel: Publish from (connected TikTok accounts), Publish at (datetime + Now / In 1 hour / Tomorrow 9:00), footer Reject (reason panel → Confirm reject), Edit, Archive, "⋯" TikTok settings popover with red attention dot, Approve and Schedule disabled until an account is chosen.
- "⋯" popover keeps every TikTok compliance rule already on this branch: privacy options from creator_info with no default, comments/Duet/Stitch off by default (Duet/Stitch disabled for photo), commercial disclosure with Your brand / Branded content (branded content cannot be Only me), AI-generated toggle, Music Usage Confirmation consent + processing notice next to Approve/Schedule.
- Needs scheduling state: banner "Approved. Schedule this post to publish it." + "Schedule in Calendar", "Undo — return to pending". Failed: "Back to pending" (existing reopen rules).

## Phase 4 — Calendar and Activity
- Calendar: month/week/day (`?date=`, `&view=`), TODAY / prev / next, Needs scheduling panel with "Schedule…" popover, chips (published = ink, failed = tomato), chip popover (Open, error code, Retry at → Reschedule, Back to pending). Drag-to-schedule from the panel.
- Activity: one list of all drafts, STATUS filter with counts, rows expand to preview, "Open" deep-links into Approvals.

## Phase 5 — Integrations and Workspace
- Integrations: CONNECTED ACCOUNTS list (Connected pill, × disconnect), TikTok card (Connect your TikTok account / Add another TikTok) reusing `tiktok-oauth`; other channels shown as "SOON".
- Workspace: account name/email/timezone (existing profile data).

## Out of scope for now
- Field-level activity diff log (needs an events table) — follow-up if wanted.
- AI rationale ("Why Vee made this"), agent filter, confidence score.

## Verification
- `npm run lint`, `npx tsc --noEmit`, `npm test`, Deno tests for `tiktok-review`, SQL lifecycle tests.
- Manual run on `localhost:8090` as a non-admin and as an admin (admin must look unchanged).
