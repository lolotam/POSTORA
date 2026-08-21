# Investigation Report + Implementation Plan

**WhatsApp inbox chat box not updating, and n8n Postora Trigger not receiving WhatsApp messages**

| Field | Value |
|---|---|
| Date | 2026-08-21 |
| Audience | Claude Code (implementer) |
| Scope | Read-only investigation. **No production code was changed in this pass.** |
| Repos | `F:\Postora_new` (Postora app + vendored n8n node) and `F:\N8N\Postora-n8n-community-node` (GitHub-connected n8n node). Both node copies are the same trigger source. |
| Evidence | Live Postgres + edge-function logs via `ssh-contabo-mcp` on Contabo `86.48.2.205`, stack `postorasupabase-supabase-j8axyh`. |

---

## Executive summary

Both symptoms are real. **Inbound WhatsApp ingestion is healthy.** The failures are downstream of a successful write.

| # | Symptom | Proven root cause | Confidence |
|---|---|---|---|
| 1 | Left contact list updates; right chat box does not | Shared inbox renderer `reverse()`s the message array because Facebook/Instagram Graph returns **newest-first**. WhatsApp `whatsapp_get_messages` returns **oldest-first**. After `reverse()`, the newest bubble is at the **top** while auto-scroll pins to the **bottom** (oldest). The new message is off-screen. `limit(100)` also keeps the **oldest** 100, so long Cloud/coexistence threads drop the newest rows entirely. | High — code + live DB |
| 2 | n8n trigger fires for Facebook and Instagram, never for WhatsApp | The trigger node is a passthrough. Postora dispatches by **WhatsApp account owner `user_id`**. The only live n8n webhook is registered under `danatfuture@gmail.com` (who owns FB/IG, **zero WhatsApp accounts**). The live WhatsApp number is owned by `dr.vet.waleedtam@gmail.com`. Lookup returns **zero destinations** and exits silently (no log line). | High — live DB |

**Do not change the n8n community node for either bug.** The node copies are identical on this path; `PostoraTrigger.webhook()` just forwards the POST body.

---

## How the system is wired (shared context)

```
Inbound WhatsApp
  ├─ Cloud / coexistence  →  supabase/functions/whatsapp-webhook/index.ts
  └─ QR / Evolution       →  supabase/functions/whatsapp-evolution-webhook/index.ts
        │
        ├─ INSERT whatsapp_messages   (chat bubbles)
        ├─ UPSERT messaging_cache     (left list preview / unread)
        └─ dispatchMessageEvent(admin, account.user_id, payload)
              └─ SELECT app_settings WHERE key LIKE 'n8n_webhook_{user_id}_%'
                    └─ POST to n8n callback  →  Postora Trigger (passthrough)

UI  /messaging/whatsapp/conversations
  MessagingInbox
    left:  useConversations → whatsapp_list_conversations → messaging_cache
    right: ConversationDetail → useMessages → whatsapp_get_messages → whatsapp_messages
```

Conversation identity is consistent: `id` in the list **is** `messaging_cache.conversation_id` (e.g. `wa_<owner>_<contact>`), and `whatsapp_get_messages` filters on that same string. This is **not** an id-mismatch bug.

Facebook/Instagram use a different store (`social_inbox_events`) and Graph `get_messages` (newest-first, limit 50). That is why FB/IG chat panes look correct with the same `reverse()`.

---

## Issue 1 — Chat box does not update

### Symptom

Contacts/numbers on the left, chat pane on the right. A message from another phone to the registered number updates the left thread (preview and/or unread). The right pane does not show it.

Page: `/messaging/whatsapp/conversations` → `src/pages/whatsapp/Conversations.tsx` → `MessagingInbox platform="whatsapp"`.

### Live evidence (ingestion works)

Active WhatsApp accounts:

| connection_mode | platform_user_id | owner | cache rows | message rows | last activity (UTC) |
|---|---|---|---|---|---|
| `evolution_qr` | `96597950350` | `dr.vet.waleedtam@gmail.com` (`7fe4d34e-…`) | 307 | 455 | 2026-08-21 17:06:46 |
| `coexistence` | `1097745303431352` | `xsellpointkw@gmail.com` (`1122a2d5-…`) | 21 | 519 | 2026-08-21 17:06:46 |

The same test inbound was persisted **twice** (QR path + Cloud coexistence path) at the same second:

```
evolution_qr   wa_96597950350_96555683677       inbound  "Hi what are you selling"  17:06:46  from 96555683677
coexistence    wa_1097745303431352_96555683677  inbound  "Hi what are you selling"  17:06:46  from 96555683677
```

`messaging_cache.last_message_preview` for those conversation ids is the same text. Edge logs: `whatsapp-evolution-webhook` is hit continuously; `whatsapp-webhook` logged `Stored inbound message` for the Cloud path.

