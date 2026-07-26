// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { WhatsAppAccessError } from "../_shared/whatsappWorkspaceAccess.ts";
import {
  type WhatsAppAction,
  withWhatsAppActionAccess,
} from "./whatsappAccess.ts";

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
  readonly tablesRead: string[] = [];

  constructor(private readonly rows: Record<string, FakeRow[]>) {}

  from(table: string): FakeQuery {
    this.tablesRead.push(table);
    return new FakeQuery(table, this.rows);
  }
}

const formerlyLeakingActions: WhatsAppAction[] = [
  "whatsapp_get_analytics",
  "whatsapp_list_conversations",
  "whatsapp_get_messages",
  "whatsapp_mark_read",
];

for (const action of formerlyLeakingActions) {
  Deno.test(`${action} refuses an outsider before reading or returning tenant data`, async () => {
    const client = new FakeClient({
      social_accounts: [{
        id: "victim-account",
        user_id: "victim-user",
        workspace_id: "victim-workspace",
        platform: "whatsapp",
        platform_user_id: "victim-phone-id",
        platform_username: "Victim",
        access_token: "victim-secret",
        account_metadata: {},
      }],
      workspace_members: [],
    });
    let protectedOperationRan = false;

    const error = await assertRejects(
      () =>
        withWhatsAppActionAccess(
          {
            client,
            userId: "attacker-user",
            action,
            socialAccountId: "victim-account",
          },
          () => {
            protectedOperationRan = true;
            return Promise.resolve({ leaked: true });
          },
        ),
      WhatsAppAccessError,
    );

    assertEquals(error.status, 404);
    assertEquals(protectedOperationRan, false);
    assertEquals(client.tablesRead, [
      "social_accounts",
      "workspace_members",
    ]);
  });
}
