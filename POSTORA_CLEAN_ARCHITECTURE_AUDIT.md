# POSTORA Clean Architecture Audit

Repository audited: `lolotam/POSTORA`  
Audit focus: Clean Architecture, SOLID, Screaming Architecture, Common Closure Principle (CCP), Acyclic Dependencies Principle (ADP), Dependency Inversion Principle (DIP), and practical maintainability for React + TypeScript + Supabase/Deno.

## Executive Summary

POSTORA is a production system with several strong engineering foundations already in place: shared authentication helpers, error sanitization, sensitive-data redaction, schema validation in important edge functions, reusable `_shared` modules, RLS-centric data security, testing tooling, and a clear operational stack.

The main architectural risk is not the technology choice. It is **feature scattering and dependency direction**.

The frontend is largely organized by technical type (`pages`, `components`, `hooks`, `contexts`, `lib`, `services`, `stores`) rather than by business capability. Important workflows such as publishing span large page components, broad hooks, shared contexts, direct Supabase calls, platform-specific settings, and Edge Functions. This makes changes harder to localize and increases the chance that an AI coding agent will modify several unrelated areas.

The backend has the same pressure in a different form: `process-post` is a very large multi-platform Edge Function with request handling, orchestration, platform contracts, publishing logic, retries, media handling, and provider-specific details co-located. Some shared extraction has already started, which is a good direction, but there are still duplicated contracts and infrastructure coupling.

The recommended strategy is **incremental feature-oriented refactoring**, not a repository-wide rewrite.

---

## Current Architecture Strengths

### 1. Security-first backend helpers exist

`supabase/functions/_shared/auth-helper.ts` derives the authenticated user from the JWT and only accepts a body `user_id` for authenticated service-role calls. It also compares the service-role token using a timing-safe hash comparison.

**Keep and standardize this pattern.**

### 2. Sensitive logging protection is already centralized

`supabase/functions/_shared/logging.ts` recursively redacts values whose keys look like tokens, secrets, passwords, API keys, authorization data, service-role values, webhooks, cookies, and similar sensitive fields.

**This is a strong cross-cutting boundary and should be mandatory for new backend logging.**

### 3. Client-facing backend errors have a sanitizer

`supabase/functions/_shared/errorSanitizer.ts` maps database/internal errors to user-safe messages and attempts to prevent schema and implementation details from leaking.

**New Edge Functions should use this instead of exposing raw provider or database errors.**

### 4. Validation is moving toward schemas

`process-post` already uses Zod plus shared request-validation helpers.

**This should become the default for every external Edge Function entrypoint.**

### 5. Shared backend extraction has begun

`process-post` imports helpers from `_shared`, including platform types, validation, webhook security, media helpers, LinkedIn destination helpers, and timeout utilities.

That means the repository has already started moving away from “everything in one Edge Function file.”

---

## Main Findings

## Finding 1 — Frontend structure does not yet “scream” the business

### Current pattern

The primary source tree is organized around technical categories:

```text
src/
├── pages/
├── components/
├── hooks/
├── contexts/
├── integrations/
├── lib/
├── services/
├── stores/
└── types/
```

This is convenient early in a React application, but at POSTORA's current size it weakens the Common Closure Principle.

A publishing change can require edits in:

```text
src/pages/CreatePost.tsx
src/hooks/usePostForm.tsx
src/hooks/usePlatformSettings.tsx
src/components/post/*
src/contexts/PublishingContext.tsx
src/lib/*
src/integrations/supabase/*
supabase/functions/process-post/*
supabase/migrations/*
```

### Architectural effect

A business feature is spread across many technical folders, so unrelated features share the same change surfaces.

### Recommendation

Do not rewrite all existing folders.

For substantial new work, prefer:

```text
src/features/
├── publishing/
├── scheduling/
├── social-accounts/
├── media/
├── messaging/
├── analytics/
├── billing/
├── ai-generation/
├── admin/
└── auth/
```

Each feature owns its UI, application logic, contracts, infrastructure adapters, and tests.

---

## Finding 2 — `CreatePost.tsx` is an orchestration hotspot

`CreatePost.tsx` imports many feature hooks, platform-specific state types, shared utilities, a Supabase client, contexts, quota logic, feature flags, role logic, media-editing behavior, account selection, scheduling, and a large number of UI components.

This component is doing more than presentation composition.

### Risk

It becomes a “god page” where adding one platform or publishing rule can touch many unrelated concerns.

### Recommendation

The page should mainly:

1. read route state,
2. invoke a publishing/composer application controller,
3. render components,
4. dispatch user intents.

Move workflow logic into the publishing feature.

Target:

