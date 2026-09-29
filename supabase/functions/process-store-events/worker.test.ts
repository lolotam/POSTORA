import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { TemplateGraph } from "../_shared/procedures/eventTemplates.ts";
import { openerText } from "../_shared/procedures/openers.ts";
import {
  accountSkipReason,
  runStoreEventWorker,
  STORE_EVENT_LIMITS,
  storeSkipReason,
  type AccountContext,
  type SendOutcome,
  type StoreEventRow,
  type StoreRead,
  type StoreSnapshot,
  type StoreEventLog,
  type ThreadRow,
  type WorkerPorts,
} from "./worker.ts";

const PHONE = "96555512345";
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

function event(overrides: Partial<StoreEventRow> = {}): StoreEventRow {
  const row: StoreEventRow = {
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "user-1",
    social_account_id: "account-1",
    connector_id: "connector-1",
    binding_id: "binding-1",
    flow: "cod_confirm",
    external_id: "1042",
    payload: { phone: PHONE, first_name: "Sara", order_number: "1042", order_id: "1042", total: "12.500", currency: "KWD" },
    status: "claimed",
    claim_token: "token-1",
    due_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(),
    attempts: 1,
    outbound_message_id: null,
    ...overrides,
  };
  if (overrides.created_at === undefined) row.created_at = row.due_at;
  return row;
}

function account(overrides: Partial<AccountContext> = {}): AccountContext {
  return {
    platform: "whatsapp",
    connectionMode: "cloud_api",
    phoneNumberId: "pnid",
    platformUserId: "pnid",
    languageMode: "en",
    agentEnabled: true,
    defaultMode: "ai_first",
    settings: { enabled: true, prompts: {}, closing: "", consent_attested_at: "2026-09-01T00:00:00.000Z" },
    connectorVisible: true,
    connectorReadOnly: false,
    optedOut: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    paymentMethod: "cod",
    status: "processing",
    phone: PHONE,
    createdAt: new Date(NOW - 60_000).toISOString(),
    stockStatus: "instock",
    ...overrides,
  };
}

function pending(runId: string) {
  const at = new Date(NOW).toISOString();
  return {
    run_id: runId,
    key: "cod_confirm" as const,
    version: 1,
    step: 0,
    fields: {},
    off_script: 0,
    origin: "event" as const,
    phase: "pending_opener" as const,
    started_at: at,
    updated_at: at,
  };
}

interface Harness {
  ports: WorkerPorts;
  row: StoreEventRow;
  sends: SendOutcome[];
  records: string[];
  persists: Array<{ expected: unknown; next: unknown }>;
  alerts: string[];
  logs: StoreEventLog[];
  qrReleases: number;
  qrReserveEventIds: string[];
  qrReleaseEventIds: string[];
  qrReserveLimits: number[];
  deleted: number;
  thread: ThreadRow;
}

function harness(options: {
  row?: StoreEventRow;
  rows?: StoreEventRow[];
  account?: AccountContext | null;
  store?: StoreSnapshot | null;
  read?: StoreRead;
  thread?: ThreadRow;
  send?: SendOutcome;
  template?: "approved" | "pending" | "rejected" | "missing";
  graph?: TemplateGraph | null;
  reserve?: boolean;
  now?: () => number;
  update?: WorkerPorts["updateEvent"];
} = {}): Harness {
  const row = options.row ?? event();
  const rows = options.rows ?? [row];
  const state: Harness = {
    ports: {} as WorkerPorts,
    row,
    sends: [],
    records: [],
    persists: [],
    alerts: [],
    logs: [],
    qrReleases: 0,
    qrReserveEventIds: [],
    qrReleaseEventIds: [],
    qrReserveLimits: [],
    deleted: 0,
    thread: options.thread ?? { id: "thread-1", procedure_state: null },
  };
  const apply = options.update ?? (async (id, token, patch) => {
    const target = rows.find((item) => item.id === id && item.claim_token === token);
    if (!target) return false;
    Object.assign(target, patch);
    return true;
  });
  state.ports = {
    now: options.now ?? (() => NOW),
    claim: () => Promise.resolve(rows),
    updateEvent: apply,
    releaseClaim: async (id, token) => {
      const target = rows.find((item) =>
        item.id === id
        && item.claim_token === token
        && (item.status === "claimed" || item.status === "sending")
        && !item.outbound_message_id
      );
      if (!target) return false;
      Object.assign(target, { status: "pending", claim_token: "released" });
      return true;
    },
    loadAccount: () => Promise.resolve(options.account === undefined ? account() : options.account),
    readStore: () => Promise.resolve(options.read ?? (
      options.store === undefined
        ? { outcome: "snapshot" as const, snapshot: snapshot() }
        : options.store === null
          ? { outcome: "absent" as const }
          : { outcome: "snapshot" as const, snapshot: options.store }
    )),
    reserveQr: (_accountId, limit, eventId) => {
      state.qrReserveEventIds.push(eventId);
      state.qrReserveLimits.push(limit);
      return Promise.resolve(options.reserve !== false);
    },
    releaseQr: (_accountId, eventId) => {
      state.qrReleases += 1;
      state.qrReleaseEventIds.push(eventId);
      return Promise.resolve();
    },
    ensureThread: () => Promise.resolve(state.thread),
    findThread: () => Promise.resolve(state.thread),
    persistState: (_threadId, expected, next) => {
      state.persists.push({ expected, next });
      state.thread = { ...state.thread, procedure_state: next };
      return Promise.resolve(true);
    },
    templateStatus: () => Promise.resolve({
      status: options.template ?? "approved",
      name: "postora_cod_confirm_v1",
      language: "en",
      category: "UTILITY",
    }),
    templateGraph: () => Promise.resolve(options.graph === undefined ? null : options.graph),
    sendOpener: () => {
      const outcome = options.send ?? { accepted: true as const, messageId: "wamid.1" };
      state.sends.push(outcome);
      return Promise.resolve(outcome);
    },
    recordOpener: (input) => {
      state.records.push(input.text);
      return Promise.resolve();
    },
    deleteWaitlist: () => {
      state.deleted += 1;
      return Promise.resolve();
    },
    alertAdmin: (_event, reason) => {
      state.alerts.push(reason);
      return Promise.resolve();
    },
    logEvent: (entry) => {
      state.logs.push(entry);
      return Promise.resolve();
    },
  };
  return state;
}