Realtime publication already includes both tables (`messaging_cache`, `whatsapp_messages`). Replica identity is default (`d`). RLS on `whatsapp_messages` SELECT is `uid() = user_id` only.

### Root cause A (always): order inversion vs auto-scroll

Facebook/Instagram Graph `get_messages` returns **newest first**. The shared pane undoes that:

```231:231:src/components/messaging/ConversationDetail.tsx
  const sortedMessages = [...messages].reverse();
```

```59:61:src/components/messaging/ConversationDetail.tsx
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);
```

WhatsApp does the opposite:

```1212:1218:supabase/functions/messaging-api/index.ts
      const { data: msgs, error: msgsError } = await adminClient
        .from("whatsapp_messages")
        .select("*")
        .eq("social_account_id", social_account_id)
        .or(`conversation_id.eq.${normalizedConvId},conversation_id.eq.${conversation_id}`)
        .order("timestamp", { ascending: true })
        .limit(100);
```

| Path | API order | After `reverse()` | Newest bubble | Auto-scroll target |
|---|---|---|---|---|
| FB/IG `get_messages` | newest-first | oldest→newest | bottom | bottom (correct) |
| WA `whatsapp_get_messages` | oldest-first | newest→oldest | **top** | **bottom = oldest** (looks frozen) |

The left list is not reversed. It reads `last_message_preview` from `messaging_cache`, so it updates correctly via realtime (`messaging_cache`) plus a 30s poll.

`useMessages` also polls every 15s and subscribes to `whatsapp_messages` realtime. Even when the new row is fetched, inversion hides it below the fold (actually **above** the fold, off the top).

### Root cause B (long Cloud threads): `limit(100)` keeps the oldest 100

`whatsapp_get_messages` orders ASC then `limit(100)`. For a thread with more than 100 rows the newest messages are **not returned at all**.

Live:

| conversation_id | messages | last_msg |
|---|---|---|
| `wa_1097745303431352_96560685150` | 166 | 2026-04-12 |
| `wa_1097745303431352_96555433488` | 142 | 2026-02-22 |
| `wa_1097745303431352_96555683677` | **124** | **2026-08-21 17:06:46** (the test inbound) |

The test Cloud thread has 124 rows. The right pane can never show the latest 24, including today's inbound, until ordering is DESC (or the limit is applied after sorting newest-first).

The Evolution copy of that thread has 54 rows, so it is affected by inversion/scroll only, not by truncation.

### Ruled out

- Conversation id mismatch between list and messages (same `wa_…` string in both tables).
- Trigger node / n8n package (UI does not go through n8n).
- Missing realtime publication (both tables are in `supabase_realtime`).
- Failed webhook ingest (rows exist; cache preview matches).

### Secondary notes (do not block the fix)

- `selectedConversation` in `MessagingInbox` is a React snapshot. The header unread count can stay stale; bubbles come from `useMessages`, not that snapshot.
- `whatsapp_messages` RLS is owner-only; `messaging_cache` allows workspace members. A workspace agent can see the left list via realtime but not `whatsapp_messages` INSERT events. They still load bubbles through `messaging-api` (service role) on poll. After order is fixed, agents may lag up to 15s unless RLS/realtime is widened later.
- Junk cache row `wa_96597950350_0` (15 messages) comes from `remoteNumberFor` collapsing a non-phone JID to `"0"`. Unrelated; filter on ingest later.
- `isSent={msg.from?.id === pageId}` is correct for both modes (Cloud `from_phone` is the contact; Evolution owner-sent rows use `platform_user_id`).

---

## Issue 2 — n8n trigger does not receive WhatsApp

### Symptom

The messaging trigger already receives Facebook and Instagram into the workflow. Sending WhatsApp to the registered number never creates an execution.

### What the node does (not at fault)

Both copies are the same:

- `F:\Postora_new\Postora-n8n-community-node\nodes\PostoraTrigger\PostoraTrigger.node.ts`
- `F:\N8N\Postora-n8n-community-node\nodes\PostoraTrigger\PostoraTrigger.node.ts`

On activate, the node `POST`s `{ webhook_url, events }` to `/api/v1/webhooks`. At runtime it only returns `this.getBodyData()`. It does not poll, and it does not filter by platform after the body arrives.

Offered events include `message.received`, `message.whatsapp`, `message.instagram`, `message.facebook`. Subscription matching in Postora is:

```
events includes "*" OR "message.received" OR "message.{platform}"
```

### Live evidence (tenancy mismatch)

**The only n8n webhook in production:**

