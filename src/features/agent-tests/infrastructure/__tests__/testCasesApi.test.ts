import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateTestCase } from "../testCasesApi";

const supabaseMock = vi.hoisted(() => {
  const calls: Array<{ op: string; filters: string[] }> = [];

  function chain(filters: string[]) {
    const query = {
      eq(column: string, value: string) {
        filters.push(`${column}=${value}`);
        return query;
      },
      then(
        onFulfilled?: (value: { error: null }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve({ error: null }).then(onFulfilled, onRejected);
      },
    };
    return query;
  }

  return {
    calls,
    from: vi.fn((table: string) => ({
      update: () => {
        const filters: string[] = [];
        calls.push({ op: `update:${table}`, filters });
        return chain(filters);
      },
    })),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: supabaseMock.from },
}));

describe("updateTestCase", () => {
  beforeEach(() => {
    supabaseMock.calls.length = 0;
  });

  it("filters the update by id, social account, and platform", async () => {
    await updateTestCase("case-1", {
      message: "updated",
      expected: { contains: ["price"] },
      socialAccountId: "acct-b",
      platform: "instagram",
    });

    expect(supabaseMock.calls).toEqual([
      {
        op: "update:ai_agent_test_cases",
        filters: ["id=case-1", "social_account_id=acct-b", "platform=instagram"],
      },
    ]);
  });
});