function activated(box: Harness): boolean {
  return box.persists.some((call) => (call.next as { phase?: string } | null)?.phase === "active");
}

function qrAccount(): AccountContext {
  return account({
    connectionMode: "evolution_qr",
    platformUserId: "qr-user",
    phoneNumberId: null,
    settings: {
      enabled: true,
      prompts: {},
      closing: "",
      consent_attested_at: "2026-09-01T00:00:00.000Z",
      qr_risk_acknowledged_at: "2026-09-01T00:00:00.000Z",
    },
  });
}

function reasonOf(row: StoreEventRow): string | undefined {
  return (row as StoreEventRow & { skip_reason?: string }).skip_reason;
}

Deno.test("each account and store skip reason is recorded and nothing is sent", async () => {
  const cases: Array<{ name: string; account?: AccountContext | null; store?: StoreSnapshot | null; row?: StoreEventRow; reason: string }> = [
    { name: "missing account", account: null, reason: "account_unavailable" },
    { name: "not whatsapp", account: account({ platform: "instagram" }), reason: "not_whatsapp" },
    { name: "flow disabled", account: account({ settings: { enabled: false, prompts: {}, closing: "" } }), reason: "flow_disabled" },
    { name: "agent disabled", account: account({ agentEnabled: false }), reason: "agent_disabled" },
    { name: "human first", account: account({ defaultMode: "human_first" }), reason: "engagement_mode" },
    { name: "connector hidden", account: account({ connectorVisible: false }), reason: "connector_not_visible" },
    { name: "opted out", account: account({ optedOut: true }), reason: "opted_out" },
    { name: "too old", row: event({ due_at: new Date(NOW - 49 * 60 * 60 * 1000).toISOString() }), reason: "expired" },
    { name: "qr risk", account: account({ connectionMode: "evolution_qr", platformUserId: "qr-user", phoneNumberId: null }), reason: "qr_risk_unacknowledged" },
    { name: "consent", account: account({ settings: { enabled: true, prompts: {}, closing: "" } }), reason: "consent_missing" },
    { name: "store unread", store: null, reason: "store_unread" },
    { name: "payment", store: snapshot({ paymentMethod: "bacs" }), reason: "payment_method_changed" },
    { name: "status", store: snapshot({ status: "completed" }), reason: "status_changed" },
    { name: "phone", store: snapshot({ phone: "966500000000" }), reason: "phone_changed" },
    { name: "order age", store: snapshot({ createdAt: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString() }), reason: "order_too_old" },
    {
      name: "review",
      row: event({ flow: "review_request" }),
      store: snapshot({ status: "refunded" }),
      reason: "review_not_completed",
    },
    {
      name: "stock",
      row: event({ flow: "back_in_stock", payload: { phone: PHONE, product_id: "9", product_name: "Rose" } }),
      account: account({ settings: { enabled: true, prompts: {}, closing: "" } }),
      store: snapshot({ stockStatus: "outofstock" }),
      reason: "not_instock",
    },
  ];
  for (const item of cases) {
    const box = harness({ row: item.row, account: item.account, store: item.store });
    await runStoreEventWorker(box.ports);
    assertEquals(reasonOf(box.row), item.reason, item.name);
    assertEquals(box.row.status, "skipped", item.name);
    assertEquals(box.sends.length, 0, item.name);
  }
});

