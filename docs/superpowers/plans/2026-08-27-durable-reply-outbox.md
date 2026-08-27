# Durable Reply Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer's inbound message still gets an AI reply when the edge worker that was generating it is killed mid-flight.

**Architecture:** The webhook durably records the *inbound work item* before starting background work, and a cron-driven recovery function re-drives any item still unfinished after two minutes. Re-driving is made safe by an idempotency key that `ai-agent-reply` checks before it sends, so a worker killed after delivery but before bookkeeping does not produce a second reply.

**Tech Stack:** Postgres (new table, two `SECURITY DEFINER` functions, `pg_cron`), Deno edge functions, `deno test`.

**Spec:** none — this plan is written directly from the task brief pasted on 2026-08-27, whose relevant text is reproduced under "The brief, and where this plan departs from it".

**Status:** DRAFT — awaiting three decisions (marked **Decision required**) before implementation begins.

---

## Global Constraints

- Every new table: RLS enabled, explicit policies or a deliberate deny-all, FKs indexed (`ARCHITECTURE.md` §23).
- `SECURITY DEFINER` functions: controlled `search_path`, minimal grants, no dynamic SQL (§23).
- No new edge function returns 5xx for an application error — Cloudflare replaces the body and the real reason is lost (memory: `postora-cloudflare-masks-origin-5xx`).
- The whole inbound request must fit the **60-second edge-worker ceiling**; today's worst case is already ~50s (memory: `postora-edge-worker-60s-ceiling`).
- Never blindly retry a send that can duplicate a side effect; use idempotency keys (§26).
- Background work must be idempotent or safely deduplicated (§27).
- Deploy is manual: files copied into the functions volume, then `docker compose -p postorasupabase-supabase-j8axyh restart functions` (`CLAUDE.md` step 7). `npx supabase functions deploy` does **not** work against this self-hosted stack.
- Gates: `npx tsc --noEmit`, `npx vitest run`, `deno test --allow-env --allow-read`, `clean-code-guard`, `test-guard`.
- Branch `feat/durable-reply-outbox`. Commits scoped to named files. **Open a PR; do not merge.**

---

## The brief, and where this plan departs from it

Three things in the brief cannot be implemented as written. Each is a decision for the reviewer, not something this plan should quietly substitute.

### Departure 1 — the durable unit is the inbound work item, not the generated reply

The brief says:

> Before `runInBackground()`: Insert a 'pending' row once the reply is generated but before sending.

The webhook never has a generated reply. It calls `triggerAiAgentReply`, which is an HTTP POST to the `ai-agent-reply` function; generation and delivery both happen inside that function, in a different isolate. There is no point in the webhook where `generated_reply` exists.

More importantly, that is not where the loss happens. The window established while fixing #42 is the **whole continuation**:

```ts
runInBackground(async () => {
  await runInboundMediaUnderstanding(...)   // download (10s) + model (20s)
  await triggerAiAgentReply(...)            // generation + delivery (20s)
})
```

A worker killed at any point in those ~50 seconds drops the customer's message entirely, and the most likely kill points are *before* generation, not after. An outbox that only starts recording once a reply exists is blind to most of the outage it is meant to survive.

**This plan therefore persists the inbound work item** — everything needed to re-invoke `ai-agent-reply` from scratch — written *before* `runInBackground` is entered. `generated_reply` becomes a nullable column filled in on success, useful for audit rather than for recovery.

| | Brief as written | This plan |
|---|---|---|
| Row written when | after generation | before background work starts |
| Row contains | the finished reply | the inbound request |
| Recovery does | re-send stored text | re-invoke `ai-agent-reply` |
| Survives a kill during media understanding | no | yes |
| Survives a kill during generation | no | yes |
| Survives a kill during delivery | yes | yes |

**Decision required.** If the reviewer prefers the brief's version, Task 3 changes shape and Tasks 5–6 shrink considerably.

### Departure 2 — retrying a send needs an idempotency key, and `ai-agent-reply` has none

The brief's Step 5 says the `message_id` UNIQUE constraint prevents double-replies. It does not. It prevents two *rows*; it does nothing about one row being driven twice. The dangerous sequence is:

