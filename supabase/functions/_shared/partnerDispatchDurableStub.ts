// TEST SUPPORT — not production code, not a test file.
//
// A supabase-js client stub whose mutations are DURABLE ACROSS PROCESS
// DEATH: after every operation it writes its state synchronously to a file.
// A write that completed is committed; anything else never happened. This is
// what lets the D13 crash gate run the REAL dispatch path in a worker,
// terminate the worker mid-flight (no catch block runs, no cleanup write
// happens), and then replay the retry against exactly the durable state a
// killed process would have left behind.
//
// The stub implements the real table semantics the dispatch path relies on:
//   partner_dispatch_intents   UNIQUE (key_id, idempotency_key),
//                              UPDATE ... WHERE filters evaluated against
//                              CURRENT values (compare-and-set works)
//   partner_api_idempotency    UPDATE ... WHERE (state/attempt_token fencing)
//   reserve/release_partner_quota
//
// Everything else (usage ledger, whatsapp_messages, contacts, cache) is a
// standing success, matching the existing stub style in
// whatsappPartnerOps.test.ts.
//
// Pass a path for cross-process durability (the crash tests), or null for an
// in-memory harness (the in-process dispatch tests).

import type { PartnerKeyRecord } from "./partnerApiKeys.ts";
import type { WhatsAppOpsContext } from "./whatsappPartnerOps.ts";

export interface DurableDispatchState {
  /** How many times the provider (the fetcher's call-through) was actually
   *  invoked. Incremented — and PERSISTED — before the provider interaction
   *  begins, so the count survives a crash mid-call. */
  providerCalls: number;
  /** Request bodies handed to the provider, in order. */
  requestBodies: string[];
  quotaReserved: number;
  intents: Array<Record<string, unknown>>;
  idempotency: Array<Record<string, unknown>>;
  /** Ordered operation log, for ordering assertions. */
  log: string[];
  /** Every quota RPC invoked, in order — for the Phase 10.1 bucket-move assertions. */
  rpcCalls: string[];
}

export function initialDurableState(): DurableDispatchState {
  return { providerCalls: 0, requestBodies: [], quotaReserved: 0, intents: [], idempotency: [], log: [], rpcCalls: [] };
}

const encoder = new TextEncoder();

function loadState(path: string | null, memory: DurableDispatchState): DurableDispatchState {
  if (path === null) return memory;
  try {
    return JSON.parse(new TextDecoder().decode(Deno.readFileSync(path))) as DurableDispatchState;
  } catch {
    return initialDurableState();
  }
}

type Filter = { kind: "eq"; col: string; val: unknown } | { kind: "in"; col: string; vals: unknown[] };

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) =>
    f.kind === "eq" ? row[f.col] === f.val : f.vals.includes(row[f.col])
  );
}

/** A supabase-js-shaped query builder. Thenable (awaiting the chain executes
 *  and yields { data, error }), with .select().maybeSingle() support. */
