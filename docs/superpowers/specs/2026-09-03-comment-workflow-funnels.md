# Design Specification: Comment Workflow (comment-to-DM funnels)

**Date**: 2026-09-03
**Status**: Built. Revised twice — once after a codebase review of the original draft, once after an adversarial review by Codex.
**Feature flag**: `feature_comment_workflow` (ships off)
**Platforms**: Instagram, Facebook, Threads
**Out of scope**: YouTube. Its comment endpoints (`commentThreads.list`, `comments.insert`) require the `youtube.force-ssl` scope, which neither `youtube-oauth` (`readonly` + `upload`) nor the Composio YouTube auth config (`upload`) holds. It is a sensitive scope, so adding it means Google app re-verification. The Composio tool slugs the first draft named do not exist in this repo. YouTube needs its own spec, gated on that approval.

---

## 1. What this is

A **Comment Workflow rule** is a deterministic, per-account, optionally per-post funnel: *"comment GUIDE under this post and we DM you the link."* When a public comment matches, Postora posts one of the rule's public replies and, on Facebook and Instagram, sends the commenter **one private reply** — a DM opened from a public comment — carrying fixed copy and, optionally, a seven-day signed link to a file from the user's media library.

It is **not** a second comment pipeline. Postora already has one, and this extends it:

| Existing piece | File | What it already does |
|---|---|---|
| Meta ingestion | `facebook-instagram-webhook/index.ts` | receives `feed` / `comments` webhooks, normalizes, dedups via `social_inbox_events`, skips own comments, routes by handler |
| Threads ingestion | `_shared/threadsCommentIngest.ts` | same, fed by `threads-webhook`, `threads-poll-replies` and `threads-mentions` |
| Handler routing | `_shared/automationHandler.ts` | `comment_automation_handler` ∈ `off` (default) / `internal` / `n8n` |
| Internal automation | `_shared/commentAutomation.ts` | `messenger_auto_replies` keyword rules, then the AI agent |
| Public reply | `_shared/commentActions.ts` | Facebook `/{id}/comments`, Instagram `/{id}/replies`, Threads container+publish |
| DM credentials | `_shared/messengerCredentials.ts` | `getSendCredentials` resolves `{graphBase, pageId, pageToken}` |
| Signed links | `_shared/whatsappMediaResolver.ts` | `signMediaPath`, and `ownedStoragePath` for the ownership check |

The feature adds **one new platform capability** (the private reply), **one new decision step** in the two ingestion paths, **three tables and one view**, and **one page**.

### Against the AI agent
- **Comment Manager / AI agent**: conversational, model-driven, governed by personas. Untouched.
- **Comment Workflow**: fixed copy, fixed links, keyword triggers, no model call.

---

## 2. Where it sits in the pipeline

Funnel rules are evaluated **before** the `comment_automation_handler` switch, in both ingestion paths, for **every** handler value including the default `off`.

```
webhook / poller
  → social_inbox_events claim        (unchanged; this is the redelivery guard)
  → isOwnComment skip                (unchanged; this is the loop breaker)
  → NEW  runCommentWorkflow
        ├─ a rule matched → the funnel owns this comment; STOP
        └─ no rule matched → fall through, unchanged
  → handler switch: n8n → dispatchN8nEvent ; internal → handleCommentInternally ; off → nothing
```

**Exactly one automation answers a comment.** A claim suppresses the internal path and the n8n dispatch alike.

Two consequences worth stating plainly, because both change existing behaviour:

- **Firing on `off` is deliberate.** `off` means "no conversational automation", not "ignore the funnels I built". Creating a rule is itself the per-account opt-in; the handler is the account-wide fallback for everything a funnel did not claim.
- **A claimed comment no longer reaches n8n.** This is the harder trade. An n8n subscriber that only logs a comment loses that row; a subscriber that auto-replies would otherwise post a second reply under a comment the funnel already answered. The double reply is the worse outcome and it is visible to the account's audience, so suppression wins. Funnel activity is recorded in `comment_workflow_events`. If an n8n-side record proves necessary, the follow-up is a distinct `comment.workflow_handled` envelope carrying the statuses and an explicit "do not reply" marker — never the unchanged `comment.received` shape, which live subscribers already treat as a cue to reply.

**Mentions never reach matching.** Threads routes mentions through the same ingest door as replies (`threads-webhook`, `threads-mentions`). A mention is a stranger naming the account in their own thread, not a comment under the account's post, so `runCommentWorkflow` refuses `kind === "mention"` before anything else.

---

## 3. Matching

Inputs: the account's active rules, the comment text, the post id.

1. Filter to `target_post_id IS NULL OR target_post_id = post.id`.
2. Filter by `match_type`:
   - `exact` — the normalized comment equals a normalized keyword,
   - `contains` — a keyword is a case-insensitive substring,
   - `any` — every comment matches; `keywords` is ignored.
