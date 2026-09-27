import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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
  type ThreadRow,
  type WorkerPorts,
} from "./worker.ts";

const PHONE = "96555512345";
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

function event(overrides: Partial<StoreEventRow> = {}): StoreEventRow {
  return {
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
    outbound_message_id: null,
    ...overrides,
  };
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
  qrReleases: number;
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
    qrReleases: 0,
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
      const target = rows.find((item) => item.id === id && item.claim_token === token && item.status === "claimed");
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
    reserveQr: () => Promise.resolve(options.reserve !== false),
    releaseQr: () => {
      state.qrReleases += 1;
      return Promise.resolve();
    },
    ensureThread: () => Promise.resolve(state.thread),
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
  assertEquals(storeSkipReason("review_request", {}, snapshot({ status: "completed" }), NOW), null);
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

Deno.test("a template that is not approved skips and clears the opener state", async () => {
  const box = harness({ template: "pending" });
  await runStoreEventWorker(box.ports);
  assertEquals(reasonOf(box.row), "template_not_approved");
  assertEquals(box.sends.length, 0);
  assertEquals(box.persists.some((call) => call.next === null), true);
  assertEquals(activated(box), false);
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
