import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LIFECYCLE_PREREQUISITE_CODE,
  LIFECYCLE_PREREQUISITE_STATUS,
  isLifecycleRefusal,
} from "../_shared/facebookCredentialMode.ts";
import {
  isProtectedMetaRefreshPlatform,
  refreshTripwirePorts,
  settleMetaRefreshAttempt,
  type MetaRefreshPorts,
} from "./protectedMetaRefresh.ts";

function countingPorts(): { ports: MetaRefreshPorts; calls: Record<string, number> } {
  const calls = { exchange: 0, markAttempt: 0, writeHealth: 0, sendAlert: 0, recordEvent: 0 };
  const bump = (name: keyof typeof calls) => () => {
    calls[name] += 1;
    throw new Error(`${name} invoked`);
  };
  return {
    calls,
    ports: {
      exchange: bump("exchange"),
      markAttempt: bump("markAttempt"),
      writeHealth: bump("writeHealth"),
      sendAlert: bump("sendAlert"),
      recordEvent: bump("recordEvent"),
    },
  };
}

Deno.test("protected scheduled and manual meta refresh refuse before http and writes", async () => {
  for (const platform of ["facebook", "instagram"] as const) {
    for (const trigger of ["scheduled", "manual"] as const) {
      const { ports, calls } = countingPorts();
      let legacyCalls = 0;
      let failureCalls = 0;
      const settled = await settleMetaRefreshAttempt({
        mode: "protected",
        platform,
        trigger,
        ports,
        legacy: async () => {
          legacyCalls += 1;
          throw new Error("legacy refresh invoked");
        },
        onLegacyFailure: async () => {
          failureCalls += 1;
          throw new Error("legacy refresh failure handler invoked");
        },
      });

      assertEquals(isLifecycleRefusal(settled), true);
      if (!isLifecycleRefusal(settled)) continue;
      assertEquals(settled.errorCode, LIFECYCLE_PREREQUISITE_CODE);
      assertEquals(settled.status, LIFECYCLE_PREREQUISITE_STATUS);
      assertEquals(settled.action, trigger);
      assertEquals(calls, { exchange: 0, markAttempt: 0, writeHealth: 0, sendAlert: 0, recordEvent: 0 });
      assertEquals(legacyCalls, 0);
      assertEquals(failureCalls, 0);
    }
  }
});

Deno.test("protected meta refresh does not call the production tripwires", async () => {
  const settled = await settleMetaRefreshAttempt({
    mode: "protected",
    platform: "instagram",
    trigger: "scheduled",
    ports: refreshTripwirePorts(),
    legacy: async () => {
      throw new Error("legacy refresh invoked");
    },
    onLegacyFailure: async () => {
      throw new Error("legacy refresh failure handler invoked");
    },
  });
  assertEquals(isLifecycleRefusal(settled), true);
});

Deno.test("legacy meta refresh runs the legacy exchange and not the refusal ports", async () => {
  const { ports, calls } = countingPorts();
  const settled = await settleMetaRefreshAttempt({
    mode: "legacy",
    platform: "facebook",
    trigger: "scheduled",
    ports,
    legacy: async () => "refreshed",
    onLegacyFailure: async () => {
      throw new Error("legacy refresh failure handler invoked");
    },
  });
  assertEquals(settled, "refreshed");
  assertEquals(calls.exchange, 0);
  assertEquals(calls.markAttempt, 0);
  assertEquals(calls.writeHealth, 0);
  assertEquals(calls.sendAlert, 0);
  assertEquals(calls.recordEvent, 0);
});

Deno.test("a protected deployment still refreshes unrelated platforms", async () => {
  assertEquals(isProtectedMetaRefreshPlatform("tiktok"), false);
  assertEquals(isProtectedMetaRefreshPlatform("youtube"), false);
  const { ports, calls } = countingPorts();
  const settled = await settleMetaRefreshAttempt({
    mode: "protected",
    platform: "tiktok",
    trigger: "manual",
    ports,
    legacy: async () => "tiktok-refreshed",
    onLegacyFailure: async () => {
      throw new Error("legacy refresh failure handler invoked");
    },
  });
  assertEquals(settled, "tiktok-refreshed");
  assertEquals(calls.exchange, 0);
  assertEquals(calls.recordEvent, 0);
});

Deno.test("a legacy refresh failure reaches the failure handler and is not a protected refusal", async () => {
  const { ports, calls } = countingPorts();
  const settled = await settleMetaRefreshAttempt({
    mode: "legacy",
    platform: "instagram",
    trigger: "manual",
    ports,
    legacy: async () => {
      throw new Error("provider timeout");
    },
    onLegacyFailure: async (error) => {
      assertEquals(error instanceof Error && error.message, "provider timeout");
      return "failed-closed";
    },
  });
  assertEquals(settled, "failed-closed");
  assertEquals(isLifecycleRefusal(settled), false);
  assertEquals(calls.exchange, 0);
  assertEquals(calls.recordEvent, 0);
});

Deno.test("a protected refusal is not followed by the failure handler when legacy throws", async () => {
  const settled = await settleMetaRefreshAttempt({
    mode: "protected",
    platform: "facebook",
    trigger: "manual",
    ports: refreshTripwirePorts(),
    legacy: async () => {
      throw new Error("legacy refresh invoked");
    },
    onLegacyFailure: async () => "fell-through",
  });
  assertEquals(isLifecycleRefusal(settled), true);
  if (!isLifecycleRefusal(settled)) return;
  assertEquals(settled.errorCode, LIFECYCLE_PREREQUISITE_CODE);
});

Deno.test("production refresh tripwires reject if a protected refresh calls them", async () => {
  const ports = refreshTripwirePorts();
  await assertRejects(() => ports.exchange(), Error, "protected refresh exchange invoked");
  await assertRejects(() => ports.markAttempt(), Error, "protected refresh markAttempt invoked");
  await assertRejects(() => ports.writeHealth(), Error, "protected refresh writeHealth invoked");
  await assertRejects(() => ports.sendAlert(), Error, "protected refresh sendAlert invoked");
  await assertRejects(() => ports.recordEvent(), Error, "protected refresh recordEvent invoked");
});
