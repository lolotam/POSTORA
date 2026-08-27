// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CloudGraphFetcher,
  DirectUrlFetcher,
  EvolutionFetcher,
  MediaFetchError,
  MetaMessagingFetcher,
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
    { platform: "whatsapp", accessToken: "secret-token", mediaUrl: "https://lookaside.fbsbx.com/x" },
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
          new Response(JSON.stringify({ url: "https://scontent.fbcdn.net/a", mime_type: "audio/ogg" }), { status: 200 }),
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
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://scontent.fbcdn.net/a" },
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
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://scontent.fbcdn.net/a" },
        LIMITS,
        () => Promise.resolve(bodyResponse(new Uint8Array(4096), { "content-length": "4096" })),
      ),
    MediaFetchError,
    "declared",
  );
});

Deno.test("an external abort surfaces as AbortError rather than a timeout", async () => {
  const controller = new AbortController();
  const pending = new CloudGraphFetcher().fetchMediaBytes(
    { platform: "whatsapp", accessToken: "t", mediaUrl: "https://scontent.fbcdn.net/a" },
    { maxBytes: 1024, timeoutMs: 5_000 },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    controller.signal,
  );
  controller.abort();
  const error = await assertRejects(() => pending);
  assertEquals((error as Error).name, "AbortError");
});

