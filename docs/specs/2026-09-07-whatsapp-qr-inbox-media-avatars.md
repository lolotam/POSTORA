# WhatsApp Direct-QR inbox: media, voice notes and avatars — root cause and plan

Date: 2026-09-07. Status: plan (pre-implementation).

## Symptoms (user report, after PR #158 shipped)

1. Inbound images and PDFs do not render in the chat box (no preview, no download).
2. Inbound voice notes cannot be played in the chat box.
3. Sender profile pictures are missing.

## Evidence

Three independent read-only investigations (orchestrator, Codex gpt-6-astra, OpenCode GLM 5.3)
converged on the same facts:

- Deployed edge code equals `main` (SHA256 after CRLF normalisation) for every file on the media
  and avatar paths. Live bundle chunk `Conversations-lX4l2tz1.js` contains the PR #158 UI.
- `POST messaging-api {action: whatsapp_get_media}` with a minted owner JWT resolves 3 rows in
  0.3 s and a full 10-row uncached batch in 1.6 s, all with signed storage URLs. Signed URLs return
  200 with the right `Content-Type` through Cloudflare.
- `storage.objects` under `<uid>/whatsapp/inbound/` contained only objects created by probes.
  Every media row of the day had `media_url IS NULL` before the probes: **the browser never once
  reached the media endpoint**.
- The only messaging-api failures since the functions restart are eight HTTP 500
  `This action is not supported in Direct QR mode` from the user's Chrome at 14:55Z. The actions
  behind them (`whatsapp_send_interactive`, `whatsapp_send_message`) are sent only by the legacy
  `ConversationDetail` / `useSendMessage` path, which is what the **Unified Inboxes** page
  (`/messaging`, sidebar entry) renders for its WhatsApp tab.
- Legacy `MessageBubble.MediaRenderer` understands only Meta-shaped attachments
  (`image_data.url`, `video_data.url`, `file_url`). QR rows arrive as
  `{kind, message_row_id, needs_fetch: true, file_url: null}` → nothing renders, no audio branch,
  `whatsapp_get_media` is never called.
- Avatars: `messaging_cache.participant_avatar` is set on 26 of 1635 QR conversations (0 of 34 for
  the affected account). The webhook only copies an existing value; sync relies on
  `profilePicUrl` from `findChats/findContacts`, which Evolution leaves null; `evolutionApi.ts` has
  no `fetchProfilePictureUrl`. Live check: `POST /chat/fetchProfilePictureUrl/{instance}` returns
  a `pps.whatsapp.net` URL (expiring, `oe=` parameter) for one recent contact and `null` for
  another (privacy setting) → the URL must be cached durably and misses must be remembered.

### What is NOT proven

- Which page the reporting user had open is inferred, not observed. `whatsapp_send_interactive`
  is callable from both the legacy composer and the new one, so the 500s do not name the UI.
  The live `whatsapp_get_messages` response carries the correct attachment contract
  (`kind`, `message_row_id`, `needs_fetch`) and the resolver works, so on the new UI the only
  remaining explanations would be browser-side (visibility gate, or a request that fails before
  reaching Kong and is swallowed into "Media unavailable" with a console-only log).
- Five different account owners all have 100% uncached media, so the failure is not one user's
  habit; either all of them use the legacy tab, or the new UI also fails client-side.
- Self-check that settles it (30 seconds): on `/messaging` click **Open Full WhatsApp Studio**,
  open the same chat. If images/PDF/voice work there, the legacy tab is the cause and Slice A is
  the fix. If not, capture DevTools on that page: Network filter `messaging-api` (is there a
  `whatsapp_get_media` POST? what does it return?), Console for
  `[whatsapp-media] batch resolution failed`, and whether `[data-testid="wa-media-pending"]`
  stays with `aria-busy="true"`.
- Unrelated but observed: one browser issued 258 identical `messaging-api` requests within ten
  minutes (10:40–10:50Z), roughly one every 2.3 s. That is not a 15 s poll. Worth a look later.

## Root causes

| Symptom | Root cause | Layer |
|---|---|---|
| 1, 2 | The user's chat box is the legacy Unified Inboxes WhatsApp tab (`MessagingInbox` → `ConversationDetail` → `MessageBubble`), a second WhatsApp UI that never adopted the QR media contract. PR #158 fixed the other UI (`/messaging/whatsapp/conversations`). | Frontend |
| 3 | No code path fetches a profile picture for Direct-QR accounts. | Edge functions + DB |
| (latent) | The resolver's `unavailable` exits for deadline / budget / unusable id / no fetcher log nothing, which is why this needed DB forensics. | Edge functions |

## Plan

### Slice A — one WhatsApp chat UI (frontend)

Replace `<MessagingInbox platform="whatsapp" />` in `src/pages/messaging/UnifiedInboxesPage.tsx`
with the feature's public entry point `WhatsAppInboxScreen` (from `@/features/whatsapp-inbox`),
inside a container that gives it a bounded height (the screen is `h-full min-h-0`; the standalone
page runs it immersive via `WhatsAppChromeContext`). Keep the `AutomationHandlerCard` and the
"Open Full WhatsApp Studio" link. Remove the now-dead WhatsApp branch from `MessagingInbox`
(`platform` prop narrows to `facebook | instagram`) and the WhatsApp-only sends it carried
(`whatsapp_send_interactive` builder in `ConversationDetail`, `useSendMessage` WhatsApp branch)
only if nothing else calls them — grep before deleting; otherwise leave them.

Debate outcome (Codex, agreed with changes):
- A bare embed throws: `WhatsAppInboxScreen` requires `WhatsAppChromeContext`
  (`src/components/whatsapp/WhatsAppChromeContext.tsx:28`) and `WhatsAppWorkspaceProvider`
  (`src/components/whatsapp/WhatsAppWorkspaceProvider.tsx:60`). Supply both locally in the tab;
  do not nest the whole `WhatsAppLayout`.
