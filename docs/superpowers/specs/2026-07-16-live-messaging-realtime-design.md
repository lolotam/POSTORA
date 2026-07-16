# Live Messaging Realtime Design

## Goal

Display new inbound Facebook, Instagram, WhatsApp, and Threads engagement data without requiring a browser refresh.

## Root Cause

Facebook and Instagram inbox queries only poll Meta, their webhook does not persist inbound messages or comments, and the comment manager has no automatic refetch. WhatsApp persists webhook data but its UI only polls. Threads mentions are persisted but are loaded after a manual refresh; Threads replies are read directly from the Threads API.

## Design

- Persist Facebook and Instagram inbound messages and comments received through Meta webhooks in account-scoped cache tables.
- Use Supabase Realtime in the corresponding React hooks to invalidate only the affected React Query cache for the signed-in user and selected social account.
- Retain short active-view polling as a recovery path for missed events and for Threads reply data that is not delivered through the current webhook payload.
- Synchronize messaging page tab state with the `tab` query parameter, accepting `inbox`, `comments`, `mentions`, and `replies`.

## Scope

- Facebook and Instagram inboxes and comment managers.
- WhatsApp conversations and messages.
- Threads mentions and replies.
- Targeted hook and URL-tab regression tests.

## Non-Goals

- Changing existing Meta OAuth permissions or connection flows.
- Backfilling historical Facebook or Instagram messages and comments.
- Replacing the manual refresh controls.

## Validation

- A persisted event refreshes only the matching account cache.
- Realtime subscriptions clean up when the account changes or the component unmounts.
- URL-selected tabs render the correct content.
- Existing project typecheck and relevant Vitest suites pass.
