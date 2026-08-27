# Durable Reply Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer's inbound message still gets an AI reply when the edge worker that was generating it is killed mid-flight — without the recovery itself sending a second reply, repeating a tool call, or escalating twice.

**Architecture:** A **two-stage** outbox. The webhook durably records the *inbound work item* before starting background work. `ai-agent-reply` then persists its *generated reply* before sending. Recovery behaves differently on each side of that line: after generation it only re-delivers text it already has, never re-running the agent; before generation it may re-run the agent, but only while nothing externally visible has happened yet. Anything ambiguous goes to a human rather than being replayed.

**Tech Stack:** Postgres (one table, three `SECURITY DEFINER` functions, `pg_cron`), Deno edge functions, `deno test`.

**Spec:** none — written from the task brief pasted 2026-08-27, whose relevant text is quoted below.

**Status:** REVISION 2 — Codex round 1 returned `REJECT` with 8 blocking findings. Seven were verified true and are fixed here; one was verified false and is rejected with evidence. Three **Decision required** markers remain for the reviewer.

---

## Round 1 review outcome

Codex reviewed revision 1 (`afd5962c`) read-only and rejected it. Every claim was checked against the source before being accepted — the record matters, because two of these are load-bearing enough that adopting them on trust would have been as bad as ignoring them.

### Accepted — and what changed

| # | Finding | Verified how | Fixed in |
|---|---|---|---|
| 1 | The idempotency check does not cover the external send. `replySender` fires at `ai-agent-reply/index.ts:803`; the `sent` log is written at `:838`; `logOutcome` swallows its insert error at `:213`. A death or a failed insert in between leaves no `sent` row, and recovery sends again. Two concurrent invocations can also both pass `alreadyDelivered` and both send. | Read all three line ranges | Tasks 1, 3, 5 — staged states, a lease, and `delivery_unknown` |
| 2 | `FOR UPDATE SKIP LOCKED` holds only until the RPC transaction commits. Revision 1's eligibility was `status IN ('pending','sending') AND created_at < now() - interval`, so a row just marked `sending` was **immediately** eligible again and two cron runs could execute it concurrently. | Re-read my own SQL | Task 1 — real `lease_expires_at` |
| 3 | Claiming 25 rows bumps 25 `attempts` but processes only what the deadline allows. The rest keep their bumped count, and at `attempts = 3` the predicate excludes them forever without ever marking them `failed` — a non-terminal graveyard. Revision 1 called this a "correct trade"; it was a defect. | Traced the predicate | Tasks 1, 6 — batch of 3, and a reaper |
| 4 | `jsonResponse(data, status = 200)` — so `ai-agent-reply` returns **HTTP 200** carrying `{ok:false}`. Revision 1's "throw on non-2xx, retry 5xx, give up on 4xx" would have marked every generation failure as `sent`. | `_shared/cors.ts:45` | Tasks 4, 5 — parse the body, not the status |
| 5 | The row stored `inboundText: messageText` (the placeholder) while the plan claimed recovery "re-runs media understanding". It stored no media URL, kind, caption or unread count. A recovered voice note would have produced a generic placeholder reply. | Read my own Task 4 against Task 5 | Task 1 — media reference columns |
| 6 | `recordPendingReply` returned the same `null` for a duplicate and for a failed insert, and told the caller to proceed. A Meta redelivery therefore invoked the agent with **no** idempotency key, so both invocations could reply. | Read my own Task 2 | Task 2 — `enqueue_agent_reply` returns ownership |
| 8 | Re-running the agent repeats more than the reply: tool calls, escalation, human assignment and admin notification all happen before the send. The key was checked only at request entry. | `ai-agent-reply/tools.ts` is invoked well before `:803` | The whole two-stage design, and Task 5's gate |

Findings 9–12 (freshness, ordering, human takeover, the 24h service window, quota interaction, retention, generated types, vacuous tests) are accepted and appear in Tasks 1, 5, 6 and 8.

### Rejected — with evidence

**Finding 7: "Threads cannot create the sent log, because `ai_agent_logs.platform` allows only whatsapp/facebook/instagram."** This is **false**. Codex read `20260712000000_ai_agent_foundation.sql` and stopped. `20260822180000_threads_agent_platform.sql` widened that constraint, and the deployed database confirms it:

```
CHECK (platform = ANY (ARRAY['whatsapp'::text, 'facebook'::text, 'instagram'::text, 'threads'::text]))

platform | count
---------+------
whatsapp |  194
facebook |    9
instagram|    7
threads  |    7
```

Seven Threads rows are logged today. No additive migration is required, and the "verify the deployed production definition" step it asked for has been done — the result is above.

**Finding 11, in part: "the plan omits `src/integrations/supabase/types.ts`."** Partly declined. The house precedent for a service-role-only counter table is that it is **not** in the generated types: `media_understanding_usage` (shipped 2026-08-25) does not appear there, and no browser code can read it because RLS denies all. `pending_agent_replies` is in the same category. Regenerating types for it would add a surface no client may use. The `ai_agent_logs.idempotency_key` column **is** different — that table is read by the Logs tab — so that part is accepted and appears in Task 3.

