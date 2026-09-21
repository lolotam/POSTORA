-- Partial repair of media_files.metadata rows flattened by the heal-write bug.
-- Cause and evidence: docs/devtools-audit.md finding F1; fix shipped in PR #185.
--
-- Until PR #185 the media grids healed a null `metadata.width` with
-- `update({ metadata: { width, height } })`. PostgREST replaces a jsonb column
-- wholesale, so that write dropped `format`, `duration` and `original_filename`
-- from the row. The nine rows clobbered during the audit were restored from a
-- capture taken moments before; this migration addresses the rows clobbered
-- earlier, for which no such capture exists.
--
-- SCOPE: the clobber signature, not "missing format"
--
-- The bug wrote exactly `{width, height}` and nothing else, so that exact key
-- set is the scope. An earlier draft used `NOT (metadata ? 'format')`, which is
-- wrong: several paths legitimately write metadata without a `format` key --
-- `BatchImageToolsDialog.tsx` inserts `{cloudinary_url, cloud_name,
-- batch_processed, ...}` with no `mime_type` column at all, and
-- `process-video/index.ts` inserts `{source, operation, ...}` on a video row.
-- Neither is damaged, neither is repairable from `mime_type`, and sweeping them
-- in would have this migration fail on any database that holds one.
--
-- WHAT THIS CAN AND CANNOT RESTORE
--
--   format             recoverable from `mime_type`, the authoritative source.
--                      On the production rows it agreed with the file extension
--                      on every one.
--
--   duration           recoverable *for images only*, where the upload path
--                      writes null. A clobbered video would need its duration
--                      probed from the file, which this migration cannot do, so
--                      such a row is left alone and reported rather than
--                      recorded as having no length.
--
--   original_filename  NOT recoverable, and deliberately not guessed. It holds
--                      a name that appears nowhere in `file_path`: intact rows
--                      pair `original_filename` = '<user-id>_<uuid>' with a path
--                      basename of 'postora_<date>_<user-id>_<n>.png', and
--                      another pairs 'postora_circle_logo' with an unrelated
--                      path. Any value derived from the path would be a
--                      plausible-looking fabrication. The key stays absent so
--                      the loss remains visible rather than papered over.
--
-- Rows in scope that cannot be repaired are skipped and counted, never asserted
-- on: a migration that aborts the chain over unrepairable data would block every
-- later migration on a restored database for no benefit.
--
-- Production was repaired on 2026-09-21 (38 rows, all images). Those rows held
-- exactly `{width, height}`, so this narrowed predicate selects the same set and
-- re-running here is a no-op.

DO $$
DECLARE
  in_scope integer;
  repaired integer;
BEGIN
  CREATE TEMP TABLE clobbered_media_metadata ON COMMIT DROP AS
  SELECT id, mime_type, file_type
  FROM media_files
  WHERE metadata IS NOT NULL
    AND metadata ?& array['width', 'height']
    AND (SELECT count(*) FROM jsonb_object_keys(metadata)) = 2;

  SELECT count(*) INTO in_scope FROM clobbered_media_metadata;

  -- `format` comes from mime_type; `duration` null is only correct for an image.
  UPDATE media_files m
  SET metadata = m.metadata || jsonb_build_object(
        'format', split_part(c.mime_type, '/', 2),
        'duration', NULL
      )
  FROM clobbered_media_metadata c
  WHERE c.id = m.id
    AND c.file_type = 'image'
    AND c.mime_type IS NOT NULL
    AND split_part(c.mime_type, '/', 2) <> '';

  GET DIAGNOSTICS repaired = ROW_COUNT;

  RAISE NOTICE 'media_files metadata backfill: % row(s) matched the clobber '
               'signature, % repaired, % skipped as unrepairable (video, or no '
               'usable mime_type). original_filename left absent throughout - '
               'not reconstructible.',
               in_scope, repaired, in_scope - repaired;
END $$;
