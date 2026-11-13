import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readConnectionState } from "./stateReader.ts";

Deno.test("the state is read out of the Evolution payload", async () => {
  const state = await readConnectionState(
    { connectionState: () => Promise.resolve({ instance: { state: "open" } }) },
    "postora_acc-1",
  );

  assertEquals(state, "open");
});

Deno.test("a read that cannot be answered is a failure, not a state", async () => {
  // Answering null here would record the account as polled and skip it, and an outage
  // behind an unreachable Evolution would go unnoticed.
  await assertRejects(() =>
    readConnectionState(
      { connectionState: () => Promise.reject(new Error("evolution is down")) },
      "postora_acc-1",
    )
  );
});