```
key:    n8n_webhook_12f4ba6a-91a8-4ab7-9286-dd27e8a9db61_478d82d1-41b1-4b2b-aed6-4a7c6b3f66a8
url:    https://n8n2.walidmohamed.com/webhook/ce0916ca-fdc8-4976-ac94-b6ba842d04f8/postora
events: ["message.instagram", "message.received", "message.whatsapp", "message.facebook"]
active: true
fails:  0
```

`12f4ba6a-…` = `danatfuture@gmail.com`. That user owns:

- Facebook `Danat Future Company` (active)
- Instagram `danatfuture` (active)
- **No WhatsApp account**

**WhatsApp owners (different tenants):**

| account | mode | number / phone_number_id | owner |
|---|---|---|---|
| `93de5a12-…` | evolution_qr | `96597950350` | `dr.vet.waleedtam@gmail.com` |
| `d40ad3b2-…` | coexistence | `1097745303431352` | `xsellpointkw@gmail.com` |

Dispatch:

```ts
// whatsapp-webhook + whatsapp-evolution-webhook
dispatchMessageEvent(admin, account.user_id, payload)

// n8nMessagingDispatch.ts loadDestinations
.from("app_settings").like("key", `n8n_webhook_${userId}_%`)
```

For a message to `96597950350`, `userId` is `7fe4d34e-…`. There is **no** `n8n_webhook_7fe4d34e-…` row. Legacy `whatsapp_webhooks` is empty. `unique.length === 0` → `Promise.all([])` → **silent success, no log**.

Facebook/Instagram work because those accounts belong to `12f4ba6a-…`, which matches the registration.

This is the same class of bug as the 2026-08-21 Instagram DM tenancy issue: dispatch is scoped to the **receiving account's user_id**; registration is scoped to the **API-key owner**.

### Ruled out

- Missing `message.whatsapp` on the trigger (the live row includes it and `message.received`).
- Trigger node event list / `checkExists` (registration exists, URL matches, `failure_count` is 0 because Facebook deliveries succeed).
- `shouldDispatchInboundMessage` dropping live inbound (Cloud logs `Stored inbound message` then `runInBackground` dispatch; Evolution skips only `fromMe` / duplicates).
- Webhook URL blocked by SSRF checks (`n8n2.walidmohamed.com` is a public HTTPS host; FB/IG already POST there successfully).

---

## Suggested implementation plan (for Claude Code)

Implement in a follow-up. Do not mix the operational n8n tenancy fix with unrelated refactors.

### Fix 1 — Chat pane (required code)

**Preferred (one backend semantic change, no frontend contract break):**

1. In `supabase/functions/messaging-api/index.ts` action `whatsapp_get_messages`, change:

   ```ts
   .order("timestamp", { ascending: true })
   .limit(100);
   ```

   to:

   ```ts
   .order("timestamp", { ascending: false })
   .limit(100);
   ```

   This matches Graph `get_messages` (newest-first). Existing `ConversationDetail` `reverse()` then paints oldest→newest top→bottom and auto-scrolls to the newest. `limit(100)` then keeps the **latest** 100, which also fixes coexistence threads with >100 rows.

2. Only consumer is `useMessages` in `src/hooks/useMessaging.ts` (`action === "whatsapp_get_messages"`). Do not change `ConversationDetail` if the backend contract is aligned.

3. Add a regression test around the query shape if there is an existing messaging-api test harness; otherwise a focused unit/contract test that documents "WhatsApp messages are returned newest-first, same as Graph".

4. Deploy `messaging-api` with `docs/runbooks/deploy-edge-function.md` (copy into the functions volume, SHA256, `docker compose restart functions` — do **not** use `npx supabase functions deploy`).

**Do not** reverse only on the frontend for WhatsApp as the primary fix: that leaves `limit(100)` dropping newest Cloud rows.

**Optional follow-up (not required to close the bug):**

- After the order fix, in browser DevTools confirm `postgres_changes` INSERT events on `whatsapp_messages` for the owner. If they never arrive, the pane still lags up to 15s (poll). Publication + owner SELECT policy already look correct.
- Later: widen `whatsapp_messages` SELECT RLS to workspace members to match `messaging_cache`, if agents need instant bubbles.

**Verify:**

1. Open `wa_96597950350_96555683677` (Evolution) and `wa_1097745303431352_96555683677` (coexistence, 124 rows).
2. Send a new inbound from `96555683677`.
3. Left preview updates; right pane shows the new bubble at the **bottom** within one poll cycle (≤15s), immediately if realtime fires.
4. Coexistence thread shows the latest messages, not April/February history at the bottom.

### Fix 2 — n8n WhatsApp trigger

The node is not the bug. **Do not bump `n8n-nodes-postora`, do not edit both node copies, do not cut a GitHub release** unless you also implement Option C and choose to document it.

**Option A — operational, do this first (no code):**

