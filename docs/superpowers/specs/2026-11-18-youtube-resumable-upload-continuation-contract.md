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

Sections 21 to 41 are the third round. The lifecycle does not change: it says
in which order the locks are taken, which outcome is a proof and which is not,
what a repair is allowed to take, and what the live authority is checked
against.

Sections 42 to 47 are the fourth round: the recovered receipt, the owned
failure, the bounded follow-ups, the reconnect, the credential and the
marker.

Sections 48 to 57 are the fifth round, from the cross-file review. The
lifecycle changes in three places and nowhere else: a permanent refusal now
settles its row, the disconnect keeps the evidence, and the admission can
rebind a session to the file a retry names. The rest is about what may be
fetched, what may be sent, and what fails closed.

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

**Is:** the continuation result uses a code from `YOUTUBE_UPLOAD_REASON`.
Successful continuation uses `youtube_upload_completed`. The internal upload
runner hands a successful video receipt to the caller, which builds that
public continuation result. Each code has a stable message. Provider text
stays on the server in redacted diagnostics.

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
the scope is **complete**, and section 28 says how a destination without a row
becomes part of the scope.

* A **single destination** closes through the real notification-enrolled
  fanout: the candidate becomes ready, the parent is rolled up, and the
  notification is dispatched as it is for any other post.
* A **mixed destination** whose sibling has no row is closed too, after that
  sibling is terminalised the way section 28 describes. The successful sibling
  keeps its result, and **nothing is re-run**.

The continuation closes the fanout before settling the YouTube result or
projecting an existing receipt. If a worker holds a live lease, it passes the
token to recovery. The pending result stays in place while the scope is
incomplete. After the lease expires, the reconciler can recover an eligible
terminal session using the persisted attempt scope.

**Proved by:** SQL suites Y24, Y25 and Y31.

---

## 28. A missing result row is an unknown outcome, not a proof

**Was:** the recovery read a destination without a result row as a destination
that **never started**, wrote that claim into the candidate
(`fanout_unsent_account_ids`), and left the fanout open. The generic sweeper
then read the same absence as a proof, wrote a row that said *Safe to retry*,
and made the post terminal.

**That reading was wrong.** Only the native YouTube path writes its result row
**before** the provider call, so only a missing YouTube row proves that nothing
was sent. Every other platform writes its row **after** the provider call: the
worker publishes first and records the outcome afterwards. A missing sibling row
therefore proves nothing. The provider call may have succeeded and the receipt
may have been lost with the worker, and a retry of that destination can publish
a second time.

**Is:**

* The recovery **never** claims that a sibling never started, and **never**
  gives a sibling a retryable result.
* A destination without a row is **terminal** with the stable public reason
  `partner_publish_reconcile_required`, and its `response_data` carries
  `publish_outcome = 'uncertain'`. The scope becomes complete, the fanout
  closes, and the parent reaches a finite outcome. The row says what a human
  has to do.
* The successful siblings keep their results, and the durable YouTube receipt
  is untouched.
* Nothing is published again from the recovery.

**The quiescence boundary.** Recovery waits until
`posts.processing_started_at + youtube_upload_attempt_quiet_after()`,
which is 150 seconds on the current worker configuration. A live worker may
still send its result while that window is open. After the window, a database
request sent before worker termination may still commit. The timeout therefore
does not establish whether a provider call happened or whether a result write
is still in flight. Recovery classifies a missing sibling result as uncertain
and does not authorize a resend. Until the window expires, recovery returns
`attempt_may_still_be_running` without closing the fanout.

**The order.** The closure is driven **before** the public row is settled. The
pending YouTube row is what keeps the generic sweeper from reading the absence
of a sibling row as a proof, so the scope has to be settled while that row is
still pending. The continuation drives `recoverFanout` before `settleUpload`
and before the receipt projection.

**The retry gate.** `request_post_retry` refuses a result whose
`publish_outcome` is `uncertain` or `cancelled`, in the one place every retry
path goes through. The queue, the API, the MCP node and the browser therefore
get the same answer: that destination is not safe to publish to again.

**Proved by:** SQL suites Y25, Y28, Y29 and Y31.

---

## 29. The generic sweeper never offers a retry for an ambiguous destination

**Was:** `sweep_stale_processing_posts` read the absence of a result row as a
proof that the destination never started, and wrote a row that said *Safe to
retry*. For a post with a YouTube upload that reading is wrong, and the retry
could publish a second time.

**Is:** a destination of a post that has a YouTube upload is closed with the
same non-retryable reason the recovery uses
(`partner_publish_reconcile_required`, `publish_outcome = 'uncertain'`). The
parent is still rolled up, so the post reaches a finite outcome either way, and
the sweeper never becomes the thing that asserts a safety it cannot prove.

A post **without** a YouTube upload is swept exactly as before.

**Proved by:** SQL suite Y29.

---