---

## Global Constraints

- Every new table: RLS enabled, explicit policies or a deliberate deny-all, FKs indexed (`ARCHITECTURE.md` §23).
- `SECURITY DEFINER` functions: controlled `search_path`, minimal grants, no dynamic SQL, positive-parameter validation (§23).
- No edge function returns 5xx for an application error — Cloudflare replaces the body (memory: `postora-cloudflare-masks-origin-5xx`).
- Everything must fit the **60-second edge-worker ceiling**; the inbound path's worst case is already ~50s (memory: `postora-edge-worker-60s-ceiling`).
- Never blindly retry a send that can duplicate a side effect (§26). Background work must be idempotent or safely deduplicated (§27).
- Deploy is manual: copy into the functions volume, then `docker compose -p postorasupabase-supabase-j8axyh restart functions`. `npx supabase functions deploy` does not work here.
- Gates: `npx tsc --noEmit`, `npx vitest run`, `deno test --allow-env --allow-read`, `clean-code-guard`, `test-guard`.
- Branch `feat/durable-reply-outbox`. Scoped commits. **Open a PR; do not merge.**

---

## The three departures from the brief

Unchanged from revision 1 in substance; Codex agreed with all three.

### Departure 1 — the durable unit is the inbound work item, not the generated reply

The brief says to "insert a 'pending' row once the reply is generated but before sending". The webhook never holds a generated reply — it POSTs to `ai-agent-reply`, and generation and delivery both happen inside that function, in another isolate.

And that is not where most of the loss is. The window is the whole continuation:

```ts
runInBackground(async () => {
  await runInboundMediaUnderstanding(...)   // download (10s) + model (20s)
  await triggerAiAgentReply(...)            // generation + delivery (20s)
})
```

A row written only after generation is blind to the first 30 seconds of that.

**But Codex's finding 8 shows the brief's instinct was protecting something real.** Re-running the agent is not free: it can repeat tool calls, escalations and admin notifications. So this revision keeps **both**: an inbound work item for pre-generation deaths, *and* a persisted reply for post-generation ones, with different recovery rules on each side.

### Departure 2 — replay needs delivery idempotency, which does not exist yet

`UNIQUE(social_account_id, message_id)` prevents two *rows*, not one row being driven twice. Revision 1 tried to solve this with a partial unique index on `ai_agent_logs` and called it a backstop. It is not: the send happens 35 lines before the log, and the log insert's error is swallowed. See Task 5 for what replaced it.

### Departure 3 — `threads-poll-replies` does not call the agent

`_shared/commentAutomation.ts:98` does, for Facebook, Instagram and Threads alike. "Threads only" is not separable there without an arbitrary platform condition.

- **3a (recommended):** cover the whole shared comment path — one function, one risk.
- **3b:** DMs only now, comments as a follow-up.

**Decision required.**

### WhatsApp Cloud is on neither list — **Decision required**

The brief excludes Evolution and names FB/IG and Threads. `whatsapp-webhook` (Cloud) is never mentioned, runs the identical shape, and carries 194 of the 217 logged agent replies — by far the most traffic. This plan assumes it is out of scope as literally specified, and records it as the largest remaining hole.

---

## The state machine

Everything below follows from this. A row is always in exactly one state, and every state has a way out.

```
                enqueued by webhook
                        |
                        v
                   [ pending ]───────────────┐ lease expires, attempts left
                        |                     │
        agent claimed   |                     │
                        v                     │
                   [ running ]────────────────┤
                        |                     │
   reply generated &    |                     │
   persisted            v                     │
              [ ready_to_send ]───────────────┤
                        |                     │
          send returned |                     │
          unambiguously v                     │
                    [ sent ]  (terminal)      │
                                              │
   send outcome unknown ──> [ delivery_unknown ] (terminal, needs a human)
   attempts exhausted   ──> [ failed ]          (terminal, logged to ai_agent_logs)
   human took over /
   superseded           ──> [ cancelled ]       (terminal)
```

Two properties this buys, both of which revision 1 lacked:

