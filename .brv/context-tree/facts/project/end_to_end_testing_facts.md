---
title: End-to-End Testing Facts
summary: Project uses Playwright for e2e tests organized by feature with .spec.ts files; fixtures and global setup are in e2e/fixtures/auth.ts and e2e/global-setup.ts.
tags: []
related: []
keywords: []
createdAt: '2026-06-29T18:45:09.793Z'
updatedAt: '2026-06-29T18:45:09.793Z'
---
## Reason
Document e2e testing framework, file layout, and conventions

## Raw Concept
**Task:**
Document end-to-end testing framework and test organization

**Changes:**
- Adopted Playwright as the standard e2e testing framework
- Organized tests by feature with dedicated spec files
- Created authentication fixtures for test setup

**Files:**
- e2e/auth.spec.ts
- e2e/analytics.spec.ts
- e2e/dashboard.spec.ts
- e2e/history.spec.ts
- e2e/landing.spec.ts
- e2e/media-library.spec.ts
- e2e/profiles.spec.ts
- e2e/scheduled-posts.spec.ts
- e2e/fixtures/auth.ts
- e2e/global-setup.ts

**Flow:**
global setup -> feature-specific test execution -> result aggregation

**Timestamp:** 2026-06-29

## Narrative
### Structure
All end-to-end tests are in the e2e/ directory and organized by application feature. Test cases use Playwright and follow a .spec.ts naming convention.

### Dependencies
Requires Playwright as a dev dependency. Authentication tests rely on fixtures in e2e/fixtures/auth.ts. Global setup is performed using e2e/global-setup.ts.

### Highlights
Covers authentication, analytics, dashboard, media upload, and scheduling. Each feature has a dedicated test spec for maintainability.

## Facts
- **e2e_testing_framework**: The project uses Playwright for end-to-end testing, with test specs located in the e2e/ directory. [project]
- **test_file_pattern**: Test files are named with the .spec.ts extension and cover features such as authentication, dashboard, media uploads, and scheduled posts. [project]
- **test_organization**: End-to-end tests are organized by feature and include global setup via global-setup.ts. [project]
- **auth_fixtures_path**: Fixtures for authentication are located in e2e/fixtures/auth.ts. [project]
- **feature_coverage**: Analytics, authentication, and media upload features have dedicated test specs. [project]
