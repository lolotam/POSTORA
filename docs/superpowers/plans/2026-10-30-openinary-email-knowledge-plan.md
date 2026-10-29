# Email attachments and knowledge sources in Openinary — implementation plan

Spec: [2026-10-30-openinary-email-knowledge-design.md](../specs/2026-10-30-openinary-email-knowledge-design.md).
Branch: `fix/openinary-email-knowledge`. Required reading: `ARCHITECTURE.md` §1, §12–17, §26, §33, §36, §46.

Each task ends green: `deno test` for the files touched, `deno check` (no new errors against `origin/main`), `npx eslint` on changed files.

## Task 1 — `_shared/emailAttachmentStorage.ts` (+ test)

- Pure helpers: `resolveAttachmentType(filename, contentType)` over `mediaTypes.ts`, `attachmentObjectName(uniqueKey, filename)`, `parseDeletablePublicId(publicId, folderPrefix)`.
- `storeEmailAttachment(input, deps)` and `deleteEmailAttachment(publicId, deps)`: provider chosen as in the spec; dependencies (Openinary config, Cloudinary credentials, the four network functions) injected so the test fakes only the network boundary.
- `EmailAttachmentStorageError` with `code`: `no_provider | unsupported_type | provider_failed`.
- Tests: Openinary configured stores there and never calls Cloudinary, even when Openinary fails; Cloudinary only when Openinary is unconfigured; neither gives `no_provider`; unsupported extension refused before any call; same inbound id adopts, different ids with the same file name get different paths; delete refuses folders, `..`, inbound and foreign paths; delete routes by prefix.

## Task 2 — `cloudinary-email-upload/index.ts`

- Drop the unconditional `CLOUDINARY_*` reads; call the new module for upload and delete.
- Map errors to 415/503/502, log a `system_logs` row on failure, keep the success body identical, add `error` to a failed delete.

## Task 3 — `fetch-email-content` and `resend-webhook`

- Replace the Cloudinary block with `storeEmailAttachment` in both; each failure writes a `system_logs` row. `fetch-email-content` also returns `{stored, failed}` from `fetchAndStoreAttachments` and reports `attachments_failed`.
- No other behaviour changes: download, auth-retry and the saved attachment record are as before.

## Task 4 — verification

- Run the new test, every existing test in `_shared/` that imports a touched file, `deno check` on the three functions and the module, and eslint, comparing with `origin/main`.
- Knowledge sources: no code change (spec). Re-confirm by grep that no `cloudinary` write remains under `ai-knowledge-ingest/` or `_shared/knowledgeSourceFiles.ts` other than the legacy read and delete.
