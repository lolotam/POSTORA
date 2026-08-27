# Inbound media: Facebook/Instagram wiring + PDF support

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** An image, a voice note, or a PDF sent to any of Postora's four DM surfaces
reaches the AI agent as text it can reason about, instead of a placeholder.

**Architecture:** Two independent defects, one shared pipeline. `runInboundMediaUnderstanding`
already does the work and is already correct; Facebook/Instagram simply never call it, and
every kind gate in the stack refuses `document`. The fix widens the existing seams rather
than adding a parallel path: a new mode value, a `document` arm through the four gates that
block it, a platform-supplied `kindHint` for transports that carry no mime, a `MetaMessagingFetcher`
that bounds where Meta media may be fetched from, and one new caller in
`facebook-instagram-webhook` shaped like the WhatsApp one.

**Tech Stack:** Deno edge functions, Gemini 2.5 Flash (multimodal), Supabase Postgres.

**Spec:** `docs/specs/2026-08-25-inbound-media-understanding.md` (this extends D4/D6/D9).

## Evidence (root cause, proven before any fix)

Live rows from the user's own test messages, 2026-08-27:

| Time (UTC) | Platform | What was sent | `ai_agent_logs.inbound_text` |
|---|---|---|---|
| 16:15:26 | facebook | text | the Arabic greeting, intact |
| 16:15:48 | facebook | image | `[Attachment]` |
| 16:16:39 | facebook | voice clip | `[Attachment]` |
| 16:20:16 | whatsapp | image | `[Image description & OCR - ...]` |
| 16:21:16 | whatsapp | PDF | `[Document] 1448O.pdf` |

`social_inbox_events` shows both Facebook attachments arrived intact with working CDN URLs,
so nothing upstream is losing them.

**Cause 1:** `facebook-instagram-webhook/index.ts:225` collapses every attachment to the
literal `"[Attachment]"`. `runInboundMediaUnderstanding` has exactly two callers, both
WhatsApp. `account_metadata.media_understanding` is therefore inert on FB/IG.

**Cause 2:** four gates decline documents on every platform -
`rejectUnusableMedia` (hard decline), `classifyMime` (no PDF arm), `modeAllows` +
`MEDIA_UNDERSTANDING_MODES` (no mode admits documents), and the `audio || image` kind gate
in both WhatsApp webhooks.

## Global Constraints

- **No bytes are stored.** This path fetches into memory, calls Gemini, and persists only
  extracted text to `whatsapp_messages.media_understanding`. No Supabase bucket, no
  Openinary, no growth in project storage. Nothing in this plan may add an upload.
- **Max 15 MB**, unchanged: 15 MB base64-expands to ~20 MB, Gemini's inline-request ceiling.
- **Documents are Gemini-only.** ElevenLabs and Whisper are transcribers.
- **Understanding never drops a message.** Every failure path keeps the placeholder.
- **Deploy is the runtime-checkout path with `restart`**, never `up -d`
  (`docs/runbooks/deploy-edge-function.md`).
- Threads is out of scope: it has no DM API. Four surfaces, not five.

## File Structure

| File | Responsibility in this change |
|---|---|
| `_shared/inboundMediaUnderstanding.ts` | classify PDFs, document prompt, document deadline, Gemini-only routing |
| `_shared/inboundMediaPipeline.ts` | new mode, kind table, `kindHint`, document label |
| `_shared/inboundMediaFetchers.ts` | `MetaMessagingFetcher`: Meta-only origin bound, container rename |
| `whatsapp-webhook/index.ts` | admit `document` to the kind gate |
| `whatsapp-evolution-webhook/index.ts` | admit `document` to the kind gate |
| `facebook-instagram-webhook/index.ts` | new caller: per-type placeholders + understanding before the agent fires |
| `_shared/*.test.ts` | one test per gate; invert the "documents are not supported" test |

---

### Task 1: Documents pass the understanding module

**Files:** Modify `supabase/functions/_shared/inboundMediaUnderstanding.ts`;
Test `supabase/functions/_shared/inboundMediaUnderstanding.test.ts`

**Interfaces:**
- Produces: `timeoutFor(kind: MediaKind, limits: UnderstandingLimits): number`,
  `UnderstandingLimits.documentTimeoutMs?: number`, `classifyMime` returning `"document"`.

- [ ] **Step 1: Widen the limits type and add the per-kind deadline**

`documentTimeoutMs?: number` on `UnderstandingLimits`, defaulting to `20_000`; `timeoutFor`
returns it for documents and `timeoutMs` otherwise. 10s is tuned for a voice note; a scanned
PDF is a page-by-page read and runs past it.