3. Normalization: trim, lower-case, collapse internal whitespace, strip trailing `.` `!` `?`. The punctuation strip is what makes an exact `GUIDE` funnel fire for the many people who type `GUIDE!`.
4. Blank keywords never match. `"".includes()` is true for every string, so one blank entry would otherwise claim every comment on the account.
5. Precedence: a post-specific rule beats an account-wide one; among equals, the oldest `created_at` wins, ties by `id`, and a row with no `created_at` sorts last.
6. Replies are matched like top-level comments.

The matcher is pure (`_shared/commentWorkflowRules.ts`), so precedence and normalization are tested without any I/O.

---

## 4. Execution

`_shared/commentWorkflow.ts` exposes `runCommentWorkflow(admin, account, input, deps?) → "claimed" | "unclaimed"`.

1. **Refuse mentions.**
2. **Load rules** for the account. A failed read is a failed read, never "no rules": log and return `"unclaimed"` so the normal pipeline still runs.
3. **Match.** No match → `"unclaimed"`.
4. **Write the event row first**, both statuses `pending`, upserted with `ON CONFLICT (social_account_id, external_comment_id) DO NOTHING`. No row back means another invocation owns this comment → `"claimed"`, nothing sent. Writing before sending means a killed worker leaves a visible `pending` row rather than silence.
5. **Take the send-once claim** (when `send_once_per_user`) *before* sending. A read-then-check loses the race between two comments from one person in different isolates; a primary key does not. A collision → both statuses `skipped`, reason `already_served`.
6. **Send.** Public reply via `replyToComment`, then the private reply via `sendPrivateReply`. The two legs are independent — neither failure cancels the other. Each is attempted **once**: Meta allows one private reply per comment, so a retry can only be refused, and that refusal is indistinguishable from the original failure.
7. **Release the claim only when every leg is known undelivered.** A Graph timeout is reported by `callGraph` as an unreachable upstream precisely because Meta may have accepted the request whose answer was lost; such a leg is recorded `indeterminate` and **keeps** the claim, so the person's next comment cannot produce a second DM for something they may already have. This matches `commentAutomation.ts`, which records usage in a `finally` so a failed send still throttles.
8. **Finalize** the event row with the statuses, the public reply id, and sanitized error text.

Both call sites run the whole decision inside `runInBackground`. This is not tidiness: `threads-webhook` awaits the ingest door on its HTTP response path, and a Threads public reply alone can spend nine seconds polling its container to `FINISHED` — long enough for Meta to treat the delivery as failed and send it again.

### Known limit
Nothing sweeps up a `pending` row. It is a signal to a human, not a work queue. A durable, leased state machine would close that gap; it is a larger piece of work than this feature and is not attempted here.

### `_shared/metaPrivateReply.ts`
`sendPrivateReply(admin, account, commentId, text, fetcher?)`:
- resolves the host and id through `getSendCredentials`, the same resolution the ordinary DM path uses, so a direct-login Instagram account posts to `graph.instagram.com/{ig-user-id}/messages` and a Page-backed account or Facebook Page to `graph.facebook.com/{page-id}/messages`;
- `POST` with `{ recipient: { comment_id }, message: { text } }`, 15-second timeout, errors mapped through `commentActions`' `failure()` so `error_user_msg` wins;
- **requires `message_id` in the response.** A 200 without one is not a send; treating it as one records an unproven delivery as `sent`;
- text only. Instagram private replies accept text only; the link form works on both platforms, so one code path;
- never logs the message text or a token.

Meta's terms this depends on: one private reply per comment, within seven days of the comment, requiring `pages_messaging` plus the relevant Instagram comment/message permission. The OAuth flows already request these, so no scope change. What that does **not** prove is that an account connected long ago granted them — a rule whose DM fails with a permission error surfaces as a `failed` row carrying Meta's own message, which is the reconnect prompt.

---

## 5. Media

- The rule stores `media_file_id`, and the database binds it to the rule's owner with a composite key, so a rule can never name another user's file.
- At send time the row is re-read and three things are checked, in order: the bucket is still `media` (a file can move after the rule is saved, and `signMediaPath` signs that bucket regardless), the path passes `ownedStoragePath`, and signing succeeds.
- **`ownedStoragePath` is the security control, not a nicety.** `media_files`' insert policy checks that the row's `user_id` is the caller's — it does not constrain `file_path`. Without the path check a user could save a row naming another user's object and have the service role sign it into a DM.
- A failure at any of those steps sends the copy **without** the link and records the reason. A lead with copy and no link can still be answered by hand; a lead with nothing cannot.
- The link lives seven days because a private reply is one-shot: there is no later message in which to refresh it. It is a bearer URL and anyone the message is forwarded to can use it, which the form says on screen.

---

## 6. Database

Migration `supabase/migrations/20260904120000_comment_workflow.sql`. Scoped by `user_id` like `messenger_auto_replies`; `workspace_id` is not used, because `social_accounts_whatsapp_needs_workspace` guarantees a workspace only for WhatsApp rows.

**Every ownership relationship is a composite foreign key.** Edge Functions run under the service role, so RLS is not enforcing tenancy for the code that writes these rows — only the schema is.

