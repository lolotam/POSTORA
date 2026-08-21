# WhatsApp Direct QR: ID Normalization, `fromMe` Persistence, and Historical Chat Sync

Date: 2026-08-21
Branch: `fix/whatsapp-qr-webhook-delivery`
Status: implemented, reviewed and verified against the live stack (2026-08-21)

## Problem

After Direct QR Connect (`connection_mode = 'evolution_qr'`) started working, the Live
Messaging inbox stayed effectively empty: no past conversations, replies from the
conversation dialog failed, and messages sent from the owner's phone never appeared.

Investigation on the live stack (Evolution API v2.3.7 at `wa.postora.cloud`, instance
`postora_93de5a12-4b74-4227-8eed-a45f85f8a51d`) showed one symptom with **three
independent causes**. Evidence for each is recorded below; none of it is inferred.

### Cause A - no history import

Evolution's own store holds **332 chats** for the instance. Postora's `messaging_cache`
holds **1**. Baileys only pushes messages that arrive *after* linking; everything older
lives in Evolution's database and nothing in Postora ever reads it.

Webhook delivery itself is healthy - Evolution logs show successful POSTs to
`https://api.postora.cloud/functions/v1/whatsapp-evolution-webhook`, and exactly one
`messages.upsert` in 24h (23 `connection.update`, 34 `qrcode.updated`).

### Cause B - `platform_user_id` violates the digits-only invariant

QR activation stores the full JID `96597950350@s.whatsapp.net`. Every other WhatsApp
account stores digits only (`1081875588344886`, `1073510062515838`). Three consumers
silently depend on the digits form. In `messaging-api/index.ts:1126`:

```ts
conversationId.replace(`wa_${social_account_id}_`, "").replace(/^wa_\d+_/, "")
```

Neither replacement matches: the first looks for the account UUID, which the id does not
contain; the second requires `_` after the digits but encounters `@`. `participant_id`
therefore returns the entire string `wa_96597950350@s.whatsapp.net_96555683677`, and
`ConversationDetail.tsx:124` passes that verbatim as `recipient_phone`. The send cannot
resolve a recipient. This is the "cannot reply from the conversation dialog" symptom.

### Cause C - `fromMe` messages are discarded

`isInboundMessage()` in `whatsapp-evolution-webhook/index.ts` drops `key.fromMe === true`.
Correct for Cloud API; wrong for QR, where the owner replying from their own phone is
legitimate inbox content. The single `messages.upsert` received in 24h was filtered by
this rule. This is the "shows on mobile only" symptom.

Compounding it, `persistInboundMessage` destructures away the upsert `error`, so a genuine
database failure is indistinguishable from a deliberate filter drop.

## Verified facts about the Evolution API

Measured against the live instance. These correct several assumptions in the original
feature brief and MUST be honoured by the implementation.

| Fact | Value |
|---|---|
| `POST /chat/findChats/{instance}` | returns a plain array; 0.20s |
| `POST /chat/findMessages/{instance}` | returns `{messages:{total,pages,currentPage,records}}` - **not** an array; 0.10s |
| `findMessages` `limit` parameter | **ignored** - 110 messages came back as 3 pages of ~40 |
| `POST /chat/findContacts/{instance}` | returns a plain array; 7148 entries, 7146 with `pushName` |
| Chat JID mix (332 total) | 307 `@s.whatsapp.net`, 13 `@lid`, 12 `@g.us` |
| Participant names in `findChats` | **zero** - `pushName` is null on all 307 direct chats |
| `lastMessage.pushName` on inbound | the phone number repeated as a string, not a name |
| Names via `findContacts` join | 159 of 307 resolve to a real name; 148 fall back to the number |
| `profilePicUrl` coverage | 6 of 307 |
| `unreadCount` in `findChats` | 0 on every chat |

Database facts:

- `idx_whatsapp_messages_user_message_id` is a genuine `UNIQUE` index on
  `(user_id, message_id)`, so `onConflict: "user_id,message_id"` is real idempotency.
- `messaging_cache` has `UNIQUE (user_id, conversation_id)`.
- `whatsapp_contacts` has `UNIQUE (user_id, phone_number)` and requires `workspace_id`.
- `whatsapp_evolution_instances` has **no** `last_sync_at` column.
- Outbound sends already store the Baileys `key.id` as `message_id`
  (verified: `3EB088496DD5BCE31F6874`), so a webhook echo of our own send deduplicates
  for free. No explicit echo suppression is required.

