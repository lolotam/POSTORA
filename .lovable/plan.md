## n8n Artifact Compatibility Review — Plan

Documentation-only update to one sticky-note inside the n8n workflow artifact. No runtime nodes, no public API code, no auth format changes.

### Findings

**`public/n8n-complete-workflow.json`** (3 sticky notes + 7 runtime nodes):
- Line 22 — `Configuration` Set node `apiBaseUrl` value is already `https://api.postora.cloud/functions/v1/n8n-api` ✅ (runtime correct)
- All `httpRequest` nodes derive their URL from `{{$node["Configuration"].json["apiBaseUrl"]}}` (no hardcoded legacy URLs)
- Line 230 — `Documentation` sticky-note `content` contains 3 curl examples using `https://[PROJECT].supabase.co/functions/v1/n8n-api/...` → **documentation string only**, used to teach users; classification: `documentation string`
- The curl examples use header `x-api-key: YOUR_KEY` — this header **is supported** by `n8n-api` (verified at `supabase/functions/n8n-api/index.ts:1687`, which also accepts `Authorization: Apikey|Bearer`). Auth docs are valid; no change needed.

**`n8n-community-node/`**:
- `credentials/PostoraApi.credentials.ts` baseURL default is `https://api.postora.cloud/functions/v1/n8n-api` ✅
- Header is `x-api-key` ✅ (supported)
- No legacy URLs.

**`supabase/functions/n8n-api/index.ts`**:
- No legacy hosts. Accepts both `x-api-key` and `Authorization: Apikey|Bearer xxx`. No change.

**Other docs** (`docs/*`, `API_REFERENCE.md`, `README.md`): contain legacy `efruibswazzuuupgyzmf` / `supabase.co` references, but each file already starts with the "Self-hosted migration notice (2026-06)" banner explaining these are historical. **Out of scope** for this n8n-artifact-specific review.

### Single proposed change

Update only the `Documentation` sticky-note `content` (node index 10) in `public/n8n-complete-workflow.json`:

- Replace 3 occurrences of `https://[PROJECT].supabase.co/functions/v1/n8n-api/api/v1/upload-media` with `https://api.postora.cloud/functions/v1/n8n-api/api/v1/upload-media`.
- Keep the `x-api-key: YOUR_KEY` header as-is (still supported, matches the community node).
- Keep request bodies, parameter names, response shape, and all runtime nodes unchanged.

No edits to:
- Any runtime node URL, parameter, or credential.
- `supabase/functions/n8n-api/`.
- `n8n-community-node/`.
- `.env.example`.
- Auth header format.
- API request/response shape.
- Other docs (each has the migration banner already).

### Validation

- Re-run grep for `[PROJECT].supabase.co` in `public/n8n-complete-workflow.json` → expect zero hits.
- `python3 -c "import json; json.load(open('public/n8n-complete-workflow.json'))"` to confirm JSON still parses.
- `git diff --check`.
- typecheck/lint/build skipped — JSON-only doc change.

### Guard reviews

- CleanCodeGuard: no production code changed; review not required.
- TestGuard: no test files changed; no test-code review required.

### Out of scope

- Mass-rewriting `docs/*` legacy refs (covered by existing migration banner).
- Changing `x-api-key` ↔ `Authorization: Apikey` documentation style (both supported).
- Any DB change (none needed).
- Republishing the n8n community node package.

### Manual actions after merge

- Users who imported the old workflow JSON: re-import or copy the updated `Documentation` sticky note text. Runtime nodes do not need re-import (they were already correct).

### Final status target

`completed` — documentation-only fix, no behavior change.