The workflow that already receives FB/IG uses danatfuture's API key. WhatsApp events will reach it only if the WhatsApp account is connected under **that same Postora user**, **or** the trigger credential is switched to an API key of the WhatsApp account owner.

Pick one:

- A1. Connect / move number `96597950350` under `danatfuture@gmail.com`, **or**
- A2. In n8n, create/activate a Postora Trigger credential whose API key belongs to `dr.vet.waleedtam@gmail.com`, with events `message.received` and/or `message.whatsapp`.

Rule: every social account whose events must hit a workflow must be owned by the same user as the API key that registered the webhook.

Confirm by sending WhatsApp and watching an n8n execution. `app_settings` should then contain `n8n_webhook_7fe4d34e-…` (if A2) or WhatsApp `social_accounts.user_id` should become `12f4ba6a-…` (if A1).

**Option B — product change (only if product wants workspace-wide fan-out):**

In `supabase/functions/_shared/n8nMessagingDispatch.ts` `loadDestinations`, resolve `workspace_id` from the account and include webhook registrations for workspace members / owner. This is a security/tenancy change. Do not do it as a silent bugfix. Needs an explicit product decision.

**Option C — diagnosability (small, recommended with any code change):**

In `dispatchMessageEvent`, if `unique.length === 0`, log:

```
[n8n-dispatch] no webhook destinations for user <id> platform <platform>
```

Today this case is invisible in function logs, which is why it required a DB dump.

### Test / deploy matrix

| Step | Action | Expected |
|---|---|---|
| 1 | Change `whatsapp_get_messages` order to DESC | Newest-first, latest 100 |
| 2 | Deploy `messaging-api` via Contabo runbook | Function answers; hashes match |
| 3 | Send inbound to `96597950350` | Bubble at bottom of open thread |
| 4 | Open coexistence thread with 124 messages | Latest inbound visible |
| 5 | Option A for n8n | New WhatsApp execution on `n8n2.walidmohamed.com` |
| 6 | Option C (if coded) | Zero-destination warn in functions logs when owner has no webhook |

### Files for the follow-up implementation task

| File | Change |
|---|---|
| `supabase/functions/messaging-api/index.ts` | `whatsapp_get_messages` order DESC |
| `supabase/functions/_shared/n8nMessagingDispatch.ts` | optional zero-destination warning |
| tests next to those modules, if present | ordering / empty-destination regression |

**Out of scope for the fix:**

- `Postora-n8n-community-node` (both copies)
- Frontend `ConversationDetail.tsx` if backend order is aligned
- Evolution `@lid` / `wa_…_0` cleanup
- Workspace RLS expansion (separate)

---

## Implementation notes for Claude Code

1. Do not start with the n8n node. Confirm the tenancy row in `app_settings` still has no `n8n_webhook_7fe4d34e-%` before writing dispatch changes.
2. Keep WhatsApp and Graph message envelopes aligned: newest-first from the API, `reverse()` in the shared pane.
3. After editing any `supabase/functions/*` file, deploy with `docs/runbooks/deploy-edge-function.md`. Self-hosted Contabo. Never `npx supabase functions deploy`.
4. If you later change the n8n node (you should not for these two bugs), apply the same diff to **both** `F:\N8N\Postora-n8n-community-node` and `F:\Postora_new\Postora-n8n-community-node`, and publish only from the N8N repo.
5. Guard pass: `clean-code-guard` on production edits, `test-guard` on new tests. Commit only the task files.
6. Browser-verify the inbox: open the thread, send from a second number, confirm the new bubble at the bottom on both Evolution and coexistence accounts.

---

## Appendix — key source locations

| Concern | Path |
|---|---|
| Inbox shell | `src/pages/whatsapp/Conversations.tsx`, `src/components/messaging/MessagingInbox.tsx` |
| List | `src/components/messaging/ConversationList.tsx` |
| Chat pane + reverse + scroll | `src/components/messaging/ConversationDetail.tsx` |
| Hooks / poll / realtime | `src/hooks/useMessaging.ts`, `src/hooks/useRealtimeQueryInvalidation.ts` |
| List + get messages API | `supabase/functions/messaging-api/index.ts` (`whatsapp_list_conversations`, `whatsapp_get_messages`) |
| Cloud ingest + n8n dispatch | `supabase/functions/whatsapp-webhook/index.ts` |
| QR ingest + n8n dispatch | `supabase/functions/whatsapp-evolution-webhook/index.ts` |
| Fan-out | `supabase/functions/_shared/n8nMessagingDispatch.ts` |
| Webhook registration | `supabase/functions/n8n-api/index.ts` `handleRegisterWebhook` |
| Trigger node | `Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts` (both copies) |
| Deploy | `docs/runbooks/deploy-edge-function.md` |
