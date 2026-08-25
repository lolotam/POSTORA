# Spec — WhatsApp Business chat experience overhaul

- **Date:** 2026-08-25
- **Revision:** 3 (after two Codex adversarial review rounds)
- **Branch:** `feat/whatsapp-chat-overhaul` (worktree `F:/Postora_wa_chat`, cut from `origin/main` @ `333e1e68`)
- **Scope:** `/messaging/whatsapp/conversations` only. Facebook Messenger and Instagram DM inboxes must be visually and behaviourally unchanged.
- **Goal (closes only on merge to `main`):** the WhatsApp Business conversations screen reads and behaves like the WhatsApp application.

---

## 1. Context

The WhatsApp Business console at `/messaging/whatsapp/conversations` renders a
600px-tall chat box stranded under three stacked header cards, with no voice
recording, no pagination, no per-message actions, no media rendering, and no
export. The user asked for it to become "a copy of the WhatsApp application".

Several of the requested items are described as "broken". They are not all the
same kind of broken, and the distinction drives the plan: some are missing
features, some are live defects with a proven root cause, and one is a data
problem that no amount of UI work can fix. Section 3 states the evidence for
each.

---

## 2. Evidence base

Everything below was verified either by reading the working tree at `333e1e68`
or by querying the production stack over `ssh-contabo-mcp` (`86.48.2.205`).

### 2.1 Frontend

| Fact | Location |
|---|---|
| Shell is `flex h-screen flex-col overflow-hidden`; `<main>` is `flex-1 overflow-y-auto` | `src/components/whatsapp/WhatsAppLayout.tsx:53,124` |
| The green header has no fixed height — it is content- and breakpoint-dependent. It stays visible because only `<main>` scrolls, so it never leaves the viewport | `WhatsAppLayout.tsx:54-95` |
| Collapsed rail is `w-[68px]` but keeps `h-4 w-4` icons | `WhatsAppLayout.tsx:100-105`, `WhatsAppNavList.tsx:36,43` |
| Page wrapper forces `min-h-[640px]`, under a `WhatsAppPageHeader` — a third piece of chrome on this route | `src/pages/whatsapp/Conversations.tsx:6-17` |
| Chat container is a hard `h-[600px]`, appearing 3× in the file | `src/components/messaging/MessagingInbox.tsx:155,192,234` |
| Setup-guide + connection cards render above the chat | `MessagingInbox.tsx:131` (`<WhatsAppSetup>`) |
| Auto-scroll effect depends on the raw query array | `src/components/messaging/ConversationDetail.tsx:60-62` |
| `Mic` menu item is a file picker, not a recorder | `ConversationDetail.tsx:334-336` |
| Only per-message action is a hover trash icon | `src/components/messaging/MessageBubble.tsx:101-110` |
| Media renders `image_data`/`video_data`, else a generic download link | `MessageBubble.tsx:13-39` |
| Opening a chat never clears unread (`useMarkConversationRead` has one caller: `NotificationBell`) | `src/hooks/useMessaging.ts:277-290` |
| **`MessagingInbox` has a fourth caller with no `platform` prop**, rendering all three tabs — so the shared WhatsApp block cannot be resized in place | `src/pages/BrandIntelligence.tsx:367` |
| A context-menu primitive and two lightbox implementations already exist; neither needs a new dependency | `src/components/ui/context-menu.tsx`, `src/components/post/MediaLightbox.tsx`, `src/components/scheduled/MediaLightboxDialog.tsx` |
| `IntersectionObserver`, `scrollIntoView` and `navigator.clipboard` are already mocked for tests; `MediaRecorder` and `getUserMedia` are not | `src/test/setup.ts:19,52,62` |

Repo-wide greps confirm **zero** occurrences of `MediaRecorder`, `getUserMedia`,
`useInfiniteQuery` (outside Threads replies), `ContextMenu` in the messaging
tree, or any zip / virtualization / audio-recording dependency in
`package.json`.

### 2.2 Backend

