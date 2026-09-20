<!--
  Our side of the wasl integration clarification, sent 2026-09-20 and mirrored
  here so the reasoning lives with the code it describes.

  The partner escalated four asks. Three needed something other than what was
  asked for, and the root cause was ours: partner_provisioned_workspaces was
  empty, so assertEntitled refused before reading any feature flag, for every
  partner key rather than just theirs. See issue #183 for the structural problem
  underneath, and docs/api/openapi.yaml for the media endpoint this introduced.

  The copy the partner received is autoverse511-cyber/wasl-selfhosted PR #144.
-->

# Postora → wasl: the integration is unblocked, and three of the four asks needed something other than what was asked for

Thanks for the precise report. It was accurate about what you observed, and the endpoint-by-endpoint table is what let us find the cause quickly. The conclusion it reached was wrong, though, and in a useful direction: **the blocker was ours, it was a single missing database row, and it is now fixed.** No entitlement needed enabling.

Below is what was actually happening, ask by ask.

---

## The real cause: every partner key was refused, for everyone

`/agents` and `/whatsapp/numbers` returned `403 feature_not_entitled`, so the natural reading was that a feature flag was off. It was not. Every flag involved was already `true`, and your key already held every scope.

Our entitlement check resolves the workspace's owner **before** it reads a single flag:

```
if (!provisioning?.owner_user_id)
  return refuse("feature_not_entitled", "missing_provisioned_owner");
```

That owner lives in a provisioning table which was **completely empty in production**. So the check refused before reaching any flag, and it refused for every partner key, not just yours. The error names a feature, which is exactly why it read as an entitlement problem and why you escalated it as one. That was a reasonable inference from the evidence you had.

The gap dates from a change on 2026-09-12 that added the owner lookup without populating the table, and nothing reported it.

**Fixed.** Your workspace is bound to its owner, and we have also fixed the key-minting path so every future key creates its binding in the same transaction, plus a backfill for keys already issued. Your existing `pk_live_` key needs no change.

---

## Ask 1 — human agents: nothing to enable

`feature_human_agent` was already enabled globally, and your key already carries `agents:read` and `agents:manage`. With the provisioning fixed, `/agents`, `/conversations/{id}/assignment`, `/assignment-history` and `/mode` are all reachable now.

One trap worth knowing before you call it: **`/v1/conversations/{id}/mode` requires an explicit `?platform=` parameter.** There is no default. Omitting it returns `403 feature_not_entitled` with reason `unsupported_agent_platform`, which will look exactly like the bug you just reported and is not one.

## Ask 2 — WhatsApp numbers: nothing to enable

Same story. `feature_msg_whatsapp` and `feature_wa_evolution_qr_enabled` were both already on, and your key holds `whatsapp:numbers.read` and `whatsapp:numbers.manage`. `/whatsapp/numbers` works now.

## Ask 3 — inbound media: this one was real, and it is now built

You were right that this was the largest functional gap and right about why: the `media_url` on the webhook is a `graph.facebook.com` lookaside link that expires and needs a bearer token you do not hold. Storing it would persist a dead link.

Three things shipped:

1. **`message.received` now carries `postora_message_id`**, a stable `msg_`-prefixed id. The existing `id` field is unchanged and is still the provider's wamid.
2. **`GET /v1/conversations/{id}/messages` now returns a `media` object** on each message, with `type`, `mime_type`, `file_name` and `size_bytes`. It is `null` when the message has no attachment, never absent.
3. **`GET /v1/messages/{id}/media`** returns a signed, Postora-origin URL for the bytes, needing scope `media:read`, which your key already has.

The response states its own expiry, so you do not have to guess:

```json
{
  "message_id": "msg_…",
  "type": "image",
  "mime_type": "image/jpeg",
  "size_bytes": 84213,
  "url": "https://…",
  "expires_in": 900,
  "expires_at": "2026-09-20T12:15:00Z"
}
```

