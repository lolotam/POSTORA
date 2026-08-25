# ARCHITECTURE.md — POSTORA Architecture Rules

This file defines the mandatory **architectural** rules for AI coding agents and human contributors working in POSTORA.

These rules are intentionally specific to the current POSTORA stack:

- React 18
- TypeScript
- Vite
- Tailwind + shadcn/Radix
- TanStack Query
- Zustand / React Context
- self-hosted Supabase
- PostgreSQL + RLS
- Supabase Auth
- Deno Edge Functions
- Cloudinary
- Docker + nginx + Dokploy

The goal is **incremental Clean Architecture**, not a full rewrite.

---

# 0. How This File Relates to the Other Agent Docs

POSTORA keeps four agent documents, each with one responsibility. Do not duplicate content between them — a fact must have exactly one home.

| File | Owns | Auto-loaded by |
|---|---|---|
| `CLAUDE.md` | **Task Execution Workflow (authoritative)**, project facts, DB schema, MCP routing, deploy rules | Claude Code |
| `AGENTS.md` | The same project context, mirrored for Codex | Codex |
| `ARCHITECTURE.md` (this file) | Architecture, layering, dependency direction, security shape | nothing — must be read deliberately |
| `PROJECT_AGENT.md` | Known hotspots, stop conditions, decision hierarchy, completion summary | nothing |

Supporting evidence for every rule here lives in `POSTORA_CLEAN_ARCHITECTURE_AUDIT.md`.

## Precedence

**On any conflict, `CLAUDE.md`'s Task Execution Workflow wins.**

This file governs *where code goes and what it may depend on*. It does **not** govern the task lifecycle. The mandatory lifecycle — mem0 recall, brainstorming, evidence-backed root cause, guard skills, edge-function redeployment, mem0 save, final report — is defined in `CLAUDE.md` and is not restated here.

## Verification status of the claims in this file

Every repository fact asserted below was verified against the working tree on **2026-08-22**. If you find one to be false, fix it in the same change rather than working around it. Stale architectural documentation is itself a documented failure mode in this repository (see §41).

---

# 1. Prime Directive

Before modifying code:

1. inspect the existing implementation,
2. trace the full request/data path,
3. identify the business rule being changed,
4. identify all consumers,
5. inspect existing tests,
6. determine whether the change belongs to domain, application, infrastructure, or UI,
7. make the smallest coherent change,
8. preserve backward compatibility unless the task explicitly changes it.

Never assume a file is the only implementation of a behavior.

Never fix a cross-cutting bug only in the visible UI when the underlying business rule lives elsewhere.

## Definition of Done — Zero Dead Modules

**No new helper, utility, or infrastructure container is considered complete or
merged without at least one active, production (non-test) consumer wired to it
in the same change.**

A passing test suite is not evidence that a module is reachable. Tests are
consumers too, and a module whose only callers are its own tests looks healthy
in CI, in review, and in coverage while doing nothing at runtime.

This rule was added on 2026-08-24 after `src/lib/cdn.ts` was found in exactly
that state: a complete, tested image-transform layer — `getCdnThumbnail`,
`getCdnSrcSet`, `getCdnPlaceholder` — that no component ever imported, while
the media library shipped full-size originals into thumbnail cells. An
`imgproxy` container in the Supabase stack sat unused for the same reason. The
optimization had been written, reviewed, and merged; only the wiring was
missing, and nothing in the process looked for it.

Checking this means naming the call site, not finding the string. A grep for the
export's name also matches declarations, comments, re-exports, and — the trap
`cdn.ts` actually fell into — type-only imports: `useCdnConfig.ts` imported
`CdnConfig` and `CdnProvider` from it, so the module looked referenced while
every function in it was unreachable. Point at a non-test file that *calls* the
new code, or run an AST/call-graph check. If you cannot name that line, the
change is not done.

---

# 2. Architecture Strategy

POSTORA is migrating incrementally from technical-folder organization toward feature-oriented architecture.