## 30. The pending row of a cancelled post is closed

**Was:** the admission creates the public pending row and the session together.
When the post was cancelled the attempt ended and that row stayed `pending` for
ever: the continuation refuses a post that is no longer being processed
(YUS12), and the sweeper leaves a post with a pending row alone. The customer
saw a publication that never finished.

**Is:** `youtube_upload_terminalize_cancelled(session)` closes **that row** and
nothing else.

* The row becomes a terminal failure with a stable public reason:
  `youtube_upload_reconcile_required` when a video may exist (a byte ever
  reached the provider, or the last write may have landed), and
  `youtube_upload_cancelled` when nothing ever reached the provider.
* The session becomes terminal and releases its lease.
* The parent is **not** rolled up and nothing is published again: the post keeps
  the outcome the owner gave it. The row is closed directly instead of through
  the settlement, because the settlement rolls the parent up when the post
  carries no notification candidate.
* The attempt authority still holds: the session's attempt must be the post's
  current one, so an attempt that has been superseded is left alone.

Neither reason is retryable, and the `publish_outcome` marker keeps the retry
gate from touching the destination.

**The reachable surface.** The continuation can never reach this: it refuses a
post that is not being processed. `reconcile_youtube_upload_fanouts(p_limit)`
is the bounded driver that reaches it, and the reconciler calls it every
minute.

**Proved by:** SQL suite Y30.

---

## 31. A retried upload that never sent a byte is started again

**Was:** `request_post_retry` legitimately changes the post's `publish_requested_at`,
and that is part of the content fence. The admission compared the fence of the
existing session with the live fence **before** the branch that reopens a
`failed` session, so the retry of an upload that never sent a single byte was
refused with YUS04: the customer could not publish the video again at all,
although nothing had ever reached the provider.

**Is:** the admission restarts a terminal session that proves that nothing ever
reached the provider — and it does so **before** the fence is compared.