## Decisions

1. **Normalize `platform_user_id` to digits.** Restores the invariant; no parser changes.
2. **Import direct chats only** in v1. Skip `@g.us` and `@lid` (25 chats), and log the
   count. Digit-stripping a group or privacy id yields a non-phone number that collides
   with the `wa_<me>_<phone>` scheme and cannot be replied to.
3. **Sync depth: all chats, newest page each.** 307 conversations plus roughly 12,000
   messages, about 7s at concurrency 5. No pagination loop in v1.

## Design

### Commit 1 - JID normalization (bug fix)

- `supabase/functions/_shared/evolutionQrAccount.ts`: strip the `@...` suffix from the
  owner JID before writing `platform_user_id`. Single behavioural change.
- One-time data correction for the 3 existing rows (1 `social_accounts`,
  1 `messaging_cache`, 1 `whatsapp_messages`) via `docker exec psql`.
- Must land before any sync runs, otherwise 307 conversations and ~12,000 messages are
  materialized in the broken id format and need migrating afterwards.

### Commit 2 - `fromMe` persistence (bug fix)

- `whatsapp-evolution-webhook/index.ts`: persist `key.fromMe === true` messages with
  `direction: "outbound"`. Retain the `status`, `protocolMessage` and
  `status@broadcast` filters.
- Stop discarding the upsert error; log it.

### Commit 3 - historical chat and contact sync (feature)

| Module | Responsibility |
|---|---|
| `_shared/evolutionApi.ts` | add `findChats`, `findMessages`, `findContacts` - HTTP only, no business logic |
| `_shared/evolutionMessageNormalize.ts` | **extracted** from the webhook: `getMessageText`, `messageTimestamp` |
| `_shared/whatsappSyncEngine.ts` | fetch, filter, join names, batch upsert |
| `whatsapp-evolution-bridge/index.ts` | new `sync_past_chats` action - workspace admin + cooldown |
| migration | add `whatsapp_evolution_instances.last_sync_at timestamptz` |
| frontend | "Sync Past Chats" control, shown only for `evolution_qr` accounts |

Extracting the normalizer is load-bearing, not tidiness: history and live messages must
produce identical rows, or the same conversation renders differently depending on which
path delivered it.

**Sync algorithm**

1. `findChats` and `findContacts` concurrently.
2. Keep chats whose `remoteJid` ends in `@s.whatsapp.net`; count and log the rest.
3. Build a `remoteJid -> pushName / profilePicUrl` map from contacts.
4. Upsert `messaging_cache` per chat, `onConflict: "user_id,conversation_id"`, with
   `conversation_id = wa_${account.platform_user_id}_${digits(remoteJid)}`,
   `participant_name = contactName ?? digits(remoteJid)`, and `unread_count` taken from
   Evolution's `unreadCount` - never incremented.
5. In chunks of 5, `findMessages` per chat, read `payload.messages.records`, normalize via
   the shared module, and upsert `whatsapp_messages` with
   `onConflict: "user_id,message_id", ignoreDuplicates: true`. `direction` follows
   `key.fromMe`.
6. Set `last_sync_at`.

Per-chat failures are caught and logged; the sweep continues.

**Triggers** - `CONNECTION_UPDATE -> open` in the webhook, `reconcileAccountConnection`
in the bridge poller, and the manual action. All three share one `last_sync_at` cooldown
(60s) and run through `runInBackground`.

**Explicitly not reused:** `touchConversation` increments `unread_count` per message and
would report roughly 12,000 phantom unreads.

### Known risk

When `open` fires, Baileys may still be pulling history from the phone, so an auto-sync
can land early and import little. The engine is idempotent and cheap, so the manual
control is the reliable path and auto-sync is best-effort. To be verified empirically on
the next scan rather than asserted.

## Testing

Deno tests using a fake Evolution client and the `recordingAdmin()` pattern already
established in `_shared/evolutionQrAccount.test.ts`:

- `@g.us` / `@lid` chats are excluded and counted
- name resolution falls back to the phone number when the contact has no `pushName`
- `unread_count` comes from Evolution and is never incremented
- `findMessages` envelope (`messages.records`) is unwrapped correctly
- normalizer parity: the webhook path and the sync path produce the same row for the
  same Baileys message
- `fromMe` messages are stored as `direction: "outbound"`

