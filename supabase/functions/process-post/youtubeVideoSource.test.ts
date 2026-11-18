/**
 * Reading the video's bytes, proved against a fake media host.
 *
 * The host here is a script. It can answer a range, ignore a range, answer a
 * range it was not asked for, send more than it announced, or redirect
 * somewhere else. What the tests below prove is that none of those can put
 * the wrong bytes into the upload:
 *
 *   * a range read asks for bytes and gets exactly those bytes;
 *   * a host that answers a different range is refused;
 *   * a host that ignores ranges is read as a stream, and the skip to a
 *     non-zero offset is EXACT even when the blocks land across the offset;
 *   * a host that sends more than it announced is refused, so the worker
 *     never allocates what it did not ask for;
 *   * a host that is not on the approved list never receives a request, and
 *     a redirect to a host that is not on the list is refused too.
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createVideoByteSource, readBoundedBytes, VideoSourceError } from "./youtubeVideoSource.ts";
import { approvedMediaHosts, isApprovedMediaUrl, YOUTUBE_UPLOAD_REASON } from "./youtubeUploadPolicy.ts";

const HOST = "https://media.example.test";
const APPROVED = approvedMediaHosts({ supabaseUrl: "https://api.example.test" });
APPROVED.add("media.example.test");

/** A file of `size` bytes, each byte its own index modulo 251. */
function fileBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

/** A body that arrives in blocks of the given sizes. */
function blockBody(bytes: Uint8Array, blockSizes: number[]): ReadableStream<Uint8Array> {
  let offset = 0;
  let block = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = Math.min(blockSizes[block % blockSizes.length], bytes.length - offset);
      block += 1;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

interface FakeHostOptions {
  /** When false the host answers with the whole file, whatever was asked. */
  ranged?: boolean;
  /** The block sizes the body arrives in. */
  blockSizes?: number[];
  /** The length the host announces. */
  announceLength?: number;
  /** A redirect to answer with instead of the content. */
  redirectTo?: string;
  /** How many bytes are really sent, when it is not the announced length. */
  sendBytes?: number;
}

function fakeHost(options: FakeHostOptions = {}) {
  const ranged = options.ranged !== false;
  const bytes = fileBytes(4096);
  const requests: string[] = [];

  const fetchImpl: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    const headers = new Headers(init?.headers ?? {});
    const range = headers.get("range");

    if (options.redirectTo) {
      return Promise.resolve(new Response("", { status: 302, headers: { Location: options.redirectTo } }));
    }

    if (!ranged || !range) {
      const send = options.sendBytes ?? bytes.length;
      const announce = options.announceLength ?? bytes.length;
      return Promise.resolve(
        new Response(blockBody(bytes.slice(0, send), options.blockSizes ?? [1024]), {
          status: 200,
          headers: { "Content-Length": String(announce), "Content-Type": "video/mp4" },
        }),
      );
    }

    const match = /bytes=(\d+)-(\d+)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : bytes.length - 1;
    const slice = bytes.slice(start, end + 1);
    return Promise.resolve(
      new Response(blockBody(slice, options.blockSizes ?? [1024]), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          "Content-Type": "video/mp4",
        },
      }),
    );
  };

  return { fetchImpl, requests, bytes };
}

Deno.test("a range read asks for the bytes it wants and gets exactly those", async () => {
  const host = fakeHost();
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl: host.fetchImpl,
    approvedHosts: APPROVED,
  });
  assertEquals(source.ranged, true);
  assertEquals(source.size, 4096);

  const bytes = new Uint8Array(await source.read(100, 199));
  assertEquals(bytes.length, 100);
  assertEquals(bytes[0], 100 % 251);
  assertEquals(bytes[99], 199 % 251);
});

Deno.test("a host that answers a different range is refused", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(new Uint8Array(10), {
        status: 206,
        headers: { "Content-Range": "bytes 0-9/4096" },
      }),
    );
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl,
    approvedHosts: APPROVED,
  });
  await assertRejects(() => source.read(100, 199));
});

Deno.test("a host that answers the wrong number of bytes is refused", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(new Uint8Array(10), {
        status: 206,
        headers: { "Content-Range": "bytes 0-99/4096" },
      }),
    );
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl,
    approvedHosts: APPROVED,
  });
  await assertRejects(() => source.read(0, 99));
});

Deno.test("a host that ignores the range is read as a stream", async () => {
  const host = fakeHost({ ranged: false });
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl: host.fetchImpl,
    approvedHosts: APPROVED,
  });
  assertEquals(source.ranged, false);
  const bytes = new Uint8Array(await source.read(0, 99));
  assertEquals(bytes.length, 100);
  assertEquals(bytes[0], 0);
});

Deno.test("the skip to a non-zero offset is exact", async () => {
  const host = fakeHost({ ranged: false, blockSizes: [1024] });
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl: host.fetchImpl,
    approvedHosts: APPROVED,
  });
  const bytes = new Uint8Array(await source.read(1000, 1099));
  assertEquals(bytes.length, 100);
  assertEquals(bytes[0], 1000 % 251);
  assertEquals(bytes[99], 1099 % 251);
});