* The restart is allowed only when the session is `failed` or `expired`, the
  record proves that no byte ever reached the provider (`video_may_exist` is
  false and `bytes_sent` is zero), the media file is the **same file at the
  same content version**, the account is still a target of the post, and the
  attempt that is asking is the one that is running (the post is locked, and the
  caller's attempt must still be the current one).
* The restart resets the state, the provider session URI, the offsets, the
  lease, the attempt and the continuation count, and it **refreshes** the fence
  and the upload body with the live ones, because this attempt publishes the
  live post. The media file and its version are the ones that were checked.
* A session that may already hold a video is **not** restarted: the `failed`
  branch now refuses to reopen one, exactly like the `expired` branch already
  did, and leaves it for a human.
* An inherited or open session keeps the fence comparison: it holds a provider
  session that carries the old attempt's content.
* A session that holds a receipt is returned as it is, and a possible video is
  never restarted.

The reason codes do not change: the restart produces the same session a first
admission produces, and the write authority sees the live fence afterwards.

**Proved by:** SQL suite Y32 (the real composition of `request_post_retry`, the
fresh processing claim and the admission, plus the unsafe counterparts), and the
in-memory session store's tests.

---

## 32. The terminal session whose worker died is settled

**Was:** a worker that gives up releases the session into a terminal state and
then settles the public row in a **separate** call. A worker that died in
between left the session terminal (`failed`, `expired` or `reconcile`) and the
public row `pending`, and nothing else settled it: the claim only recovered
open sessions and stored receipts, and the sweeper leaves a post with a pending
row alone. The post stayed `processing` for ever, and the customer saw a
publication that never finishes.

**Is:** `recover_youtube_upload_terminal_results(p_limit)` classifies the
sessions whose public row is still pending although the session itself is
already terminal.

* The classification is the one the database already applies to an open session
  that cannot be carried on, so the outcome is derived from the record: no
  provider is contacted, no upload is written a second time and nothing
  uncertain is replayed.
* The reason follows the state the session was found in: a session the worker
  marked for a human stays `reconcile`, a session the provider refused for good
  becomes `youtube_upload_rejected`, and a session whose provider session was
  gone becomes `youtube_upload_unsent` unless a byte had reached the provider.
  A proven failure is retryable; a possible video is not, and it carries the
  `publish_outcome = 'uncertain'` marker, so the database and the browser both
  refuse a blind retry.
* The fences: a worker that still holds the lease is left alone (the release
  keeps the lease on purpose, because the owner still has to settle the row),
  the attempt must still be the running one and the post must still be
  processing, so a cancelled or superseded post keeps its own outcome, and the
  work is bounded.
* The pending row of a **cancelled** post is closed by the cancellation path
  (`youtube_upload_terminalize_cancelled`, which now also accepts a terminal
  session), and the parent keeps the outcome the owner gave it.
* The other destinations and their receipts are untouched: the settlement is the
  one the database already uses, and the parent rolls up as it always did.

**The two callers.** The claim surface calls the recovery with the shared
remaining limit, so one pass never walks more than the batch allows; it does
not consume the budget, because it hands out no work and costs no worker. The
repair driver calls it as well, with a bound of its own: a post that waits for
a free slot would stay `processing` for ever, which is the very thing this
recovery exists to prevent.

**Proved by:** SQL suite Y33.

---

## 33. One lock order, owned by one helper

**Was:** the writers of a session took their locks in different orders. The
settlement locked the session and then the parent, the projection locked the
result row first, and the classification locked the parent and the session in
one statement. Two transactions that walked the same post in opposite orders
could deadlock, and the failure of one of them would be a deadlock victim
rather than a retry.

**Is:** the order is **parent → session → result**, and it lives in one place:
`youtube_upload_lock_scope(p_session_id)`.

* The helper locks the parent, then the session, and it **re-reads the binding**
  between the two locks: a session that was moved to another parent cannot be
  written through the old one, and the helper says so instead of writing.
* The settlement, the receipt projection, the cancellation repair and the
  classification all take their scope through the helper, and none of them takes
  a session lock of its own. The result row may still be locked: that is the
  third step of the order, not an inversion.
* The classification loop of the batch claim locks the **parent**
  (`FOR UPDATE OF p SKIP LOCKED`), so a backlog of exhausted sessions cannot
  invert the order either.

The order is a property of the code, so it is proved on the code: the suite
reads the definitions and checks the order of the two locks, and checks that no
writer locks the session itself.

**Proved by:** SQL suite Y34.

---

## 34. An explicit reconcile is never taken away

**Was:** the settlement derived the outcome of the session from the byte
counters alone: a session that was already marked for a human — the worker
could not tell whether the last chunk landed — became `failed` when the
settlement said `failed`. The mark was the only thing that kept a second video
off the channel, and it was dropped. The public row got no marker either, so
the retry gate and the page could not see that the outcome was not a proof.

**Is:** the uncertainty is read from the **record**, not from the counters.

* A session that is already `reconcile` stays `reconcile`: a failure never
  replaces an explicit manual outcome with a safe one.
* A session whose bytes may have reached the provider, a session that was
  already marked for a human, and a settlement that says the outcome is
  uncertain are all `reconcile`.
* The settled row carries `publish_outcome = 'uncertain'` and the reason that
  made it uncertain — **even when the final-byte flag says false**. The marker
  is the row's own record of what happened, and it is what the retry gate and
  the page read.
* A proven failure carries **no** marker: the upload never started, or the
  provider refused it for good. Those stay retryable.

The worker writes the same marker on its side, so the row that the worker
settles and the row that the database settles say the same thing.

**Proved by:** SQL suite Y36, and the continuation's tests.

---

## 35. A cancelled post is not classified

**Was:** the classification settled the public row of a session whose post was
no longer being processed. On a cancelled post that preempted the
cancellation repair: the row was closed with the outcome of the **upload**
instead of the outcome of the **cancellation**, and the repair that should
have closed it found a row that was already settled.

**Is:** a post that is not being processed is left alone — state and all.

* The classification returns `{ classified: false, reason: 'post_not_processing' }`
  and does not touch the session or the public row.
* The cancellation repair finds the session by its state and closes the row
  itself, with `youtube_upload_cancelled` and `publish_outcome = 'cancelled'`,
  and the parent keeps the outcome the owner gave it.

**Proved by:** SQL suite Y37.

---

## 36. The repairs are bounded

**Was:** the expiry reset and the exhausted classification walked the whole
table in one pass. A backlog of expired or exhausted sessions held a lock on
every one of them, and one pass of the claim did the work of many.

**Is:** both repairs are bounded by the batch, and they skip the rows another
transaction is holding.

* The expiry reset is a bounded set (`ORDER BY … LIMIT p_limit FOR UPDATE SKIP
  LOCKED`): one pass reopens one session, the rest waits for the next one.
* The exhausted classification is bounded by the same limit and locks the
  **parent** with `FOR UPDATE OF p SKIP LOCKED`, so it keeps the lock order and
  never blocks on a row another worker holds.

**Proved by:** SQL suite Y38.

---

## 37. No work is starved

**Was:** the shared claim limit handed the first step — the deferred publishes —
all of it. A backlog of deferred publishes took every slot, and the upload
continuations that were due got none: their posts stayed `processing` until
the backlog was gone.

**Is:** the shared limit is still the limit, and it keeps a **reserved share**
for the upload work.

* The deferred publishes take `p_limit - reserved`, the notification candidates
  take one of what is left, and the upload continuations take the rest.
* The reserve is `least(2, p_limit - 1)`: with a limit of one the behaviour is
  unchanged, and with a larger limit the upload work always keeps a slot.
* The total is still at most `p_limit`: the shared limit is a limit on the
  batch, not on each kind.

**Proved by:** SQL suites Y19 and Y38.

---

## 38. The live authority in the last checkpoint

**Was:** the write authority was checked **before** the chunk was read. A slow
read — a chunk that took a minute to come out of the provider — is long enough
for the customer to cancel the post, to edit it, or to start another attempt
of it. The checkpoint then wrote the bytes of a post that no longer existed in
that shape.

**Is:** the live authority is checked again in the **last statement before the
bytes are written**.

* It is checked on the chunk that **completes** the upload, because that is the
  write that can publish a video. The chunks before it only fill a provider
  session that is discarded when the upload is not finished, so they cost one
  query per upload instead of one per chunk.
* The refusals reuse the codes that already exist: `YUS11` for a superseded
  attempt, `YUS12` for a post that is no longer being processed, `YUS04` for a
  post that was edited, `YUS15` for a target the post no longer selects, `YUS03`
  for a media file that was replaced.
* The refused chunk moves **nothing**: the offsets, the provider session URI and
  the uncertainty are exactly what they were.

**Proved by:** SQL suites Y35 and Y35b.

---

## 39. A disconnected destination leaves the scope

**Was:** the recovery of a dead worker skipped a destination whose account was
disconnected, but the scope of the attempt still named it. The closure is
refused when a destination in the scope has no result row
(`invalid_result_scope`), so the fanout could never close and the post waited
for ever.

**Is:** the disconnected destination leaves the scope **in the same
transaction**, and its record of the possible side effect stays.

* The scope of the attempt is the list of destinations this attempt owns. An
  account that is gone, or that belongs to somebody else, cannot be published
  to any more, so it leaves the scope.
* The record of the unknown outcome (`fanout_unknown_account_ids`) **keeps** it:
  the account may have been published to before it was disconnected, and that is
  a possible side effect nobody may forget.
* The other destinations and their receipts are untouched, and the parent rolls
  up as it always did.

**Proved by:** SQL suite Y39.

---

## 40. The admission takes the live media version

**Was:** the admission read the live media version and recorded it in the
session, but it never compared it with the version the caller had read. A file
that was replaced between the caller's read and the admission was admitted
under its **new** version: a continuation could then send the bytes of the old
file under the new version, and the video would be a mixture of two files.

**Is:** the admission takes the version the caller read, and refuses the
admission when it is not the live one.

* `admit_youtube_upload(..., p_expected_media_version)` compares the caller's
  version with `media_files.current_object_version` and refuses with `YUS03`
  when they differ.
* The refusal happens **before** the session and the public row exist, so a
  refused admission creates nothing.
* The caller's version comes from the file the worker resolved, so the bytes the
  worker holds are the bytes the session records.

**Proved by:** SQL suite Y40, and the session store's tests.

---

## 41. A cleared schedule is not an unchanged one

**Was:** an omitted next-check time and an explicit clear both reached SQL
as NULL. The checkpoint could not distinguish them.

**Is:** the two are separate.

* `checkpoint_youtube_upload_session(..., p_clear_next_check)` says which one it
  is. Clearing sets `next_check_at` to NULL, removing the delay. An open
  session that meets the other claim conditions is then due immediately.
* Omitting the time leaves it unchanged. The worker sends the clear flag
  only for an explicit null.
* The in-memory session store stops handing out a session that is at the
  continuation cap, the way the database does, so a test cannot prove something
  the database would refuse.

**Proved by:** the session store's tests, and SQL suite Y38.

---

## 42. The provider request is recreated exactly

**Was:** the settings of the provider request were rebuilt from the stored body
when a later worker opened the provider session: the parts were the names of the
fields the body carried, and the subscriber notification was always the
provider's default. A customer who had turned the notification off was told
about their video by a worker that opened the session later, and the request
that was approved was not the request that was made.

**Is:** the settings are stored with the session, and they are part of the
request that is made.

* `admit_youtube_upload(..., p_upload_settings)` keeps the settings the caller
  named: the `part` values the request writes, and whether the channel's
  subscribers are told about the video.
* A caller that names none gets the request its body describes — the parts are
  the names of the fields the body carries, in one order, and the notification
  is the provider's default. The derivation lives in the database, so the
  settings a session carries are the settings the worker will use.
* The settings travel in the session payload, and the safe restart refreshes
  them with the ones of the new attempt.
* `buildYoutubeUploadUrl` is the only place the URL is built, so the request
  the publisher makes and the request a later worker makes cannot drift apart.

**Proved by:** SQL suite Y41, and the publisher's and the session store's tests.

---

## 43. The receipt is recovered before the media is opened

**Was:** the continuation opened the media before it asked the provider what it
held. A media host that answered with a 500 ended the attempt before the
provider was asked, so a receipt that YouTube could still return was never
read: the attempt cap ran out with an uncertain result on the customer's
channel.

**Is:** the provider is asked first, and the file is opened only when it says it
needs more bytes.

* The continuation hands the runner a **deferred** source: the media is opened
  on the first byte that is read, not before.
* The runner probes an inherited session before any data write, so a session
  the provider already finished is settled without the media ever being touched.
* The media check and the write-authority check still run **before** the upload,
  so a file that is gone, replaced or still being scanned is refused before
  the provider is asked, and a write that the live state does not allow never
  happens.
* A media host that cannot answer can therefore no longer keep a receipt from
  being recovered.

**Proved by:** the continuation's tests.

---

## 44. An admitted row belongs to the upload recovery

**Was:** a settlement whose answer was lost, or that was refused because the
lease was gone, threw an error that did not say the row had been written by
this worker. The outer loop then recorded a **second** result for the same
destination: beside the pending row the admission made, or beside a success
that had already committed. The row id was not carried either, so the scope of
the attempt did not name the destination and the fanout could not close.

**Is:** the row is owned by the upload recovery, and the error says so.

* The settlement never throws. It answers `{confirmed, reason}`, and the caller
  acts on the answer.
* A settlement that was **confirmed** is the final word: the row is a failure
  and the customer is told what it was.
* When a settlement is **unconfirmed**, the worker leaves the admitted result
  to recovery. A lost response can mean the write already committed. Otherwise
  recovery can project a stored receipt or classify a terminal failure from the
  session state.
* The error carries `selfWroteRows` and the row id, so the generic writer does
  not write a second row and the scope of the attempt names the destination.
* The failure never becomes a *second* row beside the admitted one: the same
  row is settled.

**Proved by:** the outcome contract's tests, and the continuation's tests.

---

## 45. The follow-ups are bounded and guarded

**Was:** the thumbnail and the first comment were written without a deadline
and without a check of the live state. A host that accepted the connection and
then stopped sending held the worker, and the outcome was never written at all;
and a post that was edited or cancelled while the video was being written still
got a thumbnail and a comment.

**Is:** both follow-ups are best-effort requests inside the worker's budget.

* Every request carries a deadline that covers the headers **and** the body,
  and the thumbnail is read with the same bound.
* The budget is asked for **every** follow-up, so the second one is skipped when
  the first one used the time up.
* The live state is asked about **before** the follow-ups are written. The
  receipt does not depend on that answer: the video exists, so the row is
  settled either way.
* The first comment is posted **once**. It is never retried: a first comment
  posted twice is a duplicate on the customer's channel, and a timeout says
  nothing about whether the first one arrived.
* The follow-ups belong to the run that **created** the video. A run that
  inherited the receipt never repeats them.
* **The cost of that rule, on purpose.** A worker that dies after the receipt
  is checkpointed but before the thumbnail or the first comment is written
  loses both, and History shows the post as published. That is the lesser
  loss. A second comment on the customer's own channel is public and cannot
  be unread, and a second thumbnail is a second write against a video that
  already carries one. A missing thumbnail and a missing first comment are
  visible and fixable — the customer can set the thumbnail on the video —
  while a duplicate cannot be taken back. The rule is therefore kept, and the
  cost is stated here rather than left to be discovered.

**Proved by:** the follow-ups' tests, and the continuation's tests.

---

## 46. A credential that is not accepted asks for a reconnect

**Was:** a handshake that was refused with 401 or 403 became a refusal of the
upload, and the customer was told that the upload had been refused. The
customer had to work out that the credential was the problem, and a retry with
the same credential failed the same way.

**Is:** a credential the provider no longer accepts is its own outcome.

* The provider module raises a typed refusal with the status it was given.
* 401 and 403 become the reason `account_unusable`, whose public message asks
  the customer to reconnect the account and try again.
* Every other refusal stays a plain refusal: YouTube refused the upload, and
  that is a proof that nothing was published.
* The message never carries the provider's own words.

**Proved by:** the runner's tests, and the outcome contract's tests.

---

## 47. The marker says the outcome is not a proof

**Was:** the native path settled a failure without the marker that says the
provider may already hold a video. History and the API retry selector read that
marker, so an outcome that was not a proof was offered as a retry.

**Is:** one rule decides what is a proof, and it is in one place.

* An outcome is uncertain when the provider may hold a video nobody has a
  receipt for: a reconcile, or an answer that could not be classified.
* The native settlement carries `publish_outcome: "uncertain"` for exactly those
  outcomes, and no marker for a proven failure.
* The database adds the marker on its own rule as well, and the union is
  uncertain: a settlement that dropped the marker would offer a blind retry.
* A proven failure on a sibling account carries no marker, so one account's
  refusal does not take the whole post away from the retry button.

**Proved by:** the outcome contract's tests, and SQL suites Y22 and Y25.

---

## 48. The thumbnail is fetched only from an approved origin

**Was:** the follow-up that reads the thumbnail asked for the URL it was given.
The URL came from the customer, so the worker could be asked to read anything
on the internet, and the read had no size bound and no deadline of its own.

**Is:** the thumbnail is read with `fetchApprovedMedia`, the same function the
video source uses: only an approved HTTPS media origin, every redirect hop
validated before it is followed, a bounded body (10 MB) and the worker's
deadline.

**Why:** the thumbnail is the customer's file. Reading it back from an origin
Postora does not own is an SSRF the customer can aim at the deployment, and an
unbounded read is a way to spend the worker's whole lifetime on one byte of
answer. The cost is that a thumbnail hosted somewhere else is no longer
fetched: the copy that is fetched is the copy that Postora stores, which is
what the channel shows anyway.

**Proved by:** `youtubeVideoSource.test.ts` (the approved hosts, the per-hop
validation and the bounded read) and `youtubeUploadFollowUps.test.ts`.

---

## 49. One token refresh policy

**Was:** the publishing path refreshed a YouTube token inline, and the
continuation loaded the account without refreshing it. Two places, two
policies, and a continuation that could run an hour after the publishing path
had refreshed the token.

**Is:** `youtubeTokenRefresh.ts` holds the policy — a token that expires
within thirty minutes is refreshed, the refresh has fifteen seconds of its
own, the logs are redacted and the refresh token never reaches a log line.
Both the publishing path and the continuation's account load call it.

**Why:** the refresh is a rule about one credential, so it is written once. The
continuation is the path that runs long after the publishing path, so it is
the path that needs the rule most.

**The receipt-only work stays provider-independent.** A continuation that
finds a stored receipt never loads the account, so it never refreshes a token
and never touches the provider. That is deliberate: the work that only
projects a receipt must work when the provider is unreachable.

**Proved by:** `youtubeTokenRefresh.test.ts` and the continuation's tests (a
receipt-only continuation loads no account).