Deno.test("engagement mode uses the reply gate and human_then_ai still sends", () => {
  const row = event();
  assertEquals(accountSkipReason(row, account({ defaultMode: "human_then_ai" }), NOW), null);
  // resolveEngagementMode maps an unknown mode to human_then_ai, so it is not a skip.
  assertEquals(accountSkipReason(row, account({ defaultMode: "nope" }), NOW), null);
  assertEquals(storeSkipReason("review_request", { phone: PHONE }, snapshot({ status: "completed" }), NOW), null);
});

Deno.test("a successful send activates the procedure and records the opener", async () => {
  const box = harness();
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.sent, 1);
  assertEquals(box.row.status, "sent");
  assertEquals(box.row.outbound_message_id, "wamid.1");
  assertEquals(box.records, [openerText("cod_confirm", "en", box.row.payload)]);
  const activation = box.persists.at(-1);
  assertEquals((activation?.expected as { phase?: string })?.phase, "pending_opener");
  assertEquals((activation?.next as { phase?: string })?.phase, "active");
});

Deno.test("own pending_opener resumes into a send", async () => {
  const row = event();
  const box = harness({ thread: { id: "thread-1", procedure_state: pending(row.id) } });
  await runStoreEventWorker(box.ports);
  assertEquals(box.sends.length, 1);
  assertEquals(box.persists.length, 1);
  assertEquals((box.persists[0].next as { phase?: string }).phase, "active");
});

Deno.test("a transient store read releases the claim instead of skipping", async () => {
  const box = harness({ read: { outcome: "transient" } });
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.released, 1);
  assertEquals(summary.skipped, 0);
  assertEquals(box.row.status, "pending");
  assertEquals(reasonOf(box.row), undefined);
  assertEquals(box.sends.length, 0);
});

Deno.test("a definitive store miss is skipped as store_unread", async () => {
  const box = harness({ read: { outcome: "absent" } });
  await runStoreEventWorker(box.ports);
  assertEquals(box.row.status, "skipped");
  assertEquals(reasonOf(box.row), "store_unread");
  assertEquals(box.sends.length, 0);
});

Deno.test("a reclaimed sending row with a provider message id finishes without resending", async () => {
  const row = event({ status: "sending", outbound_message_id: "wamid.kept" });
  const box = harness({
    row,
    thread: { id: "thread-1", procedure_state: pending(row.id) },
  });
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.sent, 1);
  assertEquals(box.sends.length, 0);
  assertEquals(box.row.status, "sent");
  assertEquals(box.records.length, 1);
  assertEquals(box.alerts.length, 0);
  assertEquals((box.persists.at(-1)?.expected as { phase?: string }).phase, "pending_opener");
  assertEquals((box.persists.at(-1)?.next as { phase?: string }).phase, "active");
});

Deno.test("a reclaimed back-in-stock send deletes the waitlist without resending", async () => {
  const row = event({
    status: "sending",
    outbound_message_id: "wamid.stock",
    flow: "back_in_stock",
    external_id: "waitlist:row-1",
    payload: { phone: PHONE, product_id: "9", product_name: "Rose", first_name: "Sara" },
  });
  const box = harness({
    row,
    account: account({ settings: { enabled: true, prompts: {}, closing: "" } }),
    thread: { id: "thread-1", procedure_state: { ...pending(row.id), key: "back_in_stock" } },
  });
  await runStoreEventWorker(box.ports);
  assertEquals(box.sends.length, 0);
  assertEquals(box.deleted, 1);
  assertEquals(box.row.status, "sent");
  assertEquals(box.records.length, 1);
});

Deno.test("an expired sending row without a message id is never resent", async () => {
  const row = event({ status: "sending" });
  const box = harness({
    row,
    thread: { id: "thread-1", procedure_state: pending(row.id) },
  });
  await runStoreEventWorker(box.ports);
  assertEquals(box.sends.length, 0);
  assertEquals(box.row.status, "failed");
  assertEquals(reasonOf(box.row), "indeterminate");
  assertEquals(box.alerts, ["indeterminate"]);
  assertEquals(box.persists.at(-1)?.next, null);
});

Deno.test("a definite send failure clears the opener state and releases the QR slot", async () => {
  const box = harness({
    account: qrAccount(),
    send: { accepted: false, definite: true, reason: "recipient 96555512345 unreachable" },
  });
  await runStoreEventWorker(box.ports);
  assertEquals(box.row.status, "failed");
  assertEquals(reasonOf(box.row)?.includes(PHONE), false);
  assertEquals(box.qrReleases, 1);
  assertEquals(box.persists.some((call) => call.next === null), true);
  assertEquals(activated(box), false);
});

