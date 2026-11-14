import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { serveHealthRequest } from "./serve.ts";

Deno.test("startup failures retain restricted CORS and hide initialization diagnostics", async () => {
  const req = new Request("https://edge.example.test", { headers: { origin: "https://postora.cloud" } });
  const res = await serveHealthRequest(req, async () => { throw new Error("private initialization diagnostics"); });
  assertEquals(res.status, 500);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://postora.cloud");
  assert(!(await res.text()).includes("private"));
});
