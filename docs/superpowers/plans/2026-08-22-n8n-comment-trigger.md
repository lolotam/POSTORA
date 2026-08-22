# n8n Comment Trigger & Automation Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward new Facebook/Instagram/Threads comments to n8n via a new "Postora Comment Trigger" node, let n8n reply/hide/delete through a new Comment resource, and give users a per-account switch choosing which agent (Postora AI / n8n / none) handles Messages and Comments.

**Architecture:** One shared, signed dispatcher (`_shared/n8nMessagingDispatch.ts`) becomes event-agnostic with per-subscription platform/account filters; the three inbound webhooks (`facebook-instagram-webhook`, `threads-webhook` mentions + new `replies`) call it after an idempotent insert into `social_inbox_events`. `n8n-api` stores the filters and exposes `/api/v1/comments/*`. The web app writes `account_metadata.automation_handler` / `comment_automation_handler` through `messaging-api`.

**Tech Stack:** Deno edge functions (Supabase self-hosted), `deno test` for `_shared`, React + Vitest for the web app, n8n community node in TypeScript with Jest (two local copies that must stay identical).

**Spec:** `docs/superpowers/specs/2026-08-22-n8n-comment-trigger-and-automation-handler-design.md`

**Branches:** Postora repo: `feat/n8n-comment-trigger` (already created). Node repo `F:\N8N\Postora-n8n-community-node`: work on `main` (it releases from `main`).