- **Recovery from `ready_to_send` never re-runs the agent.** It re-delivers stored text. Tool calls and escalations cannot repeat, because they already happened and are not part of delivery.
- **Recovery from `pending` may re-run the agent, but only when nothing externally visible has happened yet** — no tool call, no escalation, no `sent` log for the key. Otherwise the row goes to `delivery_unknown` and a human sees it. Guessing is what produces the double reply.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260828000000_pending_agent_replies.sql` | table, RLS, indexes, `enqueue_agent_reply`, `claim_agent_replies`, `reap_exhausted_agent_replies`, `ai_agent_logs.idempotency_key`, two cron entries |
| `supabase/functions/_shared/pendingReplies.ts` | **new.** Outbox client: enqueue, transition, settle. The only module that knows the table's shape. |
| `supabase/functions/_shared/pendingReplies.test.ts` | **new.** |
| `supabase/functions/_shared/agentReplyResult.ts` | **new.** Parses `ai-agent-reply`'s JSON body into a discriminated union. Shared by the webhooks and the recovery job so they cannot drift. |
| `supabase/functions/_shared/agentReplyResult.test.ts` | **new.** |
| `supabase/functions/process-pending-replies/index.ts` | **new.** Cron-invoked recovery. |
| `supabase/functions/process-pending-replies/recovery.ts` | **new.** Pure decision logic. |
| `supabase/functions/process-pending-replies/recovery.test.ts` | **new.** |
| `supabase/functions/ai-agent-reply/index.ts` | accept `outbox_id`; persist the reply before sending; return a typed outcome |
| `supabase/functions/facebook-instagram-webhook/index.ts` | enqueue before `runInBackground`; settle inside |
| `supabase/functions/_shared/commentAutomation.ts` | same, for the comment path (Option 3a only) |

---

## Task 1: The table, the lease, and the reaper

**Files:**
- Create: `supabase/migrations/20260828000000_pending_agent_replies.sql`

**Interfaces:**
- Produces: table `public.pending_agent_replies`; `enqueue_agent_reply(...) RETURNS TABLE(id UUID, newly_enqueued BOOLEAN)`; `claim_agent_replies(p_limit INTEGER, p_lease_seconds INTEGER, p_max_attempts INTEGER) RETURNS SETOF public.pending_agent_replies`; `reap_exhausted_agent_replies(p_max_attempts INTEGER) RETURNS INTEGER`.

- [ ] **Step 1: The table**

```sql
CREATE TABLE IF NOT EXISTS public.pending_agent_replies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  social_account_id UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  -- Derived inside enqueue_agent_reply from social_accounts, never taken from the caller:
  -- a webhook passing the wrong user_id would attribute a reply to the wrong tenant.
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  message_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  recipient_id      TEXT NOT NULL,

  -- What the customer sent. inbound_text is the placeholder as it stood at enqueue time;
  -- the media_* columns are what recovery needs to redo the understanding the original
  -- attempt may not have finished. Revision 1 stored only the first and claimed it could
  -- do the second.
  inbound_text      TEXT NOT NULL,
  media_url         TEXT,
  media_kind        TEXT,
  media_caption     TEXT,
  unread_attachments INTEGER NOT NULL DEFAULT 0,
  language_hint     TEXT,
  comment_id        TEXT,
  -- Meta's signed URLs expire. Recovery past this point must not pretend it can still read
  -- the media; it degrades to the placeholder and says so in the reply's log.
  media_expires_at  TIMESTAMPTZ,

  -- Ordering within a conversation, so two queued messages are never answered backwards.
  inbound_at        TIMESTAMPTZ NOT NULL,

  -- Persisted by ai-agent-reply BEFORE it sends. Its presence is what makes a row
  -- re-deliverable without re-running the agent.
  generated_reply   TEXT,

  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','ready_to_send','sent',
                                      'delivery_unknown','failed','cancelled')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  -- The lease. A claimed row is invisible to other workers until this passes, which is the
  -- guarantee SKIP LOCKED does NOT give once the claiming transaction commits.
  lease_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at        TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  error             TEXT,
  CONSTRAINT pending_agent_replies_dedup UNIQUE (social_account_id, message_id)
);

ALTER TABLE public.pending_agent_replies ENABLE ROW LEVEL SECURITY;
-- Deny-all. Written only by webhooks and the recovery job, both service-role. The
-- user-facing record of a reply stays ai_agent_logs, which has its own RLS.

-- The claim query: unfinished rows whose lease has lapsed, oldest inbound first.
CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_claimable
  ON public.pending_agent_replies (lease_expires_at NULLS FIRST, inbound_at)
  WHERE status IN ('pending','running','ready_to_send');

CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_account
  ON public.pending_agent_replies (social_account_id);

-- Serves both the ordering check and the retention purge.
CREATE INDEX IF NOT EXISTS idx_pending_agent_replies_conversation
  ON public.pending_agent_replies (conversation_id, inbound_at);
```

- [ ] **Step 2: `enqueue_agent_reply` — one statement that also answers "am I the owner?"**

Finding 6: the caller must be able to tell "I enqueued this" from "someone else already has it". Returning the same `null` for both is what let a Meta redelivery reply twice.

```sql
/**
 * Enqueues an inbound work item and reports whether THIS caller created it.
 *
 * newly_enqueued=false means another invocation already owns the work -- a webhook
 * redelivery, or the same message racing itself. That caller must NOT start processing;
 * the owner is either still running or the recovery job will take it. Revision 1 could not
 * express this, so both invocations proceeded and both could reply.
 *
 * user_id is read from social_accounts rather than accepted as an argument, so a caller
 * cannot attribute a reply to the wrong tenant.
 */
