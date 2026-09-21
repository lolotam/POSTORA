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
-- WHAT THIS CAN AND CANNOT RESTORE
--
--   format             recoverable. `mime_type` is populated on every affected
--                      row and is the authoritative source; the file extension
--                      agrees with it on all of them, and the guard below
--                      refuses to run if that ever stops being true.
--
--   duration           recoverable *for images only*, where the upload path
--                      writes null. Every affected row is an image (asserted
--                      below). If a video ever lands in this set the assert
--                      fires rather than writing a null that would read as
--                      "a video of no length".
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
-- Scope predicate is `NOT (metadata ? 'format')`, which also matches any row
-- whose upload never wrote `format` at all. That is intended: such a row wants
-- the same repair and the same values, and this migration is idempotent.

DO $$
DECLARE
  affected_rows integer;
  repaired_rows integer;
BEGIN
  SELECT count(*) INTO affected_rows
  FROM media_files
  WHERE metadata IS NOT NULL
    AND NOT (metadata ? 'format');

  -- A video in this set would need its duration probed from the file, which
  -- this migration cannot do. Stop rather than write a misleading null.
  ASSERT NOT EXISTS (
    SELECT 1
    FROM media_files
    WHERE metadata IS NOT NULL
      AND NOT (metadata ? 'format')
      AND file_type IS DISTINCT FROM 'image'
  ), 'Non-image rows are in scope; their duration cannot be reconstructed here.';

  -- `format` comes from mime_type. Refuse the whole batch if any row lacks one,
  -- or if mime_type and the file extension disagree about what the file is.
  ASSERT NOT EXISTS (
    SELECT 1
    FROM media_files
    WHERE metadata IS NOT NULL
      AND NOT (metadata ? 'format')
      AND (
        mime_type IS NULL
        OR split_part(mime_type, '/', 2) IS DISTINCT FROM
           lower(regexp_replace(regexp_replace(file_path, '[?#].*$', ''), '^.*\.', ''))
      )
  ), 'mime_type is missing or disagrees with the file extension; resolve by hand first.';

  UPDATE media_files
  SET metadata = metadata || jsonb_build_object(
        'format', split_part(mime_type, '/', 2),
        'duration', NULL
      )
  WHERE metadata IS NOT NULL
    AND NOT (metadata ? 'format');

  GET DIAGNOSTICS repaired_rows = ROW_COUNT;

  RAISE NOTICE 'media_files metadata backfill: % row(s) in scope, % repaired. '
               'original_filename left absent - not reconstructible.',
               affected_rows, repaired_rows;
END $$;
