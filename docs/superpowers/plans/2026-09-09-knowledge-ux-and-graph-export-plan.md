# Knowledge UX and graph export — Implementation Plan

Spec: `docs/superpowers/specs/2026-09-09-knowledge-ux-and-graph-export-design.md`
Branch: `feat/knowledge-ux-and-graph-export` · Base: `origin/main` at `3ba784cf`
Baseline gates on that commit: **1569 passed, 0 failed, 15 skipped; typecheck clean.**

Debated once with Codex astra 6 medium, read-only, against this checkout. The
verdict table is at the end of this file. Four of my original claims were false
and are corrected here rather than silently edited.

## Slices

| Slice | Tasks | Files owned |
|---|---|---|
| A | 1 | `src/components/automation/DatabaseConnectorsManager.tsx` |
| B | 2, 3 | `src/components/messaging/knowledge/KnowledgeSourcesPanel.tsx`, `src/hooks/useAiKnowledge.ts` |
| C | 4, 5 | `supabase/functions/ai-knowledge-ingest/exports.ts`, `supabase/functions/ai-knowledge-ingest/index.ts` |

File sets are disjoint, so the three run in parallel. **Slice B consumes an
interface Slice C creates.** That interface is written out verbatim below and
pasted into both briefs, so neither slice waits on the other. Nothing else
checks that the two sides agree — the frontend and the Deno function share no
types — so assembly greps both sides for the action string.

Each slice is **one assignment**. A slice carrying two tasks is done by one
implementer, in order, in one run. Tasks are never dispatched separately.

---

## The cross-slice contract

Slice C builds it. Slice B calls it. Both briefs carry this block verbatim.

```
Edge function : ai-knowledge-ingest
Action        : "download_source"
Request       : { action: "download_source", source_id: string }
Success (200) : { url: string }          // short-lived, directly fetchable
Not found(404): { error: string }        // unknown id, not the caller's, or unresolvable file
Auth   (401)  : { error: string }        // no or invalid caller JWT
```

The returned URL already carries its own attachment filename. The caller
navigates to it and does **not** add a `download` attribute.

---

## Global constraints

Quote verbatim into every brief. Paraphrasing loses what matters.

1. **Read `ARCHITECTURE.md` before editing anything under `src/**` or
   `supabase/functions/**`.** It governs layering, dependency direction, and the
   security shape new code must follow.
2. You do **not** commit. The orchestrator reviews the diff, runs the gates, and
   lands the change. Do not run `git commit`, `git push`, or `git checkout`.
3. Edit **only** the files listed for your slice. A stray edit outside that set
   breaks the parallel assembly.
4. Do not run any deploy step and do not merge anything.
5. Preserve backward compatibility. No existing prop, exported signature, or
   call site changes shape unless your task explicitly says so.
6. Match the surrounding code: this repository comments the *why* behind
   non-obvious decisions and does not restate what the code says.
7. No new runtime dependency. Neither `package.json` nor an edge function import
   map gains an entry.
8. **Stop at the end of your assigned slice.** Complete every numbered task in
   your slice, in order, then stop. Do not start another slice's tasks and do
   not act on anything in the spec outside your slice.
9. You do not write tests. A separate lane writes them afterwards.

---

## Slice A

### Task 1 — Cap and scroll the connector dialog

**File:** `src/components/automation/DatabaseConnectorsManager.tsx` only.

**Current state.** Line 1963 is `<DialogContent className="max-w-2xl">`; the
dialog closes at line 2401. Header, preset description, connector-type select,
the credential-field list, the URL field, the Composio connection picker, the
`SupabaseSchemaPicker`, and the footer buttons all render with no height cap and
no overflow container. On the Supabase preset the footer falls below the
viewport and cannot be reached.

**Change.** Cap the dialog's height to the viewport and make the *body* the
scroll region, leaving header and footer actions fixed.

- Give `DialogContent` a viewport-relative max height and a column layout that
  does not itself scroll.
- Wrap the form body — everything between `DialogHeader` and the footer action
  row — in one vertically scrolling element that is allowed to shrink.
  **In a flex column a child needs an explicit minimum-size reset to shrink
  below its content.** Without it the container grows to fit and the scroll
  never engages. That is the specific trap in this task.
- Leave the footer action row outside the scrolling element.

**Acceptance criteria.**

- On the Supabase preset at a 768px-tall viewport, the footer buttons are
  visible without scrolling the page, and the body scrolls to reveal every field.
- A short preset renders with no visible scrollbar and no tall empty frame.
- The dialog stays centred horizontally and vertically.
- Tabbing to a field below the fold scrolls it into view.
- No field, label, validation path, or handler is altered.