Deno.test("an indeterminate send fails the row, alerts, and keeps the QR slot", async () => {
  const box = harness({
    account: qrAccount(),
    send: { accepted: false, definite: false },
  });
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.failed, 1);
  assertEquals(box.row.status, "failed");
  assertEquals(reasonOf(box.row), "indeterminate");
  assertEquals(box.alerts, ["indeterminate"]);
  assertEquals(box.qrReleases, 0);
  assertEquals(activated(box), false);
  assertEquals(box.sends.length, 1);
});

Deno.test("QR reserve and release receive the store event id", async () => {
  const at = new Date(NOW).toISOString();
  const cases: Array<{ name: string; releases: number; prepare: (box: Harness) => void }> = [
    {
      name: "definite send failure",
      releases: 1,
      prepare: (box) => {
        box.ports.sendOpener = () => {
          const outcome = { accepted: false as const, definite: true as const, reason: "unreachable" };
          box.sends.push(outcome);
          return Promise.resolve(outcome);
        };
      },
    },
    {
      name: "opener clear lost after a definite failure",
      releases: 1,
      prepare: (box) => {
        box.thread = { id: "thread-1", procedure_state: pending(box.row.id) };
        box.ports.ensureThread = () => Promise.resolve(box.thread);
        box.ports.sendOpener = () => {
          const outcome = { accepted: false as const, definite: true as const, reason: "unreachable" };
          box.sends.push(outcome);
          return Promise.resolve(outcome);
        };
        box.ports.persistState = () => Promise.resolve(false);
      },
    },
    {
      name: "another live procedure",
      releases: 1,
      prepare: (box) => {
        box.thread = {
          id: "thread-1",
          procedure_state: {
            run_id: "other",
            key: "order_status",
            version: 1,
            step: 0,
            fields: {},
            off_script: 0,
            origin: "model",
            started_at: at,
            updated_at: at,
          },
        };
        box.ports.ensureThread = () => Promise.resolve(box.thread);
      },
    },
    {
      name: "already active for this event",
      releases: 1,
      prepare: (box) => {
        box.thread = { id: "thread-1", procedure_state: { ...pending(box.row.id), phase: "active" } };
        box.ports.ensureThread = () => Promise.resolve(box.thread);
      },
    },
    {
      name: "claim token lost before sending",
      releases: 1,
      prepare: (box) => {
        const row = box.row;
        box.ports.updateEvent = async (id, token, patch) => {
          if (patch.status === "sending") return false;
          if (row.id !== id || row.claim_token !== token) return false;
          Object.assign(row, patch);
          return true;
        };
      },
    },
    {
      name: "pending state did not persist",
      releases: 1,
      prepare: (box) => {
        box.ports.persistState = () => Promise.resolve(false);
      },
    },
    {
      name: "worker threw before sending",
      releases: 1,
      prepare: (box) => {
        box.ports.ensureThread = () => Promise.reject(new Error("db down"));
      },
    },
    {
      name: "daily cap refused",
      releases: 0,
      prepare: (box) => {
        box.ports.reserveQr = (_accountId, limit, eventId) => {
          box.qrReserveEventIds.push(eventId);
          box.qrReserveLimits.push(limit);
          return Promise.resolve(false);
        };
      },
    },
    {
      name: "accepted send keeps the slot",
      releases: 0,
      prepare: () => {},
    },
  ];

  for (const item of cases) {
    const box = harness({ account: qrAccount() });
    item.prepare(box);
    await runStoreEventWorker(box.ports);
    assertEquals(box.qrReserveEventIds, [box.row.id], item.name);
    assertEquals(box.qrReserveLimits, [STORE_EVENT_LIMITS.qrDailyCap], item.name);
    assertEquals(box.qrReleaseEventIds, item.releases === 0 ? [] : [box.row.id], item.name);
  }
});

Deno.test("the QR daily cap skips without a send", async () => {
  const box = harness({
    reserve: false,
    account: account({
      connectionMode: "evolution_qr",
      platformUserId: "qr-user",
      phoneNumberId: null,
      settings: {
        enabled: true,
        prompts: {},
        closing: "",
        consent_attested_at: "2026-09-01T00:00:00.000Z",
        qr_risk_acknowledged_at: "2026-09-01T00:00:00.000Z",
      },
    }),
  });
  await runStoreEventWorker(box.ports);
  assertEquals(reasonOf(box.row), "qr_daily_cap");
  assertEquals(box.sends.length, 0);
  assertEquals(box.qrReleases, 0);
});

