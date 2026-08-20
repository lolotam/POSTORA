# Plan: Higgsfield AI provider + Openinary dual-cloud storage

Status: **v3 — debate closed, ready to implement**
Target: `postora` · Date: 2026-08-20
Source of both features: `E:\m-turboplay` (both shipped and verified there).

**Changelog v1 -> v2.** Codex reviewed v1 and returned "not sound enough to
implement as written," with 8 blocking items. v2 accepted 5 outright, partially
accepted 2, and contested 1 with evidence. The user made three product decisions
v1 had left open (§0.1). Largest change: the two loose columns
(`openinary_path`, `storage_providers[]`) became a `media_file_providers` child
table.

**Changelog v2 -> v3.** Codex round 2 **conceded the contested TOCTOU finding**
(§7) and closed six of the round-1 items, but identified five real defects the v2
rewrite had introduced. All five are fixed here:

| Round-2 finding | Fix |
|---|---|
| `UNIQUE(media_file_id, provider)` cannot hold old + new during a copy-and-swap rename | Versioned grain `(media_file_id, provider, object_version)` + `media_files.current_object_version` — §3.4 |
| "Permanent `file_path` fallback" can override authoritative deletion — wrong, not merely stale | Fallback is **legacy-only**: reachable only when no provider row exists for the current version — §3.4 |
| BYO quota bypass is unmetered multi-tenant abuse surface | Resource limits independent of quota + ownership derived from JWT, never the request body — §2.6 |
| One callback, two trust scopes = confused deputy | Atomic one-time state consumption, scope enforced both directions, admin re-checked at callback — §2.3 |
| Deterministic key alone doesn't fix "upload succeeded, DB write lost" | Adopt-before-upload reconciliation by object identity + explicit aggregate readiness — §3.9 |

Codex also argued Openinary contract tests are load-bearing rather than deferrable.
Accepted — §6.

---

## 0. Scope

Two independent features, cloned from `m-turboplay` and adapted to Postora:

1. **Higgsfield Hub** as a new AI provider for **image *and* video** generation,
   OAuth 2.1 + PKCE, generation over MCP, account-scoped model sync.
2. **Openinary** (`https://openinary.walidmohamed.com`) as a second storage cloud
   next to Cloudinary, admin-selectable: Cloudinary / Openinary / **both**.

They share no code and ship as **two PRs**. Feature 2 touches the media hot path
every publisher depends on; feature 1 does not.

### 0.1 Product decisions (user, 2026-08-20)

| Decision | Choice | Consequence |
|---|---|---|
| Higgsfield tenancy | **Both** — a platform-wide admin token **and** optional per-user BYO connections | New `higgsfield_connections` table; resolution order in §2.3 |
| Quota on BYO | **Own connection bypasses plan quota**; platform token is strictly metered | §2.6 |
| `file_path` model | Keep immutable; add a child table, resolve at render | §3.4 |
| Hardening scope | Codex's 5 blocking fixes in; the long tail deferred | §6 |

---

## 1. What is *not* a copy — the two architectural gaps

### Gap A — storage origin (feature 2)

| | m-turboplay | Postora |
|---|---|---|
| Origin of truth | Supabase Storage | **Cloudinary itself** |
| Cloudinary's role | a sync *mirror* | the actual upload destination |
| `file_path` holds | a Supabase path, rewritten at render | the raw Cloudinary `secure_url` |
| Flip primary CDN | free — origin is provider-neutral | **not free** — no neutral origin exists |

m-turboplay could flip its primary CDN because it always kept a neutral origin.
Postora cannot: `media_files.file_path` is a Cloudinary URL consumed directly by
`n8n-api`, and by `process-post/index.ts:1258`, which pushes it straight to
Facebook/Instagram/TikTok.

### Gap B — settings & catalog tables (feature 1)

m-turboplay writes to `site_settings` and inserts `ai_providers` / `ai_models`
rows using a `sort_order` column. Postora has `system_settings` + `app_settings`
(**no `site_settings`**) and **no `sort_order`** on either AI table. Shapes
otherwise match, and `generate-image` already resolves a chain through
`ai_models -> ai_providers` keyed on `provider_code`, so Higgsfield slots in as one
more provider.

---

## 2. Feature 1 — Higgsfield

### 2.1 Ported from source (~6,600 lines)

