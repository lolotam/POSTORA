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