---

## 50. The type of the video travels with the upload

**Was:** the resumed upload declared its chunks as `video/mp4`, whatever the
file was. A video that was not an MP4 was refused by the provider halfway
through, after the bytes had been sent.

**Is:** the type comes from the media row the session is fenced on, and the
continuation's `runUpload` port carries it. The file's own `mime_type` is the
answer, and the media version fence is what makes that answer the right one.

**Why:** the provider refuses a chunk whose declared type does not match the
upload it belongs to, and it refuses it late. The declared type is part of the
provider request, so it is part of the session, like the query settings.

**Proved by:** `youtubeUploadContinuation.test.ts` (the type reaches the
upload) and `youtubeVideoSource.test.ts`.

---

## 51. The scope verdict decides what may be removed

**Was:** the continuation drove the fanout closure and then removed the
pending evidence, whether the closure had worked or not. A closure that
could not be proven left the row pending for ever, and a closure that threw
left it pending too — so a post whose fanout could not be closed waited for
ever.

**Is:** the recovery's answer is read as a **scope verdict**, in the worker:

* `recovered` → the scope is **closed**: the evidence may be removed.
* `attempt_may_still_be_running` → the scope is **attempt_running**: the
  worker of the attempt is going to complete it, so the evidence may be
  removed.
* anything else → the scope is **incomplete**: the evidence STAYS. The
  pending row is the sweeper's protection, and it is what keeps the sweeper
  from reading the absence of a sibling row as "this destination never
  started".

