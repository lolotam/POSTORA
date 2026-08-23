# Investigation Report + Claude Code Fix Brief

**n8n Postora node Message → Reply returns 404 `ACCOUNT_NOT_FOUND`**

| Field | Value |
|---|---|
| Date | 2026-08-22 |
| Audience | Claude Code (implementer) |
| Scope | Read-only investigation. **No production code was changed in this pass.** |
| Repos | `F:\Postora_new` (Postora + vendored n8n node) and `F:\N8N\Postora-n8n-community-node` (GitHub-connected n8n node) |
| Evidence | Exact API error body + n8n stack + source of `handleMessageReply` / node Message→Reply. Live Contabo SSH **timed out this session** (MCP + `root@86.48.2.205:22`). Ownership facts below are from the 2026-08-21 live-DB investigation, which is the same tenant and the same n8n host. |

---

## Error (as reported)

n8n node **`danat-future`** (`n8n-nodes-postora.postora`, resource `message`, operation `reply`) at `2026-08-22 22:28:50` (likely Asia/Kuwait, **19:28:50 UTC**):

```json
{
  "error": {
    "code": "ACCOUNT_NOT_FOUND",
    "message": "Social account not found or not owned by the authenticated user."
  }
}
```

HTTP 404 from `POST {baseUrl}/api/v1/messages/reply`. Auth succeeded (401 would be `UNAUTHORIZED`). The node did send a non-empty `social_account_id` (empty would have been a local `Required parameter 'Social Account ID' is missing` before any HTTP call).

n8n host: `n8n2.walidmohamed.com` (from the 2026-08-21 webhook row). n8n `2.35.7` self-hosted. Package path on disk: `/home/node/.n8n/nodes/node_modules/n8n-nodes-postora/`.

---

## Executive summary

This is **not** a Meta send failure and **not** a missing route. The request reached `supabase/functions/n8n-api/index.ts` `handleMessageReply`, which loads `social_accounts` by **primary key UUID** and then requires `account.user_id === API-key profile.id`. That check failed.

