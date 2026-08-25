# Debug report: n8n Postora Comment Trigger never fires for a Facebook comment

Investigator: opencode · 2026-08-22 · Read-only investigation, no code changed.
Input: `.codex-briefs/comment-trigger-debug.md`

## 0. The single most important architectural fact

The Comment manager UI **does not read the webhook pipeline at all**. It polls the Meta
Graph API live every 30 s through the `comment-manager` edge function
(`get_page_comments`) — `src/hooks/useCommentInbox.ts:148-164` (action chosen at :148,
`refetchInterval: 30_000` at :163). `social_inbox_events` is used only to *invalidate*
that react-query cache (`useCommentInbox.ts:165-170`), never as the data source.

**Consequence:** "the comment appears in Comment manager" is evidence about the Page's
access token and the Graph API, and says *nothing* about whether Meta ever POSTed the
change to `facebook-instagram-webhook`, or about any gate after that. Every hypothesis
below — including "Meta never delivered the webhook" — is compatible with the symptom.

---

## 1. Full ordered condition list: Meta POST → n8n webhook URL called (Q1)

Every `continue`/early-return, in order. File `supabase/functions/facebook-instagram-webhook/index.ts` unless noted.

**Stage A — reaching the handler**
1. Request method is POST (OPTIONS served at :93-95, GET verification at :100-112; anything else → 405 :296).
2. `FACEBOOK_APP_SECRET` env set **and** `x-hub-signature-256` header present (:116-124) → else 401.
3. HMAC-SHA256 signature valid (:126-132) → else 401. *(A bad signature never even reaches `try` — comment invisible to the pipeline.)*

**Stage B — per change (`for (const change of entry?.changes || [])`, :227)**
4. `findAccountForRecipient` finds a `social_accounts` row with `platform = 'facebook'`, `platform_user_id = entry.id`, `is_active = true` (:228; query at :34-41) → else `continue` with log `No matching facebook account found` (:156).
5. `externalEventId = change.value.comment_id || change.value.id` non-empty (:229-230) → else `continue` (silent).
6. `recordInboxEvent` upserts into **`social_inbox_events`** (`onConflict: social_account_id,external_event_id`, :309-316). Result must be `"inserted"`:
   - `"error"` (DB error) → logs `Failed to persist inbox event` (:317-319) → `continue` (:239). Dispatch skipped by design (idempotency claim).
   - `"duplicate"` (Meta retry already seen) → silent `continue` (:239).
7. `normalizeMetaCommentChange(platform, change)` non-null (:241-242). For Facebook it requires `change.field === 'feed'` **and** `value.item === 'comment'` **and** `value.verb === 'add'` **and** `value.comment_id` (`facebook-instagram-webhook/commentEvents.ts:20-21`). Deletes/edits/reactions return null → silent `continue`.
8. `isOwnComment(account, normalized.author)` false (:245-248). True when `author.id` equals the account's `platform_user_id` (Page id) — `supabase/functions/_shared/commentAuthor.ts:34-35` — → `continue` with log `skipped own facebook comment <id>`.
9. `resolveCommentAutomationHandler(account.account_metadata) === 'n8n'` (:250-251). Default is **`'off'`** (`_shared/automationHandler.ts:19-22`) → neither branch runs, **no log at all**.

**Stage C — dispatch (`_shared/n8nMessagingDispatch.ts`), inside `runInBackground` (:252-256)**
10. `loadDestinations` DB reads succeed; thrown errors are swallowed by the background guard and logged as `[background] facebook-instagram comment dispatch failed:` (`_shared/background.ts:37-39`).
11. Destinations are looked up for **`account.user_id`** (the account owner), not the API-key owner: keys `n8n_webhook_<userId>_%` in `app_settings` + rows in `whatsapp_webhooks` (:267-272). Zero rows → log `[n8n-dispatch] no webhook destinations for user <id> platform facebook` and return (:232-234).
12. Per destination, `matchesSubscription` (:315-329) requires ALL of:
    - `isActive === true` and non-empty `url` (:302-304);
    - **legacy registry (`whatsapp_webhooks`) never receives comment events** (:321);
    - `destination.platform` unset or `=== payload.platform` (:322);
    - `destination.social_account_id` unset or `=== payload.social_account_id` (:323);
    - `events` is an array containing `"*"` or `"comment.received"` or the alias `"comment.facebook"` (:327-328; alias built at :310-313). `events: null` matches only on the legacy registry (:326) — i.e. never for comments.
    - Zero matches → warn `[n8n-dispatch] N webhook(s) configured for user <id> but none subscribed to comment.facebook` and return (:226-235).
