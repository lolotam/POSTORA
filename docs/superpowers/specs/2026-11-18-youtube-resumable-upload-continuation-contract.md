# YouTube resumable upload: the changed contract

**Date:** 2026-11-18
**Branch:** `T3-CODE/youtube-resumable-upload-durability`
**Base:** `0d25e934df28db85ba99b4385e2e9792921bf999` (PR #440)

This note says what changed against the contract the previous commit
established, and why. It is written for the reviewer: everything here is a
deliberate difference, not an accident.

Sections 1 to 10 are the contract the first round established. Sections 11
to 20 are the changes the second round made to it, and they change the
lifecycle, not just the wording.

---

## 1. The lease is a number of milliseconds, not an interval

**Was:** `claim_youtube_upload_session(p_session_id, p_lease_token, p_lease interval)`
and `claim_youtube_upload_sessions(p_limit, p_lease interval)`.

**Is:** `p_lease_ms bigint` on both.

**Why:** PostgREST sends the named arguments of a function as JSON, and a JSON
interval has no agreed shape. The adapter was sending `p_lease_ms`, the
functions wanted `p_lease`, so the call was a *missing function* at run time,
not a wrong argument. A number of milliseconds is the same on both sides, and
each function turns it into an interval itself with
`make_interval(secs => p_lease_ms / 1000.0)`.

**Proved by:** `supabase/tests/youtube_upload_sessions.sql` Y11 (a lease of
`180000` ms is a lease of three minutes; `0` and an unbounded lease are
refused) and `youtubeUploadSession.test.ts` (the adapter sends `p_lease_ms`
and never sends `p_lease`).

---

## 2. The session records a post attempt, and a continuation is fenced on it

**Was:** the session knew the owner, the account, the content fence and the
lease. It did not know which attempt of the post it belonged to.

**Is:** `youtube_upload_sessions.attempt_started_at`. The **admission**
records the attempt the post is on (the caller's, or the post's own
`processing_started_at` when the caller does not name one).
`claim_youtube_upload_session` refuses a session whose attempt is not the
post's current one (`YUS11`) and a session whose post is no longer
`processing` (`YUS12`).

**Why:** a post that was edited or retried is published again, and that is a
new attempt. Carrying the older attempt's bytes on would put the wrong video
on the channel.

**Proved by:** SQL suite Y12 and `youtubeUploadContinuation.test.ts` (an older
attempt, a settled post, an account that is not usable, an account the post
does not select, a media file the post does not name, a replaced media file
and a cross-tenant account are all refused).

---

## 3. The continuation claim carries the token, not the session URI

**Was:** `claim_youtube_upload_sessions` returned `session_uri`. The session
URI is the credential: it authorises writes to the upload.

**Is:** the batch claim returns `lease_token`, `attempt_started_at`,
`confirmed_bytes`, `total_bytes`, `video_may_exist`, `state` and
`continuation_count` — and **no** `session_uri`. The worker reads the session
with `claim_youtube_upload_session(session_id, lease_token, lease_ms)`, which
returns the URI to the service role only.

**Why:** the claim is handed to a worker over HTTP. The credential must not
travel in a dispatch body and must not appear in a worker response. The
reconciler now dispatches `{post_id, resume_youtube_upload_session_id,
resume_youtube_upload_lease_token, attempt_started_at}` and nothing else.

**Proved by:** SQL suite Y9 and Y13, and `youtubeUploadSession.test.ts` (the
claim JSON contains no session URI).

---

## 4. The reconciler drives the continuation

**Was:** `claim_youtube_upload_sessions` existed but nothing called it. An
upload that a worker left half written stayed half written until somebody
pressed retry.

**Is:** `claim_post_completion_work` — the reconciler's one bounded claim
surface — has a third step that hands out the upload sessions that are due.
The reconciler dispatches them to `process-post`, which carries them on.

No new cron, no new function, no new workflow dependency: the existing
`reconcile-deferred-publishes` cron already runs every minute.

**The claim is bounded** three ways: the reconciler's `p_limit` (5), the
number of sessions the claim takes, and the number of continuations one
session may have (24, after which it is marked for a human).

**Proved by:** SQL suite Y13.

---

## 5. An inherited session is probed BEFORE any byte is written

**Was:** a session with a URI was written to from the offset the record held.

**Is:** the provider is asked for the status first, and the next block starts
at the offset the *provider* confirmed. The block is built from that offset,
so a partial acknowledgement inside an old chunk is continued from exactly
where the provider stopped, and the block is still a multiple of 256 KiB
unless it is the last one.

**Why:** the provider is the only party that knows how many bytes it holds.
A worker may have died between writing and recording, and the provider may
have accepted part of a chunk. Writing first and asking later would push
bytes the provider has already accepted.

**Proved by:** `youtubeResumableUpload.test.ts` ("an inherited session is
probed before any byte is written", "a partial acknowledgement inside a
chunk is accepted and continued").

---

## 6. A provider that will not talk leaves the session alive

**Was:** any status the protocol could not explain ended the upload as a
manual reconciliation.

**Is:** the answers are split. A timeout, a 5xx and a 429 are *retryable*:
the session stays open, the URI is kept, and the continuation looks again
later with a bounded wait that honours `Retry-After`. An answer the protocol
does not allow — a malformed range, a range that contradicts the last one, a
2xx without a usable video id — is *not* retryable, and stays a manual
reconciliation.

**Why:** a provider that is down must not turn every upload into work for a
human, and must not turn into a loop either. The wait is bounded at both
ends: 60 s to 15 min, and it never grows past the ceiling.

**Proved by:** `youtubeResumableUpload.test.ts` ("a provider that will not
talk leaves the session alive", "a provider that asks for patience is waited
for, not hammered", "a range the provider cannot mean is not a resumable
answer").

---

## 7. The public outcome carries a stable reason code

**Was:** the outcome carried free text (`"The provider did not answer the
write: ..."`).

**Is:** every outcome carries one of the codes in `YOUTUBE_UPLOAD_REASON`. The
message that goes with a code is fixed, and a code that needs a human never
reads like a retry is safe. The provider text is kept on the server side,
redacted, and never reaches the customer.

**Proved by:** `youtubeUploadPolicy.test.ts`.

---

## 8. The media read is bounded and the egress is reviewed

**Was:** `redirect: "follow"` on the media read, and no host check.

**Is:** the media host is checked against the approved list **before the
first request**, every redirect hop is checked again, and a redirect is never
followed blindly. The approved list is built from the running configuration:
the storage host from `SUPABASE_URL`, the CDN origin from the
admin-configured `cdn_storage` setting, and `res.cloudinary.com`.

The stream reader was also wrong in a way that lost bytes: it dropped the
whole block that a seek landed in, so the bytes between the offset and the
end of that block were lost. It now keeps them. And the body is read through
a bounded reader, so a host that announces one size and sends another is
refused instead of making the worker allocate what it did not ask for.

**Scope note:** a media file whose host is not on the approved list cannot be
uploaded. That is deliberate — the alternative is reaching a host nobody
reviewed. The consequence is that a deployment with an unusual media origin
must add that origin to the approved list before its YouTube uploads work.

**Proved by:** `youtubeVideoSource.test.ts` ("the skip is exact across
irregular block boundaries", "a fresh non-zero seek receives exact bytes",
"a host outside the approved list never receives a request", "a redirect to a
host outside the approved list is refused").

---

## 9. The upload writes a pending row before it starts

**Was:** the `platform_posts` row was written after the provider call, as a
success.

**Is:** the native YouTube path writes a `pending` row *before* the upload
starts and settles that same row when the upload finishes.

**Why:** two things depend on it. The sweeper leaves a post alone while it
has a pending row, so a post is never declared "safe to retry" while the
provider may already hold a video. And the continuation needs to know which
row to settle when it carries the upload on.

`partner_settle_platform_post` is given the row's id, so the failure path
settles *that* row rather than inserting a second one for the same account.

**Proved by:** SQL suite Y14 (the sweeper leaves the post alone) and the
`platform_posts` assertions in the existing process-post suites.

---

## 10. The retry guard also refuses an OPEN upload

**Was:** a session in `reconcile` was excluded from a retry.

**Is:** a session in `open` is excluded as well. A blind retry while an upload
is open would write the same bytes into a second session.

---

# The second round

The nine findings of the second review are addressed below. Each one changes
the contract, and each one is proved by a test that runs.

---

## 11. The session and the public row are admitted together, atomically

**Was:** `begin_youtube_upload_session` created the private session, and the
publishing path inserted the public pending row itself, in a second
statement. Between them there was a window in which one existed without the
other.

**Is:** `admit_youtube_upload(post, account, user, media, size, total_bytes,
upload_body, attempt_started_at, target_account_ids, session_expires_at)`
creates **the private session and the public pending `platform_posts` row in
one transaction**, before any provider work. It returns the session and the
row id. There is no separate insert any more: the publishing path no longer
writes a pending row of its own.

**The two crash windows, stated plainly:**

| When the worker dies | What is durable | What happens next |
|---|---|---|
| **Before the admission** | Nothing. No session, no row, no byte ever reached the provider. | The post is still `processing` with no pending row, so the sweeper's "safe to retry" is correct: a retry starts a fresh upload and no video can exist. |
| **Immediately after the admission** | Both rows, and no byte has reached the provider. | The sweeper skips the post (it has a pending row and an open session). The continuation claims the session and starts the upload — it may have no provider session yet, which is an eligible window. |

**Why it matters:** the exclusion-only cleanup of the first round could only
ever say "do not touch this". A recovery path has to be able to say "this is
what happens next", for every window after the admission.

**Proved by:** SQL suite Y3 (the session and the row are created together,
one per post and account) and the `admit` assertions in
`youtubeUploadSession.test.ts`.

---

## 12. Every window after the admission has a finite, eligible recovery path

**Was:** the batch claim only handed out sessions that were `open` with a
provider session URI. A session that was admitted and never opened one, or
one that held a receipt whose row was still pending, was invisible.

**Is:** `claim_youtube_upload_sessions` hands out every window that can still
be finished:

| Window | Handed out? | What the worker does |
|---|---|---|
| Admitted, no provider session, no bytes written | **Yes** | Opens a provider session and starts the upload. |
| Admitted, provider session, bytes in flight | **Yes** | Probes the provider and continues from the confirmed offset. |
| Receipt stored, public row still pending | **Yes** | Projects the receipt onto the row. No media is read and the provider is not contacted. |
| Expired, no byte ever written | Reopened by the admission | A fresh session is safe. |
| Expired, bytes may have been written | Marked `reconcile` | A human looks. A new session could create a second video. |
| Over the continuation cap | Marked `reconcile` | A human looks, and only once the lease is gone. |
| Already settled | **No** | There is nothing left to do. |

**After a possible provider success there is never a blind retry.** A session
in `reconcile`, `open` or `uploaded` is excluded from `request_post_retry`'s
targeting *and* from its deletion.

**Proved by:** SQL suites Y8, Y10, Y16 and Y17.

---

## 13. The fence is the LIVE post, not the saved upload body

**Was:** the content fence compared the saved `upload_body` against itself,
so a post that was edited while the upload ran was not noticed.

**Is:** `youtube_upload_live_fence(post, media, total_bytes, account)`
computes the fence from the **live** row: the caption, the platforms, the
media file ids, `normalize_threads_internal_metadata(metadata)`, the schedule
and the source — plus the media file's **current content version** and the
account.

The normaliser strips the keys that are attempt-only runtime bookkeeping
(`attempt_started_at`, `attempt_scope`, `settlement_rollup_*`,
`final_notification_intent`, `legacy_notification_candidate`) and keeps the
customer's content (`youtube_title`, `youtube_visibility`, the description,
the tags).

So a change to the title, the privacy, the caption or the media file refuses
the session, and a change that only records that a worker was running does
not.

**A receipt-only reconciliation does not need to authorise another provider
write.** It is fenced on the attempt, not on the content, because it sends
nothing.

**Proved by:** SQL suite Y7.

---

## 14. The terminal outcome is fenced to the attempt and to the upload's owner

**Was:** the worker that finished an upload settled the public row through
the publishing seam, and a worker that had lost its lease could still write
the row.

**Is:** `settle_youtube_upload_session(session, lease_token, status, video_id,
error_message, response_data)` settles the durable public result **and** the
parent transitions in one transaction, and only for the worker that still
holds the lease and the current attempt. A worker that lost its lease
settles **nothing**.

`project_youtube_upload_receipt(session)` is the receipt-only path: no lease
is needed (it is not a provider write), it is fenced on the attempt, it is
idempotent, and it never forces a second settlement.

**A worker that lost its lease writes nothing at all.** The worker that took
over may already have written the video, so a stale worker settling the row
would publish a result the upload does not have.

**At the continuation cap the active lease is honoured**: the session is only
marked `reconcile` once the lease is gone, and the public outcome is
projected only after a safe recovery or after the lease expires.

**Proved by:** SQL suites Y4, Y17 and Y18, and the takeover and stale-worker
tests in `youtubeUploadSession.test.ts` ("a worker that lost the lease to a
takeover settles nothing").

---

## 15. The continuation resumes only the target the run resolved

**Was:** the continuation checked the account against the post's stored
`selected_account_ids` only. A run that was given an explicit account — a
platform-only publish, an account override — resolved a target the post does
not store, and the continuation refused it.

**Is:** the session records what the run resolved: `resolved_platform` and
`target_account_ids`. The continuation resumes the target when the session
names it, and falls back to the post's stored selection when it does not.

The retry-request list is deliberately **not** the authority: a retry
excludes the accounts that have an open session, so reading the retry list
would strand exactly the sessions that need carrying on.

**Only a YouTube target is resumed.** A session whose `resolved_platform` is
anything else is refused, so no other platform is ever re-run by this worker.

**Proved by:** SQL suite Y15 and the target tests in
`youtubeUploadContinuation.test.ts`.

---

## 16. The dispatch modes are exclusive, and every refusal is observable

**Was:** the handler rejected `attempt_started_at` before it looked at the
mode. That made the YouTube continuation unreachable, because the attempt is
part of the continuation's own identity.

**Is:** the modes are told apart by the lease they carry:

| Mode | Identity |
|---|---|
| Publication | none |
| Notification recovery | attempt + candidate + claim |
| Upload continuation | attempt + session + claim token |

The notification mode is checked first, then the upload continuation, then the
publication mode refuses any leftover identity. A request that carries an
attempt and no mode is refused; a request that carries the continuation *and* a
notification claim is refused; a request that carries the continuation and a
publication override is refused. An ordinary client cannot ask for either
internal mode.

**Every refusal writes a persistent diagnostic and touches nothing else** —
no read, no claim, no provider call.

**Proved by:** `youtubeDispatchMode.test.ts`, which drives the **real
registered handler** with the reconciler's own `resumePayload()` and asserts
that a refusal made no work call at all.

---

## 17. The continuation writes nothing when the upload merely continues

**Was:** the continuation wrote the confirmed offset and the next look time
again from its own snapshot. That put older values back over newer ones, and
it cleared the "a video may exist" uncertainty.

**Is:** the resumable path writes **nothing**. The upload already recorded
the confirmed offset, the next look time and the uncertainty under its lease,
and those records are the authoritative ones. The continuation only reports
when the session may be looked at again.

The uncertainty that a video may exist is **sticky** in both the SQL and the
in-memory store: a checkpoint can set it, and no checkpoint can clear it.

**Proved by:** the "an upload that continues leaves the row pending and
writes nothing" test, the "the uncertainty that a video may exist never
clears" test, and SQL suite Y5.

---

## 18. The source is rebuilt through the normal resolver

**Was:** the continuation rebuilt the video's source with a hard-coded
`storage_bucket: "postora"` and no provider rows. A file in the `media`
bucket, or a file whose provider had a delivery URL, was read from the wrong
place.

**Is:** the resolver lives in one module, `mediaDelivery.ts`, and the
publishing path and the continuation both use it. The continuation reads the
file's **own bucket** and the provider rows that match its **current content
version**. The CDN read preference is one admin setting read through one
function, so the two paths cannot disagree about which object they publish.

Nothing is hard-coded and nothing reaches outside the approved media hosts:
the URL the resolver returns is checked against the host policy before the
first byte is asked for.

**Proved by:** `youtubeUploadSource.test.ts` (a file in `media` is signed in
`media`, a file in `postora` is signed in `postora`, a provider row of the
current version is used, a provider row of a stale version is not, and an
unapproved host never receives a request).

---

## 19. A media read failure names a stable reason and no URL

**Was:** the source module threw ``The video could not be read: ${reason}``,
where `reason` was the raw exception message. A failed `fetch` carries the
URL it was given in its message, and a media URL is signed: the credential
ended up in the public result and in the stored error column.

**Is:** every failure in `youtubeVideoSource.ts` is a `VideoSourceError` with
a stable reason code and a stable message. The raw text goes into `detail`,
which is redacted and is for the log line. The provider's response body is
never read into a message at all.

Two new reasons: `youtube_upload_media_read_failed` (the host did not
answer) and `youtube_upload_media_origin_not_approved` (the host is outside
the policy). They are separate from `youtube_upload_media_unavailable`
(the file is gone) because they mean different things to a customer.

**Proved by:** `youtubeVideoSource.test.ts` ("a failed read names a stable
reason and no URL", "a provider response body never reaches the message", "a
host that answers the wrong status names a stable reason", "a host outside
the approved list names its own reason"). Every host in those tests is a
script; nothing talks to a real site.

---

## 20. The follow-ups belong to the run that created the video

**Was:** the thumbnail and the first comment were done by whichever run
finished the upload. With a continuation in the picture, the run that created
the video is not always the run that finished it.

**Is:** they belong to the run that **created** the video.

- The publishing path does them only when it created the video
  (`!inheritedReceipt`).
- The continuation does them only when it created the video — that is, when
  it ran the upload itself and it completed. A continuation that inherits a
  receipt does **not** repeat them.
- They happen **before** the settlement, so a worker that dies in between
  leaves them done rather than done twice.
- A follow-up that fails never blocks the settlement: the video is already
  live and the public row has to be settled either way.

The rule is at-most-once. A first comment posted twice is a duplicate on the
customer's channel, which is worse than a missing one.

**Proved by:** the follow-up tests in `youtubeUploadContinuation.test.ts`.

---

# The third round

## 21. The receipt and the lease are handed to the owner that has to settle them

**Was:** `complete_youtube_upload_session` and `release_youtube_upload_session`
cleared the lease, and `settle_youtube_upload_session` demanded a live lease.
The worker that stored the receipt therefore could not publish it: the receipt
sat on the session with nobody able to settle the public row, and a takeover
could settle the row with a receipt the owner had already stored.

**Is:** the lease **survives** `complete` and `release`. The owner keeps the
lease it was given, and that lease is what the fenced settlement accepts. The
settlement releases the lease.

The handoff is a sequence, not a state: **claim → complete/release → settle,
all with the same lease.** A worker that lost the lease settles nothing
(YUS09), and a live lease is never taken over (YUS07) — the owner of an
uploaded session is the worker that is about to settle it.

A worker that dies between the receipt and the settlement leaves a lease that
expires on its own. The takeover then inherits the receipt and settles it.

**Proved by:** SQL suite Y20; `youtubeUploadSession.test.ts` ("the owner keeps
its lease after the receipt so it can settle", "a takeover after the lease ran
out inherits the receipt").

---

## 22. The dispatch that reached the cap is consumable by its own lease

**Was:** the single-session claim refused every claim once the continuation
count reached the cap, including the claim of the worker the **batch** claim
had just handed the session to. The dispatch that brought the count to the cap
could not be consumed, so the session stalled at the cap with a public row that
stayed pending.

**Is:** the cap refuses everyone **except** the holder of the live exact lease.
A takeover, and the same worker after its lease expired, are refused (YUS13);
the batch reconciliation classifies the session once the lease is gone.

**Proved by:** SQL suite Y21; `youtubeUploadSession.test.ts` ("the holder of the
live lease may consume the dispatch that reached the cap").

---

## 23. An exhausted session settles its public row

**Was:** the batch reconciliation changed the private state of an exhausted
session and left the public row pending. A session that never opened a provider
session was not even eligible, so its row stayed pending for ever.

**Is:** `youtube_upload_classify_terminal(session)` classifies a due session and
**settles its public row** under the same authority as every other settlement:
the parent is locked before the row, and only when the post is still processing
and the attempt still matches.

The classification distinguishes the two outcomes:

* a video **may** exist (a byte reached the provider) → the session is
  `reconcile`, the public row is failed with `youtube_upload_reconcile_required`,
  and **no blind retry** is offered;
* nothing was ever written → the session is `failed`, the public row is failed
  with `youtube_upload_unsent`, and **a retry is safe**.

A session that never opened a provider session counts as exhausted too: leaving
it invisible would leave its public row pending for ever.

**Proved by:** SQL suite Y22.

---

## 24. A late receipt does not overwrite a cancellation

**Was:** the receipt-only projection settled the public row and the parent
without asking whether the owner had cancelled the post in the meantime. A
cancellation could be overwritten by a receipt that was read before it.

**Is:** the projection locks the **parent before the result row**, so the two
never deadlock and a cancellation is either seen or waits. When the post is no
longer being processed, the projection refuses (YUS12): the **private receipt is
kept** on the session — it is the truth about what the provider holds — and the
public row and the parent keep the outcome the owner gave them.

The idempotent answer is checked first: a row that is already settled with the
same video returns the same answer and changes nothing, because there is no
parent transition left to make.

**Proved by:** SQL suites Y18 and Y23.

---

## 25. The admission compares the caller's snapshot with the live post

**Was:** the admission blessed the upload body the caller had already built.
Between the caller's read and the admission, the customer could have changed the
title, the privacy or the caption, and the body would still have been blessed.

**Is:** `admit_youtube_upload(...)` takes the caller's snapshot
(`p_expected_content`) and compares it with the **live** post under the post's
lock. A snapshot that no longer matches the live post is refused (YUS04), so a
body built from a stale read is never blessed. The admission also refuses a
post that is no longer being processed (YUS12) and an attempt that is not the
post's current one (YUS11).

**Proved by:** SQL suite Y26.

---

## 26. The write authority is the live state, not the lease

**Was:** the lease was the only fence between the worker's first read of the
world and the write to the provider. A lease says the worker owns the session;
it says nothing about the post, the content, the target or the media.

**Is:** `youtube_upload_effect_authority(session, lease_token)` answers whether
the worker may write **now**, against the live state: the lease, the attempt,
the post status, the live content fence, the authorised target, and the media
file (its current object version and its scan state).

It returns a reason rather than raising, because the caller has to decide: a
stale attempt is a refusal, and a media file that is still being scanned is a
wait.

The check runs **before the provider session is opened** and **again before the
write that creates the video** — the two writes that cannot be taken back. A
refusal writes nothing at all and leaves the record exactly as it was, so a
refusal before the last chunk does not leave the record claiming that a video
may exist when no byte was ever written.

**The media rule is the shared one.** `media_files.scan_state` is read with the
same `mediaSendability` rule every other send path uses: `pending` is a wait
and `rejected` is permanent. A resumed upload refuses exactly what every other
send path refuses.

**Proved by:** SQL suites Y26 and Y27; `youtubeResumableUpload.test.ts` ("a
refusal before the session is opened writes nothing at all", "a refusal before
the last chunk leaves the video unwritten"); `youtubeUploadContinuation.test.ts`
("a title that changed after the claim stops the write", "a media file that is
still being scanned waits").

---

## 27. The fanout of a dead worker is closed by the next one

**Was:** the worker that admitted the upload may have died before it closed
the post fanout. The notification candidate stayed open, the post stayed
`processing`, and the parent was never rolled up.

**Is:** `recover_youtube_upload_fanout(session)` closes the fanout of an upload
whose worker died between the admission and the closure.

The scope is **derived from the database**, never guessed: the attempt's
destinations come from the persisted notification candidate, and the rows are
the attempt's own rows for those destinations. The closure only happens when
the scope is **complete**.

* A **single destination** closes through the real notification-enrolled
  fanout: the candidate becomes ready, the parent is rolled up, and the
  notification is dispatched as it is for any other post.
* A **mixed destination** whose sibling never started is **not** closed. The
  candidate records an explicit terminal state
  (`fanout_state = 'youtube_upload_partial_scope'`, the accounts that never
  started, and a reason), the successful sibling keeps its result, and
  **nothing is re-run**.

The authority is the session, not the lease: the closure runs after the
settlement, and the settlement releases the lease. A session that reached a
terminal state was settled by the worker that owned it, and the scope is read
from the database, so a caller that arrives late or twice can only cause the
closure the database already implies.

**Proved by:** SQL suites Y24 and Y25.

---

## The shared claim limit

`claim_post_completion_work(p_limit, ...)` hands out work of three kinds
through **one** limit: the deferred publishes, the notification candidates
and the upload continuations. The notification step now increments the
counter it shares, so a notification candidate consumes a slot and the upload
continuations only get what is left.

**Proved by:** SQL suite Y19.

---

## The rollout order

**The schema comes before the code.** The migration
`20261118120000_youtube_resumable_upload_sessions.sql` creates the table, the
functions and the changed `sweep_stale_processing_posts` and
`claim_post_completion_work`. The `process-post` build that calls them needs
those functions to exist: a missing function is an error at the first upload,
not a fallback.

The migration has never been applied anywhere, so the corrected signatures
(`p_lease_ms`, the attempt column, the extended `checkpoint`, the admission,
the fenced settlement and the receipt projection) are simply the first
version.

### The order of the three deploys

**1. The schema.** Apply the migration. It is additive: a new table, new
functions, and the changed sweeper and claim. Nothing that exists calls the
new functions yet, so the old `process-post` keeps working.

**2. The compatible reconciler.** Deploy the `reconcile-deferred-publishes`
build that knows the new functions. It is compatible with the old
`process-post`: it only *claims* work, and the claim is a read of the new
tables. The old publisher never calls the new functions.

**3. The publishing producer.** Deploy the `process-post` build that calls the
admission, the fenced settlement, the effect authority and the fanout
recovery. This is the deploy that needs the schema, and it is the deploy that
starts writing the durable sessions.

**The order is not optional in the other direction.** The new `process-post`
calls `admit_youtube_upload`, `settle_youtube_upload_session`,
`youtube_upload_effect_authority` and `recover_youtube_upload_fanout`, so it
needs the schema. The new reconciler drives the continuation, and the
continuation needs the schema too. The schema needs neither.

**One thing the owner has to decide:** the `reconcile-deferred-publishes`
cron already runs every minute, and the YouTube continuation rides on it, so
there is no new schedule. If the owner would rather have the continuation on
its own schedule, that is a separate change and it is not in this branch.
