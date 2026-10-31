import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { graphId } from "./graphResponse.ts";

Deno.test("graphId returns the id Meta gave the created container", () => {
  assertEquals(graphId({ id: "17890000000000001" }, "Instagram image container"), "17890000000000001");
});

Deno.test("a reply with no id, or an empty one, is an error naming the container instead of 'undefined'", () => {
  for (const reply of [{}, { id: "" }, { id: 123 as unknown as string }, { success: true }]) {
    assertThrows(() => graphId(reply, "Instagram carousel container"), Error, "Instagram carousel container: Meta returned no id");
  }
});