13. URL-dedup across destinations (:331-338) — a duplicate-URL subscription is dropped, only one delivery per URL.
14. Fan-out bounded: 10 s overall deadline (:123, :236), 5 workers max (:121, :256), per-request 5 s timeout (:122, :364 via `postWebhook`). Skipped destinations log `[n8n-dispatch] fan-out deadline hit` (:257-259).
15. `postWebhook` re-validates the target (public HTTPS, per-hop on redirects) — `supabase/functions/_shared/webhookSecurity.ts:107-109` — and requires `response.ok`; failures increment `failure_count`, log `[n8n-dispatch] <url> failed:` (:363-371), and after **10 consecutive failures** the subscription is set `is_active: false` (:389-401) and never retried.
16. Background survival: on the `EdgeRuntime.waitUntil` path the dispatch survives the HTTP response (`_shared/background.ts:41-44`); on the degraded path (no `EdgeRuntime`) a **2 s cap** can abandon it with log `[background] facebook-instagram comment dispatch exceeded the 2s degraded cap` (:46-53). Which path is active is logged once per cold start (:26-29).

## 2. Which conditions can hold while the comment still shows in the UI? (Q2)

**All of them, including conditions upstream of Postora entirely** (see §0). The UI reads
Graph API directly. Within Postora's own pipeline, the `social_inbox_events` row is
written at step 6 — *before* the n8n-specific gates 7-15 — so even `normalize = null`,
`isOwnComment`, handler `off`, filter mismatches, and delivery failures all leave data the
UI can (and does, via Graph) show. The one gate that would also hide the row from the
pipeline (but not the UI) is a `recordInboxEvent` DB error or a missing/inactive
`social_accounts` row (steps 4, 6).

## 3. Default of `comment_automation_handler` (Q3)

Default is **`'off'`** — `_shared/automationHandler.ts:19-22` (any value outside
`['off','internal','n8n']`, including missing/null metadata, resolves to `'off'`;
pinned by `_shared/automationHandler.test.ts:17-23`). **Yes, the Page's account row must
have `account_metadata.comment_automation_handler = 'n8n'`** or step 9 silently drops the
event (`facebook-instagram-webhook/index.ts:250-256`). It is set from the web UI's
Automation card (Comments row, `src/components/messaging/AutomationHandlerCard.tsx:96-103`)
→ `messaging-api` action `set_automation_handlers` → RPC `patch_account_metadata`
(`supabase/functions/messaging-api/index.ts:335-367`). The node itself documents the
requirement in the Account field description
(`Postora-n8n-community-node/nodes/PostoraCommentTrigger/PostoraCommentTrigger.node.ts:70`).
(Side observation, not this bug: `messaging-api/index.ts:353-355` still rejects setting
`internal` for comments with "The Postora AI agent does not handle comments yet", while the
webhook already implements the `internal` branch (`index.ts:257-263`) — the UI option
"Postora AI Agent" for Comments currently 400s.)

## 4. Does `isOwnComment` skip the page's own comments? (Q4)

Yes. `commentAuthor.ts:34-35`: `author.id === account.platform_user_id` (the Page id for
Facebook) → true → `continue` with log `skipped own facebook comment`
(`facebook-instagram-webhook/index.ts:245-248`). So a comment written **by the Page** —
including the admin testing while "acting as the Page" on Facebook — is never dispatched,
even though Comment manager shows it (Graph API returns it like any comment).

## 5. Old-node (v1.2.1) subscriptions and `comment.received` (Q5)

**No.** Git history shows the `PostoraTrigger` events list at introduction offered only
`post.completed` (commit `5c94c207`), later `post.completed` + `message.received/whatsapp/instagram/facebook`
(commit `6092253c`). The comment options (`comment.received`, `comment.facebook`, …) were
only added in v1.3.0/v1.3.1 (`F:\Postora_new\CLAUDE.md:27-28`; current list at
`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:71-85`).
No `"*"` option was ever offered by the node (`*` is accepted server-side,
`n8n-api/index.ts:30-36`, but the old UI never sent it).

