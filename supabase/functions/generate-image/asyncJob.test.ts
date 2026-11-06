// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildEnqueueArgs, kickAiImageWorker } from "./asyncJob.ts";

Deno.test("enqueue args carry scalars and the https reference URLs only (B8)", () => {
  const refs = [{ url: "data:image/png;base64,AAAA", type: "style", priority: 1 }, { url: "https://cdn.example/a.png", type: "content", priority: 2 }];
  assertEquals(buildEnqueueArgs("u1", { prompt: "cat", aspectRatio: "16:9" }, refs), {
    p_user_id: "u1", p_model_id: null,
    p_params: { prompt: "cat", aspectRatio: "16:9", quality: null, requestedModel: null, reference_urls: ["https://cdn.example/a.png"] },
    p_references: refs,
  });
});
Deno.test("kick posts to the worker with the service-role bearer and a timeout", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response("{}", { status: 202 }); }) as typeof fetch;
  await kickAiImageWorker(fake, "https://api.example.invalid/", "srk");
  assertEquals(seen!.url, "https://api.example.invalid/functions/v1/ai-image-worker");
  assertEquals((seen!.init.headers as Record<string, string>).Authorization, "Bearer srk");
  assertEquals(seen!.init.signal instanceof AbortSignal, true);
});
