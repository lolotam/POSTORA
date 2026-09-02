# Handover — Higgsfield OAuth callback never lands as connected

**Date:** 2026-08-20
**Repo:** `E:\postora` (`https://github.com/lolotam/postora.git`)
**Branch at handoff:** `fix/regen-types-and-ai-models-metadata`
**Status:** Root cause proven. A partial local fix exists in the working tree. It is **not committed**, **not pushed**, and **not deployed**. The user then said: do not change more code; write this handover so Claude can continue.

**Reference implementation (working):** `E:\m-turboplay`
**Plan / QA:** `docs/plans/higgsfield-and-openinary.md`, `docs/qa/higgsfield-openinary-user-journey.md`

---

## What the user reported

User-level connect works from Settings → Integrations. Admin-level connect works from Admin → Settings (Higgsfield Hub card). Higgsfield/Clerk opens, the user authorizes, then the browser returns to:

```
https://postora.cloud/profiles?code=YJDIZGRLM2QTYZUXNI0ZYWI1LTKZNZQTODK5MZYZYMMXZWI1&iss=https%3A%2F%2Fclerk.higgsfield.ai&state=izd9psUenjnxQngKOwqbZhp3G9PRLnsp
```

The UI does **not** show Connected. It shows the connect/auth screen again.

Requested outcome:

1. Auth completes and shows success.
2. After auth, the user is not dumped onto a dead `/profiles?code&state&iss` page.
3. Higgsfield tools/models sync into Admin → Settings image and video generation providers, with Test working.

---

## Root cause (proven)

Higgsfield **does** redirect to the registered URI:

`https://postora.cloud/admin/oauth/higgsfield/callback?code=…&state=izd9psUenjnxQngKOwqbZhp3G9PRLnsp&iss=https://clerk.higgsfield.ai`

Then a **global Instagram leftover** steals it.

`OAuthReturnHandler` (mounted in `src/App.tsx` on every route) originally did:

```ts
const hasIgCallback = params.get("code") && params.get("state");
if (hasIgCallback && location.pathname !== "/profiles") {
  navigate("/profiles" + location.search, { replace: true });
}
```

That was written for Instagram Business Login. Higgsfield also returns `code` + `state` (plus Clerk `iss`). The Higgsfield callback page is unmounted before it can call `higgsfield-oauth` `action: "callback"`.

`src/pages/Auth.tsx` had the same greedy rule: logged-in + `code` + `state` → `/profiles` + search.

`/profiles` then tries to parse `state` as Instagram/Threads/Bluesky JSON via `useOAuthRedirectHandler`, fails silently, and shows the social-account connect UI. That is the “authentication page” the user sees.

`iss=https://clerk.higgsfield.ai` is **expected**. Higgsfield MCP OAuth uses Clerk as upstream (`https://mcp.higgsfield.ai/.well-known/oauth-protected-resource` advertises `upstream_authorization_server: https://clerk.higgsfield.ai`). Extra `iss` is not a wrong redirect target.

Production already has `/admin/oauth/higgsfield/callback` in the live JS bundle. This is not “frontend not deployed”.

---

## Live evidence (Contabo / self-hosted Supabase)

Queried 2026-08-20 ~11:09 UTC via `ssh-contaboo-mcp` → `docker exec postorasupabase-supabase-j8axyh-supabase-db psql`.

`oauth_clients` (correct):

| provider_code | issuer | redirect_uri | client_id |
|---|---|---|---|
| higgsfield | `https://mcp.higgsfield.ai` | `https://postora.cloud/admin/oauth/higgsfield/callback` | `iQQfCJqCo6DHhFXH` |

`oauth_states` still contained the user’s exact state (never consumed):

| state | scope_kind | redirect_uri | created_at | expires_at |
|---|---|---|---|---|
| `izd9psUenjnxQngKOwqbZhp3G9PRLnsp` | `platform` | admin callback URI | 10:45:56 UTC | 10:55:56 UTC |

`consumeOAuthState` **deletes** the row on callback. The row still being there means `AdminHiggsfieldCallback` never successfully invoked `action: "callback"`.

At that moment:

- `higgsfield_connections` — 0 rows
- `provider_api_keys` where `provider_code='higgsfield'` — 0 rows

That authorization `code` is **expired**. Replaying the URL will fail even after the routing fix. User must click Connect again.

Edge logs only showed `serving the request with /home/deno/functions/higgsfield-oauth` (authorize_url / status). No callback error, because callback never ran.

---

## Secondary bugs (real, not the redirect)

