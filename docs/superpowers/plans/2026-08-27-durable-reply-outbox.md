# Durable Reply Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer's inbound message still gets an AI reply when the edge worker that was generating it is killed mid-flight — without the recovery itself sending a second reply, repeating a tool call, or escalating twice.

**Architecture:** A **two-stage** outbox. The webhook durably records the *inbound work item* before starting background work. `ai-agent-reply` then persists its *generated reply* before sending. Recovery behaves differently on each side of that line: after generation it only re-delivers text it already has, never re-running the agent; before generation it may re-run the agent, but only while nothing externally visible has happened yet. Anything ambiguous goes to a human rather than being replayed.

**Tech Stack:** Postgres (one table, three `SECURITY DEFINER` functions, `pg_cron`), Deno edge functions, `deno test`.

**Spec:** none — written from the task brief pasted 2026-08-27, whose relevant text is quoted below.

**Status:** REVISION 4 — all three decisions resolved by the reviewer on 2026-08-27:
**two-stage** (not the brief's delivery-only shape), the comment path covered for **all three
platforms**, and **WhatsApp Cloud in scope**. Codex reviewed it twice, rejecting both times: round 1 with 8 blocking findings (7 verified
true and fixed, 1 verified false and rejected with evidence), round 2 with 6 more. Every
round-2 finding was verified and is fixed below. **Review stops at two rounds** per the
project workflow; nothing from round 2 is left unresolved, and the residual limits are stated
at the end rather than hidden. Ready to implement.

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

## Round 2 review outcome

Codex rejected revision 3 as well, and conceded finding 7 in its own words: *"you are
correct, and I was wrong… I withdraw round-one finding 7 completely."* Six new blocking
findings, all verified before being accepted:

| # | Finding | Verified how | Fixed in |
|---|---|---|---|
| 1 | `ready_to_send` still **spanned the provider call**. A kill between the send succeeding and `markSent` left a row that the unconditional `ready_to_send → deliver_stored` rule would deliver a second time. The `sendWasAttempted` flag guarding it lived in process memory — and a killed process runs no `catch`. | Re-read my own Task 4 | New durable `sending` state; the state machine table |
| 2 | `running` was **drawn but never entered**. Nothing transitioned into it, and inferring "did a tool fire?" from logs cannot work — a worker can call a tool and die before `logOutcome`. | Traced my own tasks; `logOutcome` is the last step | `advance()` confirmed transition into `running` |
| 3 | `ModelChainExhaustedError` did not fit the union. `deliverModelOutageFloor` **escalates, notifies a human and sends an apology**, then returns HTTP 200 `{ok:false}` — which revision 3 classified `retryable`. | Read `outage-floor.ts:43-92`; it calls `escalateConversation` then `sender(...)` | New `outage_handled` outcome, terminal |
| 4 | The live owner held **no lease**, so cron could claim a row alongside the invocation still working on it. *(Already fixed in `a53b5c9d`, after Codex's snapshot — independent confirmation.)* Its second half was new: `return` inside the per-event loop would exit the handler without a `Response` and drop sibling messages. | Read the loop nesting | `continue`, plus a `handleInboundMessage` extraction |
| 5 | `delivery_unknown` was called "needs a human" but **no human could see it** — deny-all RLS, no UI, and the reaper returned only a count. | Read my own reaper | Reaper returns rows; caller writes `ai_agent_logs` + `system_logs` |
| 6 | Batch of 3 with a 45s deadline **charges attempts for rows it never processes**. Three runs and the reaper marks them `failed` — a customer with no reply and no attempt ever made, worse than the graveyard it replaced. | Arithmetic on my own limits | Claim one row at a time, time-checked before each claim |

Should-fix 7–10 are accepted too: `media_expires_at` was never populated anywhere (the column
comment now says what it can and cannot mean); `isDailyCapReached` **counts** rather than
reserves, so revision 3's "the spend was already reserved" was false and the cap is now
re-checked before every send; `pending_agent_replies` is added to the generated types after
all, because §23 as written has no service-role exception and following
`media_understanding_usage`'s precedent would be following a violation; and the crash-point
tests are named in each task.

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

**Resolved: 3a.** Cover the whole shared comment path — Facebook, Instagram and Threads.
One function, one risk, no arbitrary platform condition. Task 8.

### WhatsApp Cloud — **resolved: in scope**

The brief excludes Evolution and names FB/IG and Threads. `whatsapp-webhook` (Cloud) is never mentioned, runs the identical `runInBackground(understand → trigger)` shape, and carries **194 of the 217** logged agent replies — by far the most traffic on the platform. Covering the quieter surfaces while skipping the busiest one would have made the feature mostly decorative, so it is in. Task 9.

`whatsapp-evolution-webhook` stays **out**, as the brief instructs.

---

## The state machine

Everything below follows from this. A row is always in exactly one state, and every state has a way out.

```
        enqueued by webhook, holding a 180s owner lease
                        |
                        v
                   [ pending ]          nothing external has happened yet
                        |
   confirmed before     |
   any tool or model    v
                   [ running ]          tools MAY have fired; unknowable after a kill
                        |
   reply persisted      |
                        v
              [ ready_to_send ]         text exists; NO delivery attempted
                        |
   confirmed before     |
   the provider call    v
                   [ sending ]          a delivery attempt is in flight
                        |
     provider returned  |
                        v
                    [ sent ]  (terminal)

   terminal, no automatic retry:
     [ delivery_unknown ]   an attempt may have reached the customer
     [ failed ]             attempts exhausted before any delivery attempt
     [ cancelled ]          human took over, superseded, or outside the send window
```

**Every state transition that precedes an external side effect is confirmed and
fail-closed.** If the `UPDATE` does not come back affecting exactly one row, the side effect
does not happen. A non-throwing transition that lets the send proceed anyway is the same
hole in a new place — revision 3 had exactly that in `markReadyToSend`.

The recovery rule is then a function of the state a lapsed lease was found in, and nothing
else. This is the table; it is the whole safety argument:

| Lapsed in | What is knowable | Recovery does |
|---|---|---|
| `pending` | nothing external has happened | **re-run the agent** |
| `running` | a tool, escalation or notification *may* have fired, and after a kill there is no way to tell | **hand to a human** — never re-run |
| `ready_to_send` | text exists, no delivery was attempted | **deliver the stored text** |
| `sending` | a delivery attempt was in flight; it may have reached the customer | **`delivery_unknown`** — never re-send |

Revision 3 had `ready_to_send` spanning the provider call, so a kill between the send
succeeding and the bookkeeping left a row that recovery would deliver a second time. It also
drew `running` without ever entering it, so a worker that ran a tool and died still looked
like `pending`. Both are why `sending` exists and why entering `running` is a durable step
rather than a label.

The cost is stated plainly: **more work is handed to a human than strictly needs to be.**
A worker that died in `running` before calling any tool is recoverable in principle, and
this design will not recover it. Distinguishing those cases needs per-tool checkpoints,
which is a larger change than this plan. Conservative here means a customer waits for a
person, not that a customer gets two conflicting replies.

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
| `supabase/functions/_shared/commentAutomation.ts` | same, for the shared comment path (all three platforms) |
| `supabase/functions/whatsapp-webhook/index.ts` | same, for WhatsApp Cloud. `whatsapp-evolution-webhook` is deliberately untouched. |

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
  -- Populated ONLY when the platform states an expiry we can read; NULL means "unknown",
  -- not "never expires".
  --
  -- Meta's messaging attachment URLs are signed and do expire, but the webhook payload
  -- carries no expiry and the signature is opaque, so for FB/IG this stays NULL. Revision 3
  -- claimed a `mediaExpired` recovery decision this column cannot support -- it was never
  -- populated anywhere, and the plan's own test asserted `expires_at: null`. The honest
  -- design is the other way round: recovery ATTEMPTS the fetch, and an expiry-shaped refusal
  -- from the CDN is what degrades the attempt to the placeholder. The column exists for
  -- transports that do declare an expiry, and for the log to record why a fetch was skipped.
  media_expires_at  TIMESTAMPTZ,

  -- Ordering within a conversation, so two queued messages are never answered backwards.
  inbound_at        TIMESTAMPTZ NOT NULL,

  -- Persisted by ai-agent-reply BEFORE it sends. Its presence is what makes a row
  -- re-deliverable without re-running the agent.
  generated_reply   TEXT,

  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','ready_to_send','sending','sent',
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
  WHERE status IN ('pending','running','ready_to_send','sending');

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
     WHERE p.status IN ('pending','running','ready_to_send','sending')
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
 * Moves exhausted work to a terminal state, and RETURNS THE ROWS so the caller can make
 * them visible.
 *
 * Two things this fixes. First, without it a row at max attempts is never selected again --
 * alive in the table, invisible to the job, invisible to the operator. Second, returning a
 * bare count (revision 3) was not enough: this table has deny-all RLS and no UI, so a
 * "terminal, needs a human" state that only exists here is not observable by any human. The
 * caller writes an ai_agent_logs row for each returned id, which is the surface the customer's
 * owner already reads.
 *
 * Which terminal state depends on how far the row got, because that is what decides whether
 * a customer may already have received something:
 *   pending       -> failed            nothing external happened
 *   running       -> delivery_unknown  a tool or escalation may have fired
 *   ready_to_send -> failed            text exists but no delivery was attempted
 *   sending       -> delivery_unknown  an attempt was in flight
 */
CREATE OR REPLACE FUNCTION public.reap_exhausted_agent_replies(p_max_attempts INTEGER)
RETURNS SETOF public.pending_agent_replies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.pending_agent_replies
     SET status = CASE WHEN status IN ('running','sending') THEN 'delivery_unknown'
                       ELSE 'failed' END,
         error  = COALESCE(error, 'attempts exhausted'),
         lease_expires_at = NULL
   WHERE status IN ('pending','running','ready_to_send','sending')
     AND attempts >= p_max_attempts
     AND (lease_expires_at IS NULL OR lease_expires_at < now())
  RETURNING *;
END;
$$;
```

And two confirmed, fail-closed transitions. These are the ones that gate a side effect, so
they report whether they actually changed a row rather than swallowing the failure:

```sql
/**
 * Claims the row for execution, or refuses.
 *
 * The WHERE clause names the state the caller believes the row is in, so two workers cannot
 * both believe they own it. A caller that gets FALSE must NOT proceed -- that is the whole
 * contract, and it is why this returns BOOLEAN rather than being a fire-and-forget update.
 */
CREATE OR REPLACE FUNCTION public.advance_agent_reply(
  p_id UUID,
  p_from TEXT,
  p_to TEXT,
  p_generated_reply TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.pending_agent_replies
     SET status = p_to,
         generated_reply = COALESCE(p_generated_reply, generated_reply)
   WHERE id = p_id AND status = p_from;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
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
- Produces: `type AgentReplyOutcome = { kind: "sent" | "redelivered" | "skipped" | "outage_handled" | "retryable" | "permanent"; detail?: string }`; `parseAgentReplyResult(status: number, body: unknown): AgentReplyOutcome`.

`outage_handled` is the case revision 3 got wrong. When every model fails,
`deliverModelOutageFloor` (`ai-agent-reply/outage-floor.ts:43`) escalates the conversation,
assigns or notifies a human, **and sends the customer an apology** — then the handler returns
HTTP 200 carrying `{ok:false, escalated}`. Revision 3's union classified that `retryable`, so
recovery would have re-run the agent, escalated a second time and sent a second apology. It
is terminal, not retryable, and `ai-agent-reply` must surface `apology_sent` and
`human_notified` in the body so the caller can tell it apart from an ordinary failure.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("HTTP 200 carrying ok:false is a failure, not a send", () => {
  // jsonResponse defaults to 200 (_shared/cors.ts:45), so ai-agent-reply's error path
  // returns 200 {ok:false}. Revision 1 classified on HTTP status and would have marked
  // every generation failure as delivered.
  assertEquals(parseAgentReplyResult(200, { ok: false, error: "provider timeout" }).kind,
               "retryable");
});

Deno.test("a model outage that already apologised and escalated is terminal", () => {
  // The trap: this ALSO returns 200 {ok:false}. But deliverModelOutageFloor has already
  // escalated the conversation, notified a human and sent the customer an apology. Retrying
  // it sends a second apology to someone who has one, and escalates a conversation that is
  // already escalated.
  assertEquals(parseAgentReplyResult(200,
    { ok: false, error: "all models failed", escalated: true, apology_sent: true }).kind,
    "outage_handled");
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
// Three durable steps, each confirmed before the next. The order is the whole safety
// argument, and every one of these transitions gates a side effect:
//
//   running       -> ready_to_send   the text is now durable
//   ready_to_send -> sending         a delivery attempt is about to begin
//   sending       -> sent            the provider returned
//
// Revision 3 collapsed the middle one, so ready_to_send spanned the provider call: a kill
// between the send succeeding and the bookkeeping left a row recovery would deliver a
// SECOND time. And its transitions were non-throwing, so a failed persist still fell
// through to replySender -- the same hole, one line lower.
if (request.outbox_id) {
  if (!await advance(admin, request.outbox_id, "running", "ready_to_send", replyText)) {
    // Refusing to send is the correct failure. An unpersisted reply that goes out is one
    // nothing can reconcile afterwards, and the customer is better served by the recovery
    // pass than by a message no record exists of.
    throw new Error("could not persist the reply before sending");
  }
  if (!await advance(admin, request.outbox_id, "ready_to_send", "sending")) {
    throw new Error("another worker is already delivering this reply");
  }
}

const outboundMessageId = await replySender(request.recipient_phone, replyText);

if (request.outbox_id) {
  await advance(admin, request.outbox_id, "sending", "sent");
}
```

The last transition is deliberately **not** checked. By then the customer already has the
message; a failed bookkeeping update must not throw and turn a delivered reply into an
error. The row is left in `sending`, its lease lapses, and the recovery pass classifies it
`delivery_unknown` — which is exactly true, and is the honest outcome rather than a guess.

- [ ] **Step 3: Handle the ambiguous send**

A `replySender` that throws after the platform accepted the message is indistinguishable from one that never reached it. Do not guess:

```ts
} catch (error) {
  // Only meaningful when the process survives to run it. A killed isolate executes no
  // catch -- which is precisely why the durable `sending` state exists and this handler is
  // a convenience rather than the guarantee. Revision 3 relied on an in-memory
  // `sendWasAttempted` flag here and called that its answer to the ambiguity; a flag in a
  // dead process protects nothing.
  if (request.outbox_id) {
    await advance(admin, request.outbox_id, "sending", "delivery_unknown");
  }
  throw error;
}
```

`delivery_unknown` is terminal and surfaces to a human (Task 6, Step 4). Exactly-once delivery across Postgres and Meta is not achievable; the honest response is to name the ambiguity rather than resolve it by replaying.

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
Deno.test("the lapsed state alone decides what recovery may do", () => {
  // This table IS the safety argument, so it is asserted as a table. Revision 3 tried to
  // infer "did anything external happen" from prior tool-call LOGS, which cannot work: a
  // worker can call a tool and die before logOutcome ever runs, leaving a row that looks
  // untouched. Only the durable state knows.
  const cases: [string, string][] = [
    ["pending",       "rerun_agent"],     // nothing external has happened
    ["running",       "hand_to_human"],   // a tool or escalation MAY have fired
    ["ready_to_send", "deliver_stored"],  // text exists, no delivery attempted
    ["sending",       "delivery_unknown"],// an attempt was in flight; never re-send
  ];
  for (const [status, expected] of cases) {
    assertEquals(decideRecovery({ status, generated_reply: "hi" }, FRESH).kind, expected,
                 `lapsed in ${status}`);
  }
});

Deno.test("a sending row is never re-delivered, even though the text is right there", () => {
  // The tempting wrong move. The stored reply is valid and delivery "probably" failed --
  // but "probably" is how a customer gets the same answer twice.
  assertEquals(decideRecovery({ status: "sending", generated_reply: "hi" }, FRESH).kind,
               "delivery_unknown");
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

Deno.test("a reply outside the send window is cancelled, whatever state it lapsed in", () => {
  // Applies to deliver_stored too, which revision 3 exempted. Persisting text does not
  // extend Meta's 24-hour service window -- a stored reply that crosses it is rejected by
  // the platform exactly like a fresh one, and attempting it burns every remaining attempt
  // to end in a 'failed' row whose error explains nothing.
  //
  // Window rules are per surface: a public comment reply has no 24-hour window, so the
  // context carries the decision rather than this function assuming a DM.
  for (const status of ["pending", "ready_to_send"]) {
    assertEquals(decideRecovery({ status }, { ...FRESH, outsideSendWindow: true }).kind,
                 "cancel", `lapsed in ${status}`);
  }
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

Per run: `reap_exhausted_agent_replies` first, then a loop that claims **one row at a time**:

```ts
while (Date.now() - startedAt < RECOVERY_LIMITS.deadlineMs - RECOVERY_LIMITS.perRowMs) {
  const [row] = await claim(1);      // claim_agent_replies(1, 180, 3)
  if (!row) break;
  await process(row);
}
```

One at a time, not a batch. Revision 3 claimed three and processed what the deadline allowed
— but claiming **increments `attempts`**, so a row the deadline never reached still paid for
an attempt it never had. Three runs of that and the reaper marks it `failed`: a customer with
no reply and no recovery ever actually attempted, which is a *worse* outcome than the
non-terminal graveyard it replaced. Checking the remaining time *before* each claim makes
every incremented attempt correspond to work that genuinely begins.

Both actions go through the **same** door: a POST to `ai-agent-reply` carrying `outbox_id`.
The row's own status decides which path runs.

Quota and window, before any send (Codex round 2, finding 8): `isDailyCapReached`
(`ai-agent-reply/index.ts:181`) **counts** committed `sent` logs — it does not reserve, so
revision 3's claim that "the original attempt already reserved that spend" was simply false.
A generated `ready_to_send` reply holds no slot, and other conversations can fill the cap
before recovery runs. The cap is therefore re-checked before every send, including a stored
redelivery, and the send window is checked with it.

Both actions go through the **same** door: a POST to `ai-agent-reply` carrying `outbox_id`.
The row's own status is what decides which path runs — `ready_to_send` takes Task 4's
redelivery branch and never reaches generation, `pending` runs the agent normally. The
recovery job therefore holds no transport logic and no second copy of the send-credential
resolution; `decideRecovery`'s `deliver_stored` vs `rerun_agent` distinction governs whether
the job posts at all and how it settles the row, not how the message is sent.


- [ ] **Step 2: Cron entry** — `*/2 * * * *`, `net.http_post` with `get_cron_secret()`, same unschedule-then-schedule shape as `20260823090000`.

- [ ] **Step 3: Verify `get_cron_secret()` is non-null** before relying on it — an unset `CRON_SECRET` 503s every run and looks exactly like the job never being scheduled (memory: `postora-cron-secret-unset-503`).

- [ ] **Step 4: Make terminal problems visible to a human**

`delivery_unknown` and `failed` are described as "needs a human", but `pending_agent_replies`
has deny-all RLS and no UI — a state only this table knows about is not observable by any
human, and purging it after 90 days does not change that. So the reaper's returned rows are
written to `ai_agent_logs` (the customer owner's Logs tab) and `system_logs` (the admin Logs
page) with statuses `delivery_unknown` and `recovery_failed`. `hand_to_human` likewise
performs a real assignment through the existing escalation path rather than only returning an
enum value.

- [ ] **Step 5: End-to-end on the real database** — a backdated `ready_to_send` row is delivered once; invoking twice produces one message and one `ai_agent_logs` row; a `sending` row that lapses becomes `delivery_unknown` **and appears in `ai_agent_logs`**; a backlog of 10 rows drains over consecutive runs with none stuck and none marked failed without an attempt. Clean up afterwards.

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

// A redelivery is not a second customer message. The first invocation owns it (and holds a
// 180s lease), and the recovery job is the backstop if that invocation dies -- so this one
// acknowledges and stops rather than starting a parallel reply.
//
// `continue`, NOT `return`. This sits inside the loop over the events in one webhook
// envelope: returning here would exit the handler without its Response and silently drop
// every remaining message in the same delivery.
if (enqueued && !enqueued.newlyEnqueued) continue;
```

- [ ] **Step 2: Settle inside the continuation** using `parseAgentReplyResult`, never the HTTP status.
- [ ] **Step 3: Collapse `triggerAiAgentReply`'s parameters** into `(account, request)` — adding `outbox_id` would make it 7 positional args, two of them transposable strings. Same refactor as `reserveAttempt` in PR #43.

- [ ] **Step 3b: Extract the per-message body into a helper.** The enqueue/ownership check
      needs `continue` semantics, and the block it lives in is already deeply nested inside
      two loops. Pulling one message's handling into `handleInboundMessage(...)` makes the
      early exit local and obvious instead of depending on which loop the reader thinks they
      are in — the mistake revision 3's snippet actually made.
- [ ] **Step 4: Gates** — `deno test --allow-env --allow-read supabase/functions/facebook-instagram-webhook/`, `deno check`.
- [ ] **Step 5: Commit**

---

## Task 8: The shared comment path

`_shared/commentAutomation.ts:98`. Same shape as Task 7; `messageId` is the comment id and `commentId` is set, so recovery replies publicly rather than by DM.

The comment path is already safer than the DM path — it gates on its inbox-event claim — so the enqueue mainly adds recovery, not deduplication.

> **Blocker to clear first:** `_shared/commentAutomation.test.ts` has 5 pre-existing `TS2322` errors under `deno check` (`null` assigned to `string` at lines 136 and 142 among others). Unrelated to this work — untouched since `0e386f08` — but they block `deno check` on everything importing the module. Fix in its own commit.

> **Not a blocker:** Codex claimed Threads cannot write a `sent` log because of the `ai_agent_logs.platform` CHECK. Verified false — `20260822180000_threads_agent_platform.sql` widened it and production shows 7 Threads rows. No migration needed.

---

## Task 9: WhatsApp Cloud

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.ts` — the `automationHandler === "internal" && !ruleReplied` block (~line 539), both branches, and `triggerAiAgentReply` (~line 991)

The busiest surface, and the one whose continuation is longest: it is the path that runs
media understanding **and** generation inside one `runInBackground`.

- [ ] **Step 1: Enqueue before `runInBackground`, and honour ownership**

`messageId` is the WhatsApp message id (`msg.id`), `recipientId` is `from`, `inboundAt` comes
from the message timestamp rather than `now()` — a delayed webhook must not be ordered as
though it had just arrived.

**Both branches need it.** The `else` at ~line 582 (plain text, no understandable media)
currently calls `triggerAiAgentReply` with a bare `.catch()` and no background wrapper at
all, so it drops replies just as readily.

- [ ] **Step 2: Settle inside the continuation** with `parseAgentReplyResult`, never the HTTP status.

- [ ] **Step 3: Collapse `triggerAiAgentReply`'s parameters.** It is already 6 positional
      arguments (`account, conversationId, phoneNumberId, recipientPhone, inboundText,
      languageHint`) — three adjacent strings a caller can transpose in silence — and
      `outbox_id` would make it 7. Collapse to `(account, request)` as in Task 7.

- [ ] **Step 4: One extra check this path needs that FB/IG does not.** WhatsApp Cloud
      enforces the 24-hour service window at the platform, and `SERVICE_WINDOW_MS` already
      exists in `ai-agent-reply`. A recovered reply is by definition later than the original,
      so `decideRecovery`'s `outsideServiceWindow` branch (Task 5) is load-bearing here
      rather than theoretical — assert it against a real WhatsApp row.

- [ ] **Step 5:** `deno test --allow-env --allow-read supabase/functions/whatsapp-webhook/`, `deno check`, commit.

> `whatsapp-evolution-webhook` is **not** touched. The brief excludes it, and it has its own
> reliability layer.

---

## Task 10: Gates, PR, deploy

- [ ] `npx tsc --noEmit` → 0 errors.
- [ ] `npx vitest run` → baseline 949 passed / 15 skipped.
- [ ] `deno test --allow-env --allow-read` over the touched directories → baseline 428 passed. `--allow-read` is required; without it `planQuotasContract.test.ts` reports a permission error that reads as a test failure.
- [ ] `clean-code-guard` on changed production files; `test-guard` on changed tests.
- [ ] Regenerate `src/integrations/supabase/types.ts` for **both** `ai_agent_logs.idempotency_key` and `pending_agent_replies` with its RPCs.

  Revision 3 omitted the table, on the precedent that `media_understanding_usage` — the
  comparable service-role-only counter shipped 2026-08-25 — is not in the generated types
  either. Codex's counter-argument is better: `ARCHITECTURE.md` §23 says schema changes "must
  be reflected in generated/maintained TypeScript database types" with no service-role
  exception, and a type declaration grants nothing — RLS and grants remain the security
  boundary. Following the precedent here would be following a violation.

  Worth raising separately with the reviewer: either §23 should be amended to define the
  generated types as the browser-accessible subset, or `media_understanding_usage` is a
  standing gap. Not this PR's job to settle, but it should not be silently copied.
- [ ] Push, open a PR stating the departures and the open decisions. **Do not merge.**
- [ ] After approval: migration **first**, then the function files into the volume (SHA256 verified with `tr -d '\r'`), then `docker compose -p postorasupabase-supabase-j8axyh restart functions`. Reversing that order points live webhooks at a table that does not exist.
- [ ] `mem0 add_memory`; final report.

---

## Self-review

**Coverage of the brief.** Steps 1–2 → Task 1. Step 3 → Tasks 4 and 7 (amended by Departure 1 and finding 8: the row is written earlier *and* the reply is persisted before the send). Step 4 → Tasks 5–6. Step 5 → Tasks 1–2, via `enqueue_agent_reply` returning ownership rather than a bare unique constraint. Evolution is untouched, as instructed.

**Type consistency.** `enqueueAgentReply` returns `{ id, newlyEnqueued } | null` in Task 2 and is consumed in Tasks 7–8. `parseAgentReplyResult` returns `AgentReplyOutcome` in Task 3, consumed in Tasks 6–7. `RECOVERY_LIMITS` uses `leaseSeconds` in Tasks 5 and 6 and matches `claim_agent_replies(p_lease_seconds)`.

**Every state has an exit.** `pending`/`running`/`ready_to_send` are all claimable once their lease lapses; the reaper makes anything at max attempts terminal; the purge removes terminal rows on two windows. There is no state a row can occupy that nothing observes — the specific defect that sank revision 1.

**Honest limits.** None of these are defects to be fixed later by someone who reads this
carefully; they are the shape of the problem, and they are stated so the reviewer approves
them knowingly.

1. **Exactly-once delivery is not achievable** across Postgres and Meta. `delivery_unknown`
   names the ambiguity rather than resolving it by replay — but that only helps if someone
   looks. Task 6 Step 4 puts those rows in the Logs tab and `system_logs` for exactly that
   reason; if nobody watches them, this design degrades to "a small number of replies quietly
   need attention". That is an operational commitment, not just code.
2. **Anything that died in `running` goes to a human, never a retry.** A worker that died
   before calling any tool *is* recoverable in principle, and this will not recover it.
   Telling those apart needs per-tool checkpoints keyed by `<outbox-id>:<tool-index>`, which
   is a larger change than this plan. The trade is deliberate: a customer waits for a person,
   instead of two conflicting replies.
3. **A death before the enqueue is unrecoverable.** Accepted explicitly by the brief. The
   window is now milliseconds rather than ~50 seconds.
4. **Recovery is not instant.** A dead owner's 180s lease must lapse before cron can take the
   row, and cron runs every two minutes — so worst case is roughly 3–5 minutes before the
   customer's reply is retried. Shortening the lease below the 60s worker ceiling would let
   cron collide with a living owner, which is worse than the delay.
5. **`whatsapp-evolution-webhook` remains uncovered**, as the brief instructs. WhatsApp Cloud
   is now in scope (Task 9), so this is the only inbound surface without an outbox.
