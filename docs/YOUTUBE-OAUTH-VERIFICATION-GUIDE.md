# YouTube OAuth Verification Guide

## Overview

This document outlines the complete process for verifying the Postora application with Google to lift the 100-refresh token limit that affects YouTube OAuth functionality.

---

## Current Status

### The Problem

When a Google Cloud project is in **"Testing"** mode:
- Only 100 refresh token grants are allowed per user
- After 100 refreshes, users receive `invalid_grant` errors
- Users must manually disconnect and reconnect their YouTube account
- This significantly impacts user experience for active publishers

### Current Configuration

| Setting | Value |
|---------|-------|
| OAuth Consent Screen Status | Testing |
| User Cap | 100 test users |
| Refresh Token Limit | 100 per user |
| Project Type | External |

### Affected Code Files

```
supabase/functions/youtube-oauth/index.ts     # Main OAuth flow
supabase/functions/_shared/social-auth.ts     # Token refresh logic
supabase/functions/refresh-tokens/index.ts    # Cron-based refresh
```

---

## Google OAuth Verification Requirements

### Prerequisites Checklist

Before submitting for verification, ensure all items are complete:

- [ ] **Privacy Policy** - Publicly accessible, mentions Google data usage
- [ ] **Terms of Service** - Publicly accessible
- [ ] **Homepage** - Verified domain ownership
- [ ] **Application Homepage URL** - Must match authorized domains
- [ ] **Support Email** - Valid, monitored email address
- [ ] **Developer Contact Email** - For Google communication
- [ ] **OAuth Consent Screen Branding** - Logo, app name configured
- [ ] **Scopes Documentation** - Justification for each scope requested

### Required URLs

| URL Type | Current Value | Requirements |
|----------|---------------|--------------|
| Homepage | `https://postora.cloud` | Must be on verified domain |
| Privacy Policy | `https://postora.cloud/privacy` | Must mention Google API data usage |
| Terms of Service | `https://postora.cloud/terms` | Must be publicly accessible |
| Support Email | `support@postora.cloud` | Must be monitored |

---

## Scopes Requested

### Current YouTube Scopes

```typescript
// From supabase/functions/youtube-oauth/index.ts (the `scopes` array in the authorize action)
const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",      // Read channel name, id, avatar (channels.list mine=true)
  "https://www.googleapis.com/auth/youtube.upload",        // Upload videos, set the thumbnail on the just-uploaded video
  "https://www.googleapis.com/auth/youtube.force-ssl",     // Read, reply to, moderate and delete comments on the user's own videos
].join(" ");
```

The `scope` field Google returns on every token response is recorded as `account_metadata.granted_scopes` on the `social_accounts` row (connect and refresh). A channel connected before `youtube.force-ssl` was requested has no such record and shows "Reconnect this channel on Profiles to enable comments" on every comment surface until it is reconnected. Composio-managed channels are not affected: Composio's Google app already holds the scope.

### Scope Justification Template

For each scope, provide justification:

| Scope | Purpose | User Benefit |
|-------|---------|--------------|
| `youtube.readonly` | Fetch channel name, avatar, and ID for account identification | Display connected channel info in dashboard |
| `youtube.upload` | Post videos and Shorts on behalf of user | Core publishing functionality |
| `youtube.force-ssl` | Manage video privacy, titles, descriptions | Allow users to customize video settings |
| `userinfo.profile` | Get user's display name | Personalize the application experience |

---

## Verification Process Steps

### Step 1: Prepare Application

