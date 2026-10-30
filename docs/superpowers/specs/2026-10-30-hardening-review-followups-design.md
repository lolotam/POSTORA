# Review follow-ups to the hardening branch — design

Status: findings verified against `origin/main` at `aa8d21f` (PR #300 merged). Branch:
`fix/hardening-review-followups`. Parent spec: `2026-10-29-hardening-followups-design.md`
(Parts A–D); this one only corrects what review found wrong or missing in it.

Not done, on purpose: a unique index on `media_file_providers (media_file_id, provider,
object_version)` (it exists in production as
`media_file_providers_media_file_id_provider_object_version_key`), and backfilling
`posts.processing_started_at` (0 rows affected in production; the claim sets it).

Line numbers are as of `aa8d21f`.

| # | Finding | Evidence | Fix |
|---|---|---|---|
| F1 | **Poll deadlines do not bound network time.** The deadline is compared with `Date.now() + delay` only after a status answer, never before a fetch, and each fetch keeps its 15 s timeout. Threads turns the remaining budget into an attempt count using only the 2 s sleep. A slow Meta runs the worker past 60 s before `ContainerStillProcessing`, which is the stuck-`processing` bug again. | `process-post/index.ts` `pollContainerStatus` (3436–3481), `pollBusinessLoginContainerStatus` (4280–4321), Threads call (6200–6209); `_shared/metaContainerStatus.ts` `pollContainer` (15 s fetch, no deadline). | One poller, `pollContainer`, takes an absolute `deadlineMs`. Before every sleep and every fetch it checks the time left; each fetch timeout is capped to it; with no time left it returns `waiting` without a request. Both Instagram pollers and the Threads path use it and throw `ContainerStillProcessing` on `waiting`. `deadlineMs = 0` (resumed run) stays "check exactly once, full timeout, no sleep". |
| F2 | **Meta API errors read as "waiting".** `pollContainer` parses any answer; a 400/401 or a Meta `error` object has no status field, so it classifies as waiting and the post is deferred for 30 minutes. | `metaContainerStatus.ts` `pollContainer` (no `response.ok` or `data.error` check). The Instagram pollers do throw on `data.error`, but treat a 5xx or a transient Meta code as fatal and ignore a non-OK answer with no `error` object. | A non-OK answer or a Meta `error` object is `failed` with Meta's message, except 5xx, 408, 429, `is_transient` and Meta's transient codes, which stay retryable like a network error. The Instagram pollers get this by sharing `pollContainer`. |
| F3 | **Streamed URL uploads lose their checks.** A byte-count mismatch in the Openinary stream is only a provider error; the provider loop then hands the URL to Cloudinary, which imports it with no declared-length or admin-cap check. Openinary (45 s) then Cloudinary (60 s) in sequence exceed the 60 s worker. | `cloudinary-upload/index.ts` 689–760 (`for (const provider of effectiveProviders)`; `uploadSource = externalUrl`). | The streamed path is Openinary-only: Cloudinary is dropped from both the attempted and the required providers for it, and an Openinary failure fails the whole upload with "The file could not be streamed to storage". Buffered (≤ 10 MB) uploads are unchanged. `streamProviders()` in `urlIngest.ts` is the tested rule. Runbook updated. |
| F4 | **2FA disable regressions.** (a) An unverified factor also gets the AAL2 step-up, though Supabase lets AAL1 unenroll it directly and the user may have no authenticator for it. (b) Every `verify` failure shows "invalid code". | `src/features/mfa/ui/useDisableMfa.ts` `requestDisable`, `submitCode` (`catch { setCodeError(...) }`). | `requestDisable` takes the factor and unenrolls an `unverified` one at once. The gateway's `verify` returns `invalid_code` only for GoTrue's `mfa_verification_failed` (present in `@supabase/auth-js` 2.108.2, the locked version, and 2.118.0); any other failure rejects, goes to `onError` and leaves the factor enrolled. |
| F5 | **Unauthenticated refusals write a service-role row.** | `media-direct-upload/index.ts` 269: `refuse(req, adminDb, null, …)` logs through `adminDb`. | Pass `null` as the admin client: console only. `refuse` already skips the write for `null`; a test pins it. |
| F6 | **The deferred pending row is not tenancy-checked in SQL.** `recordStillProcessing` inserts into `platform_posts` with the service role; only the caller pairs account and post. AGENTS.md forbids that; `partner_settle_platform_post` checks in SQL. | `process-post/deferredPublish.ts` `recordStillProcessing` (insert, ~145–155). | New `record_deferred_platform_post` (SECURITY DEFINER, service_role only, `search_path` pinned) inserts the pending row only when `social_accounts.user_id = posts.user_id`, else raises. `recordStillProcessing` calls it by `rpc`. Additive: the function is new and nothing calls it until the Edge Function deploys. |
| F7 | **A failed roll-up read drops notifications.** In a resumed run, `const { data: current } = …maybeSingle()` discards `error`; `current` is `null`, so `finalStatus = "processing"` and `notify = false`. The row is already settled, so the reconciler never returns to it. | `process-post/index.ts` 1924–1931. | `readPostOutcome` reads once, retries once, and distinguishes "not terminal" from "could not read". If the post row cannot be read but the rows can, terminal is derived the way the sweeper derives it (no pending row; any success means completed). If neither read works, an error row is written to `system_logs` (`unreadableOutcomeLog`) and nothing is announced for a post whose state is unknown; a lost notification always leaves that trace. The abandon response carries `post_status` and `notified`. |
| F8 | **A deferred post's notifications are partial or missing.** A resumed run reports only the account it resumed; the abandon path returns before Step 6, so no failure email or webhook is sent. | `process-post/index.ts` 1367–1378 (abandon return), 1924–1931 and Step 6. | When the post becomes terminal in a resumed or abandoned run, `platform_results`, `hasFailed` and the email list are built from all of the post's `platform_posts` rows (`summarizeRows`), and the abandon path runs the same notification step, now one helper used by the first run, the resumed run and the abandon path. |
| F9 | **A Facebook-login Instagram story is lost when the reel defers.** The story is published, its result sits in `igAllResults`, the reel throws `ContainerStillProcessing`, the result is dropped, and a resumed run skips the story. A later give-up fails the whole account while the story is live. | `postToInstagram` 3906–4039. | Mirror the Business-login path: once the story is published and more post types follow, write its own `platform_posts` row (`ig_post_subtype: "story"`, success) before the reel. A reel give-up then leaves a failed reel row beside a successful story row, and the post rolls up to `completed`. Story-only posts still return their result to the main loop. |
| F10 | **Plan Task 7 describes what did not ship** (HEAD preflight, `URL_INGEST_MAX_BYTES`, refusing a missing length). | `plans/2026-10-29-hardening-followups-plan.md` Task 7 vs spec C2 and `cloudinary-upload/urlIngest.ts`. | Rewrite Task 7 to match: no preflight, `STREAM_INGEST_MAX_BYTES`, bodies without a length buffered at 10 MB. |

## Deploy order

1. Apply `20261030090000_record_deferred_platform_post.sql` to production.
2. Merge; the Edge Functions Sync deploys `process-post`, `media-direct-upload`,
   `cloudinary-upload` and the shared modules.

Step 1 must come first: the new `process-post` calls the function, and a deferred first run
that cannot record its pending row is failed with "Safe to retry".

## Residual

- A user retrying an account whose reel gave up republishes its Instagram story.
- Recording a story is retried once; if the first attempt committed but its answer was lost, the
  retry writes a second story row.

## Round 2 — MergePilot on PR #302

| # | Fix |
|---|---|
| 1 | Every container wait takes `timing.deadlineMs`, not only deferrable ones (`ContainerWait`). Deferrability (`deferKind`) only picks between `ContainerStillProcessing` and "did not finish processing the media in time. Safe to retry." (`unfinishedError`). |
| 2 | The 3 s pause after FINISHED is cut to the time left (`bufferAfterFinishedMs`); a resumed run keeps it whole. |
| 3 | `MFASection` lists unverified factors under "Unfinished setup" with a Remove that uses the no-code path. |
| 4 | The final webhook keeps the `platform_results` map (a success speaks for a platform with several rows) and adds `platform_results_list`, one entry per row (`buildWebhookResults`). The n8n templates in `public/` read the map with `Object.entries`; the webhook guide now shows the real payload. |
| 5 | `writeLogRow` checks the `{ error }` the client returns. |
| 6 | `claimFinalNotification`: a compare-and-set on `posts.metadata.final_notified_at` (the shape of `claimPostForProcessing`; PostgREST `metadata->>final_notified_at=is.null` / `=eq.<old>`, no migration). The marker is a timestamp compared with `processing_started_at`, so a retried post is announced again. All three paths go through `announceFinalPost`; a claim that cannot be made sends anyway. |
| 7 | Stories recorded in a run join `platformResults` and set `hasSuccess` (`finally` in the account loop), so a reel that fails outright leaves the post `completed`. |
| 8 | Recording is retried once. If it still fails and the reel defers, the story rides on the pending row as `response_data.unrecorded_story`; a resumed run records it first, an abandoning run records it before giving the reel up. |
