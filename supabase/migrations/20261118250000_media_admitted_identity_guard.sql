-- The media of an admitted upload may not change its identity under the
-- session.
--
-- WHY THIS EXISTS. A media row is a row the authenticated owner may write,
-- including the columns that say WHERE the object is: `storage_bucket`,
-- `file_path` and `workspace_id`. An open YouTube upload session pinned the
-- content version it was admitted with, and the version fence refuses the
-- session when the file is replaced -- but nothing moved the version when the
-- row's IDENTITY columns changed, so a row rewritten after the admission
-- kept passing a fence that was comparing the version of another object.
--
-- A change to any of the three columns on a row an OPEN session reads is
-- therefore a replacement: the version is bumped, the session fence refuses
-- the upload with 'media_changed', and the bytes the upload started with are
-- never exchanged for bytes the customer did not put on this post. Rows no
-- session reads keep their old behaviour entirely.
--
-- The enforcement lives in the database on purpose: a direct row update does
-- not pass through the worker, so a worker-side check would not see it.
--
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.media_admitted_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
      OR NEW.file_path IS DISTINCT FROM OLD.file_path
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id)
     AND EXISTS (
       SELECT 1
         FROM public.youtube_upload_sessions ys
        WHERE ys.media_file_id = OLD.id
          AND ys.state = 'open'
     ) THEN
    -- The row an open upload reads changed its identity: the version the
    -- session pinned no longer names the object that was admitted, so the
    -- version moves and the session fence refuses the upload.
    NEW.current_object_version := coalesce(OLD.current_object_version, 1) + 1;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.media_admitted_identity_guard() IS
  'Bumps the content version of a media row an open upload session reads when '
  'the row''s identity columns (storage_bucket, file_path, workspace_id) '
  'change, so the session version fence refuses the upload instead of '
  'reading the object the row now names.';

DROP TRIGGER IF EXISTS media_admitted_identity_guard ON public.media_files;
CREATE TRIGGER media_admitted_identity_guard
  BEFORE UPDATE ON public.media_files
  FOR EACH ROW EXECUTE FUNCTION public.media_admitted_identity_guard();
