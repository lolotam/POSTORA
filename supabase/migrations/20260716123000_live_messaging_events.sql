CREATE TABLE public.social_inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  event_type text NOT NULL CHECK (event_type IN ('message', 'comment')),
  external_event_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (social_account_id, external_event_id)
);

CREATE INDEX social_inbox_events_user_account_idx
  ON public.social_inbox_events (user_id, social_account_id, created_at DESC);

ALTER TABLE public.social_inbox_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own social inbox events"
  ON public.social_inbox_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

ALTER PUBLICATION supabase_realtime ADD TABLE public.social_inbox_events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messaging_cache;
ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.threads_mentions;
