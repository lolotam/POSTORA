# Postora Backend API PRD

## Product
Postora is a social media management platform backed by a self-hosted Supabase deployment. The backend surface is Supabase Edge Functions served at `/functions/v1/<function-name>`.

## Backend Scope
Test all discoverable backend endpoints from the codebase, prioritizing security boundaries, public endpoints, request validation, CORS behavior, and documented response contracts.

## Base URL
For local TestSprite execution, use `http://localhost:54321/functions/v1`. Production is documented as `https://api.postora.cloud/functions/v1`, but automated tests should not mutate production data.

## Authentication Model
- Most user-facing functions require a valid Supabase user JWT in `Authorization: Bearer <access_token>`.
- The public n8n REST API requires a Postora profile API key in `Authorization: Bearer <profiles.api_key>`.
- Admin endpoints require a valid user JWT plus an admin role.
- Cron and service endpoints require service-role or cron-secret authorization.
- Webhook endpoints are public at the gateway but validate platform signatures, verification tokens, or webhook secrets in function code.
- Public endpoints include `get-public-config` and selected password reset flows.

## Endpoint Groups
- OAuth connection functions: `facebook-oauth`, `instagram-oauth`, `instagram-business-oauth`, `threads-oauth`, `tiktok-oauth`, `youtube-oauth`, `pinterest-oauth`, `linkedin-oauth`, `twitter-oauth`, `bluesky-oauth`, `reddit-oauth`, `whatsapp-oauth`, `manage-oauth-redirects`.
- Posting and scheduling functions: `process-post`, `process-scheduled-posts`, `process-scheduled-blog-posts`, `process-scheduled-flags`, `process-scheduled-emails`, `whatsapp-scheduled-sender`.
- Media functions: `cloudinary-upload`, `cloudinary-delete`, `cloudinary-rename`, `cloudinary-email-upload`, `process-video`, `transcode-video`, `transcribe-media`, `remove-background`, `upscale-image`, `upscale-image-atlas`, `cleanup-media`, `check-music-copyright`.
- AI functions: `generate-caption`, `generate-hashtags`, `generate-image`, `suggest-best-times`, `ai-config`, `ai-email-assistant`, `analyze-log`, `test-ai-model`, `fetch-openrouter-models`, `openrouter-models`.
- Public automation API: `n8n-api` with nested REST paths for profiles, accounts, upload-media, create-post, schedule-post, posts, and post-status.
- Webhooks: `stripe-webhook`, `resend-webhook`, `whatsapp-webhook`, `tiktok-webhook`.
- Billing functions: `stripe-checkout`, `stripe-manage-subscription`, `create-payment`, `verify-payment`, `backfill-subscription`, `check-subscription`.
- Admin and observability functions: `manage-app-secrets`, `manage-cron-jobs`, `observability-alerts`, `observability-collector`, `sync-user-quotas`, `notify-admin-new-user`, `notify-expiring-ai-overrides`.
- Account security functions: `check-user-mfa`, `send-reset-otp`, `verify-reset-otp`, `verify-mfa-reset`, `send-change-password-otp`, `change-password`, `manage-backup-codes`.

## Required Test Coverage
- Every edge function should answer `OPTIONS` preflight with CORS headers.
- Public endpoints should accept valid unauthenticated requests and return documented shapes.
- Protected endpoints should reject missing, malformed, or insufficient credentials with non-success authorization responses.
- Admin endpoints should reject non-admin credentials.
- Webhook endpoints should reject invalid signatures or verification tokens without mutating state.
- JSON endpoints should reject malformed JSON and missing required fields with client errors.
- n8n API endpoints should reject missing API keys and invalid API keys.
- Nonexistent nested n8n routes should return 404.
- Public reset flows should validate email or OTP payload requirements without exposing sensitive account enumeration.

## Constraints
Happy-path tests for social posting, AI generation, billing, media transformations, and OAuth provider callbacks require seeded database state and third-party sandbox credentials. If these secrets are unavailable locally, tests should focus on authorization, validation, CORS, and safe failure behavior.
