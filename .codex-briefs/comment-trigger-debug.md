# Debug brief: n8n Postora Comment Trigger never fires for a Facebook comment

## Repo
F:\Postora_new  (Postora — React/Vite frontend + self-hosted Supabase edge functions in Deno)
Vendored n8n node copy: `Postora-n8n-community-node/` (canonical repo lives at F:\N8N\Postora-n8n-community-node)

## Symptom (observed by the user, 2026-08-22)
A user commented on a Facebook post of a connected Page.
- The comment DOES appear in Postora's web UI: Messaging -> Comment manager.
- The n8n workflow's Postora trigger node did NOT receive any event.
No error was reported by the user.

## Your job
Find EVERY plausible reason the n8n trigger did not receive `comment.received`,
ranked by likelihood, each with a file:line citation as evidence. Do NOT write a
fix. Read the code and the READMEs. Output a markdown report.

## Where to look (read all of these fully)
- `supabase/functions/facebook-instagram-webhook/index.ts` — the `for (const change of entry?.changes || [])` block
- `supabase/functions/_shared/n8nMessagingDispatch.ts` — `dispatchN8nEvent`, `loadDestinations`, `dedupeDestinations`, `aliasEvent`, `deliverToDestination`, the per-subscription `platform` / `socialAccountId` filters
- `supabase/functions/_shared/automationHandler.ts` + its test
- `supabase/functions/_shared/commentAuthor.ts` — `isOwnComment`
- `supabase/functions/_shared/metaComments.ts` or wherever `normalizeMetaCommentChange` lives
- `supabase/functions/n8n-api/index.ts` — webhook subscription create/list endpoints, allowed events list
- `supabase/functions/messaging-api/index.ts` — how `comment_automation_handler` is read/written
- `src/components/messaging/AutomationHandlerCard.tsx` — the UI that sets the handler
- `Postora-n8n-community-node/nodes/PostoraTrigger/*` and `nodes/PostoraCommentTrigger/*` — the event lists each node registers, and how it subscribes
- `Postora-n8n-community-node/README.md` and the repo root `CLAUDE.md`

## Specific questions to answer with evidence
1. What is the FULL ordered list of conditions between "Meta POSTs the comment change" and "the n8n webhook URL is called"? Enumerate every `continue`/early-return.
2. Which of those conditions can be true while the comment STILL shows up in the comment manager UI? (i.e. which happen AFTER the row the UI reads is written — identify which table the UI reads.)
3. What is the DEFAULT value of `account_metadata.comment_automation_handler`, and does the Facebook page in question need it set to `n8n` for dispatch to happen? Cite the code.
4. Does `isOwnComment` skip a comment written BY the page itself / by the page admin acting as the page? Cite it.
5. On the webhook-subscription side: does a subscription created by an OLD version of the node (v1.2.1) contain `comment.received` in its `events` array? What happens in `loadDestinations` if it does not? Is there a wildcard?
6. Are the per-subscription `platform` and `social_account_id` filters set by `PostoraCommentTrigger`, and could a mismatch there silently drop the event?
7. Is `runInBackground` (EdgeRuntime.waitUntil) able to drop the dispatch if the function returns first? Cite `_shared/background.ts`.
8. Does the webhook subscription live in `app_settings` ("settings" registry) or a legacy table, and could the two registries disagree?

## Output
Write your report to `.codex-briefs/comment-trigger-<yourname>.md`. Ranked hypotheses,
each with: what would have to be true, the file:line evidence, and the exact SQL or log
grep that would confirm or refute it against production.
