# POSTORA Partner API
## Product Requirements Document (PRD) v1.0

**Product:** POSTORA Partner API  
**Status:** Proposed / Implementation Baseline  
**Architecture:** Public Integration Layer inside POSTORA  
**Canonical Contract:** OpenAPI 3.1  
**Initial API Version:** `/v1`  
**Primary Repository:** `lolotam/POSTORA`  
**Strategy:** Incremental migration; no repository-wide rewrite

---

# 1. Executive Summary

POSTORA Partner API will become a first-class product inside POSTORA rather than a single Edge Function.

Its purpose is to provide a secure, stable, documented, versioned public integration layer for external systems such as WordPress/WooCommerce, Shopify, Salla, Zid, CRMs, ERPs, mobile applications, n8n, Make, and custom software.

External integrations must never depend directly on POSTORA's database schema, Supabase service-role credentials, internal Edge Functions, provider OAuth secrets, or implementation-specific tables.

The Partner API will expose business capabilities through stable contracts while POSTORA retains control over authentication, authorization, tenant isolation, quotas, billing, provider credentials, retries, auditability, and compatibility.

The OpenAPI 3.1 specification will be the canonical public API contract:

```text
openapi/postora-partner-api-v1.yaml
```

That contract will drive API documentation, request/response validation, contract tests, Postman collections, SDK generation, and client libraries.

---

# 2. Product Vision

Make POSTORA an integration platform that other products can safely build on.

The target model is:

```text
External Products / Platforms
          |
          v
POSTORA Partner API v1
          |
          v
Application Use Cases
          |
          v
POSTORA Domain
          |
          v
Infrastructure Adapters
   |       |       |       |
Supabase  Meta   Shopify  Other Providers
```

The Partner API is a product boundary.

It is not a public wrapper around internal tables and it is not permission to call arbitrary internal Edge Functions.

---

# 3. Why This Product Is Needed

POSTORA already contains messaging, publishing, social-account, webhook, quota, provider, media, authentication, and automation capabilities.

The repository audit found that some important workflows are currently spread across frontend hooks/pages, direct Supabase calls, large Edge Functions, shared modules, and provider-specific code.

The largest relevant architectural hotspot is `process-post`, which currently combines multiple provider and orchestration responsibilities. The frontend also has feature scattering, particularly around publishing.

Opening these internal surfaces directly to external partners would freeze internal implementation details into public contracts and create security and backward-compatibility risks.

Therefore the Partner API must sit above existing implementation details and expose stable business use cases.

---

# 4. Product Principles

## 4.1 Public API, private implementation

External clients interact only with documented Partner API endpoints and signed webhooks.

They never receive:

- `SUPABASE_SERVICE_ROLE_KEY`
- database credentials
- Meta/WhatsApp app secrets
- provider access or refresh tokens
- Cloudinary secrets
- internal user JWTs
- direct access to private Supabase tables
- undocumented internal Edge Function credentials

## 4.2 OpenAPI-first

Every public endpoint, schema, error, security requirement, parameter, and webhook contract must be represented in OpenAPI 3.1 before it is considered stable.

## 4.3 Least privilege

Every credential receives only the scopes, workspace, account access, quota, and lifetime it needs.

## 4.4 Tenant isolation is server-authoritative

The caller must not gain access merely by supplying another `workspace_id`, `social_account_id`, or user ID.

Authorization is resolved from the authenticated partner identity and server-side mappings.

## 4.5 Backward compatibility

Published `/v1` contracts must remain compatible during their supported lifetime.

Breaking changes require a new API version or an explicit deprecation/migration process.

## 4.6 Idempotency for side effects

Operations such as sending messages, publishing posts, creating paid resources, and other externally visible side effects must support safe duplicate prevention.

## 4.7 Incremental architecture

Do not rewrite POSTORA.

Build the Partner API as a clean public boundary and migrate existing internal capabilities behind application ports/use cases incrementally.

---

# 5. Goals

The v1 product must provide:

1. Stable public REST APIs.
2. Partner API-key authentication for trusted server-to-server integrations.
3. OAuth 2.0 support for installable/public integrations where appropriate.
4. Granular scopes.
5. Workspace/account isolation.
6. Messaging APIs.
7. Social publishing and scheduling APIs.
8. Media APIs.
9. Webhook subscriptions and signed event delivery.
10. Idempotency.
11. Rate limits and quotas.
12. Usage metering and billing readiness.
13. Structured errors.
14. Monitoring and audit logs.
15. Developer documentation.
16. OpenAPI 3.1.
17. Postman collection.
18. SDK generation strategy.
19. Integration patterns for WooCommerce, Shopify, Salla, Zid, n8n, Make, and custom systems.
20. A formal changelog and deprecation policy.

---

# 6. Non-Goals

v1 will not:

- expose arbitrary SQL or database tables;
- expose the Supabase service role;
- expose provider OAuth tokens to partners;
- guarantee that every POSTORA admin UI feature has a public endpoint;
- mirror internal Edge Functions one-for-one;
- allow clients to bypass POSTORA quotas or billing;
- use frontend role checks as authorization;
- perform a repository-wide Clean Architecture migration;
- make internal implementation details part of the public contract.

---

# 7. Target Users

## 7.1 Private integration developers

Developers integrating a company's website, CRM, ERP, WordPress site, or custom application with POSTORA.

## 7.2 E-commerce platforms

Connectors and apps for:

- Shopify
- WooCommerce / WordPress
- Salla
- Zid

## 7.3 Automation platforms

- n8n
- Make
- custom workflow engines

## 7.4 SaaS partners

Third-party products that use POSTORA messaging, publishing, media, analytics, or automation capabilities.

## 7.5 POSTORA internal integrations

POSTORA-owned connectors should consume the same stable application contracts wherever practical, reducing duplicated integration logic.

---

# 8. Existing POSTORA Baseline

The audited repository currently uses:

```text
Frontend
- React 18
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui + Radix UI
- TanStack Query
- Zustand / React Context
- React Hook Form + Zod

Backend / Data
- Self-hosted Supabase
- PostgreSQL
- RLS
- Supabase Auth
- Supabase Realtime
- Supabase Storage
- Deno Edge Functions

Infrastructure
- Docker
- nginx
- Dokploy
- Cloudinary

Integrations
- Meta / Facebook / Instagram / Threads
- WhatsApp
- TikTok
- YouTube / Google
- Pinterest
- LinkedIn
- Twitter/X
- Reddit
- Bluesky
- Stripe
- Resend
- AI providers
- n8n / Make
```

Existing positive foundations include authenticated identity extraction, service-role separation, sensitive-data redaction, safe error handling, runtime schema validation, HTTP timeout helpers, webhook target validation, quotas, and idempotency-related infrastructure.

These foundations should be reused rather than replaced.

---

# 9. Product Architecture

## 9.1 Logical architecture

```text
                    Developer / Partner
                           |
                     HTTPS + OAuth/API Key
                           |
                           v
                 Partner API HTTP Adapter
                           |
             +-------------+-------------+
             |                           |
        Authentication                Validation
             |                           |
             +-------------+-------------+
                           |
                           v
                    Application Layer
             +-------------+-------------+
             |             |             |
         Messaging     Publishing      Webhooks
             |             |             |
             v             v             v
                         Domain
                           |
                           v
                  Infrastructure Ports
       +-----------+-------+-------+-----------+
       |           |               |           |
   Supabase     Meta APIs      Cloudinary   Other APIs
```

## 9.2 Edge Function rule

Partner API Edge Function entrypoints are adapters.

A public handler should conceptually do only:

```text
request
-> CORS
-> request ID
-> authenticate
-> resolve tenant/account access
-> authorize scope
-> validate schema
-> idempotency check if needed
-> invoke application use case
-> meter usage
-> map response
-> sanitize error
```

Provider-specific business logic must not accumulate inside the HTTP entrypoint.

---

# 10. Proposed Repository Structure

```text
openapi/
├── postora-partner-api-v1.yaml
├── schemas/
└── examples/

supabase/functions/
├── partner-api/
│   └── index.ts
└── _shared/
    └── partner/
        ├── auth/
        ├── contracts/
        ├── idempotency/
        ├── metering/
        ├── webhooks/
        ├── errors/
        └── observability/

src/features/developer-platform/
├── domain/
├── application/
├── infrastructure/
├── ui/
└── index.ts

docs/developer/
├── getting-started.md
├── authentication.md
├── scopes.md
├── errors.md
├── idempotency.md
├── rate-limits.md
├── webhooks.md
├── messaging.md
├── publishing.md
├── media.md
├── integrations/
└── changelog.md

sdk/
├── javascript/
├── php/
└── python/
```