| Fact | Location |
|---|---|
| **`media_url` is hardcoded `null` for every Evolution-ingested row** — this, not the response mapping, is the origin of the broken-media bug | `supabase/functions/_shared/evolutionMessage.ts:162` |
| An SSRF-hardened fetcher set already exists and is tested: `EvolutionFetcher` (POSTs `/chat/getBase64FromMediaMessage/{instance}`), `CloudGraphFetcher`, `DirectUrlFetcher`, `selectFetcher` | `supabase/functions/_shared/inboundMediaFetchers.ts:244,309,358,380` |
| `FetchedMedia` carries only bytes and a mime type — **no filename and no size metadata** | `inboundMediaFetchers.ts:85-88` |
| `whatsapp_get_messages` is `.order(timestamp desc).order(id desc).limit(100)` with no cursor | `messaging-api/index.ts:1258-1300` |
| It returns `id: m.id` — the **local row UUID**, never the provider id `m.message_id` | `index.ts:1291-1292` |
| It sets `attachments: [{ file_url }]` and never `image_data`/`video_data` | `index.ts:1297` |
| The query filters `(social_account_id, conversation_id)`. The table has four indexes — `idx_whatsapp_messages_conversation (user_id, conversation_id, timestamp desc)`, `idx_whatsapp_messages_message_id`, `idx_whatsapp_messages_media_type`, and unique `idx_whatsapp_messages_user_message_id` — and **none of them serves this filter plus a keyset walk**, because the composite one leads with a column the query never filters on | migrations `20260413174023:22`, `20260414000921:8`, `20260710100000:21-22` |
| `whatsapp_mark_read` requires workspace role `agent`; a `viewer` gets 403 on every chat open | `messaging-api/whatsappAccess.ts:38` |
| `delete_message` is Meta-Graph-only and hard-throws for QR accounts | `index.ts:817-834`, esp. `:825-827` |
| The Evolution client exposes instance lifecycle, chat/contact/message history, logout and webhook config — but **no audio and no message-revoke method** | `_shared/evolutionApi.ts:64-76` |
| **Runtime** ingest writes are non-clobbering: both webhooks use `upsert(..., { ignoreDuplicates: true })` (a `DO NOTHING`), and `import_whatsapp_messages` uses an explicit two-column `do update set social_account_id, conversation_id` | `whatsapp-webhook/index.ts:427-448`, `whatsapp-evolution-webhook/index.ts:105-108`, migration `20260821140000:103-110` |
| **A migration has deleted `whatsapp_messages` rows**: the dedupe sweep that preceded the unique index. No *runtime* path deletes rows, but the absolute claim is false and a future dedupe would cascade | `20260710100000:5-17` |
| `message_id` is **nullable**, and the scheduled sender persists a synthetic `sched_<id>` when the provider returns none | `whatsapp-scheduled-sender/index.ts:116-128` |
| `remoteJid` is never stored; it is derived into `conversation_id` as `wa_{platform_user_id}_{remoteNumber}`. Group (`@g.us`), `@lid` and `status@broadcast` JIDs are filtered out at ingest, so every stored conversation is an individual chat | `_shared/evolutionMessage.ts:40-46,110-121` |
| For QR rows, `message_id` holds the **Baileys `key.id`**, which is not a Meta Cloud `wamid` | `_shared/evolutionMessage.ts:129-156` |
| `whatsapp_messages` RLS is SELECT + INSERT only, both `auth.uid() = user_id`. There is no UPDATE, no DELETE, and no workspace-aware policy — so a workspace agent cannot read messages from the browser at all; only the service-role edge function can | `20260413174023:27-33`, `20260413174047`, confirmed live |
| No `deleted_at` / `is_deleted` / `pinned` column exists on any messaging table | grep over all 227 migrations |
| The installed PostgREST client appends duplicate `or` parameters, so **two top-level `.or()` calls on one query silently produce the wrong SQL** | `@supabase/postgrest-js` `PostgrestFilterBuilder.ts:2039-2048` |
| CI installs with `bun install --frozen-lockfile` | `.github/workflows/test.yml:26,69` |
| The deploy runbook requires `docker compose restart functions`, and states explicitly that `up -d` does nothing when the compose config is unchanged — the deploy looks successful and is not | `docs/runbooks/deploy-edge-function.md:92-101` |