| Source file | Lines | Destination | Adaptation |
|---|---:|---|---|
| `_shared/higgsfield-oauth.ts` | 487 | same path | connection resolution (§2.3) |
| `_shared/higgsfield-mcp.ts` | 224 | same path | verbatim |
| `_shared/higgsfield-model-spec.ts` | 883 | same path | verbatim (data) |
| `_shared/higgsfield-job-payload.ts` | 268 | same path | verbatim |
| `functions/higgsfield-oauth/` | 387 | same path | two connect scopes (§2.3) |
| `functions/ai-video-generate/` | 284 | **`generate-video/`** | user-scoped + quota |
| `functions/ai-generation-status/` | 247 | same path | archives via `cloudinary-upload` (§2.5) |
| Higgsfield branch of `ai-image-generate` | — | **`generate-image/`** | new branch beside gemini/openai |
| `src/lib/higgsfieldModelSpecs.ts` | 883 | same path | verbatim |
| `src/lib/higgsfieldModels.ts` | 84 | same path | verbatim |
| `src/lib/higgsfieldJobPayload.ts` | 268 | same path | verbatim |
| `admin/HiggsfieldIntegrationCard.tsx` | 291 | `admin/settings/` | platform connect |
| `admin/AIVideoGenerator.tsx` | 650 | `post/VideoGenerator.tsx` | targets a post |
| `pages/AdminHiggsfieldCallback.tsx` | 121 | same path | handles both scopes |
| `hooks/useAiGenerationJob.ts` | 150 | same path | verbatim |
| — | new | `settings/HiggsfieldConnectionCard.tsx` | **new**: user BYO connect |

Postora's `supabase/functions/_shared/` is a real shared directory (self-hosted,
not the CLI's vendored-copy model), so m-turboplay's per-function `_shared/`
duplication **must not** be reproduced. One copy.

### 2.2 Migration

One idempotent migration:

1. `provider_api_keys`: drop `api_key` NOT NULL; add `auth_type` (default
   `'api_key'`), `access_token`, `refresh_token`, `expires_at`, `scope`,
   `account_id`; CHECK `(api_key IS NOT NULL OR access_token IS NOT NULL)`.
   This row is the **platform** connection.
2. `ai_providers`: add `auth_type`; insert `higgsfield`
   (`api_endpoint = https://mcp.higgsfield.ai/mcp`, `api_type = 'higgsfield'`,
   `auth_type = 'oauth'`). **No `sort_order`** — Postora's table lacks it.
3. **New `higgsfield_connections`** — the per-user BYO connection:
   `user_id uuid UNIQUE REFERENCES auth.users`, `access_token`, `refresh_token`,
   `expires_at`, `scope`, `account_id`, `account_email`, timestamps.
   RLS: a user may `SELECT`/`DELETE` **their own row only**, and the policy must
   not expose token columns to the client — the frontend reads a
   `higgsfield_connection_status` view (`user_id`, `account_email`, `expires_at`,
   `connected`) instead. Tokens are service-role only.
4. **New `oauth_clients`** — RFC 7591 dynamic-registration cache, service-role only.
5. **New `oauth_states`** — PKCE verifier + state + `scope_kind`
   (`'platform' | 'user'`) + `user_id`, service-role only, `expires_at` index.
6. **New `ai_generation_jobs`** — `user_id` (RLS: owner only), `provider`,
   `model_id`, `modality`, `credential_source` (`'platform' | 'byo'`), `status`,
   `provider_job_id`, `params`, `result_url`, `media_file_id`, `error`, timestamps.
7. Seed `ai_models` for the Higgsfield catalog (image + video), `capabilities`
   carrying `'image'` / `'video'`, no `sort_order`.

### 2.3 Two connection types

```
resolveHiggsfieldCredential(userId):
  1. higgsfield_connections WHERE user_id = userId  -> BYO   (refresh if near expiry)
  2. provider_api_keys WHERE provider_code='higgsfield' -> PLATFORM
  3. none -> 409 "Higgsfield is not connected"
```

The OAuth flow is the source's, unchanged, with `scope_kind` threaded through
`oauth_states` so one callback route serves both. The parts that look like details
are load-bearing:

- Endpoints are **discovered** (`/.well-known`), never hardcoded — they are
  `/oauth2/authorize` and `/oauth2/token` today and have moved before.
- There is **no public `client_id`**; the app self-registers per redirect URI
  (RFC 7591) and caches credentials in `oauth_clients`. Both scopes share one
  registration.
- The PKCE `code_verifier` **never reaches the browser** — it lives in
  `oauth_states`, keyed by `state`, and read back server-side.

