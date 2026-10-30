# Openinary video processing (`process-video`, `transcode-video`)

Date: 2026-10-30. Status: implemented in `fix/openinary-video-processing`.

## Problem (proven in code)

The Cloudinary account (`dur1soa8n`) has been disabled since September 2026: every
Cloudinary API call answers 401 "cloud_name is disabled". Openinary is now the primary
store, but both video functions still work through Cloudinary only:

| Where (origin/main) | What it does | Why it fails in production |
| --- | --- | --- |
| `process-video/index.ts:8-10` | Reads `CLOUDINARY_*` with `!` | Function depends on a dead provider |
| `process-video/index.ts:72-105` | `getVideoMetadata` calls `api.cloudinary.com/.../resources/video/upload/{id}` | 401; also only works when `cloudinary_public_id` is set, which Openinary-only rows never have |
| `process-video/index.ts:140-291` | `processVideoWithCloudinary`: signed upload API with an `eager` transformation | 401 |
| `process-video/index.ts:360-365` | Builds a `res.cloudinary.com` source URL from `cloudinary_public_id` | Openinary-only rows fall through to `file_path` and are then handed to Cloudinary |
| `process-video/index.ts:403-423` | Records the result with `storage_bucket: "cloudinary"`, no `media_file_providers` row | Result is not stored where reads look |
| `process-video/index.ts:469` | Quota cleanup with `destroyCloudinary` | Cannot remove an Openinary object |
| `transcode-video/index.ts:28-109` | Same signed-upload-with-eager flow for TikTok/Instagram/YouTube presets | 401 |
| `transcode-video/index.ts:150-167` | Only `storage_bucket === "cloudinary"` is read directly; anything else goes through a Supabase signed URL then Cloudinary | Openinary rows (`storage_bucket = "openinary"`) take the Supabase-storage branch and fail |
| `transcode-video/index.ts:185-221` | Records result as Cloudinary (+ a `cloudinary` provider row) | Same as above |

Both also trusted `user_id` from the request body while using the service role
(ARCHITECTURE.md section 13/14); the rewrite derives identity from the JWT.

## Callers (front-end contract that must keep working)

* `src/components/post/VideoCompressor.tsx` invokes `process-video` with
  `{ media_file_id, user_id, operation: "compress", compress: { quality, maxSizeMB? } }`.
* `src/components/post/MediaCropper.tsx` invokes `process-video` with
  `{ media_file_id, user_id, operation: "crop", crop: { x, y, width, height, targetWidth?, targetHeight? } }`
  (x/y/width/height are percentages of the frame; the crop box can be dragged off centre).
* `src/components/post/TikTokPreCheck.tsx` invokes `transcode-video` with
  `{ media_file_id, user_id, target_platform: "tiktok" }`.
* All three read `success`, `error`, and `processed_url` / `transcoded_url` plus
  `new_media_file_id`. None calls `get_metadata`.
* All three do `if (invokeError) throw invokeError`, so a non-2xx reply surfaces as the
  generic "Edge Function returned a non-2xx status code" and the function's own message is
  lost. A small shared helper now reads the reply body (`src/lib/functionInvokeError.ts`).

## Openinary capabilities (read from docs.openinary.dev sources and `packages/core` on 2026-10-30)

Transform URL: `GET {server}/t/{k_v,k_v,...}/{path}`. Video keys: `w`, `h`, `c`
(`fill` `crop` `fit` `scale` `pad`, needs `w` or `h`), `q` (1-100; CRF = round(51 - q/100*33),
default 60), `so`, `eo`, `f` (`mp4` `webm` `mov` or an image format), `t`, `tt`.
Behaviour that shapes this design:

