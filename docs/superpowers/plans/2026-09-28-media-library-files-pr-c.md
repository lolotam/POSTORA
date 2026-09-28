# PR C — upload and "choose from Library" in the Schedule Message dialog — plan

**Spec:** `docs/superpowers/specs/2026-09-28-media-library-files-design.md` (the WhatsApp scheduling decisions).

**Lanes:** Grok is out of credit, so a Claude subagent does both the code and the small migration (the fallback in memory). The Codex astra debate on this plan comes first.

## Behaviour
- The media section of `ScheduleMessageDialog` has three sources: **None**, **Upload file** and **Choose from Library**. The existing free-text https URL option stays as **Paste link**.
- **Upload:**
  - The file goes through the same path as the Library: `cloudinary-upload`, the shared allow-list, a 10 MiB cap, Openinary. It therefore appears in the Library straight away.
  - Use the same request shape as `MediaUploadDialog` (base64 `fileData`, `fileName`, `fileType` from the kind), and reuse its error extraction (`uploadErrors.ts`).
  - Quota: the same `canUploadMedia`/`incrementMediaUpload` checks as the Library dialog.
- **Choose from Library:** a picker that lists the user's own `media_files` of every allowed kind. It is not `MediaLibraryPicker`, which only allows postable files. It shows type tiles (`FileTypeTile`), the original name, search, and a kind filter. Selecting a file fills in the URL (`resolveMediaPublicUrl`), the media type and the original name.
- **Media type** is derived from the file's kind:
  - image → image;
  - video → video;
  - audio → audio;
  - document or archive → document.

  The user can no longer set it to something inconsistent.
- **Original name:** the customer sees it (`invoice.pdf`, not `postora_2026…`).
  - Migration: `whatsapp_scheduled_messages.media_filename text NULL` (idempotent), with a CHECK that it is at most 240 characters.
  - The dialog sends `media_filename`. The client guard allows it, since it only guards claim/status columns.
  - Sender (`whatsapp-scheduled-sender/handler.ts` `mediaInput`): a document uses `media_filename` when present, and otherwise keeps today's name from the URL. It is sanitised: no path separators, control characters stripped, 240 characters at most.
- **Per-account rules:**
  - Cloud API and coexistence accounts:
    - The file must be `whatsappCloud` in the allow-list (jpg/jpeg/png, mp4, mp3/ogg, pdf/doc(x)/xls(x)/ppt(x)/txt). Otherwise block with the message "WhatsApp Cloud API doesn't accept .<ext> files. Use a QR account or convert it."
    - Size limits: image 5 MB, video 16 MB, audio 16 MB, document 100 MB. The 10 MiB storage cap means only images and the 16 MB kinds can actually hit these.
  - QR accounts: any stored type is allowed.
  - Re-validate when the account changes.
- **Retention:** a pending scheduled message already protects its file through the reference map (`whatsapp_scheduled_messages.media_url` for pending, claimed and sending rows). Using a file sets `last_used_at` through the existing AFTER trigger. There is no retention SQL change, but the plan must confirm the url match covers the `resolveMediaPublicUrl` URL.
- The caption limit is 1024 characters and audio has no caption; both already exist.

## Tests
- Dialog (vitest):
  - Upload success fills the URL, type and filename, and the insert payload includes `media_filename`.
  - An upload refusal (a bad type) shows the backend message.
  - The Library picker lists documents and archives, and selecting one fills the fields.
  - A Cloud API account blocks zip and webp; a QR account allows them.
  - Switching the account re-validates.
- Sender (Deno): a document uses a sanitised `media_filename`; the URL name is the fallback.
- SQL suite: the `media_filename` column exists, the length CHECK holds, and an authenticated insert with `media_filename` passes the guard. Add these to `supabase/tests/whatsapp_scheduled_sender.sql`.

## Deploy
1. Migration first (`20261001110000_scheduled_media_filename.sql`).
2. `NOTIFY pgrst`.
3. Merge; the sender and frontend auto-deploy.

## Merge threshold

Blockers:
- a file uploaded outside the allow-list or over the cap;
- a Cloud API account allowed to schedule a type Meta refuses;
- the original filename breaking the send or allowing path injection;
- the scheduled row insert rejected for a valid owner;
- a file used by a pending message becoming eligible for retention.

