import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseExportUrlTarget,
  resolveExportUrl,
  SIGNED_URL_TTL_SECONDS,
} from "./knowledgeExportUrls.ts";

function fakeStorageAdmin(
  respond: (path: string) => { signedUrl: string | null } | { error: string },
) {
  const signed: Array<{ bucket: string; path: string; ttl: number }> = [];
  const admin = {
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, expiresIn: number) => {
          signed.push({ bucket, path, ttl: expiresIn });
          const result = respond(path);
          return "error" in result
            ? { data: null, error: { message: result.error } }
            : { data: { signedUrl: result.signedUrl }, error: null };
        },
      }),
    },
  };
  return { admin, signed };
}

const OWNER = { bucket: "ai-knowledge", ownerFolder: "media/owner_at_example_com" };

Deno.test("parseExportUrlTarget classifies every stored export form", () => {
  assertEquals(
    parseExportUrlTarget("supabase://ai-knowledge/media/owner_at_example_com/knowledge-graph/graph.html", "ai-knowledge"),
    { kind: "storage", path: "media/owner_at_example_com/knowledge-graph/graph.html" },
  );
  // Legacy rows store the pre-private-bucket public URL; the object still
  // exists at the same path, so it resolves to that path instead of a dead link.
  assertEquals(
    parseExportUrlTarget("https://api.postora.cloud/storage/v1/object/public/ai-knowledge/media/owner_at_example_com/knowledge-graph/graph.html", "ai-knowledge"),
    { kind: "storage", path: "media/owner_at_example_com/knowledge-graph/graph.html" },
  );
  assertEquals(
    parseExportUrlTarget("https://res.cloudinary.com/demo/raw/upload/v1/media/owner_at_example_com/knowledge-graph/graph.html", "ai-knowledge"),
    { kind: "external", url: "https://res.cloudinary.com/demo/raw/upload/v1/media/owner_at_example_com/knowledge-graph/graph.html" },
  );
  assertEquals(parseExportUrlTarget("supabase://other-bucket/media/o/graph.html", "ai-knowledge"), null);
  assertEquals(parseExportUrlTarget("supabase://ai-knowledge/../../other/user/graph.html", "ai-knowledge"), null);
  assertEquals(parseExportUrlTarget("supabase://ai-knowledge/", "ai-knowledge"), null);
  assertEquals(parseExportUrlTarget("file:///etc/passwd", "ai-knowledge"), null);
  assertEquals(parseExportUrlTarget("garbage", "ai-knowledge"), null);
});

Deno.test("resolveExportUrl signs a stored supabase:// reference for its owner", async () => {
  const { admin, signed } = fakeStorageAdmin(() => ({ signedUrl: "https://signed.example.com/t" }));
  const url = await resolveExportUrl(
    admin,
    "supabase://ai-knowledge/media/owner_at_example_com/knowledge-graph/graph.html",
    OWNER,
  );
  assertEquals(url, "https://signed.example.com/t");
  assertEquals(signed, [{
    bucket: "ai-knowledge",
    path: "media/owner_at_example_com/knowledge-graph/graph.html",
    ttl: SIGNED_URL_TTL_SECONDS,
  }]);
});

Deno.test("signed URL TTL stays within the 15-60 minute window the plan allows", () => {
  assertEquals(SIGNED_URL_TTL_SECONDS >= 15 * 60, true);
  assertEquals(SIGNED_URL_TTL_SECONDS <= 60 * 60, true);
});

Deno.test("resolveExportUrl passes an external delivery URL through without signing", async () => {
  const { admin, signed } = fakeStorageAdmin(() => ({ signedUrl: "https://signed.example.com/t" }));
  const external = "https://res.cloudinary.com/demo/raw/upload/v1/graph.html";
  assertEquals(await resolveExportUrl(admin, external, OWNER), external);
  assertEquals(signed.length, 0);
});

Deno.test("resolveExportUrl re-signs a legacy public-URL row from the caller's own folder", async () => {
  const { admin, signed } = fakeStorageAdmin(() => ({ signedUrl: "https://signed.example.com/t" }));
  const url = await resolveExportUrl(
    admin,
    "https://api.postora.cloud/storage/v1/object/public/ai-knowledge/media/owner_at_example_com/knowledge-graph/graph.html",
    OWNER,
  );
  assertEquals(url, "https://signed.example.com/t");
  assertEquals(signed.map((s) => s.path), ["media/owner_at_example_com/knowledge-graph/graph.html"]);
});

Deno.test("resolveExportUrl refuses to sign a path outside the caller's folder", async () => {
  const { admin, signed } = fakeStorageAdmin(() => ({ signedUrl: "https://signed.example.com/t" }));
  // A user-writable row repointed at another user's object must yield nothing.
  const url = await resolveExportUrl(
    admin,
    "supabase://ai-knowledge/media/victim_at_example_com/knowledge-graph/graph.html",
    OWNER,
  );
  assertEquals(url, null);
  assertEquals(signed.length, 0);
});

Deno.test("resolveExportUrl degrades to null when signing fails", async () => {
  const { admin, signed } = fakeStorageAdmin(() => ({ error: "Object not found" }));
  const url = await resolveExportUrl(
    admin,
    "supabase://ai-knowledge/media/owner_at_example_com/knowledge-graph/graph.html",
    OWNER,
  );
  assertEquals(url, null);
  assertEquals(signed.length, 1);
});

Deno.test("resolveExportUrl maps missing and unparseable values to null", async () => {
  const { admin, signed } = fakeStorageAdmin(() => ({ signedUrl: "https://signed.example.com/t" }));
  assertEquals(await resolveExportUrl(admin, null, OWNER), null);
  assertEquals(await resolveExportUrl(admin, "", OWNER), null);
  assertEquals(await resolveExportUrl(admin, "not a url", OWNER), null);
  assertEquals(signed.length, 0);
});
