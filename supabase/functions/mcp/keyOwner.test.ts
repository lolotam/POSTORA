import { assertEquals } from "jsr:@std/assert@1";
import { resolveKeyOwner } from "./keyOwner.ts";

interface FakeCall {
  method: string;
  args: unknown[];
}

interface FakeQueryBuilder {
  select(columns: string): FakeQueryBuilder;
  eq(column: string, value: unknown): FakeQueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
}

interface FakeAdminOptions {
  profile?: { id: string } | null;
  lookupError?: { message: string } | null;
  throwOn?: "maybeSingle" | null;
}

// A fake admin that records every call the resolver makes. Nothing here talks
// to a database or to the network.
function createFakeAdmin(options: FakeAdminOptions = {}) {
  const calls: FakeCall[] = [];

  const admin = {
    from(table: string): FakeQueryBuilder {
      calls.push({ method: "from", args: [table] });
      const builder: FakeQueryBuilder = {
        select(columns: string) {
          calls.push({ method: "select", args: [columns] });
          return builder;
        },
        eq(column: string, value: unknown) {
          calls.push({ method: "eq", args: [column, value] });
          return builder;
        },
        async maybeSingle() {
          calls.push({ method: "maybeSingle", args: [] });
          if (options.throwOn === "maybeSingle") throw new Error("database is down");
          if (options.lookupError) return { data: null, error: options.lookupError };
          return { data: options.profile ?? null, error: null };
        },
      };
      return builder;
    },
  };

  return { admin, calls };
}

// The key is hashed exactly like the API hashes it before looking the owner
// up: sha256Hex(apiKey) against profiles.api_key_hash.
const sha256Hex = async (_text: string): Promise<string> => "hashed-placeholder";

const KEY_PLACEHOLDER = "placeholder-key";

Deno.test("the owner of a known key is resolved", async () => {
  const { admin, calls } = createFakeAdmin({ profile: { id: "user-42" } });

  const owner = await resolveKeyOwner({ admin, sha256Hex }, KEY_PLACEHOLDER);

  assertEquals(owner, { kind: "owner", userId: "user-42" } as const);

  // The owner is looked up the way the API looks it up: the hashed key
  // against profiles.api_key_hash.
  assertEquals(calls.map((call) => call.method), ["from", "select", "eq", "maybeSingle"]);
  assertEquals(calls[0].args, ["profiles"]);
  assertEquals(calls[1].args, ["id"]);
  assertEquals(calls[2].args, ["api_key_hash", "hashed-placeholder"]);

  // The key itself never reaches the query.
  const serialized = JSON.stringify(calls);
  assertEquals(serialized.includes(KEY_PLACEHOLDER), false);
});

Deno.test("a key that belongs to no profile is unknown", async () => {
  const { admin, calls } = createFakeAdmin({ profile: null });

  const owner = await resolveKeyOwner({ admin, sha256Hex }, KEY_PLACEHOLDER);

  assertEquals(owner, { kind: "unknown" } as const);
  assertEquals(calls.map((call) => call.method), ["from", "select", "eq", "maybeSingle"]);
});

Deno.test("a failed lookup is an error, not an unknown key", async () => {
  const { admin } = createFakeAdmin({ lookupError: { message: "database is down" } });

  const owner = await resolveKeyOwner({ admin, sha256Hex }, KEY_PLACEHOLDER);

  // The edge cannot tell whether the caller is allowed in, so it must not
  // answer "invalid key" either.
  assertEquals(owner, { kind: "error" } as const);
});

Deno.test("a throwing database client is an error", async () => {
  const { admin } = createFakeAdmin({ throwOn: "maybeSingle" });

  const owner = await resolveKeyOwner({ admin, sha256Hex }, KEY_PLACEHOLDER);

  assertEquals(owner, { kind: "error" } as const);
});

Deno.test("a throwing hash is an error and never throws", async () => {
  const { admin, calls } = createFakeAdmin({ profile: { id: "user-42" } });
  const throwingHash = async (_text: string): Promise<string> => {
    throw new Error("hashing is unavailable");
  };

  let thrown: unknown = null;
  let owner: unknown = null;
  try {
    owner = await resolveKeyOwner({ admin, sha256Hex: throwingHash }, KEY_PLACEHOLDER);
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
  assertEquals(owner, { kind: "error" } as const);
  assertEquals(calls, []);
});