### 2.3 Production stack (verified live)

| Fact | How verified |
|---|---|
| Storage bucket `media` is **private** (`public = false`) | `select ... from storage.buckets` |
| Storage INSERT policy requires `auth.uid()::text = (storage.foldername(name))[1]` | `pg_policies` on `storage.objects` |
| Every **active** WhatsApp account is `connection_mode = 'evolution_qr'` | `select ... from social_accounts` |
| Evolution API **2.3.7** is running (`postora-evolutionapi-zenkpi`) | container `package.json` |
| Evolution exposes `sendWhatsAppAudio`, `deleteMessageForEveryone`, `getBase64FromMediaMessage`, `markMessageAsRead` | grep over `/evolution/dist/main.js` |
| **The container ships `ffmpeg 8.1.2`** plus `fluent-ffmpeg` and the literal `audio/ogg; codecs=opus`; it transcodes server-side under `encoding: true` and sends `ptt: true`. `sendWhatsAppAudio` accepts a URL **or** base64 | container probe |
| Both `sendWhatsAppAudio` and `deleteMessageForEveryone` throw *"Method not available on WhatsApp Business API"* for non-Baileys channels — the capability limits are vendor-enforced, not assumed | container probe |
| **527 `evolution_qr` media rows have zero URLs**; the 96 rows that do carry a URL are all `coexistence` | live SQL by connection mode |
| 3,599 messages / 622 conversations; **largest thread is 707 messages** | aggregate |
| Rows without a URL carry only `{"mime_type": ...}` in `media_metadata` | sample of newest rows |
| The URLs that do exist are `lookaside.fbsbx.com/whatsapp_business/attachments/?mid=...` — token-gated and expiring | sample of newest rows |

---

## 3. Root causes

Each user-reported defect, with its proven cause. No item is a speculative
patch.

### R1 — "The sound recording feature is not working"

Two independent causes.

1. **There is no recorder.** `ConversationDetail.tsx:334-336` calls
   `handleFileSelect("audio/*")`, which opens the OS file dialog. No
   `MediaRecorder` or `getUserMedia` call exists anywhere in `src/`. Nothing
   regressed — the feature was never built.
2. **Even the file-attachment path cannot work.** `:110` uploads to
   `whatsapp-media/${buildPostoraFileName(...)}`. The storage INSERT policy
   requires the first path segment to equal `auth.uid()`, so the upload is
   rejected by RLS. If it were not, `:114` calls `getPublicUrl` on a private
   bucket, producing a URL WhatsApp and Evolution cannot fetch.

Consequence: **all outbound media in the chat box is broken today**, not only
audio.

### R2 — "Show only the latest messages, don't animate to the bottom"

1. `whatsapp_get_messages` caps at `limit(100)` with no cursor, so the
   707-message thread has 607 unreachable messages.
2. `ConversationDetail.tsx:60-62` runs `scrollIntoView({behavior: "smooth"})`
   in an effect keyed on `messages` — the raw TanStack Query array. The
   15-second `refetchInterval` produces a new array identity every poll, so the
   pane smooth-scrolls to the bottom repeatedly, including while the user is
   reading older messages.

### R3 — "Make the chat box read images"

`messaging-api/index.ts:1297` maps every WhatsApp row to
`attachments: m.media_url ? [{ file_url: m.media_url }] : []`, never setting
`image_data` or `video_data`, so `MediaRenderer` always falls through to the
generic download-link branch.

**Fixing that mapping alone renders exactly zero additional images**, because it
is the third of three causes and the least important:

1. `_shared/evolutionMessage.ts:162` hardcodes `media_url: null` in every row it
   builds. Both Evolution ingest paths — the live webhook upsert and the
   `whatsappSyncEngine` history sweep — go through `buildEvolutionMessageRow`.
   The result, by connection mode:

   | mode | media rows | rows with a URL |
   |---|---|---|
   | `evolution_qr` | 527 | **0** |
   | `coexistence` | 96 | 96 |

   Every active account is `evolution_qr`.