CREATE OR REPLACE FUNCTION public.enqueue_agent_reply(
  p_social_account_id UUID,
  p_platform TEXT,
  p_message_id TEXT,
  p_conversation_id TEXT,
  p_recipient_id TEXT,
  p_inbound_text TEXT,
  p_inbound_at TIMESTAMPTZ,
  p_media JSONB DEFAULT '{}'::jsonb,
  p_language_hint TEXT DEFAULT NULL,
  p_comment_id TEXT DEFAULT NULL,
  p_lease_seconds INTEGER DEFAULT 180
)
RETURNS TABLE (id UUID, newly_enqueued BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_id UUID;
BEGIN
  SELECT sa.user_id INTO v_user_id
    FROM public.social_accounts sa WHERE sa.id = p_social_account_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unknown social account %', p_social_account_id;
  END IF;

  INSERT INTO public.pending_agent_replies (
    social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, media_url, media_kind, media_caption, unread_attachments,
    media_expires_at, language_hint, comment_id, lease_expires_at
  ) VALUES (
    p_social_account_id, v_user_id, p_platform, p_message_id, p_conversation_id,
    p_recipient_id, p_inbound_text, p_inbound_at,
    p_media->>'url', p_media->>'kind', p_media->>'caption',
    COALESCE((p_media->>'unread')::int, 0),
    (p_media->>'expires_at')::timestamptz, p_language_hint, p_comment_id,
    -- The enqueuing invocation IS the first owner, so it takes the lease here.
    --
    -- Leaving this NULL would make a brand-new row immediately claimable, and the webhook
    -- never calls claim_agent_replies -- it enqueues and then processes inline. A cron tick
    -- landing inside that ~50s window would claim the row and re-run the agent CONCURRENTLY
    -- with the invocation still working on it: finding 2's collision, re-entering through a
    -- different door. 180s exceeds the 60s worker ceiling, so the lease outlives any living
    -- owner; a row whose owner died early becomes claimable when it lapses, which is the
    -- two-minute recovery the brief asks for.
    now() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT ON CONSTRAINT pending_agent_replies_dedup DO NOTHING
  RETURNING pending_agent_replies.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, TRUE;
  ELSE
    RETURN QUERY
      SELECT p.id, FALSE FROM public.pending_agent_replies p
       WHERE p.social_account_id = p_social_account_id AND p.message_id = p_message_id;
  END IF;
END;
$$;
```

- [ ] **Step 3: `claim_agent_replies` — a real lease**

Finding 2. The claim must make the row *invisible* to other workers, not merely unlocked-and-still-eligible.

```sql
/**
 * Claims work by taking a LEASE on it.
 *
 * Eligibility is "the lease has lapsed", not "the row is old". Revision 1 used
 * created_at < now() - interval, which a freshly claimed row satisfies immediately -- so
 * SKIP LOCKED bought nothing once the claiming transaction committed and two cron runs
 * could execute the same row side by side.
 *
 * Rows are ordered by inbound_at so a conversation's messages are recovered in the order
 * the customer sent them.
 */
CREATE OR REPLACE FUNCTION public.claim_agent_replies(
  p_limit INTEGER,
  p_lease_seconds INTEGER,
  p_max_attempts INTEGER
)
RETURNS SETOF public.pending_agent_replies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_limit <= 0 OR p_lease_seconds <= 0 OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'claim_agent_replies requires positive parameters';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT p.id FROM public.pending_agent_replies p
     WHERE p.status IN ('pending','running','ready_to_send')
       AND p.attempts < p_max_attempts
       AND (p.lease_expires_at IS NULL OR p.lease_expires_at < now())
     ORDER BY p.inbound_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.pending_agent_replies p
     SET attempts         = p.attempts + 1,
         claimed_at       = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    FROM claimed
   WHERE p.id = claimed.id
  RETURNING p.*;
END;
$$;
```

Note the status is **not** overwritten on claim: a `ready_to_send` row must stay `ready_to_send`, or the recovery job loses the very fact that tells it "re-deliver, do not re-run".

- [ ] **Step 4: `reap_exhausted_agent_replies` — no permanent graveyard**

Finding 3. A row at `attempts = p_max_attempts` is excluded by the claim predicate forever; something must make it terminal and visible.

```sql
/**
 * Moves exhausted work to a terminal state.
 *
 * Without this, a row that reached max attempts is simply never selected again -- alive in
 * the table, invisible to the job, and invisible to the operator. Revision 1 described that
 * as rows "eventually exhausting their attempts", which was not true of any state anyone
 * could observe.
 *
 * A row that got as far as ready_to_send is NOT marked failed: a reply may or may not have
 * reached the customer, and only a human can tell. It becomes delivery_unknown.
 */
CREATE OR REPLACE FUNCTION public.reap_exhausted_agent_replies(p_max_attempts INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.pending_agent_replies
     SET status = CASE WHEN status = 'ready_to_send' THEN 'delivery_unknown' ELSE 'failed' END,
         error  = COALESCE(error, 'attempts exhausted'),
         lease_expires_at = NULL
   WHERE status IN ('pending','running','ready_to_send')
     AND attempts >= p_max_attempts
     AND (lease_expires_at IS NULL OR lease_expires_at < now());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

- [ ] **Step 5: Grants and retention**

`REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role;` for all three. Then (finding 10) a purge, since these rows carry customer message text:

```sql
DO $$ BEGIN PERFORM cron.unschedule('purge-pending-agent-replies');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule('purge-pending-agent-replies', '23 4 * * *', $$
  DELETE FROM public.pending_agent_replies
   WHERE status IN ('sent','cancelled') AND created_at < now() - interval '14 days';
  DELETE FROM public.pending_agent_replies
   WHERE status IN ('failed','delivery_unknown') AND created_at < now() - interval '90 days';
$$);
```

Two windows deliberately: a settled row is transient bookkeeping, but a `failed` or `delivery_unknown` row is the evidence for a customer complaint and must outlive the complaint.

- [ ] **Step 6: Rehearse on the real database, in a rolled-back transaction**

Over `ssh-contabo-mcp`, inside `BEGIN; … ROLLBACK;`. Paste the transcript into the PR. Assert:

1. `enqueue_agent_reply` twice with the same `(account, message_id)` → `newly_enqueued` true then **false**, same id both times.
2. A row with a live lease is **not** returned by `claim_agent_replies`. *(This is the assertion revision 1's rehearsal could not make, because it had no lease.)*
3. Two `claim_agent_replies` calls **in two concurrent sessions** — not two sequential calls in one — never return the same row. Sequential calls in one session prove nothing about the case that actually broke.
4. A `ready_to_send` row survives a claim still `ready_to_send`.
5. `reap_exhausted_agent_replies` moves an exhausted `pending` to `failed` and an exhausted `ready_to_send` to `delivery_unknown`, and afterwards no row remains in a non-terminal state with `attempts >= max`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260828000000_pending_agent_replies.sql
git commit -m "feat(outbox): leased work items with no non-terminal graveyard"
```

---

## Task 2: The outbox client

**Files:**
- Create: `supabase/functions/_shared/pendingReplies.ts`, `supabase/functions/_shared/pendingReplies.test.ts`

**Interfaces:**
- Produces: `enqueueAgentReply(admin, item): Promise<{ id: string; newlyEnqueued: boolean } | null>`; `markReadyToSend`, `markSent`, `markDeliveryUnknown`, `markFailed`, `markCancelled`.

- [ ] **Step 1: Write the failing tests**

Finding 12 says revision 1's tests were vacuous. These assert on the caller's *decision*, not on a stub's echo:

```ts
Deno.test("a redelivery is told it is not the owner, so it does not dispatch", async () => {
  // The bug this prevents: Meta redelivers a webhook it thinks was unacknowledged while the
  // first invocation is still generating. Revision 1 returned a bare null here, the caller
  // read it as "no outbox row, carry on", and both invocations replied.
  const admin = stubRpc({ data: [{ id: "row-1", newly_enqueued: false }] });
  assertEquals(await enqueueAgentReply(admin, ITEM), { id: "row-1", newlyEnqueued: false });
});

Deno.test("an enqueue that fails outright returns null, and the caller still replies", async () => {
  // A reply with no outbox row beats no reply. This is the one degradation the brief
  // explicitly accepts.
  assertEquals(await enqueueAgentReply(stubRpc({ error: { message: "db down" } }), ITEM), null);
});

Deno.test("every field the agent needs survives the round trip, by value", () => {
  // Object.keys() alone was vacuous -- it proved the names existed, not that they carried
  // the right values. A media_url mapped from the caption would have passed it.
  assertEquals(toArgs({ ...ITEM, mediaUrl: "https://cdn/x", mediaKind: "audio",
                        mediaCaption: "hi", unreadAttachments: 2 }).p_media,
    { url: "https://cdn/x", kind: "audio", caption: "hi", unread: 2, expires_at: null });
});
```

- [ ] **Step 2: Run them** — expect FAIL, module not found.
- [ ] **Step 3: Implement.** All transition helpers are non-throwing and log their errors; `enqueueAgentReply` returns `null` only on a genuine failure, never on a duplicate.

> A non-throwing transition can strand a row in `running` when the update fails (finding 12's tail). That is why the lease exists: the row simply becomes claimable again when it lapses. Say so in the module comment, so the next reader does not "fix" it by making it throw.

- [ ] **Step 4: Run them** — expect PASS.
- [ ] **Step 5: Commit**

---

## Task 3: A typed result from `ai-agent-reply`

Finding 4. This must exist before any caller settles a row, or every failure is recorded as a success.

**Files:**
- Create: `supabase/functions/_shared/agentReplyResult.ts`, `supabase/functions/_shared/agentReplyResult.test.ts`
- Modify: `supabase/functions/ai-agent-reply/index.ts`
- Modify: the migration — `ALTER TABLE public.ai_agent_logs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;` plus an index on it (non-unique; see Task 5 for why the unique version was dropped)

**Interfaces:**
- Produces: `type AgentReplyOutcome = { kind: "sent" | "deduplicated" | "skipped" | "retryable" | "permanent"; detail?: string }`; `parseAgentReplyResult(status: number, body: unknown): AgentReplyOutcome`.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("HTTP 200 carrying ok:false is a failure, not a send", () => {
  // jsonResponse defaults to 200 (_shared/cors.ts:45), so ai-agent-reply's error path
  // returns 200 {ok:false}. Revision 1 classified on HTTP status and would have marked
  // every generation failure as delivered.
  assertEquals(parseAgentReplyResult(200, { ok: false, error: "model chain exhausted" }).kind,
               "retryable");
});

Deno.test("a skipped reply is not a sent reply", () => {
  // {ok:true, skipped:"no_reply_generated"} means the agent deliberately said nothing.
  // Recording that as 'sent' would claim a reply the customer never got.
  assertEquals(parseAgentReplyResult(200, { ok: true, skipped: "no_reply_generated" }).kind,
               "skipped");
});

Deno.test("a 4xx is permanent and a 5xx is retryable", () => {
  assertEquals(parseAgentReplyResult(400, {}).kind, "permanent");
  assertEquals(parseAgentReplyResult(503, {}).kind, "retryable");
});

Deno.test("an unparseable body is retryable, never sent", () => {
  // Cloudflare can replace a body wholesale. Defaulting to 'sent' on something we cannot
  // read is the one classification that loses a customer's reply silently.
  assertEquals(parseAgentReplyResult(200, "<html>502</html>").kind, "retryable");
});
```

- [ ] **Step 2–3:** run (FAIL), implement, run (PASS).

- [ ] **Step 4: Make `ai-agent-reply` return the union**

Add `outbox_id?: string` to `ReplyRequest`. Keep the existing body shape and add fields — `ARCHITECTURE.md` §36; callers that predate this must be unaffected. Set `idempotency_key: request.outbox_id ?? null` on `baseLog` so **every** outcome row carries it, not only the successful one, or recovery cannot tell "never ran" from "ran and failed".

- [ ] **Step 5: Commit**

---

## Task 4: Persist the reply before sending it

This is the change that makes recovery safe, and it lives inside `ai-agent-reply`.

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts` around `:803`

- [ ] **Step 1: Deliver a stored reply without regenerating it**

This is the executor for `decideRecovery`'s `deliver_stored`, and it belongs here rather
than in the recovery job. The job has no transport: choosing between `replySender`,
`replyToComment` and the WhatsApp Cloud/Evolution split lives in `getSendCredentials` and
`resolveWhatsAppTransport`, and duplicating that resolution in a second function is how the
two drift until a recovered reply goes out on the wrong channel.

So the branch is early, before the model chain, the tool loop, the knowledge retrieval and
the daily-cap check — all of which the original attempt already ran:

```ts
// A row that already reached ready_to_send has a reply that was generated once and paid
// for once. Re-entering generation here is exactly the tool/escalation replay the two-stage
// design exists to prevent, so this returns before any of it.
if (request.outbox_id) {
  const stored = await loadReadyToSend(admin, request.outbox_id);
  if (stored) {
    const outboundMessageId = await replySender(request.recipient_phone, stored.generated_reply);
    await markSent(admin, request.outbox_id, outboundMessageId ?? null);
    // Logged as a redelivery, not a fresh reply: counting it again would charge the daily
    // cap twice for one answer.
    await logOutcome(admin, { ...baseLog, status: "sent", reply_text: stored.generated_reply },
                     { redelivered: true });
    return jsonResponse({ ok: true, redelivered: true });
  }
}
```

`replySender` must therefore be resolved **before** this branch — today it is resolved
partway down the handler, so the resolution moves up. Nothing else about it changes.

- [ ] **Step 2: Write the reply down, then send**

```ts
// The order is the whole point. Once this row says ready_to_send, recovery can deliver
// this exact text without re-running the agent -- so a death during or after the send
// cannot repeat a tool call, an escalation, or an admin notification. Revision 1 had no
// such line, so every recovery re-ran everything.
if (request.outbox_id) {
  await markReadyToSend(admin, request.outbox_id, replyText);
}
const outboundMessageId = await replySender(request.recipient_phone, replyText);
if (request.outbox_id) {
  await markSent(admin, request.outbox_id, outboundMessageId ?? null);
}
```

- [ ] **Step 3: Handle the ambiguous send**

A `replySender` that throws after the platform accepted the message is indistinguishable from one that never reached it. Do not guess:

```ts
} catch (error) {
  if (request.outbox_id && sendWasAttempted) {
    await markDeliveryUnknown(admin, request.outbox_id, errorMessage(error));
  }
  throw error;
}
```

`delivery_unknown` is terminal and surfaces to a human. Finding 1's core point is that exactly-once delivery across Postgres and Meta is not achievable; the honest response is to name the ambiguity rather than resolve it by replaying.

- [ ] **Step 4: Tests** — an injected `replySender` proving exactly one send per outbox id;
      proving `markReadyToSend` is called before it; and proving that a `ready_to_send` row
      reaches the sender **without** the model chain or the tool loop being entered at all
      (inject both and assert neither ran — that assertion is the two-stage guarantee, and
      without it the branch could regress to a normal generation and every test would still
      pass). Then commit.

---

## Task 5: The recovery decision logic

**Files:**
- Create: `supabase/functions/process-pending-replies/recovery.ts`, `.test.ts`

**Interfaces:**
- Produces: `RECOVERY_LIMITS = { batch: 3, leaseSeconds: 180, maxAttempts: 3, deadlineMs: 45_000 }`; `decideRecovery(row, context): RecoveryAction`.

`batch: 3`, not 25 (finding 3): each row can hold a ~20s agent call inside a 60s ceiling, so a batch the invocation cannot finish is a batch that strands rows. `leaseSeconds: 180` exceeds the worker ceiling, so a lease never lapses while its holder is still alive.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("a ready_to_send row is re-delivered, never re-generated", () => {
  // The single most important rule here. Re-running the agent would repeat any tool call,
  // escalation or admin notification the first attempt already performed.
  assertEquals(decideRecovery({ status: "ready_to_send", generated_reply: "hi" }, FRESH).kind,
               "deliver_stored");
});

Deno.test("a pending row that already touched the outside world is not re-run", () => {
  // A death mid-generation may have left tool calls behind. We cannot tell which ran, so we
  // do not guess -- a human sees it instead.
  assertEquals(decideRecovery({ status: "pending" },
    { ...FRESH, priorToolCalls: 1 }).kind, "hand_to_human");
});

Deno.test("a conversation a human took over is cancelled, not answered", () => {
  assertEquals(decideRecovery({ status: "pending" }, { ...FRESH, humanTookOver: true }).kind,
               "cancel");
});

Deno.test("a superseded message is cancelled, so replies cannot land out of order", () => {
  // Two queued messages from one customer: answering the older one after the newer produces
  // a conversation that reads backwards.
  assertEquals(decideRecovery({ status: "pending", inbound_at: T0 },
    { ...FRESH, newerPendingInConversation: true }).kind, "cancel");
});

Deno.test("media whose signed URL has expired degrades to the placeholder, and says so", () => {
  // Meta's URLs expire. Silently replying to "[Image]" as though it were understood is how
  // a recovered reply becomes confidently wrong.
  const action = decideRecovery({ status: "pending", media_url: "https://cdn/x" },
    { ...FRESH, mediaExpired: true });
  assertEquals(action.kind, "rerun_agent");
  assertEquals(action.mediaUsable, false);
});

Deno.test("a reply outside the 24h service window is cancelled, not attempted", () => {
  // The platform would reject it. Attempting anyway burns all three attempts and ends in a
  // 'failed' row whose error says nothing useful.
  assertEquals(decideRecovery({ status: "pending" }, { ...FRESH, outsideServiceWindow: true })
    .kind, "cancel");
});
```

- [ ] **Step 2–4:** run (FAIL), implement as a pure function, run (PASS). Commit.

---

## Task 6: The recovery function and its cron

**Files:**
- Create: `supabase/functions/process-pending-replies/index.ts`
- Modify: the migration (cron entry)

- [ ] **Step 1: The function**

Auth mirrors `threads-poll-replies`: bearer `CRON_SECRET`, constant-time compare, **401 on mismatch, never 5xx**.

Per run: `reap_exhausted_agent_replies` first (so exhausted rows leave the table's working set before anything else), then `claim_agent_replies(3, 180, 3)`, then each row sequentially under `RECOVERY_LIMITS.deadlineMs`. Stop early when the deadline is near and leave the rest — their leases lapse and the next run takes them.

Both actions go through the **same** door: a POST to `ai-agent-reply` carrying `outbox_id`.
The row's own status is what decides which path runs — `ready_to_send` takes Task 4's
redelivery branch and never reaches generation, `pending` runs the agent normally. The
recovery job therefore holds no transport logic and no second copy of the send-credential
resolution; `decideRecovery`'s `deliver_stored` vs `rerun_agent` distinction governs whether
the job posts at all and how it settles the row, not how the message is sent.

Quota (finding 9): a `deliver_stored` action must **not** re-check `isDailyCapReached`. The original attempt already reserved that spend; refusing on the retry would strand a reply that was already paid for and generated.

- [ ] **Step 2: Cron entry** — `*/2 * * * *`, `net.http_post` with `get_cron_secret()`, same unschedule-then-schedule shape as `20260823090000`.

- [ ] **Step 3: Verify `get_cron_secret()` is non-null** before relying on it — an unset `CRON_SECRET` 503s every run and looks exactly like the job never being scheduled (memory: `postora-cron-secret-unset-503`).

- [ ] **Step 4: End-to-end on the real database** — a backdated `ready_to_send` row is delivered once; invoking twice produces one message and one `ai_agent_logs` row; a backlog of 10 rows drains over consecutive runs with none stuck. Clean up afterwards.

- [ ] **Step 5: Commit**

---

## Task 7: Wire `facebook-instagram-webhook`

**Files:** `supabase/functions/facebook-instagram-webhook/index.ts`

- [ ] **Step 1: Enqueue before `runInBackground`, and respect ownership**

```ts
const enqueued = await enqueueAgentReply(adminClient, {
  socialAccountId: account.id,
  platform,
  messageId: event.message.mid || `${senderId}:${event.timestamp}`,
  conversationId,
  recipientId: senderId,
  inboundText: messageText,
  inboundAt: new Date(event.timestamp).toISOString(),
  mediaUrl: readable?.url ?? null,
  mediaKind: readable?.kind ?? null,
  mediaCaption: event.message.text || null,
  unreadAttachments: unread,
});

// A redelivery is not a second customer message. The first invocation owns it, and the
// recovery job is the backstop if that invocation dies -- so this one acknowledges and
// stops rather than starting a parallel reply.
if (enqueued && !enqueued.newlyEnqueued) return;
```

- [ ] **Step 2: Settle inside the continuation** using `parseAgentReplyResult`, never the HTTP status.
- [ ] **Step 3: Collapse `triggerAiAgentReply`'s parameters** into `(account, request)` — adding `outbox_id` would make it 7 positional args, two of them transposable strings. Same refactor as `reserveAttempt` in PR #43.
- [ ] **Step 4: Gates** — `deno test --allow-env --allow-read supabase/functions/facebook-instagram-webhook/`, `deno check`.
- [ ] **Step 5: Commit**

---

## Task 8: The comment path — Option 3a only

**Skip entirely if the reviewer chooses 3b.**

`_shared/commentAutomation.ts:98`. Same shape as Task 7; `messageId` is the comment id and `commentId` is set, so recovery replies publicly rather than by DM.

The comment path is already safer than the DM path — it gates on its inbox-event claim — so the enqueue mainly adds recovery, not deduplication.

> **Blocker to clear first:** `_shared/commentAutomation.test.ts` has 5 pre-existing `TS2322` errors under `deno check` (`null` assigned to `string` at lines 136 and 142 among others). Unrelated to this work — untouched since `0e386f08` — but they block `deno check` on everything importing the module. Fix in its own commit.

> **Not a blocker:** Codex claimed Threads cannot write a `sent` log because of the `ai_agent_logs.platform` CHECK. Verified false — `20260822180000_threads_agent_platform.sql` widened it and production shows 7 Threads rows. No migration needed.

---

## Task 9: Gates, PR, deploy

- [ ] `npx tsc --noEmit` → 0 errors.
- [ ] `npx vitest run` → baseline 949 passed / 15 skipped.
- [ ] `deno test --allow-env --allow-read` over the touched directories → baseline 428 passed. `--allow-read` is required; without it `planQuotasContract.test.ts` reports a permission error that reads as a test failure.
- [ ] `clean-code-guard` on changed production files; `test-guard` on changed tests.
- [ ] Regenerate `src/integrations/supabase/types.ts` **for `ai_agent_logs.idempotency_key` only** — that table is read by the Logs tab. `pending_agent_replies` is deliberately absent, matching `media_understanding_usage`: service-role-only, RLS deny-all, no client may read it.
- [ ] Push, open a PR stating the departures and the open decisions. **Do not merge.**
- [ ] After approval: migration **first**, then the function files into the volume (SHA256 verified with `tr -d '\r'`), then `docker compose -p postorasupabase-supabase-j8axyh restart functions`. Reversing that order points live webhooks at a table that does not exist.
- [ ] `mem0 add_memory`; final report.

---

## Self-review

**Coverage of the brief.** Steps 1–2 → Task 1. Step 3 → Tasks 4 and 7 (amended by Departure 1 and finding 8: the row is written earlier *and* the reply is persisted before the send). Step 4 → Tasks 5–6. Step 5 → Tasks 1–2, via `enqueue_agent_reply` returning ownership rather than a bare unique constraint. Evolution is untouched, as instructed.

**Type consistency.** `enqueueAgentReply` returns `{ id, newlyEnqueued } | null` in Task 2 and is consumed in Tasks 7–8. `parseAgentReplyResult` returns `AgentReplyOutcome` in Task 3, consumed in Tasks 6–7. `RECOVERY_LIMITS` uses `leaseSeconds` in Tasks 5 and 6 and matches `claim_agent_replies(p_lease_seconds)`.

**Every state has an exit.** `pending`/`running`/`ready_to_send` are all claimable once their lease lapses; the reaper makes anything at max attempts terminal; the purge removes terminal rows on two windows. There is no state a row can occupy that nothing observes — the specific defect that sank revision 1.

**Honest limits.**
1. **Exactly-once delivery is not achievable** across Postgres and Meta. `delivery_unknown` names the ambiguity instead of resolving it by replay, and needs a human. If that queue is never watched, this design degrades to "a small number of replies silently need attention" — an operational commitment, not just code.
2. **A pre-generation death that already ran tools is handed to a human, not retried.** Conservative on purpose; it means some recoverable work is not recovered automatically.
3. **WhatsApp Cloud is out of scope** per the brief, and carries 194 of 217 logged agent replies — the largest uncovered surface by a wide margin.
4. **A death before the enqueue is unrecoverable.** Accepted explicitly by the brief; the window is now milliseconds rather than ~50 seconds.