* H.264 (libx264, `ultrafast`, baseline profile, level 3.0) is fixed; audio is copied.
* Without explicit `w`/`h` the video is downscaled to 720p max.
* `c_fill`/`c_crop` with both `w` and `h` is "cover then **centre** crop" (`scale=..:force_original_aspect_ratio=increase,crop=w:h`). There are no `x`/`y` offsets and gravity is not applied to video.
* A variant that is not cached answers **202** `{status, statusUrl}`; poll `GET {server}{statusUrl}` until `completed`, then request the `/t/` URL again. Encoding is ~5-30 s; limits: 200 MB source, 5 minute FFmpeg timeout. Upload size cap defaults to 50 MB (`MAX_FILE_SIZE_MB`).
* Openinary has no bitrate cap, no `vc`, no remote-URL ingest (upload is multipart only).
* The video-info endpoint does not exist: no way to read width/height/duration.

## Transformation mapping

| Cloudinary (today) | Used by | Openinary | Result |
| --- | --- | --- | --- |
| `c_crop,x_,y_,w_,h_` pixel region | crop | `w_{cw},h_{ch},c_fill` when the region is **centred** and spans the **full width or full height** (what the aspect-ratio presets produce) | Supported, exact |
| same, region off centre or not full-span | crop | none (no offsets) | `UNSUPPORTED_CROP_REGION` (422) |
| `c_crop,fl_relative,...` (no metadata fallback) | crop | none | `SOURCE_DIMENSIONS_UNKNOWN` (422) when width/height are neither on the library row nor sent by the caller (`source_dimensions`) |
| `/c_scale,w_T,h_T` upscale after crop (cropped smaller than target) | crop | folded into one step: `w_{T},h_{T},c_fill` | Supported when region aspect is within 2 % of target aspect, else `UNSUPPORTED_CROP_TARGET` (422) |
| auto-upscale of narrow verticals (ratio < 0.7, width < 720) to 720 wide | crop | same single-step target | Supported |
| `vc_h264` | all | implicit | Supported (H.264 is the only codec) |
| `q_auto:best` / `good` / `eco` | transcode (best), crop (good), compress (by the quality slider: >= 80 best, >= 50 good, else eco) | `q_80` / `q_60` / `q_40` | Supported |
| `br_500k` / `1000k` / `2000k` (from `maxSizeMB`) | compress | none | Not applied; the output size is **checked** after encoding and a result above `maxSizeMB` fails with `TARGET_SIZE_NOT_REACHED` (nothing stored) |
| `f_mp4` | all | `f_mp4` | Supported |
| `c_fill,w_720,h_1280,ar_9:16,g_center` (tiktok) | transcode | `w_720,h_1280,c_fill,q_80,f_mp4` | Supported (`ar` is ignored for video, `g_center` is the default) |
| instagram `1080x1920`, youtube `1920x1080` | transcode | same shape | Supported |
| compress keeps source resolution | compress | `w_{W},h_{H},c_scale,q_..` (even dims) | Supported when dimensions are known; else Openinary's own 720p cap applies and the response carries a `warnings` entry |
| `get_metadata` (Cloudinary resource API) | none in repo | none (no probe) | Returns stored `media_files.metadata` width/height/duration when present, else `METADATA_UNAVAILABLE` |
| `destroyCloudinary` on quota refusal | both | `deleteFromOpeninary` | Supported |

A compress result that is not smaller than the source (`media_files.file_size`) fails with
`COMPRESSION_NOT_SMALLER`; a faster-preset H.264 re-encode can grow a file, and returning
it as "compressed" would be a fake success.

## Design

Pure logic in `supabase/functions/_shared/openinaryVideoTransform.ts`:
`planCompress`, `planCrop`, `planTranscode` return a transformation segment (or throw a typed
`OpeninaryVideoError` with a stable `code`, HTTP status and user-safe message).

