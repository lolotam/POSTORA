import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { touchSocialContact } from "./socialContactIngest.ts";

function fakeAdmin(result: { data?: unknown; error?: { message: string } | null } = { data: "row-1", error: null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  };
}

Deno.test("passes the account id and author fields through; never a user id", async () => {
  const admin = fakeAdmin();
  const outcome = await touchSocialContact(admin, "acc-1", {
    platform: "instagram",
    author: { id: "1784140001", name: null, username: "dana.kw" },
    comment: { id: "c1", text: "price?" },
    post: { id: "p1" },
  });
  assertEquals(outcome, "upserted");
  assertEquals(admin.calls[0].fn, "touch_social_contact");
  assertEquals(admin.calls[0].args, {
    p_social_account_id: "acc-1", p_platform: "instagram", p_author_id: "1784140001", p_author_name: null,
    p_author_username: "dana.kw", p_comment_text: "price?", p_post_id: "p1",
  });
});

Deno.test("no id and no username short-circuits without an rpc call", async () => {
  const admin = fakeAdmin();
  const outcome = await touchSocialContact(admin, "acc-1", {
    platform: "facebook",
    author: { id: null, name: "Someone", username: "  " },
    comment: { id: "c3", text: "x" },
    post: { id: "p3" },
  });
  assertEquals(outcome, "no_identity");
  assertEquals(admin.calls.length, 0);
});

Deno.test("a null rpc result (writer declined) is reported as no_identity", async () => {
  const admin = fakeAdmin({ data: null, error: null });
  const outcome = await touchSocialContact(admin, "acc-1", {
    platform: "threads", author: { id: null, name: null, username: "v" }, comment: { id: "c", text: "t" }, post: { id: null },
  });
  assertEquals(outcome, "no_identity");
});

Deno.test("rpc error is reported as failed, never thrown", async () => {
  const admin = fakeAdmin({ error: { message: "boom" } });
  const outcome = await touchSocialContact(admin, "acc-1", {
    platform: "facebook", author: { id: "10", name: "A", username: null }, comment: { id: "c4", text: "x" }, post: { id: "p4" },
  });
  assertEquals(outcome, "failed");
});