The Danat Future n8n workflow authenticates as **`danatfuture@gmail.com`**. That user owns Facebook `Danat Future Company` and Instagram `danatfuture` only. The live WhatsApp number is owned by **`dr.vet.waleedtam@gmail.com`**. Using that WhatsApp UUID (or any UUID not in danatfuture's `social_accounts`) with danatfuture's API key produces exactly this 404.

The n8n Message → Reply field still uses the **old** default `{{ $json.social_account_id }}`. Comment → Reply was patched today (2026-08-22 production incident) to fall back to the trigger by name when an AI Agent sits in between. Message → Reply was not patched. If an agent is in the path, `$json` is the agent's output; a hallucinated or copied-from-the-wrong-field UUID still passes `requireParam` and dies here.

**Do not silently allow cross-user account access.** That is a tenancy boundary. Fix diagnostics + the node expression/UUID guard. The operational rule stays: the API key on the Reply node must own the `social_account_id` being sent.

| # | What happened | Proven? | Confidence |
|---|---|---|---|
| 1 | 404 is `handleMessageReply` ownership check, not Meta, not "route missing" | Code path matches the error body byte-for-byte | High |
| 2 | Auth user is the n8n credential's `profiles.api_key` owner (`danatfuture@gmail.com` on this workflow) | 2026-08-21 live webhook row `n8n_webhook_12f4ba6a-…`; same n8n host | High |
| 3 | That user does not own the WhatsApp account; Waleed does | 2026-08-21 live `social_accounts` dump | High |
| 4 | Message node still has the pre-fix `$json.social_account_id` default (comments were fixed today) | `Postora.node.ts` L550 vs L471 | High |
| 5 | Exact UUID sent at 22:28 was **not** recovered this session | SSH handshake timeout; `api_logs` for n8n-api does not store `request_data` | Blocked — must confirm on next SSH |

---

## How the call is wired

```
n8n node "danat-future"
  resource=message operation=reply
  POST {credentials.baseUrl}/api/v1/messages/reply
  headers: x-api-key = postoraApi.apiKey
  body: {
    social_account_id: <messageSocialAccountId>,
    recipient_id:      <messageRecipientId>,
    message:           <messageText>,
    message_type:      text|media
    platform?:         omitted when Auto-detect
  }
        │
        ▼
n8n-api authenticateApiKey
  profiles.api_key = header  →  userId = profiles.id
        │
        ▼
handleMessageReply
  SELECT social_accounts
    WHERE id = body.social_account_id
  if !row OR row.user_id !== userId
    → 404 ACCOUNT_NOT_FOUND     ← THIS ERROR
  if body.platform set AND body.platform !== row.platform
    → 400 INVALID_PLATFORM
  else sendMessage(...)
```

Node (local `F:\N8N\Postora-n8n-community-node`, v1.4.0):

```548:552:F:\N8N\Postora-n8n-community-node\nodes\Postora\Postora.node.ts
        displayName: "Social Account ID",
        name: "messageSocialAccountId",
        type: "string",
        default: "={{ $json.social_account_id }}",
        required: true,
```

```1288:1314:F:\N8N\Postora-n8n-community-node\nodes\Postora\Postora.node.ts
        else if (resource === "message" && ["send", "reply"].includes(operation)) {
          const socialAccountId = requireParam(... "Social Account ID");
          ...
          url: `${baseUrl}/api/v1/messages/reply`,
```

Comment fields (patched today — Message was not):

```471:471:F:\N8N\Postora-n8n-community-node\nodes\Postora\Postora.node.ts
        default: "={{ $json.social_account_id ?? $('Postora Comment Trigger').first().json.social_account_id }}",
```

Backend ownership check:

```1776:1805:F:\Postora_new\supabase\functions\n8n-api\index.ts
async function handleMessageReply(...) {
  const accountId = typeof body?.social_account_id === 'string' ? body.social_account_id : '';
  ...
  const { data: account, error } = await supabase
    .from('social_accounts')
    .select('id, user_id, workspace_id, ...')
    .eq('id', accountId)
    .maybeSingle();
  if (error) return apiError(..., 500, 'INTERNAL_ERROR');
  if (!account || account.user_id !== userId) {
    return apiError(..., 404, 'ACCOUNT_NOT_FOUND');
  }
```

`workspace_id` is selected and **never used**. `messaging-api` WhatsApp sends go through `requireWhatsAppWorkspaceAccess` (workspace members allowed). n8n-api does not. That is a product gap, not a reason to open the door without an explicit decision.

Post → Create **does** resolve `platform_user_id` / username for the same user (`n8n-api` ~L674–L760). Message → Reply does **not**. A numeric IG/FB id that works for posts 404s here.

---

## What 404 actually means (narrow)

`requireParam` already proved `social_account_id` was non-empty. Postgres UUID columns reject non-UUIDs with `22P02`, which this handler maps to **500** `INTERNAL_ERROR`, not 404.

So the value sent at 22:28 was a **well-formed UUID**, and either:

1. **No row** with that `id`, or
2. **A row exists whose `user_id` is not the API-key user** (most likely given yesterday's tenant split)

It is **not**: empty field, Meta token error (`MESSAGE_SEND_FAILED` 502), platform mismatch (`INVALID_PLATFORM` 400), or invalid API key (401).

### Likely UUIDs they might have sent

From 2026-08-21 live DB (confirm again; IDs abbreviated there):

| id (abbrev) | platform | handle / number | owner |
|---|---|---|---|
| Facebook Danat Future Company | facebook | Danat Future Company | `danatfuture@gmail.com` (`12f4ba6a-…`) |
| Instagram `danatfuture` | instagram | danatfuture | `danatfuture@gmail.com` |
| `93de5a12-…` | whatsapp `evolution_qr` | `96597950350` | `dr.vet.waleedtam@gmail.com` (`7fe4d34e-…`) |
| `d40ad3b2-…` | whatsapp `coexistence` | `1097745303431352` | `xsellpointkw@gmail.com` |

If the Reply node is hardcoded to Waleed's WhatsApp UUID (or an AI Agent copied it), 404 is guaranteed with danatfuture's credential.

Inbound trigger payload **does** put the correct Postora UUID on `social_account_id` and `account.id` (`buildMessagePayload`). Recipient is `sender.id` / `sender.phone`. Mixing those two fields (putting `sender.id` in Social Account ID) would 404 only if that sender id happens to be a UUID, which Meta PSIDs usually are **not** (that would be 500). More likely they pasted/hardcoded another account's UUID.

---

## SSH / logs — this session

`ssh-contabo-mcp` `exec` and `sudo-exec` both failed: `SSH connection error: Timed out while waiting for handshake`. Direct `ssh root@86.48.2.205` also timed out on port 22. **Re-run the queries below before coding any tenancy change.**

When the host is back (stack `postorasupabase-supabase-j8axyh`):

```bash
# 1) functions logs around 19:28 UTC 2026-08-22
# Look for: "n8n API request: POST /api/v1/messages/reply"
#           "API key authenticated for user: <uuid>"
# handleMessageReply currently does NOT log the failing accountId.

# 2) who owns what
# (run via psql on the supabase db container — do not print api_key values)

SELECT sa.id, sa.platform, sa.platform_username, sa.platform_user_id,
       sa.user_id, sa.workspace_id, sa.is_active, p.email
FROM social_accounts sa
JOIN profiles p ON p.id = sa.user_id
WHERE p.email IN ('danatfuture@gmail.com', 'dr.vet.waleedtam@gmail.com')
   OR sa.platform_username ILIKE '%danat%';

SELECT key, value->>'webhook_url' AS url, value->'events' AS events,
       value->>'user_id' AS owner, value->>'is_active' AS active
FROM app_settings
WHERE key LIKE 'n8n_webhook_%'
ORDER BY (value->>'created_at') DESC
LIMIT 20;

-- api_logs for this endpoint does NOT store the body; status_code is written
-- as 200 at rate-limit time BEFORE the handler. Do not trust it as "the reply succeeded".
SELECT created_at, user_id, endpoint, method, status_code
FROM api_logs
WHERE endpoint = '/api/v1/messages/reply'
  AND created_at >= '2026-08-22 19:20:00+00'
  AND created_at <  '2026-08-22 19:40:00+00'
ORDER BY created_at;
```

In n8n UI, open the failed execution → node `danat-future` → **input JSON + parameter values**. Record:

- evaluated `messageSocialAccountId`
- evaluated `messageRecipientId`
- which Postora credential (whose API key)
- whether an AI Agent / other node sits between Postora Trigger and this node
- whether Social Account ID is still the default expression or a hardcoded UUID

Then:

```
GET {baseUrl}/api/v1/accounts
```

with **that same credential**. The reply UUID must appear in `accounts[].id`. If it does not, this 404 is working as designed.

---

## Ruled out

| Hypothesis | Why not |
|---|---|
| Wrong URL / Kong 404 | Body is Postora `apiError` with `code: ACCOUNT_NOT_FOUND` |
| Meta Graph failure | That is 502 `MESSAGE_SEND_FAILED` |
| Empty Social Account ID | Local `requireParam` throw, no HTTP |
| Non-UUID string (`danatfuture`, phone, conversation_id) | UUID column → 500 `INTERNAL_ERROR` |
| Trigger node dropping `social_account_id` | `PostoraTrigger.webhook()` forwards `getBodyData()`; envelope always has `social_account_id` |
| n8n package missing Message→Reply | It posted `/api/v1/messages/reply` and got this structured body |
| `n8n-api` not deployed | Would be Kong/function 404, not this JSON |

---

## Suggested implementation (for Claude Code)

Do **not** mix the operational tenancy rule with a workspace-wide ACL unless product explicitly asks (same decision as 2026-08-21 Option B).

### Confirm first (15 min, blocked on SSH + n8n UI)

1. Failed execution: copy the evaluated `social_account_id`.
2. Contabo SQL: that id's `user_id` vs `profiles.id` for `danatfuture@gmail.com`.
3. Same credential `GET /api/v1/accounts`.

If the UUID is Waleed's WhatsApp (or any other tenant): **stop**. Tell the user to either:

- **A1** Reply only with Instagram/Facebook account ids owned by danatfuture, using `{{ $('Postora Trigger').first().json.social_account_id }}`, or
- **A2** Put **Waleed's** Postora API key on the Reply node (and only send Waleed-owned account ids), or
- **A3** Reconnect/move the WhatsApp number under `danatfuture@gmail.com` (same operational choice as yesterday).

Do not "fix" that 404 by skipping the owner check.

### Fix 1 — n8n node (safe, do this)

Apply to **both** node copies in the same task (`F:\N8N\Postora-n8n-community-node` **and** `F:\Postora_new\Postora-n8n-community-node`). Do not reintroduce a nested `.git` in the vendored copy. Do **not** npm-publish from the Postora repo.

1. **Message field defaults** — mirror today's comment fix:

   ```
   Social Account ID:
     {{ $json.social_account_id ?? $('Postora Trigger').first().json.social_account_id }}
   Recipient:
     {{ $json.sender.id || $json.sender.phone || $('Postora Trigger').first().json.sender.id }}
   ```

   Keep `??` so a directly wired trigger still short-circuits. Tests: copy the comment suite in `__tests__/Postora.node.test.ts` (~L879) for message fields.

2. **`requireParam` jsonPath** for `messageSocialAccountId` / `messageRecipientId` so an empty value after an AI Agent explains the real cause (today only comments get that hint).

3. **UUID guard before HTTP** (same `isValidUuid` already used for Media → Get):

   ```
   if (!isValidUuid(socialAccountId)) {
     throw new Error(
       `Social Account ID must be the Postora account UUID from the trigger's social_account_id ` +
       `(not the Instagram/Facebook user id, not sender.id, not the username). Got "${socialAccountId}". ` +
       `Run Resource=Account Operation=List with this credential and copy the id field.`
     );
   }
   ```

   This turns a confusing 404/500 into a local, actionable error when they paste a page id or username. A foreign **UUID** still reaches the API (correct — that's tenancy).

4. Field description: "Postora `social_accounts.id` UUID. Use Account → List if you do not have a trigger payload. Do not use `sender.id` or a platform numeric id."

5. Gates: `npx tsc --noEmit` + `npm test` in `F:\N8N\Postora-n8n-community-node`. Then `clean-code-guard` on node source, `test-guard` on `__tests__/Postora.node.test.ts`. Sync the vendored copy. Commit scoped files only. **Do not cut an npm release unless the user asks** — community nodes do not auto-update; they will stay on the installed version until they upgrade in n8n Settings → Community Nodes.

### Fix 2 — `n8n-api` diagnostics (safe, do this)

File: `supabase/functions/n8n-api/index.ts` `handleMessageReply` (and `loadOwnedCommentAccount` — same silent 404).

On failure, log **no tokens**:

```
[n8n-api] ACCOUNT_NOT_FOUND accountId=<uuid> authUser=<uuid> rowExists=<bool> ownerUser=<uuid|null>
```

Split the client error (still 404, still non-enumerable — do **not** reveal whether the row exists to a stranger, but n8n users are authenticated; a slightly clearer message is OK once authed):

- invalid UUID syntax → 400 `INVALID_ACCOUNT_ID` (do this **before** the query; avoids 500 `22P02`)
- no row **or** other owner → keep 404 `ACCOUNT_NOT_FOUND` (do not leak existence)
- optional same-user `platform_user_id` fallback, **only** `.eq('user_id', userId)`, matching Post → Create. If you add it, document it and add tests. Do **not** look up another user's `platform_user_id`.

Also log `social_account_id` (not the rest of the body) on every reply attempt at info level so the next 404 is greppable without SSH SQL.

Deploy via `docs/runbooks/deploy-edge-function.md` (`n8n-api` + `_shared` only if you touch shared modules). SHA256 then `docker compose up -d --no-deps functions`. **Do not** `npx supabase functions deploy`.

### Fix 3 — product, only if asked

Workspace-wide n8n access (`loadDestinations` + `handleMessageReply` using `workspace_members`) is yesterday's Option B. It is a tenancy change. FB/IG may not even have `workspace_id` set the way WhatsApp does. Do not sneak it in to make this 404 go away.

### Tests

| Case | Expected |
|---|---|
| Message defaults contain `$('Postora Trigger').first().json.social_account_id` and `??` | node test |
| Empty `messageSocialAccountId` mentions the in-between-node hint | node test |
| Non-UUID Social Account ID throws before HTTP | node test |
| Valid UUID still POSTs `/api/v1/messages/reply` | existing send/reply test |
| `handleMessageReply` non-UUID → 400 before DB | n8n-api / deno test (add a focused one; there is none today) |
| Foreign UUID / missing row → 404, log line includes accountId + authUser | same |

### Files

| File | Change |
|---|---|
| `F:\N8N\Postora-n8n-community-node\nodes\Postora\Postora.node.ts` | message defaults, requireParam hints, UUID guard, description |
| `F:\N8N\Postora-n8n-community-node\__tests__\Postora.node.test.ts` | message-field + UUID tests |
| `F:\Postora_new\Postora-n8n-community-node\…` | **same** edits (vendored copy) |
| `supabase/functions/n8n-api/index.ts` | UUID 400, diagnostic log on ACCOUNT_NOT_FOUND |
| optional `supabase/functions/n8n-api/*.test.ts` | handler cases |

**Out of scope unless product says so:** workspace fan-out, npm release, Meta send path, trigger node.

### Verify after fix

1. Account → List with danatfuture credential. Copy Instagram/Facebook `id`.
2. Message → Reply with that id + a real `sender.id` from a recent FB/IG trigger item. Expect 200 or 502 from Meta, **not** 404.
3. Message → Reply with Waleed's WhatsApp UUID + danatfuture key. Expect 404 still (correct).
4. Message → Reply with `sender.id` / username as Social Account ID. Expect **node-local** UUID error, no HTTP.
5. Trigger → AI Agent → Message Reply using the new default. `social_account_id` comes from the trigger fallback.

---

## Immediate user guidance (no deploy required)

In the failed n8n execution, node `danat-future`:

1. Confirm the Postora credential is danatfuture's API key (the same one on Postora Trigger).
2. Social Account ID must be the trigger's `social_account_id` (a UUID). Change it to:

   `{{ $json.social_account_id ?? $('Postora Trigger').first().json.social_account_id }}`

   Use the trigger node's **actual canvas name** if it is not `Postora Trigger`.
3. Recipient stays `sender.id` (FB/IG) or `sender.phone` (WhatsApp). Never put that in Social Account ID.
4. Do not paste the WhatsApp account UUID from Waleed's dashboard into this workflow. This key cannot reply on that account.
5. Run Resource = Account, Operation = List on the same credential. Only those `id`s will work.

---

## SSH note for the implementer

This investigation could not re-query Postgres. Yesterday's dump is the working map of this tenant. Reconfirm ids/owners before any data migration (A3). Stack dir and functions volume: `docs/runbooks/deploy-edge-function.md`.
