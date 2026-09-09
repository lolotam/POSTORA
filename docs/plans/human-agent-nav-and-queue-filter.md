# Human Agent: nav relocation + waiting-queue platform filter

**Branch:** `worktree-human-agent-nav-and-queue-filter`
**Date:** 2026-09-08

## Why

Two problems, found while reviewing the Human Agent surface.

1. **`/human-agent` was filed under the Ad Manager header dropdown**, beside Ad Manager,
   Ad Analytics, Leads CRM and WhatsApp Shop. A live support queue has nothing to do with
   advertising. It belongs beside Agent Setup — the AI half of the same conversation pipeline.

2. **The waiting queue is a flat, unfilterable union of three platforms.** When it is busy there
   is no way to work just the WhatsApp backlog. The data already supports filtering: every row is
   tagged with its platform at `HumanAgentMode.tsx:62-64`.

## Explicitly rejected

Moving the whole Human Agent page into Agent Setup as a sixth tab, per platform. Three reasons:

- `whatsapp_agents` is unique on `(workspace_id, user_id)` — one row per human per workspace.
  Agent Setup is scoped to one `social_account_id`. A per-account online toggle backed by a
  workspace-global row would appear to change state on accounts the user never touched.
- The queue's whole purpose is to unify three platforms in one view. Splitting it into per-platform
  tabs means a person on shift must visit three screens and will miss whatever is on the tab they
  are not looking at.
- The per-account half of human handoff already lives in Agent Setup as `HumanHandoffCard`.

A filter is a lens over one unified queue. Tabs would be navigation that hides rows. That is the
distinction this plan turns on.

## Slice 1 — nav relocation (DONE, by orchestrator)

Moved the `flags.humanAgent` entry from `adManagerChildren` to `automationChildren`, positioned
directly after Agent Setup.

No `basePath` change is needed. `isDropdownActive` checks child-path equality *before* falling back
to the `basePath` prefix, which is already how `/messaging` and `/comments` highlight correctly
inside the Automation dropdown despite not sharing its prefix.

## Slice 2 — waiting-queue platform filter (DELEGATED)

### Behaviour

- A chip row above the waiting queue: `All` plus one chip per platform that has a connected account.
- Each chip shows a count of currently-waiting conversations for that platform.
- `All` is the default and is always present.
- The row is hidden entirely when fewer than two platforms have connected accounts.
- Selecting a chip filters the rendered queue only. It does not refetch.
- The empty state names the active filter.

### Invariants

- **The "Waiting" stat card stays unfiltered.** It is a global overview; making it follow the
  filter would make the number lie about the workload.
- **A filter whose platform disappears degrades to `All`,** derived rather than stored, so a
  disconnected account can never leave the user staring at an empty queue with no chip to clear.
- **Counts are per *selected account*, not per platform.** `accountFor()` feeds each platform's
  queue from one account only. With two Facebook Pages connected, `Facebook 3` means three waiting
  on the currently selected Page. The UI must not imply otherwise.

### Out of scope

- The single-account-per-platform limit itself (pre-existing; would need `useConversations` to
  accept multiple accounts).
- Any change to claiming, assignment, or the edge functions.
- Showing the conversation's AI engagement mode on queue rows (separate, worthwhile, not this).

## Follow-up found during review (not fixed here)

**ARCHITECTURE.md §22 "Canonical Contract Rule" lists "platform names" as a contract that must have
one authoritative definition. The messaging platform union is currently inlined six times in `src/`:**

```
src/components/messaging/AccountSelector.tsx:10      platformFilter?: "facebook" | "instagram" | "whatsapp" | null
src/components/messaging/ConversationDetail.tsx:22   platform?: "facebook" | "instagram" | "whatsapp"
src/components/NotificationBell.tsx:134              (platform: "facebook" | "instagram" | "whatsapp", ...)
src/pages/messaging/UnifiedInboxesPage.tsx:16        export type InboxPlatform
src/components/messaging/human-agent/queueFilter.ts  export type Platform
src/hooks/useAiAgentConfig.ts:7                      AiAgentPlatform (superset — adds threads, youtube)
```

This slice took the count from seven to six by deleting the local copy in `HumanAgentMode.tsx` and
importing the one in `queueFilter.ts`. Consolidating the rest behind a single exported type is a
separate refactor across six files and was deliberately kept out of this change.

Note that `queueFilter.ts` is a UI leaf, so it is the *convenient* home for the union, not the
*correct* one. Whoever does the consolidation should give the type a shared module rather than
adopting this one.

## Gates

`bun run typecheck` · `bun run lint` · `bun run test`

Verified independently by the orchestrator after the delegated implementation:

- `bun run typecheck` — clean.
- `eslint` scoped to the four changed files — **0 errors, 0 warnings**.
- `bun run test` — full suite green.

`bun run lint` across the whole repo exits 1 on a pre-existing backlog of ~1326 `no-explicit-any`
errors unrelated to this change. Confirmed by scoping eslint to the changed files.