> **Status check (verified 2026-08-25): `src/features/` now exists.** It was created by the WhatsApp inbox overhaul, which is the "first substantial new feature" this note anticipated. Two modules live there today — `src/features/whatsapp-inbox/` and `src/features/webhook-observability/`. Everything else in this section and §3 still describes a *target*: most of the tree remains organised by technical folder, so do not assume a `src/features/<x>/` module exists merely because this file names it — check.
>
> `src/features/whatsapp-inbox/` is the worked example of the layering in §4: `ui → application → domain`, with `application/ports.ts` declaring the interfaces and `infrastructure/` implementing them. Its composition root is `ui/WhatsAppInboxScreen.tsx`, the only file in that feature permitted to import `infrastructure/`, and that rule is enforced by an eslint `no-restricted-imports` rule plus `tests/architecture.test.ts` rather than left to review.

Existing legacy folders remain valid:

```text
src/pages
src/components
src/hooks
src/contexts
src/lib
src/services
src/stores
```

Do not mass-move them merely for architectural purity.

For substantial new business functionality, prefer:

```text
src/features/<feature>/
```

Current preferred feature names include:

```text
publishing
scheduling
social-accounts
media
messaging
analytics
billing
subscriptions
ai-generation
admin
auth
automation
integrations
```

---

# 3. Required Feature Structure

Use only as much layering as the feature needs. Remember that no feature currently uses this layout (§2) — you are establishing the pattern, not following an existing one.

Preferred structure:

```text
src/features/<feature>/
├── domain/
├── application/
├── infrastructure/
├── ui/
├── tests/
└── index.ts
```

Small features may collapse folders, but dependency direction must remain the same.

## domain

Contains:

- business entities
- value objects
- business policies
- validation rules that do not require I/O
- pure transformations
- domain errors
- provider-neutral contracts

Domain code must be framework-independent.

## application

Contains:

- use cases
- commands
- queries
- orchestration
- application services
- ports/interfaces required from infrastructure

Application code coordinates behavior but must not contain React UI.

## infrastructure

Contains adapters for:

- Supabase
- PostgreSQL RPC
- Storage
- Cloudinary
- Stripe
- Resend
- social platform APIs
- AI providers
- external HTTP services

## ui

Contains:

- pages
- React components
- feature hooks
- view models
- form state
- presentation adapters

---

# 4. Mandatory Dependency Direction

Allowed:

```text
ui -> application
ui -> domain
application -> domain
infrastructure -> application ports
infrastructure -> domain
composition root -> ui/application/infrastructure
```

Forbidden:

```text
domain -> React
domain -> react-router
domain -> Supabase
domain -> Cloudinary
domain -> Stripe
domain -> browser APIs
domain -> UI libraries

application -> React components
application -> shadcn/Radix components
application -> pages
application -> direct Supabase client
application -> provider SDKs

infrastructure -> UI
infrastructure -> pages

feature A -> feature B internal files
```

A feature may import another feature only through that feature's public API:

```text
src/features/<feature>/index.ts
```

Do not deep-import another feature's internals.

## Enforcement status

**These rules are review-enforced only today.** The repository has no `eslint-plugin-boundaries`, no `dependency-cruiser`, and no import-layer lint rule — nothing mechanically blocks a forbidden import. Audit item P6 proposes adding that gate.

Until it exists, a reviewer (human or agent) must check dependency direction by hand on every change that touches `src/**` or `supabase/functions/**`.

---

# 5. Screaming Architecture Rule

New top-level business code must communicate product intent.

Prefer:

```text
features/publishing
features/messaging
features/analytics
features/billing
features/media
```

Avoid creating new generic dumping grounds such as:

```text
helpers2/
misc/
commonBusiness/
newServices/
utils2/
managers/
processors/
```

`shared` code is allowed only when it is truly business-neutral and used by multiple features.

Do not move feature-specific logic into `shared` merely to avoid an import.

---

# 6. Common Closure Principle

Things that change for the same business reason should live together.

When adding a feature, keep its:

- contracts
- use cases
- queries
- UI
- adapters
- tests

as close to the feature as practical.

Do not scatter a new feature across `pages`, `hooks`, `lib`, `services`, and `components` unless integration with legacy structure requires it.

If legacy integration is required, expose one feature API and keep the new internal implementation cohesive.

---

# 7. Acyclic Dependencies

Never introduce circular dependencies between:

- features
- hooks
- components
- contexts
- domain modules
- Edge Function shared modules