Gates: `deno check` on every changed function, `deno test supabase/functions/_shared/`
(current baseline 104 passed / 0 failed), `npm test` for frontend changes.

## Deployment order

1. Apply the migration via `docker exec ... psql` (the Supabase MCP is read-only for DDL).
2. Copy changed edge functions into
   `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`,
   hash-verify with `tr -d '\r' | sha256sum` on both sides (volume is CRLF, git blobs LF).
3. `docker restart postorasupabase-supabase-j8axyh-supabase-edge-functions`.
   The project runbook says `docker compose up -d --no-deps functions`, but that command
   compares service definitions rather than file contents: with no image or config change it
   prints `Running` and leaves the old code loaded. Observed again during this work, and
   already recorded from two earlier deploys. Use it only when the compose file itself
   changed; otherwise restart the container.
4. Only then merge to `main` - main auto-deploys the frontend only, so a merged frontend
   calling undeployed functions is the failure mode to avoid.

---

# Revision after the Codex debate round (2026-08-21)

Codex reviewed this design read-only and returned NEEDS REDESIGN with eight blocking
findings. Seven are accepted, one is accepted only in part. Each verdict below was
re-verified against the code rather than taken on trust.

## Accepted - and why they were real

**R1. `fromMe` needs more than a `direction` flip.** `MessagingInbox.tsx:42` sets
`pageId = selectedAccount.platform_user_id`, and `ConversationDetail.tsx:276` decides the
bubble side with `msg.from?.id === pageId`. `whatsapp_get_messages` maps
`from.id = m.from_phone`. So an owner-sent message must store the **owner's digits** in
`from_phone` and the remote party in `to_phone`, or it renders as received. The UI never
reads `direction` at all. Commit 2 therefore swaps sender/recipient for `fromMe` and never
increments unread for an owner-sent message.

**R2. Durability - accepted in part.** Codex claimed `runInBackground` waits only 2s. That
cap applies **only** when `EdgeRuntime.waitUntil` is absent (`background.ts:41-53`); this
stack runs `supabase/edge-runtime:v1.67.4`, which provides it. The proposed job table with
lease, cursor and scheduled worker is rejected as over-engineering for a 7s idempotent
sweep. The real concern - a killed run leaving no completion record - is met by writing
`last_sync_at` **only on successful completion**, so an interrupted sweep is simply re-run
and every write is idempotent.

**R3. The cooldown is not a lock.** Three triggers could start concurrent imports, and an
early empty sweep would stamp `last_sync_at` and suppress the retry that Baileys warm-up
needs. Replaced with an explicit lease: `sync_started_at` claimed by a conditional update
that returns the claimed row (zero rows means another sweep owns it), plus `last_sync_at`
set only when the sweep actually imported something.

**R4. Manual sync cannot require workspace admin.** `findOwnedAccount`
(`whatsapp-evolution-bridge/index.ts:135`) requires `social_accounts.user_id` to equal the
caller, so a non-owner admin could never invoke the action. `sync_past_chats` therefore
uses `findOwnedAccount` like every other bridge action; the spec's earlier "workspace
admin" wording was wrong about the code.

**R5. Reconnect under a new account row hides history.** Dedup is `(user_id, message_id)`
with `ignoreDuplicates`, while inbox reads filter by `social_account_id`. Re-importing the
same history under a new account row would skip every row and show empty conversations.
The sweep therefore merges on conflict instead of ignoring, rebinding
`social_account_id` and `conversation_id`. Safe because both sides derive from the same
source message.

**R6. Contacts were never persisted.** The design joined `findContacts` only for display
names, but `whatsapp_list_conversations` derives `contact_id` exclusively from
`whatsapp_contacts` (`messaging-api/index.ts:1133`). Without an upsert every imported chat
stays detached from the CRM. The sweep now upserts contacts with `user_id`, the account's
non-null `workspace_id`, digits-only `phone_number`, name and avatar - and never
overwrites a display name a user has edited.

**R7. A later sweep would erase live unread state.** Evolution reports `unreadCount: 0`
everywhere, so blanket-upserting it would reset genuine unread counts accrued since
linking. Evolution's value is used only when inserting a conversation Postora has not seen;
existing rows keep their Postora unread count.

