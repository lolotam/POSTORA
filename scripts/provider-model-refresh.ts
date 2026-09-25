// One-off: diff each provider's live /models against ai_models and print a
// DRAFT migration. Capabilities are guessed by id pattern; a human reviews them.
// Usage: deno run --allow-net --allow-env scripts/provider-model-refresh.ts < keys.json > draft.sql
// keys.json: {"openai":"…","claude":"…","xai":"…","zai":"…","existing":{"openai":["gpt-4o",…],…}}
const SOURCES: Record<string, { url: string; headers: (k: string) => Record<string, string> }> = {
  openai: { url: "https://api.openai.com/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  claude: { url: "https://api.anthropic.com/v1/models?limit=1000", headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }) },
  xai: { url: "https://api.x.ai/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  zai: { url: "https://api.z.ai/api/paas/v4/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
};

export function guessCapability(id: string): string {
  if (/embed/i.test(id)) return "embedding";
  if (/tts|speech/i.test(id)) return "tts";
  if (/whisper|transcribe|stt/i.test(id)) return "stt";
  if (/image|dall-e|imagine-image|cogview/i.test(id)) return "image";
  if (/video|sora|imagine-video|cogvideo/i.test(id)) return "video";
  return "chat";
}

if (import.meta.main) {
  const input = JSON.parse(await new Response(Deno.stdin.readable).text());
  const sql = (s: string) => s.replace(/'/g, "''");
  console.log("-- DRAFT: review every capability before committing. Generated", new Date().toISOString());
  for (const [code, src] of Object.entries(SOURCES)) {
    if (!input[code]) { console.log(`-- ${code}: no key, skipped`); continue; }
    const res = await fetch(src.url, { headers: src.headers(input[code]) });
    if (!res.ok) { console.log(`-- ${code}: HTTP ${res.status}, skipped`); continue; }
    const ids: string[] = ((await res.json()).data ?? []).map((m: { id: string }) => m.id);
    const existing = new Set<string>(input.existing?.[code] ?? []);
    for (const id of ids.filter((i) => !existing.has(i)).sort()) {
      console.log(`INSERT INTO public.ai_models (provider_id, model_id, name, capabilities, is_active)
SELECT id, '${sql(id)}', '${sql(id)}', ARRAY['${guessCapability(id)}'], true FROM public.ai_providers WHERE provider_code = '${code}'
ON CONFLICT (provider_id, model_id) DO NOTHING;`);
    }
    for (const gone of [...existing].filter((i) => !ids.includes(i)).sort()) {
      console.log(`-- ${code}: '${gone}' no longer listed; deactivate only if no default_ai_model_* uses it`);
    }
  }
}
