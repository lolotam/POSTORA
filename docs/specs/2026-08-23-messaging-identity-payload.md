# Spec — Space-free account handles and an enriched `sender` in messaging payloads

Date: 2026-08-23
Revision 2 (after Codex round 1 - 5 blocking objections, all folded in; see section 7).
Task 2 of the queued set. Depends on nothing in the rate-limits work, but touches
`_shared/n8nMessagingDispatch.ts`, which is identical on `main` and on the
rate-limits branch, so it can be branched from either.

**Goal:** `account.username` / `account.handle` never contain spaces, and
`sender` carries a consistent five-field identity shape, for the Message
Received events on the Postora Trigger node.

The space-free handle is the substantive fix; the `sender` reshape is schema
consistency rather than new data (see R2).

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

One `normalizeHandleUsername(raw)` runs **before** any branching, so every
candidate is cleaned identically and the order of operations cannot differ
between steps (Codex r1 #1):

1. reject anything that is not a string;
2. trim surrounding whitespace, Unicode included (`\s` with the `u` flag);
3. strip **all** leading `@` characters, not just one;
4. empty result → `null`;
5. no *internal* whitespace → return unchanged, **preserving case**;
6. otherwise collapse internal whitespace runs to a single `_` and lowercase —
   the fabricated-slug branch.

`describeMessagingAccount` then takes the first non-null of:

1. `account_metadata.ig_username`, **only when `platform === "instagram"`**.
   The gate matters: the field is written by `instagram-business-oauth`, and a
   Facebook or WhatsApp row carrying stale `ig_username` metadata would
   otherwise be labelled with an unrelated Instagram handle (Codex r1 #1).
2. `platform_username`.
3. `null`.

**Case is preserved except in the slug branch** (Codex r1 #2). `isOwnComment`
compares case-insensitively but never reads this summary, so nothing internal
requires lowercasing — whereas a live subscriber may compare `account.username`
case-sensitively. Step 5 therefore returns `"MyBrand"` unchanged. Lowercasing is
confined to step 6, which fires only for values already changing shape (a
display name with spaces), so it cannot alter a value anyone is matching
successfully today.

Step 5 also fixes the ordering bug Codex flagged: because the trim happens
first, `" Brand "` has no *internal* whitespace and returns as `"Brand"` rather
than being slugified to `"brand"`.

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

### R2 — `sender` gains a consistent identity shape

**Goal wording corrected (Codex r1 #3):** this is *schema consistency*, not
enrichment. `sender` does not become "the same shape as `account`" — `account`
carries `platform` and no `phone`; `sender` carries `phone` and no `platform`.
And for Meta, `username`/`handle` will usually be `null`, because messaging
webhooks carry only a sender id. Adding two mostly-null fields is a predictable
schema, not new information, and the spec should not claim otherwise.

That is still worth shipping: a workflow author reading `sender.username` today
gets `undefined` with no way to know whether the field is missing or the value
is absent. After this it is explicitly `null`. The *substantive* fix in this
task is R1 — the space-free handle.

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

  *`normalizeHandleUsername`* (Codex r1 #5):
  - a Facebook Page display name with spaces → space-free `username` **and**
    `handle`, with `name` keeping the spaces;
  - already-space-free `platform_username` passes through **unchanged and
    case-preserved** (`"MyBrand"` stays `"MyBrand"`);
  - surrounding whitespace only (`" Brand "`) → `"Brand"`, **not** `"brand"` —
    the trim-before-slug ordering;
  - internal whitespace → single `_`, collapsed from runs, lowercased;
  - Unicode whitespace (non-breaking space, ideographic space) treated as
    whitespace;
  - one, several, and zero leading `@` — never a doubled `@` in `handle`;
  - empty string, whitespace-only, and non-string input → `null`;

  *platform gating:*
  - `ig_username` on an **instagram** row wins over `platform_username`;
  - `ig_username` present on a **facebook** or **whatsapp** row is **ignored**;
  - malformed `ig_username` (non-string, empty, whitespace-only) falls through
    to `platform_username` rather than yielding `null`;
  - WhatsApp yields `handle: null` regardless of username;

  *payload stability — the regression guards:*
  - `toLegacyPayload` output is byte-for-byte unchanged for a given input, since
    it reads `sender.id` and `sender.name` and both are preserved;
  - conversation ids, dedup keys, and inbox rows are unchanged;
  - the `comment.received` payload and the `POST /api/v1/messages/reply`
    response are asserted in full, not just `message.received`, because
    `describeMessagingAccount` feeds all three;
  - a Meta sender with no `name` yields `name: null` rather than `undefined`;
  - `sender` carries all five keys for each of the three webhook paths.

- **n8n node compatibility (Codex r1 #4) — already checked, no node release
  needed.** `PostoraTrigger.node.ts:488` emits
  `workflowData: [[{ json: this.getBodyData() }]]` — the webhook body passes
  through verbatim, with no schema validation and no field allowlist. Extra
  `sender` keys therefore cannot break the node. What this does **not** cover is
  a user's own workflow doing a whole-object comparison downstream, which is the
  residual risk R4 below records.
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

---

## 7. Codex round-1 objections and disposition

| # | Objection | Disposition |
|---|---|---|
| 1 | resolution order is contradictory and unsafe: `ig_username` not gated to Instagram, `metadataString` does not trim or reject whitespace-only, step 2 keeps a leading `@` while the acceptance criteria demand it stripped, and trimming only in step 3 turns `" Brand "` into `"brand"` | **Accepted in full** - R1 rewritten around one `normalizeHandleUsername` that runs before any branching, so trim and `@`-stripping cannot differ between paths. `ig_username` is now gated on `platform === "instagram"`. `" Brand "` returns `"Brand"`. |
| 2 | lowercasing is not justified by `isOwnComment`, which never reads this summary; live subscribers may compare case-sensitively | **Accepted** - case is preserved everywhere except the slug branch, which only fires for values already changing shape. `"MyBrand"` stays `"MyBrand"`. |
| 3 | "same shape as `account`" is false, and adding two mostly-null fields is schema expansion, not enrichment | **Accepted** - R2 reworded. This is schema *consistency*; the substantive fix in this task is R1. The value is that `sender.username` becomes an explicit `null` instead of `undefined`. |
| 4 | internal consumers survive, but the n8n node and live workflows are unvalidated | **Accepted and resolved** - checked directly: `PostoraTrigger.node.ts:488` passes `this.getBodyData()` through with no schema validation, so extra keys cannot break the node. No node release needed. Residual risk for a user's own whole-object comparison is recorded in section 6. |
| 5 | acceptance coverage insufficient | **Accepted** - section 5 expanded with Unicode whitespace, multiple leading `@`, wrong-platform metadata, malformed `ig_username`, case preservation, and full assertions on the comment payload and the reply-API response rather than `message.received` alone. |
