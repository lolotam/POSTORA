# MergePilot PR 441 — cross-file findings, disposition

**Review:** `5952899914` on [PR 441](https://github.com/lolotam/POSTORA/pull/441)
**Old head:** `7fc87f8`
**Branch:** `T3-CODE/youtube-resumable-upload-durability`
**Contract:** [2026-11-18-youtube-resumable-upload-continuation-contract.md](../specs/2026-11-18-youtube-resumable-upload-continuation-contract.md) §48–§57

Every finding of the review is listed below, with what was done about it and
where the proof is. **No live system was touched**: every proof is a
synthetic one — a Deno test against a fake store, or a SQL suite against a
disposable Postgres.

The work sits on top of `7be24b45` (the earlier repair round) and does not
repeat it. Where a finding was already covered by that round, the disposition
says so instead of changing the code again.

---

## Runtime findings

### 4610879204 — Thumbnail fetch permits SSRF — `HIGH` — **Fixed**

The follow-up that reads the thumbnail fetched whatever URL it was given: the
URL comes from the customer, so the worker could be pointed at internal
services, and the read buffered the whole body with no bound.

The thumbnail now goes through `fetchApprovedMedia` — the same function the
video source uses: an approved HTTPS media origin only, every redirect hop
validated before it is followed, a bounded body (10 MB) and the worker's own
deadline. `fetchApprovedMedia` is exported from `youtubeVideoSource.ts` for
this.

**Cost to note:** a thumbnail hosted somewhere else is no longer fetched. The
copy that is fetched is the copy Postora stores, which is what the channel
shows anyway. The UI copy may want to say so.

**Proved by:** `youtubeVideoSource.test.ts`, `youtubeUploadFollowUps.test.ts`.
**Contract:** §48.

### 4610879224 — Continuation bypasses the YouTube access-token refresh — `HIGH` — **Fixed**

The continuation used the stored access token without checking expiry, so an
upload resumed after the token's lifetime sent an expired credential.

`youtubeTokenRefresh.ts` now holds the policy in one place — a token that
expires within thirty minutes is refreshed, the refresh has fifteen seconds
of its own, the logs are redacted and the refresh token never reaches a log
line. The publishing path and the continuation's account load both call it.

**The receipt-only path stays provider-independent.** A continuation that
finds a stored receipt never loads the account, so it never refreshes a token
and never touches the provider. That is deliberate: the work that only
projects a receipt has to work when the provider is unreachable.

**Proved by:** `youtubeTokenRefresh.test.ts`, the continuation's tests.
**Contract:** §49.

### 4610879234 — Continuation discards original upload parameters — `HIGH` — **Fixed**

The crash window after the admission and before the provider session is opened
was resumed with a hard-coded `video/mp4` and only `snippet,status`, losing
the parts that `recordingDetails`, `contentDetails` or
`paidProductPlacementDetails` need, and the `notifySubscribers` choice.

The session now stores the upload settings, and the continuation reuses them.
This landed with the earlier round (`7be24b45`, the 13-argument admission and
`upload_settings`); the MIME half of the finding was finished in this round,
see 4610879248.

**Proved by:** `youtubeUploadSession.test.ts`, `youtubeUploadContinuation.test.ts`.
**Contract:** §50 and the earlier round's §42.

### 4610879248 — Continuation forces MP4 content type — `HIGH` — **Fixed**

The type now comes from the media row the session is fenced on, and the
continuation's `runUpload` port carries it. The media version fence is what
makes the media row's answer the right one.

**Proved by:** `youtubeUploadContinuation.test.ts` ("the type of the video
reaches the upload").
**Contract:** §50.

### 4610879257 — Continuation discards upload request query options — `HIGH` — **Fixed**

Same fix as 4610879234: the query options travel with the session
(`upload_settings`), so a resumed upload keeps `notifySubscribers=false` and
the parts the customer's settings asked for. Landed with `7be24b45`.

**Proved by:** `youtubeUploadSession.test.ts`.
**Contract:** the earlier round's §42.

### 4610879276 — Fanout recovery omits its live lease — `HIGH` — **Fixed**

The recovery ran while this worker still held the lease, and the lease token
was never forwarded. The store's contract says the token proves ownership
while a lease is held, so the closure could be refused by the database and the
row would become terminal with the fanout still open.

`recoverFanout` now receives the lease token, and the port accepts it.

**Proved by:** `youtubeUploadContinuation.test.ts` ("the closure is given the
lease token").
**Contract:** §51.

### 4610879286 — Recheck authority after source creation — `HIGH` — **Fixed here, partly with the parent**

The live authority was checked once, before the awaited source setup. Opening
the media reaches the media host and takes seconds, and the customer may
cancel or edit the post, remove the target, or replace the media in between.

**This round:** the live state is asked about **again** once the media is
open, before the first chunk is read and therefore before the first byte is
written. A lost authority ends the attempt without a write, so nothing
reaches the provider.

**Left to the parent, as agreed:** the per-chunk read and the SQL atomic
authority are the parent's work. They are not duplicated here.

**Proved by:** `youtubeUploadContinuation.test.ts` ("the live state is asked
about again once the media is open").
**Contract:** §57.

### 4610879291 — Settlement proceeds after fanout recovery fails — `HIGH` — **Fixed**

A recovery that could not be closed left the pending row — the sweeper's
protection — and the row was the only thing keeping the sweeper from reading
the absence of a sibling row as "this destination never started".

The recovery's answer is now read as a **scope verdict**:

| the recovery says | the scope is | the pending row |
|---|---|---|
| `recovered` | closed | removed |
| `attempt_may_still_be_running` | attempt_running | removed |
| anything else | incomplete | **kept** |

The verdict is derived in the worker from the recovery's stable reason codes,
so the store's database contract does not change. An already closed scope is
distinguished from a scope that could not be closed, which is the difference
the finding is about.

**This is a contract change**, and it is the reason two existing tests were
rewritten: a fanout that cannot be closed, and a fanout that throws, now keep
the row pending instead of settling it.

**Proved by:** `youtubeUploadContinuation.test.ts` (the three verdicts and the
row that stays pending).
**Contract:** §51.

### 4610879367 — Error responses omit stable reason codes — `MEDIUM` — **Fixed**

A refused or failed continuation returned only its human-readable message.
`youtubeContinuationResponse` now carries the stable `reason` in the error
body, so the reconciler and the other callers can tell a lease conflict from
a reconciliation requirement.

**Proved by:** the continuation response tests in `index.test.ts`.
**Contract:** the earlier round's §47.

### 4610879376 — Receipt recovery drops unfinished follow-ups — `MEDIUM` — **Kept on purpose, documented**

A worker that stops after the receipt is checkpointed but before the thumbnail
or the first comment runs leaves both undone, and the recovery that finds the
receipt skips them.

**The at-most-once policy is kept deliberately.** A second comment on the
customer's own video is worse than a missing one: it is public, it cannot be
unread, and the customer asked for one comment. The same is true of the
thumbnail write. The effects are therefore **not** duplicated: the recovery
skips both, as before.

**The tradeoff is now written down** rather than left in the code: the
contract says what is lost and why it is the lesser loss. A customer whose
thumbnail did not make it can set it on the video.

**Proved by:** `youtubeUploadFollowUps.test.ts`.
**Contract:** §45 (the earlier round) and the note added there.

### 4610879448 — Missing sessions map to unknown outcomes — `MEDIUM` — **Fixed**

`refusalToReason` had no case for `session_not_found`, so it fell through to
`youtube_upload_unknown` and told the caller the upload would be checked
again when no session exists. It now maps to `not_found`.

**Proved by:** `youtubeUploadContinuation.test.ts` ("a session that is not
there is refused as not found").
**Contract:** §51.

### 4610879455 — Nullable identity fences fail open — `MEDIUM` — **Fixed**

A session with a null attempt and a session with a null media version passed
the fences that were supposed to compare them, because a comparison that
cannot be made was treated as a comparison that matched.

Each of them now fails closed: the request without an attempt, the session
without an attempt, the session without a media version, the media without a
current version, and the media of another size. The route refuses a dispatch
without an attempt outright (`youtube_attempt_missing`).

**Proved by:** `youtubeUploadContinuation.test.ts` (each fence and the size
mismatch).
**Contract:** §53.

### 4610879465 — Permanent refusals leave uploads pending — `MEDIUM` — **Fixed**

A refusal that will not change on retry left the public row **pending**: the
post waited for a destination that was never going to publish, and the worker
reclaimed it again and again.

A permanent refusal now settles the row as a failure. The settlement carries
the uncertain marker when the session may already hold a video, and the marker
follows the **durable rule** (`video_may_exist`), not the reason of the
refusal — so a refusal on a session whose last chunk may have landed is not
mistaken for a proof.

**Proved by:** `youtubeUploadContinuation.test.ts` (a refused media settles
the row; the uncertain marker travels with it).
**Contract:** §52.

### 4610879476 — Follow-up errors can leak credentials — `MEDIUM` — **Fixed**

The caught follow-up error was logged raw. A rejected thumbnail fetch can
carry its signed URL in the network error, and a provider adapter can carry a
request URL or a token. The diagnostic logs are sanitized: the stable reason
code is logged, and the provider text is not.

**Proved by:** `youtubeUploadFollowUps.test.ts`.
**Contract:** the earlier round's §45.

### 4610879646 — Continuation accepts missing attempt identity — `LOW` — **Fixed**

The continuation route required only the session id and the lease token, and
passed a null attempt onward. The attempt is part of the continuation
identity, so a malformed service-role dispatch was accepted instead of
observably refused.

The route now **requires** `attemptStartedAt` and answers `400` with
`youtube_attempt_missing` when it is absent. The continuation refuses it a
second time (`stale_attempt`), so the fence holds even if the route is
bypassed.

**Proved by:** the continuation route tests and
`youtubeUploadContinuation.test.ts`.
**Contract:** §53.

---

## SQL findings

### 4610879333 — Account deletion erases upload evidence — `HIGH` — **Fixed**

The disconnect is a hard delete of the account row, and the session referenced
it with `ON DELETE CASCADE`: the receipt, the byte checkpoints and the
uncertainty marker went with it. The disconnect was a way to publish a second
video on one channel.

* The link to the account is `ON DELETE SET NULL` and the column is nullable.
* A `BEFORE DELETE` trigger on `social_accounts` settles the public row (with
  the marker when a video may exist), redacts the provider session URI (a
  credential of an account that is gone) and makes the session terminal.
* The session records the **channel** it belonged to, so a later admission can
  tell the same channel from another one — see 4610879333's follow-up below.
* The disconnect itself is never blocked, and the tenant keeps the post, the
  media and the session.

**The design gate that remains, and is deliberate:** the public **result** row
still goes with the account, because its result belongs to the account. That
is the product's behaviour for every platform — `platform_posts.social_account_id`
is `ON DELETE CASCADE` — and changing it for YouTube alone would change the
product for every platform. The row is settled *before* the account goes, so
the parent post is rolled up and does not wait for a destination that is
disappearing. What survives is the session: the part that carries the
evidence.

**Follow-up, and why it was needed:** preserving the evidence is only half of
the repair — the evidence has to be read by something. A reconnect is a
**new account row** (the OAuth upsert cannot reuse a deleted id), so the
session lookup, which is by post and account, would not find the old session
and a retry would open a fresh upload on the same channel. The admission now
refuses that (`YUS16`, `channel_may_have_published`) and the refusal carries
the uncertain marker, so the row is never offered as a retry. **Another
channel of the same customer is a different publication and stays allowed.**

**Proved by:** SQL suites Y42 and Y46.
**Contract:** §54 and §56.

### 4610879567 — Admission checks ownership but not post membership — `MEDIUM` — **Fixed**

The admission accepted any media file the customer owned, even one the post
does not name, so a stale service-side resolution could upload a different
video from the customer's library.

The admission now requires the media file to be one of the post's
`media_file_ids`.

**Compatibility:** the parent's atomic replacement-media retry updates
`posts.media_file_ids` in the same transaction as the retry, so the post names
the replacement file before the admission. The membership check stays
compatible with it.

**Proved by:** SQL suite Y43.
**Contract:** §55.

### 4610879599 — Grant test omits mutating upload functions — `MEDIUM` — **Fixed**

Y1 claimed every upload function is service-role-only while its matrix
omitted the mutators (the single-session claim, release, terminal
classification and fanout recovery), and it checked `anon` only for the
admission.

Y1 now reads the **whole** grant surface from the catalog: every
`%youtube_upload%` function plus `partner_close_ambiguous_destination`,
`request_post_retry`, `claim_post_completion_work` and
`sweep_stale_processing_posts`, and it asserts the denial for `anon` and
`authenticated` and the allowance for `service_role` on each of them.

**Proved by:** SQL suite Y1.

### 4610879625 — Stale-lease tests use the wrong token — `MEDIUM` — **Fixed**

Y4 expired the lease owned by `v_lease_a` and then tried every mutation with
an unrelated token, so it proved token-mismatch handling rather than lease
expiry. An implementation that accepted the original token after its lease
expired would have passed.

Y4 now uses the **expired owner** token.

**Proved by:** SQL suite Y4.

### 4610879638 — Receiptless projection tests a missing session — `MEDIUM` — **Fixed**

Y18 said it verified an existing session without a receipt and passed a
random id, so a projection that validated existence but not the `video_id`
would have passed.

Y18 now uses a **real admitted session** (which raises `YUS05`, the receipt is
required) and keeps the random-id case as a second assertion (`YUS08`, the
session is not there).

**Proved by:** SQL suite Y18.

---

## The seven findings that overlap the earlier SQL brief

These were read in full and are **not** repeated here: the earlier round
already carries the change, or the change belongs to a part of the contract
this work does not own. Each one is named with where it landed, so nothing is
silently dropped.

| id | severity | the finding | where it is answered |
|---|---|---|---|
| 4610879343 | `HIGH` | Released sessions cannot recover settlement | The earlier round: the terminal classification and the reconciler's claim path (spec §32, §33). |
| 4610879537 | `MEDIUM` | Session and parent locks are acquired in opposite orders | The earlier round: one lock order, owned by one helper (spec §33). |
| 4610879548 | `MEDIUM` | Cancellation webhook uses the pre-update result | The earlier round: the cancellation terminalization (spec §35). |
| 4610879580 | `MEDIUM` | Terminal classification bypasses the reconciler limit | The earlier round: the bounded repairs (spec §36, §37). |
| 4610879590 | `MEDIUM` | Terminal classification bypasses the bounded claim limit | The earlier round: the bounded repairs (spec §36, §37). |
| 4610879629 | `MEDIUM` | Inspect function output instead of table columns | The earlier round: the claim payload is built by a function that does not expose the session URI (spec §42, and the `youtube_upload_session_payload` helper). |
| 4610879660 | `LOW` | Continuation claims bypass the configured cap | Already covered by the earlier round: the in-memory store's continuation claim skips a session that is at the cap (`youtubeUploadSession.ts`, the claim loop's `continuationCount >= 24` guard). The finding was written against the older head. |

---

## What was left to the parent, on purpose

The parent's own brief owns these, and this work does not touch them:

* the protocol helper's false writes, the malformed empty ranges and the
  **typed source read errors** — the typed read error is the mechanism the
  parent's atomic authority will use under the re-check this round added;
* the **declared-size fallback** — the parent's optional `declaredSize` port
  input is **not present in this worktree**, so its wiring is deferred. What
  *is* implemented here is the mismatch refusal: the continuation refuses a
  media file whose size is not the size the session was opened for;
* the shared reason documentation and the reconciler's input validation.

Two further items were deliberately **not** implemented, and are reported
instead:

* **The parent's browser and n8n retry path**
  (`src/hooks/history/usePostRetry.ts`, `retryTargets.ts`,
  `n8n-api/postActions.ts`) — out of scope by instruction.
* **The public result row's survival on a disconnect** — the exact design gate
  is described under 4610879333 above: the row is the account's result, and
  the product's behaviour for every platform is that it goes with the account.
  The session, which is the part that carries the evidence, survives.

---

## Proof

| gate | result |
|---|---|
| `scripts/db-harness.sh` (disposable Postgres) | OK — baseline + 197 migrations + 112 suites + 1 isolated suite |
| `deno test` (process-post + reconcile-deferred-publishes) | 436 passed (178 steps), 0 failed, 8 ignored |
| `deno check` | 0 errors |
| `tsc -b --noEmit` | 0 errors |
| eslint (three lanes: current, `HEAD` base, `--no-inline-config`) | 0 added findings |
| `clean-code-guard` (production) / `test-guard` (tests) | applied |
