# Upload, publishing and 2FA follow-ups — implementation plan

Spec: `docs/superpowers/specs/2026-10-29-hardening-followups-design.md`.
Branch: `fix/hardening-followups` (from `main` at `1911529`). One task = one local commit, scoped
with `git commit -- <files>`. Required reading for every task: `ARCHITECTURE.md` (layering,
Edge Function shape) and `AGENTS.md` rules 3 (a failed read never looks empty) and 4 (every
refusal writes a log row).

Checks run before each commit, as relevant to the files touched:

- Frontend: `npx vitest run <changed tests>`, `npx tsc --noEmit -p tsconfig.app.json`, `npx eslint <files>`, the lint/i18n gate script.
- Edge: `deno test` for the changed function's tests (import map + `--node-modules-dir=none`), `deno check` on the entry point.
- SQL: the migration's SQL suite against a scratch Postgres.

Order goes from smallest blast radius to largest. Migrations are applied to production **before**
the PR merges, because the Edge Functions Sync deploys code from `main` within two minutes and
does not run migrations.

---

## Task 1 — Part D: disable 2FA with an AAL2 step-up

Files: `src/features/mfa/{infrastructure/mfaGateway.ts, ui/useDisableMfa.ts, ui/DisableMfaDialog.tsx, index.ts}`,
`src/components/settings/SecuritySection.tsx`, `src/components/profile/MFASection.tsx`,
`src/i18n/locales/ar/accounts.json` (English is the inline default; there is no `en` locale), tests under `src/features/mfa/__tests__/`.

1. Gateway, hook and dialog (written). Both disable buttons call `requestDisable`.
2. Tests for `useDisableMfa` with a fake gateway:
   - at `aal2` → `unenroll` then `refreshSession` then `onDisabled`; no dialog;
   - at `aal1` → `pendingFactorId` set, nothing removed;
   - right code → `verify`, `unenroll`, `refreshSession`, `onDisabled`, dialog closes;
   - wrong code → `codeError` set, `unenroll` never called, dialog stays open;
   - `refreshSession` rejecting still calls `onDisabled`;
   - `unenroll` failing → `onError`, dialog closes.
3. Dialog test: Submit disabled until 6 digits, non-digits stripped, `codeError` shown with `role="alert"`.
4. Every key the dialog uses exists in `ar/accounts.json` (the i18n gate checks this).
5. Commit: `fix(auth): step up to AAL2 before disabling 2FA`.

## Task 2 — Part A, server quick fixes (A3–A8)

Files: `supabase/functions/media-direct-upload/{index,register}.ts` and their tests.

1. **A7** `readJsonBodyCapped(req, 64 * 1024)`; over the cap → 413 `body_too_large`.
2. **A5** `readUploadLimits`: an error → 503 `limits_unavailable` (retryable); defaults only when the row is absent.
3. **A4** `register.ts`: a duplicate-lookup error → 503 before any insert or provider clean-up.
4. **A8** provider rows upserted on `(media_file_id, provider, object_version)` for new and existing library rows. First confirm the unique index exists in the migrations; if not, add it in a migration with a duplicate check first.
5. **A6** every refusal path writes `logToDatabase({ source: "media-direct-upload", user_id, reason, ... })` — never signatures, tokens or URLs with query strings.
6. **A3** `start` rate-limited per user with `checkUserRateLimit` (30 per hour) → 429 with `Retry-After`.
7. Tests: one per refusal (status, body, log row written), lookup-error and limits-error paths return 503 and write nothing, a retried `complete` repairs a missing provider row.
8. Commit: `fix(media): fail closed and log refusals in direct upload`.

## Task 3 — Part A, Cloudinary trust (A1, A2)

Files: `media-direct-upload/{providers,index,register}.ts`, `cloudinary-upload/index.ts` (the
signed parameter list must stay identical across both paths), tests.

1. **A2** sign with `overwrite=false` in both the direct target and `cloudinary-upload`; update the signature tests.
2. **A1** after the signature check, `GET /v1_1/{cloud}/resources/{type}/upload/{public_id}` with basic auth and a 15 s timeout. Store its `secure_url`, `bytes`, `format`, `width`, `height`, `duration`; ignore the browser's. Refuse when the asset is missing, its version differs, or `bytes` exceeds the session cap (log row per A6).
3. Tests with a fake fetcher: forged `secure_url` is ignored; oversize refused; Admin API 404/timeout → 502 retryable.
4. Commit: `fix(media): verify Cloudinary uploads server-side`.

## Task 4 — Part A, client (A9, A10)

Files: `src/features/media-upload/{ui/useMediaUploadLimits.ts, infrastructure/directUpload.ts, infrastructure/providerUploads.ts}`,
`src/components/admin/settings/MediaUploadLimitsSettings.tsx`, tests, locale files.

1. **A9** the hook exposes `isLoading`/`isError`/`refetch`; the editor disables the selects and Save until loaded, and shows an error with Retry.
2. **A10** targets uploaded with `Promise.all`; progress = mean of fractions; a failed leg still lets the others finish (as today, `complete` keeps whichever copy landed).
3. Tests: Save disabled while loading and on error; two targets run concurrently (fake XHR); progress mean.
4. Commit: `fix(media): guard the limits editor and upload targets in parallel`.

