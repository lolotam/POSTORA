# Instagram Story sharing and collaborator options through MCP/n8n

The owner clarified that publishing should offer an additional share-to-Story option, with collaborator support in MCP, rather than Android/USB device control. The [contract and implementation plan](../specs/2026-11-01-mcp-instagram-post-story.md) preserves the existing native publishing path.

## Cause and change

Both native Instagram publishers already read `metadata.instagram_share_to_story`. The public create API did not persist that field, and MCP did not advertise its boolean input. A caller could therefore request the existing mirror behavior without it reaching the publisher. Collaborators were already advertised and mapped to the native primary-collaborator field; that behavior is retained and now exercised together with the Story option.

MCP `create_post` now advertises the additional boolean. The create API validates it before media side effects, records a sanitized refusal for invalid types, and preserves explicit true/false without adding a key for legacy omitted input. URL-encoded, multipart and fallback form readers normalize valid boolean values; malformed values remain available for the same rejection. The existing publisher mirrors the first attached image/video, matching the web setting. Descriptions disclose that scope, and distinguish the Story from the post's caption/collaborator invitation.

The standalone node repository at `F:/Dev/Projects/N8N/Postora-n8n-community-node` adds Instagram Additional Options for **Also Share to Story** and **Collaborator**. It sends one ordinary create request, preserves its existing feed/reel choice, and keeps stale options out of standalone Story mode. The local package candidate is `1.9.2`; it has not been published. No vendored node copy was updated.

## Executed proof

- The registered MCP → actual create API → persistence boundary test failed against the original source: the schema omitted the option and true/false requests did not retain it. The fixture was first corrected to model Kong's public-prefix removal and the actual API's HTTP 201 response. The original-source run then failed ten meaningful steps; those failures remain in the local log.
- After the fix, the composition and existing native Story/recording/retry suites passed **36 tests / 26 nested steps**. The composition verifies tools discovery, collaborator list normalization, true/false/omitted metadata, every supported form transport, malformed-type refusal before post insertion, immediate creation's single publisher invocation, and preserved feed/Story URLs or warnings. Its database and publisher replies are controlled external boundaries, not a live publication.
- Existing MCP authorization/mode/scope/refusal and service-proxy regressions passed **150 tests**. Their existing suite uses the CI's `--no-check` mode; the new real composition test separately typechecks its production imports.
- The standalone node's two canonical test files passed **120 tests**; `tsc --noEmit` and the build passed. The mandated broad `npm test` also passed (231 tests), but includes two pre-existing `.kilo/worktrees/lacy-edge` copies; that larger count is not substituted for the canonical source proof. All old files were preserved.
- Source/test/docs guards checked the real consumers, first-media semantics, strict input validation, refusal logging, compatibility, collaborator scope and generated artifact boundaries. Immutable lint/i18n reported NO REGRESSIONS on backend candidate `7f3185c3944c597632d144371e8d5a07aeb14bf3` against main `781111a8c8b5bc1296f8c82bbe575f2498b82748`; historical lint/i18n debt remains. The code graph update completed.

Raw evidence remains in the main workspace's `.tmp/` directory under `mcp-story-*` and `n8n-story-*`. No token was read, no collaborator invited, no Story/post sent, and no npm release or production deployment performed.

## Deployment and remaining acceptance

The backend candidate changes `mcp/index.ts` and `n8n-api/index.ts` only, plus its test/CI/documentation. No SQL or analytics-collection activation is required for this option mapping. Deploy and verify that backend before releasing the companion node package; an older backend ignores the newly advertised request field. The package's tracked build artifacts, version and lockfile belong only to the standalone repository. A GitHub release/npm publication and real account/content publication are separate operations; the local proof above does not authorize or establish them.

The three-platform analytics release, full Instagram G-X, owned-account credential/calendar evidence and Facebook competitor history remain separate open work. This option change does not claim to complete those requirements.

Companion node review: https://github.com/lolotam/postora-n8n-community-node/pull/2, head `486d14a3970c39cc685b18c6dd6cab43594554ab`. The [artifact record](evidence/2026-11-01-instagram-automation-options.json) pins both source candidates and the local evidence. The public npm version was read back as `1.9.1`; the `1.9.2` candidate is not a published release.