**Gates.** `bun run typecheck`, `bun run test`.

---

## Slice B — one assignment, tasks 2 then 3

### Task 2 — Show the true indexed date on each source

**Files:** `src/hooks/useAiKnowledge.ts`, then `KnowledgeSourcesPanel.tsx`.

**Do not use `updated_at`.** It was the original plan and it is wrong: the
visibility RPC in `20260828180000_knowledge_source_visibility.sql` writes the
source row and the trigger in `20260712000000_ai_agent_foundation.sql:139`
advances `updated_at`, so toggling sharing would show a new indexing date
without embedding anything.

**Use the newest chunk instead.** `ai_knowledge_chunks` has `source_id` and
`created_at`, and its RLS is `auth.uid() = user_id`, so the browser may read it.
A re-ingest replaces the chunks, so the newest chunk's `created_at` is the
honest answer to "when was this embedded". A sharing toggle does not touch
chunks.

**Change.**

- Extend the existing sources query in `useAiKnowledge.ts` with an embedded
  read of the newest chunk — one query, not a second round trip:

  ```ts
  .select("*, ai_knowledge_chunks(created_at)")
  .order("created_at", { referencedTable: "ai_knowledge_chunks", ascending: false })
  .limit(1, { referencedTable: "ai_knowledge_chunks" })
  ```

- Flatten it inside `queryFn` to `indexed_at: string | null` on each source, so
  the array never reaches the component. Add `indexed_at: string | null` to the
  `AiKnowledgeSource` interface.
- Render the date on each row, in the badge row beside the status badge,
  labelled **Indexed**.

**Rules the implementation must follow.**

- Render only when `source.status === "ready"` **and** `indexed_at` is present.
- **Guard null before constructing a Date.** `new Date(null)` is the Unix epoch,
  not an Invalid Date, and `Number.isNaN(getTime())` returns false for it — a
  null would render as January 1970. Write `if (!value) return null;` first,
  then construct, then check `Number.isNaN(date.getTime())`.
- Format with `toLocaleDateString`; put the full timestamp in a `title`
  attribute.

**Acceptance criteria.**

- A ready source with chunks shows a readable local date labelled Indexed.
- Pending, processing, and failed sources show no date.
- A source with no chunks, or `indexed_at` null, shows no date and does not
  render "Invalid Date" or a 1970 date.
- Toggling sharing on a source does not change the displayed date.
- Existing badges, crawl progress, the error line, and the sharing strip are
  unchanged.

### Task 3 — Download a knowledge source file

**File:** `KnowledgeSourcesPanel.tsx` (plus the hook only if a helper belongs
there).

**Do not sign the URL in the browser.** That was the original plan and it only
covers one of four stored `file_path` formats. `_shared/knowledgeSourceFiles.ts`
shows the others: legacy Cloudinary URLs, pre-private public-storage URLs, and
objects under an email folder. Cloudinary cannot be signed by Supabase, and the
storage SELECT policy in `20260712010000_ai_knowledge_bucket.sql` requires the
first path segment to equal `auth.uid()`, which the email-folder objects fail.

**Call the edge action instead.** Use the contract at the top of this file.

**Rules the implementation must follow.**

- Invoke the `download_source` action with the source id, using the same
  authenticated invocation style this panel's neighbours already use.
- Navigate the browser to the returned `url`. **Do not add a `download`
  attribute** — it is ignored cross-origin, and the server already sets the
  attachment filename.
- Render the control only for sources whose `source_type` has a file. `website`
  and `catalog` have none; omit the control rather than showing a button that
  always fails.
- Per-row pending state while resolving, cleared on both success and failure.
  A row must never be left stuck.
- A failure surfaces a visible error through the toast mechanism this panel's
  parent already uses. No silent failure, no unhandled rejection.
- Keyboard reachable, with an accessible label, matching the existing icon
  buttons in the row.

**Acceptance criteria.**

- A file-backed source downloads with its original filename.
- A website or catalog source shows no download control.
- A 404 or 401 shows an error and leaves the row interactive.
- No existing handler or prop changes shape.

**Gates for slice B.** `bun run typecheck`, `bun run test`.

---

## Slice C — one assignment, tasks 4 then 5

### Task 4 — Make the graph export an actual graph

**File:** `supabase/functions/ai-knowledge-ingest/exports.ts` only.

**Current state.** `buildGraphHtml` at line 48 returns one bordered box per
entity with relation names as plain text. No edges are drawn, no layout is
computed. Called from `index.ts:415`.

