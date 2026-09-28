import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runMediaRetention, type ClaimedMediaFile, type RetentionPorts } from "./run.ts";

const file = (id: string): ClaimedMediaFile => ({
  media_file_id: id,
  user_id: "user-1",
  file_type: "image",
  cloudinary_public_id: null,
  file_path: "unused",
});

function ports(overrides: Partial<RetentionPorts> = {}): RetentionPorts & {
  calls: string[];
  releases: Array<[string, boolean]>;
  removed: string[];
  deleted: string[];
  logged: unknown[];
} {
  const calls: string[] = [];
  const releases: Array<[string, boolean]> = [];
  const removed: string[] = [];
  const deleted: string[] = [];
  const logged: unknown[] = [];
  const base: RetentionPorts = {
    sweep: async () => {
      calls.push("sweep");
      return [{ phase: "cleared", count: 1 }, { phase: "warned", count: 2 }];
    },
    claim: async () => {
      calls.push("claim");
      return [];
    },
    release: async (id, failed) => {
      releases.push([id, failed]);
    },
    preview: async () => {
      calls.push("preview");
      return [];
    },
    readDeleteEnabled: async () => {
      calls.push("readDeleteEnabled");
      return true;
    },
    loadProviders: async () => ({ rows: [] }),
    deleteFile: async (claimed) => {
      deleted.push(claimed.media_file_id);
      return { confirmed: true };
    },
    removeMediaRow: async (id) => {
      removed.push(id);
      return {};
    },
    logRun: async (entry) => {
      logged.push(entry);
    },
  };
  return { calls, releases, removed, deleted, logged, ...base, ...overrides };
}

Deno.test("warn-only mode sweeps and deletes nothing", async () => {
  const fake = ports({
    readDeleteEnabled: async () => false,
    claim: async () => {
      throw new Error("claim must not run when deletion is off");
    },
  });
  const report = await runMediaRetention({ dryRun: false, ports: fake });
  assertEquals(report.result.deleted, 0);
  assertEquals(report.deleteEnabled, false);
  assertEquals(fake.deleted, []);
  assertEquals(fake.removed, []);
  assertEquals(fake.calls.includes("sweep"), true);
  assertEquals((fake.logged[0] as { delete_enabled: boolean }).delete_enabled, false);
});

Deno.test("claimed files are deleted and only confirmed rows are removed", async () => {
  const fake = ports({
    claim: async () => [file("ok"), file("nope")],
    deleteFile: async (claimed) => ({ confirmed: claimed.media_file_id === "ok" }),
  });
  const report = await runMediaRetention({ dryRun: false, ports: fake });
  assertEquals(fake.removed, ["ok"]);
  assertEquals(fake.releases, [["nope", true]]);
  assertEquals(report.result.deleted, 1);
  assertEquals(report.result.failed, 1);
  assertEquals(report.filesToDelete, []);
});

Deno.test("a failed provider delete calls release(id, true) and keeps the row", async () => {
  const fake = ports({
    claim: async () => [file("bad")],
    loadProviders: async () => ({ error: "lookup failed" }),
    deleteFile: async () => {
      throw new Error("must not delete when the provider read fails");
    },
  });
  await runMediaRetention({ dryRun: false, ports: fake });
  assertEquals(fake.releases, [["bad", true]]);
  assertEquals(fake.removed, []);

  const thrown = ports({
    claim: async () => [file("boom")],
    deleteFile: async () => {
      throw new Error("provider down");
    },
  });
  await runMediaRetention({ dryRun: false, ports: thrown });
  assertEquals(thrown.releases, [["boom", true]]);
  assertEquals(thrown.removed, []);
});

Deno.test("dryRun makes no writes", async () => {
  const fake = ports({
    preview: async () => [
      { media_file_id: "a", user_id: "u", action: "would_warn" },
      { media_file_id: "b", user_id: "u", action: "due" },
    ],
    sweep: async () => { throw new Error("sweep is a write"); },
    claim: async () => { throw new Error("claim is a write"); },
    release: async () => { throw new Error("release is a write"); },
    deleteFile: async () => { throw new Error("delete is a write"); },
    removeMediaRow: async () => { throw new Error("remove is a write"); },
    logRun: async () => { throw new Error("log is a write"); },
  });
  const report = await runMediaRetention({ dryRun: true, ports: fake });
  assertEquals(report.result, { warned: 1, due: 1, deleted: 0, failed: 0, backlog: 1 });
  assertEquals(report.filesToDelete, [
    { id: "a", action: "would_warn" },
    { id: "b", action: "due" },
  ]);
  assertEquals(fake.logged, []);
});

Deno.test("the budget stops new claims", async () => {
  let clock = 0;
  let claims = 0;
  const fake = ports({
    claim: async () => {
      claims += 1;
      return [file("first"), file("second")];
    },
    deleteFile: async () => {
      clock = 40_000;
      return { confirmed: true };
    },
    preview: async () => [{ media_file_id: "second", user_id: "u", action: "due" }],
  });
  const report = await runMediaRetention({
    dryRun: false,
    ports: fake,
    now: () => clock,
  });
  assertEquals(claims, 1);
  assertEquals(fake.removed, ["first"]);
  assertEquals(fake.releases, [["second", false]]);
  assertEquals(report.result.backlog, 1);
  const log = fake.logged[0] as Record<string, unknown>;
  assertEquals(Object.keys(log).sort(), ["backlog", "claimed", "cleared", "delete_enabled", "deleted", "failed", "warned"]);
});
