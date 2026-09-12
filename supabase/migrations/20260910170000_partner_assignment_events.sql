-- Assignment transitions cover every writer; deploy before the /v1 routes.
DO $widen$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'partner_webhooks_events_certified';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_webhooks_events_certified is missing -- apply 20260902130000 first';
  END IF;
  IF v_def LIKE '%conversation.assigned%'
     AND v_def LIKE '%conversation.unassigned%' THEN
    RETURN;  -- already widened; re-running is a no-op
  END IF;

  ALTER TABLE public.partner_webhooks
    DROP CONSTRAINT partner_webhooks_events_certified;
  ALTER TABLE public.partner_webhooks
    ADD CONSTRAINT partner_webhooks_events_certified
    CHECK (
      cardinality(events) > 0
      AND events <@ ARRAY[
        'webhook.test',
        'message.received',
        'message.accepted',
        'message.delivered',
        'message.read',
        'message.failed',
        'account.reauthorization_required',
        'post.scheduled',
        'whatsapp_number.connected',
        'whatsapp_number.disconnected',
        'history_sync.completed',
        'conversation.assigned',
        'conversation.unassigned'
      ]
    );
END
$widen$;

-- Never make browser/escalation writes depend on webhook availability. Legacy
-- null attribution is intentionally skipped, never guessed from a text key.
CREATE OR REPLACE FUNCTION public.partner_assignment_events_emit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type TEXT;
  v_at TIMESTAMPTZ;
  v_when TEXT;
  v_account UUID;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.conversation_cache_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.unassigned_at IS NULL THEN
    v_type := 'conversation.assigned';
    v_at := NEW.assigned_at;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.unassigned_at IS NULL AND NEW.unassigned_at IS NOT NULL THEN
      v_type := 'conversation.unassigned';
      v_at := NEW.unassigned_at;
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;
  IF v_at IS NULL THEN RETURN NEW; END IF;
  SELECT social_account_id INTO v_account FROM public.messaging_cache
    WHERE id = NEW.conversation_cache_id AND workspace_id = NEW.workspace_id
      AND platform = 'whatsapp';
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_when := to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  PERFORM public.partner_emit_webhook_event(
    NEW.workspace_id, v_type, v_type || ':' || NEW.id || ':' || v_when,
    jsonb_build_object(
      'id', 'assignment_' || NEW.id,
      'conversation', 'conv_' || NEW.conversation_cache_id,
      'agent_id', 'agent_' || NEW.agent_id,
      'assigned_at', NEW.assigned_at,
      'unassigned_at', NEW.unassigned_at
    ), 'whatsapp', v_account, v_at
  );
  RETURN NEW;
EXCEPTION
  -- OTHERS only. It covers every ordinary SQL error the emitter can raise,
  -- which is the whole point: an observation must never roll back the
  -- assignment it observes.
  --
  -- query_canceled and assert_failure are deliberately NOT caught, even though
  -- OTHERS excludes them. Swallowing query_canceled would make this statement
  -- ignore statement_timeout and an operator's pg_cancel_backend, so a write
  -- someone is trying to stop would continue -- and assert_failure means an
  -- invariant in called code is already broken, which is not something to
  -- paper over inside someone else's transaction. Both should abort the write.
  WHEN OTHERS THEN
    -- No logging SQL here: a failed logger would itself roll back the writer.
    RAISE LOG 'partner_assignment_events_emit skipped emission (SQLSTATE %)', SQLSTATE;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.partner_assignment_events_emit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_partner_assignment_events ON public.whatsapp_conversation_assignments;
CREATE TRIGGER trg_partner_assignment_events
  AFTER INSERT OR UPDATE OF unassigned_at ON public.whatsapp_conversation_assignments
  FOR EACH ROW EXECUTE FUNCTION public.partner_assignment_events_emit();

-- Cache-row lock serializes /v1 writers, including initially unassigned chats.
-- idx_active_assignment is the final arbiter for every other writer. A conflict
-- rolls back this entire function, including its close and history insert.
CREATE OR REPLACE FUNCTION public.partner_write_conversation_assignment(
  p_workspace_id UUID, p_key_id UUID, p_conversation_cache_id UUID,
  p_agent_id UUID, p_notes TEXT, p_unassign BOOLEAN
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation public.messaging_cache%ROWTYPE;
  v_previous public.whatsapp_conversation_assignments%ROWTYPE;
  v_result public.whatsapp_conversation_assignments%ROWTYPE;
  v_at TIMESTAMPTZ;
BEGIN
  IF p_unassign IS NULL THEN RAISE EXCEPTION 'Assignment operation is required'; END IF;
  SELECT c.* INTO v_conversation FROM public.messaging_cache c
    JOIN public.partner_api_key_accounts b ON b.social_account_id = c.social_account_id
      AND b.workspace_id = c.workspace_id AND b.key_id = p_key_id
    WHERE c.id = p_conversation_cache_id AND c.workspace_id = p_workspace_id
      AND c.platform = 'whatsapp' AND c.last_message_at IS NOT NULL
    FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'resource_not_found'); END IF;
  IF NOT p_unassign THEN
    PERFORM 1 FROM public.whatsapp_agents
      WHERE id = p_agent_id AND workspace_id = p_workspace_id FOR KEY SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'resource_not_found'); END IF;
  END IF;
  SELECT * INTO v_previous FROM public.whatsapp_conversation_assignments
    WHERE workspace_id = p_workspace_id AND conversation_id = v_conversation.conversation_id
      AND unassigned_at IS NULL FOR UPDATE;
  IF p_unassign AND NOT FOUND THEN RETURN jsonb_build_object('error', 'resource_not_found'); END IF;
  v_at := clock_timestamp();
  IF v_previous.id IS NOT NULL THEN
    UPDATE public.whatsapp_conversation_assignments
      SET unassigned_at = v_at, conversation_cache_id = v_conversation.id
      WHERE id = v_previous.id AND workspace_id = p_workspace_id
      RETURNING * INTO v_result;
  END IF;
  IF NOT p_unassign THEN
    INSERT INTO public.whatsapp_conversation_assignments
      (workspace_id, conversation_cache_id, conversation_id, agent_id, assigned_at, notes)
    VALUES (p_workspace_id, v_conversation.id, v_conversation.conversation_id, p_agent_id, v_at, p_notes)
    RETURNING * INTO v_result;
  END IF;
  -- No impersonated user: this is a partner-key action, so performed_by and
  -- assigned_by remain null. The HTTP usage row supplies key attribution.
  INSERT INTO public.whatsapp_assignment_history
    (workspace_id, conversation_id, action, from_agent_id, to_agent_id, reason, created_at)
  VALUES (p_workspace_id, v_conversation.conversation_id,
    CASE WHEN p_unassign THEN 'unassigned' WHEN v_previous.id IS NULL THEN 'assigned' ELSE 'transferred' END,
    v_previous.agent_id, CASE WHEN p_unassign THEN NULL ELSE p_agent_id END, p_notes, v_at);
  RETURN jsonb_build_object('id', v_result.id, 'agent_id', v_result.agent_id,
    'assigned_at', v_result.assigned_at, 'unassigned_at', v_result.unassigned_at, 'notes', v_result.notes);
END;
$$;
REVOKE ALL ON FUNCTION public.partner_write_conversation_assignment(UUID, UUID, UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_write_conversation_assignment(UUID, UUID, UUID, UUID, TEXT, BOOLEAN) TO service_role;