**Correction to the premise.** The output is **not** simply "uploaded to
Cloudinary". `uploadGraphExport` at `index.ts:306` tries Openinary, then
Supabase storage, then Cloudinary. The self-contained requirement is therefore
stronger, not weaker: the file must render standalone under whichever provider
served it.

**Change.** Rewrite `buildGraphHtml` to emit a self-contained interactive
node-link graph.

**Hard rules. Each has a reason; none is stylistic.**

- **`buildGraphHtml(entities, relations): string` keeps its exact signature and
  stays pure.** `index.ts:415` must not change.
- **No external resource.** No CDN script, no remote stylesheet, no web font.
  The output string must contain no `http://` or `https://` resource reference.
- **Keep the JSON escape exactly as it is.** The current code is
  `.replace(/</g, "\\u003c")` — a JSON unicode escape, which is what stops a
  `</script>` inside entity text from terminating the embedded script element.
  It is **not** an HTML entity escape, and `&lt;` would not work there. Copy the
  call verbatim.
- **Escape every untrusted value before it reaches the DOM.** Entity names and
  descriptions are model-extracted from user documents. Prefer creating text
  nodes over `innerHTML`; where markup is built as a string, every interpolated
  value passes through the escaper first.
- **Draw edges between the correct pair**, resolving both ids against the
  retained entity list. A relation naming an id that is not retained is skipped,
  never drawn to a phantom node.
- **The filter acts on the graph.** Filtering out a node removes its edges in
  the same pass. No edge may ever be drawn to a hidden node.
- **Bound the whole payload, not just the drawn nodes.** Rank entities by degree
  descending with name ascending as the tie-break, so the selection is
  deterministic. Keep the top N. Keep only edges whose *both* endpoints were
  retained. Embed only the retained nodes and edges in the JSON, and truncate
  each description to a stated length. State the cap in the file and render a
  visible line saying how many entities were omitted. An uncapped layout or an
  unbounded payload locks the browser tab.
- **Fixed iteration count** for the layout, computed once on load. No
  open-ended animation loop.
- **Distinguish node type** visually, and show each node's name without a hover.
- **Empty input renders a stated empty state**, not a blank page.

**Suggested approach, not binding.** Inline SVG with a small force-directed
layout in plain JavaScript: repulsion between nodes, attraction along edges, a
fixed iteration count. Circles, lines, text labels. Drag and zoom optional;
correct edges and a correct filter are what matter.

**Acceptance criteria.** These are checked by *executing* the returned HTML, not
by reading it — see the note on gates below.

- Output contains drawn edges connecting the correct node pairs.
- An entity named `</script><script>alert(1)</script>` is inert and appears as
  literal text. This is the case the escape exists for; an `<img onerror>`
  fixture does not exercise it.
- An entity named `<img src=x onerror=alert(1)>` also appears as literal text.
- A relation referencing an unknown entity id is skipped without error.
- Filtering to one entity leaves no dangling edges.
- Empty entities produce a page stating there is nothing to show.
- With more entities than the cap, the retained set is the highest-degree ones,
  ties broken by name, and the omitted count is stated.
- The output contains no `http://` or `https://` resource reference.

### Task 5 — Add the `download_source` action

**File:** `supabase/functions/ai-knowledge-ingest/index.ts` only. Touch nothing
in that file except what this action needs.

**Change.** Add the action defined in the contract at the top of this plan.

- Authenticate the caller. No valid JWT is a 401.
- Load the source row scoped to that caller — either under the caller's JWT, or
  under the admin client with an explicit `user_id` filter. Never load it
  unscoped.
- Resolve the file with `locateKnowledgeFile(source.file_path, { userId, email })`
  from `_shared/knowledgeSourceFiles.ts`. It already handles all four stored
  formats and refuses anything outside the owner's own folder. Do not
  reimplement that logic.
- A `storage` location becomes
  `createSignedUrl(path, 60, { download: file_name })`. The `download` option is
  what sets `Content-Disposition`, which is the only thing that names the file
  cross-origin.
- A `cloudinary` location returns its URL as-is.
- A null location, an unknown id, or a row belonging to someone else all return
  the same **404**. Do not distinguish them; a different response for "exists
  but not yours" tells a caller that an id exists.
- Fall back to the source id when `file_name` is null.

**Acceptance criteria.**

- A storage-backed source returns a signed URL that downloads with its original
  filename.
- A Cloudinary-backed source returns its URL.
- Another user's source id returns 404, identical to an unknown id.
- A source with an unresolvable `file_path` returns 404.
- No caller JWT returns 401.
- No other action in `index.ts` changes behaviour.

**Gates for slice C.** `deno check supabase/functions/ai-knowledge-ingest/index.ts`
(which type-checks `exports.ts` through the import) and `bun run test`.