**Commands used throughout**
- Deno tests: `deno test --allow-env --allow-net supabase/functions/_shared/<file>.test.ts` (run from `F:\Postora_new`)
- Web tests: `npx vitest run <path>` ; build: `npm run build`
- Node: `cd F:\N8N\Postora-n8n-community-node && npx tsc --noEmit && npm test && npm run build`
- Sync vendored copy (PowerShell): `robocopy F:\N8N\Postora-n8n-community-node\nodes F:\Postora_new\Postora-n8n-community-node\nodes /MIR` (repeat for `__tests__`, `dist`, and copy `README.md`, `package.json`)

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/functions/_shared/automationHandler.ts` | Resolve message + comment handler from `account_metadata`; enums |
| `supabase/functions/_shared/n8nMessagingDispatch.ts` | Envelope builders (`buildMessagePayload`, `buildCommentPayload`), `dispatchN8nEvent`, subscription matching with filters |
| `supabase/functions/_shared/commentAuthor.ts` | `isOwnComment(platform, account, author)` suppression rule |
| `supabase/functions/_shared/commentActions.ts` | Graph/Threads calls for reply/hide/delete, shared by `comment-manager` and `n8n-api` |
| `supabase/functions/facebook-instagram-webhook/index.ts` | Dispatch comment events on fresh insert |
| `supabase/functions/threads-webhook/index.ts` | Handle `replies` field; use shared dispatcher for mentions |
| `supabase/functions/threads-mentions/index.ts` | Use shared dispatcher |
| `supabase/functions/n8n-api/index.ts` | Allowlist, filters on register/list, `/api/v1/comments/*` |
| `supabase/functions/messaging-api/index.ts` | `get_automation_handlers` / `set_automation_handlers` |
| `supabase/migrations/20260822120000_social_inbox_events_threads.sql` | Allow `threads` platform |
| `src/hooks/useAutomationHandlers.ts` | Query + mutation for the switch |
| `src/components/messaging/AutomationHandlerCard.tsx` | The switch UI |
| `src/pages/messaging/{FacebookMessaging,InstagramMessaging,ThreadsMentions}.tsx` | Mount the card |
| Node: `nodes/shared/webhookLifecycle.ts` | Shared `sameEventSet`, `isAlreadyGone`, `unregisterWebhook` |
| Node: `nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts` | New trigger |
| Node: `nodes/Postora/Postora.node.ts` | Comment resource |

---

### Task 0: Land the pending trigger-robustness work in the node repo

The node repo has uncommitted changes (`isAlreadyGone`, callback-URL guard, README, tests, dist) that the vendored copy partly lacks.

**Files:**
- Modify (commit as-is): `F:\N8N\Postora-n8n-community-node\{README.md,__tests__/PostoraTrigger.node.test.ts,nodes/PostoraTrigger/PostoraTrigger.node.ts,dist/...}`
- Sync: `F:\Postora_new\Postora-n8n-community-node\__tests__\PostoraTrigger.node.test.ts`, `README.md`, `dist/`

- [ ] **Step 1: Verify the pending work passes**

Run: `cd F:\N8N\Postora-n8n-community-node && npx tsc --noEmit && npm test`
Expected: all tests PASS (includes the new "already-deleted subscription" cases).

- [ ] **Step 2: Commit in the node repo**

```bash
cd F:\N8N\Postora-n8n-community-node
git add README.md __tests__/PostoraTrigger.node.test.ts nodes/PostoraTrigger/PostoraTrigger.node.ts dist/nodes/PostoraTrigger
git commit -m "fix(trigger): tolerate already-deleted subscriptions and missing callback URL on checkExists"
```

- [ ] **Step 3: Sync to the vendored copy and commit in Postora**

```powershell
Copy-Item F:\N8N\Postora-n8n-community-node\__tests__\PostoraTrigger.node.test.ts F:\Postora_new\Postora-n8n-community-node\__tests__\PostoraTrigger.node.test.ts
Copy-Item F:\N8N\Postora-n8n-community-node\README.md F:\Postora_new\Postora-n8n-community-node\README.md
robocopy F:\N8N\Postora-n8n-community-node\dist F:\Postora_new\Postora-n8n-community-node\dist /MIR
robocopy F:\N8N\Postora-n8n-community-node\nodes F:\Postora_new\Postora-n8n-community-node\nodes /MIR
cd F:\Postora_new
git add Postora-n8n-community-node
git commit -m "chore(n8n-node): sync vendored copy with trigger robustness fix"
```

---

### Task 1: Automation handler enums (messages + comments)

**Files:**
- Modify: `supabase/functions/_shared/automationHandler.ts`
- Test: `supabase/functions/_shared/automationHandler.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the test file content with:

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  COMMENT_AUTOMATION_HANDLERS,
  MESSAGE_AUTOMATION_HANDLERS,
  resolveAutomationHandler,
  resolveCommentAutomationHandler,
} from "./automationHandler.ts";

Deno.test("resolveAutomationHandler defaults to internal and accepts n8n and off", () => {
  assertEquals(resolveAutomationHandler(null), "internal");
  assertEquals(resolveAutomationHandler({}), "internal");
  assertEquals(resolveAutomationHandler({ automation_handler: "n8n" }), "n8n");
  assertEquals(resolveAutomationHandler({ automation_handler: "off" }), "off");
  assertEquals(resolveAutomationHandler({ automation_handler: "unknown" }), "internal");
});

Deno.test("resolveCommentAutomationHandler defaults to off and accepts n8n and internal", () => {
  assertEquals(resolveCommentAutomationHandler(null), "off");
  assertEquals(resolveCommentAutomationHandler({}), "off");
  assertEquals(resolveCommentAutomationHandler({ comment_automation_handler: "n8n" }), "n8n");
  assertEquals(resolveCommentAutomationHandler({ comment_automation_handler: "internal" }), "internal");
  assertEquals(resolveCommentAutomationHandler({ comment_automation_handler: "bogus" }), "off");
});

Deno.test("handler enums are exported for server-side validation", () => {
  assertEquals([...MESSAGE_AUTOMATION_HANDLERS], ["internal", "n8n", "off"]);
  assertEquals([...COMMENT_AUTOMATION_HANDLERS], ["off", "internal", "n8n"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test --allow-env supabase/functions/_shared/automationHandler.test.ts`
Expected: FAIL — `resolveCommentAutomationHandler` not exported.

- [ ] **Step 3: Implement**

Replace `supabase/functions/_shared/automationHandler.ts` with:

```ts
export const MESSAGE_AUTOMATION_HANDLERS = ["internal", "n8n", "off"] as const;
export const COMMENT_AUTOMATION_HANDLERS = ["off", "internal", "n8n"] as const;

export type AutomationHandler = (typeof MESSAGE_AUTOMATION_HANDLERS)[number];
export type CommentAutomationHandler = (typeof COMMENT_AUTOMATION_HANDLERS)[number];

function readKey(metadata: unknown, key: string): unknown {
  if (!metadata || typeof metadata !== "object") return undefined;
  return (metadata as Record<string, unknown>)[key];
}

// Messages: "internal" (rules → AI agent) is the historical default.
export function resolveAutomationHandler(metadata: unknown): AutomationHandler {
  const value = readKey(metadata, "automation_handler");
  return (MESSAGE_AUTOMATION_HANDLERS as readonly unknown[]).includes(value) ? value as AutomationHandler : "internal";
}

// Comments: nothing automates comments unless the user opts in, so "off" is the default.
export function resolveCommentAutomationHandler(metadata: unknown): CommentAutomationHandler {
  const value = readKey(metadata, "comment_automation_handler");
  return (COMMENT_AUTOMATION_HANDLERS as readonly unknown[]).includes(value) ? value as CommentAutomationHandler : "off";
}
```

- [ ] **Step 4: Run tests**

Run: `deno test --allow-env supabase/functions/_shared/automationHandler.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Honour `"off"` for messages in both webhooks**

In `supabase/functions/facebook-instagram-webhook/index.ts` the existing checks `automationHandler === "internal"` already skip rules/AI for `"off"`. The n8n message dispatch (line ~183, `if (inboxResult === "inserted")`) must also skip when off — change to:

```ts
          if (inboxResult === "inserted" && automationHandler !== "off") {
```
and move `const automationHandler = resolveAutomationHandler(account.account_metadata);` above that `if` (it is currently declared after the dispatch block). Apply the same two edits in `supabase/functions/whatsapp-webhook/index.ts` around lines 419-446 (dispatch at 419, handler resolved at 438).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/automationHandler.ts supabase/functions/_shared/automationHandler.test.ts supabase/functions/facebook-instagram-webhook/index.ts supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(automation): add comment_automation_handler and an explicit off handler"
```

---

### Task 2: Own-comment suppression rule

**Files:**
- Create: `supabase/functions/_shared/commentAuthor.ts`
- Test: `supabase/functions/_shared/commentAuthor.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isOwnComment } from "./commentAuthor.ts";

const fb = { platform: "facebook", platform_user_id: "page-1", platform_username: "My Page", account_metadata: {} };
const ig = {
  platform: "instagram",
  platform_user_id: "app-scoped-1",
  platform_username: "mybrand",
  account_metadata: { ig_igid: "igid-1", ig_user_id: "ig-user-1" },
};
const th = { platform: "threads", platform_user_id: "th-1", platform_username: "mybrand", account_metadata: null };

Deno.test("facebook: only the page id counts as own", () => {
  assertEquals(isOwnComment(fb, { id: "page-1", username: null }), true);
  assertEquals(isOwnComment(fb, { id: "someone", username: null }), false);
});

Deno.test("instagram: any of the three stored ids counts as own", () => {
  for (const id of ["app-scoped-1", "igid-1", "ig-user-1"]) {
    assertEquals(isOwnComment(ig, { id, username: null }), true);
  }
  assertEquals(isOwnComment(ig, { id: "fan-1", username: "fan" }), false);
});

Deno.test("threads: matches by user id or username, case-insensitively", () => {
  assertEquals(isOwnComment(th, { id: "th-1", username: null }), true);
  assertEquals(isOwnComment(th, { id: null, username: "MyBrand" }), true);
  assertEquals(isOwnComment(th, { id: "x", username: "other" }), false);
});

Deno.test("missing author never counts as own", () => {
  assertEquals(isOwnComment(fb, { id: null, username: null }), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test --allow-env supabase/functions/_shared/commentAuthor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export interface CommentAuthorRef {
  id: string | null;
  username: string | null;
}

export interface CommentAccountRef {
  platform: string;
  platform_user_id?: string | null;
  platform_username?: string | null;
  account_metadata?: unknown;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

// Instagram accounts carry up to three ids (app-scoped, IGID, legacy ig_user_id) and
// comment webhooks may use any of them for `from.id`. Missing any one of them here
// reopens the self-reply loop this check exists to close.
function ownIds(account: CommentAccountRef): Set<string> {
  const ids = new Set<string>();
  if (account.platform_user_id) ids.add(account.platform_user_id);
  if (account.platform === "instagram") {
    for (const key of ["ig_igid", "ig_user_id"]) {
      const value = metadataString(account.account_metadata, key);
      if (value) ids.add(value);
    }
  }
  return ids;
}

export function isOwnComment(account: CommentAccountRef, author: CommentAuthorRef): boolean {
  if (author.id && ownIds(account).has(author.id)) return true;
  if (account.platform === "threads" && author.username && account.platform_username) {
    return author.username.replace(/^@/, "").toLowerCase() === account.platform_username.replace(/^@/, "").toLowerCase();
  }
  return false;
}
```

- [ ] **Step 4: Run tests** — Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/commentAuthor.ts supabase/functions/_shared/commentAuthor.test.ts
git commit -m "feat(comments): own-comment suppression rule per platform"
```

---

### Task 3: Generalise the dispatcher (filters, comment envelope, legacy guard)

**Files:**
- Modify: `supabase/functions/_shared/n8nMessagingDispatch.ts`
- Test: `supabase/functions/_shared/n8nMessagingDispatch.test.ts`

- [ ] **Step 1: Add failing tests** (append to the test file; `stubAdmin`/`Query` already exist at the bottom)

```ts
import { buildCommentPayload, dispatchN8nEvent } from "./n8nMessagingDispatch.ts";

const commentInput = {
  platform: "instagram" as const,
  socialAccountId: "account-ig",
  account: { id: "account-ig", platform: "instagram", platform_user_id: "1789", platform_username: "mybrand" },
  comment: { id: "c-1", kind: "comment" as const, text: "Nice!", parentCommentId: null, mediaUrl: null },
  post: { id: "m-1", url: "https://instagram.com/p/abc", caption: null },
  author: { id: "fan-1", name: null, username: "fan" },
  timestamp: "2026-08-22T10:00:00.000Z",
};

Deno.test("buildCommentPayload emits the comment envelope", () => {
  assertEquals(buildCommentPayload(commentInput), {
    event: "comment.received",
    platform: "instagram",
    social_account_id: "account-ig",
    account: { id: "account-ig", platform: "instagram", name: "mybrand", username: "mybrand", handle: "@mybrand" },
    comment: { id: "c-1", kind: "comment", text: "Nice!", parent_comment_id: null, media_url: null },
    post: { id: "m-1", url: "https://instagram.com/p/abc", caption: null },
    author: { id: "fan-1", name: null, username: "fan" },
    timestamp: "2026-08-22T10:00:00.000Z",
  });
});

Deno.test("dispatchN8nEvent honours platform and account filters and comment aliases", async () => {
  const requests: string[] = [];
  const admin = stubAdmin({
    settings: [
      { key: "k_a", value: { webhook_url: "https://alias.example", events: ["comment.instagram"], is_active: true } },
      { key: "k_b", value: { webhook_url: "https://generic.example", events: ["comment.received"], is_active: true } },
      { key: "k_c", value: { webhook_url: "https://other-platform.example", events: ["comment.received"], platform: "facebook", is_active: true } },
      { key: "k_d", value: { webhook_url: "https://other-account.example", events: ["comment.received"], social_account_id: "account-x", is_active: true } },
      { key: "k_e", value: { webhook_url: "https://this-account.example", events: ["comment.received"], platform: "instagram", social_account_id: "account-ig", is_active: true } },
      { key: "k_f", value: { webhook_url: "https://messages-only.example", events: ["message.received"], is_active: true } },
    ],
    legacy: [],
    updates: [],
  });
  await dispatchN8nEvent(admin, "user-1", buildCommentPayload(commentInput), {
    fetcher: async (url) => { requests.push(String(url)); return new Response(null, { status: 204 }); },
  });
  assertEquals(requests.sort(), ["https://alias.example", "https://generic.example", "https://this-account.example"]);
});

Deno.test("legacy whatsapp_webhooks rows never receive non-message events", async () => {
  const requests: string[] = [];
  const updates: Array<{ key: string; value: Record<string, unknown> }> = [];
  const admin = stubAdmin({
    settings: [],
    legacy: [{ id: "legacy-1", url: "https://legacy.example", secret: null, events: null, failure_count: 0, is_active: true }],
    updates,
  });
  await dispatchN8nEvent(admin, "user-1", buildCommentPayload(commentInput), {
    fetcher: async (url) => { requests.push(String(url)); return new Response(null, { status: 204 }); },
  });
  assertEquals(requests, []);
  assertEquals(updates, []);
});

Deno.test("message filters: a subscription pinned to another account does not receive this message", async () => {
  const requests: string[] = [];
  const admin = stubAdmin({
    settings: [
      { key: "k_a", value: { webhook_url: "https://pinned.example", events: ["message.received"], social_account_id: "account-2", is_active: true } },
    ],
    legacy: [],
    updates: [],
  });
  await dispatchMessageEvent(admin, "user-1", messagePayload, {
    fetcher: async (url) => { requests.push(String(url)); return new Response(null, { status: 204 }); },
  });
  assertEquals(requests, []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test --allow-env --allow-net supabase/functions/_shared/n8nMessagingDispatch.test.ts`
Expected: FAIL — `buildCommentPayload`/`dispatchN8nEvent` not exported.

- [ ] **Step 3: Implement the generalisation**

In `n8nMessagingDispatch.ts`:

(a) Add types + builder after `MessagePayload`:

```ts
export type CommentPlatform = "facebook" | "instagram" | "threads";
export type CommentKind = "comment" | "reply" | "mention";

export interface CommentPayloadInput {
  platform: CommentPlatform;
  socialAccountId: string;
  account?: MessagingAccountSource;
  comment: { id: string; kind: CommentKind; text: string; parentCommentId: string | null; mediaUrl: string | null };
  post: { id: string | null; url: string | null; caption: string | null };
  author: { id: string | null; name: string | null; username: string | null };
  timestamp?: string;
}

export interface CommentPayload {
  event: "comment.received";
  platform: CommentPlatform;
  social_account_id: string;
  account: MessagingAccountSummary;
  comment: { id: string; kind: CommentKind; text: string; parent_comment_id: string | null; media_url: string | null };
  post: CommentPayloadInput["post"];
  author: CommentPayloadInput["author"];
  timestamp: string;
}

// Any envelope the dispatcher can deliver. `event` drives subscription matching,
// `platform`/`social_account_id` drive the optional subscription filters.
export interface N8nEnvelope {
  event: string;
  platform: string;
  social_account_id: string;
  timestamp: string;
  [key: string]: unknown;
}

export function buildCommentPayload(input: CommentPayloadInput): CommentPayload {
  return {
    event: "comment.received",
    platform: input.platform,
    social_account_id: input.socialAccountId,
    account: describeMessagingAccount(input.account ?? { id: input.socialAccountId, platform: input.platform }),
    comment: {
      id: input.comment.id,
      kind: input.comment.kind,
      text: input.comment.text,
      parent_comment_id: input.comment.parentCommentId,
      media_url: input.comment.mediaUrl,
    },
    post: input.post,
    author: input.author,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}
```

Extend `describeMessagingAccount` so Threads gets a handle: change `const handleable = account.platform === "instagram" || account.platform === "facebook";` to include `|| account.platform === "threads"`.

(b) Extend `Destination` with `platform?: string; socialAccountId?: string;` and map them in `loadDestinations` from `row.value?.platform` / `row.value?.social_account_id` (settings registry only).

(c) Replace `dispatchMessageEvent` body with a wrapper, and rename the existing implementation:

```ts
export function dispatchMessageEvent(adminClient: any, userId: string, payload: MessagePayload, options: DispatchOptions = {}): Promise<void> {
  return dispatchN8nEvent(adminClient, userId, payload, options);
}

export async function dispatchN8nEvent(adminClient: any, userId: string, payload: N8nEnvelope, options: DispatchOptions = {}): Promise<void> {
  // ...existing body of dispatchMessageEvent, with these substitutions:
  //   loadDestinations(adminClient, userId, payload)
  //   payloadEvent(payload.platform) → aliasEvent(payload)
  //   console.log(... platform ${payload.platform}) unchanged
}
```

(d) Replace `loadDestinations` signature with `(adminClient, userId, payload: N8nEnvelope)` and its filter with:

```ts
    matching: configuredDestinations.filter((destination) =>
      destination.isActive && destination.url &&
      matchesSubscription(destination, payload)
    ),
```

(e) Replace `payloadEvent` + `matchesSubscription`:

```ts
// "message.received" on whatsapp also matches "message.whatsapp"; "comment.received" on
// instagram also matches "comment.instagram".
function aliasEvent(payload: N8nEnvelope): string {
  const [family] = payload.event.split(".");
  return `${family}.${payload.platform}`;
}

function matchesSubscription(destination: Destination, payload: N8nEnvelope): boolean {
  const { events, registry } = destination;
  const isMessage = payload.event.startsWith("message.");
  // whatsapp_webhooks predates the envelope and its delivery path reshapes the body as
  // a message (toLegacyPayload reads sender/message). Anything else must never reach it:
  // a thrown reshape would count as a failure and auto-disable a live WhatsApp webhook.
  if (registry === "legacy" && !isMessage) return false;
  if (destination.platform && destination.platform !== payload.platform) return false;
  if (destination.socialAccountId && destination.socialAccountId !== payload.social_account_id) return false;
  // whatsapp_webhooks rows with a null events column historically received every
  // message event; narrowing that here would silently cut off existing subscribers.
  if (events === null || events === undefined) return registry === "legacy";
  if (!Array.isArray(events)) return false;
  return events.includes("*") || events.includes(payload.event) || events.includes(aliasEvent(payload));
}
```

(f) Change `deliverToDestination`'s `payload: MessagePayload` to `payload: N8nEnvelope` and `toLegacyPayload(payload as unknown as MessagePayload)`.

- [ ] **Step 4: Run the whole dispatcher suite**

Run: `deno test --allow-env --allow-net supabase/functions/_shared/n8nMessagingDispatch.test.ts`
Expected: all pass (existing 13 + 4 new). If "dispatchMessageEvent names the owner when nothing is subscribed" fails on the warning text, keep `payloadEvent`-style text by using `aliasEvent(payload)` in the warn message.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/n8nMessagingDispatch.ts supabase/functions/_shared/n8nMessagingDispatch.test.ts
git commit -m "feat(n8n): event-agnostic dispatcher with comment envelope and platform/account filters"
```

---

### Task 4: Migration — allow `threads` in `social_inbox_events`

**Files:**
- Create: `supabase/migrations/20260822120000_social_inbox_events_threads.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Threads replies/mentions are deduplicated through the same inbox-events table as
-- Facebook/Instagram comments before being forwarded to n8n.
ALTER TABLE public.social_inbox_events
  DROP CONSTRAINT IF EXISTS social_inbox_events_platform_check;
ALTER TABLE public.social_inbox_events
  ADD CONSTRAINT social_inbox_events_platform_check
  CHECK (platform IN ('facebook', 'instagram', 'threads'));
```

- [ ] **Step 2: Confirm the constraint name on the live DB**

Run via `supabase_postora_mcp` `execute_sql`:
`SELECT conname FROM pg_constraint WHERE conrelid = 'public.social_inbox_events'::regclass AND contype = 'c';`
Expected: `social_inbox_events_platform_check` and `social_inbox_events_event_type_check`. If the platform constraint has a different name, use that name in the migration.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260822120000_social_inbox_events_threads.sql
git commit -m "feat(db): allow threads in social_inbox_events"
```

---

### Task 5: Facebook/Instagram webhook → dispatch comment events

**Files:**
- Modify: `supabase/functions/facebook-instagram-webhook/index.ts` (imports at top; `entry.changes` loop ~lines 222-234)
- Create: `supabase/functions/facebook-instagram-webhook/commentEvents.ts`
- Test: `supabase/functions/facebook-instagram-webhook/commentEvents.test.ts`

Meta payloads: Facebook `feed` change value `{ item: "comment", verb: "add", comment_id, post_id, parent_id?, from: { id, name }, message, created_time, post?: { permalink_url } }`. Instagram `comments` change value `{ id, text, from: { id, username }, media: { id, media_product_type }, parent_id? }`.

- [ ] **Step 1: Write failing tests for the normaliser**

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { normalizeMetaCommentChange } from "./commentEvents.ts";

Deno.test("facebook feed comment add → comment input", () => {
  const out = normalizeMetaCommentChange("facebook", {
    field: "feed",
    value: { item: "comment", verb: "add", comment_id: "123_456", post_id: "123_789", from: { id: "u1", name: "Fan" }, message: "Hi", created_time: 1755856800 },
  });
  assertEquals(out, {
    comment: { id: "123_456", kind: "comment", text: "Hi", parentCommentId: null, mediaUrl: null },
    post: { id: "123_789", url: null, caption: null },
    author: { id: "u1", name: "Fan", username: null },
    timestamp: "2026-08-22T10:00:00.000Z",
  });
});

Deno.test("facebook feed reply (has parent_id) → kind reply", () => {
  const out = normalizeMetaCommentChange("facebook", {
    field: "feed",
    value: { item: "comment", verb: "add", comment_id: "c2", post_id: "p1", parent_id: "c1", from: { id: "u1", name: "Fan" }, message: "Re" },
  });
  assertEquals(out?.comment.kind, "reply");
  assertEquals(out?.comment.parentCommentId, "c1");
});

Deno.test("facebook non-add verbs and non-comment items are ignored", () => {
  assertEquals(normalizeMetaCommentChange("facebook", { field: "feed", value: { item: "comment", verb: "remove", comment_id: "c" } }), null);
  assertEquals(normalizeMetaCommentChange("facebook", { field: "feed", value: { item: "like", verb: "add" } }), null);
});

Deno.test("instagram comments change → comment input", () => {
  const out = normalizeMetaCommentChange("instagram", {
    field: "comments",
    value: { id: "17891", text: "Nice", from: { id: "ig-fan", username: "fan" }, media: { id: "m1", media_product_type: "FEED" } },
  });
  assertEquals(out, {
    comment: { id: "17891", kind: "comment", text: "Nice", parentCommentId: null, mediaUrl: null },
    post: { id: "m1", url: null, caption: null },
    author: { id: "ig-fan", name: null, username: "fan" },
    timestamp: undefined,
  });
});

Deno.test("unrelated fields are ignored", () => {
  assertEquals(normalizeMetaCommentChange("instagram", { field: "mentions", value: {} }), null);
});
```

- [ ] **Step 2: Run to verify failure** — `deno test --allow-env supabase/functions/facebook-instagram-webhook/commentEvents.test.ts` → module not found.

- [ ] **Step 3: Implement the normaliser**

```ts
import type { CommentPayloadInput } from "../_shared/n8nMessagingDispatch.ts";

export type MetaCommentInput = Omit<CommentPayloadInput, "platform" | "socialAccountId" | "account">;

function toIso(value: unknown): string | undefined {
  if (typeof value === "number") return new Date(value * (value > 1e12 ? 1 : 1000)).toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

// Returns null for anything that is not a newly added comment; deletes, edits, likes
// and reaction changes share the same webhook field and must not trigger replies.
export function normalizeMetaCommentChange(platform: "facebook" | "instagram", change: any): MetaCommentInput | null {
  const value = change?.value;
  if (!value) return null;

  if (platform === "facebook") {
    if (change.field !== "feed" || value.item !== "comment" || value.verb !== "add" || !value.comment_id) return null;
    const parentId = value.parent_id && value.parent_id !== value.post_id ? String(value.parent_id) : null;
    return {
      comment: { id: String(value.comment_id), kind: parentId ? "reply" : "comment", text: String(value.message || ""), parentCommentId: parentId, mediaUrl: null },
      post: { id: value.post_id ? String(value.post_id) : null, url: value.post?.permalink_url || null, caption: null },
      author: { id: value.from?.id ? String(value.from.id) : null, name: value.from?.name || null, username: null },
      timestamp: toIso(value.created_time),
    };
  }

  if (change.field !== "comments" || !value.id) return null;
  const parentId = value.parent_id ? String(value.parent_id) : null;
  return {
    comment: { id: String(value.id), kind: parentId ? "reply" : "comment", text: String(value.text || ""), parentCommentId: parentId, mediaUrl: null },
    post: { id: value.media?.id ? String(value.media.id) : null, url: null, caption: null },
    author: { id: value.from?.id ? String(value.from.id) : null, name: null, username: value.from?.username || null },
    timestamp: toIso(value.timestamp),
  };
}
```

- [ ] **Step 4: Run tests** — Expected: 5 passed.

- [ ] **Step 5: Wire dispatch into the webhook**

Imports at top of `facebook-instagram-webhook/index.ts`:

```ts
import { resolveAutomationHandler, resolveCommentAutomationHandler } from "../_shared/automationHandler.ts";
import { buildCommentPayload, buildMessagePayload, dispatchMessageEvent, dispatchN8nEvent, shouldDispatchInboundMessage } from "../_shared/n8nMessagingDispatch.ts";
import { isOwnComment } from "../_shared/commentAuthor.ts";
import { normalizeMetaCommentChange } from "./commentEvents.ts";
```

Replace the `entry.changes` loop with:

```ts
        for (const change of entry?.changes || []) {
          const account = await findAccountForRecipient(adminClient, platform, recipientId);
          const externalEventId = change?.value?.comment_id || change?.value?.id;
          if (!account || !externalEventId) continue;

          const inboxResult = await recordInboxEvent(adminClient, {
            account,
            platform,
            eventType: "comment",
            externalEventId: String(externalEventId),
            payload: change,
          });
          if (inboxResult !== "inserted") continue;

          const normalized = normalizeMetaCommentChange(platform, change);
          if (!normalized) continue;
          if (isOwnComment(account, normalized.author)) {
            console.log(`[fb-ig-webhook] skipped own ${platform} comment ${externalEventId}`);
            continue;
          }
          if (resolveCommentAutomationHandler(account.account_metadata) !== "n8n") continue;

          await runInBackground("facebook-instagram comment dispatch", () => dispatchN8nEvent(
            adminClient,
            account.user_id,
            buildCommentPayload({ platform, socialAccountId: account.id, account, ...normalized }),
          ));
        }
```

`SocialAccountForMessaging` (from `_shared/messengerCredentials.ts`) must expose `platform_username`, `platform_user_id`, `account_metadata` — it does (`ACCOUNT_SELECT`). If the type lacks `platform_username`, add it there.

- [ ] **Step 6: Type-check the function**

Run: `deno check supabase/functions/facebook-instagram-webhook/index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/facebook-instagram-webhook
git commit -m "feat(webhook): forward new Facebook/Instagram comments to n8n"
```

---

### Task 6: Threads webhook — `replies` field + shared dispatcher for mentions

**Files:**
- Modify: `supabase/functions/threads-webhook/index.ts`
- Modify: `supabase/functions/threads-mentions/index.ts` (replace private `dispatchN8nEvent`)
- Create: `supabase/functions/threads-webhook/replyEvents.ts`
- Test: `supabase/functions/threads-webhook/replyEvents.test.ts`

Threads `replies` value: `{ id, username, text, media_type, permalink, replied_to: { id }, root_post: { id, owner_id, username }, shortcode, timestamp }`. Threads may deliver either `entry[].changes[]` (current parser) or a flat `{ topic, target_id, values: { field, value } }` envelope — handle both.

- [ ] **Step 1: Failing tests**

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { extractThreadsChanges, normalizeThreadsReply } from "./replyEvents.ts";

Deno.test("extractThreadsChanges reads entry/changes envelopes", () => {
  const out = extractThreadsChanges({ entry: [{ id: "th-1", changes: [{ field: "replies", value: { id: "r1" } }] }] });
  assertEquals(out, [{ targetId: "th-1", field: "replies", value: { id: "r1" } }]);
});

Deno.test("extractThreadsChanges reads flat topic/values envelopes", () => {
  const out = extractThreadsChanges({ topic: "moderate", target_id: "th-1", values: { field: "replies", value: { id: "r1" } } });
  assertEquals(out, [{ targetId: "th-1", field: "replies", value: { id: "r1" } }]);
});

Deno.test("normalizeThreadsReply maps the Meta reply shape", () => {
  const out = normalizeThreadsReply({
    id: "r1", username: "fan", text: "Hey", permalink: "https://threads.net/@fan/post/r1",
    replied_to: { id: "p1" }, root_post: { id: "p1", owner_id: "th-1", username: "mybrand" }, timestamp: "2026-08-22T10:00:00+0000",
  });
  assertEquals(out, {
    comment: { id: "r1", kind: "reply", text: "Hey", parentCommentId: "p1", mediaUrl: "https://threads.net/@fan/post/r1" },
    post: { id: "p1", url: null, caption: null },
    author: { id: null, name: null, username: "fan" },
    timestamp: "2026-08-22T10:00:00.000Z",
  });
});

Deno.test("normalizeThreadsReply rejects values without an id", () => {
  assertEquals(normalizeThreadsReply({ text: "x" }), null);
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

```ts
import type { CommentPayloadInput } from "../_shared/n8nMessagingDispatch.ts";

export interface ThreadsChange { targetId: string | null; field: string; value: any }

export function extractThreadsChanges(payload: any): ThreadsChange[] {
  const out: ThreadsChange[] = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      out.push({ targetId: entry?.id ? String(entry.id) : null, field: String(change?.field || ""), value: change?.value });
    }
  }
  if (payload?.values?.field) {
    out.push({ targetId: payload.target_id ? String(payload.target_id) : null, field: String(payload.values.field), value: payload.values.value });
  }
  return out;
}

export type ThreadsReplyInput = Omit<CommentPayloadInput, "platform" | "socialAccountId" | "account">;

export function normalizeThreadsReply(value: any): ThreadsReplyInput | null {
  if (!value?.id) return null;
  const parsed = value.timestamp ? new Date(value.timestamp) : null;
  return {
    comment: {
      id: String(value.id),
      kind: "reply",
      text: String(value.text || ""),
      parentCommentId: value.replied_to?.id ? String(value.replied_to.id) : null,
      mediaUrl: value.permalink || null,
    },
    post: { id: value.root_post?.id ? String(value.root_post.id) : null, url: null, caption: null },
    author: { id: null, name: null, username: value.username || null },
    timestamp: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined,
  };
}
```

- [ ] **Step 4: Run tests** — 4 passed.

- [ ] **Step 5: Rewrite the POST handler loop in `threads-webhook/index.ts`**

Imports: remove `postWebhook`; add

```ts
import { runInBackground } from "../_shared/background.ts";
import { buildCommentPayload, dispatchN8nEvent } from "../_shared/n8nMessagingDispatch.ts";
import { resolveCommentAutomationHandler } from "../_shared/automationHandler.ts";
import { isOwnComment } from "../_shared/commentAuthor.ts";
import { extractThreadsChanges, normalizeThreadsReply } from "./replyEvents.ts";
```

Delete the local `dispatchN8nEvent` function. Replace the `for (const entry of entries)` loop with:

```ts
  const ACCOUNT_SELECT = "id, user_id, platform, platform_user_id, platform_username, account_metadata, access_token";
  for (const change of extractThreadsChanges(payload)) {
    if (change.field !== "mentions" && change.field !== "replies") continue;
    const threadsUserId = change.targetId || change.value?.recipient_id || change.value?.root_post?.owner_id;
    if (!threadsUserId) continue;

    const { data: account } = await supabase
      .from("social_accounts")
      .select(ACCOUNT_SELECT)
      .eq("platform", "threads")
      .eq("platform_user_id", String(threadsUserId))
      .eq("is_active", true)
      .maybeSingle();
    if (!account) {
      console.warn(`[threads-webhook] no account for threads_user_id=${threadsUserId}`);
      continue;
    }

    if (change.field === "replies") {
      const normalized = normalizeThreadsReply(change.value);
      if (!normalized) continue;
      const { data: inserted, error: inboxError } = await supabase.from("social_inbox_events").upsert({
        user_id: account.user_id,
        social_account_id: account.id,
        platform: "threads",
        event_type: "comment",
        external_event_id: normalized.comment.id,
        payload: change.value,
      }, { onConflict: "social_account_id,external_event_id", ignoreDuplicates: true }).select("id");
      if (inboxError) { console.error("[threads-webhook] inbox persist failed", inboxError.message); continue; }
      if (!inserted?.length) continue;
      processed += 1;
      if (isOwnComment(account, normalized.author)) continue;
      if (resolveCommentAutomationHandler(account.account_metadata) !== "n8n") continue;
      await runInBackground("threads reply dispatch", () => dispatchN8nEvent(
        supabase,
        account.user_id,
        buildCommentPayload({ platform: "threads", socialAccountId: account.id, account, ...normalized }),
      ));
      continue;
    }

    // ── mentions (existing behaviour, now via the shared dispatcher) ──
    const norm = normalizeMentionEvent(change.value, change.targetId);
    if (!norm) continue;
    // ...keep the existing `existing` lookup, avatar fetch, upsertRow and upsert exactly as they are...
    processed += 1;
    const isNew = !existing;
    if (isNew && upserted) {
      await createMentionNotification(supabase, upserted);
      await runInBackground("threads mention dispatch", async () => {
        await dispatchN8nEvent(supabase, account.user_id, buildMentionEnvelope("threads.mention.created", account.id, upserted));
        if (resolveCommentAutomationHandler(account.account_metadata) === "n8n" && !isOwnComment(account, { id: norm.author_id || null, username: norm.username || null })) {
          await dispatchN8nEvent(supabase, account.user_id, buildCommentPayload({
            platform: "threads",
            socialAccountId: account.id,
            account,
            comment: { id: norm.mention_id, kind: "mention", text: norm.text || "", parentCommentId: null, mediaUrl: norm.permalink || null },
            post: { id: null, url: null, caption: null },
            author: { id: norm.author_id || null, name: null, username: norm.username || null },
            timestamp: norm.mentioned_at || undefined,
          }));
        }
      });
    }
  }
```

Add `buildMentionEnvelope` to `_shared/n8nMessagingDispatch.ts` so both Threads functions share it (keeps the legacy `data` body):

```ts
export function buildMentionEnvelope(event: "threads.mention.created" | "threads.mention.replied", socialAccountId: string, mention: any): N8nEnvelope {
  return {
    event,
    platform: "threads",
    social_account_id: socialAccountId,
    timestamp: new Date().toISOString(),
    data: {
      mention_id: mention.id,
      social_account_id: mention.social_account_id,
      platform: "threads",
      author_username: mention.mention_author_username,
      mention_text: mention.mention_text,
      mention_permalink: mention.mention_permalink,
      status: mention.status,
      sentiment: mention.sentiment,
      labels: mention.labels,
      assigned_to: mention.assigned_to,
      mentioned_at: mention.mentioned_at,
      source: mention.source,
    },
  };
}
```

In `threads-mentions/index.ts`: delete its private `dispatchN8nEvent` (lines ~119-176), import `buildMentionEnvelope, dispatchN8nEvent` from the shared module, and replace the three call sites (`:413`, `:523`, `:622`) with `asyncFire(dispatchN8nEvent(supabase, userId, buildMentionEnvelope(<event>, <socialAccountId>, <mention>)))` — each site already has the mention row; use `mention.social_account_id` for the account id.

- [ ] **Step 6: Type-check**

Run: `deno check supabase/functions/threads-webhook/index.ts supabase/functions/threads-mentions/index.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/threads-webhook supabase/functions/threads-mentions supabase/functions/_shared/n8nMessagingDispatch.ts
git commit -m "feat(threads): forward replies and mentions to n8n through the shared dispatcher"
```

---

### Task 7: Shared comment actions (reply / hide / delete)

**Files:**
- Create: `supabase/functions/_shared/commentActions.ts`
- Test: `supabase/functions/_shared/commentActions.test.ts`
- Modify: `supabase/functions/comment-manager/index.ts` (reply/hide/delete cases call the shared module)

- [ ] **Step 1: Failing tests** (fetch is injected so no network)

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deleteComment, hideComment, replyToComment } from "./commentActions.ts";

type Call = { url: string; init?: RequestInit };
function fakeFetch(calls: Call[], body: unknown = { id: "new-1" }, status = 200) {
  return async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

const fbAccount = { platform: "facebook", access_token: "tok", platform_user_id: "page", ig_auth_type: null, account_metadata: {} };
const igDirect = { platform: "instagram", access_token: "tok", platform_user_id: "ig", ig_auth_type: "business_login", account_metadata: {} };
const thAccount = { platform: "threads", access_token: "tok", platform_user_id: "th-1", ig_auth_type: null, account_metadata: {} };

Deno.test("facebook reply posts to /{comment}/replies on graph.facebook.com", async () => {
  const calls: Call[] = [];
  const result = await replyToComment(fbAccount, "c1", "Thanks!", fakeFetch(calls));
  assertEquals(result, { success: true, platform_comment_id: "new-1" });
  assertEquals(calls[0].url, "https://graph.facebook.com/v22.0/c1/replies");
});

Deno.test("direct-login instagram uses graph.instagram.com and hide uses the `hide` param", async () => {
  const calls: Call[] = [];
  await hideComment(igDirect, "c1", true, fakeFetch(calls, { success: true }));
  assertEquals(calls[0].url, "https://graph.instagram.com/v22.0/c1?hide=true&access_token=tok");
});

Deno.test("facebook hide uses is_hidden", async () => {
  const calls: Call[] = [];
  await hideComment(fbAccount, "c1", false, fakeFetch(calls, { success: true }));
  assertEquals(calls[0].url, "https://graph.facebook.com/v22.0/c1?is_hidden=false&access_token=tok");
});

Deno.test("threads reply creates a container then publishes", async () => {
  const calls: Call[] = [];
  let n = 0;
  const fetcher = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    n += 1;
    return new Response(JSON.stringify({ id: n === 1 ? "container-1" : "reply-1" }), { status: 200 });
  };
  const result = await replyToComment(thAccount, "r0", "Hi", fetcher);
  assertEquals(result, { success: true, platform_comment_id: "reply-1" });
  assertEquals(calls[0].url, "https://graph.threads.net/v1.0/th-1/threads");
  assertEquals(calls[1].url, "https://graph.threads.net/v1.0/th-1/threads_publish");
});

Deno.test("threads hide uses manage_reply and delete is refused", async () => {
  const calls: Call[] = [];
  await hideComment(thAccount, "r1", true, fakeFetch(calls, { success: true }));
  assertEquals(calls[0].url, "https://graph.threads.net/v1.0/r1/manage_reply");
  const result = await deleteComment(thAccount, "r1", fakeFetch(calls));
  assertEquals(result, { success: false, error: "Threads does not allow deleting other users' replies; use hide instead." });
});

Deno.test("graph errors are surfaced, not thrown", async () => {
  const calls: Call[] = [];
  const result = await replyToComment(fbAccount, "c1", "x", fakeFetch(calls, { error: { message: "(#10) Permission denied", code: 10 } }, 400));
  assertEquals(result.success, false);
  assertEquals(result.error, "(#10) Permission denied");
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

```ts
const GRAPH_API_VERSION = "v22.0";
const FACEBOOK_GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const INSTAGRAM_GRAPH = `https://graph.instagram.com/${GRAPH_API_VERSION}`;
const THREADS_GRAPH = "https://graph.threads.net/v1.0";

export interface CommentActionAccount {
  platform: string;
  access_token: string | null;
  platform_user_id?: string | null;
  ig_auth_type?: string | null;
  account_metadata?: unknown;
}

export interface CommentActionResult {
  success: boolean;
  platform_comment_id?: string;
  error?: string;
}

type Fetcher = typeof fetch;

// Mirrors comment-manager's rule: Instagram business-login tokens must use graph.instagram.com.
export function isDirectInstagramAccount(account: CommentActionAccount): boolean {
  const meta = (account.account_metadata && typeof account.account_metadata === "object" ? account.account_metadata : {}) as Record<string, unknown>;
  return account.platform === "instagram" && (
    account.ig_auth_type === "business_login" || meta.flow === "direct" || meta.source === "instagram_business_login" || meta.token_type === "long_lived"
  );
}

function metaBase(account: CommentActionAccount): string {
  return isDirectInstagramAccount(account) ? INSTAGRAM_GRAPH : FACEBOOK_GRAPH;
}

async function readJson(response: Response): Promise<any> {
  return await response.json().catch(() => ({ error: { message: response.statusText } }));
}

function failure(data: any, fallback: string): CommentActionResult {
  return { success: false, error: data?.error?.message || data?.error || fallback };
}

function requireToken(account: CommentActionAccount): string | CommentActionResult {
  return account.access_token || { success: false, error: "The account has no access token. Reconnect it in Profiles." };
}

export async function replyToComment(account: CommentActionAccount, commentId: string, message: string, fetcher: Fetcher = fetch): Promise<CommentActionResult> {
  const token = requireToken(account);
  if (typeof token !== "string") return token;
  if (account.platform === "threads") return replyOnThreads(account, token, commentId, message, fetcher);

  const response = await fetcher(`${metaBase(account)}/${encodeURIComponent(commentId)}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, access_token: token }),
  });
  const data = await readJson(response);
  if (!response.ok || data?.error) return failure(data, "Meta rejected the reply.");
  return { success: true, platform_comment_id: String(data.id) };
}

async function replyOnThreads(account: CommentActionAccount, token: string, replyToId: string, text: string, fetcher: Fetcher): Promise<CommentActionResult> {
  const userId = encodeURIComponent(String(account.platform_user_id || ""));
  const container = await fetcher(`${THREADS_GRAPH}/${userId}/threads`, {
    method: "POST",
    body: new URLSearchParams({ media_type: "TEXT", reply_to_id: replyToId, text, access_token: token }),
  });
  const containerData = await readJson(container);
  if (!container.ok || containerData?.error || !containerData?.id) return failure(containerData, "Threads rejected the reply container.");

  const publish = await fetcher(`${THREADS_GRAPH}/${userId}/threads_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: String(containerData.id), access_token: token }),
  });
  const publishData = await readJson(publish);
  if (!publish.ok || publishData?.error || !publishData?.id) return failure(publishData, "Threads rejected the reply publish.");
  return { success: true, platform_comment_id: String(publishData.id) };
}

export async function hideComment(account: CommentActionAccount, commentId: string, hide: boolean, fetcher: Fetcher = fetch): Promise<CommentActionResult> {
  const token = requireToken(account);
  if (typeof token !== "string") return token;

  if (account.platform === "threads") {
    const response = await fetcher(`${THREADS_GRAPH}/${encodeURIComponent(commentId)}/manage_reply`, {
      method: "POST",
      body: new URLSearchParams({ hide: String(hide), access_token: token }),
    });
    const data = await readJson(response);
    if (!response.ok || data?.error) return failure(data, "Threads rejected the hide request.");
    return { success: true, platform_comment_id: commentId };
  }

  // Instagram comment objects take `hide`; Facebook ones take `is_hidden`.
  const param = account.platform === "instagram" ? "hide" : "is_hidden";
  const response = await fetcher(`${metaBase(account)}/${encodeURIComponent(commentId)}?${param}=${hide}&access_token=${encodeURIComponent(token)}`, { method: "POST" });
  const data = await readJson(response);
  if (!response.ok || data?.error) return failure(data, "Meta rejected the hide request.");
  return { success: true, platform_comment_id: commentId };
}

export async function deleteComment(account: CommentActionAccount, commentId: string, fetcher: Fetcher = fetch): Promise<CommentActionResult> {
  if (account.platform === "threads") {
    return { success: false, error: "Threads does not allow deleting other users' replies; use hide instead." };
  }
  const token = requireToken(account);
  if (typeof token !== "string") return token;
  const response = await fetcher(`${metaBase(account)}/${encodeURIComponent(commentId)}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
  const data = await readJson(response);
  if (!response.ok || data?.error) return failure(data, "Meta rejected the delete request.");
  return { success: true, platform_comment_id: commentId };
}
```

- [ ] **Step 4: Run tests** — 6 passed.

- [ ] **Step 5: Route `comment-manager` through the shared module**

In `supabase/functions/comment-manager/index.ts` import `{ replyToComment, hideComment, deleteComment }` and replace the bodies of `reply_comment`, `hide_comment`, `delete_comment` cases (keep their 400 guards):

```ts
      case "reply_comment": {
        if (!comment_id || !message || !accessToken) { /* existing 400 */ }
        result = await replyToComment(socialAccount!, comment_id, message);
        break;
      }
      case "hide_comment": {
        if (!comment_id || !accessToken) { /* existing 400 */ }
        result = await hideComment(socialAccount!, comment_id, body.is_hidden !== undefined ? body.is_hidden : true);
        break;
      }
      case "delete_comment": {
        if (!comment_id || !accessToken) { /* existing 400 */ }
        result = await deleteComment(socialAccount!, comment_id);
        break;
      }
