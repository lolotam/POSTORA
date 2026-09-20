# Analysis Playbook

How to read a change well enough to explain it honestly. The collector script gathers facts; this
file is about turning facts into understanding.

## Contents

- [What the evidence pack contains](#what-the-evidence-pack-contains)
- [Reading a diff for user impact](#reading-a-diff-for-user-impact)
- [Tracing a component to a route](#tracing-a-component-to-a-route)
- [Merged is not deployed](#merged-is-not-deployed)
- [Mining review threads](#mining-review-threads)
- [What the collector cannot tell you](#what-the-collector-cannot-tell-you)
- [Building the journey from evidence](#building-the-journey-from-evidence)

---

## What the evidence pack contains

`scripts/gather_change_context.sh` prints sections: recent merges, PR metadata and body, review
comments, changed files with insertion/deletion counts, detected routes file, and the project's live
URL if one is discoverable.

Read the **changed-file list first, before the PR description.** Descriptions state intent; the file
list states fact. When they disagree, the files are right. A PR titled "small fix" touching thirty
files is telling you something the title isn't.

## Reading a diff for user impact

You are not reviewing the code. You are answering one question per hunk: **would anyone using the
product notice this?**

Signals a change is user-visible:

- Files under a `pages/`, `views/`, `screens/`, `routes/` or `components/` directory
- Changed string literals — button labels, headings, toast and error messages
- New or changed `<Dialog>`, `<Modal>`, `<Toast>`, form fields, routes, or navigation entries
- Changed conditionals around what renders

Signals a change is behavioural rather than visible:

- Same components, different logic — a guard clause, a changed threshold, a new branch
- Retry, timeout, scheduling, or polling changes
- Anything in a background job, cron, or queue

Signals a change is invisible:

- Tests, types, comments, docs, lockfiles, CI config
- Pure refactors — a module moved, a function extracted, no behaviour altered
- Logging and instrumentation, unless the reader is the one reading the logs

**A file being changed does not mean the user sees it.** Test files and internal modules are the
majority of most diffs. Counting them as user-facing is the most common way these reports go wrong.

## Tracing a component to a route

For each user-visible component file, find the URL that renders it. Without this the journey is
guesswork.

```bash
# 1. The collector prints the router file. Find where the component is routed:
grep -n "ComponentName" src/App.tsx src/main.tsx src/routes/* 2>/dev/null

# 2. If it is a child component, find its parent page first, then route that:
grep -rln "ComponentName" src/pages src/views src/screens 2>/dev/null
```

Note any query parameters or state the page needs — a page reached only as
`/automation?platform=instagram` must be described that way, or the reader lands somewhere that
looks nothing like your description and concludes the report is wrong.

If a component is reachable only after a precondition — a connected account, an expired token, a
pending item — that precondition is a step in the journey, not an aside.

## Merged is not deployed

This distinction matters more to the reader than any other, and it is invisible in a diff.

Establish, and state, which of these is true:

- Merged and auto-deployed — the change is live now.
- Merged, deploy pipeline pending — live within minutes.
- Merged, deploy is manual and has not happened — **not live**, and testing it now will show the old
  behaviour and produce a false bug report.
- Not merged — a branch or open PR only.

Check the repo's own deployment documentation rather than assuming. Many projects deploy the
frontend automatically and the backend manually; that asymmetry means half a change can be live
while the other half isn't. Say so explicitly when it applies.

## Mining review threads

Review comments from humans and bots are the richest source of "what nearly went wrong", and they
are where the honest caveats live.

Look for:

- Findings that were **fixed** — these are worth a line, because they show the change is stronger
  than it started.
- Findings that were **declined** — these need the reasoning, in the reader's language. A declined
  finding the reader later hears about from someone else, unexplained, damages trust badly.
- Anything explicitly **deferred** — this is next-task-prompt material.

```bash
gh pr view <N> --json reviews,comments
gh api repos/{owner}/{repo}/pulls/<N>/comments --jq '.[] | "\(.path): \(.body)"'
```

## What the collector cannot tell you

Be aware of these gaps and close them by hand when they matter:

- **Whether the change works.** Tests passing means the tests passed. Say that, not "it works".
- **Whether it's deployed.** Check the runtime, not the repo.
- **What the user's data looks like.** A fix affecting expired accounts is meaningless to a reader
  with none. Where you can safely query, do — a real count makes the report concrete.
- **Intent behind an odd-looking change.** Read the commit message and the linked issue before
  guessing.
- **Prior state.** If the reader complained about something specific before, tie the change to that
  complaint by name. The conversation history is evidence too.

## Building the journey from evidence

Every step must be traceable to something you read.

1. **Precondition** — what must be true first. An account connected, an item in a given state.
2. **Navigate** — the real URL, from the route trace.
3. **Act** — the actual control, named with the label from the changed code, not paraphrased.
4. **Expect** — what appears, specifically enough to distinguish success from failure.
5. **Verify** — how to confirm it truly worked, beyond the UI looking right. A reloaded page, a
   value that persisted, a state that changed.

Step 5 is what makes the journey trustworthy. A UI can show a success toast and have saved nothing;
without a verification step the reader confirms only that a message appeared.

**When a change is behavioural or protective, do not invent clicks.** Describe instead what to watch
and over what period: "over the next few days you should stop seeing X" or "if the network drops
mid-save, the previous behaviour was Y and now it is Z". Be explicit that there is nothing to press.
