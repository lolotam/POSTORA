// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CloudGraphFetcher,
  DirectUrlFetcher,
  EvolutionFetcher,
  MediaFetchError,
  selectFetcher,
  type MediaRef,
} from "./inboundMediaFetchers.ts";

const LIMITS = { maxBytes: 1024, timeoutMs: 100 };

function bodyResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  // `.slice().buffer` for the same reason as the Whisper blob: a Uint8Array over
  // ArrayBufferLike is not a valid BodyInit under Deno's stricter lib types.
  return new Response(bytes.slice().buffer, { status: 200, headers });
}

Deno.test("CloudGraphFetcher claims coexistence as well as cloud_api", () => {
  const fetcher = new CloudGraphFetcher();
  const base: MediaRef = { platform: "whatsapp", accessToken: "t" };
  assert(fetcher.canHandle({ ...base, connectionMode: "cloud_api" }));
  assert(fetcher.canHandle({ ...base, connectionMode: "coexistence" }));
  assert(fetcher.canHandle({ ...base, connectionMode: null }));
  // The split mirrors whatsappTransport.ts:106 — only evolution_qr is the other transport.
  assert(!fetcher.canHandle({ ...base, connectionMode: "evolution_qr" }));
});

Deno.test("CloudGraphFetcher also claims Instagram and Messenger", () => {
  const fetcher = new CloudGraphFetcher();
  assert(fetcher.canHandle({ platform: "instagram", accessToken: "t" }));
  assert(fetcher.canHandle({ platform: "facebook", accessToken: "t" }));
});

Deno.test("CloudGraphFetcher will not act without a token", () => {
  assert(!new CloudGraphFetcher().canHandle({ platform: "whatsapp", accessToken: null }));
});

Deno.test("the media download carries the Bearer token — a bare fetch 401s", async () => {
  const seen: string[] = [];
  const bytes = await new CloudGraphFetcher().fetchMediaBytes(
    { platform: "whatsapp", accessToken: "secret-token", mediaUrl: "https://lookaside.example/x" },
    LIMITS,
    (_url, init) => {
      seen.push(String((init?.headers as Record<string, string>)?.Authorization));
      return Promise.resolve(bodyResponse(new Uint8Array([1, 2, 3])));
    },
  );
  assertEquals(seen, ["Bearer secret-token"]);
  assertEquals(bytes.bytes.byteLength, 3);
});

Deno.test("a media id is resolved to a URL first, and both calls are authenticated", async () => {
  const urls: string[] = [];
  const result = await new CloudGraphFetcher().fetchMediaBytes(
    { platform: "whatsapp", accessToken: "t", mediaId: "MEDIA-1" },
    LIMITS,
    (url, init) => {
      urls.push(String(url));
      assertEquals(String((init?.headers as Record<string, string>)?.Authorization), "Bearer t");
      if (String(url).includes("MEDIA-1")) {
        return Promise.resolve(
          new Response(JSON.stringify({ url: "https://cdn.example/a", mime_type: "audio/ogg" }), { status: 200 }),
        );
      }
      return Promise.resolve(bodyResponse(new Uint8Array([7])));
    },
  );
  assertEquals(urls.length, 2);
  assertEquals(result.mimeType, "audio/ogg");
});

Deno.test("a lying Content-Length does not get past the streaming ceiling", async () => {
  // The header says 10 bytes; the body is 4096. Trusting the header alone would buffer
  // the whole thing, which is exactly what the limit exists to prevent.
  await assertRejects(
    () =>
      new CloudGraphFetcher().fetchMediaBytes(
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://cdn.example/a" },
        LIMITS,
        () => Promise.resolve(bodyResponse(new Uint8Array(4096), { "content-length": "10" })),
      ),
    MediaFetchError,
    "exceeded",
  );
});