Deno.test("a rejected template skips and clears the opener state", async () => {
  let graphs = 0;
  const box = harness({ template: "rejected" });
  box.ports.templateGraph = () => {
    graphs += 1;
    return Promise.resolve(null);
  };
  await runStoreEventWorker(box.ports);
  assertEquals(graphs, 0);
  assertEquals(reasonOf(box.row), "template_not_approved");
  assertEquals(box.sends.length, 0);
  assertEquals(box.persists.some((call) => call.next === null), true);
  assertEquals(activated(box), false);
  assertEquals(box.row.attempts, 1);
});

Deno.test("a missing template with no WhatsApp graph skips as template_not_approved", async () => {
  const box = harness({ template: "missing", graph: null });
  await runStoreEventWorker(box.ports);
  assertEquals(reasonOf(box.row), "template_not_approved");
  assertEquals(box.sends.length, 0);
  assertEquals(box.persists.some((call) => call.next === null), true);
  assertEquals(box.row.attempts, 1);
});

Deno.test("a missing template is submitted in the account language and deferred", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const box = harness({
    template: "missing",
    row: event({ attempts: 1 }),
    graph: {
      list: () => Promise.resolve([]),
      create: (body) => {
        creates.push(body);
        return Promise.resolve({ id: "tpl-1" });
      },
    },
  });
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.released, 1);
  assertEquals(summary.skipped, 0);
  assertEquals(creates.length, 1);
  assertEquals(creates[0].language, "en");
  assertEquals(creates[0].name, "postora_cod_confirm_v1");
  assertEquals(box.row.status, "pending");
  assertEquals(box.row.attempts, 0);
  assertEquals(box.row.due_at, new Date(NOW + 15 * 60 * 1000).toISOString());
  assertEquals(box.row.payload.original_due_at, new Date(NOW).toISOString());
  assertEquals(box.row.claim_token, null);
  assertEquals(box.sends.length, 0);
  assertEquals(box.persists.some((call) => call.next === null), true);
  assertEquals(activated(box), false);
  assertEquals(box.logs[0]?.metadata.reason, "template_pending");
});

function failOpenerClear(box: Harness): void {
  const original = box.ports.persistState;
  box.ports.persistState = (threadId, expected, next) => {
    if (next === null) return Promise.resolve(false);
    return original(threadId, expected, next);
  };
}

Deno.test("a failed opener clear on an indeterminate row leaves it sending and does not resend", async () => {
  const row = event({ status: "sending" });
  const box = harness({
    row,
    thread: { id: "thread-1", procedure_state: pending(row.id) },
  });
  failOpenerClear(box);
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.failed, 0);
  assertEquals(summary.released, 0);
  assertEquals(summary.sent, 0);
  assertEquals(box.sends.length, 0);
  assertEquals(box.row.status, "sending");
  assertEquals(box.row.claim_token, "token-1");
  assertEquals(box.row.outbound_message_id, null);
  assertEquals(box.alerts.length, 0);
  assertEquals((box.thread.procedure_state as { phase?: string }).phase, "pending_opener");
});

Deno.test("a failed opener clear on a rejected template releases the claim instead of skipping", async () => {
  const box = harness({ template: "rejected" });
  failOpenerClear(box);
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.skipped, 0);
  assertEquals(summary.released, 1);
  assertEquals(box.row.status, "pending");
  assertEquals(reasonOf(box.row), undefined);
  assertEquals(box.sends.length, 0);
  assertEquals((box.thread.procedure_state as { phase?: string }).phase, "pending_opener");
  assertEquals(box.logs.some((entry) => entry.metadata.reason === "template_not_approved"), false);
});

Deno.test("a pending template is deferred and the claim attempt is given back", async () => {
  const box = harness({ template: "pending", row: event({ attempts: 1 }) });
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.released, 1);
  assertEquals(summary.skipped, 0);
  assertEquals(box.row.status, "pending");
  assertEquals(box.row.attempts, 0);
  assertEquals(box.row.due_at, new Date(NOW + 15 * 60 * 1000).toISOString());
  assertEquals(box.row.payload.original_due_at, new Date(NOW).toISOString());
  assertEquals(box.row.claim_token, null);
  assertEquals(box.sends.length, 0);
  assertEquals(box.persists.some((call) => call.next === null), true);
  assertEquals(activated(box), false);
  assertEquals(box.logs, [{
    source: "process-store-events",
    category: "ai",
    level: "info",
    message: "Store event deferred",
    user_id: "user-1",
    metadata: {
      event_id: box.row.id,
      flow: "cod_confirm",
      social_account_id: "account-1",
      reason: "template_pending",
    },
  }]);

  box.row.status = "claimed";
  box.row.claim_token = "token-1";
  box.row.attempts = 1;
  box.logs.length = 0;
  await runStoreEventWorker(box.ports);
  assertEquals(box.row.payload.original_due_at, new Date(NOW).toISOString());
  assertEquals(box.row.attempts, 0);
});