This is a target direction, not a requirement to move unrelated legacy files immediately.

---

# 11. API Versioning

All public REST endpoints begin under:

```text
/v1
```

Examples:

```text
GET  /v1/accounts
GET  /v1/conversations
GET  /v1/conversations/{conversation_id}/messages
POST /v1/messages
POST /v1/posts
POST /v1/posts/{post_id}/publish
POST /v1/webhooks
GET  /v1/usage
```

Rules:

- additive optional fields are allowed in the same version;
- clients must ignore unknown response fields;
- removing fields is breaking;
- changing field meaning is breaking;
- changing required fields is breaking;
- changing enum behavior requires compatibility review;
- breaking changes require `/v2` or a documented migration window.

---

# 12. Authentication

## 12.1 Partner API keys

Trusted server-to-server integrations use POSTORA-issued keys.

Example:

```text
X-Postora-Key: pk_live_...
```

Requirements:

- random high-entropy secret;
- plaintext shown only at creation;
- stored as a one-way hash;
- identifiable non-secret prefix;
- bound to a workspace;
- optionally bound to one or more social accounts;
- assigned scopes;
- configurable rate limit;
- configurable monthly quota;
- expiration support;
- revocation support;
- last-used metadata;
- rotation support.

## 12.2 OAuth 2.0

OAuth is required for public/installable integrations where manually distributing long-lived keys is inappropriate.

Target uses include public Shopify, Salla, Zid, and similar app installations.

OAuth grants must map to:

```text
partner/application
workspace
installation
authorized scopes
authorized resources
```

Provider OAuth credentials remain private to POSTORA.

## 12.3 Never authenticate partners with

- Supabase service-role key;
- database credentials;
- Meta access tokens;
- POSTORA user's browser JWT copied into a third-party backend.

---

# 13. Authorization & Scopes

Proposed scope families:

```text
accounts:read

conversations:read

messages:read
messages:send

media:read
media:write

contacts:read
contacts:write

posts:read
posts:write
posts:publish
posts:schedule

analytics:read

webhooks:read
webhooks:manage

templates:read
templates:send

ai:generate

usage:read
```

Provider-specific scopes may be introduced only where a capability truly cannot be expressed safely by a generic scope.

Existing WhatsApp template scopes should be mapped into the public v1 scope model without breaking current consumers.

---

# 14. Tenant & Resource Isolation

Every authenticated credential resolves to a server-side partner context.

Conceptually:

```json
{
  "partner_id": "...",
  "workspace_id": "...",
  "allowed_social_accounts": ["..."],
  "scopes": ["messages:send", "conversations:read"],
  "rate_limit": 60,
  "monthly_quota": 10000
}
```

A caller-provided resource ID is always checked against this context.

Forbidden pattern:

```text
client supplies workspace_id
-> backend trusts it
-> service role reads that workspace
```

Required pattern:

```text
credential
-> server resolves allowed workspace/resources
-> requested resource is checked against allowance
-> operation proceeds
```

---

# 15. Messaging API

## 15.1 Conversations

```text
GET /v1/conversations
GET /v1/conversations/{conversation_id}
```

Filters may include:

- platform
- social account
- updated-after
- unread
- cursor
- limit

Responses must use opaque stable IDs and must not expose internal provider credentials.

## 15.2 Message history

```text
GET /v1/conversations/{conversation_id}/messages
GET /v1/messages/{message_id}
```

Support cursor pagination.

The API must distinguish:

- live messages;
- imported/history messages where relevant;
- inbound/outbound direction;
- provider message IDs;
- delivery status.

## 15.3 Send message

Canonical endpoint:

```text
POST /v1/messages
```

Initial message types:

```text
text
image
video
audio
document
template
```

Future types can be additive.

Example conceptual request:

```json
{
  "social_account_id": "acc_...",
  "recipient": {
    "type": "phone",
    "value": "+965..."
  },
  "message": {
    "type": "text",
    "text": "Hello"
  }
}
```

Side-effectful send operations require:

```text
Idempotency-Key
```

## 15.4 Provider constraints

