# CureMed model dry-run comparison

**Status: results pending.** The owner runs `scripts/probes/agent-model-dryrun.ts` after Tasks 1–6 are live. No candidate model has been selected and no measurements have been recorded here.

## Results

| Model | Turn | Latency ms | Reply language correct | Catalog tool called with non-empty query | Any URL present | Reply excerpt (120 chars) |
|---|---:|---:|---|---|---|---|
| Results pending | — | — | — | — | — | — |

The last column says "Any URL present" and not "Product link present": the probe reads the
sandbox's tool CALLS, never the rows the catalog returned, so it cannot tell the catalog's
`product_url` from a homepage or a tracking link. The column beside it says whether the
catalog was searched at all.

## Model selection

- Primary: results pending.
- Fallback: results pending.
