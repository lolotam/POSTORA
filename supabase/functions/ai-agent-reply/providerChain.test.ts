import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
// Stub only the server boundary so importing the real completion path cannot listen.
const originalServe = Deno.serve;
let chatCompletion: typeof import("./index.ts").chatCompletion;
try {
  Deno.serve = (() => ({})) as unknown as typeof Deno.serve;
  ({ chatCompletion } = await import("./index.ts"));
} finally {
  Deno.serve = originalServe;
}
import { parseModelRef } from "./logic.ts";
import { type AiTier } from "../_shared/ai-fallback.ts";
import {
  type AiRoutingAdmin,
  composeAiTiers,
  invalidateRejectedUserTier,
  type UserAiRoute,
} from "../_shared/ai-user-routing.ts";
import { ProviderHttpError } from "../_shared/ai-routing-errors.ts";

const userTier: AiTier & { credentialSource: "user" } = {
  provider: "claude",
  model: "claude-sonnet-5",
  apiKey: "test-user-secret",
  credentialSource: "user",
};

Deno.test("agent chain respects routing mode and three-tier cap, including absent user key", () => {
  const platform: AiTier[] = [1, 2, 3].map((n) => ({
    provider: "openai",
    model: `platform-${n}`,
    credentialSource: "platform",
  }));
  for (const mode of ["postora_only", "user_first", "user_only"] as const) {
    const route: UserAiRoute = {
      mode,
      allowPlatformFallback: mode === "user_first",
      ...(mode !== "postora_only" ? { userTier } : {}),
    };
    assertEquals(
      composeAiTiers(route, platform),
      mode === "postora_only"
        ? platform
        : mode === "user_only"
        ? [userTier]
        : [userTier, ...platform.slice(0, 2)],
    );
    assertEquals(
      composeAiTiers({ ...route, userTier: undefined }, platform),
      mode === "user_only" ? [] : platform,
    );
  }
  assertEquals(parseModelRef("claude/claude-sonnet-5"), {
    provider: "claude",
    model: "claude-sonnet-5",
  });
});

Deno.test("agent user-key rejection invalidates only that version; platform rejection never invalidates", async () => {
  const writes: unknown[] = [];
  const admin = {
    from(table: string) {
      const query = {
        eq(column: string, value: unknown) {
          writes.push([column, value]);
          return query;
        },
        lte(column: string, value: unknown) {
          writes.push([column, value]);
          return Promise.resolve({ error: null });
        },
      };
      return {
        update(values: unknown) {
          writes.push([table, values]);
          return query;
        },
      };
    },
  } as unknown as AiRoutingAdmin;
  const route: UserAiRoute = {
    mode: "user_first",
    allowPlatformFallback: true,
    userTier,
    fetchedAt: "2026-09-06T00:00:00.000Z",
  };
  for (const credentialSource of ["user", "platform"] as const) {
    for (const status of [401, 403, 429, 503]) {
      writes.length = 0;
      await invalidateRejectedUserTier(
        admin,
        "owner",
        route,
        new ProviderHttpError("Rejected", {
          status,
          provider: "claude",
          credentialSource,
        }),
      );
      assertEquals(
        writes,
        credentialSource === "user" && [401, 403].includes(status)
          ? [
            ["user_ai_provider_keys", {
              status: "invalid",
              last_error_code: "AI_USER_KEY_INVALID",
            }],
            ["user_id", "owner"],
            ["provider_code", "claude"],
            ["updated_at", route.fetchedAt],
          ]
          : [],
      );
    }
  }
});

Deno.test("agent user tiers bypass platform credentials for OpenAI and Claude, preserving HTTP status", async () => {
  const original = globalThis.fetch;
  const admin = {
    from() {
      throw new Error("platform credential lookup forbidden");
    },
  } as unknown as AiRoutingAdmin;
  try {
    for (const provider of ["openai", "claude"]) {
      globalThis.fetch = async (_url, init) => {
        const headers = new Headers(init?.headers);
        assertEquals(
          provider === "claude"
            ? headers.get("x-api-key")
            : headers.get("authorization"),
          provider === "claude" ? userTier.apiKey : `Bearer ${userTier.apiKey}`,
        );
        return new Response(
          JSON.stringify({ error: { message: `invalid ${userTier.apiKey}` } }),
          { status: 401 },
        );
      };
      const error = await assertRejects(
        () =>
          chatCompletion(
            { ...userTier, provider },
            { messages: [] },
            100,
            admin,
          ),
        ProviderHttpError,
      );
      assertEquals(error.status, 401);
      assertEquals(error.credentialSource, "user");
      assertEquals(error.message.includes(userTier.apiKey), false);
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("agent platform tier uses the DB key and rejects malformed successful completions", async () => {
  const original = globalThis.fetch;
  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: { api_key: "database-key" }, error: null }),
        }),
      }),
    }),
  } as unknown as AiRoutingAdmin;
  try {
    for (
      const body of [{ choices: [] }, {
        error: { message: "rejected database-key" },
      }]
    ) {
      globalThis.fetch = async (_url, init) => {
        assertEquals(
          new Headers(init?.headers).get("authorization"),
          "Bearer database-key",
        );
        return new Response(JSON.stringify(body));
      };
      const failure = await assertRejects(
        () =>
          chatCompletion(
            {
              provider: "openai",
              model: "gpt-test",
              credentialSource: "platform",
            },
            {},
            100,
            admin,
          ),
        Error,
      );
      assertEquals(failure.message.includes("database-key"), false);
    }
  } finally {
    globalThis.fetch = original;
  }
});
