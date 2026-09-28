# PR D — WhatsApp scheduled messages on /scheduled and /calendar — plan

**Spec:** `docs/superpowers/specs/2026-09-28-media-library-files-design.md` (the Scheduled views decision). The owner approved it on 2026-09-28: WhatsApp scheduled messages appear on `/scheduled` and on `/calendar` alongside posts. Pending ones can be cancelled and rescheduled; in-flight ones are locked.

**Lanes:** code goes to Grok 4.7 medium; the owner asked on 2026-09-29 for it to run in parallel with PR C. The Codex astra debate on this plan comes first. There is no migration: the #219 client guard already lets an owner change `scheduled_at` on a `pending` row and move it to `cancelled`.

**Parallel-work boundary with PR C (`F:/Postora_pc`, GLM):** PR C edits `ScheduleMessageDialog.tsx`, the insert path in `useWhatsAppScheduledMessages.ts`, the sender, and a migration. PR D must **not** edit those. Anything PR D needs goes in a new read-model module, `src/features/scheduled/whatsappScheduledItems.ts`. The only change to `useWhatsAppScheduledMessages.ts` is a new `reschedule` mutation, a small, separate hunk.

## Data

- Source: `whatsapp_scheduled_messages` rows for the signed-in user (RLS already scopes them). Columns: `id`, `social_account_id`, `recipient_phone`, `recipient_name`, `message_text`, `media_url`, `media_type`, `scheduled_at`, `status`, `sent_at`, `error_message`.
- Join the account's display name and avatar from `social_accounts` (id, `platform_username`, `avatar_url`, `connection_mode`) in one query, or through the existing accounts hook.
- Show statuses `pending`, `claimed` and `sending` on `/scheduled`. The calendar shows those plus `sent`, `failed` and `skipped` on their day. Terminal ones are greyed out and read-only; `cancelled` is hidden.
- **Unified item shape** (`ScheduledItem`, a discriminated union):
  - `{ kind: "post", post: Post }`
  - `{ kind: "whatsapp", message: ScheduledWhatsAppMessage, account }`

  Both variants carry a common `when: string` (ISO) and `id` for sorting and keys. The existing post rendering is untouched: the union wraps it.
- Reschedule: `update({ scheduled_at }).eq("id", id).eq("status", "pending").select("id")`.
  - Zero rows means the message is already being sent: throw the existing `SCHEDULED_CANCEL_BLOCKED`-style message, adapted as "This message is already being sent and can no longer be changed."
  - The new time must be at least 1 minute ahead. This is validated client-side, and the sender picks the row up normally.
- Cancel uses the existing `cancel` mutation.

## /scheduled (`src/pages/ScheduledPosts.tsx`)

- A new `WhatsAppScheduledCard` component shows:
  - the WhatsApp icon and account name;
  - the recipient: name, or the phone masked to its last 4 digits (e.g. `•••• 1234`);
  - a message preview of 2 lines;
  - the media type icon, plus the file name from the URL;
  - the scheduled time, with an overdue colour;
  - a status badge, reusing the badges from `ScheduledMessageManager`.
- Actions:
  - **Reschedule** opens a small datetime dialog, local time with the timezone shown.
  - **Cancel** asks for confirmation.
  - Both appear only when `status === "pending"`; for `claimed` and `sending` they are replaced by "Sending…".
  - Neither opens the post composer.
- Merged into the list sorted by `when`, with pagination and grid behaviour unchanged.
- Filters:
  - The platform filter gains `whatsapp`, which hides posts and shows only WhatsApp items. Other platform filters hide WhatsApp items.
  - Search matches message text, recipient name and account name.
  - The profile filter applies only to posts. When a profile filter is active, WhatsApp items are hidden.
  - The pending/overdue filter applies to both.
- Bulk actions on posts stay post-only; WhatsApp cards are not selectable for bulk actions.
- Empty states and counts include WhatsApp items.

## Sidebar count (`useScheduledPostCount`, `DashboardLayout`)

The badge counts pending and scheduled posts **plus** pending, claimed and sending WhatsApp messages, using a second head-count query. The query key changes so both refresh after mutations. Invalidate it from the WhatsApp cancel and reschedule mutations as well.

## /calendar (`src/pages/Calendar.tsx`, `src/components/calendar/*`)

- `CalendarGrid` and `DayDetailDialog` accept the union. A WhatsApp entry has a green WhatsApp chip plus the recipient or preview.
- Drag-and-drop:
  - A pending WhatsApp message can be dragged to another day. It keeps its time of day, and the result must be at least 1 minute ahead; otherwise the move is refused with a toast. It calls `reschedule`.
  - Posts keep their existing `posts.update` path.
  - Items that are claimed, sending or terminal are not draggable.
- `DayDetailDialog` lists WhatsApp items with the same actions as the card.

## Tests (vitest; mock only supabase)

- **Merge and sort:** posts and WhatsApp messages sort together by time. `cancelled` is hidden. Terminal statuses appear on the calendar but not on `/scheduled`.
- **Filters:** the `whatsapp` platform filter, search across text/recipient/account, and a profile filter hiding WhatsApp items.
- **Card actions:**
  - Reschedule and Cancel appear only when pending.
  - Reschedule calls the update with `.eq("status","pending")`.
  - Zero rows shows the blocked message.
  - A past time is refused.
- **Calendar:** dragging a pending WhatsApp item keeps its time of day and calls `reschedule`. A sending item cannot be dragged. Dropping onto a past day is refused.
- **Sidebar count:** the badge includes WhatsApp pending, claimed and sending.
- **Phone masking:** the full number is never rendered in the card.