```

The frontend (`useCommentInbox.ts`) expects the raw Graph JSON today (`{ id }` / `{ success: true }` / Graph `error`). Check `useCommentInbox.ts:178-220` for how it reads the response and keep compatibility: return `{ id: result.platform_comment_id, success: result.success, error: result.error }` for reply, and `{ success, error }` for hide/delete. Run `npx vitest run src/hooks/__tests__/useCommentInbox.test.ts` — must stay green.

Delete the now-unused local `isDirectInstagramAccount` from `comment-manager` if nothing else there uses it (`get_ig_comments` still does — keep it, or import the shared one).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/commentActions.ts supabase/functions/_shared/commentActions.test.ts supabase/functions/comment-manager/index.ts
git commit -m "refactor(comments): share reply/hide/delete Graph calls between comment-manager and n8n-api"
```

---

### Task 8: `n8n-api` — allowlist, subscription filters, `/api/v1/comments/*`

**Files:**
- Modify: `supabase/functions/n8n-api/index.ts` (`RATE_LIMITS` ~15, `ALLOWED_WEBHOOK_EVENTS` ~25, `handleRegisterWebhook` ~1442, `handleGetWebhooks` ~1518, router ~2055, 404 list ~2088)
- Create: `supabase/functions/n8n-api/webhookFilters.ts` + `webhookFilters.test.ts`

