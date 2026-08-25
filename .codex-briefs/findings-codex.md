## Summary

The Instagram ingress authenticates Meta, classifies the platform solely from `body.object`, resolves one active `social_accounts` row by recipient ID, persists an idempotency row, and dispatches only after a new insert (`supabase/functions/facebook-instagram-webhook/index.ts:104-177`). The common cross-platform dispatch registry is keyed by `account.user_id`, whereas n8n registration is keyed by the profile ID resolved from the credential API key; there is no workspace-membership translation on either path (`supabase/functions/n8n-api/index.ts:74-98`, `supabase/functions/n8n-api/index.ts:1470-1488`, `supabase/functions/_shared/n8nMessagingDispatch.ts:76-83`, `supabase/functions/_shared/n8nMessagingDispatch.ts:110-140`). Therefore an API key belonging to a workspace member or any user other than the social-account row owner creates a valid but unreachable registration, which best explains failure across Instagram and WhatsApp (`supabase/migrations/20260726000001_supercharge_postora_wacrm_chatwoot.sql:17-24`, `supabase/functions/whatsapp-webhook/index.ts:417-433`). A second serious repository defect is that the npm-shipped `dist` trigger offers only `post.completed`, while the TypeScript source offers four message events; the package explicitly publishes only `dist` (`Postora-n8n-community-node/dist/nodes/PostoraTrigger/PostoraTrigger.node.js:32-45`, `Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:43-70`, `Postora-n8n-community-node/package.json:23-42`). Runtime database state, Meta configuration, n8n static data, installed npm contents, and deployed edge-function hashes were not inspected, so the ranking is source-based rather than production-confirmed.

## Answers to the 7 brief questions

### 1. TENANCY

Yes. `n8n-api` takes `x-api-key` (or an Authorization value), queries `profiles.api_key`, and returns that profile row's `id` verbatim as `userId` (`supabase/functions/n8n-api/index.ts:74-98`, `supabase/functions/n8n-api/index.ts:1904-1933`). Registration embeds that UUID in both the key `n8n_webhook_${userId}_${webhookId}` and JSON value (`supabase/functions/n8n-api/index.ts:1470-1488`). Instagram account resolution instead searches active `social_accounts` by platform plus `platform_user_id`, with an Instagram metadata fallback, returns the first row, and dispatches with that row's `account.user_id` (`supabase/functions/facebook-instagram-webhook/index.ts:16-45`, `supabase/functions/facebook-instagram-webhook/index.ts:144-179`). Dispatch then queries only `app_settings` keys starting with that owner UUID (`supabase/functions/_shared/n8nMessagingDispatch.ts:110-140`). Consequently different UUIDs never intersect.

Workspace support makes that mismatch reachable: a workspace can have several `(workspace_id, user_id)` memberships, while a social account retains its own `user_id` and gains a separate `workspace_id` (`supabase/migrations/20260726000001_supercharge_postora_wacrm_chatwoot.sql:17-24`, `supabase/migrations/20260726000001_supercharge_postora_wacrm_chatwoot.sql:115-135`). The partner API is a separate key system pinned to a social account/workspace and explicitly reads the account's `user_id`; it does not alter n8n API-key authentication or webhook lookup (`supabase/functions/partner-api/index.ts:1-12`, `supabase/functions/partner-api/index.ts:104-128`). WhatsApp likewise dispatches with `account.user_id` even though its inbox/cache operations also carry `workspace_id` (`supabase/functions/whatsapp-webhook/index.ts:388-433`). Thus workspace/partner machinery does not bridge an n8n credential owned by a member to a registration owned by the account owner.

### 2. IDEMPOTENCY DROP

For Facebook/Instagram, `recordInboxEvent` performs an `ignoreDuplicates` upsert on `(social_account_id, external_event_id)` and returns `"inserted"` only when `.select("id")` yields a row; it returns `"duplicate"` for an empty result and `"error"` on a database error (`supabase/functions/facebook-instagram-webhook/index.ts:262-285`). Dispatch occurs only for `"inserted"`; duplicates have no explicit duplicate log at this call site, while errors do log (`supabase/functions/facebook-instagram-webhook/index.ts:168-198`). The database enforces exactly that unique pair (`supabase/migrations/20260716123000_live_messaging_events.sql:1-10`). Any earlier writer that inserted the same account/event ID would therefore suppress later dispatch permanently for that event, but repository source inspected here does not prove that history sync or backfill writes `social_inbox_events`; that specific prior-writer scenario remains unverified.

