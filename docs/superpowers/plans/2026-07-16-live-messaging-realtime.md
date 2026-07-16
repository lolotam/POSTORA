# Live Messaging Realtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface newly received Facebook, Instagram, WhatsApp, and Threads engagement data in the relevant Postora inbox views without a manual page refresh.

**Architecture:** Meta webhooks write account-scoped inbox and comment cache records. React Query hooks subscribe to the persisted data through Supabase Realtime and invalidate only cache keys for the affected account. Timed refresh remains a fallback for Meta API-derived views, particularly Threads replies.

**Tech Stack:** React 18, TypeScript, TanStack Query, Supabase Realtime, PostgreSQL migrations, Deno edge functions, Vitest.

---

### Task 1: Add Event Persistence

**Files:**
- Create: `supabase/migrations/<timestamp>_live_messaging_events.sql`
- Modify: `supabase/functions/facebook-instagram-webhook/index.ts`

- [ ] Create account-scoped tables for inbound Messenger/Instagram messages and comments with unique external event identifiers, row-level policies, indexes, and Realtime publication membership.
- [ ] Extend the verified webhook processor to normalize and upsert Facebook/Instagram message and comment events before auto-reply handling.
- [ ] Verify duplicate webhook deliveries are idempotent through unique constraints and upsert conflict targets.

### Task 2: Add Client Realtime Hooks

**Files:**
- Modify: `src/hooks/useMessaging.ts`
- Modify: `src/hooks/useCommentInbox.ts`
- Modify: `src/hooks/useThreadsMentions.ts`
- Create: `src/hooks/useRealtimeQueryInvalidation.ts`

- [ ] Write failing tests for filtered Realtime invalidation and cleanup.
- [ ] Add a reusable subscription hook that listens to one table, filters by authenticated user and selected account, invalidates a supplied React Query key, and removes the channel on cleanup.
- [ ] Subscribe messaging, comments, and Threads mentions to their persisted data sources.
- [ ] Keep active-view polling only as a missed-event fallback.

### Task 3: Make WhatsApp and Threads Live

**Files:**
- Modify: `src/hooks/useMessaging.ts`
- Modify: `src/hooks/useThreadsReplies.ts`

- [ ] Subscribe WhatsApp conversation lists to `messaging_cache` and active conversations to `whatsapp_messages`.
- [ ] Add a short refetch interval to Threads replies while their tab is mounted because replies are not currently stored by the webhook receiver.

### Task 4: Support URL Tabs

**Files:**
- Modify: `src/pages/messaging/FacebookMessaging.tsx`
- Modify: `src/pages/messaging/InstagramMessaging.tsx`
- Modify: `src/pages/messaging/ThreadsMentions.tsx`
- Create: `src/lib/messagingTab.ts`
- Test: `src/lib/__tests__/messagingTab.test.ts`

- [ ] Write failing tab-normalization tests for supported names and invalid values.
- [ ] Add a small URL query parser and update tabs through `useSearchParams`.
- [ ] Preserve the current inbox defaults when no valid query value is present.

### Task 5: Verify and Deliver

**Files:**
- Test: `src/hooks/__tests__/useRealtimeQueryInvalidation.test.tsx`
- Test: `src/lib/__tests__/messagingTab.test.ts`

- [ ] Run the focused Vitest suites after each red-green cycle.
- [ ] Run `npm test` and the project typecheck/build command.
- [ ] Review changed production code with `clean-code-guard` and tests with `test-guard`.
- [ ] Run `graphify update .`.
- [ ] Commit only feature files and push `feat/live-messaging-realtime`.
