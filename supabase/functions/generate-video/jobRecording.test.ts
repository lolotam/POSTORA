// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { insertWithOneRetry, shouldReleaseReservation } from "./jobRecording.ts";

Deno.test("a reservation is released only when the generation was never dispatched", () => {
  assertEquals(shouldReleaseReservation({ reserved: true, dispatched: false }), true);
  assertEquals(shouldReleaseReservation({ reserved: true, dispatched: true }), false);
  assertEquals(shouldReleaseReservation({ reserved: false, dispatched: false }), false);
  assertEquals(shouldReleaseReservation({ reserved: false, dispatched: true }), false);
});

Deno.test("a failed job insert is retried once and the retry's row is returned", async () => {
  const results = [{ data: null, error: { message: "timeout" } }, { data: { id: "job-1" }, error: null }];
  let calls = 0;
  const result = await insertWithOneRetry(() => Promise.resolve(results[calls++]));
  assertEquals(calls, 2);
  assertEquals(result, { data: { id: "job-1" }, error: null });
});

Deno.test("a job insert that fails twice returns the last error without a third attempt", async () => {
  let calls = 0;
  const result = await insertWithOneRetry(() => {
    calls++;
    return Promise.resolve({ data: null, error: { message: `fail ${calls}` } });
  });
  assertEquals(calls, 2);
  assertEquals(result.error, { message: "fail 2" });
});

Deno.test("a thrown insert is retried and reported as an error, not rethrown", async () => {
  let calls = 0;
  const result = await insertWithOneRetry<{ id: string }>(() => {
    calls++;
    return Promise.reject(new Error("socket closed"));
  });
  assertEquals(calls, 2);
  assertEquals(result, { data: null, error: { message: "socket closed" } });
});

Deno.test("a successful first insert is not repeated", async () => {
  let calls = 0;
  await insertWithOneRetry(() => {
    calls++;
    return Promise.resolve({ data: { id: "job-1" }, error: null });
  });
  assertEquals(calls, 1);
});
