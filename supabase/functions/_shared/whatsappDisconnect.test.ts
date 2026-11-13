import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createEvolutionApi } from "./evolutionApi.ts";
import {
  disconnectWhatsAppAccount,
  reconnectWhatsAppAccount,
  type WhatsAppDisconnectAdmin,
} from "./whatsappDisconnect.ts";

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

interface RecordedRpc {
  name: string;
  args: Record<string, unknown>;
}

// Stands in for the Supabase client the way evolutionQrAccount.test.ts does: the
// assertions are on the rows the teardown would write, not on how it called the
// client. `updateError` makes the write for one table fail, for the propagation case.
// `rpcData` is what the RPC returned: the deliberate-disconnect marker writes `true`
// when it wrote the marker and `false` when the row did not match, and the teardown
// treats anything but `true` as a failed mark.
function recordingAdmin(
  options: {
    instanceRow?: { instance_name: string } | null;
    updateError?: { table: string; error: unknown };
    rpcError?: unknown;
    rpcData?: unknown;
  } = {},
) {
  const updates: RecordedUpdate[] = [];
  const rpcs: RecordedRpc[] = [];
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      return Promise.resolve({
        data: options.rpcData === undefined ? true : options.rpcData,
        error: options.rpcError ?? null,
      });
    },
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
  return { updates, rpcs, admin: admin as unknown as WhatsAppDisconnectAdmin };
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

Deno.test("a deliberate evolution_qr disconnect is marked as deliberate", async () => {
  // A disconnect the owner asked for is not an outage: without the marker the watcher
  // would alert them about the session they just closed on purpose.
  const { rpcs, admin } = recordingAdmin({ instanceRow: { instance_name: "postora_acc-1" } });

  await disconnectWhatsAppAccount(
    { accountId: "acc-1", workspaceId: "ws-1", connectionMode: "evolution_qr" },
    { admin, evolution: evolutionRecorder([]), fetcher: graphRecorder([]) },
  );

  assertEquals(rpcs, [
    { name: "mark_whatsapp_user_disconnected", args: { p_account_id: "acc-1" } },
  ]);
});

Deno.test("a Meta-mode disconnect is not marked as deliberate", async () => {
  // The watcher only polls Evolution QR accounts, so a Meta-mode account needs no marker.
  const { rpcs, admin } = recordingAdmin();

  await disconnectWhatsAppAccount(
    { accountId: "acc-1", workspaceId: "ws-1", connectionMode: "coexistence" },
    { admin, evolution: evolutionRecorder([]), fetcher: graphRecorder([]) },
  );

  assertEquals(rpcs, []);
});

Deno.test("a failed deliberate mark stops the disconnect before anything is torn down", async () => {
  // Without the marker the watcher would see the closed session as an outage and email the
  // owner about a disconnect they asked for, so the teardown must not start unmarked.
  const { admin, updates } = recordingAdmin({
    instanceRow: { instance_name: "postora_acc-1" },
    rpcError: { message: "mark failed" },
  });
  const evolutionCalls: Array<{ url: string; method?: string }> = [];

  await assertRejects(() =>
    disconnectWhatsAppAccount(
      { accountId: "acc-1", workspaceId: "ws-1", connectionMode: "evolution_qr" },
      { admin, evolution: evolutionRecorder(evolutionCalls), fetcher: graphRecorder([]) },
    )
  );

  assertEquals(evolutionCalls, []);
  assertEquals(updates, []);
});

Deno.test("a deliberate mark that wrote nothing stops the disconnect before anything is torn down", async () => {
  // The RPC answers `false` when the row did not match its predicate: nothing was
  // written, so the watcher would still read the session as an outage and alert the
  // owner about a disconnect they asked for. An unanswered mark is not a successful one.
  const { admin, updates } = recordingAdmin({
    instanceRow: { instance_name: "postora_acc-1" },
    rpcData: false,
  });
  const evolutionCalls: Array<{ url: string; method?: string }> = [];

  await assertRejects(() =>
    disconnectWhatsAppAccount(
      { accountId: "acc-1", workspaceId: "ws-1", connectionMode: "evolution_qr" },
      { admin, evolution: evolutionRecorder(evolutionCalls), fetcher: graphRecorder([]) },
    )
  );

  assertEquals(evolutionCalls, []);
  assertEquals(updates, []);
});

Deno.test("a failed deactivation rolls the deliberate marker back and rethrows", async () => {
  // The marker is written before the deactivation. When the deactivation fails, the row
  // stays active WITH the marker, and the watcher skips every account that carries it:
  // a live account whose session is gone would never be polled again. The marker goes
  // back, and the caller still sees the deactivation failure.
  const { rpcs, admin, updates } = recordingAdmin({
    instanceRow: { instance_name: "postora_acc-7" },
    updateError: { table: "social_accounts", error: { message: "row is locked" } },
  });

  const rejection = await assertRejects(
    () =>
      disconnectWhatsAppAccount(
        { accountId: "acc-7", workspaceId: "ws-7", connectionMode: "evolution_qr" },
        { admin, evolution: evolutionRecorder([]) },
      ),
  );

  assertEquals(rejection, { message: "row is locked" });
  assertEquals(rpcs, [
    { name: "mark_whatsapp_user_disconnected", args: { p_account_id: "acc-7" } },
    { name: "unmark_whatsapp_user_disconnected", args: { p_account_id: "acc-7" } },
  ]);
  assertEquals(deactivationOf(updates)?.values, { is_active: false });
});

