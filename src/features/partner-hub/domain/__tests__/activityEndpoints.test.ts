import { describe, it, expect } from "vitest";
import { endpointForAction } from "../activityEndpoints";

describe("endpointForAction", () => {
  it("maps ledger actions to the documented /v1 routes", () => {
    expect(endpointForAction("send_template")).toBe("POST /v1/messages");
    expect(endpointForAction("create_post")).toBe("POST /v1/posts");
    expect(endpointForAction("list_accounts")).toBe("GET /v1/accounts");
    expect(endpointForAction("get_usage")).toBe("GET /v1/usage");
    expect(endpointForAction("test_webhook")).toBe("POST /v1/webhooks/{id}/test");
  });
  it("falls back to the raw action for an unknown one", () => {
    expect(endpointForAction("something_new")).toBe("something_new");
  });
});