POSTORA normalizes the common API while retaining provider-specific restrictions.

Unsupported capabilities return a stable error such as:

```text
unsupported_capability
```

The public contract must not pretend every messaging platform supports every media or interaction type.

---

# 16. Media API

Proposed endpoints:

```text
POST /v1/media
GET  /v1/media/{media_id}
GET  /v1/media/{media_id}/download
```

Requirements:

- authorization against workspace/account ownership;
- file type validation;
- size validation;
- malware/security controls where appropriate;
- signed or controlled downloads;
- no provider access token exposure;
- normalized metadata;
- expiration rules documented for temporary URLs.

---

# 17. Social Accounts API

```text
GET /v1/accounts
GET /v1/accounts/{account_id}
```

Public account responses may expose:

- POSTORA account ID;
- platform;
- display name;
- handle;
- status;
- capability summary;
- reauthorization-required status.

They must not expose:

- provider access token;
- provider refresh token;
- app secret;
- service-role information.

---

# 18. Publishing API

## 18.1 Create draft

```text
POST /v1/posts
```

## 18.2 Read post

```text
GET /v1/posts/{post_id}
```

## 18.3 Publish

```text
POST /v1/posts/{post_id}/publish
```

Requires idempotency.

## 18.4 Schedule

```text
POST /v1/posts/{post_id}/schedule
```

## 18.5 Cancel schedule

```text
DELETE /v1/posts/{post_id}/schedule
```

## 18.6 Status

```text
GET /v1/posts/{post_id}/status
```

Publishing must use provider-neutral application ports.

Adding a social platform should primarily add a provider adapter rather than expanding a giant provider switch with implementation logic.

---

# 19. Contacts API

Proposed endpoints:

```text
GET   /v1/contacts
POST  /v1/contacts
GET   /v1/contacts/{contact_id}
PATCH /v1/contacts/{contact_id}
```

Contacts are tenant-owned resources.

PII returned by this API must be limited to the authorized workspace and documented use case.

---

# 20. Analytics API

Initial read-only API:

```text
GET /v1/analytics/accounts
GET /v1/analytics/posts
GET /v1/analytics/messaging
```

Requirements:

- bounded date ranges;
- pagination where applicable;
- server-side tenant enforcement;
- documented freshness;
- stable metric definitions.

---

# 21. AI API

AI capabilities may be exposed only as explicit business operations.

Example:

```text
POST /v1/ai/captions
POST /v1/ai/replies
```

Do not expose arbitrary internal model credentials or unrestricted proxy access to AI providers.

AI usage must be quota-metered separately if billing requires it.

---

# 22. Webhook Product

Webhooks are part of the Partner API product, not an implementation detail.

## 22.1 Subscription management

```text
GET    /v1/webhooks
POST   /v1/webhooks
PATCH  /v1/webhooks/{webhook_id}
DELETE /v1/webhooks/{webhook_id}
POST   /v1/webhooks/{webhook_id}/rotate-secret
```

## 22.2 Standard headers

New v1 integrations use one canonical format:

```text
X-Postora-Event
X-Postora-Timestamp
X-Postora-Event-Id
X-Postora-Signature
```

Signature:

```text
X-Postora-Signature: sha256=<hmac>
```

HMAC secret is unique per webhook subscription or integration.

Legacy webhook formats remain compatibility-only and must not be the default for new integrations.

## 22.3 Event envelope

```json
{
  "id": "evt_...",
  "event": "message.received",
  "created_at": "2026-08-22T10:00:00Z",
  "workspace_id": "ws_...",
  "data": {}
}
```

## 22.4 Initial event families

```text
message.received
message.sent
message.delivered
message.read
message.failed

conversation.updated

post.published
post.failed
post.scheduled

account.connected
account.disconnected
account.reauthorization_required

webhook.test
```

Only events that can be reliably produced by the underlying platform should be documented as supported.

---

# 23. Webhook Delivery & Retry Policy

Webhook delivery must:

1. sign the exact raw request body;
2. include event ID and timestamp;
3. use HTTPS;
4. enforce outbound URL security;
5. apply request timeout;
6. record attempts;
7. retry only according to a bounded policy;
8. avoid duplicate logical events by preserving the same `event_id` across retries;
9. auto-disable or quarantine repeatedly failing endpoints according to documented policy;
10. provide a test-delivery feature.

