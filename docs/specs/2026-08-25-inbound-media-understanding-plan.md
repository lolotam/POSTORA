# Inbound Media Understanding — Implementation Plan

**Date:** 2026-08-25 · **Status:** Draft for approval · **Version:** 1.0
**Spec:** `docs/specs/2026-08-25-inbound-media-understanding.md`

> Contracts and rationale live in the spec; this plan references decision IDs (D1–D8) rather than
> restating them. **`ARCHITECTURE.md` is required reading for every phase.**

---

## 1. Ordering principle

By **blast radius, ascending**. Each phase is shippable and leaves the product coherent, and the
default-off flag (D4) means every phase is inert until an account opts in.

The awkward part of this ordering: the **easy** transport (Cloud, 4 accounts) comes before the
**valuable** one (Evolution QR, 13 accounts). That is deliberate — Phase 1 proves the shared module,
the storage, the caps and the degradation path against the transport that already has a resolvable
URL. Phase 2 then adds only the download plumbing that Evolution lacks (spec §2.6), against a module
that is already known to work.

---

## 2. Dependencies

| Deliverable | Requires | Why |
|---|---|---|
| Anything | Migration (1.1) | Nowhere to store the result |
| Cloud wiring (1.3) | Shared module (1.2) | It is the thing being wired |
| Evolution wiring (2.2) | Evolution media download (2.1) | No URL exists today (spec §2.6) |
| Any live test | An opted-in account (D4) | Default `off` means nothing happens otherwise |
| Phase 3 UI | Phase 1 storage | Nothing to display before that |

No phase blocks on an external party. Open question 1 (which test account) blocks only the *live*
verification of Phase 1, not its implementation.

---

## 3. Phases

### Phase 1 — Shared module + Cloud/coexistence path

Proves the design against 4 accounts.

| # | Deliverable | Spec ref |
|---|---|---|
| 1.1 | Additive migration: `media_understanding`, `media_understanding_meta` on `whatsapp_messages` | §7 |
| 1.2 | `_shared/inboundMediaUnderstanding.ts` — the **pure** understanding (bytes → text). No Supabase client, no account, no `connection_mode`. Deno tests hit it directly | D9, §6 |
| 1.2b | `InboundMediaFetcher` port + orchestrator (setting, cap, model resolution, row write, degradation) | D9, D7 |
| 1.3 | `CloudGraphFetcher` — sends `Authorization: Bearer`, enforces the streaming byte ceiling. Serves **both** `cloud_api` and `coexistence`, mirroring `whatsappTransport.ts:106` | §2.5, §8.2, D9 |
| 1.4 | Audio via Deepgram `nova-3` `language=multi`, falling back to Whisper | D3 |
| 1.5 | Image via Gemini vision using `GOOGLE_AI_STUDIO_KEY` | D3 |
| 1.6 | `account_metadata.media_understanding` resolver, default `off`, in the style of `_shared/automationHandler.ts` | D4 |
| 1.7 | Daily per-account cap + size/duration caps + bounded timeout | §8 |
| 1.8 | `whatsapp-webhook` wiring: understanding runs in `runInBackground`, and the agent trigger moves inside that continuation | D6 |
| 1.9 | `transcribe-media` refactored onto the shared module, external behaviour unchanged | D2 |

**Exit criteria**

- A real voice note to an opted-in coexistence account yields a transcript row **and** an agent
  reply that answers the actual question — verified by a human reading both.
- An **Arabic** voice note transcribes intelligibly. Judged, not asserted.
- An account with `media_understanding` unset behaves **byte-identically** to today: same
  `message_text`, same agent input, no provider call made.
- With the provider forced to fail, the message still stores and the agent still replies from the
  placeholder (D7).
- An oversized body is rejected *while streaming*, not after buffering (§8.2).
- `deno test` passes for the new module. **CI will not run it** — spec §9.

**Risks**

- **1.9 touches working user-facing code.** The media-library transcription flow is live. Refactor
  it *after* 1.2–1.8 are proven, and keep its request/response shape identical. If the refactor
  looks like it will change behaviour, drop it — one duplicated implementation is cheaper than a
  regression in a shipped feature.
- **1.8 moves the agent trigger.** The agent currently fires immediately; it will now fire inside a
  continuation. Text messages must be unaffected — they should not enter the media path at all.

---

### Phase 2 — Evolution QR

Where the value is: 13 of 17 accounts.

