# Design Spec: WhatsApp Messaging Fixes + Scheduled Posts Debug

**Date**: 2026-07-11
**Branch**: `feat/whatsapp-messaging-fixes`

---

## 1. Contact Avatar Cloudinary Upload

### Current flow (broken)
```
ContactFormDialog -> uploadContactAvatar -> supabase.storage.from("media").upload("whatsapp-contact-avatars/...")
-> RLS DENIES (path[0] != auth.uid())
```

### New flow
```
ContactFormDialog -> uploadContactAvatar(email, file) -> supabase.functions.invoke("cloudinary-upload", {
    body: { fileData: base64, fileName, fileType: "image", subfolder: "whatsapp-assets", skipMediaFiles: true }
  })
-> Cloudinary uploads to media/{email}/whatsapp-assets/{timestamp}
-> Returns { url: "https://res.cloudinary.com/..." }
-> ContactFormDialog stores URL in form.avatar_url
-> On save, updateContact writes avatar_url to whatsapp_contacts.avatar_url
```

### Edge function changes (`cloudinary-upload/index.ts`)
- Accept optional `subfolder` in request body. If provided, use `media/{sanitized_email}/{subfolder}/` instead of `media/{sanitized_email}/{date}/`
- Accept optional `skipMediaFiles: boolean`. If true, skip the `media_files` INSERT
- No changes to auth, credentials, or dedup logic

### Client changes (`useContacts.ts`)
- `uploadContactAvatar(file: File, userEmail: string)` — base64-encode file, invoke cloudinary-upload with subfolder + skipMediaFiles, return `uploadData.url`
- Remove Supabase Storage usage

### Acceptance criteria
- Contact avatar upload succeeds without RLS error
- Uploaded image appears at Cloudinary URL under `media/{email}/whatsapp-assets/`
- No `media_files` row created for contact avatars
- Existing profile avatar uploads are unaffected

---

## 2. Contact <-> Conversation Sync

### DB trigger
```sql
CREATE OR REPLACE FUNCTION public.sync_contact_to_conversations()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.messaging_cache
     SET participant_name   = COALESCE(NEW.display_name, participant_name),
         participant_avatar = COALESCE(NEW.avatar_url, participant_avatar),
         updated_at = now()
   WHERE user_id = NEW.user_id
     AND platform = 'whatsapp'
     AND conversation_id LIKE 'wa_%_' || NEW.phone_number;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_sync_contact_to_conversations
AFTER UPDATE OF display_name, avatar_url ON public.whatsapp_contacts
FOR EACH ROW EXECUTE FUNCTION public.sync_contact_to_conversations();
```

### Phone matching
`whatsapp_contacts.phone_number` stores digits-only. `messaging_cache.conversation_id` format is `wa_{phoneNumberId}_{participantPhone}`. The `LIKE 'wa_%_{digits}'` suffix match links them.

### Frontend invalidation
Add `qc.invalidateQueries({ queryKey: ["messaging-conversations"] })` to the `invalidate` function.

### Acceptance criteria
- Editing contact display_name in /contacts immediately updates conversation name in /conversations
- Editing contact avatar_url updates conversation avatar
- Conversations without matching contact are unaffected
- Inbox list refreshes within 1 second of saving a contact edit

---

## 3. WhatsApp Coexistence Field Subscription

### OAuth flow change
After `POST /{waba_id}/subscribed_apps`, add app-level subscription:
```ts
const APP_SUBSCRIPTION_FIELDS = [
  "messages", "history", "smb_message_echoes", "smb_app_state_sync",
  "account_update", "phone_number_name_update", "phone_number_quality_update",
  "message_template_status_update", "template_category_update",
];
const appId = Deno.env.get("META_APP_ID");
if (appId) {
  await fetch(`${GRAPH_API}/${appId}/subscriptions?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      object: "whatsapp_business_account",
      callback_url: `${APP_URL}/functions/v1/whatsapp-webhook`,
      verify_token: Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN"),
      fields: APP_SUBSCRIPTION_FIELDS,
    }),
  });
}
```

### Conversation ID normalization
| Handler | Line | Current | After |
|---|---|---|---|
| handleLiveMessages | 327 | `from` (raw) | `from.replace(/\D/g, "")` |
| handleHistorySync | 485 | `contactWaId` (raw) | `contactWaId.replace(/\D/g, "")` |
| handleEchoes | 566 | already stripped | no change |
| handleContactSync | 640 | already digits | no change |

### Acceptance criteria
- After reconnecting, whatsapp-config-test reports zero missing fields
- Chat threads from mobile app appear in /conversations within 5 minutes
- Messages sent from mobile app appear as outbound echoes
- No duplicate conversations

---

## 4. Scheduled Posts Debug

### Diagnostic approach
1. Add error display to ScheduledPosts.tsx to surface silent query failures
2. If RLS/auth error -> investigate auth session
3. If network error -> check Supabase URL
4. If no error but empty -> investigate at database level

### Error state UI
```tsx
const { data: posts = [], isLoading, error, refetch } = usePosts();
{error && (
  <div className="text-destructive">Failed to load posts: {error.message}</div>
)}
```

### Acceptance criteria
- All 20 scheduled posts reappear on /scheduled
- Future query failures show visible error instead of silent empty state
- Page loads correctly with media controls (folder dropdown, badges, carousel)
