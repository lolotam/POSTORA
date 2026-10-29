# Email attachments and knowledge sources store in Openinary — design

Status: implementation spec, 2026-10-30. Branch `fix/openinary-email-knowledge`.

## Problem (proven in code)

The Cloudinary account (cloud `dur1soa8n`) has answered `401 cloud_name is disabled` since September 2026. Openinary is the main asset store. Two storage-only callers still talk to Cloudinary directly and therefore fail in production.

### Email attachments: broken

| Path | Evidence |
|---|---|
| Admin composes an email and attaches a file | `src/components/admin/inbox/EmailAttachments.tsx:57` invokes `cloudinary-email-upload`, whose upload branch calls `uploadToCloudinaryEmail` (`cloudinary-email-upload/index.ts:114`), which POSTs to `https://api.cloudinary.com/v1_1/<cloud>/auto/upload` (`_shared/cloudinary-email-helper.ts:50`) and throws on any non-2xx (`:57`). Every attachment upload now fails. |
| Removing an attachment | `index.ts:81` calls `deleteFromCloudinary` (`/image/destroy`, `helper:95`). It returns `false`, the function answers `200 {success:false}`, and the UI ignores it. |
| Inbound email attachments (Resend webhook) | `resend-webhook/index.ts:135-139,217` call the same helper. The per-attachment `catch` (`:239`) swallows the error, so the message is saved with no attachments and the webhook answers 200. |
| Inbound attachments (manual "fetch content") | `fetch-email-content/index.ts:57-61,127` — same helper, same swallow; the response reports `attachments: 0` and `success: true`. |

Two of these also read `CLOUDINARY_*` with `!`, so a deployment without those secrets passes `undefined` into the signature instead of failing clearly.

### Knowledge sources: no storage write goes to Cloudinary

- A knowledge file is uploaded by the browser straight into the private `ai-knowledge` Supabase bucket (`src/components/messaging/AiKnowledgeManager.tsx:336`); `ai-knowledge-ingest` never writes a source file.
- The graph export (`ai-knowledge-ingest/graphExports.ts`) already writes Openinary first, then Supabase storage, and reaches Cloudinary only as the last resort.
- Cloudinary remains only for legacy rows: `locateKnowledgeFile` still reads old `res.cloudinary.com/.../raw/upload/...` URLs (`_shared/knowledgeSourceFiles.ts:103`), and `deleteSourceFile` (`ai-knowledge-ingest/index.ts:343-365`) destroys one when its row is deleted. Both are explicitly out of scope (existing rows are not migrated, and reading them must not break). The delete is best-effort and a disabled cloud cannot block the row deletion, so it is left as is.

**Conclusion: the knowledge half needs no code change.** The task there is verification, recorded in the PR description.

`_shared/cloudinaryDestroy.ts` is not used by any of these paths.

## Design

One new shared module, `supabase/functions/_shared/emailAttachmentStorage.ts`. It does not touch `_shared/openinary.ts` or `cloudinary-upload/` (another PR owns them); it consumes `getOpeninaryConfig`, `uploadBytesToOpeninary`, `openinaryTarget` and `deleteFromOpeninary`.

### Provider choice

- `OPENINARY_SERVER_URL` and `OPENINARY_API_KEY` set: Openinary. If it fails, the call fails. There is no silent second attempt on Cloudinary.
- Openinary not configured, `CLOUDINARY_*` complete: the existing Cloudinary helper (legacy fallback only).
- Neither: an explicit `EmailAttachmentStorageError("no_provider")`.

The Library's `cdn_storage` write policy (`getCdnPolicy`) is deliberately not consulted. These are admin-inbox files, not Library media, and that setting defaults to "Openinary disabled" when unreadable, which would send an attachment to the dead provider on a transient read error.

### Types

Openinary accepts the media allow-list in `_shared/mediaTypes.ts` and refuses everything else (its own MIME check). Email attachments are arbitrary, so the extension is resolved through that allow-list first. An extension outside it (`exe`, `html`, `xml`, `ics`, ...) is refused with `unsupported_type` before any upload: Openinary would reject it, and hosting inbound active content (`html`, `svg`, `xml`) on the CDN origin would allow phishing pages. This is logged, and the attachment is reported as failed rather than silently dropped.

### Naming and idempotency

Openinary never overwrites: a second object of the same name is stored as `name (1).ext`, which the deterministic URL cannot reach, so `_shared/openinary.ts` treats it as a failure. Two attachments called `invoice.pdf` are common, so each object name is `<uniqueKey>-<sanitised-stem>`:

- inbound: `uniqueKey` is the Resend attachment id (index when missing). A webhook retry therefore recomputes the same path and `uploadBytesToOpeninary` adopts the stored object (path and byte count match) instead of duplicating it;
- outbound: `uniqueKey` is a fresh random id.

The folder is unchanged (`admin/email/inbound/<emailId>`, `admin/email/outbound/<date>`), nested under the configured `OPENINARY_FOLDER_PREFIX` as everywhere else.

### Response shapes and columns

Unchanged: `{url, publicId, filename, size, contentType}` from the upload action; `{success}` from delete (plus an additive `error` when it fails); attachment records `{id, filename, content_type, size, url, publicId}` in `admin_inbox_messages.attachments`. For an Openinary object `publicId` is the Openinary storage path (`<prefix>/admin/email/...`), which is exactly what the delete action needs; an old row's Cloudinary `publicId` still reads fine.

### Delete

`publicId` is accepted only inside `admin/email/outbound/` (with or without the Openinary prefix), as a path to a file, never a folder or a `..` path: Openinary's delete endpoint removes folders too. This also stops the compose window's "remove" on a forwarded attachment from deleting the original inbound file (it sets `publicId` to the inbound record's value; that was already possible on Cloudinary). An Openinary-prefixed id goes to Openinary, any other id to Cloudinary when configured. A refused or failed delete returns `{success:false, error}` and is logged.

### Failure visibility

- Upload endpoint: typed errors map to `415` (unsupported type), `503` (no provider), `502` (provider rejected), each with a clear message, and write a `system_logs` row.
- Inbound paths: a failed attachment writes a `system_logs` row (extension and error code only, never the file name or bytes) from both `resend-webhook` and `fetch-email-content`. `fetch-email-content` also counts failures (`fetchAndStoreAttachments` returns `{stored, failed}`) and adds `attachments_failed` to its response, so a manual refetch no longer reports a clean zero.

## Out of scope

Migrating existing Cloudinary-hosted attachment or knowledge rows; the legacy Cloudinary read and delete for knowledge sources; the forwarded-attachment size (`0`) and type placeholders in `ComposeEmail`; `cloudinary-upload/`, `_shared/openinary.ts`.

## Deploy

No migration, no new secret. Functions to redeploy: `cloudinary-email-upload`, `fetch-email-content`, `resend-webhook` (plus the new `_shared/emailAttachmentStorage.ts`). `OPENINARY_SERVER_URL` / `OPENINARY_API_KEY` must be present in the functions container, as they already are for `cloudinary-upload`.
