// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parse } from "jsr:@std/yaml@1";
import { assertActionAuthorized, type PartnerKeyRecord } from "./partnerApiKeys.ts";
import {
  describeScopeRejection,
  GENERIC_SCOPES,
  LEGACY_SCOPE_CAPABILITY,
  LEGACY_SCOPES,
  scopeIsMintable,
} from "./partnerScopes.ts";
import { ACTION_SCOPES, satisfyingScopesFor } from "../partner-api/router.ts";

// ---------------------------------------------------------------------------
// Deliverable 1.6 — LEGACY SCOPE PINNING (decision D3).
//
// Every test here is a statement about CAPABILITY, and each would fail if the
// capability stopped holding. D3 was rewritten once because its first version
// was privilege escalation dressed as a vocabulary migration; these tests are
// what stop the escalation being reintroduced by someone who reads
// ACTION_SCOPES as a translation table rather than a per-action rule.
// ---------------------------------------------------------------------------

function keyWith(scopes: string[]): PartnerKeyRecord {
  return {
    id: "key-1",
    workspaceId: "ws-1",
    socialAccountId: "acct-1",
    keyPrefix: "pk_live_abcd",
    scopes,
    rateLimitPerMin: 60,
    monthlyQuota: null,
    expiresAt: null,
    revokedAt: null,
  };
}

/** Authorise `action` for a key holding exactly `scopes`. Mirrors what
 *  index.ts does at its single enforcement point. */
function authorize(scopes: string[], action: string): void {
  const satisfying = satisfyingScopesFor(action);
  if (satisfying === undefined) throw new Error(`unknown action ${action}`);
  if (satisfying === null) return; // no scope required
  assertActionAuthorized(keyWith(scopes), action, satisfying);
}

function refuses(scopes: string[], action: string, because: string): void {
  assertThrows(() => authorize(scopes, action), Error, "not authorized", because);
}

// --- T1 -------------------------------------------------------------------

Deno.test("T1: whatsapp:webhooks.manage authorises nothing at all", () => {
  // The trap D3(R3) exists to prevent. This scope was held by the (now
  // revoked) Danat key and has never authorised a single action. If the
  // webhook API ever lets it satisfy webhooks:manage, that converts zero
  // capability into full webhook CRUD plus an SSRF-capable outbound test.
  assertEquals(LEGACY_SCOPE_CAPABILITY["whatsapp:webhooks.manage"], []);

  const dormant = ["whatsapp:webhooks.manage"];
  for (const action of Object.keys(ACTION_SCOPES)) {
    if (satisfyingScopesFor(action) === null) continue; // get_status needs none
    refuses(dormant, action, `${action} must not be reachable with only the dormant scope`);
  }

  // get_status is reachable, but only because it requires no scope at all --
  // not because the dormant scope granted anything.
  assertEquals(satisfyingScopesFor("get_status"), null);
});

// --- T2 -------------------------------------------------------------------

Deno.test("T2: a legacy scope authorises its one action and no other", () => {
  const sendOnly = ["whatsapp:template.send"];
  authorize(sendOnly, "send_template"); // does not throw
  refuses(sendOnly, "list_templates", "template.send must not confer template reading");

  const readOnly = ["whatsapp:templates.read"];
  authorize(readOnly, "list_templates");
  refuses(readOnly, "send_template", "templates.read must not confer sending");
});

// --- T3 -------------------------------------------------------------------

Deno.test("T3: a key reissued with generic scopes can still call the frozen alias", () => {
  // D3 step 2 reissues a key with generic scopes. If the alias's actions only
  // accepted the legacy strings, that reissue would break the key -- so the
  // action accepts either vocabulary.
  authorize(["messages:send"], "send_template");
  authorize(["templates:read"], "list_templates");
});

// --- T4 -------------------------------------------------------------------

Deno.test("T4: a legacy scope does not satisfy a generic requirement beyond its one alias action", () => {
  // Asserted against a requirement that is NOT an alias action, so the test
  // keeps its meaning when /v1 arrives. `messages:send` will cover free-form
  // messaging and, under D4, any newly bound account on any platform --
  // authority the legacy holder never requested.
  const legacyHolder = keyWith(["whatsapp:template.send"]);

  assertThrows(
    () => assertActionAuthorized(legacyHolder, "post_message", ["messages:send"]),
    Error,
    "not authorized",
    "whatsapp:template.send must never satisfy messages:send",
  );

  // And the dormant one against the scope it must never become.
  assertThrows(
    () => assertActionAuthorized(keyWith(["whatsapp:webhooks.manage"]), "create_webhook", ["webhooks:manage"]),
    Error,
    "not authorized",
    "whatsapp:webhooks.manage must never satisfy webhooks:manage",
  );

  // Stated structurally as well: no legacy string appears in any action's
  // satisfying set except the one its capability entry names.
  for (const legacy of LEGACY_SCOPES) {
    const permitted = LEGACY_SCOPE_CAPABILITY[legacy];
    for (const [action, satisfying] of Object.entries(ACTION_SCOPES)) {
      if (satisfying === null) continue;
      const appears = (satisfying as readonly string[]).includes(legacy);
      assertEquals(
        appears,
        permitted.includes(action),
        `${legacy} appears in ${action}'s satisfying set but its D3(R3) capability says otherwise`,
      );
    }
  }
});

// --- T5 / T6 --------------------------------------------------------------

Deno.test("T5: a legacy scope is refused for a newly minted key", () => {
  for (const legacy of LEGACY_SCOPES) {
    assertEquals(scopeIsMintable(legacy), false, `${legacy} must not be issuable`);
    // The operator is told WHY, and pointed at the generic vocabulary --
    // "unknown scope" would send them looking for a typo.
    assertEquals(describeScopeRejection(legacy).includes("legacy scope"), true);
  }
});

Deno.test("T6: an unrecognised scope string is refused for a newly minted key", () => {
  for (const bogus of ["messages:sendd", "admin:*", "", "whatsapp:template.sendx"]) {
    assertEquals(scopeIsMintable(bogus), false, `${bogus} must not be issuable`);
  }
  // Every generic scope, by contrast, is issuable.
  for (const generic of GENERIC_SCOPES) {
    assertEquals(scopeIsMintable(generic), true, `${generic} must be issuable`);
  }
});

// --- T7 -------------------------------------------------------------------

Deno.test("T7: the enforced generic vocabulary equals the published one in openapi.yaml", () => {
  // The document is the contract a partner reads; this module is what the code
  // enforces. If they drift, the published scope list is a lie. Read from the
  // document rather than hardcoded, or this test would keep passing after
  // someone edited it.
  const doc = parse(
    Deno.readTextFileSync(new URL("../../../docs/api/openapi.yaml", import.meta.url)),
    // deno-lint-ignore no-explicit-any
  ) as any;

  assertEquals(
    [...GENERIC_SCOPES].sort(),
    [...doc.components.schemas.GenericScope.enum].sort(),
    "the code's generic scopes and docs/api/openapi.yaml GenericScope disagree",
  );
  assertEquals(
    [...LEGACY_SCOPES].sort(),
    [...doc.components.schemas.LegacyScope.enum].sort(),
    "the code's legacy scopes and docs/api/openapi.yaml LegacyScope disagree",
  );
});