1. **Status shape mismatch.** `higgsfield-oauth` `status` returns `{ platform: { connected }, user: { connected, account_email } }` with no top-level `connected`. Cards read `data.connected` → always “not connected” even after a good exchange.
2. **`return_to` was always `null`.** Successful callback defaulted to `/settings` instead of `/admin/settings` for platform connect.
3. **BYO refresh needs `higgsfield_connections.meta.redirect_uri`.** Column was missing. **Already applied live** (see below).
4. **Admin Test** for Higgsfield still treats it as an API-key provider (`testOpenAI` against `https://mcp.higgsfield.ai/mcp`).

---

## What was already changed locally (uncommitted)

A Grok session started the fix, then the user stopped further code changes. **Review this diff before continuing.** Do not assume it is complete or clean.

### Keep these (they are the routing fix)

| Path | Why |
|---|---|
| `src/lib/higgsfieldOAuthReturn.ts` | Pure helpers: skip Higgsfield `iss`, skip dedicated callback paths, rescue `/profiles?iss=clerk.higgsfield.ai` back to the callback route |
| `src/lib/higgsfieldOAuthReturn.test.ts` | 9 Vitest tests — **already passing** (`npx vitest run src/lib/higgsfieldOAuthReturn.test.ts`) |
| `src/components/OAuthReturnHandler.tsx` | Uses the helpers instead of the greedy Instagram rule |
| `src/pages/Auth.tsx` | Higgsfield `iss` → callback path, not `/profiles` |

### Also in the working tree (continue or trim)

| Path | Intent |
|---|---|
| `src/pages/AdminHiggsfieldCallback.tsx` | Use `return_to` / `scope_kind` from callback response; show account id |
| `src/components/settings/HiggsfieldConnectionCard.tsx` | Read nested `user.connected`; pass `return_to: "/settings"` |
| `src/components/admin/settings/HiggsfieldIntegrationCard.tsx` | Read nested `platform.connected`; pass `return_to: "/admin/settings"` |
| `supabase/functions/higgsfield-oauth/index.ts` | Validate redirect_uri, persist `return_to`, flatten status, persist BYO `meta`, auto-sync models after platform connect |
| `supabase/functions/ai-config/index.ts` | Higgsfield Test uses MCP `models_explore`, not OpenAI |
| `src/pages/admin/AIConfigurationTab.tsx` (since split into `src/components/admin/settings/ai/AiProvidersCard.tsx`) | Hide API-key form for OAuth/Higgsfield |
| `src/hooks/ai-config/types.ts` | `auth_type?: string` |
| `src/integrations/supabase/types.ts` | `higgsfield_connections.meta` |
| `supabase/migrations/20260820180000_higgsfield_connections_meta.sql` | `ADD COLUMN meta jsonb` |

### Delete — do NOT commit

Transfer leftovers from a failed SCP:

- `ai-config.b64`
- `higgsfield-oauth.b64`
- `hf-b64-0.txt`, `hf-b64-1.txt`
- `hf-c0.txt` … `hf-c3.txt`

Unrelated untracked (leave them): `.agents/skills/`, `.claude/`, `CLAUDE.md.bak`, `public/logo2.png`

---

## Live infra already touched

**Done on Contabo (do not re-run blindly):**

```sql
ALTER TABLE public.higgsfield_connections
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
```

Column is present. The matching migration file is still uncommitted locally.

**Not done:**

- Edge functions were **not** copied to `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`. Local `scp` hung (no SSH key in `~/.ssh`). SSH MCP `run-command` maxes out at **5000 characters**, so pasting the file failed.
- Functions container was **not** restarted.
- Frontend was **not** deployed. Dokploy deploys frontend only on **`main` push**.

Until frontend ships, production will keep hijacking Higgsfield returns to `/profiles`.

Deploy edge functions after the code is final, using `docs/runbooks/deploy-edge-function.md`:

```
VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
```

Copy `higgsfield-oauth/index.ts` and `ai-config/index.ts`, then `docker compose restart functions` from `$STACK`. Verify hashes. Do **not** use `npx supabase functions deploy` (self-hosted).

SSH MCP: **`ssh-contaboo-mcp`** only (host `86.48.2.205`). Never Musalam/Abdelaziz/curemed.

---

## What Claude should do next