Recommended v1 retry schedule is configurable and must be finalized before GA.

Consumers must deduplicate by `event_id`.

---

# 24. Idempotency

Required for operations with externally visible side effects.

Header:

```text
Idempotency-Key: <client-generated-key>
```

POSTORA stores an idempotency record scoped to:

```text
partner credential
operation
idempotency key
```

Behavior:

- same key + same request -> replay prior result;
- same key + different request -> `409 idempotency_conflict`;
- request currently processing -> stable `request_in_progress` response;
- indeterminate provider outcome -> do not blindly retry the provider action.

Retention period must be documented.

---

# 25. Rate Limits

Rate limits are applied per credential and optionally per capability.

Responses use:

```text
HTTP 429
Retry-After
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset
```

Rate-limit state must be concurrency-safe.

A limiter failure must have a deliberate fail-open/fail-closed policy depending on operation risk.

---

# 26. Quotas & Usage Metering

Usage must be recorded at the public API boundary.

Meter dimensions may include:

```text
API requests
messages accepted for send
media storage/transfer
posts published
AI generations
webhook deliveries
analytics requests
```

Quota consumption for paid side effects should reflect accepted/committed work, not merely HTTP entry.

Where provider outcome is uncertain, quota reconciliation must avoid creating duplicate real-world side effects.

---

# 27. Billing

The API must be billing-ready even if all v1 customers are initially manually provisioned.

Billing model must support:

- plan;
- included monthly usage;
- overage eligibility;
- hard quota;
- soft quota/warnings;
- per-capability metering;
- workspace attribution;
- partner/application attribution.

Stripe may remain the payment provider, but billing policy belongs to POSTORA application/domain logic rather than directly to Stripe-specific code.

---

# 28. Standard Error Contract

Every API error uses a stable envelope.

Example:

```json
{
  "error": {
    "code": "insufficient_scope",
    "message": "This credential cannot send messages.",
    "request_id": "req_...",
    "details": {}
  }
}
```

Initial error families:

```text
invalid_key
key_expired
key_revoked
insufficient_scope
resource_not_found
resource_forbidden
validation_error
rate_limited
quota_exceeded
idempotency_conflict
request_in_progress
unsupported_capability
account_reauthorization_required
provider_rate_limited
provider_rejected
media_invalid
media_too_large
internal_error
```

Raw database/provider errors must not be returned directly.

---

# 29. Request IDs & Observability

Every request receives a unique request ID.

Response header:

```text
X-Postora-Request-Id
```

Structured operational logs should include:

```text
request_id
partner_id
credential_id
workspace_id
social_account_id
operation
platform
status
error_code
duration_ms
idempotency_key_hash/reference
```

Logs must pass through sensitive-data redaction.

Never log raw credentials, access tokens, refresh tokens, authorization headers, webhook secrets, passwords, cookies, or service-role values.

---

# 30. Audit Logs

Security-sensitive actions require an immutable/auditable record where appropriate:

- API key created;
- API key rotated;
- API key revoked;
- scopes changed;
- quota changed;
- webhook created;
- webhook secret rotated;
- OAuth installation authorized/revoked;
- privileged integration settings changed.

Audit logs must identify actor, workspace, action, target, timestamp, and request ID.

---

# 31. OpenAPI 3.1 as Source of Truth

Canonical file:

```text
openapi/postora-partner-api-v1.yaml
```

It must define:

- servers;
- security schemes;
- scopes;
- endpoints;
- request schemas;
- response schemas;
- errors;
- pagination;
- idempotency headers;
- rate-limit headers;
- webhook schemas/examples;
- reusable components;
- deprecation markers.

CI must validate the specification.

A public endpoint is not considered complete until the OpenAPI contract and implementation agree.

---

# 32. Developer Documentation

Minimum documentation:

```text
Getting Started
Authentication
API Keys
OAuth
Scopes
Pagination
Idempotency
Rate Limits
Quotas
Errors
Webhooks
Messaging
Media
Publishing
Social Accounts
Contacts
Analytics
AI
Integration Guides
Changelog
Deprecations
```

Documentation examples must use fake credentials and synthetic customer data.

---

# 33. Postman

Generate or maintain a Postman collection from the canonical API contract.