**Why:** removing the pending evidence of a scope that was not closed is what
turns an unfinished publication into a silent one. The verdict is derived in
the worker from the recovery's stable reason codes, so the store's database
contract does not change.

**Proved by:** `youtubeUploadContinuation.test.ts` (the three verdicts, and the
row that stays pending).

---

## 52. A permanent refusal settles the row, and keeps the uncertainty

**Was:** a refusal that will not change on retry left the public row
**pending**. The post then waited for a destination that was never going to
publish, and the row was the only thing that said so.

**Is:** a permanent refusal settles the row as a failure, and the settlement
carries the uncertainty marker when the session may already hold a video.
The marker follows the **durable rule**, not the reason of the refusal: the
session knows whether a video may exist (`video_may_exist`), and that flag
only ever grows. A refusal on such a session is not a proof, so it carries
the marker, and neither the retry gate nor the retry button offers a blind
retry.

**Why:** a row that stays pending for ever is a publication the customer never
sees finish, and a row that is settled as a proven failure on a session that
may hold a video is a blind retry waiting to happen.

**Proved by:** `youtubeUploadContinuation.test.ts` (a refused media settles
the row, and the uncertain marker travels with it).

---

## 53. The fences fail closed

**Was:** a comparison that could not be made was treated as a comparison that
matched. A request without an attempt, a session without an attempt, a
session without a media version, a media without a current version, and a
media of another size all passed a fence that had nothing to compare.

