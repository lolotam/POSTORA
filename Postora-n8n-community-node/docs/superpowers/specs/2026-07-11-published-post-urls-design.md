# Published Post URLs Design

## Goal

Make `Post -> Create` return the published URL for every completed platform result when an immediate post finishes processing.

## Current Behavior

`POST /api/v1/post` creates a post, invokes processing for immediate posts, and returns the original database object. That object is still the pre-processing record, so its status is `pending` and it has no platform results. During processing, Postora stores each platform post URL in `platform_posts`. `GET /api/v1/post/:id` exposes those records as `post.platform_results`.

## Design

For an immediate `Post -> Create` request, the node will:

1. Create the post through `POST /api/v1/post`.
2. Read the created post ID from `response.post.id`.
3. Fetch `GET /api/v1/post/:id` after the create request completes.
4. Preserve the create response fields and replace `response.post` with the fresh status response's `post` object.

This preserves compatibility for fields such as `scheduled`, `metadata_applied`, and `account_ids_used`, while adding the authoritative `post.status` and `post.platform_results` values. Each platform result contains the platform, status, social account ID, and `post_url` when the provider has one.

Scheduled posts skip the status request because they have not been published. A failed follow-up status request must not turn a successful create into an execution failure; the original create response remains available with `post_status_lookup_error` describing the lookup failure.

## Testing

Tests will cover an immediate post with multiple platform URLs, scheduled posts without a follow-up request, and a non-fatal status lookup failure. Existing create behavior remains covered by the regression suite.