Everything else is a follow-up.

## Debate revisions (Codex astra, 2026-09-28): these override the sections above

- **Four sources:** None, Upload, Library and Paste link. Paste link keeps today's behaviour (https + chosen type). On Cloud accounts a pasted link must have a path extension in the `whatsappCloud` list for the chosen type. A link without a known extension is allowed only on QR accounts. A Meta refusal at send time is already stored as `failed` with the provider message, never silent.
- **Provider:** "the existing Library provider policy". Audio, documents and archives go to Openinary only; images and video follow `cdn_storage`.
- **Upload:**
  - Accept the result only when `success && mediaFileId`.
  - One upload in flight, and the submit button stays disabled while uploading.
  - A stale completion (dialog closed or reopened, or a different file picked) is ignored, using an upload token.
  - Scheduling reuses the uploaded result and never re-uploads.
  - Quota: preflight plus increment once per upload attempt, as `MediaUploadDialog` does. Selecting from the Library never counts.
- **Library picker:**
  - Queries with `.eq("user_id", auth user id)` explicitly, so admins see only their own files there.
  - Keeps provider and version metadata for `resolveMediaPublicUrl`.
  - Stores the **untransformed** resolved URL, never a thumbnail URL.
- **Kind → message type:**
  - **Cloud:** only `whatsappCloud` files are allowed:
    - jpg/jpeg/png → image;
    - mp4 → video;
    - mp3/ogg → audio;
    - pdf/doc(x)/xls(x)/ppt(x)/txt → document.
  - **QR:**
    - native types: jpg/jpeg/png/gif/webp → image; mp4 → video; mp3/ogg → audio;
    - **everything else becomes `document`**, including psd, heic, heif, avif, mov, webm, wav, csv, md, json and archives.
  - Codecs are not validated. The dialog hint says "Video: MP4 (H.264/AAC). Audio: MP3 or OGG (Opus)."
- **Sizes (Cloud):** image ≤ 5 MB. Video, audio and document are within their limits because of the 10 MiB cap. Check the Library file's `file_size`; a pasted link's size is unknown and is left to the provider.
- **Filename, one shared policy:** `sanitizeMediaFilename(raw)`, identical in `src/lib` and `supabase/functions/_shared`, with a parity test.
  - Basename on both `/` and `\`. A URL is parsed and its last segment decoded once *before* sanitising.
  - Strip C0/C1 control characters (including NUL, CR and LF) and the bidi override and isolate characters U+202A–U+202E and U+2066–U+2069. Keep normal Unicode and Arabic.
  - Trim. Empty, `.` or `..` becomes `file`.
  - Shorten to 240 Unicode characters while keeping the extension.
  - Applied in the dialog before insert (the DB CHECK is ≤ 240), and again in the sender. The URL fallback uses it too.
- **Migration `20261001110000_scheduled_media_filename.sql`:**
  - `media_filename text NULL CHECK (char_length(media_filename) <= 240)`.
  - **Drop and recreate `claim_whatsapp_scheduled_messages`** with `media_filename` added to RETURNS TABLE and to the RETURNING list. Keep every other column, the logic, `SECURITY DEFINER`, the `search_path` and the grants (service_role only) identical to `20260930100000`, with scalar columns only.
- **Code path:** hook input and insert, `types.ts`, `ClaimedScheduledMessage`, and the sender's `mediaInput`, which uses `sanitizeMediaFilename(media_filename ?? url name)` for documents.
- **Tests (additions):**
  - an RPC round-trip of `media_filename` in the SQL suite;
  - names over 240 characters keep the extension;
  - hostile names (control characters, bidi, `..`, encoded separators) and an empty fallback;
  - the Cloud 5 MB image boundary;
  - QR psd/wav/zip become document;
  - pasted-link Cloud rules;
  - duplicate submit and a stale upload are ignored;
  - the Library picker is owner-scoped;
  - a stored URL equal to `file_path` or `delivery_url` is protected by retention (SQL suite).
- **Merge threshold:** "type" means the extension-level allow-list; codec incompatibility surfaces as a recorded send failure.
