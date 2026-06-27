## Root cause

The Threads publish path in `supabase/functions/process-post/index.ts` (lines ~5486-5490) sends the wrong field names to Meta when the user checks "Share to Instagram Story":

```ts
containerParams.crosspost_to_instagram = "true";
containerParams.crosspost_to_instagram_dark_mode = "true";
```

Meta's Threads Graph API (`POST /{threads-user-id}/threads`) expects:

```
crossreshare_to_ig=true
crossreshare_to_ig_dark_mode=true
```

(Yes, "crossreshare" — that is Meta's actual spelling.) Confirmed by:
- Meta docs: https://developers.facebook.com/docs/threads/reference/publishing/
- meta-mcp PR #152 ("feat: cross-share Threads posts to Instagram Stories") which forwards exactly `crossreshare_to_ig` / `crossreshare_to_ig_dark_mode`.
- Our own `supabase/functions/threads-debug-publish-check/index.ts` already uses the correct name `crossreshare_to_ig` in its sample payload — so the debug panel and the real publisher disagree, and the real publisher is wrong.

Because `crosspost_to_instagram` is not a recognized parameter, Meta accepts the request, publishes the Thread, and silently drops the cross-share — exactly the symptom you described: "publishes to Threads only, no IG Story", despite the `threads_share_to_instagram` permission and test user being correctly set up.

## Changes

### 1. `supabase/functions/process-post/index.ts` (~lines 5486-5490)
Rename the two container params:

- `crosspost_to_instagram` → `crossreshare_to_ig`
- `crosspost_to_instagram_dark_mode` → `crossreshare_to_ig_dark_mode`

Keep the existing pre-flight guard (capability check, video-block, warnings) unchanged.

### 2. Capture Meta's cross-share result for diagnostics
After publish, Meta returns `crossreshare_to_ig_status` (`"SUCCESS"` or `"FAILED"`) on the published media. When `wantsCrossShare` is true, fetch this field on the published thread id and:
- log it in the verbose Threads log line,
- include it in the existing `cross_share` block of the platform response (alongside `attempted`, `capability_at_publish`, `dark_mode`) so the History/Debug surface can show whether Meta actually delivered the Story.

If the field cannot be fetched (e.g. transient error), record `status: "unknown"` — never fail the post.

### 3. No DB, env, or frontend changes
- Frontend toggle, settings persistence (`threads_cross_share_to_ig` / `_dark_mode`), and capability gating stay as-is.
- No new secrets, no schema migration.

## Validation

- Unit/regression: add a small test asserting that when `metadata.threads_cross_share_to_ig === true` and capability is not `false` and media is not video, the outgoing `containerParams` includes `crossreshare_to_ig: "true"` (and `_dark_mode` when requested), and does NOT include the legacy `crosspost_to_instagram` keys.
- Manual on VPS after edge deploy:
  1. With a test user that has `threads_share_to_instagram` granted and IG linked in Accounts Center, publish a text or image post from Postora with the "Share to Instagram Story" toggle on.
  2. Confirm the platform response now contains `cross_share.status: "SUCCESS"` and the Story appears in the linked IG account within a few seconds.
  3. Repeat with dark mode on; confirm `crossreshare_to_ig_dark_mode=true` is sent (verbose log) and the Story uses dark styling.

## Deployment (self-hosted)

Edge function only — sync `supabase/functions/process-post/index.ts` to the self-hosted functions volume and restart the functions container:

```
docker compose up -d --no-deps functions
```

No SQL, no .env changes, no provider-console changes.

## Out of scope

- Re-enabling cross-share for video/carousel (Meta PR #152 shows it's now allowed for all four types, but lifting the current video guard is a separate decision and not what's blocking you today).
- Changing the capability probe / OAuth scopes.
- Updating `threads-debug-publish-check` (already correct).

## Final status target
`completed_requires_server_sync` — code fix only; needs the functions volume sync + container restart on the VPS.
