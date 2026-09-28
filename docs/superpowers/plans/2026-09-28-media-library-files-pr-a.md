# PR A — Media Library handles all files — implementation plan

**Spec:** `docs/superpowers/specs/2026-09-28-media-library-files-design.md` (the PR A section).
**Lane:** code goes to Grok 4.7 medium. There are no migrations: the `media_files.file_type` CHECK already allows `document` and `audio`.
**Global constraints:**
- `cloudinary-upload` keeps its request contract. Its 17 callers send `fileType` values of `image`, `video`, `gif` and `raw`, and all four must keep working.
- Never log a token, key or file contents. Match file style; read `ARCHITECTURE.md` first.

## Task 1 — shared allow-list

- Create `src/lib/mediaTypes.ts` and `supabase/functions/_shared/mediaTypes.ts`. Both hold the same table, keyed by lower-case extension:

  ```
  ext -> { mime, kind: "image"|"video"|"audio"|"document"|"archive",
           storedFileType: "image"|"video"|"audio"|"document",
           icon: "image"|"video"|"audio"|"pdf"|"word"|"excel"|"powerpoint"|"text"|"code"|"archive",
           maxBytes, whatsappCloud: boolean }
  ```

  The helpers are `mediaTypeForFileName(name)`, `mediaTypeForMime(mime)`, `acceptedExtensions()` and `dropzoneAccept()` (the react-dropzone accept map).
- The types and MIME values are the spec list:
  - jpg/jpeg `image/jpeg`, png, gif, webp, avif, heic, heif, psd `image/vnd.adobe.photoshop`
  - mp4 `video/mp4`, mov `video/quicktime`, webm
  - mp3 `audio/mpeg`, ogg `audio/ogg`, wav `audio/wav`
  - pdf `application/pdf`, doc `application/msword`, docx, xls `application/vnd.ms-excel`, xlsx, ppt `application/vnd.ms-powerpoint`, pptx, txt `text/plain`, csv `text/csv`, md `text/markdown`, json `application/json`
  - zip `application/zip`, rar `application/vnd.rar`, 7z `application/x-7z-compressed`, tar `application/x-tar`, gz `application/gzip`
- Size limits per kind: image 10 MB, video 100 MB, audio 16 MB, document 100 MB, archive 100 MB.
- `whatsappCloud` is true only for:
  - jpg, jpeg, png;
  - mp4;
  - mp3, ogg;
  - pdf, doc, docx, xls, xlsx, ppt, pptx, txt.
- Tests:
  - both copies are identical, checked by a Deno test that reads `src/lib/mediaTypes.ts` as text and compares the table;
  - exe, html, htm, xml and avi are refused;
  - lookups are case-insensitive;
  - gif maps to `storedFileType` image.

## Task 2 — `cloudinary-upload` (edge function)

- Accept `fileType` values of `image`, `video`, `gif`, `raw`, `document` and `audio`.
- Resolve the real type from the allow-list using the original file name, falling back to sniffed bytes or the content type.
- Refuse an unknown or excluded extension with a 400 and a clear error, and write one `system_logs` refusal row that holds no file contents.
- Enforce `maxBytes` on the server from the decoded length.
- Openinary upload MIME comes from the allow-list. Documents, archives and audio are never attempted on Cloudinary.
- `media_files` insert: `file_type` is set to `storedFileType`, fixing bug 3, and `mime_type` to the allow-list MIME. `metadata.original_filename` and `metadata.kind` (including `archive`) are kept.
- Tests are pure helper tests plus a handler test if the function can be split cheaply:
  - a gif is stored as image with MIME `image/gif`;
  - a pdf is stored as document with MIME `application/pdf` and never reaches Cloudinary;
  - an exe is refused with 400;
  - `raw` plus `x.csv` is stored as document with MIME `text/csv`.

## Task 3 — upload dialog

- `src/components/media/MediaUploadDialog.tsx`: the dropzone accept map is `dropzoneAccept()`, and each file is checked against its kind's limit.
- The hint lists the kinds and limits. The `fileType` sent is `video`, `audio` or `document` according to kind, and `image` for images (including gif).
- The dialog shows a clear per-file error for a refused type.

## Task 4 — Library rendering

- `src/pages/MediaLibrary.tsx`, `src/pages/media-library/*`: add a `FileTypeTile` component for non-image, non-video rows. It shows a lucide icon for the icon key, coloured by kind, plus the extension badge and `metadata.original_filename`.
- The tile is used in:
  - the grid card, list row and `MediaThumbnail`;
  - the preview dialog, which shows name, size and type, with Download, Copy link, and Open in a new tab for PDFs.
