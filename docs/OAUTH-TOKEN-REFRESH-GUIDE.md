> **⚠️ Self-hosted migration notice (2026-06):** This project now runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference below to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

# OAuth & Token Refresh Technical Guide

> **NDA CONFIDENTIAL DOCUMENT**  
> For external developers: K2, Rock  
> Last Updated: February 2, 2026

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Database Schema](#database-schema)
3. [Token Lifecycle Configuration](#token-lifecycle-configuration)
4. [Platform-Specific OAuth Implementations](#platform-specific-oauth-implementations)
5. [Centralized Token Refresh System](#centralized-token-refresh-system)
6. [Optimistic Concurrency Guard](#optimistic-concurrency-guard)
7. [Cron Job Configuration](#cron-job-configuration)
8. [Error Handling & Recovery](#error-handling--recovery)
9. [Known Issues & Current Blockers](#known-issues--current-blockers)
10. [Key Files Reference](#key-files-reference)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           POSTORA OAUTH ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┐     ┌──────────────────────┐     ┌──────────────────┐   │
│   │   Frontend   │────▶│  OAuth Edge Function │────▶│  Platform API    │   │
│   │   React App  │     │  (per-platform)      │     │  (FB/YT/TikTok)  │   │
│   └──────────────┘     └──────────────────────┘     └──────────────────┘   │
│          │                       │                          │               │
│          │                       ▼                          │               │
│          │             ┌──────────────────┐                 │               │
│          │             │  social_accounts │◀────────────────┘               │
│          │             │     (tokens)     │                                 │
│          │             └──────────────────┘                                 │
│          │                       ▲                                          │
│          │                       │                                          │
│          │             ┌──────────────────────────────────────┐             │
│          │             │      refresh-tokens Edge Function    │             │
│          │             │  (Centralized Token Refresh System)  │             │
│          │             └──────────────────────────────────────┘             │
│          │                       ▲                                          │
│          │                       │                                          │
│          │             ┌──────────────────────────────────────┐             │
│          │             │           pg_cron Jobs               │             │
│          │             │  • 30min: short-lived platforms      │             │
│          │             │  • 60min: medium-lived platforms     │             │
│          │             │  • 6hrs:  long-lived platforms       │             │
│          └─────────────▶──────────────────────────────────────┘             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

| Component | Location | Purpose |
|-----------|----------|---------|
| OAuth Edge Functions | `supabase/functions/{platform}-oauth/` | Handle OAuth flow for each platform |
| Refresh Token System | `supabase/functions/refresh-tokens/` | Centralized token refresh orchestration |
| Platform-Specific Logic | `supabase/functions/_shared/social-auth.ts` | Individual refresh API calls |
| Token Config | `supabase/functions/_shared/tokenExpiryConstants.ts` | Platform-specific timing |
| Avatar Cache | `supabase/functions/_shared/avatar-cache.ts` | Cloudinary avatar caching |

---

## Database Schema

### `social_accounts` Table

```sql
CREATE TABLE social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  platform TEXT NOT NULL,                    -- 'facebook', 'tiktok', 'youtube', etc.
  platform_user_id TEXT NOT NULL,            -- External platform's user/page ID
  platform_username TEXT,                    -- Display name for UI
  access_token TEXT NOT NULL,                -- Current access token
  refresh_token TEXT,                        -- Refresh token (NULL for some platforms)
  token_expires_at TIMESTAMPTZ,              -- Token expiration timestamp
  avatar_url TEXT,                           -- Cached Cloudinary avatar URL
  is_active BOOLEAN DEFAULT true,
  connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  social_profile_id UUID,                    -- Profile grouping
  
  -- Health tracking fields
  needs_reauth BOOLEAN DEFAULT false,        -- True = user must reconnect
  failure_count INTEGER DEFAULT 0,           -- Consecutive refresh failures
  last_refresh_error TEXT,                   -- Last error message
  last_refresh_attempt_at TIMESTAMPTZ,       -- Prevents concurrent refreshes
  last_alert_sent_at TIMESTAMPTZ,            -- Alert cooldown tracking
  alerts_snoozed BOOLEAN DEFAULT false,      -- User silenced alerts
  
  account_metadata JSONB,                    -- Platform-specific data
  
  UNIQUE(user_id, platform, platform_user_id)
);
```

### `token_refresh_history` Table

```sql
CREATE TABLE token_refresh_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES social_accounts(id),
  platform TEXT NOT NULL,
  platform_username TEXT,
  status TEXT NOT NULL,           -- 'refreshed', 'failed', 'needs_reauth', 'cooldown', etc.
  error_message TEXT,
  trigger_type TEXT,              -- 'cron', 'manual', 'force'
  cron_category TEXT,             -- 'short', 'medium', 'long'
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## Token Lifecycle Configuration

### Platform Token Expiry Windows

Defined in `supabase/functions/_shared/tokenExpiryConstants.ts`:

```typescript
export const PLATFORM_REFRESH_CONFIG: Record<string, PlatformRefreshConfig> = {
  // SHORT-LIVED (require frequent refresh - 30min cron)
  twitter: {
    refreshWindowSeconds: 3600,        // Refresh 1 hour before expiry
    accessTokenExpirySeconds: 7200,    // 2 hours
    isShortLived: true,
  },
  youtube: {
    refreshWindowSeconds: 1800,        // Refresh 30 mins before expiry
    accessTokenExpirySeconds: 3600,    // 1 hour
    isShortLived: true,
  },
  reddit: {
    refreshWindowSeconds: 1800,        // 30 mins
    accessTokenExpirySeconds: 3600,    // 1 hour
    isShortLived: true,
  },
  bluesky: {
    refreshWindowSeconds: 3600,        // 1 hour
    accessTokenExpirySeconds: 7200,    // 2 hours
    isShortLived: true,
  },
  
  // MEDIUM-LIVED (hourly cron)
  tiktok: {
    refreshWindowSeconds: 21600,       // 6 hours before expiry
    accessTokenExpirySeconds: 86400,   // 24 hours
    isShortLived: false,
  },
  pinterest: {
    refreshWindowSeconds: 21600,       // 6 hours
    accessTokenExpirySeconds: 86400,   // 24 hours (varies)
    isShortLived: false,
  },
  
  // LONG-LIVED (6-hour cron)
  facebook: {
    refreshWindowSeconds: 604800,      // 7 days before expiry
    accessTokenExpirySeconds: 5184000, // 60 days
    isShortLived: false,
  },
  instagram: {
    refreshWindowSeconds: 604800,      // 7 days
    accessTokenExpirySeconds: 5184000, // 60 days
    isShortLived: false,
  },
  threads: {
    refreshWindowSeconds: 604800,      // 7 days
    accessTokenExpirySeconds: 5184000, // 60 days
    isShortLived: false,
  },
  linkedin: {
    refreshWindowSeconds: 604800,      // 7 days
    accessTokenExpirySeconds: 5184000, // 60 days
    isShortLived: false,
  },
};
```

---

## Platform-Specific OAuth Implementations

### 1. Facebook / Instagram

**File:** `supabase/functions/facebook-oauth/index.ts`

```typescript
// OAuth Flow
1. Action: "list_pages" - Get user's Facebook Pages
2. Action: "store_page" - Store selected Page with long-lived token
3. Auto-connects linked Instagram Business account if available

// Token Exchange
- Short-lived token → Long-lived token (60 days)
- Uses: /oauth/access_token?grant_type=fb_exchange_token

// Refresh Logic (in social-auth.ts)
async function refreshFacebookToken(account): Promise<{access_token, expires_in}> {
  // Exchange current token for new long-lived token
  const response = await fetch(
    `https://graph.facebook.com/v18.0/oauth/access_token?` +
    `grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${SECRET}&` +
    `fb_exchange_token=${account.access_token}`
  );
  return { access_token: data.access_token, expires_in: 5184000 }; // 60 days
}
```

**Secrets Required:**
- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`

---

### 2. TikTok

**File:** `supabase/functions/tiktok-oauth/index.ts`

```typescript
// OAuth Flow
1. Action: "authorize" - Generate auth URL with scopes
2. Action: "callback" - Exchange code for tokens
3. Action: "creator_info" - Fetch posting limits (REQUIRED for UI compliance)
4. Action: "refresh" - Manual refresh

// Scopes
const scope = "user.info.basic,user.info.profile,video.upload,video.publish";

// Refresh Logic
async function refreshTikTokToken(account): Promise<{access_token, refresh_token, expires_in}> {
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    body: new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });
  // TikTok rotates BOTH access_token AND refresh_token
  return { access_token, refresh_token: data.refresh_token, expires_in: 86400 };
}
```

**IMPORTANT:** TikTok rotates refresh tokens - must save the NEW refresh_token on each refresh!

**Secrets Required:**
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`

**UI Compliance Requirements:**
- Must call `creator_info` to get user's available privacy levels
- Must NOT use default privacy values
- Must show interaction toggles (Duet/Stitch) from API response
- Must check `creator_posting_blocked` before allowing posts

---

### 3. YouTube (Google)

**File:** `supabase/functions/youtube-oauth/index.ts`

```typescript
// OAuth Flow (PKCE not used, but state is HMAC-signed)
1. Action: "authorize" - Generate Google auth URL
2. GET callback - Handle redirect with code
3. Action: "refresh" - Manual refresh

// Scopes
const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/userinfo.profile",
];

// Critical: Must request offline access for refresh tokens
params.set("access_type", "offline");
params.set("prompt", "consent"); // Force consent to ensure refresh token

// Refresh Logic
async function refreshYouTubeToken(account): Promise<{access_token, expires_in}> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });
  return { access_token: data.access_token, expires_in: 3600 }; // 1 hour
}
```

**⚠️ CRITICAL ISSUE:** Google's "Testing" mode limits refresh token usage to 100 per user. After 100 refreshes, `invalid_grant` error occurs and user must reconnect. **Solution:** Get app verified by Google.

**Secrets Required:**
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

---

### 4. Twitter/X

**File:** `supabase/functions/twitter-oauth/index.ts`

```typescript
// OAuth 2.0 with PKCE
1. Action: "authorize" - Generate auth URL with code_challenge
2. GET callback - Exchange code with code_verifier
3. Action: "refresh" - Refresh using refresh_token

// PKCE Implementation
function generateCodeVerifier(): string { /* 32 random bytes */ }
async function generateCodeChallenge(verifier: string): string { /* SHA-256 hash */ }

// Scopes
const scopes = ["tweet.read", "tweet.write", "users.read", "offline.access"];

// Refresh Logic
async function refreshTwitterToken(account): Promise<{access_token, refresh_token, expires_in}> {
  const basicAuth = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const response = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basicAuth}` },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
      client_id: TWITTER_CLIENT_ID,
    }),
  });
  return { access_token, refresh_token: data.refresh_token, expires_in: 7200 };
}
```

**Secrets Required:**
- `TWITTER_CLIENT_ID`
- `TWITTER_CLIENT_SECRET`

---

### 5. LinkedIn

**File:** `supabase/functions/linkedin-oauth/index.ts`

```typescript
// OAuth 2.0 Flow
1. Action: "authorize" - Generate auth URL
2. GET callback - Exchange code
3. Action: "refresh" - Refresh token

// Scopes
const scopes = ["openid", "profile", "email", "w_member_social"];
// Optional for Company Pages (requires approval):
// "r_organization_admin", "w_organization_social"

// Refresh Logic
async function refreshLinkedInToken(account): Promise<{access_token, refresh_token, expires_in}> {
  const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
      client_id: LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_CLIENT_SECRET,
    }),
  });
  return { access_token, refresh_token, expires_in: 5184000 }; // 60 days
}
```

**Secrets Required:**
- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`

---

### 6. Pinterest

**File:** `supabase/functions/pinterest-oauth/index.ts`

```typescript
// OAuth Flow
1. Action: "authorize" - Generate auth URL
2. Action: "callback" - Exchange code
3. Action: "refresh" - Refresh token

// Scopes
const scope = "pins:read,pins:write,boards:read,boards:write,user_accounts:read";

// Refresh Logic
async function refreshPinterestToken(account): Promise<{access_token, refresh_token, expires_in}> {
  const response = await fetch('https://api.pinterest.com/v5/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });
  return { access_token, refresh_token, expires_in: 2592000 }; // 30 days
}
```

**Secrets Required:**
- `PINTEREST_CLIENT_ID`
- `PINTEREST_CLIENT_SECRET`

---

### 7. Threads

**File:** `supabase/functions/threads-oauth/index.ts`

```typescript
// OAuth Flow (Meta platform)
1. Action: "authorize" - Generate Threads auth URL
2. Action: "callback" - Exchange code, then exchange for long-lived token

// Scopes
const scopes = "threads_basic,threads_content_publish,threads_manage_insights";

// Token Exchange
// 1. Get short-lived token
// 2. Exchange for long-lived: /access_token?grant_type=th_exchange_token

// Refresh Logic
async function refreshThreadsToken(account): Promise<{access_token, expires_in}> {
  // Threads uses the current access_token to refresh (not refresh_token)
  const response = await fetch(
    `https://graph.threads.net/refresh_access_token?` +
    `grant_type=th_refresh_token&access_token=${account.access_token}`
  );
  return { access_token: data.access_token, expires_in: 5184000 }; // 60 days
}
```

**Note:** Threads uses the access_token itself to refresh, not a separate refresh_token!

**Secrets Required:**
- `THREADS_APP_ID`
- `THREADS_APP_SECRET`

---

### 8. Bluesky

**File:** `supabase/functions/bluesky-oauth/index.ts`

```typescript
// AT Protocol Session Management
// Uses JWT-based session tokens

// Refresh Logic
async function refreshBlueskyToken(account): Promise<{access_token, refresh_token, expires_in}> {
  const response = await fetch('https://bsky.social/xrpc/com.atproto.server.refreshSession', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${account.refresh_token}` },
  });
  return {
    access_token: data.accessJwt,
    refresh_token: data.refreshJwt,
    expires_in: 86400 // ~24 hours
  };
}
```

---

### 9. Reddit

**File:** `supabase/functions/reddit-oauth/index.ts`

```typescript
// OAuth Flow
1. Action: "authorize" - Generate auth URL with duration=permanent
2. Action: "callback" - Exchange code

// Scopes
const scopes = "identity submit read";

// Refresh Logic
async function refreshRedditToken(account): Promise<{access_token, refresh_token, expires_in}> {
  const credentials = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'User-Agent': 'Postora/1.0',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });
  return { access_token, refresh_token, expires_in: 3600 }; // 1 hour
}
```

**Secrets Required:**
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`

---

## Centralized Token Refresh System

**File:** `supabase/functions/refresh-tokens/index.ts`

### Modes of Operation

```typescript
// 1. Automatic Cron Refresh (triggered by pg_cron)
POST /functions/v1/refresh-tokens
Body: { "platforms": ["youtube", "twitter", "reddit", "bluesky"] }

// 2. Single Account Force Refresh (admin/user triggered)
POST /functions/v1/refresh-tokens
Body: { "accountId": "uuid", "force": true }

// 3. Bulk Force Refresh
POST /functions/v1/refresh-tokens
Body: { "accountIds": ["uuid1", "uuid2"], "force": true }
```

### Refresh Flow Logic

```typescript
for (const account of accountsNeedingRefresh) {
  // 1. Check cooldown (5 minutes between attempts)
  if (isWithinRefreshCooldown(account.last_refresh_attempt_at)) {
    results.push({ status: 'cooldown' });
    continue;
  }

  // 2. Check for missing refresh token
  if (!account.refresh_token) {
    await handleRefreshFailure(supabaseAdmin, account, 'No refresh token');
    continue;
  }

  // 3. Mark attempt timestamp (prevents concurrent refreshes)
  await markRefreshAttempt(supabaseAdmin, account.id);

  // 4. Store old refresh token for optimistic concurrency
  const oldRefreshToken = account.refresh_token;

  // 5. Platform-specific refresh
  const refreshResult = await refreshPlatformToken(account);

  // 6. Save with optimistic concurrency guard
  const { updated } = await handleRefreshSuccess(
    supabaseAdmin,
    account.id,
    oldRefreshToken,    // Guard value
    refreshResult.access_token,
    expiresAt,
    refreshResult.refresh_token  // New refresh token (if rotated)
  );

  // 7. Refresh avatar if successful
  if (updated) {
    await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
  }
}
```

### Constants

```typescript
const REFRESH_ATTEMPT_COOLDOWN_MS = 5 * 60 * 1000;    // 5 minutes
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;        // 24 hours
const MAX_FAILURES_BEFORE_REAUTH = 3;                  // Mark needs_reauth after 3 failures
const HEALTH_THRESHOLD_PERCENT = 70;                   // Send admin alert if health drops below
const HEALTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;  // 6 hours between admin alerts
```

---

## Optimistic Concurrency Guard

**Purpose:** Prevent race conditions when multiple workers (cron vs manual) try to refresh the same account simultaneously.

```typescript
async function handleRefreshSuccess(
  supabaseAdmin,
  accountId: string,
  oldRefreshToken: string | null,  // ← The guard value
  newToken: string,
  expiresAt: string,
  newRefreshToken?: string
): Promise<{ updated: boolean }> {
  const updateData = {
    access_token: newToken,
    token_expires_at: expiresAt,
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
  };

  if (newRefreshToken) {
    updateData.refresh_token = newRefreshToken;
  }

  // CRITICAL: Only update if refresh_token hasn't changed
  let query = supabaseAdmin
    .from('social_accounts')
    .update(updateData)
    .eq('id', accountId);

  // Use old refresh token as guard
  if (oldRefreshToken) {
    query = query.eq('refresh_token', oldRefreshToken);
  }

  const { data, error } = await query.select('id');

  // If no rows updated, another process already refreshed
  if (data?.length === 0 && oldRefreshToken) {
    console.log('Token already refreshed by another process');
    return { updated: false };
  }

  return { updated: true };
}
```

---

## Cron Job Configuration

### pg_cron Jobs (Configured in Supabase)

```sql
-- Short-lived tokens (every 30 minutes)
SELECT cron.schedule(
  'refresh-tokens-short',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/refresh-tokens',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{"platforms": ["twitter", "youtube", "reddit", "bluesky"]}'::jsonb
  )
  $$
);

-- Medium-lived tokens (every hour)
SELECT cron.schedule(
  'refresh-tokens-medium',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/refresh-tokens',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{"platforms": ["tiktok", "pinterest"]}'::jsonb
  )
  $$
);

-- Long-lived tokens (every 6 hours)
SELECT cron.schedule(
  'refresh-tokens-long',
  '0 */6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/refresh-tokens',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{"platforms": ["facebook", "instagram", "threads", "linkedin"]}'::jsonb
  )
  $$
);

-- History cleanup (daily)
SELECT cron.schedule(
  'cleanup-token-history',
  '0 3 * * *',
  $$
  SELECT public.cleanup_old_token_refresh_history()
  $$
);
```

---

## Error Handling & Recovery

### Permanent Auth Errors (Immediate needs_reauth)

```typescript
const PERMANENT_AUTH_ERRORS = [
  'invalid_grant',
  'Token has been expired or revoked',
  'The access token was revoked',
  'User has revoked access',
  'access_denied',
  'Authorization has been revoked',
  'Refresh token is invalid or expired',
  'refresh_token_invalid',
  'invalid_refresh_token',
  'The refresh token is invalid',
  'Refresh token has expired',
];

function isPermanentAuthError(error: string): boolean {
  return PERMANENT_AUTH_ERRORS.some(e => 
    error.toLowerCase().includes(e.toLowerCase())
  );
}
```

### Failure Escalation

```typescript
async function handleRefreshFailure(supabaseAdmin, account, errorMessage) {
  const currentFailureCount = (account.failure_count || 0) + 1;
  const isPermanentError = isPermanentAuthError(errorMessage);
  
  // Determine if needs_reauth should be set
  const needsReauth = 
    isPermanentError ||                              // Permanent error
    currentFailureCount >= MAX_FAILURES_BEFORE_REAUTH || // 3+ failures
    !account.refresh_token;                          // No refresh token

  // Update account
  await supabaseAdmin.from('social_accounts').update({
    failure_count: currentFailureCount,
    last_refresh_error: errorMessage,
    needs_reauth: needsReauth,
  }).eq('id', account.id);

  // Send alert if outside cooldown
  if (!account.alerts_snoozed && shouldSendAlert(account)) {
    await sendFailureAlert(account, errorMessage);
  }

  return { needsReauth, shouldAlert };
}
```

---

## Known Issues & Current Blockers

### 🔴 Issue #1: YouTube `invalid_grant` Errors

**Root Cause:** Google Cloud project in "Testing" mode limits refresh tokens to 100 uses per user.

**Symptoms:**
- Users get `invalid_grant` error after ~100 token refreshes
- Error message: "Token has been expired or revoked"
- Typically occurs after 1-2 weeks of use

**Current Workaround:**
- System marks account as `needs_reauth: true`
- User must reconnect their YouTube account

**Permanent Fix Required:**
- Submit app for Google OAuth verification
- Provide privacy policy, terms of service, demo video
- Typical review time: 2-4 weeks

---

### 🔴 Issue #2: TikTok UI Compliance

**Problem:** App repeatedly rejected by TikTok due to UX guidelines violations.

**Required Changes:**
1. ❌ Remove default privacy level selection
2. ❌ Remove default values for Duet/Stitch toggles
3. ✅ Fetch and display `creator_info` before showing post options
4. ✅ Show legal disclosure for commercial content
5. ✅ Require explicit user consent checkbox

**Files to Modify:**
- `src/components/post/platform-settings/TikTokSettings.tsx`
- `src/hooks/useTikTokCreatorInfo.ts`

---

### 🟡 Issue #3: Meta Business Verification

**Status:** App works but advanced permissions require Meta Business verification.

**Current Permissions:**
- ✅ `pages_show_list` - List user's pages
- ✅ `pages_manage_posts` - Post to pages

**Pending Permissions (require verification):**
- `instagram_content_publish` - Required for IG API v2
- Business verification process ongoing

---

## Key Files Reference

### Edge Functions

| File | Purpose |
|------|---------|
| `supabase/functions/facebook-oauth/index.ts` | Facebook/Instagram OAuth |
| `supabase/functions/tiktok-oauth/index.ts` | TikTok OAuth + creator_info |
| `supabase/functions/youtube-oauth/index.ts` | YouTube/Google OAuth |
| `supabase/functions/twitter-oauth/index.ts` | Twitter/X OAuth with PKCE |
| `supabase/functions/linkedin-oauth/index.ts` | LinkedIn OAuth |
| `supabase/functions/pinterest-oauth/index.ts` | Pinterest OAuth |
| `supabase/functions/threads-oauth/index.ts` | Threads OAuth |
| `supabase/functions/bluesky-oauth/index.ts` | Bluesky AT Protocol |
| `supabase/functions/reddit-oauth/index.ts` | Reddit OAuth |
| `supabase/functions/refresh-tokens/index.ts` | **Central refresh orchestration** |

### Shared Modules

| File | Purpose |
|------|---------|
| `supabase/functions/_shared/social-auth.ts` | Platform-specific refresh functions |
| `supabase/functions/_shared/tokenExpiryConstants.ts` | Token timing configuration |
| `supabase/functions/_shared/avatar-cache.ts` | Cloudinary avatar caching |
| `supabase/functions/_shared/cors.ts` | CORS header utilities |
| `supabase/functions/_shared/logging.ts` | Structured logging |

### Frontend Components

| File | Purpose |
|------|---------|
| `src/hooks/useProfileOAuth.ts` | OAuth connection hook |
| `src/components/post/platform-settings/TikTokSettings.tsx` | TikTok post settings UI |
| `src/hooks/useTikTokCreatorInfo.ts` | TikTok creator info fetcher |
| `src/lib/tokenUtils.ts` | Token status utilities |

---

## Environment Variables / Secrets

All secrets are stored in Supabase Edge Function secrets:

```
FACEBOOK_APP_ID
FACEBOOK_APP_SECRET
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
TWITTER_CLIENT_ID
TWITTER_CLIENT_SECRET
LINKEDIN_CLIENT_ID
LINKEDIN_CLIENT_SECRET
PINTEREST_CLIENT_ID
PINTEREST_CLIENT_SECRET
THREADS_APP_ID
THREADS_APP_SECRET
REDDIT_CLIENT_ID
REDDIT_CLIENT_SECRET
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
```

---

## Contact & Support

- **Project Dashboard:** https://supabase.com/dashboard/project/efruibswazzuuupgyzmf
- **Edge Function Logs:** https://supabase.com/dashboard/project/efruibswazzuuupgyzmf/functions
- **SQL Editor:** https://supabase.com/dashboard/project/efruibswazzuuupgyzmf/sql/new

---

*Document Version: 1.0*  
*Last Updated: February 2, 2026*
