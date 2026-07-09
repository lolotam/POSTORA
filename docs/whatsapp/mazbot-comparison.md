# Postora WhatsApp vs MazBot — feature comparison

Benchmark of Postora's WhatsApp mini-app against [mazbot.net](https://mazbot.net) (WhatsApp business messaging platform). Compiled 2026-07 from MazBot's public marketing pages (features, appointment reminders, embedded signup guide, team management, AI patient experience, AI credits).

## Feature matrix

| Capability | Postora | MazBot |
|---|---|---|
| Team inbox (shared conversations) | ✅ Conversations + agent assignment | ✅ |
| Contacts with CSV import, tags, groups | ✅ Contacts section | ✅ |
| Message templates (Meta-approved) | ✅ Templates section | ✅ |
| Broadcast campaigns | ✅ Broadcasts section | ✅ (campaigns) |
| Quick (canned) replies | ✅ Quick Replies | ✅ |
| Keyword auto-replies | ✅ Auto Replies | ✅ (bot flows) |
| Agents / assignment / handoff | ✅ Agents section | ✅ (team management, roles) |
| Conversation / message analytics | ✅ Analytics + Response Stats | ✅ |
| Scheduled messages | ✅ Scheduled section | ✅ (reminders) |
| Product catalog / commerce | ✅ Catalog + WhatsApp Shop | ✅ (store sync) |
| Outbound webhooks / automation endpoints | ✅ Webhooks section | ⚠️ not prominently advertised |
| Meta Embedded Signup onboarding | ✅ cloud_api + coexistence modes | ✅ |
| Coexistence with WhatsApp Business app | ✅ | ✅ |
| Business profile management | ✅ Profile section | ✅ |
| Human-agent escalation queue | ✅ (`feature_human_agent`) | ✅ |
| n8n / external API automation | ✅ (`n8n-api`, community node) | ⚠️ unknown |

## Gaps — MazBot has it, Postora does not

All items below are **Not implemented — roadmap candidates**. None of them exist in the Postora codebase today.

| MazBot feature | What it does | Status in Postora |
|---|---|---|
| AI agent with credits system | LLM-powered auto-responder answering customer questions from a knowledge base; usage metered by prepaid AI credits | Not implemented — roadmap candidate |
| AI knowledge base | Upload business documents/FAQ that ground the AI agent's answers | Not implemented — roadmap candidate |
| No-code flow builder | Visual drag-and-drop builder for multi-step conversation flows | Not implemented — roadmap candidate (Postora auto-replies are single keyword→response rules) |
| Appointment reminders | Booking-linked automatic reminder sequences (e.g., clinics) | Not implemented — roadmap candidate (Postora has generic scheduled messages only) |
| Store sync | Automatic product sync from an external store into the catalog | Not implemented — roadmap candidate (Postora catalog is managed manually) |
| Mobile app | Native mobile app for the team inbox | Not implemented — roadmap candidate (Postora is responsive web only) |
| Team roles & internal notes | Granular member roles and private notes on conversations | Partially — Postora has agents/assignment but no role tiers or internal conversation notes |

## Postora advantages over MazBot

- Multi-platform: WhatsApp sits next to Facebook, Instagram, TikTok, YouTube, Pinterest publishing and messaging in one product.
- Self-hosted option: full data ownership on your own Supabase stack.
- Open automation surface: n8n community node and API-key access.