**Is:** each of them fails closed.

* The route **requires** `attempt_started_at` (`youtube_attempt_missing`), and
  the continuation refuses a request without one (`stale_attempt`).
* The session's own attempt fence fails closed when the session carries no
  attempt.
* The media fence fails closed when the session or the media carries no
  version, and when the media's size is not the size the session was opened
  for (`media_unavailable`).

**Why:** a fence exists to refuse what it cannot prove. A fence that lets an
uncomparable pair through is a fence that is only there in the cases that
already work.

**Proved by:** `youtubeUploadContinuation.test.ts` (each fence, and the size
mismatch).

---

## 54. The disconnect keeps the evidence

**Was:** the disconnect is a hard delete of the account row, and the session
referenced it with `ON DELETE CASCADE`. The evidence of an upload that may
already have published — the receipt, the byte checkpoints and the
uncertainty marker — went with it. The disconnect was a way to publish a
second video on one channel.

**Is:** the link to the account is `ON DELETE SET NULL` and the column is
nullable. The session survives with its evidence, and a `BEFORE DELETE`
trigger on `social_accounts` settles the public row (with the marker when a
video may exist), redacts the provider session URI (a credential of an account
that is gone) and makes the session terminal.

**The disconnect is never blocked**, and the tenant keeps the post, the media
and the session. The public row still goes with the account, because its
result belongs to the account: that is the product's behaviour for every
platform, and changing it for YouTube alone would be a different product.

