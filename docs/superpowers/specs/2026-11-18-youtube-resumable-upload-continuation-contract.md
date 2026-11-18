# YouTube resumable upload: the changed contract

**Date:** 2026-11-18
**Branch:** `T3-CODE/youtube-resumable-upload-durability`
**Base:** `0d25e934df28db85ba99b4385e2e9792921bf999` (PR #440)

This note says what changed against the contract the previous commit
established, and why. It is written for the reviewer: everything here is a
deliberate difference, not an accident.

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

**Is:** `youtube_upload_sessions.attempt_started_at`. `begin` records the
attempt the post is on (the caller's, or the post's own
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

## The rollout order

**The schema comes before the code.** The migration
`20261118120000_youtube_resumable_upload_sessions.sql` creates the table, the
functions and the changed `sweep_stale_processing_posts` and
`claim_post_completion_work`. The `process-post` build that calls them needs
those functions to exist: a missing function is an error at the first upload,
not a fallback.

The migration has never been applied anywhere, so the corrected signatures
(`p_lease_ms`, the attempt column, the extended `checkpoint`) are simply the
first version.

**One thing the owner has to decide:** the `reconcile-deferred-publishes`
cron already runs every minute, and the YouTube continuation rides on it, so
there is no new schedule. If the owner would rather have the continuation on
its own schedule, that is a separate change and it is not in this branch.
