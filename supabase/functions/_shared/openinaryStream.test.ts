import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type OpeninaryConfig, streamedMultipart, uploadStreamToOpeninary } from "./openinary.ts";

const CONFIG: OpeninaryConfig = { serverUrl: "https://openinary.example", apiKey: "key", folderPrefix: "postora.cloud" };
const TARGET = { folder: "postora.cloud/media/u/2026-10-29", baseName: "postora_x_1", extension: "mp4", mimeType: "video/mp4", byteCount: 6 };
const PATH = `${TARGET.folder}/postora_x_1.mp4`;

function source(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

Deno.test("the streamed body is a multipart form of exactly the promised length", async () => {
  const multipart = streamedMultipart({ folder: "f" }, { field: "files", name: "a.mp4", mime: "video/mp4", source: source("abc", "def"), byteCount: 6 });
  const text = await new Response(multipart.body).text();
  assertEquals(new TextEncoder().encode(text).byteLength, multipart.contentLength);
  const boundary = multipart.contentType.split("boundary=")[1];
  assertStringIncludes(text, `name="folder"\r\n\r\nf\r\n`);
  assertStringIncludes(text, `name="files"; filename="a.mp4"\r\nContent-Type: video/mp4\r\n\r\nabcdef\r\n--${boundary}--`);
});

Deno.test("a source that sends more or fewer bytes than declared fails the body", async () => {
  for (const [chunks, declared] of [[["abcdefg"], 6], [["abc"], 6]] as const) {
    const multipart = streamedMultipart({}, { field: "files", name: "a", mime: "x", source: source(...chunks), byteCount: declared });
    let failed = false;
    try {
      await new Response(multipart.body).arrayBuffer();
    } catch {
      failed = true;
    }
    assertEquals(failed, true);
  }
});

Deno.test("the stream is posted to Openinary with its length and the stored path is checked", async () => {
  let seen: { url: string; init: RequestInit; body: string } | null = null;
  const fetcher = (async (url: string, init: RequestInit) => {
    seen = { url, init, body: await new Response(init.body).text() };
    return Response.json({ success: true, files: [{ path: PATH }] });
  }) as typeof fetch;
  const result = await uploadStreamToOpeninary(CONFIG, source("abcdef"), TARGET, { fetcher, lister: () => Promise.resolve([]), uploadBaseUrl: "https://upload.example" });
  assertEquals(result, { success: true, path: PATH, url: `https://openinary.example/t/${PATH}` });
  assertEquals(seen!.url, "https://upload.example/api/upload");
  const headers = seen!.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, "Bearer key");
  assertEquals(Number(headers["Content-Length"]), new TextEncoder().encode(seen!.body).byteLength);
});

Deno.test("an object already stored at the exact path and size is adopted, not uploaded again", async () => {
  let posted = false;
  const fetcher = (() => {
    posted = true;
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  const result = await uploadStreamToOpeninary(CONFIG, source("abcdef"), TARGET, {
    fetcher,
    lister: () => Promise.resolve([{ name: "postora_x_1.mp4", path: PATH, size: 6 }]),
  });
  assertEquals(result.adopted, true);
  assertEquals(posted, false);
});

Deno.test("a collision rename and an upload error both count as failures", async () => {
  const renamed = (() => Promise.resolve(Response.json({ success: true, files: [{ path: `${TARGET.folder}/postora_x_1-1.mp4` }] }))) as typeof fetch;
  assertEquals((await uploadStreamToOpeninary(CONFIG, source("abcdef"), TARGET, { fetcher: renamed, lister: () => Promise.resolve([]) })).success, false);
  const down = (() => Promise.reject(new Error("timed out"))) as typeof fetch;
  assertEquals(await uploadStreamToOpeninary(CONFIG, source("abcdef"), TARGET, { fetcher: down, lister: () => Promise.resolve([]) }), { success: false, error: "timed out" });
});
