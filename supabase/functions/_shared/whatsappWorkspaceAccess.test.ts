// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  requireWhatsAppWorkspaceAccess,
  roleAtLeast,
  toSafeWhatsAppAccount,
  WhatsAppAccessError,
  type WorkspaceRole,
} from "./whatsappWorkspaceAccess.ts";

type FakeRow = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];

  constructor(
    private readonly table: string,
    private readonly rows: Record<string, FakeRow[]>,
  ) {}

  select(_columns: string): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  maybeSingle(): Promise<{ data: FakeRow | null; error: null }> {
    const matches = (this.rows[this.table] || []).filter((row) =>
      this.filters.every(([column, value]) => row[column] === value)
    );
    return Promise.resolve({ data: matches[0] ?? null, error: null });
  }
}

class FakeClient {
  constructor(private readonly rows: Record<string, FakeRow[]>) {}

  from(table: string): FakeQuery {
    return new FakeQuery(table, this.rows);
  }
}

const roles: WorkspaceRole[] = ["owner", "admin", "agent", "viewer"];

function accountRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "account-1",
    user_id: "owner-user",
    workspace_id: "workspace-1",
    platform: "whatsapp",
    platform_user_id: "phone-number-id",
    platform_username: "Postora WA",
    access_token: "top-secret",
    account_metadata: { waba_id: "waba-1" },
    ...overrides,
  };
}

function clientFor(
  role: WorkspaceRole | null,
  account: FakeRow | null = accountRow(),
): FakeClient {
  return new FakeClient({
    social_accounts: account ? [account] : [],
    workspace_members: role
      ? [{ workspace_id: "workspace-1", user_id: "caller-user", role }]
      : [],
    workspaces: [
      {
        id: "personal-workspace",
        owner_id: "owner-user",
        is_personal: true,
      },
    ],
  });
}

Deno.test("roleAtLeast follows the complete workspace role ordering", () => {
  for (const role of roles) {
    for (const minimum of roles) {
      const expected = roles.indexOf(role) <= roles.indexOf(minimum);
      assertEquals(
        roleAtLeast(role, minimum),
        expected,
        `${role} at least ${minimum}`,
      );
    }
  }
});

for (const role of roles) {
  Deno.test(`${role} receives WhatsApp access at viewer minimum`, async () => {
    const access = await requireWhatsAppWorkspaceAccess(
      clientFor(role),
      "caller-user",
      "account-1",
      "viewer",
    );
    assertEquals(access.role, role);
    assertEquals(access.workspaceId, "workspace-1");
    assertEquals(access.accessToken, "top-secret");
  });
}

for (const minimum of ["agent", "admin"] as const) {
  Deno.test(`viewer is rejected at ${minimum} minimum`, async () => {
    const error = await assertRejects(
      () =>
        requireWhatsAppWorkspaceAccess(
          clientFor("viewer"),
          "caller-user",
          "account-1",
          minimum,
        ),
      WhatsAppAccessError,
    ) as WhatsAppAccessError;
    assertEquals(error.status, 403);
  });
}

Deno.test("non-member and nonexistent account errors are byte-for-byte identical", async () => {
  const nonMemberError = await assertRejects(
    () =>
      requireWhatsAppWorkspaceAccess(
        clientFor(null),
        "caller-user",
        "account-1",
      ),
    WhatsAppAccessError,
  ) as WhatsAppAccessError;
  const missingError = await assertRejects(
    () =>
      requireWhatsAppWorkspaceAccess(
        clientFor(null, null),
        "caller-user",
        "account-1",
      ),
    WhatsAppAccessError,
  ) as WhatsAppAccessError;

  assertEquals(nonMemberError.message, missingError.message);
  assertEquals(nonMemberError.status, missingError.status);
  assertEquals(nonMemberError.status, 404);
});

Deno.test("non-WhatsApp accounts are rejected", async () => {
  const error = await assertRejects(
    () =>
      requireWhatsAppWorkspaceAccess(
        clientFor("owner", accountRow({ platform: "facebook" })),
        "caller-user",
        "account-1",
      ),
    WhatsAppAccessError,
  ) as WhatsAppAccessError;
  assertEquals(error.status, 404);
});

Deno.test("NULL workspace_id falls back to the owner's personal workspace", async () => {
  const client = new FakeClient({
    social_accounts: [accountRow({ workspace_id: null })],
    workspaces: [{
      id: "personal-workspace",
      owner_id: "owner-user",
      is_personal: true,
    }],
    workspace_members: [{
      workspace_id: "personal-workspace",
      user_id: "owner-user",
      role: "owner",
    }],
  });

  const access = await requireWhatsAppWorkspaceAccess(
    client,
    "owner-user",
    "account-1",
  );
  assertEquals(access.workspaceId, "personal-workspace");
  assertEquals(access.role, "owner");
});

Deno.test("safe account projection never includes accessToken", async () => {
  const access = await requireWhatsAppWorkspaceAccess(
    clientFor("owner"),
    "caller-user",
    "account-1",
  );
  const safeAccount = toSafeWhatsAppAccount(access);

  assertEquals(Object.hasOwn(safeAccount, "accessToken"), false);
  assertEquals(safeAccount, {
    accountId: "account-1",
    ownerId: "owner-user",
    workspaceId: "workspace-1",
    role: "owner",
    platformUserId: "phone-number-id",
    platformUsername: "Postora WA",
    accountMetadata: { waba_id: "waba-1" },
  });
});
