# CureMed model dry-run comparison

Source conversation: (redacted -- this file carries no customer data)

**Status: results pending.** The owner runs `scripts/probes/agent-model-dryrun.ts` after Tasks 1–6 are live. No candidate model has been selected and no measurements have been recorded here.

The reply text is not recorded here: the excerpt column reports how long the reply was and nothing else, and the conversation id is redacted, so this file can be committed. The unredacted detail is written beside it in the `.local` file, which git ignores -- keep that file out of every commit.

## Results

| Model | Turn | Latency ms | Reply language correct | Catalog tool called with non-empty query | Any URL present | Reply excerpt (120 chars) | Status |
|---|---:|---:|---|---|---|---|---|
| Results pending | — | — | — | — | — | — | — |

## What this report does not measure

- Catalog grounding. The sandbox hands the probe the tool CALLS it made -- the
  name and the arguments -- and never the rows the catalog returned, so
  "Catalog tool called with non-empty query" says the catalog was SEARCHED, not
  that the answer came from it. A model that searches and then answers something
  unrelated scores exactly like one that answers from the rows. The probe cannot
  measure grounding without the rows and the sandbox does not expose them, so no
  grounding score is reported here. Read the answers in the owner copy beside this
  report before choosing a model.
- The URL column says "Any URL present" and not "Product link present", for the
  same reason: the probe never sees the catalog's rows, so it cannot tell the
  catalog's `product_url` from a homepage or a tracking link.

## Model selection

- Primary: results pending owner review.
- Fallback: results pending owner review.
