# Nightly knowledge-graph refresh

Date: 2026-09-09
Status: design, pending approval

## Why

Three defects sit on top of each other in the knowledge-graph export path.

**1. Unreachable links.** `resolveExportUrl` signed storage objects with a client
built from the in-cluster `SUPABASE_URL`, so the browser received
`http://kong:8000/storage/v1/object/sign/...` and failed DNS. Fixed and deployed
on 2026-09-09 (`fix/graph-export-public-signing`). Kept here because it explains
why the remaining two were invisible.

**2. Supabase Storage cannot render the graph, ever.** Measured on production:

| Host | Stored type | Served type | Browser result |
|---|---|---|---|
| Supabase Storage | `text/html` | `text/plain; charset=UTF-8` | source code |
| Openinary | `text/html` | `text/html; charset=utf-8` | rendered graph |

Storage down-converts HTML on serve as an anti-XSS measure. A graph that lands
on the storage fallback is unviewable no matter how good the HTML is. Openinary
is therefore not a preference, it is the only host that works for `graph.html`.

**3. Nothing regenerates an export.** `export_graph` runs only when a user asks.
An export is a snapshot of the entity and relation tables at the moment it was
written, so it goes stale the moment anything is indexed, and a row written
before Openinary was configured stays on the broken storage path forever.

Production state at design time:

| User | Entities | Newest entity | Export written | Host |
|---|---|---|---|---|
| `12f4ba6a` | 8 | 2026-08-24 | 2026-08-25 | Supabase Storage |
| `7fe4d34e` | 0 | n/a | 2026-08-30 | Openinary |
| `c371c63b` | 8 | 2026-08-31 | never | none |

## What we are building

A nightly worker that regenerates each user's graph export only when their graph
has actually changed, writing to Openinary under their own account folder.

### Why nightly and not on every embedding

Regenerating per embedding means a 50-file upload rebuilds the same graph 50
times, each run deleting and re-uploading the previous Openinary object, with
later runs racing earlier ones to the single `ai_knowledge_graph_exports` row.
Nightly collapses a day of activity into one rebuild per user. This is what the
requester proposed and it is the right shape.

### When a user is due for a refresh

Any one of these makes a user stale:

1. Entities exist and there is no export row.
2. The newest entity or relation is newer than `generated_at`.
3. Stored entity or relation count differs from the current count.
4. `html_url` or `vault_url` is not an external delivery URL, meaning it is a
   storage reference or a legacy public-storage URL.

Rule 3 exists because deletion never moves a `created_at`. The nightly prune at
03:15 deletes orphan entities, so without it a pruned user's graph would stay
stale forever with no timestamp to prove it. It needs two new columns.

Rule 4 is the backfill. It is what repairs `12f4ba6a`, and it self-heals any row
that fell back to storage because Openinary was briefly unavailable.

### Ordering

The refresh runs at **03:45**, after `prune-ai-knowledge-graph-daily` at 03:15,
so the exported graph reflects the post-prune entity set rather than being
invalidated half an hour later.

## Components

**`supabase/functions/ai-knowledge-ingest/graphExports.ts`** — pure move of
`createGraphExports`, `uploadGraphExport` and `cloudinarySignature` out of
`index.ts`. They are currently function-local, so nothing else can import them.
No behaviour change; `index.ts` imports them back.

**`supabase/functions/ai-knowledge-graph-refresh/index.ts`** — the worker.
Guarded by `verifyCronAuth`. Selects due users, rebuilds each one, updates the
row. Shaped like `ai-knowledge-excel-worker`, which is the existing precedent for
scheduled knowledge work in its own function, and which already imports across
function directories.

**`supabase/functions/ai-knowledge-graph-refresh/dueUsers.ts`** — the staleness
rule as a pure function over rows, so all four conditions are testable without a
live database. This is where the real logic lives.

**Migration A** — `entity_count` and `relation_count` on
`ai_knowledge_graph_exports`, both nullable integers. Null means "written before
this existed", which rule 3 treats as stale, so every legacy row refreshes once.

**Migration B** — the pg_cron schedule, matching the `net.http_post` shape
already used by `drain-ai-knowledge-queue`.

Both migrations route to OpenCode Muse Spark per the standing lane rule.

## Bounds

The edge worker is killed at 60 seconds. Each user costs one entity read, one
relation read, a zip build and two uploads. The worker stops starting new users
at 45 seconds elapsed and caps a run at 25 users. Anything not reached is due
again tomorrow and nothing is lost, because due-ness is derived from the data
rather than from a queue.

## Known gap

An entity edited in place without changing counts or `created_at` will not mark
a user stale. Entities are upserted on conflict, so a description rewrite is
possible in principle. It does not warrant a hash column; the user is refreshed
the next time anything is added or removed.

## Decisions to confirm

**Folder name.** Exports currently live at
`postora.cloud/media/<account>/knowledge-graph/`. The request asked for a folder
named `Graphify`. Renaming is cheap but strands the existing objects in the old
folder and changes every stored URL. Recommendation: keep `knowledge-graph`,
which already sits under the account name.

**The Openinary URL is public.** It is unauthenticated and derivable from the
account email. That is what makes it a live, shareable link, and it is what was
asked for, but it is a real change in exposure compared with a 30-minute signed
URL. Storage signing stays as the fallback for anything Openinary rejects.
