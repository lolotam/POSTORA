# Delivery tiers: Light / Medium / Heavy Implementation Pipeline

Date: 2026-11-19. Decided by Waleed. Relayed by the PosPay manager thread (reference: PosPay PP-195, `lolotam/PayPos.systems#1085`).

## Owner words (verbatim)

«ابعت بقي ملفات وخطة ال3 pip lines دي لكل المديرين علشان يسجلوها وينفزوها كقاعدة عنهم في كل الشغل ويعملولها merg علطول بدون مراجعة light task كاضافة وثائق في ملفات المشاريع cladue.md file and agent file»

## Decision

The three delivery tiers are recorded as a standing rule in `CLAUDE.md` and `AGENTS.md` (section "Delivery tiers (Light / Medium / Heavy Implementation Pipeline)"). Adding that section is itself a Light task, merged on green CI without waiting for review bots.

## Conflicts with earlier project rules and how they were resolved

- Earlier rule: a PR merges only after Waleed says to merge. The tiers replace it for Light work (merge on green CI). A PR that has a migration, money or permissions/auth still merges only after Waleed's card approval.
- Earlier rule: every PR is held for review bots. Light skips the bot wait; Medium and Heavy keep it.
- The implementer order in the tiers (Kimi, MiniMax, GLM, Grok, Claude Sonnet) differs from the earlier instruction of 2026-11-19 that put Antigravity (Gemini 4 Neon, high) first and OpenCode GLM 5.3 Fast as its fallback. This record follows the tier text; whether Antigravity keeps a place in front of the list is left to Waleed.

## Update 2026-11-20: skills per tier and implementer lane

- Waleed agreed to record the skills per tier: Light none; Medium `clean-code-guard` and `test-guard` run by the implementer; Heavy adds `waleed-security-reviewer`; the manager runs `/code-review` once on the whole PR at the end (it is built into Claude Code and not available to other CLIs).
- Waleed replaced Grok with OpenCode `zai-coding-plan/glm-5.3-flash` in the implementer order. The `vercel/zai/...` GLM ids fail on the Vercel free tier and must not be used.
- Still open for Waleed: whether Antigravity (Gemini 4 Neon, high) keeps a place in front of Kimi, as he asked on 2026-11-19.

## Update 2026-11-20 (opening sessions)

- Waleed made it a standing rule that every session the manager opens goes through `delegate_task` (it notifies the manager when the work finishes); another tool is allowed only with "message me when done" in the brief, and running sessions are never polled.
