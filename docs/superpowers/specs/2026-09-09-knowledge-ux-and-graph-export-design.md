# Knowledge UX and graph export — Design Specification

Date: 2026-09-09
Branch: `feat/knowledge-ux-and-graph-export`
Base: `origin/main` at `3ba784cf`

Three independent user-reported defects. They touch disjoint files, which is
what allows them to be implemented in parallel. One seam does cross slices —
the download button calls a new edge action — so that contract is written out
verbatim in the plan and pasted into both briefs, rather than one slice waiting
on the other.

---

## Task 1 — The connector credentials dialog does not scroll

### Root cause, with evidence

`src/components/automation/DatabaseConnectorsManager.tsx:1963` opens

```tsx
<DialogContent className="max-w-2xl">
```

and the dialog closes at line 2401. Roughly 440 lines of JSX — header, preset
description, connector-type select, a variable-length credential-field list, the
URL field, the Composio connection picker, the schema picker, and the footer
actions — render inside it with **no height constraint and no scroll container**.

Radix's `DialogContent` is already centred: the shipped `dialog.tsx` variant
applies `fixed left-[50%] top-[50%] translate-x-[-50%] translate-y-[-50%]`.
Centring is therefore not the missing piece. What is missing is a maximum height
relative to the viewport and an overflow region, so on the Supabase preset —
which has the longest credential-field list — the lower part of the form and the
footer buttons render past the bottom of the screen with no way to reach them.

### Requirements

1. The dialog is capped at a viewport-relative height so it can never exceed the
   screen.
2. The **body scrolls**; the header and the footer actions stay visible. A
   scroller that carries the Save button off-screen solves nothing.
3. Centring is preserved. With a max-height set, Radix's translate-based
   centring continues to hold.
4. Every other preset that uses the same dialog keeps working. This dialog is
   shared across all connector types, so the change must be neutral for short
   forms — a short form must not grow a scrollbar or a fixed tall frame.
5. Keyboard and focus behaviour is unchanged: tabbing into a field below the
   fold scrolls it into view.

### Non-goals

Redesigning the form, splitting it into steps, or changing any field. The
complaint is reachability, not layout.

---

## Task 2 — Knowledge sources need an embedded date and a download

`src/components/messaging/knowledge/KnowledgeSourcesPanel.tsx` renders one row
per source with a title, three badges, and re-ingest plus delete buttons.

### 2a. Show when each file was embedded

**No schema change is required, but `updated_at` is the wrong column.** It was
the first choice and the debate falsified it: the visibility RPC in
`20260828180000_knowledge_source_visibility.sql` writes the source row, and the
trigger at `20260712000000_ai_agent_foundation.sql:139` advances `updated_at`.
Toggling who a file is shared with would therefore change its "indexed" date
without embedding anything.

**The newest chunk is the honest source of truth.** `ai_knowledge_chunks`
carries `source_id` and `created_at`, and its row-level security is
`auth.uid() = user_id`, so the browser may read it directly. A re-ingest
replaces a source's chunks, so the newest chunk's `created_at` is exactly when
the current content was embedded. A sharing change does not touch chunks.

Requirements:

1. Extend the existing sources query with an embedded read of the newest chunk,
   in one round trip, and flatten it to `indexed_at: string | null` on each
   source before it leaves `queryFn`.
2. Render the date on each row, next to the existing badges, only for sources in
   `ready` status that have an `indexed_at`. A pending or failed source has not
   been embedded, and showing a date there would assert something untrue.
3. Format it in the user's locale, with the exact timestamp available on hover.
4. A null or unparseable value renders nothing. Guard the value **before**
   constructing a `Date`: `new Date(null)` yields the Unix epoch rather than an
   Invalid Date, so a naive `isNaN(getTime())` check would render January 1970.

### 2b. Download a specific file

`file_path` is on the row. Per PR #54 the files live in a **private** Supabase
bucket addressed as `supabase://ai-knowledge/<path>`, so a public URL will not
work and must not be attempted — the bucket has previously drifted public, and
that defeated every per-owner storage policy.

**Signing in the browser is not sufficient, and was the first plan's error.**
`supabase/functions/_shared/knowledgeSourceFiles.ts` shows four stored formats,
not one: the current `supabase://` bucket reference, legacy Cloudinary URLs,
pre-private public-storage URLs, and objects under an email folder. Cloudinary
assets cannot be signed by Supabase at all, and the email-folder objects fail
the storage SELECT policy in `20260712010000_ai_knowledge_bucket.sql`, which
requires the first path segment to equal `auth.uid()`. A browser-side
implementation would leave every pre-PR-#54 file undownloadable.

