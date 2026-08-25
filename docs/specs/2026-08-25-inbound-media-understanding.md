# Inbound Media Understanding for the WhatsApp AI Agent — Spec

**Date:** 2026-08-25 · **Status:** Draft for approval · **Version:** 1.0
**Plan:** `docs/specs/2026-08-25-inbound-media-understanding-plan.md`
**Required reading for any implementer:** `ARCHITECTURE.md` — §12 (Edge Function shape),
§13 (prohibitions), §24 (service role), §26 (external HTTP), §27 (background work).

> Every claim about current behaviour below is cited to a file and line, or to a production query
> run on 2026-08-25. Anything else is marked as a proposal.

---

## 1. Problem

When a customer sends a voice note or a photo on WhatsApp, the AI agent is handed a placeholder
string — `[Audio message]`, `[Image]` — instead of the content. It then replies to that string.
From the customer's side the bot ignored them.

---

## 2. Evidence

### 2.1 The defect

`supabase/functions/whatsapp-webhook/index.ts:254`

```ts
} else if (msgType === "audio") {
  messageText = "[Audio message]";
```

`supabase/functions/_shared/evolutionMessage.ts:76`

```ts
if (body.audioMessage) return {
  text: "[Audio message]",
```

That value is what reaches the agent — `whatsapp-webhook/index.ts:512`:

```ts
triggerAiAgentReply(account, conversationId, phoneNumberId, from, messageText)
```

`supabase/functions/ai-agent-reply/index.ts` contains **no** reference to audio or transcription.

### 2.2 Scale — measured, not assumed

`whatsapp_messages where direction='inbound'`, production, 2026-08-25:

| Type | Count | Share |
|---|---:|---:|
| text | 1,283 | 72.6% |
| document | 137 | 7.8% |
| image | 129 | 7.3% |
| templateMessage | 70 | 4.0% |
| **audio** | **62** | **3.5%** |
| media_placeholder | 32 | 1.8% |
| errors | 28 | 1.6% |
| video | 25 | 1.4% |
| **Total** | **1,766** | |

**This corrects the premise this work was proposed on.** The figure quoted was "40%+ of Gulf
WhatsApp users send voice notes", from
`docs/postora future feathers/SOURCE-ai-agent-competitor-notes.md`. Postora's own data says audio
is **3.5%**.

Voice alone does not justify the work. **All non-text inbound does: 385 messages, 21.8%**, every one
of which reaches the agent as a placeholder. Images outnumber audio two to one, and the source notes
describe exactly the high-value image case — tenants sending **KNET transfer receipts and photos of
apartment faults**.

### 2.3 Transport distribution — determines what to build first

`social_accounts where platform='whatsapp'`:

| `connection_mode` | Accounts |
|---|---:|
| **evolution_qr** | **13** |
| coexistence | 3 |
| cloud_api | 1 |

Evolution QR carries 13 of 17 accounts and is the **harder** path (§2.6). Building the easy Cloud
path alone would serve one account.

### 2.4 `transcribe-media` requires a user JWT

`transcribe-media/index.ts:254-266` requires an `Authorization` header and calls
`supabaseAdmin.auth.getUser(token)`. Webhooks run service-role with no user JWT.

### 2.5 The existing downloader sends no auth header

`transcribe-media/index.ts:42`

```ts
async function downloadMedia(mediaUrl: string): Promise<Blob> {
  const res = await fetch(mediaUrl);
```

WhatsApp Cloud media URLs require `Authorization: Bearer <token>`
(`whatsapp-webhook/index.ts:951-963` resolves the URL with exactly that header). A bare fetch gets
401 — the existing transcriber cannot download WhatsApp media at all.

### 2.6 Evolution QR exposes no media URL

`_shared/evolutionMessage.ts:76-81` records only `mime_type` for audio — no URL, no bytes.
`_shared/evolutionApi.ts` has media **send** (`EvolutionMediaInput`, `:17-24`) and **no download**.

### 2.7 No storage column