**Why:** the evidence has to outlive the account, or preserving it is
cosmetic. The pattern is the one the repository already uses for the same
problem (`20261002090000_scheduled_keep_inflight_on_account_delete.sql`).

**The evidence is kept; no code reads it yet.** Nothing reads
`posts.metadata.youtube_upload_outcomes`: not the retry path, not the
dashboard, not the reconciler. That is not a hole in the safety. The rule that
keeps a second video off the channel is the session's (§56, `YUS16`): the
session outlives the disconnect, and the admission refuses a reconnect that
would carry the upload onto the same channel. The retry path cannot replay the
destination either, because the row that named it is deleted with the
account, so there is nothing there to keep out of the retry. The map is
therefore the record of a destination that no longer exists — for a human
reading the post, and for whatever reads it next — and not an input to an
automatic decision.

It is deliberately **not** shown in History: the public row goes with the
account for every platform, and keeping this one would make YouTube the only
platform that shows a destination the customer disconnected.

**Proved by:** SQL suite Y42.

---

## 55. A retry with a replacement file is admitted

**Was:** the retry that carries a replacement video names the new file in the
post, and the session of the previous attempt still pointed at the old one.
The admission compared the old fence with the live post and refused, so a
retry the customer had been given could never be admitted.

**Is:** the admission **rebinds** the session to the file the post names. The
rebind is a separate branch from the same-file restart, and both require:

* the attempt to be **terminal** (`failed` or `expired`),
* **no byte sent** and **no video may exist**,
* **no live lease**: a worker that still owns the session is about to settle
  it, and a rebind under that worker would settle the new attempt with the
  old outcome,
* the new file to be the **post's own file** at the exact version the caller
  read,
* the account to still be a **target** of the post,
* the attempt that asks to be the one that is **running**.

The open, reconcile and uploaded sessions keep their guards: an open session
holds a provider session with the old content, and a session that may hold a
video may publish a second one.

**Why:** the fence of the previous attempt describes a write that never
happened, so it may not refuse a retry for ever. The proof that nothing ever
reached the provider is what makes the rebind safe.

**Proved by:** SQL suites Y44 (the rebind and the claim) and Y45 (a session
that may hold a video is not rebound).

---

## 56. The same channel is not published again after a reconnect

**Was:** the disconnect removed the session, so a reconnect and a retry opened
a fresh upload. A reconnect is a **new account row** — the OAuth upsert cannot
reuse a deleted id — so the session lookup, which is by post and account, did
not find the old session.

**Is:** the session survives the disconnect and records the **channel** it
belonged to. The admission refuses (`YUS16`,
`channel_may_have_published`) when the post already has a session of a
disconnected account, that session may hold a video, and the channel is the
one the upload is about to be carried on to.

**The channel is what tells the two apart.** Another channel of the same
customer is a different publication and stays allowed; the same channel is
refused, because a second video on one channel is worse than a post that
needs a human. The refusal carries the uncertain marker, so the row the
outer loop writes is never offered as a retry.

**Why:** preserving the evidence is only half of the repair. The evidence has
to be read by something, or preserving it changes nothing.

**Proved by:** SQL suite Y46 and `youtubeUploadOutcome.test.ts` (a refusal
that may have published carries the marker).

---

## 57. The live state is asked about again before the first byte

**Was:** the live authority was asked about once, before anything was sent. The
media is opened lazily, inside the upload, and opening it reaches the media
host — so it takes seconds. Between the check and the first byte the customer
may cancel or edit the post, remove the target account, or replace the media,
and the upload would write the old content anyway.

