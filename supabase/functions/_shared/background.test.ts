import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runInBackground } from "./background.ts";

Deno.test("runInBackground returns before the background callback settles", async () => {
  let release: (() => void) | undefined;
  let started = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });

  runInBackground("test", async () => {
    started = true;
    await pending;
  });

  await Promise.resolve();
  assertEquals(started, true);
  release?.();
});