If A needs B and B needs A, stop and redesign.

Break the cycle using one of:

- a domain contract,
- an application port,
- an event,
- callback injection,
- a shared neutral contract,
- moving ownership to the correct feature.

Do not use dynamic imports merely to hide an architectural cycle.

---

# 8. React Page Rules

Pages are composition boundaries.

A page may:

- read route parameters,
- compose feature components,
- invoke feature hooks/controllers,
- render loading/error/empty states,
- translate user actions into application commands.

A page should not:

- construct Supabase queries,
- contain provider API logic,
- contain large platform-specific business rules,
- perform token handling,
- implement data persistence,
- duplicate validation policies,
- become the canonical definition of a business rule.

If a page becomes large because of workflow orchestration, extract an application controller/use case.

---

# 9. React Component Rules

Components should primarily render UI.

Never import a visual component from domain/application code to reuse a helper.

Example of a forbidden dependency:

```text
application hook -> VideoPreview component -> file-size rule
```

Instead:

```text
media-policy.ts
    ↑           ↑
application   VideoPreview
```

Business/media/platform rules belong in pure modules, not presentation components.

---

# 10. Hook Rules

A hook may manage:

- React lifecycle,
- feature-specific UI state,
- query integration,
- subscriptions,
- controller binding.

A hook must not become a hidden service layer containing unrelated:

- persistence,
- provider integrations,
- business policies,
- storage rules,
- routing rules,
- media policies,
- account policies,
- publishing orchestration.

If a hook performs several of those concerns, split it into:

```text
pure domain policy
application use case/controller
infrastructure adapter
thin React hook
```

---

# 11. Supabase Frontend Rules

RLS remains the security boundary for browser-accessible data.

However, architectural access must be controlled.

## Never

Do not add new raw Supabase queries directly inside:

```text
pages
visual components
generic UI components
```

## Prefer

Create feature-owned adapters/query modules:

```text
features/publishing/infrastructure/supabase-post-repository.ts
features/social-accounts/infrastructure/supabase-social-account-repository.ts
```

React Query hooks may wrap those adapters.

## Security

Never rely on client-side role checks for authorization.

Frontend role checks are UX only.

Database RLS / secure RPC / authenticated Edge Functions must enforce permissions.

---

# 12. Edge Function Prime Rule

An Edge Function entrypoint is an **adapter**, not the business layer.

Target shape:

```text
HTTP request
  ↓
CORS
  ↓
authentication
  ↓
schema validation
  ↓
construct dependencies
  ↓
invoke application use case
  ↓
map response
  ↓
sanitized error
```

`index.ts` should become boring.

---

# 13. Never Do These in a New Edge Function

Never add a new Edge Function that:

- trusts `user_id` from the request body for a normal user call,
- exposes `SUPABASE_SERVICE_ROLE_KEY`,
- returns raw database errors to clients,
- returns raw third-party credentials or tokens,
- logs access tokens, refresh tokens, API keys, cookies, authorization headers, secrets, OTPs, or webhook secrets,
- performs unrelated business workflows in one handler,
- duplicates platform contracts already defined elsewhere,
- embeds thousands of lines of provider-specific logic in `index.ts`,
- creates its own ad-hoc auth convention when `_shared/auth-helper.ts` applies,
- creates its own ad-hoc error exposure convention when `_shared/errorSanitizer.ts` applies,
- uses unlimited polling or retry loops,
- performs network calls without explicit timeout/retry policy,
- writes to another user's rows using service role without verified ownership,
- assumes CORS `*` is appropriate for a new authenticated endpoint,
- swallows provider errors without logging a sanitized operational event,
- depends on frontend files.

---

# 14. Edge Function Authentication

For authenticated user endpoints:

1. derive identity from the Authorization header,
2. use the shared authentication helper or the current approved equivalent,
3. treat body `user_id` as untrusted,
4. compare resource ownership against the authenticated identity,
5. use service role only when server privilege is genuinely required.

Service-role internal calls may pass a user identifier only after the caller itself is authenticated as service-role.

Never downgrade this rule for convenience.

---

# 15. Edge Function Validation

Every externally callable function must validate its input at the boundary.

Prefer Zod.

Pattern:

