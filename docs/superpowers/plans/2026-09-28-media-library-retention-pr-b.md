# PR B — Media Library auto-delete (retention) — implementation plan

**Spec:** `docs/superpowers/specs/2026-09-28-media-library-files-design.md` (the Retention decision).

**Owner decisions:**
- Retention is a per-user setting (7, 30 or 90 days, or never), default 30. On 2026-09-28 the owner also decided:
  - a 7-day warning ("Expires in N days" plus Keep) before any delete;
  - a per-file Keep forever option;
  - use resets the clock (a `last_used_at` column).
- Files that exist at rollout count their age from the rollout time.

**Lanes:** migration and SQL suite go to Muse Spark; code goes to Grok 4.7 medium. The Codex astra debate on this plan comes first.

## Reference map (source: code search, 2026-09-28)

A `media_files` row is **in use**, and must never be warned about or deleted, when any of the following holds.

**By id:**
- `posts.media_file_ids` contains its id, for any post status, including published history.
- `comment_workflow_rules.media_file_id = id`.
- `workflows.nodes`, `workflow_versions.nodes` or `workflow_templates.nodes` contain its id or any of its addresses (text search on `nodes::text`).

**By address.** A row's address set is `file_path`, every `media_file_providers.delivery_url`, and `cloudinary_public_id` when present. The row is in use when any address appears (substring match) in:
- `profiles.avatar_url` (all users);
- `app_settings.value::text` for keys `app_logo` and `app_favicon`;
- `image_reference_presets.reference_images::text`;
- `posts.metadata::text` (the youtube and twitter thumbnail keys);
- `whatsapp_scheduled_messages.media_url` for status `pending`, `claimed` or `sending`;
- `whatsapp_broadcasts.template_components::text` for a broadcast whose status is not `completed` or `failed`;
- `blog_posts.cover_image_url`;
- another `media_files` row with the same `file_path` (canvas duplicate rows).

**Out of scope, never considered:**
- `storage_bucket` `partner-media` (workspace files) or `media`/`supabase` (legacy Supabase storage);
- rows with neither provider rows nor `cloudinary_public_id`;
- `keep_forever = true`.

## Task 1 — migration `20261001100000_media_retention.sql` (Muse Spark)

Idempotent, applied twice in rehearsal, with no BEGIN/COMMIT of its own.

- **`profiles.media_retention_days`:** `integer NULL DEFAULT 30`, with `CHECK (media_retention_days IS NULL OR media_retention_days IN (7,30,90))`. NULL means never. Backfill existing rows to 30.
- **`media_files` columns:** `keep_forever boolean NOT NULL DEFAULT false`, `last_used_at timestamptz`, `expires_at timestamptz` (the warning deadline, NULL when not warned). Add a partial index on `expires_at WHERE expires_at IS NOT NULL`.
- **Rollout time:** `public.media_retention_settings(id int primary key default 1 check (id = 1), rollout_at timestamptz not null default now())`. Insert one row on first apply only, so a re-apply never moves it. RLS is enabled, with no end-user policies; the functions read it as SECURITY DEFINER.
- **`last_used_at` triggers** (AFTER INSERT OR UPDATE OF the column, SECURITY DEFINER, `search_path = public, pg_temp`):
  - on `posts.media_file_ids`: set `last_used_at = now()` and `expires_at = NULL` for those ids, owner-scoped (`media_files.user_id = NEW.user_id`);
  - on `comment_workflow_rules.media_file_id`: the same;
  - on `whatsapp_scheduled_messages.media_url`: update rows whose address set contains `NEW.media_url`, owner-scoped.
