# Plan

## Task 1 — Knowledge tab flashing / not loading (Facebook + WhatsApp + Instagram)

**Cause hypotheses (to confirm at start of implementation):**
- `AiKnowledgeManager` always calls `useWhatsAppCatalog()` even when `platform === "facebook" | "instagram"`, which triggers WhatsApp-scoped queries/subscriptions that repeatedly fail/refetch → visible "flash".
- `useAiKnowledge` uses a `refetchInterval` that re-evaluates while `status` transitions, causing the sources list to re-mount if `sources` is destructured unstably.
- `useEffect(() => setProfile(config?.business_profile_text || ""), [config])` reruns whenever the query returns a new object reference, wiping local textarea state → looks like flashing.

**Fixes:**
1. Gate `useWhatsAppCatalog` behind `platform === "whatsapp"` and only render the WhatsApp catalog card in that case.
2. Change the profile-sync effect to depend on `config?.business_profile_text` (primitive) instead of the whole `config` object.
3. Stabilize `sources` from `useAiKnowledge` (default `[]` only once) and set `refetchInterval` to `false` unless a source is actively `pending|processing` (already close — verify no infinite refetch loop when the query errors).
4. Add a proper loading skeleton + empty state so the tab paints once instead of flickering between spinner and content.

Files: `src/components/messaging/AiKnowledgeManager.tsx`, `src/hooks/useAiKnowledge.ts`.

## Task 2 — Move model selection to Admin, allow multi-model + fallbacks per user

**Admin side (new): `/admin/settings` → new "AI Agent" section**
- New page/section `src/pages/admin/AdminAiAgent.tsx` (or a card in existing settings) listing allowed chat models. Admin can add rows: `{ provider, model_id, label, is_active, sort_order }`.
- Backed by a new table `ai_agent_allowed_models` (manual SQL migration, RLS: admins full, authenticated read active).
- Admin can toggle active, reorder, and set a global default (used as final fallback if the user picks nothing).

**User side: `/messaging/whatsapp/ai-agent` → Advanced card**
- Remove the free-text Model `<Input>`.
- Replace with three `<Select>`s fed by the admin allow-list: **Primary model**, **Fallback #1**, **Fallback #2** (Fallback options include a "None" entry).
- Persist as new columns on `ai_agent_configs`: `model` (primary, existing), `model_fallback_1`, `model_fallback_2` (nullable text).

**Backend (edge functions that call the model, e.g. `ai-agent-reply`):**
- Try `model` → on failure/timeout, try `model_fallback_1` → then `model_fallback_2`.
- Preserve current OpenAI-compatible gateway pattern; do not change tool schemas.

**Admin logs / tracking:**
- Every AI agent chat call writes a row to `admin_audit_log` (already exists) with `action='ai_agent_reply'`, `resource_type='ai_agent'`, `resource_id=conversation_id`, `details={ platform, model_used, fallback_level, prompt_tokens, completion_tokens, latency_ms, status, error }`.
- Existing `ai_agent_logs` remains for the user-facing Logs tab; `admin_audit_log` writes give admins a global view.
- Add an "AI Agent Calls" tab in `/admin` (or reuse the audit log page with a filter) — read-only.

**Manual SQL (self-hosted; user runs it):**

```text
supabase/manual-sql/20260712120000_ai_agent_allowed_models.sql
  - CREATE TABLE public.ai_agent_allowed_models(...)
  - GRANT SELECT to authenticated (only WHERE is_active), full to service_role
  - RLS: admins full via has_role(auth.uid(),'admin'); authenticated SELECT is_active=true
supabase/manual-sql/20260712120500_ai_agent_configs_fallback_models.sql
  - ALTER TABLE public.ai_agent_configs ADD COLUMN model_fallback_1 text, model_fallback_2 text
```

Files:
- New: `src/pages/admin/AdminAiAgent.tsx`, `src/hooks/useAdminAiAgentModels.ts`, `src/hooks/useAllowedAiModels.ts`.
- Edited: `src/components/messaging/AiAgentManager.tsx` (Advanced card), `src/hooks/useAiAgentConfig.ts` (extend type + payload fields), `supabase/functions/ai-agent-reply/index.ts` (fallback chain + audit-log insert), admin routes in `src/components/AnimatedRoutes.tsx`.

## Task 3 — WhatsApp nav restructure: add "Automation" group (UI only)

Update `src/components/whatsapp/waNav.ts` + `src/components/whatsapp/WhatsAppLayout.tsx`:

- Introduce a two-level nav model. Top-level tabs become:
  `Dashboard, Conversations, Contacts, Templates, Analytics, Automation, Broadcasts→(moved under Automation), Profile, Webhooks, Scheduled, Response Stats, Catalog, Setup, Docs`.
- New **Automation** parent tab whose sub-tabs are:
  1. AI Agent (existing `ai-agent`)
  2. Quick Replies (existing `quick-replies`)
  3. Auto Replies (existing `auto-replies`)
  4. Agents (existing `agents`)
  5. Broadcasting (existing `broadcasts`)
  6. Human Agent (new — points to existing `/human-agent-mode` embed or reuses `AgentManager` in "human handoff" mode)
- Routes stay the same to avoid breaking bookmarks; the Automation tab is a wrapper page at `/messaging/whatsapp/automation` that renders a secondary Tabs bar and lazy-loads each existing page component. Sub-URLs like `/messaging/whatsapp/automation/ai-agent` also work and highlight both the parent and child.
- No backend/logic changes.

Files: `src/components/whatsapp/waNav.ts`, `src/components/whatsapp/WhatsAppLayout.tsx`, new `src/pages/whatsapp/Automation.tsx`, `src/components/AnimatedRoutes.tsx` (add nested routes).

## Deliverables checklist
- Fix flashing on Knowledge tab across FB/IG/WA.
- Admin AI Agent settings page with multi-model allow-list.
- User Advanced: 3 dependent model selects (primary + 2 fallbacks) sourced from admin.
- `ai-agent-reply` uses fallback chain + writes to `admin_audit_log`.
- Two manual SQL files for the user to run on the self-hosted DB.
- WhatsApp nav grouped under an "Automation" tab with the 6 requested sub-tabs.
- No logic changes to non-AI features; nav restructure is UI only.

## Final status target
`completed_requires_manual_sql` (2 SQL files) + edge-function redeploy for `ai-agent-reply`.
