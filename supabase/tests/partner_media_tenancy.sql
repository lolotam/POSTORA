-- Phase 4 (D10 R3): does media_files' composite FK actually make a
-- cross-workspace attribution unrepresentable, or does it only look like it?
--
-- Four properties, and the last two are the ones a catalog check alone would
-- miss:
--   1. workspace A's media attributed to workspace B's key is REFUSED
--   2. the same key with its OWN workspace is ACCEPTED -- without this, a
--      constraint that refused everything would pass property 1
--   3. deleting the key nulls ONLY created_by_key_id. Without the column list
--      on ON DELETE SET NULL, workspace_id goes too and credential rotation
--      silently orphans the media out of its own workspace -- data loss
--      dressed as a foreign key
--   4. a legacy row with no workspace still inserts, or the migration was not
--      additive after all
\set ON_ERROR_STOP on

-- Catalog first: the constraint, its ON DELETE action, and the bucket.
SELECT 'constraint: ' || pg_get_constraintdef(oid)
FROM pg_constraint WHERE conname = 'media_files_created_by_key_in_workspace';

SELECT 'bucket: ' || id || ' public=' || public::text
FROM storage.buckets WHERE id = 'partner-media';

SELECT 'index: ' || indexname FROM pg_indexes
WHERE indexname = 'media_files_workspace_created_idx';

-- Two workspaces, each with an owner and a key.
DO $$
DECLARE
  ws_a UUID; ws_b UUID; user_a UUID; user_b UUID; key_b UUID;
  -- Fixture identifiers are unique per run. social_accounts is unique on
  -- (user_id, platform, platform_user_id) and partner_api_keys on key_hash, so
  -- fixed literals make this suite runnable exactly once -- and a suite nobody
  -- can re-run is a suite nobody re-runs while debugging it.
  nonce TEXT := replace(gen_random_uuid()::text, '-', '');
BEGIN
  SELECT id INTO user_a FROM auth.users LIMIT 1;
  IF user_a IS NULL THEN RAISE EXCEPTION 'harness seeds one auth.users row; none found'; END IF;
  user_b := user_a;

  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('ws-a', user_a, false) RETURNING id INTO ws_a;
  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('ws-b', user_b, false) RETURNING id INTO ws_b;

  -- A key that belongs to workspace B. social_account_id is NOT NULL and
  -- carries its own composite FK, so give B a real account first.
  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (user_b, ws_b, 'whatsapp', 'phone-b-' || nonce, 'tok', true);

  INSERT INTO public.partner_api_keys
    (workspace_id, social_account_id, key_hash, key_prefix, name, scopes)
  SELECT ws_b, id, 'hash-b-' || nonce, 'pk_live_bbbb', 'key-b', ARRAY['media:write']
  FROM public.social_accounts WHERE workspace_id = ws_b LIMIT 1
  RETURNING id INTO key_b;

  -- THE TEST: workspace A's media, attributed to workspace B's key.
  BEGIN
    INSERT INTO public.media_files
      (user_id, workspace_id, created_by_key_id, file_path, file_type, storage_bucket)
    VALUES (user_a, ws_a, key_b, 'a/' || nonce || '.jpg', 'image', 'partner-media');
    RAISE EXCEPTION 'FAIL: a cross-workspace attribution was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: cross-workspace attribution refused by the composite FK';
  END;

  -- The same key with its OWN workspace must still work, or the constraint is
  -- refusing everything rather than refusing the wrong thing.
  INSERT INTO public.media_files
    (user_id, workspace_id, created_by_key_id, file_path, file_type, storage_bucket)
  VALUES (user_b, ws_b, key_b, 'b/' || nonce || '.jpg', 'image', 'partner-media');
  RAISE NOTICE 'PASS: same-workspace attribution accepted';

  -- Deleting the key must null ONLY created_by_key_id. If workspace_id goes
  -- too, credential rotation silently orphans the media out of its workspace.
  DELETE FROM public.partner_api_keys WHERE id = key_b;
  IF EXISTS (
    SELECT 1 FROM public.media_files
    WHERE file_path = 'b/' || nonce || '.jpg' AND workspace_id = ws_b AND created_by_key_id IS NULL
  ) THEN
    RAISE NOTICE 'PASS: key deletion cleared attribution and KEPT ownership';
  ELSE
    RAISE EXCEPTION 'FAIL: deleting the key did not leave workspace_id intact';
  END IF;

  -- A pre-existing app upload (workspace_id NULL) must remain insertable, or
  -- the additive migration is not additive.
  INSERT INTO public.media_files (user_id, file_path, file_type)
  VALUES (user_a, 'legacy/' || nonce || '.jpg', 'image');
  RAISE NOTICE 'PASS: a legacy row with no workspace still inserts';
END $$;

-- The harness requires a terminal sentinel on a no-plan suite: a run truncated
-- after its first passing assertion exits 0 and looks identical to a complete
-- one. This line is the only proof the DO block above reached its end.
\echo ALL CHECKS PASSED
