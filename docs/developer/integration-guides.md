# Integration Guide — End-to-End

Synthetic data throughout. Replace `pk_live_REPLACE_ME` and ids with your own.

## 1. Get a key

Ask your operator for a key bound to account `acc_11111111-1111-4111-8111-111111111111` with scopes `messages:send`, `messages:read`, `media:write`, `webhooks:manage`.

The operator mints it with `scripts/create-partner-key.ts --token <user JWT>`; the plaintext is shown once.

## 2. List accounts

```bash
curl -H "x-postora-key: pk_live_REPLACE_ME" \
  https://api.postora.cloud/functions/v1/partner-api/v1/accounts
```

Verify the binding contains the account you expect.

## 3. Upload media (if sending media)

```bash
curl -X POST https://api.postora.cloud/functions/v1/partner-api/v1/media \
  -H "x-postora-key: pk_live_REPLACE_ME" \
  -H "Idempotency-Key: 22222222-2222-4222-8222-222222222222" \
  -F file=@photo.jpg
# → {"id":"media_33333333-3333-4333-8333-333333333333", ...}
```

## 4. Send a text message

```bash
curl -X POST https://api.postora.cloud/functions/v1/partner-api/v1/messages \
  -H "x-postora-key: pk_live_REPLACE_ME" \
  -H "Idempotency-Key: 44444444-4444-4444-8444-444444444444" \
  -H "Content-Type: application/json" \
  -d '{"type":"text","recipient_phone":"+15550000000","text":{"body":"Hello Jane Example"}}'
# → 200 {"success":true,"message_id":"<wamid>","state":"accepted_by_meta","recorded_in_inbox":true,"request_id":"55555555-5555-4555-8555-555555555555"}
```

The provider `message_id` is the wamid, not an `msg_` id and not the Idempotency-Key. Media sends reference `"media_id"`.

If `409 idempotency_in_progress`, retry after backoff with same key+body. If `409 idempotency_indeterminate`, do not retry — reconcile (see §6).

## 5. Subscribe to webhooks

```bash
curl -X POST https://api.postora.cloud/functions/v1/partner-api/v1/webhooks \
  -H "x-postora-key: pk_live_REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/postora-webhook","events":["webhook.test","message.accepted","message.delivered"]}'
# Store "secret" — shown once.
```

Include `webhook.test` so the next step succeeds. Rotate with `POST /v1/webhooks/{id}/rotate-secret` (24h overlap). Test requires the subscription be active and subscribed to `webhook.test`:

```bash
curl -X POST https://api.postora.cloud/functions/v1/partner-api/v1/webhooks/wh_66666666-6666-4666-8666-666666666666/test \
  -H "x-postora-key: pk_live_REPLACE_ME"
# → 202 {"status":"queued","occurrence_id":"webhook.test:..."}
```

## 6. Receive events and reconcile

Verify signatures per `webhooks.md`, dedupe on `X-Postora-Event-Id`.

An accepted send's wamid is `message_id` in both the send response and `message.accepted` webhook payload. To reconcile an indeterminate send, list the conversation's messages and match `provider_message_id` to that wamid:

```bash
curl -H "x-postora-key: pk_live_REPLACE_ME" \
  "https://api.postora.cloud/functions/v1/partner-api/v1/conversations/conv_77777777-7777-4777-8777-777777777777/messages?limit=20"
```

`message.accepted` confirms the wamid; `message.delivered`/`message.failed` track downstream progress. Ordering is not guaranteed.