Deno.test("a pending template past the original due time is skipped as stale", async () => {
  const staleAt = new Date(NOW - 49 * 60 * 60 * 1000).toISOString();
  const freshAt = new Date(NOW).toISOString();
  const cases: Array<{ name: string; row: StoreEventRow }> = [
    {
      name: "cod created_at",
      row: event({ attempts: 1, created_at: staleAt, due_at: freshAt }),
    },
    {
      name: "back in stock created_at",
      row: event({
        flow: "back_in_stock",
        attempts: 1,
        created_at: staleAt,
        due_at: freshAt,
        payload: { phone: PHONE, product_id: "9", product_name: "Rose" },
      }),
    },
    {
      name: "review original_due_at",
      row: event({
        flow: "review_request",
        attempts: 1,
        created_at: freshAt,
        due_at: freshAt,
        payload: {
          phone: PHONE,
          first_name: "Sara",
          order_number: "1042",
          order_id: "1042",
          original_due_at: staleAt,
        },
      }),
    },
  ];
  for (const item of cases) {
    const box = harness({
      template: "pending",
      row: item.row,
      account: item.row.flow === "back_in_stock"
        ? account({ settings: { enabled: true, prompts: {}, closing: "" } })
        : undefined,
    });
    await runStoreEventWorker(box.ports);
    assertEquals(box.row.status, "skipped", item.name);
    assertEquals(reasonOf(box.row), "expired", item.name);
    assertEquals(box.row.attempts, 1, item.name);
    assertEquals(box.row.due_at, freshAt, item.name);
    assertEquals(box.sends.length, 0, item.name);
    assertEquals(box.logs[0]?.metadata.reason, "expired", item.name);
  }
});

Deno.test("another live procedure skips as flow_active and releases the QR slot", async () => {
  const at = new Date(NOW).toISOString();
  const box = harness({
    account: qrAccount(),
    thread: {
      id: "thread-1",
      procedure_state: {
        run_id: "other",
        key: "order_status",
        version: 1,
        step: 0,
        fields: {},
        off_script: 0,
        origin: "model",
        started_at: at,
        updated_at: at,
      },
    },
  });
  await runStoreEventWorker(box.ports);
  assertEquals(reasonOf(box.row), "flow_active");
  assertEquals(box.qrReleases, 1);
  assertEquals(box.sends.length, 0);
  assertEquals(activated(box), false);
});

Deno.test("a stale claim token updates nothing and does not send", async () => {
  const row = event();
  let mutated = false;
  const box = harness({
    row,
    update: () => Promise.resolve(false),
  });
  box.ports.releaseClaim = () => {
    mutated = true;
    return Promise.resolve(false);
  };
  await runStoreEventWorker(box.ports);
  assertEquals(row.status, "claimed");
  assertEquals(row.claim_token, "token-1");
  assertEquals(mutated, false);
  assertEquals(box.sends.length, 0);
  assertEquals(box.persists.length, 0);
});

Deno.test("a claim token lost before sending releases the QR slot and does not send", async () => {
  const row = event();
  const box = harness({
    row,
    account: qrAccount(),
    update: async (id, token, patch) => {
      if (patch.status === "sending") return false;
      if (row.id !== id || row.claim_token !== token) return false;
      Object.assign(row, patch);
      return true;
    },
  });
  await runStoreEventWorker(box.ports);
  assertEquals(box.sends.length, 0);
  assertEquals(box.qrReleases, 1);
  assertEquals(activated(box), false);
  assertEquals(row.status, "claimed");
});

Deno.test("the tick releases claimed rows once the 40s budget is spent", async () => {
  let clock = NOW;
  const first = event();
  const second = event({ id: "22222222-2222-4222-8222-222222222222", claim_token: "token-2" });
  const box = harness({ rows: [first, second], now: () => clock });
  const originalSend = box.ports.sendOpener;
  box.ports.sendOpener = (input) => {
    clock = NOW + STORE_EVENT_LIMITS.tickBudgetMs;
    return originalSend(input);
  };
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.sent, 1);
  assertEquals(summary.released, 1);
  assertEquals(second.status, "pending");
  assertEquals(box.sends.length, 1);
});

function loseActivation(box: Harness): void {
  const original = box.ports.persistState;
  box.ports.persistState = (threadId, expected, next) => {
    if ((next as { phase?: string } | null)?.phase === "active") {
      box.persists.push({ expected, next });
      return Promise.resolve(false);
    }
    return original(threadId, expected, next);
  };
}

