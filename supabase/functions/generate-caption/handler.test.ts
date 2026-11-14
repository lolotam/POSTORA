import { getModels } from "npm:@mariozechner/pi-ai@0.73.1";
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.208.0/testing/time.ts";

const userId = crypto.randomUUID();
Deno.env.set("SUPABASE_URL", "https://fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", crypto.randomUUID());
Deno.env.set("SUPABASE_ANON_KEY", crypto.randomUUID());
const { handleGenerateCaptionRequest } = await import("./handler.ts");
const { handleGenerateHashtagsRequest } = await import("../generate-hashtags/handler.ts");
const tier = (model_id: string) => ({ provider_code: "google", model_id });

for (const branch of ["caption", "brand_intelligence", "youtube_title", "youtube_description", "youtube_tags", "hashtags", "youtube_cap_refusal"]) {
  for (const enabled of [true, false]) {
    Deno.test(`${branch} uses ${enabled ? "its category" : "legacy Chat"} at the provider boundary`, async () => {
      const previousFetch = globalThis.fetch;
      const category = branch === "hashtags" ? "hashtags" : "caption";
      const calls: Array<Record<string, unknown>> = [];
      const settings = [{ key: "feature_ai_category_text_ladders", value: enabled }, { key: "default_ai_model_chat", value: tier("chat") },
        { key: "default_ai_model_caption", value: tier("caption") }, { key: "default_ai_model_hashtags", value: tier("hashtags") }];
      if (branch === "youtube_cap_refusal") {
        const codex = { provider_code: "openai", model_id: getModels("openai-codex")[0].id, auth_method: "oauth" };
        settings.splice(settings.findIndex(row => row.key === "default_ai_model_caption"), 1);
        for (const suffix of ["", "_fallback", "_fallback_2"]) settings.push({ key: `default_ai_model_caption${suffix}`, value: codex });
      }
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const table = url.pathname.split("/").at(-1);
        if (url.hostname !== "fixture.invalid") {
          calls.push(JSON.parse(String(init?.body)));
          const content = branch === "brand_intelligence" ? JSON.stringify({ captions: ["caption"], imagePrompts: [], videoPrompts: [] })
            : branch.startsWith("youtube_") ? JSON.stringify({ suggestions: ["Synthetic suggestion"] }) : branch === "hashtags" ? "#test\n#fixture" : "one\n---\ntwo\n---\nthree\n---\nfour\n---\nfive";
          return Response.json({ choices: [{ message: { content } }] });
        }
        if (table === "user") return Response.json({ id: userId });
        if (table === "user_roles") return Response.json({ role: "admin" });
        if (table === "app_settings") return Response.json({ value: false });
        if (table === "user_feature_overrides" || table === "user_ai_model_overrides") return Response.json(null);
        if (table === "system_settings") {
          if (url.searchParams.get("key")?.startsWith("eq.")) return Response.json({ value: enabled });
          return Response.json(settings.filter(row => url.searchParams.get("key")?.includes(row.key)));
        }
        if (table === "provider_api_keys") return Response.json({ api_key: crypto.randomUUID() });
        return Response.json(null);
      };
      try {
        const handler = category === "hashtags" ? handleGenerateHashtagsRequest : handleGenerateCaptionRequest;
        const response = await handler(new Request("https://edge.invalid/generate", { method: "POST", headers: { Authorization: `Bearer ${crypto.randomUUID()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ context: "Synthetic fixture", caption: "Synthetic fixture", requestType: branch === "caption" ? undefined : branch === "youtube_cap_refusal" ? "youtube_title" : branch, platform: "instagram", model: "ignored-client-choice" }) }));
        const body = await response.json();
        if (branch === "youtube_cap_refusal" && enabled) {
          assertEquals(response.status, 409);
          assertEquals(body.error, "ai_output_cap_unsupported");
          assertEquals(calls, []);
          return;
        }
        assertEquals(response.status, 200);
        assert(!body.error && !body.error_code, JSON.stringify(body));
        assertEquals(calls.map(call => call.model), [enabled ? category : "chat"]);
        if (branch.startsWith("youtube_")) assertEquals(calls[0].max_tokens, 4096);
      } finally { globalThis.fetch = previousFetch; }
    });
  }
}

Deno.test("caption HTTP authentication consumes the same bounded request deadline", async () => {
  const time = new FakeTime();
  const previousFetch = globalThis.fetch;
  let captured: AbortSignal | undefined;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    captured = init?.signal ?? undefined;
    captured?.addEventListener("abort", () => reject(new DOMException("private", "AbortError")), { once: true });
  });
  try {
    const pending = handleGenerateCaptionRequest(new Request("https://edge.invalid/generate", { method: "POST", headers: { Authorization: `Bearer ${crypto.randomUUID()}` }, body: "{}" }));
    for (let i = 0; i < 200; i++) await Promise.resolve();
    assert(captured);
    time.tick(50_000);
    for (let i = 0; i < 200; i++) await Promise.resolve();
    assertEquals(captured.aborted, true);
    const response = await pending;
    assertEquals(response.status, 401);
  } finally { globalThis.fetch = previousFetch; time.restore(); }
});

for (const invalid of [{ caption: {} }, { caption: 'x'.repeat(10001) }, { caption: 'valid', platform: {} },
  { caption: 'valid', model: 'x'.repeat(101) }, {}]) {
  Deno.test(`hashtags validates before routing: ${Object.keys(invalid).join(',') || 'missing caption'}`, async () => {
    const previousFetch = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname; paths.push(path);
      if (path.endsWith('/user')) return Response.json({ id: userId });
      if (path.endsWith('/user_roles')) return Response.json({ role: 'admin' });
      return Response.json(null);
    };
    try {
      const response = await handleGenerateHashtagsRequest(new Request('https://edge.invalid/generate', { method: 'POST',
        headers: { Authorization: `Bearer ${crypto.randomUUID()}` }, body: JSON.stringify(invalid) }));
      assertEquals(response.status, 400);
      assertEquals((await response.json()).error, 'Invalid request body');
      assertEquals(paths.some(path => path.endsWith('/app_settings') || path.endsWith('/system_settings') || path.includes('completions')), false);
    } finally { globalThis.fetch = previousFetch; }
  });
}
