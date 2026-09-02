# Postora API Integration Guide

> **Partner API v1:** For the Partner API (machine-to-machine, `x-postora-key`), see `docs/developer/` — this document describes the older user-JWT / n8n surface.

> **Complete technical reference for connecting any external website to Postora's REST API for multi-platform social media publishing.**

Use this guide to integrate your image-generating website, content tool, or any application with Postora to publish content across Facebook, Instagram, TikTok, YouTube, Pinterest, LinkedIn, and Twitter/X.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Authentication](#authentication)
3. [API Endpoints](#api-endpoints)
4. [Upload Media](#upload-media)
5. [Create Post — Complete Field Reference](#create-post)
6. [Get Accounts](#get-accounts)
7. [Get Post History](#get-post-history)
8. [Webhooks](#webhooks)
9. [Rate Limits](#rate-limits)
10. [Response Formats](#response-formats)
11. [Code Examples](#code-examples)
12. [Integration Patterns](#integration-patterns)
13. [Error Handling & Retry Logic](#error-handling)
14. [FAQ](#faq)

---

## Quick Start

### Base URL

```
https://api.postora.cloud/functions/v1/n8n-api
```

### Minimal Example — Upload Image + Publish to Instagram

```bash
# Step 1: Upload an image
curl -X POST \
  "https://api.postora.cloud/functions/v1/n8n-api/api/v1/upload-media" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"media_url": "https://example.com/my-image.jpg"}'

# Response → {"success": true, "media_file_ids": ["abc123-uuid"]}

# Step 2: Create post
curl -X POST \
  "https://api.postora.cloud/functions/v1/n8n-api/api/v1/post" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "caption": "Check out this amazing image! 🎨 #art #design",
    "platforms": ["instagram"],
    "media_file_ids": ["abc123-uuid"]
  }'
```

### Where to Find Your API Key

1. Log in to [Postora](https://postora.cloud)
2. Go to **Settings** → **API Keys**
3. Copy your API key
4. If you don't have one, click **Generate API Key**

---

## Authentication

Every request must include your API key. The API supports three authentication methods:

| Method | Header | Example |
|--------|--------|---------|
| **x-api-key** (recommended) | `x-api-key` | `x-api-key: your-api-key-here` |
| **Authorization: Apikey** | `Authorization` | `Authorization: Apikey your-api-key-here` |
| **Authorization: Bearer** | `Authorization` | `Authorization: Bearer your-api-key-here` |

**Unauthorized Response (401):**

```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing API key"
}
```

---

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/accounts` | `GET` | List connected social accounts |
| `/api/v1/upload-media` | `POST` | Upload images/videos (URL, base64, or file) |
| `/api/v1/post` | `POST` | Create and publish a post |
| `/api/v1/posts` | `GET` | Get post history with status |
| `/api/v1/webhooks` | `POST` | Register a webhook |
| `/api/v1/webhooks` | `GET` | List registered webhooks |
| `/api/v1/webhooks/:id` | `DELETE` | Remove a webhook |
| `/api/v1/webhooks/test` | `POST` | Test a webhook URL |

> **Path Normalization:** Both `/api/v1/post` and `/v1/post` are accepted. The `/api` prefix is added automatically if missing.

---

## Upload Media

### `POST /api/v1/upload-media`

Upload media files before creating a post. Supports three methods: URL, base64, and direct file upload.

### Method 1: Upload via URL (JSON)

```bash
curl -X POST \
  "BASE_URL/api/v1/upload-media" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "media_url": "https://example.com/image.jpg"
  }'
```

**Multiple URLs:**

```bash
curl -X POST \
  "BASE_URL/api/v1/upload-media" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "media_urls": [
      "https://example.com/image1.jpg",
      "https://example.com/image2.png"
    ]
  }'
```

### Method 2: Upload via Base64 (JSON)

```bash
curl -X POST \
  "BASE_URL/api/v1/upload-media" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "file_data": "data:image/png;base64,iVBORw0KGgo...",
    "file_name": "my-image.png"
  }'
```

**Multiple base64 files:**

```json
{
  "files_data": [
    "data:image/png;base64,iVBORw0KGgo...",
    "data:image/jpeg;base64,/9j/4AAQ..."
  ],
  "file_names": ["image1.png", "image2.jpg"]
}
```

### Method 3: Direct File Upload (Multipart)

```bash
curl -X POST \
  "BASE_URL/api/v1/upload-media" \
  -H "x-api-key: YOUR_API_KEY" \
  -F "file=@/path/to/image.jpg"
```

**Multiple files:**

```bash
curl -X POST \
  "BASE_URL/api/v1/upload-media" \
  -H "x-api-key: YOUR_API_KEY" \
  -F "files=@/path/to/image1.jpg" \
  -F "files=@/path/to/image2.png"
```

> Accepted field names: `file`, `files`, `file[]`, `files[]`

### Upload Media — Request Fields

| Field | Type | Description |
|-------|------|-------------|
| `media_url` | `string` | Single media URL to upload |
| `media_urls` | `string[]` | Array of media URLs to upload |
| `file_data` | `string` | Single base64-encoded file (`data:mime/type;base64,DATA`) |
| `files_data` | `string[]` | Array of base64-encoded files |
| `file_name` | `string` | Filename for single base64 upload |
| `file_names` | `string[]` | Filenames for multiple base64 uploads |

### Upload Response

```json
{
  "success": true,
  "media_files": [
    {
      "id": "abc123-uuid-here",
      "file_path": "user-id/filename.jpg",
      "file_type": "image",
      "file_size": 245000,
      "mime_type": "image/jpeg",
      "public_url": "https://res.cloudinary.com/..."
    }
  ],
  "media_file_ids": ["abc123-uuid-here"],
  "total_uploaded": 1,
  "total_failed": 0
}
```

---

## Create Post

### `POST /api/v1/post`

Create and publish a post to one or more social media platforms. This is the main endpoint with full control over every platform's settings.

### Core Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `caption` | `string` | No* | `""` | Post caption/text. *At least `caption` or `title` should be provided |
| `title` | `string` | No | — | Title/main content. Used as caption fallback for video platforms |
| `platforms` | `string[]` | **Yes** | — | Target platforms: `instagram`, `facebook`, `tiktok`, `youtube`, `pinterest`, `linkedin`, `twitter` |
| `media_file_ids` | `string[]` | No | `[]` | Media file IDs from upload-media endpoint |
| `media_url` | `string` | No | — | Single media URL (auto-uploaded before posting) |
| `media_urls` | `string[]` | No | — | Multiple media URLs (auto-uploaded before posting) |
| `media_base64` | `string \| string[]` | No | — | Base64-encoded media (auto-uploaded before posting) |
| `scheduled_at` | `string` | No | — | ISO 8601 datetime for scheduling (e.g., `2025-01-15T10:00:00Z`) |
| `scheduled_date` | `string` | No | — | Alternative field name for `scheduled_at` |
| `account_ids` | `string[]` | No | auto | Specific social account UUIDs to post to (from `/api/v1/accounts`) |
| `account_IDs` | `string[]` | No | — | Alternative casing for `account_ids` |
| `user_identifier` | `string` | No | — | Select account by username: `"myusername (instagram)"` |
| `operation` | `string` | No | `upload_photos` | Type: `upload_photos`, `upload_video`, `upload_text`, `upload_document` |
| `timezone` | `string` | No | `UTC` | Timezone for scheduling (e.g., `America/New_York`) |

> **Platforms field accepts:** JSON array `["instagram", "facebook"]`, comma-separated string `"instagram,facebook"`, or a JSON string `'["instagram"]'`.

### YouTube Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `youtube_privacy` | `string` | `"private"` | Privacy: `private`, `unlisted`, `public` |
| `youtube_title` | `string` | — | Video title |
| `youtube_description` | `string` | — | Video description |
| `youtube_tags` | `string[]` | `[]` | Tags (also accepts comma-separated string) |
| `youtube_category` | `string` | `"22"` | Category ID (22 = People & Blogs). See [YouTube categories](https://developers.google.com/youtube/v3/docs/videoCategories/list) |
| `youtube_made_for_kids` | `boolean` | `false` | Whether content is made for kids |
| `youtube_allow_embedding` | `boolean` | `true` | Allow embedding on other sites |
| `youtube_public_stats_viewable` | `boolean` | `true` | Show public view/like counts |
| `youtube_contains_synthetic_media` | `boolean` | `false` | Contains AI-generated content |
| `youtube_has_paid_product_placement` | `boolean` | `false` | Contains paid promotion |
| `youtube_notify_subscribers` | `boolean` | `true` | Notify subscribers on publish |
| `youtube_default_language` | `string` | — | Video language code (e.g., `en`) |
| `youtube_default_audio_language` | `string` | — | Audio language code |
| `youtube_license` | `string` | `"youtube"` | License: `youtube` or `creativeCommon` |
| `youtube_allowed_countries` | `string[]` | — | Whitelist country codes (ISO 3166-1) |
| `youtube_blocked_countries` | `string[]` | — | Blacklist country codes |
| `youtube_first_comment` | `string` | — | Auto-post first comment after publishing |
| `youtube_thumbnail` | `string` | — | Custom thumbnail URL |
| `youtube_recording_date` | `string` | — | Recording date (ISO 8601) |
| `youtube_video_type` | `string` | `"video"` | `video` for regular, `short` for YouTube Shorts |

### TikTok Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tiktok_post_mode` | `string` | `"DIRECT_POST"` | `DIRECT_POST` (publish) or `MEDIA_UPLOAD` (save as draft) |
| `tiktok_allow_comments` | `boolean` | `true` | Allow comments on post |
| `tiktok_allow_duet` | `boolean` | `true` | Allow Duet (video only) |
| `tiktok_allow_stitch` | `boolean` | `true` | Allow Stitch (video only) |
| `tiktok_disclosure_content` | `boolean` | `false` | Content promotes yourself ("Your brand") |
| `tiktok_brand_content` | `boolean` | `false` | Content promotes a third party ("Branded content") |

### Instagram Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `instagram_media_type` | `string` | `"feed"` | `feed` or `stories` |
| `instagram_collaborators` | `string[]` | `[]` | Collaborator usernames for co-authorship |
| `instagram_user_tags` | `string[]` | `[]` | Tag users in the post |
| `instagram_location_id` | `string` | — | Facebook Location/Page ID for geo-tagging |
| `instagram_title` | `string` | — | Override title for Instagram (falls back to `title`) |
| `instagram_alt_text` | `string` | — | Alt text for accessibility (falls back to `alt_text`) |
| `instagram_first_comment` | `string` | — | Auto-post first comment (falls back to `first_comment`) |
| `instagram_audio_name` | `string` | — | Custom audio name for Reels |
| `instagram_share_to_feed` | `boolean` | `true` | Share Reel to feed |

### Facebook Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `facebook_page_id` | `string` | — | Target Facebook Page ID (from `/api/v1/accounts`) |
| `facebook_media_type` | `string` | — | `REELS` or `STORIES` |
| `facebook_post_type` | `string` | `"feed"` | `feed`, `story`, or `reel` |
| `facebook_audience` | `string` | `"public"` | Post audience/privacy setting |
| `facebook_reel_description` | `string` | — | Description specifically for Reels |
| `facebook_first_comment` | `string` | — | Auto-post first comment |
| `facebook_link` | `string` | — | Attach a link to the post |
| `facebook_share_to_story` | `boolean` | `false` | Also share to Story |
| `facebook_location` | `string` | — | Location tag |

### Pinterest Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pinterest_board_id` | `string` | auto | Board ID to pin to. If invalid or missing, the first available board is auto-selected |
| `pinterest_title` | `string` | — | Pin title (falls back to `title`) |
| `pinterest_link` | `string` | — | Source link URL for the pin |
| `pinterest_alt_text` | `string` | — | Alt text (falls back to `alt_text`) |

> **Board Auto-Selection:** If you provide an invalid `pinterest_board_id` (e.g., a user ID instead of a board ID), Postora validates against the Pinterest API and auto-selects the first available board.

### LinkedIn Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `linkedin_page_id` | `string` | — | Organization page ID (for company pages) |
| `linkedin_article_url` | `string` | — | Share an article URL |

### Twitter/X Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `twitter_reply_to_tweet_id` | `string` | — | Tweet ID to reply to |
| `twitter_quote_tweet_id` | `string` | — | Tweet ID to quote |
| `twitter_reply_settings` | `string` | `"everyone"` | Who can reply: `everyone`, `following`, `mentionedUsers`, `subscribers`, `verified` |
| `twitter_for_super_followers_only` | `boolean` | `false` | Restrict to super followers |
| `twitter_share_with_followers` | `boolean` | `true` | Share with followers |
| `twitter_tagged_user_ids` | `string[]` | `[]` | Tag user IDs in media |
| `twitter_exclude_reply_user_ids` | `string[]` | `[]` | Exclude users from reply thread |
| `twitter_place_id` | `string` | — | Location place ID |
| `twitter_community_id` | `string` | — | Community ID to post in |
| `twitter_dm_deep_link` | `string` | — | DM deep link |
| `twitter_nullcast` | `boolean` | `false` | Don't show in timeline |
| `twitter_thumbnail_url` | `string` | — | Custom card thumbnail |
| `twitter_custom_title` | `string` | — | Custom card title |
| `twitter_thread_mode` | `boolean` | `false` | Enable thread mode (splits long text) |
| `twitter_post_as_long_tweet` | `boolean` | `false` | Post as long-form tweet |
| `twitter_poll_enabled` | `boolean` | `false` | Attach a poll |
| `twitter_poll_options` | `string[]` | — | Poll choices (2-4 options, required if `twitter_poll_enabled`) |
| `twitter_poll_duration` | `number` | `1440` | Poll duration in minutes (max 10080 = 7 days) |

### Global / Cross-Platform Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `alt_text` | `string` | — | Default alt text for all platforms (overridden by platform-specific) |
| `first_comment` | `string` | — | Default first comment for all platforms (overridden by platform-specific) |
| `webhook_url` | `string` | — | Per-request webhook URL for status callbacks |
| `webhook_secret` | `string` | — | HMAC secret for webhook signature verification |

### Async / Advanced Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `upload_async` | `boolean` | `true` | Process upload asynchronously |
| `wait_for_completion` | `boolean` | `true` | Wait for processing to complete |
| `poll_interval` | `number` | `10` | Polling interval in seconds |
| `timeout` | `number` | `600` | Timeout in seconds |

### Create Post Response

```json
{
  "success": true,
  "post": {
    "id": "post-uuid",
    "user_id": "user-uuid",
    "caption": "My caption",
    "platforms": ["instagram", "facebook"],
    "media_file_ids": ["media-uuid"],
    "status": "pending",
    "scheduled_at": null,
    "created_at": "2025-01-15T10:00:00Z"
  },
  "metadata_applied": { ... },
  "account_ids_used": ["account-uuid-1", "account-uuid-2"]
}
```

For scheduled posts, `status` will be `"scheduled"` instead of `"pending"`.

---

## Get Accounts

### `GET /api/v1/accounts`

List all connected social media accounts. Use the returned `id` values in the `account_ids` field when creating posts.

```bash
curl -X GET \
  "BASE_URL/api/v1/accounts" \
  -H "x-api-key: YOUR_API_KEY"
```

### Response

```json
{
  "success": true,
  "accounts": [
    {
      "id": "uuid-1",
      "platform": "instagram",
      "platform_username": "myaccount",
      "platform_user_id": "17841400000000",
      "avatar_url": "https://...",
      "is_active": true,
      "connected_at": "2025-01-01T00:00:00Z",
      "social_profile_id": "profile-uuid",
      "profile_name": "My Brand"
    },
    {
      "id": "uuid-2",
      "platform": "facebook",
      "platform_username": "My Page",
      "platform_user_id": "123456789",
      "avatar_url": null,
      "is_active": true,
      "connected_at": "2025-01-01T00:00:00Z",
      "social_profile_id": "profile-uuid",
      "profile_name": "My Brand"
    }
  ],
  "usage_hint": "Use the \"id\" field in the \"account_ids\" parameter when creating posts to target specific accounts"
}
```

---

## Get Post History

### `GET /api/v1/posts`

Retrieve your post history with per-platform status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | `number` | `50` | Max posts to return |
| `offset` | `number` | `0` | Pagination offset |
| `status` | `string` | — | Filter: `pending`, `processing`, `completed`, `failed`, `scheduled` |

```bash
# Get recent posts
curl "BASE_URL/api/v1/posts?limit=10" \
  -H "x-api-key: YOUR_API_KEY"

# Get only failed posts
curl "BASE_URL/api/v1/posts?status=failed" \
  -H "x-api-key: YOUR_API_KEY"
```

### Response

```json
{
  "success": true,
  "posts": [
    {
      "id": "post-uuid",
      "caption": "My post",
      "platforms": ["instagram", "facebook"],
      "status": "completed",
      "scheduled_at": null,
      "posted_at": "2025-01-15T10:01:00Z",
      "created_at": "2025-01-15T10:00:00Z",
      "platform_posts": [
        {
          "id": "pp-uuid-1",
          "platform": "instagram",
          "status": "success",
          "platform_post_url": "https://instagram.com/p/...",
          "error_message": null,
          "posted_at": "2025-01-15T10:01:00Z"
        },
        {
          "id": "pp-uuid-2",
          "platform": "facebook",
          "status": "failed",
          "platform_post_url": null,
          "error_message": "Token expired",
          "posted_at": null
        }
      ]
    }
  ],
  "limit": 10,
  "offset": 0
}
```

---

## Webhooks

Register webhooks to receive real-time notifications when post status changes.

### Register Webhook — `POST /api/v1/webhooks`

```bash
curl -X POST \
  "BASE_URL/api/v1/webhooks" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_url": "https://mysite.com/postora-webhook",
    "events": ["post.completed", "post.failed", "post.published"]
  }'
```

**Available events:** `post.completed`, `post.failed`, `post.published`, `*` (all events)

**Response:**

```json
{
  "success": true,
  "webhook": {
    "id": "webhook-uuid",
    "webhook_url": "https://mysite.com/postora-webhook",
    "events": ["post.completed", "post.failed", "post.published"],
    "status": "active"
  }
}
```

### List Webhooks — `GET /api/v1/webhooks`

```bash
curl "BASE_URL/api/v1/webhooks" -H "x-api-key: YOUR_API_KEY"
```

### Delete Webhook — `DELETE /api/v1/webhooks/:id`

```bash
curl -X DELETE "BASE_URL/api/v1/webhooks/webhook-uuid" -H "x-api-key: YOUR_API_KEY"
```

### Test Webhook — `POST /api/v1/webhooks/test`

```bash
curl -X POST \
  "BASE_URL/api/v1/webhooks/test" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhook_url": "https://mysite.com/postora-webhook"}'
```

### Webhook Payload Format

When Postora sends a webhook, your endpoint receives:

```json
{
  "event": "post.completed",
  "timestamp": "2025-01-15T10:01:00Z",
  "data": {
    "post_id": "post-uuid",
    "caption": "My post",
    "platforms": ["instagram", "facebook"],
    "status": "completed",
    "results": { ... }
  }
}
```

**Headers sent with webhook:**

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `X-Postora-Event` | Event name (e.g., `post.completed`) |
| `X-Postora-Timestamp` | ISO 8601 timestamp |

---

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/v1/post` | 30 requests | per hour |
| `POST /api/v1/upload-media` | 60 requests | per hour |
| `GET /api/v1/posts` | 100 requests | per hour |
| `GET /api/v1/accounts` | 100 requests | per hour |
| `*/api/v1/webhooks` | 30 requests | per hour |
| All other endpoints | 100 requests | per hour |

**Rate limit exceeded response (429):**

```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests. Please try again after 2025-01-15T11:00:00Z",
  "retry_after": 3600
}
```

**Headers on 429 responses:**

| Header | Description |
|--------|-------------|
| `X-RateLimit-Remaining` | Remaining requests in window |
| `X-RateLimit-Reset` | ISO timestamp when limit resets |
| `Retry-After` | Seconds until limit resets |

---

## Response Formats

### Success Responses

| Status | Meaning |
|--------|---------|
| `200` | Request successful (GET, DELETE, webhook test) |
| `201` | Resource created (POST upload-media, POST post, POST webhooks) |

### Error Responses

| Status | Meaning |
|--------|---------|
| `400` | Bad request (missing required fields, invalid data) |
| `401` | Unauthorized (invalid or missing API key) |
| `429` | Rate limit exceeded |
| `500` | Server error |

**Error format:**

```json
{
  "error": "Short error description",
  "message": "Detailed explanation",
  "hint": "How to fix it (optional)"
}
```

---

## Code Examples

### TypeScript / JavaScript — PostoraClient Class

```typescript
const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

interface PostoraAccount {
  id: string;
  platform: string;
  platform_username: string;
  platform_user_id: string;
  avatar_url: string | null;
  is_active: boolean;
  profile_name: string | null;
}

interface MediaUploadResult {
  success: boolean;
  media_file_ids: string[];
  media_files: any[];
  errors?: any[];
}

interface CreatePostResult {
  success: boolean;
  post: {
    id: string;
    caption: string;
    platforms: string[];
    status: string;
    scheduled_at: string | null;
    created_at: string;
  };
  metadata_applied: Record<string, any>;
  account_ids_used: string[] | string;
}

class PostoraClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = API_BASE;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(
        response.headers.get("Retry-After") || "60"
      );
      throw new Error(
        `Rate limited. Retry after ${retryAfter} seconds.`
      );
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data;
  }

  /** List all connected social accounts */
  async listAccounts(): Promise<{
    success: boolean;
    accounts: PostoraAccount[];
  }> {
    return this.request("/api/v1/accounts");
  }

  /** Upload media from URL(s) */
  async uploadMedia(urls: string | string[]): Promise<MediaUploadResult> {
    const body = Array.isArray(urls)
      ? { media_urls: urls }
      : { media_url: urls };
    return this.request("/api/v1/upload-media", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Upload media from base64 */
  async uploadMediaBase64(
    data: string,
    fileName?: string
  ): Promise<MediaUploadResult> {
    return this.request("/api/v1/upload-media", {
      method: "POST",
      body: JSON.stringify({
        file_data: data,
        file_name: fileName,
      }),
    });
  }

  /** Create and publish a post */
  async createPost(options: {
    caption: string;
    platforms: string[];
    media_file_ids?: string[];
    media_url?: string;
    scheduled_at?: string;
    account_ids?: string[];

    // YouTube
    youtube_privacy?: "private" | "unlisted" | "public";
    youtube_title?: string;
    youtube_description?: string;
    youtube_tags?: string[];
    youtube_category?: string;
    youtube_video_type?: "video" | "short";
    youtube_thumbnail?: string;
    youtube_made_for_kids?: boolean;

    // TikTok
    tiktok_post_mode?: "DIRECT_POST" | "MEDIA_UPLOAD";
    tiktok_allow_comments?: boolean;
    tiktok_allow_duet?: boolean;
    tiktok_allow_stitch?: boolean;

    // Instagram
    instagram_media_type?: "feed" | "stories";
    instagram_collaborators?: string[];
    instagram_share_to_feed?: boolean;

    // Facebook
    facebook_page_id?: string;
    facebook_post_type?: "feed" | "story" | "reel";

    // Pinterest
    pinterest_board_id?: string;
    pinterest_title?: string;
    pinterest_link?: string;

    // LinkedIn
    linkedin_page_id?: string;

    // Twitter
    twitter_thread_mode?: boolean;
    twitter_poll_enabled?: boolean;
    twitter_poll_options?: string[];
    twitter_poll_duration?: number;

    // Extras
    [key: string]: any;
  }): Promise<CreatePostResult> {
    return this.request("/api/v1/post", {
      method: "POST",
      body: JSON.stringify(options),
    });
  }

  /** Get post history */
  async getPosts(options?: {
    limit?: number;
    offset?: number;
    status?: string;
  }): Promise<{ success: boolean; posts: any[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    if (options?.status) params.set("status", options.status);
    const qs = params.toString();
    return this.request(`/api/v1/posts${qs ? "?" + qs : ""}`);
  }

  /** Register a webhook */
  async registerWebhook(
    webhookUrl: string,
    events?: string[]
  ): Promise<any> {
    return this.request("/api/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({
        webhook_url: webhookUrl,
        events: events || [
          "post.completed",
          "post.failed",
          "post.published",
        ],
      }),
    });
  }
}

export { PostoraClient };
```

### Usage Example — Complete Workflow

```typescript
const postora = new PostoraClient("your-api-key-here");

// 1. Check connected accounts
const { accounts } = await postora.listAccounts();
console.log("Connected accounts:", accounts);

const igAccount = accounts.find((a) => a.platform === "instagram");
const fbAccount = accounts.find((a) => a.platform === "facebook");

// 2. Upload your generated image
const { media_file_ids } = await postora.uploadMedia(
  "https://mysite.com/generated-image.jpg"
);

// 3. Publish to Instagram + Facebook with full control
const result = await postora.createPost({
  caption: "AI-generated masterpiece! 🎨 #AIArt #Design",
  platforms: ["instagram", "facebook"],
  media_file_ids,
  account_ids: [igAccount!.id, fbAccount!.id],

  // Instagram-specific
  instagram_collaborators: ["collab_user"],
  instagram_share_to_feed: true,

  // Facebook-specific
  facebook_page_id: fbAccount!.platform_user_id,
  facebook_post_type: "feed",
});

console.log("Post created:", result.post.id);
console.log("Status:", result.post.status);
```

### Schedule a Post for Later

```typescript
const result = await postora.createPost({
  caption: "Scheduled content 📅",
  platforms: ["instagram", "twitter"],
  media_file_ids: ["media-uuid"],
  scheduled_at: "2025-02-01T14:00:00Z",
  timezone: "America/New_York",
});

// result.post.status === "scheduled"
```

### Python Example

```python
import requests
import json

API_BASE = "https://api.postora.cloud/functions/v1/n8n-api"
API_KEY = "your-api-key-here"

headers = {
    "x-api-key": API_KEY,
    "Content-Type": "application/json"
}

# Upload media
upload_resp = requests.post(
    f"{API_BASE}/api/v1/upload-media",
    headers=headers,
    json={"media_url": "https://example.com/image.jpg"}
)
media_ids = upload_resp.json()["media_file_ids"]

# Create post
post_resp = requests.post(
    f"{API_BASE}/api/v1/post",
    headers=headers,
    json={
        "caption": "Posted from Python! 🐍",
        "platforms": ["instagram", "facebook", "twitter"],
        "media_file_ids": media_ids,
        "instagram_share_to_feed": True,
        "facebook_post_type": "feed"
    }
)

result = post_resp.json()
print(f"Post ID: {result['post']['id']}")
print(f"Status: {result['post']['status']}")
```

### cURL — Full Multi-Platform Post

```bash
# Upload image
UPLOAD_RESPONSE=$(curl -s -X POST \
  "${API_BASE}/api/v1/upload-media" \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"media_url": "https://example.com/video.mp4"}')

MEDIA_ID=$(echo $UPLOAD_RESPONSE | jq -r '.media_file_ids[0]')

# Create multi-platform post with full settings
curl -X POST \
  "${API_BASE}/api/v1/post" \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"caption\": \"Amazing content! 🎉\",
    \"platforms\": [\"instagram\", \"facebook\", \"tiktok\", \"youtube\", \"pinterest\"],
    \"media_file_ids\": [\"${MEDIA_ID}\"],

    \"youtube_privacy\": \"public\",
    \"youtube_title\": \"My Latest Video\",
    \"youtube_description\": \"Full description here\",
    \"youtube_tags\": [\"tutorial\", \"howto\"],
    \"youtube_video_type\": \"video\",

    \"tiktok_post_mode\": \"DIRECT_POST\",
    \"tiktok_allow_comments\": true,

    \"instagram_share_to_feed\": true,

    \"pinterest_title\": \"Check This Out\",

    \"facebook_post_type\": \"feed\"
  }"
```

---

## Integration Patterns

### Pattern 1: "Send to Postora" Button

Add a button to your image-generating website that sends content directly to Postora:

```typescript
async function sendToPostora(imageUrl: string, caption: string) {
  const postora = new PostoraClient(userApiKey);

  // Upload the generated image
  const { media_file_ids } = await postora.uploadMedia(imageUrl);

  // Create a post (user controls platform selection in Postora dashboard)
  const result = await postora.createPost({
    caption,
    platforms: ["instagram", "facebook"], // or let user choose
    media_file_ids,
  });

  return result;
}
```

### Pattern 2: Scheduled Batch Posting

Queue up multiple posts for different times:

```typescript
const images = [
  { url: "https://...", caption: "Monday motivation 💪" },
  { url: "https://...", caption: "Tuesday tips 📝" },
  { url: "https://...", caption: "Wednesday wisdom 🧠" },
];

for (let i = 0; i < images.length; i++) {
  const { media_file_ids } = await postora.uploadMedia(images[i].url);

  const scheduledDate = new Date();
  scheduledDate.setDate(scheduledDate.getDate() + i);
  scheduledDate.setHours(10, 0, 0, 0);

  await postora.createPost({
    caption: images[i].caption,
    platforms: ["instagram", "twitter"],
    media_file_ids,
    scheduled_at: scheduledDate.toISOString(),
  });
}
```

### Pattern 3: Webhook-Based Status Tracking

```typescript
// 1. Register webhook (one-time setup)
await postora.registerWebhook("https://mysite.com/api/postora-status", [
  "post.completed",
  "post.failed",
]);

// 2. Your webhook handler (Express/Node.js example)
app.post("/api/postora-status", (req, res) => {
  const { event, data } = req.body;

  if (event === "post.completed") {
    console.log(`Post ${data.post_id} published successfully!`);
    // Update your UI, notify user, etc.
  }

  if (event === "post.failed") {
    console.error(`Post ${data.post_id} failed:`, data);
    // Alert user, retry, etc.
  }

  res.status(200).json({ received: true });
});
```

---

## Error Handling

### Retry Logic with Exponential Backoff

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt === maxRetries) throw error;

      // Don't retry 400/401 errors
      if (
        error.message.includes("400") ||
        error.message.includes("401")
      ) {
        throw error;
      }

      // Handle rate limiting
      if (error.message.includes("Rate limited")) {
        const match = error.message.match(/(\d+) seconds/);
        const waitSeconds = match ? parseInt(match[1]) : 60;
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        continue;
      }

      // Exponential backoff for other errors
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Max retries exceeded");
}

// Usage
const result = await withRetry(() =>
  postora.createPost({
    caption: "Retry-safe post",
    platforms: ["instagram"],
    media_file_ids: ["media-uuid"],
  })
);
```

### Common Error Scenarios

| Error | Cause | Solution |
|-------|-------|----------|
| `platforms array is required` | Missing or empty `platforms` | Always include at least one platform |
| `No valid account IDs found` | Wrong `account_ids` values | Use `GET /api/v1/accounts` to get correct IDs |
| `No account provided for platforms: X` | `account_ids` doesn't cover all platforms | Add accounts for missing platforms or remove from `platforms` array |
| `Rate limit exceeded` | Too many requests | Wait for `retry_after` seconds, then retry |
| `Failed to upload media` | Invalid URL or unsupported format | Verify URLs are publicly accessible, use supported formats (jpg, png, mp4, etc.) |
| `Invalid base64 data format` | Wrong base64 encoding | Use format: `data:mime/type;base64,DATA` |

---

## ⚠️ Important: Media Requirements & Known Limitations

### Media is Required for Most Platforms

If you call `POST /api/v1/post` without providing any media (`media_file_ids`, `media_url`, `media_urls`, or `media_base64`), the post will be created with **empty media**. Most platforms (Instagram, TikTok, Pinterest, YouTube) **require media** and will reject the post.

**Always provide media** using one of these methods:

```json
// Option A: Pre-upload, then reference by ID (RECOMMENDED)
{
  "caption": "My post",
  "platforms": ["instagram"],
  "media_file_ids": ["abc123-uuid-from-upload-media"]
}

// Option B: Pass URL directly (auto-uploaded by Postora)
{
  "caption": "My post",
  "platforms": ["instagram"],
  "media_url": "https://example.com/image.jpg"
}

// Option C: Pass base64 directly (auto-uploaded by Postora)
{
  "caption": "My post",
  "platforms": ["instagram"],
  "media_base64": "data:image/png;base64,iVBORw0KGgo..."
}
```

### Known Issue: Some Platforms Reject CDN URLs

Some social media platforms (Facebook, Instagram, TikTok) may reject direct Cloudinary or third-party CDN URLs when passed as media. This happens because:

- **Platform URL validation**: Some APIs only accept URLs from whitelisted domains
- **URL redirects**: CDN URLs with redirects or query parameters may be rejected
- **Expiring URLs**: Signed or time-limited URLs may expire before the platform fetches them

**Recommended Workaround:**

1. **Use the two-step flow** (upload first, then post):
   - Call `POST /api/v1/upload-media` with your image URL or base64 data
   - Use the returned `media_file_ids` in your post request
   - Postora handles the server-side binary upload to each platform

2. **Ensure URLs are publicly accessible**: If using `media_url`, make sure the URL:
   - Does NOT require authentication headers
   - Does NOT redirect (use the final URL)
   - Does NOT expire within 5 minutes
   - Returns proper `Content-Type` headers

3. **Prefer base64 for generated images**: If your website generates images programmatically, sending `media_base64` avoids all URL-related issues:

```typescript
// From your image-generating website:
const imageBase64 = canvas.toDataURL("image/png"); // or from your API

const response = await fetch(`${POSTORA_BASE_URL}/api/v1/post`, {
  method: "POST",
  headers: {
    "x-api-key": API_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    caption: generatedCaption,
    platforms: ["instagram", "facebook"],
    media_base64: imageBase64, // Direct binary — no URL issues
  }),
});
```

### Debugging Empty Media Posts

If your posts are failing with empty media, check the following:

| Symptom | Cause | Fix |
|---------|-------|-----|
| `media_file_ids: []` in post | No media provided in request | Add `media_url`, `media_urls`, `media_base64`, or `media_file_ids` |
| Upload succeeds but post fails | Platform rejected the media URL | Use the two-step upload flow or send base64 directly |
| `"Failed to upload media"` error | URL is not publicly accessible | Ensure URL has no auth, no redirects, and correct CORS |
| Media uploads but post shows no image | `media_file_ids` not included in post request | Use the IDs returned from `/api/v1/upload-media` |

### Complete Safe Flow (Recommended)

```typescript
// Step 1: Upload media first
const uploadRes = await fetch(`${BASE_URL}/api/v1/upload-media`, {
  method: "POST",
  headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    media_url: "https://your-site.com/generated-image.png",
  }),
});
const uploadData = await uploadRes.json();

if (!uploadData.success || !uploadData.media_file_ids?.length) {
  throw new Error("Media upload failed: " + JSON.stringify(uploadData));
}

// Step 2: Create post with uploaded media IDs
const postRes = await fetch(`${BASE_URL}/api/v1/post`, {
  method: "POST",
  headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    caption: "My generated content 🎨",
    platforms: ["instagram", "facebook"],
    media_file_ids: uploadData.media_file_ids, // ✅ Always include this
  }),
});
const postData = await postRes.json();
console.log("Post created:", postData);
```

---

## FAQ

### Can I post without uploading media first?

Yes. You can pass `media_url` or `media_urls` directly in the `POST /api/v1/post` body. Postora will auto-upload them before posting. However, the **recommended approach** is the two-step flow (upload first → post with IDs) to avoid platform URL rejection issues.

```json
{
  "caption": "Direct URL posting",
  "platforms": ["instagram"],
  "media_url": "https://example.com/image.jpg"
}
```

### How do I post to a specific Facebook Page?

Use the `facebook_page_id` field with the page's `platform_user_id` from `/api/v1/accounts`:

```json
{
  "platforms": ["facebook"],
  "facebook_page_id": "123456789",
  "caption": "Page post"
}
```

### How do I post YouTube Shorts?

Set `youtube_video_type` to `"short"`:

```json
{
  "platforms": ["youtube"],
  "youtube_video_type": "short",
  "youtube_title": "My Short",
  "media_file_ids": ["video-uuid"]
}
```

### Can I select accounts by username instead of UUID?

Yes. Use the `user_identifier` field with format `"username (platform)"`:

```json
{
  "platforms": ["instagram"],
  "user_identifier": "myaccount (instagram)",
  "caption": "Posted to specific account"
}
```

### What content types are accepted for uploads?

The API accepts `application/json`, `application/x-www-form-urlencoded`, and `multipart/form-data`. All three are fully parsed with array and boolean field handling.

### What media formats are supported?

**Images:** JPEG, PNG, GIF, WebP  
**Videos:** MP4, MOV, WebM, AVI, MPEG

---

## Support

- **Dashboard:** [https://postora.cloud](https://postora.cloud)
- **API Base URL:** `https://api.postora.cloud/functions/v1/n8n-api`
- **Contact:** Support available through the Postora dashboard
