# Reconnect-stays-red — Claude's independent investigation

Date: 2026-08-28. Repo: F:\Postora_new, branch `chore/codex-native-pr-review`.

## Symptom
Expired account shows red "Action Required: Reconnect". Completing full OAuth does not turn it
green. Persists for months across many fix attempts.

## Production evidence (self-hosted PG, container `postorasupabase-supabase-j8axyh-supabase-db`)

### A. Per-platform census — active accounts
| platform | active | has refresh_token | needs_reauth=true |
|---|---|---|---|
| facebook | 14 | **0** | **11** |
| instagram | 27 | **0** | **21** |
| threads | 16 | **0** | **11** |
| pinterest | 8 | 8 | 1 |
| twitter | 2 | 2 | 1 |
| youtube | 4 | 4 | 0 |
| tiktok | 1 | 1 | 0 |
| bluesky | 1 | 1 | 0 |
| linkedin | 1 | 1 | 0 |
| whatsapp | 3 | 0 | 0 |

43 of the 57 Meta-family accounts are flagged. Every platform that actually issues refresh
tokens is clean. The flag correlates with *platform*, not with auth health.

### B. The account the owner reconnected at 17:51 today
```
id=c41e2610-1528-4aef-8929-6844aec182ec  user_id=7fe4d34e…  platform=facebook
platform_username=الطملاوي…   platform_user_id=1110933532112881
connected_at=2026-08-28 17:51   updated_at=2026-08-28 17:51
token_expires_at=2026-10-27          <-- fresh 60-day long-lived page token
needs_reauth=true   failure_count=1   last_refresh_error='No refresh token available'
```
The reconnect **did** land (connected_at/updated_at/token_expires_at all refreshed) but the three
health columns were untouched.

## ROOT CAUSES

### RC1 — CONFIRMED. `refresh-tokens` treats "platform has no refresh token" as an auth failure.
`supabase/functions/refresh-tokens/index.ts:834-841` (bulk cron) and `:356-359` (force path):
```ts
if (!account.refresh_token) {
  await handleRefreshFailure(supabaseAdmin, account, 'No refresh token available');
  ...continue;
}
```
Facebook / Instagram / Threads **never** have a `refresh_token` — Meta issues a long-lived access
token that is *extended* via `fb_exchange_token`, not refreshed. So every Meta account that enters
the refresh window (7 days before expiry, `_shared/tokenExpiryConstants.ts:66-79`) is unconditionally
marked `needs_reauth = true`.

Corollary: `refreshFacebookToken` at `refresh-tokens/index.ts:852-854` is **dead code** — the
`!account.refresh_token` guard short-circuits before the `switch` ever reaches
`case 'facebook'`. Meta tokens are therefore never extended, guaranteeing they eventually
approach expiry and get flagged.

### RC2 — CONFIRMED. The flag is a one-way latch that no Facebook OAuth path clears.
The cron's own selection excludes flagged rows (`refresh-tokens/index.ts:751-755`):
```ts
.eq('is_active', true)
.or('needs_reauth.is.null,needs_reauth.eq.false')
```
so nothing in the refresh path can ever un-flag an account. Only an OAuth write can — and the
Facebook write paths don't:

- `supabase/functions/facebook-oauth/index.ts:734-753` (explicit page selection)
- `supabase/functions/facebook-oauth/index.ts:921-940` (single-page auto-select)

Both `.upsert(..., { onConflict: "user_id,platform,platform_user_id" })` with payloads that omit
`needs_reauth`, `failure_count`, `last_refresh_error`, `last_alert_sent_at`. PostgREST compiles an
upsert to `ON CONFLICT DO UPDATE SET <only the listed columns>` — so the red flags survive
the reconnect verbatim. This is exactly the DB state in §B.

Contrast: the Instagram merge-upsert helper at `facebook-oauth/index.ts:122` *does* set
`needs_reauth: false` — the fix was applied in one helper and never propagated.

**RC1 + RC2 together are sufficient and necessary to produce the reported symptom.**

### RC3 — CONFIRMED (contributing). Reconnect mode never reaches the Facebook handler.
`src/hooks/useProfileOAuth.tsx:88-127`: `invokePlatform(profileId, platform, options)` forwards
`options` ({ mode: "reconnect", socialAccountId }) only to tiktok, pinterest and twitter.
The `facebook`, `youtube`, `linkedin`, `threads`, `bluesky`, `reddit` branches call their handler
without `options`, so the backend never learns it is a reconnect and the redirect never carries
`reconnected=1`. `useOAuthRedirectHandler.ts:141` reads that marker to fire the
"Connection refreshed" toast and `oauthUtils.ts:17`'s
`refetchQueries(["accounts-needing-reauth"])`. So even a correct backend write would not repaint
the banner without a manual reload.

## Why previous fixes failed
Every prior attempt targeted the *frontend* reconnect plumbing (`mode: "reconnect"`,
`socialAccountId`, `reconnected=1`, query invalidation — see `reconnectMode.test.ts`,
`reconnectHealthClearing.test.ts`). None touched the two server-side facts: the cron sets the
flag for a reason that is not an error, and no Facebook write clears it. The UI was faithfully
re-rendering a row that was still red in the database.

## FIX PLAN (minimal, root-cause)

1. **Model the platform property.** Add `usesRefreshToken: boolean` (or `exchangeOnly: true`) to
   `PlatformRefreshConfig` in `_shared/tokenExpiryConstants.ts`; false for facebook, instagram,
   threads (and whatsapp). Export `platformUsesRefreshToken(platform)`.
2. **RC1.** In `refresh-tokens/index.ts`, before the `!account.refresh_token` guard (both the bulk
   loop and `refreshSingleAccount`), branch on the platform: for exchange-only platforms run the
   `fb_exchange_token` extension path (`refreshFacebookToken`) instead of calling
   `handleRefreshFailure`. Only mark `needs_reauth` when the *exchange itself* fails with a
   permanent auth error (OAuthException 190 / error_subcode 460 etc.).
3. **RC2.** Add `needs_reauth: false, failure_count: 0, last_refresh_error: null,
   last_alert_sent_at: null` to every OAuth success write. Best done as one shared constant
   (e.g. `_shared/socialAccountHealth.ts` → `HEALTHY_TOKEN_FIELDS`) applied across
   facebook-oauth (both upserts), instagram-*, threads, tiktok, twitter, youtube, pinterest,
   linkedin, reddit, bluesky — audit each.
4. **RC3.** Forward `options` from `invokePlatform` to every platform handler, or drop the
   parameter where a handler genuinely cannot use it — do not silently swallow it.
5. **Backfill migration** for the 43 already-corrupted rows: clear `needs_reauth`,
   `failure_count`, `last_refresh_error` where `last_refresh_error = 'No refresh token available'`
   AND `platform IN ('facebook','instagram','threads')` AND `token_expires_at > now()`.
   Scope tightly so genuinely-broken accounts stay flagged.

## RISKS
- Must NOT simply stop setting `needs_reauth` — accounts with genuinely revoked tokens must still
  go red. The discriminator is the *result of the exchange call*, not the absence of a column.
- The backfill must not un-flag rows whose token is already past expiry.
- `check-connection-health`, `send-token-expiry-notifications`, `partner-api`,
  `observability-collector` and the admin token-health page all read `needs_reauth`; changing its
  semantics affects them — verify none depend on the false positives.
