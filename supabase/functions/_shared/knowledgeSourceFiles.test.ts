import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  cloudinaryFolderForEmail,
  downloadKnowledgeFile,
  knowledgeStorageObjectPath,
  knowledgeStorageRef,
  locateKnowledgeFile,
  type KnowledgeFileLocation,
} from "./knowledgeSourceFiles.ts";

const OWNER = { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" };
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const OWNER_FOLDER = cloudinaryFolderForEmail(OWNER.email);
const OTHER_FOLDER = cloudinaryFolderForEmail("someone.else@example.com");

function cloudinaryUrl(publicId: string): string {
  return `https://res.cloudinary.com/demo/raw/upload/v1712345678/${publicId}`;
}

Deno.test("locateKnowledgeFile accepts only what the owner owns", async (t) => {
  const accepted: Array<[string, string, KnowledgeFileLocation]> = [
    [
      "a storage ref under the owner's id",
      knowledgeStorageRef(`${OWNER.userId}/sources/abc.csv`),
      { kind: "storage", bucket: "ai-knowledge", path: `${OWNER.userId}/sources/abc.csv` },
    ],
    [
      "a legacy bare path under the owner's email folder",
      `media/${OWNER_FOLDER}/ai-knowledge/report.pdf`,
      { kind: "storage", bucket: "ai-knowledge", path: `media/${OWNER_FOLDER}/ai-knowledge/report.pdf` },
    ],
    [
      "a public storage URL from before the bucket went private",
      `https://api.postora.cloud/storage/v1/object/public/ai-knowledge/${OWNER.userId}/sources/x.md`,
      { kind: "storage", bucket: "ai-knowledge", path: `${OWNER.userId}/sources/x.md` },
    ],
    [
      "a Cloudinary asset in the owner's folder",
      cloudinaryUrl(`media/${OWNER_FOLDER}/ai-knowledge/postora_2026_1.md`),
      {
        kind: "cloudinary",
        url: cloudinaryUrl(`media/${OWNER_FOLDER}/ai-knowledge/postora_2026_1.md`),
        publicId: `media/${OWNER_FOLDER}/ai-knowledge/postora_2026_1.md`,
      },
    ],
  ];

  for (const [label, filePath, expected] of accepted) {
    await t.step(label, () => {
      assertEquals(locateKnowledgeFile(filePath, OWNER), expected);
    });
  }
});

Deno.test("locateKnowledgeFile refuses anything outside the owner's folder", async (t) => {
  const refused: Array<[string, string]> = [
    // The two that matter most: file_path is owner-writable through RLS while
    // both readers run as the service role, so an unchecked value lets one user
    // have another user's knowledge file chunked into their own agent.
    [
      "a storage ref under another user's id",
      knowledgeStorageRef(`${OTHER_USER}/sources/secret.csv`),
    ],
    [
      "a Cloudinary asset in another user's email folder",
      cloudinaryUrl(`media/${OTHER_FOLDER}/ai-knowledge/pricing.md`),
    ],
    ["a bare path under another user's id", `${OTHER_USER}/sources/secret.csv`],
    ["a public storage URL for another user's object", `https://api.postora.cloud/storage/v1/object/public/ai-knowledge/${OTHER_USER}/x.md`],
    ["a ref naming a different bucket", `supabase://media/${OWNER.userId}/sources/x.csv`],
    ["a ref with no bucket segment", "supabase://ai-knowledge"],
    ["a traversal out of the owner's folder", `${OWNER.userId}/../${OTHER_USER}/secret.csv`],
    ["a percent-encoded traversal", `${OWNER.userId}/%2E%2E/${OTHER_USER}/secret.csv`],
    ["an absolute path", `/${OWNER.userId}/sources/x.csv`],
    // Everything below would be an outbound request made with service-role
    // authority if it were accepted.
    ["an arbitrary https URL", "https://attacker.example.com/payload.csv"],
    ["a link-local metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
    ["a non-http scheme", "file:///etc/passwd"],
    ["a Cloudinary image URL rather than a raw asset", `https://res.cloudinary.com/demo/image/upload/v1/media/${OWNER_FOLDER}/x.png`],
    ["an empty path", ""],
  ];

  for (const [label, filePath] of refused) {
    await t.step(label, () => {
      assertEquals(locateKnowledgeFile(filePath, OWNER), null);
    });
  }

  await t.step("null and undefined", () => {
    assertEquals(locateKnowledgeFile(null, OWNER), null);
    assertEquals(locateKnowledgeFile(undefined, OWNER), null);
  });

  await t.step("a Cloudinary asset when the owner's email is unknown", () => {
    // Without an email there is no folder to compare against, so the only safe
    // answer is a refusal — never an unscoped fetch.
    assertEquals(
      locateKnowledgeFile(cloudinaryUrl(`media/${OWNER_FOLDER}/x.md`), { userId: OWNER.userId }),
      null,
    );
  });
});

Deno.test("knowledgeStorageObjectPath keeps the extension and carries no email", () => {
  const path = knowledgeStorageObjectPath(OWNER.userId, "Q3 Price List.XLSX", "obj-1");
  assertEquals(path, `${OWNER.userId}/sources/obj-1.xlsx`);
  assertEquals(path.includes("@"), false);
  assertEquals(path.includes(OWNER_FOLDER), false);
});

Deno.test("knowledgeStorageObjectPath tolerates a name with no extension", () => {
  assertEquals(knowledgeStorageObjectPath(OWNER.userId, "README", "obj-2"), `${OWNER.userId}/sources/obj-2`);
});

Deno.test("downloadKnowledgeFile reads a bucket object at the resolved path", async () => {
  const requested: string[] = [];
  const admin = {
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          requested.push(`${bucket}:${path}`);
          return Promise.resolve({ data: new Blob(["rows"]), error: null });
        },
      }),
    },
  };
  const blob = await downloadKnowledgeFile(admin, {
    kind: "storage",
    bucket: "ai-knowledge",
    path: `${OWNER.userId}/sources/abc.csv`,
  });
  assertEquals(await blob.text(), "rows");
  assertEquals(requested, [`ai-knowledge:${OWNER.userId}/sources/abc.csv`]);
});

Deno.test("downloadKnowledgeFile surfaces a storage error instead of an empty file", async () => {
  const admin = {
    storage: {
      from: () => ({
        download: () => Promise.resolve({ data: null, error: { message: "Object not found" } }),
      }),
    },
  };
  await assertRejects(
    () =>
      downloadKnowledgeFile(admin, {
        kind: "storage",
        bucket: "ai-knowledge",
        path: `${OWNER.userId}/sources/gone.csv`,
      }),
    Error,
    "Object not found",
  );
});

Deno.test("downloadKnowledgeFile rejects a non-OK Cloudinary response", async () => {
  const admin = { storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: null }) }) } };
  await assertRejects(
    () =>
      downloadKnowledgeFile(
        admin,
        { kind: "cloudinary", url: cloudinaryUrl("media/x/y.md"), publicId: "media/x/y.md" },
        () => Promise.resolve(new Response("nope", { status: 404 })),
      ),
    Error,
    "404",
  );
});