**Both gates are blind to the graph script.** `deno check` cannot see inside a
returned string, and the existing `src/lib/__tests__/knowledgeGraph.test.ts`
covers `buildObsidianNotes` and normalization only — it never imports
`buildGraphHtml`. A completely broken graph passes both. That is why the test
lane must execute the HTML, and why task 4's acceptance is judged that way.

---

## Assembly

1. Collect the three slices onto `feat/knowledge-ux-and-graph-export`. They do
   not conflict.
2. **Grep both sides for the action string** `download_source` and confirm the
   request and response shapes match the contract. Nothing else checks this
   seam; the frontend and the Deno function share no types.
3. Run `bun run typecheck`, the full suite, and
   `deno check supabase/functions/ai-knowledge-ingest/index.ts` on the assembled
   branch. Green isolated slices prove nothing about the assembly.
4. `clean-code-guard` on all changed production code.
5. **Then** the test lane writes tests for tasks 1 to 5, gated by `test-guard`.
   The graph tests instantiate the returned HTML in jsdom with
   `runScripts: "dangerously"` and assert on the resulting DOM — edges, filter,
   empty state, the two hostile-name fixtures, and no script error.
6. **Re-run every gate after the tests land**, and again after any repair the
   tests prompt. The suite must be green on the exact commit that gets merged,
   not on an earlier one.

## Deployment note for the orchestrator

The frontend download button calls an edge action that does not exist in
production yet. The edge function is therefore a **prerequisite of the merge**,
not a follow-up: deploy `ai-knowledge-ingest` from this branch first, verify it,
then merge. Merging first ships a button that 404s.

## Out of scope for every slice

Deploying, merging, opening the pull request, and writing tests.

---

## Debate round 1 — Codex astra 6 medium, read-only, 2026-09-09

10 findings. Nine accepted, one accepted in part. None rejected outright. Four
were falsifications of claims I had made, verified by Codex against this
checkout.

| # | Finding | Sev | Verdict | Ruling |
|---|---------|-----|---------|--------|
| 1 | The XSS instruction specified a no-op escape | P1 | accept | Correct and serious. The real code is `.replace(/</g, "\\u003c")`, a JSON unicode escape; my spec said an HTML entity, which does nothing inside a script block and would have let `</script>` break out. The call is now quoted verbatim and a `</script>` fixture is required. |
| 2 | `updated_at` is the wrong column for an indexing date | P2 | accept | Codex proved it: the visibility RPC writes the row and a trigger bumps `updated_at`, so sharing a file would change its "indexed" date. Rejected the suggested relabel to "Updated" — that answers a question the user did not ask. Deriving from the newest chunk's `created_at` gives the true date with no migration, since chunk RLS is `auth.uid() = user_id`. |
| 3 | The null-date guard does not work | P2 | accept | `new Date(null)` is the Unix epoch, not Invalid Date, so my guard would have rendered January 1970. Guard on the value before constructing the Date. |
| 4 | Client-side signing cannot serve the legacy formats | P2 | accept | `knowledgeSourceFiles.ts` handles four stored formats. Cloudinary cannot be signed by Supabase and email-folder objects fail the storage policy. Moved to a server-side action reusing the existing, tested resolver. |
| 5 | Cross-origin `download` attribute does not name the file | P2 | accept | True; the attribute is same-origin only. `createSignedUrl(path, ttl, { download })` sets `Content-Disposition` server-side, which is the actual fix. |
| 6 | The claimed graph regression coverage does not exist | P2 | accept | Verified: `knowledgeGraph.test.ts` never imports `buildGraphHtml`, and `deno check` cannot see inside a string. Both my gates could pass with a broken graph. Execution in jsdom is now mandatory. |
| 7 | The delivery path is not Cloudinary | P2 | accept | `uploadGraphExport` tries Openinary, then storage, then Cloudinary. Premise corrected, and a post-deploy render check on the delivered file added. |
| 8 | A node cap does not bound the workload | P2 | partial | Accepted the substance: bound the embedded payload, retained edges, description length, and layout iterations, with a deterministic degree ranking and name tie-break. Rejected the demand for an automated label-readability check — that is not measurable in a gate; a dense fixture at the cap is what is actually checkable. |
| 9 | Slice B contradicts "stop after your numbered task" | P2 | accept | Real contradiction. Slices are now single assignments and rule 8 says stop at the end of the assigned slice. |
| 10 | Assembly validates before the tests exist | P2 | accept | Correct ordering gap. Tests now precede the final gate run, and gates re-run after any repair they prompt. |