Deno.test("a lost activation compare-and-set leaves the accepted send unfinished", async () => {
  const box = harness({ account: qrAccount() });
  loseActivation(box);
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.sent, 0);
  assertEquals(summary.failed, 0);
  assertEquals(box.row.status, "sending");
  assertEquals(box.row.outbound_message_id, "wamid.1");
  assertEquals(box.records.length, 0);
  assertEquals(box.deleted, 0);
  assertEquals(box.qrReleases, 0);
  assertEquals(box.alerts.length, 0);
  assertEquals(box.logs.length, 0);
  assertEquals((box.persists.at(-1)?.next as { phase?: string }).phase, "active");
});

Deno.test("a reclaimed send retries activation when the compare-and-set loses", async () => {
  const row = event({ status: "sending", outbound_message_id: "wamid.kept" });
  const box = harness({
    row,
    thread: { id: "thread-1", procedure_state: pending(row.id) },
  });
  loseActivation(box);
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.sent, 0);
  assertEquals(summary.failed, 0);
  assertEquals(box.sends.length, 0);
  assertEquals(box.row.status, "sending");
  assertEquals(box.row.outbound_message_id, "wamid.kept");
  assertEquals(box.records.length, 0);
  assertEquals(box.deleted, 0);
  assertEquals(box.alerts.length, 0);
  assertEquals(box.logs.length, 0);
});

Deno.test("a reclaimed send treats this event's active state as already activated", async () => {
  const row = event({ status: "sending", outbound_message_id: "wamid.kept" });
  const box = harness({
    row,
    thread: { id: "thread-1", procedure_state: { ...pending(row.id), phase: "active" } },
  });
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.sent, 1);
  assertEquals(box.sends.length, 0);
  assertEquals(box.persists.length, 0);
  assertEquals(box.row.status, "sent");
  assertEquals(box.records.length, 1);
  assertEquals(box.alerts.length, 0);
});

Deno.test("a reclaimed send fails activation_conflict when another flow holds the thread", async () => {
  const row = event({ status: "sending", outbound_message_id: "wamid.kept" });
  const at = new Date(NOW).toISOString();
  const box = harness({
    row,
    account: qrAccount(),
    thread: {
      id: "thread-1",
      procedure_state: {
        run_id: "other-run",
        key: "order_status",
        version: 1,
        step: 0,
        fields: {},
        off_script: 0,
        origin: "model",
        phase: "active",
        started_at: at,
        updated_at: at,
      },
    },
  });
  const summary = await runStoreEventWorker(box.ports);
  assertEquals(summary.failed, 1);
  assertEquals(box.sends.length, 0);
  assertEquals(box.records.length, 0);
  assertEquals(box.qrReleases, 0);
  assertEquals(box.row.status, "failed");
  assertEquals(reasonOf(box.row), "activation_conflict");
  assertEquals(box.alerts, ["activation_conflict"]);
  assertEquals(box.logs.length, 1);
  assertEquals(box.logs[0].level, "warn");
  assertEquals(box.logs[0].message, "Store event failed");
  assertEquals(box.logs[0].metadata.reason, "activation_conflict");
  assertEquals("phone" in box.logs[0].metadata, false);
});

Deno.test("a skip writes one outcome log and a thrown log insert does not change the skip", async () => {
  const box = harness({ account: account({ agentEnabled: false }) });
  await runStoreEventWorker(box.ports);
  assertEquals(box.row.status, "skipped");
  assertEquals(box.logs, [{
    source: "process-store-events",
    category: "ai",
    level: "info",
    message: "Store event skipped",
    user_id: "user-1",
    metadata: {
      event_id: box.row.id,
      flow: "cod_confirm",
      social_account_id: "account-1",
      reason: "agent_disabled",
    },
  }]);
  assertEquals("phone" in box.logs[0].metadata, false);

  const thrown = harness({ account: account({ optedOut: true }) });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  };
  thrown.ports.logEvent = () => {
    throw new Error(`log insert failed for ${PHONE}`);
  };
  try {
    await runStoreEventWorker(thrown.ports);
  } finally {
    console.error = original;
  }
  assertEquals(thrown.row.status, "skipped");
  assertEquals(reasonOf(thrown.row), "opted_out");
  assertEquals(errors.length > 0, true);
  assertEquals(errors.some((line) => line.includes(PHONE)), false);
});

Deno.test("a read-only connector skips cod confirmation before any send", async () => {
  const box = harness({ account: account({ connectorReadOnly: true }) });
  await runStoreEventWorker(box.ports);
  assertEquals(box.row.status, "skipped");
  assertEquals(reasonOf(box.row), "connector_read_only");
  assertEquals(box.sends.length, 0);
  assertEquals(box.logs.length, 1);
  assertEquals(box.logs[0].message, "Store event skipped");
  assertEquals(box.logs[0].metadata.reason, "connector_read_only");
  assertEquals(JSON.stringify(box.logs[0]).includes(PHONE), false);
});

