# User Journey — Messaging Triggers, n8n Node & WhatsApp Direct QR Connect

Manual test plan for the two features merged in `52bef67`:
- **Feature A** — inbound messages trigger n8n; n8n replies through Postora.
- **Feature B** — WhatsApp Direct QR Connect (3rd connection mode, Evolution API).

Everything below is written against the merged code. Endpoint paths, action names, body fields and
flag keys are quoted from the implementation, not from the original spec — the spec was wrong about
several of them.

---

## 0. Prerequisites — none of this works until these are done

Nothing in this document will pass on a fresh environment. Do these first, in order.

### 0.1 Apply the two migrations

| File | Adds |
|---|---|
| `supabase/migrations/20260821080000_n8n_webhook_key_index.sql` | partial index on the n8n webhook keys in `app_settings` |
| `supabase/migrations/20260821090000_evolution_qr_support.sql` | `social_accounts.connection_mode` column + check + index, and the `whatsapp_evolution_instances` table |

The second one runs a preflight `UPDATE` that normalises existing `account_metadata->>'connection_mode'`
values, then adds the constraint `NOT VALID` and immediately `VALIDATE`s it. **If the VALIDATE step
fails, stop** — it means a WhatsApp row holds a mode outside
`cloud_api | coexistence | evolution_qr`, and that row must be fixed before the feature is safe to
enable. Do not force the constraint through.

Verify afterwards:
```sql
select connection_mode, count(*) from social_accounts where platform = 'whatsapp' group by 1;
-- expect only cloud_api / coexistence, no NULLs

select relrowsecurity from pg_class where relname = 'whatsapp_evolution_instances';
-- expect: t

select count(*) from pg_policies where tablename = 'whatsapp_evolution_instances';
-- expect: 0  (RLS on with no policy = deny-all to clients; service role only)
```
That last check matters: the per-instance `jwt_key` lives in this table. If a policy ever appears
here, the key becomes readable by logged-in users.

### 0.2 Set the Supabase secrets

```
EVOLUTION_API_URL = https://wa.postora.cloud
EVOLUTION_API_KEY = <the Evolution global API key>
```

`wa.postora.cloud` is the correct host — **not** `wa-engine.postora.cloud`, which has no Traefik
router and returns 526. Confirm the service before going further:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: $EVOLUTION_API_KEY" \
  https://wa.postora.cloud/instance/fetchInstances
# expect: 200
```
The global key is admin-scoped over **every** instance on that server. It must never appear in a
browser response or a log line.

### 0.3 Deploy the edge functions

Per `docs/runbooks/deploy-edge-function.md` (copy into the functions volume, verify hashes, then
`docker compose up -d --no-deps functions`):

`n8n-api`, `whatsapp-webhook`, `facebook-instagram-webhook`, `whatsapp-oauth`, `messaging-api`,
`ai-agent-reply`, `ecommerce-whatsapp-api`, `partner-api`, `whatsapp-evolution-bridge`,
`whatsapp-evolution-webhook`.

### 0.4 Confirm the background primitive is live

After the functions restart, send any inbound WhatsApp message and check the function logs for:
```
[background] waitUntil path active
```
If it instead says `degraded inline path active`, the runtime has no `EdgeRuntime.waitUntil`. The
feature still works, but each inbound webhook response is delayed by up to 2s while dispatch
completes — which eats into Meta's 5-second webhook budget. Investigate before load-testing.

### 0.5 Set Evolution's own env (Feature B only)

On the Dokploy app `postora-evolutionapi-zenkpi`, add:
`SERVER_URL=https://wa.postora.cloud`, `WEBHOOK_GLOBAL_ENABLED=false`, `DEL_INSTANCE=true`.
Without `SERVER_URL`, media URLs Evolution generates can point at the wrong host.

---

## Feature A — inbound message triggers n8n, n8n replies

### A1. Register a webhook and capture the secret

In n8n, add a **Postora Trigger** node. The Events dropdown should now offer five values:

| Label | Value |
|---|---|
| Post Completed | `post.completed` |
| New Message Received (All Platforms) | `message.received` |
| WhatsApp Message Received | `message.whatsapp` |
| Instagram DM Received | `message.instagram` |
| Facebook Message Received | `message.facebook` |

Pick **New Message Received (All Platforms)** and activate the workflow.

**Check:** the registration response contains a `webhook_secret`. It is generated server-side and
**returned exactly once** — you cannot supply your own, and re-reading the webhook will not show it
again. Save it now if you intend to verify signatures.

**Negative check:** try registering with `events: ["message.banana"]`. Expect **400**, not a silent
accept. Then try `events: ["*"]` — expect **success**; the wildcard is legacy behaviour that older
registrations depend on.

### A2. Trigger on a real inbound message

Send a WhatsApp message **from an external phone** to a connected Cloud API number.

**Expect** the n8n workflow to fire once, with this body:
```json
{
  "event": "message.received",
  "platform": "whatsapp",
  "social_account_id": "<uuid>",
  "conversation_id": "wa_<phoneNumberId>_<sender>",
  "sender": { "id": "...", "name": "...", "phone": "..." },
  "message": { "id": "wamid...", "text": "...", "type": "text", "attachments": [] },
  "timestamp": "..."
}
```
Downstream nodes should be able to reference `{{ $json.message.text }}` and `{{ $json.sender.id }}`
directly.

Repeat on **Instagram DM** and **Facebook Messenger** — same envelope, `platform` differs.

**The important negative checks:**

| Do this | Expect |
|---|---|
| Reply *from* the business account (an echo) | **no** trigger |
| Watch a delivered/read receipt arrive | **no** trigger |
| Have Meta redeliver the same message (or replay the webhook) | **no** second trigger — idempotency is keyed on message ID |
| Run a WhatsApp history sync | **no** flood of triggers |

The redelivery case is the one most likely to regress. Meta retries webhooks routinely, and before
this change the Facebook/Instagram path had no duplicate check at all.

### A3. Reply from n8n

Add a **Postora** node → Resource **Message** → Operation **Reply / Send**, with
`Social Account` = `={{ $json.social_account_id }}` and
`Recipient ID` = `={{ $json.sender.id }}`.

Or call it directly:
```bash
curl -X POST https://api.postora.cloud/functions/v1/n8n-api/api/v1/messages/reply \
  -H "x-api-key: <your Postora API key>" \
  -H "Content-Type: application/json" \
  -d '{
        "social_account_id": "<uuid>",
        "recipient_id": "96512345678",
        "message": "Yes, it is in stock.",
        "message_type": "text"
      }'
```
Auth also accepts `Authorization: Bearer <key>`. `platform` is optional — it is derived from the
account when omitted, and returns **400** if it contradicts the account.

**Expect** `{"success": true, "message_id": "..."}`, the message delivered to the phone, and the
reply visible in the Postora unified inbox (not just on the handset).

**Security checks:**

| Do this | Expect |
|---|---|
| Use another user's `social_account_id` | **404**, not 403 — account IDs stay non-enumerable |
| Omit `message` | 400 |
| `message_type: "media"` with no `media_url` | 400 |
| Send 61 replies in an hour | 429 — the limit is 60/hr on the exact path `/api/v1/messages/reply` |

### A4. Double-reply coordination

This is the behaviour most likely to surprise an existing user, so test it explicitly.

**A4a — default (no opt-in).** On an account with AI agent or auto-replies enabled and an n8n
webhook registered, send an inbound message.
**Expect:** the AI/auto-reply still fires **and** n8n is triggered. Registering a webhook for
observation must not disable existing automation. If the AI reply went silent here, that is a
regression.

**A4b — opt-in.** Set `account_metadata.automation_handler = 'n8n'` on the account, then send
another inbound message.
**Expect:** n8n triggers, and the internal auto-reply/AI agent **do not** send. Only n8n answers.

**A4c — reconnect survival.** Disconnect and reconnect the WhatsApp account through OAuth, then
re-check `automation_handler`. It must still be `'n8n'` — the OAuth path used to overwrite
`account_metadata` wholesale and now merges.