In `loadDestinations` there is **no backfill or upgrade**: a v1.2.1-era subscription whose
`events` array is e.g. `["post.completed","message.received"]` fails
`matchesSubscription` (:327-328) for every comment payload — silently except for the warn
at `:228-230`. And per `F:\Postora_new\CLAUDE.md:25`, **community nodes never auto-update
in n8n** — a stale package keeps producing exactly this until the user updates the package
and the workflow re-registers (the v1.3.x `checkExists` compares event sets and re-creates
the subscription on next activation, `PostoraTrigger.node.ts:106-161`).

## 6. Per-subscription `platform` / `social_account_id` filters (Q6)

Yes — `PostoraCommentTrigger` sends them when non-empty
(`PostoraCommentTrigger.node.ts:31-36`), validated by
`supabase/functions/n8n-api/webhookFilters.ts:6-21` (platform ∈ facebook/instagram/threads/whatsapp;
account must be a UUID owned by the caller, `n8n-api/index.ts:1482-1494`) and stored in the
`app_settings` value (:1505-1514). Dispatch enforces them at
`n8nMessagingDispatch.ts:322-323` with **no logging on filter mismatch** — a mismatch is
indistinguishable (log-wise) from "not subscribed", both funnel into the
`:228-230` warn. Classic silent-drop scenarios: the Page was **reconnected** (new
`social_accounts` row ⇒ new UUID, subscription still filters the old id), or the workflow
was configured with Account = a specific different Page than the one commented on.

## 7. Can `runInBackground` drop the dispatch? (Q7)

Only on the degraded path. `_shared/background.ts`: with `EdgeRuntime.waitUntil` the
promise is registered and survives the returned Response (:41-44) — this is the expected
path on the self-hosted supabase/edge-runtime container. Without `EdgeRuntime`, work is
awaited under a **2 s race cap** (:46-53) and the dispatch can be abandoned with
`[background] facebook-instagram comment dispatch exceeded the 2s degraded cap`. The
active path is logged once per instance: `[background] waitUntil path active` vs
`degraded inline` (:26-29) — check that line in production logs. Even on the waitUntil
path, `dispatchN8nEvent` itself bounds work at 10 s and logs skipped destinations
(`n8nMessagingDispatch.ts:236-259`).

## 8. Which registry holds the subscription; can they disagree? (Q8)

n8n trigger subscriptions live in **`app_settings`** under keys
`n8n_webhook_<userId>_<uuid>` (create: `n8n-api/index.ts:1496-1516`; list :1549-1570;
delete :1583-1588). The legacy **`whatsapp_webhooks`** table is *also* read by
`loadDestinations` (`n8nMessagingDispatch.ts:271`) and counts toward "configured", but
comment events are hard-excluded from it (:321) — so a user whose only registration is a
legacy WhatsApp webhook gets `configured > 0` yet zero comment deliveries (the warn at
:228-230 fires). The registries can therefore "disagree" in the sense that a legacy
subscription can look alive in any UI listing while being structurally ineligible for
comments. A second mismatch axis: dispatch looks up destinations by **account owner**
(`facebook-instagram-webhook/index.ts:254` passes `account.user_id`) while registration is
keyed by **API-key owner** — if those differ, `configured = 0` and the only trace is the
`:232-234` log.

---

## Ranked hypotheses

Ranked for the exact symptom (Facebook Page comment visible in Comment manager, no n8n
event, no user-visible error). "Confirm" commands: SQL runs against the self-hosted
Postgres on Contabo (`supabase_postora_mcp` or psql in the db container); logs via
`docker logs <functions-container> --since <window> 2>&1 | grep ...` (functions service of
the `postorasupabase-supabase-j8axyh` stack).

### H1 — Comments handler is `off` on that Page's account (most likely)
- **Would have to be true:** `account_metadata.comment_automation_handler` of the Page's `social_accounts` row is unset/`'off'`/typo'd (anything ≠ `'n8n'`).
- **Evidence:** default `'off'` — `automationHandler.ts:19-22`; gate `facebook-instagram-webhook/index.ts:250-256` drops with **no log** (neither branch runs); UI default also `'off'` (`AutomationHandlerCard.tsx:99`); node doc warns about it (`PostoraCommentTrigger.node.ts:70`).
- **Confirm/refute:**
  ```sql
  SELECT id, platform_user_id, platform_username, is_active,
         account_metadata->>'comment_automation_handler' AS comment_handler
  FROM social_accounts
  WHERE platform = 'facebook' AND platform_user_id = '<pageId>';
  ```
  `comment_handler` ≠ `n8n` ⇒ confirmed. Refuted if it is `n8n`.