2. The 96 rows that *do* carry a URL hold a `lookaside.fbsbx.com` Graph URL
   requiring an `Authorization: Bearer` header and expiring. A browser
   `<img src>` gets 401/403. Even the "working" rows do not render.
3. Only then does the mapping collapse everything to `file_url`.

Inline media therefore requires a **media materialization layer**. The
repository already owns the hard part: `inboundMediaFetchers.ts` provides a
tested, SSRF-hardened `EvolutionFetcher`, a `CloudGraphFetcher` that resolves a
media id with the bearer token, a `DirectUrlFetcher`, and `selectFetcher`. This
work reuses that set rather than writing a fourth fetcher.

### R4 — "Delete any message"

Three separate defects.

1. `delete_message` only calls Meta Graph and explicitly throws
   *"This action is not supported in Direct QR mode"* — which is every active
   account. The button can never succeed.
2. It passes `message.id`, the **local row UUID**, to a Graph URL that expects a
   platform message id.
3. There is no local delete of any kind, and `whatsapp_messages` has no UPDATE
   or DELETE RLS policy, so "delete for me" cannot be implemented client-side
   without a migration.

### R5 — Layout

`h-screen` shell → `overflow-y-auto` main → `min-h-[640px]` page → `h-[600px]`
chat produces a fixed-height chat box inside a scrolling page inside a
viewport-height shell: nested scrollbars and dead space on tall screens.

### R6 — Collapsed nav rail

`WhatsAppNavList.tsx:43` keeps `h-4 w-4` icons in both states, so the 68px rail
shows a 16px glyph in 68px of space.

---

## 4. Platform capability matrix

Capability is not uniform across connection modes. The UI must degrade, not
fail.

| Capability | `evolution_qr` (all active accounts) | `cloud_api` / `coexistence` | Degradation |
|---|---|---|---|
| Send text | yes — `sendText` | yes — Graph | — |
| Send media | yes — `sendMedia` | yes — Graph | — |
| Send **voice note (PTT)** | yes — `sendWhatsAppAudio` with `encoding: true`; the container's ffmpeg transcodes to Ogg/Opus and sends `ptt: true` | **no — not implemented** | Mic **hidden**. Attach ▸ Audio file remains and is labelled as a normal file attachment, not a voice note |
| **Delete for everyone** | yes — `deleteMessageForEveryone`, outbound messages with a real provider id only | no — vendor throws, and Meta has no revoke API | Menu item **disabled with a tooltip stating the reason**, never hidden |
| **Delete for me** | yes — Postora-local | yes — Postora-local | always available |
| **Pin / Copy** | yes — Postora-local | yes — Postora-local | always available |
| Recover missing media bytes | yes — `EvolutionFetcher` | yes — `CloudGraphFetcher` with the bearer token | on permanent failure the bubble shows a "media unavailable" placeholder |

Rules:

- **"Delete for everyone" is always disabled-with-a-reason, never hidden** — for
  unsupported modes, for inbound messages, and for rows whose `message_id` is
  null or synthetic. A missing menu item reads as a bug; a disabled one with a
  stated reason reads as a limitation. The **one** exception is an
  already-revoked message, which exposes no actions at all because there is
  nothing left to act on.
- **The mic is hidden** where voice notes are impossible, because there is no
  degraded version of it worth showing.
- **Cloud API voice notes are explicitly out of scope.** Meta's contract needs a
  media upload plus `audio.voice: true`, not merely an Ogg link; the existing
  Graph shape at `whatsappTransport.ts:64-73` has no PTT marker, and nothing in
  this work verifies Meta's behaviour. Sending an ordinary audio message and
  calling it a voice note would be dishonest, so `CloudApiTransport` gets **no**
  `sendVoiceNote` at all — not even a throwing stub.
- Never silently send a WebM where a voice note was intended. WhatsApp renders
  it as a paperclip attachment, which looks like success and is not.
- Pin and "delete for me" are Postora-local in every mode, are never sent to
  WhatsApp, and are never presented as if they were.

---

## 5. Requirements

