# Threads Platform Agent & AI Agent for Public Comments — Design

**Date:** 2026-08-22
**Sub-projects:** 2 (Threads platform agent parity) and 3 (Postora AI agent + auto-replies for public comments)
**Depends on:** sub-project 1 (`docs/superpowers/specs/2026-08-22-n8n-comment-trigger-and-automation-handler-design.md`, shipped as PR #16, node v1.3.0)

---

## Goal

Two things the platform cannot do today:

1. **Threads has no agent surface.** `ThreadsMentions.tsx` offers only Mentions and Replies. There is no Auto Replies, Agents, or AI Agent tab, and five database CHECK constraints reject `platform = 'threads'` outright.
2. **The Postora AI agent and auto-reply rules only answer DMs.** Public comments are handled manually (comment manager) or by n8n. The `Postora AI Agent` option under **Comments** in the Automation card is rendered disabled with a *"Coming in a later update"* hint.

After this work, `comment_automation_handler = "internal"` makes rules and the AI agent answer public comments on Facebook, Instagram and Threads, and Threads gets the same management tabs Facebook and Instagram have.

---

## The convergence that shapes the design

Sub-project 2's brief asks for a "Threads delivery transport in `ai-agent-reply` using two-step publishing". Sub-project 3's brief asks for "AI agent replies to public comments".

**On Threads these are the same feature.** Threads exposes no DM API, and the app has no Threads inbox — `AutomationHandlerCard` already hides the Messages row on Threads. Every Threads agent reply is therefore a reply to a *reply or mention*, i.e. a comment.

And that transport already exists: `_shared/commentActions.ts:replyOnThreads` implements exactly the two-step `POST /{threads_user_id}/threads` (with `reply_to_id`) → `POST /{threads_user_id}/threads_publish` flow the brief describes, and has done since sub-project 1.

So the design is **one seam, not two**: `ai-agent-reply` gains a comment-reply sender that delegates to `_shared/commentActions.ts`. That single change gives Facebook, Instagram *and* Threads comment replies, and satisfies the Threads-transport requirement without a second Threads Graph client.

---

## Architecture

### Reply routing

```
comment webhook (fb-ig | threads)
  └─ recordInboxEvent            (unchanged; always runs, drives the realtime UI)
  └─ isOwnComment?  → stop       (loop breaker — MUST stay before the branch)
  └─ resolveCommentAutomationHandler(account.account_metadata)
       ├─ "off"      → stop
       ├─ "n8n"      → dispatchN8nEvent(comment.received)      [sub-project 1, unchanged]
       └─ "internal" → handleCommentInternally()               [NEW]
                         ├─ matchAutoReplyRule(rules, text, now)
                         │     └─ match → replyToComment() + log usage → done
                         └─ no match → ai-agent-reply { comment_id, … }
                                          └─ replyToComment()
```

### New and changed modules

| File | Change |
|---|---|
| `supabase/migrations/20260822180000_threads_agent_platform.sql` | **new** — widen 5 platform CHECK constraints |
| `supabase/functions/_shared/autoReplyRules.ts` | **new** — pure away/keyword matcher |
| `supabase/functions/_shared/commentAutomation.ts` | **new** — internal comment pipeline |
| `supabase/functions/ai-agent-reply/index.ts` | comment sender, comment-scoped daily cap |
| `supabase/functions/ai-agent-reply/logic.ts` | `surface` on `buildSystemPrompt` |
| `supabase/functions/facebook-instagram-webhook/index.ts` | branch on handler; reuse shared matcher |
| `supabase/functions/threads-webhook/index.ts` | branch on handler for replies **and** mentions |
| `supabase/functions/messaging-api/index.ts` | `supportedAiAgentPlatforms += "threads"` |
| `src/pages/messaging/ThreadsMentions.tsx` | 5 tabs |
| `src/components/messaging/AutomationHandlerCard.tsx` | enable `internal` for Comments |
| `src/hooks/useMessengerAutoReplies.ts`, `useAiAgentConfig.ts` | widen platform unions |
| `nodes/PostoraTrigger/PostoraTrigger.node.ts` (both copies) | 6 comment/mention events |

---

## Decisions

### D1 — `ReplyRequest` gains an optional `comment_id`

```ts
interface ReplyRequest {
  …
  comment_id?: string;   // present ⇒ reply to a public comment, not a DM
}
```

`buildReplySender` branches on it *before* platform, so one branch serves all three platforms:

```ts
if (request.comment_id) {
  const account = await loadAccount(admin, request);
  return async (_recipientId, text) => {
    const result = await replyToComment(account, request.comment_id!, text);
    if (!result.success) throw new Error(result.error || "Comment reply failed");
    return result.platform_comment_id || `ai_${Date.now()}`;
  };
}
```

**The throw is required.** `replyToComment` returns `{success:false, error}` rather than throwing; `TextSender`'s contract is to throw. Returning a value on failure would make `logOutcome` record a failed public reply as `sent`.

`recipient_phone` is still required by the existing validation, so callers pass the comment author id (or username on Threads) — it is unused by this sender but keeps the request shape and the log rows uniform.

**`comment_id` is service-role only.** `ai-agent-reply` has two callers: platform webhooks holding the service-role key, and the in-app Test sandbox holding a user JWT. The JWT branch forces `dryRun = true` and never sends, but it also builds the request from user-controlled body fields. `comment_id` is therefore read **only** on the service-role branch and ignored on the JWT branch, so no user-supplied value can ever reach a public-reply call. Account tenancy is enforced as before, by `.eq("user_id", request.user_id)` on the account lookup; the comment id itself is trusted because it came from a Meta-signature-verified webhook payload the same request derived the account from.

### D2 — `conversation_id` is per (post, commenter)

```
`${account.id}_comment_${postKey}_${authorKey}`
postKey   = post.id ?? comment.id       // Threads mentions carry no root post
authorKey = author.id ?? author.username ?? comment.id
```

- **Per comment** would give every comment its own `ai_threads` row, so `reply_cooldown_seconds` and `daily_message_cap` — both keyed on `conversation_id` — could never fire. A busy post would mean one LLM call and one public reply per comment with no ceiling.
- **Per commenter, account-wide** (the first draft of this spec) leaks context across posts. The agent replays the last 4 turns of that thread, so something a person said under post A can surface in a **public** reply under post B, in front of a different audience. On a public surface that is a privacy failure, not just a relevance bug.
- **Per (post, commenter)** keeps continuity where it is wanted — someone going back and forth under one post — and makes cooldown meaningful, without carrying context between audiences.

Threads wrinkle: `normalizeThreadsReply` sets `author.id = null` always — Threads reply payloads carry only a username. The `?? author.username` fallback is not defensive padding; it is the Threads path. Usernames are mutable, so Threads continuity is inherently weaker than Meta's; bounding it to one post root limits what a handle change or reuse can expose.

### D3 — the daily cap is re-scoped for comments

`isDailyCapReached` counts `ai_agent_logs` rows for one `conversation_id`. Under D2 that is a per-commenter cap, which is not a spend guard: 500 distinct commenters in a day means 500 LLM calls and 500 public replies with `daily_message_cap` never reached.

For comment requests the cap counts **all comment conversations on the account** instead:

```sql
conversation_id LIKE '<account.id>\_comment\_%' ESCAPE '\'
```

No new column and no new config field — the account id is already embedded in the conversation id by D2. `daily_message_cap` therefore means "DMs per conversation per day" for messages and "comment replies per account per day" for comments. This asymmetry is deliberate and documented in the code.

**The escape is load-bearing.** `_` is a single-character wildcard in SQL `LIKE`, so an unescaped `<uuid>_comment_%` would also match `<uuid>Xcomment_…`. A shared `escapeLikePattern` helper escapes `\`, `%` and `_` in the account id prefix.

Only rows with `status = 'sent'` consume cap — errors and skips do not, matching the existing DM behaviour.

### D4 — auto-reply matching is extracted, sending is not

`processAutoReplies` in `facebook-instagram-webhook` mixes three things: rule *matching*, DM *sending* via the Send API, and a module-level `lastAutoReplyMap` cooldown. Only the matching is reusable — comments send through `replyToComment` and have no Send API, no `whatsapp_conversation_assignments` row, and their own cooldown story.

So `_shared/autoReplyRules.ts` exports the pure part only:

```ts
export interface AutoReplyMatch { ruleId: string; replyMessage: string; }
export function matchAutoReplyRule(rules: AutoReplyRule[], inboundText: string, now: Date): AutoReplyMatch | null
```

Away rules are evaluated before keyword rules (existing precedence, preserved). `facebook-instagram-webhook` is refactored to call it — behaviour-preserving, and it is what makes the schedule logic unit-testable for the first time.

**Rule ordering becomes deterministic.** `messenger_auto_replies` has no ordering constraint, and the current query relies on whatever order Postgres returns, so "the first matching keyword rule" is undefined today. The shared matcher orders candidates by `created_at, id` — oldest rule wins — which is stable across replicas and vacuum. This is a latent-bug fix for the DM path as well.

**Away rules apply to comments too**, as the brief specifies, with one guard. The surface is opt-in behind a handler that defaults to `off`, so no existing account changes behaviour. But an away message written for DMs ("We're closed, we'll get back to you tomorrow") posted publicly under *every* comment on a busy post is spam, not service. So on the comment surface an away rule fires **at most once per post per away window**: before sending, the pipeline checks `messenger_auto_reply_usage` for any row whose `conversation_id` matches this account and post prefix inside the window. Keyword rules are unaffected — they are the natural public-comment case ("price" → "DM us for a quote") and stay per commenter.

No `scope` column is added — that would be a schema change and a user migration with no caller today. The away-on-public behaviour is called out in the PR description and release notes.

**Matcher failures fail closed on comments.** In the DM path a thrown error during rule evaluation returns "no match" so the AI can still answer. Publicly, replying while the rule configuration is in an unknown state is the worse outcome, so on the comment surface an exception aborts the whole pipeline instead of falling through to the agent.

### D5 — Threads mentions take the internal path, not just replies

The `replies` webhook field still needs a manual subscription in the Meta App Dashboard (pending since sub-project 1). If internal handling hooked only `replies`, the Threads agent would ship looking dead for exactly the same reason the comment trigger looked missing.

Mentions are comment-shaped, already normalized in `threads-webhook`, and `reply_to_id` accepts the mention's media id, so the same two-step publish works. Own-mention suppression already exists on that path and is reused unchanged.

### D6 — comment cooldown is database-backed, not in-memory

`lastAutoReplyMap` is a module-level `Map` in the fb-ig webhook. Edge function isolates are recycled, so it is best-effort for DMs and would be worse for comments (a burst of comments on one post can land across isolates).

The comment path relies on `ai_threads` + `ai_agent_logs` instead — `isCooldownActive` reads `ai_thread_messages`, which is durable. Rule-matched comment replies write a `messenger_auto_reply_usage` row, and the pipeline checks for a usage row on the same conversation inside the cooldown window before sending again.

### D7 — surface-aware system prompt

`buildSystemPrompt` currently hardcodes *"You are a customer-service assistant answering on WhatsApp"* and *"Keep replies short and WhatsApp-friendly"*. Posting that voice as a public Facebook comment reply is wrong on its face.

`SystemPromptParams` gains `surface?: "dm" | "comment"`. On `comment` the prompt says the reply is a **public** comment visible to everyone, instructs the model to keep it to one or two sentences, and to move anything account-specific or private to DMs rather than answering it in public. Default stays `dm`, so every existing caller is unchanged.

### D8 — Threads Agents tab ships roster-only

`AgentManager` calls `useConversations(account.id, messagingPlatform)` with `WHATSAPP | INSTAGRAM | MESSENGER`. Threads has no conversation records, so there is nothing to assign.

The tab ships with the parts that do work — register as agent, set status, view the roster — and an explicit empty state on the assignment card saying Threads conversations cannot be assigned yet. Building an assignable Threads comment-thread list is real additional scope and is **not** in this spec.

### D9 — deploy order

1. Migration (widens constraints; safe on its own — nothing writes `threads` yet)
2. Edge functions via ssh + SHA256 verify
3. **PR merge last**

The frontend auto-deploys on merge to `main`, and the frontend is what un-disables the *Postora AI Agent* comment option. Merging first would show users a selectable option with no backend behind it.

---

## Error handling

- `replyToComment` failures throw inside the sender, so `ai-agent-reply` logs `status: "error"` with Meta's `error_user_msg` and mirrors it to `system_logs` — the existing path, no new handling.
- A rule-matched comment reply that fails to send is logged and **still claims the comment** (precedence is decided by the match, not the send result — same rule as the DM path), so a failed rule reply does not fall through to the AI.
- Rule *evaluation* that throws returns "no match", letting the AI answer as a fallback (existing DM semantics, preserved).
- Webhook handlers keep returning 200 on internal failure. Meta retries non-200, and the inbox insert is the idempotency claim — a retry after a partial failure must not re-run automation.

### D10 — bounded public input, no empty replies

Comment text is attacker-controlled free text on a public surface. Two cheap bounds, no moderation pipeline:

- inbound comment text is truncated before it reaches the model (the existing `ai_agent_logs.inbound_text` already truncates at 2000 chars; the prompt uses the same bound);
- a reply that comes back empty or whitespace-only is logged as `skipped`, never posted.

Full input/output moderation, link policy and PII screening are **out of scope** and recorded as such below.

---

## Known limitations (accepted, not fixed here)

Raised in the codex review round and deliberately not addressed:

| Limitation | Why it is acceptable here |
|---|---|
| **No retry / dead-letter for a failed reply send.** A matched rule or agent reply that Meta rejects is logged and dropped. | Identical to the DM path shipped today. Adding a durable retry queue is an architectural change affecting all four surfaces, not a comment feature. |
| **Cooldown and daily cap are check-then-send, not reservations.** Two isolates can both pass the gate and both reply. | Also identical to the DM path. The inbox `upsert … ignoreDuplicates` claim already serialises per comment, so the exposure is concurrent *distinct* comments, bounding overshoot rather than allowing unbounded spend. A reservation table is the right fix and belongs in its own change. |
| **A send timeout is ambiguous** — the inbox row is claimed but delivery is unknown. | Meta's own retry is suppressed by the 200 response by design (re-running automation on retry is the worse failure). |
| **No content moderation on public replies.** | See D10. The prompt constrains voice and length; it is not a safety control. Users opt in per account, and the handler defaults to `off`. |
| **Threads `replies` events still require a manual Meta Dashboard subscription.** | Cannot be fixed in code. Mentions work without it (D5), so the feature is not dead on arrival — but Threads coverage is partial until the user completes it. Called out in the release notes and the final report. |

## Testing

- **Deno**: `autoReplyRules.test.ts` (away schedule incl. overnight windows, day filter, keyword precedence, no-match); `commentAutomation.test.ts` (rule match replies and stops; no match hands off; own-comment never reaches either); comment-sender adapter converts `{success:false}` into a throw; comment daily-cap query shape.
- **Vitest**: `ThreadsMentions` renders 5 tabs; `AutomationHandlerCard` offers a selectable `internal` Comments option and saves it.
- **Jest** (node repo): `PostoraTrigger.node.test.ts` covers the 6 new event values registering correctly.

## Out of scope

- Assignable Threads conversations / a Threads DM inbox.
- A `scope` column separating DM rules from comment rules.
- Per-platform-surface AI agent configs (`ai_agent_configs` stays unique on `(user_id, platform)`, so one config serves both DMs and comments on a platform).
- Comment analytics.
