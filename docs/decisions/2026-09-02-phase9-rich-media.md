# Phase 9 — rich-media messaging: the door, and the substrate

**Date:** 2026-09-02
**Deliverables:** 9.2, 9.3 (9.1 already shipped)
**Status:** implemented; one row still needs owner ratification (below)

---

## What 9.1 already had (and this change does not touch)

`POST /v1/messages` already accepts `type` image / video / audio / document,
referencing a `media_id` — never a URL — from `POST /v1/media`, behind the
full D10 control matrix and the D13 dispatch boundary. That contract is
unchanged here.

---

## 9.2 — the capability matrix, decided at the door

### The problem, with the exact old order

A media send to a QR-mode account used to do all of this, in this order,
before anything refused it:

1. `loadPartnerMedia` — the media row is read
2. `signPartnerMediaUrl` — a **signed storage URL is minted** (a live read
   capability, valid 900s)
3. the `Idempotency-Key` header check, then `claimIdempotency` — **a key is
   consumed**
4. `dispatchPartnerTemplate` — quota reserved, **a dispatch intent recorded**
5. only then does the deep guard in `whatsappPartnerOps.sendMedia` throw
   `unsupported_direct_qr`

A request that was always going to be refused had already produced a URL and
consumed a key. Text and template sends to QR accounts had the same shape
one step later (step 5's `sendText` / `sendTemplate` guards).

### The fix

`_shared/partnerMessagingCapabilities.ts` holds one explicit matrix:
`connection_mode` (`cloud_api` | `coexistence` | `evolution_qr` | null) ×
message `type` (text | template | image | video | audio | document) →
`{supported: true}` or `{supported: false, code, message}`. Every cell is
spelled out; a missing cell is a compile error under `deno check`, and the
exhaustive unit test walks all 24 cells at runtime because CI runs
`--no-check`.

- `cloud_api`, `coexistence`, `null`: all six types supported — this records
  today's behaviour, nothing more. `coexistence` numbers awaiting
  registration can still meet a *typed* `meta_error` on session sends; that
  is not an opaque failure, and the cell must not narrow.
- `evolution_qr`: all six refused with **`unsupported_direct_qr`**, kept
  deliberately (it is about the account's connection — the same vocabulary
  errors.ts pins and the alias has emitted for years). Per-family wording
  preserved from the deep guards.
- An unrecognized mode *string* (impossible under
  `social_accounts_connection_mode_chk`) is refused with
  `unsupported_capability` and logged, never guessed at. An explicit "no" is
  recoverable; an implicit "yes" that dies at Meta is the opaque failure the
  phase's exit criterion forbids.

`messages.ts` now consults the matrix right after the type check and the
per-type scope check. That required **moving `resolveWhatsAppAccount` up**
(suspension → account → matrix), which changes error precedence in one
place: an unhealthy account now answers before body-shape complaints
(missing recipient, malformed media id, missing text body) and before the
`Idempotency-Key` header check. That ordering is deliberate — a permanent
fact about the account beats a per-request typo, the same philosophy as
scope-before-suspension — but it is a behaviour change and is recorded here.

A refused cell returns with `details: {connection_mode, type}` and — the
whole point — **zero side effects**: zero signed URLs, zero idempotency
claims, zero dispatch intents. `messages.capability.test.ts` C1/C1b assert
exactly those zeroes and were run against the pre-change code, where they
failed on precisely those counters.

The three deep guards in `whatsappPartnerOps.ts` STAY, as defence in depth:
the alias (messaging-api door) does not consult the matrix, so a QR-mode
account is still refused there at the provider boundary.

### A test casualty, and why it was re-pinned

`messages.test.ts` T6 ("the TEXT send path writes a dispatch intent") had
pinned an `evolution_qr` account purely as a network-avoidance trick — the
deep guard threw before any fetch. Under the door, text × `evolution_qr` is
a refused cell that never reaches the intent write, so the pin would make
the property unobservable. T6 now uses a sendable account; the provider call
fails against the bogus token exactly as `media.test.ts` R2's always has,
and the assertion on the intent row is unchanged. `messages.capability.test.ts`
C1b covers the vacated scenario (zero claims, zero intents).

The route fixtures in `messages.test.ts` / `media.test.ts` also said
`connection_mode: "cloud"` — a value `social_accounts_connection_mode_chk`
forbids. Harmless while the route only compared against `evolution_qr`;
wrong the moment the matrix read the mode meaningfully. Both now say
`cloud_api`.

---

## 9.3 — the scan-state substrate

D10's "Malware handling" row already named the exact shape for a future
"scan anyway" answer: *"a `scan_state` column on `media_files`, a `pending`
state that `POST /v1/messages` refuses, and a worker."* This builds the
state and the refusal, and no scanner.

- Migration `20260902160000_partner_media_scan_state.sql`: `scan_state text
  NOT NULL DEFAULT 'available'`, CHECK `('pending','available','rejected')`,
  idempotent. The default is `available` **precisely** so existing rows and
  the app's own uploader change NO current behaviour — the refusal exists
  only for rows a scanner has actually marked.
- `partnerMediaStore.ts`: `loadPartnerMedia` returns `scanState`; one shared
  `mediaSendability(stored)` helper decides sendability so every send path —
  this route today, the publishing route when Phase 8 lands — refuses the
  same rows for the same reasons. `pending` → `media_pending` (409,
  retryable: retry the SAME request; a re-upload mints a new pending id);
  `rejected` → `media_rejected` (422, permanent).
- `errors.ts` carries the two codes' status/retryable verdicts;
  `messages.ts` `buildMediaSend` applies the helper **after** the kind check
  and **before** the signed URL is minted — same rule as 9.2: a refused file
  must not produce a URL.

When a scanner exists, nothing else has to change: write `pending` at
upload, run the worker, flip states. The send path already refuses.

---

## Review round (Codex on PR #127)

**Matrix before suspension — fixed.** The template-suspension check ran before the matrix, so a
QR-mode template send answered `temporarily_unavailable`: an invitation to wait for something that
can never work. The matrix now sits between the per-type scope check and the suspension, which is
the same permanent-before-temporary rule the type check already follows (C1d).

**Scan state at the publish — fixed.** The creation-time check in `POST /v1/posts` could be
outrun by a row flipping to `rejected` afterwards; `process-post` now applies `mediaSendability`
to every loaded media row before any URL is generated, failing the post with the same 422 shape
the missing-media path uses. Verified by inspection and typecheck — `process-post` has no test
harness (7,200 lines, 60 pre-existing typecheck errors on `main`), which is itself the Core 1
refactor's problem.

**Capability refusals and the usage ledger — declined, with a follow-up.** Accurate, but broader
than this branch: `recordUsage` is called only by the alias, and *no* `/v1` route or the
`withPartnerAuth` wrapper records anything — success or refusal, on any route. Recording one
refusal type here would make it the only visible `/v1` event, which is worse telemetry than none.
The right fix is centralised in the wrapper and belongs with `GET /v1/usage` (plan 2.7) and the
split counters (10.1), where the counter schema is decided.

## Owner ratification still required

D10's open row is still open, and this substrate does not answer it — it
only makes answering it additive. The question for the owner, restated:

> There is no malware scanner anywhere in Postora. D10 constrained the
> surface instead (no execution, no browser-facing origin, a nine-type
> byte-confirmed allowlist, recipient-side scanning, an attributable
> uploader) and collapsed the state machine to one state: `available`.
> Is that acceptable, or do we scan anyway?

If "scan anyway": set the upload default to `pending`, stand up the worker,
and the refusal wired in 9.3 becomes live with no further schema or route
change. Until then, every partner-uploaded file lands `available` and sends,
exactly as before.
