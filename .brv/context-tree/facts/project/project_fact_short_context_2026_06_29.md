---
title: Project Fact Short Context 2026-06-29
summary: Concise snapshot of project facts, conventions, and operational values as of June 29, 2026.
tags: []
related: []
keywords: []
createdAt: '2026-06-29T17:58:35.541Z'
updatedAt: '2026-06-29T18:56:01.207Z'
---
## Reason
Maintain a brief, durable snapshot of project facts and state as of 2026-06-29

## Raw Concept
**Task:**
Curate short-form, up-to-date project facts and operational context as of 2026-06-29

**Changes:**
- Updated project state facts
- Updated fact snapshot from latest project context
- README.md was rewritten into a 20-section structure while preserving all useful existing content.
- The 20 sections added to README.md are: 1. Project Overview, 2. Tech Stack, 3. Project Architecture, 4. Folder Structure, 5. Main Features, 6. API Endpoints, 7. Database Blueprint, 8. Environment Variables, 9. Local Development Setup, 10. Production Build & Deployment, 11. Current Self-Hosting / Database Setup, 12. External Integrations, 13. Security Notes, 14. Testing & Quality, 15. Development Roadmap, 16. Known Issues / Technical Debt, 17. Useful Commands, 18. Contribution / Developer Notes, 19. Maintenance Checklist, 20. Final Summary.
- The codebase contains 96 edge functions categorized by auth, posting, media, AI, threads, TikTok, WhatsApp, messaging, analytics, tokens, billing, email, admin, MFA, public API, and webhooks.
- Self-hosted Supabase is deployed on Contabo VPS at IP 86.48.2.205 via Dokploy.
- A historical reference 'efruibswazzuuupgyzmf' is noted for Supabase but is non-runtime.
- There are approximately 200 SQL migrations in the codebase.
- The security model is RLS-first with has_role() SECURITY DEFINER.
- Platform-error-reporting pattern uses HTTP 200 for operator-fixable errors.
- There is a critical gotcha about docker-compose.yml interpolation for Edge Runtime environment mapping.
- Docker uses a multi-stage build: Node 20 to nginx:alpine, with CRON_SECRET gating.
- No secrets are exposed in documentation; only variable names, purposes, and fake placeholder examples are used.
- .env.example values are placeholders and preserved as such.
- All public URLs documented (postora.cloud, api.postora.cloud) are non-secret.
- The README documents a platform matrix, architecture diagram, edge function reference, and operational caveats.
- The README includes a database blueprint with approximately 30 tables grouped by core, billing, messaging, config/AI/observability, as well as functions, triggers, and storage buckets.
- Environment variables are documented in full tables by category (frontend, Supabase, Meta, Google, TikTok, etc.) with no real secrets.
- Local development setup includes prerequisites, steps, dev URL, and a Threads HTTPS caveat.
- Production build and deployment covers build, Docker, Dokploy, reverse proxy/SSL, and migrations.
- Current self-hosting/database setup uses Contabo VPS, Dokploy stacks, public URLs, ports, and security.
- External integrations include 25+ services: Meta, TikTok, YouTube, Cloudinary, Stripe, Resend, AI providers, etc.
- Security notes cover auth, authorization, CORS, rate limiting, RLS, nginx hardening, and gaps.
- Testing and quality section documents Vitest, Playwright, TestSprite, lint, and missing-coverage TODOs.
- Development roadmap includes 8 phases with bullet tasks.
- Known issues/technical debt section documents 12 items with evidence.
- Useful commands are documented in a command table.
- Contribution/developer notes cover branching, code style, where to add things, and env var safety.
- Maintenance checklist is included for project owners.
- Final summary section provides a 5-8 line overview.
- TODOs left: complete per-function request/response schemas for all 96 functions (deferred to API_REFERENCE.md), automated Postgres backup schedule and disaster-recovery runbook (not in repo), tightening CSP to specific origins (current broad https: allowlist), adding test/test:e2e scripts to package.json.

**Flow:**
Extract project facts -> Map to categories -> Curate as short-form facts

**Timestamp:** 2026-06-29

