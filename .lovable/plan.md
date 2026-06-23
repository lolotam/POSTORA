## n8n community node — URL audit & docs refresh

### Audit result (no runtime URL changes required)

- `credentials/PostoraApi.credentials.ts` already defaults `baseUrl` to `https://api.postora.cloud/functions/v1/n8n-api` (new self-hosted backend).
- `nodes/Postora/Postora.node.ts` builds every request from that credential `baseUrl`:
  - `GET  {baseUrl}/api/v1/accounts`
  - `POST {baseUrl}/api/v1/post`
  - `GET  {baseUrl}/api/v1/post/{id}`
  - `GET  {baseUrl}/api/v1/posts`
  - `POST {baseUrl}/api/v1/upload-media`
- No legacy `*.supabase.co`, `efruibswazzuuupgyzmf`, or `supabase.postora.cloud` references anywhere in the package.
- No OAuth redirect URIs or inbound webhooks live in the node — OAuth runs inside the Postora app (`facebook-oauth`, etc.), not in n8n.

So the code is already compatible. The only changes needed are documentation accuracy + a version bump so users know it targets the new backend.

### Planned edits

1. `n8n-community-node/credentials/PostoraApi.credentials.ts`
   - Tighten the `baseUrl` description: clarify it must point at the Postora backend `n8n-api` function (e.g. `https://api.postora.cloud/functions/v1/n8n-api`), and that self-hosted Postora deployments should substitute their own API host. No default value change.

2. `n8n-community-node/README.md`
   - Replace the platform list in the intro with the currently shipping set (Facebook, Instagram, Threads, YouTube Beta, Pinterest, LinkedIn personal, Bluesky) to match `platformOptions` in `Postora.node.ts`. Remove TikTok / X / Reddit from the headline list (they're commented out in the node).
   - Add a short **API Endpoint** section documenting:
     - Default base URL: `https://api.postora.cloud/functions/v1/n8n-api`
     - Endpoints used by the node (the 5 routes above)
     - Auth header: `x-api-key: <Postora API key>`
     - Note: OAuth connections are made in the Postora app, not in n8n.
   - Fix the Pinterest row in the Platform-Specific Options table (current node also exposes Description/Link); keep table aligned with `Postora.node.ts`.

3. `n8n-community-node/package.json`
   - Bump `version` from `0.1.0` → `0.2.0` (backend host migration milestone).
   - Update `description` platform list to match README.

### Out of scope (explicitly not changed)

- No change to default `baseUrl` value (already correct).
- No change to request paths, auth scheme, or node behavior.
- No edits to historical migrations, app OAuth code, or provider-console settings.
- No automatic SQL execution.

### Validation

- `cd n8n-community-node && npm run lint` (which runs `tsc --noEmit`) — report `script not available` if `npm` install isn't run.
- `rg "supabase\.co|efruibsw|supabase\.postora" n8n-community-node` → must return empty.
- `git diff --check` on the three edited files.

### Guard reviews

- **CleanCodeGuard** on the credential description + README structure (naming, no speculative config, no dead links).
- **TestGuard**: no test files in `n8n-community-node/`; will state "no test files changed; no test-code review required."

### Manual actions required

- None for the runtime. After merging, republish the npm package (`npm publish` from `n8n-community-node/`) so end users get the corrected default and docs.

### Final status target

`completed` (docs + version bump only; runtime URLs were already migrated).