```ts
const RequestSchema = z.object({
  ...
});

const input = RequestSchema.parse(body);
```

Validation belongs before business execution.

Do not spread repeated manual `typeof` / missing-field checks throughout provider logic when a schema can define the contract once.

---

# 16. Edge Function Error Handling

Internal logs may contain technical context after sensitive-data redaction.

Client responses must not expose:

- SQL fragments,
- table names unnecessarily,
- RLS policy details,
- stack traces,
- environment variables,
- access tokens,
- provider secrets,
- internal hostnames,
- service-role information.

Use the shared error sanitizer for unexpected failures.

Expected business failures should use typed/domain errors mapped to stable response codes.

---

# 17. Logging Rules

Use centralized logging/redaction.

Never log raw:

```text
access_token
refresh_token
Authorization
apikey
api_key
password
secret
webhook_secret
cookie
OTP
service role
private key
```

When metadata is useful, send it through the existing sensitive-data redactor.

Prefer stable structured fields:

```text
event
user_id
account_id
platform
operation
error_code
duration_ms
attempt
```

Do not use logs as a shadow database.

---

# 18. Social Platform Adapter Rule

Each social provider should behave as an implementation of a common publishing capability.

Target concept:

```ts
interface PlatformPublisher {
  publish(input: PublishInput): Promise<PublishResult>;
}
```

Provider-specific implementations:

```text
FacebookPublisher
InstagramPublisher
ThreadsPublisher
TikTokPublisher
YouTubePublisher
PinterestPublisher
LinkedInPublisher
TwitterPublisher
RedditPublisher
BlueskyPublisher
WhatsAppPublisher
```

The publishing use case chooses a publisher through a registry/factory.

Do not add another giant `if/else` or `switch` containing full provider implementations.

A switch that selects an adapter is acceptable.

A switch that implements each provider is not.

---

# 19. Open/Closed Principle for Platforms

Adding a new social platform should primarily require:

1. a new provider adapter,
2. a new provider contract/schema extension,
3. registration in the publisher registry,
4. provider-specific UI settings,
5. tests.

It should not require invasive edits to every existing provider.

Stable shared publishing logic should remain closed to provider-specific modification wherever practical.

---

# 20. Liskov Substitution for Provider Capabilities

Do not force every platform adapter to implement unsupported behavior.

Bad:

```ts
interface SocialPlatform {
  publish(): ...
  uploadThumbnail(): ...
  createFirstComment(): ...
  createPoll(): ...
  publishStory(): ...
}
```

Many platforms cannot honor that contract.

Prefer capability interfaces:

```ts
interface Publisher {}
interface SupportsFirstComment {}
interface SupportsPoll {}
interface SupportsThumbnail {}
interface SupportsStories {}
```

Code must query/use the capability rather than calling no-op or throwing “unsupported” from a fake universal interface.

---

# 21. Interface Segregation

Avoid giant contracts that contain settings for every platform.

Do not pass an object containing all Facebook, TikTok, YouTube, LinkedIn, Pinterest, Reddit, Threads, and X settings into code that only needs one provider.

Prefer:

```text
CommonPublishInput
+
FacebookPublishOptions
```

or:

```text
CommonPublishInput
+
TikTokPublishOptions
```

Provider code should depend only on the fields it actually uses.

---

# 22. Canonical Contract Rule

A business contract must have one authoritative definition.

Do not maintain duplicate copies of:

- PlatformMetadata
- post status enums
- platform names
- quota types
- publishing result shapes
- webhook payload shapes
- role enums

Prefer a runtime schema plus inferred TypeScript type.

Example:

```ts
export const PlatformMetadataSchema = z.object({...});
export type PlatformMetadata = z.infer<typeof PlatformMetadataSchema>;
```

When cross-runtime sharing is not practical, generate or explicitly version mirrored contracts and test compatibility.

## Known live violation — `PlatformMetadata`

`PlatformMetadata` is currently defined **three** separate times (verified 2026-08-22):

```text
supabase/functions/process-post/index.ts          interface PlatformMetadata
supabase/functions/n8n-api/index.ts               interface PlatformMetadata
supabase/functions/_shared/platforms/types.ts     export interface PlatformMetadata
```