`whatsapp_messages` has no transcript field. `transcript` / `transcript_language` /
`transcript_duration` exist on **`media_files`** (migration `20260324052743`) — the media library,
a different table and a different flow.

---

## 3. Goals

1. The agent receives the *content* of an inbound voice note or image, not a placeholder.
2. Both transports are covered, with Evolution QR treated as primary.
3. Cost is bounded and opt-in, because this spends money per inbound message.
4. Failure degrades to today's behaviour — never worse.

## 4. Non-goals

| Excluded | Why | Re-entry |
|---|---|---|
| Voice replies (TTS) | Reading is the value; speaking is a separate product decision | Explicit request |
| Documents / PDF | 137 inbound, but text extraction is a different pipeline | After D-phase 2 ships |
| Video | 25 inbound; poor cost-to-value | Demand |
| Backfilling the 385 historical messages | Cloud media URLs have expired; Evolution history may not be retrievable | Never for Cloud; maybe for Evolution |
| Replacing `message_text` | Everything reading it today would change behaviour | Never |

---

## 5. Decisions

### D1 — Scope is "inbound media understanding", not "voice notes"

Audio and image share one pipeline: resolve → download with auth → model → substitute text.
Adding image to an audio implementation is roughly 20% more work for two thirds more coverage
(§2.2). Shipping audio alone would be the worse trade.

### D2 — Extract into `_shared/`; do not call `transcribe-media` over HTTP

New `supabase/functions/_shared/inboundMediaUnderstanding.ts`. Webhooks import it directly.

`ARCHITECTURE.md` §12 makes an Edge Function entrypoint an adapter; adapter-to-adapter HTTP
duplicates authentication, timeout, retry and idempotency semantics on both sides. This is the same
anti-pattern rejected for `PublishPort` in the Partner API spec (D9). Extracting also *removes* the
JWT blocker (§2.4) instead of working around it with a service-role bypass.

`transcribe-media` is refactored to call the shared module, so one implementation serves both the
user-facing media library and the webhook path. Its external behaviour does not change.

### D3 — Providers already configured; no new secrets

| Kind | Provider | Why |
|---|---|---|
| audio | Deepgram `nova-3`, `language=multi` (`transcribe-media/index.ts:73`) | Already the configured choice, already multilingual — decisive for Arabic/English |
| audio fallback | OpenAI Whisper (`:72`) | Existing three-tier ladder |
| image | Gemini vision via `GOOGLE_AI_STUDIO_KEY` | Already used for embeddings; no new provider, no new secret |

Model selection continues to read `app_settings` / `system_settings` as `transcribe-media` does, so
admins keep one place to change it.

### D4 — Default off, per account

`account_metadata.media_understanding` ∈ `off` | `audio` | `audio+image`, defaulting to **`off`**.

This mirrors `comment_automation_handler` (`_shared/automationHandler.ts:20-21`), which defaults to
`off` for the same reason: it spends money and reaches customers, so it is opted into deliberately.

### D5 — The placeholder stays; understanding is additive

`message_text` continues to hold `[Audio message]`. The understood text goes in a new column.
Anything reading `message_text` today is unaffected, so the feature cannot regress the inbox, the
n8n payload, or the auto-reply rules.

### D6 — Understanding runs in background; the agent trigger moves with it

The webhook must return 200 promptly or Meta retries. Understanding involves a download plus a model
call, so it runs via the existing `runInBackground` helper (`_shared/background.ts`), and the agent
trigger moves inside that continuation — the agent must not fire before the text exists.

`ARCHITECTURE.md` §27 permits this for bounded background work and requires persisted state; the
understanding is written to the database before the agent is triggered.

### D7 — Failure degrades, never blocks

`understandInboundMedia` never throws to its caller. On any failure the agent is triggered with the
placeholder — exactly today's behaviour. A media message must never be *dropped* because
understanding failed.

### D8 — Cloud media is downloaded immediately, not staged

