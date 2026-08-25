# Postora n8n `comment.received` trigger diagnosis

Date: 2026-08-22  
Scope: source/readme diagnosis only; no fix was written and production was not queried.

## Executive conclusion

The strongest source-based hypotheses are:

1. **The Facebook account's Comments automation handler was not `n8n`.** The default is `off`, and dispatch is entered only for the exact value `n8n` (`supabase/functions/_shared/automationHandler.ts:18-21`, `supabase/functions/facebook-instagram-webhook/index.ts:250-263`). The UI itself warns that comments reach n8n only while this is selected (`src/components/messaging/AutomationHandlerCard.tsx:96-107`).
2. **The workflow was created with node v1.2.1 (or retained its old subscription).** v1.2.1 predates comment automation: the repository records Comment Trigger as added in v1.3.0 and comment events on the main trigger as added in v1.3.1 (`CLAUDE.md:25-28`). Thus a v1.2.1 main-trigger subscription cannot have selected `comment.received`; an old persisted `events` array remains nonmatching unless re-registration explicitly replaces it. There is no implicit wildcard for settings-registry subscriptions (`supabase/functions/_shared/n8nMessagingDispatch.ts:315-328`).
3. **The comment was authored as the Page.** Facebook `from.id` equal to the connected Page's `platform_user_id` is deliberately classified as an own comment and skipped (`supabase/functions/_shared/commentAuthor.ts:22-39`, `supabase/functions/facebook-instagram-webhook/index.ts:241-248`). A Page admin acting as the Page therefore follows this skip path.
4. **A subscription existed but was filtered out or inactive** because its event list, `platform`, `social_account_id`, owner, URL, or active state did not match (`supabase/functions/_shared/n8nMessagingDispatch.ts:262-305`, `supabase/functions/_shared/n8nMessagingDispatch.ts:315-328`). Comment Trigger writes both optional filters when selected (`Postora-n8n-community-node/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts:21-35`, `Postora-n8n-community-node/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts:157-166`).
5. **The event was persisted but then suppressed as duplicate, failed normalization, or failed during best-effort delivery.** Persistence occurs before normalization, own-author detection, handler gating, subscription matching, and HTTP delivery (`supabase/functions/facebook-instagram-webhook/index.ts:227-263`). There is no durable outbox behind background dispatch (`supabase/functions/_shared/background.ts:7-20`).

The fact that the comment appears in Comment Manager does **not** prove that any webhook row or n8n dispatch succeeded. The UI calls the `comment-manager` function, which fetches the current comments, and only uses `social_inbox_events` as a realtime refetch signal (`src/hooks/useCommentInbox.ts:143-170`).

## 1. Full ordered gate list: Meta POST to n8n callback

This is the ordered path for a Facebook comment change, including every relevant early return/`continue`.

### A. Request/envelope gates

1. The request must be `POST`; `OPTIONS`, `GET`, and other methods return on separate paths (`supabase/functions/facebook-instagram-webhook/index.ts:92-115`, `supabase/functions/facebook-instagram-webhook/index.ts:294-296`).
2. `FACEBOOK_APP_SECRET` and `x-hub-signature-256` must both exist, or the function returns 401 (`supabase/functions/facebook-instagram-webhook/index.ts:115-124`).
3. The HMAC signature must validate, or the function returns 401 (`supabase/functions/facebook-instagram-webhook/index.ts:126-132`).
4. The body must parse and processing must not throw; the outer catch returns 500 (`supabase/functions/facebook-instagram-webhook/index.ts:134-143`, `supabase/functions/facebook-instagram-webhook/index.ts:287-292`).
5. The body must contain an `entry`, and that entry must contain a `changes` element; absent arrays simply produce no loop iteration (`supabase/functions/facebook-instagram-webhook/index.ts:143-145`, `supabase/functions/facebook-instagram-webhook/index.ts:227-227`).

### B. Account and inbox/idempotency gates

