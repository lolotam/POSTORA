import { describe, it, expect } from "vitest";
import { buildCredentialsFile } from "../credentialsFile";

describe("buildCredentialsFile", () => {
  it("serialises the one-time credential bundle", () => {
    const json = buildCredentialsFile({
      name: "Danat", environment: "staging", key: "pk_test_abc", keyPrefix: "pk_test_abc",
      scopes: ["messages:send"], workspaceId: "ws", socialAccountId: "acct",
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const parsed = JSON.parse(json);
    expect(parsed.key).toBe("pk_test_abc");
    expect(parsed.base_url).toBe("https://api.postora.cloud/functions/v1/partner-api/v1");
    expect(parsed.scopes).toEqual(["messages:send"]);
  });
});
