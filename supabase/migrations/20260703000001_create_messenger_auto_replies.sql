CREATE TABLE public.messenger_auto_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('away', 'keyword')),
  keywords TEXT[],
  reply_message TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  schedule_start TIME,
  schedule_end TIME,
  schedule_days INTEGER[],
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.messenger_auto_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own messenger auto replies"
  ON public.messenger_auto_replies FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_messenger_auto_replies_updated_at
  BEFORE UPDATE ON public.messenger_auto_replies
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.messenger_auto_reply_usage (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  auto_reply_rule_id UUID NOT NULL,
  conversation_id TEXT,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.messenger_auto_reply_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own messenger auto reply usage"
  ON public.messenger_auto_reply_usage FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can insert messenger auto reply usage"
  ON public.messenger_auto_reply_usage FOR INSERT
  WITH CHECK (true);

CREATE INDEX idx_messenger_ar_usage_user ON public.messenger_auto_reply_usage(user_id);
CREATE INDEX idx_messenger_ar_usage_rule ON public.messenger_auto_reply_usage(auto_reply_rule_id);
