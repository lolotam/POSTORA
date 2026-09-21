-- Clears avatar URLs pointing at the disabled Cloudinary cloud.
--
-- `dur1soa8n` is deactivated: every object under it answers 401. Those URLs sit
-- in `social_accounts.avatar_url` and `profiles.avatar_url` and are requested on
-- every render, so each one is a failed image request in the browser console and
-- a generic glyph on screen.
--
-- The backfill in PR #187 re-hosted what it could. What remains cannot be
-- repaired from here: the platform tokens are expired or revoked (Threads
-- reports the user changed their password, Instagram's sessions expired in
-- July, Facebook returns subcode 458 "user has not authorized application"), so
-- there is no live source to re-fetch from. Reconnecting an account rewrites
-- this column through Openinary, which is the real repair.
--
-- Until then, holding a URL that is known to 401 is worse than holding none:
-- every avatar component already falls back to a platform glyph on an empty
-- value, and does so without issuing a request. This clears the dead value so
-- the fallback happens quietly.
--
-- Scoped to the specific disabled cloud rather than to res.cloudinary.com
-- generally, so a future working Cloudinary account is unaffected.

DO $$
DECLARE
  cleared_accounts integer;
  cleared_profiles integer;
BEGIN
  UPDATE social_accounts
  SET avatar_url = NULL
  WHERE avatar_url LIKE '%res.cloudinary.com/dur1soa8n/%';
  GET DIAGNOSTICS cleared_accounts = ROW_COUNT;

  UPDATE profiles
  SET avatar_url = NULL
  WHERE avatar_url LIKE '%res.cloudinary.com/dur1soa8n/%';
  GET DIAGNOSTICS cleared_profiles = ROW_COUNT;

  RAISE NOTICE 'Cleared dead Cloudinary avatars: % social_accounts, % profiles.',
               cleared_accounts, cleared_profiles;
END $$;