| # | Deliverable | Spec ref |
|---|---|---|
| 2.1 | Media download added to `_shared/evolutionApi.ts` — new capability, with tests | §2.6 |
| 2.2 | `EvolutionFetcher` implementing the D9 port | D9 |
| 2.3 | `whatsapp-evolution-webhook` wired to the same orchestrator | D2, D9 |

**Note on scope.** Because of D9, this phase adds **a fetcher and nothing else** — the
understanding, the caps, the storage and the degradation path are all already proven in Phase 1.
That is the whole point of the boundary: if Phase 2 finds itself changing
`inboundMediaUnderstanding.ts`, the boundary was drawn wrong and that is a signal to stop.

**Exit criteria**

- Same live test as Phase 1, against an `evolution_qr` account.
- `inboundMediaUnderstanding.ts` is **unchanged** by this phase — verified by diff.
- Both fetchers satisfy the same port, proven by one shared test suite run against both.
- Evolution accounts that have not opted in are unchanged.

**Risk.** Evolution's media retrieval is Baileys-backed and less predictable than Graph. If bytes
cannot be retrieved reliably, D7 means the account degrades to today's behaviour rather than
breaking — but the phase's value would not land, and that should be reported rather than papered
over.

---

### Phase 3 — Surface it

| # | Deliverable |
|---|---|
| 3.1 | Inbox shows the transcript under an audio bubble, the description under an image |
| 3.2 | Per-account toggle in the Automation card, alongside the existing handler controls |
| 3.3 | Admin visibility of usage and cost from `media_understanding_meta` |

**Exit criteria.** An operator can see what the agent heard, and turn the feature on or off without
SQL.

**Why 3.1 matters beyond polish.** It is the only way a human can tell whether a bad agent reply
came from a mis-transcription or from the model. Without it, every complaint is unattributable.

---

## 4. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Per-message provider cost on a webhook path | Unbounded spend | Default `off`, per-account opt-in, daily cap, size/duration caps (D4, §8) |
| Slow provider stalls the webhook | Meta retries; duplicate processing | `runInBackground` + bounded timeout (D6) |
| Cloud media URL expires mid-flight | No transcript | Download immediately (D8); degrade to placeholder (D7) |
| Arabic quality below usable | Feature does not deliver for the actual market | `nova-3 language=multi` is already the configured choice; Phase 1 exit is judged on a real Arabic note, and a failure here should stop the phase |
| Agent acts on a mis-transcription | Wrong answer to a customer | Transcript stored and shown (3.1); open question 2 proposes the agent signal it is working from a transcript |
| `transcribe-media` refactor regresses the media library | A shipped feature breaks | Do it last; drop it rather than risk it (1.9) |
| Tests do not run in CI | Regressions land silently | Known and stated (spec §9). Run `deno test` locally; consider the CI Deno job from the Partner API plan P0.4 as a shared prerequisite |
| Concurrent branch resets | Committed work vanishes from `main` | Observed in this repo 2026-08-25 (commit `92cbe138`). Work on a feature branch; verify `git log` after any sync |

---

## 5. What this plan does not do

Per spec §4: no TTS replies, no document/PDF extraction, no video, no backfill of the 385 historical
media messages, and no change to `message_text`.

---

## 6. Working agreement

1. `ARCHITECTURE.md` named in any delegation brief, with §12, §13, §24, §26, §27 called out.
2. Migration is additive; no column dropped or repurposed.
3. `clean-code-guard` on changed production code, `test-guard` on changed tests before commit.
4. Edge functions deploy via `ssh-contabo-mcp` per `CLAUDE.md` step 7 — **not**
   `npx supabase functions deploy`, which targets Supabase Cloud and fails on this self-hosted stack.
5. Scoped commits: `git commit -- <files>`.
6. No phase claims a capability it has not verified against a real message.

---

## 7. Open questions carried from the spec

| # | Question | Blocks |
|---|---|---|
| 1 | Which account can receive a real test voice note? | Live verification of Phase 1 (not its implementation) |
| 2 | Should the agent signal it is working from a transcript? | 1.8 prompt wiring |
| 3 | Daily cap default (proposal: 100/account/day) | 1.7 |
| 4 | Image prompt — generic description, or task-specific for receipts and property faults? | 1.5 |

Question 4 is the one that most affects perceived quality: "describe this image" is a poor fit for a
KNET receipt. Recommendation is a task-specific prompt, configurable per account.