1. **Domain Verification**
   - Go to [Google Search Console](https://search.google.com/search-console)
   - Add and verify `postora.cloud`
   - Add DNS TXT record or HTML file verification

2. **OAuth Consent Screen Configuration**
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Navigate to: APIs & Services → OAuth consent screen
   - Ensure all required fields are filled

3. **Branding Assets**
   - App logo: 120x120px PNG
   - App name: "Postora"
   - Authorized domains: `postora.cloud`, `supabase.co`

### Step 2: Privacy Policy Requirements

Your privacy policy MUST include:

```markdown
## Google API Data Usage

Postora uses Google APIs to provide YouTube publishing functionality.

### Data We Access
- YouTube channel information (name, ID, avatar)
- Ability to upload videos to your channel
- Video management (titles, descriptions, privacy settings)

### How We Use This Data
- Display your connected YouTube channel in the dashboard
- Publish videos and Shorts to your channel on your behalf
- Allow you to manage video settings before publishing

### Data Storage
- OAuth tokens are stored securely in our database
- Tokens are refreshed automatically to maintain connection
- We do not share your YouTube data with third parties

### Data Deletion
- You can disconnect your YouTube account at any time
- Upon disconnection, all stored tokens are deleted
- Contact support@postora.cloud for data deletion requests

### Limited Use Disclosure
Postora's use and transfer of information received from Google APIs 
adheres to Google API Services User Data Policy, including the 
Limited Use requirements.
```

### Step 3: Submit for Verification

1. **Go to OAuth Consent Screen**
   - Click "PUBLISH APP" button
   - This moves from "Testing" to "In production" (still unverified)

2. **Start Verification**
   - Click "PREPARE FOR VERIFICATION"
   - Fill out the verification form

3. **Required Information**
   - Justification for each sensitive scope
   - Video demonstration of OAuth flow
   - Screenshots of how data is used

### Step 4: Video Demonstration

Create a screen recording showing:

1. **OAuth Flow**
   - User clicks "Connect YouTube"
   - Google consent screen appears
   - User grants permissions
   - Redirect back to Postora
   - Success message displayed

2. **Data Usage**
   - Show channel info displayed in dashboard
   - Show video upload interface
   - Show privacy/settings options
   - Show where tokens are managed (account settings)

3. **Disconnection Flow**
   - User clicks "Disconnect"
   - Confirmation dialog
   - Account removed from dashboard

**Video Requirements:**
- 720p or higher resolution
- Clear narration or text overlays
- Under 5 minutes
- Upload to YouTube as unlisted

### Step 5: Security Assessment

For sensitive scopes, Google may require:

1. **Third-Party Security Assessment**
   - Only if using restricted scopes
   - Current scopes are "sensitive" not "restricted"
   - Assessment by Google-approved assessor
   - Cost: $15,000 - $75,000 (if required)

2. **Self-Assessment**
   - More likely for sensitive scopes only
   - Complete security questionnaire
   - Provide architecture documentation

---

## Verification Timeline

| Phase | Duration | Notes |
|-------|----------|-------|
| Preparation | 1-2 weeks | Docs, privacy policy, branding |
| Initial Review | 1-3 weeks | Google reviews submission |
| Clarifications | 1-2 weeks | Respond to Google questions |
| Security Review | 2-4 weeks | If required |
| Final Approval | 1 week | Verification badge issued |

**Total Estimated Time: 4-10 weeks**

---

## Interim Workarounds

While awaiting verification, implement these mitigations:

### 1. Detect `invalid_grant` Errors

```typescript
// In supabase/functions/_shared/social-auth.ts
export async function refreshYouTubeToken(accountId: string, refreshToken: string) {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data = await response.json();

    if (data.error === "invalid_grant") {
      // Mark account as needing re-authentication
      await supabase
        .from("social_accounts")
        .update({
          needs_reauth: true,
          last_refresh_error: "Token limit exceeded. Please reconnect your account.",
          failure_count: 100, // Signal permanent failure
        })
        .eq("id", accountId);

      throw new Error("REAUTH_REQUIRED");
    }

    // ... rest of refresh logic
  } catch (error) {
    // Handle error
  }
}
```

### 2. User-Facing Reconnect Prompt

```typescript
// Frontend component to show reconnect button
function YouTubeReconnectBanner({ account }) {
  if (!account.needs_reauth) return null;

  return (
    <Alert variant="warning">
      <AlertTitle>YouTube Reconnection Required</AlertTitle>
      <AlertDescription>
        Your YouTube connection needs to be refreshed. This is a temporary
        limitation while our app is being verified by Google.
      </AlertDescription>
      <Button onClick={() => handleReconnect(account.id)}>
        Reconnect YouTube
      </Button>
    </Alert>
  );
}
```

### 3. Proactive Token Monitoring

```sql
-- Query to find accounts approaching the limit
-- (based on connected_at date and refresh frequency)
SELECT 
  id,
  platform_username,
  connected_at,
  EXTRACT(DAY FROM NOW() - connected_at) as days_connected,
  -- Approximate refreshes (every 30 min = 48/day)
  EXTRACT(DAY FROM NOW() - connected_at) * 48 as estimated_refreshes
FROM social_accounts
WHERE platform = 'youtube'
  AND is_active = true
  AND NOT needs_reauth
ORDER BY connected_at ASC;
```

### 4. Reduce Refresh Frequency (Temporary)

```typescript
// In supabase/functions/_shared/tokenExpiryConstants.ts
// TEMPORARY: Reduce YouTube refresh frequency to extend token life
youtube: {
  refreshWindowSeconds: TIME_CONSTANTS.MINUTE * 10, // Reduced from 30 to 10
  accessTokenExpirySeconds: TIME_CONSTANTS.HOUR,
  isShortLived: true,
},
```

**Note:** This is a temporary measure. Tokens expire in 1 hour, so this may cause some publish failures if tokens expire between refreshes.

---

## Post-Verification Benefits

Once verified:

| Before | After |
|--------|-------|
| 100 refresh limit per user | Unlimited refreshes |
| "Unverified app" warning | Clean consent screen |
| Limited to test users | Open to all users |
| User trust concerns | Google verification badge |

---

## Google Cloud Console Checklist

### APIs & Services → OAuth consent screen

- [ ] User Type: External
- [ ] App name: Postora
- [ ] User support email: support@postora.cloud
- [ ] App logo: Uploaded (120x120px)
- [ ] Application home page: https://postora.cloud
- [ ] Application privacy policy link: https://postora.cloud/privacy
- [ ] Application terms of service link: https://postora.cloud/terms
- [ ] Authorized domains: postora.cloud
- [ ] Developer contact email: (admin email)

### APIs & Services → Credentials

- [ ] OAuth 2.0 Client ID created
- [ ] Authorized redirect URIs configured:
  - `https://api.postora.cloud/functions/v1/youtube-oauth`
- [ ] Client ID stored as `GOOGLE_CLIENT_ID` secret
- [ ] Client secret stored as `GOOGLE_CLIENT_SECRET` secret

### APIs & Services → Library

- [ ] YouTube Data API v3: Enabled
- [ ] Google+ API: Enabled (for userinfo.profile)

---

## Contact Points

| Purpose | Contact |
|---------|---------|
| Google Cloud Support | [Cloud Console Support](https://console.cloud.google.com/support) |
| OAuth Verification Team | verification-support@google.com |
| YouTube API Support | [YouTube API Forum](https://developers.google.com/youtube/community) |

---

## References

- [Google OAuth Verification Requirements](https://support.google.com/cloud/answer/9110914)
- [OAuth Brand Verification](https://support.google.com/cloud/answer/13463073)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- [YouTube Data API Overview](https://developers.google.com/youtube/v3/getting-started)
- [Limited Use Requirements](https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes)

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-02-02 | Postora Team | Initial document |

---

## Quick Start for Developers

1. **Read this guide completely** before making changes
2. **Current priority**: Implement `invalid_grant` detection and user reconnect flow
3. **Do not** reduce refresh frequency without team approval
4. **Track** all YouTube-related issues in the project tracker
5. **Test** OAuth flow changes in a separate Google Cloud project first