1. `ai-agent-reply` generates, sends the Messenger message, writes its `ai_agent_logs` row.
2. The worker dies **before** the outbox row is updated to `sent`.
3. Two minutes later the recovery job sees an unfinished row and re-invokes.
4. The customer receives the same answer twice — or a different answer to the same question, which is worse.

`ARCHITECTURE.md` §26 forbids exactly this. So the plan adds an **idempotency key** (the outbox row's `id`) to the `ai-agent-reply` request contract. `ai-agent-reply` records it and refuses to send a second time for a key that already reached `status='sent'`.

This is real added scope the brief did not ask for. It is also the difference between an outbox that protects customers and one that annoys them.

### Departure 3 — `threads-poll-replies` does not call the agent

The brief says to apply the outbox to `facebook-instagram-webhook` and `threads-poll-replies`. The Threads poller contains no call to `ai-agent-reply`; it hands comments to `_shared/threadsCommentIngest.ts`, and the agent is invoked from `_shared/commentAutomation.ts:98` — which is the **shared** comment path for Facebook, Instagram and Threads alike.

So "Threads only" is not separable at that call site without a platform condition, which would be an arbitrary line through one code path. Two coherent options:

- **3a (recommended):** cover the whole comment path in `commentAutomation.ts` — all three platforms — since it is one function carrying one risk.
- **3b:** cover DMs only (`facebook-instagram-webhook`) in this change and leave comments to a follow-up.

**Decision required.**

### Also needing a decision — WhatsApp Cloud is on neither list

The brief excludes WhatsApp Evolution ("it has its own reliability layer") and names FB/IG and Threads as in scope. It never mentions **`whatsapp-webhook`** (the Cloud path). That path runs the identical `runInBackground(understand → trigger)` shape and carries the same ~50s exposure. Leaving it out means the outbox covers the surfaces with less traffic and skips the one with most.

This plan **assumes WhatsApp Cloud is out of scope**, as literally specified, and flags it as the largest remaining hole.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260828000000_pending_agent_replies.sql` | table, RLS, indexes, `claim_pending_agent_replies`, the `ai_agent_logs` idempotency column, the cron entry |
| `supabase/functions/_shared/pendingReplies.ts` | **new.** Outbox client: `recordPendingReply`, `markReplySent`, `markReplyFailed`. The single place that knows the table's shape. |
| `supabase/functions/_shared/pendingReplies.test.ts` | **new.** |
| `supabase/functions/ai-agent-reply/idempotency.ts` | **new.** `alreadyDelivered`. A sibling module because `index.ts` is a `Deno.serve` module and importing it starts a server. |
| `supabase/functions/ai-agent-reply/idempotency.test.ts` | **new.** |
| `supabase/functions/process-pending-replies/index.ts` | **new.** Cron-invoked recovery: claim → re-invoke → settle. |
| `supabase/functions/process-pending-replies/recovery.ts` | **new.** The pure decision logic, separated so it is testable. |
| `supabase/functions/process-pending-replies/recovery.test.ts` | **new.** |
| `supabase/functions/ai-agent-reply/index.ts` | accept and honour `idempotency_key` |
| `supabase/functions/facebook-instagram-webhook/index.ts` | write the row before `runInBackground`; settle it inside |
| `supabase/functions/_shared/commentAutomation.ts` | same, for the comment path (Option 3a only) |

---

## Task 1: The table and its claim function

**Files:**
- Create: `supabase/migrations/20260828000000_pending_agent_replies.sql`

**Interfaces:**
- Produces: table `public.pending_agent_replies`; function `public.claim_pending_agent_replies(p_limit INTEGER, p_stale_seconds INTEGER, p_max_attempts INTEGER) RETURNS SETOF public.pending_agent_replies`.

- [ ] **Step 1: Write the table**

```sql
CREATE TABLE IF NOT EXISTS public.pending_agent_replies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  social_account_id UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL,
  platform          TEXT NOT NULL,
  -- The platform's id for the INBOUND message. Dedup key: a webhook redelivery must not
  -- create a second work item. Called message_id rather than mid because Threads and
  -- WhatsApp do not use Meta's name for it.
  message_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  recipient_id      TEXT NOT NULL,
  -- Everything ai-agent-reply needs to be re-invoked from scratch. This is the durable
  -- unit: a worker killed before generation is recoverable only because this is here.
  inbound_text      TEXT NOT NULL,
  language_hint     TEXT,
  comment_id        TEXT,
  -- Filled in on success, for audit. NOT what recovery replays -- see Departure 1. A row
  -- that reaches 'sent' with this null means the reply went out but the response body was
  -- not captured, which is not an error.
  generated_reply   TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at        TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  error             TEXT,
  CONSTRAINT pending_agent_replies_dedup UNIQUE (social_account_id, message_id)
);

