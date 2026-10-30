import { assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { encodeOpeninaryPath, extensionForBytes, extensionForContentType, listOpeninaryEntries, openinaryTarget, shouldAdoptOpeninaryFile } from "./openinary.ts";

Deno.test("derives deterministic target under postora.cloud", () => assertEquals(openinaryTarget("users/u/photo", "postora.cloud"), { folder:"postora.cloud/users/u", baseName:"photo" }));
Deno.test("derives extension from content type", () => { assertEquals(extensionForContentType("image/jpeg; charset=binary"), "jpg"); assertEquals(extensionForContentType("application/octet-stream"), null); });
Deno.test("encodes each path segment", () => assertEquals(encodeOpeninaryPath("postora.cloud/a/probe (1).png"), "postora.cloud/a/probe%20(1).png"));
Deno.test("collision text identifies drift", () => assertStringIncludes("Openinary stored x instead of requested y (collision rename)", "collision rename"));
Deno.test("adopts only the exact path with the expected byte count", () => {
  assertEquals(shouldAdoptOpeninaryFile({ name:"a.png", path:"f/a.png", size:12 }, "f/a.png", 12), true);
  assertEquals(shouldAdoptOpeninaryFile({ name:"a.png", path:"f/a (1).png", size:12 }, "f/a.png", 12), false);
  assertEquals(shouldAdoptOpeninaryFile({ name:"a.png", path:"f/a.png", size:11 }, "f/a.png", 12), false);
});
Deno.test("derives extension from leading bytes", () => {
  assertEquals(extensionForBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), "png");
  assertEquals(extensionForBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "jpg");
  assertEquals(extensionForBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "gif");
  assertEquals(extensionForBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "webp");
  assertEquals(extensionForBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null);
  assertEquals(extensionForBytes(new Uint8Array([])), null);
});

async function withListing(status: number, body: unknown, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify(body), { status }));
  try { await run(); } finally { globalThis.fetch = original; }
}
const CONFIG = { serverUrl: "https://o.example", apiKey: "k", folderPrefix: "postora.cloud" };

Deno.test("a listing returns folders and files, dropping malformed entries", () =>
  withListing(200, {
    folders: [{ name: "u1", path: "p/u1", coverPath: null }, { name: 3 }],
    files: [{ name: "a.png", path: "p/a.png", size: 5, mtime: "2026-10-30T00:00:00Z" }, { name: "b", path: "p/b" }],
  }, async () => {
    assertEquals(await listOpeninaryEntries(CONFIG, "p"), {
      folders: [{ name: "u1", path: "p/u1" }],
      files: [{ name: "a.png", path: "p/a.png", size: 5, mtime: "2026-10-30T00:00:00Z" }],
    });
  }));

Deno.test("a missing folder lists as empty, but a failed listing throws instead of reading as empty", async () => {
  await withListing(404, {}, async () => assertEquals(await listOpeninaryEntries(CONFIG, "p"), { folders: [], files: [] }));
  await withListing(502, {}, async () => { await assertRejects(() => listOpeninaryEntries(CONFIG, "p"), Error, "502"); });
});

Deno.test("the listing timeout also covers a body that never finishes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"files":['));
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  try {
    await assertRejects(() => listOpeninaryEntries(CONFIG, "p", 20));
  } finally {
    globalThis.fetch = original;
  }
});
