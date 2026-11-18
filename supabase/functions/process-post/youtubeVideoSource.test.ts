/**
 * The bounded read of the video's bytes, proved against fake media hosts.
 *
 * WHY A FAKE HOST
 * ---------------
 * The upload is now written in chunks, so the video has to be read a chunk
 * at a time. Two things about that read have to be true, and neither can be
 * checked against a live CDN on purpose:
 *
 *   * the bytes that are read are exactly the bytes that were asked for, so
 *     the customer's channel never gets a shifted or short video;
 *   * the worker never holds more than one chunk, whatever the size of the
 *     file is.
 *
 * So the host here answers ranges the way a good one does, and answers
 * ranges the way a bad one does.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createVideoByteSource,
  parseContentRangeTotal,
  readProbeResponse,
} from "./youtubeVideoSource.ts";

const VIDEO_BYTES = new Uint8Array(1024);
for (let index = 0; index < VIDEO_BYTES.length; index += 1) VIDEO_BYTES[index] = index % 251;

/**
 * A media host that answers byte ranges.
 */
function rangedHost(options: { total?: number; mimeType?: string } = {}) {
  const total = options.total ?? VIDEO_BYTES.length;
  const mimeType = options.mimeType ?? "video/mp4";
  const requests: string[] = [];

  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers as HeadersInit).get("range");
    requests.push(range ?? "");
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range ?? "") ?? [];
    const start = Number(from ?? 0);
    const end = Math.min(Number(to ?? total - 1), total - 1);
    const slice = VIDEO_BYTES.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": mimeType,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(slice.length),
      },
    });
  }) as unknown as typeof fetch;

  return { requests, fetchImpl };
}

/**
 * A media host that ignores the range and answers with the whole file.
 */
function wholeFileHost() {
  const requests: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers as HeadersInit).get("range");
    requests.push(range ?? "");
    return new Response(VIDEO_BYTES, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(VIDEO_BYTES.length),
      },
    });
  }) as unknown as typeof fetch;

  return { requests, fetchImpl };
}

Deno.test("the size of a file is read from the range answer", () => {
  assertEquals(parseContentRangeTotal("bytes 0-0/12345"), 12345);
  assertEquals(parseContentRangeTotal("bytes 0-0/*"), null);
  assertEquals(parseContentRangeTotal(null), null);
  assertEquals(parseContentRangeTotal("bytes 0-0/0"), null);
});

Deno.test("a host that answers a range tells the file size", () => {
  const probe = readProbeResponse(
    new Response(null, {
      status: 206,
      headers: { "Content-Range": "bytes 0-0/9999", "Content-Type": "video/mp4" },
    }),
  );

  assertEquals(probe, { size: 9999, mimeType: "video/mp4", ranged: true });
});

Deno.test("a host that ignores the range tells the file size too", () => {
  const probe = readProbeResponse(
    new Response(null, {
      status: 200,
      headers: { "Content-Length": "4096", "Content-Type": "video/mp4" },
    }),
  );

  assertEquals(probe, { size: 4096, mimeType: "video/mp4", ranged: false });
});

Deno.test("a range read asks for the bytes it wants and gets exactly those", async () => {
  const host = rangedHost();
  const source = await createVideoByteSource({
    url: "https://media.test/video.mp4",
    fetchImpl: host.fetchImpl,
  });

  assertEquals(source.size, VIDEO_BYTES.length);
  assertEquals(source.ranged, true);

  const bytes = new Uint8Array(await source.read(10, 19));
  assertEquals(Array.from(bytes), Array.from(VIDEO_BYTES.slice(10, 20)));
  assertEquals(host.requests[0], "bytes=0-0", "the size is asked for with one byte");
  assertEquals(host.requests[1], "bytes=10-19");
});

Deno.test("a host that ignores the range is read as a stream", async () => {
  const host = wholeFileHost();
  const source = await createVideoByteSource({
    url: "https://media.test/video.mp4",
    fetchImpl: host.fetchImpl,
  });

  assertEquals(source.size, VIDEO_BYTES.length);
  assertEquals(source.ranged, false);

  const first = new Uint8Array(await source.read(0, 15));
  assertEquals(Array.from(first), Array.from(VIDEO_BYTES.slice(0, 16)));

  const second = new Uint8Array(await source.read(16, 31));
  assertEquals(Array.from(second), Array.from(VIDEO_BYTES.slice(16, 32)));
});

Deno.test("a host that answers a different range is refused", async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers as HeadersInit).get("range");
    if (range === "bytes=0-0") {
      return new Response(null, {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/1024", "Content-Type": "video/mp4" },
      });
    }
    // The host answers a range that was not the one that was asked for.
    return new Response(VIDEO_BYTES.slice(0, 4), {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/1024", "Content-Type": "video/mp4" },
    });
  }) as unknown as typeof fetch;

  const source = await createVideoByteSource({
    url: "https://media.test/video.mp4",
    fetchImpl,
  });

  const error = await assertRejects(() => source.read(10, 19));
  assertStringIncludes(error instanceof Error ? error.message : String(error), "different range");
});

Deno.test("a host that answers the wrong number of bytes is refused", async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers as HeadersInit).get("range");
    if (range === "bytes=0-0") {
      return new Response(null, {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/1024", "Content-Type": "video/mp4" },
      });
    }
    return new Response(VIDEO_BYTES.slice(0, 4), {
      status: 206,
      headers: { "Content-Range": "bytes 10-19/1024", "Content-Type": "video/mp4" },
    });
  }) as unknown as typeof fetch;

  const source = await createVideoByteSource({
    url: "https://media.test/video.mp4",
    fetchImpl,
  });

  const error = await assertRejects(() => source.read(10, 19));
  assertStringIncludes(error instanceof Error ? error.message : String(error), "instead of 10");
});

Deno.test("a video with no bytes is refused", async () => {
  const fetchImpl = (async () =>
    new Response(null, { status: 416 })) as unknown as typeof fetch;

  const error = await assertRejects(() =>
    createVideoByteSource({ url: "https://media.test/video.mp4", fetchImpl })
  );
  assertStringIncludes(error instanceof Error ? error.message : String(error), "empty");
});

Deno.test("a host that cannot be reached is refused", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("connection refused");
  }) as unknown as typeof fetch;

  const error = await assertRejects(() =>
    createVideoByteSource({ url: "https://media.test/video.mp4", fetchImpl })
  );
  assertStringIncludes(error instanceof Error ? error.message : String(error), "could not be read");
});
