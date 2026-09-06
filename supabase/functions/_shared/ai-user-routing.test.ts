import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type AiRoutingAdmin,
  markUserKeyInvalid,
  resolveUserAiRoute,
} from "./ai-user-routing.ts";

function fakeAdmin(
  options: {
    global?: boolean;
    override?: Record<string, unknown>;
    preferences?: Record<string, unknown>[];
    key?: unknown;
    row?: Record<string, unknown> | null;
    fail?: string;
  } = {},
) {
  const reads: string[] = [];
  const filters: unknown[][] = [];
  const writes: Record<string, unknown>[] = [];
  const rpcCalls: unknown[][] = [];
  const admin = {
    from(table: string) {
      reads.push(table);
      const result = () => ({
        data: table === "app_settings"
          ? { value: options.global ?? true }
          : table === "user_feature_overrides"
          ? options.override ?? null
          : table === "user_ai_routing_preferences"
          ? options.preferences ?? []
          : table === "user_ai_provider_keys"
          ? (options.row === undefined ? { updated_at: "2026-09-06T00:00:00.000Z" } : options.row)
          : null,
        error: options.fail === table
          ? { message: "database unavailable" }
          : null,
      });
      const query = {
        eq(column: string, value: unknown) {
          filters.push([table, column, value]);
          return query;
        },
        in(column: string, value: unknown) {
          filters.push([table, column, value]);
          return query;
        },
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      return {
        select: () => query,
        update(values: Record<string, unknown>) {
          writes.push(values);
          return query;
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push([name, args]);
      const apiKey = options.key === undefined ? "user-secret" : options.key;
      return Promise.resolve({
        data: apiKey === null ? [] : [{
          api_key: apiKey,
          status: "active",
          updated_at: "2026-09-06T00:00:00.000Z",
        }],
        error: options.fail === "rpc" ? { message: "vault failed" } : null,
      });
    },
  } as unknown as AiRoutingAdmin;
  return { admin, reads, filters, writes, rpcCalls };
}
const preference = (mode = "user_only", capability = "*") => ({
  capability,
  mode,
  preferred_provider_code: "claude",
  preferred_model_id: "claude-sonnet-5",
  allow_platform_fallback: mode === "user_first",
});

Deno.test("flag off avoids preferences and vault; unexpired user overrides win in both directions", async () => {
  for (
    const [global, override, expected] of [
      [false, undefined, false],
      [false, { enabled: true, expires_at: null }, true],
      [true, { enabled: false, expires_at: null }, false],
      [false, { enabled: true, expires_at: "2000-01-01" }, false],
    ] as const
  ) {
    const fake = fakeAdmin({ global, override, preferences: [preference()] });
    const route = await resolveUserAiRoute(fake.admin, "owner", "chat");
    assertEquals(route.mode, expected ? "user_only" : "postora_only");
    if (!expected) {
      assertEquals(route.reason, "flag_off");
      assertEquals(fake.reads, ["app_settings", "user_feature_overrides"]);
      assertEquals(fake.rpcCalls, []);
    }
    assertEquals(
      fake.filters.some((filter) =>
        filter[0] === "user_feature_overrides" && filter[1] === "user_id" &&
        filter[2] === "owner"
      ),
      true,
    );
  }
});

Deno.test("capability preference beats wildcard and resolves only the owner's provider key", async () => {
  const fake = fakeAdmin({
    preferences: [preference(), {
      ...preference("user_first", "agent"),
      preferred_provider_code: "openai",
      preferred_model_id: "gpt-test",
    }],
  });
  const route = await resolveUserAiRoute(fake.admin, "owner-2", "agent");
  assertEquals(route.mode, "user_first");
  assertEquals(route.userTier, {
    provider: "openai",
    model: "gpt-test",
    credentialSource: "user",
    apiKey: "user-secret",
  });
  // fetchedAt is the row's own updated_at from the same snapshot as the key.
  assertEquals(route.fetchedAt, "2026-09-06T00:00:00.000Z");
  assertEquals(fake.rpcCalls, [["get_user_ai_provider_key_snapshot", {
    p_user_id: "owner-2",
    p_provider_code: "openai",
  }]]);
  assertEquals(
    fake.filters.some((filter) =>
      filter[0] === "user_ai_routing_preferences" && filter[1] === "user_id" &&
      filter[2] === "owner-2"
    ),
    true,
  );
});

Deno.test("missing key fails closed for user_only and permits consented user_first fallback", async () => {
  for (const mode of ["user_only", "user_first"] as const) {
    const fake = fakeAdmin({ preferences: [preference(mode)], key: null });
    assertEquals(await resolveUserAiRoute(fake.admin, "owner", "chat"), {
      mode,
      allowPlatformFallback: mode === "user_first",
      reason: "user_key_missing",
    });
  }
});

Deno.test("missing preferences use Postora and malformed RPC payloads never become missing keys", async () => {
  assertEquals(await resolveUserAiRoute(fakeAdmin().admin, "owner", "chat"), {
    mode: "postora_only",
    allowPlatformFallback: false,
    reason: "no_preference",
  });
  await assertRejects(
    () =>
      resolveUserAiRoute(
        fakeAdmin({
          preferences: [preference()],
          key: [{ api_key: "not-a-scalar" }],
        }).admin,
        "owner",
        "chat",
      ),
    Error,
    "Invalid AI provider key response",
  );
});

Deno.test("flag, override, preference and RPC failures all throw", async () => {
  for (
    const fail of [
      "app_settings",
      "user_feature_overrides",
      "user_ai_routing_preferences",
      "rpc",
    ]
  ) {
    await assertRejects(
      () =>
        resolveUserAiRoute(
          fakeAdmin({ preferences: [preference()], fail }).admin,
          "owner",
          "chat",
        ),
      Error,
    );
  }
});

Deno.test("key invalidation is scoped to user, provider and the fetched key version; errors throw", async () => {
  const fake = fakeAdmin();
  const fetchedAt = "2026-09-06T00:00:00.000Z";
  await markUserKeyInvalid(fake.admin, "owner", "claude", fetchedAt);
  assertEquals(fake.writes, [{
    status: "invalid",
    last_error_code: "AI_USER_KEY_INVALID",
  }]);
  assertEquals(fake.filters, [["user_ai_provider_keys", "user_id", "owner"], [
    "user_ai_provider_keys",
    "provider_code",
    "claude",
  ], ["user_ai_provider_keys", "updated_at", fetchedAt]]);
  await assertRejects(
    () =>
      markUserKeyInvalid(
        fakeAdmin({ fail: "user_ai_provider_keys" }).admin,
        "owner",
        "claude",
        fetchedAt,
      ),
    Error,
  );
});
