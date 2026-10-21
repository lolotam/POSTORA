-- Seed admin-editable rate limits for the n8n-api routes behind the MCP tools
-- list_comments, list_messages, get_post_analytics, generate_caption,
-- generate_hashtags and generate_image. DML only, no schema change.
--
-- The numbers equal the in-memory fallback in
-- supabase/functions/n8n-api/rateLimitConfig.ts; the two must stay in sync so a
-- DB outage never enforces a different limit than the admin page shows. Until
-- this is applied the fallback is what n8n-api enforces.
--
-- Same replay guard as 20260823120000_unify_rate_limits.sql: a row an admin has
-- edited (updated_at > created_at) is skipped, and is_active is never touched.

INSERT INTO public.rate_limit_settings (endpoint, display_name, max_requests, window_minutes) VALUES
  ('/api/v1/comments', 'n8n: List Comments', 300, 60),
  ('/api/v1/messages', 'n8n: List Messages', 300, 60),
  ('/api/v1/analytics', 'n8n: Post Analytics', 120, 60),
  ('/api/v1/ai/caption', 'n8n: AI Caption', 30, 60),
  ('/api/v1/ai/hashtags', 'n8n: AI Hashtags', 30, 60),
  ('/api/v1/ai/image', 'n8n: AI Image', 10, 60)
ON CONFLICT (endpoint) DO UPDATE SET
  display_name   = EXCLUDED.display_name,
  max_requests   = EXCLUDED.max_requests,
  window_minutes = EXCLUDED.window_minutes
WHERE rate_limit_settings.updated_at = rate_limit_settings.created_at;
