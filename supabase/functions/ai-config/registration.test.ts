import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { stub } from "https://deno.land/std@0.208.0/testing/mock.ts";

Deno.test("an imported worker entrypoint registers its production handler", async () => {
  const registration = stub(Deno, "serve");
  try {
    await import("./index.ts");
    const { handleAiConfigRequest } = await import("./handler.ts");
    assertEquals(registration.calls.length, 1);
    assertEquals<unknown>(registration.calls[0].args[0], handleAiConfigRequest);
  } finally {
    registration.restore();
  }
});