Deno.test("the skip is exact across irregular block boundaries", async () => {
  // The blocks are 7, 13 and 29 bytes, so the offset falls inside a block
  // most of the time.
  const host = fakeHost({ ranged: false, blockSizes: [7, 13, 29] });
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl: host.fetchImpl,
    approvedHosts: APPROVED,
  });
  for (const offset of [0, 1, 6, 7, 20, 33, 100, 1001]) {
    const bytes = new Uint8Array(await source.read(offset, offset + 49));
    assertEquals(bytes.length, 50, `length at ${offset}`);
    assertEquals(bytes[0], offset % 251, `first byte at ${offset}`);
    assertEquals(bytes[49], (offset + 49) % 251, `last byte at ${offset}`);
  }
});

Deno.test("a fresh non-zero seek receives exact bytes", async () => {
  const host = fakeHost({ ranged: false, blockSizes: [7, 13, 29] });
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl: host.fetchImpl,
    approvedHosts: APPROVED,
  });
  // A seek backwards reopens the stream and skips again.
  await source.read(2000, 2049);
  const bytes = new Uint8Array(await source.read(10, 59));
  assertEquals(bytes.length, 50);
  assertEquals(bytes[0], 10 % 251);
  assertEquals(bytes[49], 59 % 251);
});

Deno.test("rejects a stream block crossing the announced end", async () => {
  for (const actualSize of [1024, 1025]) {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(blockBody(fileBytes(actualSize), [513]), {
          status: 200,
          headers: { "Content-Length": "1024", "Content-Type": "video/mp4" },
        }),
      );
    const source = await createVideoByteSource({ url: `${HOST}/video.mp4`, fetchImpl, approvedHosts: APPROVED });
    if (actualSize === 1024) {
      assertEquals(new Uint8Array(await source.read(0, 1023)), fileBytes(1024));
    } else {
      const error = await assertRejects(() => source.read(0, 1023), VideoSourceError);
      assertEquals(error.detail, "The media host sent more bytes than the video has.");
    }
  }
});

Deno.test("rejects a ranged response for a different object size", async () => {
  const fetchImpl: typeof fetch = (_input, init) => {
    const probe = new Headers(init?.headers).get("range") === "bytes=0-0";
    return Promise.resolve(new Response(new Uint8Array(probe ? 1 : 10), {
      status: 206,
      headers: { "Content-Range": probe ? "bytes 0-0/1024" : "bytes 1-10/2048" },
    }));
  };
  const source = await createVideoByteSource({ url: `${HOST}/video.mp4`, fetchImpl, approvedHosts: APPROVED });
  const error = await assertRejects(() => source.read(1, 10), VideoSourceError);
  assertEquals(error.detail, "The media host answered with a different range than the one that was asked for.");
});

Deno.test("a timed-out streaming read cancels the stream and can reopen", async () => {
  let opened = 0;
  let cancelled = false;
  const fetchImpl: typeof fetch = () => {
    opened++;
    const body = opened === 2
      ? new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })
      : blockBody(fileBytes(1024), [7, 13]);
    return Promise.resolve(new Response(body, { headers: { "Content-Length": "1024" } }));
  };
  const source = await createVideoByteSource({ url: `${HOST}/video.mp4`, fetchImpl, approvedHosts: APPROVED });
  const error = await assertRejects(() => source.read(0, 9, 5), VideoSourceError);
  assertEquals(error.detail, "The media read took longer than this upload is allowed.");
  assertEquals(cancelled, true);
  assertEquals(new Uint8Array(await source.read(0, 9)), fileBytes(10));
});

Deno.test("a read past the size of the video is refused", async () => {
  const host = fakeHost({ ranged: false });
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl: host.fetchImpl,
    approvedHosts: APPROVED,
  });
  await assertRejects(() => source.read(4000, 5000));
});

Deno.test("a body that is longer than the range is refused", async () => {
  const response = new Response(new Uint8Array(50), {
    status: 206,
    headers: { "Content-Range": "bytes 0-9/4096" },
  });
  await assertRejects(() => readBoundedBytes(response, 10));
});

Deno.test("a host outside the approved list never receives a request", async () => {
  const host = fakeHost();
  await assertRejects(() =>
    createVideoByteSource({
      url: "https://elsewhere.example/video.mp4",
      fetchImpl: host.fetchImpl,
      approvedHosts: APPROVED,
    })
  );
  assertEquals(host.requests.length, 0);
});

Deno.test("a redirect to a host outside the approved list is refused", async () => {
  const host = fakeHost({ redirectTo: "https://elsewhere.example/video.mp4" });
  await assertRejects(() =>
    createVideoByteSource({
      url: `${HOST}/video.mp4`,
      fetchImpl: host.fetchImpl,
      approvedHosts: APPROVED,
    })
  );
  assertEquals(host.requests.length, 1);
});

