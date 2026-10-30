import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { prefixedStream, readPrefix, streamedSourceLength, STREAM_INGEST_MAX_BYTES, streamFailureMessage, streamIngestCap, streamProviders } from "./urlIngest.ts";

const MB = 1024 * 1024;

function chunked(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...new Uint8Array(await new Response(stream).arrayBuffer())];
}

Deno.test("only a declared length over 10 MB is streamed", () => {
  assertEquals(streamedSourceLength(String(10 * MB)), null);
  assertEquals(streamedSourceLength(String(10 * MB + 1)), 10 * MB + 1);
  assertEquals(streamedSourceLength(null), null);
  assertEquals(streamedSourceLength("abc"), null);
});

Deno.test("the streamed cap is the admin's limit, held under Cloudflare's", () => {
  assertEquals(streamIngestCap("video", { image_max_mb: 20, video_max_mb: 50 }), 50 * MB);
  assertEquals(streamIngestCap("video", { image_max_mb: 20, video_max_mb: 500 }), STREAM_INGEST_MAX_BYTES);
  assertEquals(streamIngestCap("image", { image_max_mb: 20, video_max_mb: 500 }), 20 * MB);
  assertEquals(streamIngestCap("document", { image_max_mb: 20, video_max_mb: 500 }), null);
});

Deno.test("the prefix and the rest add back up to the whole body", async () => {
  const reader = chunked([1, 2], [3, 4, 5], [6]).getReader();
  const prefix = await readPrefix(reader, 3);
  assertEquals([...prefix], [1, 2, 3, 4, 5]);
  assertEquals(await collect(prefixedStream(prefix, reader)), [1, 2, 3, 4, 5, 6]);
});

Deno.test("a body shorter than the prefix is read whole", async () => {
  const reader = chunked([9, 8]).getReader();
  const prefix = await readPrefix(reader, 4096);
  assertEquals([...prefix], [9, 8]);
  assertEquals(await collect(prefixedStream(prefix, reader)), [9, 8]);
});

Deno.test("a streamed upload uses Openinary alone, so a failed stream is never retried through Cloudinary", () => {
  assertEquals(streamProviders({ attempted: ["cloudinary", "openinary"], required: ["cloudinary", "openinary"] }), {
    attempted: ["openinary"],
    required: ["openinary"],
  });
  assertEquals(streamProviders({ attempted: ["openinary", "cloudinary"], required: [] }), { attempted: ["openinary"], required: [] });
  // Cloudinary alone leaves nothing to stream to: the caller answers 503 rather than importing the URL.
  assertEquals(streamProviders({ attempted: ["cloudinary"], required: ["cloudinary"] }), { attempted: [], required: [] });
});

Deno.test("the failure message says the stream failed and why", () => {
  assertEquals(
    streamFailureMessage(["openinary: Source sent 5 of the 20 bytes it declared"]),
    "The file could not be streamed to storage (openinary: Source sent 5 of the 20 bytes it declared)",
  );
  assertEquals(streamFailureMessage([]), "The file could not be streamed to storage (unknown error)");
});
