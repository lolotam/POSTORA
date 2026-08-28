# Plan — per-account agent configuration (PR2/PR3 completion)

Status: revision 2, 2026-08-28. Revision 1 was reviewed by Codex and rejected; the review
found nine defects and this rewrite adopts all nine. The staging order is inverted from
revision 1, which is the most important change.

## Goal

One Postora account owning several accounts on the same platform (`dr.vet.waleedtam` today
has 6 Facebook pages, 9 Instagram accounts, 6 Threads profiles) must be able to give each of
them its own agent: persona, model, engagement mode, caps, and its own subset of knowledge.

## Where we are

| Piece | State |
|---|---|
| `ai_agent_configs.social_account_id` | exists, backfilled, 0 rows null |
| `ai_agent_configs_user_id_platform_key` UNIQUE (user_id, platform) | **still enforced** |
| `ai_knowledge_source_accounts` | exists, backfilled to every account |
| `match_ai_knowledge_*_for_account` | live; an owned account with **no links at all** reads the whole corpus |
| `_shared/agentConfigLookup.ts` | account config first, else the owner's config for the platform |
| Frontend | sends no account id |
| `create_ai_knowledge_source` RPC | exists since the expansion migration, **no caller** |
| `ai_agent_logs` | has no `social_account_id` |

## What revision 1 got wrong

**The staging was backwards.** Revision 1 shipped the UI first and dropped the constraint
last. But while `UNIQUE (user_id, platform)` stands, writing a config for a *second* account
on a platform violates it — so the account selector would have been able to switch pages and
then fail every save. Worse, the contract migration only asserts that each existing config
*has* an account; it never asserts that each active *account* has a config. Removing the
platform fallback at that moment would have silenced up to 18 of that user's 21
Facebook/Instagram/Threads accounts at once, because pages B–F inherit page A's config today
and would suddenly resolve to nothing.

**The knowledge fallback is non-monotonic.** "No links means read everything" is keyed on the
account having *zero* links, so removing a source's last link *grants* that account the entire
corpus, and adding the first link *shrinks* its access from everything to one document.
Permission-shaped state must never behave that way. (This is live today, shipped in #59. It is
latent rather than active because nothing in the UI can yet remove a link.)

**Several claims in revision 1 were simply false**: that passing an account id would scope the
Logs tab (`ai_agent_logs` has no account column), and that the sandbox would keep working
(it hardcodes `social_account_id: "test"`, resolves to no account, and would return
`agent_not_configured` for every test once the fallback is gone).

## Revised order: clone, then drop, then select

Every account gets its own config **before** anything stops falling back. After the clone
step, removing the fallback is a no-op, because there is nothing left to fall back to.

### PR A — make knowledge visibility explicit

Absence of links must stop meaning "allow everything".

1. `ai_knowledge_sources.visibility text NOT NULL DEFAULT 'shared'`, check-constrained to
   `('shared','restricted')`. Backfill every existing row to `'shared'`.
2. Retrieval rule becomes: a source is visible to an account when
   `visibility = 'shared'` **or** an explicit link to that account exists. Replace the
   zero-link predicate in `20260828170000` (`ai_knowledge_account_reads_whole_corpus`) with
   this; drop that function.
   - monotonic: adding a link never removes access, removing the last link from a
     `restricted` source hides it rather than revealing everything
   - a newly connected account sees the shared corpus and no restricted documents, which is
     the behaviour #59 was reaching for without the surprise
3. Uploads route through the existing `create_ai_knowledge_source` RPC so the source and its
   links are one transaction. Today `AiKnowledgeManager` inserts the row and then ingests, so
   a failure between the two leaves an unlinked source.
4. Tests: shared source visible to an unlinked account; restricted source invisible to it;
   restricted source with its last link removed is invisible to everyone; adding a link never
   reduces what an account can see.

### PR B — clone configs to every active account

1. Migration: for every active messaging account with no config, insert a copy of the owner's
   platform config (persona, model, mode, caps — every column). This is what keeps pages B–F
   answering across the cutover.
2. The same migration then asserts **zero active messaging accounts lack a config** and raises
   with the offending list if any do. That is the assertion revision 1's contract migration
   was missing.
3. `SET NOT NULL` on `social_account_id`; drop `ai_agent_configs_user_id_platform_key`.
4. Add `platform` to the config's composite FK, or validate it in `resolveAgentAccountId` and
   `resolveOwnedAccountId`. Today an internal request naming `platform: "instagram"` with a
   Facebook account id resolves and loads the Facebook persona.
5. `resolveOwnedAccountId` also filters `is_active` — a stale id currently updates a dead
   account row while the live one stays unconfigured.

### PR C — the account selector

1. `useAiAgentConfig(platform, socialAccountId)`; query key includes the account; sends
   `social_account_id` on read and write.
2. `AiAgentManager` owns the selection (default: first active account, the filter
   `AutomationHandlerCard` already uses) and passes it to `AutomationHandlerCard`,
   `AiKnowledgeManager` and `AiAgentTestChat`.
3. **The form refuses to submit a config it never loaded.** This is the defence that would have
   prevented today's incident on its own: a blank form is not a save, it is an unloaded form.
   Independent of any account work, and worth having regardless.
4. Sandbox: `AiAgentTestChat` sends the selected account; `ai-agent-reply` resolves it for the
   dry-run path and keys the sandbox thread per account, so page B's test cannot replay page
   A's turns.
5. Only after PR C is live: delete the platform fallback from `_shared/agentConfigLookup.ts`
   and the unscoped read in `ai_get_config`.

### PR D — reconnect lifecycle

A QR reconnect inserts a **new** `social_accounts` row, orphaning the config and the knowledge
links. This happened in production today and was repaired by hand. Codex is right that this is
not an enhancement: it is lifecycle integrity for the identifier the whole design keys on.
Either the reconnect reuses the existing row, or it transfers config and links atomically
before the new account goes active.

### PR E — per-account logs

`ai_agent_logs` records only platform and conversation id, so the Logs tab shows every account
on the platform, including other pages' customer text. Add `social_account_id`, write it from
every dispatch site, backfill what is derivable from the conversation id, index it, and filter
the query. Until this ships, the Logs tab must not claim to be account-scoped.

## Deployment holes to close in PR B/C

- An old Edge Function request in flight when the constraint drops will fail on
  `ON CONFLICT (user_id, platform)`. Drain or accept a brief window of failed saves.
- **Rolling the backend back after PR B is not safe**: the old code targets a conflict key that
  no longer exists, and once several configs share a platform the old unique constraint cannot
  be restored. Treat PR B as forward-only and say so in the runbook.
- A cached frontend that reads null and then saves is the exact defect from this morning.
  PR C step 3 is what closes it; ship that before removing the unscoped read.

## Explicitly not in scope

- `ai_agent_tools`, `whatsapp_auto_replies`, `messenger_auto_replies` per account
- Comment-automation filters per account
- `social_account_id` on `ai_threads` / `ai_conversation_modes`. Live conversation ids already
  discriminate — Facebook/Instagram DMs use `${account.id}_${sender}`, comments use the account
  UUID, WhatsApp uses the business phone identity — so the only real gap is the sandbox, which
  PR C step 4 fixes directly. Revisit if evidence shows a live collision.