### H2 — Stale subscription created by old node version (v1.2.1): `events` lacks any comment event
- **Would have to be true:** the workflow's webhook was registered before the node offered comment events (package never updated to ≥1.3.0, or subscription never re-created), so `events` ⊆ {post.*, message.*}.
- **Evidence:** old event lists in git (`5c94c207`, `6092253c` — no comment values, no `*`); match requires `"*" | "comment.received" | "comment.facebook"` — `n8nMessagingDispatch.ts:327-328`; no subscription upgrade in `loadDestinations`; community nodes never auto-update (`F:\Postora_new\CLAUDE.md:25`); re-registration only happens via v1.3.x `checkExists` on workflow (re)activation (`PostoraTrigger.node.ts:106-161`, `PostoraCommentTrigger.node.ts:115-156`).
- **Confirm/refute:**
  ```sql
  SELECT key, value->'events' AS events, value->>'is_active' AS is_active,
         value->>'platform' AS platform, value->>'social_account_id' AS social_account_id,
         value->>'failure_count' AS failure_count, value->>'webhook_url' AS url
  FROM app_settings WHERE key LIKE 'n8n_webhook_%';
  ```
  No row whose `events` contains `comment.received`/`comment.facebook`/`*` ⇒ confirmed. Log-side: `docker logs <fn> --since 24h | grep "none subscribed to"` should show `... but none subscribed to comment.facebook`.

### H3 — `isOwnComment` skip: the tester commented *as the Page*
- **Would have to be true:** `value.from.id` of the comment equals the Page's `platform_user_id` (admin posting as the Page, or a genuine page-authored comment).
- **Evidence:** `commentAuthor.ts:34-35`; skip + log at `facebook-instagram-webhook/index.ts:245-248`.
- **Confirm/refute:** `docker logs <fn> --since <window> | grep "skipped own facebook comment"` — presence for that comment id confirms. Also check the stored payload: `SELECT payload->'value'->'from' FROM social_inbox_events WHERE external_event_id = '<commentId>';` vs the row's `platform_user_id`.

### H4 — Per-subscription `platform`/`social_account_id` filter mismatch (PostoraCommentTrigger)
- **Would have to be true:** the subscription carries `social_account_id` (or `platform`) that ≠ the `social_accounts.id` of the Page that received the comment — e.g. Page reconnected after the workflow was configured (new row id), or Account dropdown pinned to another Page.
- **Evidence:** filters sent by the node — `PostoraCommentTrigger.node.ts:31-36`; stored — `n8n-api/index.ts:1505-1514`; enforced silently — `n8nMessagingDispatch.ts:322-323` (filter drops produce only the generic `:228-230` warn).
- **Confirm/refute:** compare the SQL of H2 (`social_account_id` column) against
  ```sql
  SELECT id, user_id FROM social_accounts WHERE platform='facebook' AND platform_user_id='<pageId>';
  ```
  Mismatch (or a second, newer row for the same Page) ⇒ confirmed.