**Known limitation, not a bug:** if an AI reply is already in flight when n8n replies, both can
land. Per-message precedence cannot prevent that.

### A5. Legacy WhatsApp webhook subscribers must not break

If any rows exist in `whatsapp_webhooks`, this is the highest-risk regression in the release —
those are live external integrations.

| Check | Expect |
|---|---|
| Body received by a `whatsapp_webhooks` subscriber | the **old** shape: `{event, timestamp, data:{from, contact_name, message, message_type, conversation_id, phone_number_id}}` — *not* the new envelope |
| Signature header | `X-Webhook-Signature: <hex>` — *not* `X-Postora-Signature` |
| A row with `events = NULL` | still receives every message |
| A URL registered in **both** `whatsapp_webhooks` and the n8n registry | delivered **once**, not twice |

### A6. Delivery is best-effort — confirm you can see failures

Point a webhook at a URL that returns 500. Send 10 inbound messages.
**Expect:** `failure_count` climbs and the webhook auto-deactivates at 10; inbound messages still
land in the Postora inbox throughout. A failing n8n workflow must never block message ingestion.

Point one at a URL that hangs. **Expect** it to be abandoned after ~5s per attempt, and other
subscribers still delivered. With more than 5 subscribers, watch for
`fan-out deadline hit; N/M destination(s) not delivered` in the logs — that message is intentional,
and it means those destinations were skipped, not retried. There is **no outbox**: a dropped
delivery is gone.

---

## Feature B — WhatsApp Direct QR Connect

Use a **throwaway phone number**. This is the unofficial WhatsApp Web protocol; Meta can ban numbers
used for bulk or unsolicited messaging. Do not test with a number you care about.

### B1. Enable the flag

Admin → Feature Flags → **WhatsApp Direct QR Mode** (`feature_wa_evolution_qr_enabled` →
`waEvolutionQrEnabled`). It ships **off**.

**Check:** with the flag off, the third card is absent from WhatsApp setup.

### B2. The disclaimer gate

WhatsApp setup now shows three cards: Official Cloud API, Coexistence, and **Direct QR Connect
(Beta)**. Click the third.

| Check | Expect |
|---|---|
| Proceed button before ticking the box | disabled |
| Clicking proceed anyway | nothing happens |
| After ticking the box | enabled |
| Cancel, then reopen the dialog | checkbox **cleared**, button disabled again — a prior acceptance must not carry over |

**Server-side check (the one that actually matters).** The disabled button is trivially bypassed.
Call the bridge directly with consent omitted:
```bash
curl -X POST https://api.postora.cloud/functions/v1/whatsapp-evolution-bridge \
  -H "Authorization: Bearer <user JWT>" -H "Content-Type: application/json" \
  -d '{"action":"create_and_get_qr"}'
```
**Expect 400** — "Risk consent is required before connecting Direct QR mode". If this succeeds, the
audit trail is worthless.

### B3. Pair the phone

Accept the disclaimer. The scanner shows a 512px QR with a 45-second countdown and a refresh button.

On the phone: WhatsApp → Settings → Linked Devices → Link a Device → scan.

**Expect:** the UI flips to connected within a few seconds, without a manual page refresh.

**Database checks after pairing:**
```sql
select connection_mode, is_active, platform_user_id,
       account_metadata->>'risk_consent_accepted_at' as consented_at,
       account_metadata->>'risk_consent_user_ip'     as consent_ip
from social_accounts where connection_mode = 'evolution_qr';
```
- `connection_mode` = `evolution_qr`, `is_active` = `true`
- `platform_user_id` is the **real MSISDN**, no longer `pending_<uuid>` — it is filled in from the
  first `CONNECTION_UPDATE: open`
- `consented_at` and `consent_ip` are both populated (this is the liability record)

```sql
select social_account_id, instance_name, last_connection_state from whatsapp_evolution_instances;
-- instance_name = postora_<social_account_id>
```

