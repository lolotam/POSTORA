# Meta owned analytics read paths: merge, deployment and live verification

This record covers the deployed versioned Facebook/Threads **read** paths. It does not accept historical collection, the shared UI, Instagram capability verification, a pilot or a schedule.

## Reviewed source and deployment

| Change | Reviewed head | Merge commit | Merge time (UTC) |
|---|---|---|---|
| [#340](https://github.com/lolotam/POSTORA/pull/340): canonical contract and versioned Threads reader | `680ee7f2ccc623930f423e97e92fd7658a40e517` | `500f4bbc0574b8b1df55e107f847641bf58fa22f` | 2026-11-01 07:19:06 |
| [#341](https://github.com/lolotam/POSTORA/pull/341): Facebook owned reader, shared transport and final comparison correction | `0f98e331c2292c113687953f8015dda7f445c459` | `3f1da2d4fb20d7976d0067a368824114d0baf234` | 2026-11-01 07:20:36 |

All reported hosted checks succeeded on both reviewed heads. CodeRabbit's #340 observations were checked and corrected/adjudicated in the [contract record](2026-11-01-unified-threads-contract.md#review-corrections-and-adjudication); the final missing-comparison observation was corrected in #341. Codex completed its #341 review on the exact head with no findings. CodeRabbit initially skipped #341 because its base was a non-default feature branch; that skip is not represented as a completed review. Before retargeting #341 to main, the merged parent tree was verified identical to its reviewed feature tree. The final main tree was then verified identical to the reviewed combined head.

The versioned deployment helper ran at **07:21:27–07:21:47 UTC**, moving the functions volume from the already deployed parent to `3f1da2d4`. It restarted functions and the knowledge worker required by the shared-module change. Health returned 200. Changed-function boot probes returned Facebook 204, Threads 200, MCP 200 and n8n-api 200. All **18 changed runtime TypeScript files** matched their canonical Git-blob SHA256 hashes in the volume; the [public manifest](evidence/2026-11-01-meta-read-runtime-manifest.json) contains only source paths, hashes and the source commit.

No migration, credential, collection switch, eligibility list, analytics schedule or retention control was changed. The deployment helper's existing runtime reconciliation schedule is separate from analytics collection schedules.

## Live reads on the authorized aliases

Exact account mappings and raw measurements remain in the restricted evidence directory. Public aliases and authorization scope are owned by the [capability record](2026-11-01-meta-live-capabilities.md). Requests used the selected account and authenticated owner, `analyticsContractVersion: 1`, seven closed `America/Los_Angeles` days and the deployed production handlers.

At **07:26:51–07:26:58 UTC**, both `FB-01` and `TH-01` returned HTTP 200 with the expected account/platform/version, `source: live` and `sync.status: never_synced`. The handlers applied the canonical schema before returning their responses. These calls passed through the internal Kong route, not a synthetic server.

- Facebook returned available views, engagements and final-day follower observations for both periods. Daily unique viewers remained `window_mismatch` as a period aggregate; unverified metrics remained unavailable. No private measurements are published here.
- Threads returned available profile visits for both periods and a current follower observation. Its previous follower value remained `not_collected`; undated interaction totals remained `window_mismatch`. Content views were not substituted for profile visits.

At **07:29:51–07:29:55 UTC**, one signed continuation per platform returned HTTP 200, kept the frozen period/account and introduced no duplicate returned post IDs. Threads reached the observed end with `posts.status: available` and no continuation. Facebook still had continuation and correctly remained partial; full Facebook listing exhaustion has not been proved by this bounded check. Both handlers returned exact `401 / unauthorized` for an unauthenticated request and for a service-role request missing its owner identifier.

At **07:36:07–07:36:13 UTC**, actual API-key calls to n8n-api's `/api/v1/analytics` returned the versioned contract for both selected aliases through the real proxy-to-function path. Facebook completed in **2.399 seconds**, Threads in **3.489 seconds**, each below 45 seconds. These are measured healthy-path requests, not a universal latency guarantee or a signed-in browser/MCP-client journey.

| Restricted artifact | SHA256 |
|---|---|
| Runtime hash/report verification metadata | `3958d2d5fb0218463afd40d28d8b1066518a7e49a8dc19751864bae275f20068` |
| Facebook first deployed report | `496d5e3514e4c1b8d9cfb862a6059277f92d741249d139d0b3976b222f93fd08` |
| Threads first deployed report | `82865dd7986a66f7b2e90bfe98716b7a6d324d9ef56b8b4a500f5d5e74bbb35f` |
| Continuation/auth-refusal metadata | `915812751eb0613c0f2b524a0e6627478e21f78cb442a9d465e9f71ffcf7a666` |
| Facebook second report page | `8f46cd66f71423ac39c9989ea28ae607b9d563887a490785d976d0519794b725` |
| Threads second report page | `52d2363bf0061340a6332fde72ff290a46b7401801ced4629f3511f306327522` |
| API-key proxy verification metadata | `ca24589d3580969a2208eb5e1d927a27f83276bff394ae36a28625c810874414` |
| Facebook proxy report | `8fd9f43b262cb52829ae7703ff87c39e5a22467b3a74c404ce96c1e772bae7cf` |
| Threads proxy report | `aedb2783d7e3169c0b1dc4e39ed8cc6990f95ac6b238f14d8f98acaf183e1926` |

## Public-ingress observation

The initial external Python-urllib POSTs received **HTTP 403, `error code: 1010`** from Cloudflare before reaching either handler. Both bodies were the same non-JSON 17-byte refusal. A subsequent credential-free request confirmed `Server: cloudflare`, a `cf-ray` header and the same body hash. The preserved public-refusal metadata hash is `96c9992ef9f4a3223ef8ca5ea6f43fd622d2b9545ff180e1dd02635fa5e25cb0`; body SHA256 is `2938e9f1284180959e33ab1718d0793a72ff6e4cdb8108c34dcd14e69446de5c`.

The subsequent internal Kong checks isolate application/authentication behavior from that public-ingress refusal. No Cloudflare setting was changed. The public signed-in browser journey remains open; internal successes must not be represented as proving that journey.

## What remains

The current web panels still use their existing interfaces. Versioned read-path deployment does not implement the shared UI, stored history, periodic workers, exact unique-period totals, per-metric retention limits or reconciliation against independent same-capture Meta evidence. Instagram's protected credential binding remains absent for the selected account, and the complete G-X prerequisite remains required before its owner pilot. Seven scheduled due-date receipts, rollback and separately approved restoration are still pending.

The older #331 must not be merged over this canonical implementation. Its remaining unique Instagram daily-summary adoption and owner-inventory changes must be ported deliberately to the appropriate rebased Instagram work before that proposal is closed. Its branches/commits have been preserved; no unmerged work was deleted.
