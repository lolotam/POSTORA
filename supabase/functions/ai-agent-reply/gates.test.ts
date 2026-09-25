import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluateGates } from "./logic.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

Deno.test("evaluateGates starts every check before any of them resolves", async () => {
  const started: string[] = [];
  const withinServiceWindow = deferred<boolean>();
  const humanAssignedAndOnline = deferred<boolean>();
  const cooldownActive = deferred<boolean>();
  const dailyCapReached = deferred<boolean>();

  const pending = evaluateGates({
    withinServiceWindow: () => {
      started.push("withinServiceWindow");
      return withinServiceWindow.promise;
    },
    humanAssignedAndOnline: () => {
      started.push("humanAssignedAndOnline");
      return humanAssignedAndOnline.promise;
    },
    cooldownActive: () => {
      started.push("cooldownActive");
      return cooldownActive.promise;
    },
    dailyCapReached: () => {
      started.push("dailyCapReached");
      return dailyCapReached.promise;
    },
  });

  assertEquals(started, [
    "withinServiceWindow",
    "humanAssignedAndOnline",
    "cooldownActive",
    "dailyCapReached",
  ]);

  withinServiceWindow.resolve(true);
  humanAssignedAndOnline.resolve(false);
  cooldownActive.resolve(true);
  dailyCapReached.resolve(false);

  assertEquals(await pending, {
    withinServiceWindow: true,
    humanAssignedAndOnline: false,
    cooldownActive: true,
    dailyCapReached: false,
  });
});

Deno.test("evaluateGates propagates a rejection from any check", async () => {
  const hang = deferred<boolean>();
  await assertRejects(
    () =>
      evaluateGates({
        withinServiceWindow: () => Promise.resolve(true),
        humanAssignedAndOnline: () => Promise.reject(new Error("assigned lookup failed")),
        cooldownActive: () => hang.promise,
        dailyCapReached: () => Promise.resolve(false),
      }),
    Error,
    "assigned lookup failed",
  );
  hang.resolve(false);
});
