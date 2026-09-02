import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parse } from "jsr:@std/yaml@1";
import { buildCollection, buildEnvironments } from "./generate-postman.ts";

const DOC_PATH = new URL("../docs/api/openapi.yaml", import.meta.url);
const COLLECTION_PATH = new URL("../docs/api/postman/postora-partner-api.postman_collection.json", import.meta.url);
const ENV_DIR = new URL("../docs/api/postman/", import.meta.url);

function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** A Windows checkout under autocrlf hands back CRLF; the comparison is on content, not line endings. */
async function committedText(url: URL): Promise<string> {
  return (await Deno.readTextFile(url)).replaceAll("\r\n", "\n");
}

Deno.test("generated Postman collection is byte-identical to committed file", async () => {
  const text = await Deno.readTextFile(DOC_PATH);
  const doc = parse(text);
  const built = buildCollection(doc as any);
  const expected = stableStringify(built);
  let committed: string;
  try {
    committed = await committedText(COLLECTION_PATH);
  } catch {
    throw new Error("run `deno run --allow-read --allow-write scripts/generate-postman.ts` and commit the result");
  }
  assertEquals(committed, expected, "run `deno run --allow-read --allow-write scripts/generate-postman.ts` and commit the result");
});

Deno.test("generated Postman environments are byte-identical to committed files", async () => {
  const envs = buildEnvironments();
  for (const [fname, built] of Object.entries(envs)) {
    const expected = stableStringify(built);
    let committed: string;
    try {
      committed = await committedText(new URL(fname, ENV_DIR));
    } catch {
      throw new Error("run `deno run --allow-read --allow-write scripts/generate-postman.ts` and commit the result");
    }
    assertEquals(committed, expected, `environment ${fname} drift: run \`deno run --allow-read --allow-write scripts/generate-postman.ts\` and commit the result`);
  }
});

Deno.test("no real credential in generated collection", async () => {
  const text = await Deno.readTextFile(DOC_PATH);
  const doc = parse(text);
  const built = buildCollection(doc as any);
  const json = JSON.stringify(built);
  const realKeyRe = /pk_(live|test)_[0-9A-Za-z]{20,}/;
  assertEquals(realKeyRe.test(json), false, `collection contains a real-looking key matching ${realKeyRe}`);
});

Deno.test("every documented path appears exactly once in collection", async () => {
  const text = await Deno.readTextFile(DOC_PATH);
  const doc = parse(text) as any;
  const built = buildCollection(doc);
  const paths = Object.keys(doc.paths ?? {}).sort();

  // Collect request URLs from collection
  const seen = new Map<string, number>();
  for (const folder of (built.item as any[])) {
    for (const req of (folder.item as any[])) {
      const raw: string = req.request.url.raw as string;
      // raw is {{baseUrl}}/functions/v1/partner-api/v1/...
      const path = raw.replace("{{baseUrl}}", "");
      const method = (req.request.method as string).toLowerCase();
      const key = `${method} ${path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }

  for (const path of paths) {
    const pathItem = doc.paths[path] as any;
    for (const m of Object.keys(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
      // The collection renders `{id}` as Postman's `:id` path variable.
      const key = `${m} ${path.replace(/\{([^}]+)\}/g, ":$1")}`;
      const count = seen.get(key) ?? 0;
      assertEquals(count, 1, `expected exactly one request for ${key}, found ${count}`);
    }
  }

  // Also ensure no extra requests beyond documented paths
  const totalDocOps = paths.reduce((sum, p) => {
    const item = doc.paths[p] as any;
    return sum + Object.keys(item).filter((m) => ["get", "post", "put", "patch", "delete"].includes(m)).length;
  }, 0);
  const totalSeen = [...seen.values()].reduce((a, b) => a + b, 0);
  assertEquals(totalSeen, totalDocOps, `collection has ${totalSeen} requests but doc has ${totalDocOps} operations`);
});
