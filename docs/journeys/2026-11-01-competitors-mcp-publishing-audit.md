# Competitor analytics and MCP/n8n publishing: source audit

Scope: the owner's follow-up request to inspect Facebook/Instagram competitor analysis, MCP/n8n endpoint coverage and publishing the same content as a post and a Story. This is a source audit, not a claim that a live provider request or publication succeeded. The Android/USB wording and the exact publishing mode remain under clarification. No Android/USB action, provider request, paid collection, credential change or publication was performed.

## What already exists

- MCP `create_post` advertises Carousel creation using multiple media URLs or file IDs, and separate Instagram Story creation with `instagram_media_type: "stories"` (`supabase/functions/mcp/index.ts`). It forwards to the existing `POST /api/v1/post` route rather than implementing a second publisher.
- The publisher accepts `instagram_post_type` as either a string or an array. Both Instagram credential paths support explicit Story-plus-feed/reel selection; the additional `instagram_share_to_story` flag is a separate convenience path. The Facebook-login path avoids an extra share when `story` is already selected (`supabase/functions/process-post/index.ts`, `instagramStory.ts`). Existing Story idempotency/result tests must remain intact.
- `n8n-api` preserves an explicitly supplied `instagram_post_type` into top-level metadata. Consequently, an array such as `["feed", "story"]` can reach the publisher. MCP's current `passthrough` schema can forward that undeclared field, but does not advertise or validate it as a first-class property. An earlier preliminary finding that the missing share flag meant combined publication was entirely absent is superseded by this full path trace.
- Instagram has the durable `competitor-snapshot-sync`, `competitor-tracking-report`, retention and frontend competitor feature. That is distinct from the one-shot `brand-scrape` analysis route and does not establish accepted production collection or full G-X.

## Proven gaps

| Boundary | Source finding | Consequence / next proof |
|---|---|---|
| Facebook competitor history | `20261026130000_instagram_insight_tracking_schema.sql` constrains tracked competitors to `platform = 'instagram'`. The Facebook analytics page instead uses `brand-scrape`. | Facebook does not acquire equivalent durable competitor tracking merely by adding a tab. It needs a reviewed platform-specific collection/storage/report path and verified provider permissions/metrics. |
| Competitor API tools | MCP registration has owned `get_post_analytics` but no competitor-analysis/watchlist/report tools. | Connected automation cannot discover the competitor workflow through MCP. Adding it requires explicit owner scope, quotas, collection controls and failure semantics; reuse the existing owner RPC/report boundary rather than duplicating provider logic in MCP. |
| Combined Instagram post + Story discoverability | MCP advertises a single `instagram_media_type`; the separately supplied `instagram_post_type` array is not in its documented schema. | Make the supported combined mode discoverable and validated, preserving legacy single-value input and existing retry/idempotency behavior. A separate publication endpoint is not needed just to forward an existing setting. |
| API/publisher metadata parity | Create-post stores `instagram.shareToFeed`, `instagram.locationId`, `instagram.altText` and `instagram.audioName` as nested metadata, while the native publisher reads `instagram_share_to_feed`, `instagram_location_id`, `instagram_alt_text` and `instagram_audio_name`. Only selected fields, such as the first comment and primary collaborator, are explicitly mirrored at creation. | Source-proven mapping mismatch. An actual create-post → persisted metadata → publisher test must establish each affected option before a fix is accepted. In particular, a requested `share_to_feed: false` must not silently become the publisher's default true. This audit did not publish to demonstrate it. |
| Share-to-Story flag | The publisher consumes `instagram_share_to_story`; create-post does not persist this field and MCP does not advertise it. | A client sending this convenience flag alone does not get the same contract as the web composer. Reuse the existing setting only after the requested combined-mode contract is clarified. |
| Legacy competitor reads | `brand-scrape` uses direct provider fetches and maps several unavailable public counts with `|| 0`. It is not the canonical saved analytics contract. | Establish bounded calls, validated response shapes, explicit availability/source/freshness and pagination behavior. Do not describe absent public competitor metrics as verified zeros or as owned-account insights. |
| Facebook provider capability | The legacy Facebook branch uses an app access token against public Page/posts at Graph `v22.0`. Reading the configured Apify actor setting does not prove that branch uses it. | A Page name and app credentials are not live evidence of public-content access for arbitrary competitors. Verify current allowed access/version/metrics before promising coverage or selecting a different provider. |

## Standalone n8n package

The Git-connected package was found at `F:/Dev/Projects/N8N/Postora-n8n-community-node`, remote `https://github.com/lolotam/postora-n8n-community-node.git`, package version `1.9.1`. This is newer than the versions/paths recorded in the local agent documents. Its create-post `postType` is a single `options` selection, retrieved as a string and forwarded to `instagram_post_type`; it does not offer the publisher's multi-selection shape. These observations concern the local checkout, not a verified installed or published npm version.

The standalone checkout has pre-existing untracked files; none were modified. A tracked `n8n-community-node/` also exists in Postora despite the migration notice. The owner's instruction forbids recreating/syncing the vendored copy and supersedes the stale sibling-copy text in the node checkout's AGENTS.md. Do not delete either checkout, copy changes twice or publish from the vendored directory. Any later node implementation/release belongs to the standalone repository, with its own tests and explicit release scope.

## Recommended next work

1. Finish the analytics stack's current CI correction and prerequisite SQL deployment decision before dependent runtime merges. Preserve the completed saved-report work and its exact evidence.
2. Confirm whether the request concerns MCP/n8n/SDK coverage or an actual Android device, and whether the desired publishing UI is combined Post + Story. Do not infer USB operations from transcription.
3. Implement and test a single supported Instagram option contract through web/API/MCP/n8n and the real publisher boundary, preserving separate outcomes and retry safety for post/Story. Do not send a real publication as a test without its explicit account/content approval.
4. Specify Facebook competitor capability/history and common competitor tool exposure from the existing Instagram feature. Keep owned analytics and public-competitor metrics distinct, with explicit unavailable values.
5. Any paid Apify access/activation remains the owner's deferred decision. The request for stronger analysis does not itself choose a paid fallback or widen collection eligibility.

Remaining acceptance is explicit: no live competitor reconciliation, complete canonical G-X, deployed combined-mode proof, npm release or Android/USB integration was demonstrated by this audit.
