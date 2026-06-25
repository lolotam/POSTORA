## OAuth Public Redirect Hardening — Plan

### Current state (verified by reading the files)

- `youtube-oauth/index.ts` — redirect fallback already hardened (uses `PUBLIC_API_ORIGIN`, no `SUPABASE_URL` fallback). **Scope is still the broad `https://www.googleapis.com/auth/youtube`** (lines 141–142) — needs narrowing.
- `linkedin-oauth/index.ts` (lines 17–19) — falls back to `${SUPABASE_URL}/functions/v1/linkedin-oauth` → can resolve to `http://kong:8000/...`. **Vulnerable.**
- `instagram-oauth/index.ts` (lines 26–28) — same `SUPABASE_URL` fallback. **Vulnerable.**
- `instagram-business-oauth/index.ts` (lines 28–30) — same `SUPABASE_URL` fallback. **Vulnerable.**
- `facebook-oauth/index.ts` (lines 13–17) — same `SUPABASE_URL` fallback. **Vulnerable.**
- `infra/edge-runtime.required-env.json` — `PUBLIC_API_ORIGIN` already present ✅
- `.env.example` — `PUBLIC_API_ORIGIN=https://api.postora.cloud` already present ✅

### Changes

**1. `supabase/functions/youtube-oauth/index.ts`** — scope narrowing only (redirect already correct)

Replace lines 139–143:
```ts
const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
].join(" ");
```
Keep `response_type=code`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true` unchanged. Token exchange, state HMAC, channel fetch, DB write — all untouched.

**2. `supabase/functions/linkedin-oauth/index.ts`** — redirect fallback hardening

Replace lines 17–19:
```ts
const PUBLIC_API_ORIGIN =
  Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const LINKEDIN_REDIRECT_URI =
  Deno.env.get("LINKEDIN_REDIRECT_URI") ??
  `${PUBLIC_API_ORIGIN}/functions/v1/linkedin-oauth`;
```
Keep `SUPABASE_URL` intact (still used at lines 218/227/333/440 for internal Supabase calls). No scope change.

**3. `supabase/functions/instagram-oauth/index.ts`** — same pattern, replace lines 26–28 with `INSTAGRAM_REDIRECT_URI` derived from `PUBLIC_API_ORIGIN`. No scope change.

**4. `supabase/functions/instagram-business-oauth/index.ts`** — same pattern, replace lines 28–30 with `INSTAGRAM_BUSINESS_REDIRECT_URI` derived from `PUBLIC_API_ORIGIN`. No scope change.

**5. `supabase/functions/facebook-oauth/index.ts`** — same pattern, replace lines 13–17 with `FACEBOOK_REDIRECT_URI` derived from `PUBLIC_API_ORIGIN`. No scope change.

### Out of scope (explicitly not touching)

- Token exchange logic, account-storage logic, frontend behavior.
- Google login / Supabase Auth callback (separate flow).
- Other OAuth functions (tiktok, threads, pinterest, twitter, reddit, bluesky) — not in user-specified list.
- n8n, database, secrets, SQL.

### Env

No env changes needed — `PUBLIC_API_ORIGIN` already in manifest + `.env.example`.

### Database

None.

### Validation (after edits)

- `npm run check:edge-env`
- `npm run build`
- `npm run lint`
- `npx vitest run`
- Greps for `http://kong:8000`, `efruibswazzuuupgyzmf`, `.supabase.co/functions/v1`, `supabase.postora.cloud` against `src supabase/functions scripts public`.
- CleanCodeGuard self-check on the 5 changed files.
- TestGuard: no test files changed → not required.

### Manual production actions (owner / Zed — Lovable cannot do these)

1. Sync the 5 changed Edge Function files to `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions`.
2. Ensure production `.env` contains:
   - `PUBLIC_API_ORIGIN=https://api.postora.cloud`
   - `YOUTUBE_REDIRECT_URI=https://api.postora.cloud/functions/v1/youtube-oauth` (optional belt-and-suspenders)
3. `docker compose up -d --no-deps functions`
4. Run server env checker (`scripts/check-edge-env-server.sh`).
5. Real OAuth tests for YouTube, LinkedIn, Instagram (direct + business), Facebook.

### Expected final status

`completed_ready_for_server_sync`