- [ ] **Step 1: Failing tests for filter validation (pure function)**

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseSubscriptionFilters } from "./webhookFilters.ts";

Deno.test("no filters → empty object", () => {
  assertEquals(parseSubscriptionFilters({}), { ok: true, filters: {} });
});

Deno.test("valid platform is kept", () => {
  assertEquals(parseSubscriptionFilters({ platform: "threads" }), { ok: true, filters: { platform: "threads" } });
});

Deno.test("unknown platform is rejected", () => {
  assertEquals(parseSubscriptionFilters({ platform: "myspace" }), { ok: false, error: "platform must be one of facebook, instagram, threads, whatsapp" });
});

Deno.test("social_account_id must be a UUID", () => {
  assertEquals(parseSubscriptionFilters({ social_account_id: "nope" }), { ok: false, error: "social_account_id must be a UUID" });
  assertEquals(
    parseSubscriptionFilters({ social_account_id: "3f2b1a0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c" }),
    { ok: true, filters: { social_account_id: "3f2b1a0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c" } },
  );
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `webhookFilters.ts`**

```ts
export const SUBSCRIPTION_PLATFORMS = ["facebook", "instagram", "threads", "whatsapp"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SubscriptionFilters { platform?: string; social_account_id?: string }

export function parseSubscriptionFilters(body: any): { ok: true; filters: SubscriptionFilters } | { ok: false; error: string } {
  const filters: SubscriptionFilters = {};
  if (body?.platform !== undefined && body.platform !== "") {
    if (!(SUBSCRIPTION_PLATFORMS as readonly unknown[]).includes(body.platform)) {
      return { ok: false, error: `platform must be one of ${SUBSCRIPTION_PLATFORMS.join(", ")}` };
    }
    filters.platform = body.platform;
  }
  if (body?.social_account_id !== undefined && body.social_account_id !== "") {
    if (typeof body.social_account_id !== "string" || !UUID_RE.test(body.social_account_id)) {
      return { ok: false, error: "social_account_id must be a UUID" };
    }
    filters.social_account_id = body.social_account_id;
  }
  return { ok: true, filters };
}
```

- [ ] **Step 4: Run tests** — 4 passed.

- [ ] **Step 5: Wire into `n8n-api/index.ts`**

(a) Allowlist:

```ts
const ALLOWED_WEBHOOK_EVENTS = new Set([
  'post.completed', 'post.failed', 'post.published',
  'message.received', 'message.whatsapp', 'message.instagram', 'message.facebook',
  'comment.received', 'comment.facebook', 'comment.instagram', 'comment.threads',
  'threads.mention.created', 'threads.mention.replied',
  '*',
]);
```

(b) Rate limits: add `'/api/v1/comments/reply': { requests: 120, windowMs: 60 * 60 * 1000 }, '/api/v1/comments/hide': { requests: 120, windowMs: 60 * 60 * 1000 }, '/api/v1/comments/delete': { requests: 60, windowMs: 60 * 60 * 1000 },`.

(c) `handleRegisterWebhook`: after the events check add

```ts
  const parsedFilters = parseSubscriptionFilters(body);
  if (!parsedFilters.ok) return apiError(req, parsedFilters.error, 400, 'INVALID_FILTER');
  const { filters } = parsedFilters;
  if (filters.social_account_id) {
    const { data: account } = await supabase
      .from('social_accounts')
      .select('id, user_id, platform')
      .eq('id', filters.social_account_id)
      .maybeSingle();
    if (!account || account.user_id !== userId) {
      return apiError(req, 'Social account not found or not owned by the authenticated user.', 404, 'ACCOUNT_NOT_FOUND');
    }
    if (filters.platform && filters.platform !== account.platform) {
      return apiError(req, 'platform does not match the selected social account', 400, 'INVALID_PLATFORM');
    }
  }
```

Store `...filters` inside the `value` object of the upsert, and include `...filters` in the `webhook` object of the 201 response.

(d) `handleGetWebhooks`: add `platform: s.value.platform ?? null, social_account_id: s.value.social_account_id ?? null` to each mapped webhook.

(e) Comment handlers (place after `handleMessageReply`):

```ts
async function loadOwnedCommentAccount(req: Request, supabase: any, userId: string, body: any) {
  const accountId = typeof body?.social_account_id === 'string' ? body.social_account_id : '';
  const commentId = typeof body?.comment_id === 'string' ? body.comment_id.trim() : '';
  if (!accountId || !commentId) {
    return { error: apiError(req, 'social_account_id and comment_id are required', 400, 'INVALID_COMMENT_REQUEST') };
  }
  const { data: account, error } = await supabase
    .from('social_accounts')
    .select('id, user_id, platform, platform_user_id, platform_username, ig_auth_type, account_metadata, access_token')
    .eq('id', accountId)
    .maybeSingle();
  if (error) return { error: apiError(req, 'Failed to fetch social account', 500, 'INTERNAL_ERROR') };
  if (!account || account.user_id !== userId) {
    return { error: apiError(req, 'Social account not found or not owned by the authenticated user.', 404, 'ACCOUNT_NOT_FOUND') };
  }
  if (!['facebook', 'instagram', 'threads'].includes(account.platform)) {
    return { error: apiError(req, 'Comments are supported for Facebook, Instagram and Threads accounts', 400, 'INVALID_PLATFORM') };
  }
  if (typeof body?.platform === 'string' && body.platform && body.platform !== account.platform) {
    return { error: apiError(req, 'platform does not match the selected social account', 400, 'INVALID_PLATFORM') };
  }
  return { account, commentId };
}

function commentActionResponse(req: Request, result: CommentActionResult): Response {
  if (!result.success) {
    const detail = result.error && containsSensitiveInfo(result.error) ? 'the platform rejected the request' : result.error;
    return apiError(req, `Comment action failed: ${detail}`, 502, 'COMMENT_ACTION_FAILED');
  }
  return new Response(
    JSON.stringify({ success: true, platform_comment_id: result.platform_comment_id }),
    { status: 200, headers: { ...restrictedCorsHeaders(req), 'Content-Type': 'application/json' } },
  );
}

async function handleCommentReply(req: Request, supabase: any, userId: string, body: any) {
  const loaded = await loadOwnedCommentAccount(req, supabase, userId, body);
  if ('error' in loaded) return loaded.error;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return apiError(req, 'message is required', 400, 'INVALID_COMMENT_REQUEST');
  return commentActionResponse(req, await replyToComment(loaded.account, loaded.commentId, message));
}

async function handleCommentHide(req: Request, supabase: any, userId: string, body: any) {
  const loaded = await loadOwnedCommentAccount(req, supabase, userId, body);
  if ('error' in loaded) return loaded.error;
  const hide = body?.hide === undefined ? true : body.hide === true || body.hide === 'true';
  return commentActionResponse(req, await hideComment(loaded.account, loaded.commentId, hide));
}

async function handleCommentDelete(req: Request, supabase: any, userId: string, body: any) {
  const loaded = await loadOwnedCommentAccount(req, supabase, userId, body);
  if ('error' in loaded) return loaded.error;
  if (loaded.account.platform === 'threads') {
    return apiError(req, 'Threads replies cannot be deleted through the API; use hide instead.', 400, 'UNSUPPORTED_PLATFORM');
  }
  return commentActionResponse(req, await deleteComment(loaded.account, loaded.commentId));
}
```

Imports: `import { type CommentActionResult, deleteComment, hideComment, replyToComment } from "../_shared/commentActions.ts"; import { parseSubscriptionFilters } from "./webhookFilters.ts";`

(f) Router — before the 404 branch:

```ts
    } else if (path === '/api/v1/comments/reply' && req.method === 'POST') {
      response = await handleCommentReply(req, supabaseAdmin, userId, await parseRequestBody(req));
    } else if (path === '/api/v1/comments/hide' && req.method === 'POST') {
      response = await handleCommentHide(req, supabaseAdmin, userId, await parseRequestBody(req));
    } else if (path === '/api/v1/comments/delete' && req.method === 'POST') {
      response = await handleCommentDelete(req, supabaseAdmin, userId, await parseRequestBody(req));
```

and add the three routes to `available_endpoints`.

- [ ] **Step 6: Type-check + targeted smoke**

Run: `deno check supabase/functions/n8n-api/index.ts` → clean.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/n8n-api
git commit -m "feat(n8n-api): comment events, subscription filters and /api/v1/comments endpoints"
```

---

### Task 9: `messaging-api` — get/set automation handlers

**Files:**
- Modify: `supabase/functions/messaging-api/index.ts` (add actions next to `ai_get_config`, ~line 317)

- [ ] **Step 1: Add the actions**

```ts
    // ACTION: get_automation_handlers
    if (action === "get_automation_handlers") {
      const account = await getAccountToken(String(body.social_account_id || ""));
      return jsonResponse({
        social_account_id: account.id,
        platform: account.platform,
        automation_handler: resolveAutomationHandler(account.account_metadata),
        comment_automation_handler: resolveCommentAutomationHandler(account.account_metadata),
      });
    }

    // ACTION: set_automation_handlers — read-merge-write so other metadata keys (ig_igid, flow, …) survive.
    if (action === "set_automation_handlers") {
      const account = await getAccountToken(String(body.social_account_id || ""));
      const patch: Record<string, string> = {};
      if (body.automation_handler !== undefined) {
        if (!(MESSAGE_AUTOMATION_HANDLERS as readonly unknown[]).includes(body.automation_handler)) {
          return jsonResponse({ error: "automation_handler must be internal, n8n or off" }, 400);
        }
        patch.automation_handler = body.automation_handler;
      }
      if (body.comment_automation_handler !== undefined) {
        if (!(COMMENT_AUTOMATION_HANDLERS as readonly unknown[]).includes(body.comment_automation_handler)) {
          return jsonResponse({ error: "comment_automation_handler must be off, internal or n8n" }, 400);
        }
        if (body.comment_automation_handler === "internal") {
          return jsonResponse({ error: "The Postora AI agent does not handle comments yet" }, 400);
        }
        patch.comment_automation_handler = body.comment_automation_handler;
      }
      if (Object.keys(patch).length === 0) return jsonResponse({ error: "Nothing to update" }, 400);

      const existing = (account.account_metadata && typeof account.account_metadata === "object") ? account.account_metadata as Record<string, unknown> : {};
      const { error } = await adminClient
        .from("social_accounts")
        .update({ account_metadata: { ...existing, ...patch } })
        .eq("id", account.id)
        .eq("user_id", user.id);
      if (error) throw error;
      return jsonResponse({
        social_account_id: account.id,
        automation_handler: resolveAutomationHandler({ ...existing, ...patch }),
        comment_automation_handler: resolveCommentAutomationHandler({ ...existing, ...patch }),
      });
    }
```

Import: `import { COMMENT_AUTOMATION_HANDLERS, MESSAGE_AUTOMATION_HANDLERS, resolveAutomationHandler, resolveCommentAutomationHandler } from "../_shared/automationHandler.ts";`

- [ ] **Step 2: Type-check** — `deno check supabase/functions/messaging-api/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/messaging-api/index.ts
git commit -m "feat(messaging-api): read and set per-account automation handlers"
```

---

### Task 10: Web app — `useAutomationHandlers` hook

**Files:**
- Create: `src/hooks/useAutomationHandlers.ts`
- Test: `src/hooks/__tests__/useAutomationHandlers.test.ts`

- [ ] **Step 1: Failing test** (mirror the mocking style of `src/hooks/__tests__/useCommentInbox.test.ts` — mock `@/lib/messagingApi` and `@/hooks/useAuth`)

```ts
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

const callMessagingApi = vi.fn();
vi.mock("@/lib/messagingApi", () => ({ callMessagingApi: (...args: unknown[]) => callMessagingApi(...args) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: { user: { id: "u1" } } }) }));

