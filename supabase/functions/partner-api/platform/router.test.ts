// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseRoutes } from "../../../../scripts/generate-agent-context.ts";
import { handleV1Request } from "../v1/router.ts";
import { PLATFORM_ACTION_RISK } from "./policy.ts";

Deno.test("every platform route publishes a literal risk matching policy", async () => {
  const source = await Deno.readTextFile(new URL("./router.ts", import.meta.url));
  const routes = parseRoutes(source);
  assertEquals(routes.length, 5, "computed risks must not silently disappear from the published bundle");
  assertEquals(Object.fromEntries(routes.map((route) => [route.action, route.riskClass])), PLATFORM_ACTION_RISK);
});

Deno.test("platform method refusals share 405 and Allow without constructing a client", async () => {
  const res = await handleV1Request(new Request("https://x/v1/platform/workspaces", { method: "PATCH" }),
    "/v1/platform/workspaces", "router-test", () => { throw new Error("must not construct client"); });
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Allow"), "POST, GET");
  assertEquals(res.headers.get("X-Postora-Request-Id"), "router-test");
});
