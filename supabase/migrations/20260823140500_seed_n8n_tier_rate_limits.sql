-- Seed tier_rate_limits rows for the ten /api/v1/* endpoints n8n-api serves.
-- Amendment A8. DML only — no schema change.
--
-- Every pre-existing tier_rate_limits row targets the AI endpoints
-- (generate-caption / generate-image / generate-hashtags), and AdminRateLimits
-- has no insert path, so without this seed the tier resolution step added in
-- Task 11 finds no rows for the n8n endpoints and a free-tier caller is never
-- constrained by the free tier.
--
-- Derivation of max_requests_per_hour: taken from the live rate_limit_settings
-- globals as free = 25%, pro = 2x, business = 5x, so the free tier is always
-- stricter than the global default and the paid tiers are always looser:
--
--   endpoint                global   free(25%)   pro(2x)     business(5x)
--   /api/v1/post               60        15        120          300
--   /api/v1/upload-media      120        30        240          600
--   /api/v1/posts             300        75        600         1500
--   /api/v1/accounts          300        75        600         1500
--   /api/v1/webhooks           60        15        120          300
--   /api/v1/media             300        75        600         1500
--   /api/v1/messages/reply    600       150       1200         3000
--   /api/v1/comments/reply   1200       300       2400         6000
--   /api/v1/comments/hide     600       150       1200         3000
--   /api/v1/comments/delete   300        75        600         1500
--
-- n8n-api enforces ONLY max_requests_per_hour (amendment A9): checkRateLimit
-- counts a single rolling window per request, so the daily half of a tier row
-- has no consumer for these endpoints. max_requests_per_day is stored as
-- hourly * 24 purely for parity with the AI-endpoint rows. The admin Rate
-- Limits page surfaces that note rather than implying a cap that never fires.
--
-- Replay semantics: ON CONFLICT (plan_slug, endpoint) DO NOTHING — the
-- tier_rate_limits_plan_slug_endpoint_key UNIQUE (plan_slug, endpoint)
-- constraint already exists (20260112191102_828ed5c9-4300-45af-8f04-965b726a147f.sql)
-- — so a row an admin has tuned is left alone and a replay is inert.

INSERT INTO public.tier_rate_limits
  (plan_slug, endpoint, max_requests_per_hour, max_requests_per_day, is_active)
VALUES
  -- /api/v1/post — global 60
  ('free',       '/api/v1/post',           15,   360, true),
  ('pro',        '/api/v1/post',          120,  2880, true),
  ('business',   '/api/v1/post',          300,  7200, true),
  -- /api/v1/upload-media — global 120
  ('free',       '/api/v1/upload-media',   30,   720, true),
  ('pro',        '/api/v1/upload-media',  240,  5760, true),
  ('business',   '/api/v1/upload-media',  600, 14400, true),
  -- /api/v1/posts — global 300
  ('free',       '/api/v1/posts',          75,  1800, true),
  ('pro',        '/api/v1/posts',         600, 14400, true),
  ('business',   '/api/v1/posts',        1500, 36000, true),
  -- /api/v1/accounts — global 300
  ('free',       '/api/v1/accounts',       75,  1800, true),
  ('pro',        '/api/v1/accounts',      600, 14400, true),
  ('business',   '/api/v1/accounts',     1500, 36000, true),
  -- /api/v1/webhooks — global 60
  ('free',       '/api/v1/webhooks',      15,   360, true),
  ('pro',        '/api/v1/webhooks',     120,  2880, true),
  ('business',   '/api/v1/webhooks',     300,  7200, true),
  -- /api/v1/media — global 300
  ('free',       '/api/v1/media',          75,  1800, true),
  ('pro',        '/api/v1/media',         600, 14400, true),
  ('business',   '/api/v1/media',        1500, 36000, true),
  -- /api/v1/messages/reply — global 600
  ('free',       '/api/v1/messages/reply', 150,  3600, true),
  ('pro',        '/api/v1/messages/reply', 1200, 28800, true),
  ('business',   '/api/v1/messages/reply', 3000, 72000, true),
  -- /api/v1/comments/reply — global 1200
  ('free',       '/api/v1/comments/reply', 300,  7200, true),
  ('pro',        '/api/v1/comments/reply', 2400, 57600, true),
  ('business',   '/api/v1/comments/reply', 6000, 144000, true),
  -- /api/v1/comments/hide — global 600
  ('free',       '/api/v1/comments/hide', 150,  3600, true),
  ('pro',        '/api/v1/comments/hide', 1200, 28800, true),
  ('business',   '/api/v1/comments/hide', 3000, 72000, true),
  -- /api/v1/comments/delete — global 300
  ('free',       '/api/v1/comments/delete', 75,  1800, true),
  ('pro',        '/api/v1/comments/delete', 600, 14400, true),
  ('business',   '/api/v1/comments/delete', 1500, 36000, true)
ON CONFLICT (plan_slug, endpoint) DO NOTHING;