**R8. QR-incompatible delete is exposed.** `delete_message`
(`messaging-api/index.ts:731`) uses Meta Graph credentials with no Direct QR rejection,
yet the UI renders delete for every message (`ConversationDetail.tsx:149`). A
`rejectDirectQrCapability` guard is added so the action fails cleanly instead of
attempting a Graph call with no token.

## Additional ordering rule

A history sweep must never regress live data: `messaging_cache.last_message_at`, preview,
name and avatar are only updated when the incoming timestamp is **newer** than the stored
one.

## Revised migration

`whatsapp_evolution_instances` gains two columns, not one:

- `sync_started_at timestamptz` - the lease
- `last_sync_at timestamptz` - successful completion

## Deferred, recorded deliberately

- `whatsapp_get_messages` caps at 100 rows (`messaging-api/index.ts:1188`); deeper history
  needs pagination that this change does not add.
- Group (`@g.us`) and privacy (`@lid`) chats remain unsupported.
- `isInboundMessage` keeps its name this round; renaming it to an eligibility predicate is
  a follow-up so the bug-fix diff stays reviewable.

---

# Revision after the Codex commit review and live verification (2026-08-21)

The implementation was exercised end to end against the live instance before merge. That run
found four defects no review had caught, and the Codex commit review found five more. Both
sets are fixed below.

## Found by running it

1. **`/contact/findContacts` answers 404.** The route is `/chat/findContacts` on v2.3.7.
   The table above has been corrected.
2. **The PostgREST `or()` lease filter never matched.** An ISO timestamp contains a `.`, and
   PostgREST splits an `or()` filter on that character, so the compare-and-set failed with
   42703. The claim moved into `claim_whatsapp_history_sync`, a single SQL
   `UPDATE ... WHERE` that is atomic without any filter encoding.
3. **The lease was never released on failure.** A sweep that threw left `sync_started_at` set
   for its whole window, and because a held lease returns early and silently, every retry in
   that window reported success while doing nothing. Released in a `finally` now.
4. **Duplicate message ids inside one page.** Evolution can return the same id twice, and
   Postgres rejects an `ON CONFLICT` statement that touches a row twice (SQLSTATE 21000),
   failing the whole batch. This cost 247 of 307 chats their messages until the rows were
   deduplicated before the write.

## Found by the Codex commit review

5. **Contact lookup was scoped by workspace while the uniqueness key spans workspaces.**
   `whatsapp_contacts` is unique on `(user_id, phone_number)`, so a contact the same user
   holds in another workspace was invisible to the check and would have been moved and
   renamed.
6. **The "don't overwrite newer live state" guard was a read-then-write race.** A webhook
   could advance a conversation between the read and the write.
7. **Merging message rows erased live data.** `buildEvolutionMessageRow` always writes
   `media_url: null`, while an outbound media send stores a real URL, so a later sweep would
   have wiped attachment links.
8. **Auto-import had no second attempt.** The QR screen stops polling shortly after `open`,
   so a sweep that ran before Baileys finished loading history was never retried.
9. **Dispatching to n8n after a failed inbox write risks double execution.** Meta retries a
   failed delivery, and the insert is what makes dispatch at-most-once.

## What changed as a result

Findings 5, 6 and 7 shared one cause -- conflict rules expressed as read-then-write in the
edge function -- and are now three SQL functions (`import_whatsapp_conversations`,
`import_whatsapp_contacts`, `import_whatsapp_messages`) that state each rule directly on the
conflict: a conversation only advances when the incoming record is newer, a contact is only
renamed when the stored name is absent or is just the phone number, and a message row is only
ever rebound to its account, never overwritten.

Finding 8 is addressed by triggering the import from the connection webhook as well as the
poller. Finding 9 is accepted: dispatch is tied to a successful insert again, and the failure
is logged rather than silently swallowed.

## Measured result of a full run

```text
chatsDiscovered 332, chatsImported 307, chatsSkipped 25, messagesWritten 457, chatFailures 0
```

307 conversations, 451 stored messages, 161 contacts, 159 conversations resolved to a real
name. All 307 conversation ids match `wa_<owner>_<digits>`, and both directions are present
(265 inbound, 186 outbound), confirming the `fromMe` fix on imported history.

**The "roughly 12,000 messages" estimate earlier in this document was wrong.** It came from
extrapolating the one chat that had 110 messages. Evolution holds about two messages for most
chats, so the real total is ~450. Nothing is being dropped -- that is the entire history
Baileys pulled off the phone, and deeper history is not available through this path.
