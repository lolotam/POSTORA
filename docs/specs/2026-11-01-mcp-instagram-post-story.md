# Instagram post plus Story options in automation

The owner requested an additional share-to-Story option while publishing a post through MCP/n8n, with collaborator support. This extends the existing publisher behavior; it does not introduce Android/USB control, a second post-creation request or a different publishing queue.

## Contract

- `create_post` advertises optional boolean `instagram_share_to_story`. True mirrors the first attached image/video as a Story in addition to the ordinary feed post/reel, matching the web composer's existing setting. Omitted/false preserves ordinary publishing. Multi-media requests must disclose the first-media scope; this is not a promise to turn an entire carousel into multiple Stories.
- Existing `instagram_collaborators` remains discoverable and accepts the MCP list formats already supported. Only the first invited username is consumed by the native publisher. A collaborator applies to the feed post/reel, not its Story. Existing warning behavior remains visible if Meta rejects the invitation.
- The public create API validates and persists the boolean as top-level `metadata.instagram_share_to_story`, the key consumed by both native Instagram credential paths. Reject invalid JSON types before media side effects. Form bodies accept the corresponding boolean field. Keep legacy single Story selection and explicit multi-type input compatible.
- The standalone n8n node adds Instagram Additional Options for sharing to Story and the collaborator. They apply to feed/reel creation, and preserve saved workflows without these options. Do not copy node files into Postora's vendored directory.

## Implementation and proof

1. Reproduce MCP discovery/forwarding and create-API persistence through their actual registered routes, controlling only network/database boundaries. Demonstrate the absent mirror flag before fixing it. Verify collaborator normalization in the same request.
2. Extend the existing schema and create-API metadata mapping. Keep one post row and the existing worker, Story result recording and retry guards.
3. Extend the standalone node's Instagram options and execution body, preserving existing post type, caption, media and schedule. Test true/false/omitted options and the published-result response.
4. Run relevant MCP/API and native Story/retry regressions, node typecheck/tests/build, source/test/docs guards and immutable lint/i18n checks. Commit scoped files in their respective repositories and record reviewable PRs/artifacts.

No real post, collaborator invitation, npm release or production deployment is part of local verification. The existing native Story idempotency/result tests remain required. Live publication acceptance needs an explicitly chosen account/content and operation; do not manufacture a successful live publication from source or mocked transport proof.