**Check no credential leaked to the browser:** open DevTools → Network, reload the accounts page,
and search the `social_accounts` response for `jwt_key`. **It must not appear.** `account_metadata`
is returned to the browser wholesale, which is exactly why the key lives in a separate deny-all
table.

**Mid-pairing check:** between generating the QR and scanning, the account row exists with
`is_active = false`. Confirm the scanner still shows status — it must query by account id, because
`useSocialAccounts` filters `is_active = true` and would not see a pairing row.

### B4. Two-way messaging

Message the linked number **from an external phone**.

**Expect:** it appears in the Postora inbox, the unread counter increments, and — if an n8n webhook
is registered — the workflow fires with **the identical envelope from A2**, with
`platform: "whatsapp"`. A workflow built against a Cloud API account should need **zero changes**.

Reply from the Postora inbox, and again from n8n via `/api/v1/messages/reply`. Both should reach the
phone in a couple of seconds, and both should route through Evolution rather than the Graph API.

**Anti-echo check:** send a message *from the linked phone itself* (`fromMe: true`).
**Expect no** n8n trigger and no reply loop. This is the failure mode that produces infinite bot
conversations.

### B5. Capability limits are enforced server-side

Evolution has no Meta template/catalog/interactive surface. Disabling the UI is not enough — any API
caller can bypass it. Against a QR-connected account, call `messaging-api` with:

`whatsapp_send_template`, `whatsapp_send_interactive`, `whatsapp_get_catalog`,
`whatsapp_send_product`

**Expect** a clear *"not supported in Direct QR mode"* error from the **backend** for each — not a
confusing Graph API failure, and not a success.

Also confirm the AI agent (`ai-agent-reply`) and the e-commerce sender (`ecommerce-whatsapp-api`)
either route through Evolution or refuse cleanly on a QR account. Before this change they called the
Cloud API directly and would have failed opaquely.

### B6. Webhook authentication

Evolution signs its webhooks with an HS256 JWT derived from the per-instance key.

| Do this | Expect |
|---|---|
| POST to `whatsapp-evolution-webhook` with no `Authorization` | 401 |
| POST with a random Bearer token | 401 |
| POST with a JWT signed by a *different* instance's key | 401 |
| Capture a valid request and replay it | accepted (the JWT is not body-bound) but **no duplicate message** — idempotency makes it a no-op |
| Replay it after 10 minutes | 401 — the JWT has expired |

The replay window is a real, documented limitation: Evolution's JWT carries `exp: iat+600` and is not
bound to the request body. Message-ID idempotency is what makes it harmless.

### B7. Disconnect and cleanup

Disconnect the QR account in Postora.

**Expect:** `is_active` → `false`, the device disappears from the phone's Linked Devices list, and
the Evolution instance is removed.

**Failure-path check (worth forcing once):** if instance creation succeeds but the database write
fails, the bridge deletes the Evolution instance. Without that compensation an orphaned instance
keeps a live linked device that Postora no longer knows about.

### B8. Ownership isolation

As user A, call the bridge with user B's `social_account_id` for `get_qr_status` and
`logout_instance`. **Expect** a not-found error in both cases.

Instance names are always derived server-side from the owned row — the API never accepts a
client-supplied instance name. Worth confirming, because the global Evolution key can control every
instance on the server.

---

## Known gaps — expected to fail, do not raise as bugs

1. **The n8n node is not published.** The in-repo copy is at `1.2.0` and its tests pass, but
   `F:\N8N\Postora-n8n-community-node` was not mounted, so the standalone repo was never synced,
   built, or published to npm. `npm view n8n-nodes-postora version` still reports the old version,
   and **hosted n8n users will not see the new Trigger events or the Message resource until that
   publish happens**. Anyone testing Feature A through n8n today must install the node from source.
2. **No durable delivery.** If the isolate dies mid-dispatch, that webhook delivery is lost with no
   retry. Accepted for this release.
3. **Concurrent AI + n8n replies** can both land (A4).
4. **Inbound path latency** was not restructured. Meta's 5s budget was already tight before this
   change; dispatch was kept off the awaited path, but no P95/P99 measurement was taken. Worth
   watching under real load.