I/O in `supabase/functions/_shared/openinaryVideoDelivery.ts`:
`fetchVideoVariant` requests the transformed URL, follows the 202/`statusUrl` protocol with a
bounded deadline (40 s of the 60 s wall clock; an expired deadline is the retryable
`TRANSFORM_STILL_PROCESSING`, and Openinary keeps the job so a retry is cheap), never fetches a
`statusUrl` that leaves the configured server, and returns the 200 response unread.
`ingestVariant` stores it as a new object without holding a large video in memory: a rendition of
a known size up to 16 MB goes through the production `uploadBytesToOpeninary` path (plain
FormData, adopt-before-upload, collision-as-failure); anything larger, or of unknown size, is
streamed into `POST /api/upload` as a hand-built chunked multipart body and cut off if it passes
`MAX_DERIVED_BYTES` (50 MB, Openinary's default upload cap). A name Openinary renamed to avoid a
collision, or a stored size that differs from the bytes sent, fails and the stray object is removed.

Library and DB recording in `supabase/functions/_shared/derivedVideoMedia.ts`:
`resolveVideoSource` (provider row `openinary`/`ready`, else the path of an Openinary
`file_path`; paths with dot segments or on another host are never used), `recordDerivedVideo` (`media_files` row `storage_bucket: "openinary"`,
`media_file_providers` row `openinary`/`ready`, same fields `media-direct-upload` writes) and
rollback of the stored object when the insert is refused (quota).

`_shared/videoDerivation.ts` is the use case both handlers call (load the owned video, resolve
the source, plan, fetch, check, ingest, record). Handlers stay adapters: CORS, JWT identity
(`_shared/videoCaller.ts` over `authenticateCaller`; a body `user_id` that is not the caller is
refused with 403, and a service-role bearer is refused because these are browser functions),
Zod validation (`request.ts`), the use case, and `_shared/videoErrorMapping.ts` for the reply.
Requests gain an optional `source_dimensions` (what the player reports, used only when the row
records no size); responses gain an optional `warnings` array. Both are additive.
Cloudinary is used only when the row has a `cloudinary_public_id` and no usable Openinary
object. Each plan therefore also carries the equivalent Cloudinary eager transformation string
(the strings the old code built, including the relative-crop form used when dimensions are
unknown), and `_shared/cloudinaryVideoFallback.ts` runs the one signed upload-with-eager call
both functions used to duplicate. A disabled cloud (401 "disabled") is reported as
`PROVIDER_UNAVAILABLE` instead of the raw provider message. The fallback no longer calls the
Cloudinary resource API for metadata.

Media that exists only in Supabase Storage (`transcode-video` used to hand a signed URL to
Cloudinary) cannot be served by Openinary and has no remote-fetch step any more: it fails with
`SOURCE_NOT_AVAILABLE`.

## Error contract

`{ success: false, error, error_code }` with a stable status. Codes (status): `INVALID_REQUEST`
(400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `MEDIA_NOT_FOUND` (404), `UNSUPPORTED_CROP_REGION`,
`UNSUPPORTED_CROP_TARGET`, `SOURCE_DIMENSIONS_UNKNOWN`, `SOURCE_NOT_AVAILABLE`, `SOURCE_TOO_LARGE`,
`RESULT_TOO_LARGE`, `TARGET_SIZE_NOT_REACHED`, `SIZE_NOT_VERIFIABLE`, `COMPRESSION_NOT_SMALLER`, `METADATA_UNAVAILABLE`
(all 422), `TRANSFORM_FAILED` and `STORE_FAILED` (502), `TRANSFORM_STILL_PROCESSING` and
`PROVIDER_UNAVAILABLE` (503), `MEDIA_QUOTA_DAILY_EXCEEDED` (429), `PROCESSING_ERROR` (500, the
only generic one; its cause is logged, never returned). Every refusal is also written to
`system_logs` with its code and no secrets.

Because supabase-js reduces any non-2xx reply to "Edge Function returned a non-2xx status code",
`src/lib/functionInvokeError.ts` reads the reply body and the three callers
(`VideoCompressor`, `MediaCropper`, `TikTokPreCheck`) show the function's own message.

## Not verifiable here

No live Openinary server and no access to docs.openinary.dev (blocked in this sandbox; the
grammar was read from the Openinary repository's docs sources and `packages/core` on
raw.githubusercontent.com). Covered only by fakes and a local Deno multipart server: the 202
flow against the real status endpoint, the chunked multipart upload against Openinary's
Hono/Node server, the deployed Openinary version matching `main`, baseline/level 3.0 H.264
output being accepted by TikTok/Instagram, and the browser's `fetch(processed_url)` of the new
Openinary URL (needs CORS on `/t/`).