### 5.1 Layout and chrome (L)

- The screen occupies the full viewport height. No `h-[600px]`, no
  `min-h-[640px]`, no nested page scrollbar.
- The conversation list runs the full height of the content area.
- The green shell header condenses when the message pane is scrolled away from
  the top, and restores when it returns near the top. Restoration is
  position-based, not direction-based — the threshold pair is stated in the plan
  so the requirement and the test agree.
- The Setup-guide and connection cards collapse into a one-line status chip
  showing account name, mode badge and connection state, expanding on click,
  persisted in `localStorage`. At zero connected accounts the panel is expanded
  and not collapsible, so onboarding is never hidden.
- Facebook and Instagram inboxes keep the existing `h-[600px]` block unchanged.
- **Mobile:** below `lg`, the fixed `w-80` rail and the chat pane do not fit
  side by side. The screen becomes single-pane — list, then thread with a back
  affordance. Long-press and `100dvh` behaviour are meaningless without this.

### 5.2 Voice notes (V)

- Press-and-hold or click-to-toggle recording, with elapsed timer, a live level
  meter, slide/click to cancel, and a preview with playback before sending.
- Recording stops automatically at the duration cap and refuses to send past the
  byte cap; both are enforced, not merely declared.
- Microphone permission denial produces an explanatory message, not a silent
  no-op. Every exit path releases the microphone track.
- **Only offered on `evolution_qr`** (see §4).
- The storage defect (R1.2) is fixed for **all** attachment types: uploads land
  under an `auth.uid()`-prefixed path, and the URL handed to the provider is
  minted server-side.
- **Codec — resolved.** Browsers produce `audio/webm;codecs=opus` (Chromium) or
  `audio/ogg;codecs=opus` (Firefox). The Evolution container transcodes
  server-side under `encoding: true`, so the client records whatever the browser
  offers and no transcoder — WASM or otherwise — is introduced.

### 5.3 Message loading (P)

- Selecting a conversation renders the newest page immediately, already
  positioned at the bottom, with **no visible scroll animation**.
- Scrolling to the top loads the previous page and preserves the reading
  position.
- **Newly arriving messages must keep appearing no matter how far back the user
  has scrolled**, and **no message already shown may disappear**. Both are hard
  requirements. A bounded page cache evicts the newest page and silently stops
  delivering new messages; a moving newest-N window drops older rows out of its
  own response, deleting them from the thread unless they are retained. The
  rendered thread is therefore an accumulating set, not a snapshot.
- **Fields that mutate on already-loaded messages must become visible without
  reopening the conversation.** At least three writers mutate old rows —
  delivery status, asynchronous AI media understanding, and revocation by any
  workspace member — and the existing realtime invalidation is owner-filtered,
  so a teammate never receives it. "Visible to every member" must not mean
  "visible after you close and reopen the chat".
- The poll no longer forces the viewport to the bottom. Auto-scroll happens only
  when the user is already near the bottom; otherwise a "N new messages" jump
  button appears.
- Opening a conversation marks it read, skipped for `viewer` role rather than
  403-ing on every open.
- **Backward compatibility is absolute.** A request with no pagination fields
  returns 100 rows in exactly today's shape. The reduced default page size
  applies only to explicitly paginated requests. The backend deploys before the
  frontend merges, and during that window the deployed old client must be
  unaffected.

### 5.4 Collapsed navigation rail (N)

- Larger, optically centred icons in the 68px rail, with an active-state
  treatment that reads clearly at rail width.
- The existing tooltip and `sr-only` label accessibility is preserved exactly.

### 5.5 Per-message actions (A)

- Right-click (desktop) and long-press (touch) open a context menu; a hover
  kebab offers the same actions.
- Long-press must not fire on a scroll gesture: pointer movement, `pointerup`,
  `pointercancel` and unmount all cancel the timer.
- Actions: **Copy**, **Pin / Unpin**, **Delete → for me / for everyone**.
- Pinned messages surface in a per-conversation pinned bar. Clicking one scrolls
  to it when it is loaded; when it is not, the bar shows the pinned message's
  content in place rather than pretending to scroll to something absent.
