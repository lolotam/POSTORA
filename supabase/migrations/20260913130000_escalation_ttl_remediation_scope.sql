-- Correction to 20260913120000_escalation_ttl.sql's remediation.
--
-- That update bounded every human_first override that had an "AI escalation:"
-- assignment for the same conversation key, without tying the assignment's
-- workspace to the override's owner. Conversation keys recur across accounts
-- (two Postora accounts can connect the same WhatsApp number), so four
-- overrides were bounded on the strength of another account's assignment.
-- Whether those four were escalations that never assigned or manual choices
-- is not recorded, so the safe direction is back to "until released": a
-- permission-shaped row must never be widened by inference (AGENTS.md rule 5).
-- The affected rows are named explicitly; on any other database this is a
-- no-op. (Codex P1 on PR #178, verified on production 2026-09-13.)

update public.ai_conversation_modes m
   set expires_at = null
 where m.mode = 'human_first'
   and m.expires_at is not null
   and (m.user_id::text, m.conversation_id) in (
     ('c371c63b-277d-438a-b52f-ad3371f0b19e', 'cba03dae-e500-4cb1-9d19-f855423ce35a:comment:18134375995556864:2420791712061102'),
     ('12f4ba6a-91a8-4ab7-9286-dd27e8a9db61', 'wa_96592280746_96550050548'),
     ('12f4ba6a-91a8-4ab7-9286-dd27e8a9db61', 'wa_96592280746_96599207323'),
     ('12f4ba6a-91a8-4ab7-9286-dd27e8a9db61', 'wa_96592280746_96599000690')
   )
   and not exists (
     select 1
       from public.whatsapp_conversation_assignments a
       join public.workspaces w on w.id = a.workspace_id
      where a.conversation_id = m.conversation_id
        and a.notes like 'AI escalation:%'
        and (
          w.owner_id = m.user_id
          or exists (
            select 1 from public.social_accounts s
             where s.user_id = m.user_id and s.workspace_id = w.id
          )
        )
   );
