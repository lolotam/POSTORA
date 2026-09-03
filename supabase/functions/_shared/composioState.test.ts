import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  newNonce,
  signConnectState,
  verifyConnectState,
} from "./composioState.ts";

const state = {
  connectionId: "connection-1",
  workspaceId: "workspace-1",
  nonce: "0123456789abcdef0123456789abcdef",
  exp: 2_000,
};

Deno.test("signed connect state round-trips", async () => {
  const token = await signConnectState(state, "state-secret");
  assertEquals(
    await verifyConnectState(token, "state-secret", () => 1_000_000),
    state,
  );
  assertEquals(token.split(".").length, 2);
});

Deno.test("tampered payload and wrong secret fail closed", async () => {
  const token = await signConnectState(state, "state-secret");
  const [payload, signature] = token.split(".");
  const tampered = `${payload.slice(0, -1)}${
    payload.endsWith("A") ? "B" : "A"
  }.${signature}`;

  assertEquals(
    await verifyConnectState(tampered, "state-secret", () => 1_000_000),
    null,
  );
  assertEquals(
    await verifyConnectState(token, "wrong-secret", () => 1_000_000),
    null,
  );
});

Deno.test("expired and malformed state returns null without throwing", async () => {
  const token = await signConnectState(state, "state-secret");
  assertEquals(
    await verifyConnectState(token, "state-secret", () => 2_001_000),
    null,
  );

  for (const malformed of ["", "one-part", "a.b.c", "!.!", "e30.invalid"]) {
    assertEquals(await verifyConnectState(malformed, "state-secret"), null);
  }
});

Deno.test("newNonce returns sixteen random bytes as lowercase hex", () => {
  const first = newNonce();
  const second = newNonce();
  assertMatch(first, /^[0-9a-f]{32}$/);
  assertMatch(second, /^[0-9a-f]{32}$/);
  assert(first !== second);
});

Deno.test("a profile id rides in the signed state only when the door set one", async () => {
  const homed = { ...state, socialProfileId: "profile-1" };
  const token = await signConnectState(homed, "state-secret");
  assertEquals(
    await verifyConnectState(token, "state-secret", () => 1_000_000),
    homed,
  );
  const empty = await signConnectState(
    { ...state, socialProfileId: "" },
    "state-secret",
  );
  assertEquals(await verifyConnectState(empty, "state-secret", () => 1_000_000), null);
});