import { useAutomationHandlers } from "@/hooks/useAutomationHandlers";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useAutomationHandlers", () => {
  beforeEach(() => callMessagingApi.mockReset());

  it("loads handlers for the account", async () => {
    callMessagingApi.mockResolvedValueOnce({ social_account_id: "a1", platform: "instagram", automation_handler: "internal", comment_automation_handler: "off" });
    const { result } = renderHook(() => useAutomationHandlers("a1"), { wrapper });
    await waitFor(() => expect(result.current.handlers?.comment_automation_handler).toBe("off"));
    expect(callMessagingApi).toHaveBeenCalledWith("get_automation_handlers", { social_account_id: "a1" });
  });

  it("saves a partial update", async () => {
    callMessagingApi.mockResolvedValueOnce({ social_account_id: "a1", platform: "instagram", automation_handler: "internal", comment_automation_handler: "off" });
    callMessagingApi.mockResolvedValueOnce({ social_account_id: "a1", automation_handler: "internal", comment_automation_handler: "n8n" });
    const { result } = renderHook(() => useAutomationHandlers("a1"), { wrapper });
    await waitFor(() => expect(result.current.handlers).toBeTruthy());
    await act(async () => { await result.current.save.mutateAsync({ comment_automation_handler: "n8n" }); });
    expect(callMessagingApi).toHaveBeenLastCalledWith("set_automation_handlers", { social_account_id: "a1", comment_automation_handler: "n8n" });
  });

  it("does not query without an account", () => {
    renderHook(() => useAutomationHandlers(null), { wrapper });
    expect(callMessagingApi).not.toHaveBeenCalled();
  });
});
```

Save as `.test.tsx` (JSX in wrapper).

- [ ] **Step 2: Run** — `npx vitest run src/hooks/__tests__/useAutomationHandlers.test.tsx` → fails (module missing).

- [ ] **Step 3: Implement**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callMessagingApi } from "@/lib/messagingApi";

export type MessageAutomationHandler = "internal" | "n8n" | "off";
export type CommentAutomationHandler = "off" | "internal" | "n8n";

export interface AutomationHandlers {
  social_account_id: string;
  platform: string;
  automation_handler: MessageAutomationHandler;
  comment_automation_handler: CommentAutomationHandler;
}

export type AutomationHandlersPatch = Partial<Pick<AutomationHandlers, "automation_handler" | "comment_automation_handler">>;

export function useAutomationHandlers(socialAccountId: string | null) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["automation-handlers", socialAccountId];

  const query = useQuery({
    queryKey,
    queryFn: async () => (await callMessagingApi("get_automation_handlers", { social_account_id: socialAccountId })) as AutomationHandlers,
    enabled: !!session && !!socialAccountId,
  });

  const save = useMutation({
    mutationFn: async (patch: AutomationHandlersPatch) =>
      (await callMessagingApi("set_automation_handlers", { social_account_id: socialAccountId, ...patch })) as AutomationHandlers,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return { handlers: query.data, isLoading: query.isLoading, error: query.error, save };
}
```

