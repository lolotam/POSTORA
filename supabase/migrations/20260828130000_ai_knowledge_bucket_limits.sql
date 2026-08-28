-- ============================================================================
-- Constrain what may be written to the private ai-knowledge bucket
-- ============================================================================
-- Type: additive constraint on an existing bucket. No data is moved or dropped.
--
-- Knowledge files used to be pushed to Cloudinary through the `cloudinary-upload`
-- edge function as a base64 data URL, so the edge request body size was an
-- accidental ceiling on how large an upload could be. They now go straight from
-- the browser into this bucket, which has no such ceiling -- an unconstrained
-- bucket would accept an arbitrarily large object from any authenticated user.
--
-- 25 MB comfortably clears the largest source seen in production (a ~4 MB
-- product catalogue) while keeping a single upload well inside what the
-- ingestion worker can chunk within its budget.
--
-- The MIME list mirrors SOURCE_TYPE_BY_EXTENSION in src/lib/aiKnowledge.ts.
-- Browsers are inconsistent about CSV and Markdown in particular (text/csv vs
-- application/vnd.ms-excel, text/markdown vs an empty string), so the list is
-- deliberately wider than the extension list rather than rejecting a file the
-- UI already accepted. The extension check in the UI and the parser's own byte
-- sniffing remain the real gates; this is a ceiling, not a content check.
-- ============================================================================

BEGIN;

UPDATE storage.buckets
SET
  file_size_limit = 26214400,  -- 25 MiB
  allowed_mime_types = ARRAY[
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
WHERE id = 'ai-knowledge';

-- The bucket must stay private: a public bucket serves /object/public/... without
-- consulting RLS at all, which is how these files were exposed before
-- 20260828100000_ai_knowledge_bucket_private.sql. Assert rather than assume,
-- because production has drifted on exactly this flag once already.
DO $$
DECLARE
  is_public boolean;
BEGIN
  SELECT public INTO is_public FROM storage.buckets WHERE id = 'ai-knowledge';
  IF is_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ai-knowledge bucket is not private (public = %)', is_public;
  END IF;
END $$;

COMMIT;
