# Spec: Scheduled Posts — Account Visibility Indicator

## Goal
Eliminate confusion when a user sees "No scheduled posts" while posts exist under a different account. Show the currently logged-in email prominently on the `/scheduled` page, and add a helpful hint when a non-admin user has zero posts.

## Design

### 1. Account Badge
Add a small badge near the page header showing the currently logged-in email. This is always visible regardless of post count.

**Location**: Next to the existing "X scheduled" / "X overdue" badges in the page header (around line 525 of `ScheduledPosts.tsx`).

**Visual**:
```
[📅 20 scheduled] [⚠ 0 overdue] [👤 xsellpointkw@gmail.com]
```

**Implementation**:
- Use `useAuth()` to get the user's email
- Add a small Badge component with a User icon

### 2. Helpful Empty State
When the page shows "No scheduled posts" and the user is a subscriber (not admin), show a more informative message:

**Before**:
> "You don't have any upcoming scheduled posts."

**After**:
> "You don't have any scheduled posts under this account.
> If you expected to see posts here, make sure you're logged in with the account that created them."

**Implementation**:
- Use `useUserRole()` hook to check if user is admin
- If not admin and has 0 posts, show the expanded message
- If admin and has 0 posts, keep the original simple message (admin should see all posts)

### 3. Non-Disruptive
- No database changes
- No RLS changes
- No new API endpoints
- Pure UI/UX improvement

## Files Changed
- `src/pages/ScheduledPosts.tsx` — add account badge + improved empty state

## Testing
- Log in as xsellpointkw → see email badge showing "xsellpointkw@gmail.com" + improved empty state
- Log in as dr.vet.waleedtam@gmail.com (admin) → see email badge + 20 scheduled posts
- Switch accounts → badge updates correctly

## Why This Fix Is Safe
- The 20 scheduled posts are NOT lost — they're under the admin account
- RLS is correctly preventing xsellpointkw from seeing admin's posts (this is desired behavior)
- The fix is purely informational — it helps the user understand the situation
- The real action is for the user to log in as admin or update their n8n API key
