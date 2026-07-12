CREATE TABLE public.ai_knowledge_graph_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  html_url text,
  vault_url text,
  generated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_knowledge_graph_exports TO authenticated;
GRANT ALL ON public.ai_knowledge_graph_exports TO service_role;

ALTER TABLE public.ai_knowledge_graph_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own ai knowledge graph exports"
  ON public.ai_knowledge_graph_exports FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins manage all ai knowledge graph exports"
  ON public.ai_knowledge_graph_exports FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
