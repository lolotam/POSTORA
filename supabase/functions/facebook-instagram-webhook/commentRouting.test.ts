import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { routeComment } from "./commentRouting.ts";
import type { MetaCommentInput } from "./commentEvents.ts";

const ACCOUNT = {
  id: "acct-1",
  user_id: "user-1",
  platform: "instagram",
  platform_user_id: "ig-1",
  platform_username: "shop_ig",
  access_token: "tok",
  account_metadata: {},
};

const COMMENT: MetaCommentInput = {
  comment: { id: "c1", kind: "comment", text: "GUIDE", parentCommentId: null, mediaUrl: null },
  post: { id: "p1", url: null, caption: null },
  author: { id: "a1", name: null, username: "fan" },
  timestamp: "2026-09-03T10:00:00Z",
};

// One shared timeline: which automation ran, in order. Separate counters per collaborator
// could not distinguish "the funnel claimed it and the handler was skipped" from "both ran".
function spies(workflowVerdict: "claimed" | "unclaimed") {
  const ran: string[] = [];
  return {
    ran,
    deps: {
      runWorkflow: () => {
        ran.push("workflow");
        return Promise.resolve(workflowVerdict);
      },
      dispatchN8n: () => {
        ran.push("n8n");
        return Promise.resolve(undefined as never);
      },
      handleInternally: () => {
        ran.push("internal");
        return Promise.resolve("skipped" as never);
      },
    } as never,
  };
}

Deno.test("a claimed comment reaches neither n8n nor the internal automation", async () => {
  for (const handler of ["off", "internal", "n8n"] as const) {
    const { ran, deps } = spies("claimed");
    const route = await routeComment({}, ACCOUNT, "instagram", COMMENT, handler, deps);
    assertEquals(route, "workflow", `handler=${handler}`);
    assertEquals(ran, ["workflow"], `handler=${handler} ran more than the funnel`);
  }
});

Deno.test("funnels are evaluated before the handler, on every handler value including off", async () => {
  for (const handler of ["off", "internal", "n8n"] as const) {
    const { ran, deps } = spies("unclaimed");
    await routeComment({}, ACCOUNT, "instagram", COMMENT, handler, deps);
    assertEquals(ran[0], "workflow", `handler=${handler} skipped the funnel`);
  }
});

Deno.test("an unclaimed comment routes exactly as it did before this feature", async () => {
  const n8n = spies("unclaimed");
  assertEquals(await routeComment({}, ACCOUNT, "instagram", COMMENT, "n8n", n8n.deps), "n8n");
  assertEquals(n8n.ran, ["workflow", "n8n"]);

  const internal = spies("unclaimed");
  assertEquals(await routeComment({}, ACCOUNT, "instagram", COMMENT, "internal", internal.deps), "internal");
  assertEquals(internal.ran, ["workflow", "internal"]);

  const off = spies("unclaimed");
  assertEquals(await routeComment({}, ACCOUNT, "instagram", COMMENT, "off", off.deps), "none");
  assertEquals(off.ran, ["workflow"]);
});

Deno.test("the funnel receives the comment's own timestamp, which gates Meta's 7-day window", async () => {
  let seen: Record<string, unknown> | null = null;
  const deps = {
    runWorkflow: (_admin: unknown, _account: unknown, input: Record<string, unknown>) => {
      seen = input;
      return Promise.resolve("unclaimed");
    },
    dispatchN8n: () => Promise.resolve(undefined),
    handleInternally: () => Promise.resolve("skipped"),
  } as never;

  await routeComment({}, ACCOUNT, "instagram", COMMENT, "off", deps);

  assertEquals(seen!.timestamp, "2026-09-03T10:00:00Z");
  assertEquals((seen!.comment as Record<string, unknown>).kind, "comment");
  assertEquals((seen!.post as Record<string, unknown>).id, "p1");
});