class StubChain {
  private filters: Filter[] = [];
  private result: { data: unknown; error: unknown } | null = null;
  constructor(private execute: (filters: Filter[]) => { data: unknown; error: unknown }) {}
  eq(col: string, val: unknown) {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push({ kind: "in", col, vals });
    return this;
  }
  select(_cols?: string) {
    return this;
  }
  maybeSingle() {
    return Promise.resolve(this.run());
  }
  then(
    onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
  private run() {
    if (!this.result) this.result = this.execute(this.filters);
    return this.result;
  }
}

export interface DispatchHarness {
  // deno-lint-ignore no-explicit-any
  admin: any;
  record: PartnerKeyRecord;
  ctx: WhatsAppOpsContext;
  /** A fetcher that counts (durably) and calls through to the canned Meta
   *  2xx provider. */
  countingFetcher: () => (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** A fetcher that ABORTS at the given point: it signals via onAbort and
   *  then parks on a timer until the parent terminates the worker. This is
   *  the injection seam — production code never learns about it. */
  abortingFetcher: (
    point: "before" | "after",
    onAbort: () => void,
  ) => (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  read: () => DurableDispatchState;
  /** Models claim_partner_idempotency's expired-lease takeover: state stays
   *  `processing`, a fresh attempt token is minted into the row. */
  simulateTakeoverClaim: (attemptToken: string) => void;
  /** Seeds the idempotency row a fresh claim would have written. */
  seedClaim: (attemptToken: string, keyId: string, idempotencyKey: string) => void;
}

export function createDispatchHarness(statePath: string | null): DispatchHarness {
  const memory = initialDurableState();

  const persist = (state: DurableDispatchState) => {
    if (statePath !== null) Deno.writeFileSync(statePath, encoder.encode(JSON.stringify(state)));
    Object.assign(memory, state);
  };
  const mutate = (
    fn: (state: DurableDispatchState) => void,
  ): DurableDispatchState => {
    // structuredClone: every mutation works on its own snapshot, so a
    // reference a caller captured earlier is frozen at that point in time —
    // exactly what a database row read in an earlier statement behaves like.
    const state = structuredClone(loadState(statePath, memory));
    fn(state);
    persist(state);
    return state;
  };

  const record: PartnerKeyRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "ws-crash",
    socialAccountId: "acct-crash",
    keyPrefix: "pk_live_crash",
    scopes: ["whatsapp:template.send"],
    rateLimitPerMin: 60,
    monthlyQuota: null,
    expiresAt: null,
    revokedAt: null,
  };

  const ctx: WhatsAppOpsContext = {
    admin: null,
    accountId: "acct-crash",
    ownerId: "owner-crash",
    workspaceId: "ws-crash",
    phoneNumberId: "999888777",
    accessToken: "tok",
  };

  const intents = () => {
    const s = loadState(statePath, memory);
    return { s, rows: s.intents };
  };

  const metaSuccessResponse = () =>
    new Response(JSON.stringify({ messages: [{ id: "wamid.CRASH_GATE" }] }), { status: 200 });

  // deno-lint-ignore no-explicit-any
  const admin: any = {
    rpc(name: string, params: unknown) {
      if (name === "reserve_partner_quota") {
        mutate((s) => {
          s.quotaReserved += 1;
          s.rpcCalls.push(name);
          s.log.push("quota-reserved");
        });
        return Promise.resolve({ data: { allowed: true }, error: null });
      }
      if (name === "release_partner_quota") {
        mutate((s) => {
          s.quotaReserved = Math.max(0, s.quotaReserved - 1);
          s.rpcCalls.push(name);
          s.log.push("quota-released");
        });
        return Promise.resolve({ error: null });
      }
      if (name === "confirm_partner_quota") {
        mutate((s) => {
          s.rpcCalls.push(name);
          s.log.push("quota-confirmed");
        });
        return Promise.resolve({ error: null });
      }
      if (name === "indeterminate_partner_quota") {
        mutate((s) => {
          s.rpcCalls.push(name);
          s.log.push("quota-indeterminate");
        });
        return Promise.resolve({ error: null });
      }
      // Phase 6: the settle and the reconcile became single-statement RPCs
      // (state change + webhook fan-out in one call). The stub mirrors the
      // SQL CAS semantics so the dispatch and crash tests keep asserting
      // real transitions. `enqueued: 0` is honest -- no webhook tables exist
      // in this harness; the enqueue half is proven by the SQL suite
      // (supabase/tests/partner_webhook_phase6_events.sql).
      if (name === "partner_settle_dispatch_intent_sent") {
        const p = params as { p_intent_id: string; p_wamid: string; p_http_status: number; p_response_body: unknown };
        let settled = false;
        mutate((s) => {
          const row = s.intents.find((r) => r.id === p.p_intent_id);
          // Compare-and-set, like the SQL WHERE state = 'intended'.
          if (row && row.state === "intended") {
            Object.assign(row, {
              state: "sent",
              wamid: p.p_wamid,
              http_status: p.p_http_status,
              response_body: p.p_response_body,
              resolved_at: new Date().toISOString(),
            });
            settled = true;
            s.log.push("intent-updated:sent");
          }
        });
        return Promise.resolve({ data: { settled, enqueued: 0 }, error: null });
      }
      if (name === "partner_reconcile_dispatch_intent_sent") {
        const p = params as { p_intent_id: string; p_wamid: string };
        let reconciled = false;
        mutate((s) => {
          const row = s.intents.find((r) => r.id === p.p_intent_id);
          if (row && ["intended", "indeterminate", "sent"].includes(row.state as string)) {
            Object.assign(row, {
              state: "reconciled_sent",
              wamid: p.p_wamid,
              resolved_at: new Date().toISOString(),
            });
            reconciled = true;
            s.log.push("intent-updated:reconciled_sent");
          }
        });
        return Promise.resolve({ data: { reconciled, enqueued: 0 }, error: null });
      }
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      if (table === "partner_dispatch_intents") {
        return {
          insert(row: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
            let conflict = false;
            mutate((s) => {
              const conflictKey = opts?.onConflict === "key_id,idempotency_key";
              if (conflictKey && opts?.ignoreDuplicates) {
                conflict = s.intents.some(
                  (r) => r.key_id === row.key_id && r.idempotency_key === row.idempotency_key,
                );
              }
              if (!conflict) {
                s.intents.push({ ...row });
                s.log.push("intent-inserted");
              }
            });
            const inserted = () => {
              const { s } = intents();
              return conflict
                ? null
                : s.intents.find(
                  (r) => r.key_id === row.key_id && r.idempotency_key === row.idempotency_key,
                ) ?? null;
            };
            return new StubChain(() => ({ data: inserted(), error: null }));
          },
          update(patch: Record<string, unknown>) {
            return new StubChain((filters) => {
              let first: Record<string, unknown> | null = null;
              mutate((s) => {
                // WHERE evaluates against CURRENT values, so an .eq("state",
                // "intended") filter is a compare-and-set.
                const hit = s.intents.filter((r) => matches(r, filters));
                for (const r of hit) Object.assign(r, patch);
                first = hit[0] ?? null;
                if (hit.length) s.log.push(`intent-updated:${patch.state ?? "?"}`);
              });
              return { data: first, error: null };
            });
          },
          select(_cols?: string) {
            return new StubChain((filters) => {
              const { s } = intents();
              return { data: s.intents.find((r) => matches(r, filters)) ?? null, error: null };
            });
          },
        };
      }
      if (table === "partner_api_idempotency") {
        return {
          update(patch: Record<string, unknown>) {
            return new StubChain((filters) => {
              mutate((s) => {
                const hit = s.idempotency.filter((r) => matches(r, filters));
                for (const r of hit) Object.assign(r, patch);
                if (hit.length) s.log.push(`idempotency:${String(patch.state ?? "?")}`);
              });
              return { data: null, error: null };
            });
          },
          select(_cols?: string) {
            return new StubChain((filters) => {
              const s = loadState(statePath, memory);
              return { data: s.idempotency.find((r) => matches(r, filters)) ?? null, error: null };
            });
          },
        };
      }
      // whatsappPartnerOps' persistence tables: standing success.
      return {
        insert: () => new StubChain(() => ({ data: null, error: null })),
        upsert: () => new StubChain(() => ({ data: null, error: null })),
        update: () => new StubChain(() => ({ data: null, error: null })),
        select: () => new StubChain(() => ({ data: null, error: null })),
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  ctx.admin = admin;

  const countingFetcher =
    () =>
    (_input: string | URL | Request, init?: RequestInit) => {
      // Counted AND persisted before the provider interaction begins, so the
      // number survives an abort at either injection point.
      mutate((s) => {
        s.providerCalls += 1;
        s.requestBodies.push(String(init?.body ?? ""));
      });
      return Promise.resolve(metaSuccessResponse());
    };

  const abortingFetcher = (point: "before" | "after", onAbort: () => void) =>
    (_input: string | URL | Request, init?: RequestInit) => {
      if (point === "before") {
        // Die immediately BEFORE the provider invocation: no count, no call.
        onAbort();
        return new Promise<Response>((resolve) => {
          // A real timer holds the worker's event loop open, so the only
          // thing that ends this attempt is the parent's terminate() — a
          // deterministic kill, not an idle exit.
          setTimeout(() => resolve(metaSuccessResponse()), 60_000);
        });
      }
      // Die immediately AFTER the provider invocation returns: the call
      // happened (counted durably), and control never returns to the caller.
      mutate((s) => {
        s.providerCalls += 1;
        s.requestBodies.push(String(init?.body ?? ""));
      });
      onAbort();
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(metaSuccessResponse()), 60_000);
      });
    };

  return {
    admin,
    record,
    ctx,
    countingFetcher,
    abortingFetcher,
    read: () => loadState(statePath, memory),
    simulateTakeoverClaim: (attemptToken: string) => {
      mutate((s) => {
        for (const r of s.idempotency) r.attempt_token = attemptToken;
      });
    },
    seedClaim: (attemptToken: string, keyId: string, idempotencyKey: string) => {
      mutate((s) => {
        s.idempotency = [{
          key_id: keyId,
          idempotency_key: idempotencyKey,
          state: "processing",
          attempt_token: attemptToken,
        }];
      });
    },
  };
}