Deno.test("an honest oversized Content-Length is refused before the body is read", async () => {
  await assertRejects(
    () =>
      new CloudGraphFetcher().fetchMediaBytes(
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://cdn.example/a" },
        LIMITS,
        () => Promise.resolve(bodyResponse(new Uint8Array(4096), { "content-length": "4096" })),
      ),
    MediaFetchError,
    "declared",
  );
});

Deno.test("a hung download aborts as a timeout", async () => {
  await assertRejects(
    () =>
      new CloudGraphFetcher().fetchMediaBytes(
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://cdn.example/a" },
        { maxBytes: 1024, timeoutMs: 20 },
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    MediaFetchError,
    "timed out",
  );
});

Deno.test("EvolutionFetcher claims only evolution_qr", () => {
  const fetcher = new EvolutionFetcher("https://evo.example", "key", "inst");
  assert(fetcher.canHandle({ platform: "whatsapp", connectionMode: "evolution_qr" }));
  assert(!fetcher.canHandle({ platform: "whatsapp", connectionMode: "coexistence" }));
  assert(!fetcher.canHandle({ platform: "instagram" }));
});

Deno.test("EvolutionFetcher uses inline base64 without a network call", async () => {
  let called = false;
  const result = await new EvolutionFetcher("https://evo.example", "key", "inst").fetchMediaBytes(
    { platform: "whatsapp", connectionMode: "evolution_qr", rawBase64: btoa("hi"), mimeType: "audio/ogg" },
    LIMITS,
    () => { called = true; return Promise.resolve(bodyResponse(new Uint8Array())); },
  );
  assertEquals(new TextDecoder().decode(result.bytes), "hi");
  assert(!called);
});

Deno.test("EvolutionFetcher falls back to the instance API when there is no inline base64", async () => {
  const result = await new EvolutionFetcher("https://evo.example/", "key", "inst").fetchMediaBytes(
    { platform: "whatsapp", connectionMode: "evolution_qr", mediaId: "M1" },
    LIMITS,
    (url, init) => {
      assert(String(url).includes("/chat/getBase64FromMediaMessage/inst"));
      assertEquals((init?.headers as Record<string, string>)?.apikey, "key");
      return Promise.resolve(
        new Response(JSON.stringify({ base64: btoa("voice"), mimetype: "audio/ogg" }), { status: 200 }),
      );
    },
  );
  assertEquals(new TextDecoder().decode(result.bytes), "voice");
  assertEquals(result.mimeType, "audio/ogg");
});

Deno.test("oversized inline base64 is refused", async () => {
  const big = btoa("x".repeat(2048));
  await assertRejects(
    () =>
      new EvolutionFetcher("https://evo.example", "k", "i").fetchMediaBytes(
        { platform: "whatsapp", connectionMode: "evolution_qr", rawBase64: big },
        LIMITS,
      ),
    MediaFetchError,
    "exceeds",
  );
});

Deno.test("DirectUrlFetcher only claims a credential-free URL", () => {
  const fetcher = new DirectUrlFetcher();
  assert(fetcher.canHandle({ platform: "whatsapp", mediaUrl: "https://x/y" }));
  assert(!fetcher.canHandle({ platform: "whatsapp", mediaUrl: "https://x/y", accessToken: "t" }));
  assert(!fetcher.canHandle({ platform: "whatsapp" }));
});

Deno.test("selectFetcher picks the first that claims the ref, and null when none do", () => {
  const candidates = [new CloudGraphFetcher(), new EvolutionFetcher("u", "k", "i"), new DirectUrlFetcher()];
  assertEquals(
    selectFetcher({ platform: "whatsapp", connectionMode: "coexistence", accessToken: "t" }, candidates)?.name,
    "cloud_graph",
  );
  assertEquals(
    selectFetcher({ platform: "whatsapp", connectionMode: "evolution_qr" }, candidates)?.name,
    "evolution",
  );
  assertEquals(selectFetcher({ platform: "whatsapp" }, candidates), null);
});
