# n8n Comment Trigger, Comment Resource & Automation Handler — Design

**Date:** 2026-08-22
**Status:** Approved (sub-project 1 of 3)
**Scope owner:** Postora backend (`supabase/functions`), web app (`src/`), n8n community node (`F:\N8N\Postora-n8n-community-node` + vendored `Postora-n8n-community-node/`)

## Goal

Let an n8n workflow auto-reply to public comments on Facebook, Instagram and Threads:

1. Postora forwards new comments (and Threads replies/mentions) to subscribed n8n webhooks.
2. A new **Postora Comment Trigger** node lets the user pick Platform → Account before the event fires.
3. A new **Comment** resource in the main Postora node replies to / hides / deletes a comment.
4. A per-account **Automation handler** setting in the web app decides whether the Postora AI agent or n8n handles Messages and, separately, Comments — exactly one handler (or none) per channel, so two agents never answer the same item.

## Out of scope (later sub-projects)

- **Sub-project 2:** Threads platform agent (Auto Replies / Agents / AI Agent tabs on the Threads page; `threads` in `messenger_auto_replies` / `ai_agent_configs` CHECKs; Threads transport in `ai-agent-reply`).
- **Sub-project 3:** Postora AI agent / Auto Replies for comments (today both run for DMs only).
- No DMs for Threads — the Threads API has no messaging; "Threads messaging" means replies to the user's posts and mentions.

## Existing facts this design builds on

- `facebook-instagram-webhook/index.ts` already receives comment changes (`entry.changes`) and upserts them into `social_inbox_events` via `recordInboxEvent` (idempotent on `social_account_id, external_event_id`). They are never forwarded to n8n.
- `threads-webhook` handles only `mentions`; `threads-replies` polls replies. Both have private copies of an n8n dispatcher; `threads.mention.*` events are dispatched but not in `ALLOWED_WEBHOOK_EVENTS`, so only `*` subscribers receive them.
- `_shared/n8nMessagingDispatch.ts` is the only signed, SSRF-guarded, failure-counting dispatcher (`dispatchMessageEvent`). Subscriptions live in `app_settings` rows keyed `n8n_webhook_{userId}_{webhookId}` with `{webhook_url, events, webhook_secret, is_active, …}`; legacy `whatsapp_webhooks` rows are also read.
- `_shared/automationHandler.ts` defines `account_metadata.automation_handler: "internal" | "n8n"` (default `internal`). No UI writes it.
- Web app: `src/pages/messaging/{Facebook,Instagram}Messaging.tsx` have tabs inbox / comments / auto-replies / agents / ai-agent; `ThreadsMentions.tsx` has mentions / replies tabs.

## §1 Event contract & dispatcher (backend)

### Shared dispatcher
`supabase/functions/_shared/n8nMessagingDispatch.ts` is generalised:

- `dispatchN8nEvent(admin, userId, envelope)` — event-agnostic. Loads destinations (unchanged: `app_settings` + legacy `whatsapp_webhooks`), matches, dedupes by URL, signs (`X-Postora-Signature: sha256=…`, `X-Postora-Event`, `X-Postora-Timestamp`), delivers via `postWebhook` with the existing concurrency cap, deadline and 10-failure auto-disable.
- `matchesSubscription(sub, envelope)`: event matches if `sub.events` contains `*`, the exact event, or the platform alias (`comment.instagram` for `comment.received` on instagram; same rule as today's `message.*`). Additionally, if `sub.platform` is set it must equal `envelope.platform`; if `sub.social_account_id` is set it must equal `envelope.social_account_id`.
- `dispatchMessageEvent` stays as a thin wrapper around `dispatchN8nEvent` — no behaviour change for messages.
- The private dispatcher copies in `threads-webhook/index.ts` and `threads-mentions/index.ts` are removed in favour of the shared one. (`process-post`'s and `n8n-api`'s copies are left alone — out of scope.)

### Allowed events
`ALLOWED_WEBHOOK_EVENTS` (`n8n-api/index.ts`) gains: `comment.received`, `comment.facebook`, `comment.instagram`, `comment.threads`, `threads.mention.created`, `threads.mention.replied`.

### Envelope
```json
{
  "event": "comment.received",
  "platform": "facebook" | "instagram" | "threads",
  "social_account_id": "<uuid>",
  "account": { "id": "<uuid>", "platform": "...", "name": "...", "username": "...", "handle": "..." },
  "comment": {
    "id": "<platform comment id>",
    "kind": "comment" | "reply" | "mention",
    "text": "...",
    "parent_comment_id": "<id or null>",
    "media_url": "<url or null>"
  },
  "post": { "id": "<platform post/media id>", "url": "<url or null>", "caption": "<text or null>" },
  "author": { "id": "...", "name": "<or null>", "username": "<or null>" },
  "timestamp": "<ISO 8601>"
}
```
`buildCommentPayload(...)` in the shared module produces this; `describeMessagingAccount` is reused for `account`.

`kind`: FB/IG top-level comment → `comment`; FB/IG reply to a comment (has parent) → `reply`; Threads reply to the user's post → `reply`; Threads mention → `mention`. Threads mention events also keep their existing `threads.mention.created` dispatch (now deliverable) — unchanged payload, for backward compatibility.

### Own-comment suppression
Before dispatch, drop the event when `author.id === account.platform_user_id` (FB page ID / IG user ID / Threads user ID). This prevents the n8n reply from re-triggering the workflow. No opt-out.

### Gate
Comments are dispatched only when `resolveCommentAutomationHandler(account.account_metadata) === "n8n"` (new helper in `_shared/automationHandler.ts`, reads `comment_automation_handler`, default `"off"`). Messages keep today's `automation_handler` gate. Valid values: `automation_handler ∈ {"internal","n8n","off"}`, `comment_automation_handler ∈ {"off","internal","n8n"}`. `"off"` for messages is newly accepted: skip rules, AI agent and n8n. Unknown values fall back to the defaults (`internal` / `off`).

### Call sites
| Function | Where | Kind |
|---|---|---|
| `facebook-instagram-webhook` | `entry.changes` loop, only when `recordInboxEvent` returns `"inserted"` | `comment` / `reply` |
| `threads-webhook` | mention handler | `mention` |
| `threads-replies` | when polling discovers a reply not yet in `social_inbox_events` (insert first, dispatch on `"inserted"`) | `reply` |

All dispatches run via `runInBackground` so webhook processing never fails because of n8n.

## §2 Webhook subscription & comment API (`n8n-api`)

- `POST /api/v1/webhooks` body gains optional `platform` (`facebook|instagram|threads|whatsapp`) and `social_account_id`. If `social_account_id` is given it must belong to the caller's user (404-style rejection otherwise, non-enumerable) and, if `platform` is also given, match the account's platform. Both are stored in the `app_settings` value and returned by `GET /api/v1/webhooks`. Subscriptions without filters behave as before.
- New endpoints, all `x-api-key` authed, ownership-scoped to the caller's `social_accounts`:
  - `POST /api/v1/comments/reply` `{ platform, social_account_id, comment_id, message }`
  - `POST /api/v1/comments/hide` `{ platform, social_account_id, comment_id, hide?: boolean=true }` — FB/IG only; Threads → 400.
  - `POST /api/v1/comments/delete` `{ platform, social_account_id, comment_id }`
  Implementation: extract the Graph-API logic from `comment-manager` (reply/hide/delete) into `_shared/commentActions.ts` used by both `comment-manager` and `n8n-api`; Threads reply/delete reuse the same Threads Graph calls as `threads-reply` / `threads-delete-post`. Responses: `{ success, platform_comment_id?, error? }`. Logged to `api_logs` like other n8n-api routes.

## §3 n8n node (apply to both local copies)

### `nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts`
- Display name **Postora Comment Trigger**, name `postoraCommentTrigger`, credential `postoraApi`, webhook path `postora-comment`.
- Properties, in order:
  1. **Platform** — options: All, Facebook, Instagram, Threads (default All).
  2. **Account** — `loadOptions: getCommentAccounts` (calls `GET /api/v1/accounts`, filtered by Platform; first option "All accounts" = `""`). Always shown; with Platform = All it lists every FB/IG/Threads account.
  3. **Events** — multiOptions: `comment.received` (default), `threads.mention.created`, `threads.mention.replied`. Description notes that Threads replies and mentions arrive as `comment.received` with `comment.kind`.
- Lifecycle mirrors `PostoraTrigger`: server-authoritative `checkExists` (`GET /api/v1/webhooks`, compare `webhook_url`, event set, `platform`, `social_account_id`; delete stale then return false), `create` (`POST /api/v1/webhooks` with filters), `delete`. Shared helpers (`sameEventSet`, `isAlreadyGone`, `unregisterWebhook`) move to `nodes/shared/webhookLifecycle.ts` and are used by both triggers.
- `webhook()` emits the request body verbatim.

### `nodes/Postora/Postora.node.ts` — new **Comment** resource
- Operations: **Reply** (Platform: Facebook/Instagram/Threads; Account via existing `getAccounts`; Comment ID; Message), **Hide** (Facebook/Instagram; Comment ID; Hide/Unhide), **Delete** (all three; Comment ID). Calls §2 endpoints. `continueOnFail` honoured like other resources.

### Package
- Register both new node class and resource in `package.json` `n8n.nodes`; version `1.2.1 → 1.3.0`; README sections "Comment Trigger" and "Comment resource" with the envelope example and the automation-handler prerequisite.
- Tests: `__tests__/PostoraCommentTrigger.node.test.ts` (lifecycle with filters, stale-subscription cleanup, loadOptions filtering) and Comment cases in `__tests__/Postora.node.test.ts`.

## §4 Automation handler UI (web app)

- New `src/components/messaging/AutomationHandlerCard.tsx`, rendered at the top of the **Auto Replies** tab in `FacebookMessaging.tsx` and `InstagramMessaging.tsx`, and at the top of the **Replies** tab in `ThreadsMentions.tsx` (Threads has no Auto Replies tab yet).
- Content: account selector (the page's existing selected account) and up to two rows:
  - **Messages** — Select: Off / Postora AI Agent / n8n. Hidden on Threads.
  - **Comments** — Select: Off / Postora AI Agent (disabled, tooltip "Coming in a later update") / n8n.
  Defaults displayed when metadata is unset: Messages = Postora AI Agent, Comments = Off.
- Data: `src/hooks/useAutomationHandlers.ts` → `callMessagingApi("get_automation_handlers" | "set_automation_handlers", { social_account_id, automation_handler?, comment_automation_handler? })`. `messaging-api` validates values against the enums in §1, checks account ownership, and merges into `account_metadata` server-side. No client-side raw metadata writes.
- Copy under the card: "Exactly one handler answers each channel. n8n requires a Postora Comment Trigger (or Postora Trigger) workflow."

## §5 Error handling, tests, deploy

- n8n delivery failures never affect webhook/polling success; existing auto-disable after 10 failures applies.
- Missing/invalid handler metadata → safe defaults; never throws.
- **Deno tests:** `n8nMessagingDispatch.test.ts` (platform/account filter matching, alias matching for `comment.*`, own-comment suppression, envelope shape), `automationHandler.test.ts` (new values/defaults), `n8n-api` filter validation + comment endpoints (ownership, Threads hide → 400).
- **Vitest:** `AutomationHandlerCard` (defaults, disabled option, save call) and `useAutomationHandlers`.
- **Jest (node):** both test files; `npx tsc --noEmit`, `npm test`, `npm run build` before release.
- **Guards:** `clean-code-guard`, `test-guard`, `docs-guard` (README).
- **Deploy order:** edge functions first via `ssh-contabo-mcp` (`n8n-api`, `facebook-instagram-webhook`, `threads-webhook`, `threads-replies`, `threads-mentions`, `messaging-api`, `comment-manager`), then merge to `main` (frontend auto-deploys), then n8n node release `v1.3.0` from `F:\N8N\Postora-n8n-community-node` and verify `npm view n8n-nodes-postora version`.

## Risks

- Meta permissions: comment webhooks need `pages_manage_engagement` / `instagram_manage_comments` — already in use by the comment manager, so no new review expected.
- Threads `replies` webhook field availability is unverified; the design relies on `threads-replies` polling for replies regardless, so delivery works either way (with polling latency).
- Users with existing `automation_handler = "n8n"` keep receiving messages; comments stay off until they opt in via the new card.