- [ ] **Step 4: Run** — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useAutomationHandlers.ts src/hooks/__tests__/useAutomationHandlers.test.tsx
git commit -m "feat(web): useAutomationHandlers hook"
```

---

### Task 11: Web app — `AutomationHandlerCard` + mount on three pages

**Files:**
- Create: `src/components/messaging/AutomationHandlerCard.tsx`
- Test: `src/components/messaging/__tests__/AutomationHandlerCard.test.tsx`
- Modify: `src/pages/messaging/FacebookMessaging.tsx`, `InstagramMessaging.tsx` (Auto Replies tab), `ThreadsMentions.tsx` (Replies tab, ~line 352)

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

const save = { mutate: vi.fn(), isPending: false };
vi.mock("@/hooks/useAutomationHandlers", () => ({
  useAutomationHandlers: () => ({
    handlers: { social_account_id: "a1", platform: "instagram", automation_handler: "internal", comment_automation_handler: "off" },
    isLoading: false,
    save,
  }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: [{ id: "a1", platform: "instagram", platform_username: "mybrand", is_active: true }] }),
}));

import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";

describe("AutomationHandlerCard", () => {
  it("shows Messages and Comments rows for Instagram", () => {
    render(<AutomationHandlerCard platform="instagram" />);
    expect(screen.getByText("Messages")).toBeInTheDocument();
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(screen.getByTestId("messages-handler")).toHaveTextContent("Postora AI Agent");
    expect(screen.getByTestId("comments-handler")).toHaveTextContent("Off");
  });

  it("hides the Messages row on Threads", () => {
    render(<AutomationHandlerCard platform="threads" />);
    expect(screen.queryByText("Messages")).not.toBeInTheDocument();
    expect(screen.getByText("Comments")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run** → fails (module missing).

- [ ] **Step 3: Implement**

```tsx
import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import {
  useAutomationHandlers,
  type CommentAutomationHandler,
  type MessageAutomationHandler,
} from "@/hooks/useAutomationHandlers";

interface AutomationHandlerCardProps {
  platform: "facebook" | "instagram" | "threads";
}

const MESSAGE_OPTIONS: Array<{ value: MessageAutomationHandler; label: string }> = [
  { value: "off", label: "Off" },
  { value: "internal", label: "Postora AI Agent" },
  { value: "n8n", label: "n8n" },
];

const COMMENT_OPTIONS: Array<{ value: CommentAutomationHandler; label: string; disabled?: boolean; hint?: string }> = [
  { value: "off", label: "Off" },
  { value: "internal", label: "Postora AI Agent", disabled: true, hint: "Coming in a later update" },
  { value: "n8n", label: "n8n" },
];

export function AutomationHandlerCard({ platform }: AutomationHandlerCardProps) {
  const { data: socialAccounts = [] } = useSocialAccounts();
  const accounts = useMemo(() => socialAccounts.filter((a) => a.platform === platform && a.is_active), [socialAccounts, platform]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const accountId = selectedId && accounts.some((a) => a.id === selectedId) ? selectedId : accounts[0]?.id ?? null;
  const { handlers, isLoading, save } = useAutomationHandlers(accountId);

  if (accounts.length === 0) return null;

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Automation</CardTitle>
        <CardDescription>
          Exactly one handler answers each channel. n8n requires a Postora Comment Trigger (or Postora Trigger) workflow.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={accountId ?? ""} onValueChange={setSelectedId}>
          <SelectTrigger className="w-full max-w-xs"><SelectValue placeholder="Select account" /></SelectTrigger>
          <SelectContent>
            {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.platform_username || a.platform_user_id}</SelectItem>)}
          </SelectContent>
        </Select>

        {platform !== "threads" && (
          <HandlerRow
            label="Messages"
            testId="messages-handler"
            value={handlers?.automation_handler ?? "internal"}
            options={MESSAGE_OPTIONS}
            disabled={isLoading || save.isPending}
            onChange={(value) => save.mutate({ automation_handler: value as MessageAutomationHandler })}
          />
        )}
        <HandlerRow
          label="Comments"
          testId="comments-handler"
          value={handlers?.comment_automation_handler ?? "off"}
          options={COMMENT_OPTIONS}
          disabled={isLoading || save.isPending}
          onChange={(value) => save.mutate({ comment_automation_handler: value as CommentAutomationHandler })}
        />
      </CardContent>
    </Card>
  );
}

interface HandlerRowProps {
  label: string;
  testId: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean; hint?: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}