WhatsApp has the analogous behavior: live Cloud API messages upsert on `(user_id,message_id)`, explicitly log and skip duplicates before dispatch (`supabase/functions/whatsapp-webhook/index.ts:360-385`, `supabase/functions/whatsapp-webhook/index.ts:417-433`), and Evolution QR returns before dispatch when the same upsert yields no inserted row (`supabase/functions/whatsapp-evolution-webhook/index.ts:97-125`). WhatsApp history import also upserts with `ignoreDuplicates` on the same key, so history can pre-claim a message ID before a later live delivery (`supabase/functions/whatsapp-webhook/index.ts:504-520`, `supabase/functions/whatsapp-webhook/index.ts:550-579`). This can explain individual WhatsApp misses, but not one fresh Instagram DM plus all platforms without additional evidence.

### 3. SSRF GUARD

Registration rejects malformed URLs, non-HTTPS schemes, internal/single-label hostnames, explicit unsafe IPv4 ranges, and unsafe IPv6 ranges (`supabase/functions/_shared/webhookSecurity.ts:1-25`, `supabase/functions/_shared/webhookSecurity.ts:68-92`). It does not resolve DNS and does not reject non-standard ports, because validation ends after protocol/hostname/IP syntax checks (`supabase/functions/_shared/webhookSecurity.ts:77-92`). Therefore an unresolvable public hostname or closed/non-standard port can register, but will fail only during delivery; redirects are revalidated, requests time out, and at most five redirects are followed (`supabase/functions/_shared/webhookSecurity.ts:100-135`).

`n8n-api` returns HTTP 400 with the validation message before writing a registration (`supabase/functions/n8n-api/index.ts:1445-1460`). The node awaits its authenticated HTTP request and writes `staticData.webhookId` only after a successful response (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:80-98`), so a fresh rejected registration should make activation fail rather than appear successful. Activation can nevertheless appear successful when stale static data causes `checkExists` to bypass `create`, which is a different defect (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:75-99`).

### 4. STALE REGISTRATION

Confirmed and reachable. `checkExists()` tests only whether node static data contains a `webhookId`; it makes no server request (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:75-79`). Server deletion removes the `app_settings` row, while the node clears static data only after its own DELETE call succeeds (`supabase/functions/n8n-api/index.ts:1548-1571`, `Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:100-115`). Manual/admin deletion, failure-based deactivation, database restore, or other server-side loss can therefore leave the n8n ID behind; on reactivation n8n can accept `checkExists=true` and never call `create` (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:75-99`). The correct code fix is for `checkExists` to GET the authenticated webhook list and verify the saved ID is present and active, clearing stale static data and returning false otherwise; the backend list already exposes `id` and `is_active` (`supabase/functions/n8n-api/index.ts:1516-1545`).

### 5. EVENT NAME MISMATCH

The payload's envelope event is always `message.received`, while subscription matching separately derives `message.${platform}` and accepts `*`, `message.received`, or that derived event (`supabase/functions/_shared/n8nMessagingDispatch.ts:52-61`, `supabase/functions/_shared/n8nMessagingDispatch.ts:143-153`). Thus a correctly classified Instagram event matches either configured value in the symptom.

Classification is fragile: ingress assigns `instagram` only when `body.object === "instagram"`; every other object value becomes `facebook` (`supabase/functions/facebook-instagram-webhook/index.ts:124-127`). Account lookup then requires the same platform value, so an Instagram message delivered in a Page envelope classified as Facebook may either resolve a Facebook row and match only `message.received`/`message.facebook`, or fail account resolution entirely (`supabase/functions/facebook-instagram-webhook/index.ts:22-45`, `supabase/functions/facebook-instagram-webhook/index.ts:144-147`). Because the reported selection includes `message.received`, platform-event mismatch alone should not filter the destination; an account-resolution failure could still drop it before dispatch (`supabase/functions/_shared/n8nMessagingDispatch.ts:147-153`, `supabase/functions/facebook-instagram-webhook/index.ts:144-147`). Whether Meta actually sends this account's IG messaging events with a non-`instagram` object is unverified.

### 6. META SUBSCRIPTION