- Audio previews play in an `<audio>` element.
- The filter gains Documents, Audio and Archives. Archives are detected from `metadata.kind`, or from the extension for older rows.
- Image-only actions (image tools, background removal, replace-as-image) are hidden for other kinds.

## Task 5 — bug 1: public URL

- Build `publicUrl` with `resolveMediaPublicUrl` (`src/lib/mediaUrl.ts:153`) for every row, the same way `MediaLibraryPicker` does.
- Test: an Openinary row gets its https `file_path` URL, not a storage URL.

## Task 6 — bug 2: delete via providers

- Single delete, bulk delete and `src/hooks/history/historyUtils.ts` call `cloudinary-delete` with `{ mediaFileIds: [...] }` for every non-`media`-bucket row, then delete the rows.
- Only rows with `storage_bucket = 'media'` use `storage.remove`.
- Check `cloudinary-delete` authorises by owner. If it trusts ids without an ownership check, add `user_id` scoping, keeping the response contract.
- Tests:
  - an Openinary row triggers `cloudinary-delete` with its id;
  - a `media`-bucket row uses `storage.remove`;
  - bulk delete batches the ids.

## Gates

From `supabase/functions`:
- `deno test -A --no-check --node-modules-dir=none _shared/ cloudinary-upload/ cloudinary-delete/`
- `deno check --node-modules-dir=none cloudinary-upload/index.ts cloudinary-delete/index.ts`

From the repo root:
- `bun install --frozen-lockfile`
- `npx vitest run` (full suite)
- `tsc -p tsconfig.app.json`
- eslint on the changed files

Live check after deploy, on the admin account:
- upload a PDF, a ZIP and a GIF, and confirm the cards, download, copy link and preview work;
- delete one file and confirm the Openinary object is gone (GET returns 404).

## Debate revisions (Codex astra, 2026-09-28): these override the tasks above

- **Size cap is 10 MiB decoded for every kind, for now.**
  - Enforce a ~14 MiB JSON body cap while reading the request, before JSON parsing. Then check the encoded length before decoding, and the decoded length after.
  - The current transport is base64 in JSON on a 150 MB isolate.
  - Production evidence: no stored file exceeds 9.1 MB, so this cap removes nothing that works today.
  - External URL uploads align to the same cap.
  - Uploads up to 100 MB need a streaming or direct upload, which is a separate follow-up PR.
- **Extensions:**
  - A missing extension resolves from supported bytes or the content type. Keep this for the extensionless callers: admin identity logos, background removal, image tools, n8n.
  - An explicit excluded or unsupported extension is rejected.
  - Normalise URL pathnames (strip the query) before classifying.
  - Fix the n8n-api relay so it never produces `.bin` or other unknown suffixes for supported types.
- **Dedupe:**
  - Disable the filename+size dedupe for document, audio and archive kinds. It can return a different file as a successful upload.
  - Run validation before any dedupe return.
  - Store `metadata.original_filename` as the real basename, with Unicode and extension. Use it for display, search and the download filename.
- **Provider MIME:** `media_file_providers.mime_type` also comes from the allow-list, not from `image/...`.
- **Provider selection:** filter both the attempted and the required providers to Openinary for non-image and non-video kinds.
- **Upload dialog:**
  - The result model and rendering must support non-image and non-video results. They currently render as `<video>`.
  - Show dropzone rejections.
  - Extract backend refusal details from `FunctionsHttpError.context`.
  - Validate before charging quota.
- **Guards:** "Send to Post" and the post composer's `MediaLibraryPicker` must exclude or refuse document, audio and archive items. Posts only take image and video.
- **Delete (`cloudinary-delete` with `mediaFileIds`):**
  - Authorise each requested id explicitly against `media_files.user_id` (keep admin behaviour).
  - Reconcile the requested ids with the ids actually deleted, and report them per id.
  - Choose the Cloudinary resource type per row.
  - A row with no provider record is not "deleted".
  - Check provider status update errors.
  - The frontend deletes `media_files` rows only for ids confirmed deleted, and handles partial results and transport errors.
  - The legacy `publicIds` path resolves through authorised `media_files` rows before destroying anything.
- **Out of scope, recorded:** `ReplaceFileDialog` sends multipart to a JSON endpoint and deletes the old object first. It is broken today, and fixing it is a separate issue.
- **Tests (handler level, not only pure helpers):**
  - an extensionless upload resolves;
  - an unsupported or excluded extension is rejected;
  - two same-size, different documents are both stored;
  - partial delete;
  - mixed image and video delete;
  - a foreign id is refused;
  - a document is refused by the post picker;
  - an oversize body is rejected before parsing.
