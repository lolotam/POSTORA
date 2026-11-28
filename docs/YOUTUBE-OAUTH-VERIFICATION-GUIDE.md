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
  "https://www.googleapis.com/auth/youtube.force-ssl",     // Edit published metadata, create a playlist or add a playlist item, manage comments, and list/add caption tracks on the user's own videos
].join(" ");
```

The `scope` field Google returns on every token response is recorded as `account_metadata.granted_scopes` on the `social_accounts` row (connect and refresh). A channel connected before `youtube.force-ssl` was requested has no such record and shows "Reconnect this channel on Profiles to enable comments" on every comment surface until it is reconnected. Composio-managed channels are not affected: Composio's Google app already holds the scope.

### Scope Justification Template

For each scope, provide justification:

| Scope | Purpose | User Benefit |
|-------|---------|--------------|
| `youtube.readonly` | Identify the connected channel and check connection health; browse owned uploads and full video details on `/youtube`; list the channel's own playlists (`playlists.list`) so a destination playlist can be chosen when publishing; read owner-accepted channel/video reports through YouTube Analytics API v2 on `/analytics/youtube`; read the public statistics of up to three public channels the owner names, and the public metrics of their recent public videos, on `/youtube/benchmark` (`channels.list`, `playlistItems.list`, `videos.list`) | See the correct channel, browse its content, pick one of its playlists for a new video, view on-demand analytics without Postora storing the numbers, and compare public channels side by side without Postora storing or combining their figures |
| `youtube.upload` | Upload new videos and Shorts with user-chosen metadata and set an optional custom thumbnail with `thumbnails.set`; replace the thumbnail of a video the owner already uploaded, from `/youtube`, with an owned JPEG or PNG image from the owner's own Postora media library, through the same `thumbnails.set` operation | Publish new content to the owner's channel, and correct the thumbnail of an existing video without ever replacing the video's media bytes |
| `youtube.force-ssl` | Edit published metadata with `videos.update` on `/youtube` — the title, description, tags, category and privacy (with privacy changed only on the owner's explicit confirmation) of a video the owner already uploaded, written conditionally and verified afterwards; create a new playlist on the owner's channel when explicitly requested in Create Post (`playlists.insert`) and add a newly uploaded video to an existing playlist the owner selected in Create Post (`playlistItems.insert`) — never renaming, reordering, or deleting playlists and never removing playlist items; list the caption tracks of a video the owner already uploaded (`captions.list`) and add a new caption track from an owner-supplied `.srt` or `.vtt` file (`captions.insert`) — never modifying, replacing, or deleting an existing caption track and never downloading one; read Published and Held for review comments and create top-level comments and replies (with optional creator-initiated AI reply drafting that sends the selected comment text and video title to the configured AI provider solely to populate the local reply draft without auto-sending); edit/delete the channel's own comments; publish or reject comments (moving a published comment to hold is disabled at the current baseline), with optional `banAuthor` on rejection | Correct published details, create a new playlist or file a new video under the playlist of the owner's choice, add a caption track the owner supplied, and manage/moderate discussions on owned videos |
| `userinfo.profile` | Get user's display name during Google Sign-In only, not YouTube connection | Personalize the application experience |

Postora does not replace existing video media bytes or delete videos. Published metadata editing is live (`PUBLISHED_EDIT_WRITE_ENABLED = true`) for the title, description, tags, category and privacy (with privacy changed only on the owner's explicit confirmation), and it is covered by `youtube.force-ssl`; the disclosure must say exactly that and must not claim a wider field set.

**Published metadata editing.** The owner opens an owned video on `/youtube`, clicks **Edit video details**, edits the title, the description, the tags, the category or the privacy (with an explicit confirmation checkbox required whenever privacy is changed, and privacy editing disabled when the video is scheduled on YouTube), and saves. The save is one conditional write: Postora reads the video, recomputes the revision digest, sends `videos.update` with the fresh `If-Match` ETag, and reads the same video again to confirm the saved values. A video changed in YouTube Studio while the editor was open is refused with **"YouTube changed since this was opened"** instead of being overwritten, and a lost answer is reported as unknown — never as a save, and never retried. The write is covered by `youtube.force-ssl` and gated by the server's derived `edit_metadata` capability. The limits are **10 edits per 10 minutes** and **50 edits per 24 hours** per user, on top of the project-wide **4,000-unit daily YouTube write budget**; a refused limit is shown with its wait time and nothing is written. The `If-Match` behaviour was rehearsed on a private fixture channel and is recorded in `docs/reports/2026-11-27-youtube-if-match-rehearsal.md`; the activation decision is `docs/decisions/2026-11-27-youtube-phase4a-if-match-and-edit-activation.md`.

**Thumbnails.** Postora sets a custom thumbnail on a video at upload time, and it can also replace the thumbnail of a video the owner already uploaded. The replacement happens from `/youtube`: the owner opens the video, clicks **Change thumbnail**, picks a JPEG or PNG image from their own Postora media library, and confirms the change before anything is sent. Only JPEG and PNG are accepted — WebP, GIF and videos are refused — and only an image the owner owns can be used. Setting a thumbnail never replaces the video's media bytes and never deletes the video. The write goes through the `thumbnails.set` operation and is covered by `youtube.upload` (or `youtube.force-ssl` on a connection that holds it); it is gated by its own `manage_thumbnail` capability and is independent of the published-metadata editing capability.

**Playlists.** Postora lists the playlists of the connected channel and, on the owner's explicit instruction, can create a new playlist on the channel (`playlists.insert`, capped at 5 new playlists per 24 hours per user) and add a newly uploaded video to a chosen playlist (`playlistItems.insert`). It never renames, reorders, or deletes playlists, and never removes playlist items. Listing playlists is covered by `youtube.readonly`; creating a playlist and inserting a playlist item are covered by `youtube.force-ssl`. A playlist belongs to exactly one channel, so the selector and inline creation in Create Post are disabled when more than one distinct native YouTube channel is selected for the post.

**Captions.** Postora lists the caption tracks of a video the owner already uploaded and, on the owner's instruction, adds a new caption track from a `.srt` or `.vtt` file the owner supplies — either from the video drawer on `/youtube` or when the owner attaches an `.srt` or `.vtt` caption file to a new video upload in Create Post (or attaches subtitles generated from the video's audio in Create Post, which is sent to YouTube after the video upload completes through `captions.insert` under `youtube.force-ssl`, sharing the same 512 KB UTF-8 limit and 2-uploads-per-24-hours allowance, with the caption text scrubbed from stored post metadata once publishing settles). Both operations are covered by `youtube.force-ssl` (`captions.list` and `captions.insert`). Listing is never automatic: every list costs 50 provider units, so the owner clicks **Show caption tracks** in the video drawer on `/youtube` and Postora reads the tracks only then. The upload is two steps — the owner picks the file, the language and the track name, then confirms — because the write costs 400 units and adds a public track to the video. The file is capped at 512 KB measured in UTF-8 bytes, in the browser before the request leaves the page and again on the server. Postora never modifies, replaces, or deletes an existing caption track, never downloads one, and never retries a lost answer: the owner is asked to refresh the track list instead. Downloading, replacing, deleting, and auto-translating caption tracks are out of scope.

**Public channel benchmark (Phase 6B).** Postora compares up to three **public** YouTube channels that the owner names himself on `/youtube/benchmark`. The owner types a handle (`@name`) or a channel ID (`UC…`) for each channel; Postora reads `channels.list?part=snippet,statistics,contentDetails`, then the channel's uploads playlist through `playlistItems.list?maxResults=10`, then `videos.list?part=snippet,statistics` for those uploads. All three are covered by `youtube.readonly`.

- **What is read:** only public fields of the named channels — the channel title and thumbnail, the subscriber count (or the fact that the owner hides it), the total view count, the total video count, and the view, like and comment counts of up to ten recent **public** videos. The owner's own channel is never added to the comparison and no channel the owner did not name is ever read.
- **Unit cost:** at most **3 units per channel**, so a three-channel comparison costs at most **9 units**. The cost is 1 unit when the channel is not found, 2 units when the channel has no uploads (`videos.list` is then never called), and 3 units otherwise. The project-wide budget for this feature is **300 units per Pacific day**, debited by the units actually spent, and each user is limited to **10 requests per 10 minutes** and **30 requests per 24 hours**.
- **Nothing is stored:** the response carries `Cache-Control: no-store`; no benchmark figure is written to a database, a storage bucket, a log line, or browser storage. The browser keeps the settled answers in memory only (30 minutes) and drops them when the owner signs out.
- **No aggregation across channels:** each channel is shown in its own column with its own figures, the per-recent-video averages are computed in the browser from that channel's own uploads, and Postora never combines the figures of two different channels into one score or ranking.
- **The three states are distinct:** a channel that was read, a channel YouTube says does not exist, and a channel that could not be read (quota, outage, revoked grant) are three different answers. A failure is never presented as "no channel found".

### Connect and reconnect parameters

The native authorize action requests exactly the three YouTube scope URLs above with:

```text
access_type=offline
prompt=consent select_account
```

It does **not** send `include_granted_scopes`, so an earlier unrequested grant is not silently merged into a new authorization. The account chooser and permission prompt therefore appear on connection and reconnection. Google's returned scope string is recorded in `account_metadata.granted_scopes`; missing capabilities require an explicit reconnect rather than an automatic permission expansion.

Analytics uses the existing three scopes and does not currently request `yt-analytics.readonly`. Google's OAuth permission is separate from Postora's in-app **Analytics Purpose Clause, Version 2, dated November 26, 2026**. An owner must accept that clause for the current `connection_revision` before any analytics read. Withdrawal stops subsequent reads without changing Google permissions, publishing, or comments. Disconnecting or reconnecting ends acceptance for the old connection; a trusted token refresh preserves it.

### Disconnect and revocation

For a native YouTube connection, **Profiles → Connected Accounts → Disconnect** invokes the authenticated `disconnect` action. Postora checks whether another active native connection of the same user shares the channel grant. It skips provider revocation when such a connection remains; otherwise it calls Google's RFC 7009 endpoint at `https://oauth2.googleapis.com/revoke` with the refresh token, falling back to the access token when the refresh token is absent or already invalid. Tokens travel in the form body, never the URL. An unconfirmed required revocation fails closed and leaves local credentials untouched. After the required provider step succeeds, Postora immediately clears the stored credentials and the frontend removes the connection row. Legacy Composio-managed connections are removed in Postora and can be revoked directly from Google Account Permissions. Disconnect ends analytics authorization for that connection but does not create a purpose-withdrawal event.

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
- Your uploaded videos and their full details when you browse your channel
- The playlists of your channel (playlist ID, title, privacy status) when you choose a destination playlist, and the title, optional description and privacy setting you provide when you instruct Postora to create a new playlist on your channel
- The caption tracks of a video you already uploaded when you ask Postora to list them, and the text of an .srt or .vtt caption file you choose when you upload a new caption track (including when you attach an .srt or .vtt caption file to a new video upload in Create Post, or attach subtitles generated from the video's audio in Create Post; the caption text is sent to YouTube after the video upload completes under `youtube.force-ssl` and removed from stored post metadata once publishing settles)
- Published video metadata (title, description, tags, category and privacy, with privacy changed only on your explicit confirmation) when you instruct Postora to edit it
- Ability to upload videos to your channel
- The bytes of a JPEG or PNG image from your own Postora media library when you replace the thumbnail of a video you already uploaded
- Comments on your own videos for creation, replies, editing, deletion, and moderation
- On-demand YouTube Analytics numbers after your connection-scoped in-app purpose acceptance
- The public statistics of up to three public YouTube channels you name yourself on `/youtube/benchmark`, and the public metrics of their recent public videos

### How We Use This Data
- Display your connected YouTube channel in the dashboard
- Browse your uploaded videos and their details on `/youtube`
- Publish videos and Shorts to your channel on your behalf, with an optional custom thumbnail
- Replace the thumbnail of a video you already uploaded from `/youtube`, with an owned JPEG or PNG image from your own media library, only after you pick the image and confirm the change; Postora never replaces the video's media bytes and never deletes the video
- List your channel's playlists so you can pick a destination playlist, create a new playlist on your channel when you explicitly ask in Create Post (`playlists.insert`), and add a newly uploaded video to the playlist you select; Postora never renames, reorders, or deletes playlists and never removes playlist items
- List the caption tracks of a video you already uploaded from `/youtube`, only when you ask for the list, and add a new caption track from an .srt or .vtt file you choose after you confirm the upload (or when you attach an .srt or .vtt caption file to a new video upload in Create Post, or attach subtitles generated from the video's audio in Create Post, sent to YouTube after the video upload completes under `youtube.force-ssl` and scrubbed from stored post metadata once publishing settles); Postora never modifies, replaces, or deletes existing caption tracks
- Load YouTube's embedded player in the creator's own browser when they press Play on a video. When you press Play on a video in Postora, your browser loads YouTube's embedded player from youtube-nocookie.com. Google receives the request directly from your browser under YouTube's Terms of Service and Google's Privacy Policy. Postora does not receive or store playback data.
- Edit published video metadata (title, description, tags, category and privacy, with privacy changed only on your explicit confirmation) on your instruction, without replacing video bytes or deleting videos
- Read, create, reply to, edit, delete, and moderate comments on your own videos
- Display your own channel and video analytics (summary, daily trend, top videos, viewer country, device type, traffic sources, and audience retention, with optional browser-local export to your own device) to you, the signed-in owner, only where enabled and after you accept Analytics Purpose Clause Version 2 (November 26, 2026) for the current connection; analytics numbers are read on demand and are not stored by Postora
- Compare up to three public YouTube channels that you name yourself on `/youtube/benchmark`, showing each channel's own public figures and the public metrics of its recent public videos; nothing is stored by Postora and the figures of different channels are never combined into one score

### Data Storage
- OAuth tokens are stored securely in our database
- Tokens are refreshed automatically to maintain connection
- YouTube Analytics values are read on demand for immediate display and are not stored by Postora
- Public channel benchmark figures are read on demand for immediate display, are sent with `Cache-Control: no-store`, and are not stored by Postora
- Acceptance events record the owner, channel, account reference, event type, purpose version, locale, method, request ID, timestamp, and connection revision, never analytics numbers
- We do not share your YouTube data with third parties

### Data Deletion
- You can disconnect your YouTube account through Profiles → Connected Accounts → Disconnect
- For native YouTube connections, Postora clears stored OAuth credentials immediately and revokes the Google grant when no other active connection of yours shares it (legacy Composio-managed connections are removed in Postora and can be revoked from Google Account Permissions)
- Disconnect ends analytics authorization for that connection; reconnecting requires fresh purpose acceptance
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

Create a masked screen recording of these ten journeys, using an owner-controlled test channel and synthetic identifiers wherever a denial is required:

1. **Connect:** account chooser and permission dialog with all three scopes, followed by the Postora success state.
2. **Channel and video browse:** `/youtube` channel summary, uploads paging, and full details for an owned video.
3. **Published metadata edit:** on `/youtube`, open an owned video, click **Edit video details**, change the title, the description, the tags, the category or the privacy (ticking the confirmation checkbox when changing privacy), save, and show the verified result at the same watch URL; then show the refusal path by changing the same video in YouTube Studio while the editor is open and saving again — the editor must report "YouTube changed since this was opened" and write nothing. Never replace media bytes or delete a video.
4. **New upload and thumbnail replacement:** publish a new video with chosen metadata and, optionally, a custom thumbnail; when a playlist of the same channel is selected in Create Post, show the video listed in that playlist exactly once; then, from `/youtube`, replace the thumbnail of an already uploaded video with an owned JPEG or PNG image from the media library, show the confirmation step before the write, and show the confirmed result on the video.
5. **Comments and moderation:** read Published and Held for review, create/reply/edit an own comment, and demonstrate publish and reject on a controlled or already-held comment (moving a published comment to hold is disabled at the current baseline via `STAGE4_HOLD_FROM_PUBLISHED = false`); show the separate ban confirmation only if that capability is enabled for the test account.
6. **On-demand analytics:** accept Analytics Purpose Clause Version 2 at `/analytics/youtube`, show channel/video reports, withdraw, and prove no further report loads. Reconnect later to show fresh acceptance is required.
7. **Denial:** use a synthetic foreign account/video ID and a connection with missing scope to show safe `not_found`/reconnect states with no data or write.
8. **Disconnect and reconnect:** Profiles → Connected Accounts → Disconnect, immediate local removal and provider-revocation outcome, followed by the account chooser and permission prompt on reconnect.
9. **Caption tracks:** from `/youtube`, open an owned video, click **Show caption tracks** and show that nothing was listed before the click, then upload an owner-supplied `.srt` or `.vtt` file with a language and a track name, show the explicit confirmation step before the write, and show the confirmed new track in the list; never show an existing track being edited, replaced, or deleted.
10. **Public channel benchmark:** open `/youtube/benchmark`, show that nothing was read before the click, type up to three public handles or channel IDs, click **Compare channels**, and show the three columns side by side with their own figures, the per-recent-video averages, the "Fetched at" line and the YouTube attribution line; show that a channel YouTube does not have reads "No channel found for this handle or channel ID." and that a failed lookup reads a quota or outage notice with a per-channel **Retry** and never "No channel found".

The complete actions, expected results, masking rules, and capture checklist are in `docs/reports/2026-11-26-youtube-stage6-approval-package.md`.

**Video Requirements:**
- 720p or higher resolution
- Clear narration or text overlays
- Keep the recording as concise as the ten journeys permit
- Upload to YouTube as unlisted
- Never expose tokens, cookies, client secrets, customer data, private channel identifiers, or unmasked personal information

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
- [ ] YouTube Analytics API v2: Enabled (for on-demand `reports.query`)
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
| 1.1 | 2026-11-26 | Postora Team | Stage 6: complete three-scope Stage 1–5 justifications, exact OAuth prompt, revocation/fallback, analytics purpose acceptance, and eight-journey demo package |
| 1.2 | 2026-11-27 | Postora Team | Stage 3B: playlist justifications (`playlists.list` under readonly, `playlistItems.insert` under force-ssl) and the single-channel playlist selector |
| 1.3 | 2026-11-27 | Postora Team | Stage 6A: caption justifications (`captions.list` and `captions.insert` under force-ssl), the 512 KB UTF-8 file ceiling, the explicit-upload confirmation, the nine-journey demo package, and the "no modification or deletion of existing caption tracks" wording |
| 1.4 | 2026-11-27 | Postora Team | Stage 6B & Phase 7.0 (`PR-15A`): public channel benchmark disclosure (`channels.list`, `playlistItems.list`, `videos.list` under readonly with `Cache-Control: no-store`), ten-journey demo package, Analytics Purpose Clause Version 2, and privacy-enhanced embedded player (`youtube-nocookie.com`) disclosure |

---

## Quick Start for Developers

1. **Read this guide completely** before making changes
2. **Current priority**: Implement `invalid_grant` detection and user reconnect flow
3. **Do not** reduce refresh frequency without team approval
4. **Track** all YouTube-related issues in the project tracker
5. **Test** OAuth flow changes in a separate Google Cloud project first