Page-linked Facebook/Instagram connection code requests the `messages,messaging_postbacks` subscribed fields on the Page's `/subscribed_apps` endpoint (`supabase/functions/facebook-oauth/index.ts:185-198`). It invokes this after storing a selected page in both connection flows (`supabase/functions/facebook-oauth/index.ts:740-755`, `supabase/functions/facebook-oauth/index.ts:925-939`). Direct Instagram login separately requests the `instagram_business_manage_messages` scope and best-effort subscribes `messages` through the Instagram `/subscribed_apps` endpoint (`supabase/functions/instagram-oauth/index.ts:35-50`, `supabase/functions/instagram-oauth/index.ts:215-232`).

Both subscription helpers deliberately swallow failure and allow account connection to succeed, logging only warnings (`supabase/functions/facebook-oauth/index.ts:185-201`, `supabase/functions/instagram-oauth/index.ts:42-59`). Therefore the required `messages` subscription can be missing even for a connected account, especially if the best-effort call failed or the account predates these calls; the latter historical condition is an unverified assumption. No periodic reconciliation is evidenced by these connect-time call sites.

### 7. DELIVERY FAILURE

Delivery converts non-2xx responses and network/SSRF/timeout failures into a caught exception, increments `failure_count`, updates the destination, and emits only `console.error`; it does not rethrow to ingress (`supabase/functions/_shared/n8nMessagingDispatch.ts:164-194`). At ten consecutive failures, a settings destination becomes inactive; the filter then silently excludes inactive destinations (`supabase/functions/_shared/n8nMessagingDispatch.ts:118-140`, `supabase/functions/_shared/n8nMessagingDispatch.ts:212-224`). The background wrapper is explicitly best-effort and non-durable, and failures are confined to logs (`supabase/functions/_shared/background.ts:7-20`, `supabase/functions/_shared/background.ts:31-54`). The trigger itself merely turns a received callback body into workflow data and returns 200, so it exposes no Postora-side delivery/failure status (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:120-125`). No user-visible delivery alert or dead-letter/outbox is present on this path; operators must inspect logs or the `app_settings.value.failure_count/is_active` fields that dispatch mutates (`supabase/functions/_shared/n8nMessagingDispatch.ts:212-218`).

## Ranked candidate root causes

### 1. Credential/account owner UUID mismatch

Mechanism: the credential registers under `profiles.id`, but Instagram, Cloud WhatsApp, and Evolution WhatsApp all dispatch under the receiving `social_accounts.user_id`; workspace membership is ignored, so a different member's otherwise-valid API key produces zero matching destinations on every platform (`supabase/functions/n8n-api/index.ts:74-98`, `supabase/functions/n8n-api/index.ts:1470-1488`, `supabase/functions/_shared/n8nMessagingDispatch.ts:110-140`, `supabase/functions/whatsapp-evolution-webhook/index.ts:125-140`). This is the strongest source-based explanation for “all platforms.”

CONFIRM/REFUTE with read-only SQL, replacing the webhook ID only:

```sql
WITH hook AS (
  SELECT key, value, split_part(key, '_', 3)::uuid AS registered_user_id
  FROM public.app_settings
  WHERE value->>'webhook_id' = '1bdd6b00-dfd0-417f-a687-feb8a9d479cb'
)
SELECT h.key, h.registered_user_id, h.value->'events' AS events,
       h.value->>'is_active' AS is_active,
       sa.id AS social_account_id, sa.user_id AS account_owner_id,
       sa.workspace_id, sa.platform, sa.platform_user_id,
       (sa.user_id = h.registered_user_id) AS owner_matches
FROM hook h
LEFT JOIN public.social_accounts sa
  ON sa.platform IN ('instagram','facebook','whatsapp') AND sa.is_active = true
ORDER BY sa.platform, sa.id;
```

The key format and account-owner lookup being tested are defined in `supabase/functions/n8n-api/index.ts:1470-1488` and `supabase/functions/facebook-instagram-webhook/index.ts:22-45`.

### 2. Stale or auto-deactivated registration

Mechanism: stale `staticData.webhookId` makes `checkExists` return true without checking the backend, while ten delivery failures set `is_active=false` and future dispatch silently filters the row (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:75-99`, `supabase/functions/_shared/n8nMessagingDispatch.ts:118-140`, `supabase/functions/_shared/n8nMessagingDispatch.ts:212-218`).

CONFIRM/REFUTE:

```sql
SELECT key, value->>'webhook_id' AS webhook_id, value->>'webhook_url' AS webhook_url,
       value->'events' AS events, value->>'is_active' AS is_active,
       value->>'failure_count' AS failure_count
FROM public.app_settings
WHERE value->>'webhook_id' = '1bdd6b00-dfd0-417f-a687-feb8a9d479cb';
```

An absent row, `is_active <> 'true'`, or large failure count confirms this state against the server schema written at `supabase/functions/n8n-api/index.ts:1475-1488`.

### 3. Meta `messages` subscription missing or failed

Mechanism: the connect-time subscription is best-effort and failures do not abort connection, so Meta may never call ingress despite a visibly connected account (`supabase/functions/facebook-oauth/index.ts:185-201`, `supabase/functions/instagram-oauth/index.ts:42-59`).

CONFIRM/REFUTE by grepping the relevant OAuth function logs for the exact source messages:

```text
Failed to subscribe page to webhooks:
Error subscribing page to webhooks:
Failed to subscribe direct Instagram account to webhooks:
Error subscribing direct Instagram account to webhooks:
```

Those exact log strings are emitted at `supabase/functions/facebook-oauth/index.ts:194-200` and `supabase/functions/instagram-oauth/index.ts:52-58`. An operator can also query Meta's `/{page-or-ig-id}/subscribed_apps` with an authorized token, but this report does not include a credential-bearing curl command because secrets must not be exposed.

### 4. Checked-in npm `dist` is stale

Mechanism: package metadata ships only `dist`, and its trigger contains only `post.completed`, whereas source and tests contain all message event choices (`Postora-n8n-community-node/package.json:23-42`, `Postora-n8n-community-node/dist/nodes/PostoraTrigger/PostoraTrigger.node.js:32-45`, `Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:43-70`, `Postora-n8n-community-node/__tests__/PostoraTrigger.node.test.ts:37-49`). A package built from this repository state cannot faithfully expose/register the selected message events shown in source.

CONFIRM/REFUTE on the n8n host without contacting Postora:

```powershell
rg -n 'message\.received|message\.instagram' '<n8n-node-install-root>\node_modules\n8n-nodes-postora\dist\nodes\PostoraTrigger\PostoraTrigger.node.js'
```

Zero matches confirms the installed artifact has the same stale event list evidenced at `Postora-n8n-community-node/dist/nodes/PostoraTrigger/PostoraTrigger.node.js:32-45`.

### 5. Callback delivery failure followed by silent disablement

Mechanism: an unresolvable public hostname, unreachable port, timeout, redirect problem, or n8n non-2xx response passes registration when syntactically public but fails delivery; the error is swallowed and ten failures deactivate the destination (`supabase/functions/_shared/webhookSecurity.ts:77-92`, `supabase/functions/_shared/webhookSecurity.ts:100-135`, `supabase/functions/_shared/n8nMessagingDispatch.ts:186-194`, `supabase/functions/_shared/n8nMessagingDispatch.ts:212-218`).

CONFIRM/REFUTE by grepping edge-function logs for:

```text
[n8n-dispatch] <callback-url> failed:
```

That exact prefix is emitted at `supabase/functions/_shared/n8nMessagingDispatch.ts:186-194`. The operator may also run `curl -i -X POST '<stored webhook_url>' -H 'Content-Type: application/json' --data '{"event":"message.received","platform":"instagram"}'` from the Supabase/functions host; the stored URL is the exact target dispatch uses (`supabase/functions/_shared/n8nMessagingDispatch.ts:118-127`, `supabase/functions/_shared/n8nMessagingDispatch.ts:186-188`).

### 6. Ingress account resolution or platform classification drop

Mechanism: `body.object` determines the platform, and no matching active account causes a warning followed by `continue`, so no inbox insert or dispatch occurs (`supabase/functions/facebook-instagram-webhook/index.ts:124-147`). Recipient matching uses only `platform_user_id` plus one Instagram metadata fallback and takes the first row (`supabase/functions/facebook-instagram-webhook/index.ts:22-45`).

CONFIRM/REFUTE by grepping ingress logs for `Received verified instagram event`, `Received verified facebook event`, and `No matching <platform> account found for recipient`; these exact messages occur at `supabase/functions/facebook-instagram-webhook/index.ts:124-147`. Then compare the logged recipient ID using:

```sql
SELECT id, user_id, workspace_id, platform, platform_user_id,
       account_metadata->>'ig_user_id' AS metadata_ig_user_id, is_active
FROM public.social_accounts
WHERE platform IN ('instagram','facebook')
  AND (platform_user_id = '<recipient-id>' OR account_metadata->>'ig_user_id' = '<recipient-id>');
```

The predicates mirror `supabase/functions/facebook-instagram-webhook/index.ts:27-45`.

### 7. Idempotency pre-claimed the event

Mechanism: a duplicate Instagram/Facebook event returns `duplicate` and bypasses dispatch; WhatsApp history can similarly pre-insert a message ID before live delivery (`supabase/functions/facebook-instagram-webhook/index.ts:160-198`, `supabase/functions/facebook-instagram-webhook/index.ts:262-285`, `supabase/functions/whatsapp-webhook/index.ts:550-579`). This is plausible for isolated events but less likely for fresh tests across all platforms.

CONFIRM/REFUTE for the Meta message ID:

```sql
SELECT id, user_id, social_account_id, platform, event_type, external_event_id, created_at
FROM public.social_inbox_events
WHERE social_account_id = '<social-account-uuid>'
  AND external_event_id = '<Meta-mid>';
```

The relevant unique key is defined at `supabase/migrations/20260716123000_live_messaging_events.sql:1-10`. For WhatsApp, grep `Duplicate inbound message skipped`, emitted at `supabase/functions/whatsapp-webhook/index.ts:380-385`.

## Best hypothesis

Credential/account owner UUID mismatch is the root cause because registration is namespaced to the `profiles.id` authenticated by the “danat-future” API key, while every ingress dispatch is namespaced to the receiving social account's `user_id`, and workspace membership/partner keys never translate between them (`supabase/functions/n8n-api/index.ts:74-98`, `supabase/functions/n8n-api/index.ts:1470-1488`, `supabase/functions/_shared/n8nMessagingDispatch.ts:76-83`, `supabase/functions/_shared/n8nMessagingDispatch.ts:110-140`, `supabase/functions/partner-api/index.ts:119-128`). This uniquely supplies one common mechanism for the reported Instagram, WhatsApp, and all-platform failure, although the production SQL query above is required to confirm it.

## Recommended fixes (DO NOT APPLY)

1. In `supabase/functions/n8n-api/index.ts`, make webhook registration explicitly account/workspace scoped: accept and authorize a `workspace_id` or selected `social_account_ids`, persist that scope in the webhook value, and reject credentials that cannot access it; registration currently stores only `user_id` (`supabase/functions/n8n-api/index.ts:1440-1488`). In `supabase/functions/_shared/n8nMessagingDispatch.ts`, load destinations using the authorized workspace/account scope rather than assuming `account.user_id` is the credential owner (`supabase/functions/_shared/n8nMessagingDispatch.ts:76-83`, `supabase/functions/_shared/n8nMessagingDispatch.ts:110-140`).
2. In `PostoraTrigger.node.ts`, change `checkExists` to GET `/api/v1/webhooks`, verify the saved ID exists and is active, clear stale static data and return false otherwise; the backend already returns these fields (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:75-99`, `supabase/functions/n8n-api/index.ts:1516-1545`). Also make delete clear stale data on a server-confirmed 404, while preserving real errors (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:100-115`).
3. Rebuild and publish the community node so `dist/nodes/PostoraTrigger/PostoraTrigger.node.js` matches the TypeScript event list, and add a release gate that tests the built JS rather than importing TypeScript; current tests inspect source while npm ships only `dist` (`Postora-n8n-community-node/__tests__/PostoraTrigger.node.test.ts:1-49`, `Postora-n8n-community-node/package.json:27-42`).
4. In both OAuth functions, treat a missing `messages` subscription as a surfaced partial-connection failure or persist a health flag, and add a reconciliation endpoint/job that checks and repairs subscriptions; current helpers only warn and return (`supabase/functions/facebook-oauth/index.ts:185-201`, `supabase/functions/instagram-oauth/index.ts:42-59`).
5. In `n8nMessagingDispatch.ts`, persist delivery attempts/status and expose them through `n8n-api`; emit a user-visible notification before automatic deactivation and retain last error/status/time. The current settings update records only failure count/active state and the error stays in logs (`supabase/functions/_shared/n8nMessagingDispatch.ts:186-194`, `supabase/functions/_shared/n8nMessagingDispatch.ts:212-218`). Use a durable outbox instead of the explicitly best-effort background path for customer automation events (`supabase/functions/_shared/background.ts:7-20`).
6. In `facebook-instagram-webhook/index.ts`, log duplicate results explicitly and add durable correlation fields for ingress, account resolution, insert result, destination count, and delivery result; today duplicates bypass dispatch without a dedicated log at the call site (`supabase/functions/facebook-instagram-webhook/index.ts:160-198`, `supabase/functions/facebook-instagram-webhook/index.ts:262-285`). Validate Meta envelope/platform mappings with fixtures and resolve by recipient identity before relying solely on `body.object` (`supabase/functions/facebook-instagram-webhook/index.ts:124-147`).
7. In `webhookSecurity.ts`, add DNS resolution plus resolved-IP checks immediately before each connection (with redirect-hop revalidation) if the Deno runtime permits a safe resolver; the current validator catches literal unsafe targets but does not resolve public-looking hostnames (`supabase/functions/_shared/webhookSecurity.ts:77-92`, `supabase/functions/_shared/webhookSecurity.ts:100-135`).