function HandlerRow({ label, testId, value, options, disabled, onChange }: HandlerRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium">{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-48" data-testid={testId}><SelectValue /></SelectTrigger>
        <SelectContent>
          <TooltipProvider>
            {options.map((option) => option.disabled ? (
              <Tooltip key={option.value}>
                <TooltipTrigger asChild>
                  <div><SelectItem value={option.value} disabled>{option.label}</SelectItem></div>
                </TooltipTrigger>
                <TooltipContent>{option.hint}</TooltipContent>
              </Tooltip>
            ) : (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </TooltipProvider>
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 4: Run** — 2 passed. (If Radix `Select` needs `ResizeObserver`/`hasPointerCapture` polyfills under jsdom, check `src/test/setup.ts` — other Select tests in the repo already run, so it should exist.)

- [ ] **Step 5: Mount the card**

`FacebookMessaging.tsx` and `InstagramMessaging.tsx` — inside the `auto-replies` `TabsContent`, above `<AutoReplyManager … />`:

```tsx
<AutomationHandlerCard platform="facebook" />   // "instagram" on the IG page
```

`ThreadsMentions.tsx` — inside `<TabsContent value="replies">` before `<ThreadsRepliesTab … />`:

```tsx
<AutomationHandlerCard platform="threads" />
```

Add the import `import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";` on all three pages.

- [ ] **Step 6: Full web gates**

Run: `npx vitest run` → 0 failures (baseline 474 passed). Run: `npm run build` → success.

- [ ] **Step 7: Commit**

```bash
git add src/components/messaging/AutomationHandlerCard.tsx src/components/messaging/__tests__/AutomationHandlerCard.test.tsx src/pages/messaging
git commit -m "feat(web): per-account automation handler switch for messages and comments"
```

---

### Task 12: Node — shared webhook lifecycle helpers + Comment Trigger

All edits in `F:\N8N\Postora-n8n-community-node`, then synced to `F:\Postora_new\Postora-n8n-community-node` in Task 14.

**Files:**
- Create: `nodes/shared/webhookLifecycle.ts`
- Modify: `nodes/PostoraTrigger/PostoraTrigger.node.ts` (import helpers instead of local copies)
- Create: `nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts`
- Test: `__tests__/PostoraCommentTrigger.node.test.ts`

- [ ] **Step 1: Extract helpers**

`nodes/shared/webhookLifecycle.ts`:

```ts
import { IAllExecuteFunctions, IHookFunctions } from "n8n-workflow";

export type WebhookRegistration = { webhook: { id: string } };

export type RegisteredWebhook = {
  id?: string;
  webhook_url?: string;
  events?: string[];
  is_active?: boolean;
  platform?: string | null;
  social_account_id?: string | null;
};

export type WebhookListing = { webhooks?: RegisteredWebhook[] };

export function sameEventSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((event, index) => event === sortedRight[index]);
}

/**
 * A 404 means the subscription is already gone, which is the outcome the delete wanted. n8n
 * surfaces the upstream status differently depending on the HTTP helper, so several shapes
 * are checked rather than assuming one.
 */
export function isAlreadyGone(error: unknown): boolean {
  const candidate = error as { statusCode?: number; httpCode?: number | string; response?: { status?: number } };
  return candidate?.statusCode === 404 || candidate?.response?.status === 404 || Number(candidate?.httpCode) === 404;
}

export async function unregisterWebhook(context: IHookFunctions, baseUrl: string, webhookId: string): Promise<void> {
  await context.helpers.httpRequestWithAuthentication.call(
    context as unknown as IAllExecuteFunctions,
    "postoraApi",
    { method: "DELETE", url: `${baseUrl}/api/v1/webhooks/${webhookId}` },
  );
}

export async function listWebhooks(context: IHookFunctions, baseUrl: string): Promise<WebhookListing> {
  return await context.helpers.httpRequestWithAuthentication.call(
    context as unknown as IAllExecuteFunctions,
    "postoraApi",
    { method: "GET", url: `${baseUrl}/api/v1/webhooks` },
  ) as WebhookListing;
}
```

In `PostoraTrigger.node.ts` delete the local `sameEventSet`, `isAlreadyGone`, `unregisterWebhook`, `WebhookRegistration`, `WebhookListing` and import them from `../shared/webhookLifecycle`. Run `npm test` — the existing trigger suite must stay green.

- [ ] **Step 2: Failing tests for the Comment Trigger**

```ts
import { PostoraCommentTrigger } from "../nodes/PostoraCommentTrigger/PostoraCommentTrigger.node";

type WebhookRequest = { method: string; url: string; body?: unknown };
const CALLBACK_URL = "https://n8n.example.test/webhook/postora-comment";

function createHookContext(overrides: {
  staticData?: Record<string, unknown>;
  params?: Record<string, unknown>;
  listing?: unknown[];
  callbackUrl?: string | undefined;
}) {
  const requests: WebhookRequest[] = [];
  const staticData = overrides.staticData ?? {};
  const params = { platform: "", socialAccountId: "", events: ["comment.received"], ...(overrides.params ?? {}) };
  return {
    context: {
      getCredentials: async () => ({ baseUrl: "https://api.example.test" }),
      getNodeParameter: (name: string) => (params as Record<string, unknown>)[name],
      getNodeWebhookUrl: () => ("callbackUrl" in overrides ? overrides.callbackUrl : CALLBACK_URL),
      getWorkflowStaticData: () => staticData,
      helpers: {
        httpRequestWithAuthentication: function (_c: string, request: WebhookRequest) {
          requests.push(request);
          if (request.method === "GET") return Promise.resolve({ webhooks: overrides.listing ?? [] });
          return Promise.resolve({ webhook: { id: "sub-1" } });
        },
      },
    },
    requests,
    staticData,
  };
}

describe("Postora Comment Trigger", () => {
  it("exposes platform, account and events properties in that order", () => {
    const names = new PostoraCommentTrigger().description.properties.map((p) => p.name);
    expect(names).toEqual(["platform", "socialAccountId", "events"]);
  });

  it("registers the callback with platform and account filters", async () => {
    const { context, requests, staticData } = createHookContext({ params: { platform: "instagram", socialAccountId: "acc-1" } });
    await new PostoraCommentTrigger().webhookMethods.default.create.call(context as any);
    expect(requests[0]).toEqual({
      method: "POST",
      url: "https://api.example.test/api/v1/webhooks",
      body: { webhook_url: CALLBACK_URL, events: ["comment.received"], platform: "instagram", social_account_id: "acc-1" },
    });
    expect(staticData.webhookId).toBe("sub-1");
  });

  it("omits empty filters (All platforms / All accounts)", async () => {
    const { context, requests } = createHookContext({});
    await new PostoraCommentTrigger().webhookMethods.default.create.call(context as any);
    expect(requests[0].body).toEqual({ webhook_url: CALLBACK_URL, events: ["comment.received"] });
  });

  it("keeps a subscription whose url, events and filters still match", async () => {
    const { context, requests } = createHookContext({
      staticData: { webhookId: "sub-1" },
      params: { platform: "threads", socialAccountId: "acc-2" },
      listing: [{ id: "sub-1", webhook_url: CALLBACK_URL, events: ["comment.received"], is_active: true, platform: "threads", social_account_id: "acc-2" }],
    });
    expect(await new PostoraCommentTrigger().webhookMethods.default.checkExists.call(context as any)).toBe(true);
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("retires a subscription whose account filter changed", async () => {
    const { context, requests, staticData } = createHookContext({
      staticData: { webhookId: "sub-1" },
      params: { platform: "threads", socialAccountId: "acc-3" },
      listing: [{ id: "sub-1", webhook_url: CALLBACK_URL, events: ["comment.received"], is_active: true, platform: "threads", social_account_id: "acc-2" }],
    });
    expect(await new PostoraCommentTrigger().webhookMethods.default.checkExists.call(context as any)).toBe(false);
    expect(requests.map((r) => r.method)).toEqual(["GET", "DELETE"]);
    expect(staticData.webhookId).toBeUndefined();
  });

  it("loads accounts filtered by the selected platform with an All option first", async () => {
    const node = new PostoraCommentTrigger();
    const ctx = {
      getCredentials: async () => ({ baseUrl: "https://api.example.test" }),
      getCurrentNodeParameter: () => "facebook",
      helpers: {
        httpRequestWithAuthentication: async (_c: string, req: { url: string }) => {
          expect(req.url).toBe("https://api.example.test/api/v1/accounts?platform=facebook");
          return { accounts: [{ id: "acc-1", platform: "facebook", platform_username: "My Page" }] };
        },
      },
    };
    const options = await node.methods.loadOptions.getCommentAccounts.call(ctx as any);
    expect(options).toEqual([
      { name: "All accounts", value: "" },
      { name: "My Page (facebook)", value: "acc-1" },
    ]);
  });

  it("emits the request body as workflow data", async () => {
    const body = { event: "comment.received", comment: { id: "c1" } };
    const result = await new PostoraCommentTrigger().webhook.call({ getBodyData: () => body } as any);
    expect(result).toEqual({ workflowData: [[{ json: body }]], webhookResponse: { status: 200 } });
  });
});
```

- [ ] **Step 3: Run** — `npm test -- PostoraCommentTrigger` → fails (module missing).

- [ ] **Step 4: Implement the node**

```ts
import {
  IAllExecuteFunctions,
  IHookFunctions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
  NodeConnectionTypes,
} from "n8n-workflow";
import {
  isAlreadyGone,
  listWebhooks,
  sameEventSet,
  unregisterWebhook,
  WebhookListing,
  WebhookRegistration,
} from "../shared/webhookLifecycle";

type CommentTriggerParams = { platform: string; socialAccountId: string; events: string[] };

function readParams(context: IHookFunctions): CommentTriggerParams {
  return {
    platform: (context.getNodeParameter("platform") as string) || "",
    socialAccountId: (context.getNodeParameter("socialAccountId") as string) || "",
    events: context.getNodeParameter("events") as string[],
  };
}

function registrationBody(callbackUrl: string, params: CommentTriggerParams): Record<string, unknown> {
  const body: Record<string, unknown> = { webhook_url: callbackUrl, events: params.events };
  if (params.platform) body.platform = params.platform;
  if (params.socialAccountId) body.social_account_id = params.socialAccountId;
  return body;
}

export class PostoraCommentTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Postora Comment Trigger",
    name: "postoraCommentTrigger",
    icon: "fa:comments",
    group: ["trigger"],
    version: 1,
    description: "Starts a workflow when a new comment, reply or mention reaches a connected Facebook, Instagram or Threads account",
    defaults: { name: "Postora Comment Trigger" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "postoraApi", required: true }],
    webhooks: [{ name: "default", httpMethod: "POST", path: "postora-comment" }],
    properties: [
      {
        displayName: "Platform",
        name: "platform",
        type: "options",
        options: [
          { name: "All", value: "" },
          { name: "Facebook", value: "facebook" },
          { name: "Instagram", value: "instagram" },
          { name: "Threads", value: "threads" },
        ],
        default: "",
      },
      {
        displayName: "Account",
        name: "socialAccountId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getCommentAccounts", loadOptionsDependsOn: ["platform"] },
        default: "",
        description: "Only comments on this account trigger the workflow. The account's Comments automation handler must be set to n8n in Postora (Messaging → Auto Replies → Automation), otherwise no events are sent.",
      },
      {
        displayName: "Events",
        name: "events",
        type: "multiOptions",
        options: [
          { name: "New Comment Received", value: "comment.received", description: "Facebook/Instagram comments and replies, Threads replies and mentions (see comment.kind)" },
          { name: "Threads Mention Created (legacy payload)", value: "threads.mention.created" },
          { name: "Threads Mention Replied (legacy payload)", value: "threads.mention.replied" },
        ],
        default: ["comment.received"],
      },
    ],
  };

  methods = {
    loadOptions: {
      async getCommentAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("postoraApi");
        const baseUrl = credentials.baseUrl as string;
        const platform = (this.getCurrentNodeParameter("platform") as string) || "";
        const url = platform ? `${baseUrl}/api/v1/accounts?platform=${encodeURIComponent(platform)}` : `${baseUrl}/api/v1/accounts`;
        const response = await this.helpers.httpRequestWithAuthentication.call(
          this as unknown as IAllExecuteFunctions,
          "postoraApi",
          { method: "GET", url, json: true },
        );
        const accounts: Array<{ id: string; platform: string; platform_username?: string | null; name?: string | null }> =
          Array.isArray(response?.accounts) ? response.accounts : [];
        return [
          { name: "All accounts", value: "" },
          ...accounts
            .filter((account) => ["facebook", "instagram", "threads"].includes(account.platform))
            .map((account) => ({
              name: `${account.platform_username || account.name || account.id} (${account.platform})`,
              value: account.id,
            })),
        ];
      },
    },
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData("node");
        const webhookId = staticData.webhookId as string | undefined;
        if (!webhookId) return false;

        const credentials = await this.getCredentials<{ baseUrl: string }>("postoraApi");
        const params = readParams(this);
        const callbackUrl = this.getNodeWebhookUrl("default");
        if (!callbackUrl) return true;

        let listing: WebhookListing;
        try {
          listing = await listWebhooks(this, credentials.baseUrl);
        } catch {
          return true;
        }

        const existing = (listing.webhooks || []).find((webhook) => webhook.id === webhookId);
        const matches = Boolean(
          existing &&
          existing.is_active !== false &&
          existing.webhook_url === callbackUrl &&
          sameEventSet(existing.events || [], params.events) &&
          (existing.platform || "") === params.platform &&
          (existing.social_account_id || "") === params.socialAccountId,
        );
        if (matches) return true;

        if (existing) {
          try {
            await unregisterWebhook(this, credentials.baseUrl, webhookId);
          } catch (error) {
            if (!isAlreadyGone(error)) {
              throw new Error(
                `Postora could not retire the previous webhook subscription (${webhookId}), so re-registering would deliver some events twice. Resolve the Postora API error and activate again.`,
              );
            }
          }
        }
        delete staticData.webhookId;
        return false;
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const credentials = await this.getCredentials<{ baseUrl: string }>("postoraApi");
        const callbackUrl = this.getNodeWebhookUrl("default");
        if (!callbackUrl) throw new Error("Postora webhook registration requires an n8n callback URL.");
        const registration = await this.helpers.httpRequestWithAuthentication.call(
          this as unknown as IAllExecuteFunctions,
          "postoraApi",
          { method: "POST", url: `${credentials.baseUrl}/api/v1/webhooks`, body: registrationBody(callbackUrl, readParams(this)) },
        ) as WebhookRegistration;
        this.getWorkflowStaticData("node").webhookId = registration.webhook.id;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData("node");
        const webhookId = staticData.webhookId as string | undefined;
        if (!webhookId) return true;
        const credentials = await this.getCredentials<{ baseUrl: string }>("postoraApi");
        try {
          await unregisterWebhook(this, credentials.baseUrl, webhookId);
        } catch (error) {
          if (!isAlreadyGone(error)) throw error;
        }
        delete staticData.webhookId;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    return { workflowData: [[{ json: this.getBodyData() }]], webhookResponse: { status: 200 } };
  }
}
```

Register in `package.json` → `n8n.nodes`: add `"dist/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.js"`.

- [ ] **Step 5: Run** — `npx tsc --noEmit && npm test` → all green.

- [ ] **Step 6: Commit (node repo)**

```bash
git add nodes/shared nodes/PostoraTrigger nodes/PostoraCommentTrigger __tests__/PostoraCommentTrigger.node.test.ts package.json
git commit -m "feat: Postora Comment Trigger node with platform and account filters"
```

---

### Task 13: Node — Comment resource (Reply / Hide / Delete)

**Files:**
- Modify: `nodes/Postora/Postora.node.ts` (resource options ~330; operation blocks ~376; field blocks ~420; execute ~1190)
- Test: `__tests__/Postora.node.test.ts`

- [ ] **Step 1: Failing tests** (append; reuse the file's existing execute-context helper — see the "Message → Send / Reply" describe at ~401 for the pattern)

```ts
describe("Postora node — Comment → Reply / Hide / Delete", () => {
  it("replies to a comment through /api/v1/comments/reply", async () => {
    const requests: any[] = [];
    const ctx = createExecuteContext({
      params: { resource: "comment", operation: "reply", commentPlatform: "instagram", commentSocialAccountId: "acc-1", commentId: "c-1", commentMessage: "Thanks!" },
      onRequest: (r) => { requests.push(r); return { success: true, platform_comment_id: "r-1" }; },
    });
    const [[out]] = await new Postora().execute.call(ctx);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://example.test/api/v1/comments/reply",
      body: { platform: "instagram", social_account_id: "acc-1", comment_id: "c-1", message: "Thanks!" },
    });
    expect(out.json).toEqual({ success: true, platform_comment_id: "r-1" });
  });

  it("hides a comment with the hide flag", async () => {
    const requests: any[] = [];
    const ctx = createExecuteContext({
      params: { resource: "comment", operation: "hide", commentPlatform: "facebook", commentSocialAccountId: "acc-1", commentId: "c-1", commentHide: false },
      onRequest: (r) => { requests.push(r); return { success: true }; },
    });
    await new Postora().execute.call(ctx);
    expect(requests[0].url).toBe("https://example.test/api/v1/comments/hide");
    expect(requests[0].body).toEqual({ platform: "facebook", social_account_id: "acc-1", comment_id: "c-1", hide: false });
  });

  it("does not offer Delete for Threads", () => {
    const node = new Postora();
    const op = node.description.properties.find((p) => p.name === "operation" && (p.displayOptions?.show?.resource as string[])?.includes("comment")) as any;
    const del = op.options.find((o: any) => o.value === "delete");
    expect(del.description).toContain("Facebook and Instagram");
    const platformField = node.description.properties.find((p) => p.name === "commentPlatform") as any;
    expect(platformField.options.map((o: any) => o.value)).toEqual(["facebook", "instagram", "threads"]);
  });

  it("throws a clear error when Comment ID is empty", async () => {
    const ctx = createExecuteContext({
      params: { resource: "comment", operation: "reply", commentPlatform: "facebook", commentSocialAccountId: "acc-1", commentId: "", commentMessage: "x" },
      onRequest: () => ({}),
    });
    await expect(new Postora().execute.call(ctx)).rejects.toThrow("Comment ID");
  });
});
```

If `createExecuteContext` does not exist under that name, use the helper the Message tests use and adapt the param/onRequest shape.

- [ ] **Step 2: Run** → fails.

- [ ] **Step 3: Implement**

Resource option: add `{ name: "Comment", value: "comment" },` (keep alphabetical: Account, Comment, Media, Message, Post, Webhook).

Operation block (next to the Message one):

```ts
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["comment"] } },
        options: [
          { name: "Reply", value: "reply", description: "Reply to a comment, reply or mention", action: "Reply to a comment" },
          { name: "Hide", value: "hide", description: "Hide or unhide a comment", action: "Hide a comment" },
          { name: "Delete", value: "delete", description: "Delete a comment (Facebook and Instagram only)", action: "Delete a comment" },
        ],
        default: "reply",
      },
```

Fields:

```ts
      {
        displayName: "Platform",
        name: "commentPlatform",
        type: "options",
        options: [
          { name: "Facebook", value: "facebook" },
          { name: "Instagram", value: "instagram" },
          { name: "Threads", value: "threads" },
        ],
        default: "facebook",
        displayOptions: { show: { resource: ["comment"] } },
      },
      {
        displayName: "Social Account ID",
        name: "commentSocialAccountId",
        type: "string",
        default: "={{ $json.social_account_id }}",
        required: true,
        displayOptions: { show: { resource: ["comment"] } },
      },
      {
        displayName: "Comment ID",
        name: "commentId",
        type: "string",
        default: "={{ $json.comment.id }}",
        required: true,
        displayOptions: { show: { resource: ["comment"] } },
      },
      {
        displayName: "Message",
        name: "commentMessage",
        type: "string",
        typeOptions: { rows: 4 },
        default: "={{ $json.response }}",
        required: true,
        displayOptions: { show: { resource: ["comment"], operation: ["reply"] } },
      },
      {
        displayName: "Hide",
        name: "commentHide",
        type: "boolean",
        default: true,
        description: "Whether to hide (true) or unhide (false) the comment",
        displayOptions: { show: { resource: ["comment"], operation: ["hide"] } },
      },
```

Execute branch (after the Message branch):

```ts
        // ── Comment → Reply / Hide / Delete ──
        else if (resource === "comment" && ["reply", "hide", "delete"].includes(operation)) {
          const commentBody: Record<string, unknown> = {
            platform: this.getNodeParameter("commentPlatform", i, "facebook") as string,
            social_account_id: requireParam(this.getNodeParameter("commentSocialAccountId", i, "") as string, "Social Account ID"),
            comment_id: requireParam(this.getNodeParameter("commentId", i, "") as string, "Comment ID"),
          };
          if (operation === "reply") commentBody.message = requireParam(this.getNodeParameter("commentMessage", i, "") as string, "Message");
          if (operation === "hide") commentBody.hide = this.getNodeParameter("commentHide", i, true) as boolean;
          responseData = await this.helpers.httpRequestWithAuthentication.call(
            this as unknown as IAllExecuteFunctions,
            "postoraApi",
            { method: "POST", url: `${baseUrl}/api/v1/comments/${operation}`, body: commentBody, json: true },
          );
        }
```

- [ ] **Step 4: Run** — `npx tsc --noEmit && npm test` → green.

- [ ] **Step 5: Commit (node repo)**

```bash
git add nodes/Postora/Postora.node.ts __tests__/Postora.node.test.ts
git commit -m "feat: Comment resource — reply, hide, delete"
```

---

### Task 14: Node — README, version 1.3.0, build, sync vendored copy

**Files:**
- Modify: `README.md`, `package.json` (`1.2.1` → `1.3.0`)
- Build output: `dist/`
- Sync: `F:\Postora_new\Postora-n8n-community-node\{nodes,__tests__,dist,README.md,package.json}`

- [ ] **Step 1: README** — add two sections after the existing "Postora Trigger" section:

```markdown
## Postora Comment Trigger

Fires when a new comment, reply, or mention arrives on a connected Facebook, Instagram, or Threads account.

| Property | Meaning |
|---|---|
| Platform | All / Facebook / Instagram / Threads |
| Account | Loaded from your connected accounts (filtered by Platform). "All accounts" = no filter |
| Events | `comment.received` (default). Threads replies and mentions arrive as `comment.received` with `comment.kind` = `reply` / `mention` |

**Prerequisite:** in Postora, open the platform's Messaging page → Auto Replies → **Automation** and set **Comments** to **n8n** for the account. Without this the subscription is registered but receives nothing. Your own account's comments are never delivered (loop protection).

Payload:

```json
{
  "event": "comment.received",
  "platform": "instagram",
  "social_account_id": "…",
  "account": { "id": "…", "platform": "instagram", "name": "mybrand", "username": "mybrand", "handle": "@mybrand" },
  "comment": { "id": "1789…", "kind": "comment", "text": "Love this!", "parent_comment_id": null, "media_url": null },
  "post": { "id": "1784…", "url": null, "caption": null },
  "author": { "id": "1234…", "name": null, "username": "fan" },
  "timestamp": "2026-08-22T10:00:00.000Z"
}
```

## Comment resource

| Operation | Platforms | Endpoint |
|---|---|---|
| Reply | Facebook, Instagram, Threads | `POST /api/v1/comments/reply` |
| Hide | Facebook, Instagram, Threads | `POST /api/v1/comments/hide` (`hide: true/false`) |
| Delete | Facebook, Instagram | `POST /api/v1/comments/delete` |

Defaults are expressions that read the Comment Trigger payload (`$json.social_account_id`, `$json.comment.id`), so Trigger → AI Agent → Comment Reply needs no mapping beyond the reply text.
```

Also update the README's "Postora Trigger" events list if it enumerates them (add nothing there — message trigger is unchanged) and any version/changelog line to `1.3.0`.

- [ ] **Step 2: Version bump** — `package.json` `"version": "1.3.0"`.

- [ ] **Step 3: Gates + build**

Run: `npx tsc --noEmit && npm test && npm run build` → all succeed; `dist/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.js` exists.

- [ ] **Step 4: Commit (node repo) — do NOT push/release yet**

```bash
git add README.md package.json dist
git commit -m "chore(release): 1.3.0 — Comment Trigger and Comment resource"
```

- [ ] **Step 5: Sync vendored copy + commit (Postora repo)**

```powershell
robocopy F:\N8N\Postora-n8n-community-node\nodes F:\Postora_new\Postora-n8n-community-node\nodes /MIR
robocopy F:\N8N\Postora-n8n-community-node\__tests__ F:\Postora_new\Postora-n8n-community-node\__tests__ /MIR
robocopy F:\N8N\Postora-n8n-community-node\dist F:\Postora_new\Postora-n8n-community-node\dist /MIR
Copy-Item F:\N8N\Postora-n8n-community-node\README.md,F:\N8N\Postora-n8n-community-node\package.json F:\Postora_new\Postora-n8n-community-node\
cd F:\Postora_new
git add Postora-n8n-community-node
git commit -m "chore(n8n-node): sync vendored copy for 1.3.0"
```

Verify: `diff -rq F:\N8N\Postora-n8n-community-node\nodes F:\Postora_new\Postora-n8n-community-node\nodes` prints nothing.

---

### Task 15: Guards, docs, full gates

- [ ] **Step 1: `clean-code-guard`** on: `_shared/{automationHandler,commentAuthor,commentActions,n8nMessagingDispatch}.ts`, `facebook-instagram-webhook/{index,commentEvents}.ts`, `threads-webhook/{index,replyEvents}.ts`, `threads-mentions/index.ts`, `n8n-api/{index,webhookFilters}.ts`, `messaging-api/index.ts`, `comment-manager/index.ts`, `src/hooks/useAutomationHandlers.ts`, `src/components/messaging/AutomationHandlerCard.tsx`, node `nodes/**`. Fix findings.
- [ ] **Step 2: `test-guard`** on every new/changed test file (Deno, Vitest, Jest). Fix findings.
- [ ] **Step 3: `docs-guard`** on the node README and on CLAUDE.md's "Current node capabilities" paragraph — update it to 1.3.0 with the Comment Trigger + Comment resource and the `/api/v1/comments/*` + subscription filters in `n8n-api`.
- [ ] **Step 4: Full gates**

```
deno test --allow-env --allow-net supabase/functions/_shared supabase/functions/facebook-instagram-webhook supabase/functions/threads-webhook supabase/functions/n8n-api
npx vitest run
npm run build
cd F:\N8N\Postora-n8n-community-node && npx tsc --noEmit && npm test
```
All green. Commit any guard fixes scoped to touched files.

- [ ] **Step 5: `graphify update .`** and commit `CLAUDE.md` + docs.

---

### Task 16: Deploy (ordered) and verify

- [ ] **Step 1: Migration first** — apply `20260822120000_social_inbox_events_threads.sql` on the self-hosted DB (via `supabase_postora_mcp` `execute_sql`, or `psql` inside the db container through `ssh-contabo-mcp`). Verify: `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='social_inbox_events_platform_check';` includes `threads`.
- [ ] **Step 2: Edge functions** — per `docs/runbooks/deploy-edge-function.md` via `ssh-contabo-mcp`: copy `_shared/` (changed files) and `n8n-api`, `facebook-instagram-webhook`, `threads-webhook`, `threads-mentions`, `messaging-api`, `comment-manager` into `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`, verify SHA256, `docker compose up -d --no-deps functions`.
- [ ] **Step 3: Meta App Dashboard (manual, user)** — Threads app → Webhooks → subscribe to `replies` (callback = existing `threads-webhook` URL, same verify token); confirm the app has `threads_read_replies`. Facebook app → Webhooks → Page: `feed` subscribed; Instagram: `comments` subscribed.
- [ ] **Step 4: Smoke via API** — with a real API key:
  - `POST /api/v1/webhooks` with `{webhook_url, events:["comment.received"], platform:"instagram", social_account_id}` → 201 with filters echoed; `GET /api/v1/webhooks` shows them.
  - Set Comments = n8n in the UI for that account (after frontend deploy), comment on a post from another account, check n8n receives the envelope, then reply via Comment → Reply and confirm the reply appears and does **not** re-trigger.
- [ ] **Step 5: Open PR** `feat/n8n-comment-trigger` → `main`; address CodeRabbit/Codex rounds (cap two); merge → frontend auto-deploys.
- [ ] **Step 6: Release the node** — use the `n8n-node-release` skill from `F:\N8N\Postora-n8n-community-node` for `v1.3.0`; verify `npm view n8n-nodes-postora version` → `1.3.0`.
- [ ] **Step 7: Memory** — `mem0` `add_memory` summary (issue, design, files, deploy gotchas: Threads `replies` subscription is manual; legacy registry guard).

---

## Self-review

- **Spec coverage:** §1 dispatcher/envelope/suppression/gate → Tasks 1-3, 5, 6; allowlist → Task 8; §2 filters + comments API → Tasks 7-8; §3 node trigger/resource/tests/version/README → Tasks 12-14; §4 UI + messaging-api → Tasks 9-11; §5 tests/guards/deploy → Tasks 15-16; migration → Task 4; pending node work → Task 0.
- **Type consistency:** `CommentPayloadInput.comment.parentCommentId/mediaUrl` (camel) → envelope `parent_comment_id/media_url` (snake) — consistent across Tasks 3, 5, 6. `resolveCommentAutomationHandler` name used in Tasks 1, 5, 6, 9. `dispatchN8nEvent` / `buildCommentPayload` / `buildMentionEnvelope` exported from the shared module and imported in Tasks 5, 6. Node param names `platform` / `socialAccountId` / `events` match `getCommentAccounts`'s `getCurrentNodeParameter("platform")`.
- **Known manual steps:** Meta/Threads webhook field subscriptions (Task 16.3) and migration before function deploy (16.1 → 16.2).