**State handling (Codex round 2, blocking #4).** Session-user matching alone is not
enough for one callback route serving two trust scopes. All of the following are
required, not optional:

  - **Atomic one-time consumption.** The state row is `DELETE … RETURNING`-ed
    *before* the token exchange, so a replayed callback finds nothing. Not
    select-then-delete — that races.
  - **Short expiry**, enforced in the same statement (`expires_at > now()`).
  - **Scope enforcement in both directions.** A `scope_kind='platform'` state
    presented to the user handler is rejected, and vice versa. Without this the
    shared route is a confused-deputy: a logged-in non-admin could complete a
    platform-scoped flow and replace the global credential.
  - **`scope_kind='platform'` additionally requires an admin session** at callback
    time, re-checked — not merely at authorize time.
  - **`scope_kind='user'` binds `user_id` at authorize time**, and the callback
    requires the session subject to equal it. A session switch between authorize
    and callback invalidates the flow rather than binding the account to whoever
    happens to be logged in.
  - The resulting credential is written **only** to the scope recorded in the
    consumed state row — never inferred from the request.
- Scope `openid email offline_access`; `resource=https://mcp.higgsfield.ai/mcp`
  (RFC 8707) on both authorize and token requests.
- Refresh fires 60s before expiry; Higgsfield rotates refresh tokens, so whatever
  comes back is persisted.

Redirect URI: `https://postora.cloud/admin/oauth/higgsfield/callback`, registered
via `manage-oauth-redirects`. One URI, both scopes.

**Disconnect does not revoke upstream.** Higgsfield publishes no revocation
endpoint, so disconnect deletes stored tokens only. Both UIs must say that rather
than claim a revocation.

### 2.4 Generation

Over **MCP JSON-RPC (Streamable HTTP)** at `https://mcp.higgsfield.ai/mcp` — the
OAuth token authorizes only the MCP endpoint; there is no OAuth-authorized REST API.

- **Image** — synchronous inside `generate-image`; a 1K draft lands in 10–20s.
- **Video** — async: `generate-video` returns a `jobId`; `ai-generation-status`
  polls, then archives.
- **Image-to-video needs a public source URL.** Higgsfield rejects an external URL
  inside `medias[]`, so the function first calls `media_import_url` for a
  `media_id`. Postora's Cloudinary URLs are public, which satisfies this.
- **Every model takes a different parameter set**, and Higgsfield rejects the whole
  request on an undeclared parameter — which is why the form *and* the edge
  functions are driven by the model's own catalog entry rather than a shared
  superset. That is what `higgsfield-model-spec.ts` (883 lines) encodes.
- Jobs are abandoned at 30 min and marked `timeout`; the client stops polling at 10.

### 2.5 Where generated media lands (Codex §5.1)

**Through `cloudinary-upload`, not a bespoke bucket.** Higgsfield retains outputs
for ~7 days, so the asset must be copied somewhere durable before the URL expires.
Routing it through the existing upload function means generated media gets a
`media_files` row (so it appears in the library and the post composer), the
Postora naming convention, and — once feature 2 lands — the dual-cloud write for
free. A dedicated bucket would need all of that rebuilt.

This creates a **one-way** dependency: feature 1 calls `cloudinary-upload` as it
exists today. It does not depend on feature 2. If feature 2 ships later, generated
media starts mirroring with no change to feature 1.

Video is downloaded and re-uploaded server-side. **Streaming, not buffering** —
edge-function memory is the constraint, and a 4K clip will not fit in a buffer.

### 2.6 Quota (Codex blocking #7)

```
generate-image / generate-video:
  cred = resolveHiggsfieldCredential(userId)
  if cred.source == 'platform':
      reserve plan quota transactionally BEFORE dispatch   -- 402 if exhausted
      settle on success / release on failure
  if cred.source == 'byo':
      no reservation  -- the user pays Higgsfield directly
  always: insert ai_generation_jobs (user_id, credential_source, model, params)
```

Both paths log a job row, so BYO stays observable even though it is unmetered.
Retries must settle against the **existing** reservation, never open a second one.

**Unmetered is not unlimited (Codex round 2, blocking #3).** Bypassing *generation*
quota does not bypass Postora's own costs — database growth, polling work, storage,
bandwidth, and MCP concurrency are all still ours. BYO therefore carries resource
limits independent of plan quota:

  - per-user cap on **concurrent** running jobs;
  - per-user cap on jobs created **per hour** (a rate limit, not a quota);
  - `ai_generation_jobs` retention window, after which rows are pruned;
  - polling stops at the existing 10-minute client / 30-minute server ceiling,
    and a job whose connection was revoked is failed rather than retried forever.

**Ownership is derived, never supplied.** `cloudinary-upload` has a service-role
path that trusts `userId` from the request body
(`supabase/functions/cloudinary-upload/index.ts:95-120`) — that pattern must **not**
be copied here. For every Higgsfield endpoint:

  - `user_id` comes from the verified JWT subject, never the body;
  - the connection is loaded by `higgsfield_connections.user_id = <jwt subject>`;
    a client-supplied connection id is ignored entirely;
  - `ai_generation_jobs` binds `user_id`, `credential_source`, and the resolved
    provider account **at creation**, and status callbacks/polling may never
    change any of the three;
  - a BYO job is never retried on the platform token — a revoked BYO connection
    fails its jobs rather than silently falling back to the admin's credential and
    billing them for it.

---

## 3. Feature 2 — Openinary dual-cloud storage

### 3.1 Live verification — 2026-08-20 (Phase 0, DONE)

Confirmed against the running instance with the supplied API key. **All probe
artefacts were deleted and `postora.cloud/` was confirmed back to its original two
files.**

| Concern | Result |
|---|---|
| `GET /api/health` | `{"status":"ok","service":"openinary-api"}` — no auth |
| `GET /api/version` | `{"version":"latest"}` — **was pinned `v0.4.0`** at m-turboplay's audit |
| `GET /` | 307 -> `/login`; `/login` 200 |
| `GET /api/storage` | Bearer required. Root: `Brands_logos_`, `m-turboplay`, `postora.cloud` |
| `GET /api/storage?path=postora.cloud` | `favicon.png`, `logo2.png` — already in use |
| `POST /api/upload` | multipart `folder`+`files` -> `{success, files:[{filename,path,size,url:"/t/<path>"}]}` |
| `POST /api/upload/sign` | 200 — presign exists |
| **`DELETE /api/storage/<path>`** | **200** — §3.3, undocumented upstream |
| `GET /t/<transforms>/<path>` | 200, public, no auth, auto AVIF/WebP |

**Folder prefix is `postora.cloud`** (user-confirmed): the project root, with every
user folder nested inside.

Measured delivery:

```
/t/postora.cloud/logo2.png                              -> 200 image/avif  60,211 B  (854 KB source)
/t/w_300,f_auto,q_auto/postora.cloud/logo2.png          -> 200 image/webp  13,990 B
/t/w_20,q_auto,f_auto/postora.cloud/logo2.png           -> 200 image/webp   1,164 B
/t/w_800,c_fill,h_600,g_auto,f_auto,q_auto/…/logo2.png  -> 200 image/webp  36,526 B
```

### 3.2 Constraints re-confirmed on the `latest` build

m-turboplay verified these against `v0.4.0`; the instance now reports `latest`, so
each was re-tested. All still hold:

1. **Delivery is `/t/<transforms>/<path>`** — public, unauthenticated, not under `/api`.
2. **No remote-URL ingest.** Every upload is a download plus a multipart re-POST —
   double bandwidth, real memory pressure, much lower safe batch size.
3. **No idempotent `public_id` — re-confirmed live.** Uploading `probe.png` twice
   produced `probe.png` then `probe (1).png`.
4. **Extensions are retained** (Cloudinary strips them).
5. **No `dpr_`, no `e_blur:`.** Blur degrades to `w_20,q_auto,f_auto` (1,164 B measured).
6. **MIME is magic-byte checked — re-confirmed live.** `application/octet-stream`
   is rejected outright; allowed: `avif gif glb gltf heic heif jpeg jpg mov mp3 mp4
   ogg png psd wav webm webp`. The extension must be derived from the response's
   `content-type`, never the source URL, which routinely lies.
7. **Delivery is public and rate-limited**, no signed URLs.

### 3.3 New finding: a delete endpoint exists

Undocumented in m-turboplay's plan, whose sync is write-only:

```
DELETE /api/storage/<url-encoded-path>   (Bearer)
  -> {"success":true,"message":"Asset deleted successfully",
      "details":{"jobsDeleted":0,"localCacheFilesDeleted":0,"cloudCacheFilesDeleted":0}}
```

Works on files **and** folders; `probe (1).png` deletes as `probe%20(1).png`. The
response reveals a **transform cache** and a **job queue** behind `/t/`, both
invalidated on delete. This matters because Postora already has `cloudinary-delete`,
`cloudinary-rename`, and `cleanup-media` — without mirroring deletes, Openinary
accumulates orphans, and because there is no overwrite, a later upload of the same
name resolves to the *stale* object.

### 3.4 Data model — the child table (Codex blocking #1, #3)

v1 proposed `openinary_path` + `storage_providers[]` on `media_files`. Codex's
objection is correct and I accept it: an array column is asked to be configuration,
desired state, *and* observed state at once, and it silently drifts — it still
claims availability after a failed upload, a one-sided delete, or a manual removal.

**Versioned grain (Codex round 2, blocking #1).** v2 keyed this
`UNIQUE(media_file_id, provider)`. That is only correct if a media row maps to
exactly one immutable object per provider — which copy-and-swap rename (§3.8)
makes false. Mid-swap, old and new objects must coexist per provider, and a
two-column key cannot hold both. The key therefore carries an object version, and
`media_files` carries a pointer to the current one:

```sql
ALTER TABLE public.media_files
  ADD COLUMN current_object_version integer NOT NULL DEFAULT 1;

CREATE TABLE public.media_file_providers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_file_id  uuid NOT NULL REFERENCES public.media_files(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('cloudinary','openinary')),
  object_version integer NOT NULL DEFAULT 1,
  object_key     text NOT NULL,         -- provider-RETURNED path, never the requested one
  delivery_url   text,                  -- absolute, provider-native
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','ready','failed','deleted')),
  bytes          bigint,
  mime_type      text,
  error          text,
  deleted_at     timestamptz,
  deleted_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_file_id, provider, object_version)
);
CREATE INDEX ON public.media_file_providers (media_file_id, object_version);
```

- **`media_files.file_path` is never rewritten.** It stays the Cloudinary
  `secure_url` and remains the read guarantee for legacy rows.
- **`object_key` records what the provider *returned*, not what was requested.**
  This is how a ` (n)` collision becomes visible instead of silently breaking reads.
- **`status='deleted'` rows are retained, never resolvable.** They keep the object
  key, version, `deleted_at`, and reason, which is what makes late deletion and
  retry auditable. Dropping the row would lose that and make a re-delete ambiguous.
- RLS mirrors `media_files` — a user sees provider rows only for their own media.
- Backfill: one row per existing `media_files` row, `provider='cloudinary'`,
  `object_version=1`, `status='ready'`, `object_key = cloudinary_public_id`,
  `delivery_url = file_path`. Pure insert, no mutation of existing data.

**Resolution — the fallback is legacy-only (Codex round 2, blocking #2).** v2 said
"fall back to `file_path` if anything fails," which is wrong: after an
authoritative deletion or a completed swap, the legacy URL is not stale but
*incorrect*, and reviving it contradicts recorded state.

```
resolveMediaUrl(mediaFile, providerRows, cdnConfig):
  rows = providerRows WHERE object_version = mediaFile.current_object_version

  if rows is EMPTY:                          -- legacy row, never mirrored
      -> media_files.file_path               -- the legacy guarantee
  else:
      1. row for cdnConfig.read_preference, status='ready'  -> delivery_url
      2. row for any other active provider,  status='ready' -> delivery_url
      3. -> UNAVAILABLE                      -- never file_path
```

Once any provider row exists for the current version, that table is authoritative.
An all-`failed`/`deleted` version resolves to unavailable, not to a resurrected
Cloudinary URL. The legacy branch is what keeps historical media working, and it is
reachable only by rows the mirror has never touched.

### 3.5 Write policy vs read preference (Codex §5.6)

v1 conflated these into one `primary_cdn` switch. They are separate concerns:

```json
{
  "write_policy":     { "providers": ["cloudinary", "openinary"], "required": ["cloudinary"] },
  "read_preference":  "cloudinary",
  "cloudinary": { "enabled": true, "cloud_name": "dur1soa8n" },
  "openinary":  { "enabled": true,
                  "server_url": "https://openinary.walidmohamed.com",
                  "folder_prefix": "postora.cloud" }
}
```

- `write_policy.providers` — where new uploads go.
- `write_policy.required` — a provider here failing fails the request; a provider
  not listed failing yields `partial` and a retry row.
- `read_preference` — which `delivery_url` the app serves. Changing it is
  instant and affects rendering only.
- Stored under `app_settings` key `cdn_storage`. Absent -> synthesised as
  Cloudinary-only, so the feature ships dark.

**One canonical server URL.** Uploads target `OPENINARY_SERVER_URL` from edge
secrets; the browser builds `/t/` URLs from `cdn_storage.openinary.server_url`. If
they disagree, bytes are written to one instance and read from another. The
settings screen must refuse to save a value that disagrees with what the edge
function reports.

### 3.6 Retirement gate (Codex blocking #2)

Cloudinary cannot be removed from `write_policy.providers` while media exists that
only Cloudinary holds. The settings screen shows live counts from
`media_file_providers` and blocks the toggle:

```
Cloudinary-only:  12,431   <- must reach 0
Both providers:      842
Openinary-only:        0
```

"Disable Cloudinary" therefore means *stop writing to it*, never *stop reading it*.
Read fallback to `file_path` (§3.4 step 3) is permanent and not user-toggleable.

### 3.7 Deterministic keys and retries (Codex blocking #4)

Postora's names already come from an atomic `next_media_seq` RPC
(`postora_<date>_<userId>_<seq>`), so two *concurrent* uploads cannot collide.
The exposure is **retry of the same logical upload** after a partial success.

Fix: the Openinary object key is derived from the `media_files.id` (a UUID),
allocated *before* any upload. A retry reuses the exact key, finds the existing
`media_file_providers` row, and either confirms `ready` or re-uploads to the same
path after deleting the previous object. It never invents a new name, so ` (n)`
cannot accumulate.

### 3.8 Rename (Codex blocking #5)

Cloudinary has a native rename API; **Openinary has none**. Rename becomes
copy-and-swap to a new object version:

1. upload the new object to every provider in `write_policy.providers`;
2. verify each returned `object_key` matches what was requested (no ` (n)` drift);
3. update `media_file_providers` rows and `media_files.file_path` in one transaction;
4. delete the old provider objects **asynchronously**, after the swap commits.

Upload-then-delete, never delete-then-upload — the latter opens a window where the
media 404s on the live CDN. `ReplaceFileDialog` currently does delete-then-upload
against Cloudinary alone; it moves to the same copy-and-swap path.

### 3.9 Dual-write (Codex blocking #3, partially accepted)

`Promise.allSettled` across both clouds, with the per-provider result **persisted**
rather than only returned:

```
1. allocate media_files.id + deterministic object keys for this object_version
2. INSERT media_file_providers rows, status='pending', one per target provider
3. ADOPT-BEFORE-UPLOAD: for each provider, if the deterministic key already exists
   upstream, adopt it instead of re-uploading  (see below)
4. Promise.allSettled([uploadCloudinary, uploadOpeninary])
5. UPDATE each row -> 'ready' (with the RETURNED object_key) or 'failed' (with error)
6. if every REQUIRED provider is 'ready' -> 200; else 500
```

**Step 3 closes the "upload succeeded, database write lost" hole** (Codex round 2,
blocking #5). A deterministic key alone does not fix that case: if the first upload
lands but the `UPDATE` never commits, a retry re-POSTs the same name and Openinary
suffixes it to ` (1)`. So a retry first calls `listOpeninaryFolder` for the exact
key; if the object is already there with the expected byte count, the row is marked
`ready` against the existing object and nothing is uploaded. Reconciliation is by
object identity, not by filename presence alone.

**Aggregate readiness.** Per-provider `ready` does not mean the media is usable —
that was implicit in v2 and is now explicit. A media version is `ready` only when
every provider in `write_policy.required` has a `ready` row for
`current_object_version`. The media library shows anything else as still
processing, so a permanently-partial mirror cannot present itself as complete.

Response contract — **`success` alone never means "in both clouds":**

| Field | Meaning |
|---|---|
| `storedIn` | **Source of truth.** Providers that actually stored bytes. Empty -> 500. |
| `success` | Reached every *required* provider. |
| `partial` | A non-required provider failed while a required one succeeded. |
| `errors` | One per failed provider, prefixed with its name. |

**A collision-renamed upload is a failure, not a success.** If the returned
`object_key` differs from the requested one, the row is marked `failed` — a
` (n)` object is unreachable by the read side and could shadow an older object.

Codex asked for a full upload-intent state machine with async retry workers. The
`media_file_providers` rows **are** that state — a `failed` row is a durable,
queryable retry record. A background retry worker is deferred (§6); an admin can
re-run the mirror for failed rows from the settings screen.

---

## 4. Work breakdown (feature 2)

Ordering follows Codex's correction — schema and state first, admin switching last.

| Phase | Work |
|---|---|
| 0 | **DONE** — live API verification (§3.1–3.3) |
| 1 | Migration: `media_file_providers` + backfill from existing rows |
| 2 | `src/lib/openinary.ts` (transform grammar, URL builder) + `src/lib/cdn.ts`; extend `src/lib/mediaUrl.ts`'s `resolveMediaPublicUrl` rather than forking it — it is already the one place that decides "Cloudinary URL or Supabase path". Vitest throughout. |
| 3 | `_shared/openinary.ts`: `uploadToOpeninary`, `listOpeninaryFolder`, `deleteFromOpeninary`, `openinaryTarget` |
| 4 | Extend `cloudinary-upload` for dual-write (§3.9). **Extend, never fork** — it serves every upload dialog *and* `n8n-api`. |
| 5 | Mirror deletes into `cloudinary-delete` + `cleanup-media`; rewrite `cloudinary-rename` as copy-and-swap (§3.8) |
| 6 | `useCdnConfig` hook + read path: `MediaLibraryPicker`, `ScheduledPostMedia`, `MediaNode`, `SortableMediaItem`, `EmailAttachments` |
| 7 | `CdnStorageSettings.tsx` — write policy, read preference, Test connection, retirement gate (§3.6) |
| 8 | Admin-triggered paged backfill of historical media. Returns `nextOffset`; caller follows it, bounded by `MAX_SYNC_PAGES`. m-turboplay's first cut always restarted at offset zero, so a folder larger than one page never advanced. Batch 10–15 for Openinary, not Cloudinary's 50. |

**Publishers are deliberately untouched.** `process-post` and `n8n-api` keep
emitting the Cloudinary URL. Codex and v1 agree: those URLs are fetched
server-side by Facebook/Instagram/TikTok, Openinary's public rate limit applies to
`/t/*`, a throttled fetch is a failed post, and `/t/` auto-negotiates AVIF/WebP
which not every platform accepts. Revisiting this needs per-platform validation and
is out of scope.

### 4.1 Secrets

| Name | Where | Value |
|---|---|---|
| `OPENINARY_SERVER_URL` | edge secrets | `https://openinary.walidmohamed.com` |
| `OPENINARY_API_KEY` | edge secrets | dashboard-issued (supplied, verified) |
| `OPENINARY_FOLDER_PREFIX` | edge secrets (optional) | `postora.cloud` |

No `VITE_` variable — the browser only builds public `/t/` URLs. **The API key must
never reach the client bundle.**

---

## 5. Verification

Before each PR: `npx tsc --noEmit` clean · `npm run build` clean · `npx vitest run`
with no new failures · `clean-code-guard` on changed production code · `test-guard`
on changed tests.

**Measured baseline on `main` @ 4bdad8e (2026-08-20): 63 passed, 2 skipped, 65 files,
489 tests, ZERO failures.** An earlier note claimed pre-existing failures in
`useMediaEditors`, `CaptionSection`, `useProfileOAuth`, `AccountSelectionSidebar`,
`AvatarSection`, and `platformConstants`. That is **stale and wrong** — verified by
running the suite against a clean `main` worktree. The bar is therefore absolute: any
failing test after this work is a regression introduced by this work, and "it was
already broken" is not available as an explanation.

One caveat worth knowing: `src/lib/__tests__/noSupabaseCoHardcode.test.ts` has a 5s
`testTimeout` and does a filesystem walk of `src/`. On a cold/slow environment it can
time out spuriously (it did once in a linked worktree, then passed in-repo taking 14.7s
wall, almost all environment setup). A single failure there is a flake, not a signal —
re-run it alone before believing it. It also enforces a real constraint on this work:
**no frontend source may hardcode a `*.supabase.co` URL.**

Live:

**Higgsfield** — connect the platform account, see the badge · connect a *second*,
per-user account and confirm generation uses it over the platform token · confirm a
platform-token generation decrements quota and a BYO one does not · confirm quota
exhaustion returns 402 · run **Sync models** · generate one image and one video end
to end · confirm no response body ever contains `access_token` or `refresh_token`.

**Openinary** — Test connection succeeds · upload with both providers enabled and
confirm two `ready` rows · **re-run the same upload and confirm the same object key,
not a ` (1)` duplicate** · kill Openinary mid-upload and confirm `partial` plus a
durable `failed` row · flip `read_preference` and confirm rendering follows without
a rebuild · delete a file and confirm it leaves both clouds · rename and confirm no
404 window · confirm the retirement gate blocks while Cloudinary-only media exists.

---

## 6. Explicitly deferred (user decision, §0.1)

In scope: the five blocking fixes — child table, retirement gate, copy-and-swap
rename, deterministic retry keys, quota enforcement.

Deferred, and why it is safe to defer:

| Item | Why deferred |
|---|---|
| Background reconciliation worker | `media_file_providers` already records divergence durably; an admin can re-run the mirror. |
| Cross-provider checksum verification | Both providers return byte counts, which are compared. Full hashing doubles read cost. |
| Cost accounting / per-provider dashboards | No cost signal exists to build on yet; needs a baseline first. |
| Divergence alerting | Follows reconciliation; premature without it. |
| GDPR erasure across providers | `cleanup-media` already gains Openinary deletes (Phase 5), which is the mechanism erasure would use. |
| Orphan GC | Bounded by the retirement gate: orphans cannot strand reads, only cost storage. |
**Promoted back into scope: Openinary contract tests.** This was on the deferred
list; Codex round 2 argued it is load-bearing for release safety, and that is
correct — the instance runs a `latest` tag and its behaviour has *already* drifted
from the `v0.4.0` m-turboplay audited, with no version signal to detect it.

The server offers no pinning, so the mitigation cannot be a version assertion. The
admin **Test connection** action instead asserts *behaviour* against a disposable
path under `postora.cloud/_healthcheck/`: upload with a correct MIME type, confirm
the returned `object_key` matches what was requested, confirm `/t/` delivers,
confirm a second upload of the same name suffixes it, confirm `application/octet-stream`
is rejected, then delete both objects. Any deviation surfaces as a failed check
naming the specific behaviour that moved, rather than a silent breakage discovered
through corrupted uploads.

---

## 7. The contested finding — conceded by Codex in round 2

> Round 2: *"I concede the narrow TOCTOU claim about the existing initial name
> allocator… concurrent initial Cloudinary uploads cannot collide merely because
> two requests observed the same sequence value."*
>
> It correctly noted the concession does not cover retry-after-lost-DB-write,
> concurrent rename, or cross-provider object identity. Those are handled by
> §3.7 (deterministic keys), §3.8 (versioned copy-and-swap), and §3.9
> (adopt-before-upload) respectively.

The original argument is kept below so a future reader does not re-add locking that
buys nothing.


**Codex blocking #4, the TOCTOU race, is overstated for Postora.** Codex asserts
"two requests can both observe 'not present' and then upload the same filename."
That is true for m-turboplay, where object names derive from user-supplied product
image filenames. It is not true here: `cloudinary-upload` allocates names from
`next_media_seq`, an atomic per-user-per-day sequence
(`supabase/functions/cloudinary-upload/index.ts:271`), so two concurrent uploads
receive different names by construction.

The residual risk — a retry of the *same* logical upload — is real, and §3.7 fixes
it with a deterministic key allocated before the first attempt. I have adopted the
fix; I am recording that the stated *cause* does not apply, so a future reader does
not add locking that buys nothing.

Similarly, "historical media becomes unusable if Cloudinary is disabled" assumes
disabling deletes the objects. It does not: settings gate writes, Cloudinary URLs
stay live, and §3.4 step 3 makes the fallback permanent. The retirement gate (§3.6)
is still worth building, but for orphan-cost and migration-completeness reasons,
not to prevent data loss.

---

## 8. Debate record

Two rounds with Codex (read-only, same session, thread `01a01c72-8768-77f1-98b6-4f19304e34c9`). Outcome:

- **Round 1** — verdict "not sound enough to implement as written"; 8 blocking items.
  5 accepted outright, 2 partially, 1 contested.
- **Round 2** — the contested finding was **conceded**; 6 round-1 items confirmed
  closed; 5 new defects found in the v2 rewrite, all fixed in v3 (see changelog).

Round-2 items Codex judged closed: loose provider metadata columns · Cloudinary
read-retirement · delete-then-upload rename · quota reservation on the platform
token · Openinary URLs reaching social publishers · the single-token trust model
(conditional on the platform token staying admin-only and BYO ownership being
enforced — both now specified in §2.3 and §2.6).

Codex's remaining deferral advice, accepted: the §6 deferrals are safe *provided*
the first release has bounded upload sizes, a manual recovery path, and a rollback
plan. All three are in scope.
