import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

type HandleNumberMismatchFn = (
  api: any,
  input: { instanceName: string },
) => Promise<void>;

async function loadHandleNumberMismatch(): Promise<HandleNumberMismatchFn> {
  const mod = await import("./numberMismatch.ts");
  return (mod as any).handleNumberMismatch;
}

function fakeApi(options: { logoutError?: unknown } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api = {
    calls,
    logout: (...args: unknown[]) => {
      calls.push({ method: "logout", args });
      if (options.logoutError) return Promise.reject(options.logoutError);
      return Promise.resolve({ status: "SUCCESS" });
    },
  };
  return api;
}

Deno.test("handleNumberMismatch: calls api.logout once with instanceName", async () => {
  const handleNumberMismatch = await loadHandleNumberMismatch();
  const api = fakeApi();

  await handleNumberMismatch(api, {
    instanceName: "postora_acc-1",
  });

  const logoutCalls = api.calls.filter((c) => c.method === "logout");
  assertEquals(logoutCalls.length, 1);
  assertEquals(logoutCalls[0].args, ["postora_acc-1"]);
});

Deno.test("handleNumberMismatch: swallows logout error without throwing", async () => {
  const handleNumberMismatch = await loadHandleNumberMismatch();
  const api = fakeApi({ logoutError: new Error("network failure") });

  await handleNumberMismatch(api, {
    instanceName: "postora_acc-1",
  });

  const logoutCalls = api.calls.filter((c) => c.method === "logout");
  assertEquals(logoutCalls.length, 1);
  assertEquals(logoutCalls[0].args, ["postora_acc-1"]);
});