It should include environments for:

```text
local
staging
production
```

No production secret may be committed into the collection.

---

# 34. SDK Strategy

Initial SDK priorities:

1. JavaScript / TypeScript
2. PHP
3. Python

SDKs should be generated or contract-driven where practical.

They must not encode undocumented behavior.

SDK releases must map to API contract versions and maintain a changelog.

---

# 35. WooCommerce / WordPress Integration Strategy

Recommended authentication for a site-owner/server plugin:

```text
POSTORA Partner API key
```

The plugin stores the POSTORA credential server-side using WordPress secret-storage best practices.

Potential capabilities:

```text
publish/schedule content
upload media
send notifications/messages
read authorized conversations
receive signed POSTORA webhooks
sync contacts/leads where enabled
```

The plugin must never receive POSTORA's Supabase or provider secrets.

---

# 36. Shopify Integration Strategy

For a private/single-merchant integration, a scoped Partner API credential may be sufficient.

For a public Shopify app, use an installation/OAuth model.

Conceptually:

```text
Shopify merchant
-> installs POSTORA app
-> OAuth authorization
-> POSTORA records installation/workspace mapping
-> connector invokes POSTORA application capabilities
```

Shopify access credentials and POSTORA partner credentials remain server-side.

Webhook verification is required in both directions.

---

# 37. Salla & Zid Integration Strategy

Use the same connector principle:

```text
Platform OAuth / app installation
-> POSTORA installation mapping
-> Partner API/application capabilities
```

Each connector owns provider-specific installation and webhook behavior.

The POSTORA public business contracts remain provider-neutral where possible.

---

# 38. n8n / Make Integration Strategy

Provide:

- API-key authentication;
- stable REST operations;
- webhook triggers;
- deterministic schemas;
- idempotency for actions;
- clear errors;
- example workflows.

Long-term, POSTORA may publish dedicated n8n nodes / Make apps, but they should call the same Partner API rather than private database surfaces.

---

# 39. Security Requirements

Mandatory:

- HTTPS only;
- secrets never in URLs;
- API keys hashed at rest;
- secret rotation;
- expiration/revocation;
- granular scopes;
- server-side resource authorization;
- RLS remains authoritative where browser/data access is involved;
- service role backend-only;
- request schema validation;
- response/error sanitization;
- HMAC webhook signing;
- SSRF-safe webhook destination validation;
- bounded external HTTP timeouts;
- bounded retries;
- idempotency;
- audit logging;
- sensitive-data redaction;
- secure CORS policy;
- no direct database access for partners.

---

# 40. Data Model Additions / Evolution

Expected public-platform entities:

```text
partner_applications
partner_api_keys
partner_api_key_scopes
partner_installations
partner_oauth_clients
partner_oauth_grants
partner_api_usage
partner_idempotency_keys
partner_webhooks
partner_webhook_deliveries
partner_audit_logs
```

Reuse existing tables where their semantics already match.

Do not duplicate existing partner key, usage, or webhook structures merely to satisfy naming.

All production schema evolution uses additive migrations.

---

# 41. Clean Architecture Rules for Partner API

The Partner API must follow the POSTORA audit rules.

## Domain must not depend on

```text
React
Supabase SDK
Deno HTTP Request/Response
Meta SDK/API payload classes
Stripe SDK
Cloudinary SDK
```

## Application may depend on

```text
domain
ports/interfaces
```

## Infrastructure implements

```text
repositories
provider adapters
storage adapters
billing adapters
HTTP clients
```

## HTTP Edge Function depends on

```text
application use cases
authentication
validation
response mapping
```

Never reverse these directions.

---

# 42. Provider Capability Model

Do not create a universal social interface that forces unsupported features.

Prefer capability interfaces such as:

```text
Publisher
MessageSender
MediaSender
SupportsTemplates
SupportsReadReceipts
SupportsScheduling
SupportsFirstComment
SupportsStories
```

This applies Liskov Substitution and Interface Segregation to provider integrations.

---

# 43. Compatibility Policy

POSTORA must publish a compatibility policy before v1 GA.

Rules:

- existing fields are not silently repurposed;
- new optional fields are additive;
- deprecated fields remain available during a documented window;
- breaking changes use a new major API version;
- webhook event schema changes follow the same discipline;
- SDKs must tolerate additive fields;
- changelog entries identify migration requirements.

