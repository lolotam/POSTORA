# Investigation Report + Claude Code Fix Brief

**Threads n8n triggers receive no data (inbox / replies / comments / mentions)**

| Field | Value |
|---|---|
| Date | 2026-08-23 |
| Audience | Claude Code (implementer) |
| Scope | Read-only investigation. **No production code was changed in this pass.** |
| Repos | `F:\Postora_new` (backend + web) and `F:\N8N\Postora-n8n-community-node` (n8n node, v1.4.1). Do **not** recreate a vendored copy under Postora. |
| Evidence | Live Postgres + edge-function logs via `ssh-contabo-mcp` on Contabo `86.48.2.205`, plus a live Threads Graph probe against the `@danatfuture` token (token not recorded here). |

---

## Executive summary

This is **not** an n8n node bug and **not** a missing n8n webhook registration.

The Postora UI at `/messaging/thread?tab=replies` and `?tab=mentions` is a **live poll of Meta**. That path never has to go through `threads-webhook`, so replies/mentions can show in Postora while n8n stays silent.

n8n only fires when Postora **pushes** `comment.received` (or `threads.mention.*`) to a registered callback. For Threads, that push is supposed to come from Meta's **Threads webhooks**. Meta is not delivering signed events. The one POST that did hit `threads-webhook` was rejected as `missing-header` (unsigned probe). There is **zero** `social_inbox_events` for Threads, **zero** `threads_mentions` rows for `@danatfuture`, and **zero** successful n8n deliveries of `comment.received` / `comment.threads`.

A second, independent bug will drop replies even after Meta starts delivering: `threads-webhook` treats `target_id` as the Threads user id, but Meta's replies payload uses `target_id` as the **media id**.

Threads has **no DM/inbox messaging API**. The `message.received` Postora Trigger will never fire for Threads. "Inbox" on `/messaging/thread` is replies + mentions.

