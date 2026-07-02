# Postora

> Multi-platform social media management platform with AI-assisted publishing, scheduling, analytics, unified messaging, and a complete admin operations suite.

- **Live app:** https://postora.cloud
- **Preview / staging:** https://postora.lovable.app
- **Operating entity:** WALEED PROLIFE LLC — 200 N Vineyard Blvd, Ste A325 334, Honolulu, HI 96817, USA
- **Supabase Backend:** Self-hosted Supabase (managed via Dokploy on VPS `86.48.2.205`) at `https://api.postora.cloud`

> **⚠️ Self-hosted migration notice (2026-06):** This project runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Project Architecture](#3-project-architecture)
4. [Folder Structure](#4-folder-structure)
5. [Main Features](#5-main-features)
6. [API Endpoints](#6-api-endpoints)
7. [Database Blueprint](#7-database-blueprint)
8. [Environment Variables](#8-environment-variables)
9. [Local Development Setup](#9-local-development-setup)
10. [Production Build & Deployment](#10-production-build--deployment)
11. [Current Self-Hosting / Database Setup](#11-current-self-hosting--database-setup)
12. [External Integrations](#12-external-integrations)
13. [Security Notes](#13-security-notes)
14. [Testing & Quality](#14-testing--quality)
15. [Development Roadmap](#15-development-roadmap)
16. [Known Issues / Technical Debt](#16-known-issues--technical-debt)
17. [Useful Commands](#17-useful-commands)
18. [Contribution / Developer Notes](#18-contribution--developer-notes)
19. [Maintenance Checklist](#19-maintenance-checklist)
20. [Final Summary](#20-final-summary)

---

## 1. Project Overview

**Postora** is a single-tenant-per-user social media operations platform. It lets users connect to **11 social networks**, compose and schedule posts across all of them from a single unified composer, generate content with AI, and monitor performance through cross-platform analytics and a unified inbox.

### Main purpose
Provide a single dashboard to manage publishing, scheduling, analytics, messaging, and administration across every major social platform — replacing the need for 5–10 separate tools.

### Target users
- Content creators and influencers managing multiple accounts
- Social media managers and agencies handling multiple clients
- Small businesses with presence on several networks
- Marketing teams needing scheduling, analytics, and unified messaging

### Core problem solved
Eliminates the friction of switching between native platform tools by offering one unified composer, scheduler, analytics dashboard, and inbox — with AI content generation baked in.

### Main modules / features
- **Multi-platform publishing** — Facebook, Instagram, Threads, TikTok, YouTube, Pinterest, LinkedIn, Twitter/X, Bluesky, Reddit, WhatsApp
- **Unified composer** with platform-specific overrides (TikTok privacy, YouTube category/Shorts, IG carousel, FB Pages, Pinterest boards, Threads location, etc.)
- **Scheduling** via a cron-driven dispatcher with just-in-time (JIT) token refresh
- **AI suite** — captions, hashtags, images, best-time suggestions, transcription, brand scraping, log analysis
- **Unified messaging inbox** — Facebook / Instagram / WhatsApp
- **Analytics & brand intelligence** — cross-platform scraping, Threads discovery, ad analytics
- **Subscriptions, credits, coupons** (Stripe)
- **Admin operations suite** — credentials, plans, quotas, OAuth verification, observability, token health, feature flags, launch checklist
- **Public API** for n8n and Make.com automation integrations
- **Two-factor auth** (TOTP + hashed backup codes)

### Current project status
**Production / live.** Actively maintained. Hosted at https://postora.cloud with self-hosted Supabase backend on a Contabo VPS. Some modules are marked "partial / experimental" (see [Main Features](#5-main-features)).

---

## 2. Tech Stack

### Frontend

| Concern | Technology |
| --- | --- |
| Framework | React 18 |
| Language | TypeScript 5 (strict mode) |
| Build tool | Vite 5 |
| Styling | Tailwind CSS 3 + shadcn/ui (Radix UI primitives) |
| Routing | react-router-dom v7 |
| Server state | TanStack Query v5 |
| Client state | Zustand, React Context (`PublishingContext`, `ProcessingJobsContext`, `VideoProcessingDebugContext`) |
| Forms | react-hook-form + Zod |
| Charts | Recharts |
| Visual builder | `@xyflow/react` (Canvas workflow) |
| Animation | Framer Motion |
| Media upload | react-dropzone |
| Theming | next-themes (dark default) |
| Error tracking | Sentry (`@sentry/react`) |
| QR / 2FA | `qrcode` |

**Main frontend dependencies:** `@supabase/supabase-js`, `@tanstack/react-query`, `react-router-dom`, `react-hook-form`, `zod`, `recharts`, `@xyflow/react`, `framer-motion`, `lucide-react`, `date-fns`, `sonner`, `zustand`, `papaparse`, `embla-carousel-react`.

### Backend

| Concern | Technology |
| --- | --- |
| Runtime | Supabase Edge Functions (Deno runtime) |
| API style | Serverless edge functions invoked via `supabase.functions.invoke()` + a public REST surface (`n8n-api`) |
| Function count | ~96 edge functions under `supabase/functions/` |
| Database client | `@supabase/supabase-js` (service-role + anon clients), Postgres RPC |
| Validation | Manual schema checks inside functions; Zod on the frontend |
| Error handling | Platform-error-reporting pattern — operator-fixable errors return HTTP 200 with `{ success:false, error_code, error }`; protocol/auth/internal failures return non-2xx. All 500s sanitized via `_shared/errorSanitizer.ts` |
| Logging | `system_logs` table via `log_system_event` RPC + `_shared/logging.ts` helpers |
| Middleware | Shared modules in `supabase/functions/_shared/` (CORS, auth-helper, cron-auth, social-auth, errorSanitizer, logging) |

### Database

| Concern | Technology |
| --- | --- |
| Type | Relational — PostgreSQL (Supabase) |
| Provider | **Self-hosted Supabase** on Contabo VPS (`86.48.2.205`) via Dokploy |
| Client | `@supabase/supabase-js`, PostgREST, `pg_cron` extension |
| Migration system | Supabase CLI migrations (`supabase/migrations/*.sql`, timestamped) |
| Security model | **Row Level Security (RLS)** on every table; admin access via `has_role(uid, 'admin')` SECURITY DEFINER helper |
| Storage | Cloudinary (media), Supabase Storage (per-user folders with RLS `${userId}/...`) |
| Realtime | Supabase Realtime (WebSocket `wss://api.postora.cloud`) |

### Authentication & Authorization

| Concern | Approach |
| --- | --- |
| Auth provider | Supabase Auth (email + password, Google OAuth, password reset via OTP) |
| Platform connections | Dedicated OAuth edge functions per platform (Meta Graph v22.0, Google incremental, TikTok PKCE, ATProto DPoP, etc.) |
| Session handling | Supabase JWT (`access_token`) in `Authorization: Bearer` header; service-role for privileged functions |
| 2FA | TOTP factors + SHA-256 hashed backup codes (peppered with `BACKUP_CODE_PEPPER`) |
| User roles | `app_role` enum (`user`, `admin`, `subscriber`) stored in `user_roles` (never on `profiles`) |
| Protected routes | `<ProtectedRoute>` component + `useUserRole` hook; admin routes gated by `has_role()` |
| Public API auth | `profiles.api_key` (prefix `postora-…`) used only by `n8n-api` |

### Infrastructure / Hosting

| Concern | Approach |
| --- | --- |
| Frontend deployment | Docker container (multi-stage Node 20 → nginx:alpine) on VPS via Dokploy |
| Backend | Self-hosted Supabase (Postgres + Auth + Storage + Edge Functions) in Docker Swarm under Dokploy |
| Reverse proxy | nginx (per-container, see `nginx.conf`) |
| Domains | `postora.cloud` (app), `api.postora.cloud` (Supabase gateway) |
| Build command | `npm run build` (Vite) |
| Start command | nginx serves static `dist/` on port 80 |
| CDN / WAF | Cloudflare (must allow verified bots — Googlebot etc.) |

---

## 3. Project Architecture

### High-level flow

The frontend is a **React SPA** that talks to a single **self-hosted Supabase** project. Supabase provides the Postgres database (with RLS), authentication, storage, realtime, and ~96 **Deno Edge Functions** that are the only place server-side credentials are read. Edge functions, in turn, call external platform APIs (Meta, TikTok, YouTube, etc.) and third-party services (Cloudinary, Stripe, Resend, AI providers).

```text
                        ┌──────────────────────────────┐
                        │   React 18 SPA (Vite + TS)   │
                        │  TanStack Query • shadcn/ui  │
                        └──────────────┬───────────────┘
                                       │ supabase-js (JWT)
                                       ▼
        ┌──────────────────────────────────────────────────────┐
        │                 Supabase (single project)            │
        │  Postgres + RLS  •  Auth + MFA  •  Storage  •  Realtime
        │              ~96 Deno Edge Functions                 │
        └─────┬───────────┬──────────────┬───────────┬─────────┘
              │           │              │           │
              ▼           ▼              ▼           ▼
        Meta Graph    TikTok /       Cloudinary    Stripe /
        / Threads /   YouTube /      (media)       Resend /
        Instagram /   Pinterest /                  OpenRouter /
        LinkedIn /    Bluesky /                    Lovable AI /
        Twitter /     WhatsApp /                   Atlas /
        Reddit /      Cloud API                    ACRCloud
        Google Auth
```

### How the client communicates with the backend
- Frontend uses `supabase.functions.invoke('<name>', { body })` → Supabase auto-adds `apikey` + `Authorization: Bearer <access_token>`.
- Realtime updates via Supabase Realtime WebSocket (`useRealtimePostUpdates`, `useRealtimeSocialAccounts`).
- Direct `fetch` for SSE / file uploads where needed.

### How authentication is handled
1. User signs up / in via Supabase Auth (email or Google OAuth) → receives JWT.
2. JWT is sent on every edge function call; functions resolve the user via `auth.getUser()`.
3. Platform connections are separate — each platform has its own OAuth edge function storing tokens in `social_accounts`.
4. Admin actions additionally check `has_role(uid, 'admin')`.

### How data is stored and retrieved
- All tables are RLS-protected — a user can only read/write their own rows.
- Admin access is granted via the `has_role()` SECURITY DEFINER function.
- Postgres RPC functions (`log_system_event`, `has_role`, `get_user_role`) handle cross-cutting logic.

### How files / uploads are handled
- Media uploads go through `cloudinary-upload` → Cloudinary CDN.
- `media_files` + `media_folders` tables track assets and metadata.
- Instagram URLs are optimized with `f_jpg,q_auto` Cloudinary transforms.
- Video pipeline: `process-video` + `transcode-video` (external transcode — Deno has no FFmpeg).

### Background jobs, cron jobs, queues, webhooks
- **Cron (pg_cron):** `process-scheduled-posts`, `process-scheduled-emails`, `process-scheduled-flags`, `process-scheduled-blog-posts`, `whatsapp-scheduled-sender`, `refresh-tokens`, `send-token-expiry-notifications`, `send-expiry-reminders`, `send-weekly-analytics`, `sync-user-quotas`, `observability-collector`, `observability-alerts`, `cleanup-media`, `notify-expiring-ai-overrides`, `sync-resend-delivery-status`. All gated by `CRON_SECRET`.
- **Webhooks:** `stripe-webhook`, `resend-webhook`, `tiktok-webhook`, `whatsapp-webhook`, `threads-webhook`.

---

## 4. Folder Structure

```text
postora/
├── src/                         # React SPA source
│   ├── pages/                   # ~70 page components (user + admin routes)
│   │   ├── admin/               # ~25 admin role-gated pages
│   │   ├── analytics/           # Analytics sub-routes
│   │   ├── docs/                # Marketing-style docs pages
│   │   ├── media-library/       # Media library shell
│   │   ├── messaging/           # Unified inbox shell
│   │   └── templates/           # Post templates
│   ├── components/              # Reusable UI
│   │   ├── ui/                  # shadcn/ui primitives
│   │   ├── post/                # Composer pieces (per-platform tabs, settings)
│   │   ├── profiles/            # Profile + connect cards
│   │   ├── admin/               # Admin widgets, tables, charts
│   │   ├── messaging/           # Inbox UI
│   │   ├── threads/             # Threads discovery / insights UI
│   │   ├── analytics/           # Brand intelligence widgets
│   │   ├── layout/              # App shell, sidebar, header
│   │   └── ...                  # auth, landing, calendar, media, etc.
│   ├── hooks/                   # ~75 custom React hooks
│   │   └── oauth/               # One hook per platform OAuth flow + redirect handler
│   ├── contexts/                # PublishingContext, ProcessingJobsContext, VideoProcessingDebugContext
│   ├── integrations/supabase/   # Generated Supabase types + client
│   ├── lib/                     # Utilities, types, image utils, oauth state, sdks
│   ├── services/                # Error tracking
│   ├── stores/                  # Zustand stores (notificationHistoryStore)
│   ├── test/                    # Vitest setup
│   └── types/                   # Shared TypeScript types
├── supabase/
│   ├── functions/               # ~96 Deno edge functions
│   │   └── _shared/             # Shared helpers (CORS, auth, logging, cron-auth)
│   └── migrations/              # ~200 timestamped SQL migrations (read-only)
├── public/                      # Static assets + /about (Google OAuth verification page)
├── infra/                       # Edge runtime env manifests (required-env.json)
├── docs/                        # Internal documentation
├── e2e/                         # Playwright end-to-end tests
├── scripts/                     # Operational scripts (check-edge-env-drift.mjs, etc.)
├── n8n-community-node/          # Companion n8n node source
├── Postora-n8n-community-node/  # Published n8n node package
├── testsprite_tests/            # TestSprite test definitions
├── nginx.conf                   # Production nginx config
├── Dockerfile                   # Multi-stage build (Node 20 → nginx:alpine)
├── docker-compose.yml           # Local containerized run
├── package.json                 # Scripts + dependencies
├── vite.config.ts               # Vite + test config
├── tailwind.config.ts           # Tailwind theme
├── tsconfig*.json               # TypeScript config (app/node/base)
├── eslint.config.js             # ESLint flat config
├── playwright.config.ts         # Playwright E2E config
├── components.json              # shadcn/ui config
├── .env.example                 # Safe env template (placeholder values only)
└── ...                          # Planning docs (ROADMAP.md, PRD.md, etc.)
```

---

## 5. Main Features

### Production-ready (implemented)

| Feature | What it does | Key files / folders | Related tables |
| --- | --- | --- | --- |
| Multi-platform publishing | Publish to 8+ networks with platform-specific overrides | `process-post`, `CreatePost.tsx`, `usePostForm.tsx`, `usePlatformSettings.tsx` | `posts`, `platform_posts`, `social_accounts` |
| Scheduling | Cron dispatcher with JIT token refresh | `process-scheduled-posts`, `ScheduledPosts.tsx`, `Calendar.tsx` | `posts` (status=`scheduled`) |
| Media library | Cloudinary-backed library with folders, aspect ratios | `MediaLibrary.tsx`, `cloudinary-*` functions | `media_files`, `media_folders` |
| AI caption/hashtag/image | Generate content with AI | `generate-caption`, `generate-hashtags`, `generate-image`, `useContentGeneration.ts` | `user_credits`, `credit_transactions`, `ai_models` |
| AI best-time suggestions | Recommend optimal posting times | `suggest-best-times`, `SmartScheduling.tsx` | — |
| Brand intelligence | Scrape competitor profiles across platforms | `brand-scrape`, `BrandIntelligence.tsx` | — |
| Threads tooling | Discovery, search, insights, location, comment, quote, repost, delete | `threads-*` functions, `useThreads*` hooks | `social_accounts` (threads) |
| Unified messaging inbox | FB / IG / WhatsApp inbox + comments | `messaging-api`, `comment-manager`, `useMessaging.ts` | — |
| Public API (n8n / Make.com) | REST surface for automation integrations | `n8n-api`, `ApiDocumentation.tsx`, `ApiKeys.tsx` | `api_logs`, `profiles.api_key` |
| Subscriptions + credits + coupons | Stripe billing | `stripe-*` functions, `useSubscription.tsx`, `Pricing.tsx` | `subscription_plans`, `user_subscriptions`, `coupons`, `user_credits` |
| Admin observability suite | Logs, health, alerts, token health, rate limits, quotas, feature flags, launch checklist | `admin/Admin*.tsx`, `observability-*` functions | `system_logs`, `system_health_snapshots`, `edge_function_status`, `admin_audit_log` |
| Two-factor auth | TOTP + hashed backup codes | `check-user-mfa`, `manage-backup-codes`, `Settings.tsx` | `backup_codes` |
| Admin email inbox | Resend-backed inbox with threads/drafts/signatures | `send-inbox-email`, `AdminInbox.tsx`, `useAdminInbox.ts` | `email_log`, `email_templates` |

### Partial / experimental

| Feature | Status | Key files |
| --- | --- | --- |
| Bluesky | OAuth + posting works; limited surface | `bluesky-oauth` |
| Reddit | OAuth + basic posting | `reddit-oauth` |
| WhatsApp Business Hub | Broadcast + scheduled sender + profile + webhook; full hub UX expanding | `whatsapp-*` functions, `WhatsAppShop.tsx` |
| Ad Manager | Meta-only, scaffolded | `ad-manager`, `ad-analytics`, `AdManager.tsx`, `AdAnalytics.tsx` |
| Leads CRM | Meta lead-form ingestion + assignment workflow | `leads-api`, `LeadsCRM.tsx` |
| Canvas workflow builder | Visual builder (beta) | `CanvasPage.tsx`, `@xyflow/react`, `useCanvasWorkflow.ts` |
| Smart Scheduling | Best-time engine (beta UI) | `SmartScheduling.tsx` |

### Admin-only modules

App credentials manager, OAuth app registry + verification, observability dashboards + alerts, rate limit configuration, plan quotas, token health, AI provider/model configuration, feature flags (with beta-platform tagging), launch checklist, media cleanup, scaling controls, blog posts ("What's New"), system notifications, scheduled flag/blog/email runners.

---

## 6. API Endpoints

### Architecture

The primary API surface is **~96 Supabase Edge Functions** invoked via `supabase.functions.invoke('<name>', { body })`. The only intended public REST surface is **`n8n-api`** (used by n8n + Make.com, authenticated with `profiles.api_key`).

### Endpoint categories

| Category | Count | Functions | Auth |
| --- | --- | --- | --- |
| Auth / OAuth | 12 | `facebook-oauth`, `instagram-oauth`, `instagram-business-oauth`, `threads-oauth`, `tiktok-oauth`, `youtube-oauth`, `pinterest-oauth`, `linkedin-oauth`, `twitter-oauth`, `bluesky-oauth`, `reddit-oauth`, `whatsapp-oauth`, `manage-oauth-redirects` | user JWT (admin for `manage-oauth-redirects`) |
| Posting | 5 | `process-post`, `process-scheduled-posts`, `process-scheduled-blog-posts`, `process-scheduled-flags`, `process-scheduled-emails` | service-role / cron |
| Media | 11 | `cloudinary-upload`, `cloudinary-delete`, `cloudinary-rename`, `cloudinary-email-upload`, `process-video`, `transcode-video`, `transcribe-media`, `remove-background`, `upscale-image`, `upscale-image-atlas`, `cleanup-media`, `check-music-copyright` | user JWT / cron |
| AI | 10 | `generate-caption`, `generate-hashtags`, `generate-image`, `suggest-best-times`, `ai-config`, `ai-email-assistant`, `analyze-log`, `test-ai-model`, `fetch-openrouter-models`, `openrouter-models` | user JWT / admin |
| Threads | 13 | `threads-discovery`, `threads-keyword-search`, `threads-insights`, `threads-location-search`, `threads-recently-searched`, `threads-comment`, `threads-manage-reply`, `threads-quote`, `threads-repost`, `threads-delete-post`, `threads-reply`, `threads-replies`, `threads-mentions`, `threads-debug-publish-check` | user JWT / admin |
| TikTok | 4 | `tiktok-analytics`, `tiktok-check-status`, `tiktok-demo-publish`, `tiktok-webhook` | user JWT / public (signature) |
| WhatsApp | 6 | `whatsapp-broadcast`, `whatsapp-config-test`, `whatsapp-profile`, `whatsapp-scheduled-sender`, `whatsapp-webhook`, `whatsapp-oauth` | user JWT / cron / public |
| Messaging / Comments | 3 | `messaging-api`, `comment-manager`, `facebook-places-search` | user JWT |
| Analytics / Brand / Ads | 4 | `brand-scrape`, `ad-analytics`, `ad-manager`, `leads-api` | user JWT |
| Tokens / Health | 4 | `refresh-tokens`, `check-connection-health`, `send-token-expiry-notifications`, `send-token-failure-alert` | cron / user JWT |
| Billing | 7 | `stripe-checkout`, `stripe-manage-subscription`, `stripe-webhook`, `create-payment`, `verify-payment`, `backfill-subscription`, `check-subscription` | user JWT / public (signature) |
| Email | 10 | `send-auth-email`, `send-inbox-email`, `send-reset-otp`, `send-subscription-email`, `send-weekly-analytics`, `send-expiry-reminders`, `sync-resend-delivery-status`, `resend-webhook`, `fetch-email-content`, `notify-admin-new-user` | mixed |
| Admin / Ops | 8 | `manage-app-secrets`, `manage-cron-jobs`, `observability-alerts`, `observability-collector`, `sync-user-quotas`, `notify-expiring-ai-overrides`, `get-public-config`, `ecommerce-whatsapp-api` | admin / cron / public |
| MFA & Password | 6 | `check-user-mfa`, `verify-mfa-reset`, `verify-reset-otp`, `manage-backup-codes`, `change-password`, `send-change-password-otp` | mixed |
| MCP | 3 | `mcp`, `mcp-oauth` | mixed |
| Public API | 2 | `n8n-api`, `unsplash-proxy` | api_key / user JWT |
| Webhooks | 5 | `stripe-webhook`, `resend-webhook`, `tiktok-webhook`, `whatsapp-webhook`, `threads-webhook` | signature verification |

> A full per-function reference (Purpose / Access / Input / Output / Errors) lives in [`API_REFERENCE.md`](./API_REFERENCE.md). The table below summarizes the highest-traffic functions.

### Key endpoint reference

| Method | Endpoint (function) | Purpose | Auth | Request body | Response summary | Source file |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `process-post` | Master publisher — routes to per-platform branches | service-role | `{ "post_id": "uuid" }` | `{ success, post_id, results: { <platform>: { success, platform_post_id, platform_post_url, warnings } } }` | `supabase/functions/process-post/index.ts` |
| POST | `process-scheduled-posts` | Cron picker → JIT refresh → `process-post` | cron (`CRON_SECRET`) | `{ }` (reads due posts) | `{ success, processed: N, results: [...] }` | `supabase/functions/process-scheduled-posts/index.ts` |
| POST | `n8n-api` | Public REST: posts/accounts/media/schedule | `profiles.api_key` | varies by resource | `{ success, data: [...], usage: { count, limit, window } }` | `supabase/functions/n8n-api/index.ts` |
| POST | `generate-caption` | AI caption generation (1 credit) | user JWT | `{ platform, tone, language, ... }` | `{ success, caption, credits_remaining }` | `supabase/functions/generate-caption/index.ts` |
| POST | `generate-image` | AI image generation (2 credits) | user JWT | `{ prompt, ... }` | `{ success, image_url, credits_remaining }` | `supabase/functions/generate-image/index.ts` |
| POST | `cloudinary-upload` | Sign + upload file to Cloudinary | user JWT | `{ filename, ... }` | `{ success, url, public_id }` | `supabase/functions/cloudinary-upload/index.ts` |
| POST | `facebook-oauth` | FB OAuth + Page selection | user JWT | `{ action: "get-auth-url"|"exchange-code"|"disconnect", ... }` | `{ success, url? | account? }` | `supabase/functions/facebook-oauth/index.ts` |
| POST | `messaging-api` | Unified inbox CRUD (FB/IG/WA) | user JWT | `{ action, platform, ... }` | `{ success, data }` | `supabase/functions/messaging-api/index.ts` |
| POST | `stripe-checkout` | Create Stripe checkout session | user JWT | `{ plan_id, ... }` | `{ success, url }` | `supabase/functions/stripe-checkout/index.ts` |
| POST | `stripe-webhook` | Stripe event webhook | Stripe signature | (Stripe event) | `{ received: true }` | `supabase/functions/stripe-webhook/index.ts` |
| POST | `refresh-tokens` | Per-platform token refresh | cron | `{ }` | `{ success, refreshed: N }` | `supabase/functions/refresh-tokens/index.ts` |
| POST | `manage-app-secrets` | Read/write `app_credentials` & secrets | admin | `{ action, ... }` | `{ success, data }` | `supabase/functions/manage-app-secrets/index.ts` |
| POST | `get-public-config` | Public-safe config (feature flags, plan IDs) | public | `{ }` | `{ success, config }` | `supabase/functions/get-public-config/index.ts` |

> TODO: Complete per-function request/response schema for all ~96 functions. See `API_REFERENCE.md` for the detailed reference where available.

### Common response conventions

```json
// Success
{ "success": true, "data": { ... } }

// Operator-fixable error (HTTP 200)
{ "success": false, "error_code": "token_expired", "error": "..." }

// Protocol/auth/internal (non-2xx, sanitized)
{ "error": "..." }
```

---

## 7. Database Blueprint

- **Type:** PostgreSQL (relational)
- **Connection method:** Supabase connection pooling (PostgREST + `@supabase/supabase-js`); direct DB via `DATABASE_URL` / `SUPABASE_DB_URL`
- **Security:** Row Level Security (RLS) on every table; admin via `has_role(uid, 'admin')` SECURITY DEFINER helper
- **Migrations location:** `supabase/migrations/` (~200 timestamped SQL files, treated as read-only — new changes require new migration files)

### Core tables

| Table | Purpose | Key columns |
| --- | --- | --- |
| `profiles` | User profile + API key | `id` (FK→auth.users), `email`, `full_name`, `avatar_url`, `api_key` (unique UUID) |
| `user_roles` | Role assignments | `user_id`, `role` (`app_role`: user/admin/subscriber) |
| `social_profiles` | Account groups | `id`, `user_id`, `name`, `share_token`, `is_public` |
| `social_accounts` | Connected platform accounts + tokens | `id`, `user_id`, `platform`, `platform_user_id`, `platform_username`, `access_token`, `refresh_token`, `token_expires_at`, `account_metadata` (JSONB), `is_active`, `social_profile_id`, `needs_reauth`, `failure_count`, `last_refresh_error` |
| `posts` | Authored posts | `id`, `user_id`, `caption`, `platforms` (text[]), `media_file_ids` (uuid[]), `status` (pending/processing/completed/failed/scheduled), `scheduled_at`, `posted_at`, `metadata` (JSONB) |
| `platform_posts` | Per-target publish outcome | `id`, `post_id`, `social_account_id`, `platform`, `platform_post_id`, `platform_post_url`, `status`, `error_message`, `response_data` |
| `media_files` | Media assets (Cloudinary-backed) | `id`, `user_id`, `file_path`, `file_type`, `file_size`, `mime_type`, `storage_bucket`, `metadata` |
| `media_folders` | Folder structure | folder hierarchy for media library |

### Billing & quotas

| Table | Purpose |
| --- | --- |
| `subscription_plans` | Available plans (`price_monthly`, `price_yearly`, `features`, `profile_limit`, `is_popular`) |
| `user_subscriptions` | User subscription records (Stripe linkage) |
| `coupons` | Discount coupons |
| `user_quotas` | Per-user quota matrix |
| `user_credits` | AI credit balance |
| `credit_transactions` | Credit ledger |

### Messaging, notifications & content

| Table | Purpose |
| --- | --- |
| `support_tickets` / `ticket_messages` | Support system |
| `system_notifications` / `notification_reads` | In-app notifications |
| `blog_posts` / `user_blog_post_reads` | "What's New" CMS |

### Config, AI & observability

| Table | Purpose |
| --- | --- |
| `app_settings` | Global key/value config |
| `app_credentials` | Admin-managed platform secrets metadata |
| `ai_providers` / `ai_models` / `ai_model_preferences` | AI registry + per-user/per-feature overrides |
| `system_logs` | Observability logs (48h retention via `observability-collector`) |
| `system_health_snapshots` | Health scores (hourly rollup) |
| `edge_function_status` | Edge function health |
| `token_refresh_history` | Per-account refresh outcomes |
| `api_logs` | Public API logs + rate-limit basis |
| `admin_audit_log` | Admin action trail |
| `email_templates` / `email_log` | Resend transactional email |
| `launch_checklist` | Admin operational checklist |
| `backup_codes` | Hashed 2FA recovery codes (SHA-256 + pepper) |
| `oauth_apps` / `oauth_redirect_requests` | OAuth 2.1 consent flow |

### Database functions / triggers

| Function | Purpose |
| --- | --- |
| `has_role(user_id, role)` | Check if user has a specific role (SECURITY DEFINER) |
| `get_user_role(user_id)` | Get user's primary role |
| `update_updated_at_column()` | Trigger: auto-update `updated_at` |
| `handle_new_user()` | Trigger: create profile on signup |
| `handle_new_user_role()` | Trigger: assign default `user` role on signup |
| `log_system_event(...)` | RPC: write to `system_logs` |
| `log_admin_action(...)` | RPC: write to `admin_audit_log` |

### Storage buckets
- **Cloudinary** — primary media store (uploads, transforms, deletion)
- **Supabase Storage** — per-user folders with RLS enforcing `${userId}/...` as first path segment

---

## 8. Environment Variables

All variables below are documented **by name and purpose only**. Real values live in Supabase Edge Function secrets and the production `.env` on the VPS. **Never commit real secrets.** Copy `.env.example` to `.env` and fill in placeholders.

### Frontend (Vite-exposed)

| Variable | Required | Used by | Purpose | Example |
| --- | --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | ✅ | Frontend | Supabase API gateway URL | `https://api.postora.cloud` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | ✅ | Frontend | Supabase anon/publishable JWT | `eyJhbGciOi...` |
| `VITE_SUPABASE_ANON_KEY` | ✅ | Frontend | Alias of publishable key (must hold same value) | `eyJhbGciOi...` |
| `VITE_SUPABASE_STUDIO_URL` | ❌ | Frontend | Studio dashboard URL (optional link) | `https://api.postora.cloud` |
| `VITE_SUPABASE_PROJECT_ID` | ❌ | Frontend | Cosmetic ref only (never used for URLs) | `self-hosted` |
| `PUBLIC_APP_ORIGIN` | ✅ | OAuth functions | Public app origin | `https://postora.cloud` |
| `PUBLIC_API_ORIGIN` | ✅ | OAuth functions | Public API origin | `https://api.postora.cloud` |

### Supabase (server / Edge Functions)

| Variable | Required | Used by | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | ✅ | Edge functions | Supabase API gateway URL |
| `SUPABASE_ANON_KEY` | ✅ | Edge functions | Anon JWT |
| `SUPABASE_PUBLISHABLE_KEY` | ✅ | Edge functions | Publishable JWT |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Privileged functions | Service role key (bypasses RLS) |
| `SUPABASE_JWT_SECRET` | ✅ | Auth verification | JWT signing secret |
| `SUPABASE_DB_URL` / `DATABASE_URL` | ✅ | Direct DB access | Postgres connection string |
| `SB_MANAGEMENT_TOKEN` | ❌ | Management API | Cloud-style management token |
| `SUPABASE_PROJECT_REF` | ❌ | CLI | Project reference |
| `CRON_SECRET` | ✅ | Cron functions | Shared secret for `pg_cron`-triggered functions (Bearer or `x-cron-secret`) |
| `OAUTH_STATE_SECRET` | ✅ | OAuth functions | HMAC secret for OAuth state param |
| `BACKUP_CODE_PEPPER` | ✅ | 2FA | HMAC pepper for backup codes |
| `SITE_URL` | ✅ | OAuth functions | Public app origin (alias of `PUBLIC_APP_ORIGIN`) |

### Meta (Facebook / Instagram / Threads)

| Variable | Purpose |
| --- | --- |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Facebook app credentials |
| `FACEBOOK_REDIRECT_URI` / `FACEBOOK_GRAPH_API_VERSION` | FB OAuth redirect + Graph API version |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Instagram app credentials |
| `INSTAGRAM_REDIRECT_URI` / `INSTAGRAM_BUSINESS_REDIRECT_URI` | IG OAuth redirects |
| `THREADS_APP_ID` / `THREADS_APP_SECRET` | **Separate** Threads app credentials (≠ FB app) |
| `THREADS_DEMO_MODE` | Threads sandbox flag |
| `THREADS_REDIRECT_URI` / `THREADS_WEBHOOK_VERIFY_TOKEN` | Threads OAuth redirect + webhook |

### Google / YouTube

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials |
| `GOOGLE_AI_STUDIO_KEY` / `GEMINI_API_KEY` | Google AI Studio / Gemini API key |
| `YOUTUBE_REDIRECT_URI` | YouTube OAuth redirect |

### TikTok / Twitter / LinkedIn / Pinterest / Reddit / Bluesky

| Variable | Purpose |
| --- | --- |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` / `TIKTOK_WEBHOOK_SECRET` / `TIKTOK_REDIRECT_URI` | TikTok credentials |
| `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` / `TWITTER_REDIRECT_URI` | Twitter/X credentials |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` / `X_API_KEY` / `X_API_SECRET` | X aliases (legacy) |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` / `LINKEDIN_REDIRECT_URI` | LinkedIn credentials |
| `PINTEREST_CLIENT_ID` / `PINTEREST_CLIENT_SECRET` / `PINTEREST_REDIRECT_URI` | Pinterest credentials |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_REDIRECT_URI` | Reddit credentials |
| `BLUESKY_REDIRECT_URI` | Bluesky redirect (client identity in `public/client-metadata.json`) |

### WhatsApp Cloud API

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp credentials |
| `WHATSAPP_VERIFY_PIN` / `WHATSAPP_WEBHOOK_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` / `META_APP_SECRET` | Verification + webhook signing |

### Media / AI / search / email / payments

| Variable | Purpose |
| --- | --- |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Cloudinary media |
| `ATLASCLOUD_API_KEY` | AtlasCloud 4K upscale |
| `ACRCLOUD_HOST` / `ACRCLOUD_ACCESS_KEY` / `ACRCLOUD_ACCESS_SECRET` | Music copyright detection |
| `DEEPGRAM_API_KEY` | Speech-to-text |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `PERPLEXITY_API_KEY` / `XAI_API_KEY` / `ZAI_API_KEY` / `MINIMAX_API_KEY` / `MINIMAX_GROUP_ID` / `ELEVENLABS_API_KEY` / `LOVABLE_API_KEY` | AI providers |
| `APIFY_API_TOKEN` / `APIFY_API_KEY` | Web scraping (brand intelligence) |
| `BRAVE_SEARCH_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY` | Web search / scraping |
| `UNSPLASH_ACCESS_KEY` / `GIPHY_API_KEY` / `PEXELS_API_KEY` / `PIXABAY_API_KEY` / `KLIPY_API_KEY` | Stock / GIF providers |
| `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` / `SEND_EMAIL_HOOK_SECRET` / `EMAIL_FROM` / `EMAIL_PROVIDER` / `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` | Email (Resend) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Payments (Stripe) |
| `SLACK_API_KEY` | Observability alerts |

> **⚠️ Edge Runtime env warning:** Filling `.env` is not enough. Every variable must also be declared under the `functions` service in `docker-compose.yml` (via `env_file: [./.env]` or explicit `environment:` mapping), otherwise Deno returns `undefined`. See `infra/edge-runtime.required-env.json` and `docs/EDGE_RUNTIME_ENV_RUNBOOK.md`.

---

## 9. Local Development Setup

### Prerequisites
- **Node.js 20+** (required by Dockerfile build stage)
- **npm** (or **Bun** — `bun.lock` is present)
- A Supabase project (local, self-hosted, or cloud) with the schema applied

### Steps

```bash
# 1. Clone the repository
git clone <repo-url> postora
cd postora

# 2. Install dependencies
npm install        # or: bun install

# 3. Copy the env template and fill in values
cp .env.example .env
# Edit .env — set VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, etc.

# 4. Apply database migrations (if pointing at a fresh DB)
#    via Supabase CLI:
# npx supabase db push --db-url "<your-postgres-connection-string>"

# 5. Start the dev server
npm run dev
```

- **Frontend URL:** http://localhost:8080 (Vite dev server, `host: "::"`, `port: 8080`)
- **Backend URL:** your Supabase URL (set in `VITE_SUPABASE_URL`)

> **Threads OAuth caveat:** Meta blocks Threads OAuth from any non-HTTPS origin (`error_code: 1349187`). The frontend guards this client-side in `src/hooks/oauth/useThreadsOAuth.ts`. **Test Threads from `https://postora.lovable.app/profiles` or `https://postora.cloud/profiles`.**

### Edge function local notes
- Edge functions run in the **Deno runtime** inside the Supabase Docker stack.
- Local function testing requires `supabase functions serve` + the env vars mapped into the functions container (see warning in [Environment Variables](#8-environment-variables)).

---

## 10. Production Build & Deployment

### Build

```bash
npm run build      # Vite production build → dist/
```

### Run (Docker)

```bash
docker compose up -d --build
```

The `Dockerfile` is a multi-stage build:
1. **Stage 1 (builder):** `node:20-alpine` — `npm install` + `npm run build`
2. **Stage 2 (serve):** `nginx:alpine` — serves `dist/` on port 80 with `nginx.conf`

### Deployment (Dokploy on Contabo VPS)
- **Frontend:** built from the repo and deployed as a Docker container via Dokploy (app name `postors.cloud`).
- **Backend (Supabase):** self-hosted Supabase stack running in Docker Swarm under Dokploy (stack `postorasupabase-supabase-j8axyh`).
- **Edge functions:** deployed via Supabase CLI:
  ```bash
  npx supabase functions deploy <function-name> --project-ref <ref>
  ```
  > ⚠️ The `SUPABASE_ACCESS_TOKEN` used for MCP is **read-only / MCP-scoped** and CANNOT run `supabase functions deploy` (returns HTTP 401). Generate a new access token in Supabase Dashboard → Account → Access Tokens.

### Reverse proxy / SSL
- nginx (per-container) handles SPA fallback, gzip, cache headers, security headers, CSP.
- SSL/domain termination is handled upstream (Cloudflare + Dokploy/Traefik).
- `/about` is served verbatim (required for Google OAuth verification).

### Database migrations
- Applied via Supabase CLI to the self-hosted instance.
- Migrations are **read-only**; create new timestamped files for changes.

### Production env requirements
- All [Environment Variables](#8-environment-variables) must be set in the production `.env` on the VPS **and** mapped into the functions container.
- `CRON_SECRET` must be set and used by all `pg_cron` jobs.

---

## 11. Current Self-Hosting / Database Setup

- **Database engine:** PostgreSQL via self-hosted Supabase (Kong Gateway routing auth/rest/storage/functions)
- **Hosting:** Contabo VPS at `86.48.2.205`, managed via Dokploy
- **Public URLs (safe, non-secret):**
  - App: `https://postora.cloud`
  - API / Supabase gateway: `https://api.postora.cloud`
  - Realtime WebSocket: `wss://api.postora.cloud`
- **Dokploy stacks:**
  - Frontend: `postora` (app name `postors.cloud`)
  - Supabase: `postorasupabase-supabase-j8axyh`
- **Internal project ID:** `efruibswazzuuupgyzmf` (historical ref used in CLI/container paths only — not a runtime URL)
- **Docker services:** Supabase stack (Postgres, GoTrue auth, PostgREST, Realtime, Storage, Edge Functions, Kong, Studio), frontend container (nginx)
- **Ports:** Container exposes 80 (nginx); Supabase internal ports are managed by the stack
- **Volumes:** Managed by Dokploy for Postgres data persistence

### Backup considerations
- TODO: Automated Postgres backup schedule is not documented in the repo. Recommend daily `pg_dump` to off-VPS storage.

### Security considerations
- RLS enforced on every table
- Service-role key never exposed to the frontend
- Cloudflare WAF + Bot Fight Mode must allow verified bots (Googlebot etc.)
- `system_logs` auto-pruned to ~48h by `observability-collector`
- `CRON_SECRET` gates all cron-triggered functions

> TODO: Document exact backup schedule, retention policy, and disaster-recovery runbook. The repo does not currently encode these.

---

## 12. External Integrations

| Service | Purpose | Key env vars | Related files | Security notes |
| --- | --- | --- | --- | --- |
| **Meta Graph API** (v22.0) | Facebook + Instagram publishing, insights, messaging | `FACEBOOK_*`, `INSTAGRAM_*`, `META_APP_SECRET` | `facebook-oauth`, `instagram-oauth`, `messaging-api` | Separate FB/IG apps; webhook signature verification |
| **Threads Graph** | Threads publishing, discovery, insights | `THREADS_APP_ID/SECRET` (≠ FB app) | `threads-*` functions | HTTPS-only redirect; separate app IDs |
| **TikTok** | Video/photo publish, analytics | `TIKTOK_CLIENT_*`, `TIKTOK_WEBHOOK_SECRET` | `tiktok-*` functions | PKCE; UX-compliant composer |
| **YouTube / Google** | Video + Shorts publish | `GOOGLE_CLIENT_*`, `YOUTUBE_REDIRECT_URI` | `youtube-oauth` | Incremental authorization; Testing-mode 100-refresh cap |
| **Pinterest** | Pin publishing (async 3-step) | `PINTEREST_CLIENT_*` | `pinterest-oauth`, `pinterest-boards` | — |
| **LinkedIn** | Text/image/video posts | `LINKEDIN_CLIENT_*` | `linkedin-oauth` | 24h API response caching (compliance); client `77k0p74fi3zlau` |
| **Twitter/X** | Tweets + threads | `TWITTER_*` / `X_*` | `twitter-oauth` | Requires Basic tier or higher |
| **Bluesky** | Text posts (ATProto) | `BLUESKY_REDIRECT_URI` | `bluesky-oauth` | DPoP-bound tokens |
| **Reddit** | Basic posting | `REDDIT_*` | `reddit-oauth` | — |
| **WhatsApp Cloud API** | Broadcast, messaging, profile | `WHATSAPP_*` | `whatsapp-*` functions | Webhook verify token |
| **Cloudinary** | Media upload/transform/delete | `CLOUDINARY_*` | `cloudinary-*`, `upscale-image` | Signed uploads |
| **AtlasCloud** | 4K image upscale | `ATLASCLOUD_API_KEY` | `upscale-image-atlas` | — |
| **ACRCloud** | Music copyright detection | `ACRCLOUD_*` | `check-music-copyright` | — |
| **Google AI Studio / Gemini** | Default AI model (`gemini-2.5-flash`) | `GOOGLE_AI_STUDIO_KEY`, `GEMINI_API_KEY` | `generate-*`, `suggest-best-times` | — |
| **OpenRouter** | Multi-model AI gateway | `OPENROUTER_API_KEY` | `openrouter-models`, `fetch-openrouter-models` | — |
| **Lovable AI Gateway** | AI generation | `LOVABLE_API_KEY` | AI functions | — |
| **Other AI** | OpenAI, Anthropic, Perplexity, xAI, ZAI, MiniMax, ElevenLabs | respective `*_API_KEY` | `ai-config` registry | DB-driven provider registry |
| **Resend** | Transactional + admin inbox email | `RESEND_*`, `SEND_EMAIL_HOOK_SECRET` | `send-*` functions, `resend-webhook` | Svix webhook signature |
| **Stripe** | Subscriptions, coupons, payments | `STRIPE_*` | `stripe-*` functions | Stripe-Signature verification |
| **Apify** | Brand intelligence scraping | `APIFY_*` | `brand-scrape` | — |
| **Web search/scraping** | Brave, Exa, Firecrawl | respective keys | search/scrape functions | — |
| **Stock / GIF** | Unsplash, Giphy, Pexels, Pixabay, Klipy | respective keys | `unsplash-proxy`, `src/lib/*Api.ts` | Rate-limited proxies |
| **Deepgram** | Speech-to-text | `DEEPGRAM_API_KEY` | `transcribe-media` | 3-tier STT fallback chain |
| **Slack** | Observability alerts | `SLACK_API_KEY` | `observability-alerts` | Configurable |
| **n8n / Make.com** | Automation integrations | (uses `profiles.api_key`) | `n8n-api`, `n8n-community-node/` | Per-user rate limiting via `api_logs` |
| **Supabase Auth** | App login (email + Google) | `SUPABASE_*` | `src/hooks/useAuth.tsx` | JWT-based |

---

## 13. Security Notes

### Auth protection
- Supabase Auth with JWT on every request; service-role for privileged functions only
- 2FA: TOTP + SHA-256 hashed (peppered) backup codes
- Password reset via OTP (`send-reset-otp`, `verify-reset-otp`)

### API authorization
- User JWT validated in-code via `auth-helper.ts` (most functions deploy with `verify_jwt = false` at gateway, validating in code)
- Admin gate: `has_role(uid, 'admin')` checked after user resolution
- Public API (`n8n-api`): `profiles.api_key` (`postora-…` prefix)
- Webhooks: platform-specific signature verification (Stripe-Signature, Svix, Meta verify token)

### Sensitive environment variables
- All secrets in Supabase Edge Function secrets + production `.env` on VPS
- `.env` is gitignored; `.env.example` contains placeholders only
- Service-role key never reaches the frontend

### CORS setup
- Shared CORS headers from `_shared/cors.ts` (`Access-Control-Allow-Origin: *`)
- All functions handle `OPTIONS` preflight

### Rate limiting
- Public API (`n8n-api`): per-user rate limit computed from `api_logs` (default 30/hour)
- Returns HTTP 429 with `{ limit, window }`

### Input validation
- Frontend: Zod schemas + react-hook-form
- Backend: manual schema checks inside each function

### File upload restrictions
- Cloudinary signed uploads via `cloudinary-upload`
- Storage RLS enforces `${userId}/...` as first path segment

### Database access rules
- RLS on every table; users see only their own rows
- Admin access via `has_role()` SECURITY DEFINER helper
- Roles never stored on `profiles` (privilege-escalation safety) — always `user_roles`

### nginx hardening
- Blocks sensitive paths (`.env`, `.git`, `.php`, `config.php`, etc.) with 404
- Security headers: HSTS, X-Frame-Options, X-Content-Type-Options, CSP, Permissions-Policy, COOP, CORP
- CSP allows `https:` broadly to keep Supabase/Cloudinary/Stripe/OAuth popups working

### Known gaps / TODOs
- TODO: Document automated Postgres backup schedule
- TODO: The broad CSP allowlist (`script-src ... https:`) could be tightened to specific origins
- TODO: `verify_jwt = false` at gateway for most functions — relies on in-code validation (acceptable but worth auditing)

---

## 14. Testing & Quality

| Concern | Details |
| --- | --- |
| Unit test framework | **Vitest** (`vitest` v4, jsdom environment) |
| Test command | `npm run dev` runs Vite (tests via `vitest` — see `vite.config.ts` `test` block) |
| Test setup | `src/test/setup.ts` |
| Test files | `src/**/*.{test,spec}.{ts,tsx}`, `src/hooks/__tests__/`, `src/lib/__tests__/` |
| E2E framework | **Playwright** (`@playwright/test`, `playwright.config.ts`) |
| E2E tests | `e2e/` directory |
| Lint command | `npm run lint` (ESLint flat config, `eslint.config.js`) |
| Typecheck | TypeScript strict mode (`tsconfig.app.json`); no `any` allowed |
| Build verification | `npm run build` (Vite production build with sourcemaps) |
| External test runner | TestSprite (`testsprite.config.json`, `testsprite_tests/`) |
| Existing reports | `TEST_REPORT.md`, `FRONTEND_TEST_REPORT.md`, `TESTING_GUIDE.md`, `TESTING_PLAN.md` |

### Missing test coverage TODOs
- TODO: No formal test command in `package.json` scripts beyond lint/build — add `"test": "vitest"` and `"test:e2e": "playwright test"`
- TODO: Coverage thresholds not enforced
- TODO: Backend (edge function) unit tests are minimal

---

## 15. Development Roadmap

> Living planning docs: `ROADMAP.md`, `MONETIZATION_FEATURES_PLAN.md`, `PRD.md`, `REFACTORING_PLAN.md`, `REFACTORING_PLAN_V2.md`. Items below are **planned**, not implemented, unless they appear in [Main Features](#5-main-features).

### Phase 1 – Documentation & Environment Cleanup
- [ ] Consolidate planning docs (`ROADMAP.md`, `PRD.md`, `REFACTORING_PLAN*`) into one source of truth
- [ ] Add `.env.example` validation script to CI
- [ ] Document Postgres backup + disaster-recovery runbook
- [ ] Keep this README in sync after major changes

### Phase 2 – Stability & Bug Fixing
- [ ] Fix remaining connection issues (see `/admin/token-health`)
- [ ] Comprehensive error handling audit across all edge functions
- [ ] Stabilize partial platforms (Bluesky, Reddit, WhatsApp hub)
- [ ] Reduce `ig_video_processing_timeout` rate

### Phase 3 – Security & Auth Hardening
- [ ] Tighten CSP to specific origins instead of broad `https:`
- [ ] Audit `verify_jwt = false` functions
- [ ] Add rate limiting to user-facing functions beyond `n8n-api`
- [ ] Rotate `CRON_SECRET` and `OAUTH_STATE_SECRET` procedure

### Phase 4 – Database & Backup Improvements
- [ ] Automated daily `pg_dump` to off-VPS storage
- [ ] Add missing indexes for hot query paths
- [ ] Partition `system_logs` / `api_logs` for growth
- [ ] Document schema in a single ERD

### Phase 5 – UI/UX Improvements
- [ ] Polish Canvas workflow builder (beta → GA)
- [ ] Polish Smart Scheduling (beta → GA)
- [ ] Mobile responsiveness audit
- [ ] Reduce bundle size (analyze manual chunks)

### Phase 6 – Testing & QA
- [ ] Add `vitest` test script to `package.json`
- [ ] Enforce coverage thresholds
- [ ] Expand Playwright E2E suite
- [ ] Add edge function unit tests

### Phase 7 – Production Deployment Improvements
- [ ] CI/CD pipeline for edge function deploys
- [ ] Blue/green or rolling frontend deploys
- [ ] Structured rollout of Google project out of Testing mode (YouTube 100-refresh cap)
- [ ] Monitoring/alerting on Supabase stack health

### Phase 8 – Future Features
- [ ] Competitor analysis (input profile URL → top performing content)
- [ ] Viral repurposing (AI transcribe + generate new scripts)
- [ ] Team/workspace support (multi-user)
- [ ] Enterprise: SSO/SAML, white-label, audit logs
- [ ] Expand Ad Manager beyond Meta
- [ ] Expand WhatsApp Business Hub UX

---

## 16. Known Issues / Technical Debt

| Issue | Evidence / notes |
| --- | --- |
| Mixed planning docs | `ROADMAP.md`, `PRD.md`, `REFACTORING_PLAN.md`, `REFACTORING_PLAN_V2.md`, `MONETIZATION_FEATURES_PLAN.md` overlap — needs consolidation |
| Duplicate package dirs | Both `n8n-community-node/` and `Postora-n8n-community-node/` exist |
| `OPENAI_API_KEY` drift | AGENTS.md/CLAUDE.md reference `OPENAI_API_KEY` but AI is now DB-driven multi-provider (`ai_providers` + `ai_models`) |
| Broad CSP | `script-src 'self' 'unsafe-inline' 'unsafe-eval' https:` — could be tightened |
| `verify_jwt = false` | Most functions validate JWT in code (acceptable, but worth auditing) |
| Missing backup docs | No automated Postgres backup schedule documented in repo |
| No formal test script | `package.json` has no `test`/`test:e2e` script (only lint/build) |
| Large page files | Some admin pages exceed 400-line target (`AdminTokenHealth.tsx` ~63KB, `AdminUserDetail.tsx` ~63KB, `MediaLibrary.tsx` ~61KB) |
| Experimental modules | Ad Manager, Leads CRM, Canvas, Smart Scheduling are scaffolded/beta |
| Historical ref IDs | `efruibswazzuuupgyzmf` appears in docs/config but is historical only post-migration |
| YouTube Testing-mode cap | 100 refresh-token uses per user until Google project moves to Production |
| Twitter tier requirement | X Basic tier or higher required for OAuth 2.0 user context |

---

## 17. Useful Commands

| Purpose | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Start dev server | `npm run dev` |
| Production build | `npm run build` |
| Dev-mode build | `npm run build:dev` |
| Preview built bundle | `npm run preview` |
| Lint | `npm run lint` |
| Check edge env drift | `npm run check:edge-env` |
| Check edge env (local) | `npm run check:edge-env:local` |
| Run unit tests | `npx vitest` *(TODO: add `"test"` script)* |
| Run E2E tests | `npx playwright test` *(TODO: add `"test:e2e"` script)* |
| Docker build & run | `docker compose up -d --build` |
| Deploy edge function | `npx supabase functions deploy <name> --project-ref <ref>` |
| Apply migrations | `npx supabase db push --db-url "<connection-string>"` |

---

## 18. Contribution / Developer Notes

### For new developers
1. Read this README + `CLAUDE.md` (AI assistant context) + `API_REFERENCE.md`.
2. Clone, `npm install`, `cp .env.example .env`, fill values.
3. `npm run dev` → http://localhost:8080.

### Branching
- Use feature branches off `main`; keep PRs focused.
- File-size governance: target **≤400 lines** per file; refactor when approaching the limit.

### Code style
- **TypeScript strict.** No `any`. Types in `src/lib/types.ts` + generated `src/integrations/supabase/types.ts` (read-only).
- **Tailwind only** — semantic tokens from `index.css` + `tailwind.config.ts`. No inline styles, no new CSS files, all colors HSL.

### Where to add things
- **Frontend components:** `src/components/<feature>/` (use shadcn/ui primitives from `src/components/ui/`)
- **Frontend pages:** `src/pages/` (user) or `src/pages/admin/` (admin, role-gated); register routes in `src/components/AnimatedRoutes.tsx`
- **Frontend hooks:** `src/hooks/` (one per concern; OAuth flows in `src/hooks/oauth/`)
- **Backend endpoints:** `supabase/functions/<name>/index.ts` (Deno); import shared helpers from `supabase/functions/_shared/`
- **Database changes:** new timestamped migration in `supabase/migrations/` (never edit existing)

### RLS-first rule
Every new table needs RLS + a `has_role()`-based admin policy. Roles always in `user_roles`, never on `profiles`.

### Adding environment variables safely
1. Add the name + purpose to `.env.example` (placeholder only).
2. Add it to `infra/edge-runtime.required-env.json` if used by edge functions.
3. Map it into the `functions` service in the Supabase `docker-compose.yml` (`env_file` or `environment:`).
4. Set the real value only in the production `.env` on the VPS.

### Updating database schema
- Create a new `supabase/migrations/<timestamp>_<name>.sql` file.
- Never edit existing migrations (they are read-only history).
- Test locally against a fresh DB before deploying.

---

## 19. Maintenance Checklist

- [ ] **Update dependencies** — `npm audit` + `npm update` / `bun update` monthly
- [ ] **Check environment variables** — run `npm run check:edge-env` to detect drift
- [ ] **Backup database** — verify daily `pg_dump` runs and off-VPS storage *(TODO: schedule not yet documented)*
- [ ] **Check logs** — `/admin/logs`, `/admin/observability`, Supabase Studio logs
- [ ] **Renew SSL** — Cloudflare + Dokploy/Traefik auto-renew; verify expiry quarterly
- [ ] **Run tests** — `npm run lint` + `npm run build` + `npx vitest` + `npx playwright test`
- [ ] **Verify production build** — `npm run build` passes before each deploy
- [ ] **Review security rules** — RLS policies, `has_role()` gates, CSP, webhook signatures
- [ ] **Update README** after major changes — keep feature matrix, env vars, and roadmap current
- [ ] **Monitor token health** — `/admin/token-health`; trigger `refresh-tokens` for failing accounts
- [ ] **Prune observability data** — `observability-collector` trims `system_logs` to ~48h; verify it runs

---

## 20. Final Summary

**Postora** is a production-grade, multi-platform social media management platform built on **React 18 + TypeScript + Vite** for the frontend and **self-hosted Supabase** (Postgres + ~96 Deno Edge Functions + Auth + Storage + Realtime) for the backend. It lets users connect to **11 social networks**, compose and schedule posts with AI assistance, run cross-platform analytics, manage a unified messaging inbox, and exposes a public API for n8n/Make.com automation. The system includes a comprehensive **admin operations suite** (credentials, billing, observability, token health, feature flags) and is hardened with **RLS, 2FA, JWT auth, and platform-specific webhook verification**. It is deployed via **Docker on a Contabo VPS managed by Dokploy**, with Cloudinary for media, Stripe for billing, Resend for email, and multiple AI providers (Gemini default). The codebase is actively maintained with a clear folder structure, ~200 SQL migrations, and living planning docs — though it carries some technical debt around test coverage, backup documentation, and consolidating overlapping planning documents.
