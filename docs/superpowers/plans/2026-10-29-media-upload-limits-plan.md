# Admin-selectable media upload limits — implementation plan

Spec: [2026-10-29-large-media-uploads-design.md](../specs/2026-10-29-large-media-uploads-design.md), Part 2.
Branch: `feat/large-media-uploads` (PR #295). Required reading for any implementer: `ARCHITECTURE.md` §1, §11, §14–15, §23, §33, §36, §38.

Each task ends green: `deno test` for the functions touched, `vitest` for the files touched, `eslint`, `tsc`.

## Task 1 — limit options and parser (`mediaTypes.ts`, both copies)

- Replace `MEDIA_DIRECT_UPLOAD_BYTE_CAPS` with:
  - `UPLOAD_LIMIT_OPTIONS_MB = { image: [10, 20, 50, 100], video: [100, 200, 500, 1000, 2000] }`
  - `DEFAULT_UPLOAD_LIMITS_MB = { image: 20, video: 500 }`
  - `type UploadLimits = { image_max_mb: number; video_max_mb: number }`
  - `parseUploadLimits(value: unknown): UploadLimits` — per field, a value not in its option list falls back to the default.
- Add a `limits: UploadLimits = DEFAULT…` parameter to `directUploadByteCap`, `maxUploadBytesFor` and `needsDirectUpload`, so existing callers keep today's behaviour.
- Keep `src/lib/mediaTypes.ts` byte-identical (the Deno test enforces this).
- Tests (`_shared/mediaTypes.test.ts`): parser cases; caps follow the limits; an image limit of 10 means no direct images.

## Task 2 — migration

`supabase/migrations/20261029120000_media_upload_limits.sql`:
- `INSERT INTO app_settings (key, value, description) VALUES ('media_upload_limits', '{"image_max_mb":20,"video_max_mb":500}', …) ON CONFLICT (key) DO NOTHING;`
- Drop and recreate "Anyone can read public settings", copying the key list from `20260424154448_…sql` exactly, plus `'media_upload_limits'`.
- Verify on a local DB: anon can read the new key; anon still cannot read `cdn_storage`; admin can update it; a non-admin update is denied.

## Task 3 — server enforcement (`media-direct-upload`)

- `plan.ts`: `planDirectUpload(request, policy, usable, limits)` uses `directUploadByteCap(kind, limits)`.
- `index.ts` `start`: read `media_upload_limits` through the admin client, then `parseUploadLimits`. A read error means the defaults apply, and is logged.
- Tests (`plan.test.ts`): a 150 MB video against a 100 MB limit returns 413 with "100 MB"; a 2000 MB video passes at a 2000 MB limit; a 50 MB image passes at 50.

## Task 4 — browser limits hook

- `src/features/media-upload/infrastructure/uploadLimitsRepository.ts`: reads the row and runs `parseUploadLimits`.
- `src/features/media-upload/ui/useMediaUploadLimits.ts`: React Query, 5-minute stale time; returns the defaults while loading or on error. Export it from `index.ts`.
- Wire it into `MediaUploadDialog` (dropzone `maxSize`, `onDrop`, `handleUpload`, size hint text) and `usePostForm.uploadFileToStorage`.
- Tests: the hook falls back to defaults; the dialog shows "over the 50 MB limit" when the admin chose 50.

## Task 5 — admin section

- `settingsCatalog.ts`: add the `media-upload-limits` section (title, description, keywords).
- `src/components/admin/settings/MediaUploadLimitsSettings.tsx`: two `Select`s built from `UPLOAD_LIMIT_OPTIONS_MB`, Save upserts the row (same pattern as `CdnStorageSettings`), a success toast, and the infrastructure warning text from the spec.
- Bind the component in `AdminSettings` (the `Record<SettingsSectionId, …>` makes a missing binding a type error).
- Arabic strings in `src/i18n/locales/ar/`.
- Tests: only the listed options render; Save sends the chosen values; saving invalidates the limits query.

## Task 6 — docs

- `docs/runbooks/large-media-uploads.md`: where the limits live; that Openinary `MAX_FILE_SIZE_MB` and memory must match the largest chosen video limit; a 2 GB test before enabling 1000/2000.

## Task 7 — verify and ship

1. Run the full `vitest` suite plus `deno test` over `media-direct-upload/`, `cloudinary-upload/` and `_shared/mediaTypes.test.ts`.
2. Commit only the task's files and push to `feat/large-media-uploads`.
3. Deploy (with the owner's go-ahead):
   - apply the migration on the self-hosted DB;
   - copy `media-direct-upload/` and `_shared/mediaTypes.ts` to the functions volume, check SHA256, then `docker compose up -d --no-deps functions`;
   - the frontend deploys when `main` is pushed.
4. Manual check (spec "Testing"): change the limits in Admin and confirm both browser and server follow them.