- **`public.media_file_in_use(p_id uuid) RETURNS boolean`:** STABLE, SECURITY DEFINER. It implements the reference map exactly. Revoke from public, anon and authenticated; grant to service_role.
- **`public.media_retention_sweep(p_now timestamptz DEFAULT now(), p_limit int DEFAULT 200) RETURNS TABLE(media_file_id uuid, user_id uuid, file_type text, cloudinary_public_id text)`:** scalar columns only; never a composite row type.
  - Only eligible rows are considered:
    - the owner's `media_retention_days` is not null;
    - the bucket is in scope;
    - `keep_forever` is false;
    - `age_basis = greatest(created_at, coalesce(last_used_at, created_at), rollout_at)`.
  - Phase A, **clear:** rows with `expires_at` set that are now in use, `keep_forever`, or whose owner's retention is null, go back to `expires_at = NULL`.
  - Phase B, **warn:** eligible rows with `expires_at IS NULL`, `age_basis < p_now - retention_days`, and not in use get `expires_at = p_now + 7 days`. Bounded by `p_limit`, oldest first. Write one sanitized `system_logs` row per user with the count.
  - Phase C, **due:** eligible rows with `expires_at <= p_now` that are still not in use are returned, `LIMIT p_limit`, oldest first. The caller deletes them.
  - SECURITY DEFINER with a fixed `search_path`. Revoke from public, anon and authenticated; grant to service_role.
- **Cron:**
  - Unschedule any existing job named `cleanup-media`. The manual-SQL job always ran as a dry run, so this removes nothing.
  - Schedule `media-retention` at `'5 5 * * *'`, using the `net.http_post` + `get_cron_secret()` pattern from `20260909170100_ai_knowledge_graph_refresh_cron.sql`.
  - Guard: pg_cron present, `get_cron_secret()` present, job absent. When a guard fails, raise a NOTICE rather than failing.
- **Suite:** `supabase/tests/media_retention.sql`, registered in `scripts/db-harness.sh`, with the `\echo` sentinel last. Cases:
  - the settings CHECK;
  - `rollout_at` does not change on re-apply;
  - each reference type in the map protects its row: id refs, avatar, app logo, workflow node url, scheduled message url, canvas duplicate, `posts.metadata` thumbnail;
  - `keep_forever` protects;
  - partner-media and media buckets are never returned;
  - a row older than retention but newer than `rollout_at` is not warned;
  - warn sets `expires_at = now + 7d`, and the due row is returned only after `expires_at`;
  - using a file (inserting a post that references it) clears `expires_at` and sets `last_used_at`;
  - retention NULL (never) clears warnings;
  - EXECUTE is granted to service_role only;
  - cron present with the NOTICE skip.

## Task 2 — edge function `media-retention` (Grok)

- Auth: `verifyCronOrAdmin` from `_shared/cron-auth.ts`.
- The body `{ dryRun?: boolean }` defaults to false for cron. An admin call may pass `dryRun: true`.
- Call the `media_retention_sweep` RPC (it returns an array).
- Move `destroyCloudinary` from `cloudinary-delete/index.ts` into `_shared/cloudinaryDestroy.ts`, keeping the same behaviour including the disabled-account rule. `cloudinary-delete` then imports it.
- Load the provider rows for the due ids, then call `deleteAuthorisedMediaFiles` (move `deletePlan.ts` to `_shared/mediaDeletePlan.ts` and re-export it from the old path). The rows come from the RPC, so authorisation is the RPC's eligibility check. Use `markDeleted(id, "retention")`.
- Delete the `media_files` rows only for confirmed-deleted ids, with the service role.
- Log per run: counts of warned, due, deleted and failed. Never log ids of other users' files, urls or names.
- `dryRun` returns the due ids without deleting.
- Time budget: 40 s. Stop starting new deletes after that; the rest are picked up on the next run.
- Retire `cleanup-media`:
  - Make it delegate to the same module with `dryRun` support, so `AdminMediaCleanup.tsx` keeps working.
  - Remove its unsafe logic: posts-only check, Cloudinary-only candidates, and deleting rows after a failed storage delete.
- Tests, handler level with ports: due files are deleted, and only confirmed rows are removed; `dryRun` deletes nothing; the budget stops new deletes; a failed provider delete keeps the row.