## Narrative
### Structure
This context captures a concise, up-to-date snapshot of project state, operational facts, conventions, and key configuration values as of June 29, 2026.

### Dependencies
Facts are extracted from project documentation, operational logs, and recent configuration changes.

### Highlights
Includes version numbers, feature state, API endpoints, OAuth details, infrastructure settings, and operational conventions.

## Facts
- **README.md structure**: README.md was rewritten into a 20-section structure while preserving all useful existing content.
- **README.md sections**: The 20 sections added to README.md are: 1. Project Overview, 2. Tech Stack, 3. Project Architecture, 4. Folder Structure, 5. Main Features, 6. API Endpoints, 7. Database Blueprint, 8. Environment Variables, 9. Local Development Setup, 10. Production Build & Deployment, 11. Current Self-Hosting / Database Setup, 12. External Integrations, 13. Security Notes, 14. Testing & Quality, 15. Development Roadmap, 16. Known Issues / Technical Debt, 17. Useful Commands, 18. Contribution / Developer Notes, 19. Maintenance Checklist, 20. Final Summary.
- **edge functions**: The codebase contains 96 edge functions categorized by auth, posting, media, AI, threads, TikTok, WhatsApp, messaging, analytics, tokens, billing, email, admin, MFA, public API, and webhooks.
- **Supabase deployment**: Self-hosted Supabase is deployed on Contabo VPS at IP 86.48.2.205 via Dokploy.
- **Supabase reference**: A historical reference 'efruibswazzuuupgyzmf' is noted for Supabase but is non-runtime.
- **SQL migrations**: There are approximately 200 SQL migrations in the codebase.
- **database security**: The security model is RLS-first with has_role() SECURITY DEFINER.
- **error reporting**: Platform-error-reporting pattern uses HTTP 200 for operator-fixable errors. [convention]
- **docker-compose.yml**: There is a critical gotcha about docker-compose.yml interpolation for Edge Runtime environment mapping.
- **Docker build**: Docker uses a multi-stage build: Node 20 to nginx:alpine, with CRON_SECRET gating.
- **documentation safety**: No secrets are exposed in documentation; only variable names, purposes, and fake placeholder examples are used.
- **.env.example**: .env.example values are placeholders and preserved as such.
- **public URLs**: All public URLs documented (postora.cloud, api.postora.cloud) are non-secret.
- **README.md content**: The README documents a platform matrix, architecture diagram, edge function reference, and operational caveats.
- **database blueprint**: The README includes a database blueprint with approximately 30 tables grouped by core, billing, messaging, config/AI/observability, as well as functions, triggers, and storage buckets.
- **environment variables**: Environment variables are documented in full tables by category (frontend, Supabase, Meta, Google, TikTok, etc.) with no real secrets.
- **local development setup**: Local development setup includes prerequisites, steps, dev URL, and a Threads HTTPS caveat.
- **production deployment**: Production build and deployment covers build, Docker, Dokploy, reverse proxy/SSL, and migrations.
- **self-hosting**: Current self-hosting/database setup uses Contabo VPS, Dokploy stacks, public URLs, ports, and security.
- **external services**: External integrations include 25+ services: Meta, TikTok, YouTube, Cloudinary, Stripe, Resend, AI providers, etc.
- **security notes**: Security notes cover auth, authorization, CORS, rate limiting, RLS, nginx hardening, and gaps.
- **testing tools**: Testing and quality section documents Vitest, Playwright, TestSprite, lint, and missing-coverage TODOs.
- **development roadmap**: Development roadmap includes 8 phases with bullet tasks.
- **technical debt**: Known issues/technical debt section documents 12 items with evidence.
- **useful commands**: Useful commands are documented in a command table.
- **developer notes**: Contribution/developer notes cover branching, code style, where to add things, and env var safety.
- **maintenance checklist**: Maintenance checklist is included for project owners.
- **final summary**: Final summary section provides a 5-8 line overview.
- **outstanding tasks**: TODOs left: complete per-function request/response schemas for all 96 functions (deferred to API_REFERENCE.md), automated Postgres backup schedule and disaster-recovery runbook (not in repo), tightening CSP to specific origins (current broad https: allowlist), adding test/test:e2e scripts to package.json.