**Revised from 30s after review.** The ladder budget is twice the per-kind value, so 30s
allows a 60s provider phase; on top of the download that exceeds the 60s edge-worker
ceiling, and the worker is killed without a log line. 20s leaves room for the download plus
two Gemini rungs.

- [ ] **Step 2: Classify PDFs**

`const DOCUMENT_MIME = /^application\/pdf/i;` and a third arm in `classifyMime`. PDF only -
Word and PowerPoint are ZIP containers Gemini does not open, and admitting them would trade
a clear "unsupported" for a confident answer about a document nothing read.

- [ ] **Step 3: Add `DOCUMENT_PROMPT` and route prompts through one function**

Same `{description, text, fields}` JSON contract as `IMAGE_PROMPT`, so one parser serves
both. Replace `imagePrompt()` with `geminiPrompt(kind, promptContext)` and update **both**
call sites (`attemptTier` and `attemptGemini` - the second is easy to miss).

- [ ] **Step 4: Stop declining documents; route them to Gemini**

Delete the `kind === "document"` early return from `rejectUnusableMedia` (it no longer needs
`kind` at all). `tierSupports`: `image || document` maps to Gemini only.

- [ ] **Step 5: Apply the document deadline everywhere in the ladder**

`kindTimeoutMs` local, used by the single-provider `base`, the `ladderDeadline`, and the
per-rung `Math.min`. Missing the ladder means a configured tier list silently keeps the
10s budget.

- [ ] **Step 6: Rename `parseImagePayload` to `parseVisualPayload(raw, kind)`**

`"Text in image:"` reads wrong on a PDF; label by kind.

- [ ] **Step 7: Tests**

Invert the existing "documents are not supported" test. Add: `classifyMime("application/pdf")`
is `"document"`; `classifyMime("application/msword")` is `null`; a document tier list
containing only ElevenLabs is filtered to empty; `timeoutFor("document", DEFAULT_LIMITS)` is
20000 and `timeoutFor("audio", ...)` is 10000.

Run: `deno test supabase/functions/_shared/inboundMediaUnderstanding.test.ts`

---

### Task 2: The pipeline admits documents and platform-declared kinds

**Files:** Modify `supabase/functions/_shared/inboundMediaPipeline.ts`;
Test `supabase/functions/_shared/inboundMediaPipeline.test.ts`

**Interfaces:**
- Consumes: `timeoutFor` from Task 1.
- Produces: mode `"audio+image+document"`, `PipelineInput.kindHint?: MediaKind | null`.

- [ ] **Step 1: Add the mode and replace the condition chain with a table**

New mode value rather than widening `audio+image` - this spends money per document and
reaches customers, so it is opted into deliberately, matching the module's existing stance.
`MODE_KINDS: Record<MediaUnderstandingMode, readonly MediaKind[]>`; `modeAllows` becomes a
lookup.

- [ ] **Step 2: Add `kindHint` and prefer it over the mime**

`const kind = input.kindHint ?? classifyMime(input.mimeType);`

Meta's messaging webhooks send **no mime** - only `type: "audio"` and a CDN URL. Without
this, every Facebook attachment exits at `unsupported_type`.

- [ ] **Step 3: Carry the hint to the fetcher; do NOT reconcile mimes here**

**Revised after review.** An earlier draft put a `reconcileMime` helper in this module. That
is Facebook knowledge in a file whose header promises a new platform costs a fetcher and no
pipeline change. `kindHint` is added to `MediaRef` (a transport fact, like
`connectionMode`) and the container rename lives in `MetaMessagingFetcher` instead.

- [ ] **Step 4: Leave the download on the standard budget**

**Revised from "widen it" after review.** `fetchMediaBytes` keeps `limits.timeoutMs`. 15 MB
from a CDN in 10s is ample, and the widened budget is for the model call, which is the slow
half. Widening both puts the request over the 60s worker ceiling. A test asserts the
timeout the fetcher actually receives, so the split cannot drift silently.

**Revised again after round 2.** Passing 10s was not the same as spending 10s: `timedFetch`
restarted that duration for the initial request, for each of two redirects, and for the body
read, so a two-hop download could take 40s and the real worst case was ~80s, not 50s. Every
step now draws from one shared clock (`remainingTimeFrom`), in `CloudGraphFetcher` as well as
`MetaMessagingFetcher`. Worst case is 10s download + 2x20s ladder = 50s. The test that pins
this measures elapsed time and fails at ~160ms against the per-hop version.

- [ ] **Step 5: Label document text for the agent**

`AGENT_TEXT_LABELS: Record<MediaKind, string>`, document maps to
`"Document summary & extracted text"`. Exhaustive record, so a future kind fails to compile
rather than silently falling back to the image label.

- [ ] **Step 6: Tests**