async function withClearFailure(box: Harness, mode: "false" | "throw", run: (errors: string[]) => Promise<void>): Promise<void> {
  const errors: string[] = [];
  const originalError = console.error;
  const originalPersist = box.ports.persistState;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  };
  box.ports.persistState = (threadId, expected, next) => {
    if (next === null) {
      if (mode === "throw") return Promise.reject(new Error(`clear failed for ${PHONE}`));
      return Promise.resolve(false);
    }
    return originalPersist(threadId, expected, next);
  };
  try {
    await run(errors);
  } finally {
    console.error = originalError;
  }
}

Deno.test("a template refusal whose state clear fails releases the claim", async () => {
  const box = harness({ template: "pending" });
  const released: string[] = [];
  const original = box.ports.releaseClaim;
  box.ports.releaseClaim = async (id, token) => {
    released.push(token);
    return original(id, token);
  };
  await withClearFailure(box, "false", async (errors) => {
    const summary = await runStoreEventWorker(box.ports);
    assertEquals(summary.released, 1);
    assertEquals(summary.skipped, 0);
    assertEquals(box.row.status, "pending");
    assertEquals(reasonOf(box.row), undefined);
    assertEquals(box.sends.length, 0);
    assertEquals(box.logs.length, 0);
    assertEquals(released, ["token-1"]);
    assertEquals(errors.some((line) => line.includes("releasing the claim")), true);
    assertEquals(errors.some((line) => line.includes(PHONE)), false);
  });
});

Deno.test("a definite send failure whose state clear throws releases the claim", async () => {
  const box = harness({
    send: { accepted: false, definite: true, reason: `recipient ${PHONE} unreachable` },
  });
  const released: string[] = [];
  const original = box.ports.releaseClaim;
  box.ports.releaseClaim = async (id, token) => {
    released.push(`${id}:${token}`);
    return original(id, token);
  };
  await withClearFailure(box, "throw", async (errors) => {
    const summary = await runStoreEventWorker(box.ports);
    assertEquals(summary.failed, 0);
    assertEquals(summary.released, 1);
    assertEquals(box.row.status, "pending");
    assertEquals(reasonOf(box.row), undefined);
    assertEquals(box.sends.length, 1);
    assertEquals(box.alerts.length, 0);
    assertEquals(box.logs.length, 0);
    assertEquals(released, [`${box.row.id}:token-1`]);
    assertEquals(errors.some((line) => line.includes(PHONE)), false);
    assertEquals(errors.some((line) => line.includes("[redacted]") || line.includes("state clear failed")), true);
  });
});

Deno.test("a definite send failure writes one outcome log without the phone", async () => {
  const box = harness({
    send: { accepted: false, definite: true, reason: `recipient ${PHONE} unreachable` },
  });
  await runStoreEventWorker(box.ports);
  assertEquals(box.row.status, "failed");
  assertEquals(box.logs.length, 1);
  assertEquals(box.logs[0].level, "warn");
  assertEquals(box.logs[0].message, "Store event failed");
  assertEquals(box.logs[0].category, "ai");
  assertEquals(box.logs[0].user_id, box.row.user_id);
  assertEquals(Object.keys(box.logs[0].metadata).sort(), ["event_id", "flow", "reason", "social_account_id"]);
  assertEquals("phone" in box.logs[0].metadata, false);
  assertEquals(box.logs[0].metadata.reason.includes(PHONE), false);
  assertEquals(JSON.stringify(box.logs[0]).includes(PHONE), false);
});

Deno.test("back in stock deletes the waitlist row after the opener is accepted", async () => {
  const box = harness({
    row: event({
      flow: "back_in_stock",
      external_id: "waitlist:row-1",
      payload: { phone: PHONE, product_id: "9", product_name: "Rose", first_name: "Sara" },
    }),
    account: account({ settings: { enabled: true, prompts: {}, closing: "" } }),
  });
  await runStoreEventWorker(box.ports);
  assertEquals(box.deleted, 1);
  assertEquals(box.row.status, "sent");
});

// PR #214 round 9: a delayed review must not go to a number the order no longer carries.
Deno.test("a review request is skipped when the order's phone changed since the webhook", () => {
  assertEquals(storeSkipReason("review_request", { phone: PHONE }, snapshot({ status: "completed", phone: "96599990000" }), NOW), "phone_changed");
  assertEquals(storeSkipReason("review_request", { phone: PHONE }, snapshot({ status: "completed", phone: "" }), NOW), "phone_changed");
  assertEquals(storeSkipReason("review_request", { phone: PHONE }, snapshot({ status: "completed" }), NOW), null);
});
