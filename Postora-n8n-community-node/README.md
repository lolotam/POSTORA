# n8n-nodes-postora

This is an [n8n](https://n8n.io/) community node for [Postora](https://postora.cloud) — the AI-powered social media management platform.

Publish content to **Instagram, Facebook, TikTok, YouTube, Twitter/X, LinkedIn, Pinterest, Threads, Bluesky, and Reddit** directly from your n8n workflows.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

1. Go to **Settings → Community Nodes**
2. Click **Install a community node**
3. Enter `n8n-nodes-postora`
4. Click **Install**

## Operations

### Post
- **Create** — Publish content to one or more social media platforms
- **Get Status** — Check the publishing status of a post
- **List** — List recent posts with optional status filter

### Media
- **Upload** — Upload an image or video file to the Postora media library. Accepts three sources (see [Media → Upload](#media--upload) below):
  - **Binary Property** — a file from a previous n8n node
  - **URL** — download from a public web address (http/https)
  - **Media File ID** — look up & re-attach a file already in Postora (no re-upload)

### Account
- **List** — List all connected social media accounts

## Credentials

You need a Postora API key to use this node:

1. Sign up at [postora.cloud](https://postora.cloud)
2. Go to **Settings → API Keys**
3. Generate a new API key
4. In n8n, create a new **Postora API** credential and paste the key

## Usage Examples

### Schedule a Post to Instagram

1. Add a **Postora** node to your workflow.
2. Set **Resource** to `Post`.
3. Set **Operation** to `Create`.
4. Set **Platform** to `Instagram`.
5. In **Social Accounts**, select the Instagram account(s) to publish to.
6. (Optional) Set **Post Type** to `Reel` for short-form video or `Story` for ephemeral content.
7. Write your **Caption** (disabled for Stories — only media is posted).
8. Set **Media Source** to `URL` and paste a direct image or video URL (e.g. `https://example.com/photo.jpg`).
9. (Optional) Set **Schedule At** to a future date/time to publish later. Leave empty to post immediately.
10. (Optional) Expand **Additional Options** and add a **First Comment**.
11. Execute the node. Since v1.1.13, immediate posts return their completed `post` record, including one entry per account in `post.platform_results`; use each `post_url` to open the published post. Scheduled posts return before publishing, so use **Post → Get Status** after the scheduled time to retrieve their URLs. If the status lookup fails after creation, the response includes `post_status_lookup_error` and retains the created post ID for a later status check.

For example, an immediate post can return:

```json
{
  "post": {
    "id": "post-uuid",
    "status": "completed",
    "platform_results": [
      { "platform": "instagram", "status": "success", "post_url": "https://instagram.com/p/..." }
    ]
  }
}
```

### List Connected Accounts

Use this to verify your credentials work and discover which social accounts are available:

1. Add a **Postora** node to your workflow.
2. Set **Resource** to `Account`.
3. Set **Operation** to `List`.
4. Execute the node. The output lists every connected social account with its ID, name, and platform.

### Publish a YouTube Video

1. Add a **Postora** node to your workflow.
2. Set **Resource** to `Post`.
3. Set **Operation** to `Create`.
4. Set **Platform** to `YouTube`.
5. In **Social Accounts**, select the YouTube channel to publish to.
6. Write your video description in **Caption**.
7. Set **Media Source** to `URL` and paste a direct video URL.
8. Expand **Additional Options** and configure:
   - **YouTube Title** — the video title.
   - **YouTube Visibility** — `Public`, `Unlisted`, or `Private`.
   - **YouTube Category** — category ID (default: `22` for People & Blogs).
9. Execute the node.

## Platform-Specific Options

When creating a post, you can set platform-specific options:

| Platform | Options |
|----------|---------|
| YouTube | Title, Privacy (public/unlisted/private), Category ID |
| TikTok | Privacy level, Allow Comments/Duet/Stitch |
| Pinterest | Board ID, Title |
| Reddit | Subreddit, Title |

## Media → Upload

The **Media → Upload** node ingests files into your Postora media library. Choose where the files come from with the **Media Source** dropdown. Every source produces the same output shape:

```json
{ "total": 2, "uploaded": 2, "failed": 0, "results": [ { "success": true, ... }, { "success": true, ... } ] }
```

The `results` array contains one entry per input item. Each entry has `success: true|false` plus source-specific fields (`field` for binary, `url` for URL, `file_id` for Media File ID).

### Source 1 — Binary Property (n8n file)

Default. Reads one or more binary properties produced by an upstream node and uploads each as a multipart file.

- **Binary Property:** the property name(s). Default `data`. For multiple files, use comma-separated names: `data,data1,data2`.

### Source 2 — URL (download from web)

Downloads each URL on the n8n side and uploads the bytes to Postora. **SSRF hardening:** only `http`/`https` schemes; literal private/loopback/link-local/reserved IPs (IPv4 and IPv6) and well-known internal hostnames are rejected — checked on the original URL *and* on every redirect hop, before that hop is requested (up to 5 hops); 50 MB max; 30 s per-hop timeout; the response `Content-Type` must be `image/*` or `video/*`.

> **Known limit:** this checks the hostname/IP as written in the URL, not where DNS actually resolves it. A domain an attacker controls that resolves to an internal address (DNS rebinding) is not caught. If you accept media URLs from untrusted sources, treat this as defense-in-depth, not a full guarantee.

- **Media URLs:** one or more public URLs. Comma-separated, **or** use an expression returning an array:

  ```
  ={{ $json.urls }}
  ```

  Each bad URL (private host, wrong content-type, oversized, dead link) becomes a per-item failure in `results`; the node never crashes.

### Source 3 — Media File ID (look up & re-attach)

Resolves Postora media file UUID(s) you uploaded earlier and re-attaches them to this item — **no re-upload**. The node calls `GET /api/v1/media/:id` for each UUID, validates each is a well-formed UUID, and de-duplicates.

- **Media File ID(s):** one or more UUIDs. Comma-separated, **or** an expression returning an array:

  ```
  ={{ $json.file_ids }}
  ```

> **Note on `uploaded` counts for this source:** "uploaded" means *successfully resolved & attached* media items, not files re-uploaded to storage.

Invalid UUIDs, IDs you don't own, and missing IDs each become a per-item failure with a clear message. The node never crashes on bad input. If the API key is rejected (HTTP 401), the whole node fails — because auth is broken for everything.

### Backward compatibility

Workflows saved before v1.1.7 used a single **Binary Property** field (`binaryPropertyName`). Those workflows keep working unchanged: the node detects the legacy field and defaults the Media Source to **Binary Property** automatically.

## Media Source Options

When creating a post, you can attach media using one of four methods:

| Source | Description |
|--------|-------------|
| **None** | Text-only post, no media attached |
| **URL** | Provide one or more comma-separated media URLs (e.g., `https://example.com/photo1.jpg,https://example.com/photo2.jpg`) |
| **Binary Data** | Attach binary file(s) from previous nodes. Specify property names as comma-separated values (e.g., `data,data1,data2`) to upload multiple files at once |
| **Media File ID** | Reuse file(s) already uploaded via **Media → Upload**, by ID |

### Binary Data Details

To use binary data:
1. Connect a node that outputs binary data (e.g., HTTP Request, Read Binary File)
2. Select **Binary Data** as the Media Source
3. Enter the binary property name(s) — default is `data`
4. For multiple files, use comma-separated names: `data,data1,data2`

Binary files are automatically converted to base64 and sent via the `media_base64` API parameter.

### Media File ID Details

If you already uploaded file(s) with a **Media → Upload** step (e.g. earlier in the same workflow), you can post them without re-uploading:

1. Select **Media File ID** as the Media Source on the **Post → Create** node.
2. Enter the ID(s) returned by the Upload step in **Media File ID(s)**.
3. For multiple files, separate IDs with a comma: `id-1,id-2,id-3`. Wrapping them in brackets (`[id-1, id-2, id-3]`) also works — the brackets are stripped automatically.

## Troubleshooting

### "Could not find any entity of type BinaryDataFile matching..."

This error comes from n8n itself, not from this node — it means n8n can no longer find the actual file bytes for a binary field on the item you're processing.

The most common cause: the upstream node's output was **pinned** (📌) in the n8n editor while you were building the workflow. Pinning freezes the *shape* of the data, but the underlying file content lives in n8n's own storage and can be cleaned up over time (e.g. on restart, or by n8n's execution data retention settings). Once that happens, the pinned item still *looks* like it has a file attached, but reading it fails with this error.

**Fix:** unpin the upstream node (click the pin icon again to remove it) and re-run the workflow with a fresh execution before testing **Media → Upload** or **Post → Create** with binary data.

## Resources

- [Postora Website](https://postora.cloud)
- [API Documentation](https://postora.cloud/docs/api)
- [n8n Community Nodes Docs](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE.md)
