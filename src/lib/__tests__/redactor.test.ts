import { describe, expect, it } from "vitest";
import { redactSensitive } from "../../../supabase/functions/_shared/logging";

describe("redactSensitive", () => {
  it("redacts known sensitive keys", () => {
    const input = {
      access_token: "abc123",
      refresh_token: "xyz789",
      password: "secret",
      otp: "123456",
      api_key: "key-abc",
      bearer: "Bearer xyz",
      normal_field: "visible",
    };

    const result = redactSensitive(input) as Record<string, unknown>;

    expect(result.access_token).toBe("[REDACTED]");
    expect(result.refresh_token).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.otp).toBe("[REDACTED]");
    expect(result.api_key).toBe("[REDACTED]");
    expect(result.bearer).toBe("[REDACTED]");
    expect(result.normal_field).toBe("visible");
  });

  it("redacts nested sensitive keys", () => {
    const input = {
      user: {
        email: "test@example.com",
        authorization: "Bearer xyz",
      },
      metadata: {
        code_hash: "abc123def456",
        source: "process-post",
      },
    };

    const result = redactSensitive(input) as Record<string, any>;

    expect(result.user.email).toBe("test@example.com");
    expect(result.user.authorization).toBe("[REDACTED]");
    expect(result.metadata.code_hash).toBe("[REDACTED]");
    expect(result.metadata.source).toBe("process-post");
  });

  it("redacts Bearer tokens in string values", () => {
    const input = { header: "Bearer eyJhbGciOiJIUzI1NiJ9.test" };
    const result = redactSensitive(input) as Record<string, unknown>;
    expect(result.header).toBe("[REDACTED]");
  });

  it("redacts long hex strings that look like tokens", () => {
    const hexToken = "a".repeat(64);
    const input = { data: hexToken };
    const result = redactSensitive(input) as Record<string, unknown>;
    expect(result.data).toBe("[REDACTED]");
  });

  it("preserves short non-sensitive strings", () => {
    const input = { message: "Post published successfully", count: 42 };
    const result = redactSensitive(input) as Record<string, unknown>;
    expect(result.message).toBe("Post published successfully");
    expect(result.count).toBe(42);
  });

  it("handles arrays recursively", () => {
    const input = {
      items: [{ token: "secret" }, { name: "ok" }],
    };

    const result = redactSensitive(input) as Record<string, any>;

    expect(result.items[0].token).toBe("[REDACTED]");
    expect(result.items[1].name).toBe("ok");
  });

  it("redacts pepper and webhook_secret keys", () => {
    const input = {
      pepper: "my-secret-pepper",
      webhook_secret: "whsec_abc",
      CRON_SECRET: "cron-xyz",
    };

    const result = redactSensitive(input) as Record<string, unknown>;

    expect(result.pepper).toBe("[REDACTED]");
    expect(result.webhook_secret).toBe("[REDACTED]");
    expect(result.CRON_SECRET).toBe("[REDACTED]");
  });
});
