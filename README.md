> **⚠️ Self-hosted migration notice (2026-06):** This project now runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference below to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

# Postora

> Multi-platform social media management with AI-assisted publishing, scheduling, analytics, unified messaging, and a complete admin operations suite.

- **Live app:** https://postora.cloud
- **Preview / staging:** https://postora.lovable.app
- **Operating entity:** WALEED PROLIFE LLC — 200 N Vineyard Blvd, Ste A325 334, Honolulu, HI 96817, USA
- **Supabase Backend:** Self-hosted Supabase (managed via Dokploy on VPS `86.48.2.205`) at `https://api.postora.cloud`

Postora connects to 11 social platforms, publishes immediately or on a schedule, generates content with AI, ingests cross-platform analytics, and exposes everything through a hardened admin console plus a public API used by the official n8n and Make.com integrations.

---

## Table of contents

1. [What Postora does](#what-postora-does)
2. [Core features](#core-features)
3. [Supported platforms](#supported-platforms)
4. [Platform capability matrix](#platform-capability-matrix)
5. [Architecture overview](#architecture-overview)
6. [Tech stack](#tech-stack)
7. [Project structure](#project-structure)
8. [Frontend structure](#frontend-structure)
9. [Backend / Supabase Edge Functions](#backend--supabase-edge-functions)
10. [OAuth / authentication flows](#oauth--authentication-flows)
11. [Posting pipeline](#posting-pipeline)
12. [Threads module](#threads-module)
13. [AI capabilities](#ai-capabilities)
14. [Admin panel capabilities](#admin-panel-capabilities)
15. [Database overview](#database-overview)
16. [Configuration and env vars](#configuration-and-env-vars)
17. [App credentials / secrets](#app-credentials--secrets)
18. [Running locally](#running-locally)
19. [Production deployment](#production-deployment)
20. [Docker / nginx setup](#docker--nginx-setup)
21. [Common debugging workflows](#common-debugging-workflows)
22. [Known limitations / operational notes](#known-limitations--operational-notes)
23. [Recommended reconnect / credential procedures](#recommended-reconnect--credential-procedures)
24. [Logging and diagnostics](#logging-and-diagnostics)
25. [Roadmap](#roadmap)
26. [Contributing / maintenance](#contributing--maintenance)
27. [Edge function reference (appendix)](#edge-function-reference-appendix)
28. [Quick Start for Operators](#quick-start-for-operators)
29. [AI Assistant Context](#ai-assistant-context)

---

## What Postora does

Postora is a single-tenant per-user social media operations platform. Users:

- Connect accounts on 11 networks via OAuth.
- Group accounts into **Social Profiles** (multi-tenant style, per user).
- Compose posts in a unified composer with platform-specific overrides (TikTok privacy, YouTube category/Shorts, IG carousel, FB Pages, Pinterest boards, Threads location, etc.).
- Publish immediately or schedule via a cron-driven dispatcher with just-in-time token refresh.
- Generate captions, hashtags, images, and best-time suggestions with AI.
- Run cross-platform analytics, brand intelligence scraping, Threads discovery, and unified messaging (Facebook / Instagram / WhatsApp).
- Operate the full system from `/admin/*` — credentials, plans, quotas, OAuth verification, observability, token health, feature flags, launch checklist.

---

## Core features

### Production-ready (implemented)

- Multi-platform publishing for Facebook, Instagram, Threads, TikTok, YouTube, Pinterest, LinkedIn, Twitter/X.
- Scheduled posts with JIT token refresh (`process-scheduled-posts`).
- Media library with Cloudinary backing, aspect-ratio metadata, folder structure, admin "view as user" mode.
- AI suite: caption / hashtag / image generation, best-time suggestions, transcription, brand scraping, log analysis.
- Threads tooling: discovery, keyword search, insights, location search, comment / quote / repost / delete, admin debug check.
- Unified inbox for Facebook, Instagram, WhatsApp (`messaging-api` + `comment-manager`).
- Public API for n8n and Make.com (`n8n-api`) with rate limiting via `api_logs`.
- Subscriptions + credits + coupons (Stripe).
- Admin observability suite (logs, health snapshots, alerts, token health, rate limits, plan quotas, feature flags, launch checklist).
- Two-factor auth (TOTP + hashed backup codes), MFA reset flow.
- Resend-backed admin email inbox with thread/draft/signature support.

### Partial / experimental

- **Bluesky** (`bluesky-oauth`) — ATProto + DPoP, posting works, limited surface.
- **Reddit** (`reddit-oauth`) — OAuth + basic posting.
- **WhatsApp Business Hub** — broadcast + scheduled sender + profile + webhook present; full hub UX still expanding.
- **Ad Manager** (`ad-manager`, `ad-analytics`) — Meta-only, scaffolded.
- **Leads CRM** (`leads-api`, `LeadsCRM.tsx`) — Meta lead-form ingestion, assignment + status workflow.
- **Canvas workflow builder** (`CanvasPage.tsx`, `@xyflow/react`) — visual builder, beta.
- **Smart Scheduling** (`SmartScheduling.tsx`) — best-time engine, beta UI.

### Admin-only

App credentials manager, OAuth app registry + verification, observability dashboards + alerts, rate limit configuration, plan quotas, token health, AI provider/model configuration, feature flags (with beta-platform tagging), launch checklist, media cleanup, scaling controls, blog posts ("What's New"), system notifications, scheduled flag/blog/email runners.

---

## Supported platforms

| # | Platform | OAuth function | Status |
|---|----------|----------------|--------|
| 1 | Facebook (Pages) | `facebook-oauth` | Stable |
| 2 | Instagram (FB-linked + Business Login) | `instagram-oauth` | Stable |
| 3 | Threads | `threads-oauth` | Stable (HTTPS-only) |
| 4 | TikTok | `tiktok-oauth` | Stable (UX-compliant) |
| 5 | YouTube | `youtube-oauth` | Stable (Testing-mode caveats) |
| 6 | Pinterest | `pinterest-oauth` + `pinterest-boards` | Stable |
| 7 | LinkedIn | `linkedin-oauth` | Stable |
| 8 | Twitter/X | `twitter-oauth` | Stable (Basic tier required) |
| 9 | Bluesky | `bluesky-oauth` | Partial |
| 10 | Reddit | `reddit-oauth` | Partial |
| 11 | WhatsApp (Cloud API) | `whatsapp-oauth` | Partial (hub expanding) |

---

## Platform capability matrix

| Platform | OAuth | Publish | Scheduling | Analytics | Comments / Inbox | Status |
|----------|:-----:|:-------:|:----------:|:---------:|:----------------:|:------:|
| Facebook | ✅ | ✅ Page posts, photos, albums, video, Reels, Stories | ✅ | ✅ `brand-scrape` + `ad-analytics` | ✅ Inbox + comments | Stable |
| Instagram | ✅ | ✅ Feed, carousel (2–10), Reels, Stories | ✅ | ✅ `brand-scrape` | ✅ Inbox + comments | Stable |
| Threads | ✅ | ✅ Text / image / video, location, share-to-IG, repost, quote, comment, delete | ✅ | ✅ `threads-insights` + discovery | ✅ `threads-comment` | Stable |
| TikTok | ✅ | ✅ Video + photo slideshow (UX-compliant) | ✅ | ✅ `tiktok-analytics` | ⚠️ Read-only | Stable |
| YouTube | ✅ | ✅ Videos + Shorts | ✅ | ✅ via brand-scrape | ❌ | Stable |
| Pinterest | ✅ | ✅ Pins (image + video, async flow) | ✅ | ⚠️ Limited | ❌ | Stable |
| LinkedIn | ✅ | ✅ Text + image + video | ✅ | ⚠️ Limited | ❌ | Stable |
| Twitter/X | ✅ | ✅ Tweets + threads | ✅ | ⚠️ Limited | ❌ | Stable (Basic tier) |
| Bluesky | ✅ | ✅ Text posts | ✅ | ❌ | ❌ | Partial |
| Reddit | ✅ | ✅ Basic posting | ✅ | ❌ | ❌ | Partial |
| WhatsApp | ✅ | ✅ Broadcast + scheduled | ⚠️ via `whatsapp-scheduled-sender` | ❌ | ✅ Inbox | Partial |

---

## Architecture overview

```
                        ┌──────────────────────────────┐
                        │   React 18 SPA (Vite + TS)   │
                        │  TanStack Query • shadcn/ui  │
                        └──────────────┬───────────────┘
                                       │ supabase-js
                                       ▼
        ┌──────────────────────────────────────────────────────┐
        │                 Supabase (single project)            │
        │  Postgres + RLS  •  Auth + MFA  •  Storage  •  Realtime
        │              ~95 Deno Edge Functions                 │
        └─────┬───────────┬──────────────┬───────────┬─────────┘
              │           │              │           │
              ▼           ▼              ▼           ▼
        Meta Graph    TikTok /      Cloudinary    Stripe /
        / Threads /   YouTube /     (media)       Resend /
        LinkedIn /    Pinterest /                 OpenRouter /
        Twitter /     Bluesky /                   Lovable AI
        Reddit /      WhatsApp                    Gateway /
        Google Auth   Cloud API                   Atlas / ACRCloud
```

Edge Functions are the only place credentials are read. The frontend never holds platform secrets — only the Supabase publishable key.

---

## Tech stack

- **Frontend:** React 18, TypeScript 5, Vite 5, Tailwind CSS 3, shadcn/ui (Radix UI), TanStack Query, react-router v6, react-hook-form + Zod, Recharts, `@xyflow/react`, Sentry browser SDK.
- **Backend:** Supabase Postgres + Row Level Security, Supabase Auth, Supabase Storage, Supabase Edge Functions (Deno runtime).
- **Media:** Cloudinary (uploads, transforms, deletion), AtlasCloud (4K upscale), Unsplash (stock).
- **AI:** Lovable AI Gateway, Google AI Studio (Gemini 2.5 Flash default), OpenRouter, Imagen, ACRCloud (music copyright).
- **Email:** Resend (transactional + admin inbox).
- **Payments:** Stripe (subscriptions, coupons, webhooks).
- **Infra:** Docker (multi-stage Node 20 → nginx:alpine), Lovable hosting + custom domain.
- **Automation:** n8n community node (`n8n-nodes-postora`), Make.com custom app — both back the public `n8n-api` edge function.

---

## Project structure

```
postora/
├── src/                    # React SPA
├── supabase/
│   ├── functions/          # ~95 Deno edge functions
│   └── migrations/         # SQL migrations (read-only here)
├── public/                 # Static assets + /about (Google OAuth verification page)
├── docs/                   # Internal docs
├── e2e/                    # End-to-end tests
├── n8n-community-node/     # Companion n8n node source
├── scripts/                # Operational scripts
├── nginx.conf              # Production nginx config
├── Dockerfile              # Multi-stage build
└── docker-compose.yml      # Local containerized run
```

---

## Frontend structure

```
src/
├── pages/                  # ~50 user routes
│   ├── admin/              # ~25 admin routes (role-gated)
│   ├── analytics/          # Analytics sub-routes
│   ├── docs/               # Marketing-style docs pages
│   ├── media-library/      # Media library shell
│   └── messaging/          # Unified inbox shell
├── components/
│   ├── ui/                 # shadcn primitives
│   ├── post/               # Composer pieces (per-platform tabs, settings)
│   ├── profiles/           # Profile + connect cards (incl. PlatformAccountsTab)
│   ├── admin/              # Admin widgets, tables, charts
│   ├── messaging/          # Inbox UI
│   ├── threads/            # Threads discovery / insights UI
│   ├── analytics/          # Brand intelligence widgets
│   └── layout/             # App shell, sidebar, header
├── hooks/                  # ~70 hooks
│   └── oauth/              # One hook per platform OAuth flow + redirect handler
├── contexts/               # PublishingContext, ProcessingJobsContext, VideoProcessingDebugContext
├── integrations/supabase/  # Generated types + client
└── lib/                    # utils, types, image utils, oauth state, sdks
```

Notable hooks: `useAuth`, `useUserRole`, `useSocialProfiles`, `useSocialAccounts`, `usePosts`, `usePostForm`, `usePlatformSettings`, `useRealtimePostUpdates`, `useThreadsCapabilities`, `useThreadsLiveDiscovery`, `useOwnedThreadsAccounts`, `useProfileOAuth`, `useOAuthRedirectHandler`, `useCredits`, `useQuotas`, `useSubscription`.

---

## Backend / Supabase Edge Functions

~95 Deno edge functions live under `supabase/functions/`. They are the only place server-side credentials are read. All deploy automatically from this repo.

Categories (full appendix table near the end):

- **Auth / OAuth (12)** — one per platform + `manage-oauth-redirects`.
- **Posting (5)** — `process-post` (immediate), `process-scheduled-posts` (cron), `process-scheduled-blog-posts`, `process-scheduled-flags`, `process-scheduled-emails`.
- **Media (10)** — Cloudinary CRUD, video processing, transcription, background removal, upscale (Cloudinary + Atlas), cleanup, music copyright check.
- **AI (10)** — caption / hashtag / image / best-times generators, model registry, log analyzer, AI email assistant, model tester, OpenRouter listings.
- **Threads tools (10)** — discovery, keyword search, insights, location search, recently searched, comment, quote, repost, delete-post, debug-publish-check.
- **TikTok (4)** — analytics, status check, demo publish (sandbox), webhook.
- **WhatsApp (6)** — broadcast, config test, profile, scheduled sender, webhook, OAuth.
- **Messaging / Comments (3)** — `messaging-api`, `comment-manager`, `facebook-places-search`.
- **Analytics / Brand / Ads (4)** — `brand-scrape`, `ad-analytics`, `ad-manager`, `leads-api`.
- **Tokens / Health (4)** — `refresh-tokens`, `check-connection-health`, `send-token-expiry-notifications`, `send-token-failure-alert`.
- **Billing (7)** — `stripe-checkout`, `stripe-manage-subscription`, `stripe-webhook`, `create-payment`, `verify-payment`, `backfill-subscription`, `check-subscription`.
- **Email (10)** — `send-auth-email`, `send-inbox-email`, `send-reset-otp`, `send-subscription-email`, `send-weekly-analytics`, `send-expiry-reminders`, `sync-resend-delivery-status`, `resend-webhook`, `fetch-email-content`, plus `notify-admin-new-user`.
- **Admin / Ops (7)** — `manage-app-secrets`, `manage-cron-jobs`, `observability-alerts`, `observability-collector`, `sync-user-quotas`, `notify-expiring-ai-overrides`, `get-public-config`.
- **MFA (3)** — `check-user-mfa`, `verify-mfa-reset`, `verify-reset-otp`.
- **Public API (1)** — `n8n-api` (also serves Make.com).
- **Misc (1)** — `unsplash-proxy`.

---

## OAuth / authentication flows

Postora uses Supabase Auth for app login (email + Google). All platform connections are handled by dedicated edge functions invoked from `src/hooks/oauth/*` and orchestrated by `useProfileOAuth`. The shared callback page is `src/pages/OAuthCallback.tsx`, with `useOAuthRedirectHandler` resolving state + error mapping.

| Platform | Edge function | Notes |
|----------|---------------|-------|
| Facebook | `facebook-oauth` | Page selection, Meta Graph **v22.0**, "Relevant Only" scope strategy, phantom-account prevention. |
| Instagram | `instagram-oauth` | Dual flow: FB-Page-linked **and** direct Instagram Business Login (also v22.0). |
| Threads | `threads-oauth` | Separate Threads App ID + Secret, **HTTPS-only redirect**, calls `graph.threads.net`. |
| TikTok | `tiktok-oauth` | PKCE, `THREADS_DEMO_MODE`-style sandbox flag, `creator_info` UX gating, `user.info.basic` + `user.info.profile`. |
| YouTube | `youtube-oauth` | Google **incremental authorization** (JIT scope escalation). |
| Pinterest | `pinterest-oauth` + `pinterest-boards` | Boards loaded on demand. Video uses 3-step async upload. |
| LinkedIn | `linkedin-oauth` | Client `77k0p74fi3zlau`, 24h API caching policy enforced. |
| Twitter/X | `twitter-oauth` | Requires **Basic** access tier or higher. |
| Bluesky | `bluesky-oauth` | ATProto + DPoP on every request. |
| Reddit | `reddit-oauth` | Standard OAuth. |
| WhatsApp | `whatsapp-oauth` | Cloud API; webhook verified by `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. |
| Google sign-in | (Supabase Auth) | App-level login only, not platform connection. |

Registered redirect URIs (production) are documented in memory `mem://auth/platform-redirect-uris`. Custom OAuth apps registered by users are managed via `manage-oauth-redirects` and reviewed in `/admin/oauth-verification`.

---

## Posting pipeline

```
CreatePost.tsx ──► usePostForm + usePlatformSettings
        │
        ▼
   posts (status='pending'|'scheduled')
   platform_posts (one row per target account)
   media_files (Cloudinary-backed)
        │
   ┌────┴─────────────────────────────┐
   │ immediate                         │ scheduled_at set
   ▼                                   ▼
process-post                  process-scheduled-posts (cron)
   │                                   │
   │ JIT token refresh (only           │ same JIT refresh strategy
   │ for selected accounts)            │
   ▼                                   ▼
Per-platform branch ────────► platform_posts.status / error_message / posted_at
        │
        ▼
useRealtimePostUpdates ──► live UI updates on /history, /scheduled
```

Key rules:

- `posts.status` enum is enforced by `posts_status_check` and includes a dedicated `scheduled` value.
- Media uploads go through `cloudinary-upload`; Instagram URLs are optimized with `f_jpg,q_auto`.
- Video pipeline: `process-video` + `transcode-video` (Deno has no FFmpeg — work runs in external services).
- IG video polling: 60 attempts × 3s.
- First-comment requires `pages_manage_engagement` (FB) and `instagram_manage_comments` (IG).
- Story pipelines for FB + IG are specialized inside `process-post`.
- Single-media FB feed posts containing video are routed to `/{pageId}/videos`.

---

## Threads module

Threads has the deepest tooling beyond core publishing.

**Publishing surface (`process-post` + helpers):**
- Text, image, video.
- 500-char backend safety net (frontend mirrors).
- Location tagging (requires advanced access).
- Share-to-Instagram, repost, quote, comment, delete (`threads-comment`, `threads-quote`, `threads-repost`, `threads-delete-post`).

**Discovery + intelligence:**
- `threads-discovery` — feed of recent owned + topical posts.
- `threads-keyword-search` — keyword search across Threads.
- `threads-insights` — per-post + account insights.
- `threads-location-search` — location autocomplete.
- `threads-recently-searched` — search history.

**Diagnostics (admin):**
- `threads-debug-publish-check` — surfaces App ID / scope / token state for a given account before publishing.

**Frontend hooks:** `useThreadsCapabilities`, `useThreadsLiveDiscovery`, `useOwnedThreadsAccounts`.

**Operational caveats:**
- **HTTPS-only redirect URI.** Connecting Threads from `http://localhost` triggers Meta error `1349187` ("Insecure Login Blocked"). The frontend now short-circuits this with a toast pointing users to the preview / production URLs (see `src/hooks/oauth/useThreadsOAuth.ts`).
- Threads uses a **separate App ID / Secret** from the main Facebook app. Mixing them produces Meta error `4476002` ("No app ID was sent with the request"). Always set `THREADS_APP_ID` + `THREADS_APP_SECRET` distinctly.
- `THREADS_DEMO_MODE` enables a sandbox path for review.

---

## AI capabilities

| Function | Use | Credits |
|----------|-----|---------|
| `generate-caption` | Captions per platform / tone / language | 1 |
| `generate-hashtags` | Hashtag suggestions | 1 |
| `generate-image` | Image generation (Imagen / Gemini 2.5 Flash Image fallback) | 2 |
| `suggest-best-times` | Best-time recommendations per account | — |
| `transcribe-media` | 3-tier STT fallback chain | — |
| `brand-scrape` | Cross-platform brand scraping (IG, Threads, FB, YouTube, TikTok) | — |
| `ai-email-assistant` | Drafting + reply assistance in the admin inbox | — |
| `analyze-log` | AI-assisted root cause + Lovable prompt generation per `system_logs` row | — |
| `test-ai-model` | Provider-specific live test from `/admin/settings` | — |
| `ai-config` / `fetch-openrouter-models` / `openrouter-models` | Provider + model registry | — |
| `notify-expiring-ai-overrides` | Cron alert for model overrides | — |

**Provider stack (DB-driven via `ai_providers` + `ai_models`):** Lovable AI Gateway, Google AI Studio (default `gemini-2.5-flash`), OpenRouter, Imagen, Atlas (upscale), Unsplash, ACRCloud (music copyright detection).

Image generation is strictly scoped to dedicated media models — see `mem://features/ai-generation/image-model-governance`.

---

## Admin panel capabilities

All admin pages are RLS-protected and require the `admin` role in `user_roles` (checked by `has_role()` and the `useUserRole` hook).

| Route | Page | Purpose |
|-------|------|---------|
| `/admin` | `AdminDashboard` | Overview KPIs |
| `/admin/users` | `AdminUsers` | User list, search, filters, bulk actions |
| `/admin/users/:id` | `AdminUserDetail` | Per-user drilldown |
| `/admin/subscriptions` | `AdminSubscriptions` | Subscription state + MRR |
| `/admin/plans` | `AdminPlans` | Plans builder |
| `/admin/plan-quotas` | `AdminPlanQuotas` | Per-plan quota matrix |
| `/admin/coupons` | `AdminCoupons` | Coupon CRUD |
| `/admin/messages` | `AdminMessages` | Support tickets |
| `/admin/inbox` | `AdminInbox` | Resend-backed email inbox |
| `/admin/notifications` | `AdminNotifications` | System-wide notifications |
| `/admin/blog` | `AdminBlogPosts` | "What's New" CMS |
| `/admin/settings` | `AdminSettings` | App credentials manager + AIConfigurationTab |
| `/admin/oauth-apps` | `AdminOAuthApps` | OAuth 2.1 client registry |
| `/admin/oauth-verification` | `AdminOAuthVerification` | Custom redirect URI review queue |
| `/admin/feature-flags` | `AdminFeatureFlags` | Feature flags + Beta-platform tagging |
| `/admin/logs` | `AdminLogs` | `system_logs` browser + AI analyze |
| `/admin/observability` | `AdminObservability` | Health scores, charts, alerts |
| `/admin/rate-limits` | `AdminRateLimits` | Per-user API rate limits |
| `/admin/token-health` | `AdminTokenHealth` | Token distribution, refresh logs, exports |
| `/admin/media-cleanup` | `AdminMediaCleanup` | Cloudinary orphan sweep |
| `/admin/scaling` | `AdminScaling` | Capacity controls |
| `/admin/launch-checklist` | `AdminLaunchChecklist` | Pre-launch / ongoing ops checklist |
| `/admin/analytics` | `AdminAnalytics` | Platform-wide analytics |

Plus admin "view as user" mode on `/media` (`effectiveUserId`).

---

## Database overview

All tables are RLS-protected. Admin access is granted via the SECURITY DEFINER helper `has_role(uid, 'admin')`.

| Table | Purpose |
|-------|---------|
| `profiles` | User profile + API key |
| `user_roles` | `app_role` enum (`user` / `admin` / `subscriber`) |
| `social_profiles` | Account groups |
| `social_accounts` | Connected platform accounts + tokens |
| `posts` | Authored posts (statuses incl. `scheduled`) |
| `platform_posts` | Per-target outcome (status, URL, error) |
| `media_files` / `media_folders` | Cloudinary-backed media |
| `subscription_plans` / `user_subscriptions` / `coupons` | Billing |
| `user_quotas` / `user_credits` / `credit_transactions` | Quota + AI credit ledger |
| `support_tickets` / `ticket_messages` | Support |
| `system_notifications` / `notification_reads` | In-app notifications |
| `blog_posts` / `user_blog_post_reads` | "What's New" |
| `app_settings` / `app_credentials` | Platform-wide config + admin-managed secrets metadata |
| `ai_providers` / `ai_models` / `ai_model_preferences` | AI registry + per-user/per-feature override |
| `system_logs` / `system_health_snapshots` / `edge_function_status` | Observability |
| `token_refresh_history` | Per-account refresh outcomes |
| `api_logs` | Public API + rate-limit basis |
| `admin_audit_log` | Admin actions trail |
| `email_templates` / `email_log` | Resend transactional |
| `launch_checklist` | Admin operational checklist |
| `backup_codes` | Hashed 2FA recovery codes |
| `oauth_apps` / `oauth_redirect_requests` | OAuth 2.1 consent flow |

---

## Configuration and env vars

### Frontend (`.env`)

Copy `.env.example` to `.env` and fill in the values. Required frontend variables:

```
VITE_SUPABASE_URL=https://api.postora.cloud
VITE_SUPABASE_PUBLISHABLE_KEY=<your_self_hosted_anon_key>
VITE_SUPABASE_PROJECT_ID=efruibswazzuuupgyzmf
```

> See `.env.example` for the safe template and the URL cutover notes (testing app
> `https://new.postora.cloud` → final `https://postora.cloud`; Supabase API stays
> `https://supabase.postora.cloud`).

The frontend never reads platform secrets.

## App credentials / secrets

All platform secrets live in **Supabase Edge Function secrets** and are surfaced through the **App Credentials Manager** at `/admin/settings` (backed by `manage-app-secrets`).

### Supabase
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SB_MANAGEMENT_TOKEN`

### Meta family (separate apps!)
- `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`
- `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`
- `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_DEMO_MODE`

### TikTok
- `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`

### Google / YouTube
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GOOGLE_AI_STUDIO_KEY`

### LinkedIn / Twitter / Pinterest
- `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`
- `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`
- `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`

### WhatsApp Cloud API
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `WHATSAPP_VERIFY_PIN`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`

### Media + AI
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `ATLASCLOUD_API_KEY`
- `OPENROUTER_API_KEY`
- `UNSPLASH_ACCESS_KEY`
- `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET`
- `LOVABLE_API_KEY`

### Email (Resend)
- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SECRET`
- `SEND_EMAIL_HOOK_SECRET`

### Payments (Stripe)
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

### Connector-managed
- `SLACK_API_KEY` (for observability alerts)

---

## Running locally

```bash
npm install
npm run dev
```

Visit http://localhost:8081.

> **Threads OAuth caveat (very common gotcha):** Meta blocks Threads OAuth from any non-HTTPS origin (`error_code: 1349187`). The frontend has a built-in guard in `src/hooks/oauth/useThreadsOAuth.ts` that intercepts Threads connect attempts on `http://` and toasts the user to use the preview / production URL instead. **Test Threads from `https://postora.lovable.app/profiles` or `https://postora.cloud/profiles`.**

Other scripts:

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run build:dev` | Dev-mode build |
| `npm run preview` | Preview built bundle |
| `npm run lint` | ESLint |

---

## Production deployment

- **Hosted on VPS/Server** via Dokploy at `86.48.2.205`. The frontend is built from `https://github.com/lolotam/remix-of-postora.cloud.git` and runs as a Docker container.
- **Supabase Backend:** Self-hosted Supabase running in Docker Swarm under Dokploy.
- **Edge functions:** Deployed to the self-hosted Supabase instance at `https://api.postora.cloud` using Supabase CLI.
- **Migrations:** Applied locally or via the CLI to the self-hosted database instance.

---

## Docker / nginx setup

`Dockerfile`: multi-stage Node 20 build → `nginx:alpine` serving the SPA on port 80.

`docker-compose.yml`:
```yaml
services:
  postora:
    build: { context: ., dockerfile: Dockerfile }
    expose: ["80"]
    environment: [NODE_ENV=production]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:80/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

`nginx.conf` highlights:
- Gzip + cache headers for static assets.
- Security headers (CSP-friendly, HSTS, X-Frame-Options).
- 404 for sensitive paths (`.env`, `.git`, `.php`, `config.php`, etc.) — see `mem://security/architecture-hardening`.
- Static `/about` page served verbatim — required for **Google OAuth verification** (see `mem://compliance/google-oauth-verification-strategy`).
- SPA fallback to `/index.html`.

---

## Common debugging workflows

When something breaks, check in this order:

1. **Browser console + Sentry** — frontend errors / 401 cascades.
2. **Edge function logs** — Self-hosted Supabase Studio logs:
   `https://api.postora.cloud` (or `https://supabase.postora.cloud`) Studio interface.
3. **`/admin/logs`** — `system_logs` table (48h retention via `observability-collector`). Use the inline AI analyzer (`analyze-log`) for root-cause + Lovable prompt.
4. **`/admin/observability`** — health scores, edge function status, alert history.
5. **`/admin/token-health`** — token expiry distribution + per-account refresh outcomes.
6. **Targeted diagnostic functions:**
   - Threads — `threads-debug-publish-check`
   - WhatsApp — `whatsapp-config-test`
   - AI providers — `test-ai-model` (from `/admin/settings`)
7. **`api_logs`** — public API errors + rate-limit hits.

---

## Known limitations / operational notes

- **Deno edge runtime has no FFmpeg.** Heavy media work uses external services (Cloudinary, Atlas).
- **Threads OAuth is HTTPS-only** (Meta `1349187`). Frontend guard already in place.
- **Threads ≠ Facebook app.** Mixing IDs causes Meta `4476002`.
- **Twitter/X requires Basic tier or higher** for the OAuth 2.0 user context.
- **YouTube in Testing mode** is capped at 100 refresh-token uses per user — see `mem://auth/youtube-oauth-testing-constraints`.
- **Storage RLS** enforces `${userId}/...` as the first path segment.
- **LinkedIn caching:** API responses must be cached for 24h (compliance) — see `mem://auth/linkedin-app-credentials`.
- **Instagram video polling:** 60 attempts × 3s (~3 min cap) — see `mem://technical-decisions/instagram-media-delivery-optimization`.
- **API rate limit** is per-user, computed from `api_logs` (default policy) — see `mem://technical-decisions/api-rate-limiting`.
- **Cloudflare WAF + Bot Fight Mode** must allow verified bots (Googlebot etc.) — see `mem://technical-decisions/cloudflare-configuration`.

---

## Recommended reconnect / credential procedures

| Symptom | Procedure |
|---------|-----------|
| Token expired (any platform) | `/admin/token-health` → trigger `refresh-tokens` for the account; if it still fails, disconnect + reconnect from `/profiles`. |
| LinkedIn 401 | Disconnect + reconnect (LinkedIn rejects refreshed tokens silently). |
| YouTube refresh 100 cap | Re-auth the user; long-term fix = move Google project out of Testing. |
| Threads "Insecure Login Blocked" (`1349187`) | Use HTTPS preview / production URL. |
| Threads "No app ID" (`4476002`) | Verify `THREADS_APP_ID` ≠ `FACEBOOK_APP_ID` in `/admin/settings`. Redeploy `threads-oauth`, `get-public-config`. |
| Meta posting failures | Check Page permissions in `/profiles`; rerun `check-connection-health`. |
| TikTok publish stuck | `tiktok-check-status` for the publish ID; `/admin/logs` for `process-post` errors. |
| WhatsApp webhook silent | `whatsapp-config-test` + verify `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. |
| AI model failing | `/admin/settings` → AI Configuration → `test-ai-model`. |

---

## Logging and diagnostics

| Source | Surface |
|--------|---------|
| `system_logs` | `/admin/logs` (+ `analyze-log` inline AI) |
| `system_health_snapshots` | `/admin/observability` charts |
| `edge_function_status` | `/admin/observability` |
| `token_refresh_history` | `/admin/token-health` |
| `admin_audit_log` | `/admin/users/:id` + audit views |
| `api_logs` | Rate-limit basis + public-API errors |
| Sentry | Browser + edge runtime |
| Slack alerts | `observability-alerts` (configurable) |

`observability-collector` runs on cron and trims `system_logs` to ~48h to keep storage bounded.

---

## Roadmap

The repo includes living planning documents (not duplicated here):

- `ROADMAP.md`
- `MONETIZATION_FEATURES_PLAN.md`

Items there are **planned**, not implemented, unless they appear in the capability matrix above.

---

## Contributing / maintenance

- **Files target ≤400 lines** (`mem://technical-decisions/file-size-governance`). Refactor when approaching the limit.
- **TypeScript strict.** No `any`. Types live in `src/lib/types.ts` + `src/integrations/supabase/types.ts` (read-only generated).
- **Tailwind only**, semantic tokens from `index.css` + `tailwind.config.ts`. No inline styles, no new CSS files, all colors HSL.
- **RLS-first.** Every new table needs RLS + a `has_role()`-based admin policy.
- **Migrations** under `supabase/migrations/` are read-only; create new timestamped files.
- **Edge functions** auto-deploy on merge.
- **Roles never on `profiles`** — always in `user_roles` (privilege-escalation safety).

---

## Edge function reference (appendix)

| Function | Category | Purpose | Facing |
|----------|----------|---------|--------|
| `facebook-oauth` | Auth | Facebook OAuth + Page selection | User |
| `instagram-oauth` | Auth | IG (FB-linked + Business Login) | User |
| `threads-oauth` | Auth | Threads OAuth (HTTPS-only) | User |
| `tiktok-oauth` | Auth | TikTok OAuth (PKCE, UX-compliant) | User |
| `youtube-oauth` | Auth | Google incremental OAuth | User |
| `pinterest-oauth` | Auth | Pinterest OAuth | User |
| `linkedin-oauth` | Auth | LinkedIn OAuth | User |
| `twitter-oauth` | Auth | Twitter/X OAuth (Basic+) | User |
| `bluesky-oauth` | Auth | ATProto + DPoP | User |
| `reddit-oauth` | Auth | Reddit OAuth | User |
| `whatsapp-oauth` | Auth | WhatsApp Cloud API onboarding | User |
| `manage-oauth-redirects` | Auth | Custom redirect URI requests | Admin |
| `process-post` | Posting | Immediate publish (all platforms) | User |
| `process-scheduled-posts` | Posting | Cron scheduler with JIT refresh | Cron |
| `process-scheduled-blog-posts` | Posting | Scheduled "What's New" posts | Cron |
| `process-scheduled-flags` | Posting | Scheduled feature-flag toggles | Cron |
| `process-scheduled-emails` | Posting | Scheduled emails | Cron |
| `cloudinary-upload` | Media | Upload to Cloudinary | User |
| `cloudinary-delete` | Media | Delete from Cloudinary | User |
| `cloudinary-rename` | Media | Rename / move in Cloudinary | User |
| `cloudinary-email-upload` | Media | Inbound email attachment ingest | Internal |
| `process-video` | Media | Video orchestration | User |
| `transcode-video` | Media | External transcode wrapper | User |
| `transcribe-media` | Media | 3-tier STT chain | User |
| `remove-background` | Media | BG removal | User |
| `upscale-image` | Media | Cloudinary `c_scale` upscale | User |
| `upscale-image-atlas` | Media | AtlasCloud 4K upscale | User |
| `cleanup-media` | Media | Orphan sweep | Admin |
| `check-music-copyright` | Media | ACRCloud lookup | User |
| `generate-caption` | AI | Caption generation | User |
| `generate-hashtags` | AI | Hashtag generation | User |
| `generate-image` | AI | Imagen / Gemini fallback chain | User |
| `suggest-best-times` | AI | Best-time recommendations | User |
| `ai-config` | AI | Provider/model config | Admin |
| `ai-email-assistant` | AI | Email reply / draft assist | Admin |
| `analyze-log` | AI | Root cause + Lovable prompt for a log row | Admin |
| `test-ai-model` | AI | Live provider test | Admin |
| `fetch-openrouter-models` | AI | Refresh OpenRouter list | Admin |
| `openrouter-models` | AI | List endpoint | Internal |
| `threads-discovery` | Threads | Owned + topical feed | User |
| `threads-keyword-search` | Threads | Keyword search | User |
| `threads-insights` | Threads | Post + account insights | User |
| `threads-location-search` | Threads | Location autocomplete | User |
| `threads-recently-searched` | Threads | Search history | User |
| `threads-comment` | Threads | Post comment | User |
| `threads-quote` | Threads | Quote a thread | User |
| `threads-repost` | Threads | Repost | User |
| `threads-delete-post` | Threads | Delete a thread | User |
| `threads-debug-publish-check` | Threads | Pre-flight diagnostic | Admin |
| `tiktok-analytics` | TikTok | Analytics ingest | User |
| `tiktok-check-status` | TikTok | Async publish status | User |
| `tiktok-demo-publish` | TikTok | Sandbox publish | Admin |
| `tiktok-webhook` | TikTok | Inbound webhook | Internal |
| `whatsapp-broadcast` | WhatsApp | Broadcast send | User |
| `whatsapp-config-test` | WhatsApp | Diagnostic | Admin |
| `whatsapp-profile` | WhatsApp | Profile read/write | User |
| `whatsapp-scheduled-sender` | WhatsApp | Scheduled outbound | Cron |
| `whatsapp-webhook` | WhatsApp | Inbound webhook | Internal |
| `messaging-api` | Messaging | Unified inbox (FB/IG/WA) | User |
| `comment-manager` | Messaging | Comment CRUD | User |
| `facebook-places-search` | Messaging | Place lookup for tagging | User |
| `brand-scrape` | Analytics | Cross-platform scraping | User |
| `ad-analytics` | Analytics | Meta ad metrics | User |
| `ad-manager` | Analytics | Meta ad management | User |
| `leads-api` | Analytics | Meta Lead Forms ingest | User |
| `refresh-tokens` | Tokens | Refresh OAuth tokens | Cron + Admin |
| `check-connection-health` | Tokens | Verify connection | User |
| `send-token-expiry-notifications` | Tokens | User reminders | Cron |
| `send-token-failure-alert` | Tokens | Admin alert | Cron |
| `stripe-checkout` | Billing | Create checkout | User |
| `stripe-manage-subscription` | Billing | Cancel / change plan | User |
| `stripe-webhook` | Billing | Stripe events | Internal |
| `create-payment` / `verify-payment` | Billing | One-off payments | User |
| `backfill-subscription` | Billing | Retro-link Stripe customer | Admin |
| `check-subscription` | Billing | Status check | User |
| `send-auth-email` | Email | Auth flows | Internal |
| `send-inbox-email` | Email | Admin inbox send | Admin |
| `send-reset-otp` / `verify-reset-otp` | Email/MFA | Password reset OTP | User |
| `send-subscription-email` | Email | Plan lifecycle | Internal |
| `send-weekly-analytics` | Email | Weekly digest | Cron |
| `send-expiry-reminders` | Email | Token/credit reminders | Cron |
| `sync-resend-delivery-status` | Email | Delivery sync | Cron |
| `resend-webhook` | Email | Inbound from Resend | Internal |
| `fetch-email-content` | Email | Pull thread content | Admin |
| `notify-admin-new-user` | Email | New-signup alert | Internal |
| `manage-app-secrets` | Admin/Ops | App credentials manager backend | Admin |
| `manage-cron-jobs` | Admin/Ops | Cron registry | Admin |
| `observability-alerts` | Admin/Ops | Alert dispatch | Cron |
| `observability-collector` | Admin/Ops | Snapshot + log retention | Cron |
| `sync-user-quotas` | Admin/Ops | Quota recalculation | Cron + Admin |
| `notify-expiring-ai-overrides` | Admin/Ops | AI override alerts | Cron |
| `get-public-config` | Admin/Ops | Public-safe config (App IDs etc.) | User |
| `check-user-mfa` | MFA | Enrollment check | User |
| `verify-mfa-reset` | MFA | MFA-protected reset | User |
| `n8n-api` | Public API | n8n + Make.com integration | External |
| `unsplash-proxy` | Misc | Unsplash search proxy | User |
| `pinterest-boards` | Auth/Aux | Fetch Pinterest boards | User |

---

## Quick Start for Operators

1. **Set app credentials.** Open `/admin/settings` → App Credentials tab. Fill secrets per platform. **Threads uses its own App ID + Secret — do not reuse the Facebook app.**
2. **Verify with diagnostics.** Run `test-ai-model` (AI tab), `whatsapp-config-test` (WhatsApp), and `threads-debug-publish-check` for any owned Threads account.
3. **Connect platforms.** As a regular user, go to `/profiles` → create a Social Profile → connect each platform. **Test Threads from the HTTPS preview URL.**
4. **Publish a test post.** `/post` → pick the profile + platforms → write a caption → "Publish now". Check the result in `/history`.
5. **Confirm in logs.** `/admin/logs` for `process-post` rows; `/admin/observability` for health; `/admin/token-health` for token state.
6. **(Optional) Schedule a post** to validate `process-scheduled-posts` cron + JIT refresh.

---

## AI Assistant Context

Compact map for future AI coding assistants:

- **App login lives in:** `src/hooks/useAuth.tsx`. Roles in `src/hooks/useUserRole.tsx`. Supabase client in `src/integrations/supabase/client.ts`.
- **Platform OAuth lives in:** `src/hooks/oauth/use<Platform>OAuth.ts` (one per platform) + `src/pages/OAuthCallback.tsx` + `useOAuthRedirectHandler`. Server side: `supabase/functions/<platform>-oauth/`.
- **Posting composer:** `src/pages/CreatePost.tsx` + `src/hooks/usePostForm.ts` + `src/hooks/usePlatformSettings.ts` + `src/components/post/*`. Server publish: `supabase/functions/process-post/`. Scheduler: `process-scheduled-posts`.
- **Threads tools:** `supabase/functions/threads-*` and `src/hooks/useThreads*` + `src/components/threads/*`. **HTTPS guard** is in `src/hooks/oauth/useThreadsOAuth.ts`.
- **Admin app credentials:** UI at `src/pages/admin/AdminSettings.tsx`, backend at `supabase/functions/manage-app-secrets/`. Public-safe IDs via `get-public-config`.
- **Diagnostics first stop:** `/admin/logs` (uses `system_logs` + `analyze-log`), then `/admin/observability`, then the platform-specific debug function (`threads-debug-publish-check`, `whatsapp-config-test`, `tiktok-check-status`).
- **Memory pointers** worth opening before deep changes: `mem://auth/platform-redirect-uris`, `mem://features/posting-page/core-implementation`, `mem://features/threads-integration/core-implementation`, `mem://admin/app-credentials-manager`, `mem://technical-decisions/scheduler-refresh-logic`, `mem://technical-decisions/edge-function-constraints`.

---

© WALEED PROLIFE LLC. Proprietary.
