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
  // Answering null here would classify the state as unknown. The caller counts a throw
  // as a failed account and still records the poll time so the queue rotates.
  await assertRejects(() =>
    readConnectionState(
      { connectionState: () => Promise.reject(new Error("evolution is down")) },
      "postora_acc-1",
    )
  );
});