```text
src/features/publishing/
├── domain/
│   ├── post.ts
│   ├── platform.ts
│   └── publishing-policy.ts
├── application/
│   ├── create-post.ts
│   ├── schedule-post.ts
│   ├── validate-post.ts
│   └── publishing-controller.ts
├── infrastructure/
│   ├── postora-publishing-repository.ts
│   ├── supabase-post-repository.ts
│   └── media-upload-adapter.ts
├── ui/
│   ├── CreatePostPage.tsx
│   ├── components/
│   └── hooks/
└── index.ts
```

---

## Finding 3 — Business/application hooks depend on presentation code

`usePostForm.tsx` imports `checkFileSizeForPlatforms` from:

```text
@/components/post/VideoPreview
```

This is a dependency-direction violation.

A form/application hook should not depend on a presentation component to obtain business/media validation logic.

### Correct direction

```text
UI component
    ↓
application hook/controller
    ↓
domain policy / pure utility
```

Not:

```text
application hook
    ↓
UI component
```

### Recommendation

Move file-size validation to a pure feature/domain module such as:

```text
src/features/publishing/domain/media-policy.ts
```

Both `VideoPreview` and the publishing controller may depend on that module.

---

## Finding 4 — Direct Supabase access exists inside workflow hooks/pages

`usePostForm.tsx` directly queries `posts`, `media_files`, and storage. `CreatePost.tsx` also imports the Supabase client.

Direct Supabase calls are not automatically wrong, especially with strong RLS, but allowing them anywhere makes infrastructure coupling spread through the UI.

### Recommendation

New code must not make raw Supabase calls from pages or visual components.

Use feature-owned adapters:

```text
Publishing UI
    ↓
Publishing application service
    ↓
PostRepository interface
    ↑
SupabasePostRepository
```

For React Query, the query hook may live in the feature infrastructure/UI boundary, but the page should consume a feature API rather than construct database queries itself.

---

## Finding 5 — `process-post` violates Single Responsibility at file level

`supabase/functions/process-post/index.ts` contains or coordinates:

- HTTP entry handling
- CORS
- environment access
- request validation
- post retrieval
- account resolution
- media handling
- webhook notifications
- background polling
- result aggregation
- Facebook publishing
- Instagram publishing
- LinkedIn publishing
- Pinterest publishing
- Reddit publishing
- Threads publishing
- TikTok publishing
- Twitter/X publishing
- YouTube publishing
- Bluesky publishing

The file itself documents sections beyond 3,000 lines.

### Positive signal

It already imports shared modules. Extraction has started.

### Recommendation

Keep the Edge Function entrypoint thin:

```text
process-post/index.ts
    ↓
PublishPostUseCase
    ↓
PlatformPublisher port
    ↑
FacebookPublisher
InstagramPublisher
TikTokPublisher
...
```

The entrypoint should not know provider-specific request formats.

---

## Finding 6 — Stale architectural comment in `process-post`

The file comment states that Edge Function limitations require all code to be in one file and that imports from other files are unsupported.

The same file now imports several modules from `../_shared`.

This is stale documentation and can actively mislead coding agents into creating more monolithic functions.

### Recommendation

Remove or rewrite the stale comment immediately.

Agent rule:

> Never copy architectural comments forward without verifying that they still match the current runtime.

---

## Finding 7 — Platform contracts are duplicated

`process-post/index.ts` defines a large local `PlatformMetadata` interface while also importing shared platform metadata types.

`supabase/functions/_shared/platforms/types.ts` separately defines `PlatformMetadata`.

This creates contract-drift risk.

### Recommendation

One canonical schema should own platform metadata.

Prefer:

```text
_shared/contracts/platform-metadata.ts
```

with:

- Zod runtime schema
- inferred TypeScript type
- compatibility/version rules

Then frontend and backend should derive their types from the same contract where practical.

---

## Finding 8 — Shared platform contracts are coupled to Supabase

`_shared/platforms/types.ts` imports `SupabaseClient` and includes it directly in `PlatformPostContext`.

That couples platform publishing contracts to Supabase infrastructure.

### Better design

Pure contract:

```ts
interface PlatformPublisher {
  publish(input: PublishInput): Promise<PlatformPostResult>;
}
```

Infrastructure/context:

```ts
interface PublishDependencies {
  accountRepository: AccountRepository;
  mediaRepository: MediaRepository;
  httpClient: HttpClient;
}
```

Provider implementation may use Supabase indirectly through repositories.

This is Dependency Inversion.

---

## Finding 9 — TypeScript safety is weaker than the README implies

The application TypeScript configuration currently has:

```text
strict: false
noImplicitAny: false
noUnusedLocals: false
noUnusedParameters: false
```

The ESLint configuration also disables unused-variable enforcement.

This conflicts with the README description of “TypeScript strict mode.”

### Recommendation

Do not flip `strict: true` repository-wide in one commit.

Use incremental hardening:

1. New feature modules must be strict-compatible.
2. Do not introduce new `any` unless documented at an infrastructure boundary.
3. Replace unsafe casts when touching existing code.
4. Introduce a strict secondary tsconfig for `src/features/**`.
5. Gradually move legacy modules into the strict scope.
6. Re-enable unused-variable checking after cleanup.

---

## Finding 10 — `any` is being used to solve infrastructure version friction

`_shared/logging.ts` intentionally types `SupabaseClient` as `any` to avoid version mismatch issues across functions.

This is understandable operationally, but it hides API mistakes from the compiler.

### Recommendation

Allow `any` only at the infrastructure seam, never inside business/domain modules.

Prefer a narrow structural interface containing only the operations the logger needs.

Example:

```ts
interface LoggingDatabase {
  from(table: "system_logs" | "profiles" | "user_subscriptions" | "user_roles"): ...
}
```

---

## Finding 11 — Root provider composition is globally broad

`App.tsx` composes authentication, publishing, processing jobs, video processing debug, theme, tooltips, routing, notifications, feature flags, and error boundaries.

Some are truly application-wide. Others appear feature-specific.

### Recommendation

Keep root providers only for genuinely global concerns:

- auth
- query client
- router
- theme
- global error boundary

Move feature-specific providers closer to the relevant feature route when possible.

This reduces hidden coupling and rerender scope.

---

## Clean Architecture Assessment

| Principle | Current status | Notes |
|---|---|---|
| Single Responsibility | Partial | Good extraction exists, but publishing page and `process-post` are large hotspots |
| Open/Closed | Partial | Platform model is extensible conceptually, but central files still require edits for many new providers |
| Liskov Substitution | Not strongly testable from sampled code | Should be enforced through explicit publisher contracts |
| Interface Segregation | Needs improvement | Broad state/hooks and large platform contexts suggest oversized contracts |
| Dependency Inversion | Needs improvement | UI/workflow code imports Supabase directly; shared platform types import Supabase |
| Screaming Architecture | Weak | Root folders mostly describe technical categories |
| Common Closure Principle | Weak-to-partial | Feature-specific subfolders exist, but business changes still cross many root technical folders |
| Acyclic Dependencies | At risk | Example: application hook importing a UI component utility |
| Error boundary/security | Strong | Sanitization and auth helpers are good foundations |
| Runtime validation | Improving | Zod usage exists and should become standard |
| Testability | Moderate | Tooling is present; architecture currently makes isolated domain testing harder |
| Type safety | Needs improvement | `strict` is disabled and unused checks are relaxed |

---

## Priority Refactoring Plan

### P0 — Rules before structural migration

Add `AGENTS.md` first so all new AI-generated work follows the desired dependency rules.

### P1 — Publishing boundary

Publishing is the highest-value first feature because it currently concentrates the most cross-platform complexity.

Extract:

```text
src/features/publishing/
supabase/functions/_shared/publishing/
```

Do not move everything at once. Migrate code only when touched.

### P2 — Thin `process-post`

Reduce `process-post/index.ts` until it performs:

```text
request
→ CORS
→ authenticate
→ validate
→ construct dependencies
→ invoke PublishPost
→ map result
→ sanitize error
```

Provider logic belongs elsewhere.

### P3 — Canonical publishing contracts

Eliminate duplicate `PlatformMetadata`.

Define a single runtime schema and inferred type.

### P4 — Introduce frontend repository adapters

Prevent new direct Supabase queries from pages/components.

Migrate existing direct queries opportunistically.

### P5 — Strict feature islands

Make all new `src/features/**` code strict-compatible.

### P6 — Architectural linting/tests

Add checks preventing:

```text
features/*/domain -> React
features/*/domain -> Supabase
features/*/application -> components
features/*/application -> integrations/supabase
features/A -> features/B/internal/*
```

---

## Recommended Target Dependency Graph

```text
                    app composition root
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
         publishing      billing       messaging
             │
             ▼
             UI
             │
             ▼
        application
             │
             ▼
           domain
             ▲
             │
      infrastructure
             │
    ┌────────┼─────────┐
    ▼        ▼         ▼
 Supabase  Platform   External
 adapter    APIs       services
```

Allowed:

```text
ui -> application
ui -> domain contracts
application -> domain
infrastructure -> application ports
infrastructure -> domain
composition root -> everything
```

Forbidden:

```text
domain -> React
domain -> Supabase
domain -> browser APIs
application -> UI components
application -> Supabase client
infrastructure -> UI
feature A -> feature B internal files
_shared -> feature-specific business code
```

---

## Migration Rule

Do not perform a “Clean Architecture rewrite.”

Use the **Boy Scout Rule with architectural direction**:

> Every touched subsystem should leave with slightly clearer boundaries than before, without unrelated mass movement.

The architecture should improve feature-by-feature while the live product remains stable.
