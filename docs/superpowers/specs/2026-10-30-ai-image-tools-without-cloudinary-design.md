# AI image tools without Cloudinary — design spec

Status: root cause proven from code and the owner's account state; design agreed 2026-10-30.
Branch: `fix/ai-image-tools-without-cloudinary`.

## Symptom

Upscale and background removal fail for every user. The Cloudinary account (cloud
`dur1soa8n`) has been disabled since September 2026: every Cloudinary API call answers
401 "cloud_name is disabled", and stays that way until the owner buys a paid plan. The
credentials are still in the environment, so a "credentials present" check passes.

## Root cause (evidence, `origin/main`)

1. `supabase/functions/upscale-image/index.ts:92` defaults `platform` to `"cloudinary"`;
   the default branch (`:242-:317`) uploads to `api.cloudinary.com` (`:274`) and returns
   `e_upscale` delivery URLs. It is gated only on env presence (`:243`).
2. The AtlasCloud branch (`:102`) is reachable only when the caller asks for it, and a
   base64 input is staged **in Cloudinary** first (`:111-:146`), so Atlas upscaling of a
   pasted/uploaded image fails too. A missing key is a 500 (`:105`), not a 503.
3. `supabase/functions/remove-background/index.ts:66-:116` is Cloudinary-only
   (`background_removal=cloudinary_ai` add-on at `:88`, upload at `:99`), gated on env presence.
4. Neither function consults the admin CDN policy that the upload path uses
   (`cloudinary-upload/providerPolicy.ts` `getCdnPolicy` / `orderWriteProviders`, used at
   `cloudinary-upload/index.ts:616-:618`). Openinary is the main store; the policy default is
   Openinary only (`parseCdnPolicy`).
5. In-app callers never call `remove-background` at all. They build Cloudinary delivery URLs
   in the browser: `BackgroundRemovalDialog.tsx:110-:137` (`e_background_removal`),
   `image-tools/utils.ts:158-:160` and `ImageToolsDialog.tsx:524-:553`
   (`e_background_removal`, `e_upscale`). For a file that is not Cloudinary-stored they first
   stage it through `cloudinary-upload`, which now writes to Openinary and returns no
   `cloudName`, so the dialogs throw "Could not determine Cloudinary cloud name"
   (`ImageToolsDialog.tsx:339,:479`, `BackgroundRemovalDialog.tsx:222`). The Atlas upscale
   path in `ImageToolsDialog` hits that same throw before it reaches the function.
6. Openinary has no AI features (no background removal, no upscaling):
   https://docs.openinary.dev/cloudinary-comparison (as stated by the owner; the docs host
   is not reachable from the build sandbox).

## Decision 1 — "is Cloudinary usable?" is the admin CDN policy, not env presence

Server: `cloudinaryUsableForTransforms(policy, env)` in `_shared/aiImageProviders.ts` is
`orderWriteProviders(policy, { cloudinary: envPresent, openinaryConfigured }).includes("cloudinary")`.
That is exactly the rule the upload path uses to decide whether it writes to Cloudinary, so
the AI tools and uploads cannot disagree. With the default policy (Openinary only) and a
healthy Openinary, Cloudinary is *not* usable. A missing setting row behaves as on the upload
path (Cloudinary only as the fallback when it has credentials and Openinary is not enabled).
A *failed read* is the one place the tools are deliberately stricter than the upload path
(whose reader turns it into the default policy): the tools treat it as "not usable", so a
database blip sends a paid request to AtlasCloud rather than to a possibly disabled account.

Browser: `isCloudinaryTransformsAvailable(config)` is `write_policy.providers.includes("cloudinary")`
from the existing `useCdnConfig`. The browser does not know the server env, so it is the
policy half of the same rule; the server stays authoritative for the API.

## Decision 2 — providers

| Tool | Cloudinary usable | Cloudinary not usable |
|---|---|---|
| upscale (`platform` omitted, `"auto"` or unknown) | Cloudinary (unchanged) | AtlasCloud if `ATLASCLOUD_API_KEY` set, else 503 |
| upscale `platform: "atlascloud"` | AtlasCloud | AtlasCloud (503 if no key) |
| upscale `platform: "cloudinary"` | Cloudinary | AtlasCloud (logged fallback; response says `platform: "atlascloud"`) so existing API consumers keep working |
| remove-background | Cloudinary add-on (unchanged) | AtlasCloud if key set, else 503 |

