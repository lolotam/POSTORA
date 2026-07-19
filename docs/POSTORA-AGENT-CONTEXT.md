# Postora — Complete Project Context & Marketing Bible

> **Purpose:** Working context for AI agents, marketers, sales, and contributors. Captures the product, integrations, positioning, pricing, competitor angles, and marketing strategy for Postora.
>
> **Last updated:** 2026-07-19
> **Live URL:** https://postora.cloud
> **API URL:** https://api.postora.cloud
> **Operating entity:** WALEED PROLIFE LLC — 200 N Vineyard Blvd, Ste A325 334, Honolulu, HI 96817, USA
> **Admin contact:** dr.vet.waleedtam@gmail.com
> **GitHub:** https://github.com/lolotam/postora
> **n8n node package:** `n8n-nodes-postora` (npm) — current v1.1.11

---

## Table of Contents

1. [Executive Snapshot](#1-executive-snapshot)
2. [Product Identity and Positioning](#2-product-identity-and-positioning)
3. [Unique Selling Points (USPs)](#3-unique-selling-points-usps)
4. [Full Feature Catalog](#4-full-feature-catalog)
5. [Supported Platforms (11)](#5-supported-platforms-11)
6. [Pricing Strategy](#6-pricing-strategy)
7. [Ideal Customer Profile (ICP)](#7-ideal-customer-profile-icp)
8. [Competitor Analysis and Attack Angles](#8-competitor-analysis-and-attack-angles)
9. [Strong Points and Defensible Moats](#9-strong-points-and-defensible-moats)
10. [Yearly Marketing Strategy](#10-yearly-marketing-strategy)
11. [Content Pillars and Messaging](#11-content-pillars-and-messaging)
12. [Tech Stack and Architecture](#12-tech-stack-and-architecture)
13. [Admin and Operations Suite](#13-admin-and-operations-suite)
14. [Integrations and Public API](#14-integrations-and-public-api)
15. [Proof Points and Recent Wins](#15-proof-points-and-recent-wins)
16. [Roadmap Highlights](#16-roadmap-highlights)
17. [Glossary](#17-glossary)

---

## 1. Executive Snapshot

**Postora is the AI-native social media command center.**

One unified dashboard replaces 5–10 fragmented tools for publishing, scheduling, AI content creation, analytics, messaging, media management, and automation across **11 major social networks**.

- **Tagline:** *One Platform. All Your Socials.*
- **Launch message:** *One social command center. No channel tax. No legacy bloat.*
- **Pricing wedge:** The landing page currently advertises Pro at **$5/month** as an early-bird offer (normally $19); competitor pricing needs reconfirmation before public use.
- **Self-hosted Supabase** on a Contabo VPS with about 96 edge functions.
- **Public API + n8n node** for automation-first workflows.
- **Production-live** at https://postora.cloud.

### Evidence Rules

- **Verified product behavior:** sourced from the repository implementation and README.
- **Current commercial terms:** sourced from the active landing-page code and must be checked before external publication.
- **Competitor pricing and product claims:** sourced from the 2026-07-05 launch plan; re-check each competitor's live pricing page before publishing a comparison.
- **Roadmap:** directional only. Do not market an item as available until implementation is verified.

---

## 2. Product Identity and Positioning

### What Postora IS

A unified social media operations platform that combines:

- **Publishing & scheduling** across 11 platforms
- **AI content generation** (captions, hashtags, images, best-time)
- **Unified messaging inbox** (Facebook, Instagram, WhatsApp)
- **Analytics & brand intelligence**
- **Media library** (Cloudinary-backed)
- **Public API** for automation (n8n, Make.com)
- **Admin operations suite** for observability, billing, and platform management

### What Postora IS NOT

- Not just a scheduler (Buffer's positioning)
- Not just a visual planner (Later's positioning)
- Not an enterprise-only tool (Sprout's positioning)
- Not an agency-only tool (SocialPilot's positioning)
- Not a single-platform tool (later's IG heritage)

### Brand Voice

- **Confident but not arrogant** — "modern command center, not legacy bloat"
- **Direct and honest** — transparent pricing, no per-channel tax
- **AI-native** — automation and AI are first-class citizens, not bolted on
- **Builder-friendly** — public API and n8n node signal "we trust you to extend"

---

## 3. Unique Selling Points (USPs)

### USP #1: 11 Platforms in One Dashboard

| Platform | Status |
|---|---|
| Facebook | Implemented: feed, story, reel, carousel |
| Instagram | Implemented: feed, story, reel, carousel, business login |
| Threads | Implemented: carousel, location, cross-share to IG, quote, reply |
| TikTok | Implemented: privacy levels, duet/stitch, commercial-content controls |
| YouTube | Implemented: videos, Shorts, scheduled publishing |
| Pinterest | Implemented: board selection, link pins |
| LinkedIn | Implemented: publishing workflows |
| Twitter / X | Implemented: tweets, threads, media |
| Bluesky | Implemented: ATProto DPoP publishing |
| Reddit | Implemented: publishing workflows |
| WhatsApp | Implemented: mini-app, broadcasts, scheduled sender, agents |

**Marketing use:** lead with breadth only after validating the enabled production platforms for the audience and region.

### USP #2: No Channel Tax — Radical Pricing

| Plan | Postora Price | Closest Competitor |
|---|---|---|
| Free | $0 forever, 2 profiles | Buffer $0 / 3 channels |
| Pro | **$5/mo** (early bird, normally $19) | Buffer $6 / 1 channel |
| Business | $49/mo, unlimited everything | Hootsuite $99 / 1 user, 10 accounts |

**Marketing line:** *"Stop paying the channel tax."*

### USP #3: AI-Native, Not AI-Bolted-On

- **AI Caption Generator** — context-aware captions per platform
- **AI Hashtag Engine** — niche-relevant hashtags
- **AI Image Generation** — DALL-E-grade visuals
- **AI Best-Time Suggestions** — when to post for max engagement
- **AI Transcription** — for video content
- **AI Brand Scraping** — competitor intelligence
- **AI Log Analysis** — observability copilot
- **AI Email Assistant** — for inbox workflows
- **AI Reply Suggestions** — in the unified messaging inbox
- **OpenRouter integration** — pick any LLM (GPT, Claude, Gemini, Llama, etc.)

### USP #4: Unified Messaging Inbox (3 Platforms)

Most competitors handle publishing well but fail at messaging. Postora unifies:

- **Facebook Messenger** (with avatars via Business Asset User Profile Access)
- **Instagram DMs** (both business and direct-login accounts)
- **WhatsApp** (full mini-app with agents, broadcasts, scheduled sender)

With **AI auto-reply + human-agent handoff** for always-on coverage.

### USP #5: Public API + n8n Node + Make.com Integration

- **Public REST API** with API key auth (`postora-…` prefix)
- **n8n community node** published on npm (`n8n-nodes-postora`)
- **Make.com integration** via HTTP modules
- **MCP server** for AI agent integrations
- **Webhook system** for post status callbacks

This is rare — most legacy tools gate API access behind enterprise tiers.

### USP #6: Self-Hosted Supabase — Operational Control

Postora's backend runs on a **self-hosted Supabase** instance on a Contabo VPS:

- Postora operates its own Supabase deployment rather than relying on Supabase Cloud.
- The team controls database, Auth, Storage, Realtime, and Edge Function operations.
- Any data-residency, compliance, or cost claim requires legal and commercial review before use in marketing.
- PostgreSQL + RLS + Edge Functions (Deno) + Realtime + Storage

### USP #7: Operations & Observability Suite (Built-in)

Not a user-facing feature but a **competitive moat** — Postora's admin suite includes:

- Token health monitoring (auto-refresh OAuth tokens)
- Connection health checks
- Feature flags (live toggle features without deploys)
- Rate limit management
- Audit logs (`admin_audit_log`)
- Observability collector + alerts
- Launch checklist (operational readiness)
- OAuth verification tracking
- Plan quota management

Legacy tools charge enterprise prices for these capabilities.

---

## 4. Full Feature Catalog

### A. Publishing & Scheduling

| Feature | Description |
|---|---|
| Unified Composer | One post → many platforms with per-platform overrides |
| Platform-Specific Settings | TikTok privacy/duet/stitch, YouTube category/Shorts, IG carousel, FB first comment, Pinterest boards, Threads location/reply control, LinkedIn visibility, etc. |
| Carousel Posts | Multi-image carousels (up to 10 slides) for IG, FB, Threads, LinkedIn |
| Story Posts | FB/IG Stories with auto-share-to-feed option |
| Reel Posts | FB Reels, IG Reels, YouTube Shorts |
| Cloudinary Image Compression | Auto-compress PNG → JPEG q_80 for platform limits (e.g., Threads 8MB) |
| Video Processing | Transcode + thumbnail extraction via external pipeline |
| Scheduling | Cron-driven dispatcher with JIT (just-in-time) token refresh |
| Calendar View | Drag-and-drop rescheduling |
| Smart Scheduling | AI-suggested optimal posting times per platform |
| Templates | Save and reuse post templates |
| First Comment | Auto-post a comment immediately after publishing |
| Cross-Posting | IG → Threads cross-share, FB → IG cross-post |

### B. AI Suite

| Feature | Endpoint | Description |
|---|---|---|
| Caption Generator | `generate-caption` | Context-aware, platform-tuned captions |
| Hashtag Suggestions | `generate-hashtags` | Niche-relevant hashtags with volume/competition scoring |
| Image Generation | `generate-image` | AI-generated visuals |
| Best-Time Suggestions | `suggest-best-times` | Per-platform optimal posting windows |
| Media Transcription | `transcribe-media` | Speech-to-text for video content |
| Brand Scraping | `brand-scrape` | Competitor profile scraping across platforms |
| Log Analysis | `analyze-log` | AI observability copilot for system logs |
| Email Assistant | `ai-email-assistant` | AI for inbox workflows |
| Agent Reply | `ai-agent-reply` | AI auto-responses in unified inbox |
| Knowledge Ingest | `ai-knowledge-ingest` | Build brand voice from existing content |
| Background Removal | `remove-background` | AI image background removal |
| Image Upscaling | `upscale-image`, `upscale-image-atlas` | AI image enhancement |
| Music Copyright Check | `check-music-copyright` | ACRCloud-powered copyright detection |
| AI Agent Reply (WhatsApp) | `ai-agent-reply` | AI auto-reply with human handoff |
| AI Configuration | `ai-config` | Admin-tunable AI model selection |

### C. Unified Messaging Inbox

| Feature | Description |
|---|---|
| Facebook Messenger | Full thread + reply + participant avatars |
| Instagram DMs | Both business-login and direct-login IG accounts |
| WhatsApp Business | Full mini-app with templates, agents, broadcasts |
| Unified Threads | One inbox across all three platforms |
| Realtime Updates | Supabase Realtime WebSocket for live message delivery |
| Comment Management | Hide/reply to FB/IG comments from inbox |
| AI Auto-Reply | AI-powered responses with confidence thresholds |
| Human Handoff | Seamless escalation from AI to human agent |
| Webhook Persistence | Meta webhooks persisted to DB for audit trail |

### D. Analytics & Intelligence

| Feature | Description |
|---|---|
| Cross-Platform Analytics | Unified metrics across all connected accounts |
| Facebook Analytics | Page insights, post performance, audience |
| Instagram Analytics | Account insights, reel metrics, story metrics |
| Brand Intelligence | Competitor scraping and benchmarking |
| Ad Analytics | Facebook Ad performance tracking |
| Ad Manager | Create/manage Facebook ad campaigns |
| Threads Discovery | Find trending Threads content and creators |
| Threads Mentions | Track brand mentions on Threads |
| Weekly Analytics Email | Automated performance summary |

### E. Media Library

| Feature | Description |
|---|---|
| Cloudinary-Backed Storage | CDN-delivered media with on-the-fly transforms |
| Folders | Hierarchical organization |
| Aspect Ratios | Per-platform sizing |
| Background Removal | One-click AI removal |
| Image Upscaling | AI-powered resolution enhancement |
| Video Transcoding | External pipeline for format conversion |
| Auto-Cleanup | Cron-driven cleanup of orphaned media |
| Email-to-Upload | Send attachment to special address → auto-add to library |

### F. WhatsApp Mini-App (Standalone Sub-Product)

| Feature | Description |
|---|---|
| WhatsApp-branded UI | Full WhatsApp green theme, replaces Postora sidebar |
| Templates | Pre-approved message templates |
| Contacts Manager | CRM-style contact management |
| Broadcasts | Mass messaging campaigns |
| Scheduled Sender | Time-delayed message sending |
| AI Agents | Auto-reply with brand voice |
| Human Agent Mode | Take over from AI |
| WhatsApp Shop | E-commerce integration |
| Lead CRM | Lead capture and pipeline |

### G. Subscriptions & Billing

| Feature | Description |
|---|---|
| Stripe Integration | Full subscription billing |
| Plan Tiers | Free / Pro / Business (admin-configurable) |
| Coupons | Discount codes with usage limits |
| Credits | AI feature credits with purchase/refresh logic |
| Profile Limits | Per-plan profile count limits |
| Auto-Reconciliation | Self-healing cron for subscription state |
| Customer Portal | Stripe-hosted subscription management |

### H. Security & Auth

| Feature | Description |
|---|---|
| Email/Password Auth | Supabase Auth |
| Google OAuth | Sign in with Google |
| 2FA (TOTP) | Time-based one-time passwords |
| Backup Codes | SHA-256 hashed (peppered) recovery codes |
| Row Level Security | Every table RLS-protected |
| Admin Role Gating | `has_role(uid, 'admin')` SECURITY DEFINER |
| API Keys | Per-user API keys for public API access |
| Session Management | Auto-refresh, stale-session cleanup |
| Password Reset | OTP-based secure reset flow |
| MFA Reset | Verified reset flow for lost 2FA devices |

### I. Public API & Automation

| Feature | Description |
|---|---|
| REST API | Full CRUD for posts, media, accounts |
| API Documentation | Interactive docs at `/api-documentation` |
| API Playground | Try endpoints in-browser at `/api-playground` |
| n8n Node | Published npm package `n8n-nodes-postora` |
| Make.com | HTTP module integration |
| MCP Server | Model Context Protocol for AI agents |
| Webhooks | Post status callbacks to user URLs |
| Rate Limiting | Per-key request throttling |

### J. Threads Tooling (Deep Integration)

| Feature | Endpoint | Description |
|---|---|---|
| Discovery | `threads-discovery` | Find trending Threads content |
| Quote Posts | `threads-quote` | Quote-tweet Threads |
| Reply | `threads-reply`, `threads-replies` | Reply to Threads |
| Comment | `threads-comment` | Comment on Threads |
| Delete | `threads-delete-post` | Delete own Threads |
| Mentions | `threads-mentions` | Track mentions |
| Recently Searched | `threads-recently-searched` | Search history |
| Location Tagging | Built into `process-post` | Native Threads location tags |

### K. Notifications & Communication

| Feature | Description |
|---|---|
| In-App Notifications | Admin → user notifications |
| Blog Posts ("What's New") | Feature announcements |
| Email Notifications | Resend-powered transactional |
| Token Expiry Alerts | Proactive OAuth token refresh warnings |
| Subscription Emails | Welcome, renewal, expiry |
| Weekly Analytics | Automated performance digests |

---

## 5. Supported Platforms (11)

| Platform | Auth Type | Posting Capabilities | Special Features |
|---|---|---|---|
| Facebook | OAuth (Page tokens) | Feed, Story, Reel, Carousel, First Comment | Page selection, place tagging |
| Instagram | OAuth (business & direct login) | Feed, Story, Reel, Carousel | Cross-share to Threads |
| Threads | OAuth | Feed, Carousel, Story cross-share | Location, reply control, topic tags |
| TikTok | OAuth (PKCE) | Feed, Reel | Privacy levels, duet/stitch, commercial content, UX-compliant |
| YouTube | OAuth (Google) | Videos, Shorts | Category, tags, visibility, chapters |
| Pinterest | OAuth | Pins | Board selection, link pins |
| LinkedIn | OAuth | Feed, Carousel | Visibility (public/connections), hashtags |
| Twitter / X | OAuth (1.0a + 2.0) | Tweets, Threads | Up to 4 images per tweet |
| Bluesky | OAuth (ATProto DPoP) | Posts | Decentralized identity |
| Reddit | OAuth | Posts | Subreddit selection |
| WhatsApp | OAuth + Cloud API | Messages, Templates | Mini-app, agents, broadcasts |

---

## 6. Pricing Strategy

### Live Pricing Tiers

| Plan | Price | Profiles | Posts/Month | Key Features |
|---|---|---|---|---|
| **Free** | $0 forever | 2 | 10 | Basic analytics, community support |
| **Pro** (Early Bird) | **$5/mo** (normally $19) | 10 | Unlimited | Advanced analytics, priority support, AI captions, custom scheduling |
| **Business** | $49/mo | Unlimited | Unlimited | Team collaboration, API access, white-label, dedicated account manager |

### Pricing Wedge (Marketing)

| Competitor | Entry Price | What You Get | Postora Equivalent |
|---|---|---|---|
| Hootsuite Standard | $99/mo | 1 user, 10 accounts | Postora Business ($49) — unlimited |
| Sprout Social Standard | $199/seat/mo | 5 profiles | Postora Pro ($5) — 10 profiles |
| Buffer Team | $12/mo per channel | 1 channel | Postora Pro ($5) — 10 profiles |
| Later Starter | $25/mo | 1 social set, 30 posts/profile | Postora Free — 2 profiles, 10 posts |
| SocialPilot Pro | $30/mo | 5 accounts | Postora Pro ($5) — 10 profiles |

### Pricing Philosophy

1. **No per-channel / per-seat tax** — flat pricing, scale freely
2. **Early-bird wedge** — first 100 users get $5/mo Pro (creates urgency)
3. **Generous free tier** — eliminate trial friction
4. **Transparent** — pricing page, no "contact sales" until Business
5. **Value-based** — anchor against expensive legacy tools

---

## 7. Ideal Customer Profile (ICP)

### Primary ICP: Modern Creator-Operators

**Demographics:**
- Age 22–45
- Solopreneurs, creators, social media managers
- Managing 3+ social accounts across 3+ platforms
- Tech-comfortable, value automation
- Price-sensitive but willing to pay for value

**Psychographics:**
- Frustrated with legacy tool pricing (Hootsuite/Sprout)
- Wants ONE dashboard, not 5 tabs
- Values AI as a collaborator, not a replacement
- Cares about data sovereignty and tool control
- Active on Threads/TikTok/Bluesky (early adopter platforms)

### Secondary ICP: Lean Agencies

**Demographics:**
- 1–10 person agencies
- Managing 5+ client accounts
- Need reporting, white-label, API access
- Priced out of Sprout/Hootsuite enterprise tiers

**Psychographics:**
- Wants to scale without multiplying costs
- Needs automation for repeatable workflows
- Values API access for custom integrations
- Cares about team collaboration features

### Tertiary ICP: SMB Marketing Teams

**Demographics:**
- Small businesses with social presence
- 1–3 person marketing teams
- Multiple platforms (FB, IG, TikTok at minimum)
- Need scheduling + analytics + messaging

---

## 8. Competitor Analysis and Attack Angles

### Hootsuite

**Their positioning:** "Full social operating system" for teams
**Pricing:** Standard $99/mo (1 user, 10 accounts); Professional for unlimited
**Their weakness:** **Priced for enterprises, sold to everyone.** Small teams pay enterprise prices for basic operations.
**Attack angle:** *"Stop paying the Hootsuite enterprise tax. Postora gives you the same command center for $5/mo."*
**Where to hit:** Pricing comparison posts, SMB/agencies, switch campaigns

### Buffer

**Their positioning:** Simple publishing and queue management
**Pricing:** Free (3 channels, 10 scheduled posts); paid per-channel
**Their weakness:** **It's a scheduler, not an operations engine.** No unified inbox, limited AI, no API access on lower tiers.
**Attack angle:** *"Buffer schedules your posts. Postora runs your entire social operation — publish, message, analyze, automate."*
**Where to hit:** Feature comparison (inbox, AI, analytics, API), "beyond the queue" content

### Later

**Their positioning:** Visual planner with IG heritage
**Pricing:** Starter $25/mo (1 social set, 30 posts/profile); Growth $45/mo
**Their weakness:** **IG-first thinking in a multi-platform world.** Visual planner is a feature, not a product.
**Attack angle:** *"Later plans the grid. Postora runs the whole social engine — across platforms, messages, AI, analytics, and automation."*
**Where to hit:** Multi-platform emphasis, Threads/TikTok/Bluesky coverage, unified inbox

### Sprout Social

**Their positioning:** Enterprise-quality social management
**Pricing:** Standard $199/seat/mo (5 profiles); Professional $299/seat/mo (unlimited)
**Their weakness:** **Corporate procurement pricing.** SMBs and creators can't justify $200+/month per seat.
**Attack angle:** *"Sprout is priced for corporations. Postora gives agencies and creators enterprise power without enterprise procurement."*
**Where to hit:** SMB/agency switch campaigns, ROI calculators, "no per-seat tax"

### SocialPilot

**Their positioning:** Agency-focused scheduling
**Pricing:** $30/mo (5 accounts) to $200/mo (40 accounts)
**Their weakness:** **Traditional scheduler with AI bolted on.** Not automation-first, not AI-native.
**Attack angle:** *"SocialPilot is a traditional scheduler with agency packaging. Postora is AI-native and automation-first — built for the next decade, not the last one."*
**Where to hit:** AI workflows, n8n/Make.com integrations, automation case studies

---

## 9. Strong Points and Defensible Moats

### Technical Moats

1. **Self-hosted Supabase** — direct control of the application backend and operational stack
2. **~96 edge functions** — depth of integration across 11 platforms (hard to replicate)
3. **Just-in-time token refresh** — robust scheduling that doesn't fail on expired tokens
4. **Public API + n8n node** — rare in this space, signals trust and extensibility
5. **Cloudinary on-the-fly transforms** — media cost optimization (8MB PNG → 0.3MB JPEG)
6. **Operations suite** — observability, feature flags, audit logs, and token-health tooling in the same product stack

### Product Moats

1. **11 platforms supported** — deepest coverage in the SMB/creator tier
2. **Unified inbox across FB/IG/WhatsApp** — most competitors only do publishing well
3. **Threads deep integration** — early-mover advantage (quote, reply, location, discovery)
4. **Bluesky + Reddit support** — differentiated coverage that should be validated against competitors before comparison
5. **AI-native architecture** — AI is first-class, not bolted on (10+ AI features)
6. **WhatsApp mini-app** — full sub-product, not a checkbox feature

### Pricing Moats

1. **$5 Pro tier** — undercutting Buffer ($6/channel) and SocialPilot ($30/5 accounts)
2. **No per-channel / per-seat tax** — flat pricing
3. **Generous free tier** — eliminates trial friction
4. **Lifetime early-bird pricing** — creates urgency and locks in early adopters

### Distribution Moats

1. **n8n community node** on npm — discoverable by automation builders
2. **Public API documentation** with interactive playground
3. **OpenRouter integration** — LLM-agnostic, future-proof
4. **Self-hosted option** — appeals to privacy-conscious and enterprise-curious

---

## 10. Yearly Marketing Strategy

### Q1: Disruptor Launch

**Theme:** *Stop paying the channel tax.*
**Goal:** Awareness and trial signups
**Core message:** Legacy tools charge by channels, seats, and limits. Postora replaces fragmented workflows with one command center.
**Content types:**
- Competitor comparison posts (price/feature matrices)
- Launch manifesto ("no channel tax")
- Pricing disruption visuals
- Multi-platform publishing demos
- Switch-from-Hootsuite/Sprout campaigns

### Q2: Automation Ecosystem

**Theme:** *Your social media on autopilot.*
**Goal:** Adoption and activation
**Core message:** Postora is not only a scheduler — it connects to real automation workflows via n8n, Make.com, APIs, and AI content pipelines.
**Content types:**
- n8n workflow tutorials
- Creator automation playbooks
- Agency operations templates
- Integration explainers
- API deep-dives

### Q3: Agency Scaling

**Theme:** *Scale without limits.*
**Goal:** Expansion into agencies and high-volume teams
**Core message:** Manage more clients, platforms, messages, and campaigns without multiplying tools or costs.
**Content types:**
- Agency playbooks
- Account scaling case studies
- White-label/operations angles
- Workflow templates
- Team collaboration features

### Q4: Performance Proof

**Theme:** *The peak engagement advantage.*
**Goal:** Retention, proof, and authority
**Core message:** AI-assisted scheduling, analytics, and unified operations improve consistency, speed, and engagement.
**Content types:**
- Year-end reports
- Analytics wins / case studies
- Best-time recommendations explained
- Customer success stories
- Product update recaps

---

## 11. Content Pillars and Messaging

### 12 Core Content Pillars

1. **Pricing disruption** — "$5/mo vs $99/mo Hootsuite"
2. **Multi-platform publishing** — "11 platforms, one composer"
3. **AI captions and hashtags** — "Generate a week of content in 10 minutes"
4. **AI image generation and creative workflows** — "From idea to visual in seconds"
5. **Smart scheduling and best-time recommendations** — "Post when your audience is listening"
6. **Unified inbox and customer care** — "FB + IG + WhatsApp in one inbox"
7. **Analytics and brand intelligence** — "Know what works and what competitors do"
8. **Team collaboration and approvals** — "Built for teams, not just solos"
9. **Content calendar and media library** — "Your content ops in one place"
10. **n8n/Make.com automation** — "API-first, automation-native"
11. **All-in-one social operations** — "Replace 5-10 tools"
12. **Self-hosted / data sovereignty** — "Your data, your rules"

### Brand Voice Adjectives

- Confident (not arrogant)
- Direct (no fluff)
- Modern (not legacy)
- AI-native (not AI-bolted)
- Builder-friendly (APIs, docs, integrations)
- Honest (transparent pricing, real limits)

### Forbidden Messaging

- ❌ "We use AI" (everyone says this — show, don't tell)
- ❌ "Best-in-class" (vague, overused)
- ❌ "Next-generation" (cliché)
- ❌ "Robust" (meaningless)
- ❌ Direct attacks on competitors (compare on facts, don't insult)

---

## 12. Tech Stack and Architecture

### Frontend

| Layer | Technology |
|---|---|
| Framework | React 18 |
| Language | TypeScript 5 (strict) |
| Build | Vite 5 |
| Styling | Tailwind CSS 3 + shadcn/ui (Radix) |
| Routing | react-router-dom v7 |
| Server state | TanStack Query v5 |
| Client state | Zustand + React Context |
| Forms | react-hook-form + Zod |
| Charts | Recharts |
| Visual builder | @xyflow/react (Canvas workflow) |
| Animation | Framer Motion |
| Theming | next-themes (dark default) |
| Error tracking | Sentry |
| Auth | Supabase Auth (email, Google OAuth, 2FA TOTP) |

### Backend

| Layer | Technology |
|---|---|
| Runtime | Supabase Edge Functions (Deno) |
| Database | PostgreSQL (self-hosted Supabase) |
| Auth | Supabase Auth (JWT + 2FA + backup codes) |
| Storage | Cloudinary (media) + Supabase Storage (per-user) |
| Realtime | Supabase Realtime (WebSocket) |
| Functions | ~96 Deno edge functions |
| Background jobs | pg_cron (15+ scheduled jobs) |
| Webhooks | Stripe, Resend, TikTok, WhatsApp, Threads, Facebook/Instagram |

### Infrastructure

| Component | Setup |
|---|---|
| Frontend hosting | Docker (Node 20 → nginx:alpine) on Contabo VPS via Dokploy |
| Backend hosting | Self-hosted Supabase Docker swarm on same VPS |
| CDN/WAF | Cloudflare |
| Domains | postora.cloud (app), api.postora.cloud (Supabase gateway) |
| CI/CD | GitHub → Dokploy auto-deploy on push to main |
| Error tracking | Sentry |

### External Integrations

- **Meta Graph API** (v22.0) — Facebook, Instagram, Threads, Messenger
- **TikTok API** — Content publishing, webhooks
- **Google/YouTube API** — OAuth + YouTube Data API v3
- **Pinterest API** — Boards, pins
- **LinkedIn API** — Posts, carousels
- **Twitter/X API** — v1.1 + v2
- **Bluesky/ATProto** — DPoP-authenticated
- **Reddit API** — Posts
- **WhatsApp Cloud API** — Messaging, templates, agents
- **Cloudinary** — Media CDN + transforms
- **Stripe** — Subscription billing
- **Resend** — Transactional email
- **OpenRouter** — Multi-LLM gateway
- **Atlas** — AI services
- **ACRCloud** — Music copyright detection
- **OpenAI / Anthropic / Google / Llama** — via OpenRouter
- **Unsplash** — Stock imagery (proxied)

---

## 13. Admin and Operations Suite

Postora ships with an extensive admin suite — rare for SMB-tier tools:

### Admin Modules

| Module | Purpose |
|---|---|
| **Admin Dashboard** | Overview metrics, recent activity |
| **User Management** | List, search, suspend, detail view |
| **Subscriptions** | Active/cancelled/expired tracking |
| **Plans Builder** | Configure plans, features, limits |
| **Plan Quotas** | Per-plan feature quotas |
| **Coupons** | Discount code management |
| **Support Messages** | User support tickets |
| **Admin Inbox** | Cross-user messaging oversight |
| **Notifications** | System-wide announcements |
| **Blog Posts** | "What's New" feature announcements |
| **OAuth Verification** | Track Meta/Google app review status |
| **OAuth Apps** | Manage OAuth credentials |
| **Token Health** | Monitor OAuth token expiration/refresh |
| **Feature Flags** | Live-toggle features without deploys |
| **Rate Limits** | Per-endpoint throttling config |
| **Observability** | System metrics, alerts, dashboards |
| **Logs** | Searchable system_logs table |
| **AI Configuration** | Per-model admin tuning |
| **Media Cleanup** | Orphaned media removal |
| **Launch Checklist** | Operational readiness tracking |
| **Admin Analytics** | Cross-user aggregate metrics |
| **Scaling** | Capacity planning metrics |
| **Settings** | App-wide config |

---

## 14. Integrations and Public API

### Public API

- **Base URL:** `https://api.postora.cloud/functions/v1/n8n-api`
- **Auth:** `x-api-key` header (per-user API key, `postora-…` prefix)
- **Documentation:** https://postora.cloud/api-documentation
- **Playground:** https://postora.cloud/api-playground

### Endpoints (Highlights)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/post` | Create a post (immediate or scheduled) |
| GET | `/api/v1/post/:id` | Get post status |
| GET | `/api/v1/accounts` | List connected social accounts |
| POST | `/api/v1/media/upload` | Upload media file |
| GET | `/api/v1/media/:id` | Get media file by ID |
| GET | `/api/v1/health` | API health check |

### n8n Community Node

- **Package:** `n8n-nodes-postora`
- **npm:** https://www.npmjs.com/package/n8n-nodes-postora
- **GitHub:** https://github.com/lolotam/postora-n8n-community-node
- **Current version:** 1.1.11 (as of 2026-07-03)
- **Capabilities:** Post → Create (None/URL/Binary/Media File ID), Media → Upload (same + SSRF-hardened URL download)

### Make.com Integration

- HTTP module-based integration
- Documented at `/make-integration`

### MCP Server

- Model Context Protocol server for AI agent integrations
- OAuth-protected at `/mcp-authorize`

### Webhooks

- Post status callbacks (user-defined URLs)
- Stripe webhook → subscription state reconciliation
- Resend webhook → email delivery tracking
- Meta webhooks → Facebook, Instagram, Messenger
- TikTok webhook → post status
- WhatsApp webhook → incoming messages

---

## 15. Proof Points and Recent Wins

### Meta App Approvals (2026-07-04)

All messaging-relevant Meta permissions approved at **advanced access**:
- Business Asset User Profile Access (FB Messenger avatars)
- pages_messaging
- instagram_manage_messages
- instagram_business_manage_messages
- pages_show_list
- pages_read_engagement
- pages_manage_metadata
- instagram_basic
- instagram_business_basic

### Production Stability (2026-07-19)

- **135 posts** published by admin user (`dr.vet.waleedtam@gmail.com`)
- **245 posts** published by test user (`xsellpointkw@gmail.com`)
- Self-hosted Supabase stable on Contabo VPS
- ~96 edge functions deployed
- 15+ pg_cron background jobs running reliably

### Recent Feature Ships

- **Live messaging realtime** (2026-07-16) — Supabase Realtime cache invalidation across FB/IG/WhatsApp/Threads
- **n8n node v1.1.11** (2026-07-03) — Media File ID source, SSRF-hardened URL download
- **WhatsApp mini-app** (2026-07-05) — Standalone WhatsApp-branded sub-product
- **Threads deep integration** — Quote, reply, comment, delete, mentions, discovery
- **Cloudinary auto-compression** (2026-07-19) — Auto-handle platform image limits (e.g., 8MB Threads → 0.3MB JPEG)
- **Carousel posts** — Multi-image carousels across IG/FB/Threads/LinkedIn

### Operational Proof

- TikTok publishing UX includes creator, privacy, interaction, disclosure, and consent controls; audit status must be confirmed before claiming approval.
- 2FA with hashed backup codes (peppered)
- RLS on every table
- Sentry error tracking
- Audit logs (`admin_audit_log`)
- Observability alerts

---

## 16. Roadmap Highlights

### Confirmed In-Progress / Planned

- **AI Knowledge Base** — ingest brand voice, generate on-brand content
- **No-code Flow Builder** — visual automation builder (Canvas with @xyflow/react)
- **Appointment Reminders** — for WhatsApp mini-app
- **Store Sync** — e-commerce platform integrations (Shopify, WooCommerce)
- **Mobile App** — iOS/Android companion
- **Team Approvals Workflow** — multi-step post approval
- **White-Label Mode** — rebrand Postora for agencies

### Continuous Improvement Areas

- **More AI model integrations** (already LLM-agnostic via OpenRouter)
- **Deeper TikTok/YouTube Shorts analytics**
- **More Threads tooling** (already deepest in market)
- **Enhanced brand intelligence** (competitor benchmarking)

---

## 17. Glossary

| Term | Meaning |
|---|---|
| **Channel tax** | Legacy tools' per-channel/per-seat pricing model |
| **JIT refresh** | Just-in-time OAuth token refresh during scheduling |
| **Unified inbox** | Single inbox across FB Messenger + IG DMs + WhatsApp |
| **Composer** | The post creation UI in Postora |
| **n8n** | Open-source workflow automation tool |
| **MCP** | Model Context Protocol (AI agent standard) |
| **RLS** | Row-Level Security (Postgres feature) |
| **Edge function** | Deno-based serverless function on Supabase |
| **Carousel** | Multi-image post (up to 10 slides) |
| **Cross-share** | Auto-publish to multiple platforms (e.g., IG → Threads) |
| **JWT** | JSON Web Token (used for auth) |
| **Cloudinary** | Media CDN with on-the-fly transforms |
| **DPoP** | Demonstrating Proof-of-Possession (Bluesky auth) |
| **PKCE** | Proof Key for Code Exchange (TikTok OAuth) |
| **TOTP** | Time-based One-Time Password (2FA) |
| **HMAC** | Hash-based Message Authentication Code (webhook signing) |

---

## Appendix: Quick Reference URLs

| Resource | URL |
|---|---|
| Live app | https://postora.cloud |
| API gateway | https://api.postora.cloud |
| API docs | https://postora.cloud/api-documentation |
| API playground | https://postora.cloud/api-playground |
| Pricing | https://postora.cloud/pricing |
| Privacy policy | https://postora.cloud/privacy |
| Terms of service | https://postora.cloud/terms |
| Contact | https://postora.cloud/contact |
| Marketero (sister product) | https://marketero.postora.cloud |
| GitHub repo | https://github.com/lolotam/postora |
| n8n node repo | https://github.com/lolotam/postora-n8n-community-node |
| n8n node (npm) | https://www.npmjs.com/package/n8n-nodes-postora |
| WhatsApp docs | https://postora.cloud/messaging/whatsapp/docs |
| About (Google OAuth) | https://postora.cloud/about |

---

## How To Use This Document

### For AI Agents

When asked about Postora, reference this document for:
- Feature lists and capabilities
- Pricing and positioning
- Competitor comparisons
- Technical architecture
- Marketing messages and angles
- ICP definitions

### For Marketers

Use the Yearly Marketing Strategy (Section 10) and Content Pillars (Section 11) to plan campaigns. Pull attack angles from Competitor Analysis (Section 8).

### For Sales

Use the Pricing Strategy (Section 6) and Competitor Analysis (Section 8) for objection handling. Emphasize USPs (Section 3) in pitches.

### For Support

Reference the Feature Catalog (Section 4) and Glossary (Section 17) when explaining capabilities to users.

### For Contributors

The Tech Stack (Section 12) and Admin Suite (Section 13) describe the system. The README.md has implementation details.

---

*This document is the canonical source of truth for Postora's product, market positioning, and competitive landscape. Update it whenever significant features ship, pricing changes, or competitive dynamics shift.*
