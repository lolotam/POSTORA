import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRefusalLogGate } from "./refusalLog.ts";

Deno.test("a burst of refusals writes one row, and the next row counts the ones held back", () => {
  const gate = createRefusalLogGate(1000);
  assertEquals(gate.admit(0), { write: true, suppressed: 0 });
  assertEquals(gate.admit(10), { write: false });
  assertEquals(gate.admit(999), { write: false });
  assertEquals(gate.admit(1000), { write: true, suppressed: 2 });
  assertEquals(gate.admit(1500), { write: false });
  assertEquals(gate.admit(5000), { write: true, suppressed: 1 });
});
