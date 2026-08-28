import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createEvolutionApi } from "./evolutionApi.ts";
import { disconnectWhatsAppAccount, type WhatsAppDisconnectAdmin } from "./whatsappDisconnect.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedUpdate {
  table: string;
  values: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

// Stands in for the Supabase client the way evolutionQrAccount.test.ts does: the
// assertions are on the rows the teardown would write, not on how it called the
// client. `updateError` makes the write for one table fail, for the propagation case.
function recordingAdmin(
  options: {
    instanceRow?: { instance_name: string } | null;
    updateError?: { table: string; error: unknown };
  } = {},
) {
  const updates: RecordedUpdate[] = [];
  const admin = {
    from(table: string) {
      return {
        select(_columns: string) {
          return {
            eq(_column: string, _value: unknown) {
              return this;
            },
            maybeSingle: () =>
              Promise.resolve({ data: options.instanceRow ?? null, error: null }),
          };
        },
        update(values: Record<string, unknown>) {
          const filters: Array<[string, unknown]> = [];
          const chain = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return chain;
            },
            // The builder resolves only once awaited, which is when the recorded
            // filters are complete -- recording inside eq would miss the scope terms.
            then(
              onFulfilled?: (value: { error: unknown }) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) {
              updates.push({ table, values: { ...values }, filters: [...filters] });
              const error = options.updateError?.table === table
                ? options.updateError.error
                : null;
              return Promise.resolve({ error }).then(
                onFulfilled as never,
                onRejected as never,
              );
            },
          };
          return chain;
        },
      };
    },
  };
  return { updates, admin: admin as unknown as WhatsAppDisconnectAdmin };
}

function evolutionRecorder(
  calls: Array<{ url: string; method?: string }>,
  behavior: { failUrls?: RegExp[] } = {},
) {
  return createEvolutionApi(async (url, init) => {
    const urlText = String(url);
    calls.push({ url: urlText, method: init?.method });
    if (behavior.failUrls?.some((pattern) => pattern.test(urlText))) {
      throw new Error("Evolution unreachable");
    }
    return response({});
  }, { baseUrl: "https://wa.postora.cloud", apiKey: "k" });
}

function graphRecorder(calls: Array<{ url: string; method?: string; authorization?: string }>) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      authorization: (init?.headers as Record<string, string>)?.Authorization,
    });
    return response({ success: true });
  };
}

const deactivationOf = (updates: RecordedUpdate[]) =>
  updates.find((update) => update.table === "social_accounts");

Deno.test("an evolution_qr account is torn down at Evolution, recorded locally, deactivated, and never touches Meta", async () => {
  // Regression, 2026-08-27: disconnect spoke only to the Meta Graph API, so an
  // Evolution QR account deactivated in Postora kept its linked Baileys session
  // (Evolution reported connectionStatus "open" for minutes afterwards) and kept
  // ingesting messages and auto-replying to them.
  const { updates, admin } = recordingAdmin({ instanceRow: { instance_name: "postora_acc-1" } });
  const evolutionCalls: Array<{ url: string; method?: string }> = [];
  const graphCalls: Array<{ url: string; method?: string; authorization?: string }> = [];

  const result = await disconnectWhatsAppAccount(
    {
      accountId: "acc-1",
      workspaceId: "ws-1",
      connectionMode: "evolution_qr",
    },
    {
      admin,
      evolution: evolutionRecorder(evolutionCalls),
      fetcher: graphRecorder(graphCalls),
    },
  );

  assertEquals(evolutionCalls, [
    { url: "https://wa.postora.cloud/instance/logout/postora_acc-1", method: "DELETE" },
    { url: "https://wa.postora.cloud/instance/delete/postora_acc-1", method: "DELETE" },
  ]);
  assertEquals(
    updates.find((update) => update.table === "whatsapp_evolution_instances"),
    {
      table: "whatsapp_evolution_instances",
      values: { last_connection_state: "close", last_qr: null },
      filters: [["social_account_id", "acc-1"]],
    },
  );
  assertEquals(deactivationOf(updates), {
    table: "social_accounts",
    values: { is_active: false },
    filters: [["id", "acc-1"], ["workspace_id", "ws-1"]],
  });
  assertEquals(graphCalls, []);
  assertEquals(result, { deactivated: true, evolution: "ok", graph: "skipped", warnings: [] });
});

Deno.test("a coexistence account unsubscribes the WABA webhook, never touches Evolution, and deactivates", async () => {
  const { updates, admin } = recordingAdmin();
  const evolutionCalls: Array<{ url: string; method?: string }> = [];
  const graphCalls: Array<{ url: string; method?: string; authorization?: string }> = [];

  const result = await disconnectWhatsAppAccount(
    {
      accountId: "acc-2",
      workspaceId: "ws-2",
      connectionMode: "coexistence",
      wabaId: "waba-2",
      accessToken: "token-2",
    },
    {
      admin,
      evolution: evolutionRecorder(evolutionCalls),
      fetcher: graphRecorder(graphCalls),
    },
  );

  assertEquals(graphCalls, [{
    url: "https://graph.facebook.com/v22.0/waba-2/subscribed_apps",
    method: "DELETE",
    authorization: "Bearer token-2",
  }]);
  assertEquals(evolutionCalls, []);
  assertEquals(deactivationOf(updates), {
    table: "social_accounts",
    values: { is_active: false },
    filters: [["id", "acc-2"], ["workspace_id", "ws-2"]],
  });
  assertEquals(result, { deactivated: true, evolution: "skipped", graph: "ok", warnings: [] });
});

