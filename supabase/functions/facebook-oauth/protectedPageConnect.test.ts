import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FACEBOOK_CREDENTIAL_MODE_SETTING_KEY,
  LIFECYCLE_PREREQUISITE_CODE,
  LIFECYCLE_PREREQUISITE_STATUS,
  createAppSettingLookup,
  isLifecycleRefusal,
} from "../_shared/facebookCredentialMode.ts";
import {
  beginOAuthRequest,
  continueOAuthRequest,
  oauthTripwirePorts,
  type OAuthLifecyclePorts,
} from "./protectedPageConnect.ts";
import { PROTECTED_PILOT_USERS_SETTING_KEY } from "../_shared/protectedAccountCutover.ts";

const ACTIONS = [
  "authorize",
  "callback",
  "get_pending_selection",
  "list_pages",
  "store_page",
  "store_account",
  "store_instagram",
  "store_ig_account",
  "clear_pending_selection",
] as const;

const FLOWS = ["facebook_oauth", "instagram_business_oauth", "instagram_oauth"] as const;

function countingPorts(): { ports: OAuthLifecyclePorts; calls: Record<string, number> } {
  const calls = { provider: 0, stash: 0, mutate: 0, legacy: 0 };
  const bump = (name: keyof typeof calls) => () => {
    calls[name] += 1;
    throw new Error(`${name} invoked`);
  };
  return {
    calls,
    ports: {
      provider: bump("provider"),
      stash: bump("stash"),
      mutateAccount: bump("mutate"),
    },
  };
}

function protectedLookup() {
  return createAppSettingLookup(async (key) => {
    if (key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY) {
      return { data: { value: "protected" }, error: null };
    }
    return { data: null, error: null };
  });
}

Deno.test("protected oauth actions refuse before provider, stash, and account mutation", async () => {
  for (const flow of FLOWS) {
    for (const action of ACTIONS) {
      const { ports, calls } = countingPorts();
      let legacyCalls = 0;
      const decision = await beginOAuthRequest({
        lookup: protectedLookup(),
        flow,
        action,
        ports,
        legacy: async () => {
          legacyCalls += 1;
          throw new Error("legacy oauth invoked");
        },
      });

      assertEquals(isLifecycleRefusal(decision), true);
      if (!isLifecycleRefusal(decision)) continue;
      assertEquals(decision.errorCode, LIFECYCLE_PREREQUISITE_CODE);
      assertEquals(decision.status, LIFECYCLE_PREREQUISITE_STATUS);
      assertEquals(decision.flow, flow);
      assertEquals(decision.action, action);
      assertEquals(calls, { provider: 0, stash: 0, mutate: 0, legacy: 0 });
      assertEquals(legacyCalls, 0);
    }
  }
});

Deno.test("protected mode does not call the production tripwire ports", async () => {
  const decision = await continueOAuthRequest({
    mode: "protected",
    flow: "instagram_business_oauth",
    action: "store_ig_account",
    ports: oauthTripwirePorts(),
    legacy: async () => {
      throw new Error("legacy oauth invoked");
    },
  });
  assertEquals(isLifecycleRefusal(decision), true);
});

Deno.test("legacy mode runs only the legacy continuation", async () => {
  const { ports, calls } = countingPorts();
  const decision = await continueOAuthRequest({
    mode: "legacy",
    flow: "facebook_oauth",
    action: "store_page",
    ports,
    legacy: async () => "legacy-continued",
  });
  assertEquals(decision, "legacy-continued");
  assertEquals(calls.provider, 0);
  assertEquals(calls.stash, 0);
  assertEquals(calls.mutate, 0);
});

Deno.test("a token-bearing action is not copied into the refusal", async () => {
  const secret = "EAABwzLixnjYBO7ZBsecretValueThatIsLongEnough";
  const decision = await continueOAuthRequest({
    mode: "protected",
    flow: "instagram_oauth",
    action: `callback?access_token=${secret}`,
    ports: oauthTripwirePorts(),
    legacy: async () => {
      throw new Error("legacy oauth invoked");
    },
  });
  assertEquals(isLifecycleRefusal(decision), true);
  if (!isLifecycleRefusal(decision)) return;
  assertEquals(decision.action, "unknown");
  assertEquals(decision.error.includes(secret), false);
  assertEquals(decision.error.includes("access_token"), false);
});

