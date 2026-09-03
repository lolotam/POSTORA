import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { ComposioError } from "./composioClient.ts";
import { md5Hex, uploadFileForTool } from "./composioFiles.ts";

const BYTES = new TextEncoder().encode("hello composio");

Deno.test("md5Hex matches the well-known digest of the bytes", async () => {
  assertEquals(await md5Hex(new TextEncoder().encode("")), "d41d8cd98f00b204e9800998ecf8427e");
});

Deno.test("uploadFileForTool requests a slot with the md5, PUTs the bytes with only Content-Type, and returns the s3key", async () => {
  const requests: unknown[] = [];
  const puts: Array<{ url: string; init: RequestInit }> = [];
  const client = {
    requestFileUpload: (input: unknown) => {
      requests.push(input);
      return Promise.resolve({ key: "250199/youtube/TOOL/request/abc", presignedUrl: "https://r2.example/put?X-Amz-Signature=s" });
    },
  };
  const uploaded = await uploadFileForTool(client, {
    toolkit: "youtube",
    tool: "YOUTUBE_MULTIPART_UPLOAD_VIDEO",
    filename: "short.mp4",
    mimetype: "video/mp4",
    bytes: BYTES,
    signal: new AbortController().signal,
  }, {
    fetch: (url, init) => {
      puts.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });

  assertEquals(requests[0], {
    toolkit: "youtube",
    tool: "YOUTUBE_MULTIPART_UPLOAD_VIDEO",
    filename: "short.mp4",
    mimetype: "video/mp4",
    md5: await md5Hex(BYTES),
  });
  assertEquals(puts[0].url, "https://r2.example/put?X-Amz-Signature=s");
  assertEquals(puts[0].init.method, "PUT");
  assertEquals(puts[0].init.headers, { "content-type": "video/mp4" });
  assertEquals(uploaded, { name: "short.mp4", mimetype: "video/mp4", s3key: "250199/youtube/TOOL/request/abc" });
});

Deno.test("a refused presigned PUT surfaces as a Composio rejection with its status", async () => {
  const client = {
    requestFileUpload: () => Promise.resolve({ key: "k", presignedUrl: "https://r2.example/put" }),
  };
  const error = await assertRejects(
    () =>
      uploadFileForTool(client, {
        toolkit: "youtube",
        tool: "YOUTUBE_MULTIPART_UPLOAD_VIDEO",
        filename: "short.mp4",
        mimetype: "video/mp4",
        bytes: BYTES,
        signal: new AbortController().signal,
      }, { fetch: () => Promise.resolve(new Response("denied", { status: 403 })) }),
    ComposioError,
  );
  assertEquals(error.code, "composio_rejected");
  assertEquals(error.status, 403);
});