The resolver that already handles all four, with the ownership check, is
server-side and tested. The download therefore goes through a new action on the
`ai-knowledge-ingest` edge function, which reuses it.

Requirements:

1. A download control on each row whose source type has a file.
2. It calls the edge action, which resolves the file under the service role
   after confirming the row belongs to the caller, and returns a short-lived
   URL.
3. Sources with no file — `website` and `catalog` types — do not get the
   control. The type badge already distinguishes them, so omit it rather than
   showing a disabled button.
4. A failure surfaces an error to the user. It must not fail silently, and it
   must not leave the row in a stuck loading state.
5. The filename offered to the browser is the source's `file_name`, not the
   storage path. Because the URL is cross-origin to the app, an `<a download>`
   attribute is ignored; the name must be set server-side through the signed
   URL's `download` option, which sets `Content-Disposition`.
6. An unknown id, another user's id, and an unresolvable file all return the
   same 404. A distinct response for "exists but not yours" would confirm that
   an id exists.

### Non-goals

Bulk download, re-download of website crawls, and any change to ingestion.

---

## Task 3 — The knowledge graph export is not a graph

### Root cause, with evidence

`supabase/functions/ai-knowledge-ingest/exports.ts:48`, `buildGraphHtml`, emits
one `<article class="node">` per entity: a bordered box holding the entity name,
its type, its description, and the *names* of its relations as plain text spans.

There are no edges, no positions, and no layout. Boxes flow inline and wrap.
Nothing connects a relation to the entity at its other end — the relation is
rendered as a word, not a link. That is precisely the reported symptom: HTML
renders, and it does not look like a knowledge graph, because it is a list.

### Requirements

1. Render an actual node-link graph: entities as nodes, relations as drawn edges
   between the correct pair.
2. **Self-contained.** `uploadGraphExport` at `index.ts:306` tries Openinary,
   then Supabase storage, then Cloudinary — the file is not bound to one
   provider, which makes the requirement stronger rather than weaker. No
   external script or stylesheet may be required for it to render; an offline
   copy must work. This rules out pulling a graph library from a CDN.
3. Preserve the existing XSS defences, exactly as written. The current code
   serialises the graph JSON through `.replace(/</g, "\\u003c")` — a JSON
   unicode escape, which is what stops a `</script>` inside entity text from
   terminating the embedded script element. It is not an HTML entity escape, and
   an entity escape would not work in that position. Entity names and
   descriptions are model-extracted from user documents and are untrusted. Any
   rewrite keeps both this escape and the per-value escaping before insertion,
   and must not reintroduce raw `innerHTML` interpolation of untrusted text.
4. Keep the existing filter box, and make it act on the graph: a filtered-out
   node and its edges disappear together, so no edge is ever drawn to a node
   that is not shown.
5. Readable at both ends of the size range. The graph must stay legible for a
   handful of entities and must not lock the browser on a large one; state and
   enforce a node cap, rendering the most-connected entities first and saying
   plainly how many were omitted.
6. Node type is visually distinguishable, and node identity is readable without
   hovering every node.
7. `buildGraphHtml` stays a **pure function of its two arguments**, returning a
   string. It is unit-testable that way today, and the ingest function's call
   site at `index.ts:415` must not need to change.
8. Empty input renders a stated empty state, not a blank page.

### Non-goals

Changing what the graph contains, the extraction pipeline, the Obsidian vault
export, or the Cloudinary upload path.

---

## Global constraints

These apply to every task and must be quoted verbatim into any implementation
brief.

1. **Read `ARCHITECTURE.md` before editing anything under `src/**` or
   `supabase/functions/**`.** It governs layering, dependency direction, and the
   security shape new code must follow.
2. The implementer does **not** commit. The orchestrator reviews the diff, runs
   the gates, and lands every change.
3. Do not touch files outside the task's own file list. The three tasks run in
   parallel against disjoint paths, and a stray edit outside that set breaks the
   assembly.
4. Do not run any deploy step, and do not merge anything.
5. Preserve backward compatibility. No existing prop, exported signature, or
   call site changes shape unless the task explicitly says so.
6. Match the surrounding code: this repository comments the *why* behind
   non-obvious decisions and does not restate what the code says.
7. No new runtime dependency. Neither `package.json` nor an edge function import
   map gains an entry.

## Verification

Per task: the project's own suite (`bun run test`), `bun run typecheck` for the
frontend tasks, and `deno check` for the edge function. Assembly is verified by
running the full suite on the integration branch, not on the isolated slices.

Task 3 additionally requires a rendered check: generate the HTML from fixture
data and confirm it draws edges, filters correctly, and escapes a hostile entity
name.
