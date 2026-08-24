# Instagram DMs never reach the n8n trigger — autoverse511@gmail.com (2026-08-24)

Read-only DB / log investigation. No code changed.

## Account under investigation

| Field | Value |
|---|---|
| Postora user | `1242ddb9-517c-412b-87c1-e46d3011c28e` — autoverse511@gmail.com |
| Plan | Business, active. `profiles.api_key` present. |
| IG account row | `e7b62a8a-eace-4b00-8546-a61f01b473af` |
| IG connect flow | `instagram_business_login`, `flow: direct`, connected `2026-08-24 15:10:05Z` |
| `platform_user_id` | `28328915980060259` |
| `account_metadata.ig_igid` | `17841414837379313` |
| username / name | `ahmedahmed5678977` / "aaaaaaaaaaaa" |
| token | valid, expires 2026-10-23, `needs_reauth=false`, `failure_count=0` |

## What is NOT broken

- **Meta-side per-account subscription is correct.**
  `GET graph.instagram.com/v22.0/28328915980060259/subscribed_apps` →
  `{"data":[{"id":"18155946892494580","subscribed_fields":["messages","comments"]}]}`
  (`instagram-oauth` logged `Subscribed direct Instagram account to webhooks: 28328915980060259` at 15:10:05Z.)
- **App-level delivery works.** `facebook-instagram-webhook` logged
  `Received verified instagram event` at 19:07:49 / 19:07:51 / 19:08:00Z.
- **Token/auth is healthy** (`me` resolves; no reauth flag).
- `granted_scopes: []` in metadata is cosmetic — it is only read by the Threads
  cross-share path (`process-post`, `useThreadsCapabilities`), never by messaging.

## Root cause 1 — the DMs are going to a different Instagram account

Every inbound Instagram event in the last 5 hours carries `entry.id = 17841401514313845`:

```
19:07:49Z [Info]  [fb-ig-webhook] Received verified instagram event
19:07:49Z [Error] [fb-ig-webhook] No matching instagram account found for recipient 17841401514313845
19:07:51Z [Info]  ... entryId 17841401514313845, messagingKinds [["message"]]  (echo, skipped)
19:08:00Z [Error] [fb-ig-webhook] No matching instagram account found for recipient 17841401514313845
```

`findAccountForRecipient` (`supabase/functions/facebook-instagram-webhook/index.ts:32-51`)
matches `platform_user_id`, then `account_metadata.ig_igid`, then `ig_user_id`.
A full-table scan finds **no** Postora `social_accounts` row with `17841401514313845`
in any of those three columns — across all users, not just this one.

The account the user actually connected resolves to a different pair of ids:

```
GET /v22.0/me?fields=id,user_id,username,name
{"id":"28328915980060259","user_id":"17841414837379313","username":"ahmedahmed5678977","name":"aaaaaaaaaaaa"}
```

`17841414837379313 != 17841401514313845`, and
`GET /v22.0/17841401514313845` with the connected account's token returns
IGApiException code 100 subcode 33 (object not visible to this token) —
confirming it is a *different* Instagram account, not another id form of the same one.

**So:** Meta delivers the DM, Postora receives and verifies it, then drops it at the
account lookup because the receiving Instagram account is not connected in Postora.
`social_inbox_events` has **0 rows** for `e7b62a8a-…` and 0 rows containing
`17841401514313845`. Nothing ever reaches `dispatchN8nEvent`.

The connected account (`ahmedahmed5678977`, display name "aaaaaaaaaaaa") looks like a
throwaway/test profile; the traffic is on the user's real account.

## Root cause 2 — no n8n trigger is registered at all

`app_settings` holds exactly four `n8n_webhook_%` rows and **all four belong to
`12f4ba6a-…` (danatfuture@gmail.com)**. Zero rows for `1242ddb9-…`.
`whatsapp_webhooks` for this user: 0 rows.

Edge-function log shows an n8n editor session from 14:25:42Z to 15:12:58Z that is a
continuous `POST /api/v1/webhooks` → `DELETE /api/v1/webhooks/{id}` churn — the
signature of n8n's **"Test workflow" / listen mode**, which registers on listen and
deletes on stop, ending on a `DELETE` at 15:12:58Z. (The log lines carry no user id, and
danatfuture was demonstrably active in the same window — dispatch 404s to
`n8n.walidmohamed.com` at 14:31/14:34 — so that session is **not attributable** to
autoverse511. The zero-rows result below is user-scoped and unaffected.)

**After 15:12:58Z there is no `n8n API request` line of any kind.** That is decisive
rather than circumstantial: in the *deployed* `n8n-api/index.ts` the request log
(line 2088) runs **before** the API key is even read (line 2097), so even a request
with a wrong or missing key would be logged. Silence therefore means autoverse511's n8n
made **no call to Postora at all** during the complaint window — not a rejected one.
The trigger was never activated (or n8n is pointed at the wrong base URL).

A registration only persists when the workflow is **saved and activated**. Even if
root cause 1 were fixed, `loadDestinations` would return `configured: 0` and
`dispatchN8nEvent` would log `no webhook destinations for user 1242ddb9-…` and return.

## Fix for the user

1. Connect the Instagram account that actually receives the DMs
   (`/profiles` → Connect Instagram, and sign in as that account — not
   `ahmedahmed5678977`). Confirm the new row's `ig_igid` is `17841401514313845`.
2. Confirm with the user **which Instagram username they are DMing** — the
   diagnosis above proves the recipient is not `ahmedahmed5678977`, but not whose it is.
3. In n8n, **Save + Activate** the workflow containing Postora Trigger. Test-mode
   listening is not enough. Verify with
   `GET /api/v1/webhooks` (or check `app_settings` for an
   `n8n_webhook_1242ddb9-…` row with `is_active: true`). Also confirm the node's
   credential base URL is `https://api.postora.cloud` — no request from their n8n
   reached the function at all after 15:12:58Z, and a wrong base URL looks identical.
4. If DMs still do not arrive after reconnecting the correct account, check
   Instagram's message-access toggle on that profile (Instagram app → Settings →
   *Messages and story replies* → *Connected tools* → "Allow access to messages";
   wording varies by app version). With it off, Meta silently sends nothing.
5. Verify end to end: send a DM, then expect
   `[fb-ig-webhook] Received inbound instagram message` (not "No matching …")
   followed by a delivery in the n8n execution list.

## Product gap worth fixing

`No matching instagram account found for recipient <id>` is server-log-only. A user in
this exact situation — connected the wrong IG profile — gets a completely silent
failure with no signal in the UI. Surfacing unmatched-recipient events (or showing the
connected account's IGID on the messaging page) would make this self-diagnosable.
