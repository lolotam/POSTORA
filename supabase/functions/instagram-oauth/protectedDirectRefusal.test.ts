import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FACEBOOK_CREDENTIAL_MODE_SETTING_KEY,
  LIFECYCLE_PREREQUISITE_CODE,
  createAppSettingLookup,
  isLifecycleRefusal,
} from "../_shared/facebookCredentialMode.ts";
import { beginOAuthRequest, type OAuthLifecyclePorts } from "../facebook-oauth/protectedPageConnect.ts";

/**
 * Direct Instagram login is the writer `instagram-oauth/index.ts` still owns.
 * The index calls this same gate for GET callback and POST authorize/callback
 * before `exchangeAndPersist` and `createOAuthState`. The index starts a
 * server on import, so the gate is what a hermetic test can execute.
 */
function portsThatThrow(): OAuthLifecyclePorts {
  const forbid = (kind: string): (() => Promise<never>) => () => {
    throw new Error(`instagram oauth ${kind} invoked`);
  };
  return {
    provider: forbid("provider"),
    stash: forbid("stash"),
    mutateAccount: forbid("account"),
  };
}

Deno.test("protected direct instagram authorize and callback refuse before exchange", async () => {
  const lookup = createAppSettingLookup(async (key) => {
    if (key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY) {
      return { data: { value: "protected" }, error: null };
    }
    return { data: null, error: null };
  });

  for (const action of ["authorize", "callback"] as const) {
    let exchange = 0;
    let persist = 0;
    const decision = await beginOAuthRequest({
      lookup,
      flow: "instagram_oauth",
      action,
      ports: portsThatThrow(),
      legacy: async () => {
        exchange += 1;
        persist += 1;
        throw new Error("exchangeAndPersist invoked");
      },
    });

    assertEquals(isLifecycleRefusal(decision), true);
    if (!isLifecycleRefusal(decision)) continue;
    assertEquals(decision.errorCode, LIFECYCLE_PREREQUISITE_CODE);
    assertEquals(decision.flow, "instagram_oauth");
    assertEquals(decision.action, action);
    assertEquals(exchange, 0);
    assertEquals(persist, 0);
  }
});
