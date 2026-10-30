> **⚠️ Self-hosted migration notice (2026-06):** This project now runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference below to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

# Postora — Backend API Reference

> **Implementation-grounded reference for the Postora Supabase Edge Function backend.**
> Version: aligned with `main` as of 2026-04-22 · Project ref: `efruibswazzuuupgyzmf`

This document is a **technical reference** for developers, operators, and AI assistants
working with Postora's backend. Every endpoint, error code, and metadata field below is
verified against a real file in `supabase/functions/`. Anything that could not be fully
confirmed in source is explicitly marked **(inferred)**.

This is **not** a marketing page, not a tutorial, and not a public REST spec — most
Postora functions are invoked from the SPA via `supabase.functions.invoke()` and rely on
Supabase's auto-generated `/functions/v1/<name>` URL plus a Supabase JWT.

---

## Table of Contents

1. [API architecture overview](#1-api-architecture-overview)
2. [Authentication & authorization model](#2-authentication--authorization-model)
3. [Common request conventions](#3-common-request-conventions)
4. [Common response conventions](#4-common-response-conventions)
5. [Common structured error conventions](#5-common-structured-error-conventions)
6. [Common logging & diagnostic conventions](#6-common-logging--diagnostic-conventions)
7. [Edge Functions index](#7-edge-functions-index)
8. [Detailed function reference](#8-detailed-function-reference)
9. [OAuth flow references by platform](#9-oauth-flow-references-by-platform)
10. [Posting pipeline reference](#10-posting-pipeline-reference)
11. [AI generation endpoints reference](#11-ai-generation-endpoints-reference)
12. [Utility / admin / debug endpoints reference](#12-utility--admin--debug-endpoints-reference)
13. [Platform-specific metadata reference](#13-platform-specific-metadata-reference)
14. [Common database side effects](#14-common-database-side-effects)
15. [Known caveats & limitations](#15-known-caveats--limitations)
16. [Operator debugging notes](#16-operator-debugging-notes)
17. [Common OAuth failure patterns](#17-common-oauth-failure-patterns)
18. [Common posting failure patterns](#18-common-posting-failure-patterns)
19. [Logs to inspect first](#19-logs-to-inspect-first)
20. [Quick API Debug Checklist](#20-quick-api-debug-checklist)
21. [AI Assistant API Map](#21-ai-assistant-api-map)

---

## 1. API architecture overview

```
┌─────────────────────────┐   supabase.functions.invoke()   ┌─────────────────────────┐
│  React SPA (postora.    │ ──────────────────────────────► │  Supabase Edge Runtime  │
│  cloud / .lovable.app)  │     POST JSON + Bearer JWT      │  (Deno, per-function)   │
└─────────────────────────┘                                 └────────────┬────────────┘
        │                                                               │
        │ direct fetch for SSE / file uploads                           │
        ▼                                                               ▼
┌─────────────────────────┐                                 ┌─────────────────────────┐
│  Public REST surface    │                                 │  External APIs:         │
│  /functions/v1/n8n-api  │                                 │  Meta Graph v22.0,      │
│  (api_key auth)         │                                 │  Threads Graph,         │
└─────────────────────────┘                                 │  TikTok, YouTube,       │
                                                            │  Pinterest, LinkedIn,   │
                                                            │  Twitter v2, Bluesky,   │
                                                            │  Reddit, WhatsApp Cloud,│
                                                            │  Cloudinary, Stripe,    │
                                                            │  Resend, AI Gateway,    │
                                                            │  OpenRouter, Atlas      │
                                                            └─────────────────────────┘
```

- **Primary surface**: 96 Supabase Edge Functions under `supabase/functions/<name>/index.ts`.
- **Frontend invocation**: `supabase.functions.invoke('<name>', { body })` — adds `apikey`
  and `Authorization: Bearer <session.access_token>` automatically.
- **Direct REST**: only `n8n-api` is intended for third-party calls. Everything else is
  internal-app or admin-gated.
- **Webhooks (no JWT)**: `tiktok-webhook`, `whatsapp-webhook`, `stripe-webhook`,
  `resend-webhook` — verify upstream signatures themselves.
- **Cron jobs**: invoked by `pg_cron` via the management token, not user JWT
  (`process-scheduled-posts`, `process-scheduled-emails`, `process-scheduled-flags`,
  `process-scheduled-blog-posts`, `whatsapp-scheduled-sender`, `refresh-tokens`,
  `send-token-expiry-notifications`, `send-expiry-reminders`,
  `send-weekly-analytics`, `sync-user-quotas`, `observability-collector`,
  `observability-alerts`, `cleanup-media`, `notify-expiring-ai-overrides`,
  `sync-resend-delivery-status`).

---

## 2. Authentication & authorization model

| Auth tier | How it's enforced | Used by |
|---|---|---|
| **Supabase JWT** | `Authorization: Bearer <access_token>` resolved via `createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization } } }).auth.getUser()` | Most user-facing functions |
| **Service-role only** | `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` — never accepts user JWTs | `process-post`, `process-scheduled-posts`, `manage-app-secrets`, all `send-*` mailers |
| **Admin gate** | After user resolution, query `user_roles.role = 'admin'` (or call `has_role(auth.uid(), 'admin'::app_role)` RPC) and 403 otherwise | `manage-app-secrets`, `manage-cron-jobs`, `manage-oauth-redirects`, `threads-debug-publish-check`, `analyze-log`, `observability-alerts`, `test-ai-model`, `whatsapp-config-test` |
| **Public API key** | `Authorization: Bearer <profiles.api_key>` (key prefix `postora-…`); resolved into a user_id | `n8n-api` only |
| **Webhook signature** | Platform-specific HMAC verification | `stripe-webhook` (Stripe-Signature), `resend-webhook` (Svix), `whatsapp-webhook` (Meta verify token), `tiktok-webhook` |
| **OAuth state HMAC** | State param is `base64url(json) + '.' + hmac(state, OAUTH_STATE_SECRET)` (see `_shared/social-auth.ts`) | Every `*-oauth` callback |
| **Public** | No auth required | `get-public-config`, `unsplash-proxy` (rate-limited) |

> **Note on `verify_jwt`**: most Postora edge functions deploy with `verify_jwt = false`
> in `supabase/config.toml` and validate JWTs in code via `auth-helper.ts`. Webhooks and
> public endpoints are intentionally unauthenticated at the gateway level.

---

## 3. Common request conventions

- **Method**: `POST` for almost every function (some `GET` for `n8n-api` paths and
  webhooks).
- **Preflight**: every function handles `OPTIONS` and returns the shared CORS headers
  from `_shared/cors.ts`:
  ```ts
  {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, ...",
  }
  ```
- **Body**: JSON. The convention for multi-action functions (all `*-oauth` and
  `manage-*`) is:
  ```json
  { "action": "get-auth-url" | "exchange-code" | "disconnect" | "refresh" | ..., ...payload }
  ```
- **Headers**:
  - `Authorization: Bearer <token>` — user JWT (or `profiles.api_key` for `n8n-api`).
  - `apikey: <SUPABASE_PUBLISHABLE_KEY>` — added automatically by `supabase-js`.
  - `x-client-info` — added automatically by `supabase-js`.
- **Idempotency**: not enforced server-side. Callers are expected to debounce. `n8n-api`
  schedule writes return the row id which can be re-checked before retrying.

---

## 4. Common response conventions

The dominant success shape across the codebase:

```json
{
  "success": true,
  "data": { ... }            // optional, function-specific
}
```

For posting (`process-post`), the response carries a per-platform results map:

```json
{
  "success": true,
  "post_id": "uuid",
  "results": {
    "facebook": { "success": true,  "platform_post_id": "...", "platform_post_url": "...",
                  "warnings": ["..."] },
    "instagram":{ "success": false, "error_code": "ig_video_processing_timeout",
                  "error": "Instagram media did not finish processing within 180s" }
  }
}
```

`n8n-api` additionally appends a usage block:

```json
{
  "success": true,
  "data": [...],
  "usage": { "count": 5, "limit": 30, "window": "1h" }
}
```

AI generators return their content in `data` plus debit info:

```json
{ "success": true, "caption": "…", "credits_remaining": 47 }
```

---

## 5. Common structured error conventions

Postora follows the **platform-error-reporting pattern** (see
`mem://technical-decisions/platform-error-reporting-pattern`):

> Operator-fixable / platform-policy errors return **HTTP 200** with
> `{ success: false, error_code, error, details? }` so the frontend can map them to a
> human-readable message. Protocol/auth/internal failures return non-2xx.

### 5.1 Status code matrix

| HTTP | Shape | When |
|---|---|---|
| `200` | `{ success:true, ... }` | Normal success |
| `200` | `{ success:false, error_code, error }` | Expected, user/operator-fixable (bad token, missing scope, platform policy reject, capability missing) |
| `400` | `{ error: "..." }` or `{ error_code, error }` | Malformed request body, missing required fields |
| `401` | `{ error: "Unauthorized" }` | Missing/invalid JWT or `api_key` |
| `403` | `{ error: "Admin only" }` / `{ error: "Forbidden" }` | Failed `has_role('admin')` gate |
| `404` | `{ error: "...not found" }` | Account / post / resource not found |
| `429` | `{ error: "Rate limit exceeded", limit, window }` | `n8n-api` (default 30/hour) |
| `500` | `{ error: "..." }` (sanitized via `_shared/errorSanitizer.ts`) | Uncaught / DB / external API failure |
| `503` | `{ error: "Service temporarily unavailable..." }` | Postgres connection codes (`08xxx`) |

### 5.2 Common `error_code` values

Sourced from `process-post/index.ts`, `*-oauth/index.ts`, `_shared/errorSanitizer.ts`,
and `_shared/threads-debug.ts`:

| `error_code` | Meaning | Typical fix |
|---|---|---|
| `1349187` | **Threads OAuth blocked**: redirect URI is HTTP, not HTTPS | Use `postora.cloud` / `postora.lovable.app` (frontend guard also blocks this client-side) |
| `4476002` | Wrong app ID — Facebook App ID used where Threads App ID is required | Use `THREADS_APP_ID` / `THREADS_APP_SECRET` |
| `redirect_uri_mismatch` | URI not registered in the Meta/Google/TikTok/Pinterest dashboard | Add it under Valid OAuth URIs |
| `invalid_credentials_source` | Function expected DB-backed app credentials but secret was missing | Set in `/admin/settings` (App Credentials Manager) |
| `token_expired` | Stored access token is past `token_expires_at` | Reconnect (LinkedIn) or wait for `refresh-tokens` cron (FB/IG/Threads/TikTok/YT) |
| `missing_scope` | Token lacks a required permission | Reconnect with the missing scope |
| `capability_missing` | `account_metadata.capabilities.*` is `false` | Reconnect to refresh capabilities |
| `tiktok_privacy_required` | `privacy_level` not selected | User must pick one in composer |
| `ig_carousel_too_many` | More than 10 items in carousel | Trim items |
| `ig_video_processing_timeout` | IG container poll exceeded 60×3s | Re-publish — usually transient on Meta side |
| `fb_video_format_unsupported` | FB Story/Reel codec rejection | Re-encode (H.264 + AAC, MP4) |
| `pinterest_keyframe_invalid` | Video keyframe interval ≠ 1s | Re-encode with keyint=1s |
| `threads_text_too_long` | Caption > 500 chars (backend safety net) | Trim |
| `threads_location_unauthorized` | App lacks Threads Advanced Access | Strip `location_id` or apply for Advanced Access |
| `cross_share_skipped` | Threads → IG share skipped (no linked IG, video, or carousel) | Informational; surfaced as warning, not failure |
| `youtube_refresh_limit` | Google Cloud project still in Testing mode (100-refresh cap) | Ship to Production in Google Cloud Console |
| `twitter_tier_too_low` | App is not Basic tier or higher | Upgrade in X Developer Portal |
| `linkedin_token_stale` | Access token expired and LinkedIn doesn't refresh in-place | User must disconnect + reconnect |

---

## 6. Common logging & diagnostic conventions

### 6.1 `system_logs` table

Written via the `log_system_event` Postgres RPC and the helpers in
`_shared/logging.ts`:

```ts
await logSystem({
  level: 'info' | 'warn' | 'error' | 'critical',
  service: 'process-post' | 'threads-oauth' | ...,
  message: 'human-readable',
  details: { event: 'process_post_publish_start', post_id, platform },
  error_code: '1349187',            // optional
  error_message: '...',             // optional
  user_id,                          // optional
});
```

Rows older than 30 days (non-critical) are pruned by `cleanup_old_health_data()`.
Real-time tail visible at `/admin/logs`.

### 6.2 Named events worth grepping

| Event name | Where | What it means |
|---|---|---|
| `threads_oauth_authorize_url_built` | `threads-oauth` | URL generated successfully |
| `threads_oauth_insecure_redirect_blocked` | `threads-oauth` | Frontend asked for HTTP redirect — refused |
| `threads_oauth_callback_*` | `threads-oauth` | Token exchange phases |
| `process_post_*` | `process-post` | Per-platform branch start/finish, capability probes |
| `scheduler_jit_refresh_*` | `process-scheduled-posts` | JIT token refresh attempts |
| `n8n_api_request` | `n8n-api` | Mirrored to `api_logs` for rate-limit accounting |
| `token_refresh_*` | `refresh-tokens` | Per-platform refresh outcome (also written to `token_refresh_history`) |
| `ig_video_poll_attempt` | `process-post` | One of the 60 polling attempts |

### 6.3 Other diagnostic stores

- `api_logs` — every `n8n-api` request (used for per-user rate limiting).
- `token_refresh_history` — every refresh attempt (success/error_message).
- `admin_audit_log` — written by `log_admin_action()` whenever admins read user data
  or change settings.
- `edge_function_status` — populated by `observability-collector`.
- `system_health_snapshots` — overall health score, rolled up hourly.

---

## 7. Edge Functions index

Total: **96 functions** (verified against `supabase/functions/` directory).

### 7.1 Auth / OAuth (12)

| Name | Access | Method | Brief |
|---|---|---|---|
| `facebook-oauth` | user JWT | POST | FB Login + Pages selection (Graph v22.0) |
| `instagram-oauth` | user JWT | POST | IG Business Login + IG-via-FB-Page |
| `threads-oauth` | user JWT | POST | Threads Graph (`graph.threads.net`); HTTPS-only |
| `tiktok-oauth` | user JWT | POST | TikTok Login Kit + Content Posting API |
| `youtube-oauth` | user JWT | POST | Google incremental auth, JIT scope escalation |
| `pinterest-oauth` | user JWT | POST | Pinterest API v5 |
| `linkedin-oauth` | user JWT | POST | OIDC + organizationAcl (client `77k0p74fi3zlau`) |
| `twitter-oauth` | user JWT | POST | OAuth 2.0 PKCE (Basic tier required) |
| `bluesky-oauth` | user JWT | POST | ATProto + DPoP-bound tokens |
| `reddit-oauth` | user JWT | POST | OAuth 2.0 + permanent refresh |
| `whatsapp-oauth` | user JWT | POST | Embedded Signup / WABA selection |
| `manage-oauth-redirects` | admin | POST | CRUD over `oauth_redirect_requests` |

### 7.2 Posting pipeline (5)

| Name | Access | Method | Brief |
|---|---|---|---|
| `process-post` | service-role | POST | Master publisher. Routes to per-platform branches. |
| `process-scheduled-posts` | cron | POST | Cron picker → JIT refresh → `process-post` |
| `process-scheduled-blog-posts` | cron | POST | Publish queued blog posts |
| `process-scheduled-flags` | cron | POST | Apply scheduled feature-flag toggles |
| `process-scheduled-emails` | cron | POST | Pop and send queued emails |

### 7.3 Media (10)

| Name | Access | Method | Brief |
|---|---|---|---|
| `cloudinary-upload` | user JWT | POST | Sign + upload a file to Cloudinary |
| `cloudinary-delete` | user JWT | POST | Delete a Cloudinary asset |
| `cloudinary-rename` | user JWT | POST | Rename a Cloudinary public_id |
| `cloudinary-email-upload` | service-role | POST | Email-attachment helper used by `send-inbox-email` |
| `process-video` | user JWT | POST | Mark video as ready / metadata extraction |
| `transcode-video` | user JWT | POST | Submit transcode job (external service — Deno has no FFmpeg) |
| `transcribe-media` | user JWT | POST | 3-tier fallback STT chain |
| `remove-background` | user JWT or API key | POST | AI background removal: AtlasCloud, or Cloudinary while the admin CDN policy writes to it; result stored in Openinary; 503 `PROVIDER_UNAVAILABLE` when no provider is available |
| `upscale-image` | user JWT or API key | POST | AI upscale: Cloudinary while the admin CDN policy writes to it, otherwise AtlasCloud (2K/4K, result stored in Openinary); 503 `PROVIDER_UNAVAILABLE` when no provider is available |
| `upscale-image-atlas` | user JWT | POST | AtlasCloud 4K upscale (premium) |
| `cleanup-media` | cron / admin | POST | Sweep orphaned media |
| `check-music-copyright` | user JWT | POST | ACRCloud lookup |

### 7.4 AI generation & config (10)

| Name | Access | Method | Brief |
|---|---|---|---|
| `generate-caption` | user JWT | POST | Caption generator (1 credit) |
| `generate-hashtags` | user JWT | POST | Hashtag generator (1 credit) |
| `generate-image` | user JWT | POST | Image generation (2 credits) |
| `suggest-best-times` | user JWT | POST | AI best-time recommender |
| `ai-config` | admin | POST | Read/write AI provider+model config |
| `ai-email-assistant` | user JWT | POST | Compose-assist for admin inbox |
| `analyze-log` | admin | POST | LLM explanation + Lovable prompt for a log row |
| `test-ai-model` | admin | POST | Per-provider test ping |
| `fetch-openrouter-models` | admin | POST | Pull live OpenRouter catalog |
| `openrouter-models` | user JWT | GET/POST | Cached catalog read for users |

### 7.5 Threads tools (10)

| Name | Access | Method | Brief |
|---|---|---|---|
| `threads-discovery` | user JWT | POST | Search/discover Threads posts |
| `threads-keyword-search` | user JWT | POST | Keyword search |
| `threads-insights` | user JWT | POST | Per-post insights |
| `threads-location-search` | user JWT | POST | Location lookup for tagging |
| `threads-recently-searched` | user JWT | POST | List recent searches |
| `threads-comment` | user JWT | POST | Comment on a thread |
| `threads-quote` | user JWT | POST | Quote-post |
| `threads-repost` | user JWT | POST | Repost |
| `threads-delete-post` | user JWT | POST | Delete owned thread |
| `threads-debug-publish-check` | admin | POST | Diagnostic dry-run (no publish) |

### 7.6 TikTok extras (4)

| Name | Access | Method | Brief |
|---|---|---|---|
| `tiktok-analytics` | user JWT | POST | TikTok analytics fetch |
| `tiktok-check-status` | user JWT | POST | Poll publish status |
| `tiktok-demo-publish` | admin | POST | Sandbox/demo publish path (gated by `THREADS_DEMO_MODE`-style flag) |
| `tiktok-webhook` | public (signature) | POST | TikTok event webhook |

### 7.7 WhatsApp (7)

| Name | Access | Method | Brief |
|---|---|---|---|
| `whatsapp-broadcast` | user JWT | POST | Send broadcast batch |
| `whatsapp-config-test` | admin | POST | Diagnostic for WABA config |
| `whatsapp-profile` | user JWT | POST | Read/update business profile |
| `whatsapp-scheduled-sender` | cron | POST | Send scheduled WhatsApp messages |
| `whatsapp-webhook` | public (verify token) | GET/POST | Inbound messages + status |
| `whatsapp-oauth` | user JWT | POST | Embedded Signup callback |

### 7.8 Messaging / comments / places (3)

| Name | Access | Method | Brief |
|---|---|---|---|
| `messaging-api` | user JWT | POST | Unified inbox CRUD (FB/IG/WA) |
| `comment-manager` | user JWT | POST | Comment list/reply/hide for FB/IG |
| `facebook-places-search` | user JWT | POST | FB Places lookup for location tagging |

### 7.9 Analytics / brand / ads / leads (4)

| Name | Access | Method | Brief |
|---|---|---|---|
| `brand-scrape` | user JWT | POST | Scrape competitor profiles (Apify-backed) |
| `ad-analytics` | user JWT | POST | Read Meta ads analytics (partial) |
| `ad-manager` | user JWT | POST | Create/update Meta ads (partial / experimental) |
| `leads-api` | user JWT | POST | Meta Lead Ads CRM (partial) |

### 7.10 Tokens / health (4)

| Name | Access | Method | Brief |
|---|---|---|---|
| `refresh-tokens` | cron | POST | Per-platform token refresh; writes `token_refresh_history` |
| `check-connection-health` | user JWT | POST | Probe all connected accounts |
| `send-token-expiry-notifications` | cron | POST | Email reminders for soon-to-expire tokens |
| `send-token-failure-alert` | service | POST | Send failure alert for a specific account |

### 7.11 Billing (7)

| Name | Access | Method | Brief |
|---|---|---|---|
| `stripe-checkout` | user JWT | POST | Create checkout session |
| `stripe-manage-subscription` | user JWT | POST | Cancel / resume / portal |
| `stripe-webhook` | public (signature) | POST | Stripe events |
| `create-payment` | user JWT | POST | One-off payment intent |
| `verify-payment` | user JWT | POST | Verify a session post-checkout |
| `backfill-subscription` | admin | POST | Repair subscription state |
| `check-subscription` | user JWT | POST | Sync DB ↔ Stripe |

### 7.12 Email (9)

| Name | Access | Method | Brief |
|---|---|---|---|
| `send-auth-email` | Supabase auth hook | POST | Auth-flow emails (signed by `SEND_EMAIL_HOOK_SECRET`) |
| `send-inbox-email` | admin | POST | Send from admin inbox via Resend |
| `send-reset-otp` | public | POST | Email reset OTP |
| `send-subscription-email` | service | POST | Subscription lifecycle emails |
| `send-weekly-analytics` | cron | POST | Weekly digest |
| `send-expiry-reminders` | cron | POST | Token expiry reminders (alias of `send-token-expiry-notifications`) |
| `sync-resend-delivery-status` | cron | POST | Pull delivery status from Resend |
| `resend-webhook` | public (signature) | POST | Inbound delivery events |
| `fetch-email-content` | admin | POST | Fetch full HTML/text for an email_log row |

### 7.13 Admin / ops (8)

| Name | Access | Method | Brief |
|---|---|---|---|
| `manage-app-secrets` | admin | POST | Read/write `app_credentials` & vault secrets |
| `manage-cron-jobs` | admin | POST | Toggle/edit `pg_cron` jobs |
| `observability-alerts` | admin / cron | POST | Evaluate alert configs, write history |
| `observability-collector` | cron | POST | Roll up health metrics + `system_health_snapshots` |
| `sync-user-quotas` | cron | POST | Reapply quotas from current plan |
| `notify-admin-new-user` | service | POST | Slack/email on new signup |
| `notify-expiring-ai-overrides` | cron | POST | Warn admins when AI provider keys near expiry |
| `get-public-config` | public | POST | Public-safe config (feature flags, plan IDs) |

### 7.14 MFA & password (2)

| Name | Access | Method | Brief |
|---|---|---|---|
| `verify-mfa-reset` | public | POST | Verify reset OTP for MFA disable |
| `verify-reset-otp` | public | POST | Verify password reset OTP |

### 7.15 Public API & misc (2)

| Name | Access | Method | Brief |
|---|---|---|---|
| `n8n-api` | `profiles.api_key` | GET/POST/PUT/DELETE | Public REST surface (posts/accounts/media/schedule). Used by n8n + Make.com nodes. |
| `unsplash-proxy` | user JWT | GET | Rate-limited Unsplash search proxy |

---

## 8. Detailed function reference

> The full template (Purpose / Access / Invocation / Input / Output / Errors / Side
> Effects / Notes) is applied to high-traffic / high-surface functions below. Functions
> already adequately described in §7 are not re-documented here unless they have a
> non-trivial request shape.

### 8.1 `process-post`

**Purpose**
Master publisher. Reads a `posts` row, looks up the selected `social_accounts`, and
dispatches per-platform publish branches. Handles capability probing, JIT account
selection, video routing (FB `/videos`), IG container polling, Threads safety nets,
TikTok UX gating, Pinterest 3-step async, and Stories pathways.

**Access** Service-role only. Invoked by the SPA *and* by `process-scheduled-posts`.
The SPA call uses a service-role pass-through (never exposes the key — `supabase.functions.invoke()` from an authenticated session, function then asserts ownership).

**Invocation**
- Frontend: `usePostForm` → `supabase.functions.invoke('process-post', { body: { post_id } })`.
- Cron: `process-scheduled-posts` invokes with the same body.

**Input**
```jsonc
{
  "post_id": "uuid"            // required
  // No other fields; everything else is read from the posts row.
}
```

The `posts` row must contain:
- `caption: string | null`
- `platforms: text[]` — e.g. `["facebook","instagram","threads","tiktok","youtube","pinterest","linkedin","twitter","bluesky","reddit"]`
- `media_file_ids: uuid[]` — references `media_files`
- `metadata.selected_account_ids: uuid[]` — only these accounts are published to
- `metadata.platform_settings.<platform>`: see §13 for exact shapes

**Output**
```jsonc
{
  "success": true,
  "post_id": "uuid",
  "results": {
    "<platform>": {
      "success": true,
      "platform_post_id": "...",
      "platform_post_url": "...",
      "warnings": ["cross_share_skipped", "..."],
      "response_data": { /* raw upstream response, sanitized */ }
    }
  }
}
```

The same per-platform shape is also persisted as one row per `(post_id,
social_account_id)` in `platform_posts`.

**Errors**
- HTTP 200 + `success:false` for any per-platform failure (per `error_code` table in §5.2).
- HTTP 400 if `post_id` is missing.
- HTTP 404 if the post row doesn't exist or doesn't belong to the calling user.
- HTTP 500 only on unhandled exceptions (sanitized).

**Side effects**
- Writes one row per platform to `platform_posts` (status `success` | `failed`).
- Updates `posts.status` to `completed` (any success) or `failed` (all failures) and
  sets `posts.posted_at`.
- Logs `process_post_*` events to `system_logs`.
- May refresh tokens in-line on selected accounts (writes `token_refresh_history`).
- May create Cloudinary delivery URLs (re-encoded with `f_jpg,q_auto` for IG).

**Notes**
- IG video container poll cap: **60 attempts × 3 s = 180 s** (see
  `mem://technical-decisions/instagram-video-polling-constraints`).
- FB single-media `feed` posts containing video are routed to `/{pageId}/videos`
  (`mem://features/facebook-integration/video-feed-routing`).
- Threads caption is clamped to 500 chars server-side as a safety net.
- TikTok will refuse to publish if `privacy_level` is unset
  (`mem://features/tiktok-integration/core-posting-flow`).

### 8.2 `process-scheduled-posts`

**Purpose** Cron picker. Selects `posts` where `status='scheduled'` and `scheduled_at <= now()`, performs **selective JIT token refresh** (only for accounts in `metadata.selected_account_ids`), then invokes `process-post`.

**Access** Cron / service-role only.

**Invocation** `pg_cron` schedule (configurable in `/admin/cron`).

**Input** No body; uses environment + DB.

**Output** `{ success: true, processed: N, failed: M }`.

**Side effects**
- Sets `posts.status='processing'` before calling `process-post`.
- Per-account token refresh writes `token_refresh_history`.
- Logs `scheduler_jit_refresh_*` and `scheduler_pick_*` events.

**Notes**
- JIT refresh is **selective** — only the accounts the user actually picked are
  refreshed, to avoid exhausting platform refresh quotas
  (`mem://technical-decisions/scheduler-refresh-logic`).
- Uses `posts.status = 'scheduled'` (enforced by `posts_status_check`).

### 8.3 `n8n-api`

**Purpose** The single public REST surface. Used by `n8n-nodes-postora` and the
Make.com app to manage posts, accounts, media, and the scheduler.

**Access** `Authorization: Bearer <profiles.api_key>` (key prefix `postora-…`).

**Method/paths** `function_url + "?path=..."` or `/posts`, `/accounts`, `/media`,
`/schedule`. Verb is read from the HTTP method.

**Common operations**

| Method + path | Purpose |
|---|---|
| `GET  /accounts` | List connected social accounts |
| `GET  /posts` | List posts (paginated) |
| `POST /posts` | Create + immediately publish |
| `POST /schedule` | Create a scheduled post |
| `GET  /schedule` | List upcoming scheduled posts |
| `DELETE /schedule/:id` | Cancel scheduled post |
| `PUT /schedule/:id` | Edit scheduled post |
| `GET  /media` | List media files |
| `POST /media` | Upload (multipart or `media_base64` data URI) |

**Output** `{ success, data, usage: { count, limit, window } }`.

**Errors**
- `401` when api_key is missing/invalid.
- `429` when over the per-user rate limit (default **30/hour**, configurable per user
  in `/admin/rate-limits`; see `mem://technical-decisions/api-rate-limiting`).
- `400` for validation failures with field-level error map.

**Side effects**
- Writes to `api_logs` for *every* call (used to compute the rate-limit window).
- For posting, behaves the same as the SPA → `process-post` flow.

**Notes**
- Documented gaps: no full granular CRUD on every resource yet
  (`mem://api/public-api-gaps`).
- Scheduling readiness uses standard preflight checks
  (`mem://api/n8n-integration/endpoint-structure`).

### 8.4 `threads-oauth`

**Purpose** Threads OAuth (separate from Facebook OAuth — distinct App ID and Secret).

**Access** User JWT.

**Actions** (request body `{ action }`)

| Action | Purpose |
|---|---|
| `get-auth-url` | Build Meta consent URL using `THREADS_APP_ID` + `redirect_uri` |
| `exchange-code` | Exchange `code` for short-lived → long-lived token (`graph.threads.net`) |
| `disconnect` | Soft-disconnect (`is_active=false`) |

**Critical guard** Refuses to build an HTTP redirect URI; logs
`threads_oauth_insecure_redirect_blocked` and returns
`{ success:false, error_code: 1349187, error: "Threads requires HTTPS" }`. The
frontend (`useProfileOAuth`) also blocks before calling.

**Errors**
- `1349187` — insecure redirect (HTTP).
- `4476002` — wrong App ID (Facebook ID used instead of Threads ID).
- `redirect_uri_mismatch` — URI not in the Threads app dashboard.

**Side effects**
- On successful exchange, upserts `social_accounts` (platform=`threads`) with
  `account_metadata.capabilities.canCrossShareToIg`, `granted_scopes`, etc.
- Logs `threads_oauth_authorize_url_built` / `threads_oauth_callback_*`.

**Notes**
- Required redirect URIs are listed in `mem://auth/platform-redirect-uris`.
- `THREADS_DEMO_MODE` secret toggles a sandbox path used by `tiktok-demo-publish`-style
  diagnostics. *(inferred from secret presence; behavior centralized in
  `_shared/threads-debug.ts`.)*

### 8.5 `generate-caption`

**Purpose** AI caption generator.

**Access** User JWT.

**Input**
```jsonc
{
  "platform": "instagram" | "facebook" | "threads" | "tiktok" | "youtube" | "linkedin" | "twitter" | "pinterest",
  "tone": "professional" | "casual" | "funny" | "inspiring" | ...,
  "language": "en" | "ar" | "es" | ...,
  "length": "short" | "medium" | "long",
  "keywords": ["..."],
  "context": "...",                   // optional free-form context
  "image_url": "...",                 // optional — vision-enabled providers
  "model_override": "gemini-2.5-flash" // optional — falls back to user pref → system default
}
```

**Output**
```jsonc
{
  "success": true,
  "caption": "...",
  "credits_remaining": 47,
  "model_used": "gemini-2.5-flash",
  "provider": "gemini"
}
```

**Errors**
- `402` (or 200 + `success:false`) when out of credits.
- `503` after exhausting the AI fallback chain.

**Side effects**
- Decrements `user_credits.balance` by **1** (`use_credits` RPC).
- Inserts into `caption_history` and AI observability tables.

**Notes**
- Provider chain resolved via `get_active_ai_model_config(user_id, 'caption')` →
  `_shared/ai-fallback.ts` (see `mem://technical-decisions/ai-infrastructure-v3`).

### 8.6 `generate-hashtags`

Same shape as `generate-caption` but returns `{ hashtags: string[] }`. Cost: **1 credit**.

### 8.7 `generate-image`

**Input**
```jsonc
{
  "prompt": "...",
  "aspect_ratio": "1:1" | "16:9" | "9:16" | "4:5",
  "model": "imagen-4-standard" | "imagen-4-fast" | "imagen-4-ultra" | "gemini-2.5-flash-image",
  "reference_image_url": "..."   // optional
}
```

**Output** `{ success, image_url, model_used, credits_remaining }`. Cost: **2 credits**.

**Notes** Image models are scoped to the dedicated media-model list
(`mem://features/ai-generation/image-model-governance`). YouTube thumbnail variant
costs **2 credits** as well.

### 8.8 `suggest-best-times`

**Input** `{ platform, account_id }`.
**Output** `{ success, suggestions: [{ day, hour, score }] }`.
**Notes** Uses historical `platform_posts` engagement plus heuristics. No credit cost.

### 8.9 `manage-app-secrets`

**Access** Admin only.

**Actions** `list`, `get`, `set`, `delete` over the `app_credentials` table — used by
the App Credentials Manager at `/admin/settings`
(`mem://admin/app-credentials-manager`).

**Notes** Resolves to the Supabase secret store for vault-managed names; otherwise
to `app_credentials.secret_value`. Writing logs an `admin_audit_log` entry.

### 8.10 `manage-cron-jobs`

**Access** Admin only.
**Actions** `list`, `toggle`, `edit-schedule`. Backed by `get_cron_jobs()` /
`toggle_cron_job()` RPCs.

### 8.11 `manage-oauth-redirects`

**Access** Admin only.
**Purpose** CRUD over `oauth_redirect_requests` and `oauth_apps`.

### 8.12 `threads-debug-publish-check`

**Access** Admin only.
**Purpose** Dry-run diagnostic — does **not** publish. Returns redacted token info,
granted scopes, capability flags, the sample payload that *would* be sent, and a
`/me` echo from Meta.
**Input** `{ account_id, hypothetical?: 'text'|'image'|'video'|'carousel' }`.
**Output** `{ ok, account, token: {length, prefix}, scopes, capabilities, samplePayload, meEndpointStatus, meEndpointBody, crossShareWouldBeSent, crossShareSkipReason }`.
**Notes** First place to look when diagnosing Threads publish failures.

### 8.13 `whatsapp-config-test`

**Access** Admin only.
**Purpose** Validates `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_BUSINESS_ACCOUNT_ID`. Returns each probe's HTTP status.

### 8.14 `test-ai-model`

**Access** Admin only.
**Purpose** Per-provider validation ping. Strategy varies per provider
(`mem://admin/ai-provider-specific-configs`).

### 8.15 `analyze-log`

**Access** Admin only.
**Input** `{ log_id }`.
**Output** `{ explanation, root_cause, lovable_prompt }`. Result cached in
`log_analyses` keyed on `log_id`.

### 8.16 `check-connection-health`

**Access** User JWT.
**Purpose** Probe each of the user's `social_accounts` and update
`account_metadata.health.*` and `is_active`.
**Output** Per-account `{ ok, last_checked_at, error? }` map.

### 8.17 `refresh-tokens`

**Access** Cron.
**Purpose** Per-platform refresh batch. Writes one `token_refresh_history` row per
attempt. Logs `token_refresh_*` events.
**Notes** LinkedIn does not refresh in-place — affected rows get
`error: 'reconnect-required'` (`mem://auth/linkedin-app-credentials`).

### 8.18 `pinterest-boards`

**Input** `{ social_account_id }`.
**Output** `{ success, boards: [{ id, name, privacy }] }`.
**Notes** Refresh button on the composer hits this directly.

### 8.19 `tiktok-webhook`

**Access** Public (TikTok-signed).
**Purpose** Receives `post.publish.complete`, `post.publish.failed`, etc. Updates
`platform_posts.status`.

### 8.20 `whatsapp-webhook`

**Access** Public.
**Purpose**
- `GET` — verification challenge (validates `hub.verify_token` ==
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN`).
- `POST` — inbound messages and delivery statuses → `messaging_cache`.

### 8.21 `stripe-webhook`

**Access** Public (Stripe-signed via `STRIPE_WEBHOOK_SECRET`).
**Events handled**: `checkout.session.completed`, `customer.subscription.*`,
`invoice.payment_succeeded`, `invoice.payment_failed`. Updates
`user_subscriptions` and triggers `set_user_quotas_for_plan()`.

### 8.22 `resend-webhook`

**Access** Public (Svix-signed via `RESEND_WEBHOOK_SECRET`).
**Updates** `email_log.status` via `update_email_status()` RPC.

### 8.23 `send-auth-email`

**Access** Supabase auth hook (signed via `SEND_EMAIL_HOOK_SECRET`).
**Purpose** Renders + sends auth-flow emails (signup confirmation, password reset,
magic link) through Resend with custom branded templates.

### 8.24 Other concise entries

| Function | One-line note |
|---|---|
| `cleanup-media` | Sweeps `media_files` rows whose Cloudinary asset is gone (cron). |
| `observability-collector` | Hourly: rolls up `system_health_snapshots`, `edge_function_status`. |
| `observability-alerts` | Evaluates `observability_alert_configs`, writes `observability_alert_history`, dispatches Slack/email. |
| `sync-user-quotas` | Reapplies `set_user_quotas_for_plan` for all active subs. |
| `notify-admin-new-user` | Slack + email on new signup. |
| `notify-expiring-ai-overrides` | Warns admins about user-level AI provider overrides nearing expiry. |
| `get-public-config` | Returns publishable config (no secrets) for the SPA bootstrap. |
| `unsplash-proxy` | Rate-limited Unsplash search proxy. |
| `brand-scrape` | Apify-backed competitor scraping (cached in `brand_scrape_cache`). |
| `ad-analytics` / `ad-manager` / `leads-api` | Meta Ads + Lead Ads (partial / experimental). |
| `messaging-api` | Unified inbox CRUD for FB/IG/WA. |
| `comment-manager` | Comment list/reply/hide for FB/IG. |
| `facebook-places-search` | FB Places lookup for location tagging. |
| `verify-mfa-reset` / `verify-reset-otp` | OTP verification for MFA disable / password reset. |
| `tiktok-analytics` / `tiktok-check-status` | Read-only TikTok helpers. |
| `tiktok-demo-publish` | Sandbox publish (admin only; bypasses live API). |
| `whatsapp-broadcast` / `whatsapp-profile` / `whatsapp-scheduled-sender` | WA business operations. |
| `process-scheduled-blog-posts` / `process-scheduled-flags` / `process-scheduled-emails` | Cron-only thin wrappers around their respective domains. |
| `send-token-expiry-notifications` / `send-expiry-reminders` / `send-token-failure-alert` | Token health emails. |
| `send-weekly-analytics` | Weekly digest email. |
| `send-subscription-email` | Subscription lifecycle emails. |
| `send-inbox-email` | Send from the admin inbox via Resend. |
| `send-reset-otp` | Email-OTP for password reset. |
| `sync-resend-delivery-status` | Pulls recent delivery statuses from Resend. |
| `fetch-email-content` | Returns full HTML/text for an email_log row. |
| `fetch-openrouter-models` | Refreshes the OpenRouter catalog cache. |
| `openrouter-models` | Reads the cached catalog. |
| `ai-config` | Read/write AI provider+model selection. |
| `ai-email-assistant` | Compose-assist for the admin inbox. |
| `cloudinary-upload` / `-delete` / `-rename` / `-email-upload` | Direct Cloudinary helpers. |
| `process-video` / `transcode-video` | Video pipeline (transcode runs on an external service — Deno has no FFmpeg). |
| `transcribe-media` | 3-tier STT fallback. |
| `remove-background` / `upscale-image` / `upscale-image-atlas` | Image AI tools. |
| `check-music-copyright` | ACRCloud lookup. |
| `create-payment` / `verify-payment` | Stripe one-off payment intents (credit packs). |
| `stripe-checkout` / `stripe-manage-subscription` / `check-subscription` / `backfill-subscription` | Subscription operations. |

---

## 9. OAuth flow references by platform

All OAuth functions accept `{ action: 'get-auth-url' | 'exchange-code' | 'disconnect' }`
and many also support `'refresh'`. Frontend orchestration lives in
`src/hooks/oauth/useProfileOAuth.tsx` and `src/pages/OAuthCallback.tsx`.

### Registered redirect URIs

(See `mem://auth/platform-redirect-uris` for the canonical list.)

| Platform group | Production URI |
|---|---|
| Meta (FB/IG/Threads/WA) | `https://postora.cloud/profiles` and `https://postora.lovable.app/profiles` |
| Google/YouTube | same |
| TikTok | same |
| Pinterest | same |
| LinkedIn | same |
| Twitter | same |
| Reddit / Bluesky | same |

> **Threads is HTTPS-only** at the Meta OAuth gateway. Localhost is impossible —
> use the preview URL.

### Per-platform notes

| Platform | Function | Required secrets | Scopes (high-level) | Notes |
|---|---|---|---|---|
| Facebook | `facebook-oauth` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`, `read_insights`, `business_management` | Phantom-account guard prevents creating empty FB rows when the user has no manageable Pages (`mem://auth/facebook-phantom-account-prevention`). Graph API v22.0. |
| Instagram | `instagram-oauth` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`, optional `instagram_manage_messages` | Dual flow — FB-Page-linked + IG Business Login. Direct IG Business Login marked via `account_metadata.business_login=true` (`mem://auth/instagram-business-login-integration`). |
| Threads | `threads-oauth` | `THREADS_APP_ID`, `THREADS_APP_SECRET` | `threads_basic`, `threads_content_publish`, `threads_manage_insights`, `threads_manage_replies`, `threads_keyword_search`, `threads_location_tagging` (Advanced Access) | HTTPS-only. Distinct App from Facebook — using FB App ID returns `4476002`. |
| TikTok | `tiktok-oauth` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `user.info.basic`, `user.info.profile`, `video.publish`, `video.upload` | PKCE. Uses `creator_info` API for UX gating (`mem://features/tiktok-integration/core-posting-flow`). |
| YouTube | `youtube-oauth` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `youtube.readonly`, `youtube.upload`, `youtube.force-ssl` | All three requested at connect; the granted set is stored as `account_metadata.granted_scopes`. Comments (Comment Manager, agent, workflows, `youtube-poll-comments`) need `force-ssl`; a channel connected before it was requested must reconnect. Composio-managed channels (`auth_provider = composio`) hold it already. Refresh-cap of 100 while in Testing mode. |
| Pinterest | `pinterest-oauth` | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` | `boards:read`, `pins:read`, `pins:write`, `user_accounts:read` | Boards listed via `pinterest-boards`. |
| LinkedIn | `linkedin-oauth` | `LINKEDIN_CLIENT_ID` (`77k0p74fi3zlau`), `LINKEDIN_CLIENT_SECRET` | OIDC: `openid`, `profile`, `email`; posting: `w_member_social`, `w_organization_social`, `r_organization_social` | 24h cache rule; refresh = disconnect+reconnect (`mem://auth/linkedin-app-credentials`). |
| Twitter/X | `twitter-oauth` | `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | `tweet.read`, `tweet.write`, `users.read`, `offline.access` | Requires Basic tier or higher (`mem://auth/twitter-x-access-tier-handling`). |
| Bluesky | `bluesky-oauth` | none (ATProto) | n/a | DPoP-bound tokens; every call (auth, refresh, publish) must reuse the same DPoP key (`mem://auth/bluesky-atproto-implementation`). |
| Reddit | `reddit-oauth` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` *(inferred — verify in `_shared/social-auth.ts`)* | `identity`, `submit`, `read`, `flair` | Permanent refresh tokens. |
| WhatsApp | `whatsapp-oauth` | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_VERIFY_PIN` | n/a | Embedded Signup; webhook verifies via verify token. |

### Structured success / error shape

```jsonc
// success
{
  "success": true,
  "account": {
    "id": "uuid",
    "platform": "threads",
    "platform_username": "@user",
    "capabilities": { "canCrossShareToIg": true, ... }
  }
}

// expected failure
{
  "success": false,
  "error_code": "1349187" | "4476002" | "redirect_uri_mismatch" | "missing_scope" | "...",
  "error": "human readable",
  "details": { "scope_requested": [...], "scope_granted": [...] }
}
```

---

## 10. Posting pipeline reference

### 10.1 Composer → DB

`CreatePost.tsx` + `usePostForm` + `usePlatformSettings` build the row:

```jsonc
{
  "user_id": "uuid",
  "caption": "...",
  "platforms": ["facebook","instagram","threads","tiktok","youtube","pinterest"],
  "media_file_ids": ["uuid"],
  "metadata": {
    "selected_account_ids": ["uuid", "..."],
    "platform_settings": {
      "facebook":  { ... },
      "instagram": { ... },
      "threads":   { ... },
      "tiktok":    { ... },
      "youtube":   { ... },
      "pinterest": { ... },
      "linkedin":  { ... }
    }
  },
  "status": "pending" | "scheduled",
  "scheduled_at": "<iso>" | null
}
```

### 10.2 Dispatch (`process-post`)

For each `platforms[i]`:

1. Resolve all selected accounts whose `platform = platforms[i]`.
2. Probe `account_metadata.capabilities.*` (silently downgrades unsupported features —
   logged as a `warning`).
3. Run platform branch (FB/IG/Threads/TikTok/YT/Pinterest/LinkedIn/Twitter/Bluesky/
   Reddit). Branch returns:
   ```jsonc
   { success, platform_post_id?, platform_post_url?, warnings?: string[],
     response_data?: {...}, error_code?, error? }
   ```
4. Persist to `platform_posts` (one row per `(post_id, social_account_id)`).
5. Return aggregated `results` map (§4) and update `posts.status`.

### 10.3 `platform_posts` row contract

| Column | Notes |
|---|---|
| `status` | `'pending' \| 'success' \| 'failed'` |
| `platform_post_id` | Upstream post ID (e.g., FB `<pageId>_<postId>`) |
| `platform_post_url` | Best-effort canonical URL |
| `error_message` | Sanitized error |
| `response_data` | Sanitized upstream JSON + `warnings: string[]` |
| `posted_at` | Set on success |

### 10.4 Real-time

The SPA subscribes via `useRealtimePostUpdates` to `posts` and `platform_posts`
changes — toast and badges update without polling.

### 10.5 Scheduler (`process-scheduled-posts`)

- Picks `posts where status='scheduled' and scheduled_at <= now()`.
- Sets `status='processing'`.
- Calls `refresh-tokens`-style logic **only on selected accounts**.
- Invokes `process-post` with the same `{ post_id }` shape.
- See `mem://technical-decisions/scheduler-refresh-logic` and
  `mem://technical-decisions/scheduled-post-status-integration`.

### 10.6 Stories pathway

Facebook + Instagram Stories use a specialized branch in `process-post` (
`mem://features/facebook-instagram-story-publishing/implementation-details`):
- IG: container-based (`media_type=STORIES`), then publish.
- FB: `/{pageId}/photo_stories` or `/{pageId}/video_stories`.

### 10.7 Pinterest 3-step async

1. Register media-upload intent → upload params.
2. Upload to S3.
3. Poll status until `succeeded`, then create the pin.
   See `mem://features/pinterest-integration/technical-requirements`.

### 10.8 Threads safety nets

- Caption clamped to **500 chars**.
- `location_id` only sent if the account has Threads Advanced Access (capability flag).
- `share_to_instagram` (cross-reshare) only sent if `capabilities.canCrossShareToIg`
  is true and the post is text/image (not video, not carousel).
  See `mem://features/threads-integration/core-implementation`.

---

## 11. AI generation endpoints reference

### 11.1 Provider resolution

For every AI call:
```
get_active_ai_model_config(user_id, feature)
  → user pref (ai_model_preferences)
  → system default (system_settings.default_ai_model_<feature>)
  → system default (system_settings.default_ai_model)
  → hardcoded fallback: gemini-2.5-flash
```
After the model is chosen, `_shared/ai-fallback.ts` walks a 3-tier provider chain on
failure (Primary → Fallback → Last Resort). All calls are logged for observability
(`mem://admin/ai-call-observability`).

### 11.2 Endpoints summary

| Endpoint | Cost | Output |
|---|---|---|
| `generate-caption` | 1 credit | `{ caption }` |
| `generate-hashtags` | 1 credit | `{ hashtags: string[] }` |
| `generate-image` | 2 credits | `{ image_url }` |
| `suggest-best-times` | 0 | `{ suggestions: [{day,hour,score}] }` |
| `transcribe-media` | varies | `{ transcript, language, segments? }` |
| `ai-email-assistant` | varies | `{ draft }` |

### 11.3 Image governance

Image generation is restricted to dedicated media models — no general-purpose chat
models are allowed in this code path
(`mem://features/ai-generation/image-model-governance`).

---

## 12. Utility / admin / debug endpoints reference

| Endpoint | Notable input/output |
|---|---|
| `refresh-tokens` | No body; returns `{ refreshed, failed, by_platform }`. |
| `check-connection-health` | `{ account_ids? }` → per-account `{ ok, error? }`. |
| `pinterest-boards` | `{ social_account_id }` → `{ boards: [{id,name,privacy}] }`. |
| `n8n-api` | Full REST surface; see §8.3. |
| `tiktok-webhook` | Public; signature-verified. |
| `threads-debug-publish-check` | Admin; full diagnostic envelope (§8.12). |
| `whatsapp-config-test` | Admin; per-secret HTTP probe results. |
| `test-ai-model` | Admin; `{ provider_code, model_id }` → `{ ok, latency_ms, sample? }`. |
| `analyze-log` | Admin; `{ log_id }` → `{ explanation, root_cause, lovable_prompt }`. |
| `manage-app-secrets` | Admin; `{ action: 'list'\|'get'\|'set'\|'delete', name?, value? }`. |
| `manage-cron-jobs` | Admin; `{ action: 'list'\|'toggle'\|'edit', jobid?, active?, schedule? }`. |
| `manage-oauth-redirects` | Admin; CRUD. |
| `get-public-config` | Public; safe config for SPA bootstrap. |
| `observability-collector` | Cron; computes `system_health_snapshots` row. |
| `observability-alerts` | Evaluates configs; writes `observability_alert_history`. |
| `unsplash-proxy` | `?query=…&page=…` rate-limited. |
| `cleanup-media` | Removes orphaned `media_files`. |
| `verify-mfa-reset` / `verify-reset-otp` | OTP/MFA helpers. |

---

## 13. Platform-specific metadata reference

Read by `process-post` from `posts.metadata.platform_settings.<platform>`. Field maps
are sourced directly from `process-post/index.ts`.

### TikTok — `metadata.platform_settings.tiktok`
```jsonc
{
  "privacy_level": "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY",
  "disable_comment": false,
  "disable_duet": false,
  "disable_stitch": false,
  "brand_content_toggle": false,   // disclosure: branded content
  "brand_organic_toggle": false,   // disclosure: your brand
  "is_aigc": false                 // AI-generated content disclosure
}
```
Required: `privacy_level` (no default). Duet/Stitch are auto-disabled for photo posts.

### YouTube — `metadata.platform_settings.youtube`
```jsonc
{
  "privacy": "private" | "unlisted" | "public",
  "category_id": "22",             // YouTube Data API category
  "tags": ["..."],
  "made_for_kids": false,
  "is_short": true,                // routes to Shorts UI
  "thumbnail_url": "https://...",
  "thumbnail_media_id": "uuid",
  "language": "en",
  "country": "US"                  // ISO 3166-1 alpha-2
}
```
See `mem://features/youtube-integration/creation-settings`.

### Instagram — `metadata.platform_settings.instagram`
```jsonc
{
  "is_carousel": false,            // 2..10 items
  "is_reel": false,
  "is_story": false,
  "share_to_feed": true,           // for Reels
  "audio_name": "Custom audio",    // Reels
  "collaborators": ["@user1"],
  "location_id": "...",
  "cover_url": "https://...",      // Reels cover
  "first_comment": "..."
}
```
- IG video container poll cap: 60×3s (180s total).
- IG delivery URLs are re-encoded `f_jpg,q_auto` to dodge "media type not accepted"
  (`mem://technical-decisions/instagram-media-delivery-optimization`).

### Facebook — `metadata.platform_settings.facebook`
```jsonc
{
  "page_id": "...",
  "is_reel": false,
  "is_story": false,
  "place_id": "...",               // FB Places ID
  "link_attachment": "https://...",
  "first_comment": "..."
}
```
Single-media `feed` posts containing video are routed to `/{pageId}/videos` via
`file_url` (`mem://features/facebook-integration/video-feed-routing`).

### Pinterest — `metadata.platform_settings.pinterest`
```jsonc
{
  "board_id": "...",               // required
  "link": "https://...",
  "alt_text": "..."
}
```
Video keyframe interval must be 1 s.

### Threads — `metadata.platform_settings.threads`
```jsonc
{
  "location_id": "...",            // requires Advanced Access
  "share_to_instagram": true,      // skipped silently for video/carousel or no IG link
  "quote_post_id": "...",
  "reply_to_id": "..."
}
```
Caption clamped to 500 chars server-side.

### LinkedIn — `metadata.platform_settings.linkedin`
```jsonc
{
  "linkedin_page_id": "...",       // optional (org page); else personal
  "visibility": "PUBLIC" | "CONNECTIONS"
}
```

### Twitter — `metadata.platform_settings.twitter`
```jsonc
{
  "thread": ["...", "..."],        // optional reply chain
  "reply_to_tweet_id": "..."
}
```

### `social_accounts.account_metadata`

| Path | Purpose |
|---|---|
| `capabilities.*` | What the token can do — e.g. `canCrossShareToIg`, `canPublishVideo`, `canTagLocation`. Refreshed during OAuth and `check-connection-health`. |
| `granted_scopes` | The actual scopes the upstream issued (may be a subset of requested). |
| `platform_specific.*` | Per-platform extras (FB Page list, IG account id, YouTube channel id, WABA id, etc.). |
| `health.*` | Last-checked-at, error, status. |
| `business_login` | `true` for IG direct Business Login. |
| `capability_probe.*` | Last probe payload (used by `threads-debug-publish-check`). |

### `platform_posts.response_data`

Per-platform sanitized upstream response. Always includes:
```jsonc
{
  "warnings": ["cross_share_skipped", "tiktok_brand_disclosure_required", "..."],
  "raw": { ... }                   // optional: trimmed upstream JSON
}
```

---

## 14. Common database side effects

| Flow | Tables written |
|---|---|
| Publish | `posts`, `platform_posts`, `media_files` (read), `social_accounts` (read; sometimes refresh writes), `token_refresh_history`, `system_logs`, `user_quotas` (post counter), `credit_transactions` (only if AI was used in composer) |
| Schedule | `posts` (status `scheduled`), then full publish path |
| OAuth connect | `social_accounts` (upsert), `social_profiles` (auto-grouping), `system_logs`, `admin_audit_log` (for admin-triggered actions) |
| AI gen | `user_credits` (debit), `credit_transactions`, `caption_history` / `image_*`, AI observability rows, `system_logs` |
| Public API call | `api_logs` (always), then whichever flow it triggered |
| Admin actions | `admin_audit_log` (mandatory for state changes) |
| Webhook (Stripe/WA/Resend/TikTok) | Domain-specific (`user_subscriptions`, `messaging_cache`, `email_log`, `platform_posts`) |

---

## 15. Known caveats & limitations

- **Deno runtime has no FFmpeg** — video transcoding goes through external services
  (`mem://technical-decisions/edge-function-constraints`).
- **Threads OAuth requires HTTPS** — `error_code 1349187` blocked at both the frontend
  guard and the `threads-oauth` function.
- **Threads App ID ≠ Facebook App ID** — using the wrong one returns `4476002`.
- **Twitter/X requires Basic tier** — Free tier rejects publish (`mem://auth/twitter-x-access-tier-handling`).
- **YouTube refresh cap = 100** while the Google Cloud project is in Testing mode
  (`mem://auth/youtube-oauth-testing-constraints`).
- **LinkedIn does not refresh in place** — reconnect required when token is stale.
- **LinkedIn 24-hour cache rule** — content cached for compliance.
- **IG video poll** — 60 attempts × 3 s, then `ig_video_processing_timeout`.
- **Storage RLS path convention** — first segment of any object key must be `${userId}/`
  (`mem://technical-decisions/storage-rls-path-convention`).
- **`n8n-api` rate limit** — default 30/hour per user, configurable in `/admin/rate-limits`.
- **Capability silent-drop** — `process-post` never hard-fails on a capability gap; it
  drops the unsupported field and adds a `warning` instead.
- **Bluesky DPoP** — every request must reuse the same DPoP key throughout the session.

---

## 16. Operator debugging notes

- Edge Function logs:
  `https://supabase.com/dashboard/project/efruibswazzuuupgyzmf/functions/<function-name>/logs`
- App-side log viewer: `/admin/logs` (filter by `service` and `level`).
- Health: `/admin/observability` and `/admin/token-health`.
- Cron status: `/admin/cron`.
- Token refresh history: `/admin/token-health` → "Refresh log" tab.
- Sentry catches uncaught frontend errors.
- Use the `analyze-log` endpoint (or its `/admin/logs` UI button) to get an LLM
  explanation + a Lovable prompt for any log row.

---

## 17. Common OAuth failure patterns

| Symptom | `error_code` | Root cause | Fix |
|---|---|---|---|
| Threads "Insecure Login Blocked" | `1349187` | Redirect URI is HTTP | Use `postora.cloud` / `postora.lovable.app` |
| Threads "App ID does not match" | `4476002` | Used FB App ID instead of Threads App ID | Set `THREADS_APP_ID` / `THREADS_APP_SECRET` |
| Meta `redirect_uri` mismatch | `redirect_uri_mismatch` | URI not in app dashboard | Add to Valid OAuth Redirect URIs |
| TikTok "invalid_client" | `invalid_client` | Wrong client key/secret | Re-paste in `/admin/settings` |
| TikTok consent fails | `unauthorized_scope_error` | Scope not approved in app review | Apply for the scope or remove the request |
| YouTube "redirect_uri_mismatch" | `redirect_uri_mismatch` | URI not in Google Cloud Console | Add it under OAuth client |
| YouTube refresh fails after a while | `youtube_refresh_limit` | Project still in Testing mode (100-refresh cap) | Move to Production |
| LinkedIn refresh ignored | `linkedin_token_stale` | LinkedIn doesn't refresh in-place | Disconnect + reconnect |
| Twitter publish rejected | `twitter_tier_too_low` | App on Free tier | Upgrade to Basic+ |
| Empty FB account row | (none) | User has no manageable Pages | Phantom-account guard prevents the insert |
| LinkedIn returns "scope not granted" | `missing_scope` | User declined `w_organization_social` | Re-consent with org permissions |
| OAuth state validation fails | `invalid_state` | State HMAC mismatch (tab swap, replay) | Restart the connect flow |

---

## 18. Common posting failure patterns

| Symptom | Where it surfaces | Likely cause |
|---|---|---|
| TikTok publish silently rejected | `error_code: tiktok_privacy_required` | `privacy_level` not picked in composer |
| IG carousel rejected | `ig_carousel_too_many` | More than 10 items |
| IG container never finishes | `ig_video_processing_timeout` | 60×3s exhausted; usually transient — retry |
| FB Story rejects video | `fb_video_format_unsupported` | Codec/container mismatch — re-encode H.264+AAC MP4 |
| Pinterest video upload "invalid" | `pinterest_keyframe_invalid` | Keyframe interval ≠ 1s |
| Threads location ignored | `warning: threads_location_unauthorized` | App lacks Advanced Access |
| Threads cross-share skipped | `warning: cross_share_skipped` | Video/carousel, or no IG linked, or capability missing |
| Caption truncated on Threads | `warning: threads_text_clamped` | Caption > 500 chars |
| YouTube comments show "Reconnect this channel" | `MISSING_SCOPE` from `comment-manager`, `reconnect_required` in the poller summary | Channel connected before `youtube.force-ssl` was requested (no `granted_scopes` record) — reconnect it on Profiles |
| LinkedIn org post fails | `missing_scope` | `w_organization_social` not granted |
| All platforms fail at scheduled time | `scheduler_jit_refresh_failed` | Token refresh failed — check `token_refresh_history` |
| Capability silently dropped | `warning: capability_missing` | Probe found scope/feature unavailable; re-connect |

---

## 19. Logs to inspect first

| Flow | Function logs | `system_logs.service` filter | Key event names |
|---|---|---|---|
| Publish | `process-post` | `process-post` | `process_post_publish_start`, `process_post_branch_<platform>_*`, `ig_video_poll_attempt` |
| Schedule | `process-scheduled-posts` → `process-post` | `process-scheduled-posts` | `scheduler_pick_*`, `scheduler_jit_refresh_*` |
| Threads OAuth | `threads-oauth` | `threads-oauth` | `threads_oauth_authorize_url_built`, `threads_oauth_insecure_redirect_blocked`, `threads_oauth_callback_*` |
| Threads diagnostics | `threads-debug-publish-check` | `threads-debug-publish-check` | (returns full envelope; no events) |
| Token refresh | `refresh-tokens` | `refresh-tokens` | `token_refresh_*` (also `token_refresh_history` row) |
| Public API | `n8n-api` | `n8n-api` | `n8n_api_request` (also `api_logs` row) |
| AI generation | `generate-*` | `ai` | `ai_call_*`, `ai_fallback_used` |
| WhatsApp inbound | `whatsapp-webhook` | `whatsapp` | `wa_inbound_*`, `wa_status_*` |
| Stripe | `stripe-webhook` | `stripe` | `stripe_event_*` |

---

## 20. Quick API Debug Checklist

### Auth failures
- [ ] Is the SPA session still valid? (`useAuth` should not be `null`)
- [ ] If using `n8n-api`, is `Authorization: Bearer postora-…` present?
- [ ] For admin endpoints: does the user actually have `user_roles.role='admin'`?
- [ ] For webhooks: is the upstream signature header present and valid?

### Connect / reconnect failures
- [ ] Are the platform secrets set? (`/admin/settings` → App Credentials)
- [ ] Is the redirect URI registered upstream? (See §9 list)
- [ ] For Threads: are you on HTTPS? (`error_code 1349187`)
- [ ] For Threads: is `THREADS_APP_ID` (not `FACEBOOK_APP_ID`)? (`error_code 4476002`)
- [ ] For LinkedIn token issues: did you fully **disconnect** before reconnecting?
- [ ] For YouTube: is the GCP project out of Testing mode if you're refreshing often?

### Publish failures
- [ ] Check `platform_posts.error_message` for the row that failed.
- [ ] Look at `system_logs` filtered by `service='process-post'` and your `user_id`.
- [ ] For Threads-specific issues: run `threads-debug-publish-check` (admin).
- [ ] Verify `account_metadata.capabilities.*` matches the feature you tried to use.
- [ ] For IG video: was the 60×3s poll exhausted? (Retry — usually transient.)
- [ ] For TikTok: is `privacy_level` set?

### AI generation failures
- [ ] Is `user_credits.balance` ≥ the cost? (1/1/2 for caption/hashtag/image)
- [ ] Is the active model (`get_active_ai_model_config`) actually enabled in `/admin/ai`?
- [ ] Did the fallback chain in `_shared/ai-fallback.ts` exhaust? (Look for
      `ai_fallback_used` events.)
- [ ] For provider-specific failures: run `test-ai-model` (admin) for that model.

### Admin credential problems
- [ ] Check `manage-app-secrets list` output — is the secret really set?
- [ ] Run the relevant diagnostic: `whatsapp-config-test`, `test-ai-model`,
      `threads-debug-publish-check`, `check-connection-health`.
- [ ] Check `admin_audit_log` for the last write to that secret.

---

## 21. AI Assistant API Map

A compact map for AI assistants and new contributors:

- **OAuth functions** → `supabase/functions/<platform>-oauth/index.ts`
  + frontend orchestration in `src/hooks/oauth/useProfileOAuth.tsx` and
  `src/pages/OAuthCallback.tsx`. Shared HMAC + helpers in
  `supabase/functions/_shared/social-auth.ts`.
- **Posting** → `supabase/functions/process-post/index.ts` (master, ~6k lines) and
  `supabase/functions/process-scheduled-posts/index.ts` (cron picker). Frontend
  composer: `src/pages/CreatePost.tsx` + `src/hooks/usePostForm.tsx` +
  `src/hooks/usePlatformSettings.tsx`.
- **AI endpoints** → `supabase/functions/generate-caption/index.ts`,
  `generate-hashtags/index.ts`, `generate-image/index.ts`,
  `suggest-best-times/index.ts`. Provider chain: `_shared/ai-fallback.ts`. Provider
  resolution RPC: `get_active_ai_model_config()`.
- **Threads tools** → `supabase/functions/threads-*` and `_shared/threads-debug.ts`.
  Frontend: `src/hooks/useThreads*`. Diagnostic UI under `/admin/...`.
- **Diagnostics first stops** → `threads-debug-publish-check`,
  `whatsapp-config-test`, `test-ai-model`, `check-connection-health`,
  `analyze-log`. UI: `/admin/logs`, `/admin/observability`, `/admin/token-health`.
- **Admin credentials** → `manage-app-secrets` (backend) + `/admin/settings`
  (UI). Rule of thumb: never add a hardcoded `Deno.env.get("…")` for a platform
  credential — go through the App Credentials Manager so admins can rotate it.
- **Shared helpers** → `supabase/functions/_shared/`:
  `cors.ts` (corsHeaders), `auth-helper.ts` (JWT resolution + admin gate),
  `logging.ts` (system_logs writer), `errorSanitizer.ts` (sanitize for clients),
  `rate-limiter.ts` (api_logs window), `social-auth.ts` (OAuth state HMAC + token
  helpers), `threads-debug.ts` (capability probe), `tokenExpiryConstants.ts`
  (per-platform refresh thresholds), `ai-fallback.ts` (3-tier provider chain),
  `avatar-cache.ts`, `cloudinary-email-helper.ts`.

---

*Last updated: 2026-04-22. Source of truth: the code in `supabase/functions/`.*