**Is:** the live state is asked about **again** once the media is open, and the
check travels with the source: it runs before the first chunk is read, and
therefore before the first byte is written. A lost authority makes that read
fail, which ends the attempt **without a write**, so nothing reaches the
provider. The session stays resumable, and the attempt stops here instead of
waiting for another worker to find the same thing.

A media that is still being scanned is not a failure: the attempt waits, the
same sentence the resumable outcome uses.

**Why:** the first check says the world was right when it was read. The second
one says it is right now. The write is the thing that cannot be taken back,
so the check belongs immediately before it.

**Proved by:** `youtubeUploadContinuation.test.ts` (the second check, and the
wait for a media that is still being scanned).

---

## The bounded driver of the three repairs

`reconcile_youtube_upload_fanouts(p_limit)` does what no worker can:

1. it closes the pending row of a cancelled post,
2. it settles the pending row of a terminal session whose worker died, and
3. it closes a fanout whose attempt has gone quiet.

It hands out no work: all three outcomes are derived from the database, so none
of them needs a provider and none needs a worker. That is why it is **not**
part of the shared claim limit — a post that waits for a free slot would stay
`processing` for ever — and why it has a bound of its own. It runs from
`claim_post_completion_work`, which the reconciler calls every minute.

---

## The shared claim limit

`claim_post_completion_work(p_limit, ...)` hands out work of three kinds
through **one** limit: the deferred publishes, the notification candidates
and the upload continuations. The notification step now increments the
counter it shares, so a notification candidate consumes a slot and the upload
continuations only get what is left.

**The limit keeps a reserved share for the upload work.** The first step — the
deferred publishes — may not take all of it: a backlog of deferred publishes
would otherwise starve the upload continuations that are due, and their posts
would stay `processing` until the backlog was gone. The deferred publishes take
`p_limit - reserved`, the notification candidates take one of what is left, and
the upload continuations take the rest. The reserve is `least(2, p_limit - 1)`,
so a limit of one behaves as before. The total is still at most `p_limit`: the
shared limit is a limit on the batch, not on each kind.

**Proved by:** SQL suites Y19 and Y38.

---

## The rollout order

**The schema comes before the code.** The migration
`20261118120000_youtube_resumable_upload_sessions.sql` creates the table, the
functions and the changed `sweep_stale_processing_posts` and
`claim_post_completion_work`. The `process-post` build that calls them needs
those functions to exist: a missing function is an error at the first upload,
not a fallback. Apply `20261118121000_post_retry_replacement_media.sql`
before deploying `enqueue-post-publish` with replacement-media support.
Deploy that handler before the frontend that sends replacement IDs. Apply
`20261118173000_youtube_pending_handoff_guard.sql` and
`20261118190000_post_action_processing_claim.sql` before the `process-post`
build that calls `restore_youtube_pending_post` and
`claim_post_action_processing`. Apply
`20261118200000_youtube_disconnected_outcome_evidence.sql` before the
`process-post` build that relies on the preserved receipt and the uncertainty
marker: the trigger that copies the outcome of a deleted result row onto the
post has to exist before that build settles a post whose account was
disconnected. Apply `20261118210000_youtube_recovery_hardening.sql`,
`20261118220000_post_action_claim_status_key.sql` and
`20261118230000_youtube_refreshed_token_rpc.sql` before the `process-post`
build that calls the recovery functions, the claim that answers with one
status, and the token-storing RPC.

**The five migrations named above were applied to production on 2026-11-18; the
three migrations added after them were not.** A change to the behaviour of a
migration that is already applied is therefore a NEW migration and never an
edit of an applied file (ARCHITECTURE.md §23). The corrected signatures
(`p_lease_ms`, the attempt column, the extended `checkpoint`, the admission,
the fenced settlement and the receipt projection) are the ones that run.

### The order of the three deploys

**1. The schema.** Apply the migration. It is additive: a new table, new
functions, and the changed sweeper and claim. Nothing that exists calls the
new functions yet, so the old `process-post` keeps working.

The migration is self-contained: `claim_post_completion_work` calls
`reconcile_youtube_upload_fanouts`, which calls
`recover_youtube_upload_terminal_results`, and all three are in the same
migration. Before the publishing producer is deployed no YouTube session
exists, so the drivers have nothing to do.

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

**The closure is driven before the settlement.** The new `process-post` calls
`recover_youtube_upload_fanout` **before** it settles the public row, because
the pending YouTube row is what keeps the generic sweeper from reading the
absence of a sibling row as a proof. A `process-post` that settled first would
leave a window in which the sweeper could close that window with a retry
offer. The schema alone cannot prevent that: the order lives in the producer.

**One thing the owner has to decide:** the `reconcile-deferred-publishes`
cron already runs every minute, and the YouTube continuation rides on it, so
there is no new schedule. If the owner would rather have the continuation on
its own schedule, that is a separate change and it is not in this branch.
