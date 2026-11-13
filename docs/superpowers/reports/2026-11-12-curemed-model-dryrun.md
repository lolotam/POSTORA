# CureMed model dry-run comparison

Source conversation: (redacted -- this file carries no customer data)

**Status: results pending.** The owner runs `scripts/probes/agent-model-dryrun.ts` after Tasks 1–6 are live. No candidate model has been selected and no measurements have been recorded here.

The reply text is not recorded here: the excerpt column reports how long the reply was and nothing else, and the conversation id is redacted, so this file can be committed. The unredacted detail is written beside it in the `.local` file, which git ignores -- keep that file out of every commit.

## Results

| Model | Turn | Latency ms | Reply language correct | Catalog tool called with non-empty query | Any URL present | Catalog grounded (identity match) | Reply excerpt (120 chars) | Status |
|---|---:|---:|---|---|---|---|---|---|
| Results pending | — | — | — | — | — | — | — |

## Grounding score

Catalog grounded compares the reply with bounded product identifiers, names and URLs returned by the catalog in that sandbox turn. Yes means an exact product identity match; it does not verify every price or medical claim. No means no returned product identity matched. An older sandbox response without `catalog_evidence` is not measured. The separate URL column counts any URL.

## Model selection

- Primary: results pending owner review.
- Fallback: results pending owner review.