Deno.test("a Meta account without a WABA id or token skips the unsubscribe and still deactivates", async () => {
  // Preserves the old whatsapp-oauth behaviour: the Graph call was conditional on
  // both existing, and its absence never blocked the deactivation.
  const { updates, admin } = recordingAdmin();
  const graphCalls: Array<{ url: string; method?: string; authorization?: string }> = [];

  const result = await disconnectWhatsAppAccount(
    {
      accountId: "acc-3",
      workspaceId: "ws-3",
      connectionMode: "cloud_api",
      wabaId: null,
      accessToken: null,
    },
    { admin, fetcher: graphRecorder(graphCalls) },
  );

  assertEquals(graphCalls, []);
  assertEquals(deactivationOf(updates)?.values, { is_active: false });
  assertEquals(result.graph, "skipped");
  assertEquals(result.deactivated, true);
});

Deno.test("an unreachable Evolution server still deactivates the account locally and reports the failed step", async () => {
  // The property that stops a silent half-disconnect: the user can always
  // disconnect, but a failed remote teardown is never reported as clean.
  const { updates, admin } = recordingAdmin({ instanceRow: { instance_name: "postora_acc-4" } });
  const evolutionCalls: Array<{ url: string; method?: string }> = [];
  const graphCalls: Array<{ url: string; method?: string; authorization?: string }> = [];

  const result = await disconnectWhatsAppAccount(
    {
      accountId: "acc-4",
      workspaceId: "ws-4",
      connectionMode: "evolution_qr",
    },
    {
      admin,
      evolution: evolutionRecorder(evolutionCalls, { failUrls: [/instance\//] }),
      fetcher: graphRecorder(graphCalls),
    },
  );

  // BOTH assertions matter: deactivation happened AND the caller can see the
  // remote session may still be live.
  assertEquals(result.deactivated, true);
  assertEquals(result.evolution, "failed");
  assertEquals(result.warnings.length, 2);
  assertEquals(deactivationOf(updates)?.values, { is_active: false });
  assertEquals(graphCalls, []);
});

Deno.test("a logout that succeeds while the delete fails still reports a partial remote teardown", async () => {
  // Logging out ends the linked session but leaves the instance registered; the
  // caller must be able to tell that apart from a full teardown.
  const { updates, admin } = recordingAdmin({ instanceRow: { instance_name: "postora_acc-5" } });
  const evolutionCalls: Array<{ url: string; method?: string }> = [];

  const result = await disconnectWhatsAppAccount(
    {
      accountId: "acc-5",
      workspaceId: "ws-5",
      connectionMode: "evolution_qr",
    },
    {
      admin,
      evolution: evolutionRecorder(evolutionCalls, { failUrls: [/instance\/delete/] }),
    },
  );

  assertEquals(evolutionCalls.length, 2);
  assertEquals(result.evolution, "failed");
  assertEquals(result.deactivated, true);
  assertEquals(deactivationOf(updates)?.values, { is_active: false });
});

Deno.test("an evolution_qr account with no instance row is treated as skipped and still deactivates", async () => {
  // A provisioning failure or an already-removed instance must not make the
  // instance lookup an error the user cannot get past.
  const { updates, admin } = recordingAdmin({ instanceRow: null });
  const evolutionCalls: Array<{ url: string; method?: string }> = [];

  const result = await disconnectWhatsAppAccount(
    {
      accountId: "acc-6",
      workspaceId: "ws-6",
      connectionMode: "evolution_qr",
    },
    { admin, evolution: evolutionRecorder(evolutionCalls) },
  );

  assertEquals(evolutionCalls, []);
  assertEquals(result.evolution, "skipped");
  assertEquals(result.deactivated, true);
  assertEquals(deactivationOf(updates)?.values, { is_active: false });
});

Deno.test("a failed local deactivation is raised, not swallowed", async () => {
  // A no-op update (no matching row, rejected write) is exactly the half-disconnect
  // state this module exists to make impossible, so it is the one error that throws.
  const { updates, admin } = recordingAdmin({
    instanceRow: { instance_name: "postora_acc-7" },
    updateError: { table: "social_accounts", error: { message: "row is locked" } },
  });

  // The raw database error object propagates, matching how every other write in
  // this code base surfaces a rejected statement.
  const rejection = await assertRejects(
    () =>
      disconnectWhatsAppAccount(
        {
          accountId: "acc-7",
          workspaceId: "ws-7",
          connectionMode: "evolution_qr",
        },
        { admin, evolution: evolutionRecorder([]) },
      ),
  );
  assertEquals(rejection, { message: "row is locked" });
  assertEquals(deactivationOf(updates)?.values, { is_active: false });
});

Deno.test("an account with no workspace scoping deactivates by id alone", async () => {
  // Legacy bridge rows predate workspace scoping; their id is a UUID primary key,
  // which is a sufficient scope on its own.
  const { updates, admin } = recordingAdmin();

  const result = await disconnectWhatsAppAccount(
    {
      accountId: "acc-8",
      workspaceId: null,
      connectionMode: "coexistence",
      wabaId: "waba-8",
      accessToken: "token-8",
    },
    { admin, fetcher: graphRecorder([]) },
  );

  assertEquals(deactivationOf(updates), {
    table: "social_accounts",
    values: { is_active: false },
    filters: [["id", "acc-8"]],
  });
  assertEquals(result.deactivated, true);
});
