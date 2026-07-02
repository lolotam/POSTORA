---
title: README.md Durable Documentation Protocol
summary: Comprehensive, codebase-driven README.md protocol for technical/business clarity, onboarding, and project maintenance; includes conventions for secrets, env vars, folder structure, API docs, roadmap, technical debt, and update workflow.
tags: []
related: []
keywords: []
createdAt: '2026-06-29T17:46:22.277Z'
updatedAt: '2026-06-29T17:46:22.277Z'
---
## Reason
Document robust, durable conventions and requirements for README.md technical documentation and onboarding for any developer or AI.

## Raw Concept
**Task:**
Define and enforce protocol for codebase-driven README.md documentation to ensure all critical technical/business details, onboarding, stack, API, database, and maintenance info are captured without exposing secrets.

**Changes:**
- Established convention to never expose secrets or credentials in docs.
- Mandated codebase-driven README.md updates with clear TODOs for missing info.
- Standardized structure: overview, stack, folder structure, endpoints, env vars, setup, deployment, roadmap, technical debt, commands, onboarding, maintenance.
- Documented durable onboarding facts for future maintainers and AI agents.

**Files:**
- README.md
- docker-compose.yml
- package.json

**Flow:**
1. Analyze project codebase → 2. Extract technical/business facts → 3. Update README.md per protocol → 4. Mark gaps as TODO → 5. Maintain durable onboarding context.

**Timestamp:** 2026-06-29

**Author:** ByteRover Context Engineer

## Narrative
### Structure
README.md must always reflect the actual stack, folder structure, API, database, environment, and deployment setup present in the codebase. Documentation is structured into 20 key sections, with mandatory tables and diagrams where appropriate. Each section is updated only if supported by source or config. No secrets are ever exposed.

### Dependencies
Requires ongoing codebase analysis for new features, database changes, environment/config updates, and deployment changes. Relies on developer/AI discipline to maintain accuracy and mark TODOs for missing details.

### Highlights
Durable protocol ensures any developer or AI can onboard, maintain, or migrate the project using only README.md, without risk of credential exposure. Every critical aspect—stack, endpoints, database, env, commands, roadmap, debt, onboarding—is systematically documented.

### Rules
Rule 1: Never document real secrets, API keys, or credentials. Rule 2: If any required information is missing, add a TODO. Rule 3: Only document what is confirmed in the codebase/config. Rule 4: Follow the 20-section template. Rule 5: README.md is the canonical source for onboarding and maintenance.

### Examples
Example: If database type is unknown, add `TODO: clarify database engine and hosting`. Example: For env vars, only show variable names and fake examples.

## Facts
- **AI assistant**: The AI assistant is instructed to analyze a website/application codebase and update the main README.md file for clarity to any developer, owner, hosting provider, or future AI agent. [project]
- **AI assistant**: The assistant must not rewrite application code unless absolutely required for documentation accuracy. [project]
- **AI assistant**: The assistant must not expose secrets, API keys, passwords, tokens, private URLs, service-role keys, or credentials. [project]
- **AI assistant**: If information is missing, the assistant should write 'TODO:' clearly instead of guessing. [project]
- **AI assistant**: The assistant must focus on accuracy based on the actual codebase, not assumptions. [project]
- **.env/config documentation**: If .env or config files exist, only the variable names and purpose should be documented, never the values. [convention]
- **README.md**: If there is already a README, preserve useful existing content and improve it professionally. [convention]
- **README.md**: If there is no README, the assistant must create a complete new one. [convention]
- **README.md**: README.md must give a complete technical and business picture of the project. [convention]
- **README.md**: README.md must document frontend stack, backend stack, API endpoints, folder structure, database/self-hosting setup, environment variables, local development and production deployment steps, roadmap, and technical debt. [convention]
- **README.md**: README.md must not expose any private credentials. [convention]
- **README.md**: README.md must be professional, structured, and easy to understand. [convention]
- **README.md**: README.md must use markdown tables, code blocks, and diagrams where useful. [convention]
- **README.md**: README.md must include a full folder structure, API endpoint table, database blueprint, and environment variable table. [convention]
- **README.md**: If database/self-hosting setup details are missing, mark as TODO. [convention]
- **README.md**: README.md must include local development setup, production build & deployment, roadmap, technical debt, useful commands, contribution notes, maintenance checklist, and final project summary. [convention]
- **Folder Structure**: Folder structure must be documented with paths and explanations for each major folder. [convention]
- **Environment Variables**: All environment variables found in the project must be documented safely, with only variable names, purposes, and fake example values. [convention]
- **Environment Variables**: If environment variables are unknown, mark as TODO. [convention]
- **Self-hosting documentation**: Self-hosted database/server setup should be documented or marked TODO if not detectable. [convention]
- **Test framework**: Test framework, test command, lint command, typecheck command, build verification command, test folders/files, and test coverage TODOs must be documented if present. [convention]
- **Development roadmap**: Project roadmap must include phases: documentation & env cleanup, stability & bug fixing, security & auth hardening, database & backup improvements, UI/UX improvements, testing & QA, production deployment improvements, future features. [convention]
- **Roadmap phases**: Each roadmap phase must have clear bullet tasks. [convention]
- **Technical debt**: Technical debt section must list issues found during code review. [convention]
- **Issue inclusion criteria**: Only include issues in technical debt that are supported by actual code inspection. [convention]
- **Command table**: A command table must be included for install, dev, build, start, test, lint, typecheck, database migrate, database seed, and Docker up/down if available. [convention]
- **Command inclusion**: Only include commands that are actually present in the codebase or scripts. [convention]
- **Onboarding**: Contribution/developer notes must explain onboarding, branching, code style, how to add frontend components, backend endpoints, environment variables, and update database schema. [convention]
- **Maintenance checklist**: Maintenance checklist must include updating dependencies, checking environment vars, backing up database, checking logs, renewing SSL, running tests, verifying production build, reviewing security rules, and updating README. [convention]
- **Project summary**: Project summary must explain the full project in 5–8 lines. [convention]
- **Server access**: Access to the server is possible via ssh-contaboo-mcp. [project]
