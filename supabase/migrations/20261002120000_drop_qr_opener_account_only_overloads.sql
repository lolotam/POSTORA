-- Drop the account-only QR opener overloads.
--
-- 20261002100000 added reserve_qr_opener(uuid, int, uuid, uuid) and
-- release_qr_opener(uuid, uuid, uuid) and kept the 2-arg / 1-arg versions
-- because the deployed worker still called them. The event- and
-- claim-scoped worker is now live (PR #231), and nothing else calls the old
-- signatures, so they go. Idempotent. Run as supabase_admin.

DROP FUNCTION IF EXISTS public.reserve_qr_opener(uuid, int);
DROP FUNCTION IF EXISTS public.release_qr_opener(uuid);

NOTIFY pgrst, 'reload schema';
