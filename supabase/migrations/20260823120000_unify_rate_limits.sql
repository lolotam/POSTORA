-- Unify platform-wide rate limiting under the admin Rate Limits page.
-- Spec: docs/specs/2026-08-23-unified-rate-limits.md (R1). DML only — no schema change.
--
-- Seeds one rate_limit_settings row per platform endpoint so every limit n8n-api
-- enforces is admin-editable without an edge-function redeploy. The /api/v1/*
-- numbers become the in-memory fallback map in supabase/functions/n8n-api/rateLimitConfig.ts;
-- the two must stay in sync so a DB outage never enforces a different limit than
-- the admin page shows.
--
-- Deliberate behaviour change: the four pre-existing AI/web rows are RAISED
-- (caption 20->60, image 10->30, hashtags 30->60) and post-create is renamed to
-- "Web App Post Creation". These values are intentional and user-requested.
-- Only generate-caption and generate-image actually enforce today; the other two
-- rows are seeds for future enforcement.
--
-- Replay semantics: the DO UPDATE carries
--   WHERE rate_limit_settings.updated_at = rate_limit_settings.created_at
-- The BEFORE UPDATE trigger update_rate_limit_settings_updated_at stamps
-- updated_at on every admin edit, so a row an admin has ever edited has
-- updated_at > created_at and Postgres silently SKIPS it here instead of
-- clobbering the tuned values. A pristine row converges onto this baseline.
-- is_active is deliberately absent from the SET list: an admin's deliberate
-- disable is the one piece of state that must always survive a replay.
-- Deploy runs the pristineness check in spec §5 BEFORE applying, so a guarded
-- skip is an explicit decision rather than a silent no-op.

INSERT INTO public.rate_limit_settings (endpoint, display_name, max_requests, window_minutes) VALUES
  ('/api/v1/messages/reply', 'n8n: Message Reply', 600, 60),
  ('/api/v1/comments/reply', 'n8n: Comment Reply', 1200, 60),
  ('/api/v1/comments/hide', 'n8n: Comment Hide', 600, 60),
  ('/api/v1/comments/delete', 'n8n: Comment Delete', 300, 60),
  ('/api/v1/post', 'n8n: Post Creation', 60, 60),
  ('/api/v1/upload-media', 'n8n: Media Upload', 120, 60),
  ('/api/v1/webhooks', 'n8n: Webhooks', 60, 60),
  ('/api/v1/accounts', 'n8n: List Accounts', 300, 60),
  ('/api/v1/posts', 'n8n: List Posts', 300, 60),
  ('/api/v1/media', 'n8n: Get Media by ID', 300, 60),
  ('generate-caption', 'AI Caption Generation', 60, 60),
  ('generate-image', 'AI Image Generation', 30, 60),
  ('generate-hashtags', 'AI Hashtag Generation', 60, 60),
  ('post-create', 'Web App Post Creation', 60, 60)
ON CONFLICT (endpoint) DO UPDATE SET
  display_name   = EXCLUDED.display_name,
  max_requests   = EXCLUDED.max_requests,
  window_minutes = EXCLUDED.window_minutes
WHERE rate_limit_settings.updated_at = rate_limit_settings.created_at;