`modeAllows` truth table across all four modes by three kinds; `kindHint` beats a null mime;
`kindHint` beats a *disagreeing* mime; `video/mp4` plus `kindHint: "audio"` is understood;
`video/mp4` with no hint still returns `unsupported_type`.

Run: `deno test supabase/functions/_shared/inboundMediaPipeline.test.ts`

---

### Task 3: Both WhatsApp webhooks admit documents

**Files:** Modify `supabase/functions/whatsapp-webhook/index.ts`,
`supabase/functions/whatsapp-evolution-webhook/index.ts`

- [ ] **Step 1: Cloud webhook**

`understandableKind` gains `"document"`. The caption check is
`messageText === MEDIA_PLACEHOLDERS[mediaType]`, but a document's text is
`[Document] <filename>` and `MEDIA_PLACEHOLDERS` has no `document` key, so the filename
would be passed to the model as a customer caption. Handle the document case explicitly.

- [ ] **Step 2: Evolution webhook**

Same gate, `(mediaKind === "audio" || mediaKind === "image" || mediaKind === "document")`.
Confirm Evolution actually reports `document` as `media_type` before relying on it.

- [ ] **Step 3: Commit**

---

### Task 4: Facebook and Instagram call the pipeline

**Files:** Modify `supabase/functions/facebook-instagram-webhook/index.ts`

- [ ] **Step 1: Replace the generic placeholder with per-type ones**

`"[Attachment]"` becomes `[Image]` / `[Voice message]` / `[Document]` / `[Video]` from Meta's
`attachments[0].type`, so a failed understanding still tells the agent what it was.

- [ ] **Step 2: Understand before the agent fires**

Mirror the WhatsApp shape: rules run first on the placeholder; if unclaimed, run
understanding inside `runInBackground` and move `triggerAiAgentReply` **inside** that
continuation. Firing the agent before the transcript exists is the whole bug.

Differences from WhatsApp: `messageRowId` is `null` (FB/IG do not write `whatsapp_messages`);
`caption` is `event.message.text || null`; pass `kindHint` from Meta's type;
`mimeType: null` (let the fetcher discover it).

**Revised after review.** Selecting attachment 0 blind is wrong: Messenger allows up to 30
attachments, so a customer who sends a video then a photo puts the readable one second.
Scan for the first attachment with a known kind, and tell **the agent** — not just the log —
how many were not read, as a webhook-authored line outside the fenced customer content.

- [ ] **Step 3: Add `MetaMessagingFetcher` — do NOT use `DirectUrlFetcher`**

**Revised after review.** `DirectUrlFetcher` passes a null host policy, so it will download
from any public HTTPS host. The webhook's HMAC proves *Meta sent the payload*, not that the
payload's URL is Meta's, and the spec promises inbound media is fetched only from the
transport's own hosts.

`MetaMessagingFetcher` attaches no credentials (Meta's URL is already signed) and bounds the
origin to `fbsbx.com` / `fbcdn.net` / `cdninstagram.com`, re-validating each redirect hop.

The suffix list is **not** `CREDENTIALED_HOST_SUFFIXES`: that list names
`lookaside.fbsbx.com`, which `cdn.fbsbx.com` — the host Messenger actually serves voice
clips from — does not suffix-match. Reusing it would refuse every Facebook voice note while
every unit test still passed. A test pins `cdn.fbsbx.com`.

- [ ] **Step 4: Carry the detected language into the reply**

Check whether FB/IG's `triggerAiAgentReply` accepts a language hint like WhatsApp's. If not,
extend it - without it the reply endpoint counts characters, and the English data-marker
wrapping an Arabic transcript wins.

- [ ] **Step 5: Commit**

---

### Task 5: Gates, guards, and enablement

- [ ] **Step 1:** `deno check` every touched function; full `deno test` for `_shared`.
- [ ] **Step 2:** `npm run lint`, `npx tsc --noEmit`, `npm test` (frontend untouched, but the
      baseline must stay green: 949 passed / 0 failed).
- [ ] **Step 3:** `clean-code-guard` on the production diff, `test-guard` on the tests.
- [ ] **Step 4:** Deploy the five changed edge files via the runtime checkout + `restart`;
      verify SHA256 with `tr -d '\r'` (the volume is LF, the working copy CRLF).
- [ ] **Step 5:** Flip `account_metadata.media_understanding` to `audio+image+document` on the
      WhatsApp and FB/IG accounts. **Without this the retest fails identically** - the
      accounts currently read `audio+image`.
- [ ] **Step 6:** Retest live. Stored payloads cannot be replayed: `recordInboxEvent` dedupes
      on `mid` and the CDN URLs expire, so the user must resend. Check
      `ai_agent_logs.inbound_text` shows a transcript/description rather than a placeholder,
      and `media_understanding_usage` counts the attempts.
