> **⚠️ Self-hosted migration notice (2026-06):** This project now runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference below to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

> **Partner API v1:** For the Partner API (machine-to-machine, `x-postora-key`), see `docs/developer/` — this document describes the older user-JWT / n8n surface.

# Postora - External Developer Technical Guide

> **Confidential** - This document is intended for developers under NDA.  
> **Last Updated**: February 2, 2026  
> **Live App**: https://postora.cloud

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack & Architecture](#tech-stack--architecture)
3. [Project Structure](#project-structure)
4. [Current Critical Issues](#current-critical-issues)
5. [OAuth & Token System](#oauth--token-system)
6. [Social Media Integrations](#social-media-integrations)
7. [Edge Functions Reference](#edge-functions-reference)
8. [Database Schema (Key Tables)](#database-schema-key-tables)
9. [Future Roadmap](#future-roadmap)
10. [Development Guidelines](#development-guidelines)

---

## Project Overview

**Postora** is a comprehensive social media management platform enabling:
- Multi-platform posting (10 platforms supported)
- AI-powered content creation (captions, hashtags, thumbnails)
- Advanced scheduling with calendar view
- Token health monitoring and auto-refresh
- Admin dashboard with analytics

### Supported Platforms
| Platform | Status | Token Type | Notes |
|----------|--------|------------|-------|
| TikTok | ✅ Active | Short-lived (24h) | **NEEDS UI APPROVAL** |
| Instagram | ✅ Active | Long-lived (60d) | Via Meta Business |
| Facebook | ✅ Active | Long-lived (60d) | Via Meta Business |
| YouTube | ✅ Active | Short-lived (1h) | **HAS REFRESH LIMIT ISSUE** |
| Twitter/X | ✅ Active | Short-lived (2h) | OAuth 2.0 PKCE |
| LinkedIn | ✅ Active | Long-lived (60d) | - |
| Pinterest | ✅ Active | Medium-lived (24h) | Requires Standard Access |
| Threads | ✅ Active | Long-lived (60d) | Via Meta |
| Bluesky | ✅ Active | Short-lived (2h) | App password auth |
| Reddit | ✅ Active | Short-lived (1h) | - |

---

## Tech Stack & Architecture

### Frontend
- **Framework**: React 18 + TypeScript + Vite
- **UI**: Tailwind CSS + shadcn/ui (Radix primitives)
- **State**: TanStack Query (server state) + Zustand (client state)
- **Routing**: React Router v6
- **Forms**: react-hook-form + Zod validation

### Backend
- **Platform**: Supabase (PostgreSQL + Edge Functions + Storage)
- **Auth**: Supabase Auth (Email, Google, Facebook OAuth)
- **Edge Functions**: Deno (TypeScript)
- **Cron Jobs**: pg_cron for scheduled token refresh

### Supabase Project
- **Project ID**: `efruibswazzuuupgyzmf`
- **Dashboard**: https://supabase.com/dashboard/project/efruibswazzuuupgyzmf

---

## Project Structure

```
postora/
├── src/
│   ├── components/
│   │   ├── ui/                    # shadcn/ui components (49 files)
│   │   ├── post/                  # Post creation components
│   │   │   ├── platform-settings/ # Platform-specific settings UI
│   │   │   │   ├── TikTokSettings.tsx       # ⭐ TikTok compliance UI
│   │   │   │   ├── TikTokPreviewDialog.tsx  # ⭐ TikTok preview & upload
│   │   │   │   ├── YouTubeSettings.tsx
│   │   │   │   ├── InstagramSettings.tsx
│   │   │   │   └── ...
│   │   │   ├── CreatePost.tsx     # Main post composer
│   │   │   └── PlatformSelector.tsx
│   │   ├── layout/                # Layout components
│   │   ├── admin/                 # Admin panel components
│   │   └── oauth/                 # OAuth connection UI
│   │
│   ├── hooks/
│   │   ├── useAuth.tsx            # Authentication state
│   │   ├── usePosts.tsx           # Post management
│   │   ├── useSocialAccounts.tsx  # Social account CRUD
│   │   ├── useProfileOAuth.tsx    # ⭐ OAuth connection handler
│   │   └── useTokenHealth.tsx     # Token health monitoring
│   │
│   ├── pages/
│   │   ├── admin/
│   │   │   ├── oauth-verification/
│   │   │   │   ├── checklist-data/
│   │   │   │   │   ├── tiktok.ts  # ⭐ TikTok compliance checklist
│   │   │   │   │   └── ...
│   │   │   └── AdminTokenHealth.tsx
│   │   ├── Dashboard.tsx
│   │   ├── CreatePost.tsx
│   │   └── Connections.tsx
│   │
│   ├── lib/
│   │   ├── types.ts               # TypeScript definitions
│   │   ├── platformConstants.ts   # Platform configs & limits
│   │   └── tokenExpiryConstants.ts # Token expiry configs
│   │
│   └── integrations/
│       └── supabase/
│           ├── client.ts          # Supabase client
│           └── types.ts           # Auto-generated DB types
│
├── supabase/
│   ├── functions/
│   │   ├── _shared/
│   │   │   ├── social-auth.ts     # ⭐ Platform-specific refresh logic
│   │   │   ├── tokenExpiryConstants.ts
│   │   │   └── cors.ts
│   │   │
│   │   ├── refresh-tokens/        # ⭐ Main token refresh orchestrator
│   │   │   └── index.ts
│   │   │
│   │   ├── process-post/          # Post publishing to platforms
│   │   │   └── index.ts           # ~4000 lines (needs refactoring)
│   │   │
│   │   ├── tiktok-oauth/          # TikTok OAuth + Creator Info
│   │   │   └── index.ts
│   │   ├── youtube-oauth/
│   │   │   └── index.ts
│   │   ├── facebook-oauth/        # Meta (FB/IG/Threads) OAuth
│   │   │   └── index.ts
│   │   ├── twitter-oauth/
│   │   │   └── index.ts
│   │   ├── pinterest-oauth/
│   │   │   └── index.ts
│   │   ├── linkedin-oauth/
│   │   │   └── index.ts
│   │   ├── reddit-oauth/
│   │   │   └── index.ts
│   │   ├── bluesky-oauth/
│   │   │   └── index.ts
│   │   │
│   │   ├── pinterest-boards/      # Fetch Pinterest boards
│   │   │   └── index.ts
│   │   │
│   │   ├── generate-caption/      # AI caption generation
│   │   ├── generate-hashtags/     # AI hashtag suggestions
│   │   └── generate-thumbnail/    # AI thumbnail generation
│   │
│   ├── config.toml                # Supabase configuration
│   └── migrations/                # Database migrations
│
├── docs/
│   ├── ADMIN-DASHBOARD-IMPLEMENTATION-GUIDE.md
│   ├── REFACTORING_PLAN_V2.md
│   └── EXTERNAL-DEVELOPER-GUIDE.md  # This file
│
└── ROADMAP.md
```

---

## Current Critical Issues

### 🔴 Issue #1: TikTok UI Approval (BLOCKING)

**Problem**: App repeatedly rejected by TikTok review due to UI guideline violations.

**TikTok Content Posting API Requirements**:
1. ✅ Call `creator_info` API before each post (implemented)
2. ✅ Display creator's nickname on posting page (implemented)
3. ⚠️ **NO DEFAULT VALUES** for privacy settings (must verify)
4. ⚠️ **NO DEFAULT VALUES** for interaction toggles (must verify)
5. ✅ Respect `max_video_post_duration_sec` (implemented)
6. ✅ Brand content & organic disclosure toggles (implemented)
7. ✅ Legal consent checkbox (implemented)
8. ⚠️ Music usage acknowledgment (needs verification)

**Key Files to Review**:
```
src/components/post/platform-settings/TikTokSettings.tsx
src/components/post/platform-settings/TikTokPreviewDialog.tsx
src/pages/admin/oauth-verification/checklist-data/tiktok.ts
supabase/functions/tiktok-oauth/index.ts
```

**Action Required**:
1. Review exact rejection comments in TikTok Developer Portal
2. Compare UI against official TikTok UX guidelines
3. Ensure NO pre-selected defaults for privacy/interactions
4. Verify all required disclosures are visible

**TikTok Developer Console**: Check "My Apps" → App History for rejection details

---

### 🔴 Issue #2: YouTube Token Refresh Limit (BLOCKING)

**Problem**: YouTube access tokens expire every 1 hour. Google limits "Testing" mode apps to **100 refresh token uses per user**. After 100 refreshes, users get `invalid_grant` error.

**Root Cause**:
- App is in "Testing" publication status in Google Cloud Console
- Testing mode has hard limit of 100 refresh token rotations
- After limit: refresh token becomes permanently invalid

**Current Architecture**:
```
Cron Schedule: Every 30 minutes for YouTube
Location: supabase/functions/refresh-tokens/index.ts
Logic: supabase/functions/_shared/social-auth.ts → refreshYouTubeToken()
```

**Token Expiry Config** (`_shared/tokenExpiryConstants.ts`):
```typescript
youtube: {
  refreshWindowSeconds: 1800, // 30 mins before expiry
  accessTokenExpirySeconds: 3600, // 1 hour
  isShortLived: true,
}
```

**Solutions**:

| Solution | Effort | Impact |
|----------|--------|--------|
| **Get Google verification** | High (weeks) | Permanent fix, unlimited refreshes |
| **Detect `invalid_grant` → set `needs_reauth`** | Low (1-2 days) | Users must reconnect manually |
| **Implement refresh token rotation handling** | Medium | Better UX, graceful degradation |

**Key Files**:
```
supabase/functions/refresh-tokens/index.ts
supabase/functions/_shared/social-auth.ts (refreshYouTubeToken function)
supabase/functions/_shared/tokenExpiryConstants.ts
```

**Database Fields** (social_accounts table):
- `needs_reauth`: Boolean flag for re-authentication required
- `failure_count`: Tracks consecutive failures
- `last_refresh_error`: Stores error message

---

### 🟡 Issue #3: Meta Business Verification (LONG-TERM)

**Problem**: Meta not approving Business Portfolio for advanced permissions.

**Current State**:
- OAuth flow implemented in `facebook-oauth` edge function
- Basic permissions working (pages_show_list)
- Advanced permissions needed: `instagram_content_publish`, `pages_manage_posts`

**Requirements for Approval**:
1. Business Verification documents (registration, utility bills)
2. Privacy Policy URL: `/privacy`
3. Terms of Service URL: `/terms`
4. Data Usage Disclosure: `/docs/google-api`
5. App Review with screen recordings

**Key Files**:
```
supabase/functions/facebook-oauth/index.ts
src/hooks/useProfileOAuth.tsx
```

---

## OAuth & Token System

### Token Refresh Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    pg_cron Schedules                        │
├─────────────────────────────────────────────────────────────┤
│  Short-lived (30 min):  Twitter, YouTube, Reddit, Bluesky  │
│  Medium-lived (1 hour): TikTok, Pinterest                   │
│  Long-lived (6 hours):  Facebook, Instagram, Threads, LinkedIn │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│            supabase/functions/refresh-tokens/               │
│                                                             │
│  1. Query accounts needing refresh                          │
│  2. Check platform-specific refresh window                  │
│  3. Call platform refresh function                          │
│  4. Update tokens with optimistic concurrency               │
│  5. Log to token_refresh_history                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│           supabase/functions/_shared/social-auth.ts         │
│                                                             │
│  • refreshYouTubeToken()   ← ISSUE: 100 refresh limit       │
│  • refreshTikTokToken()                                     │
│  • refreshFacebookToken()                                   │
│  • refreshTwitterToken()                                    │
│  • refreshPinterestToken()                                  │
│  • refreshLinkedInToken()                                   │
│  • refreshRedditToken()                                     │
│  • refreshBlueskyToken()                                    │
└─────────────────────────────────────────────────────────────┘
```

### Optimistic Concurrency Guard

To prevent race conditions during concurrent refresh attempts:

```typescript
// Capture original token before refresh
const originalRefreshToken = account.refresh_token;

// After getting new tokens, only update if token hasn't changed
const { error } = await supabase
  .from('social_accounts')
  .update({ 
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    token_expires_at: newExpiry
  })
  .eq('id', accountId)
  .eq('refresh_token', originalRefreshToken); // Concurrency guard
```

### Token Expiry Constants

```typescript
// supabase/functions/_shared/tokenExpiryConstants.ts

export const PLATFORM_REFRESH_CONFIG = {
  twitter: {
    refreshWindowSeconds: 3600,      // 1 hour before expiry
    accessTokenExpirySeconds: 7200,  // 2 hours
    isShortLived: true,
  },
  youtube: {
    refreshWindowSeconds: 1800,      // 30 mins before expiry
    accessTokenExpirySeconds: 3600,  // 1 hour
    isShortLived: true,
  },
  tiktok: {
    refreshWindowSeconds: 21600,     // 6 hours before expiry
    accessTokenExpirySeconds: 86400, // 24 hours
    isShortLived: false,
  },
  facebook: {
    refreshWindowSeconds: 604800,    // 7 days before expiry
    accessTokenExpirySeconds: 5184000, // 60 days
    isShortLived: false,
  },
  // ... other platforms
};
```

---

## Social Media Integrations

### TikTok Integration

**OAuth Flow**: `supabase/functions/tiktok-oauth/index.ts`

**Creator Info API** (called before each post):
```typescript
// Returns:
{
  creator_nickname: string,
  creator_avatar_url: string,
  privacy_level_options: string[], // e.g., ["PUBLIC_TO_EVERYONE", "SELF_ONLY"]
  comment_disabled: boolean,
  duet_disabled: boolean,
  stitch_disabled: boolean,
  max_video_post_duration_sec: number,
  daily_limit_total: number,
  daily_limit_remaining: number
}
```

**UI Compliance Checklist** (`src/pages/admin/oauth-verification/checklist-data/tiktok.ts`):
- 16 checklist items across 4 categories
- API Integration, Privacy & Settings, Content Requirements, Documentation

### YouTube Integration

**OAuth Flow**: `supabase/functions/youtube-oauth/index.ts`

**Key Scopes**:
- `youtube.upload` - Upload videos
- `youtube.readonly` - Read channel info

**Known Issue**: 100 refresh token limit in Testing mode

### Meta (Facebook/Instagram/Threads)

**OAuth Flow**: `supabase/functions/facebook-oauth/index.ts`

**Required Permissions**:
- `pages_show_list` - List managed pages
- `pages_manage_posts` - Post to pages (needs review)
- `instagram_basic` - Basic Instagram access
- `instagram_content_publish` - Post to Instagram (needs review)

---

## Edge Functions Reference

| Function | Purpose | Auth | Cron |
|----------|---------|------|------|
| `refresh-tokens` | Orchestrate token refresh | Service role | ✅ |
| `process-post` | Publish posts to platforms | JWT | - |
| `tiktok-oauth` | TikTok OAuth + Creator Info | Public | - |
| `youtube-oauth` | YouTube OAuth flow | Public | - |
| `facebook-oauth` | Meta OAuth (FB/IG/Threads) | Public | - |
| `twitter-oauth` | Twitter/X OAuth | Public | - |
| `pinterest-oauth` | Pinterest OAuth | Public | - |
| `pinterest-boards` | Fetch Pinterest boards | JWT | - |
| `linkedin-oauth` | LinkedIn OAuth | Public | - |
| `reddit-oauth` | Reddit OAuth | Public | - |
| `bluesky-oauth` | Bluesky auth | Public | - |
| `generate-caption` | AI caption generation | JWT | - |
| `generate-hashtags` | AI hashtag suggestions | JWT | - |
| `generate-thumbnail` | AI thumbnail generation | JWT | - |

---

## Database Schema (Key Tables)

### social_accounts
```sql
CREATE TABLE social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  platform_username TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  avatar_url TEXT,
  is_active BOOLEAN DEFAULT true,
  needs_reauth BOOLEAN DEFAULT false,      -- ⭐ For token issues
  failure_count INTEGER DEFAULT 0,          -- ⭐ Track failures
  last_refresh_attempt_at TIMESTAMPTZ,
  last_refresh_error TEXT,
  account_metadata JSONB,
  social_profile_id UUID,
  connected_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### token_refresh_history
```sql
CREATE TABLE token_refresh_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES social_accounts(id),
  platform TEXT NOT NULL,
  platform_username TEXT,
  status TEXT NOT NULL,           -- 'success', 'failed', 'skipped'
  trigger_type TEXT DEFAULT 'cron', -- 'cron', 'manual', 'on_demand'
  cron_category TEXT,             -- 'short', 'medium', 'long'
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### posts
```sql
CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  caption TEXT,
  platforms TEXT[] NOT NULL,
  media_file_ids TEXT[],
  status TEXT DEFAULT 'pending',  -- pending, processing, completed, failed
  scheduled_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  metadata JSONB,                 -- Platform-specific settings
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### platform_posts
```sql
CREATE TABLE platform_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id),
  platform TEXT NOT NULL,
  social_account_id UUID,
  status TEXT DEFAULT 'pending',
  platform_post_id TEXT,          -- ID from the platform
  platform_post_url TEXT,
  error_message TEXT,
  response_data JSONB,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## Future Roadmap

### Phase 1: Current Issues (Priority)
- [ ] TikTok UI approval
- [ ] YouTube token limit solution
- [ ] Meta business verification

### Phase 2: Stability
- [ ] Refactor `process-post` (4000+ lines → modular)
- [ ] Improve error handling across platforms
- [ ] Add comprehensive logging

### Phase 3: Advanced Features
- [ ] Canvas editor for images
- [ ] Competitor analysis (scrape top content)
- [ ] Viral content repurposing with AI

### Phase 4: Integrations
- [ ] n8n community node
- [ ] Make.com integration
- [ ] Zapier integration
- [ ] Webhooks for post status

---

## Development Guidelines

### Environment Setup
1. Clone repository
2. `npm install`
3. Create `.env` with Supabase credentials (ask admin)
4. `npm run dev`

### Edge Function Development
```bash
# Deploy single function
npx supabase functions deploy [function-name] --project-ref efruibswazzuuupgyzmf

# View logs
# Dashboard: https://supabase.com/dashboard/project/efruibswazzuuupgyzmf/functions
```

### Code Standards
- TypeScript strict mode
- Tailwind for styling (no inline styles)
- TanStack Query for data fetching
- Zod for validation
- Always include error handling
- Add logging in edge functions

### Testing
- Vitest for unit tests
- Test files: `*.test.ts` or `__tests__/`

---

## Contact & Resources

- **Live App**: https://postora.cloud
- **Supabase Dashboard**: https://supabase.com/dashboard/project/efruibswazzuuupgyzmf
- **Edge Function Logs**: https://supabase.com/dashboard/project/efruibswazzuuupgyzmf/functions

---

*This document is confidential and intended for authorized developers only.*