---

# 44. Changelog & Deprecation

Maintain:

```text
docs/developer/changelog.md
```

Every public API release records:

```text
Added
Changed
Deprecated
Fixed
Security
```

Deprecated features must include:

- replacement;
- deprecation date;
- planned removal date;
- migration instructions.

---

# 45. Environments

Minimum environments:

```text
local
staging
production
```

Partner credentials are environment-specific.

A staging key must never authenticate against production.

Webhook testing should be available in staging before production enablement.

---

# 46. Testing Strategy

## 46.1 Contract tests

Validate implementation against OpenAPI.

## 46.2 Authentication tests

Test:

- valid key;
- invalid key;
- revoked key;
- expired key;
- missing scope;
- wrong workspace/account.

## 46.3 Tenant-isolation tests

Attempt cross-workspace and cross-account access for every resource family.

These are release-blocking security tests.

## 46.4 Idempotency tests

Test:

- duplicate same request;
- same key with different body;
- concurrent duplicate requests;
- provider timeout/indeterminate result.

## 46.5 Webhook tests

Test:

- signature;
- tampered body;
- timestamp;
- retry;
- duplicate event;
- disabled endpoint;
- SSRF rejection.

## 46.6 Quota/rate-limit tests

Include concurrency tests.

## 46.7 Provider adapter tests

Use fixtures/mocks and staging provider accounts where appropriate.

## 46.8 E2E certification

At least one complete integration path must be tested from external client -> Partner API -> provider -> webhook/status reconciliation.

---

# 47. CI/CD Gates

Partner API changes should fail CI when:

- OpenAPI is invalid;
- implementation/contract tests fail;
- generated artifacts are stale where generation is enforced;
- security/tenant tests fail;
- type/build tests fail;
- required API documentation is missing;
- a breaking contract change is detected without version/deprecation handling.

---

# 48. Developer Portal

The long-term product surface should include a Developer area inside POSTORA with:

```text
Applications
API Keys
OAuth Clients
Scopes
Webhooks
Usage
Quota
Logs
API Explorer
Documentation
SDKs
Changelog
```

The portal must never reveal a previously created API key's full secret.

Rotation creates a new secret and supports a controlled overlap window where required.

---

# 49. Admin Controls

POSTORA administrators need:

- create/revoke partner applications;
- set allowed scopes;
- set quotas;
- set rate limits;
- suspend integrations;
- inspect usage;
- inspect sanitized delivery/API logs;
- rotate webhook secrets;
- investigate request IDs;
- disable compromised credentials.

Admin UI is not the security boundary; backend authorization remains mandatory.

---

# 50. Implementation Roadmap

## Phase 0 - Freeze the contract direction

Deliver:

- this PRD;
- `AGENTS.md` rules applied;
- public API naming conventions;
- `/v1` versioning rules;
- OpenAPI repository location;
- security threat review.

Exit criteria:

No new external integration is allowed to depend directly on internal tables/service-role credentials.

## Phase 1 - Partner API Foundation

Deliver:

- `/v1` routing;
- API-key auth;
- credential hashing;
- scopes;
- workspace/account binding;
- request IDs;
- standard errors;
- rate limiting;
- quotas;
- usage ledger;
- idempotency;
- audit events;
- OpenAPI base specification.

Migrate existing `get_status`, WhatsApp template send, and template-list behavior into the formal v1 contract without breaking existing consumers.

## Phase 2 - Messaging

Deliver:

- conversations;
- message history;
- message details;
- send text;
- send image;
- send video;
- send audio;
- send document;
- templates;
- media retrieval;
- normalized statuses;
- messaging webhooks.

## Phase 3 - Webhook Platform

Deliver:

- webhook CRUD;
- per-subscription secrets;
- canonical headers;
- `event_id`;
- delivery ledger;
- retry policy;
- replay/test tooling;
- endpoint health state.

Keep legacy webhook contracts for compatibility only.

## Phase 4 - Publishing

Deliver:

- posts;
- media association;
- publish;
- schedule;
- cancel;
- status;
- publishing webhooks.

This phase should simultaneously reduce coupling to the legacy `process-post` monolith by introducing provider-neutral publishing ports/adapters.

