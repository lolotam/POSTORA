-- The identity guard of an admitted media row reads a table the owner cannot read.
--
-- WHY THIS EXISTS. `media_admitted_identity_guard` (20261118250000) ran with
-- the privileges of the caller and looked for an open upload session in
-- `youtube_upload_sessions`, a private table the `authenticated` role cannot
-- read. A row update by its owner that changed `file_path`, `storage_bucket`
-- or `workspace_id` therefore failed with a permission error, with or
-- without an open session.
--
-- The function now runs as its owner, so the lookup works for every caller.
-- The second hole is closed here too: an owner may write
-- `current_object_version`, and writing the pinned value back after the guard
-- bumped it would make the session fence match again. While an open session
-- reads the row, the version can only move forward.

CREATE OR REPLACE FUNCTION public.media_admitted_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_identity_changed boolean;
  v_version_changed boolean;
BEGIN
  v_identity_changed := NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
    OR NEW.file_path IS DISTINCT FROM OLD.file_path
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id;
  v_version_changed := NEW.current_object_version IS DISTINCT FROM OLD.current_object_version;

  IF NOT (v_identity_changed OR v_version_changed) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.youtube_upload_sessions ys
     WHERE ys.media_file_id = OLD.id
       AND ys.state = 'open'
  ) THEN
    RETURN NEW;
  END IF;

  IF v_identity_changed THEN
    NEW.current_object_version := greatest(
      coalesce(NEW.current_object_version, 1),
      coalesce(OLD.current_object_version, 1) + 1
    );
  ELSE
    NEW.current_object_version := greatest(
      coalesce(NEW.current_object_version, 1),
      coalesce(OLD.current_object_version, 1)
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.media_admitted_identity_guard() FROM PUBLIC, anon, authenticated;
