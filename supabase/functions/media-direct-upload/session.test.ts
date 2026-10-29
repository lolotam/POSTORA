import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { signSession, verifySession, type DirectUploadSession } from "./session.ts";

const SECRET = "test-secret";
const NOW = 1_800_000_000;

function session(overrides: Partial<DirectUploadSession> = {}): DirectUploadSession {
  return {
    v: 1,
    uid: "user-1",
    exp: NOW + 60,
    publicId: "postora_2026-10-29_user-1_7",
    folder: "media/a_at_b_com/2026-10-29",
    uploadDate: "2026-10-29",
    ext: "mp4",
    mime: "video/mp4",
    kind: "video",
    storedFileType: "video",
    size: 300 * 1024 * 1024,
    originalFilename: "clip.mp4",
    providers: ["openinary"],
    required: ["openinary"],
    readPreference: "openinary",
    openinary: { folder: "postora.cloud/media/a_at_b_com/2026-10-29", fileName: "postora_2026-10-29_user-1_7.mp4" },
    ...overrides,
  };
}

Deno.test("a signed session round-trips for its own user", async () => {
  const token = await signSession(session(), SECRET);
  const checked = await verifySession(token, SECRET, "user-1", NOW);
  assertEquals(checked.ok, true);
  if (checked.ok) assertEquals(checked.session.size, 300 * 1024 * 1024);
});

Deno.test("a session edited in the browser is refused", async () => {
  const token = await signSession(session(), SECRET);
  const [body, mac] = token.split(".");
  const forged = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  forged.size = 5 * 1024 * 1024 * 1024;
  const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEquals(await verifySession(`${forgedBody}.${mac}`, SECRET, "user-1", NOW), { ok: false, reason: "bad_signature" });
});

Deno.test("another user's session, an expired one and a foreign key are refused", async () => {
  const token = await signSession(session(), SECRET);
  assertEquals(await verifySession(token, SECRET, "user-2", NOW), { ok: false, reason: "wrong_user" });
  assertEquals(await verifySession(token, SECRET, "user-1", NOW + 61), { ok: false, reason: "expired" });
  assertEquals(await verifySession(token, "other-secret", "user-1", NOW), { ok: false, reason: "bad_signature" });
});

Deno.test("garbage tokens are malformed, not errors", async () => {
  for (const token of ["", "abc", "a.b.c", "%%%.###"]) {
    assertEquals((await verifySession(token, SECRET, "user-1", NOW)).ok, false, token);
  }
});
