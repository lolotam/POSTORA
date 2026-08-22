# Postora n8n node v1.1.7 — Story crash fix + Upload Media Source dropdown

**Date:** 2026-07-03
**Status:** Approved
**Version:** `1.1.7` (both `n8n-nodes-postora` package and vendored copy in `postora.git`)
**Scope:** node fix + node feature + new backend route, shipped together.

## 1. Problem

### 1.1 Instagram/Facebook Story crash — `"Could not get parameter"`
`Postora.node.ts` reads `caption` via `getNodeParameter("caption", i)` with **no fallback**.
The `caption` field is `required: true` and **hidden for `postType:"story"`**
(`displayOptions.hide.postType:["story"]`). n8n throws `"Could not get parameter"`
inside the try block; it is caught and re-thrown as `NodeApiError` at dist line 885
(the catch block). The failure occurs **before** any media-source logic, so toggling
`mediaSource` between `url` and `mediafileid` has no effect.

### 1.2 Upload node lacks a media-source selector
`Media → Upload` only accepts a binary property name. Users want to upload from
Binary / URL / Media File ID, with comma-separated and array (expression) inputs.

## 2. Design

### 2.1 Part A — targeted caption fix with explicit validation
- Add fallback defaults **only** where a parameter may be hidden or optional.
- Add a `requireParam(value, label)` helper that throws a clear, field-named error
  for visible required fields that come back empty.
- `caption` (FB/IG) → `getNodeParameter("caption", i, "")` (hidden for Story).
- `socialAccounts_${platform}`, `platform`, `postId` → read with fallback then
  `requireParam(...)` so they fail with a clear message instead of n8n's generic one.
- Legacy `binaryPropertyName` → default `"data"` (optional via backward-compat).
- **No "zero behavior change" claim.** Visible required fields now fail with a
  clearer message; only genuinely hidden/optional params get silent defaults.

### 2.2 Part B — Upload `Media Source` dropdown (single source per node)

#### Properties (gated `resource:["media"], operation:["upload"]`)
| Field | name | shown when | type |
|---|---|---|---|
| Media Source | `uploadMediaSource` | always | options: `binary`/`url`/`mediafileid`, default `binary` |
| Binary Property | `uploadBinaryProperty` | source=binary | string, default `data` |
| Media URLs | `uploadMediaUrls` | source=url | string |
| Media File ID(s) | `uploadMediaFileIds` | source=mediafileid | string |

**Backward compat:** if a saved workflow has legacy `binaryPropertyName` set but no
`uploadMediaSource`, default source to `binary` and use that value.

#### Input normalization
`normalizeList(input)` accepts a comma-separated string OR an array (from an
expression) and returns `string[]`.

#### `binary` source
Unchanged loop, reads `uploadBinaryProperty` / legacy `binaryPropertyName`.

#### `url` source — SSRF-safe fetch
Per URL: scheme allowlist (http/https only); DNS SSRF guard (reject loopback,
private, link-local, reserved); bounded download (30s timeout, 5 redirects,
50 MB max); content-type must be `image/*` or `video/*`; safe filename inference
(Content-Disposition → URL basename → `upload.<ext>`). Per-item success/failure.

#### `mediafileid` source — strict validation + look up & re-attach
Pipeline: `normalizeList` → trim → drop empties → dedupe → UUID v1–v5 validation
(invalid → per-item failure) → `GET /api/v1/media/:id` per valid UUID.
- 200 → `{success:true, attached:true, resolved:true, ...row}` (resolved, NOT re-uploaded).
- 404 (missing or not-owned) → per-item `{success:false, error:"Not found or not owned"}`.
- 401 → fail whole node (auth).
- Never crashes the node; bad IDs surface as per-item failures.

#### Output contract (identical shape across all sources)
```ts
{ total: number, uploaded: number, failed: number, results: Array<{success:boolean, ...}> }
```
For `mediafileid`, **`uploaded` = successfully resolved/attached media items**
(documented semantics, not re-uploads).

### 2.3 Part C — Backend `GET /api/v1/media/:id` (shipped now)
File: `supabase/functions/n8n-api/index.ts`.
- Reuses existing API-key auth middleware (resolves `userId`).
- Malformed UUID → **400** `INVALID_UUID`.
- `media_files.select("id,user_id,file_path,file_type,file_size,mime_type,storage_bucket,metadata,created_at").eq("id", id).maybeSingle()`.
- No row OR `user_id !== userId` → **404** `MEDIA_NOT_FOUND` (single message, no existence leak).
- Response: `{ success:true, media: {...} }`.
- Added to `available_endpoints` 404 list.

## 3. Tests

**Node (Jest + ts-jest):**
1. Regression: IG/FB Story with caption hidden → no `"Could not get parameter"`.
2. Backward compat: legacy `binaryPropertyName` still uploads.
3. Upload sources: binary, URL string, URL array, file-id string, file-id array.
4. Output shape: all sources return `{ total, uploaded, failed, results }`.
5. URL safety: private IP rejected, non-http(s) rejected, oversize rejected, bad content-type rejected.
6. File-ID validation: empty, invalid UUID, dedupe, not-owned.

**Backend (Deno.test, mocked Supabase):**
1. Valid owner → 200 with row.
2. Invalid API key → 401.
3. Not-owned ID → 404.
4. Malformed UUID → 400.
5. Missing ID → 404.

## 4. Docs
README "Media → Upload" section: three sources, comma-separated + array input, two
expression examples (URL array `={{ $json.urls }}`, file-ID array `={{ $json.file_ids }}`),
note that `uploaded` for file-ID means resolved/attached.

## 5. Release & deploy (both ship together)
1. Edits applied identically to `F:\N8N\Postora-n8n-community-node` and
   `F:\Postora_new\Postora-n8n-community-node`.
2. `package.json` → `1.1.7`; rebuild dist.
3. **Backend first:** deploy `n8n-api` via `ssh-contaboo-mcp` (SHA256 verify,
   `docker compose up -d --no-deps functions`); smoke-test `GET /api/v1/media/:id`.
4. **Node tests pass.**
5. **Primary release:** `F:\N8N\…` commit scoped files → push to
   `postora-n8n-community-node.git` → GitHub release `v1.1.7` → `publish.yml`
   auto-publishes to npm.
6. **Vendored copy:** `F:\Postora_new\Postora-n8n-community-node` commit synced
   source → push to `postora.git`.

## 6. Out of scope
- Mixed source types in one node (single-source-per-node chosen).
- New backend endpoint for URL ingestion (node-side fetch keeps backend untouched
  for URLs).
