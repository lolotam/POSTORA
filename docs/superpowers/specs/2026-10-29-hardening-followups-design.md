# Upload, publishing and 2FA follow-ups — design

Status: approved by the owner on 2026-10-29 ("collect all the needed tasks in one spec and one
implementation plan and start task by task"). Branch: `fix/hardening-followups`.
Supersedes `2026-10-29-mfa-disable-aal2-design.md` (PR #299), which is folded in as Part D.

One spec for four groups of work, each traced to evidence:

| Part | What | Where it came from |
|---|---|---|
| A | Harden the browser-direct upload | Codex and MergePilot review of #295 (posted after merge) |
| B | Stop video posts getting stuck in "processing" and record Instagram's reason | Investigation of handasa10@gmail.com, 2026-10-29 |
| C | Let the API/MCP upload larger files by URL | Same investigation: 4 MCP uploads refused at 10 MB |
| D | Disabling 2FA fails with "AAL2 required to unenroll verified factor" | Owner report, 2026-10-29 |

---

## Part A — browser-direct upload hardening

Code: `supabase/functions/media-direct-upload/` and `src/features/media-upload/`.

| # | Problem | Evidence | Fix |
|---|---|---|---|
| A1 | **Cloudinary metadata is trusted from the browser.** The signature covers only `public_id` and `version`, yet `complete` stores the browser's `secure_url` and `bytes`. A user can register any URL, which `process-post` later fetches server-side. | `index.ts` (complete → `cloudinary = result`), `register.ts` | After the signature check, read the asset from the Cloudinary Admin API (`GET /resources/{type}/upload/{public_id}`, basic auth, 15 s timeout). Store its `secure_url`, `bytes`, `format`, size and duration. Refuse if `bytes` exceeds the session's cap. |
| A2 | **`overwrite=true` lets a signed target replace the object after it was verified**, for about an hour. | `providers.ts` (`cloudinaryUploadTarget`) | Sign with `overwrite=false`. A retry of the same public id then returns the existing asset instead of replacing it. |
| A3 | **Quota bypass:** `start` → upload → never `complete` stores files that never count against the daily quota. Exploitable now through Openinary. | `index.ts` (quota is only checked at `start`, charged at insert) | Rate-limit `start` per user (`checkUserRateLimit`, 30 per hour). A full quota reservation (pending row plus clean-up job) is out of scope; see "Later". |
| A4 | **A failed duplicate lookup reads as "no row"** (AGENTS.md rule 3). A retried `complete` can insert twice, or `quotaInsertRefusal` can delete an object an earlier row uses. | `register.ts` (`const { data: existing }` ignores `error`) | On a lookup error, return 503 retryable before any insert or clean-up. |
| A5 | **The limits read fails open:** a read error falls back to 20/500 even when the admin chose less. | `index.ts` `readUploadLimits` | A read error returns 503 retryable. Defaults apply only when the row is genuinely absent. |
| A6 | **Refusals leave no log row** (AGENTS.md rule 4): type, size, quota, session and provider refusals only `console.warn`. | `index.ts` | Every refusal writes a `system_logs` row through `logToDatabase` (source `media-direct-upload`, user id, reason; never signatures or tokens). |
| A7 | **No body cap:** `req.json()` reads any size before Zod. | `index.ts` | Use `readJsonBodyCapped(req, 64 KiB)`; over the cap → 413. |
| A8 | **A lost provider-row insert is never repaired:** a retried `complete` returns the existing library row as is. | `register.ts` | Upsert provider rows on `(media_file_id, provider, object_version)`, for new and existing rows alike. |
| A9 | **The admin editor can save the fallback:** while the limits load or fail, the editor shows 20/500, and Save would overwrite the real values. | `MediaUploadLimitsSettings.tsx`, `useMediaUploadLimits` | Expose loading and error state. Disable the selects and Save until the row has loaded; show an error with a retry link on failure. |
| A10 | **Cloudinary's signature can expire behind a long Openinary leg** when both providers are on. | `directUpload.ts` (targets uploaded one after another) | Upload to all targets in parallel; progress is the mean of their fractions. |

Not changed: the "secret detected" finding (a test constant, `"test-secret"`), and the stale
docs (fixed in #297).

## Part B — publishing reliability (Instagram / Threads video)

Code: `supabase/functions/process-post/index.ts` (line numbers as of `1911529`).

**What happens today.** `claimPostForProcessing` sets `posts.status = 'processing'`. Accounts are
then published one after another (≈1622), and `posts.status` is written once, at the end
(≈1830). Instagram and Threads video wait for Meta's container inside the worker:

| Poller | Where | Budget | Asks Meta for |
|---|---|---|---|
| `pollContainerStatus` (Facebook-login IG) | ≈3324 | 60 × 2 s ≈ 120 s, then publish retries ≈ 30 s | `status_code` only |
| `pollBusinessLoginContainerStatus` (IG Business Login) | ≈4142 | 30 × 2 s, raw `fetch`, no timeout | `status_code` only |
| Threads loop in `postToThreads` | ≈6021 | 15 × 2 s, raw `fetch` | `status` only |

The edge worker has a 60 s wall clock. A reel that Meta processes for longer gets the worker
killed mid-poll: no `platform_posts` row is written, the final update never runs, and the post
stays `processing` for good. Nothing re-picks it — `process-scheduled-posts` selects only
`pending`/`scheduled`, and no reconciler or stale sweeper exists. This is exactly what
handasa10's `95f26127`, `c92c20cf` and `3bac400d` show (the last was in fact published).

| # | Problem | Fix |
|---|---|---|
| B1 | **Meta's reason is never recorded.** On `ERROR` the IG pollers throw `Container failed with status: ERROR`; Meta's explanation sits in the `status` field, which is never requested. | Request `fields=status_code,status` in both IG pollers (Threads: `status,error_message`). On `ERROR`/`EXPIRED` the thrown message carries Meta's text, so it lands in `platform_posts.error_message` and the log. |
| B3 | **Threads publishes a failed container.** The `throw` on `status === "ERROR"` (≈6039) is inside the `try` whose `catch` (≈6045) swallows it; after 15 attempts the code publishes anyway. | A shared pure classifier (`FINISHED` → publish, `ERROR`/`EXPIRED` → fail with reason, otherwise → keep waiting). Only network errors are retried; `ERROR` leaves the loop. Running out of budget never publishes blindly — it defers (B2). |
| B2 | **The worker waits for Meta inside its 60 s.** | *Deferred completion.* Polling inside the worker is bounded by the time left (stop with ≈15 s spare). A container still `IN_PROGRESS` is handed off: a `platform_posts` row with status `pending` and `response_data.deferred = { kind, container_id, social_account_id, api: "fb_login" \| "business_login" \| "threads", post_publish options, attempts, give_up_at }`. The post stays `processing`, exactly as the TikTok `pending` row already does (≈1731). A new cron function `reconcile-deferred-publishes` (every minute) polls each due row once, publishes on `FINISHED`, runs the same post-publish steps (permalink, first comment, comment toggle, story mirror — extracted into one shared helper), and settles through `partner_settle_platform_post`, which rolls the parent up. `ERROR` settles `failed` with Meta's reason; passing `give_up_at` (30 min) settles `failed` "Instagram did not finish processing the video in time. Safe to retry." |
| B2b | **Safety net.** A post can still be stranded by a crash before any row is written. | The same cron sweeps posts `processing` for over 20 min with no `pending` row: each selected account without a row gets a `failed` row "Publishing was interrupted before it finished. Safe to retry.", settled through the RPC. The age comes from a new `posts.processing_started_at`, set by `claimPostForProcessing` (a column, not `updated_at`, so unrelated edits never reset the clock). Each sweep writes a `system_logs` row. |
| B4 | **`3bac400d` (smartenergykw) is published on Instagram but still `processing`.** | Operational, needs the owner's go-ahead: read the IG media id from the Graph API, write a `success` row through the RPC. Not code. |

Scope of B2: video/reel containers (Facebook-login and Business-login) and Threads containers.
Images and carousels finish in seconds and keep the in-worker wait, now bounded by the same
budget (an over-budget image also defers instead of being killed).

Not changed: `process-scheduled-posts` still never re-picks `processing`; the reconciler, not a
re-run of the whole post, finishes the deferred account, so already-published accounts are
never posted twice.

## Part C — larger uploads through the API and MCP

Code: `supabase/functions/cloudinary-upload/index.ts`, `n8n-api/index.ts`, `mcp/index.ts`.

**What happens today.** MCP `upload_media` → n8n-api `POST /api/v1/upload-media` →
`cloudinary-upload` with `{ externalUrl, userId }` (service role). That branch downloads the
whole URL into the worker first (`readCappedBytes`, cap `MEDIA_DECODED_BYTE_CAP` = 10 MB),
even when Cloudinary — which fetches the URL itself — is the only provider. handasa10's four
refused uploads (00:19–00:21) were this cap. The browser path already goes to 20 MB / 500 MB
(admin-set) because it uploads straight to the provider.

**Provider status (owner, 2026-10-29):** the Cloudinary account is blocked until a paid plan
exists (free quota used up). Openinary is the main store for every asset, and `cdn_storage` is
Openinary-only, so C3 is the leg that matters now; C4 keeps working the day Cloudinary returns.

| # | Fix |
|---|---|
| C1 | **Cap from the admin limits.** The URL branch reads `media_upload_limits` (same reader as `media-direct-upload`, same fail-closed rule as A5) and caps at `directUploadByteCap(kind, limits)`, further limited to `URL_INGEST_MAX_BYTES` = 95 MB while Openinary sits behind Cloudflare's 100 MB request cap. The refusal names the limit that applied. |
| C2 | **Preflight before any byte moves.** SSRF-checked `HEAD` (redirects followed through `safeFetchExternal`); a missing or over-cap `Content-Length` is refused up front with a clear message. The streamed body is still counted, so a lying header aborts at the cap. |
| C3 | **Stream to Openinary instead of buffering.** The GET body is piped into a streamed multipart request (`folder`, `files`) to Openinary's `/api/upload`, with the same adopt-before-upload and collision checks as `storeOpeninaryObject`. Memory stays flat; the whole leg is bounded to ≈45 s, after which the upload fails "too slow to fetch; upload the file from the browser instead". |
| C4 | **Cloudinary gets the URL, never the bytes.** When Cloudinary is enabled it is handed the URL (as today) and its upload `fetch` gets a 60 s timeout. With Openinary off, the worker no longer downloads the file at all. |
| C5 | **Base64 stays at 10 MB.** A JSON body cannot carry more through the worker. The MCP tool and API docs say: over 10 MB, pass `media_url`. |

---

## Part D — disabling 2FA (AAL2)

Folded in from PR #299, unchanged in substance.

- **Evidence:** both disable buttons call `supabase.auth.mfa.unenroll({ factorId })` directly
  (`SecuritySection.handleUnenrollMfa`, `MFASection.handleUnenroll`). Supabase only removes a
  **verified** factor from an **AAL2** session
  ([reference](https://supabase.com/docs/reference/kotlin/auth-mfa-unenroll)), so an AAL1
  session gets exactly the error users see.
- **Fix:** one shared step-up used by both buttons.
  1. Read `getAuthenticatorAssuranceLevel()`. At `aal2`, unenroll directly.
  2. Otherwise ask for the 6-digit code and call `challengeAndVerify`.
  3. Unenroll, then `refreshSession()` so the session drops back to AAL1 at once.
  4. A wrong code removes nothing. A user who lost the authenticator keeps the existing
     backup-code recovery path.

## Later (not in this branch)

- Full quota reservation for direct uploads: a pending row at `start`, finalised at
  `complete`, and expired by a clean-up job.
- Streaming the large-video publishers (Facebook, LinkedIn, Pinterest, TikTok, X, YouTube)
  that load the whole file into the worker.