## Task 3 — frontend (Grok)

- **Settings:** a `MediaRetentionSection` in the Settings "profile" tab, following the `TimezoneSection` pattern. It offers 7, 30 or 90 days, or Never, and saves `profiles.media_retention_days` then calls `refreshProfile()`.
- **Library, badge and Keep actions:**
  - A row with `expires_at` shows a badge "Deletes in N days" in amber, turning red at 1 day or less.
  - **Keep** clears `expires_at` and sets `keep_forever = true`.
  - A **Keep forever** toggle sits in the card menu and in the bulk actions.
  - A filter "Expiring soon" shows rows where `expires_at` is not null.
  - RLS: check that the owner can update `keep_forever` and `expires_at` on their own rows, and use the existing update path if so.
- **`mediaDelete.ts`:** treat `storage_bucket` `supabase` like `media` (the PR #222 follow-up).
- **Types:** update `src/integrations/supabase/types.ts` for the new columns and `media_retention_days`.
- **i18n:** Arabic entries in the right namespace file (`settings`/`assets`), plus English `t()` fallbacks.
- **Tests (vitest):** the badge thresholds; Keep clears the expiry and sets `keep_forever`; the settings save; the `supabase` alias goes to storage.

## Deploy

1. Migration first. Verify the columns, functions and grants, that the cron job is present, and that `rollout_at` is set.
2. Merge, then check "healthy on <sha>".
3. Run a dry run of `media-retention` as admin. Expected result: 0 due, and 0 warned until 30 days after rollout.

## Merge threshold (set before review)

Blockers:
- any path that can warn about or delete a file that is in use per the reference map, or `keep_forever`, or partner/legacy;
- a delete that removes a row whose object deletion was not confirmed;
- a rollout-date violation;
- any cross-tenant update from the triggers;
- EXECUTE granted beyond service_role.

Everything else is a follow-up.

## Debate revisions (Codex astra, 2026-09-28): these override the sections above

**Prerequisite:** the provider-row hotfix PR (`fix/provider-rows-server-managed`) merges first. It makes `media_file_providers` server-managed, and it checks that Openinary `object_key` matches `delivery_url` before any destroy. Without it, a user can point a provider row at another user's object.

### Mode (owner default while the question is unanswered; decided 2026-09-28)

- **Warn-only until #223 is fixed.** Openinary keeps serving some deleted files by link.
- Setting `app_settings.media_retention_delete_enabled`: `false` by default, admin-only. While it is false, the job runs phases A (clear) and B (warn) only, so no file is ever deleted.
- The UI still shows "Deletes in N days", plus a note that deletion is paused until the admin enables it.

### Reference map: added

**Protected:**
- `whatsapp_messages.media_url` (forwarding reuses it)
- `whatsapp_contacts.avatar_url`
- `ai_knowledge_sources.file_path`
- `workflows.thumbnail_url`
- `workflow_templates.preview_image_url`
- `ai_generation_jobs.media_file_id` / `result_url` / `params::text` while the job is not in a terminal state

**Explicitly not protected:**
- `media_operations_history`
- completed `ai_generation_jobs`
- `media_files.metadata.original_file_id` / `transcoded_from`

These are history and provenance: their links may break after retention. The history UI shows "file expired" where it can.

**Duplicate protection:** match by shared provider object identity. `(provider, object_key)` of any other `media_files` row, or any address alias (`file_path` or `delivery_url` of another row), counts as in use. Rows excluded from deletion still count as references.

### Set-based reference check

No per-candidate scalar LIKE scans.

1. Materialise the candidate ids and their address/object sets once, into a temp table inside the sweep.
2. Build the used-id set with UNION branches:
   - unnest `posts.media_file_ids` once;
   - join comment rules;
   - extract JSON string leaves once (`jsonb_path_query`/text) from the jsonb sources;
   - join the scalar url columns.
3. Reuse that set across phases A, B and C.
4. The suite includes an `EXPLAIN (ANALYZE, BUFFERS)` smoke on a synthetic 5k-row corpus. Report the timing; it is not an assert.

### Server-managed retention columns

- `REVOKE UPDATE (keep_forever, last_used_at, expires_at, retention_state) ON media_files FROM authenticated`. Grant the other columns if needed so existing owner updates (rename metadata, `folder_path`) keep working.
- Test that each existing client update path still passes.
- `public.media_set_keep(p_ids uuid[], p_keep boolean)` is SECURITY DEFINER and owner-scoped (`auth.uid()`). Keep sets `keep_forever` and clears `expires_at`. Un-keep sets `keep_forever = false` and leaves `expires_at` NULL, so the next sweep re-evaluates.
- EXECUTE goes to authenticated. The frontend Keep and Keep-forever actions call this RPC only.

### Deletion claim protocol (mandatory, not best-effort)

- `media_files.retention_state text NULL CHECK (retention_state IN ('warned','deleting'))`, plus `retention_claimed_at`, `retention_attempts int NOT NULL DEFAULT 0` and `retention_next_attempt_at`.
- **`media_retention_claim(p_limit)`**, in one transaction:
  - `FOR UPDATE SKIP LOCKED` on due rows;
  - re-check the retention age against the owner's *current* setting (an increase cancels the warning), plus `keep_forever`, the bucket and in-use;
  - set `retention_state = 'deleting'` and return the rows.
- **Reference writers:** a BEFORE INSERT/UPDATE trigger on `posts.media_file_ids`, `comment_workflow_rules.media_file_id`, and on the scheduled message and `whatsapp_messages` url columns. If a referenced file is in `'deleting'`, raise a clear error ("This file is being deleted from your library"). Otherwise the trigger is a no-op.
  - This guard is mandatory and cheap: a PK lookup for the id columns, an indexed `file_path` lookup for urls.
  - The `last_used_at` bookkeeping stays a separate AFTER trigger that is best-effort: an EXCEPTION block logs and continues, and updates are owner-scoped.
- Keep (`media_set_keep`) on a row in `'deleting'` returns an error: already being deleted.
- **After destroy**, delete the row only if the provider deletes are confirmed. On failure, set `retention_state = 'warned'`, increment `retention_attempts`, and set `retention_next_attempt_at = now() + backoff`. The claim orders by `retention_next_attempt_at NULLS FIRST`, so fair retry holds. After 5 attempts, leave the row warned and log.
- A stale claim (`'deleting'` older than 1 hour) goes back to `'warned'`.

### Throughput

- The cron runs every 15 minutes (`'*/15 * * * *'`) with `p_limit` 50 per phase and a continuation loop inside the 40 s budget.
- The guard also requires `pg_net`.
- Backlog count goes into the run log.

### Preview is non-mutating

`media_retention_preview(p_user uuid DEFAULT NULL)` returns what would be warned and deleted, with no writes. The admin page and `dryRun` use it.

### Admin page contract

`AdminMediaCleanup.tsx` switches to `{ result: { warned, due, deleted, failed, backlog }, filesToDelete: [...] }`. Its age inputs become read-only text explaining the per-user setting.

### Budget

Every provider call gets its own timeout, capped by the remaining budget. Cloudinary destroy gets an AbortSignal of 10 s. Completed deletions are checkpointed (the row is deleted per file, not per batch).

### Frontend

- `useAuth`'s `Profile` interface and `PROFILE_COLUMNS` include `media_retention_days`.

### Tests (additions)

- races: a post referencing a `'deleting'` file is refused, and Keep on `'deleting'` is refused;
- an authenticated user cannot set `expires_at`, `retention_state` or `last_used_at`;
- a retention increase cancels the warning;
- Never (NULL) survives a migration re-apply (no NULL backfill on re-run; the backfill runs only when the column is newly added);
- alternate-address duplicates;
- a provider read failure treated as unsafe;
- partial delete and retry backoff;
- every added reference.
