# Large media uploads and admin-selectable size limits — design

Status: Part 1 built (PR #295, branch `feat/large-media-uploads`). Part 2 proposed, awaiting approval.

> Process note: Part 1 was implemented before this spec was written. This document records
> it after the fact so the design is reviewable, and Part 2 follows the normal order:
> spec → plan → approval → code.

## Problem

Image and video uploads stopped at 10 MB. Users assumed Cloudflare; the evidence says otherwise:

- `MEDIA_DECODED_BYTE_CAP = 10 MiB` and `MEDIA_JSON_BODY_BYTE_CAP = 14 MB` in
  `_shared/mediaTypes.ts` (mirrored in `src/lib/mediaTypes.ts`) are enforced in the browser
  (`MediaUploadDialog`, `ReplaceFileDialog`) and in `cloudinary-upload`.
- The browser sends the file as base64 JSON; `cloudinary-upload` decodes it in memory and
  forwards it. An edge worker has **150 MB of memory and a 60-second wall clock**
  (`workerTimeoutMs = 60_000`), so raising the constant cannot work.
- Cloudflare's own limit (100 MB per proxied request on Free/Pro) only matters near 100 MB.

## Part 1 — direct upload (built, PR #295)

Files over 10 MB never pass through an edge function.

```
browser ─start──▶ media-direct-upload ─▶ signed target per provider + HMAC session
browser ─bytes──▶ Openinary  POST /api/upload        (presigned, one request)
        ─bytes──▶ Cloudinary POST /{type}/upload     (signed, 20 MB chunks)
browser ─complete▶ media-direct-upload ─▶ confirm object ─▶ media_files + media_file_providers
```

- **Providers** come from the existing `cdn_storage` setting (Admin → Settings → CDN storage),
  Openinary first; Cloudinary is optional. Shared with `cloudinary-upload` via
  `cloudinary-upload/providerPolicy.ts`.
- **Trust:** size, object names and providers live only in the signed session. `complete`
  accepts an Openinary object only at the exact path and byte size, and a Cloudinary result
  only if its `signature` (SHA-1 of `public_id`+`version`+secret) matches.
- **Rows:** the same `media_files` / `media_file_providers` rows as the edge path; a retried
  `complete` returns the existing row (`metadata.direct_upload_id`).
- **Caps (hard-coded today):** image 20 MB, video 500 MB; other kinds stay at 10 MB.

## Part 2 — admin-selectable limits (proposed)

### Requirement

An admin picks, from drop-downs:

| Kind | Options (MB) | Default |
|---|---|---|
| Image | 10, 20, 50, 100 | 20 |
| Video | 100, 200, 500, 1000, 2000 | 500 |

The chosen values apply to every user immediately and are enforced on the server, not only in the UI.

### Storage

New `app_settings` row, key `media_upload_limits`:

```json
{ "image_max_mb": 20, "video_max_mb": 500 }
```

- **Writes:** admin only (existing `app_settings` admin write policy), from a new settings
  section.
- **Reads:** every signed-in browser needs the values to show the right limit and pick the
  path, so the key is added to the "Anyone can read public settings" allow-list. A new
  migration recreates that policy from its latest definition
  (`20260424154448_…sql`) plus the new key. The values are not sensitive.
- **Validation:** a value outside its option list (hand-edited row, old data) is ignored and
  the default used. One pure parser, `parseUploadLimits(value)`, in `mediaTypes.ts`, used by
  browser and server alike.

### Enforcement

- **Server (authoritative):** `media-direct-upload` `start` reads `media_upload_limits` with
  the admin client and passes it to `planDirectUpload`. Over the cap → 413
  `File exceeds the N MB limit`.
- **Browser (UX):** a `useMediaUploadLimits()` hook (React Query, feature-owned adapter under
  `src/features/media-upload/`) feeds `MediaUploadDialog` and `usePostForm`. While loading or
  on error it uses the defaults; the server still decides.
- **Unchanged:** files ≤ 10 MB keep the base64 path; audio, documents, archives, Replace
  File, scheduled WhatsApp media and the n8n/MCP API stay at 10 MB. With the image limit
  at 10 MB, no image takes the direct path.

### Admin UI

New section in `settingsCatalog.ts` ("Media upload limits", keywords: upload, size, video,
image, limit, MB) with two `Select`s and a Save button. Under the video select, a static
warning that the infrastructure must allow the chosen size:

- Openinary `MAX_FILE_SIZE_MB` ≥ the chosen video limit (default 50).
- Over 100 MB, the Openinary upload host must not be Cloudflare-proxied
  (`OPENINARY_UPLOAD_URL`).
- Cloudinary's plan caps (free: image 10 MB, video 100 MB). Over it the Cloudinary copy
  fails and Openinary still serves the file.

These cannot be read from Postora, so the UI warns rather than blocks.

### Risks of the 1000 / 2000 MB options

| Risk | Detail | Mitigation |
|---|---|---|
| Openinary memory | Its upload route calls `file.arrayBuffer()`, holding the whole file in RAM; default container limit 4 GB | Runbook: raise `DOCKER_MEMORY_LIMIT`, test 2 GB before offering it |
| Presign expiry | Openinary checks `expires` after the body arrives; max lifetime 1 hour. 2 GB needs ≥ ~4.5 Mbit/s upstream | Documented; Cloudinary path is chunked and unaffected |
| Publishing | Facebook, LinkedIn, Pinterest, TikTok, X and YouTube publishers in `process-post` load the whole video into a 150 MB worker | Known limit, separate change; Instagram/Threads pull by URL |
| Platform limits | Platforms cap video size themselves (e.g. Bluesky 50 MB) | Existing per-platform checks in the post form still run |

### Out of scope

Per-plan limits, limits for audio/documents, the Replace File dialog, streaming the
publishers.

### Testing

- Deno: `parseUploadLimits` (valid, out-of-list, missing, wrong type); `planDirectUpload`
  with custom limits at the boundary; `start` reading the setting.
- Vitest: hook fallback to defaults; dialog shows the admin's limit in its messages; the
  admin section saves the chosen values and offers only the listed options.
- Manual: set image 50 MB → a 30 MB image uploads; set video 100 MB → a 150 MB video is
  refused in the browser, and a forged `start` for 150 MB is refused with 413.

### Open question

Defaults: keep 20 MB / 500 MB (today's behaviour), or change?
