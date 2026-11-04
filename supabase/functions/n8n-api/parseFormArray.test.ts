import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseFormArray } from "./requestBody.ts";

Deno.test("parseFormArray keeps numeric usernames as text, in JSON arrays and as scalars", () => {
  assertEquals(parseFormArray("[1234]"), ["1234"]);
  assertEquals(parseFormArray('["a", 5678]'), ["a", "5678"]);
  assertEquals(parseFormArray("1234"), ["1234"]);
  assertEquals(parseFormArray("a, b"), ["a", "b"]);
  assertEquals(parseFormArray("[9007199254740992]"), ["9007199254740992"]);
  assertEquals(parseFormArray("[12345678901234567890]"), ["12345678901234567890"]);
});