6. `entry.id` must resolve to an **active Facebook** `social_accounts` row by `platform_user_id`; otherwise `findAccountForRecipient` returns null (`supabase/functions/facebook-instagram-webhook/index.ts:29-43`).
7. `change.value.comment_id` or `change.value.id` must exist. Missing account or external ID executes `continue` (`supabase/functions/facebook-instagram-webhook/index.ts:227-230`).
8. The upsert to `social_inbox_events` must return an inserted row. A database error or an already-existing `(social_account_id, external_event_id)` produces `error`/`duplicate`, and `inboxResult !== "inserted"` executes `continue` (`supabase/functions/facebook-instagram-webhook/index.ts:232-239`, `supabase/functions/facebook-instagram-webhook/index.ts:299-321`).

### C. Comment eligibility and account routing gates

9. Facebook normalization requires `field === "feed"`, `item === "comment"`, `verb === "add"`, and `comment_id`; otherwise it returns null and the caller continues (`supabase/functions/facebook-instagram-webhook/commentEvents.ts:14-22`, `supabase/functions/facebook-instagram-webhook/index.ts:241-242`). Deletes, edits, likes, and reactions intentionally fail this gate.
10. The author must not be the connected account. For Facebook, matching `author.id` against `platform_user_id` returns true; the caller continues without dispatch (`supabase/functions/_shared/commentAuthor.ts:22-39`, `supabase/functions/facebook-instagram-webhook/index.ts:243-248`).
11. `resolveCommentAutomationHandler(account_metadata)` must equal **exactly** `n8n`. Missing, invalid, or `off` resolves to `off`; `internal` routes to Postora automation instead (`supabase/functions/_shared/automationHandler.ts:18-21`, `supabase/functions/facebook-instagram-webhook/index.ts:250-263`).

### D. Background/dispatcher gates

12. `runInBackground` invokes the dispatcher. With `EdgeRuntime.waitUntil`, it registers the guarded promise and returns; without it, it waits only up to two seconds. Errors are caught and logged rather than propagated (`supabase/functions/_shared/background.ts:22-54`).
13. Both registry queries must succeed: `app_settings` keys matching `n8n_webhook_<account.user_id>_%` and legacy `whatsapp_webhooks` rows for that user. Either query error throws before matching/delivery (`supabase/functions/_shared/n8nMessagingDispatch.ts:262-275`).
14. A settings destination must have `value.is_active === true` and a nonblank `webhook_url` (`supabase/functions/_shared/n8nMessagingDispatch.ts:276-305`).
15. Legacy `whatsapp_webhooks` destinations are always rejected for comments; they accept message envelopes only (`supabase/functions/_shared/n8nMessagingDispatch.ts:315-321`).
16. If present, subscription `platform` must equal payload `facebook` (`supabase/functions/_shared/n8nMessagingDispatch.ts:322-322`).
17. If present, subscription `social_account_id` must equal the internal `social_accounts.id` placed in the payload (`supabase/functions/_shared/n8nMessagingDispatch.ts:138-153`, `supabase/functions/_shared/n8nMessagingDispatch.ts:323-323`).
18. A settings subscription must have an array `events`; missing/null and malformed values do not match. The array must contain `*`, `comment.received`, or the alias `comment.facebook` (`supabase/functions/_shared/n8nMessagingDispatch.ts:308-328`). There is no default wildcard during dispatch.
19. Matching destinations are deduplicated by exact URL. A later duplicate URL is silently removed (`supabase/functions/_shared/n8nMessagingDispatch.ts:331-337`).
20. At least one unique destination must remain; otherwise dispatch returns after logging either “none subscribed” or “no webhook destinations” (`supabase/functions/_shared/n8nMessagingDispatch.ts:217-235`).
21. The fan-out deadline must not already have elapsed when the destination is selected; otherwise it is counted as skipped and the loop continues (`supabase/functions/_shared/n8nMessagingDispatch.ts:236-259`).
22. Signing must complete if a secret is configured, and the outbound request must pass `postWebhook` validation/network handling, complete within the five-second timeout, and return an HTTP `2xx`. Any failure is caught, increments `failure_count`, and does not reach n8n workflow execution (`supabase/functions/_shared/n8nMessagingDispatch.ts:340-371`).
23. After ten consecutive failed deliveries, the destination is written inactive, causing subsequent events to fail gate 14 (`supabase/functions/_shared/n8nMessagingDispatch.ts:389-401`).
24. Finally, n8n itself must still expose the registered callback and have the workflow active. The node merely returns HTTP 200 and passes the received body into workflow data once n8n invokes its webhook handler (`Postora-n8n-community-node/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts:113-186`).