- "Delete for me" hides the message for the acting viewer only. "Delete for
  everyone" is platform-global and visible to every workspace member.
- A revoked message renders WhatsApp's tombstone and exposes no actions.
- The existing hover trash icon does not carry over — it passed the local row
  UUID into a Graph `DELETE` and hard-failed for every QR account.
  `MessageBubble.tsx` and `delete_message` stay untouched for Facebook and
  Instagram, where that path works.
- **Known gap, not addressed here:** a customer revoking their own message
  arrives as a Baileys `protocolMessage`, filtered out at
  `evolutionMessage.ts:40-47`, so it stays visible in Postora.

### 5.6 Inline media (M)

- Images render as thumbnails and open in a lightbox.
- Videos render with native controls and `preload="metadata"`. A poster frame is
  used **only where one can be derived without decoding the video client-side**;
  otherwise the native first-frame behaviour stands. This is deliberately not a
  promise to generate thumbnails.
- Voice notes and audio render in a player showing a duration and a progress
  scrubber. Duration comes from `media_metadata.duration_seconds` where the
  sender recorded it and from the loaded audio element otherwise; where neither
  is available the player shows elapsed time only.
- Documents show a filename and size where the source provides them. Neither is
  guaranteed: `FetchedMedia` carries only bytes and a mime type, so filename and
  size must be sourced from `media_metadata` or the stored object, and the UI
  degrades to a generic label when absent.
- Where the AI has already produced `media_understanding`, it is available as an
  expandable caption under the bubble.
- Media bytes that were never persisted are recovered on demand and cached.
  Recovery is lazy, never a bulk backfill. **A row that has no stored URL and no
  recoverable bytes renders an "unavailable" placeholder — not a download link,
  because for those 527 rows there is no download target.**

### 5.7 Export (E)

- Multi-select in the conversation list, with select-all over the current
  filter.
- **One chat** → CSV or Markdown → single file. **Several chats** → ZIP of one
  `.md` per chat plus a manifest.
- An "include media files" checkbox, **off by default**; when on the ZIP gains a
  `media/` folder and the Markdown references relative paths.
- Export pulls history through the paginated endpoint rather than the pages held
  in memory, with **visible per-chat progress** and a cancel that aborts
  in-flight work.
- A safety ceiling on pages is permitted. When it truncates, the export is
  **visibly partial**: the README and the affected transcript say so. "Full
  history" means "not limited to what is on screen", not "unbounded".
- CSV uses the existing `papaparse`. ZIP uses `fflate` — one new dependency,
  reflected in `bun.lock` (CI runs `--frozen-lockfile`) and `package-lock.json`.
- The export flow owns a small download helper. **Migrating the repo's other
  `createObjectURL` call sites is explicitly out of scope** — the export dialog
  is itself a production caller, so Zero Dead Modules is satisfied without a
  repo-wide sweep that this task did not ask for.

---

## 6. Data model changes

Two kinds of state, two homes.

**Revocation is platform state and belongs on the message row.** Once revoked on
WhatsApp it is gone for everyone, so it is not per-viewer. Storing it on the row
is safe against runtime ingest: both webhooks conflict to `DO NOTHING` and the
history import updates an explicit two-column list.

```sql
alter table public.whatsapp_messages
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id) on delete set null;
```

No new RLS policy is added to `whatsapp_messages`. Revocation is privileged and
goes through the edge function, which already performs the workspace-role check.

**Pin and "delete for me" are per-viewer state and belong in a side table.**
A column would be wrong because `whatsapp_messages.user_id` is the **account
owner**, not the viewer, so one agent's pin would apply to every workspace
member. `localStorage` is rejected too: a delete whose effect vanishes in
another browser is worse than none.

```sql
create table public.whatsapp_message_flags (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  message_row_id  uuid not null references public.whatsapp_messages(id) on delete cascade,
  pinned_at       timestamptz,
  hidden_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, message_row_id)
);
```

- RLS: four policies, all `auth.uid() = user_id`.
- `unique (user_id, message_row_id)` already provides the lookup index; **no
  second identical index is created**. One partial index on
  `(user_id, pinned_at) where pinned_at is not null` is added for the pinned bar.
