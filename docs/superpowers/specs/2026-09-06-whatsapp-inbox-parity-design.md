# WhatsApp inbox parity with Danat — design

Date: 2026-09-06. Branch: `worktree-whatsapp-inbox-parity`.

Reference implementation: `F:\Danat-Mostakbal` (`src/components/admin/whatsapp/**`,
`src/hooks/useWhatsAppInbox.ts`, `src/fns/evolutionHistorySync.ts`,
`src/fns/evolutionWebhook.ts`, `src/lib/evolution/messageAck.ts`). Danat is a
single-tenant Evolution inbox; Postora is multi-tenant (`social_accounts` ×
`workspace_id`) and already has pin / hide / revoke / labels / AI mode / export /
voice notes / quick replies. Only what Danat has and Postora lacks is ported.

## 1. Problem, with evidence

Measured on production (`postorasupabase` DB, 2026-09-06) for active Direct-QR
accounts:

| owner number | conversations in `messaging_cache` | shown in UI | `whatsapp_messages` rows | outbound rows still `sent` |
|---|---|---|---|---|
| 96597950350 | 264 | 50 | 476 | 199 |
| 201285060308 | 285 | 50 | 1184 | 574 |
| 201000689201 | 129 | 50 | 239 | 107 |

Four confirmed causes:

1. **List cap.** `messaging-api` `whatsapp_list_conversations` selects
   `.limit(50)`; the client filters by `participant_name` only.
2. **LID chats never imported.** `_shared/whatsappSyncEngine.ts` `scanChats`
   drops any `@lid` chat whose `lastMessage.key.remoteJidAlt` is absent
   (`chatsUnaddressable`). Danat resolves such chats by probing page 1 of the
   chat and matching any `message_id` already ingested from a live webhook.
3. **Evolution holds only the pairing snapshot.** The Dokploy app
   `postora-evolutionapi` (Evolution 2.3.7, Baileys 7.0.0-rc14) has no
   `CONFIG_SESSION_PHONE_SYNC_FULL_HISTORY`; only the snapshot WhatsApp sends at
   pairing exists to sweep. Baileys rc14 already carries the 463 reach-out fix
   Danat is still waiting for.
4. **No delivery acks.** `MESSAGES_UPDATE` is not in the subscribed event list
   (`_shared/evolutionApi.ts`, `whatsapp-evolution-bridge/index.ts`) nor
   handled by `whatsapp-evolution-webhook`. Every outbound row stays `sent`;
   the bubble renders no ticks.

## 2. Scope

### Track A — sync correctness (ships first)

A1. `whatsapp_list_conversations`: cap 50 → 500, optional `q` (name or phone,
`ilike`, `%`/`_` stripped), and the contact directory name overrides the cached
push name (`whatsapp_contacts.display_name` when set and not equal to the
phone). Response shape unchanged plus nothing new required by the client; the
client passes `q` from the existing search box (debounced 250 ms) and stops
filtering client-side.

A2. `whatsappSyncEngine.ts`: for a LID chat with no `remoteJidAlt`, fetch page
1 of `findMessages(remoteJid)`, collect key ids, look up
`whatsapp_messages.message_id IN (...) AND social_account_id = account.id`,
take its `conversation_id` phone. Found → import the chat under that number
(the `addressFallback` already supported by `buildEvolutionMessageRow`).
Not found → count as `chatsAwaitingLid` (renamed from `chatsUnaddressable`
in the outcome; log line updated). The lookup is scoped per account, unlike
Danat's global lookup, because the same LID may belong to different tenants.

A3. Sync feedback. New columns on `whatsapp_evolution_instances`:
`last_sync_outcome jsonb` (the `SyncOutcome` plus `finished_at`). Written in
the `finally` of `importEvolutionHistory` alongside the lease release. The
bridge action `sync_past_chats` keeps returning immediately (the sweep can
exceed the edge worker ceiling) but `get_qr_status` and a new bridge action
`get_sync_status` return `last_sync_outcome`. `WhatsAppSetup` polls
`get_sync_status` every 3 s after the button press until `finished_at`
advances, then toasts Danat-style: `N messages, M chats imported`, plus
`partial — run again` when `truncated`, plus `K chats waiting for a first live
message` when `chatsAwaitingLid > 0`.

A4. Ops: set `CONFIG_SESSION_PHONE_SYNC_FULL_HISTORY=true` on the Evolution
Dokploy app and redeploy; the user re-pairs each QR account; the next sweep
imports full history. Ops only; no code.

### Track B — chat-box parity

B1. Delivery acks. Add `MESSAGES_UPDATE` to the event union and to the
subscription list used at pairing. New `_shared/evolutionMessageAck.ts`
(port of Danat `messageAck.ts`): `normalizeAckStatus` (string or numeric
Baileys code), `inboxStatusForAck` → `delivered | read | failed | null`,
`isMessageKeyId`. Webhook handler: for each item with `fromMe === true`
update `whatsapp_messages.status` where `message_id = keyId AND
social_account_id = account.id` (never downgrade `read` → `delivered`;
order is sent < delivered < read, `failed` is terminal). Ops: call
`setWebhook` on every paired instance so existing sessions send the event
(a `resubscribe_webhook` bridge action, service-role or workspace-admin
gated, run once per instance from a script).