### Background-removal provider research

Already integrated and configured: AtlasCloud (`ATLASCLOUD_API_KEY`, used by the upscaler),
OpenAI / Google AI Studio / OpenRouter / Anthropic (text and image *generation*), Higgsfield
(per-user OAuth through MCP, credit-reserving job pipeline in `generate-image`).

- Chat/vision LLM image generation (OpenAI, Google, OpenRouter) *regenerates* the picture
  and does not produce a faithful alpha cut-out: rejected.
- Higgsfield has a `remove_background` MCP tool, but it needs a per-user OAuth connection and
  the job/credit pipeline: not a public API-key endpoint, rejected.
- **AtlasCloud offers a dedicated model**: `midjourney/v8.2/remove-background` (also
  `midjourney/v8.1/remove-background`), "removes the background from the input image and
  returns one transparent-background result", one `image` input, $0.086 per image, async
  (submit, then poll the prediction). Model page:
  https://www.atlascloud.ai/models/midjourney/v8.2/remove-background (seen in search
  listings; the Atlas host is not reachable from the build sandbox, so the page body was
  not fetched). Request shape cross-checked against a third-party client of this exact
  model, https://raw.githubusercontent.com/atatogan/rembg/main/rembg/sessions/atlascloud.py:
  `POST https://api.atlascloud.ai/api/v1/model/generateImage` with
  `{ model, image, enable_base64_output: false }`, id at `data.id`, poll
  `GET /api/v1/model/prediction/{id}` until `data.outputs[0]`; `data.status` `failed` is an error.
  This is the same endpoint and polling contract the repo already uses for
  `atlascloud/image-upscaler`, with no new credentials.

Chosen: AtlasCloud, model id read from `ATLASCLOUD_BG_REMOVAL_MODEL`, default
`midjourney/v8.2/remove-background`, so a model deprecation is an env change, not a deploy.
**Not tested against the live Atlas API** (no network from the sandbox, and a call is paid).
The first production call is the real test; see the plan's verification section.

## Decision 3 — storage: results and staged inputs go to Openinary

- A base64 or uploaded file is staged to Openinary (`postora/<user>/ai-tmp/<uuid>`) so Atlas
  can fetch it by URL, and removed after the job (best effort).
- The provider's output is downloaded (size and time bounded) and stored in Openinary
  (`postora/<user>/upscaled|processed/<uuid>`); the response URL is the Openinary URL.
  If storing fails after a successful (paid) job, the provider's own output URL is returned
  instead, with a logged warning: the work is real, so it is not discarded.
- If a staged input is needed and Openinary is not configured: 503, logged.
- `_shared/openinary.ts` and `cloudinary-upload/` are imported, not edited.

## Decision 4 — errors

