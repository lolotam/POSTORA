---
name: waleed-task-summary-and-journey-guide
description: Investigates what a code change actually did — reading PRs, merges, commits and diffs — then explains it to a non-technical reader in professional Arabic and English, and derives a click-by-click testing journey from the surfaces the change actually touched. Use this whenever the user asks what happened, what changed, what a PR or merge did, asks for a summary or explanation of recent work, asks "شنو صار" or "وش سويت" or for a شرح or ملخص, wants to know how to test or verify something that was just built or deployed, or hands over a report from another agent (Claude Code, Codex, OpenCode, Antigravity) and wants it made understandable. Use it even when they don't say the words "Arabic", "journey" or "summary" — any request to make technical work legible to a human belongs here.
---

# Task Analysis, Bilingual Explanation & User Journey

Turn technical work into something a non-technical person can understand, trust, and verify
themselves.

The reader is smart but does not read code. They own the product. They want three things: what
actually changed, whether it's safe, and how to see it with their own eyes.

## The rule that makes this skill work

**Investigate first. Never translate a summary you were handed.**

The failure mode this skill exists to prevent is fluent restatement — taking someone's report and
rewording it in Arabic. That output is confident, readable, and worthless, because it inherits every
gap and every error in the source. A handed-over report is a *lead*, not a source.

So before writing a single sentence of explanation, read the actual change: the diff, the pull
request, the review threads, the commits. Everything you claim must trace to something you read.

This is also what makes the journey real. A testing journey invented from a summary sends the user
clicking at screens the change never touched. A journey derived from the diff points at the exact
page whose file was modified.

---

## Step 1 — Establish what you are explaining

Work out the subject before gathering anything. In order of preference:

1. An explicit reference the user gave — a PR number, branch, commit, or file.
2. The work done earlier in this conversation, if the session did it.
3. Otherwise: what recently landed on the main branch.

Run the bundled collector, which handles all three and prints a structured evidence pack:

```bash
bash <skill-dir>/scripts/gather_change_context.sh          # recent merges to main
bash <skill-dir>/scripts/gather_change_context.sh 69       # a specific PR
bash <skill-dir>/scripts/gather_change_context.sh abc1234..def5678   # a commit range
```

It collects the merge commits, PR title/body/state, review comments, changed files with line
counts, and the project's live URL and route file if it can find them. Read
`references/analysis-playbook.md` before interpreting the output — it explains what to look for
and, more importantly, what the collector *cannot* tell you.

If the repo has no remote, no `gh`, or the user is asking about uncommitted work, fall back to
reading `git diff` and the working tree directly. The collector is a convenience, not a gate.

## Step 2 — Classify every change by what the user can see

This is the analytical core, and it is where most of the value is created. For each meaningful
change, decide which of these it is:

| Class | Meaning | What the reader needs |
|---|---|---|
| **Visible** | New or changed UI, copy, or flow | A journey with real click steps |
| **Behavioural** | Same screens, different outcomes | What to watch for, and over what timescale |
| **Protective** | Prevents a bad thing that used to happen | The scenario it now prevents, described concretely |
| **Internal** | Refactors, tests, types, docs | One honest line — say it changes nothing they can see |

Getting this wrong is what produces useless journeys. A change that hardens a background token
refresh has no button to click; pretending otherwise wastes the reader's time and burns their trust
in every future report you write. **Say plainly when there is nothing to click.** That honesty is
worth more than a fabricated walkthrough.

For each Visible change, trace the changed component file to the route that renders it — the
collector prints the router file, and a `grep` for the component name usually resolves it in one
step. That trace is what turns "the agent settings page changed" into "go to
`/automation?platform=instagram`".

## Step 3 — Find the risk the reader would care about

The reader cannot audit the work, so they rely on you to surface what they'd want to know:

- Anything deployed versus merged-but-not-live. These are different states and the difference
  matters enormously to someone about to go test it.
- Anything deferred, skipped, or knowingly left incomplete.
- Anything that touches money, credentials, deletion, or sending things to real customers.
- Disagreements in review threads that were declined rather than fixed — and why.

Report these in the reader's terms, not the codebase's. "This will not work until it's deployed to
the server" beats "pending edge function deployment".

## Step 4 — Write the report

Follow the template in `references/output-template.md` exactly — it is the structure the reader has
learned to expect, and consistency is what lets them skim it. Write the Arabic first: it is the
primary language here, and drafting English first produces Arabic that reads like a translation.

Read `references/arabic-style.md` before writing. It carries the register, the technical-term
glossary, and the rules for numbers and RTL punctuation. Arabic quality is the single thing that
decides whether this skill feels professional or machine-made — treat that file as required, not
optional.

**Save the report to a file as well as showing it.** Arabic renders unreliably in terminals, so the
file is often where the reader will actually read it. Write to `docs/journeys/YYYY-MM-DD-<slug>.md`
if a `docs/` directory exists, otherwise the repo root. Tell the user the path.

## Step 5 — The next-task prompt, only when it is earned

If the analysis surfaced genuinely unfinished work — deferred items, known defects, a deploy that
still has to happen — end with one copy-pasteable prompt the user can hand to a coding agent.

Write it so it survives being pasted into a fresh session with no memory of this one: name the
files, the constraints, and the gates to run. If the repo has an architecture or contributing
document, cite it by name, because a delegated agent loads nothing automatically.

If nothing real remains, **omit the section**. Manufacturing follow-up work to fill a heading
trains the reader to ignore that heading.

---

## What separates a professional report from a mediocre one

**Concrete beats general.** "Reconnecting an Instagram account now opens the login-method dialog
instead of showing a toast" tells the reader something. "Improved the reconnection experience" tells
them nothing.

**Name the before and the after.** The reader knows the old behaviour — it is why they asked. Anchor
every explanation to the thing they experienced.

**Explain the why, briefly.** One sentence of cause turns a list of changes into a story someone can
retell to a colleague or a customer.

**Never overstate.** If tests passed but nothing was deployed, say exactly that. If a fix is
probable but unproven in production, say that too. This skill's whole value is that the reader can
trust it without being able to check it.

**Keep technical terms in English with an Arabic gloss on first use.** Translating `Pull Request`
into pure Arabic makes the text harder for a reader who sees the English word in the interface all
day. See the glossary in `references/arabic-style.md`.

---

## Bundled resources

- `scripts/gather_change_context.sh` — collects PRs, merges, diffs, routes and the live URL into one
  evidence pack. Run this before analysing.
- `references/analysis-playbook.md` — how to read the evidence, classify changes, trace components
  to routes, and spot the things the collector misses.
- `references/arabic-style.md` — register, tone, the technical glossary, and number/punctuation
  rules. Required reading before writing Arabic.
- `references/output-template.md` — the exact report structure, bilingual, with a worked example.
