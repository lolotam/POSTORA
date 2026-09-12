// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getBusinessProfile, updateBusinessProfile } from "./whatsappProfileOps.ts";
import { WhatsAppOpError, type Fetcher, type WhatsAppOpsContext } from "./whatsappPartnerOps.ts";

const CTX: WhatsAppOpsContext = {
  admin: {}, accountId: "account", workspaceId: "workspace", ownerId: "owner",
  phoneNumberId: "meta-id", accessToken: "test-token", connectionMode: "cloud_api",
};
const forbidden: Fetcher = () => { throw new Error("unexpected provider call"); };

Deno.test("empty and unknown-only profile patches refuse before the provider", async () => {
  for (const patch of [{}, { profile_picture_url: "https://example.com/picture" }, { about: undefined }]) {
    const error = await assertRejects(() => updateBusinessProfile(CTX, patch, forbidden), WhatsAppOpError);
    assertEquals([error.code, error.status, error.indeterminate], ["invalid_request", 400, false]);
  }
});

Deno.test("partial profile update never blanks omitted fields (persona partial-write regression)", async () => {
  let calls = 0;
  const result = await updateBusinessProfile(CTX, { about: "New about" }, (url, init) => {
    calls++;
    assertEquals(String(url), "https://graph.facebook.com/v21.0/meta-id/whatsapp_business_profile");
    assertEquals(init?.method, "POST");
    const payload = JSON.parse(String(init?.body));
    assertEquals(payload, { messaging_product: "whatsapp", about: "New about" });
    for (const key of ["address", "description", "email", "websites", "vertical"]) assert(!Object.hasOwn(payload, key));
    return Promise.resolve(Response.json({ success: true }));
  });
  assertEquals(calls, 1);
  assertEquals(result, { success: true });
});

// Boundary matrix: exact maximum accepted, maximum + 1 refused; URL/email
// format checked separately, empty email and website list explicitly clearable.
for (const [field, max] of [["about", 139], ["address", 256], ["description", 512], ["email", 128], ["vertical", 128]] as const) {
  Deno.test(`profile ${field} preserves the browser's ${max}-character boundary`, async () => {
    const value = (length: number) => field === "email" ? `${"a".repeat(60)}@${"b".repeat(length - 65)}.com` : "x".repeat(length);
    await updateBusinessProfile(CTX, { [field]: value(max) }, () => Promise.resolve(Response.json({ success: true })));
    const error = await assertRejects(() => updateBusinessProfile(CTX, { [field]: value(max + 1) }, forbidden), WhatsAppOpError);
    assertEquals([error.code, error.status], ["invalid_request", 400]);
  });
}

Deno.test("profile preserves two URL limit, URL/email validation and explicit clearing", async () => {
  for (const patch of [{ websites: ["https://one.example", "https://two.example"] }, { email: "", websites: [] }]) {
    await updateBusinessProfile(CTX, patch, (_url, init) => {
      assertEquals(JSON.parse(String(init?.body)), { messaging_product: "whatsapp", ...patch });
      return Promise.resolve(Response.json({ success: true }));
    });
  }
  for (const patch of [{ websites: Array(3).fill("https://example.com") }, { websites: ["invalid"] }, { email: "invalid" }, { about: null }, { websites: "https://example.com" }]) {
    const error = await assertRejects(() => updateBusinessProfile(CTX, patch, forbidden), WhatsAppOpError);
    assertEquals([error.code, error.status], ["invalid_request", 400]);
  }
});

Deno.test("Direct QR refuses both business profile operations without calling Meta", async () => {
  const ctx = { ...CTX, connectionMode: "evolution_qr" as const };
  for (const operation of [() => getBusinessProfile(ctx, forbidden), () => updateBusinessProfile(ctx, { about: "x" }, forbidden)]) {
    const error = await assertRejects(operation, WhatsAppOpError, "Cloud API capability");
    assertEquals([error.code, error.status], ["unsupported_capability", 422]);
  }
});

Deno.test("profile GET selects all browser fields and normalizes only a valid profile", async () => {
  const profile = await getBusinessProfile(CTX, (input, init) => {
    const url = new URL(String(input));
    assertEquals(url.searchParams.get("fields")?.split(",").sort(), ["about", "address", "description", "email", "profile_picture_url", "vertical", "websites"]);
    assertEquals(init?.method, "GET");
    return Promise.resolve(Response.json({ data: [{ about: "Business", profile_picture_url: "https://example.com/photo", vendor_field: "private" }] }));
  });
  assertEquals(profile, { about: "Business", address: null, description: null, email: null, websites: [], vertical: null, profile_picture_url: "https://example.com/photo" });
});

Deno.test("incomplete Cloud API credentials refuse before a provider request", async () => {
  for (const ctx of [{ ...CTX, accessToken: "" }, { ...CTX, phoneNumberId: "" }]) {
    for (const operation of [() => getBusinessProfile(ctx, forbidden), () => updateBusinessProfile(ctx, { about: "x" }, forbidden)]) {
      const error = await assertRejects(operation, WhatsAppOpError);
      assertEquals(error.code, "account_not_connected");
      assertEquals(error.indeterminate, false);
    }
  }
});

for (const scenario of ["5xx", "unparseable", "missing_success", "transport"] as const) {
  Deno.test(`profile PATCH ${scenario} is indeterminate`, async () => {
    const error = await assertRejects(() => updateBusinessProfile(CTX, { about: "x" }, () => {
      if (scenario === "transport") return Promise.reject(new Error("private transport details"));
      return Promise.resolve(scenario === "5xx" ? Response.json({ error: { code: 190 } }, { status: 503 }) :
        scenario === "unparseable" ? new Response("not JSON", { status: 400 }) : Response.json({}));
    }), WhatsAppOpError);
    assertEquals([error.code, error.status, error.indeterminate], ["meta_error", 502, true]);
  });
}

Deno.test("profile GET refuses failed or malformed reads instead of returning empty profiles", async () => {
  for (const body of [{}, { data: [] }, { data: [null] }, { data: [{ websites: "broken" }] }]) {
    await assertRejects(() => getBusinessProfile(CTX, () => Promise.resolve(Response.json(body))), WhatsAppOpError);
  }
});

Deno.test("definite Meta profile rejection is sanitized and can be settled", async () => {
  for (const [code, expected] of [[100, "meta_error"], [190, "account_needs_reauth"]] as const) {
    const error = await assertRejects(() => updateBusinessProfile(CTX, { about: "x" }, () =>
      Promise.resolve(Response.json({ error: { code, message: "secret-token" } }, { status: 400 }))), WhatsAppOpError);
    assertEquals(error.code, expected);
    assertEquals(error.indeterminate, false);
    assert(!error.message.includes("secret-token"));
  }
});