## Phase 5 - Contacts & Analytics

Deliver:

- contacts;
- messaging analytics;
- publishing analytics;
- account analytics;
- documented metric semantics.

## Phase 6 - OAuth & App Installations

Deliver:

- partner applications;
- OAuth client model;
- installation model;
- authorization UI;
- token/grant lifecycle;
- revoke/uninstall flow.

## Phase 7 - Commerce Connectors

Deliver reference integrations:

1. WooCommerce / WordPress
2. Shopify
3. Salla
4. Zid

Each connector must use public/application contracts and never direct database access.

## Phase 8 - SDKs & Developer Experience

Deliver:

- Swagger/OpenAPI docs;
- Postman collection;
- JS/TS SDK;
- PHP SDK;
- Python SDK;
- integration quickstarts;
- webhook verifier helpers.

## Phase 9 - Billing & Commercialization

Deliver:

- plan entitlements;
- metered API usage;
- usage dashboard;
- quota warnings;
- overage/hard-limit policy;
- Stripe billing integration where required.

---

# 51. Migration From Current `partner-api`

Do not delete or rewrite the existing implementation in one step.

Migration sequence:

```text
1. Document existing behavior.
2. Wrap existing supported operations in `/v1` contracts.
3. Add contract tests.
4. Extract authentication/scopes/metering/idempotency as stable shared capabilities.
5. Add new use cases behind application interfaces.
6. Move provider-specific logic behind adapters as touched.
7. Keep compatibility aliases for existing clients.
8. Announce deprecation when replacement is proven.
9. Remove legacy paths only after the migration window.
```

This follows the repository audit's additive migration and incremental architecture strategy.

---

# 52. Acceptance Criteria for v1 GA

POSTORA Partner API v1 is generally available only when:

- OpenAPI 3.1 specification is complete and validated;
- authentication and scopes are documented;
- every public resource is tenant-isolated;
- no partner requires service-role/database/provider secrets;
- idempotency works for side effects;
- quotas and rate limits are concurrency-safe;
- standard errors are implemented;
- request IDs and sanitized logs are available;
- webhook signatures and event IDs are implemented;
- retry policy is documented;
- messaging and publishing critical flows have E2E tests;
- at least one external integration is certified;
- changelog/deprecation policy is published;
- staging is available;
- key rotation/revocation is operational;
- security review has passed.

---

# 53. Definition of Done for Every Public Endpoint

An endpoint is not done until it has:

1. business owner/use case;
2. OpenAPI definition;
3. authentication rule;
4. scope;
5. tenant/resource authorization;
6. validated request;
7. stable response schema;
8. stable errors;
9. rate-limit behavior;
10. quota behavior where applicable;
11. idempotency behavior where applicable;
12. sanitized logs;
13. request ID;
14. tests;
15. documentation;
16. changelog entry if externally released.

---

# 54. Key Product Decision

POSTORA Partner API is a permanent product boundary.

Future integrations should be designed as:

```text
WordPress  ----\
WooCommerce ----\
Shopify ---------> POSTORA Partner API / Application Contracts -> POSTORA Core
Salla ----------/
Zid ------------/
CRM ------------/
n8n / Make -----/
Custom Apps ----/
```

Never as:

```text
external system -> direct Supabase tables
external system -> service-role key
external system -> provider access tokens
external system -> undocumented internal Edge Function
```

This boundary is what allows POSTORA to evolve internally without breaking every external integration.

---

# 55. Success Metrics

Initial product metrics:

- number of active partner applications;
- number of active API credentials;
- API success/error rate;
- p50/p95 latency by operation;
- webhook delivery success rate;
- duplicate side-effect prevention rate;
- tenant-isolation/security incidents: target zero;
- credential compromise response time;
- integration time-to-first-successful-call;
- integration time-to-production;
- SDK adoption;
- monthly API usage;
- publishing/message volume through Partner API.

---

# 56. Final Product Statement

POSTORA Partner API must be treated with the same product discipline as POSTORA itself.

It requires:

```text
versioning
security
contracts
documentation
monitoring
quotas
billing
SDKs
changelog
backward compatibility
```

The objective is not merely to expose POSTORA.

The objective is to create a stable, secure developer platform on top of POSTORA that can support global integrations without exposing or coupling partners to POSTORA's internal architecture.