## Unverified assumptions / what I could not check

- Production `profiles`, `social_accounts`, `workspace_members`, `app_settings`, `social_inbox_events`, and WhatsApp message rows were not queried; therefore ownership mismatch, stale/deactivated registration, failure counts, and duplicate state are unverified runtime hypotheses.
- Meta App Dashboard webhook products/fields, account permissions, Page/Instagram `subscribed_apps`, and actual envelope `body.object` were not checked; only repository connect-time subscription behavior was verified (`supabase/functions/facebook-oauth/index.ts:185-201`, `supabase/functions/instagram-oauth/index.ts:42-59`).
- n8n workflow static data, the actual callback URL, n8n logs, and the installed `n8n-nodes-postora` artifact were not inspected; only the repository source/dist mismatch was verified (`Postora-n8n-community-node/nodes/PostoraTrigger/PostoraTrigger.node.ts:43-70`, `Postora-n8n-community-node/dist/nodes/PostoraTrigger/PostoraTrigger.node.js:32-45`).
- Deployed edge-function contents and hashes were not compared with this checkout, so deployed-versus-repository drift remains possible.
- The required project `mem0` service was not available among the callable tools in this run, so no prior Postora memory could be searched or saved; this task also forbade any write other than this findings file.

---

## Orchestrator verification notes (added after Codex's run — not by Codex)

Five citations were spot-checked verbatim against source and all matched exactly:
`_shared/n8nMessagingDispatch.ts:110-140`, `PostoraTrigger.node.ts:75-79`,
`dist/nodes/PostoraTrigger/PostoraTrigger.node.js:32-45`, `n8n-api/index.ts:1470-1488`,
`nodes/PostoraTrigger/PostoraTrigger.node.ts:43-70`.

**Candidate root cause #4 ("Checked-in npm `dist` is stale") is PARTLY REFUTED and should be
downgraded.** Codex could only see the *vendored* copy at
`F:\Postora_new\Postora-n8n-community-node\`. The actual publishing repo is
`F:\N8N\Postora-n8n-community-node\` (per CLAUDE.md, the only repo that publishes
`n8n-nodes-postora`). Its built output DOES contain all message events:

- `F:\N8N\Postora-n8n-community-node\dist\nodes\PostoraTrigger\PostoraTrigger.node.js:40-59`
  contains `post.completed`, `message.received`, `message.whatsapp`, `message.instagram`,
  `message.facebook`.
- Both `package.json` files report `"version": "1.2.0"`, and `npm view n8n-nodes-postora
  version` returns `1.2.0` — so 1.2.0 is genuinely published (CLAUDE.md's "current version
  1.1.11" note is simply out of date).

So the published npm artifact is NOT missing the message events, which is independently
corroborated by the user's workflow already having `events: ["message.received",
"message.instagram"]` selected. The real defect here is **vendored-copy drift**: the
`dist/` inside `F:\Postora_new\Postora-n8n-community-node\` is stale relative to the
publishing repo, violating the "apply changes twice / keep both copies in sync" rule in
CLAUDE.md. That is a repo-hygiene bug worth fixing, but it is not the cause of the
missing trigger events.

This does not affect candidate #1 (credential/account owner UUID mismatch), which remains
the best hypothesis and is unaffected by node packaging.