Find them with `grep -rn "interface PlatformMetadata" supabase/functions`. Line numbers are deliberately omitted — they drift between branches and shift on any edit above them.

Three copies means a field added to one publishing path can silently fail to exist on another. When you add or change a platform metadata field, you must check all three until they are consolidated behind one schema (audit item P3).

Do not add a fourth copy.

---

# 23. Database & Migration Rules

Never edit an already-applied production migration to change behavior.

Create a new migration.

For every new table:

- enable RLS,
- define explicit policies,
- verify normal-user access,
- verify cross-user denial,
- verify admin/service access where required,
- index foreign keys and frequent filters where appropriate,
- add timestamps where operationally useful.

For `SECURITY DEFINER` functions:

- use a controlled `search_path`,
- avoid dynamic SQL unless necessary,
- validate caller/resource scope,
- keep privileges minimal.

Schema changes must be reflected in generated/maintained TypeScript database types.

---

# 24. Service Role Rules

The Supabase service-role key is backend-only.

Never:

- send it to the browser,
- place it in Vite-exposed variables,
- serialize it into API responses,
- log it,
- include it in client bundles,
- store it in database rows,
- use it merely to bypass an RLS bug.

If RLS blocks legitimate user behavior, fix the policy or use a narrowly authorized backend operation.

---

# 25. CORS Rules

Do not copy `Access-Control-Allow-Origin: *` into new authenticated functions by default.

Use the shared CORS policy.

Wildcard CORS is acceptable only for endpoints intentionally designed to be public and whose security model has been reviewed.

CORS is not authorization.

---

# 26. External HTTP Rules

All provider/API calls must have:

- explicit timeout,
- bounded retry policy where safe,
- response validation,
- sanitized logging,
- stable error mapping.

Retries must consider idempotency.

Never blindly retry a publish/payment/send action that can duplicate side effects.

Use idempotency keys or provider operation IDs where supported.

---

# 27. Background Work Rules

Use `EdgeRuntime.waitUntil` only for bounded background work that can safely complete after the response.

Do not treat Edge Functions as durable queues.

Long-running or retry-critical workflows must persist state so they can resume/reconcile after process termination.

Every background process must be idempotent or safely deduplicated.

---

# 28. Scheduling Rules

Scheduled publishing must treat the database as source of truth.

Do not rely on browser timers.

When processing scheduled work:

1. atomically claim eligible work where possible,
2. prevent duplicate execution,
3. record attempt state,
4. use stable idempotency semantics,
5. persist provider result IDs,
6. distinguish retryable from permanent failure.

---

# 29. State Management Rules

Use local component state for local UI state.

Use React Query for server state.

Use Zustand/Context only for state that genuinely spans multiple distant components or routes.

Do not add a global Context because prop passing is mildly inconvenient.

Feature-specific state should live within the feature boundary.

---

# 30. Root Provider Rule

`App.tsx` should contain only truly application-wide providers where practical.

Good root-level concerns:

- auth
- query client
- router
- theme
- global error boundary

Feature-only providers should move toward feature routes/boundaries when touched.

Do not add another root provider without documenting why its state must be global.

---

# 31. TypeScript Rules

Existing legacy code is not fully strict.

New code must be stricter than the legacy baseline.

For all new feature modules:

- no implicit `any`,
- avoid explicit `any`,
- no unchecked casts unless justified,
- use discriminated unions for state machines,
- prefer `unknown` over `any` at untrusted boundaries,
- validate untrusted runtime input,
- exhaustively handle platform/status unions where practical.

`any` is allowed only at a documented external/infrastructure seam when upstream types are unavailable or incompatible.

Do not propagate that `any` into domain/application code.

## Enforcement status

The compiler does **not** enforce any of the above today. Verified 2026-08-22:

```text
tsconfig.json       noImplicitAny: false   strictNullChecks: false
                    noUnusedLocals: false  noUnusedParameters: false
tsconfig.app.json   strict: false          noImplicitAny: false
                    noUnusedLocals: false  noUnusedParameters: false
```

`eslint.config.js` likewise relaxes unused-variable enforcement.