- Account selection: the screen defaults to the first account (`WhatsAppInboxScreen.tsx:87`)
  instead of honouring `routeSelection.accountId`, and its route update drops `workspaceId`
  (`whatsappInboxRoute.ts:87`). Fix both while embedding; one live instance per route.
- Gate Cloud-API-only controls on `connection_mode` in the new composer too: the
  `InteractiveMessageBuilder` (`WhatsAppComposer.tsx:284`) still sends
  `whatsapp_send_interactive`, which the backend rejects for QR (the 500s above). Use the
  existing `domain/whatsappCapabilities.ts` pattern.

Tests: `UnifiedInboxesPage` renders `[data-testid="wa-inbox-shell"]` on the WhatsApp tab and
no `ConversationDetail`; `MessagingInbox` no longer accepts `"whatsapp"` (type-level); and the
behavioural test: render the Unified Inboxes WhatsApp tab with a fake inbox API, select a QR
chat containing an unresolved image, PDF and audio row, assert `whatsapp_get_media` is called
with those row ids and that the returned URLs reach the `<img>`, the PDF card and the voice
player.

### Slice B — avatar enrichment (edge + migration)

1. Migration: `alter table messaging_cache add column participant_avatar_checked_at timestamptz;`
   (negative cache; contacts with hidden pictures must not be re-fetched on every message).
2. `_shared/evolutionApi.ts`: add `fetchProfilePictureUrl(instanceName, number): Promise<string | null>`
   (`POST /chat/fetchProfilePictureUrl/{instance}`, body `{ number }`, returns
   `profilePictureUrl`). Unit test with the existing fetcher-injection pattern.
3. `whatsapp-evolution-webhook/index.ts` `touchConversation`: when the cached row has
   `participant_avatar IS NULL` and `participant_avatar_checked_at` is null or older than 7 days,
   fetch the picture, run it through `cacheAvatarToCloudinary(url, user_id, "whatsapp", number)`
   (already used for Meta), store `participant_avatar` and set `participant_avatar_checked_at`.
   Never let the fetch fail the webhook (log and continue). Owner-sent messages must not skip the
   enrichment of the other party.
4. `_shared/whatsappSyncEngine.ts`: after upserting chats, backfill at most 25 conversations per
   run that have a null avatar and a null/stale `checked_at`, same helper. Share the helper in
   `_shared/` (one place, used by webhook and sync).

Debate outcome (Codex, agreed with changes):
- Never await enrichment inside the conversation upsert or before automation runs: Evolution's
  client timeout is 10 s (`evolutionApi.ts:138`) and Cloudinary adds 8 s
  (`avatar-cache.ts:83`) against the 60 s worker ceiling. Run it best-effort after the row is
  persisted, one contact per webhook, with a short deadline; the sync backfill runs with small
  concurrency and a shared deadline.
- `cacheAvatarToCloudinary` returns the ORIGINAL URL when the upload fails
  (`avatar-cache.ts:89`). Persisting that as success would store an expiring
  `pps.whatsapp.net` link and block retries. Only persist a durable (Cloudinary) result; on
  upload failure leave `participant_avatar` null and do not stamp `checked_at`.
- `checked_at` (7 days) is for a confirmed miss (`profilePictureUrl: null`); network/upload
  errors get no stamp so they retry next time.
- Cloudinary identifier must be opaque and scoped (workspace/account/conversation), not the
  bare phone number (collides across accounts of one user; the key is overwritten
  deterministically, `avatar-cache.ts:49`).
- Owner-sent messages return early in the webhook (`whatsapp-evolution-webhook/index.ts:166`);
  enrich the other party before that return. Preserve sync's null-avatar coalescing
  (`supabase/migrations/20260821140000_whatsapp_history_import_functions.sql:33`).

Tests (Deno): helper persists only a durable URL, stamps `checked_at` only on a confirmed miss,
leaves both untouched on fetch/upload error, respects the 7-day negative cache, never throws
into the webhook.

### Slice C — resolver observability (edge)

In `_shared/whatsappMediaResolver.ts`, generalise `logFetchFailure` (`:299`) into one sanitised
logger and call it at every silent `unavailable` exit: deadline (`:206`), unusable provider id
(`:208`), budget not admitted (`:219`), no fetcher / null fetch (`:231`), and the post-upload
signing failure (`:257`). Log the row UUID and an enumerated reason only; no provider ids,
filenames, URLs or exception text. Aggregate repeated reasons per request. No behaviour change.

### Deferred (noted, not in this change)

- Dashboard recent-chat links use `?id=` while `whatsappInboxRoute` expects `chat`
  (`WhatsAppDashboard.tsx:572`) — separate fix.
- Legacy surfaces that still expose Cloud-API-only controls to QR accounts
  (`WhatsAppDiagnostics`, catalog) should be gated on `connection_mode`.

## Verification

- Frontend gates: `bun run typecheck`, `bun run lint`, `bun run test`.
- Edge: `deno check` + `deno test` for the touched `_shared` modules and the webhook.
- After deploy: open `/messaging` → WhatsApp tab → a chat with an image, a PDF and a voice note;
  all three render/play; the conversation list shows avatars for contacts whose picture is public;
  `storage.objects` gains `<uid>/whatsapp/inbound/*` rows created by the browser session;
  `messaging_cache.participant_avatar` fills for the affected account.
- Deploy order: migration (manual, as `supabase_admin`), then edge functions via the runtime
  checkout + `docker compose restart functions`, then merge (frontend auto-deploys).
