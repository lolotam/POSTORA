# Large media uploads (images to 20 MB, video to 500 MB)

Files up to 10 MB still go through `cloudinary-upload` as base64. Larger images and
video go **straight from the browser to the storage provider**:

```
browser ──start──▶ media-direct-upload ──▶ signed target per provider (Settings → CDN storage)
browser ──bytes──▶ Openinary  /api/upload   (one multipart request, presigned)
        ──bytes──▶ Cloudinary /upload       (20 MB chunks, signed)
browser ──complete▶ media-direct-upload ──▶ confirms the object, writes media_files + media_file_providers
```

No bytes pass through an edge function: a worker has 150 MB of memory and 60 seconds.
The providers come from the same `cdn_storage` setting as every other upload (Admin →
Settings → CDN storage), Openinary first.

## One-time setup

### Openinary server (`OPENINARY_SERVER_URL`)

Set on the Openinary deployment and restart it:

| Variable | Value | Why |
|---|---|---|
| `API_SECRET` | a long random string | `POST /upload/sign` refuses to presign without it |
| `CORS_ORIGIN` | `https://postora.cloud,https://www.postora.cloud` | the browser posts to Openinary directly |
| `MAX_FILE_SIZE_MB` | `520` | Openinary's default is 50 MB |

Any reverse proxy in front of Openinary must accept a 520 MB body and a slow upload
(nginx `client_max_body_size 0` and long `proxy_*_timeout`, which Openinary's own
image ships with).

**Cloudflare:** a proxied (orange-cloud) hostname refuses any request body over 100 MB
on Free/Pro plans. Openinary takes a file in one request, so either keep the Openinary
hostname DNS-only, or add a DNS-only upload hostname that points at the same server and
set it as `OPENINARY_UPLOAD_URL` below. Reads keep using `OPENINARY_SERVER_URL`.

### Supabase functions env (optional)

| Variable | Value |
|---|---|
| `OPENINARY_UPLOAD_URL` | the DNS-only upload host, e.g. `https://upload.openinary.example`. Unset = `OPENINARY_SERVER_URL`. |

### Cloudinary

Cloudinary's plan caps the file size (on the free plan, video at 100 MB and images at
10 MB). Over the cap, the Cloudinary copy fails and is recorded as a failed provider
row; the Openinary copy still serves the file.

## Deploy

Copy these to the functions volume, then restart `functions`
(see [deploy-edge-function.md](deploy-edge-function.md)):

- `media-direct-upload/` (new)
- `cloudinary-upload/index.ts`, `cloudinary-upload/providerPolicy.ts`, `cloudinary-upload/objectNaming.ts`
- `_shared/mediaTypes.ts`

## Check it works

1. Upload a 50 MB `.mp4` in Media Library → Upload. The progress bar should move steadily.
2. In the browser's network tab: `media-direct-upload` (start), then a `POST …/api/upload`
   to Openinary, then `media-direct-upload` (complete) answering `success: true`.
3. The new `media_files` row has `metadata.direct_upload_id`, and its
   `media_file_providers` row for `openinary` is `ready`.

| Symptom | Cause |
|---|---|
| start answers 503 "Storage temporarily unavailable" | Openinary presign failed: `API_SECRET` unset, or the API key is wrong. Check the function log for `Openinary presign failed`. |
| Upload stops with "Network error while uploading" | CORS (`CORS_ORIGIN` lacks the app origin) or a proxy reset the body (Cloudflare 100 MB). |
| "openinary refused the upload: File size exceeds limit of 50MB" | `MAX_FILE_SIZE_MB` not raised. |
| "the file is larger than the server accepts" (413) | A proxy in front of Openinary caps the body. |

## Known limit: publishing

Uploading a 500 MB video does not yet mean every platform can publish it. Facebook,
LinkedIn, Pinterest, TikTok, X and YouTube publishers in `process-post` download the
whole video into the worker before sending it, so a large video can exhaust the
worker's memory there. Instagram and Threads pull the file from its URL and are not
affected.