`{ success: false, error, code }`, logged with `event`, `operation`, `provider`, `user_id`.
- no usable provider: 503 `PROVIDER_UNAVAILABLE` ("Background removal is temporarily
  unavailable" / "Image upscaling is temporarily unavailable"). Never fake success.
- provider rejects our key or balance (401/402): 503 (operator problem, not the caller's
  credentials, so no 401 that would look like an expired session); detail only in the log.
- provider 429: 429. Timeout: 504. Other provider failure: 502. Oversized input: 413.
No raw provider text is sent to the client (ARCHITECTURE.md §16).

## Decision 5 — auth for `remove-background`

It accepts the `x-api-key` / `Bearer postora-…` key as before and now also a browser JWT,
like `upscale-image`, so the app can call it. The legacy key lookup stays in the file
(`partner-api/d8Containment.test.ts` pins one `profiles.api_key` site per grandfathered file
and rejects the shape anywhere new); the JWT path uses `_shared/auth-helper.ts`
`authenticateCaller`. `upscale-image` auth is untouched.

## Decision 6 — no request outlives ~45 s (added after review)

The functions run in a worker killed at 60 s behind a gateway with a 60 s upstream timeout, so a
slow paid job must not hold one request. Budgets are measured from the start of the request
(`_shared/aiImageJob.ts`): submit and poll until 32 s; everything (copying the result, cleanup)
by 44 s. Each provider call has a 10 s timeout, the output download is capped by the time left
(body included, streamed against a 40 MB limit), and a late finish returns the provider URL instead
of copying.

- Not finished in time: **202** `{success:true, status:"processing", prediction_id, retry_after_seconds, platform, ...}`.
  Nothing the result still needs is deleted (the staged input stays).
- `prediction_id` is an opaque signed token (`_shared/aiImageToken.ts`): base64url payload
  (provider prediction id, staged path, operation, result area, issue time, the values the
  response reports) plus an HMAC-SHA256 over `context + userId + payload`, keyed with the
  service-role key. Bound to the caller (another user's token verifies as forged), to the function
  (an upscale token is refused by remove-background) and valid for one hour. No table, no migration.
- Follow-up: the same function takes `{prediction_id}` (JSON or form field, no image), authenticates
  as usual, checks once and answers 202 again, or finishes (200, the normal body, staged input removed)
  or fails. A repeated follow-up is harmless: the result is stored under a name derived from the
  prediction id, so a second store adopts the first copy. A token past its hour answers 410, and its
  staged input is still removed. Follow-ups are not counted against the hourly cap.
- Unredeemed staged inputs (client never came back) stay in `postora/<user>/ai-tmp/`; they are not
  swept by this change.
- Rate limit: 30 AtlasCloud jobs per user per hour per function, 429 `RATE_LIMITED`.
- Every refusal or failed job (invalid input, unavailable, rate limited, invalid or expired token,
  provider failure) writes a `system_logs` row through `_shared/logging.ts` (`source` = function,
  user, operation, `code`, short `reason`, status). Never URLs, image data, tokens or provider text.
  Auth failures (401) are not logged: there is no user, and a flood of bad keys would flood the table.

Other review fixes: multipart `file` wins over `image_url` again; poll answers 401/402/403 and 429
end the job at once and only 5xx/network errors are retried; a submit timeout is 504; output URLs must
be well-formed https; the upscaler takes `output_format` (png|jpeg, default PNG for PNG input) so a
background-removed image keeps its transparency through upscale; JSON bodies are read under a size cap.

## Front end

- `ImageToolsDialog` and `BackgroundRemovalDialog` read `useCdnConfig` as a three-state value
  (`loading` / `available` / `unavailable`): while loading nothing runs and no notice is shown. When
  Cloudinary transforms are confirmed unavailable they call the functions (`image-tools/aiImageTools.ts`)
  with the file's public URL, naming **no provider** (the server decides): bg removal, then upscale
  (chained, the second asking for PNG). The helper follows a 202 by asking again with the
  `prediction_id` until done, bounded at 5 minutes. Resize, filters and quality are switched off
  and any that were on are cleared. The Cloudinary-only
  options (resize, filters, quality, "fine edges") are refused up front with a clear
  message instead of failing later. Upscale offers AtlasCloud only, regardless of the
  `atlascloudUpscale` flag: the flag hides the *choice* between providers; it must not
  remove the only remaining path.
- A 503 `PROVIDER_UNAVAILABLE` shows a dedicated, translated message. New strings are in
  `src/i18n/locales/ar/assets.json`.
- Out of scope, reported: `BatchImageToolsDialog` builds the same Cloudinary delivery URLs
  (`e_background_removal`, `e_upscale`, resize, filters). It is unchanged.

## Docs

`/docs/remove-background`, `/docs/upscale` pages and the n8n endpoint section describe the
real contract (provider, Openinary URLs, 503 availability error) instead of the Cloudinary
shape (the upscale page's `output_format`/`quality`/`denoise`/`face_enhance` and the
background-removal page's `output_format`/`quality` were never implemented and are removed).
`README.md`, `API_REFERENCE.md` and row 10 of `docs/qa/backend-api-classification.md` are
corrected. `CLAUDE.md` has no row for these functions, so it is unchanged.

## Deploy-time actions

- `ATLASCLOUD_API_KEY` must be set in the functions environment (already listed in
  `infra/edge-runtime.required-env.json`). Optional: `ATLASCLOUD_BG_REMOVAL_MODEL`.
- Openinary must be configured (`OPENINARY_SERVER_URL`, `OPENINARY_API_KEY`).
- Redeploy `upscale-image` and `remove-background` per `docs/runbooks/deploy-edge-function.md`
  (not done by this change).