## i18n

Only the Arabic locale file exists. Every new string is `t("key", "English fallback")` plus an Arabic entry (Egyptian-Arabic tone) in the right namespace (`scheduled`/`calendar`/`inbox`).

## Gates

- `bun install --frozen-lockfile`
- `npx vitest run` (full suite)
- `tsc -p tsconfig.app.json`
- eslint on the changed files

## Deploy

Frontend only, no migration: merge, and the Dokploy frontend build deploys it. Afterwards, check that the `/scheduled` route chunk contains the new card.

## Merge threshold

Blockers:
- a WhatsApp item that can be cancelled or rescheduled while claimed or sending;
- a reschedule into the past;
- the full phone number rendered;
- another user's messages shown;
- existing post behaviour broken (edit, publish-now, bulk, drag);
- a sidebar count that ignores WhatsApp.

Everything else is a follow-up.

## Debate revisions (Codex astra, 2026-09-29): these override the sections above

- **Hook ownership:** in `useWhatsAppScheduledMessages.ts`, PR D owns the new `reschedule` mutation and the `onSuccess`/`onError` invalidation lines of `schedule`, `cancel` and `reschedule`. PR C owns the input/insert payload. D does not change the insert payload.
- **Cache contract:**
  - Keep the sidebar count under the existing key prefix `["posts", userId, "scheduled_count"]`, so every existing post invalidation still refreshes it.
  - WhatsApp create, cancel and reschedule (on success **and** on a blocked zero-row attempt) invalidate `["whatsapp-scheduled"]` and `["posts"]`.
  - The count is: posts with the existing future-only predicate (unchanged) + WhatsApp rows with status in `pending`/`claimed`/`sending`, whatever the time.
  - Run both counts concurrently. Either error throws; never report a partial total.
  - Badge `refetchInterval` is 60 s.
- **Read model:** `src/features/scheduled/whatsappScheduledItems.ts`.
  - One query per page, explicitly filtered by `.eq("user_id", user.id)`. The query key is user-scoped. Errors propagate and are shown in the UI, never as a false empty list.
  - `select("*")`, so `media_filename` (from PR C) is used when present; otherwise the URL-derived name, both passed through the display sanitiser.
  - The account label comes from a direct `social_accounts` lookup that includes inactive accounts; a null account gets a "WhatsApp account" fallback.
  - `/scheduled` loads only active statuses. `/calendar` loads the visible range including spillover days, ordered with a limit of 1000. A small "more items not shown" note appears if the limit is hit.
  - Refresh every 30 s while the page is visible (`refetchInterval` with `refetchIntervalInBackground: false`). The page's manual refresh refreshes both posts and WhatsApp.
  - Mount the orchestration once per page. Cards receive props and callbacks, and must not call `useWhatsAppScheduledMessages()` per card.
- **Reschedule mutation:**
  - Check the error first, then the returned rows.
  - Zero rows gives the message "This message can no longer be changed (it is being sent, was sent, or was cancelled)." That is an error toast, with no success toast, followed by an invalidation.
  - Validate the new instant (≥ now + 60 s) **inside** the mutation.
  - No optimistic move; if one is added, roll it back.
- **/scheduled:**
  - Keep the existing comparator exactly (upcoming first by time, then overdue). WhatsApp items use the same `when` and the same overdue rule, with their status badges.
  - There is no pagination to preserve.
  - Select-all and bulk actions stay strictly post-only.
  - "Pending/overdue" filters use the existing meaning (not overdue / overdue).
  - Extract the status-badge rendering from `ScheduledMessageManager` into a shared `ScheduledMessageStatusBadge` component, used by both.
- **Phone masking:** one `maskRecipient(phone, name)` helper shows the name if present, else `•••• last4`. It is used in the card, the calendar chip, the day dialog, the reschedule dialog, tooltips and aria-labels. The full number is never rendered or placed in attributes.
- **Calendar:**
  - The drag-lock applies **only to WhatsApp** items: pending ones are draggable; claimed, sending and terminal ones are not. Post chips keep their existing behaviour (always draggable) unchanged.
  - Dragging keeps the **local wall-clock** hours and minutes in the browser's timezone (the calendar already uses it; show the IANA zone name in the day dialog and the reschedule dialog). Seconds become 0.
  - A local time that does not exist on the target day (DST spring-forward) is **refused** with a toast. An ambiguous fall-back time uses the earlier occurrence.
  - The resolved instant must be ≥ now + 60 s.
- **i18n:** `scheduled` is not a namespace. Use `calendar` for calendar strings and `inbox` (existing `scheduled.*` keys) for WhatsApp card and dialog strings, with Arabic entries in `src/i18n/locales/ar/calendar.json` and `inbox.json`.
- **Tests (additions):**
  - post regressions: edit, publish-now, bulk select-all (post-only) and post drag unchanged;
  - the badge updates after WhatsApp create, cancel and reschedule, and after existing post invalidations;
  - masking on every calendar surface, including aria-labels;
  - a DST nonexistent time is refused;
  - claimed, sending and terminal WhatsApp items are each read-only;
  - a zero-row reschedule shows the error and no success;
  - a query error is shown rather than an empty list.
- **Gates:** add `npm run build` (the production build) plus the clean-code and test guard review done by the orchestrator.
- **Deploy check:** after the frontend deploys, confirm with a real owned test message (created via SQL on the admin's inactive account and cleaned up) that it appears on `/scheduled` and the calendar, reschedules, cancels, and updates the badge. Also confirm that post actions still work.
