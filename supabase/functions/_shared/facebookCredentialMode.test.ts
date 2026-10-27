import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CredentialConfigurationError,
  CredentialModeError,
  FACEBOOK_CREDENTIAL_MODE_SETTING_KEY,
  INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY,
  createAppSettingLookup,
  loadFacebookCredentialSettings,
  resolveFacebookCredentialMode,
  resolveInstagramCollectionEnabled,
} from "./facebookCredentialMode.ts";
import {
  beginOAuthRequest,
  oauthTripwirePorts,
} from "../facebook-oauth/protectedPageConnect.ts";

Deno.test("an unconfigured deployment stays on the legacy credential path", () => {
  // The cutover has not happened. A deployment that was never configured keeps
  // today's behaviour, so an absent switch must not read as protected.
  assertEquals(resolveFacebookCredentialMode(null), "legacy");
  assertEquals(resolveFacebookCredentialMode(undefined), "legacy");
  assertEquals(resolveFacebookCredentialMode(""), "legacy");
  assertEquals(resolveFacebookCredentialMode("   "), "legacy");
});

Deno.test("both accepted credential modes survive a round trip", () => {
  assertEquals(resolveFacebookCredentialMode("legacy"), "legacy");
  assertEquals(resolveFacebookCredentialMode("protected"), "protected");
  assertEquals(resolveFacebookCredentialMode("PROTECTED"), "protected");
  assertEquals(resolveFacebookCredentialMode("  legacy  "), "legacy");
});

Deno.test("an unsupported credential mode is refused, never downgraded to legacy", () => {
  // Reading a mis-typed "protected" as "legacy" would silently re-open the
  // browser-readable metadata path that protected mode exists to close.
  for (const value of ["protectd", "true", "1", "off", {}]) {
    const error = assertThrows(
      () => resolveFacebookCredentialMode(value),
      CredentialModeError,
    );
    assertEquals(error.code, "CREDENTIAL_MODE_INVALID");
    assertEquals(error.settingKey, FACEBOOK_CREDENTIAL_MODE_SETTING_KEY);
  }
});

Deno.test("a non-string credential mode is refused", () => {
  for (const value of [true, false, 0, 1, [], ["legacy"]]) {
    const error = assertThrows(
      () => resolveFacebookCredentialMode(value),
      CredentialModeError,
    );
    assertEquals(error.code, "CREDENTIAL_MODE_INVALID");
  }
});

Deno.test("collection is off until it is switched on explicitly", () => {
  assertEquals(resolveInstagramCollectionEnabled(null), false);
  assertEquals(resolveInstagramCollectionEnabled(undefined), false);
  assertEquals(resolveInstagramCollectionEnabled(""), false);
  assertEquals(resolveInstagramCollectionEnabled(false), false);
  assertEquals(resolveInstagramCollectionEnabled("false"), false);
  assertEquals(resolveInstagramCollectionEnabled(true), true);
  assertEquals(resolveInstagramCollectionEnabled("true"), true);
  assertEquals(resolveInstagramCollectionEnabled("TRUE"), true);
});

Deno.test("an unsupported collection value is refused instead of reading as off", () => {
  // A typo that silently reads as "off" would hide a mis-typed switch; a typo
  // that silently reads as "on" would spend provider calls.
  for (const value of ["yes", "1", 1, {}, []]) {
    const error = assertThrows(
      () => resolveInstagramCollectionEnabled(value),
      CredentialModeError,
    );
    assertEquals(error.code, "COLLECTION_ENABLED_INVALID");
    assertEquals(error.settingKey, INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY);
  }
});

Deno.test("disabling collection never moves an account back to legacy credentials", () => {
  // The two switches are read from two different settings and resolved by two
  // different resolvers. There is no code path where a disabled collection
  // changes the credential mode.
  const modeOnly = resolveFacebookCredentialMode("protected");
  assertEquals(modeOnly, "protected");
  assertEquals(resolveInstagramCollectionEnabled(false), false);
  assertEquals(resolveFacebookCredentialMode("protected"), "protected");
});

Deno.test("the two switches are read from two different settings", async () => {
  const read: string[] = [];
  const settings = await loadFacebookCredentialSettings(async (key) => {
    read.push(key);
    if (key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY) return { found: true, value: "protected" };
    if (key === INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY) return { found: true, value: false };
    return { found: false, value: null };
  });

  assertEquals(settings.credentialMode, "protected");
  assertEquals(settings.collectionEnabled, false);
  assertEquals(read.sort(), [
    FACEBOOK_CREDENTIAL_MODE_SETTING_KEY,
    INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY,
  ].sort());
});

Deno.test("an absent collection switch leaves the credential mode alone", async () => {
  const settings = await loadFacebookCredentialSettings(async (key) =>
    key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY
      ? { found: true, value: "protected" }
      : { found: false, value: null }
  );
  assertEquals(settings.credentialMode, "protected");
  assertEquals(settings.collectionEnabled, false);
});

