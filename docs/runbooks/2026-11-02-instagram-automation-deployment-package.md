# Instagram MCP/n8n automation deployment package

Status: **awaiting review and explicit deployment approval**. This package does not approve a merge, runtime write, npm release or live post. It is independent of the incomplete analytics G-X release.

## Frozen source and prerequisites

Backend source: `d6773d0c39354a138a691617ecd633a47d816586`, PR [#348](https://github.com/lolotam/POSTORA/pull/348). Later documentation commits do not change its runtime inputs. The [candidate manifest](../journeys/evidence/2026-11-01-instagram-automation-options.json) owns exact SHA256 values for these **four files**:

- `supabase/functions/mcp/index.ts`
- `supabase/functions/n8n-api/index.ts`
- `supabase/functions/n8n-api/requestBody.ts`
- `supabase/functions/process-post/index.ts`

Deploy the request-body dependency with the router. The package exposes the existing first-media Story mirror, preserves collaborator input across transports, prevents retry duplication of a known successful mirror and persists collaborator warnings. It adds no SQL, analytics eligibility or collection schedule. Omitted options retain existing behavior.

The [read-only prerequisite receipt](../journeys/evidence/2026-11-02-instagram-automation-production-prerequisites.json) was recorded at `2026-11-02T01:43:12.794316+00:00`. All four inspected runtime files matched main `781111a8c8b5bc1296f8c82bbe575f2498b82748` exactly. No server-only conflict was found in those files. Both `record_published_story` and `partner_settle_platform_post` existed with the expected argument names/types and `jsonb` result. Their definition fingerprints matched the isolated migrated database. Both are security definers; `service_role` has EXECUTE while `anon` and `authenticated` do not. This is structural prerequisite evidence, not a live publication.

The inspected deploy pause/failure markers were absent. Their absence does not independently prove that the Dokploy schedule is active; treat a main merge as potentially deploying automatically, as the [deployment runbook](deploy-edge-function.md#automatic-deploy-dokploy-schedule) specifies.

## Proposed operation sequence

1. Reconfirm the frozen runtime bytes, PR checks/review state and both production RPC signatures, privileges and fingerprints. Re-read the four runtime hashes immediately before any write. Changed hashes or prerequisites invalidate this receipt; stop and classify drift before deployment.
2. After explicit approval, preserve the exact inspected runtime bytes and hashes using the existing runbook. Choose the normal merge/reconciler path or the separately approved manual branch path; do not mix them. A manual branch deployment needs the runbook's reconciler pause and restoration procedure because an unpaused reconciler can overwrite it.
3. Copy/verify all four candidate files and restart/health-check using the runbook. Verify the ordinary public health endpoint and OPTIONS boot probes for `mcp`, `n8n-api` and `process-post`, then inspect sanitized startup/error logs. Read MCP tool discovery through the approved authenticated connection to confirm the optional Story boolean and collaborator fields. No post or invitation is required for these checks.
4. Release the companion node only after the backend is verified and its own merge/npm-release approval is given. The [node PR](https://github.com/lolotam/postora-n8n-community-node/pull/2) freezes `486d14a3970c39cc685b18c6dd6cab43594554ab`, package candidate `1.9.2`. The last recorded public version was `1.9.1`; recheck registry state before publishing. Follow the canonical standalone-node release workflow in `CLAUDE.md`; do not update or publish a vendored copy.
5. A real post/Story or collaborator invitation remains a separate, explicitly chosen account/content action. Local registered-route tests cover option transport, native receipts, retry recovery and public warnings; they do not establish live Meta acceptance.

## Stop and rollback

Stop on source drift, missing/changed prerequisites, a boot/health failure, lost warnings or duplicate known Story IDs. Restore the inspected four-file backup with verified hashes and the runbook's restart/health procedure. Account for automatic reconciliation: a manual restore cannot remain authoritative while main still contains the new candidate. Use a reviewed revert on main or the explicitly approved temporary reconciler-pause path; never reset or erase server-only work.

Rollback of code does not remove any already-published content. No automatic publish retry, content deletion, token change, analytics activation or npm unpublish belongs to this package. The [journey and proof record](../journeys/2026-11-01-instagram-automation-options.md) retain the executed local evidence and historical candidate attribution.