Deno.test("a hung download aborts as a timeout", async () => {
  await assertRejects(
    () =>
      new CloudGraphFetcher().fetchMediaBytes(
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://scontent.fbcdn.net/a" },
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

Deno.test("the bearer token is never sent to a non-Meta host", async () => {
  // The whole point of the allowlist: even a URL that reached us looking legitimate must
  // not receive the account's access token.
  let called = false;
  await assertRejects(
    () =>
      new CloudGraphFetcher().fetchMediaBytes(
        { platform: "whatsapp", accessToken: "secret", mediaUrl: "https://evil.test/steal" },
        LIMITS,
        () => { called = true; return Promise.resolve(bodyResponse(new Uint8Array([1]))); },
      ),
    MediaFetchError,
    "refusing to send credentials",
  );
  assert(!called, "must not issue the request at all");
});

Deno.test("a lookalike host does not pass the suffix check", async () => {
  await assertRejects(
    () =>
      new CloudGraphFetcher().fetchMediaBytes(
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://graph.facebook.com.evil.test/x" },
        LIMITS,
      ),
    MediaFetchError,
    "refusing to send credentials",
  );
});

Deno.test("private-network and non-https targets are refused even without credentials", async () => {
  const direct = new DirectUrlFetcher();
  await assertRejects(
    () => direct.fetchMediaBytes({ platform: "whatsapp", mediaUrl: "http://scontent.fbcdn.net/a" }, LIMITS),
    MediaFetchError,
    "non-https",
  );
  await assertRejects(
    () => direct.fetchMediaBytes({ platform: "whatsapp", mediaUrl: "https://127.0.0.1/admin" }, LIMITS),
    MediaFetchError,
    "private-network",
  );
  await assertRejects(
    () => direct.fetchMediaBytes({ platform: "whatsapp", mediaUrl: "https://169.254.169.254/latest/meta-data" }, LIMITS),
    MediaFetchError,
    "private-network",
  );
});

Deno.test("a redirect to an unlisted host is refused rather than followed with the token", async () => {
  await assertRejects(
    () =>
      new CloudGraphFetcher().fetchMediaBytes(
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://scontent.fbcdn.net/a" },
        LIMITS,
        () =>
          Promise.resolve(
            new Response(null, { status: 302, headers: { location: "https://evil.test/x" } }),
          ),
      ),
    MediaFetchError,
    "refusing to send credentials",
  );
});

Deno.test("oversized base64 is rejected on encoded length, before atob allocates", async () => {
  const big = "A".repeat(4096); // ~3072 decoded bytes, over the 1024 ceiling
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

Deno.test("a body that emits one chunk and never closes times out instead of hanging", async () => {
  // The regression CodeRabbit asked for. A between-reads clock check does not catch this:
  // the second reader.read() simply never settles, so only racing each read does.
  const stalling = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      // never close(), never enqueue again
    },
  });
  await assertRejects(
    () =>
      new CloudGraphFetcher().fetchMediaBytes(
        { platform: "whatsapp", accessToken: "t", mediaUrl: "https://scontent.fbcdn.net/a" },
        { maxBytes: 1024, timeoutMs: 40 },
        () => Promise.resolve(new Response(stalling, { status: 200 })),
      ),
    MediaFetchError,
    "exceeded",
  );
});

Deno.test("MetaMessagingFetcher claims Messenger and Instagram attachments, and nothing else", () => {
  const fetcher = new MetaMessagingFetcher();
  const url = "https://cdn.fbsbx.com/v/t59.3654-21/clip.mp4";
  assert(fetcher.canHandle({ platform: "facebook", mediaUrl: url }));
  assert(fetcher.canHandle({ platform: "instagram", mediaUrl: url }));
  assert(!fetcher.canHandle({ platform: "whatsapp", mediaUrl: url }));
  assert(!fetcher.canHandle({ platform: "facebook", mediaUrl: null }));
});

Deno.test("cdn.fbsbx.com is accepted — the host Messenger actually serves voice clips from", async () => {
  // Regression: the pre-existing credentialed list names `lookaside.fbsbx.com`, which
  // `cdn.fbsbx.com` does NOT suffix-match. Reusing it would refuse every Facebook voice
  // note while every unit test still passed.
  const fetched = await new MetaMessagingFetcher().fetchMediaBytes(
    { platform: "facebook", mediaUrl: "https://cdn.fbsbx.com/v/t59.3654-21/audioclip-1.mp4" },
    LIMITS,
    () => Promise.resolve(bodyResponse(new Uint8Array([1, 2]), { "content-type": "video/mp4" })),
  );
  assertEquals(fetched.bytes.length, 2);
});

Deno.test("scontent image hosts and Instagram's CDN are accepted", async () => {
  for (const host of ["scontent.xx.fbcdn.net", "scontent-lhr8-1.cdninstagram.com"]) {
    const fetched = await new MetaMessagingFetcher().fetchMediaBytes(
      { platform: "instagram", mediaUrl: `https://${host}/v/photo.jpg` },
      LIMITS,
      () => Promise.resolve(bodyResponse(new Uint8Array([9]), { "content-type": "image/jpeg" })),
    );
    assertEquals(fetched.mimeType, "image/jpeg");
  }
});

Deno.test("a non-Meta host is refused even though the URL came over a verified webhook", async () => {
  // The webhook's HMAC proves Meta sent the payload; it does not prove the payload's URL
  // is Meta's. This is the bound a bare URL fetcher does not give.
  await assertRejects(
    () =>
      new MetaMessagingFetcher().fetchMediaBytes(
        { platform: "facebook", mediaUrl: "https://evil.test/payload.bin" },
        LIMITS,
        () => Promise.resolve(bodyResponse(new Uint8Array([1]))),
      ),
    MediaFetchError,
    "refusing to fetch media from evil.test",
  );
});

Deno.test("a lookalike host does not pass by suffix", async () => {
  await assertRejects(
    () =>
      new MetaMessagingFetcher().fetchMediaBytes(
        { platform: "facebook", mediaUrl: "https://cdn.fbsbx.com.evil.test/x" },
        LIMITS,
        () => Promise.resolve(bodyResponse(new Uint8Array([1]))),
      ),
    MediaFetchError,
    "refusing to fetch media",
  );
});

Deno.test("a Messenger voice clip served as video/mp4 is renamed, and only then", async () => {
  const fetcher = new MetaMessagingFetcher();
  const serve = () =>
    Promise.resolve(bodyResponse(new Uint8Array([1]), { "content-type": "video/mp4" }));
  const url = "https://cdn.fbsbx.com/v/audioclip-1.mp4";

  const asAudio = await fetcher.fetchMediaBytes(
    { platform: "facebook", mediaUrl: url, kindHint: "audio" }, LIMITS, serve,
  );
  assertEquals(asAudio.mimeType, "audio/mp4");

  // Meta calls a real video "video", never "audio". Without that word the container is
  // taken at face value, so a genuine video is not transcribed as if it were a voice note.
  const unhinted = await fetcher.fetchMediaBytes(
    { platform: "facebook", mediaUrl: url }, LIMITS, serve,
  );
  assertEquals(unhinted.mimeType, "video/mp4");
});

Deno.test("a CDN redirect is followed, and the destination is validated too", async () => {
  const seen: string[] = [];
  const fetcher = (url: string | URL | Request) => {
    seen.push(String(url));
    if (seen.length === 1) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://scontent.fbcdn.net/real.jpg" } }),
      );
    }
    return Promise.resolve(bodyResponse(new Uint8Array([7]), { "content-type": "image/jpeg" }));
  };
  const fetched = await new MetaMessagingFetcher().fetchMediaBytes(
    { platform: "facebook", mediaUrl: "https://cdn.fbsbx.com/v/first.jpg", kindHint: "image" },
    LIMITS,
    fetcher as typeof globalThis.fetch,
  );
  assertEquals(seen.length, 2);
  assertEquals(fetched.bytes.length, 1);
});

Deno.test("a redirect off Meta's hosts is refused rather than followed", async () => {
  const fetcher = (url: string | URL | Request) =>
    String(url).includes("evil")
      ? Promise.resolve(bodyResponse(new Uint8Array([1])))
      : Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }),
      );
  await assertRejects(
    () =>
      new MetaMessagingFetcher().fetchMediaBytes(
        { platform: "facebook", mediaUrl: "https://cdn.fbsbx.com/v/first.jpg" },
        LIMITS,
        fetcher as typeof globalThis.fetch,
      ),
    MediaFetchError,
    "refusing to fetch media from evil.test",
  );
});