Deno.test("an invalid credential mode refuses the whole resolution", async () => {
  const error = await assertRejects(
    () =>
      loadFacebookCredentialSettings(async (key) =>
        key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY
          ? { found: true, value: "maybe" }
          : { found: false, value: null }
      ),
    CredentialModeError,
  );
  assertEquals(error.code, "CREDENTIAL_MODE_INVALID");
});

Deno.test("an invalid collection value refuses the whole resolution", async () => {
  const error = await assertRejects(
    () =>
      loadFacebookCredentialSettings(async (key) =>
        key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY
          ? { found: true, value: "legacy" }
          : { found: true, value: "sometimes" }
      ),
    CredentialModeError,
  );
  assertEquals(error.code, "COLLECTION_ENABLED_INVALID");
});

const SECRET = "EAABwzLixnjYBO7ZBsecretValueThatIsLongEnoughToLookLikeAToken123";

function throwingPorts() {
  const calls = { provider: 0, stash: 0, mutate: 0, legacy: 0, schema: 0 };
  return {
    calls,
    ports: {
      provider: () => {
        calls.provider += 1;
        throw new Error("provider invoked");
      },
      stash: () => {
        calls.stash += 1;
        throw new Error("stash invoked");
      },
      mutateAccount: () => {
        calls.mutate += 1;
        throw new Error("mutate invoked");
      },
    },
    legacy: async () => {
      calls.legacy += 1;
      return "legacy-continued";
    },
    schema: () => {
      calls.schema += 1;
      throw new Error("protected schema invoked");
    },
  };
}

Deno.test("a returned settings error is not a missing row and does not become legacy", async () => {
  const boundary = throwingPorts();
  const lookup = createAppSettingLookup(async () => ({
    data: null,
    error: { message: `synthetic database outage ${SECRET}` },
  }));

  const error = await assertRejects(
    () =>
      beginOAuthRequest({
        lookup,
        flow: "facebook_oauth",
        action: "authorize",
        ports: boundary.ports,
        legacy: boundary.legacy,
      }),
    CredentialConfigurationError,
  );
  assertEquals(error.code, "CREDENTIAL_CONFIGURATION_UNAVAILABLE");
  assertEquals(error.message.includes(SECRET), false);
  assertEquals(error.message.includes("synthetic"), false);
  assertEquals(boundary.calls, { provider: 0, stash: 0, mutate: 0, legacy: 0, schema: 0 });

  await assertRejects(
    () => loadFacebookCredentialSettings(lookup),
    CredentialConfigurationError,
  );
});

Deno.test("a thrown settings transport error fails closed and drops the driver text", async () => {
  const boundary = throwingPorts();
  const lookup = createAppSettingLookup(async () => {
    throw new Error(`connect failed access_token=${SECRET}`);
  });

  const error = await assertRejects(
    () => loadFacebookCredentialSettings(lookup),
    CredentialConfigurationError,
  );
  assertEquals(error.message, "Credential configuration could not be read.");
  assertEquals(error.message.includes(SECRET), false);
  assertEquals(error.message.includes("access_token"), false);

  await assertRejects(
    () =>
      beginOAuthRequest({
        lookup,
        flow: "facebook_oauth",
        action: "callback",
        ports: boundary.ports,
        legacy: boundary.legacy,
      }),
    CredentialConfigurationError,
  );
  assertEquals(boundary.calls.legacy, 0);
  assertEquals(boundary.calls.provider, 0);
});

Deno.test("a malformed settings envelope is not a missing row", async () => {
  const shapes: unknown[] = [
    { unexpected: true },
    "legacy",
    ["protected"],
    { data: { value: "legacy" } },
    { error: null },
    null,
    [],
  ];

  for (const shape of shapes) {
    const boundary = throwingPorts();
    const lookup = createAppSettingLookup(async () => shape as { data: unknown; error: { message?: string } | null });
    await assertRejects(
      () =>
        beginOAuthRequest({
          lookup,
          flow: "facebook_oauth",
          action: "store_page",
          ports: boundary.ports,
          legacy: boundary.legacy,
        }),
      CredentialConfigurationError,
    );
    assertEquals(boundary.calls.legacy, 0);
    assertEquals(boundary.calls.schema, 0);
  }
});

Deno.test("a malformed present row is not a missing setting", async () => {
  for (const data of [{ unexpected: true }, "protected", ["legacy"]]) {
    const lookup = createAppSettingLookup(async () => ({ data, error: null }));
    await assertRejects(
      () => loadFacebookCredentialSettings(lookup),
      CredentialConfigurationError,
    );
  }
});