| # | What the user sees | Proven cause | Confidence |
|---|---|---|---|
| 1 | Replies visible in Postora, n8n Comment/Trigger idle | UI polls `GET /{user}/replies`. n8n needs Meta `replies` webhook → `comment.received`. No signed webhook POST ever processed. | High |
| 2 | Mentions visible in Postora, n8n idle | UI polls `GET /me/mentions`. Live Graph **does** have a mention (`@vigrox.kw` tagged `@danatfuture` at `2026-08-22T21:58:44Z`). It was **never persisted** (`threads_mentions` empty for this account) and **never delivered** as `comment.received`. | High |
| 3 | "Threads inbox / message" trigger idle | Threads API has no messaging. `message.received` is FB/IG/WhatsApp only. | High |
| 4 | Comment → Reply node seems fine | `POST /api/v1/comments/reply` returned **200** at `2026-08-22 22:03:27Z` for this user. Action node works; trigger never feeds it. | High |
| 5 | Even if Meta starts sending `replies` | `threads-webhook` looks up `social_accounts.platform_user_id = payload.target_id`. For replies, `target_id` is the **media id**, so the row is skipped (`no account for threads_user_id=…`). | High — code vs [Meta docs](https://developers.facebook.com/documentation/threads/webhooks) |
| 6 | Mentions refresh would still miss the Comment Trigger | `threads-mentions` poll dispatches only `threads.mention.created`. Danat's n8n sub is `comment.received`. Log: `2 webhook(s) configured … none subscribed to threads.threads`. | High |

**Do not change the n8n community node first.** The trigger is a passthrough. Fix Meta webhook delivery + the `target_id` lookup + make the mentions poll emit `comment.received` when `comment_automation_handler = n8n`.

---

## How the system is wired

```
Meta Threads
  ├─ Polling (UI only — never required for n8n)
  │    threads-replies   GET /{id}/replies | /conversation | /me/threads
  │    threads-mentions  GET /me/mentions  → upsert threads_mentions
  │         └─ dispatch threads.mention.created   ← NOT comment.received
  │
  └─ Webhooks (the only real-time n8n path)
       POST /functions/v1/threads-webhook
         field=replies  → social_inbox_events + comment.received   [if handler=n8n]
         field=mentions → threads_mentions + threads.mention.created
                        + comment.received (kind=mention)          [if handler=n8n]
              └─ n8nMessagingDispatch
                    SELECT app_settings n8n_webhook_{userId}_%
                    POST n8n callback  → Postora Trigger / Comment Trigger
```

Gate: `account_metadata.comment_automation_handler === "n8n"` (default `"off"`).
Own-author events are dropped (`isOwnComment`) so an n8n reply cannot loop.

Facebook/Instagram comments already follow this pattern in `facebook-instagram-webhook`. Threads was added 2026-08-22 (`docs/superpowers/specs/2026-08-22-n8n-comment-trigger-and-automation-handler-design.md`).

---

## Live evidence (`@danatfuture`)

### Account

| Field | Value |
|---|---|
| `social_accounts.id` | `13a49575-620c-4c37-8b85-3cecdbba54c9` |
| `platform_user_id` | `28097456199906758` |
| username | `danatfuture` |
| owner | `danatfuture@gmail.com` (`12f4ba6a-91a8-4ab7-9286-dd27e8a9db61`) |
| connected | 2026-08-21 18:22 UTC (token expires 2026-10-20) |
| `comment_automation_handler` | **`n8n`** (gate is open) |
| `automation_handler` | unset → messages default `internal` (irrelevant: no Threads DMs) |
| `needs_reauth` | false |
| stored `granted_scopes` | `threads_basic`, `threads_content_publish`, `threads_manage_insights`, `threads_profile_discovery`, `threads_keyword_search`, `threads_location_tagging`, `threads_manage_mentions` |
| **missing from stored scopes** | `threads_read_replies`, `threads_manage_replies` (OAuth *requests* them; `threads-oauth` never probes replies, so the array is incomplete) |
| capability probe | `canManageMentions: true` |

Live Graph against this token (2026-08-23):

- `GET /me/mentions?fields=id,text,username,timestamp&limit=3` → **hit**: id `17951103888215205`, text `@danatfuture`, username `vigrox.kw`, `2026-08-22T21:58:44+0000`
- `GET /me/replies?fields=id&limit=1` → **hit**: id `18146803309475400` (polling replies works)
- `GET /me/permissions` → Threads Graph does not expose this field (error 100). Do not use it as a probe.

### n8n subscriptions (this user)

Registered `2026-08-22T21:56:25Z` / `21:56:27Z` after several delete+recreate cycles. Both active. Host `https://n8n.walidmohamed.com` (path `/postora` = **Postora Trigger**, not Comment Trigger).

| events | callback |
|---|---|
| `["message.received"]` | `…/webhook/e897bba5-…/postora` |
| `["comment.received"]` | `…/webhook/09f0c6aa-…/postora` |

No `platform` / `social_account_id` filter (accepts all accounts). That is fine.

`POST /api/v1/comments/reply` **200** at `22:03:27Z` — ~5 minutes after the vigrox mention. The action node is healthy.

### Persistence (this is the n8n gap)

| table | `@danatfuture` | global Threads |
|---|---|---|
| `social_inbox_events` (replies webhook persist) | **0** | **0** |
| `threads_mentions` | **0** | 2 old rows for `@daressny.kw` (2026-06, `source=manual`) |

`social_inbox_events.platform` CHECK **does** include `threads`. Schema is not the blocker.

### Edge logs (`threads-webhook`, last 72h)

```
[threads-webhook] verify ok          ← Meta GET hub.challenge succeeded (callback URL + verify token are correct)
[threads-webhook] verify failed      ← older code / a bad token attempt
[threads-webhook] rejected POST: missing-header   ← unsigned POST, not a real Meta delivery
```

Absent, which would appear on a real event:

- `no account for threads_user_id=…`
- `inbox persist failed`
- `skipped own reply`
- any `n8n-dispatch` POST to `n8n.walidmohamed.com`

Present for this user (from a `threads.mention.created` envelope, almost certainly a poll/test, **not** `comment.received`):

```
[n8n-dispatch] 2 webhook(s) configured for user 12f4ba6a-… but none subscribed to threads.threads
```

`aliasEvent("threads.mention.created")` is `threads.threads`. The two subs are `message.received` and `comment.received`, so the mention envelope is dropped on purpose. `comment.received` was never built for this mention.

`THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_WEBHOOK_VERIFY_TOKEN` are **set** in the functions `.env`. `config.toml` has `[functions.threads-webhook] verify_jwt = false`.

### Timeline that should have produced an n8n execution (and did not)

| UTC | What |
|---|---|
| 21:56:25–27 | n8n registers `message.received` + `comment.received` |
| 21:58:44 | `@vigrox.kw` mentions `@danatfuture` (live Graph) |
| 22:03:27 | n8n Comment → Reply **200** (manual/agent, not trigger-fed) |

No `threads-webhook` signed POST, no `threads_mentions` row, no `comment.received` delivery.

---

## Meta App permissions / webhook checklist (do this in App Dashboard)

Official rules: [Webhooks for Threads](https://developers.facebook.com/documentation/threads/webhooks) (updated 2026-06-30).

**Without Advanced Access, Meta will not send live webhooks.** Polling still works. That is exactly this incident.

Confirm all of the following on the **Threads** app (`THREADS_APP_ID`, not the Facebook app):

1. **Use case** — Threads API → Customize → add sub-use case **Get real-time notifications with Threads Webhooks**.
2. **Callback** — `https://api.postora.cloud/functions/v1/threads-webhook`  
   Verify token = `THREADS_WEBHOOK_VERIFY_TOKEN`. Logs already show `verify ok`, so this is likely done.
3. **Subscribe fields**
   - Topic **Interaction** → `mentions` (needs `threads_basic` + `threads_manage_mentions`)
   - Topic **Moderate** → `replies` (needs `threads_basic` + `threads_read_replies`)  
   This `replies` subscription is **manual** and is called out in the 2026-08-22 design as the usual miss.
4. **Access level** — `threads_manage_mentions` and `threads_read_replies` must be **Advanced Access** (or the app in Live Mode for non-tech providers). Standard Access / tester-only = poll works, webhooks do not.
5. **Testers** — until Advanced Access, `@danatfuture` and whoever comments/mentions must be Threads testers on that app. Related live error on **Waleed's** accounts at 21:33 UTC:  
   `"This action requires the threads_basic permission. You must submit for app review, or your user must be in the list of Threads testers."`  
   (mis-classified as `invalid_media_id` in `threads-replies` — separate bug.)
6. **Business verification** — required for live webhook notifications.
7. **Reconnect** `@danatfuture` after enabling `threads_read_replies` / `threads_manage_replies` at app level so the token actually carries them. Stored `granted_scopes` currently omits both (OAuth asks for them; Meta drops scopes that are not enabled).
8. **Private accounts** — Meta will not send reply/mention webhooks if the media owner is private.

There is **no** `/{user}/subscribed_apps` call in `threads-oauth` (unlike Facebook pages / Instagram / WhatsApp). Threads webhooks are **app-dashboard field subscriptions**, not per-user `subscribed_apps`. Do not copy the FB page subscribe pattern here unless Meta docs change.

---

## Code defects (fix after / alongside Meta)

### P0 — `threads-webhook` replies lookup uses the wrong id

File: `supabase/functions/threads-webhook/index.ts` (local **and** deployed; same logic).

```ts
const threadsUserId = change.targetId || change.value?.recipient_id || change.value?.root_post?.owner_id;
```

Meta replies payload ([docs](https://developers.facebook.com/documentation/threads/webhooks)):

- `target_id` = **media id** of the reply/root
- `values.value.root_post.owner_id` = Threads user id of the post owner
- mentions: `target_id` **is** the mentioned user id (current code is correct for mentions only)

Because `targetId` is first, a real `replies` delivery looks up `platform_user_id = <media_id>`, finds nothing, logs `no account for threads_user_id=…`, and never inserts `social_inbox_events` or dispatches n8n.

**Fix:** for `field === "replies"` resolve the user as `value.root_post.owner_id || value.recipient_id || entry.id`, **never** `target_id`. Keep `target_id` for `mentions`. Add a Deno test with the sample payload from Meta's docs (`topic: moderate`, `values.field: replies`).

`extractThreadsChanges` already understands both `entry[].changes[]` and the flat `{ topic, target_id, values: { field, value } }` envelope. Do not rip that out.

### P0 — mentions poll does not emit `comment.received`

File: `supabase/functions/threads-mentions/index.ts` (~L350).

On new mention it only fires `threads.mention.created`. Danat's Comment/Trigger workflows subscribe to `comment.received`. Refreshing the Mentions tab therefore cannot start n8n.

Mirror the webhook mention branch: if `resolveCommentAutomationHandler === "n8n"` and not `isOwnComment`, also `dispatchN8nEvent(..., buildCommentPayload({ kind: "mention", ... }))`.

Optional but useful: a **replies poll fallback** in `threads-replies` or a small cron that diffs `GET /{user}/replies` into `social_inbox_events` and dispatches `comment.received` when Meta webhooks are unavailable (Standard Access / pending review). Without this, n8n Threads comments stay dead until App Review.

### P1 — log alias `threads.threads`

File: `supabase/functions/_shared/n8nMessagingDispatch.ts` `aliasEvent`.

`threads.mention.created` logs as `threads.threads`, which hid the real event in this investigation. Log `payload.event` **and** the alias.

### P1 — `threads-oauth` never records reply scopes

File: `supabase/functions/threads-oauth/index.ts`.

It probes mentions/insights/discovery/search/location, then always pushes `threads_basic` + `threads_content_publish`. It never probes `/me/replies` or `/me/permissions` (the latter 100s on Threads Graph). Stored `granted_scopes` looking "complete" without `threads_read_replies` is misleading. Probe `GET /{id}/replies?fields=id&limit=1` and add `threads_read_replies` when it succeeds.

### P2 — local vs deployed `threads-webhook` drift

Deployed volume has `SignatureCheck` (`missing-header` | `mismatch` | …). Local repo still has the boolean `verifySignature` + `"invalid signature"`. Keep the deployed diagnostic version; copy it back into git before further edits, then deploy via `docs/runbooks/deploy-edge-function.md` (`docker compose restart functions`, **not** `npx supabase functions deploy`).

### Out of scope / do not "fix"

- **n8n node trigger passthrough** — `PostoraTrigger.webhook()` / `PostoraCommentTrigger.webhook()` already emit the POST body. No node change required for "no data".
- **Cross-user account access** — previous 2026-08-22 Message → Reply 404 was a different bug (WhatsApp owned by Waleed, API key owned by Danat).
- **Threads DMs** — do not invent `message.threads`. Meta has no Threads messaging API.
- **Vendored node under Postora** — deleted 2026-08-22; node work lives only in `F:\N8N\Postora-n8n-community-node`.

---

## n8n workflow guidance (ops, not code)

On the Danat workflows at `n8n.walidmohamed.com`:

1. **Comment path** — Postora Trigger (or Postora Comment Trigger) Events = `comment.received` **and** `threads.mention.created` until the poll path also emits `comment.received`. Platform = Threads, Account = `@danatfuture` if using Comment Trigger.
2. **Do not** expect `message.received` to fire for Threads inbox. Use Comment Trigger / `comment.received` with `comment.kind` = `reply` | `mention`.
3. Confirm Messaging → `@danatfuture` → Automation → Comments = **n8n** (already set).
4. After Meta Advanced Access + the `target_id` fix: comment on a `@danatfuture` post from a **tester** account, then check in order:
   1. functions log `[threads-webhook]` without `rejected POST` / `no account`
   2. `social_inbox_events` row, platform=`threads`
   3. n8n execution on the `comment.received` workflow
5. Community nodes do not auto-update. If the Comment Trigger / Comment resource is missing, update `n8n-nodes-postora` in n8n Settings → Community Nodes (local package is `1.4.1`).

---

## Suggested implementation order for Claude Code

1. **Bring git `threads-webhook` in line with deployed** (keep `SignatureCheck` logs).
2. **Failing Deno test** for Meta's sample `replies` payload: `target_id` is a media id, `root_post.owner_id` is `28097456199906758` → account is found, `social_inbox_events` insert attempted, envelope `event=comment.received`, `comment.kind=reply`.
3. **Fix the replies user-id resolution** (P0).
4. **Failing test** for `threads-mentions` refresh: new mention + `comment_automation_handler=n8n` → both `threads.mention.created` **and** `comment.received`.
5. **Emit `comment.received` from the mentions poll** (P0).
6. **Fix `aliasEvent` log** (P1).
7. **Probe `threads_read_replies` in oauth** (P1).
8. Deploy `threads-webhook`, `threads-mentions`, `_shared/n8nMessagingDispatch.ts`, `threads-oauth` per `docs/runbooks/deploy-edge-function.md`. SHA256 local↔volume, then `docker compose restart functions`.
9. **Do not** ship an n8n node release unless you also add a replies poll fallback that the node needs to document. Node tests should stay green; no trigger contract change is required for (1)–(7).
10. After deploy, ask the human to complete the Meta Dashboard checklist, then re-test with a tester mention + tester reply on `@danatfuture`.

Guards: `clean-code-guard` on production diffs, `test-guard` on new Deno tests. Commit only the files for this fix. Save a mem0 summary when the fix lands.

---

## Verification queries (post-fix)

```sql
-- Replies webhook persist
SELECT id, event_type, external_event_id, created_at
FROM social_inbox_events
WHERE social_account_id = '13a49575-620c-4c37-8b85-3cecdbba54c9'
ORDER BY created_at DESC LIMIT 20;

-- Mentions persist
SELECT mention_id, mention_author_username, source, created_at
FROM threads_mentions
WHERE social_account_id = '13a49575-620c-4c37-8b85-3cecdbba54c9'
ORDER BY created_at DESC LIMIT 20;
```

```bash
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
docker compose logs --since 1h --no-color functions | grep -E '\[threads-webhook\]|\[n8n-dispatch\]'
```

Expect: signed POST processed, account match, then either a delivery to `n8n.walidmohamed.com` or a **specific** unmatched-event log that names `comment.received` / `comment.threads`, not `threads.threads`.
