import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { revokeTikTokAccess } from "./tiktokRevoke.ts";

function fetcherReturning(status: number, body: string, seen: Request[] = []): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
}

Deno.test("posts the app credentials and the user's token, form-encoded, to TikTok's revoke endpoint", async () => {
  const seen: Request[] = [];
  const revoked = await revokeTikTokAccess(fetcherReturning(200, "", seen), "key", "secret", "act.123");
  assertEquals(revoked, true);
  assertEquals(seen[0]?.url, "https://open.tiktokapis.com/v2/oauth/revoke/");
  assertEquals(seen[0]?.method, "POST");
  assertEquals(await seen[0]?.text(), "client_key=key&client_secret=secret&token=act.123");
});

Deno.test("treats an ok error code as revoked and any other code or HTTP failure as not revoked", async () => {
  assertEquals(await revokeTikTokAccess(fetcherReturning(200, '{"error":{"code":"ok"}}'), "k", "s", "t"), true);
  assertEquals(await revokeTikTokAccess(fetcherReturning(200, '{"error":{"code":"access_token_invalid"}}'), "k", "s", "t"), false);
  assertEquals(await revokeTikTokAccess(fetcherReturning(500, ""), "k", "s", "t"), false);
});

Deno.test("never throws when TikTok is unreachable or answers garbage", async () => {
  const failing = (() => Promise.reject(new Error("network down"))) as typeof fetch;
  assertEquals(await revokeTikTokAccess(failing, "k", "s", "t"), false);
  assertEquals(await revokeTikTokAccess(fetcherReturning(200, "<html>"), "k", "s", "t"), false);
});

Deno.test("treats TikTok's flat OAuth error body as a failed revoke", async () => {
  const flat = fetcherReturning(200, '{"error":"invalid_client","error_description":"x"}');
  assertEquals(await revokeTikTokAccess(flat, "k", "s", "t"), false);
});

Deno.test("bounds the revoke request with an abort signal and reports failure when it is aborted", async () => {
  const seen: RequestInit[] = [];
  const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError"))
      );
    });
  }) as typeof fetch;

  const pending = revokeTikTokAccess(hanging, "k", "s", "t");
  assertEquals(seen[0]?.signal instanceof AbortSignal, true);
  // The real timeout fires after 5s; fire the same event here so the test stays fast.
  seen[0]?.signal?.dispatchEvent(new Event("abort"));
  assertEquals(await pending, false);
});

Deno.test("reports a failed revoke when the request times out", async () => {
  const timingOut = (() =>
    Promise.reject(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    )) as typeof fetch;
  assertEquals(await revokeTikTokAccess(timingOut, "k", "s", "t"), false);
});
