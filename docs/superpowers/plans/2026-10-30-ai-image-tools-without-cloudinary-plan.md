# AI image tools without Cloudinary — implementation plan

Spec: [2026-10-30-ai-image-tools-without-cloudinary-design.md](../specs/2026-10-30-ai-image-tools-without-cloudinary-design.md).
Branch: `fix/ai-image-tools-without-cloudinary`. Required reading: `ARCHITECTURE.md` §12-§17, §26, §40.

Every new module below has a named production consumer in the same change
(ARCHITECTURE.md §1 "Zero Dead Modules").

## Task 1 — provider selection (pure, tested)

`supabase/functions/_shared/aiImageProviders.ts`: `cloudinaryUsableForTransforms`,
`resolveUpscaleProvider`, `resolveBackgroundRemovalProvider`, unavailable-message constants.
Consumers: `upscale-image/index.ts`, `remove-background/index.ts`.
Tests `aiImageProviders.test.ts`: policy-driven (default policy, cloudinary listed, env missing,
openinary disabled fallback) and every row of the decision table.

## Task 2 — AtlasCloud client (one place for submit + poll)

`_shared/atlasCloudImage.ts`: `runAtlasImageModel` with injected fetch/sleep, per-request timeout,
bounded polling, failures classified (`rejected` 401/402 -> 503, `rate_limited`, `timeout`,
`failed`, `bad_response`). Replaces the inline submit/poll in `upscale-image`.
Tests `atlasCloudImage.test.ts` against a fake fetch: success after polling, 402, 401, 429,
failed status, timeout, malformed body, request body and bearer header.

## Task 3 — Openinary I/O for image bytes

`_shared/aiImageIo.ts`: `readImageInput` (JSON `image_url`/`image_base64`, data URI or raw,
multipart `file`; size cap; type sniff), `stageInput`, `fetchOutputBytes` (bounded),
`storeResult`, `discardStaged`, `pngSize`. Uses `_shared/openinary.ts` unchanged.
Tests `aiImageIo.test.ts` with a stubbed `fetch`: parsing variants, oversize, bad type, stage/
store/discard calls, store failure falls back.

## Task 4 — caller auth for `remove-background`

Keep the existing in-file `profiles.api_key` lookup untouched: `partner-api/d8Containment.test.ts`
pins exactly one such site per grandfathered file and fails any new file that has the shape, so it
must not be moved into `_shared/`. Add the browser path with the approved helper
`authenticateCaller` (`_shared/auth-helper.ts`) for non-`postora-` bearer tokens. `upscale-image`
auth is not touched.

## Task 5 — the two functions

Rewrite `upscale-image/index.ts` and `remove-background/index.ts` as thin adapters on Tasks 1-4,
keeping the Cloudinary branches for when the policy allows them. Check
`partner-api/d8Containment.test.ts` (it lists both files).

## Task 6 — front end

`src/components/media/image-tools/aiImageTools.ts` (`isCloudinaryTransformsAvailable`,
`runBackgroundRemoval`, `runUpscale`, failure reader) consumed by `ImageToolsDialog.tsx`,
`BackgroundRemovalDialog.tsx`, `options/UpscaleOptions.tsx`. Vitest `aiImageTools.test.ts`.
Arabic strings in `src/i18n/locales/ar/assets.json`; `npm run check:i18n`.

## Task 7 — docs

`RemoveBackgroundApi.tsx`, `UpscaleApi.tsx`, `n8n/ApiEndpointsSection.tsx`, `README.md`,
`API_REFERENCE.md`.

## Verification

- `deno test` on each new/changed test file; `deno check` on both functions vs `origin/main`.
- `npx vitest run` on touched front-end tests; `npx eslint` on changed files vs `origin/main`;
  `npm run check:i18n`; `npx tsc -p tsconfig.app.json --noEmit` error count vs `origin/main`.
- Not testable here: live AtlasCloud / Openinary calls. First production calls after deploy:
  `POST /functions/v1/remove-background` with a small PNG URL, then `POST /functions/v1/upscale-image`
  with `image_base64`; check the logs for `ai_image_job` events and that the URL is an Openinary `/t/` URL.
