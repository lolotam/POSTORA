# YouTube Weighted Rate Limit Migration Runbook (PR-8A)

Migration: [`supabase/migrations/20261127120000_youtube_weighted_rate_limit.sql`](../../supabase/migrations/20261127120000_youtube_weighted_rate_limit.sql)  
Spec: `docs/specs/2026-11-26-youtube-vnext-roadmap-and-ux.md` (§§4.3, 10)  
Plan: `docs/plans/2026-11-26-youtube-vnext-roadmap-and-ux.md` (§PR-8A)

This migration adds `public.check_weighted_rate_limit(text, integer, integer, integer)` for atomic multi-unit write budget debits on `public.rate_limit_buckets`. It does **not** modify `public.check_rate_limit` or any table columns. Applying it in production requires Waleed's Heavy-tier card approval and must land before PR-8 merges.

---

## 1. Pre-migration database snapshot (Contabo)

Run on the Contabo host (`86.48.2.205`) via `ssh-contabo-mcp` before applying the migration, and record the snapshot receipt (path, byte size, SHA-256):

```bash
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
TS=$(date -u +%Y%m%dT%H%M%SZ)
SNAP="/root/backups/postora_pre_pr8a_${TS}.dump"

mkdir -p /root/backups
cd "$STACK"
docker compose exec -T db pg_dump -U supabase_admin -d postgres -Fc > "$SNAP"
ls -lh "$SNAP"
sha256sum "$SNAP"
```

Record the migration file SHA-256 directly from the approved git object (never from a potentially dirty working tree):

```bash
git -C /root/postora-runtime fetch origin
git -C /root/postora-runtime show <approved-sha>:supabase/migrations/20261127120000_youtube_weighted_rate_limit.sql | sha256sum
```

---

## 2. Apply migration

Apply as `supabase_admin` with `ON_ERROR_STOP=1` from the approved commit:

```bash
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
cd "$STACK"
git -C /root/postora-runtime fetch origin
git -C /root/postora-runtime show <approved-sha>:supabase/migrations/20261127120000_youtube_weighted_rate_limit.sql \
  | docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1
```

---

## 3. Post-apply smoke test

Run as `supabase_admin` (or `service_role`) against the throwaway key `youtube-wrl-smoke`, verify both responses, and delete the throwaway row:

```sql
-- 1. Allowed call: cost 50 against ceiling 100
-- Expected: {"allowed": true, "count": 50, "retry_after": 0}
SELECT public.check_weighted_rate_limit('youtube-wrl-smoke', 50, 100, 86400);

-- 2. Refused call: cost 60 against ceiling 100 (would exceed 100 -> no partial debit)
-- Expected: {"allowed": false, "count": 50, "retry_after": <1..86400>}
SELECT public.check_weighted_rate_limit('youtube-wrl-smoke', 60, 100, 86400);

-- 3. Clean up throwaway row
DELETE FROM public.rate_limit_buckets
 WHERE bucket_key = 'weighted:youtube-wrl-smoke';

-- 4. Verify privileges (only service_role has EXECUTE; PUBLIC/anon/authenticated do not)
SELECT
    has_function_privilege('anon', 'public.check_weighted_rate_limit(text, integer, integer, integer)', 'EXECUTE') AS anon_exec,
    has_function_privilege('authenticated', 'public.check_weighted_rate_limit(text, integer, integer, integer)', 'EXECUTE') AS auth_exec,
    has_function_privilege('service_role', 'public.check_weighted_rate_limit(text, integer, integer, integer)', 'EXECUTE') AS service_exec;
```

Expected: `anon_exec = false`, `auth_exec = false`, `service_exec = true`.

---

## 4. Rollback

No data or Edge Function depends on `check_weighted_rate_limit` until PR-8 merges. Roll back by dropping the function:

```sql
DROP FUNCTION IF EXISTS public.check_weighted_rate_limit(text, integer, integer, integer);
```
