# Spec — Space-free account handles and an enriched `sender` in messaging payloads

Date: 2026-08-23
Task 2 of the queued set. Depends on nothing in the rate-limits work, but touches
`_shared/n8nMessagingDispatch.ts`, which is identical on `main` and on the
rate-limits branch, so it can be branched from either.

**Goal:** `account.username` / `account.handle` never contain spaces, and the
`sender` object carries the same shape as `account`, for the Message Received
events on the Postora Trigger node.

---

## 1. Problem

### Issue 1 — spaces leak into `username` and `handle`

`describeMessagingAccount` (`_shared/n8nMessagingDispatch.ts:23`) assigns the raw
`platform_username` to `username`:

```ts
const username = account.platform_username?.trim() || null;
...
handle: handleable && username ? `@${username.replace(/^@/, "")}` : null,
```

For a Facebook Page, `platform_username` is a **display name**. A page called
"Danat Future Company" therefore yields `username: "Danat Future Company"` and
`handle: "@Danat Future Company"` — a handle with spaces, which is not a valid
handle on any platform.

### Issue 2 — `sender` is a thin, mostly-null object

`MessagePayloadInput["sender"]` is `{ id, name, phone }`. Facebook/Instagram
webhooks pass `event.sender?.name || null` and `event.sender?.phone || null`,
and Meta messaging webhooks carry neither, so both are usually `null`. There is
no `username` or `handle` at all, so `sender` and `account` have different
shapes in the same payload.

## 2. Blast radius (verified by grep — this is the part that makes it a break, not a fix)

`describeMessagingAccount` has **three** consumers, not one:

| Consumer | What changes |
|---|---|
| `buildMessagePayload` → `message.received` | `account.username` / `account.handle` |
| `buildCommentPayload` → `comment.received` (facebook, instagram, threads) | same |
| `n8n-api/index.ts:1897` — the `POST /api/v1/messages/reply` **response body** | same |

So any live n8n workflow matching on `account.username` for a Facebook Page —
on **message or comment** events, or reading the reply-API response — sees a
changed value. That must be stated in the PR body, not discovered by a user.

`isOwnComment` (`_shared/commentAuthor.ts:36`) compares `author.username`
against `account.platform_username` **directly**, not against the summary, so
this change cannot reopen the self-reply loop. Verified by reading the function.

## 3. Requirements

### R1 — space-free `username`, with `name` keeping the display name

`describeMessagingAccount` resolves `username` in this order:

1. `account_metadata.ig_username` (Instagram's real username, set by
   `instagram-business-oauth`), leading `@` stripped;
2. `platform_username` **as-is** when it already contains no whitespace;
3. `platform_username` slugified: trim → strip leading `@` → whitespace runs
   collapse to `_` → lowercase;
4. `null`.

- `name` keeps the raw `platform_username` (display name, spaces intact),
  falling back to `platform_user_id`, then `id` — unchanged from today.
- `handle` is `@${username}` for handle-based platforms (instagram, facebook,
  threads) and `null` for WhatsApp or when `username` is `null`. Since `username`
  is now space-free by construction, `handle` is too.
- `MessagingAccountSource` gains an optional `account_metadata?: unknown` field
  so step 1 can read it. `commentAuthor.ts` already has a `metadataString`
  helper for exactly this; that pattern is reused rather than duplicated.

**Accepted caveat, per the task brief:** a slugified handle such as
`@danat_future_company` is derived from a display name and **may not resolve to a
real account on-platform**. The task explicitly names this output as acceptable.
It is recorded here so it reads as a deliberate decision rather than an
oversight, and so review does not re-litigate it.

### R2 — `sender` gains the same shape as `account`

```ts
export interface MessagingPersonSummary {
  id: string;
  name: string | null;
  username: string | null;
  handle: string | null;
  phone: string | null;
}
```

`MessagePayloadInput["sender"]` and `MessagePayload["sender"]` both become
`MessagingPersonSummary`. `username` is space-free by the same slug rule as R1,
and `handle` is `@${username}` or `null`.

**Sources are limited to data already present in each code path.** No new Graph
API profile lookups: the task says "resolved from conversation/profile where
available, falling back gracefully", which does not authorise new outbound calls
with their own rate-limit and permission consequences.

| Platform | id | name | username / handle | phone |
|---|---|---|---|---|
| facebook / instagram | PSID / IGSID | `event.sender?.name` | derived from the name when present, else `null` | `null` |
| whatsapp (Cloud) | `from` (digits) | `contactName` | `null` | `from` |
| whatsapp (Evolution) | `remoteNumber` (digits) | `built.participantName` | `null` | `remoteNumber` |

WhatsApp never gets a handle — consistent with `account.handle` being `null`
there. Facebook/Instagram usually resolve `username` to `null` because Meta
messaging webhooks do not carry a sender username; that is the graceful
fallback the task allows, not a gap.

`phone` becomes `null` for facebook/instagram rather than
`event.sender?.phone || null`, since Meta messaging webhooks never populate it.

### R3 — shared slug helper

The username/handle derivation is one rule used by both `account` and `sender`,
so it lives in one exported function in `n8nMessagingDispatch.ts` and is called
twice. Duplicating it into the three webhook call sites would be the
duplicated-knowledge kind of DRY violation.

## 4. Non-goals

- No new Graph/Evolution API calls to enrich a sender.
- `comment.received`'s `author` object is **not** reshaped — the task scope is
  the Message Received payload. `author` keeps `{ id, name, username }`.
- No change to `isOwnComment`, conversation keys, or inbox persistence.
- No database migration.

## 5. Acceptance criteria

- `deno test supabase/functions/_shared/` green, covering:
  - a Facebook Page display name with spaces yields a space-free `username` and
    a space-free `handle`, with `name` keeping the spaces;
  - `account_metadata.ig_username` wins over `platform_username`;
  - an already-space-free `platform_username` passes through **unchanged** (not
    lowercased into a different value than today for the common Instagram case);
  - a leading `@` is stripped exactly once, never doubled in `handle`;
  - WhatsApp yields `handle: null` regardless of username;
  - `sender` carries all five fields for each of the three webhook paths.
- `deno check` on every changed function; `npx tsc --noEmit`; `npm test` at or
  above the 663-passed baseline; `npm run build`.
- `clean-code-guard` and `test-guard` clean.
- PR body lists the payload-shape change and names `comment.received` and the
  reply-API response as affected, not just `message.received`.

## 6. Open risk to state in the PR

Step 2 of R1 preserves today's value for any username without spaces, so
Instagram accounts (`mybrand`) are unaffected. The visible change is confined to
accounts whose `platform_username` contains whitespace — in practice Facebook
Pages and WhatsApp profile names.