- `comment_workflow_rules` — configuration. Bound to `social_accounts (id, user_id, platform)`, so the denormalized `platform` cannot disagree with the account's, which is what makes "Threads rules carry no DM" unbypassable rather than advisory. Bound to `media_files (id, user_id)` for the attachment. CHECKs reject: blank or over-long names, a keyword rule with no usable keywords, blank array entries (an `ARRAY['']` reply would otherwise claim a comment and post nothing), a blank or over-long message, more than five replies, a rule that neither replies nor messages, a Threads rule with a DM, and a file with no message to carry it.
- `comment_workflow_events` — append-only audit **and** the per-comment idempotency key, `UNIQUE (social_account_id, external_comment_id)`. Per comment, not per person: that is what lets `send_once_per_user = false` exist and lets a failed attempt and a later success both stay visible. Bound to both the rule's owner and the account. Client-readable, never client-writable. `dm_status` and `public_reply_status` both carry `indeterminate`.
- `comment_workflow_usage` — the claim, primary key `(rule_id, author_key, external_post_id)`. RLS on with no policy: service role only. `external_post_id` defaults to `''`, so every comment whose post id the platform withheld shares one claim per person — the conservative reading, one DM rather than one per unknown post.
- `comment_workflow_rule_stats` — a `security_invoker` view. Without that flag it would read as its owner and hand every user everyone else's numbers.

Deleting a rule cascades to its events and claims. That is a real trade-off, stated on the delete dialog: switching a workflow off keeps the numbers.

---

## 7. Frontend

`src/features/comment-workflow/` — domain, infrastructure, ui — following `connectors` and `whatsapp-inbox`. `src/pages/automation/CommentWorkflowPage.tsx` is composition only.

**The flag needs seven edits**, not the four an outside reader would guess: the `FeatureFlags` interface, `DEFAULT_FLAGS`, `FLAG_KEYS` (the `app_settings` query filters on it, so a missing entry means the row is never read at all), the key map, the label map, `ALL_FLAGS_ENABLED`, and `baseFromDb`. `FeatureFlagIndicator` keeps a separate label map keyed by every flag and will not compile without its own entry.

**Admins receive every non-visibility flag regardless of its stored value.** This hides the page from users, not from an admin — which matters for rollout ordering.

- **Workflows tab** — platform filter, three summary tiles, one card per rule with account, scope, trigger, counters, an active switch, edit and delete. A failed load says so rather than rendering an empty list. Unconfirmed sends are shown apart from failures, because inviting a retry invites a refusal.
- **Create / edit tab** — account (platform is derived, never asked), scope with a post picker fed by the existing comment-manager actions, trigger and keyword tags, public reply variations, and — for Facebook and Instagram only — the private message and its optional attachment. Threads shows a one-line explanation instead.

Validation mirrors the CHECK constraints so a mistake reads as "Add at least one keyword" rather than a constraint name. It discriminates on a string, not a boolean: this project compiles with `strict: false`, and without `strictNullChecks` TypeScript will not narrow a union on a `true | false` field.

**Not built**, deliberately: no per-rule n8n forwarding URL (redundant with the existing dispatch, and a server-side fetch of a user-supplied address with no SSRF guard available), no delay control (it would need durable scheduling to mean anything), no changes to `/comments` or `/automation/agents`.

---

## 8. Testing

- Pure matcher: normalization, post precedence, oldest-wins, blank keywords.
- Adapter: each host/id pair including Page-backed Instagram, error mapping, a 200 with no `message_id`, a missing token, an unresolvable Page.
- Engine: 30 cases on **one timeline shared by the database and fetch stubs**, so "claim then send" cannot pass as "send then claim". Covers the claim collision, release only on known failure, indeterminate keeping the claim, the seven-day skip, mentions, and every media refusal.
- Routing: a claimed comment reaches neither n8n nor the internal handler, on every handler value; an unclaimed one behaves exactly as before.
- SQL harness `supabase/tests/comment_workflow.sql`: cross-owner, cross-platform and cross-media rejection; every CHECK; one event per comment; claim uniqueness; RLS denial on all three tables and the view; the flag ships off.
- Frontend: form validation and both tabs.

Mutation testing was used on the engine and the SQL suite rather than assumed. It found two tests that passed for the wrong reason, both since strengthened.

---

## 9. Rollout

1. Merge first, with the flag off and the code inert.
2. Apply the migration on production via `ssh-contabo-mcp`, rehearsed on a throwaway database (an outer `BEGIN` does not rehearse a Postora migration — they self-commit). Then `NOTIFY pgrst, 'reload schema'`, or the view stays invisible to PostgREST.
3. Deploy the edge functions through the documented volume copy and SHA256 verification in `docs/runbooks/deploy-edge-function.md`.
4. Only then turn the flag on, and create one rule on a test post to confirm end to end.

The frontend auto-deploys on merge, so step 1 must precede step 2 only in the sense that nothing is reachable until step 4. An admin can reach the page as soon as it merges, which is why the migration should follow promptly rather than sit.
