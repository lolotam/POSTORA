import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  customToolDefinitions,
  type CustomTool,
  type ToolContext,
} from "./tools.ts";
import {
  executeAdapterTool,
  executeRoutedCustomTool,
} from "./connectorExecution.ts";

const legacyTool: CustomTool = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "legacy_webhook",
  description: "Existing production connector.",
  url: "https://example.test/hook",
  secret: "legacy-secret",
  admin_only: false,
  connector_type: "custom_rest",
};

const wooTool: CustomTool = {
  ...legacyTool,
  id: "22222222-2222-4222-8222-222222222222",
  name: "woo_store",
  connector_type: "woocommerce",
};

const context = (dryRun = false): ToolContext => ({
  admin: {},
  userId: "33333333-3333-4333-8333-333333333333",
  platform: "whatsapp",
  conversationId: "conversation-1",
  customerName: "Customer",
  adminPhoneNumbers: [],
  dryRun,
  retrieveKnowledge: () => Promise.resolve([]),
  sendWhatsAppText: () => Promise.resolve(),
});

const typedArgs = {
  capability: "search_products",
  parameters: { query: "hat" },
};

Deno.test("custom_rest keeps the byte-identical legacy function schema", () => {
  const actual = JSON.stringify(customToolDefinitions([legacyTool]));
  const expected = JSON.stringify([{
    type: "function",
    function: {
      name: "legacy_webhook",
      description: "Existing production connector.",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "The request to send to this connector, in plain language with all needed details",
          },
        },
        required: ["input"],
      },
    },
  }]);

  assertEquals(actual, expected);
});

Deno.test("woocommerce schema makes the model choose a capability with typed parameters", () => {
  const parameters = customToolDefinitions([wooTool])[0].function.parameters;
  const serialized = JSON.stringify(parameters);

  assertStringIncludes(serialized, "search_products");
  assertStringIncludes(serialized, "check_stock");
  assertStringIncludes(serialized, "lookup_orders");
  assertStringIncludes(serialized, "query");
  assertStringIncludes(serialized, "sku");
  assertStringIncludes(serialized, "order_id");
  assertEquals(serialized.includes('"input"'), false);
});

Deno.test("woocommerce routes only to the adapter executor", async () => {
  let adapterCalls = 0;
  let legacyCalls = 0;

  const result = await executeRoutedCustomTool(context(), wooTool, typedArgs, {
    executeAdapter: () => {
      adapterCalls += 1;
      return Promise.resolve({ output: "adapter result" });
    },
    executeLegacy: () => {
      legacyCalls += 1;
      return Promise.resolve({ output: "legacy result" });
    },
  });

  assertEquals(result.output, "adapter result");
  assertEquals(adapterCalls, 1);
  assertEquals(legacyCalls, 0);
});

Deno.test("custom_rest routes only to the legacy executor", async () => {
  let adapterCalls = 0;
  let legacyCalls = 0;

  const result = await executeRoutedCustomTool(context(), legacyTool, { input: "hello" }, {
    executeAdapter: () => {
      adapterCalls += 1;
      return Promise.resolve({ output: "adapter result" });
    },
    executeLegacy: () => {
      legacyCalls += 1;
      return Promise.resolve({ output: "legacy result" });
    },
  });

  assertEquals(result.output, "legacy result");
  assertEquals(adapterCalls, 0);
  assertEquals(legacyCalls, 1);
});

Deno.test("adapter dryRun performs no network call", async () => {
  let fetchCalls = 0;
  const result = await executeAdapterTool(context(true), wooTool, typedArgs, {
    fetch: () => {
      fetchCalls += 1;
      return Promise.reject(new Error("fetch must not run"));
    },
    getEnv: () => "must-not-be-read",
  });

  assertEquals(fetchCalls, 0);
  assertStringIncludes(result.output, "test mode");
});

Deno.test("adapter structured failure is named and is not empty success", async () => {
  const result = await executeAdapterTool(context(), wooTool, typedArgs, {
    fetch: () => Promise.resolve(Response.json({
      ok: false,
      vendor: "woocommerce",
      error: {
        code: "woocommerce_http_error",
        message: "WooCommerce rejected the request.",
        vendor_status: 401,
      },
    })),
    getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : "service-key",
  });

  assertStringIncludes(result.output, 'Connector "woo_store" failed');
  assertStringIncludes(result.output, "woocommerce_http_error");
  assertStringIncludes(result.output, "401");
  assertEquals(result.output.includes("no results"), false);
});

Deno.test("adapter call uses the in-cluster URL and service-role internal contract", async () => {
  const serviceRoleKey = "internal-service-role-key";
  let capturedRequest: Request | undefined;
  await executeAdapterTool(context(), wooTool, typedArgs, {
    fetch: (request) => {
      capturedRequest = request as Request;
      return Promise.resolve(Response.json({
        ok: true,
        vendor: "woocommerce",
        action: "execute",
        capability: "search_products",
        data: [],
      }));
    },
    getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000/" : serviceRoleKey,
  });

  assertEquals(capturedRequest?.url, "http://kong:8000/functions/v1/ai-agent-adapters");
  assertEquals(capturedRequest?.headers.get("authorization"), `Bearer ${serviceRoleKey}`);
  assertEquals(capturedRequest?.headers.get("apikey"), serviceRoleKey);
  assertEquals(await capturedRequest?.json(), {
    tool_id: wooTool.id,
    user_id: context().userId,
    action: "execute",
    capability: "search_products",
    parameters: { query: "hat" },
  });
});

Deno.test("adapter timeout and non-JSON responses degrade to named failures", async (test) => {
  await test.step("timeout", async () => {
    const result = await executeAdapterTool(context(), wooTool, typedArgs, {
      fetch: (input) => new Promise<Response>((_resolve, reject) => {
        (input as Request).signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
        );
      }),
      getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : "service-key",
      timeoutMs: 1,
    });

    assertStringIncludes(result.output, 'Connector "woo_store" failed');
    assertStringIncludes(result.output, "timed out");
  });

  await test.step("non-JSON", async () => {
    const result = await executeAdapterTool(context(), wooTool, typedArgs, {
      fetch: () => Promise.resolve(new Response("upstream proxy page", { status: 200 })),
      getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : "service-key",
    });

    assertStringIncludes(result.output, 'Connector "woo_store" failed');
    assertStringIncludes(result.output, "invalid response");
    assertEquals(result.output.includes("upstream proxy page"), false);
  });
});

Deno.test("adapter ToolResult never exposes connector or service-role secrets", async () => {
  const serviceRoleKey = "service-role-super-secret";
  const result = await executeAdapterTool(context(), wooTool, typedArgs, {
    fetch: () => Promise.resolve(Response.json({
      ok: false,
      vendor: "woocommerce",
      error: {
        code: "connector_request_failed",
        message: `${serviceRoleKey} ${wooTool.secret}`,
      },
    })),
    getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : serviceRoleKey,
  });

  assertEquals(result.output.includes(serviceRoleKey), false);
  assertEquals(result.output.includes(wooTool.secret!), false);
});
