import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { logSendRefused, optedOutPhones, type OptOutLookupAdmin } from "./optOutLookup.ts";

function phones(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(index + 1).padStart(4, "0"));
}

function lookupAdmin(optedOut: Set<string>, failAt: number | null = null): { admin: OptOutLookupAdmin; queries: Array<{ phones: string[]; userId: string }> } {
  const queries: Array<{ phones: string[]; userId: string }> = [];
  const admin: OptOutLookupAdmin = {
    from(table) {
      if (table !== "messaging_opt_outs") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            in(_column, values) {
              return {
                eq(_column, userId) {
                  queries.push({ phones: [...values], userId });
                  if (failAt !== null && queries.length === failAt) {
                    return Promise.resolve({ data: null, error: { message: "statement timeout" } });
                  }
                  const data = values.filter((phone) => optedOut.has(phone)).map((phone) => ({ phone }));
                  return Promise.resolve({ data, error: null });
                },
              };
            },
          };
        },
        insert() {
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { admin, queries };
}

Deno.test("optedOutPhones chunks 250 phones into 3 bounded queries and returns the complete set", async () => {
  const input = phones(250);
  const hits = new Set(input.filter((phone) => phone.endsWith("0")));
  const { admin, queries } = lookupAdmin(hits);
  const found = await optedOutPhones(admin, "user-1", input);
  assertEquals(queries.length, 3);
  assertEquals(queries.map((query) => query.phones.length), [100, 100, 50]);
  assertEquals(queries.every((query) => query.userId === "user-1" && query.phones.length <= 100), true);
  assertEquals(queries.flatMap((query) => query.phones), input);
  assertEquals(found, hits);
});

Deno.test("optedOutPhones throws when a chunk fails and does not return a partial set", async () => {
  const { admin } = lookupAdmin(new Set(), 2);
  await assertRejects(() => optedOutPhones(admin, "user-1", phones(150)), Error, "opt_out_lookup_failed");
});

Deno.test("logSendRefused writes one system row and drops a phone from metadata", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const admin: OptOutLookupAdmin = {
    from(table) {
      if (table !== "system_logs") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          throw new Error("select was not expected");
        },
        insert(row) {
          rows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  await logSendRefused(admin, {
    source: "whatsapp-broadcast",
    userId: "user-1",
    reason: "opted_out",
    metadata: { broadcast_id: "b1", skipped_count: 2, phone: "96550001111" },
  });
  await logSendRefused(admin, {
    source: "ecommerce-whatsapp-api",
    userId: "user-1",
    reason: "opt_out_lookup_failed",
    metadata: { action: "send_text" },
  });
  assertEquals(rows[0]?.level, "info");
  assertEquals(rows[1]?.level, "error");
  assertEquals(rows.every((row) => row.category === "system"), true);
  assertEquals(JSON.stringify(rows).includes("96550001111"), false);
  assertEquals((rows[0]?.metadata as { reason: string }).reason, "opted_out");
});

Deno.test("a failed refusal log is console.error'd and does not throw", async () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const admin: OptOutLookupAdmin = {
      from() {
        return {
          select() {
            throw new Error("select was not expected");
          },
          insert() {
            return Promise.resolve({ error: { message: "insert failed" } });
          },
        };
      },
    };
    await logSendRefused(admin, { source: "whatsapp-broadcast", userId: "user-1", reason: "opted_out", metadata: {} });
    assertEquals(errors.length, 1);
  } finally {
    console.error = original;
  }
});
