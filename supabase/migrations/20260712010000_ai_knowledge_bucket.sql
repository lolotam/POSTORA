INSERT INTO storage.buckets (id, name, public)
VALUES ('ai-knowledge', 'ai-knowledge', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can upload own AI knowledge files" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'ai-knowledge' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can view own AI knowledge files" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'ai-knowledge' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete own AI knowledge files" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'ai-knowledge' AND auth.uid()::text = (storage.foldername(name))[1]);