Resolved Cloud URLs are short-lived. The continuation downloads at once rather than persisting a URL
for later. If the URL has already expired, D7 applies.

---

## 6. Contract

```
understandInboundMedia({
  kind:      "audio" | "image",
  source:    { transport: "cloud",     url: string, accessToken: string }
           | { transport: "evolution", instance: string, messageId: string },
  mimeType:  string | null,
  admin:     SupabaseClient,
  limits:    { maxBytes: number, maxSeconds: number, timeoutMs: number },
})
  -> { ok: true,  text: string, provider: string, model: string,
       language?: string, durationSec?: number, costUsd?: number }
   | { ok: false, reason: "disabled" | "unsupported_type" | "too_large"
                        | "download_failed" | "provider_failed"
                        | "timeout" | "daily_cap_reached" }
```

Never throws. `ok: false` is a normal outcome the caller handles by keeping the placeholder.

---

## 7. Data model

Additive migration:

```sql
ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_understanding      TEXT,
  ADD COLUMN IF NOT EXISTS media_understanding_meta JSONB;
```

`media_understanding` — the text handed to the agent.
`media_understanding_meta` — provider, model, language, duration, cost, attempted-at. Needed for
cost attribution and for judging transcription quality after the fact.

A dedicated column rather than reusing `media_metadata` because the inbox UI and future search both
want to query it, and because mixing derived output into provider metadata makes both harder to
reason about.

No RLS change: `whatsapp_messages` policies already scope by `user_id`.

---

## 8. Security and cost

1. **Opt-in per account**, default `off` (D4).
2. **Size cap** checked from `Content-Length` before reading the body, and a hard byte ceiling while
   reading — a `Content-Length` header is attacker-influenced and cannot be the only check.
3. **Duration cap** for audio.
4. **Daily per-account cap**, mirroring the agent's existing daily cap
   (`ai-agent-reply/index.ts` `isDailyCapReached`).
5. **Bounded timeout** on every outbound call — `ARCHITECTURE.md` §26.
6. **No blind retry** — a failed understanding is not retried on the webhook path (§D7).
7. **Never log media bytes, media URLs with tokens, or access tokens.** The URL carries
   authorisation material.
8. **Media is fetched only from the transport's own host**; the URL comes from Postora's own
   resolution call, never from webhook-supplied input, so this is not an SSRF surface — but the
   implementation must not accept a caller-supplied URL either.

---

## 9. Testing

| Area | Must prove |
|---|---|
| Module | Each `ok: false` reason is reachable and returns the placeholder path |
| Size cap | A body exceeding the ceiling is rejected *while streaming*, not after buffering |
| Auth | The Cloud downloader sends `Authorization: Bearer`; without it the request 401s |
| Transport parity | Cloud and Evolution produce the same module input shape |
| Degradation | With the provider unavailable, the message still stores and the agent still replies |
| Opt-out | An account with `media_understanding` unset behaves byte-identically to today |
| Daily cap | The cap is enforced under concurrent inbound messages |
| Arabic | A real Arabic voice note transcribes intelligibly — judged by a human, not asserted |

Deno tests over a stubbed fetcher, in the style of `_shared/evolutionMessage.test.ts`.

**Note:** these tests will not run in CI. `vite.config.ts:45` scopes vitest to `src/**`, so every
Deno test under `supabase/functions/**` is excluded — the same finding recorded in the Partner API
spec §3.3.8. Run them locally with `deno test` and treat CI as not covering this work.

---

## 10. Open questions

1. **Which account for the phase-1 test?** Needs a coexistence or `cloud_api` account someone can
   send a real voice note to.
2. **Should the agent signal it is working from a transcript?** For example "I heard you ask
   about…". Recommendation: yes, via the existing persona config — it sets expectations and makes a
   mis-transcription obvious to the customer rather than confusing.
3. **Daily cap default.** Proposal: 100 per account per day.
4. **Image prompt.** A generic "describe this image" is weak for the actual use case. Proposal: a
   task-specific prompt covering receipts/invoices and property faults, configurable per account.