**Please do not persist that `url`.** It is a capability that expires in 15 minutes, not an identifier. Store the `postora_message_id` and call the endpoint again when you need the bytes. We deliberately made it shorter than our internal default because this URL leaves our infrastructure and enters yours.

This means your adapter's `getMedia` is no longer a stub with nothing behind it, and the three `downloadEvolutionMessageMedia` call sites now have a Postora counterpart to port to.

## Ask 4 — the WABA id: there is none, and there never will be for this account

This is the one we would push back on. The account is connected in **`evolution_qr` mode**, a QR-paired personal number. It has no WhatsApp Business Account id because that concept does not apply to it.

So `/templates` returning `409 account_not_connected` is correct behaviour, not a misconfiguration, and there is no id we can look up for you. **Template messaging requires a WhatsApp Cloud API number**, which is a different connection, not a setting on this one.

The same boundary affects delivery receipts: `message.delivered`, `message.read` and `message.failed` are Cloud API only. A QR-paired number cannot emit them. If either templates or delivery receipts are load-bearing for wasl, the answer is onboarding a Cloud API number, and we are happy to help with that as a separate piece of work.

---

## Two things that will bite you on first run

**`message.status` is not a real event name.** Our certified list has no such entry, so `createWebhook` will reject it with a 400. The vocabulary splits it three ways. Subscribe to:

```
message.received
message.accepted
message.delivered      (Cloud API only)
message.read           (Cloud API only)
message.failed         (Cloud API only)
conversation.assigned
conversation.unassigned
```

`conversation.assigned` and `conversation.unassigned` are real and you have them right.

**Your WhatsApp number is currently disconnected.** The account shows `is_active = false`, so nothing will work end to end until it is re-paired, regardless of everything above. Worth doing before you test.

---

## Suggested order to verify

1. Re-run your four-endpoint probe. Expect `/agents` 200, `/whatsapp/numbers` 200, `/webhooks` 200, and `/templates` still 409, which is correct for a QR account.
2. Reconnect the number.
3. Create the webhook with the event names above, and store the signing secret it returns. It is shown once.
4. Send a message in, watch for `message.received`, and confirm `postora_message_id` is present.
5. For a message with an attachment, call `GET /v1/messages/{postora_message_id}/media` and fetch the URL.
6. Reply via `POST /v1/messages`, watch for `message.accepted`.
7. Assign via `PUT /v1/conversations/{id}/assignment`, watch for `conversation.assigned`.

Everything there is testable today.

One thing we could not confirm from our side: both of your keys show a null `last_used_at`, so we cannot see the calls behind the table in your report. If your probes ran against a different key or base URL than we think, tell us and we will re-check.

---

## Checked against this repository, so you do not have to re-derive it

Everything below was verified against `origin/main` at `33a099e` on 2026-09-20, not inferred from the report.

**What shipped is the dual-provider shape, not the cutover.** `server/evolution.ts`, `server/evolutionWebhook.ts` and `server/evolutionReconciliation.ts` are all still present. PR #119 merged, but the Evolution removal did not land with it, so the rollback path is a configuration change rather than a redeploy. `resolveProviderKey` returns `"evolution"` for anything that is not exactly `"postora"`, which is the fail-safe direction.

**The adapter method you will want first already exists and now has a backend.** `getMedia` was written against `GET /v1/media/{id}`, which returns metadata only. The new route is `GET /v1/messages/{id}/media` and returns the signed URL, so it needs a small addition rather than a rewrite.

**Two things in the report are already right in this tree and need no action.** The human-agents runbook names `0051_eager_old_lace.sql` and explains the renumbering from `0036`, and the webhook receiver's signature verification is correct: HMAC-SHA256 over `timestamp.rawBody`, constant-time compare, 300-second skew limit, computed on the raw bytes before parsing.

**One design note on the webhook secret.** It is read from a single platform-wide `POSTORA_WEBHOOK_SECRET`, while `createWebhook` returns a per-subscription secret that is never persisted. Rotating a subscription's secret will therefore break verification until that environment variable is updated and the app redeployed. Worth knowing before anyone reaches for `rotateWebhookSecret`.
