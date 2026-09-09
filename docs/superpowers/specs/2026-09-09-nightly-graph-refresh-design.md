# Nightly knowledge-graph refresh

Date: 2026-09-09
Status: implemented on `feat/nightly-graph-refresh`

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
   storage reference or any Supabase Storage object URL.

   The check is on the URL path, not the bucket. A first implementation asked
   only whether the bucket-aware parser called the value external, and a test
   asserting that a *foreign*-bucket storage URL is unrenderable failed against
   it. The test was right: these columns are user-writable through RLS, and
   Storage down-converts HTML on every bucket, not only `ai-knowledge`.

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
`createGraphExports` and `uploadGraphExport` out of `index.ts`, where they were
function-local and therefore unreachable from any other function. `index.ts`
imports them back. `cloudinarySignature` moved to `_shared` instead, because once
the block left it had two real callers: this upload and the source-file delete.

**`supabase/functions/ai-knowledge-graph-refresh/index.ts`** — the worker.
Guarded by `verifyCronAuth`. Selects due users, rebuilds each one, updates the
row. Shaped like `ai-knowledge-excel-worker`, which is the existing precedent for
scheduled knowledge work in its own function, and which already imports across
function directories.

**`supabase/functions/ai-knowledge-graph-refresh/dueUsers.ts`** — the staleness
rule as a pure function over rows, so all four conditions are testable without a
live database. This is where the real logic lives.

**`public.ai_knowledge_graph_activity()`** — a `SECURITY DEFINER` rollup
returning one row per user with entity count, relation count, newest timestamp
and email, so the worker decides staleness in one round trip rather than two
counts per user. It returns every user's email, so execute is revoked from
`anon` and `authenticated` and granted to `service_role` alone.

**Migration A** — `entity_count` and `relation_count` on
`ai_knowledge_graph_exports`, both nullable integers. Null means "written before
this existed", which rule 3 treats as stale, so every legacy row refreshes once.

**Migration B** — the pg_cron schedule, matching the `net.http_post` shape
already used by `drain-ai-knowledge-queue`.

Both migrations route to OpenCode Muse Spark per the standing lane rule.

## Release order

The columns migration is a hard prerequisite for the code, not a companion to
it. `createGraphExports` writes both counts unconditionally and throws on the
write error, and it backs the **existing** Export Graph button as well as the new
worker, so deploying the code first breaks a working feature for every user with
a PostgREST unknown-column error.

1. Apply `20260909170000_ai_knowledge_graph_export_counts.sql`.
2. Apply `20260909170100_ai_knowledge_graph_refresh_cron.sql`.
3. `NOTIFY pgrst, 'reload schema'` — the new columns and the new RPC are
   invisible to PostgREST until it reloads.
4. Deploy all five files. `_shared/cloudinarySignature.ts` is easy to miss and
   both functions fail to import without it.
5. Merge.

## Bounds

The edge worker is killed at 60 seconds. Each user costs one entity read, one
relation read, a zip build and two uploads. The worker stops starting new users
at 45 seconds elapsed and caps a run at 25 users. Anything not reached is due
again tomorrow and nothing is lost, because due-ness is derived from the data
rather than from a queue.

`uploadGraphExport` deletes the previous Openinary object before uploading its
replacement, because Openinary suffixes a collision rather than overwriting it.
That has always left a window where a failed upload leaves the row pointing at a
deleted object; what is new is that the nightly run opens that window for every
stale user at once. A user caught by an Openinary outage at 03:45 has a dead
graph link until the next night's run, which repairs it under `unrenderable_host`
or `count_changed` without anyone intervening.

## What did not need changing

The **Show Graph** button already opens whatever URL the server resolves, so
once a row holds an Openinary URL it opens the live page directly with no
signing step. No frontend change is part of this work.

## Known gap

An entity edited in place without changing counts or `created_at` will not mark
a user stale. Entities are upserted on conflict, so a description rewrite is
possible in principle. It does not warrant a hash column; the user is refreshed
the next time anything is added or removed.

## Decisions taken

**Folder name.** Exports currently live at
`postora.cloud/media/<account>/knowledge-graph/`. The request asked for a folder
named `Graphify`. Renaming is cheap but strands the existing objects in the old
folder and changes every stored URL. Recommendation: keep `knowledge-graph`,
which already sits under the account name.

**The Openinary URL is public — accepted knowingly on 2026-09-09.** It is
unauthenticated and derivable from the account email. That is what makes it a
live, shareable page, which is what was asked for.

The scope change deserves stating plainly, because the nightly job is what makes
it universal. Before this work, a public URL appeared only when a user chose to
click Export Graph. Afterwards the cron republishes every stale user onto one
automatically. The requester was shown this and chose to land it. Storage signing
remains the fallback for anything Openinary rejects.
