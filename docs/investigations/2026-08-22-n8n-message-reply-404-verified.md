# n8n `Message → Reply` 404 `ACCOUNT_NOT_FOUND` — verified investigation

| Field | Value |
|---|---|
| Date | 2026-08-22 (probes run 19:48 UTC) |
| Incident | n8n node `danat-future`, `resource=message`, `operation=reply`, 2026-08-22 19:28:50 UTC |
| Method | Live reproduction against production `https://api.postora.cloud` + PostgREST reads with the service role key |
| SSH | `ssh-contabo-mcp` and direct port 22 both time out. Container logs were **not** available. All evidence below is from the live API and the live database. |
| Status | Root cause proven. **No code changed in this pass.** |

---

## 1. Result

Two separate defects. Only the first causes the reported error; the second is why nobody could find a log line for it.

| # | Defect | Severity | Proven |
|---|---|---|---|
| **A** | The reply is being sent with an API key that does not own the `social_account_id` in the request. `handleMessageReply` correctly rejects it. **This is a workflow misconfiguration, not a backend bug.** | Blocking (user-facing) | Reproduced byte-for-byte |
| **B** | `n8n-api`'s `api_logs` insert **fails silently** on every request that arrives with a multi-hop `X-Forwarded-For`. Side effect: **rate limiting on `n8n-api` is silently disabled**, and no request is ever logged. | High (observability + abuse control) | Reproduced |

---

## 2. Defect A — proven root cause

### The check that fires

`supabase/functions/n8n-api/index.ts:1796-1805`

```ts
const { data: account, error } = await supabase
  .from('social_accounts')
  .select('id, user_id, workspace_id, platform, …')
  .eq('id', accountId)          // primary key lookup, no user scoping
  .maybeSingle();
if (error) return apiError(req, 'Failed to fetch social account', 500, 'INTERNAL_ERROR');
if (!account || account.user_id !== userId) {
  return apiError(req, 'Social account not found or not owned by the authenticated user.', 404, 'ACCOUNT_NOT_FOUND');
}
```

`userId` comes from `authenticateApiKey` → `profiles.api_key` → `profiles.id`. So the rule is literally: **the API key on the node must belong to the user who owns the account UUID in the body.**

### Live reproduction (19:48 UTC today)

```
POST https://api.postora.cloud/functions/v1/n8n-api/api/v1/messages/reply
x-api-key: <dr.vet.waleedtam@gmail.com key>
{"social_account_id":"d41f6c78-3ac4-42b9-ae2c-7a5c7fa09dfb", …}   # danatfuture's Facebook page

HTTP 404
{"success":false,"error":{"code":"ACCOUNT_NOT_FOUND",
 "message":"Social account not found or not owned by the authenticated user."}}
```

Identical to the n8n error body, character for character. Control: the same key on `GET /api/v1/accounts` returned `200`, so auth itself is fine.

### Tenant map (live `social_accounts`, 19:48 UTC)

`danatfuture@gmail.com` = `12f4ba6a-91a8-4ab7-9286-dd27e8a9db61` owns **exactly three** accounts, all with `workspace_id = NULL`:

| `social_accounts.id` | platform | handle |
|---|---|---|
| `d41f6c78-3ac4-42b9-ae2c-7a5c7fa09dfb` | facebook | Danat Future Company |
| `fb917a00-12db-4e6b-bf82-d2bf70464899` | instagram | danatfuture |
| `13a49575-620c-4c37-8b85-3cecdbba54c9` | threads | danatfuture |

**No WhatsApp account.** Every WhatsApp number on the platform belongs to `dr.vet.waleedtam@gmail.com` (`7fe4d34e-…`), `xsellpointkw@gmail.com`, or other tenants.

### Why the two tenants collide

All three `message.received` / `comment.received` webhooks point at the **same n8n instance**, and they were registered within 2 seconds of each other:

| owner | events | webhook |
|---|---|---|
| `12f4ba6a…` (danat) | `message.received` | `n8n.walidmohamed.com/webhook/e897bba5-…/postora` (19:22:45.658Z) |
| `7fe4d34e…` (Waleed) | `message.received` | `n8n.walidmohamed.com/webhook/a5be3ee5-…/postora` (19:22:46.868Z) |
| `12f4ba6a…` (danat) | `comment.received` | `n8n.walidmohamed.com/webhook/09f0c6aa-…/postora` (19:22:47.278Z) |

None have `filters`. Then, six minutes before the failure, `social_inbox_events` shows both tenants receiving IG DMs five seconds apart:

```
19:23:18.066  user 12f4ba6a  acct fb917a00 (danatfuture)  "hi there"
19:23:23.564  user 7fe4d34e  acct 2afd638b (vigrox.kw)    "Hi there! 👋 Welcome to our perfume shop! …"
```

Two Postora credentials + two triggers + one n8n canvas = a node holding tenant X's key while its input carries tenant Y's `social_account_id`.

### What the DB cannot tell us — and the 30-second check that can