Deno.test("only https is approved", () => {
  assertEquals(isApprovedMediaUrl("https://media.example.test/v.mp4", APPROVED), true);
  assertEquals(isApprovedMediaUrl("http://media.example.test/v.mp4", APPROVED), false);
  assertEquals(isApprovedMediaUrl("https://user:pass@media.example.test/v.mp4", APPROVED), false);
  assertEquals(isApprovedMediaUrl("not a url", APPROVED), false);
});

Deno.test("the approved hosts come from the running configuration", () => {
  const hosts = approvedMediaHosts({
    supabaseUrl: "https://api.example.test",
    cdnOrigins: ["https://cdn.example.test", "not a url", "http://insecure.example.test"],
  });
  assertEquals(hosts.has("api.example.test"), true);
  assertEquals(hosts.has("cdn.example.test"), true);
  assertEquals(hosts.has("insecure.example.test"), false);
  assertEquals(hosts.has("res.cloudinary.com"), true);
});

// ───────────────────────────────────────────────────────────────────────────
// What a failure says
//
// A media read fails for a handful of reasons, and the reason a human needs
// is never the reason the exception happened to carry. A signed media URL is
// a credential, and `fetch` puts the URL it was given into the message of
// the error it raises, so the raw text must not reach the message that the
// public result is built from.
//
// Every host in this section is a script. Nothing here talks to a real site.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a failed read names a stable reason and no URL", async () => {
  const url = `${HOST}/video.mp4?token=secret-signed-token`;
  const fetchImpl: typeof fetch = () =>
    Promise.reject(new TypeError(`fetch failed for ${url}`));

  let thrown: unknown;
  try {
    await createVideoByteSource({ url, fetchImpl, approvedHosts: APPROVED });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof VideoSourceError);
  const failure = thrown as VideoSourceError;
  assertEquals(failure.reason, YOUTUBE_UPLOAD_REASON.media_read_failed);
  // The message is the stable one: it names no host, no path and no token.
  assertEquals(failure.message.includes("secret-signed-token"), false);
  assertEquals(failure.message.includes(HOST), false);
  assertEquals(failure.message.includes("/video.mp4"), false);
  // The detail is for the log line, and the credential is out of it.
  assertEquals(failure.detail.includes("secret-signed-token"), false);
  assert(failure.detail.includes("[redacted-url]"));
});

Deno.test("a provider response body never reaches the message", async () => {
  const body = JSON.stringify({
    error: { message: "the upload_id=abc123secret was refused" },
    access_token: "ya29.secret-token",
  });
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(new Response(body, { status: 500, headers: { "Content-Type": "application/json" } }));

  let thrown: unknown;
  try {
    await createVideoByteSource({
      url: `${HOST}/video.mp4`,
      fetchImpl,
      approvedHosts: APPROVED,
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof VideoSourceError);
  const failure = thrown as VideoSourceError;
  assertEquals(failure.reason, YOUTUBE_UPLOAD_REASON.media_read_failed);
  assertEquals(failure.message.includes("abc123secret"), false);
  assertEquals(failure.message.includes("ya29.secret-token"), false);
  assertEquals(failure.detail.includes("abc123secret"), false);
  assertEquals(failure.detail.includes("ya29.secret-token"), false);
});

Deno.test("a host that answers the wrong status names a stable reason", async () => {
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response("", { status: 500 }));

  let thrown: unknown;
  try {
    await createVideoByteSource({
      url: `${HOST}/video.mp4`,
      fetchImpl,
      approvedHosts: APPROVED,
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof VideoSourceError);
  const failure = thrown as VideoSourceError;
  assertEquals(failure.reason, YOUTUBE_UPLOAD_REASON.media_read_failed);
  // The status is in the detail, which is for the log.
  assert(failure.detail.includes("500"));
  assertEquals(failure.message.includes("500"), false);
});

Deno.test("a host outside the approved list names its own reason", async () => {
  const host = fakeHost();
  let thrown: unknown;
  try {
    await createVideoByteSource({
      url: "https://elsewhere.example/video.mp4?token=secret",
      fetchImpl: host.fetchImpl,
      approvedHosts: APPROVED,
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof VideoSourceError);
  const failure = thrown as VideoSourceError;
  assertEquals(failure.reason, YOUTUBE_UPLOAD_REASON.media_origin_not_approved);
  assertEquals(failure.message.includes("secret"), false);
  assertEquals(host.requests.length, 0);
});

Deno.test("a read that fails mid-stream keeps the stable reason", async () => {
  // The probe is answered, but the range read is answered with a DIFFERENT
  // range. The read is refused, and the refusal names the protocol's reason.
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(new Uint8Array(10), {
        status: 206,
        headers: { "Content-Range": "bytes 0-9/4096" },
      }),
    );
  const source = await createVideoByteSource({
    url: `${HOST}/video.mp4`,
    fetchImpl,
    approvedHosts: APPROVED,
  });

  let thrown: unknown;
  try {
    await source.read(100, 199);
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof VideoSourceError);
  assertEquals((thrown as VideoSourceError).reason, YOUTUBE_UPLOAD_REASON.media_read_failed);
});
