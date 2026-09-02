# Postora Partner API — Contract & Tooling

## Files in `docs/api/`

| File | Role |
|------|------|
| `openapi.yaml` | **Canonical contract**. The published OpenAPI 3.1 document for the Partner API. Every `/v1` route that is served is described here; `paths` is not a subset. |
| `openapi.baseline.yaml` | Last accepted baseline for the drift gate. Updated only by `scripts/regenerate-openapi-baseline.sh` after a reviewed contract change. |
| `accepted-breaking-changes.txt` | Acknowledgements for intentional breaking changes, one finding id per line as printed by `scripts/check-openapi-drift.ts`. Empty when the contract has no breaking change. |
| `postman/postora-partner-api.postman_collection.json` | **Derived** Postman Collection v2.1 (`https://schema.getpostman.com/json/collection/v2.1.0/collection.json`). Generated from `openapi.yaml`, never hand-edited. |
| `postman/local.postman_environment.json` | Postman environment — local (`http://localhost:54321`, `pk_test_REPLACE_ME`). |
| `postman/staging.postman_environment.json` | Postman environment — staging (`https://staging-api.postora.cloud`, `pk_test_REPLACE_ME`). |
| `postman/production.postman_environment.json` | Postman environment — production (`https://api.postora.cloud`, `pk_live_REPLACE_ME`). |

One-fact-one-place: the contract lives in `openapi.yaml`; the Postman collection and environments are derived. Do not edit the JSON files by hand — regenerate them.

## Regenerating the Postman files

```sh
deno run --allow-read --allow-write scripts/generate-postman.ts
```

The script parses `openapi.yaml` with `jsr:@std/yaml@1` (the same parser `check-openapi-drift.ts` uses), builds a deterministic collection (one folder per top-level resource, one request per path+method, `{{baseUrl}}` + path, `x-postora-key: {{partnerApiKey}}`, `Idempotency-Key: {{$guid}}` where required, synthetic examples from schema `example`s or type placeholders), and writes the four JSON files with stable key order, 2-space indent, trailing newline, fixed `_postman_id`s and no timestamps.

The regeneration test `scripts/generate-postman.test.ts` asserts the committed JSON is byte-identical to the generator output. If it fails, run the command above and commit the result.

Credentials in the generated files are obviously fake placeholders (`pk_test_REPLACE_ME`, `pk_live_REPLACE_ME`, `+15550000000`, `acc_000…`). No real key, phone, or workspace id is ever emitted.

## Drift gate

The contract is additive-only. How the gate works is defined in the header of [`scripts/check-openapi-drift.ts`](../../scripts/check-openapi-drift.ts) — that header is the authority; this README does not duplicate its prose.

In short: `openapi.yaml` is compared to `openapi.baseline.yaml`; every difference is classified against R1 field removal, R2 type narrowing, R3 enum removal, R4 required-field addition. Additive changes pass without acknowledgement. Breaking changes fail unless their finding id is listed in `accepted-breaking-changes.txt`. A stale acknowledgement also fails the gate. When a reviewed contract change lands, move the baseline and clear acks with:

```sh
bash scripts/regenerate-openapi-baseline.sh
```

Do not run that script before the change is reviewed — the baseline records what was reviewed.

## Versioning

`info.version` in `openapi.yaml` is ignored by the drift gate. Task 4 owns versioning.
