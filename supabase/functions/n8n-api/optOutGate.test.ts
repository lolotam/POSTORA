import { assertEquals } from "jsr:@std/assert@1";
import type { OptOutLookupAdmin } from "../_shared/optOutLookup.ts";
import { n8nWhatsAppSendRefusal } from "./optOutGate.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const OWNER = "owner-1";
const ACCOUNT = "account-1";
const PHONE = "+965 5000-1111";
const DIGITS = "96550001111";
const ROUTE = "messages/reply";

interface InboundRow {
  social_account_id: string;
  direction: string;
  from_phone: string | null;
  conversation_id: string;
  timestamp: string;
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function row(overrides: Partial<InboundRow> = {}): InboundRow {
  return {
    social_account_id: ACCOUNT,
    direction: "inbound",
    from_phone: DIGITS,
    conversation_id: "conv-1",
    timestamp: hoursAgo(1),
    ...overrides,
  };
}

function gateAdmin(options: {
  rows?: InboundRow[];
  inboundError?: boolean;
  optedOut?: boolean;
  optOutError?: boolean;
}) {
  const logs: Array<Record<string, unknown>> = [];
  let optOutLookups = 0;
  const admin: OptOutLookupAdmin = {
    from(table: string) {
      if (table === "system_logs") {
        return {
          insert(entry: Record<string, unknown>) {
            logs.push(entry);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "whatsapp_messages") {
        const filters: Record<string, string> = {};
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: string) {
            filters[column] = value;
            return builder;
          },
          gte(column: string, value: string) {
            filters[`gte:${column}`] = value;
            return builder;
          },
          limit(count: number) {
            if (options.inboundError) return Promise.resolve({ data: null, error: { message: "timeout" } });
            const cutoff = filters["gte:timestamp"];
            const matched = (options.rows ?? []).filter((message) => {
              if (message.social_account_id !== filters.social_account_id) return false;
              if (message.direction !== filters.direction) return false;
              if (filters.from_phone !== undefined && message.from_phone !== filters.from_phone) return false;
              if (filters.conversation_id !== undefined && message.conversation_id !== filters.conversation_id) return false;
              if (cutoff && message.timestamp < cutoff) return false;
              return true;
            }).slice(0, count);
            return Promise.resolve({ data: matched, error: null });
          },
        };
        return builder;
      }
      if (table === "messaging_opt_outs") {
        return {
          select() {
            return {
              in() {
                return {
                  eq() {
                    optOutLookups += 1;
                    if (options.optOutError) return Promise.resolve({ data: null, error: { message: "timeout" } });
                    const data = options.optedOut ? [{ phone: DIGITS }] : [];
                    return Promise.resolve({ data, error: null });
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { admin, logs, lookups: () => optOutLookups };
}

const base = { ownerId: OWNER, accountId: ACCOUNT, route: ROUTE, now: NOW };

const cases: Array<{
  name: string;
  recipientId: string;
  rows?: InboundRow[];
  inboundError?: boolean;
  optedOut?: boolean;
  optOutError?: boolean;
  optOutLookups: number;
  status: number | null;
  code?: string;
}> = [
  {
    name: "inbound within 24h and opted out still sends, with no opt-out lookup",
    recipientId: PHONE,
    rows: [row()],
    optedOut: true,
    optOutLookups: 0,
    status: null,
  },
  {
    name: "another customer's recent inbound does not open the window for an opted-out recipient",
    recipientId: PHONE,
    rows: [row({ from_phone: "96500000000" })],
    optedOut: true,
    optOutLookups: 1,
    status: 422,
    code: "RECIPIENT_OPTED_OUT",
  },
  {
    name: "no recent inbound and opted out is a 422",
    recipientId: PHONE,
    rows: [],
    optedOut: true,
    optOutLookups: 1,
    status: 422,
    code: "RECIPIENT_OPTED_OUT",
  },
  {
    name: "no recent inbound and not opted out sends",
    recipientId: PHONE,
    rows: [],
    optedOut: false,
    optOutLookups: 1,
    status: null,
  },
  {
    name: "inbound 25h ago and opted out is refused",
    recipientId: PHONE,
    rows: [row({ timestamp: hoursAgo(25) })],
    optedOut: true,
    optOutLookups: 1,
    status: 422,
    code: "RECIPIENT_OPTED_OUT",
  },
  {
    name: "inbound exactly 24h ago still counts as a reply",
    recipientId: PHONE,
    rows: [row({ timestamp: hoursAgo(24) })],
    optedOut: true,
    optOutLookups: 0,
    status: null,
  },
  {
    name: "opt-out lookup error is 503 and sends nothing",
    recipientId: PHONE,
    rows: [],
    optOutError: true,
    optOutLookups: 1,
    status: 503,
    code: "OPT_OUT_LOOKUP_FAILED",
  },
  {
    name: "inbound lookup error is 503 and does not consult opt-outs",
    recipientId: PHONE,
    inboundError: true,
    optedOut: true,
    optOutLookups: 0,
    status: 503,
    code: "INBOUND_LOOKUP_FAILED",
  },
  {
    name: "a JID-suffixed phone is checked as the phone the sender will deliver to",
    recipientId: `${PHONE}@s.whatsapp.net`,
    rows: [],
    optedOut: true,
    optOutLookups: 1,
    status: 422,
    code: "RECIPIENT_OPTED_OUT",
  },
  {
    name: "a group id outside 24h is allowed",
    recipientId: "120363000000000000@g.us",
    rows: [],
    optedOut: true,
    optOutLookups: 0,
    status: null,
  },
  {
    name: "a non-phone recipient outside 24h is allowed",
    recipientId: "16505551234@lid",
    rows: [],
    optedOut: true,
    optOutLookups: 0,
    status: null,
  },
];

for (const testCase of cases) {
  Deno.test(testCase.name, async () => {
    const gate = gateAdmin(testCase);
    const refusal = await n8nWhatsAppSendRefusal(gate.admin, {
      ...base,
      recipientId: testCase.recipientId,
    });
    assertEquals(gate.lookups(), testCase.optOutLookups);
    if (testCase.status === null) {
      assertEquals(refusal, null);
      assertEquals(gate.logs, []);
      return;
    }
    assertEquals(refusal?.status, testCase.status);
    assertEquals(refusal?.code, testCase.code);
    assertEquals(gate.logs.length, 1);
    assertEquals(gate.logs[0]?.source, "n8n-api");
    assertEquals(gate.logs[0]?.user_id, OWNER);
    const metadata = gate.logs[0]?.metadata as Record<string, unknown>;
    assertEquals(metadata.route, ROUTE);
    assertEquals(metadata.social_account_id, ACCOUNT);
    const serialized = JSON.stringify(gate.logs);
    assertEquals(serialized.includes(DIGITS), false);
    assertEquals(serialized.includes(testCase.recipientId), false);
  });
}
