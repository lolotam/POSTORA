import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { discardPendingQrAccount, type PendingQrCleanupPorts } from "./pendingQrCleanup.ts";

type Logged = { level: string; message: string; metadata: Record<string, unknown> };

function fakePorts(options: {
  instanceName?: string | null;
  pending?: boolean;
  evolutionFails?: boolean;
}) {
  const evolutionDeletes: string[] = [];
  const deleteCalls: Array<{ accountId: string; ownerId: string | null }> = [];
  const logs: Logged[] = [];
  const ports: PendingQrCleanupPorts = {
    findInstanceName: () => Promise.resolve(options.instanceName ?? null),
    deleteIfPending: (accountId, ownerId) => {
      deleteCalls.push({ accountId, ownerId });
      return Promise.resolve(options.pending ?? true);
    },
    deleteEvolutionInstance: (name) => {
      if (options.evolutionFails) return Promise.reject(new Error("Evolution unreachable"));
      evolutionDeletes.push(name);
      return Promise.resolve();
    },
    log: (level, message, metadata) => {
      logs.push({ level, message, metadata });
      return Promise.resolve();
    },
  };
  return { ports, evolutionDeletes, deleteCalls, logs };
}

Deno.test("an unpaired attempt loses its row and its Evolution session, and the reason is logged", async () => {
  const fake = fakePorts({ instanceName: "postora_acc-1" });

  const result = await discardPendingQrAccount(fake.ports, { accountId: "acc-1", ownerId: "user-1", reason: "abandoned" });

  assertEquals(result, { deleted: true });
  assertEquals(fake.deleteCalls, [{ accountId: "acc-1", ownerId: "user-1" }]);
  assertEquals(fake.evolutionDeletes, ["postora_acc-1"]);
  assertEquals(fake.logs.map((l) => [l.level, l.metadata.reason]), [["info", "abandoned"]]);
});

Deno.test("an account that is no longer a pending attempt keeps its Evolution session and logs nothing", async () => {
  const fake = fakePorts({ instanceName: "postora_acc-1", pending: false });

  const result = await discardPendingQrAccount(fake.ports, { accountId: "acc-1", ownerId: "user-1", reason: "abandoned" });

  assertEquals(result, { deleted: false });
  assertEquals(fake.evolutionDeletes, []);
  assertEquals(fake.logs, []);
});

Deno.test("an Evolution failure after the rows are gone is reported as a warning, not thrown", async () => {
  const fake = fakePorts({ instanceName: "postora_acc-1", evolutionFails: true });

  const result = await discardPendingQrAccount(fake.ports, { accountId: "acc-1", ownerId: null, reason: "expired" });

  assertEquals(result, { deleted: true, evolutionError: "Evolution unreachable" });
  assertEquals(fake.logs.map((l) => [l.level, l.metadata.evolution_error]), [["warn", "Evolution unreachable"]]);
});
