# Media Library: all files, retention, WhatsApp scheduling uploads — design

Status: approved by the owner on 2026-09-28. The work ships as four PRs, in the order A, B, C, D.

## Decisions (owner, 2026-09-28)

- **Storage:** Openinary only, the same as the Media Library today. A spike on 2026-09-28 uploaded a PDF, ZIP, DOCX, RAR and TXT. Each one was stored, was served back byte-exact with the correct Content-Type, and deleted cleanly. Openinary refused the EXE (`Invalid file type: application/x-msdownload`).
- **Allowed types:** Openinary's own allow-list, minus active content, minus types Openinary refuses.
  - Images: jpg/jpeg, png, gif, webp, avif, heic/heif, psd.
  - Video: mp4, mov, webm. `avi` was accepted by the old dropzone, but Openinary refuses it.
  - Audio: mp3, ogg, wav.
  - Documents: pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, md, json.
  - Archives: zip, rar, 7z, tar, gz.
  - Excluded: exe (Openinary refuses it), and html/htm/xml (hosted active content would allow phishing pages on the CDN domain).
- **Retention (PR B):**
  - A per-user setting: 7, 30 or 90 days, or never. The default is 30.
  - A file used by any post, including published history, or by a scheduled or in-flight WhatsApp message is never deleted.
  - Files that exist at rollout count their age from the rollout date, not their upload date.
- **WhatsApp scheduling (PR C):**
  - The dialog offers "Upload file" and "Choose from Library". An upload goes through the same Library path, so the file appears in the Library.
  - The message stores the `media_files` id, so retention can protect it.
  - The customer sees the original file name.
  - Cloud API accounts are warned or blocked for types Meta refuses; QR accounts can send any stored type.
  - EXE can never be sent, because it cannot be stored.
- **Scheduled views (PR D):** WhatsApp scheduled messages appear on `/scheduled` and `/calendar` alongside posts. Pending messages can be cancelled and rescheduled, and in-flight ones are locked.

## PR A — the Library handles every allowed file type, plus three bug fixes

### Proven bugs (evidence from production on 2026-09-28)

1. **Broken links for Openinary rows.** `src/pages/MediaLibrary.tsx` builds `publicUrl` only for `storage_bucket = 'cloudinary'`. Every other row goes through `supabase.storage.from("media").getPublicUrl(file_path)`. Production has 291 `openinary` rows, and all of them hold a full `https://openinary…/t/…` URL in `file_path`. Preview, copy link and download therefore get a broken URL. The fix is to use `resolveMediaPublicUrl` (`src/lib/mediaUrl.ts`), as `MediaLibraryPicker` already does.
2. **Openinary objects left behind on delete.** Single delete, bulk delete and `historyUtils` call `storage.from("media").remove([file_path])` for non-Cloudinary rows. For an Openinary row that call removes nothing, so the object stays on Openinary. The fix is `cloudinary-delete` with `mediaFileIds`, which already deletes across providers through `media_file_providers`. The function has to be called by id.
3. **Wrong `file_type` values.** `cloudinary-upload` inserts `file_type: fileType`, where `fileType` can be `"gif"` or `"raw"`. The table's CHECK allows only `image`, `video`, `audio` and `document`, and production has no gif rows at all. The fix maps `gif` to `image`, raw and document types to `document`, and audio to `audio`, and stores the true MIME type.

### Changes

- **One shared allow-list module** holds extension, MIME, kind (`image | video | audio | document | archive`), stored `file_type` (archives are stored as `document`), icon key and a WhatsApp-sendability flag. There are two copies: `src/lib/mediaTypes.ts` for the frontend and `supabase/functions/_shared/mediaTypes.ts` for the backend. A test asserts that the two copies match.
- **Upload function (`cloudinary-upload`):**
  - Accepts the new kinds and derives the MIME type from the allow-list.
  - Refuses any extension that is not on the list, with a clear error.
  - Sends documents, archives and audio to Openinary only (no Cloudinary attempt).
  - Stores `metadata.original_filename`, which it already does.
  - Enforces a per-kind size limit on the server, not only in the browser.
- **Upload UI (`MediaUploadDialog`):** the dropzone accepts the list, the hint text is updated, and per-kind limits are shown.
- **Library UI:**
  - Non-image and non-video cards show a type icon tile: coloured by kind, with the extension label and the original file name.
  - The preview dialog shows the icon, name, size and type, with Download, Copy link, and Open (for PDFs).
  - The filter gains Documents, Audio and Archives.
  - Image-only tools (background removal, image tools) are hidden for other kinds.
- **Bug fixes:** 1–3 above, each with a regression test.

### Out of scope for PR A

Retention (PR B), the dialog upload (PR C), `/scheduled` and `/calendar` (PR D), and the Cloudinary provider itself (the account is disabled).
