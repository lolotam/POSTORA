# Spec: Scheduled Posts Empty State — Link to History

## Goal
When a user has 0 scheduled posts, help them understand that their recent posts may have already been published and moved to `/history`.

## Design

### 1. Improved Empty State
When the page shows "No scheduled posts" and the user is NOT searching, show a button that links to `/history` so they can see recently published posts.

### 2. Non-Disruptive
- Pure UI improvement
- No database changes
- No new API endpoints

## Files Changed
- `src/pages/ScheduledPosts.tsx` — add a "View History" link in the empty state

## Why This Fix Is Safe
- Posts that are already published are in `/history`, accessible from the nav
- This change just makes that connection more obvious from the empty state
- No data changes, no RLS changes
