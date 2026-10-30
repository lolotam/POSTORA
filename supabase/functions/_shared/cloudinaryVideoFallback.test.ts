import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CloudinaryCredentials, deriveWithCloudinary } from "./cloudinaryVideoFallback.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";

const credentials: CloudinaryCredentials = { cloudName: "demo", apiKey: "test-id", apiSecret: "test-value" };
const base = { credentials, publicId: "legacy/id", deliveryUrl: null, label: "crop", transformation: "c_fill,w_720,h_1280/vc_h264,f_mp4" };

function network(response: Response) {
  const calls: { url: string; form: FormData }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), form: init?.body as FormData });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test("a signed upload with the eager transformation returns the eager URL", async () => {
  const net = network(new Response(JSON.stringify({ public_id: "postora_crop_x", eager: [{ secure_url: "https://res.cloudinary.com/demo/eager.mp4" }] })));
  const result = await deriveWithCloudinary({ ...base, fetchImpl: net.fetchImpl });
  assertEquals(result, { publicId: "postora_crop_x", url: "https://res.cloudinary.com/demo/eager.mp4", bytes: null });
  assertEquals(net.calls[0].url, "https://api.cloudinary.com/v1_1/demo/video/upload");
  const form = net.calls[0].form;
  assertEquals(form.get("file"), "https://res.cloudinary.com/demo/video/upload/legacy/id");
  assertEquals(form.get("eager"), base.transformation);
  assertEquals(form.get("eager_async"), "false");
  assertEquals(form.get("api_key"), "test-id");
  assert(/^[0-9a-f]{40}$/.test(String(form.get("signature"))), "SHA-1 signature");
  assert(String(form.get("public_id")).startsWith("postora_crop_"));
});

Deno.test("a stored Cloudinary delivery URL is fetched as is", async () => {
  const net = network(new Response(JSON.stringify({ public_id: "p", eager: [{ secure_url: "https://x/e.mp4" }] })));
  await deriveWithCloudinary({ ...base, deliveryUrl: "https://res.cloudinary.com/demo/video/upload/v9/legacy/id.mp4", fetchImpl: net.fetchImpl });
  assertEquals(net.calls[0].form.get("file"), "https://res.cloudinary.com/demo/video/upload/v9/legacy/id.mp4");
});

Deno.test("a disabled cloud is reported as an unavailable provider, not as the raw provider message", async () => {
  const net = network(new Response(JSON.stringify({ error: { message: "cloud_name is disabled" } }), { status: 401 }));
  const error = await assertRejects(() => deriveWithCloudinary({ ...base, fetchImpl: net.fetchImpl }), OpeninaryVideoError);
  assertEquals(error.code, "PROVIDER_UNAVAILABLE");
  assertEquals(error.status, 503);
  assert(!error.message.includes("cloud_name"));
});

Deno.test("missing credentials are an unavailable provider and nothing is sent", async () => {
  const net = network(new Response("{}"));
  const error = await assertRejects(() => deriveWithCloudinary({ ...base, credentials: null, fetchImpl: net.fetchImpl }), OpeninaryVideoError);
  assertEquals(error.code, "PROVIDER_UNAVAILABLE");
  assertEquals(net.calls.length, 0);
});

Deno.test("other Cloudinary errors are a failed transform with a generic message", async () => {
  const net = network(new Response(JSON.stringify({ error: { message: "Invalid transformation: private detail" } }), { status: 400 }));
  const error = await assertRejects(() => deriveWithCloudinary({ ...base, fetchImpl: net.fetchImpl }), OpeninaryVideoError);
  assertEquals(error.code, "TRANSFORM_FAILED");
  assert(!error.message.includes("private detail"));
});

Deno.test("an oversized source maps to its own code", async () => {
  const net = network(new Response(JSON.stringify({ error: { message: "File size too large. Got 120000000" } }), { status: 400 }));
  const error = await assertRejects(() => deriveWithCloudinary({ ...base, fetchImpl: net.fetchImpl }), OpeninaryVideoError);
  assertEquals(error.code, "SOURCE_TOO_LARGE");
});

Deno.test("a network failure is an unavailable provider", async () => {
  const fetchImpl = (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch;
  const error = await assertRejects(() => deriveWithCloudinary({ ...base, fetchImpl }), OpeninaryVideoError);
  assertEquals(error.code, "PROVIDER_UNAVAILABLE");
});

Deno.test("the eager rendition's own byte count is returned when Cloudinary reports it", async () => {
  const reported = network(new Response(JSON.stringify({ public_id: "p", eager: [{ secure_url: "https://x/e.mp4", bytes: 123456 }] })));
  assertEquals((await deriveWithCloudinary({ ...base, fetchImpl: reported.fetchImpl })).bytes, 123456);
  const missing = network(new Response(JSON.stringify({ public_id: "p", eager: [{ secure_url: "https://x/e.mp4" }] })));
  assertEquals((await deriveWithCloudinary({ ...base, fetchImpl: missing.fetchImpl })).bytes, null);
  const junk = network(new Response(JSON.stringify({ public_id: "p", eager: [{ secure_url: "https://x/e.mp4", bytes: "big" }] })));
  assertEquals((await deriveWithCloudinary({ ...base, fetchImpl: junk.fetchImpl })).bytes, null);
});