// ---------------------------------------------------------------------------
// Per-account cutover: the protected pilot list under a global `legacy`.
// ---------------------------------------------------------------------------

const PILOT_USER = "0f200001-0000-4000-8000-000000000001";
const OTHER_USER = "0f200002-0000-4000-8000-000000000002";

function legacyLookup(pilot: { value?: unknown; error?: boolean; absent?: boolean } = {}) {
  return createAppSettingLookup(async (key) => {
    if (key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY) {
      return { data: { value: "legacy" }, error: null };
    }
    if (key === PROTECTED_PILOT_USERS_SETTING_KEY) {
      if (pilot.error) return { data: null, error: { message: "read failed" } };
      if (pilot.absent) return { data: null, error: null };
      return { data: { value: pilot.value ?? [PILOT_USER] }, error: null };
    }
    return { data: null, error: null };
  });
}

async function decide(input: {
  lookup: ReturnType<typeof legacyLookup>;
  flow: (typeof FLOWS)[number];
  action: string;
  userId?: string;
}): Promise<unknown> {
  return await beginOAuthRequest({
    lookup: input.lookup,
    flow: input.flow,
    action: input.action,
    ports: oauthTripwirePorts(),
    legacy: async () => "legacy",
    protected: async () => "protected",
    userId: input.userId,
  });
}

Deno.test("a pilot user starts authorize on the protected branch under a global legacy", async () => {
  for (const flow of FLOWS) {
    assertEquals(
      await decide({ lookup: legacyLookup(), flow, action: "authorize", userId: PILOT_USER }),
      "protected",
    );
  }
});

Deno.test("a user outside the pilot list keeps the legacy authorize", async () => {
  for (const flow of FLOWS) {
    assertEquals(
      await decide({ lookup: legacyLookup(), flow, action: "authorize", userId: OTHER_USER }),
      "legacy",
    );
    assertEquals(
      await decide({ lookup: legacyLookup({ absent: true }), flow, action: "authorize", userId: OTHER_USER }),
      "legacy",
    );
  }
});

Deno.test("the pilot list never moves an action other than authorize", async () => {
  for (const flow of FLOWS) {
    for (const action of ACTIONS.filter((name) => name !== "authorize")) {
      assertEquals(
        await decide({ lookup: legacyLookup(), flow, action, userId: PILOT_USER }),
        "legacy",
      );
    }
  }
});

Deno.test("an unreadable or invalid pilot list reads as nobody", async () => {
  const lookups = [
    legacyLookup({ error: true }),
    legacyLookup({ value: "not-a-list" }),
    legacyLookup({ value: [PILOT_USER, 7] }),
    legacyLookup({ value: ["not-a-uuid"] }),
  ];
  for (const lookup of lookups) {
    assertEquals(
      await decide({ lookup, flow: "instagram_oauth", action: "authorize", userId: PILOT_USER }),
      "legacy",
    );
  }
});

Deno.test("an authorize without a caller identity is never a pilot", async () => {
  assertEquals(
    await decide({ lookup: legacyLookup(), flow: "facebook_oauth", action: "authorize" }),
    "legacy",
  );
});

Deno.test("a global protected mode is unchanged by the pilot list", async () => {
  const lookup = createAppSettingLookup(async (key) => {
    if (key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY) {
      return { data: { value: "protected" }, error: null };
    }
    if (key === PROTECTED_PILOT_USERS_SETTING_KEY) {
      return { data: { value: [] }, error: null };
    }
    return { data: null, error: null };
  });
  assertEquals(
    await decide({ lookup, flow: "instagram_oauth", action: "authorize", userId: OTHER_USER }),
    "protected",
  );
  const refused = await decide({
    lookup,
    flow: "facebook_oauth",
    action: "list_pages",
    userId: PILOT_USER,
  });
  assertEquals(isLifecycleRefusal(refused), true);
});