B2. Status ticks. `WhatsAppMessageBubble` renders one check for `sent`,
double grey for `delivered`, double blue for `read`, red alert for
`failed`, only on sent bubbles. `status` already flows through
`toWhatsAppMessageView` and the mutable overlay in
`getConversationState`, so the 15 s state poll picks acks up.

B3. Forward. New port `forwardMessage({ social_account_id, message_row_id,
to_phone })` → new messaging-api action `whatsapp_forward_message`:
text → existing send path; media → resolve the cached file
(`whatsappMediaResolver`) and re-send via `sendMedia`. A
`WhatsAppForwardDialog` (ui) lists conversations then contacts not already
listed, searchable, one click sends. Menu entry "Forward" in
`WhatsAppMessageContextMenu`.

B4. Delete chat. New action `whatsapp_delete_conversation`: deletes
`whatsapp_messages` for the conversation, then the `messaging_cache` row;
contact and cached media stay. Agent-min role like `whatsapp_mark_read`.
Hover trash on the list row plus a confirm dialog; deleting the open chat
deselects it.

B5. Download for every media kind. `WhatsAppMediaAttachment` gets a download
control for image / video / audio (uses the existing `downloadBlob` port with
the resolved signed URL and `file_name`). The lightbox becomes
`WhatsAppMediaLightbox` handling image (with prev/next as today), video
(`<video controls autoPlay>`), and PDF (`<iframe>` on the signed URL);
`resolveMediaKind` (domain) decides pdf from `mime_type` or a `.pdf` name.

B6. Thread layout. Day separators (group by local day), absolute times
(`HH:mm` in the bubble, `HH:mm` today / `dd/MM/yy` otherwise in the list),
phone number under the name in the pane header. Bubble colours use the
existing WhatsApp green theme tokens (`app_theme_whatsapp_green` migration
already defines them); wallpaper background on the message pane.

B7. Contact from the header. Header button "Add to contacts" (no directory
row with a name) / "Edit contact" (row exists) opening the existing
`ContactFormDialog` from `components/messaging/contacts`, seeded with phone
and name. Saving invalidates the conversations query so the list shows the
new name (A1).

## 3. Architecture and placement

- Feature folder `src/features/whatsapp-inbox` keeps its fences: new ports in
  `application/ports.ts`, adapter methods in
  `infrastructure/whatsappInboxApi.ts`, only `WhatsAppInboxScreen` imports
  infrastructure. Domain additions: `resolveMediaKind.ts`, `messageStatus.ts`
  (tick mapping + monotonic order), `dayGroups.ts`. All pure, tested.
- Edge: no new function. Actions added to `messaging-api` follow the
  `withWhatsAppActionAccess` pattern; role floor `agent` for forward / delete.
  Sync engine and ack handling stay in `_shared/*` with Deno tests.
- Migrations: one file adding `last_sync_outcome` to
  `whatsapp_evolution_instances`. No new tables, no RLS change.
- No i18n / RTL port; Danat's hard-coded hex replaced by theme tokens.
- Existing features untouched: pin, hide/revoke, labels, AI mode, export,
  voice, quick replies, interactive builder, Facebook/Instagram shells
  (`scopeFence.test.ts`).

## 4. Data flow changes

- Ack: Evolution → `MESSAGES_UPDATE` → webhook → `whatsapp_messages.status`
  → `whatsapp_get_conversation_state.mutable[].status` → bubble ticks.
- LID import: sweep → probe page 1 → `whatsapp_messages` lookup by account →
  `addressFallback` → `import_whatsapp_messages` (unchanged SQL).
- Sync status: sweep `finally` → `last_sync_outcome` → `get_sync_status` →
  toast.

## 5. Error handling

- Ack with an unknown key id or a foreign account: ignored, 200.
- Forward of a media message whose file is `MEDIA_UNAVAILABLE`: typed error
  `media_unavailable`, toast, nothing sent.
- Delete chat: messages first, cache row second; a failure between leaves the
  row visible rather than orphaning rows.
- Sync status poll stops after 5 min or on `finished_at` change.

## 6. Testing

- Domain: `resolveMediaKind`, `messageStatus` (monotonic order, tick
  mapping), `dayGroups`, ack normalisation (Deno).
- Application: forward and delete mutations invalidate the right keys;
  `useWhatsAppMessages` applies `status` from the overlay (existing test
  extended).
- Infrastructure: adapter bodies for the two new actions.
- UI: bubble ticks per status, forward dialog picks a target, list search hits
  phone, header contact button state.
- Edge (Deno): `MESSAGES_UPDATE` handler updates only own-account rows and
  never downgrades; sync engine imports a LID chat with an anchor and counts
  one without; list action honours `q` and the directory-name override.
- Manual: after deploy, one outbound message shows ticks progressing;
  "Sync past chats" toast shows counts; a 264-chat account lists all rows.

## 7. Delivery order and ops

1. Migration (rehearse on the harness, never in the prod container), edge
   deploy of `messaging-api`, `whatsapp-evolution-webhook`,
   `whatsapp-evolution-bridge`, `_shared/*` BEFORE merging (frontend
   auto-deploys on `main`).
2. Set the full-history flag on the Evolution app; redeploy; user re-pairs.
3. Re-subscribe `MESSAGES_UPDATE` on every currently paired instance.
4. Merge; one Codex bot review round; deferred nits to an issue.

## 8. Known limits

- A LID chat whose contact never writes in after pairing stays unimportable.
- Full history arrives only after a re-pair with the flag on.
- Acks only reach messages sent after re-subscription.