### H5 — Subscription auto-disabled after 10 failed deliveries (n8n URL unreachable from the Supabase container)
- **Would have to be true:** ≥10 consecutive dispatch failures to the n8n callback URL (expired tunnel/DNS, cert issue, n8n behind a URL reachable from the user's browser but not from the Supabase host) set `is_active=false`; the subscription then never matches again.
- **Evidence:** failure path `n8nMessagingDispatch.ts:363-371`; auto-disable `:389-401` (`active = statusCode !== null || failureCount < 10`); inactive rows still count as "configured" (:269-271) so the warn (not the quieter `:232` log) fires; matches require `isActive` (:302-304).
- **Confirm/refute:** H2 SQL — `failure_count` and `is_active` columns; `docker logs <fn> | grep "n8n-dispatch.*failed:"`. From the Contabo host: `curl -s -o /dev/null -w '%{http_code}' <webhook_url>` (POST) to test reachability.

### H6 — Meta never delivered the change to Postora at all (`feed` webhook not subscribed for the Page/app)
- **Would have to be true:** the Meta app's Page webhook lacks the `feed` field, or the Page is not subscribed to the app (`/{page-id}/subscribed_apps`), so no POST ever arrives.
- **Evidence:** UI independence (§0 — `useCommentInbox.ts:148-164` polls Graph directly); the handler's only delivery-trace logs are `[fb-ig-webhook] Received verified facebook event` (:137) and, for a change-only entry, the `entry produced no inbound message` envelope log (:270-280); absence of both around the comment time = nothing arrived.
- **Confirm/refute:** `docker logs <fn> --since <window> | grep "Received verified facebook event"` around the comment timestamp; `SELECT count(*) FROM social_inbox_events WHERE external_event_id = '<commentId>';` (0 ⇒ never ingested); Meta-side: `GET /{page-id}/subscribed_apps` with a Page token, and App Dashboard → Webhooks → `feed` field subscribed + receiving valid responses.

### H7 — API-key owner ≠ account owner (dispatch looks up the wrong user's subscriptions)
- **Would have to be true:** the n8n credential's API key belongs to a different Postora user than the one who owns the connected Page.
- **Evidence:** dispatch passes `account.user_id` — `facebook-instagram-webhook/index.ts:254`; destinations keyed `n8n_webhook_<userId>_%` — `n8nMessagingDispatch.ts:268`; empty fan-out comment + logs `:217-235`; registration keys by the authenticated API user — `n8n-api/index.ts:1497-1498`.
- **Confirm/refute:** log `[n8n-dispatch] no webhook destinations for user <uuid> platform facebook`; compare that `<uuid>` with the `user_id` on the `app_settings` key from H2's SQL.

### H8 — `normalizeMetaCommentChange` returned null (verb ≠ `add`, field ≠ `feed`)
- **Would have to be true:** the change was an edit/remove/reaction or arrived under an unexpected field name.
- **Evidence:** `commentEvents.ts:20-21`; silent `continue` at `facebook-instagram-webhook/index.ts:241-242`.
- **Confirm/refute:** `SELECT payload FROM social_inbox_events WHERE external_event_id='<commentId>';` — inspect `field`/`item`/`verb` in the stored raw change.

### H9 — No matching / inactive `social_accounts` row for `entry.id`
- **Would have to be true:** the Page's row was deactivated or `platform_user_id` ≠ the `entry.id` Meta sent (e.g. reconnect created a new row and the old one went inactive).
- **Evidence:** lookup `facebook-instagram-webhook/index.ts:228` + `:34-41` (`is_active = true` required); drop log `:156`.
- **Confirm/refute:** `docker logs <fn> | grep "No matching facebook account found"`; H1 SQL's `is_active` column.

### H10 — Delivery timing: 5 s per-request timeout / 10 s fan-out deadline / 2 s degraded background cap
- **Would have to be true:** n8n answered slower than the bounds, or the runtime lacks `EdgeRuntime` (degraded path).
- **Evidence:** `n8nMessagingDispatch.ts:121-123, 236-259`; `_shared/background.ts:26-29, 41-53`.
- **Confirm/refute:** logs `[n8n-dispatch] fan-out deadline hit`, `[background] ... exceeded the 2s degraded cap`, and the one-time `[background] ... path active` line.

### H11 — Inbox upsert error (idempotency claim failed) or Meta-retry duplicate
- **Would have to be true:** the `social_inbox_events` upsert errored (dispatch intentionally skipped), or the change was a Meta retry of an already-seen event whose original dispatch had also been dropped by one of H1-H10.
- **Evidence:** error path `facebook-instagram-webhook/index.ts:185-187, 317-319`; duplicate path `:239`.
- **Confirm/refute:** logs `Failed to persist inbox event`; `SELECT created_at FROM social_inbox_events WHERE external_event_id='<commentId>';` (one early row ⇒ original delivery was processed — investigate what dropped it then).

### Non-hypotheses (checked and ruled out as *impossible* causes)
- Legacy `whatsapp_webhooks` rows can never receive comments (`n8nMessagingDispatch.ts:321`) — they can only *mask* as "configured" (see H2/H5 log wording).
- URL dedup (:331-338) can reduce duplicates but never zero out a sole subscription.
- `threads` branches, Instagram id aliases (`ig_igid`/`ig_user_id`), and the DM pipeline are irrelevant to a Facebook Page comment.

## Fastest triage order in production

1. `docker logs <functions> --since <window> 2>&1 | grep -E "fb-ig-webhook|n8n-dispatch|background"` — the log lines uniquely identify H3 (`skipped own`), H6 (`Received verified` absent), H7 (`no webhook destinations`), H2/H4 (`but none subscribed to comment.facebook`), H5 (`failed:`), H10 (`deadline`/`degraded`).
2. H1 SQL (`comment_automation_handler` on the Page row).
3. H2 SQL (`app_settings` events/filters/is_active/failure_count vs the Page's `social_accounts.id`).
4. `social_inbox_events` row for the comment id — its absence points at H6/H9; its payload at H3/H8.
