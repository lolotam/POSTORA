# Plan: xsellpointkw's "Missing" Scheduled Posts Are Already Published

## Issue
User (xsellpointkw@gmail.com) reports that posts scheduled from the n8n node yesterday are missing from the `/scheduled` page.

## Root Cause (Confirmed via DB)
**All 42 posts that xsellpointkw scheduled yesterday via n8n have been successfully published.** They are now in `/history`, not in `/scheduled`.

### Evidence
- 42 posts with `user_id=1122a2d5-3b85-49a2-8be1-4f68509df053` (xsellpointkw) were created between 2026-07-09 22:57 and 2026-07-10 09:46 UTC
- All 42 have `status='completed'`
- 0 posts with `status='pending'` or `status='scheduled'` exist for xsellpointkw
- `platform_posts` shows successful publishing for all 42
- The 20 future scheduled posts in the DB belong to the admin account (dr.vet.waleedtam@gmail.com), NOT xsellpointkw

### Timeline
- Posts created at various times yesterday with `scheduled_at` set 5-17 hours in the future
- `process-scheduled-posts` cron (runs every minute) picked them up at the scheduled time
- `process-post` edge function published them and updated `status='completed'`
- They moved from `/scheduled` to `/history`

## Fix

### User Action
1. Check `/history` — all 42 published posts should be there
2. To see NEW posts in `/scheduled`, schedule them for future dates
3. The 20 future posts visible to the admin account are under dr.vet.waleedtam@gmail.com, not xsellpointkw

### Code Change
Make the `/scheduled` page's empty state more informative:
- When user has 0 scheduled posts, show a link to `/history` so they can see recently published posts
- Add a small badge showing "X recently published" with a link to history

## Files to Change
- `src/pages/ScheduledPosts.tsx` — improve empty state with link to history
