# TASK: Implement Real-Time Social Media Messaging Trigger & Reply in Postora and n8n Community Node

## Goal

Extend the Postora platform and its n8n Community Node (`n8n-nodes-postora`) so that when an inbound
message is received on any connected messaging platform (WhatsApp, Instagram Direct, Facebook
Messenger), it immediately triggers an n8n workflow via webhook, and allows the n8n workflow (e.g. an
AI Agent) to reply directly back to that customer in the same conversation.

## Architecture & Scope of Work

### Phase 1: Postora Backend - Webhook Event Dispatcher

1. **Extend Webhook Registry (`supabase/functions/n8n-api/index.ts`)**
   - Update `handleRegisterWebhook` to support messaging events in addition to post events:
     - `message.received` (all platforms)
     - `message.whatsapp`
     - `message.instagram`
     - `message.facebook`
   - Store registered webhooks in `app_settings` under key pattern
     `n8n_webhook_${userId}_${webhookId}` with the selected `events`.

2. **Inbound WhatsApp Dispatcher (`supabase/functions/whatsapp-webhook/index.ts`)**
   - In `handleLiveMessages`, after a verified inbound message is stored, dispatch an asynchronous
     (non-blocking / fire-and-forget) webhook payload to any active n8n webhooks for that user
     subscribed to `message.received` or `message.whatsapp`.
   - **Anti-Loop & Guard Rules**
     - Do NOT dispatch for message echoes (`is_echo`), status updates (sent, delivered, read), or
       history imports.
     - Add a check so that if external n8n webhook automation is active for this account/user, it
       bypasses or coordinates with the internal `ai-agent-reply` to avoid double-reply collisions.

3. **Inbound Facebook & Instagram Dispatcher (`supabase/functions/facebook-instagram-webhook/index.ts`)**
   - In `recordInboxEvent` / main webhook loop, after verifying the HMAC signature and confirming an
     inbound message (`!event.message.is_echo`), dispatch the standardized payload asynchronously to
     the user's active n8n webhooks.

4. **Standardized Trigger Payload Format**

```json
{
  "event": "message.received",
  "platform": "whatsapp",
  "social_account_id": "<uuid>",
  "conversation_id": "wa_123456_987654321",
  "sender": {
    "id": "987654321",
    "name": "Customer Name",
    "phone": "+96512345678"
  },
  "message": {
    "id": "wamid.HBgL...",
    "text": "Hello, do you have this in stock?",
    "type": "text",
    "attachments": []
  },
  "timestamp": "2026-08-20T03:10:00.000Z"
}
```

`platform` is one of `"whatsapp" | "instagram" | "facebook"`.

### Phase 2: Postora Backend - Outbound Message Reply Endpoint

1. **New API Route in `supabase/functions/n8n-api/index.ts`**
   - Add `POST /api/v1/messages/reply` (or `POST /api/v1/messages/send`) authenticated via API Key
     (`X-API-Key` or `Authorization: Bearer <api_key>`).
   - Request Body:

```json
{
  "social_account_id": "<uuid>",
  "platform": "whatsapp",
  "recipient_id": "987654321",
  "conversation_id": "wa_123456_987654321",
  "message": "Hello! Yes, it is in stock.",
  "message_type": "text"
}
```

   `platform` is `"whatsapp" | "instagram" | "facebook"`; `recipient_id` is the phone number for
   WhatsApp, PSID / IGSID for FB / IG; `message_type` is `"text" | "template" | "media"`.

   - Execution Logic:
     - Verify account ownership against the authenticated API key's `user_id`.
     - Route to WhatsApp Cloud API (`GRAPH_API/${phoneNumberId}/messages`) or Meta Graph API
       (`GRAPH_API/${pageId}/messages` or Instagram Direct endpoints) using stored account
       credentials / tokens.
     - Persist the outbound message into `whatsapp_messages` / `messaging_cache` /
       `social_inbox_events` so it appears in the Postora unified inbox.
     - Return `{ "success": true, "message_id": "<external_id>" }`.

### Phase 3: n8n Community Node Updates (`Postora-n8n-community-node`)

1. **Update `nodes/PostoraTrigger/PostoraTrigger.node.ts`**
   - Add the new messaging events to the `events` multiOptions parameter:
     - `Post Completed` (`post.completed`)
     - `New Message Received (All Platforms)` (`message.received`)
     - `WhatsApp Message Received` (`message.whatsapp`)
     - `Instagram DM Received` (`message.instagram`)
     - `Facebook Message Received` (`message.facebook`)
   - Ensure the trigger webhook payload matches the standardized output schema so downstream nodes
     (e.g. AI Agent) can reference `{{ $json.message.text }}` and `{{ $json.sender.id }}` directly.

2. **Update `nodes/Postora/Postora.node.ts`**
   - Add new Resource: **`Message`** (`resource = "message"`).
   - Add Operation: **`Reply / Send`** (`operation = "send"` or `"reply"`).
   - Parameters:
     - `Platform`: Dropdown (`WhatsApp`, `Instagram`, `Facebook`, or `Auto-detect`).
     - `Social Account`: Account selection or expression `={{ $json.social_account_id }}`.
     - `Recipient ID / Phone`: Expression `={{ $json.sender.id || $json.sender.phone }}`.
     - `Message Text`: Expression `={{ $json.response }}`.
     - `Message Type`: `text` (default) | `template` (optional for WhatsApp).
   - Connect execution to `POST /api/v1/messages/reply` in `Postora.node.ts`.

3. **Dual Copy Sync & Testing (MANDATORY)**
   - Apply identical changes to both local copies:
     - `Postora-n8n-community-node/` (vendored in this repo)
     - `F:\N8N\Postora-n8n-community-node/` (standalone repo)
   - Update tests in `__tests__/Postora.node.test.ts`.
   - Run `npx tsc --noEmit`, `npm test`, and `npm run build` in the standalone repo.
   - Bump version in `package.json` to `1.2.0`.

## Critical Safety & Production Rules

1. **Asynchronous Webhook Dispatch**
   - Meta requires webhook responses within < 5 seconds. The dispatch to user n8n webhook URLs must
     be strictly fire-and-forget (`fetch().catch(...)`) so slow n8n workflows never block or drop
     Meta webhooks.
2. **Loop Prevention (Anti-Echo)**
   - Check `!event.message.is_echo` and ensure outbound bot sends never trigger inbound webhooks.
3. **Deployment Procedure**
   - For Edge Functions (`n8n-api`, `whatsapp-webhook`, `facebook-instagram-webhook`), follow
     `docs/runbooks/deploy-edge-function.md` (copy to functions volume, hash verify, and run
     `docker compose restart functions`).
4. **Clean Code Guard**
   - Do not commit secrets, `.env` files, or temporary scripts. Scoped git commits only.

## Deliverables

1. Updated Edge Functions with message webhook dispatch and `POST /api/v1/messages/reply`.
2. Updated `PostoraTrigger` and `Postora` action node with `Message -> Reply` support.
3. Passing test suite and build output in both n8n repository copies.
4. Summary report of changes and verification steps.
