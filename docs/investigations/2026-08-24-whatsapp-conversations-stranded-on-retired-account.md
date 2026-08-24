# WhatsApp inbox shows 2 threads after a re-pair — evidence log

Date: 2026-08-24. All evidence gathered live against production
(`postorasupabase-supabase-j8axyh`).

**Symptom.** A user disconnected and re-scanned a WhatsApp QR connection. The
history sweep reported success, but `/messaging/whatsapp/conversations` listed
only **2** chat threads.

## The rows

```text
id        user      platform_user_id   active  msgs  convs
aff985f0  12f4ba6a  96597950350        t        553     2   <- the re-paired row
ccb565af  12f4ba6a  retired_ccb565af   f          0   305   <- merged away
```

The same split appears on every account that has been through the merge:

```text
5057c953  201285060308      t  1138    2   /  2f2d4c31 retired  0  283
a7fc6167  96597950350       f   561    3   /  93de5a12 retired  0  307
```

Messages moved. Conversations did not.

## Root cause

`activate_evolution_qr_account` (added 2026-08-24 for the 23505 collision) moves
`whatsapp_messages` to the surviving account, deletes the duplicate's Evolution
instance and retires the duplicate row — but **never touches `messaging_cache`**,
which is the table the inbox actually lists conversations from
(`messaging-api/index.ts` `whatsapp_list_conversations`:
`.eq("social_account_id", social_account_id)`).

The re-sweep cannot repair it either. `import_whatsapp_conversations` upserts on
`(user_id, conversation_id)` and guards the update with

```sql
where excluded.last_message_at > messaging_cache.last_message_at
```

A conversation id is `wa_<owner_number>_<contact>` — derived from the phone
number, not the account — so a re-import lands on the *existing* row owned by the
retired account. Re-importing unchanged history is never strictly newer, so the
guard rejects it and `social_account_id` never transfers. Only the two chats that
received fresh traffic after the re-pair carried a newer timestamp, updated, and
moved to the new account. Hence: two threads.

`whatsapp_evolution_instances.last_sync_at` was stamped
(`2026-08-23 23:59:42+00`), so the sweep also considered itself complete and
would not retry.

## Fix

1. The merge block now moves `messaging_cache` and `whatsapp_scheduled_messages`
   alongside `whatsapp_messages`. Moving rather than replacing is what keeps
   deals, assignments and labels attached — those foreign keys reference
   `(id, workspace_id)`, neither of which changes. No collision is possible:
   `messaging_cache` is unique on `(user_id, conversation_id)` and both rows
   belong to the same user, so a conversation exists on exactly one of them.
2. Rehearsed in a rolled-back transaction against `5d8adccd` claiming
   `96597950350`: 3 conversations and 561 messages moved, duplicate retired.

## One-off repair of the live data

Not part of the migration — this is production-specific state. 895 rows across
three accounts, mapped by the owner number embedded in the conversation id:

```sql
update messaging_cache c
   set social_account_id = s.id
  from social_accounts r, social_accounts s
 where c.platform = 'whatsapp'
   and r.id = c.social_account_id and r.platform_user_id like 'retired\_%'
   and s.user_id = c.user_id and s.platform = 'whatsapp'
   and s.platform_user_id = split_part(c.conversation_id, '_', 2)
   and c.workspace_id = s.workspace_id;
```

Zero stranded rows were left unmatched and zero crossed a workspace boundary.
After: `aff985f0` 307 conversations, `5057c953` 285, `a7fc6167` 310, all retired
rows at 0. `a7fc6167` is inactive — its owner has to re-activate that connection
before those threads render, which is correct ownership, not a leftover.