1. **Read this file, the plan, and the QA journey** (`J8`–`J10` in `docs/qa/higgsfield-openinary-user-journey.md`).
2. **Review the dirty diff.** Keep the routing helpers/tests. Confirm `higgsfield-oauth` status flattening and BYO `meta` persist are correct vs `E:\m-turboplay\supabase\functions\higgsfield-oauth\index.ts`.
3. **Delete the `*.b64` / `hf-c*.txt` junk.**
4. **Do not replay the user’s expired URL.** After the fix is live, click Connect again.
5. **Guard pass** (`clean-code-guard` on prod code, `test-guard` on tests) then commit **scoped files only**.
6. **Deploy**
   - Frontend: merge/push `main` (Dokploy).
   - Edge: rsync + `docker compose restart functions` as above.
7. **Verify in the browser** (Playwright MCP if available):
   - Admin: `/admin/settings` → Higgsfield Hub → Connect → land on `/admin/oauth/higgsfield/callback` (must stay there, not bounce to `/profiles`) → “Higgsfield connected” → redirect to `/admin/settings` → badge Connected.
   - Click **Sync models** (or rely on post-connect auto-sync if that code ships). Image + video Higgsfield models appear in AI Configuration / DefaultModelSelector. **Test** on the Higgsfield provider card succeeds only after platform tokens exist.
   - User: `/settings` Integrations → Your Higgsfield account → Connect → same callback route → back to `/settings` → shows connected email.
   - Instagram `code`+`state` (no `iss=clerk.higgsfield.ai`) must still forward to `/profiles`.
8. **Save a mem0 note** if that MCP is up (`user_id="HP"`, `app_id="lolotam-postora"`).

---

## Intended OAuth path (do not reinvent)

```
Connect (user or admin)
  → higgsfield-oauth action=authorize_url
      stores oauth_states (PKCE verifier, scope_kind, user_id, return_to, redirect_uri)
  → window.location = Higgsfield/Clerk authorize URL
  → return to /admin/oauth/higgsfield/callback?code&state&iss
  → AdminHiggsfieldCallback invokes action=callback
  → consumeOAuthState (DELETE … RETURNING), exchangeCode, persist
      platform → provider_api_keys
      user     → higgsfield_connections (+ meta.redirect_uri)
  → show success, navigate to return_to
  → admin: sync_models → ai_models for image + video
```

One callback route serves both scopes. `scope_kind` on the state row decides the write target. Platform callback must re-check admin. User callback must match `state.user_id` to the session.

Redirect URI stays `https://postora.cloud/admin/oauth/higgsfield/callback` (also localhost loopback for local). Do **not** register `/profiles` as the Higgsfield redirect URI. `/profiles` is the social-account OAuth dump.

---

## Tests already written

```
npx vitest run src/lib/higgsfieldOAuthReturn.test.ts
```

9 passed. Covers:

- Clerk Higgsfield `iss` is recognized
- Instagram `code`+`state` is not treated as Higgsfield
- Dedicated callback route is not forwarded to `/profiles`
- Higgsfield return that landed on `/profiles` is rescued to `/admin/oauth/higgsfield/callback?…`

Also green (untouched): `higgsfieldModels.test.ts`, `higgsfieldModelSpecs.test.ts`, `higgsfieldJobPayload.test.ts`.

---

## Suggested commit (when the diff is reviewed)

Do **not** include `*.b64`, `hf-*.txt`, `.env*`, `b64.txt`.

Scoped-ish set:

```
src/lib/higgsfieldOAuthReturn.ts
src/lib/higgsfieldOAuthReturn.test.ts
src/components/OAuthReturnHandler.tsx
src/pages/Auth.tsx
src/pages/AdminHiggsfieldCallback.tsx
src/components/settings/HiggsfieldConnectionCard.tsx
src/components/admin/settings/HiggsfieldIntegrationCard.tsx
src/pages/admin/AIConfigurationTab.tsx   # now src/components/admin/settings/ai/AiProvidersCard.tsx
src/hooks/ai-config/types.ts
src/integrations/supabase/types.ts
supabase/functions/higgsfield-oauth/index.ts
supabase/functions/ai-config/index.ts
supabase/migrations/20260820180000_higgsfield_connections_meta.sql
docs/handover/2026-08-20-higgsfield-oauth-callback.md
```

---

## Agent notes

- Self-hosted Supabase: `https://api.postora.cloud`. Historical `efruibswazzuuupgyzmf.supabase.co` is not runtime.
- Admin account: `dr.vet.waleedtam@gmail.com`
- Live app: `https://postora.cloud`
- MCP: `ssh-contaboo-mcp`, `dokploy-contaboo-mcp` (Dokploy timed out in the last session), `postora_waleedtam_mcp` is the **n8n/API** toolset not the DB. DB was queried via SSH `psql` in the postgres container.
- `mem0` MCP was down last session.

Stop here until you have reviewed the dirty diff and decided keep vs revert vs finish.
