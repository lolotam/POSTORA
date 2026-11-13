import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { withWatchLease } from "./lease.ts";

Deno.test("overlapping watchers cannot apply conflicting observations", async () => {
  let held = false;
  let observations = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const lease = {
    acquire: () => {
      if (held) return Promise.resolve(false);
      held = true;
      return Promise.resolve(true);
    },
    release: () => { held = false; return Promise.resolve(); },
  };
  const first = withWatchLease(lease, async () => { observations += 1; await pending; return "first"; });
  await Promise.resolve();
  assertEquals(await withWatchLease(lease, () => { observations += 1; return Promise.resolve("second"); }), null);
  finish();
  assertEquals(await first, "first");
  assertEquals(observations, 1);
  assertEquals(await withWatchLease(lease, () => Promise.resolve("next")), "next");
});

Deno.test("a failed watcher releases its lease so the next run can retry", async () => {
  let released = false;
  await assertRejects(() => withWatchLease({
    acquire: () => Promise.resolve(true),
    release: () => { released = true; return Promise.resolve(); },
  }, () => Promise.reject(new Error("read failed"))));
  assertEquals(released, true);
});
