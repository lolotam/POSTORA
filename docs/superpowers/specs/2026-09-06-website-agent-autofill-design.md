# Website URL to business and agent setup

Status: proposed design; runtime credential repair completed, autofill not implemented.

## Proven behavior and production repair

On 2026-09-06, testing the live WhatsApp Knowledge > Website scraping flow with
https://xsellpoint.com created source 9f6e1782-758c-431e-aadb-b56a03f32227.
The UI displayed "Page indexed" while the source was pending; the source then
failed with `JINA_API_KEY is not configured`. Both Edge Functions and the standalone
knowledge worker lacked the key. The saved disk environment and compose also
lacked Jina configuration.

The supplied credential was installed in the server environment and Dokploy's
saved environment, and the functions service now explicitly forwards
`JINA_API_KEY`. Both disk and saved compose were updated. Only functions and
ai-knowledge-excel-worker were recreated. Both are running with the key present.
The exact failed source was requeued and reached ready with 31 chunks, verified
in PostgreSQL and the existing Codex browser. The original 31-chunk source remains.
No credential values belong in this document or Git.

Business profile fields remained blank after indexing completed. The current
AiKnowledgeManager invokes ingest_website and does not apply profile or behavior
values. The backend scrapes, chunks, and indexes; it has no structured business
and behavior extraction step. This is a missing capability, separate from the
credential incident.

## Alternatives

1. Extend the existing website importer to produce a reviewed setup draft
   (recommended). Reuses crawling, indexing, ownership and existing settings.
2. Add a separate setup wizard. Offers a dedicated flow but duplicates ingestion
   orchestration and progress/error handling.
3. Immediately overwrite saved settings after scraping. Fewer clicks, but can
   overwrite edits and treat uncertain website content as an operational rule.

## Recommended user flow

The website panel offers a "Generate business and agent setup" option, enabled
by default for this flow. After the crawl, show a generated draft containing
business type, products/services, policies, FAQs, notes, greeting, tone, reply
length, objectives and relevant instruction blocks. Business facts include their
source URLs. Missing facts say "Not found on website" and do not create values.
Behavior choices are clearly marked as suggestions rather than extracted facts.

The user reviews the filled draft and applies it to the selected account through
the existing validated save paths. Existing nonempty values are preserved by
default; replacements require an explicit field choice. Do not enable the agent,
change its permissions, admin phone numbers, handoff rules, tools, engagement
mode or message limits based on website content.

When no connected account is selected, permit knowledge-only indexing and explain
that an account must be selected to apply generated agent settings. Generated
settings never propagate merely because a knowledge source is shared with other
accounts. Switching accounts or editing during extraction cannot redirect or
overwrite the pending result.

## Architecture and data flow

Reuse WebsitePanel, AiKnowledgeManager, the existing ai-knowledge-ingest and
standalone worker, BusinessProfile/AgentBehavior validators, and configured AI
provider routing. Do not create a second crawler or embedding pipeline.

Persist an optional extraction job on the source with its owner, target account,
bounded input, status, version and validated output. Use an additive migration
before dependent runtime code. The worker claims and resumes extraction; a browser
timeout or navigation does not lose the job. Indexing and extraction statuses are
separate: one can succeed while the other fails, and each has a targeted retry.
Repeated completion must not duplicate sources or apply settings twice.

The backend structurally checks source ownership and target account ownership on
every job read, creation and application. Service-role execution is not a tenancy
check. Crawl text is untrusted data, never instructions. Constrain extraction to
the existing profile and behavior schema, validate output and enforce length,
page and token bounds. Preserve source attribution. Partial crawls explicitly
show coverage; do not claim that a single homepage describes the whole business.

Pure draft validation/merge decisions belong outside React. Infrastructure owns
provider calls with explicit timeout and bounded retries. UI owns review state;
the existing backend config contract remains authoritative for saved values.

## Error and progress behavior

Change the single-page success message to distinguish an accepted queued request
from completed indexing. Only show "Page indexed" when the response confirms
completion. Show crawling, indexing and draft-generation progress independently,
with recoverable failure and a retry control. Never treat a failed configuration
read as an empty profile and never silently overwrite a user-edited draft.

## Implementation sequence and acceptance

1. Correct queued-versus-complete feedback with a regression test.
2. Add versioned extraction job storage and owner/account authorization tests;
   deploy the migration first.
3. Implement bounded extraction in the existing durable worker and validators.
4. Wire generated draft review into existing profile/settings saves.
5. Test missing facts, malformed model output, prompt injection text, partial
   crawl, account switching, concurrent edits, cross-tenant denial, retries and
   idempotent completion. Run relevant tests, lint, type/build checks and guards.
6. Commit scoped changes, deploy changed Edge Functions with hash verification
   and runtime restart, deploy frontend, and test live through Codex browser.

Live acceptance: a public business URL reaches ready, produces an attributed
draft, fills the supported business and behavior fields, preserves existing data
by default, and persists only the reviewed changes to the selected account.
Unknown policies stay unknown. Agent activation and access settings are unchanged.

## Current release status

The production credential repair is deployed and verified. The false completion
toast and automatic setup generation remain pending this design's approval and
implementation. The retried test source is retained for inspection; it duplicates
the existing website source and is not described as cleaned up.
