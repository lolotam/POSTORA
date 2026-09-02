-- Phase 9 (9.3): does the scan-state substrate do the one thing it claims --
-- exist, default to 'available', close its vocabulary, and stay out of the
-- way of every row that already exists?
--
-- Assertions:
--   1. the column exists, NOT NULL, defaulting to 'available'
--   2. a row inserted WITHOUT the column reads 'available' -- the additive
--      guarantee D10's one-state collapse depends on
--   3. the CHECK refuses a value outside the vocabulary ('scanned')
--   4. 'pending' and 'rejected' ARE storable, or the future scanner has
--      nowhere to write its verdicts
--   5. an explicit NULL is refused -- the state must always be known
--
-- Self-cleaning (every fixture row is deleted by the nonce'd path prefix),
-- re-runnable, terminal sentinel for the harness. NOT RUN by the author of
-- the migration (no Postgres 17 harness available locally); the orchestrator
-- runs it via scripts/db-harness.sh.
\set ON_ERROR_STOP on

-- Catalog first, informational: the column and its constraint as they stand.
SELECT 'column: ' || data_type || ' default=' || column_default || ' nullable=' || is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'media_files' AND column_name = 'scan_state';

SELECT 'constraint: ' || pg_get_constraintdef(oid)
FROM pg_constraint WHERE conname = 'media_files_scan_state_chk';

DO $suite$
DECLARE
  -- Fixture identifiers unique per run, so the suite re-runs cleanly.
  nonce TEXT := replace(gen_random_uuid()::text, '-', '');
  owner UUID;
  defaulted_id UUID;
  col_default TEXT;
  col_nullable TEXT;
BEGIN
  SELECT id INTO owner FROM auth.users LIMIT 1;
  IF owner IS NULL THEN RAISE EXCEPTION 'harness seeds one auth.users row; none found'; END IF;

  -- 1. The column exists, NOT NULL, defaulting to 'available'. This is the
  --    control for the whole substrate: an available-by-default row changes
  --    NO current behaviour, which is what makes the migration additive.
  SELECT column_default, is_nullable INTO col_default, col_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'media_files' AND column_name = 'scan_state';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: media_files.scan_state does not exist';
  END IF;
  -- The column is text, so the catalog renders the default as
  -- 'available'::text. Match the literal and let the cast vary: the first
  -- version of this assertion hard-coded ::character varying and failed on
  -- a correct migration.
  IF col_default IS NULL OR col_default NOT LIKE '''available''::%' THEN
    RAISE EXCEPTION 'FAIL: scan_state default is %, expected ''available''', col_default;
  END IF;
  IF col_nullable <> 'NO' THEN
    RAISE EXCEPTION 'FAIL: scan_state is nullable';
  END IF;
  RAISE NOTICE 'PASS: scan_state exists, NOT NULL, defaulting to available';

  -- 2. A row inserted WITHOUT naming scan_state reads 'available'.
  INSERT INTO public.media_files (user_id, file_path, file_type)
  VALUES (owner, 'scan-' || nonce || '-default.jpg', 'image')
  RETURNING id INTO defaulted_id;

  IF (SELECT scan_state FROM public.media_files WHERE id = defaulted_id) = 'available' THEN
    RAISE NOTICE 'PASS: a row inserted without scan_state reads available';
  ELSE
    RAISE EXCEPTION 'FAIL: a row without scan_state did not read available';
  END IF;

  -- 3. The vocabulary is closed: 'scanned' is the plausible typo a future
  -- worker makes, and it must not be storable.
  BEGIN
    INSERT INTO public.media_files (user_id, file_path, file_type, scan_state)
    VALUES (owner, 'scan-' || nonce || '-bad.jpg', 'image', 'scanned');
    RAISE EXCEPTION 'FAIL: scan_state accepted a value outside the vocabulary';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: scan_state is a closed vocabulary';
  END;

  -- 4. The two refusal states must be storable, or the substrate refuses
  -- nothing once a scanner exists.
  INSERT INTO public.media_files (user_id, file_path, file_type, scan_state)
  VALUES
    (owner, 'scan-' || nonce || '-pending.jpg', 'image', 'pending'),
    (owner, 'scan-' || nonce || '-rejected.jpg', 'image', 'rejected');
  RAISE NOTICE 'PASS: pending and rejected are storable';

  -- 5. NOT NULL is load-bearing: a row whose scan state is unknown must not
  -- be representable, because the send path would have to guess it.
  BEGIN
    INSERT INTO public.media_files (user_id, file_path, file_type, scan_state)
    VALUES (owner, 'scan-' || nonce || '-null.jpg', 'image', NULL);
    RAISE EXCEPTION 'FAIL: scan_state accepted NULL';
  EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE 'PASS: scan_state is NOT NULL';
  END;

  -- Self-cleaning: only this run's rows, by the nonce'd path prefix.
  DELETE FROM public.media_files WHERE file_path LIKE 'scan-' || nonce || '%';
END $suite$;

-- The harness requires a terminal sentinel on a no-plan suite: a run truncated
-- after its first passing assertion exits 0 and looks identical to a complete
-- one. This line is the only proof the DO block above reached its end.
\echo ALL CHECKS PASSED