Deno.test("a failed deactivation of a Meta account rolls no marker back", async () => {
  // A Meta-mode disconnect never writes the marker, so there is nothing to undo.
  const { rpcs, admin } = recordingAdmin({
    updateError: { table: "social_accounts", error: { message: "row is locked" } },
  });

  await assertRejects(() =>
    disconnectWhatsAppAccount(
      {
        accountId: "acc-8",
        workspaceId: "ws-8",
        connectionMode: "coexistence",
        wabaId: "waba-8",
        accessToken: "token-8",
      },
      { admin, fetcher: graphRecorder([]) },
    )
  );

  assertEquals(rpcs, []);
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

Deno.test("reconnect resubscribes the WABA webhook and reactivates the account", async () => {
  // The state this exists for: a healthy, already-onboarded coexistence number
  // that the product disconnected. Embedded Signup lists numbers available to
  // ONBOARD, so it never shows this one and the operator has no way back.
  const { updates, admin, rpcs } = recordingAdmin();
  const graphCalls: Array<{ url: string; method?: string; authorization?: string }> = [];

  const result = await reconnectWhatsAppAccount(
    {
      accountId: "acc-9",
      workspaceId: "ws-9",
      connectionMode: "coexistence",
      wabaId: "waba-9",
      accessToken: "token-9",
    },
    { admin, fetcher: graphRecorder(graphCalls) },
  );

  assertEquals(graphCalls, [{
    url: "https://graph.facebook.com/v22.0/waba-9/subscribed_apps",
    method: "POST",
    authorization: "Bearer token-9",
  }]);
  assertEquals(deactivationOf(updates), {
    table: "social_accounts",
    values: { is_active: true },
    filters: [["id", "acc-9"], ["workspace_id", "ws-9"]],
  });
  assertEquals(rpcs, [{
    name: "clear_undelivered_store_events",
    args: { p_account_id: "acc-9" },
  }]);
  assertEquals(result, { deactivated: false, evolution: "skipped", graph: "ok", warnings: [] });
});

Deno.test("reconnect succeeds even when clear_undelivered_store_events RPC fails", async () => {
  const { updates, admin, rpcs } = recordingAdmin({ rpcError: new Error("rpc failed") });

  const result = await reconnectWhatsAppAccount(
    {
      accountId: "acc-9",
      workspaceId: "ws-9",
      connectionMode: "coexistence",
      wabaId: "waba-9",
      accessToken: "token-9",
    },
    { admin, fetcher: graphRecorder([]) },
  );

  assertEquals(result.deactivated, false);
  assertEquals(rpcs.length, 1);
  assertEquals(rpcs[0], {
    name: "clear_undelivered_store_events",
    args: { p_account_id: "acc-9" },
  });
  assertEquals(deactivationOf(updates)?.values, { is_active: true });
});

Deno.test("reconnect leaves the account disconnected when the resubscribe fails", async () => {
  // The inverse of disconnect's best-effort rule. Reactivating a row whose
  // webhook subscription is still missing yields an account that looks connected
  // and silently receives nothing -- the exact state being escaped.
  const { updates, admin } = recordingAdmin();

  await assertRejects(() =>
    reconnectWhatsAppAccount(
      {
        accountId: "acc-10",
        workspaceId: "ws-10",
        connectionMode: "coexistence",
        wabaId: "waba-10",
        accessToken: "token-10",
      },
      { admin, fetcher: () => Promise.resolve(response({ error: "nope" }, 400)) },
    )
  );

  assertEquals(deactivationOf(updates), undefined);
});

Deno.test("reconnect refuses a Direct QR account", async () => {
  // A logged-out Baileys session cannot be restored by resubscribing; the
  // operator has to scan a new QR, and pretending otherwise would reactivate a
  // row with no live session behind it.
  const { updates, admin } = recordingAdmin();

  await assertRejects(() =>
    reconnectWhatsAppAccount(
      { accountId: "acc-11", workspaceId: "ws-11", connectionMode: "evolution_qr" },
      { admin, fetcher: graphRecorder([]) },
    )
  );

  assertEquals(updates.length, 0);
});

Deno.test("reconnect refuses an account missing its WABA id or token", async () => {
  const { updates, admin } = recordingAdmin();

  await assertRejects(() =>
    reconnectWhatsAppAccount(
      { accountId: "acc-12", workspaceId: "ws-12", connectionMode: "coexistence", wabaId: null, accessToken: "t" },
      { admin, fetcher: graphRecorder([]) },
    )
  );

  assertEquals(updates.length, 0);
});
