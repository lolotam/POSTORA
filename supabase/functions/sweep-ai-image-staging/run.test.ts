import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { OpeninaryFile } from "../_shared/openinary.ts";
import { runSweep, STAGING_MAX_AGE_MS, type SweepPorts, userFolderPaths } from "./run.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const ROOT = "postora.cloud/postora";
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const staged = (user: string, name: string, mtime?: string): OpeninaryFile => ({ name, path: `${ROOT}/${user}/ai-tmp/${name}`, size: 10, mtime });

function ports(options: {
  folders?: string[] | Error;
  staged?: Record<string, OpeninaryFile[] | Error>;
  removeErrors?: Record<string, string>;
} = {}) {
  const removed: string[] = [];
  const logs: { level: string; message: string; metadata: Record<string, unknown> }[] = [];
  const fake: SweepPorts = {
    listUserFolders: () => options.folders instanceof Error ? Promise.reject(options.folders) : Promise.resolve(options.folders ?? []),
    listStaged: (folder) => {
      const files = options.staged?.[folder] ?? [];
      return files instanceof Error ? Promise.reject(files) : Promise.resolve(files);
    },
    remove: (path) => {
      const error = options.removeErrors?.[path];
      if (error) return Promise.resolve({ success: false, error });
      removed.push(path);
      return Promise.resolve({ success: true });
    },
    log: (level, message, metadata) => {
      logs.push({ level, message, metadata });
      return Promise.resolve();
    },
  };
  return { fake, removed, logs };
}

Deno.test("only copies older than the token lifetime plus margin are deleted", async () => {
  const old = staged("u1", "old.png", ago(STAGING_MAX_AGE_MS + 1000));
  const fresh = staged("u1", "fresh.png", ago(STAGING_MAX_AGE_MS - 1000));
  const { fake, removed, logs } = ports({ folders: [`${ROOT}/u1`], staged: { [`${ROOT}/u1`]: [old, fresh] } });

  const summary = await runSweep(fake, { now: () => NOW });

  assertEquals(removed, [old.path]);
  assertEquals({ deleted: summary.deleted, kept_fresh: summary.kept_fresh, incomplete: summary.incomplete }, { deleted: 1, kept_fresh: 1, incomplete: false });
  assertEquals(logs.map((l) => l.level), ["info"]);
});

Deno.test("a quiet run (nothing expired) writes no log row", async () => {
  const { fake, logs } = ports({ folders: [`${ROOT}/u1`], staged: { [`${ROOT}/u1`]: [staged("u1", "a.png", ago(60_000))] } });
  await runSweep(fake, { now: () => NOW });
  assertEquals(logs, []);
});

Deno.test("a failed root listing is an error, not an empty store: nothing is deleted", async () => {
  const { fake, removed } = ports({ folders: new Error("Openinary listing failed: 502") });
  await assertRejects(() => runSweep(fake, { now: () => NOW }), Error, "502");
  assertEquals(removed, []);
});

Deno.test("a failed user listing is logged and the other users are still swept", async () => {
  const old = staged("u2", "old.png", ago(STAGING_MAX_AGE_MS * 2));
  const { fake, removed, logs } = ports({
    folders: [`${ROOT}/u1`, `${ROOT}/u2`],
    staged: { [`${ROOT}/u1`]: new Error("Openinary listing failed: 500"), [`${ROOT}/u2`]: [old] },
  });

  const summary = await runSweep(fake, { now: () => NOW });

  assertEquals(removed, [old.path]);
  assertEquals(summary.list_errors, 1);
  assertEquals(logs[0].level, "error");
  assertEquals(logs[0].metadata.failures, [{ path: `${ROOT}/u1/ai-tmp`, error: "Openinary listing failed: 500" }]);
});

Deno.test("a failed delete is counted and logged; files without a usable mtime are never deleted", async () => {
  const stuck = staged("u1", "stuck.png", ago(STAGING_MAX_AGE_MS * 2));
  const { fake, removed, logs } = ports({
    folders: [`${ROOT}/u1`],
    staged: { [`${ROOT}/u1`]: [stuck, staged("u1", "nodate.png"), staged("u1", "garbled.png", "yesterday-ish")] },
    removeErrors: { [stuck.path]: "Openinary delete failed: 500" },
  });

  const summary = await runSweep(fake, { now: () => NOW });

  assertEquals(removed, []);
  assertEquals({ delete_errors: summary.delete_errors, undated: summary.undated }, { delete_errors: 1, undated: 2 });
  assertEquals(logs[0].level, "error");
});

Deno.test("paths outside the user's ai-tmp folder are ignored, whatever the listing returns", async () => {
  const foreign: OpeninaryFile = { name: "x.png", path: `${ROOT}/u2/upscaled/x.png`, size: 1, mtime: ago(STAGING_MAX_AGE_MS * 2) };
  const nested: OpeninaryFile = { name: "y.png", path: `${ROOT}/u1/ai-tmp/deeper/y.png`, size: 1, mtime: ago(STAGING_MAX_AGE_MS * 2) };
  const { fake, removed } = ports({ folders: [`${ROOT}/u1`], staged: { [`${ROOT}/u1`]: [foreign, nested] } });

  const summary = await runSweep(fake, { now: () => NOW });

  assertEquals(removed, []);
  assertEquals(summary.scanned, 0);
});

Deno.test("the delete cap stops the run and marks it incomplete for the next one", async () => {
  const files = ["a", "b", "c"].map((n) => staged("u1", `${n}.png`, ago(STAGING_MAX_AGE_MS * 2)));
  const { fake, removed } = ports({ folders: [`${ROOT}/u1`], staged: { [`${ROOT}/u1`]: files } });

  const summary = await runSweep(fake, { now: () => NOW, maxDeletes: 2 });

  assertEquals(removed.length, 2);
  assertEquals(summary.incomplete, true);
});

Deno.test("no delete starts once the time budget has run out", async () => {
  let clock = NOW;
  const files = ["a", "b"].map((n) => staged("u1", `${n}.png`, ago(STAGING_MAX_AGE_MS * 2)));
  const { fake, removed } = ports({ folders: [`${ROOT}/u1`], staged: { [`${ROOT}/u1`]: files } });
  const remove = fake.remove;
  fake.remove = (path) => {
    clock += 5_000; // each delete takes 5 s
    return remove(path);
  };

  const summary = await runSweep(fake, { now: () => clock, budgetMs: 4_000 });

  assertEquals(removed.length, 1);
  assertEquals(summary.incomplete, true);
});

Deno.test("user folders are the root's direct children, as the listing names them", () => {
  assertEquals(
    userFolderPaths(ROOT, [
      { name: "u1", path: `${ROOT}/u1` },
      { name: "u2", path: "elsewhere/u2" },
      { name: "a/b", path: `${ROOT}/a/b` },
      { name: "", path: `${ROOT}/` },
    ]),
    [`${ROOT}/u1`],
  );
});

Deno.test("each run starts at a random folder and wraps around, so a budget cut does not starve the tail", async () => {
  const seen: string[] = [];
  const { fake } = ports({ folders: ["f0", "f1", "f2", "f3"].map((f) => `${ROOT}/${f}`) });
  fake.listStaged = (folder) => {
    seen.push(folder.slice(ROOT.length + 1));
    return Promise.resolve([]);
  };
  await runSweep(fake, { now: () => NOW, random: () => 0.5 });
  assertEquals(new Set(seen), new Set(["f0", "f1", "f2", "f3"]));
  assertEquals(seen.slice(0, 2).sort(), ["f2", "f3"]); // the first workers take the rotated head
});