- The table deliberately does **not** denormalize `social_account_id` or
  `conversation_id`: `import_whatsapp_messages` rewrites both in place on a QR
  re-pair, so a copy would silently go stale and pins would point at a dead
  account.
- **Reads and writes go through workspace-authorized edge actions, not a browser
  join.** `whatsapp_messages` RLS is owner-only, so a workspace agent cannot join
  through it in the browser to scope flags by conversation, and cannot discover
  pins outside the loaded pages. The flags API is scoped by account and
  conversation after `withWhatsAppActionAccess`.
- `on delete cascade` is correct for the runtime, where nothing deletes message
  rows — but a dedupe migration has done so before (`20260710100000:5-17`), so
  any future dedupe must be written knowing it will take pins with it.

**A keyset index** is required; none of the four existing indexes serves this
query's filter:

```sql
create index concurrently if not exists idx_whatsapp_messages_account_conv_keyset
  on public.whatsapp_messages (social_account_id, conversation_id, "timestamp" desc, id desc);
```

This must be its own migration file with no surrounding transaction.

Media caching reuses the existing private `media` bucket; no new bucket.

---

## 7. Edge-function contracts

All under the existing `messaging-api` adapter. Per ARCHITECTURE.md §12-17 the
entrypoint validates, authorizes, delegates and maps — the orchestration for
media, revoke, voice and pagination lives in `_shared` modules, not inline in a
1,609-line file.

| Action | Request | Response | Notes |
|---|---|---|---|
| `whatsapp_get_messages` *(extended)* | optional `limit` and `before: { timestamp, id }` | on a legacy call: **the same top-level envelope, ordering and cardinality (100 rows), with no `page_info`** — message objects gain additive fields, which the deployed client ignores and the new latest cache requires. On a paginated call: adds `page_info: { next_before, has_more }`. Every message gains `provider_message_id`, `direction`, `revoked_at`, `revoked_by`, `media_understanding`, and typed `attachments` | **Backward compatibility is load-bearing** — the deployed old client must keep getting 100 rows during the deploy window. The reduced default applies only when the caller paginates explicitly. **The existing `.or()` on `conversation_id` must first become `.in(...)`**: the client appends duplicate `or` params, so two top-level `.or()` calls produce wrong SQL |
| `whatsapp_get_media` | `social_account_id`, `message_row_ids[]` | `{ media: [{ message_row_id, kind, url, expires_in, mime_type, file_name, size_bytes }] }`, or `{ url: null, error: "MEDIA_UNAVAILABLE" }` per row | Signs a cached object, or materializes via `selectFetcher`, uploads with the service role, then signs. Bounded by an **aggregate** decoded-byte budget and a wall-clock deadline, not only a per-item cap. Provider errors are logged, never returned |
| `whatsapp_send_media` *(extended)* | adds `media_path` | unchanged | Validates the path prefix against the caller's own uid, mints the signed URL server-side, and persists the durable storage path |
| `whatsapp_get_conversation_state` | `social_account_id`, `conversation_id`, `message_row_ids[]` | `{ flags, pinned, mutable }` | Workspace-authorized. Carries the acting viewer's flags, enough of each pinned message to render the bar without loading its page, **and the mutable-field overlay** (`revoked_at`, `revoked_by`, `status`, `media_understanding`) for the supplied rows. Polled alongside the newest page |
| `whatsapp_set_message_flag` | `social_account_id`, `conversation_id`, `message_row_id`, `pinned` and/or `hidden` | `{ flag }` | Upsert scoped to the acting viewer; `user_id` comes from the session, never the body |
| `whatsapp_revoke_message` | `social_account_id`, `message_row_id` | `{ success, revoked_at }` or `{ error_type: "UNSUPPORTED_CAPABILITY" }` | Requires `evolution_qr`, `direction = "outbound"`, and a **real** provider id — a null or `sched_`-prefixed `message_id` is refused rather than sent to Evolution. **No local revoke-window check**: the window is not verifiable here, so a provider refusal surfaces as a typed error instead of a guessed gate. Reconciliation is concrete: an already-revoked row short-circuits, and an "already revoked"/"not found" provider response is treated as success and stamped, which repairs the provider-succeeded-but-local-write-failed case |
| `whatsapp_send_voice` | `social_account_id`, `recipient_phone`, `media_path`, `duration_seconds`, `mime_type` | `{ success, message_id }` | Evolution `sendWhatsAppAudio` with `encoding: true`. Not registered for non-Evolution modes |