## 2. Which failures coexist with a visible Comment Manager row?

Strictly, **the Comment Manager does not read a persisted comment row at all**. Its query invokes `comment-manager` with `get_page_comments`/`get_ig_comments`, parses the returned Meta data, and refetches every 30 seconds (`src/hooks/useCommentInbox.ts:143-164`). `social_inbox_events` only triggers realtime query invalidation (`src/hooks/useCommentInbox.ts:165-170`). Therefore, a comment can appear in the UI even if Meta never delivered this webhook request, signature validation failed, account resolution failed, or any later gate failed.

Within the webhook path, the table written before dispatch is **`social_inbox_events`** (`supabase/functions/facebook-instagram-webhook/index.ts:299-316`). Gates 9-24 happen after a successful insert and thus can definitely coexist with that inbox row. Gate 8's duplicate case also coexists with an already-present row. Gates 1-7 can coexist with UI visibility because the UI independently reads Meta, but they would not create the inbox row from this delivery.

## 3. Ranked hypotheses and production checks

Replace `:account_id`, `:user_id`, `:page_id`, `:comment_id`, `:since_utc`, and `:callback_fragment` before running SQL or log searches. Queries are read-only.

### 1 — Comments handler is `off`, missing/invalid, or `internal` (very high likelihood)

**What must be true:** `account_metadata.comment_automation_handler` is absent, `off`, invalid, or `internal`. Absent/invalid defaults to `off`; only `n8n` reaches dispatch (`supabase/functions/_shared/automationHandler.ts:18-21`, `supabase/functions/facebook-instagram-webhook/index.ts:250-263`). The UI defaults its selector display to `off` and explicitly states the requirement (`src/components/messaging/AutomationHandlerCard.tsx:96-107`).

```sql
select id, user_id, platform, platform_user_id, platform_username, is_active,
       account_metadata->>'comment_automation_handler' as comment_automation_handler
from public.social_accounts
where id = :account_id or (platform = 'facebook' and platform_user_id = :page_id);
```

Log confirmation/refutation:

```text
grep -E "Received verified facebook event|skipped own facebook comment|facebook-instagram comment dispatch|facebook-instagram comment automation" <functions-log>
```

An inserted `social_inbox_events` row with no dispatch/automation line plus a non-`n8n` metadata value confirms this gate.

### 2 — v1.2.1/old subscription does not include `comment.received` (very high if the installed node is old)

