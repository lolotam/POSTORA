import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MAX_PER_RUN, PENDING_MAX_AGE_MS, runSweep, type SweepPorts } from "./run.ts";

const NOW = Date.parse("2026-11-12T18:00:00Z");

function fakePorts(ids: string[], stillPending: Set<string>, failing = new Set<string>()) {
  const listed: Array<{ cutoff: string; limit: number }> = [];
  const deleted: string[] = [];
  const ports: SweepPorts = {
    listStalePending: (cutoff, limit) => {
      listed.push({ cutoff, limit });
      return Promise.resolve(ids);
    },
    findInstanceName: (id) => Promise.resolve(`postora_${id}`),
    deleteIfPending: (id, ownerId) => {
      if (failing.has(id)) return Promise.reject(new Error("db down"));
      assertEquals(ownerId, null);
      if (!stillPending.has(id)) return Promise.resolve(false);
      deleted.push(id);
      return Promise.resolve(true);
    },
    deleteEvolutionInstance: () => Promise.resolve(),
    log: () => Promise.resolve(),
  };
  return { ports, listed, deleted };
}

Deno.test("attempts older than the cutoff are removed, and one paired meanwhile is kept", async () => {
  const fake = fakePorts(["a", "b"], new Set(["a"]));

  const summary = await runSweep(fake.ports, () => NOW);

  assertEquals(fake.listed, [{ cutoff: new Date(NOW - PENDING_MAX_AGE_MS).toISOString(), limit: MAX_PER_RUN }]);
  assertEquals(fake.deleted, ["a"]);
  assertEquals(summary, { listed: 2, deleted: 1, kept: 1, evolution_errors: 0, errors: 0 });
});

Deno.test("one failing row does not stop the rest of the batch", async () => {
  const fake = fakePorts(["a", "b"], new Set(["a", "b"]), new Set(["a"]));

  const summary = await runSweep(fake.ports, () => NOW);

  assertEquals(fake.deleted, ["b"]);
  assertEquals(summary, { listed: 2, deleted: 1, kept: 0, evolution_errors: 0, errors: 1 });
});
