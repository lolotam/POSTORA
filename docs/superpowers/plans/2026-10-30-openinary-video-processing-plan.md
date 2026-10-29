# Plan: Openinary video processing

Spec: `docs/superpowers/specs/2026-10-30-openinary-video-processing-design.md`.

1. **Specs and plan** (this commit).
2. **Pure planning** `supabase/functions/_shared/openinaryVideoTransform.ts` + test.
   `OpeninaryVideoError`, `planCompress`, `planCrop`, `planTranscode`, centred-region check,
   even-dimension rounding, quality tiers, Cloudinary eager strings for the fallback.
   Tests first (table of crop regions: centred 9:16 on 16:9, off-centre, full frame, narrow
   vertical auto-upscale, target aspect mismatch, unknown dimensions; compress tiers; transcode
   presets).
3. **Delivery I/O** `supabase/functions/_shared/openinaryVideoDelivery.ts` + test with a fake
   `fetch` (200 direct, 202 then completed, 202 then error, deadline, non-200) and a local
   `Deno.serve` multipart server proving the streamed upload carries the exact bytes, the
   folder/name fields and an explicit `Content-Length`, plus adopt-before-upload and
   collision-as-failure.
4. **Library recording** `supabase/functions/_shared/derivedVideoMedia.ts` + test with a fake
   Supabase client: source resolution (provider row, `file_path` fallback, Cloudinary-only,
   Supabase-storage-only), row writes, quota refusal rolls the stored object back.
5. **Cloudinary fallback** `supabase/functions/_shared/cloudinaryVideoFallback.ts` + test
   (fake `fetch`: success, disabled cloud, other error).
6. **Handlers**: rewrite `process-video/index.ts` and `transcode-video/index.ts` as adapters.
   JWT identity, validation, typed error mapping, optional `source_dimensions` and `warnings`.
7. **Front-end**: `src/lib/functionInvokeError.ts` (+ Vitest) so the callers show the
   function's own message; wire into `VideoCompressor`, `MediaCropper`, `TikTokPreCheck`;
   `MediaCropper` and `VideoCompressor` send `source_dimensions` when known.
8. **Verify**: Deno tests of every touched file, `deno check` of both functions against the
   origin/main baseline (0 errors), Vitest for the front-end files, `eslint` on changed files
   against origin/main.
9. **Docs**: `API_REFERENCE.md` lines for the two functions only if behaviour wording is wrong.