Deno.test("a genuinely absent settings row is legacy and does not touch the protected schema", async () => {
  const boundary = throwingPorts();
  const keys: string[] = [];
  const lookup = createAppSettingLookup(async (key) => {
    keys.push(key);
    if (key !== FACEBOOK_CREDENTIAL_MODE_SETTING_KEY && key !== INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY) {
      boundary.schema();
    }
    return { data: null, error: null };
  });
  const settings = await loadFacebookCredentialSettings(lookup);
  assertEquals(settings.credentialMode, "legacy");
  assertEquals(settings.collectionEnabled, false);

  const continued = await beginOAuthRequest({
    lookup,
    flow: "facebook_oauth",
    action: "authorize",
    ports: boundary.ports,
    legacy: boundary.legacy,
  });
  assertEquals(continued, "legacy-continued");
  assertEquals(boundary.calls.provider, 0);
  assertEquals(boundary.calls.stash, 0);
  assertEquals(boundary.calls.mutate, 0);
  assertEquals(boundary.calls.schema, 0);
  assertEquals(boundary.calls.legacy, 1);
  assertEquals(
    keys.every((key) =>
      key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY || key === INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY
    ),
    true,
  );
});

Deno.test("an invalid persisted mode is not downgraded when the row is present", async () => {
  const boundary = throwingPorts();
  const lookup = createAppSettingLookup(async (key) => {
    if (key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY) {
      return { data: { value: "protectd" }, error: null };
    }
    return { data: null, error: null };
  });

  await assertRejects(
    () =>
      beginOAuthRequest({
        lookup,
        flow: "facebook_oauth",
        action: "store_account",
        ports: boundary.ports,
        legacy: boundary.legacy,
      }),
    CredentialModeError,
  );
  assertEquals(boundary.calls.legacy, 0);
  assertEquals(boundary.calls.provider, 0);
});

Deno.test("a collection read failure does not yield a legacy credential mode", async () => {
  const lookup = createAppSettingLookup(async (key) => {
    if (key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY) return { data: null, error: null };
    return { data: null, error: { message: `collection outage ${SECRET}` } };
  });
  const error = await assertRejects(
    () => loadFacebookCredentialSettings(lookup),
    CredentialConfigurationError,
  );
  assertEquals(error.message.includes(SECRET), false);
});

Deno.test("undefined settings data is a failed read, not a missing row", async () => {
  const boundary = throwingPorts();
  for (const data of [undefined, { value: undefined }]) {
    const lookup = createAppSettingLookup(async () => ({ data, error: null }));
    const error = await assertRejects(
      () =>
        beginOAuthRequest({
          lookup,
          flow: "facebook_oauth",
          action: "authorize",
          ports: boundary.ports,
          legacy: boundary.legacy,
        }),
      CredentialConfigurationError,
    );
    assertEquals(error.message.includes("legacy"), false);
    assertEquals(boundary.calls.legacy, 0);
    assertEquals(boundary.calls.provider, 0);
  }
});

Deno.test("an undefined error field is not an absent settings row", async () => {
  const lookup = createAppSettingLookup(async () => ({
    data: null,
    error: undefined,
  }));
  await assertRejects(
    () => loadFacebookCredentialSettings(lookup),
    CredentialConfigurationError,
  );
});

Deno.test("an inherited settings envelope is not an absent row", async () => {
  const inherited = Object.create({ data: null, error: null });
  const lookup = createAppSettingLookup(async () => inherited);
  await assertRejects(
    () => loadFacebookCredentialSettings(lookup),
    CredentialConfigurationError,
  );

  const inheritedValue = Object.create({ value: "legacy" });
  const lookupValue = createAppSettingLookup(async () => ({ data: inheritedValue, error: null }));
  await assertRejects(
    () => loadFacebookCredentialSettings(lookupValue),
    CredentialConfigurationError,
  );
});

Deno.test("a stored JSON null or blank setting stays the unconfigured default", async () => {
  const absent = await loadFacebookCredentialSettings(
    createAppSettingLookup(async () => ({ data: null, error: null })),
  );
  assertEquals(absent.credentialMode, "legacy");
  assertEquals(absent.collectionEnabled, false);

  const blank = await loadFacebookCredentialSettings(
    createAppSettingLookup(async (key) => ({
      data: {
        value: key === FACEBOOK_CREDENTIAL_MODE_SETTING_KEY ? "   " : "",
      },
      error: null,
    })),
  );
  assertEquals(blank.credentialMode, "legacy");
  assertEquals(blank.collectionEnabled, false);

  const jsonNull = await loadFacebookCredentialSettings(
    createAppSettingLookup(async () => ({ data: { value: null }, error: null })),
  );
  assertEquals(jsonNull.credentialMode, "legacy");
  assertEquals(jsonNull.collectionEnabled, false);
});

Deno.test("production oauth tripwires reject if a protected route calls them", async () => {
  const ports = oauthTripwirePorts();
  await assertRejects(() => ports.provider(), Error, "protected oauth provider invoked");
  await assertRejects(() => ports.stash(), Error, "protected oauth stash invoked");
  await assertRejects(() => ports.mutateAccount(), Error, "protected oauth mutate invoked");
});