Notes:

- Server-side signing is mandatory: `whatsapp_messages` RLS is owner-scoped, so a
  workspace agent's `auth.uid()` will not match the object's owner prefix and a
  client-minted signed URL is impossible for them.
- `media_url` now holds **either** an `http(s)://` provider URL (legacy and
  coexistence) **or** a bucket-relative storage path. `whatsapp_get_media`
  branches on the `http` prefix. No migration is needed.
- The response field is `provider_message_id`, not `wamid`: for QR rows it holds
  a Baileys `key.id`, which is not a Meta Cloud wamid.
- New actions register in `whatsappAccess.ts` with a minimum role: `viewer` for
  `whatsapp_get_media`, `whatsapp_list_message_flags` and
  `whatsapp_set_message_flag` (a viewer's own UI state); `agent` for
  `whatsapp_revoke_message` and `whatsapp_send_voice`.
- The legacy `delete_message` action is untouched so Facebook and Instagram keep
  working.

---

## 8. Out of scope

- Facebook Messenger and Instagram DM visual changes.
- Threads.
- **Cloud API / coexistence voice notes** (§4).
- Migrating the repo's other `createObjectURL` call sites (§5.7).
- Message reactions, forwarding, replies/quoting, starring, archiving.
- Bulk backfill of historical media, and eager materialization at ingest — both
  recommended as the immediate follow-up.
- Inbound revoke handling.
- Virtualized rendering. A 707-message worst case with paging does not justify a
  new dependency; revisit past ~2,000.
- Group chats.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| `MessagingInbox` is shared by four callers, one of which (`BrandIntelligence.tsx:367`) passes no platform | The WhatsApp screen is a **fork**. `MessagingInbox.tsx` stays byte-identical, and a test asserting its three `h-[600px]` occurrences survive is the tripwire. |
| A bounded page cache silently stops delivering new messages | Freshness comes from a separate newest-page query, never from a capped infinite-query cache. Covered by a test that loads several history pages, polls, and proves a new message still appears. |
| Backend deploys before the frontend merges | Legacy calls keep their 100-row behaviour, so the deployed old client is unaffected. |
| Evolution's media store no longer holds bytes for old messages | Some of the 527 backlog rows will never materialize. "Unavailable" is a first-class rendered state. Eager materialization at ingest is the real fix for *future* messages. |
| Base64 media round-tripping exhausts the edge isolate | The fetcher retains the JSON string, the decoded binary string and the byte array simultaneously. Bound the **aggregate** decoded bytes per request, keep concurrency low, and abort on the deadline. |
| Revoke succeeds at the provider but the local write fails | The action is idempotent and reconciles on the next call rather than leaving a message that is gone on WhatsApp and present in Postora forever. |
| `message_id` is nullable and can be synthetic | Revoke and media recovery refuse null or `sched_`-prefixed ids instead of calling the provider with them. |
| Storage growth — the `media` bucket has no size limit | Flag a retention job and a `file_size_limit` as follow-ups. |
| `_shared/*` is imported by ~10 other edge functions | All changes are additive. Every deploy enumerates the shared files copied and smoke-tests inbound ingest, not only the new action. |
| `up -d` looks like a successful deploy and is not | The runbook's `docker compose restart functions` is the only accepted command for source changes. |
| `h-screen` on iOS Safari clips the composer | `h-[100dvh]` with an `h-screen` fallback, flagged for the reviewer since it affects all 14 WhatsApp routes. |
| Concurrent ingest during paging | Keyset on `(timestamp, id)` bounds this to a duplicate row, deduped by row id on merge. |
