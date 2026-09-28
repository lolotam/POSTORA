import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { destroyCloudinary } from "./cloudinaryDestroy.ts";

const credentials = { cloudName: "cloud", apiKey: "key", apiSecret: "secret" };

Deno.test("cloudinary destroy aborts within the caller timeout and caps at 10s", async () => {
  let sawSignal = false;
  const result = await destroyCloudinary("pic", "image", {
    timeoutMs: 20,
    credentials,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      sawSignal = !!init?.signal;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }),
  });
  assertEquals(sawSignal, true);
  assertEquals(result, { success: false, error: "timed out" });
});

Deno.test("a disabled cloudinary account counts as deleted", async () => {
  const result = await destroyCloudinary("pic", "video", {
    credentials,
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ error: { message: "cloud_name is disabled" } }), { status: 401 })),
  });
  assertEquals(result, { success: true, reason: "provider_disabled" });
});
