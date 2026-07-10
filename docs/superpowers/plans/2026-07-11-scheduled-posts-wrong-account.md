# Plan: Scheduled Posts Disappear — Wrong Account Logged In

## Issue
User reported that all previously scheduled posts disappeared from the `/scheduled` page at `https://postora.cloud/scheduled`. The page shows "No scheduled posts" even though 20 posts with `status='scheduled'` exist in the database.

## Root Cause (Confirmed)

**The 20 scheduled posts belong to the ADMIN account `dr.vet.waleedtam@gmail.com` (user_id: `7fe4d34e-1975-46fb-9dac-9c2df7a9eed6`), NOT to the xsellpointkw account.**

User confirmed via chat: "the account I am logged in is xsellpointkw@gmail.com".

### Evidence
1. **20 posts** with `status='scheduled'` exist in DB, all with `user_id = '7fe4d34e-1975-46fb-9dac-9c2df7a9eed6'` (admin)
2. **0 posts** with `status='scheduled'` exist for user `1122a2d5-3b85-49a2-8be1-4f68509df053` (xsellpointkw)
3. xsellpointkw has **88 completed posts** (their old scheduled posts were published and moved to /history)
4. RLS policy `Users can view own posts` prevents xsellpointkw from seeing admin's posts
5. xsellpointkw has role `subscriber` (not `admin`), so the `Admins can view all posts` policy doesn't apply

### Why This Happened
1. User previously scheduled posts while logged in as xsellpointkw → they were published by `process-scheduled-posts` cron → moved to /history
2. User then created 20 new posts via the n8n API node (using the **admin's** API key, not xsellpointkw's) → posts stored under admin's `user_id`
3. xsellpointkw logs in → `usePosts()` queries `WHERE user_id = xsellpointkw.id` → 0 scheduled posts returned
4. Page shows "No scheduled posts" empty state

## Fix

### Option A (User Action — Immediate)
1. Log out of xsellpointkw@gmail.com
2. Log in as dr.vet.waleedtam@gmail.com (admin)
3. Navigate to `/scheduled` → all 20 posts will be visible

### Option B (User Action — Long Term)
Update the n8n node to use xsellpointkw's API key instead of admin's, so future scheduled posts appear under xsellpointkw's account.

### Option C (Code Change — UX Improvement)
Add a helpful banner on the `/scheduled` page that:
- Shows the currently logged-in email
- If the user has 0 posts but is a subscriber, show a hint: "If you expected to see posts here, verify you're logged in with the account that created them."

## Decision
Implement **Option C** as a defensive UX improvement. The user should not be confused about which account they're on. The primary solution remains **Option A** (log in as admin).