So "new code must be stricter than the legacy baseline" is a **convention you uphold manually**, not something `npm run lint` or `npm run build` will catch. Do not flip `strict: true` repository-wide to fix this — audit item P5 calls for a strict tsconfig scoped to `src/features/**` so new modules opt in without breaking legacy code.

This also means the README's claim of "TypeScript strict mode" is currently inaccurate.

---

# 32. Error Type Rules

Do not throw arbitrary strings.

Prefer typed errors for expected cases:

```text
UnauthorizedError
QuotaExceededError
PlatformNotConnectedError
MediaValidationError
ProviderRateLimitedError
TokenExpiredError
UnsupportedCapabilityError
```

Infrastructure errors should be translated before they reach domain/UI.

The UI should not parse provider error-message text to determine behavior.

---

# 33. Testing Rules

A change is not complete until the relevant behavior is tested.

Prefer the test pyramid:

## Domain

Fast pure unit tests.

Test:

- platform eligibility
- media rules
- scheduling rules
- quotas
- status transitions
- provider capability selection

## Application

Test use cases with fake ports/repositories.

## Infrastructure

Test adapters against mocked provider responses or test services.

## UI

Test user-visible behavior with Testing Library.

## E2E

Use Playwright for critical flows:

- authentication
- social connection
- post creation
- scheduling
- publishing status
- billing-critical flows
- admin-critical flows

Bug fixes should include a regression test whenever feasible.

---

# 34. Testability Rule

If a business rule cannot be tested without rendering React or connecting to Supabase, the rule is probably in the wrong layer.

Move pure decision logic into domain/application modules.

---

# 35. No Cosmetic Refactors During Bug Fixes

Do not combine a production bug fix with:

- broad renaming,
- formatting the whole repository,
- moving unrelated folders,
- replacing libraries,
- mass architecture migration.

Make the bug fix reviewable.

Create separate architectural changes unless the refactor is necessary to fix the bug safely.

---

# 36. Backward Compatibility

Before changing:

- API payloads,
- database columns,
- webhook schemas,
- stored metadata,
- OAuth callback state,
- public n8n/Make API behavior,

search for all producers and consumers.

Prefer additive migrations and compatibility parsing during transition.

Do not silently rename stored metadata fields.

---

# 37. Security Rules for OAuth / Tokens

OAuth token logic is infrastructure code.

Never expose tokens to components except where technically unavoidable and already security-reviewed.

Refresh logic must:

- preserve existing refresh tokens when providers omit a new one,
- update expiry atomically where practical,
- mark reauth state consistently,
- never log raw tokens,
- avoid concurrent refresh races.

Provider OAuth code should be isolated per provider.

---

# 38. Quota & Billing Rules

Quota and subscription enforcement must not rely solely on disabled buttons or hidden UI.

Enforce financially meaningful or abuse-sensitive limits server-side.

Frontend checks are for fast UX.

Backend/database rules are authoritative.

---

# 39. Admin Authorization

`isAdmin` in React is not authorization.

All admin mutations and protected reads must be enforced by:

- RLS,
- secure RPC,
- authenticated Edge Function checks,

using the existing role model.

Never add an admin-only operation protected only by a route guard.

---

# 40. Shared Code Rule

A module belongs in shared code only if:

1. at least two features genuinely use it,
2. it contains no feature-specific policy,
3. its name describes a stable technical capability.

Good shared examples:

```text
HTTP timeout
error sanitization
auth extraction
sensitive-data redaction
generic result/error primitives
```

Bad shared examples:

```text
publishingRules
youtubeSettings
billingQuotaLogic
instagramPostBuilder
```

Those belong to their feature/provider.

---

# 41. `process-post` Specific Rules

`supabase/functions/process-post/index.ts` is legacy-critical code.

**It is ~7,200 lines long** (verified 2026-08-22) and coordinates HTTP entry, CORS, validation, post retrieval, account resolution, media handling, webhook notification, background polling, result aggregation, and the full publishing implementation for Facebook, Instagram, LinkedIn, Pinterest, Reddit, Threads, TikTok, Twitter/X, YouTube and Bluesky.

**It already imports from `../_shared`.** Any comment in that file claiming Edge Functions cannot import across files is false and must be corrected, not propagated. Never copy an architectural comment forward without verifying it still matches the current runtime.

When modifying it:

- do not add another large provider implementation directly into the entrypoint,
- extract new provider logic,
- prefer shrinking the file,
- do not duplicate `PlatformMetadata`,
- reuse shared auth/validation/timeout/error/logging utilities,
- preserve provider-specific idempotency behavior,
- preserve scheduling and result persistence semantics,
- add regression tests for changed provider behavior.

Any significant new platform should use an adapter outside the main handler.

---

# 42. Publishing Metadata Rule

Platform metadata must move toward one canonical validated contract.

When adding a field:

1. add it to the canonical schema/type,
2. update UI form/state,
3. update serialization,
4. update Edge Function parsing,
5. update only the provider adapter that needs it,
6. add tests,
7. preserve older stored posts that omit it.

Never add the same field independently to multiple duplicate interfaces.

---

# 43. Naming Rules

Use names based on business behavior.

Prefer:

```text
PublishPost
SchedulePost
RefreshSocialAccountToken
ResolvePublishingTargets
CheckPublishingQuota
CreateMediaAsset
```

Avoid vague names:

```text
Manager
Helper
Processor
Utils
Handler2
ServiceNew
CommonLogic
```

“Service” is acceptable only when its responsibility is clear from the full name.

---

# 44. Comments & Documentation

Comments must explain:

- why,
- constraints,
- provider quirks,
- non-obvious security decisions,
- compatibility requirements.

Do not write comments that merely restate code.

If an architectural comment becomes false, update or remove it in the same change.

Never preserve stale comments because “they were already there.”

---

# 45. Agent Workflow for Every Task

> **This section is architectural only and is NOT the full task lifecycle.**
> `CLAUDE.md`'s Task Execution Workflow is authoritative and takes precedence: mem0 recall → brainstorming → evidence-backed root cause → guard skills (`clean-code-guard` / `test-guard` / `docs-guard`) → scoped commit → **edge-function redeployment** → mem0 save → final report.
> Treat the checklists below as the architecture-specific additions to that lifecycle, never as a replacement for it.

Before implementation, report internally or in the work summary:

```text
1. Business capability affected
2. Current implementation path
3. Root cause / required behavior
4. Layer where the change belongs
5. Files expected to change
6. Security/RLS impact
7. Backward-compatibility impact
8. Tests to add/update
```

During implementation:

```text
1. preserve existing contracts unless intentionally changed
2. keep dependency direction
3. use existing shared security helpers
4. avoid unrelated refactors
5. add/update tests
```

Before completion:

```text
1. run lint
2. run relevant unit tests
3. run build/type checks
4. run targeted E2E when relevant
5. inspect diff for secrets
6. inspect diff for accidental broad changes
7. verify no new dependency cycle
8. verify authorization is server-side
9. verify errors are sanitized
10. document migration/operational steps
11. IF any file under supabase/functions/** changed, REDEPLOY it
```

## Step 11 is not optional

Editing a file under `supabase/functions/**` in this repository changes **nothing in production**. The self-hosted stack serves Edge Functions from a Docker volume that drifts from the repo; a merged commit does not reach it.

That is why the checklist has an eleventh step at all: in most repositories "merged" implies "deployed", and here it does not.

**The deployment procedure itself is not documented here** — it lives in `CLAUDE.md` (Task Execution Workflow → Deployment) and `docs/runbooks/deploy-edge-function.md`. Follow it there.

A backend change that passes lint, tests and review but was never redeployed is **not done**.

---

# 46. Definition of Done

A task is complete only when:

- business behavior is correct,
- the root cause is addressed,
- authorization remains correct,
- RLS implications are considered,
- no secret is exposed,
- external calls are bounded,
- error responses are safe,
- relevant tests pass,
- architecture is no worse than before,
- new code follows the dependency rules in this file,
- docs/comments affected by the change are accurate,
- **any changed Edge Function has actually been redeployed** (§45 step 11), or the summary states explicitly why no redeploy was required.

---

# 47. Final Rule

Do not optimize for “fewest files changed” if that forces business logic into the wrong layer.

Do not optimize for “perfect architecture” if it causes a risky rewrite.

Optimize for:

> **small, coherent, testable changes that move POSTORA toward clear feature ownership and one-way dependencies while keeping production stable.**
