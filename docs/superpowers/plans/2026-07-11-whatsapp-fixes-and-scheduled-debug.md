# Plan: WhatsApp Messaging Fixes + Scheduled Posts Debug

**Date**: 2026-07-11
**Branch**: `feat/whatsapp-messaging-fixes`
**Scope**: 4 issues, all independent, executed in parallel

---

## Issue 1: Contact Avatar Upload RLS Violation

**Root Cause**: `useContacts.ts:250` uploads to `media/whatsapp-contact-avatars/{userId}_{timestamp}.jpg` in the `media` bucket. The bucket's RLS policy (migration `20260109060535`) requires `(storage.foldername(name))[1] = auth.uid()`. The path `whatsapp-contact-avatars` != the user UUID, so INSERT is denied.

**Solution**: Replace Supabase Storage upload with Cloudinary via the `cloudinary-upload` edge function (same pattern as `AvatarSection.tsx:56-74`). Add optional `subfolder` and `skipMediaFiles` params to `cloudinary-upload/index.ts`.

**Files**:
- `supabase/functions/cloudinary-upload/index.ts` — add `subfolder` + `skipMediaFiles` body params
- `src/components/messaging/contacts/useContacts.ts:231-256` — replace `uploadContactAvatar` with Cloudinary invoke
- `src/components/messaging/contacts/ContactFormDialog.tsx:80-95` — pass user email

**Deploy**: Redeploy `cloudinary-upload` edge function via SSH.

---

## Issue 2: Contacts <-> Conversations Sync

**Root Cause**: `useContacts.ts:116-123` writes only to `whatsapp_contacts`. Conversations stored in `messaging_cache` have denormalized `participant_name` and `participant_avatar`. No DB trigger links the tables.

**Solution**:
1. DB trigger: `AFTER UPDATE OF display_name, avatar_url ON whatsapp_contacts` updates matching `messaging_cache` rows
2. Frontend: invalidate `["messaging-conversations"]` query after contact edits

**Files**:
- `supabase/migrations/20260711120000_sync_contact_to_conversations.sql` — new trigger
- `src/components/messaging/contacts/useContacts.ts:100-103` — add conversations invalidation

**Deploy**: Apply migration via SSH.

---

## Issue 3: WhatsApp Coexistence Chat Thread Sync

**Root Cause**: `whatsapp-oauth/index.ts:136-139` calls `POST /{waba_id}/subscribed_apps` without `subscribed_fields`. Coexistence fields must be subscribed at app level. Secondary: `conversation_id` phone formatting inconsistent across handlers.

**Solution**:
1. Add app-level `POST /{app-id}/subscriptions` with coexistence fields after OAuth
2. Normalize phone digits in all webhook handlers
3. Log dropped field names for debugging

**Files**:
- `supabase/functions/whatsapp-oauth/index.ts:135-144` — app-level subscription
- `supabase/functions/whatsapp-webhook/index.ts:327,485,566,640` — normalize phone
- `supabase/functions/whatsapp-webhook/index.ts:129-131` — log dropped fields

**Deploy**: Redeploy `whatsapp-oauth` and `whatsapp-webhook` via SSH.

---

## Issue 4: Scheduled Posts Disappeared (P0)

**Symptom**: User sees "No scheduled posts" on `/scheduled`. DB has 20 posts with `status='scheduled'`. RLS allows admin to view all. Build succeeds locally.

**Diagnostic steps**:
1. Add error state display to `ScheduledPosts.tsx`
2. Check if `usePosts` query returns an error
3. Verify auth session validity
4. Compare production bundle

**Files**:
- `src/pages/ScheduledPosts.tsx` — add error state display
- `src/hooks/usePosts.tsx` — potentially add error handling

---

## Task Breakdown

| Task | Issue | Priority | Parallelize |
|---|---|---|---|
| 1 | Contact avatar Cloudinary | High | Yes |
| 2 | Contacts-Conversations trigger | High | Yes |
| 3 | Coexistence field subscription | High | Yes |
| 4a | Scheduled posts diagnostics | P0 Critical | Yes |
| 4b | Scheduled posts fix | P0 | Depends on 4a |
| 5 | Deploy: edge functions + migration | All | After 1-4b |
| 6 | Guard pass + commit + push + PR | All | After 5 |

---

## Constraints

- Do NOT modify `package.json` / `package-lock.json`
- Preserve Vite 8 WIP (stash/unstash for merge)
- Run `npx tsc --noEmit` after all changes
- Deploy edge functions via SSH (not `supabase functions deploy`)
