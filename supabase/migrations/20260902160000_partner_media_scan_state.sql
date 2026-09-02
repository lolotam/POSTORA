-- Partner API v1, Phase 9 (9.3): the scan-state substrate on media_files.
--
-- This is the additive shape D10's "Malware handling" row already names:
-- "If the answer is 'scan anyway', the shape is known: a scan_state column
-- on media_files, a pending state that POST /v1/messages refuses, and a
-- worker" (docs/decisions/2026-09-01-d10-media-control-matrix.md, "Malware
-- handling — the row that could not be answered").
--
-- D10 DECIDED there is no scanner and the state machine collapses to one
-- state: Postora never executes or renders partner media, never serves it
-- to a browser from a Postora origin, byte-confirms an allowlist of nine
-- types, the recipient's platform scans, and the uploader is an
-- authenticated, audited, revocable partner. That answer still needs OWNER
-- RATIFICATION — see docs/decisions/2026-09-02-phase9-rich-media.md.
--
-- WHAT THIS MIGRATION IS, GIVEN THAT
-- ----------------------------------
-- It builds the STATE and the REFUSAL, not a scanner. The day one exists,
-- nothing else has to change: set the default to 'pending' (or write
-- 'pending' explicitly at upload), run the worker, and the send path
-- already refuses unscanned ids with `media_pending` and unclean ones with
-- `media_rejected` (partnerMediaStore.mediaSendability).
--
-- THE DEFAULT IS 'available' ON PURPOSE, and that is the load-bearing
-- choice: an existing row — and every row the app's own uploader ever
-- writes — must change NO current behaviour. The refusal exists for rows a
-- future scanner has actually marked; inventing a pending state for files
-- nobody scans would refuse every send in production on the day this lands.
--
-- Additive and idempotent: one column, one CHECK, no data change. Re-running
-- is a no-op, per the partner-migration style (see 20260901190000).

ALTER TABLE public.media_files
  ADD COLUMN IF NOT EXISTS scan_state text NOT NULL DEFAULT 'available';

-- The closed vocabulary, same discipline as media_files_file_type_check:
-- 'available' (D10's collapsed state — sniffed, stored, sendable),
-- 'pending' (a scanner exists and has not verdicted yet), 'rejected'
-- (a scanner verdicted against it). Named DO-block guard rather than
-- ADD CONSTRAINT inline so a re-run does not collide with itself.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_files_scan_state_chk'
  ) THEN
    ALTER TABLE public.media_files
      ADD CONSTRAINT media_files_scan_state_chk
      CHECK (scan_state IN ('pending', 'available', 'rejected'));
  END IF;
END $$;