The exact `social_account_id` sent at 19:28:50 is unrecoverable (see Defect B — nothing was logged, and `api_logs` never stores request bodies). Both directions produce the identical 404:

Open the failed execution → node `danat-future` → the **evaluated** `Social Account ID`:

| Evaluated UUID | Meaning | Fix |
|---|---|---|
| `d41f6c78…`, `fb917a00…`, or `13a49575…` | Input is danat's; the node's **credential is wrong** (Waleed's key) | Switch the node's Postora credential to danatfuture's API key |
| `2afd638b…` (vigrox.kw) or any other Waleed/xsellpoint account | Credential is danat's; the node's **input is cross-wired** to Waleed's trigger | Point Social Account ID at danat's trigger, or split the two tenants into two workflows |
| Anything else | Hardcoded / hallucinated UUID (an AI Agent between trigger and node) | Use the trigger fallback expression in §4, Fix 1 |

Cross-check with the same credential: `GET /api/v1/accounts` — the UUID must appear in `accounts[].id`. If it does not, the 404 is working as designed.

### Ruled out (with evidence)

| Hypothesis | Why not |
|---|---|
| Route missing / not deployed | The live endpoint answered with Postora's own `apiError` envelope |
| Bad API key | That is `401 UNAUTHORIZED`; control request returned `200` |
| Meta / Evolution send failure | That is `502 MESSAGE_SEND_FAILED` |
| Platform mismatch | That is `400 INVALID_PLATFORM` |
| Empty Social Account ID | `requireParam` throws locally, no HTTP call |
| Non-UUID value (`sender.id`, username, page id) | `social_accounts.id` is `uuid`; Postgres raises `22P02` → the handler maps it to **500 `INTERNAL_ERROR`**, not 404 |
| Trigger dropping `social_account_id` | `buildMessagePayload` always sets it; the 19:23 events carry it |
| Workspace/ACL gap | danat's three accounts have `workspace_id = NULL`; no workspace ACL would have allowed this |

---

## 3. Defect B — `api_logs` writes and rate limiting are silently dead (new finding)

Neither prior investigation found this. It is why grok and agy both hit a wall looking for logs.

### Evidence

- `api_logs` has **134 rows total, ever**. Newest: `2026-08-22T14:13:48Z`.
- **Zero rows for `/api/v1/messages/reply` in the table's entire history**, including the 19:28 failure and my 19:48 probes.
- Two authenticated probes at 19:48 (`GET /accounts` → 200, `POST /messages/reply` → 404) produced **no rows at all**.
- `x-ratelimit-remaining: 100` (of 100) on `/accounts` after several calls within the same minute.

### Mechanism

`supabase/functions/n8n-api/index.ts:38-80` — `checkRateLimit` counts rows in `api_logs`, then:

```ts
const ipAddress = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip');
…
await supabase.from('api_logs').insert({ user_id, endpoint, method, ip_address: ipAddress, status_code });
//    ^ result never destructured; the error is discarded
```

`api_logs.ip_address` is `INET`. Behind Cloudflare → Kong, `X-Forwarded-For` is a **comma-separated chain**, which `INET` rejects. Proven directly:

```
POST /rest/v1/api_logs  {"ip_address":"1.2.3.4, 5.6.7.8", …}
HTTP 400
{"code":"22P02","message":"invalid input syntax for type inet: \"1.2.3.4, 5.6.7.8\""}
```

Because the insert result is never inspected, the failure is invisible. And since the limiter counts rows it can no longer write, **`currentCount` is permanently 0 → every request is allowed**. The rate limiter has been reporting a full budget while enforcing nothing.

### Caveat

The one row that did land today (`14:13:48`, `comments/reply`) has `ip_address: null` — that request carried neither header, so at least one n8n→API path reaches the function without the proxy chain. Scope the claim to *requests arriving with a multi-hop `X-Forwarded-For`*; the fix is the same either way.

`★ Insight ─────────────────────────────────────`
Two things made this bug invisible for months: (1) the insert's `{ error }` is never destructured, so PostgREST's rejection is swallowed by an `await` that looks like it succeeded; and (2) the limiter derives its budget from the very table it failed to write, so the failure mode is *permissive*, not restrictive — nothing breaks loudly, the quota just silently becomes infinite. A rate limiter that fails open on a write error should log at minimum; ideally it fails closed or falls back to `_shared/rate-limiter.ts`, which this function does not use.
`─────────────────────────────────────────────────`

---

## 4. Guidance for the fix

### Do **not** do this

Agy's **Option B** — an `isUserAdmin()` bypass of the ownership check in `handleMessageReply` / `loadOwnedCommentAccount` — must be rejected. It converts a tenancy boundary on a *message-sending* path into an admin-wide cross-tenant send capability, and it would paper over the actual workflow misconfiguration rather than fix it. Grok's warning on this point is correct.

Grok's **Fix 3** (workspace-wide ACL) is also inapplicable here: all three danat accounts have `workspace_id = NULL`, so workspace membership would not have granted access. Do not ship it to make this 404 disappear.

### Fix 0 — operational, no deploy (unblocks the user now)

Per the table in §2: put the correct credential on the node, or stop feeding it another tenant's trigger. One workflow per Postora tenant is the safe shape.

### Fix 1 — n8n node hardening (`F:\N8N\Postora-n8n-community-node`, the only node location)

> This section originally said to apply the change to a vendored copy under this
> repo as well. That copy was deleted on 2026-08-22 and must not be recreated —
> following the old instruction would reintroduce divergent node source. Publish
> only from `F:\N8N\Postora-n8n-community-node`.

Message fields still carry the pre-fix defaults; the Comment fields were patched today (`Postora.node.ts:471`) and Message was not.

1. Mirror the comment fallback on `messageSocialAccountId` / `messageRecipientId`:
   ```
   {{ $json.social_account_id ?? $('Postora Trigger').first().json.social_account_id }}
   {{ $json.sender.id || $json.sender.phone || $('Postora Trigger').first().json.sender.id }}
   ```
   Keep `??` so a directly-wired trigger short-circuits.
2. Pass the `jsonPath` argument to `requireParam` for both, so an empty value after an AI Agent names the real cause.
3. Add the existing `isValidUuid` guard **before** the HTTP call, with a message that names the three wrong things people paste (`sender.id`, the platform numeric id, the username) and points at `Account → List`. A *foreign but valid* UUID must still reach the API — that path is the tenancy check and stays server-side.
4. Update the field description to say it is the Postora `social_accounts.id` UUID.
5. Gates in `F:\N8N\Postora-n8n-community-node`: `npx tsc --noEmit`, `npm test`. Then `clean-code-guard` on node source, `test-guard` on `__tests__/Postora.node.test.ts` (copy the comment-field suite at ~L879). **No npm release unless asked** — community nodes never auto-update.

### Fix 2 — `n8n-api` diagnostics (`supabase/functions/n8n-api/index.ts`)

In `handleMessageReply` **and** `loadOwnedCommentAccount`:

1. Validate UUID syntax **before** the query → `400 INVALID_ACCOUNT_ID` (today a non-UUID becomes a misleading `500`).
2. On the ownership failure, log — **no tokens, no request body**:
   ```
   [n8n-api] ACCOUNT_NOT_FOUND accountId=<uuid> authUser=<uuid> rowExists=<bool> ownerUser=<uuid|null>
   ```
3. Keep the client-facing response at `404 ACCOUNT_NOT_FOUND` with the same non-enumerable text. Do not reveal whether the row exists.

### Fix 3 — `api_logs` / rate limiter (Defect B), same file, `checkRateLimit`

1. Take the first hop only, and prefer the trusted header:
   ```ts
   const forwarded = req.headers.get('x-forwarded-for');
   const ipAddress = req.headers.get('cf-connecting-ip')
     ?? (forwarded ? forwarded.split(',')[0].trim() : null);
   ```
2. Destructure and log the insert error instead of discarding it:
   ```ts
   const { error: logError } = await supabase.from('api_logs').insert({ … });
   if (logError) console.error('api_logs insert failed:', logError.message);
   ```
3. Add a regression test asserting that a comma-separated `X-Forwarded-For` yields a single valid IP.
4. After deploy, re-verify: two calls to `/api/v1/accounts` must produce two `api_logs` rows and `x-ratelimit-remaining` must decrement.

> Note for whoever ships this: fixing the insert **re-arms rate limiting**, which has effectively been off. Confirm the configured limits are workable for current automation volume before deploying, or the fix will land as an outage. Do not read the numbers from this document — since the unified rate-limits change they live in the `rate_limit_settings` table and are editable from the admin Rate Limits page, and the values that were current when this was written (60/h and 120/h) are no longer the deployed ones.

### Deployment

Edge-function changes go out via `docs/runbooks/deploy-edge-function.md` — copy into
`/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`, verify SHA256, then
`docker compose up -d --no-deps functions`. **Not** `npx supabase functions deploy`.
SSH was unreachable during this investigation; it must be restored first.

---

## 5. Adjacent risk worth one look

At 19:23:23 an obvious AI-agent reply — *"Hi there! 👋 Welcome to our perfume shop! …"* — arrived as an **inbound** `message.received` on `vigrox.kw` (Waleed's IG). Comment automation suppresses messages authored by the *same* account, but nothing suppresses tenant A's bot talking to tenant B's bot on the same n8n instance. Two automations pointed at each other will loop until a rate limit stops them — and per Defect B, no rate limit currently would.

---

## 6. What is still open

| Item | Blocker |
|---|---|
| The exact UUID sent at 19:28:50 | Nothing was logged (Defect B); n8n execution data is the only source |
| Function container logs for 19:28 | SSH to `86.48.2.205:22` times out |
| Whether the 19:28 request took the Cloudflare path | Can be settled once Fix 3 lands and rows appear |
