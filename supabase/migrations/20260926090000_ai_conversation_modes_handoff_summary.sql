-- The AI's two-line handoff note for the human, kept on the per-conversation mode row that
-- every escalation already writes, so it exists even when no agent was online to assign.
ALTER TABLE public.ai_conversation_modes
  ADD COLUMN IF NOT EXISTS handoff_summary text,
  ADD COLUMN IF NOT EXISTS handoff_summary_at timestamptz;

ALTER TABLE public.ai_conversation_modes
  DROP CONSTRAINT IF EXISTS ai_conversation_modes_handoff_summary_len;
ALTER TABLE public.ai_conversation_modes
  ADD CONSTRAINT ai_conversation_modes_handoff_summary_len CHECK (char_length(handoff_summary) <= 300);