ALTER TABLE public.pending_agent_replies ENABLE ROW LEVEL SECURITY;
-- Deny-all: written only by webhooks and the recovery job, both service-role. No browser
-- surface reads it -- the user-facing record of a reply is ai_agent_logs, which has its
-- own RLS already.

-- The recovery job's only query: unfinished rows, oldest first. Partial, because the
-- table is mostly settled rows the job must never scan.
CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_recoverable
  ON public.pending_agent_replies (created_at)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_account
  ON public.pending_agent_replies (social_account_id);
```

- [ ] **Step 2: Add the claim function to the same migration**

Claiming must be atomic, or two overlapping cron runs drive the same row twice — the very duplicate the outbox exists to avoid.

```sql
/**
 * Atomically claims recoverable work: rows still unfinished after p_stale_seconds that
 * have not exhausted p_max_attempts.
 *
 * FOR UPDATE SKIP LOCKED is what lets two overlapping cron runs coexist -- the second
 * skips what the first holds instead of blocking on it. Claiming moves the row to
 * 'sending' and bumps attempts, so a row whose worker dies again is picked up next pass
 * and eventually exhausts its attempts rather than being retried forever.
 */
CREATE OR REPLACE FUNCTION public.claim_pending_agent_replies(
  p_limit INTEGER,
  p_stale_seconds INTEGER,
  p_max_attempts INTEGER
)
RETURNS SETOF public.pending_agent_replies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id FROM public.pending_agent_replies
    WHERE status IN ('pending', 'sending')
      AND attempts < p_max_attempts
      AND created_at < now() - make_interval(secs => p_stale_seconds)
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.pending_agent_replies p
     SET status = 'sending', attempts = p.attempts + 1, claimed_at = now()
    FROM claimed
   WHERE p.id = claimed.id
  RETURNING p.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_agent_replies(INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_agent_replies(INTEGER, INTEGER, INTEGER)
  TO service_role;
```

- [ ] **Step 3: Rehearse against the real database, in a rolled-back transaction**

Over `ssh-contabo-mcp` (`docker exec ... psql`), wrapped in `BEGIN; ... ROLLBACK;` so production is untouched. Assert, and paste the transcript into the PR:

- a row created 10 seconds ago is **not** returned with `p_stale_seconds := 120`;
- the same row backdated 3 minutes **is** returned, once;
- a second call in the same session does not return it again at `p_max_attempts := 1`;
- a row already at `attempts = 3` is never returned.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260828000000_pending_agent_replies.sql
git commit -m "feat(outbox): a table for inbound work items that outlive their worker"
```

---

## Task 2: The outbox client

**Files:**
- Create: `supabase/functions/_shared/pendingReplies.ts`
- Test: `supabase/functions/_shared/pendingReplies.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PendingReplyItem` — the fields Task 1's table needs from a caller.
  - `recordPendingReply(admin: any, item: PendingReplyItem): Promise<string | null>` — the row id, or `null` when the row could not be written **or already existed**.
  - `markReplySent(admin: any, id: string, reply: string | null): Promise<void>`
  - `markReplyFailed(admin: any, id: string, error: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { recordPendingReply, toRow } from "./pendingReplies.ts";

const ITEM = {
  socialAccountId: "acc-1",
  userId: "user-1",
  platform: "facebook",
  messageId: "mid-1",
  conversationId: "conv-1",
  recipientId: "psid-1",
  inboundText: "[Image]",
};

function stubInsert(result: { data?: unknown; error?: unknown }) {
  return {
    from: () => ({
      insert: () => ({ select: () => ({ maybeSingle: () => Promise.resolve(result) }) }),
    }),
  };
}

Deno.test("a duplicate inbound message does not create a second work item", async () => {
  // Meta redelivers a webhook it believes was not acknowledged. The unique constraint is
  // what stops that becoming a second reply; recordPendingReply must report it as
  // "already handled" rather than as an error the caller should log loudly.
  const admin = stubInsert({ error: { code: "23505", message: "duplicate key" } });
  assertEquals(await recordPendingReply(admin, ITEM), null);
});

Deno.test("an outbox write that fails does not stop the reply", async () => {
  // A reply that goes out with no outbox row is strictly better than no reply at all.
  // This function must never throw -- the caller's next line is the customer-facing work.
  const admin = stubInsert({ error: { code: "08006", message: "connection failure" } });
  assertEquals(await recordPendingReply(admin, ITEM), null);
});

Deno.test("a recorded item carries everything needed to re-invoke the agent", () => {
  // If any of these is dropped, recovery silently produces a DIFFERENT reply than the
  // original would have -- wrong language, wrong conversation, or a DM where a comment
  // reply was meant. The assertion is on the whole key set, not on presence, so a field
  // added to the type without being mapped fails here rather than in production.
  assertEquals(Object.keys(toRow(ITEM)).sort(), [
    "comment_id",
    "conversation_id",
    "inbound_text",
    "language_hint",
    "message_id",
    "platform",
    "recipient_id",
    "social_account_id",
    "user_id",
  ]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `deno test --allow-env supabase/functions/_shared/pendingReplies.test.ts`
Expected: FAIL — "Module not found".

- [ ] **Step 3: Implement**

```ts
// Records an inbound message as work that must eventually produce a reply.
//
// The point of this module is that the record outlives the isolate. Everything the agent
// needs to run from scratch is written down BEFORE the work starts, because the worker can
// die at any point during it and a row written afterwards would never exist.

export interface PendingReplyItem {
  socialAccountId: string;
  userId: string;
  platform: string;
  messageId: string;
  conversationId: string;
  recipientId: string;
  inboundText: string;
  languageHint?: string | null;
  commentId?: string | null;
}

const UNIQUE_VIOLATION = "23505";

export function toRow(item: PendingReplyItem): Record<string, unknown> {
  return {
    social_account_id: item.socialAccountId,
    user_id: item.userId,
    platform: item.platform,
    message_id: item.messageId,
    conversation_id: item.conversationId,
    recipient_id: item.recipientId,
    inbound_text: item.inboundText,
    language_hint: item.languageHint ?? null,
    comment_id: item.commentId ?? null,
  };
}

/**
 * Records the work item, returning its id.
 *
 * Never throws and never blocks the reply. Two different nulls are deliberately
 * indistinguishable to the caller: the row already existed (a webhook redelivery, which is
 * a success), or the write failed (a degradation we accept). In both cases the correct next
 * action is identical -- carry on and answer the customer.
 */
export async function recordPendingReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  item: PendingReplyItem,
): Promise<string | null> {
  const { data, error } = await admin
    .from("pending_agent_replies")
    .insert(toRow(item))
    .select("id")
    .maybeSingle();

  if (error?.code === UNIQUE_VIOLATION) {
    console.log(`[outbox] ${item.platform}/${item.messageId} already recorded`);
    return null;
  }
  if (error) {
    console.error(`[outbox] could not record ${item.platform}/${item.messageId}: ${error.message}`);
    return null;
  }
  return data?.id ?? null;
}
```

`markReplySent` and `markReplyFailed` follow the same never-throw contract, each a single `update(...).eq("id", id)` whose error is logged and swallowed. `markReplySent` sets `status: "sent"`, `sent_at: new Date().toISOString()`, `generated_reply`. `markReplyFailed` sets `status: "failed"` and `error` truncated to 500 characters.

- [ ] **Step 4: Run the tests**

Run: `deno test --allow-env supabase/functions/_shared/pendingReplies.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/pendingReplies.ts supabase/functions/_shared/pendingReplies.test.ts
git commit -m "feat(outbox): a client that records work items without ever blocking a reply"
```

---

## Task 3: Idempotency in `ai-agent-reply`

Do this **before** wiring any webhook. Until the key exists, every recovery attempt is a potential duplicate reply, and a half-built outbox is worse than none at all.

**Files:**
- Create: `supabase/functions/ai-agent-reply/idempotency.ts`
- Test: `supabase/functions/ai-agent-reply/idempotency.test.ts`
- Modify: `supabase/functions/ai-agent-reply/index.ts` (`ReplyRequest` ~line 57; `baseLog`; the request handler's entry)
- Modify: `supabase/migrations/20260828000000_pending_agent_replies.sql` — the column belongs in the **same** migration, so the two halves cannot be deployed apart

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `alreadyDelivered(admin, key: string | undefined): Promise<boolean>`; `ReplyRequest.idempotency_key?: string`; column `public.ai_agent_logs.idempotency_key TEXT`.

- [ ] **Step 1: Add the column and index to Task 1's migration**

```sql
ALTER TABLE public.ai_agent_logs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial AND unique: two 'sent' rows for one key is precisely the duplicate reply this
-- prevents, and the database is where that has to be true -- an application-code check
-- loses the race it exists to win. Non-sent rows are unconstrained on purpose: a failed
-- attempt must not block the retry that succeeds.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_logs_idempotency_sent
  ON public.ai_agent_logs (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'sent';
```

- [ ] **Step 2: Write the failing tests**

```ts
Deno.test("a key that already sent is refused before the model is called", async () => {
  const admin = stubLogs([{ id: "log-1" }]);
  assertEquals(await alreadyDelivered(admin, "key-1"), true);
});

Deno.test("a key that only ever errored is allowed to try again", async () => {
  // A retry after a failure is the entire point of the outbox. Treating any prior row as
  // "delivered" would turn one transient provider error into permanent silence for that
  // customer -- a worse bug than the one being fixed.
  const admin = stubLogs([]);   // the query filters status='sent', so an error row is absent
  assertEquals(await alreadyDelivered(admin, "key-1"), false);
});

Deno.test("a request with no key is never blocked", async () => {
  // Every caller that predates the outbox sends no key. They must behave exactly as before,
  // and must not pay for a lookup either.
  let queried = false;
  const admin = { from: () => { queried = true; return stubLogs([]).from(); } };
  assertEquals(await alreadyDelivered(admin, undefined), false);
  assertEquals(queried, false);
});

Deno.test("a lookup that errors fails OPEN", async () => {
  // Opposite of the media cap's fail-closed. Refusing to answer a customer because a log
  // lookup failed is worse than a rare duplicate, and the unique index is the backstop
  // that keeps the duplicate rare rather than routine.
  assertEquals(await alreadyDelivered(stubLogsError("db down"), "key-1"), false);
});
```

- [ ] **Step 3: Run them** — expect FAIL, `alreadyDelivered` not defined.

- [ ] **Step 4: Implement**

```ts
/**
 * Whether this exact work item has already been delivered.
 *
 * The recovery job cannot tell "the worker died before sending" from "the worker died
 * after sending but before its bookkeeping" -- both leave the same unfinished row. This is
 * the only thing that can, and it is why re-driving a row is safe at all.
 */
export async function alreadyDelivered(
  // deno-lint-ignore no-explicit-any
  admin: any,
  key: string | undefined,
): Promise<boolean> {
  if (!key) return false;
  const { data, error } = await admin
    .from("ai_agent_logs")
    .select("id")
    .eq("idempotency_key", key)
    .eq("status", "sent")
    .limit(1);
  if (error) {
    console.error(`[ai-agent-reply] idempotency lookup failed: ${error.message}`);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
```

Then in `index.ts`:
1. add `idempotency_key?: string` to `ReplyRequest` (beside `language_hint`, with a comment saying who sets it);
2. immediately after the request is parsed, `if (await alreadyDelivered(admin, request.idempotency_key)) return jsonResponse({ ok: true, deduplicated: true });`
3. add `idempotency_key: request.idempotency_key ?? null` to `baseLog`, so **every** outcome row carries it — not only the `sent` one, or the recovery job cannot distinguish "never ran" from "ran and failed".

- [ ] **Step 5: Run the tests** — expect PASS (4 tests).

- [ ] **Step 6: Prove the unique index actually bites**

In a rolled-back transaction on the real database: insert two `ai_agent_logs` rows with the same key and `status='sent'` — the second must raise `23505`. Then insert one `sent` and one `error` sharing a key — both must succeed. A partial unique index that silently does not apply is indistinguishable from a working one until the day it matters.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/ai-agent-reply/idempotency.ts supabase/functions/ai-agent-reply/idempotency.test.ts supabase/functions/ai-agent-reply/index.ts supabase/migrations/20260828000000_pending_agent_replies.sql
git commit -m "feat(agent): an idempotency key, so a replayed work item cannot reply twice"
```

---

## Task 4: Wire `facebook-instagram-webhook`

**Files:**
- Modify: `supabase/functions/facebook-instagram-webhook/index.ts` (the `automationHandler === "internal" && !ruleReplied` block ~line 303; `triggerAiAgentReply` ~line 584)

**Interfaces:**
- Consumes: `recordPendingReply`, `markReplySent`, `markReplyFailed` (Task 2); `idempotency_key` (Task 3).

- [ ] **Step 1: Record before the background work begins**

The row must be written **outside** `runInBackground`, on the response path. Writing it inside means a worker killed early leaves nothing to recover — which is the whole failure being fixed.

```ts
const pendingId = await recordPendingReply(adminClient, {
  socialAccountId: account.id,
  userId: account.user_id,
  platform,
  messageId: event.message.mid || `${senderId}:${event.timestamp}`,
  conversationId,
  recipientId: senderId,
  // The placeholder, not the understood text: understanding has not happened yet, and
  // recovery re-runs it. Storing a transcript here would make the row a snapshot of work
  // that may never have completed.
  inboundText: messageText,
});
```

Both branches of the existing `if (readable && readable.url)` need it — the plain-text path drops replies the same way.

- [ ] **Step 2: Settle it inside the continuation**

```ts
try {
  await triggerAiAgentReply(account, { platform, conversationId, senderId, inboundText: agentText, languageHint, idempotencyKey: pendingId });
  if (pendingId) await markReplySent(adminClient, pendingId, null);
} catch (error) {
  if (pendingId) await markReplyFailed(adminClient, pendingId, errorMessage(error));
  throw error;   // runInBackground already logs the failure; rethrowing preserves that
}
```

Note `triggerAiAgentReply` currently swallows a non-2xx by logging it, so **Step 3 must also make it throw** on failure — otherwise every row settles as `sent` regardless and the outbox records fiction.

- [ ] **Step 3: Collapse `triggerAiAgentReply`'s parameters and make failure observable**

Adding the key would make it a 7-parameter function, past the 4-arg ceiling — and two of the existing parameters are adjacent strings a caller can transpose in silence. Collapse to `(account, request: AgentReplyRequest)` in this step, the same refactor applied to `reserveAttempt` in PR #43. In the same change, make a non-2xx response throw rather than only log.

- [ ] **Step 4: Verify no regression**

Run: `deno test --allow-env --allow-read supabase/functions/facebook-instagram-webhook/` then `deno check supabase/functions/facebook-instagram-webhook/index.ts`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/facebook-instagram-webhook/index.ts
git commit -m "feat(outbox): FB/IG DMs survive a worker that dies mid-reply"
```

---

## Task 5: The recovery job's decision logic

**Files:**
- Create: `supabase/functions/process-pending-replies/recovery.ts`
- Test: `supabase/functions/process-pending-replies/recovery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RECOVERY_LIMITS` (`{ batch: 25, staleSeconds: 120, maxAttempts: 3 }`); `classifyRecovery(row: { attempts: number }, response: RecoveryResponse | null): { action: "sent" | "retry" | "give_up"; reason: string }`; `buildReplyRequest(row): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("a row that has exhausted its attempts is failed, not retried", () => {
  assertEquals(classifyRecovery({ attempts: 3 }, null).action, "give_up");
});

Deno.test("a deduplicated response settles the row as sent, not as an error", () => {
  // ai-agent-reply reporting "already delivered" means the FIRST attempt did reach the
  // customer. Marking that failed would leave a permanently red row for a reply that
  // actually went out, and send an operator hunting a bug that is not there.
  assertEquals(classifyRecovery({ attempts: 1 }, { ok: true, deduplicated: true }).action, "sent");
});

Deno.test("a 5xx is retried; a 4xx is not", () => {
  // A malformed row will be malformed on every attempt. Retrying it three times buys
  // nothing and delays the rows queued behind it.
  assertEquals(classifyRecovery({ attempts: 1 }, { status: 503 }).action, "retry");
  assertEquals(classifyRecovery({ attempts: 1 }, { status: 400 }).action, "give_up");
});

Deno.test("the replay request is the original request, not a paraphrase of it", () => {
  // Recovery must reconstruct exactly what the webhook would have sent. A dropped
  // language_hint produces an English answer to an Arabic voice note -- the bug #42 fixed,
  // reintroduced only on the recovery path where nobody would look for it.
  const row = { id: "row-1", user_id: "u", platform: "facebook", social_account_id: "a",
                conversation_id: "c", recipient_id: "r", inbound_text: "hi",
                language_hint: "ara", comment_id: null };
  assertEquals(buildReplyRequest(row), {
    user_id: "u", platform: "facebook", social_account_id: "a", conversation_id: "c",
    recipient_phone: "r", inbound_text: "hi", language_hint: "ara",
    idempotency_key: "row-1",
  });
});
```

- [ ] **Step 2: Run them** — expect FAIL, module not found.
- [ ] **Step 3: Implement** `classifyRecovery` and `buildReplyRequest` as pure functions. `comment_id` is omitted from the request when null, matching how `language_hint` is conditionally spread today.
- [ ] **Step 4: Run the tests** — expect PASS (4 tests).
- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-pending-replies/recovery.ts supabase/functions/process-pending-replies/recovery.test.ts
git commit -m "feat(outbox): the rules for what recovery retries and what it gives up on"
```

---

## Task 6: The recovery function and its cron

**Files:**
- Create: `supabase/functions/process-pending-replies/index.ts`
- Modify: `supabase/migrations/20260828000000_pending_agent_replies.sql` (cron entry)

**Interfaces:**
- Consumes: `claim_pending_agent_replies` (Task 1); `classifyRecovery`, `buildReplyRequest`, `RECOVERY_LIMITS` (Task 5); `markReplySent`, `markReplyFailed` (Task 2).

- [ ] **Step 1: Write the function**

Authorization mirrors `threads-poll-replies`: `Authorization: Bearer <CRON_SECRET>`, compared in constant time, **401 on mismatch and never 5xx** — Cloudflare replaces a 5xx body and the real reason never reaches the logs.

```ts
const { data: claimed, error } = await admin.rpc("claim_pending_agent_replies", {
  p_limit: RECOVERY_LIMITS.batch,
  p_stale_seconds: RECOVERY_LIMITS.staleSeconds,
  p_max_attempts: RECOVERY_LIMITS.maxAttempts,
});
```

Each claimed row is re-POSTed to `ai-agent-reply` with `idempotency_key: row.id`, then settled by `classifyRecovery`. A row that gives up is marked `failed` **and** written to `ai_agent_logs` with `status: "error"`, so the customer's owner sees it in the Logs tab rather than only in a table nobody opens.

Rows are processed **sequentially**, not concurrently: 25 parallel agent invocations each hold a model call, and the batch would exceed the 60-second ceiling and be killed — recreating the exact failure this job exists to repair. With `batch: 25` and a ~20s worst case per row, even the sequential loop can exceed the ceiling, so the loop carries its own deadline and stops early, leaving the remainder for the next run two minutes later.

- [ ] **Step 2: Add the cron entry to the migration**

```sql
DO $$
BEGIN
  PERFORM cron.unschedule('process-pending-agent-replies');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'process-pending-agent-replies',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/process-pending-replies',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_cron_secret()
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Its own schedule, not a piggyback on `process-scheduled-posts`: that job's cadence is chosen for publishing, and coupling reply recovery to it means one job's slow run silently delays the other's.

- [ ] **Step 3: Verify `get_cron_secret()` returns something**

`SELECT get_cron_secret() IS NOT NULL;` over `ssh-contabo-mcp`, **before** relying on the schedule. An unset `CRON_SECRET` makes the job 503 on every run and looks identical to the job never having been scheduled (memory: `postora-cron-secret-unset-503`).

- [ ] **Step 4: End-to-end test on the real database**

Insert one `pending` row backdated three minutes, invoke the function with the cron secret, and confirm: the row reaches `sent`; exactly one `ai_agent_logs` row exists for its key. Then invoke again and confirm no second reply and no second log row. Clean up the inserted row afterwards.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-pending-replies/index.ts supabase/migrations/20260828000000_pending_agent_replies.sql
git commit -m "feat(outbox): a cron-driven recovery pass for replies whose worker died"
```

---

## Task 7: The comment path — Option 3a only

**Skip this task entirely if the reviewer chooses 3b.**

**Files:**
- Modify: `supabase/functions/_shared/commentAutomation.ts` (the `ai-agent-reply` POST at ~line 98)

Same shape as Task 4. `messageId` is the comment id; `commentId` is set, so recovery re-invokes as a comment reply rather than as a DM — a row that loses `comment_id` would answer a public comment by private message.

- [ ] **Step 1:** record before the agent call, using the comment id as `messageId`.
- [ ] **Step 2:** settle on success and on failure.
- [ ] **Step 3:** thread `idempotency_key` into the POST body.
- [ ] **Step 4:** `deno test --allow-env --allow-read supabase/functions/_shared/commentAutomation.test.ts`

> **Blocker to clear first:** that test file has 5 pre-existing `TS2322` errors under `deno check` (`null` assigned to `string` in its fixtures, at lines 136 and 142 among others). They are unrelated to this work — untouched since `0e386f08` — but they block `deno check` on the module and everything importing it. Fix them in this task, in their own commit, so the gate can pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/commentAutomation.ts
git commit -m "feat(outbox): comment replies survive a worker that dies mid-reply"
```

---

## Task 8: Gates, PR, deploy

- [ ] **Step 1:** `npx tsc --noEmit` → 0 errors.
- [ ] **Step 2:** `npx vitest run` → all pass. Baseline as of 2026-08-27: **949 passed, 15 skipped, 0 failed**.
- [ ] **Step 3:** `deno test --allow-env --allow-read` over `_shared/`, `facebook-instagram-webhook/`, `ai-agent-reply/`, `process-pending-replies/` → all pass. Baseline: **428 passed**. `--allow-read` is **required** — without it `planQuotasContract.test.ts` reports a failure that is a missing permission, not a broken test.
- [ ] **Step 4:** `clean-code-guard` on every changed production file; `test-guard` on every changed test file.
- [ ] **Step 5:** Push and open a PR whose body states the three departures and the WhatsApp Cloud gap. **Do not merge.**
- [ ] **Step 6 (after approval only):** apply the migration **first**, then copy the changed function files into the volume, verify SHA256 with `tr -d '\r'` (the volume is LF, the working copy CRLF), and `docker compose -p postorasupabase-supabase-j8axyh restart functions`. Migration first is not a preference: the webhooks reference a table that must already exist, and the reverse order drops every reply for the length of the window.
- [ ] **Step 7:** `mem0 add_memory` with the outcome; final report.

---

## Self-review

**Spec coverage.** Brief Step 1 → Task 1. Step 2 → Task 1 (the table's shape). Step 3 → Task 4, as amended by Departure 1. Step 4 → Tasks 5 and 6. Step 5 → Tasks 1 and 3, as amended by Departure 2. The brief's "do not add to Evolution" is honoured — `whatsapp-evolution-webhook` appears nowhere in the file list.

**Placeholders.** None. Every code step carries either the actual code or the actual file and line to change.

**Type consistency.** `recordPendingReply` returns `Promise<string | null>` in Task 2 and is consumed as `pendingId: string | null` in Tasks 4 and 7. `classifyRecovery` returns `{ action: "sent" | "retry" | "give_up" }` in Task 5 and is consumed in Task 6. `RECOVERY_LIMITS` uses `staleSeconds` in both Task 5 and Task 6.

**Ordering.** Task 3 precedes Task 4 deliberately: wiring a webhook to an outbox whose replays are not yet idempotent means every recovery run risks a duplicate reply.

**Known gaps, stated rather than hidden.**
1. WhatsApp Cloud (`whatsapp-webhook`) is excluded per the brief and is the largest uncovered surface.
2. A reply can still be lost if the worker dies *and* the outbox INSERT itself failed — accepted explicitly by the brief, and the failure is logged.
3. `attempts` is bumped at claim time, not at completion, so a row whose worker dies three times is given up on without three real attempts ever finishing. That is the correct trade: the alternative retries a row that kills its worker forever.
