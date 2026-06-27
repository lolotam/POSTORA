## Goal
Fix Instagram inbox and comment fetching after reauthentication, without changing unrelated features.

## What I found
Meta now has two different Instagram API paths:

1. **Instagram API with Instagram Login**
   - Host: `graph.instagram.com`
   - Token: Instagram User access token
   - Permissions: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`

2. **Instagram API with Facebook Login**
   - Host: `graph.facebook.com`
   - Token: Facebook Page/User token depending on endpoint
   - Permissions: `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `pages_read_engagement`, and sometimes `pages_messaging`

The app already requests the right Direct Instagram scopes in `instagram-oauth`, but the inbox and comment APIs still treat Instagram mostly like the Facebook/Page flow:

- `messaging-api` routes Instagram inbox through `graph.facebook.com/{pageId}/conversations`.
- `comment-manager` routes Instagram comments through `graph.facebook.com/{ig_user_id}/media`.
- If the user reconnects with **Connect Instagram Directly**, the saved token is an Instagram token, so those Facebook-host Graph calls can return empty data or permission errors.

This matches your report: permissions are granted, SQL is done, app reauthenticated, but inbox/comments still do not show.

## Implementation plan

### 1. Make the backend detect the Instagram auth type
Use `social_accounts.ig_auth_type` / `account_metadata.flow` / `account_metadata.token_type` to distinguish:

- `business_login` / `direct` / `long_lived` → use `graph.instagram.com`
- `facebook_business` / `page_token` → use existing Facebook Page flow

### 2. Fix Instagram Direct inbox fetching
Update `supabase/functions/messaging-api/index.ts`:

- For Direct Instagram accounts, call:
  - `https://graph.instagram.com/<version>/<ig_user_id>/conversations?platform=instagram...`
- Keep the existing Facebook Page flow for Facebook Business-connected IG accounts.
- Return structured errors for:
  - missing `instagram_business_manage_messages`
  - expired token
  - unsupported/non-professional account
- Keep the UI reconnect banner behavior.

### 3. Fix Instagram Direct message details
Update message retrieval in `messaging-api`:

- For Direct Instagram accounts, fetch conversation messages through the Instagram host.
- Keep Facebook/WhatsApp message behavior unchanged.

### 4. Fix Instagram Direct comment fetching
Update `supabase/functions/comment-manager/index.ts`:

- For Direct Instagram accounts, call `graph.instagram.com` with the Instagram token.
- For Facebook Business-connected IG accounts, keep `graph.facebook.com`.
- Preserve fetching of:
  - media caption/type/permalink/timestamp
  - `like_count`
  - `comments_count`
  - comments
  - replies
- Add pagination-safe fetching for media/comments where possible.

### 5. Improve frontend error visibility
Update the Instagram inbox/comment UI only enough to stop silent failures:

- Show a clear reconnect/permission banner when backend returns a structured missing-scope or expired-token response.
- Show a helpful “no conversations/comments returned by Meta” empty state when the API succeeds but returns no data.
- Do not change Facebook or WhatsApp UI behavior.

### 6. Validate locally
Run TypeScript validation and inspect the changed API paths for compatibility.

### 7. Manual deployment notes
Because this is self-hosted Supabase, code changes to edge functions will still require manual deployment/sync to the production functions volume and restarting only the functions container. I will include exact deployment notes after implementation.

## Expected result
After deploying the updated edge functions and reconnecting Instagram Direct once, Instagram inbox and comments should load through the correct `graph.instagram.com` endpoints. Facebook Business-connected Instagram accounts should continue using the existing Facebook/Page Graph flow.