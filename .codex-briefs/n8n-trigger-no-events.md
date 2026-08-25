# Investigation brief: Postora n8n Trigger receives no message events

## Symptom (reported by user)
An n8n workflow contains ONE node, `n8n-nodes-postora.postoraTrigger` (typeVersion 1),
configured with `events: ["message.received", "message.instagram"]`, credential
`postoraApi` named "danat-future", webhookId `1bdd6b00-dfd0-417f-a687-feb8a9d479cb`.
The workflow is **active and published**. The user sent a test DM to the connected
Instagram account. The trigger node never fired — no execution appeared in n8n.
Same reported for WhatsApp and "all platforms".

## Your task
INVESTIGATION ONLY. Do NOT change any code. Produce a written root-cause analysis.

Read the relevant source and trace the FULL path an Instagram DM takes from Meta to the
n8n webhook URL. For every hop, state what could silently drop the event, and rank each
candidate cause by likelihood with the specific file:line evidence that supports it.

## Repos / paths (Windows)
- Backend (Supabase edge functions, Deno): `F:\Postora_new\supabase\functions\`
  - `facebook-instagram-webhook/index.ts`  <- Meta -> Postora ingress for IG/FB
  - `whatsapp-webhook/index.ts`, `whatsapp-evolution-webhook/index.ts`
  - `_shared/n8nMessagingDispatch.ts`      <- loads destinations + fans out to n8n
  - `_shared/webhookSecurity.ts`           <- postWebhook / SSRF guard (validateWebhookTarget)
  - `n8n-api/index.ts`                     <- POST/GET/DELETE /api/v1/webhooks registration,
                                              ALLOWED_WEBHOOK_EVENTS, auth (API key -> user_id)
- n8n community node: `F:\Postora_new\Postora-n8n-community-node\`
  - `nodes/PostoraTrigger/PostoraTrigger.node.ts`
  - `credentials/` (postoraApi)
  - `dist/` (built output actually shipped to npm as `n8n-nodes-postora`)
  - `__tests__/PostoraTrigger.node.test.ts`

## Known architecture facts (verified already — do not re-derive, build on them)
- Trigger registration: `webhookMethods.default.create()` POSTs
  `{webhook_url: <n8n callback>, events}` to `${baseUrl}/api/v1/webhooks`, stores
  `registration.webhook.id` in `getWorkflowStaticData("node").webhookId`.
- `checkExists()` returns `Boolean(staticData.webhookId)` — it does NOT verify the row
  still exists server-side.
- Registration writes an `app_settings` row keyed `n8n_webhook_${userId}_${webhookId}`
  with `{webhook_url, events, webhook_secret, is_active: true, ...}`.
- Dispatch (`dispatchMessageEvent`) loads destinations with
  `app_settings.like('key', 'n8n_webhook_' + userId + '_%')` where `userId` is
  **`account.user_id`** — the owner of the social account that received the DM.
- `matchesSubscription` accepts `*`, `message.received`, or `message.<platform>`.
- Destinations are filtered by `isActive` (`value.is_active === true`); `updateDestination`
  sets `is_active: false` once `failure_count` reaches 10.
- IG ingress requires a valid `x-hub-signature-256` against `FACEBOOK_APP_SECRET`,
  then `findAccountForRecipient(adminClient, platform, entry.id)`.
- Dispatch only runs when `recordInboxEvent(...)` returns exactly `"inserted"`.

## Specific questions to answer with evidence
1. TENANCY: could the API key behind credential "danat-future" resolve to a DIFFERENT
   Postora `user_id` than the `user_id` that owns the Instagram social account? If so the
   registration row and the dispatch lookup never intersect. Trace exactly how `n8n-api`
   maps an API key to `userId`, and how `findAccountForRecipient` picks `account.user_id`.
   Is there any partner-API / workspace / multi-tenant indirection (see
   `partner-api`, whatsapp workspace tables) that breaks the assumption?
2. IDEMPOTENCY DROP: what does `recordInboxEvent` return on a duplicate
   `external_event_id`? If it returns "duplicate"/"skipped" rather than "inserted",
   dispatch is silently skipped. Could a prior ingest (history sync, AI agent, inbox
   backfill) have already inserted the event id, permanently suppressing dispatch?
3. SSRF GUARD: does `validateWebhookTarget` in `n8n-api` reject the user's n8n callback
   URL (private IP, non-https, non-standard port, unresolvable host)? What does the node
   surface to the user when registration is rejected? Would activation still appear to
   succeed?
4. STALE REGISTRATION: if the `app_settings` row was deleted or deactivated but
   `staticData.webhookId` survived, `checkExists()` returns true and `create()` is never
   re-run. Confirm from the n8n node code whether re-activating the workflow would ever
   re-register. Is that a real, reachable state? What is the correct fix?
5. EVENT NAME MISMATCH: any place where the dispatched event/platform string cannot equal
   `message.instagram` (e.g. platform computed as `facebook` because `body.object`
   !== "instagram" for IG-messaging webhooks subscribed via a Facebook Page).
6. META SUBSCRIPTION: which Meta webhook field/subscription must be active for an IG DM to
   reach `facebook-instagram-webhook`? Is any code responsible for subscribing it at
   connect time, and can it be missing/never-called?
7. DELIVERY FAILURE: `deliverToDestination` swallows errors into `console.error` and a
   failure counter. What user-visible signal exists that delivery is failing? Is there any?

## Deliverable
Write your findings to `F:\Postora_new\.codex-briefs\findings-<YOURNAME>.md` with:
- A ranked list of candidate root causes, each with file:line evidence and a
  concrete way to CONFIRM or REFUTE it (a query, a log line to look for, a curl).
- Your single best hypothesis, stated as "X is the root cause because Y".
- Recommended code fixes (diff-level description, but DO NOT apply them).
Do not modify any file other than your findings file.