**What must be true:** the workflow was activated with v1.2.1, or its persisted registration was never recreated after upgrading. The project history says the separate Comment Trigger arrived in v1.3.0 and the main trigger gained comment events only in v1.3.1 (`CLAUDE.md:25-28`). Current main-trigger source shows `comment.received` now exists but still defaults to only `post.completed` (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:45-95`). Current README says event-selection changes take effect on activation and documents older stale-registration behavior (`Postora-n8n-community-node/README.md:38-54`, `Postora-n8n-community-node/README.md:73-73`).

`loadDestinations` does **not** treat an old settings subscription as wildcard: absent events returns false for settings; an array matches only explicit `*`, exact event, or platform alias (`supabase/functions/_shared/n8nMessagingDispatch.ts:315-328`). Therefore a v1.2.1 subscription whose events are `post.completed`/`message.*` silently drops the comment.

```sql
select key,
       value->>'webhook_id' as webhook_id,
       value->'events' as events,
       value->>'webhook_url' as webhook_url,
       value->>'is_active' as is_active,
       value->>'created_at' as created_at
from public.app_settings
where key like 'n8n_webhook_' || :user_id || '_%'
order by created_at;
```

```text
grep -E "webhook\(s\) configured.*none subscribed to comment.facebook|no webhook destinations" <functions-log>
```

Confirm the installed community package in n8n itself with `npm list n8n-nodes-postora` (or inspect Settings → Community Nodes). A true v1.2.1 installation cannot contain `Postora Comment Trigger` at all.

### 3 — The Page authored the comment (high when the admin commented “as Page”)

**What must be true:** the webhook's `value.from.id` equals the connected Page's `platform_user_id`. That exact equality is `isOwnComment` for Facebook (`supabase/functions/_shared/commentAuthor.ts:22-39`). The skip is intentionally ahead of both n8n and internal branches (`supabase/functions/facebook-instagram-webhook/index.ts:241-263`). Thus a Page admin acting as the Page is skipped; an admin commenting from their personal profile is not skipped unless Meta reports the Page ID as author.

```sql
select e.external_event_id,
       e.payload->'value'->'from'->>'id' as author_id,
       a.platform_user_id as connected_page_id,
       (e.payload->'value'->'from'->>'id' = a.platform_user_id) as is_own
from public.social_inbox_events e
join public.social_accounts a on a.id = e.social_account_id
where e.event_type = 'comment'
  and e.external_event_id = :comment_id;
```

```text
grep -F "skipped own facebook comment :comment_id" <functions-log>
```

### 4 — Subscription event/platform/account/owner mismatch or inactive/blank destination (high)

**What must be true:** a subscription exists but one of its filters fails. Settings are loaded only under the receiving account's `user_id`; subscriptions created by a different API-key owner are invisible (`supabase/functions/_shared/n8nMessagingDispatch.ts:217-232`, `supabase/functions/_shared/n8nMessagingDispatch.ts:262-305`). Then `is_active`, URL, platform, account ID, and events are all conjunctive gates (`supabase/functions/_shared/n8nMessagingDispatch.ts:302-328`).

Comment Trigger does write selected platform/account filters into the registration and later compares them during lifecycle checks (`Postora-n8n-community-node/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts:21-35`, `Postora-n8n-community-node/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts:132-166`). A stale or wrong selected UUID therefore silently drops the event.

```sql
with account as (
  select id, user_id, platform from public.social_accounts where id = :account_id
)
select s.key, s.value->>'user_id' as registered_user_id,
       s.value->>'webhook_url' as webhook_url,
       s.value->'events' as events,
       s.value->>'platform' as platform_filter,
       s.value->>'social_account_id' as account_filter,
       s.value->>'is_active' as is_active,
       s.value->>'failure_count' as failure_count,
       a.id as actual_account_id, a.user_id as actual_user_id, a.platform as actual_platform
from public.app_settings s cross join account a
where s.key like 'n8n_webhook_%';
```

Refute/confirm by checking that at least one row has the actual owner prefix, nonblank URL, `is_active=true`, platform null/`facebook`, account null/actual UUID, and events containing `comment.received`, `comment.facebook`, or `*`.

### 5 — Duplicate/idempotency suppression after an earlier attempt (medium-high)

**What must be true:** `(social_account_id, external_event_id)` already existed. The upsert ignores duplicates, and only a newly inserted row proceeds (`supabase/functions/facebook-instagram-webhook/index.ts:232-239`, `supabase/functions/facebook-instagram-webhook/index.ts:299-321`). If the first attempt inserted the row but later background delivery failed, a Meta retry cannot retry n8n delivery. There is no durable outbox (`supabase/functions/_shared/background.ts:20-20`).

```sql
select id, user_id, social_account_id, platform, event_type, external_event_id, created_at,
       payload->'value'->>'verb' as verb
from public.social_inbox_events
where social_account_id = :account_id and external_event_id = :comment_id;
```

Compare its `created_at` with delivery errors in logs. A row preceding a background/n8n error, followed by another verified Meta delivery with no dispatch, supports this hypothesis.

### 6 — Outbound callback failed or subscription auto-disabled (medium)

**What must be true:** callback target validation, DNS/connectivity, TLS, timeout, HTTP status, or n8n webhook availability failed. Delivery has a five-second request timeout and catches every failure (`supabase/functions/_shared/n8nMessagingDispatch.ts:121-123`, `supabase/functions/_shared/n8nMessagingDispatch.ts:340-371`). Ten failures set `is_active=false` (`supabase/functions/_shared/n8nMessagingDispatch.ts:389-401`).

```sql
select key, value->>'webhook_url' as webhook_url,
       value->>'failure_count' as failure_count,
       value->>'is_active' as is_active
from public.app_settings
where key like 'n8n_webhook_' || :user_id || '_%';
```

```text
grep -E "\[n8n-dispatch\].*failed|HTTP [0-9]{3}|fan-out deadline hit|\[background\].*failed" <functions-log>
grep -F ":callback_fragment" <n8n-log>
```

Absence in n8n access logs plus a Postora delivery error confirms failure before n8n; n8n HTTP access with no workflow execution shifts diagnosis into n8n workflow state/routing.

### 7 — Event persisted, but normalization rejected its shape (medium)

**What must be true:** Meta supplied an ID that allowed persistence, but the change was not `feed/comment/add` (or lacked `comment_id`). Persistence precedes normalization (`supabase/functions/facebook-instagram-webhook/index.ts:227-242`), while normalization intentionally rejects edits/removes/likes/reactions (`supabase/functions/facebook-instagram-webhook/commentEvents.ts:14-22`).

```sql
select external_event_id, created_at,
       payload->>'field' as field,
       payload->'value'->>'item' as item,
       payload->'value'->>'verb' as verb,
       payload->'value'->>'comment_id' as comment_id
from public.social_inbox_events
where social_account_id = :account_id
  and event_type = 'comment'
  and created_at >= :since_utc
order by created_at desc;
```

Only `feed/comment/add` with `comment_id` refutes this hypothesis.

### 8 — Best-effort background execution was interrupted (medium-low, but real)

**What must be true:** runtime background work did not finish. `waitUntil` is explicitly intended to keep work alive after response, so returning first alone should **not normally** drop it (`supabase/functions/_shared/background.ts:7-18`, `supabase/functions/_shared/background.ts:41-44`). However delivery is explicitly best-effort and has no outbox (`supabase/functions/_shared/background.ts:20-20`). On a runtime without `waitUntil`, only a two-second inline cap is awaited, after which the still-running work is no longer protected (`supabase/functions/_shared/background.ts:46-54`). Instance termination or restart can therefore lose it.

```text
grep -E "\[background\] (waitUntil|degraded inline) path active|exceeded the 2s degraded cap|facebook-instagram comment dispatch failed" <functions-log>
```

Container restart evidence at the same timestamp plus an inserted inbox row and no dispatcher result supports this; a normal `waitUntil` path with a logged downstream filtering/delivery result refutes it.

### 9 — Account lookup/external event ID gate failed (low given an inbox row, still plausible given UI visibility)

**What must be true:** `entry.id` did not match an active Facebook `platform_user_id`, or the change lacked both candidate IDs (`supabase/functions/facebook-instagram-webhook/index.ts:29-43`, `supabase/functions/facebook-instagram-webhook/index.ts:227-230`). This creates no inbox row, yet the UI can still show the comment because it fetches Meta independently.

```sql
select id, user_id, platform, platform_user_id, is_active
from public.social_accounts
where platform = 'facebook' and platform_user_id = :page_id;

select * from public.social_inbox_events
where platform = 'facebook' and external_event_id = :comment_id;
```

```text
grep -E "Received verified facebook event|No matching facebook account found|entry produced no inbound message" <functions-log>
```

Note: the “No matching” warning is emitted in the messaging loop, not the changes loop, so SQL plus the envelope-shape log is stronger evidence for a comment-only entry.

### 10 — Dispatcher registry query failed, fan-out deadline skipped it, or URL dedupe altered fan-out (low)

**What must be true:** either registry query errored (both are mandatory), a large fan-out exhausted the 10-second start deadline, or multiple matching subscriptions shared the same exact URL and later rows were deduplicated (`supabase/functions/_shared/n8nMessagingDispatch.ts:236-259`, `supabase/functions/_shared/n8nMessagingDispatch.ts:262-275`, `supabase/functions/_shared/n8nMessagingDispatch.ts:331-337`). URL dedupe should still call the shared n8n URL once, so it explains missing per-subscription accounting more readily than a completely missing workflow execution.

```sql
select value->>'webhook_url' as webhook_url, count(*) as registrations,
       jsonb_agg(jsonb_build_object('key', key, 'events', value->'events', 'active', value->'is_active')) as rows
from public.app_settings
where key like 'n8n_webhook_' || :user_id || '_%'
group by value->>'webhook_url'
having count(*) > 1;
```

```text
grep -E "app_settings|whatsapp_webhooks|fan-out deadline hit|\[background\] facebook-instagram comment dispatch failed" <functions-log>
```

### 11 — Meta request/signature/body never reached the eligible loop (low because other webhook evidence is absent)

**What must be true:** Meta did not POST this change, used an invalid/missing signature, sent a body without the needed `entry.changes`, or parsing/processing threw (`supabase/functions/facebook-instagram-webhook/index.ts:114-143`, `supabase/functions/facebook-instagram-webhook/index.ts:227-280`, `supabase/functions/facebook-instagram-webhook/index.ts:287-292`). Again, UI visibility is independent.

```text
grep -E "Received verified facebook event|Webhook processing failed|Unauthorized|entry produced no inbound message" <gateway-and-functions-log>
```

Correlate with Meta App Dashboard webhook delivery history for the Page, timestamp, response status, and payload fields.

## 4. Direct answers to the brief's focused questions

1. **Full ordered conditions:** enumerated in section 1 (24 gates).
2. **Can it still show in Comment Manager?** Yes, for every gate. The UI reads current Meta data via `comment-manager`, not `social_inbox_events`; gates 9-24 occur after the inbox insert, and gate 8 duplicate implies a pre-existing row (`src/hooks/useCommentInbox.ts:143-170`, `supabase/functions/facebook-instagram-webhook/index.ts:227-263`).
3. **Default handler and required value:** default is `off`; the Page account needs `comment_automation_handler = 'n8n'` for n8n dispatch (`supabase/functions/_shared/automationHandler.ts:18-21`, `supabase/functions/facebook-instagram-webhook/index.ts:250-256`). The setting is per social account and is read/written through Messaging API (`supabase/functions/messaging-api/index.ts:324-375`).
4. **Own Page comment:** yes. A comment authored by the Page (including an admin acting as the Page, if Meta reports the Page ID) matches `platform_user_id` and is skipped (`supabase/functions/_shared/commentAuthor.ts:22-39`).
5. **v1.2.1 events:** no. Comment Trigger was introduced in v1.3.0 and main-trigger comment events in v1.3.1 (`CLAUDE.md:25-28`). If its settings subscription omits `comment.received`/`comment.facebook`, `loadDestinations` excludes it. There is a wildcard only when the stored array explicitly contains `"*"`; missing events are not wildcard for `app_settings` (`supabase/functions/_shared/n8nMessagingDispatch.ts:315-328`).
6. **Filters:** yes. Comment Trigger writes selected `platform` and `social_account_id`; either mismatch silently excludes the subscription (`Postora-n8n-community-node/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts:21-35`, `supabase/functions/_shared/n8nMessagingDispatch.ts:322-323`).
7. **Can response-first drop dispatch?** Normally no: `EdgeRuntime.waitUntil` is specifically used to keep it alive after return. But it remains best-effort with no outbox; degraded mode protects only two seconds, and runtime termination can lose work (`supabase/functions/_shared/background.ts:7-20`, `supabase/functions/_shared/background.ts:41-54`).
8. **Registry:** n8n subscription create/list/delete uses `app_settings` keys (`supabase/functions/n8n-api/index.ts:1496-1516`, `supabase/functions/n8n-api/index.ts:1544-1588`). Dispatcher also reads legacy `whatsapp_webhooks`, but it expressly rejects comment envelopes for that registry (`supabase/functions/_shared/n8nMessagingDispatch.ts:267-305`, `supabase/functions/_shared/n8nMessagingDispatch.ts:315-321`). The registries can disagree, but a comment registration existing only in legacy can never receive `comment.received`; legacy is message-only.

## 5. Fastest production triage order

1. Query the Facebook `social_accounts` row and verify `comment_automation_handler = 'n8n'`.
2. Query that owner's `app_settings` registrations and verify an active, nonblank matching row with `comment.received`, `comment.facebook`, or explicit `*`, plus matching/null filters.
3. Check the n8n installed package version and confirm the workflow was deactivated/reactivated after upgrade/event edits.
4. Inspect the `social_inbox_events` payload for the comment: author ID, `feed/comment/add`, Page/account IDs, and insert time.
5. Correlate Postora logs for own-comment skip, no matching subscription, background error, callback failure, deadline, or degraded cap; then correlate n8n access/execution logs.