## Task 5 — Part B1 + B3: container status with Meta's reason

Files: new `supabase/functions/_shared/metaContainerStatus.ts` (+ test), `process-post/index.ts`.

1. Pure `classifyContainerStatus({ status_code?, status?, error_message? })` → `{ state: "finished" | "failed" | "waiting", reason? }`.
2. Both IG pollers request `fields=status_code,status`; the Threads loop requests `status,error_message`. All three use the classifier; a `failed` state throws `Container failed (ERROR): <Meta's reason>`.
3. Threads: `ERROR` leaves the loop; budget exhaustion no longer publishes (until Task 6 lands it fails with "Threads did not finish processing in time. Safe to retry.").
4. The Business-login poller and publish switch to `fetchWithTimeout` (15 s).
5. Tests: classifier table; a Threads `ERROR` never reaches `threads_publish` (fake fetch).
6. Commit: `fix(publish): record Meta's container error and stop publishing failed Threads containers`.

## Task 6 — Part B2: deferred completion and stale sweeper

Files: migration `2026103xxxxxxx_deferred_publishes.sql` (+ SQL suite), `_shared/postProcessingClaim.ts`,
new `process-post/deferredPublish.ts` (+ test), `process-post/index.ts`, new function
`supabase/functions/reconcile-deferred-publishes/` (+ test), cron registration in the migration.

1. Migration: `posts.processing_started_at timestamptz`; a partial index on `platform_posts (created_at) WHERE status = 'pending'`; `cron.schedule('reconcile-deferred-publishes', '* * * * *', …)` calling the function with the service key, same pattern as `process-scheduled-posts`.
2. `claimPostForProcessing` also sets `processing_started_at = now()`.
3. `process-post/deferredPublish.ts`: the `deferred` payload schema, the poll deadline, and `recordStillProcessing` (pending row on a first run; recheck or give up on a resumed one).
4. process-post: the pollers take the budget; on exhaustion with state `waiting` they return a `deferred` result. The main loop writes the `pending` row (as for TikTok), and the final status write keeps `processing` while any deferred row exists. Post-publish steps move into one helper used by both the inline and deferred paths.
5. reconcile-deferred-publishes: cron-secret auth, claims due rows through `claim_deferred_publishes` (`FOR UPDATE SKIP LOCKED`, so two runs never take one row), and calls process-post in resume mode for each, which reuses the handler's own publish and post-publish steps. Then `sweep_stale_processing_posts()`. A run that did anything, or failed, writes a `system_logs` row.
6. Tests: deferred row shape; reconciler finished → publish + settle success; failed → settle failed with reason; past deadline → failed; sweeper writes failed rows only for accounts without a row; a row claimed by one run is skipped by another.
7. Commit: `feat(publish): finish slow Instagram/Threads videos outside the worker`.

## Task 7 — Part C: larger API/MCP uploads by URL

Files: `cloudinary-upload/index.ts`, `cloudinary-upload/urlIngest.ts` (+ test),
`_shared/openinary.ts` (streamed upload), `n8n-api/index.ts` (message only), `mcp/index.ts`
(tool description). As shipped, matching spec C1–C5:

1. `urlIngest.ts`: `streamedSourceLength` (the `Content-Length` declared by the one
   SSRF-checked GET, when it is over 10 MB) and `streamIngestCap(kind, limits)` =
   `min(directUploadByteCap, STREAM_INGEST_MAX_BYTES)`, where `STREAM_INGEST_MAX_BYTES` is
   95 MB while Openinary sits behind Cloudflare's 100 MB request cap. There is **no preflight
   request**: the GET's headers pick the path, and above 10 MB only the first 4 KB are read
   (`readPrefix`) to tell the file's type before the stream is passed on.
2. A body up to 10 MB, or one that declares no length, is buffered as before and still capped
   at 10 MB (`readCappedBytes`). A missing length is not refused.
3. `uploadStreamToOpeninary` pipes the body into a streamed multipart request of exact
   `Content-Length`, counting bytes: a source that sends more or fewer than it declared fails
   the upload. It keeps adopt-before-upload and collision rules and is bounded to 45 s.
4. A streamed upload needs Openinary: with Openinary off, a URL over 10 MB is refused with a
   clear message. Cloudinary's upload `fetch` has a 60 s timeout.
5. Base64 stays at 10 MB; the MCP `upload_media` description says "over 10 MB, pass
   media_url".
6. Tests (`urlIngest.test.ts`, `openinaryStream.test.ts`): only a declared length over 10 MB
   streams; the cap is the admin limit held under 95 MB; the prefix and the rest add back up to
   the body; a source that sends more or fewer bytes than it declared fails the upload.
7. Commit: `feat(media): accept URL uploads up to the admin limit via streaming`.

## Task 8 — Wrap-up

1. `CLAUDE.md` Edge Functions table: add `reconcile-deferred-publishes`; runbook note in `docs/runbooks/large-media-uploads.md` for URL uploads and the 95 MB ceiling.
2. Guard pass (`clean-code-guard`, `test-guard`) over the branch diff.
3. Push, open a draft PR that supersedes #299, apply the Task 2/6 migrations to production before merge.
4. **B4** (needs the owner's go-ahead): mark `3bac400d` completed with its IG media id.
5. Final report.
